/**
 * 토스증권 OAuth2 토큰 발급/캐싱.
 *
 * 스펙 확인 사항 (references/openapi.json + workflows.md):
 * - POST /oauth2/token, `application/x-www-form-urlencoded`, grant_type=client_credentials
 * - 응답은 공통 envelope 이 아닌 OAuth2 표준 형식 (access_token / token_type / expires_in)
 * - refresh token 없음. 재발급 시 **이전 토큰이 무효화**되므로 프로세스 간 동시 발급을 피해야 한다.
 *   → 이 모듈은 in-flight 발급 요청을 하나로 합쳐(single-flight) 중복 발급을 막는다.
 */

import axios from "axios";
import type { OAuth2ErrorResponse, OAuth2TokenResponse } from "./types";

export const TOSS_API_BASE = "https://openapi.tossinvest.com";

/** 만료 몇 초 전에 미리 갱신할지. 네트워크 지연·시계 오차 대비. */
const DEFAULT_SKEW_SECONDS = 60;

export interface TossAuthConfig {
  clientId: string;
  clientSecret: string;
  baseUrl?: string;
  /** 만료 전 갱신 여유 (초). 기본 60. */
  skewSeconds?: number;
  timeoutMs?: number;
}

/** 환경변수에서 인증 설정을 읽는다. 없으면 명확한 에러를 던진다. */
export function loadTossAuthConfigFromEnv(): TossAuthConfig {
  const clientId = process.env.TOSS_CLIENT_ID;
  const clientSecret = process.env.TOSS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "TOSS_AUTH_CONFIG_MISSING: 환경변수 TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 가 필요합니다."
    );
  }
  return {
    clientId,
    clientSecret,
    baseUrl: process.env.TOSS_API_BASE ?? TOSS_API_BASE,
  };
}

/** 계좌 식별 키(accountSeq). 주문/계좌 API 의 `X-Tossinvest-Account` 헤더에 쓰인다. */
export function loadAccountSeqFromEnv(): number | null {
  const raw = process.env.TOSS_ACCOUNT_SEQ;
  if (!raw) return null;
  const seq = Number(raw);
  if (!Number.isFinite(seq)) {
    throw new Error(`TOSS_ACCOUNT_SEQ_INVALID: 정수가 아닙니다 (${raw})`);
  }
  return seq;
}

export class TossTokenProvider {
  private readonly config: Required<Omit<TossAuthConfig, "baseUrl">> & { baseUrl: string };
  private token: string | null = null;
  /** epoch ms 기준 만료 시각. */
  private expiresAtMs = 0;
  private inflight: Promise<string> | null = null;

  constructor(config: TossAuthConfig) {
    this.config = {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      baseUrl: (config.baseUrl ?? TOSS_API_BASE).replace(/\/+$/, ""),
      skewSeconds: config.skewSeconds ?? DEFAULT_SKEW_SECONDS,
      timeoutMs: config.timeoutMs ?? 15000,
    };
  }

  /** 유효한 access token 을 반환한다. 만료가 임박했으면 자동 재발급. */
  async getToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.token && now < this.expiresAtMs) {
      return this.token;
    }
    // 재발급이 이전 토큰을 무효화하므로 동시 요청을 하나로 합친다.
    if (this.inflight) return this.inflight;

    this.inflight = this.issue().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** 401 수신 시 호출. 다음 요청에서 강제 재발급되도록 캐시를 비운다. */
  invalidate(): void {
    this.token = null;
    this.expiresAtMs = 0;
  }

  private async issue(): Promise<string> {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
    });

    try {
      const res = await axios.post<OAuth2TokenResponse>(
        `${this.config.baseUrl}/oauth2/token`,
        body.toString(),
        {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: this.config.timeoutMs,
        }
      );
      const data = res.data;
      if (!data?.access_token) {
        throw new Error("TOSS_AUTH_FAILED: 응답에 access_token 이 없습니다.");
      }
      this.token = data.access_token;
      const ttlSec = Math.max(0, data.expires_in - this.config.skewSeconds);
      this.expiresAtMs = Date.now() + ttlSec * 1000;
      return this.token;
    } catch (err) {
      throw new Error(`TOSS_AUTH_FAILED: ${describeOAuthError(err)}`);
    }
  }
}

function describeOAuthError(err: unknown): string {
  if (axios.isAxiosError(err) && err.response) {
    const payload = err.response.data as Partial<OAuth2ErrorResponse> | undefined;
    if (payload?.error) {
      return `${payload.error}${payload.error_description ? ` (${payload.error_description})` : ""}`;
    }
    return `HTTP ${err.response.status}`;
  }
  return err instanceof Error ? err.message : String(err);
}
