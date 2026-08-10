/**
 * S1 — MIM-Close (Market Intraday Momentum, 마감 30분 모멘텀)
 *
 * 원 출처: Gao, Han, Li & Zhou, *Market Intraday Momentum*,
 *          Journal of Financial Economics 2018 / SSRN 2440866 · 2552752
 * 집행 명세: docs/auto-trading/02-strategy-spec.md §B.1
 *
 * 규칙 요약
 *   1) 개장 후 30분(09:30~10:00 ET)의 수익률 r30 = close(개장+30분) / 전일종가 − 1
 *   2) 마감 30분 전(15:30 ET) 봉에서 r30 > THETA_LONG 이면 롱 진입, 아니면 **미참여**
 *   3) 청산은 엔진의 EOD 강제청산(= LOC 종가청산 모사)이 담당
 *
 * ── 엔진 계약 준수 ──────────────────────────────────────────────────────────
 * - `onBar` 는 동기 함수이며 외부 조회를 하지 않는다.
 * - 과거 데이터는 `ctx.history()` 로만 본다 (미래 봉 접근 경로 자체가 없다).
 * - 신호는 다음 봉 시가에 체결된다 (15:30 봉 판정 → 15:31 시가 진입).
 *
 * ── 조기폐장일 대응 ─────────────────────────────────────────────────────────
 * ET 라벨("09:59", "15:30")을 하드코딩하지 않는다. 전부 `session.openMs` /
 * `session.closeMs` 기준 상대 오프셋으로 판정하므로 13:00 ET 조기폐장일에도
 * 자동으로 올바른 봉에서 발동한다.
 *
 * ── 전일 종가 확보 ──────────────────────────────────────────────────────────
 * 1순위: `prevDailyClose` 파라미터(일봉에서 산출해 init 단계에 주입).
 * 2순위: 직전 세션에서 관측한 마지막 정규장 봉의 종가(내부 추적).
 *        정규장 종가와 공식 종가가 미세하게 다를 수 있으므로 **1순위 주입을 권장**한다.
 */

import { z } from "zod";
import type { Strategy, StrategyPlugin } from "../strategy";
import type { Bar, SessionInfo, Signal, StrategyContext } from "../types";

export const mimCloseParamsSchema = z
  .object({
    /** 거래 심볼. 논문 표본은 SPY 1종목. */
    symbol: z.string().default("SPY"),
    /**
     * 롱 진입 임계값. 논문은 부호 조건만 사용하므로 확정값 0.
     * D.5.1 탐색 범위: {0, 5bp, 10bp, 15bp, 20bp}
     */
    thetaLong: z.number().default(0),
    /**
     * 하드 손절률. **[자체판단 · 검증대상]** — 논문에는 손절이 없다.
     * 0 이면 무손절(탐색 범위의 "무손절" 케이스).
     * D.5.1 탐색 범위: {0.005, 0.010, 0.015, 0(무손절)}
     */
    stopPct: z.number().min(0).default(0.01),
    /** 1트레이드 리스크 (계좌 대비). **[자체판단 · 검증대상]** */
    riskPerTrade: z.number().positive().default(0.005),
    /** 종목당 투입 상한. **[자체판단 · 검증대상]** */
    maxPositionPct: z.number().positive().max(1).default(0.3),
    /** 신호 측정 구간 길이(분). 논문값 30. */
    signalWindowMinutes: z.number().positive().default(30),
    /** 진입 판정 시점(마감 N분 전). 논문값 30. */
    entryBeforeCloseMinutes: z.number().positive().default(30),
    /** 전일 일봉 종가 맵 (`YYYY-MM-DD`(ET) → 종가). 일봉에서 산출해 주입한다. */
    prevDailyClose: z.record(z.string(), z.number()).default({}),
  })
  .strict();

export type MimCloseParams = z.infer<typeof mimCloseParamsSchema>;

/** 참여율 진단이 붙은 S1 전략 인스턴스. 참여율은 H6 판정에 쓴다. */
export interface MimCloseStrategy extends Strategy<MimCloseParams> {
  /** 세션 수 대비 실제 진입한 세션 비율 (선택적 참여의 정량화). */
  stats(): { sessions: number; participated: number; participationRate: number };
}

