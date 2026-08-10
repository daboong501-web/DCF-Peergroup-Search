/**
 * 일봉 전용 베이스라인 전략 2종.
 *
 * ⚠️ **이 파일의 전략들은 명세 B장의 S1/S2/S3 가 아니다.**
 * 실행 환경에서 미국주식 1분봉을 구할 수 없어 S1·S2·S3 원 명세를 백테스트할 수 없기 때문에,
 * **일봉만으로 정확히 계산 가능하고 명세의 근본 전제를 검증하는** 대체 실험으로 만든 것이다.
 * `data/dailySessionAdapter.ts` 의 합성 3봉 세션과 함께 쓴다.
 *
 * ── S0: daily-open-close (귀무가설 베이스라인) ──────────────────────────────
 * "매일 시가에 사서 종가에 판다" = **롱온리 인트라데이 전량노출·무조건 참여**.
 * 명세 A.4 의 선택적 참여 논리가 정당한지를 실측으로 검증한다.
 * 알파가 전혀 없는 전략이므로 결과는 곧 "인트라데이 드리프트 − 왕복거래비용" 이다.
 *
 * ── S3-proxy: gap-reversal-daily (S3 의 일봉 프록시) ────────────────────────
 * "갭다운 > GAP_MULT × ATR14 & 전일종가 > SMA100 → 시가 진입, **종가 청산**".
 * 원 명세 S3 는 **15분 보유 후 청산**이며 크로스섹션 상위 3종목을 고른다.
 * 이 프록시는 (a) 청산 시점이 다르고 (b) 크로스섹션 랭킹이 없다.
 * ⇒ **원 전략의 성과가 아니다.** 방향성 참고용일 뿐이다.
 */

import { z } from "zod";
import type { Strategy, StrategyPlugin } from "../strategy";
import type { Bar, SessionInfo, Signal, StrategyContext } from "../types";

// ────────────────────────────────────────────────────────────────────────────
// S0 — 매일 시가매수 → 종가매도
// ────────────────────────────────────────────────────────────────────────────

export const dailyOpenCloseParamsSchema = z
  .object({
    symbol: z.string().default("SPY"),
    /**
     * 자본 대비 투입 비중. 1.0 을 그대로 쓰면 정수 주식 + 수수료·슬리피지 여유가 없어
     * 엔진이 현금부족으로 주문을 거부한다. 기본 0.98 은 그 여유분이다.
     */
    sizePct: z.number().positive().max(1).default(0.98),
  })
  .strict();

export type DailyOpenCloseParams = z.infer<typeof dailyOpenCloseParamsSchema>;

export function createDailyOpenCloseStrategy(
  params: DailyOpenCloseParams
): Strategy<DailyOpenCloseParams> {
  const p = params;
  let signaled = false;

  return {
    name: "daily-open-close",
    version: "1.0.0",
    warmupBars: 0,
    paramsSchema: dailyOpenCloseParamsSchema,

    onSessionStart(session: SessionInfo): void {
      signaled = false;
      void session;
    },

    onBar(bar: Bar, ctx: StrategyContext): Signal | null {
      if (bar.symbol !== p.symbol) return null;
      const offset = Math.round((bar.t - ctx.session.openMs) / 60_000);
      if (offset !== 0 || signaled) return null;
      if (!ctx.canEnter) return null;
      signaled = true;
      return {
        kind: "BUY",
        symbol: p.symbol,
        orderType: "MARKET",
        sizePct: p.sizePct,
        reason: "S0 무조건 참여 (시가매수 → 종가매도)",
      };
    },
  };
}

export const dailyOpenClosePlugin: StrategyPlugin<DailyOpenCloseParams> = {
  name: "daily-open-close",
  version: "1.0.0",
  paramsSchema: dailyOpenCloseParamsSchema,
  create: (params) => createDailyOpenCloseStrategy(params),
};

// ────────────────────────────────────────────────────────────────────────────
// S3-proxy — 갭다운 반전 (시가 진입 → 종가 청산)
// ────────────────────────────────────────────────────────────────────────────

export const gapReversalDailyParamsSchema = z
  .object({
    symbol: z.string().default("SPY"),
    /** 갭다운 임계 (ATR14 배수). 원 규칙 1.2. */
    gapMult: z.number().positive().default(1.2),
    /** 하드 손절률. 0 이면 무손절. */
    stopPct: z.number().min(0).default(0.015),
    /** 자본 대비 투입 비중. 명세 S3 의 종목당 비중은 0.10. */
    sizePct: z.number().positive().max(1).default(0.1),
    /** 전일 종가 > SMA100 추세 필터 사용 여부. 원 규칙은 사용. */
    requireAboveSma: z.boolean().default(true),
    /** `YYYY-MM-DD`(ET) → 전일 일봉 종가. */
    prevClose: z.record(z.string(), z.number()).default({}),
    /** `YYYY-MM-DD`(ET) → 전일까지의 ATR14. */
    atr14: z.record(z.string(), z.number()).default({}),
    /** `YYYY-MM-DD`(ET) → 전일까지의 SMA100. */
    sma100: z.record(z.string(), z.number()).default({}),
  })
  .strict();

export type GapReversalDailyParams = z.infer<typeof gapReversalDailyParamsSchema>;

export function createGapReversalDailyStrategy(
  params: GapReversalDailyParams
): Strategy<GapReversalDailyParams> {
  const p = params;
  let signaled = false;

  return {
    name: "gap-reversal-daily",
    version: "1.0.0",
    warmupBars: 0,
    paramsSchema: gapReversalDailyParamsSchema,

    onSessionStart(session: SessionInfo): void {
      signaled = false;
      void session;
    },

    onBar(bar: Bar, ctx: StrategyContext): Signal | null {
      if (bar.symbol !== p.symbol) return null;
      const offset = Math.round((bar.t - ctx.session.openMs) / 60_000);
      if (offset !== 0 || signaled) return null;
      signaled = true;

      const d = ctx.session.date;
      const prev = p.prevClose[d];
      const atr = p.atr14[d];
      const sma = p.sma100[d];
      if (!(typeof prev === "number" && prev > 0)) return null;
      if (!(typeof atr === "number" && atr > 0)) return null;
      if (p.requireAboveSma) {
        if (!(typeof sma === "number" && sma > 0)) return null;
        if (!(prev > sma)) return null;
      }

      const gapAtr = (bar.o - prev) / atr;
      if (!(gapAtr < -p.gapMult)) return null;
      if (!ctx.canEnter) return null;

      ctx.log(`[S3-proxy] ${d} gapAtr=${gapAtr.toFixed(2)} → 시가 진입`);
      const signal: Signal = {
        kind: "BUY",
        symbol: p.symbol,
        orderType: "MARKET",
        sizePct: p.sizePct,
        reason: `gapdown ${gapAtr.toFixed(2)}×ATR (종가청산 프록시)`,
      };
      if (p.stopPct > 0) signal.stopLoss = bar.o * (1 - p.stopPct);
      return signal;
    },
  };
}

export const gapReversalDailyPlugin: StrategyPlugin<GapReversalDailyParams> = {
  name: "gap-reversal-daily",
  version: "1.0.0",
  paramsSchema: gapReversalDailyParamsSchema,
  create: (params) => createGapReversalDailyStrategy(params),
};
