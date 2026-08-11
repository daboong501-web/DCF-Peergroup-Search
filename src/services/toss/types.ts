/**
 * 토스증권 Open API 응답 타입.
 *
 * 출처: /workspace/beoks/tossinvest-skill/references/openapi.json (OpenAPI 3.1.0, v1.1.1)
 * 모든 필드명·타입은 위 스펙에서 직접 확인한 것이며 추측하지 않았다.
 * 스펙에서 확인되지 않은 항목은 `// 미확인: 스펙에 없음` 으로 표기한다.
 *
 * 주의: 스펙상 금액·수량류는 전부 `format: decimal` 의 **문자열**이다.
 *       부동소수 오차를 피하기 위해 API 경계에서는 string 을 유지하고,
 *       숫자 변환은 호출부(트레이딩 코어)에서 명시적으로 수행한다.
 */

// ─── 공통 envelope ───

/** 성공 응답 envelope. 200 응답에 사용. */
export interface ApiResponse<T> {
  result: T;
}

/** 에러 객체. requestId/code/message 는 필수. */
export interface ApiError {
  requestId: string;
  /** flat string 식별자 (예: `invalid-request`, `order-not-found`). unknown code 허용 필요. */
  code: string;
  message: string;
  /** 에러 해결 힌트. 코드별로 키 구조가 다르며 없으면 필드 자체가 생략된다. */
  data?: Record<string, unknown> | null;
}

/** 에러 응답 envelope. 4xx/5xx 응답에 사용. */
export interface ErrorResponse {
  error: ApiError;
}

/** 스펙상 enum 이지만 "클라이언트는 unknown enum 값을 허용하도록 구현" 요구가 있어 확장 가능하게 둔다. */
type OpenEnum<T extends string> = T | (string & {});

export type Currency = OpenEnum<"KRW" | "USD">;
export type MarketCountry = OpenEnum<"KR" | "US">;

// ─── 인증 (POST /oauth2/token) ───

export interface OAuth2TokenRequest {
  grant_type: "client_credentials";
  client_id: string;
  client_secret: string;
}

/** 토큰 응답은 공통 envelope 을 쓰지 않고 OAuth2 표준 형식이다. */
export interface OAuth2TokenResponse {
  access_token: string;
  token_type: "Bearer";
  /** 만료까지 남은 초. */
  expires_in: number;
}

export interface OAuth2ErrorResponse {
  error:
    | "invalid_request"
    | "invalid_client"
    | "invalid_grant"
    | "unauthorized_client"
    | "unsupported_grant_type";
  error_description?: string;
  error_uri?: string;
}

// ─── 캔들 (GET /api/v1/candles) ───

/** 스펙상 interval 은 `1m`, `1d` 두 가지뿐이다. */
export type CandleInterval = "1m" | "1d";

export interface Candle {
  /** 봉 **시작** 시각 (ISO 8601, offset 포함). 예: "2026-03-25T09:00:00+09:00" */
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  currency: Currency;
}

export interface CandlePageResponse {
  candles: Candle[];
  /** 다음 페이지의 `before` 로 그대로 전달. 마지막 페이지면 null. */
  nextBefore?: string | null;
}

export interface CandleQuery {
  symbol: string;
  interval: CandleInterval;
  /** 1~200. 기본 100. 1회 최대 200봉. */
  count?: number;
  /** 페이지네이션 상한 (exclusive, ISO 8601). */
  before?: string;
  /** 수정주가 적용 여부. 기본 true. */
  adjusted?: boolean;
}

// ─── 현재가 (GET /api/v1/prices) ───

export interface PriceResponse {
  symbol: string;
  /** 체결 미발생 등으로 시각이 없을 수 있다. */
  timestamp?: string | null;
  lastPrice: string;
  currency: Currency;
}

// ─── 종목 정보 (GET /api/v1/stocks) ───

export interface KrMarketDetail {
  liquidationTrading: boolean;
  nxtSupported: boolean;
  krxTradingSuspended: boolean;
  /** NXT 미지원 종목은 null. */
  nxtTradingSuspended?: boolean | null;
}

export interface StockInfo {
  symbol: string;
  name: string;
  englishName: string;
  isinCode: string;
  market: OpenEnum<"KOSPI" | "KOSDAQ" | "NYSE" | "NASDAQ" | "AMEX" | "KR_ETC" | "US_ETC">;
  securityType: OpenEnum<
    | "STOCK"
    | "FOREIGN_STOCK"
    | "DEPOSITARY_RECEIPT"
    | "INFRASTRUCTURE_FUND"
    | "REIT"
    | "ETF"
    | "FOREIGN_ETF"
    | "ETN"
    | "STOCK_WARRANTS"
  >;
  isCommonShare: boolean;
  status: OpenEnum<"SCHEDULED" | "ACTIVE" | "DELISTED">;
  currency: Currency;
  listDate?: string | null;
  delistDate?: string | null;
  sharesOutstanding: string;
  /** ETF/ETN 에만 적용. 일반 주식은 null. */
  leverageFactor?: string | null;
  /** 해외 종목은 null. */
  koreanMarketDetail?: KrMarketDetail | null;
}

