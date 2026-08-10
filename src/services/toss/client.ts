/**
 * 토스증권 Open API 클라이언트.
 *
 * - Rate Limits Group 별 토큰버킷을 내장해 초당 호출 수를 클라이언트 측에서 먼저 제어한다.
 * - 429 수신 시 `Retry-After` / `X-RateLimit-Reset` 헤더를 우선 존중하고, 없으면 지수백오프 + jitter.
 * - 401 수신 시 토큰을 무효화하고 1회 재발급 후 재시도 (재발급이 이전 토큰을 무효화하는 스펙 대응).
 *
 * 환경변수: TOSS_CLIENT_ID, TOSS_CLIENT_SECRET, TOSS_ACCOUNT_SEQ
 */

import axios, { AxiosError, type AxiosInstance, type AxiosRequestConfig } from "axios";
import {
  TOSS_API_BASE,
  TossTokenProvider,
  loadAccountSeqFromEnv,
  loadTossAuthConfigFromEnv,
  type TossAuthConfig,
} from "./auth";
import {
  RATE_LIMITS,
  type Account,
  type ApiResponse,
  type BuyingPowerResponse,
  type CandlePageResponse,
  type CandleQuery,
  type Commission,
  type Currency,
  type ErrorResponse,
  type ExchangeRateResponse,
  type HoldingsOverview,
  type Order,
  type OrderCreateRequest,
  type OrderModifyRequest,
  type OrderOperationResponse,
  type OrderResponse,
  type PaginatedOrderResponse,
  type PriceResponse,
  type RateLimitGroup,
  type RateLimitHeaders,
  type SellableQuantityResponse,
  type StockInfo,
  type UsMarketCalendarResponse,
} from "./types";

// ─── 토큰버킷 ───

/**
 * 초당 N회 제한을 지키는 토큰버킷.
 * capacity = rate 로 두어 burst 가 한도를 넘지 않게 한다 (스펙상 X-RateLimit-Limit 이 burst capacity).
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;
  /** 대기 요청 직렬화용 체인. 선착순 보장. */
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly ratePerSec: number, private readonly capacity = ratePerSec) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  /** 현재 한도를 서버 응답 헤더 기준으로 조정한다 (한도는 사전 공지 없이 바뀔 수 있음). */
  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefillMs) / 1000;
    if (elapsedSec <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillMs = now;
  }

  /** 토큰 1개를 소비할 때까지 대기한다. */
  async take(): Promise<void> {
    const wait = this.queue.then(async () => {
      for (;;) {
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const deficitSec = (1 - this.tokens) / this.ratePerSec;
        await sleep(Math.max(5, Math.ceil(deficitSec * 1000)));
      }
    });
    this.queue = wait.catch(() => undefined);
    return wait;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── 클라이언트 ───

export interface TossClientOptions {
  auth?: TossAuthConfig;
  /** 계좌 API 용 accountSeq. 미지정 시 TOSS_ACCOUNT_SEQ 환경변수. */
  accountSeq?: number;
  baseUrl?: string;
  timeoutMs?: number;
  /** 429/5xx 최대 재시도 횟수. 기본 4. */
  maxRetries?: number;
  /** true 면 실제 네트워크 호출 없이 요청 내용만 로깅하고 예외를 던진다 (--dry-run 용). */
  dryRun?: boolean;
}

export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId?: string,
    readonly data?: Record<string, unknown> | null
  ) {
    super(message);
    this.name = "TossApiError";
  }
}

export class TossClient {
  private readonly http: AxiosInstance;
  private readonly tokenProvider: TossTokenProvider;
  private readonly buckets: Map<RateLimitGroup, TokenBucket> = new Map();
  private readonly maxRetries: number;
  private readonly accountSeq: number | null;
  readonly dryRun: boolean;