export function createMimCloseStrategy(params: MimCloseParams): MimCloseStrategy {
  const p = params;

  // 세션 상태
  let r30: number | null = null;
  let decided = false;
  let entered = false;

  // 전일 종가 폴백용 추적
  let prevSessionClose: number | null = null;
  let runningSessionClose: number | null = null;

  // 참여율 집계 (H6)
  let sessionCount = 0;
  let participatedCount = 0;

  const resolvePrevClose = (session: SessionInfo): number | null => {
    const injected = p.prevDailyClose[session.date];
    if (typeof injected === "number" && injected > 0) return injected;
    return prevSessionClose;
  };

  return {
    name: "mim-close",
    version: "1.0.0",
    warmupBars: 0,
    paramsSchema: mimCloseParamsSchema,

    onSessionStart(session: SessionInfo): void {
      prevSessionClose = runningSessionClose;
      runningSessionClose = null;
      r30 = null;
      decided = false;
      entered = false;
      sessionCount += 1;
      void session;
    },

    onBar(bar: Bar, ctx: StrategyContext): Signal | null {
      if (bar.symbol !== p.symbol) return null;
      runningSessionClose = bar.c;

      const elapsedMin = (bar.t - ctx.session.openMs) / 60_000;
      const w = p.signalWindowMinutes;

      // ── (1) 개장 후 W분 수익률 확정. W=30 이면 09:59 봉(종가 시각 = 10:00).
      if (r30 === null && elapsedMin >= w - 1 && elapsedMin < w) {
        const prevClose = resolvePrevClose(ctx.session);
        if (prevClose === null || !(prevClose > 0)) {
          ctx.log(`[S1] ${ctx.session.date} 전일 종가 없음 → r30 미산출`);
          return null;
        }
        r30 = bar.c / prevClose - 1;
        ctx.log(`[S1] ${ctx.session.date} r30 = ${(r30 * 100).toFixed(3)}%`);
        return null;
      }

      // ── (2) 마감 E분 전 봉에서 단 1회 진입 판정.
      const e = p.entryBeforeCloseMinutes;
      const mtc = ctx.minutesToClose;
      if (!decided && mtc <= e && mtc > e - 1) {
        decided = true;
        if (r30 === null) {
          ctx.log(`[S1] ${ctx.session.date} r30 미산출(데이터 공백) → 미참여`);
          return null;
        }
        if (r30 <= p.thetaLong) {
          ctx.log(
            `[S1] ${ctx.session.date} r30=${(r30 * 100).toFixed(3)}% ≤ θ → 미참여 (선택적 참여)`
          );
          return null;
        }
        if (!ctx.canEnter) {
          ctx.log(`[S1] ${ctx.session.date} 엔진이 진입 차단(손실한도/시간) → 미참여`);
          return null;
        }
        entered = true;
        participatedCount += 1;
        const sizePct =
          p.stopPct > 0 ? Math.min(p.riskPerTrade / p.stopPct, p.maxPositionPct) : p.maxPositionPct;
        const signal: Signal = {
          kind: "BUY",
          symbol: p.symbol,
          orderType: "MARKET",
          sizePct,
          reason: `MIM r30=${(r30 * 100).toFixed(3)}%`,
        };
        if (p.stopPct > 0) signal.stopLoss = bar.c * (1 - p.stopPct);
        return signal;
      }

      // ── (3) 청산은 엔진의 EOD 강제청산(LOC 모사)이 담당한다.
      return null;
    },

    onSessionEnd(session: SessionInfo): void {
      void session;
      void entered;
    },

    /** 리포트용 참여율 (H6). 엔진은 이 메서드를 호출하지 않는다. */
    stats() {
      return {
        sessions: sessionCount,
        participated: participatedCount,
        participationRate: sessionCount > 0 ? participatedCount / sessionCount : 0,
      };
    },
  };
}

export const mimClosePlugin: StrategyPlugin<MimCloseParams> = {
  name: "mim-close",
  version: "1.0.0",
  paramsSchema: mimCloseParamsSchema,
  create: (params) => createMimCloseStrategy(params),
};