// ─── 미국 장 운영 정보 (GET /api/v1/market-calendar/US) ───

/** 4개 세션 모두 startTime/endTime 만 갖는 동일 형태다. */
export interface UsMarketSession {
  startTime: string;
  endTime: string;
}

export interface UsMarketDay {
  /** 미국 현지 기준 영업일 (YYYY-MM-DD). */
  date: string;
  /** 데이마켓 (토스증권 자체 세션). 휴장이면 null. */
  dayMarket?: UsMarketSession | null;
  preMarket?: UsMarketSession | null;
  /** 정규장. 당일청산 전략의 기준 세션. */
  regularMarket?: UsMarketSession | null;
  afterMarket?: UsMarketSession | null;
}

export interface UsMarketCalendarResponse {
  today: UsMarketDay;
  previousBusinessDay: UsMarketDay;
  nextBusinessDay: UsMarketDay;
}

// ─── 호가 (GET /api/v1/orderbook) ───

export interface OrderbookEntry {
  /** 호가. */
  price: string;
  /** 잔량. */
  volume: string;
}

export interface OrderbookResponse {
  /** 데이터 시각. 데이터 미제공 시 null. */
  timestamp?: string | null;
  currency: Currency;
  /** 매도호가 목록 (낮은 가격순). asks[0] 이 최우선 매도호가. */
  asks: OrderbookEntry[];
  /** 매수호가 목록 (높은 가격순). bids[0] 이 최우선 매수호가. */
  bids: OrderbookEntry[];
}

// ─── 국내 장 운영 정보 (GET /api/v1/market-calendar/KR) ───

/**
 * 거래 가능 시간. **통합 모드(KRX+NXT) 기준**이라 KRX 정규장 마감(15:30)과 다르다.
 * 당일청산 기준 시각으로 그대로 쓰면 안 되고, 휴장일 판정에만 쓸 것.
 */
export interface IntegratedHour {
  preMarket?: { startTime: string; endTime: string } | null;
  regularMarket?: { startTime: string; endTime: string } | null;
  afterMarket?: { startTime: string; endTime: string } | null;
}

export interface KrMarketDay {
  /** 영업일 (KST 기준, YYYY-MM-DD). */
  date: string;
  /** 통합(KRX+NXT) 거래 가능 시간. 둘 다 휴장이면 null. */
  integrated?: IntegratedHour | null;
}

export interface KrMarketCalendarResponse {
  today: KrMarketDay;
  previousBusinessDay: KrMarketDay;
  nextBusinessDay: KrMarketDay;
}

// ─── 계좌 / 자산 ───

export interface Account {
  accountNo: string;
  /** 주문 등 API 호출 시 `X-Tossinvest-Account` 헤더에 넣는 값. */
  accountSeq: number;
  accountType: OpenEnum<
    "BROKERAGE" | "OVERSEAS_DERIVATIVES" | "PENSION_SAVINGS" | "RESHORING_INVESTMENT"
  >;
}

/** 통화별 합산 금액. 환산 합산은 없다. */
export interface TossPriceByCurrency {
  krw: string;
  /** 해외 종목이 없으면 null. */
  usd?: string | null;
}

export interface MarketValue {
  purchaseAmount: string;
  amount: string;
  amountAfterCost: string;
}

export interface ProfitLoss {
  amount: string;
  amountAfterCost: string;
  /** 소수비율 (0.1077 = 10.77%). */
  rate: string;
  rateAfterCost: string;
}

export interface DailyProfitLoss {
  amount: string;
  rate: string;
}

export interface Cost {
  commission: string;
  /** 세금이 없으면 null. */
  tax?: string | null;
}

export interface HoldingsItem {
  symbol: string;
  name: string;
  marketCountry: MarketCountry;
  currency: Currency;
  quantity: string;
  lastPrice: string;
  averagePurchasePrice: string;
  marketValue: MarketValue;
  profitLoss: ProfitLoss;
  dailyProfitLoss: DailyProfitLoss;
  cost: Cost;
}

export interface OverviewMarketValue {
  amount: TossPriceByCurrency;
  amountAfterCost: TossPriceByCurrency;
}

export interface OverviewProfitLoss {
  amount: TossPriceByCurrency;
  amountAfterCost: TossPriceByCurrency;
  rate: string;
  rateAfterCost: string;
}

export interface OverviewDailyProfitLoss {
  amount: TossPriceByCurrency;
  rate: string;
}

export interface HoldingsOverview {
  totalPurchaseAmount: TossPriceByCurrency;
  marketValue: OverviewMarketValue;
  profitLoss: OverviewProfitLoss;
  dailyProfitLoss: OverviewDailyProfitLoss;
  items: HoldingsItem[];
}

// ─── 주문 ───

export type OrderSide = "BUY" | "SELL";
/** 스톱로스 주문타입은 없다. 손절은 엔진이 직접 감시해서 시장가/지정가로 낸다. */
export type OrderType = "LIMIT" | "MARKET";
/** `LIMIT` + `CLS` = LOC (미국주식 전용). `OPG` 는 조회 응답에만 등장하며 현재 미지원. */
export type TimeInForce = OpenEnum<"DAY" | "CLS">;