  constructor(options: TossClientOptions = {}) {
    const auth = options.auth ?? loadTossAuthConfigFromEnv();
    const baseUrl = (options.baseUrl ?? auth.baseUrl ?? TOSS_API_BASE).replace(/\/+$/, "");
    this.tokenProvider = new TossTokenProvider({ ...auth, baseUrl });
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: options.timeoutMs ?? 15000,
      headers: { "User-Agent": "DCF-Peergroup-Search/trading (toss-openapi-client)" },
    });
    this.maxRetries = options.maxRetries ?? 4;
    this.accountSeq = options.accountSeq ?? loadAccountSeqFromEnv();
    this.dryRun = options.dryRun ?? false;

    for (const [group, rate] of Object.entries(RATE_LIMITS) as [RateLimitGroup, number][]) {
      this.buckets.set(group, new TokenBucket(rate));
    }
  }

  private bucket(group: RateLimitGroup): TokenBucket {
    const b = this.buckets.get(group);
    if (!b) throw new Error(`UNKNOWN_RATE_LIMIT_GROUP: ${group}`);
    return b;
  }

  private requireAccountSeq(): number {
    if (this.accountSeq === null) {
      throw new Error(
        "TOSS_ACCOUNT_SEQ_MISSING: 계좌 API 호출에는 TOSS_ACCOUNT_SEQ (또는 options.accountSeq) 가 필요합니다."
      );
    }
    return this.accountSeq;
  }

  /** 공통 요청 실행기. 레이트리밋 대기 → 인증 → 재시도 → envelope 해제. */
  private async request<T>(
    group: RateLimitGroup,
    config: AxiosRequestConfig,
    opts: { withAccount?: boolean } = {}
  ): Promise<T> {
    if (this.dryRun) {
      throw new Error(
        `DRY_RUN: 실제 호출 생략 — ${config.method?.toUpperCase() ?? "GET"} ${config.url} ` +
          `params=${JSON.stringify(config.params ?? {})} body=${JSON.stringify(config.data ?? null)}`
      );
    }

    let tokenRefreshed = false;
    let attempt = 0;

    for (;;) {
      await this.bucket(group).take();

      const headers: Record<string, string> = {
        ...(config.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${await this.tokenProvider.getToken()}`,
      };
      if (opts.withAccount) {
        headers["X-Tossinvest-Account"] = String(this.requireAccountSeq());
      }

      try {
        const res = await this.http.request<ApiResponse<T>>({ ...config, headers });
        return res.data.result;
      } catch (err) {
        const axErr = err as AxiosError<ErrorResponse>;
        const status = axErr.response?.status;

        // 토큰이 다른 프로세스에 의해 무효화된 경우 1회 재발급 후 재시도.
        if (status === 401 && !tokenRefreshed) {
          tokenRefreshed = true;
          this.tokenProvider.invalidate();
          continue;
        }

        const retryable = status === 429 || (status !== undefined && status >= 500) || !status;
        if (retryable && attempt < this.maxRetries) {
          attempt += 1;
          const rl = parseRateLimitHeaders(axErr.response?.headers as Record<string, unknown>);
          await sleep(backoffMs(attempt, rl));
          continue;
        }

        throw toTossApiError(axErr);
      }
    }
  }

  // ─── Market Data ───

  /**
   * 캔들 조회. Rate Limits Group: MARKET_DATA_CHART (초당 5회).
   * 1회 최대 200봉. 전체 기간 수집은 candles.ts 의 collectBars() 를 사용한다.
   */
  async getCandles(query: CandleQuery): Promise<CandlePageResponse> {
    return this.request<CandlePageResponse>("MARKET_DATA_CHART", {
      method: "GET",
      url: "/api/v1/candles",
      params: {
        symbol: query.symbol,
        interval: query.interval,
        count: query.count ?? 200,
        before: query.before,
        adjusted: query.adjusted,
      },
    });
  }

  /** 현재가 다건 조회. 최대 200종목. Rate Limits Group: MARKET_DATA (초당 10회). */
  async getPrices(symbols: string[]): Promise<PriceResponse[]> {
    const out: PriceResponse[] = [];
    for (const chunk of chunkArray(symbols, 200)) {
      const page = await this.request<PriceResponse[]>("MARKET_DATA", {
        method: "GET",
        url: "/api/v1/prices",
        params: { symbols: chunk.join(",") },
      });
      out.push(...page);
    }
    return out;
  }

  /** 종목 기본정보 다건 조회. 최대 200종목. Rate Limits Group: STOCK (초당 5회). */
  async getStocks(symbols: string[]): Promise<StockInfo[]> {
    const out: StockInfo[] = [];
    for (const chunk of chunkArray(symbols, 200)) {
      const page = await this.request<StockInfo[]>("STOCK", {
        method: "GET",
        url: "/api/v1/stocks",
        params: { symbols: chunk.join(",") },
      });
      out.push(...page);
    }
    return out;
  }

  /** 미국 장 운영 정보. date 는 미국 현지 YYYY-MM-DD. Rate Limits Group: MARKET_INFO (초당 3회). */
  async getUsMarketCalendar(date?: string): Promise<UsMarketCalendarResponse> {
    return this.request<UsMarketCalendarResponse>("MARKET_INFO", {
      method: "GET",
      url: "/api/v1/market-calendar/US",
      params: date ? { date } : undefined,
    });
  }

  /** 환율 조회. 환전스프레드 산정 참고용. Rate Limits Group: MARKET_INFO. */
  async getExchangeRate(
    baseCurrency: Currency,
    quoteCurrency: Currency,
    dateTime?: string
  ): Promise<ExchangeRateResponse> {
    return this.request<ExchangeRateResponse>("MARKET_INFO", {
      method: "GET",
      url: "/api/v1/exchange-rate",
      params: { baseCurrency, quoteCurrency, dateTime },
    });
  }

  // ─── Account / Asset ───

  /** 계좌 목록. Rate Limits Group: ACCOUNT (초당 1회). */
  async getAccounts(): Promise<Account[]> {
    return this.request<Account[]>("ACCOUNT", { method: "GET", url: "/api/v1/accounts" });
  }

  /** 보유 주식. Rate Limits Group: ASSET (초당 5회). */
  async getHoldings(symbol?: string): Promise<HoldingsOverview> {
    return this.request<HoldingsOverview>(
      "ASSET",
      { method: "GET", url: "/api/v1/holdings", params: symbol ? { symbol } : undefined },
      { withAccount: true }
    );
  }

  // ─── Order ───

  /** 주문 생성. Rate Limits Group: ORDER (초당 6회, 09:00~09:10 KST 는 3회). */
  async createOrder(body: OrderCreateRequest): Promise<OrderResponse> {
    return this.request<OrderResponse>(
      "ORDER",
      { method: "POST", url: "/api/v1/orders", data: body },
      { withAccount: true }
    );
  }

  /** 주문 정정. US 는 가격만 정정 가능하다. */
  async modifyOrder(orderId: string, body: OrderModifyRequest): Promise<OrderOperationResponse> {
    return this.request<OrderOperationResponse>(
      "ORDER",
      { method: "POST", url: `/api/v1/orders/${encodeURIComponent(orderId)}/modify`, data: body },
      { withAccount: true }
    );
  }

  /** 주문 취소. 응답 orderId 는 취소로 새로 발급된 식별자다. */
  async cancelOrder(orderId: string): Promise<OrderOperationResponse> {
    return this.request<OrderOperationResponse>(
      "ORDER",
      { method: "POST", url: `/api/v1/orders/${encodeURIComponent(orderId)}/cancel` },
      { withAccount: true }
    );
  }

  /** 주문 상세. Rate Limits Group: ORDER_HISTORY (초당 5회). */
  async getOrder(orderId: string): Promise<Order> {
    return this.request<Order>(
      "ORDER_HISTORY",
      { method: "GET", url: `/api/v1/orders/${encodeURIComponent(orderId)}` },
      { withAccount: true }
    );
  }

  /** 미체결(OPEN) 주문 목록. status=CLOSED 는 현재 400 closed-not-supported 로 막혀 있다. */
  async getOpenOrders(symbol?: string): Promise<PaginatedOrderResponse> {
    return this.request<PaginatedOrderResponse>(
      "ORDER_HISTORY",
      { method: "GET", url: "/api/v1/orders", params: { status: "OPEN", symbol } },
      { withAccount: true }
    );
  }

  /** 현금 매수 가능 금액. Rate Limits Group: ORDER_INFO. */
  async getBuyingPower(currency: Currency): Promise<BuyingPowerResponse> {
    return this.request<BuyingPowerResponse>(
      "ORDER_INFO",
      { method: "GET", url: "/api/v1/buying-power", params: { currency } },
      { withAccount: true }
    );
  }

  /** 매도 가능 수량. */
  async getSellableQuantity(symbol: string): Promise<SellableQuantityResponse> {
    return this.request<SellableQuantityResponse>(
      "ORDER_INFO",
      { method: "GET", url: "/api/v1/sellable-quantity", params: { symbol } },
      { withAccount: true }
    );
  }

  /** 시장별 매매 수수료율. 비용모델의 commissionRate 를 실제 값으로 채울 때 사용한다. */
  async getCommissions(): Promise<Commission[]> {
    return this.request<Commission[]>(
      "ORDER_INFO",
      { method: "GET", url: "/api/v1/commissions" },
      { withAccount: true }
    );
  }
}

// ─── 유틸 ───

/**
 * 미국주식 가격 정밀도 절삭.
 * 스펙: $1 미만은 소수 4자리, $1 이상은 소수 2자리까지. 그 이하 자릿수는 **절삭**(반올림 아님).
 */
export function truncateUsPrice(price: number): string {
  const decimals = Math.abs(price) < 1 ? 4 : 2;
  const factor = 10 ** decimals;
  const truncated = Math.trunc(price * factor + Number.EPSILON * Math.sign(price)) / factor;
  return truncated.toFixed(decimals);
}

/** 응답 헤더에서 레이트리밋 정보를 파싱한다. */
export function parseRateLimitHeaders(headers?: Record<string, unknown>): RateLimitHeaders {
  if (!headers) return {};
  const num = (key: string): number | undefined => {
    const raw = headers[key] ?? headers[key.toLowerCase()];
    if (raw === undefined || raw === null) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    limit: num("x-ratelimit-limit"),
    remaining: num("x-ratelimit-remaining"),
    reset: num("x-ratelimit-reset"),
    retryAfter: num("retry-after"),
  };
}

/** 지수백오프 + jitter. 서버가 알려준 대기시간이 있으면 그 값을 하한으로 삼는다. */
function backoffMs(attempt: number, rl: RateLimitHeaders): number {
  const serverHintSec = rl.retryAfter ?? rl.reset;
  const base = 1000 * 2 ** (attempt - 1); // 1s → 2s → 4s → 8s
  const floor = serverHintSec !== undefined ? serverHintSec * 1000 : 0;
  const jitter = Math.random() * 250;
  return Math.max(base, floor) + jitter;
}

function toTossApiError(err: AxiosError<ErrorResponse>): TossApiError {
  const status = err.response?.status ?? 0;
  const payload = err.response?.data;
  if (payload?.error) {
    return new TossApiError(
      status,
      payload.error.code,
      payload.error.message || `토스 API 오류 (${payload.error.code})`,
      payload.error.requestId,
      payload.error.data ?? null
    );
  }
  return new TossApiError(status, "network-error", err.message);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