export interface OrderCreateQuantityBased {
  /** 멱등성 키. 10분간 유효. 최대 36자, `^[a-zA-Z0-9\-_]+$`. */
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce?: TimeInForce;
  /** 정수 문자열만 허용 (`^\d+$`). 소수 주문은 orderAmount 변형을 써야 한다. */
  quantity: string;
  /** LIMIT 일 때 필수, MARKET 일 때 전달 불가. */
  price?: string;
  confirmHighValueOrder?: boolean;
}

/** 금액 기반 주문 (US MARKET 전용). */
export interface OrderCreateAmountBased {
  clientOrderId?: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce?: TimeInForce;
  orderAmount: string;
  confirmHighValueOrder?: boolean;
}

export type OrderCreateRequest = OrderCreateQuantityBased | OrderCreateAmountBased;

export interface OrderModifyRequest {
  orderType: OrderType;
  /** KR 필수 / US 전달 불가 (US 는 가격 정정만 가능). */
  quantity?: string;
  price?: string;
  confirmHighValueOrder?: boolean;
}

export interface OrderResponse {
  orderId: string;
  /** 요청 시 전달한 clientOrderId 를 그대로 반환. 미전달 시 null. */
  clientOrderId?: string | null;
}

export interface OrderOperationResponse {
  /** 정정/취소로 **새로 발급된** 주문 식별자. 원주문 orderId 와 다르다. */
  orderId: string;
}

export type OrderStatus = OpenEnum<
  | "PENDING"
  | "PENDING_CANCEL"
  | "PENDING_REPLACE"
  | "PARTIAL_FILLED"
  | "FILLED"
  | "CANCELED"
  | "REJECTED"
  | "CANCEL_REJECTED"
  | "REPLACE_REJECTED"
  | "REPLACED"
>;

export interface OrderExecution {
  filledQuantity: string;
  averageFilledPrice?: string | null;
  filledAmount?: string | null;
  commission?: string | null;
  tax?: string | null;
  filledAt?: string | null;
  settlementDate?: string | null;
}

export interface Order {
  orderId: string;
  symbol: string;
  side: OrderSide;
  orderType: OrderType;
  timeInForce: OpenEnum<"DAY" | "CLS" | "OPG">;
  status: OrderStatus;
  /** MARKET 주문은 null. */
  price?: string | null;
  quantity: string;
  /** 금액 기반 US 시장가 매수 주문에만 값이 있다. */
  orderAmount?: string | null;
  currency: Currency;
  orderedAt: string;
  canceledAt?: string | null;
  execution: OrderExecution;
}

export interface PaginatedOrderResponse {
  orders: Order[];
  nextCursor?: string | null;
  hasNext: boolean;
}

// ─── 주문 참고 정보 ───

export interface BuyingPowerResponse {
  currency: Currency;
  cashBuyingPower: string;
}

export interface SellableQuantityResponse {
  sellableQuantity: string;
}

export interface Commission {
  marketCountry: MarketCountry;
  /** 수수료율 (%). 0.015 = 0.015%. */
  commissionRate: string;
  /** 해외주식은 null. */
  startDate?: string | null;
  endDate?: string | null;
}

export interface ExchangeRateResponse {
  baseCurrency: Currency;
  quoteCurrency: Currency;
  rate: string;
  midRate: string;
  basisPoint: string;
  rateChangeType: OpenEnum<"UP" | "EQUAL" | "DOWN">;
  validFrom: string;
  validUntil: string;
}

// ─── 레이트리밋 ───

/**
 * Rate Limits Group 별 초당 허용 요청 수.
 * 출처: references/official-overview.md §Rate Limits.
 * 운영 상황에 따라 조정될 수 있으므로 응답 헤더 `X-RateLimit-Limit` 로 실제 한도를 확인한다.
 */
export type RateLimitGroup =
  | "AUTH"
  | "ACCOUNT"
  | "ASSET"
  | "STOCK"
  | "MARKET_INFO"
  | "MARKET_DATA"
  | "MARKET_DATA_CHART"
  | "ORDER"
  | "ORDER_HISTORY"
  | "ORDER_INFO";

export const RATE_LIMITS: Record<RateLimitGroup, number> = {
  AUTH: 5,
  ACCOUNT: 1,
  ASSET: 5,
  STOCK: 5,
  MARKET_INFO: 3,
  MARKET_DATA: 10,
  MARKET_DATA_CHART: 5,
  // ORDER/ORDER_INFO 는 09:00~09:10 KST 피크시간에 초당 3회로 낮아진다 (client.ts 에서 반영).
  ORDER: 6,
  ORDER_HISTORY: 5,
  ORDER_INFO: 6,
};

/** 응답 헤더로 내려오는 레이트리밋 정보. */
export interface RateLimitHeaders {
  limit?: number;
  remaining?: number;
  /** 토큰 1개 재충전까지 예상 초. */
  reset?: number;
  /** 429 응답에만 포함. 재시도 권장 초. */
  retryAfter?: number;
}
