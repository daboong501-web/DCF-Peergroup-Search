/**
 * S2 — Concretum Noise-Area Breakout (롱온리)
 *
 * 원 출처: Zarattini, Aziz & Barbon, *Beat the Market — An Effective Intraday Momentum
 *          Strategy for S&P500 ETF (SPY)*, SSRN 4824172 / Concretum Group
 * 집행 명세: docs/auto-trading/02-strategy-spec.md §B.2
 *
 * 밴드 정의 (명세 B.2.2 그대로)
 *   σ(τ)          = (1/N) × Σ_{d=1..N} | close_d(τ) / open_d(개장) − 1 |
 *   Upper_today(τ) = open_today(개장) × ( 1 + M × σ(τ) )
 *   τ 는 개장 이후 경과분(minute-of-session). **당일 시가로 정규화하므로 오버나잇 갭이 자동 보정된다.**
 *
 * 하단 밴드는 계산하지 않는다 — 하단 이탈 신호는 숏이며 토스 API 는 공매도를 지원하지 않는다
 * (명세 A.3.1).
 *
 * ── σ 의 조달 ───────────────────────────────────────────────────────────────
 * 명세는 `init()` 주입을 상정하지만, σ 는 **과거 정규장 봉만으로 인과적으로 계산 가능**하다.
 * 따라서 이 구현은 `ctx.history()` 에 실제로 흘러온 봉만으로 σ 를 롤링 산출한다
 * (외부 조회 없음 = 엔진 계약 준수, 그리고 주입 실수로 인한 미래참조 위험 제거).
 * 실거래에서 사전 계산값을 쓰고 싶으면 `sigmaByOffset` 파라미터로 덮어쓸 수 있다.
 *
 * ── 조기폐장일 대응 ─────────────────────────────────────────────────────────
 * 격자·점심시간·마지막 진입시각을 전부 `session.openMs` 기준 경과분으로 판정한다.
 */

import { z } from "zod";
import type { Strategy, StrategyPlugin } from "../strategy";
import type { Bar, SessionInfo, Signal, StrategyContext } from "../types";

export const concretumParamsSchema = z
  .object({
    symbol: z.string().default("SPY"),
    /** 룩백 거래일 수 N. 논문값 14. D.5.1 탐색 범위 {7, 14, 21}. */
    lookbackDays: z.number().int().positive().default(14),
    /** 변동성 배수 M. 논문값 1.0. D.5.1 탐색 범위 {0.75, 1.0, 1.25}. */
    multiplier: z.number().positive().default(1.0),
    /** 판정 격자 (분). 논문 "30분마다 추세 방향 재확인". */
    gridMinutes: z.number().int().positive().default(30),
    /** 점심 배제 구간 시작 (개장 후 경과분). 11:30 ET = 개장+120분. */
    lunchStartOffset: z.number().int().nonnegative().default(120),
    /** 점심 배제 구간 종료 (개장 후 경과분, 미포함). 13:30 ET = 개장+240분. */
    lunchEndOffset: z.number().int().nonnegative().default(240),
    /**
     * 마지막 신규진입 격자 (개장 후 경과분). 15:00 ET = 개장+330분.
     * **[자체판단 · 검증대상]** — 15:30 이후는 S1 영역이라 중복 회피.
     */
    lastEntryOffset: z.number().int().nonnegative().default(330),
    /** 하드 손절률. **[자체판단 · 검증대상]** — 논문에 하드스톱 없음. D.5.1 {0.010, 0.015, 0.020}. */
    stopPct: z.number().min(0).default(0.015),
    /** 1트레이드 리스크. **[자체판단 · 검증대상]** */
    riskPerTrade: z.number().positive().default(0.005),
    /** 종목당 투입 상한. **[자체판단 · 검증대상]** */
    maxPositionPct: z.number().positive().max(1).default(0.3),
    /**
     * σ 사전 주입 (개장 후 경과분 문자열 → σ). 지정하면 롤링 계산 대신 이 값을 쓴다.
     * 예: `{"30": 0.0012, "60": 0.0018}`
     */
    sigmaByOffset: z.record(z.string(), z.number()).default({}),
  })
  .strict();

export type ConcretumParams = z.infer<typeof concretumParamsSchema>;

interface SessionProfile {
  open: number;
  /** 개장 후 경과분 → 그 봉의 종가. */
  closes: Map<number, number>;
}

export function createConcretumStrategy(params: ConcretumParams): Strategy<ConcretumParams> {
  const p = params;

  const past: SessionProfile[] = [];
  let current: SessionProfile | null = null;

  let sessionOpen: number | null = null;
  let vwapNum = 0;
  let vwapDen = 0;

  const sigmaFor = (offset: number): number | null => {
    const injected = p.sigmaByOffset[String(offset)];
    if (typeof injected === "number" && injected >= 0) return injected;

    let sum = 0;
    let count = 0;
    for (const s of past) {
      const c = s.closes.get(offset);
      if (c === undefined || !(s.open > 0)) continue;
      sum += Math.abs(c / s.open - 1);
      count += 1;
    }
    // 논문 정의상 N 일 전부가 필요하다. 부족하면 밴드를 만들지 않는다(= 미참여).
    if (count < p.lookbackDays) return null;
    return sum / count;
  };

  return {
    name: "concretum-noise",
    version: "1.0.0",
    // 14거래일 × 390분 = 5,460봉. 그 전 신호는 엔진이 버린다.
    warmupBars: 14 * 390,
    paramsSchema: concretumParamsSchema,

    onSessionStart(session: SessionInfo): void {
      if (current && current.closes.size > 0) {
        past.push(current);
        while (past.length > p.lookbackDays) past.shift();
      }
      current = null;
      sessionOpen = null;
      vwapNum = 0;
      vwapDen = 0;
      void session;
    },

    onBar(bar: Bar, ctx: StrategyContext): Signal | null {
      if (bar.symbol !== p.symbol) return null;

      const offset = Math.round((bar.t - ctx.session.openMs) / 60_000);

      if (offset === 0) {
        sessionOpen = bar.o;
        current = { open: bar.o, closes: new Map() };
      }
      if (sessionOpen === null || current === null) return null;
      current.closes.set(offset, bar.c);

      // ── 당일 VWAP 누적 (정규장 봉만 — includeExtendedHours=false 로 보장된다)
      const typical = (bar.h + bar.l + bar.c) / 3;
      vwapNum += typical * bar.v;
      vwapDen += bar.v;
      const vwap = vwapDen > 0 ? vwapNum / vwapDen : bar.c;

      const pos = ctx.position(p.symbol);

      // ── (A) 매 1분봉 청산 감시: VWAP 하향 이탈 [논문의 트레일링 정의]
      if (pos && pos.qty > 0 && bar.c < vwap) {
        return { kind: "EXIT", symbol: p.symbol, orderType: "MARKET", reason: "VWAP 하향이탈" };
      }

      // ── (B) 30분 격자에서만 진입/밴드복귀 판정
      const onGrid =
        offset > 0 && offset % p.gridMinutes === 0 && offset <= p.lastEntryOffset;
      if (!onGrid) return null;

      const sigma = sigmaFor(offset);
      if (sigma === null) return null;
      const upper = sessionOpen * (1 + p.multiplier * sigma);

      if (pos && pos.qty > 0) {
        if (bar.c < upper) {
          return { kind: "EXIT", symbol: p.symbol, orderType: "MARKET", reason: "밴드 내 복귀" };
        }
        return null;
      }

      // ── (C) 신규 진입
      if (!ctx.canEnter) return null;
      if (offset >= p.lunchStartOffset && offset < p.lunchEndOffset) return null; // 점심 배제
      if (bar.c > upper && bar.c > vwap) {
        ctx.log(
          `[S2] ${ctx.session.date} 밴드 상단 이탈 +${offset}m ` +
            `(c=${bar.c.toFixed(4)} > upper=${upper.toFixed(4)}, σ=${(sigma * 100).toFixed(4)}%)`
        );
        const sizePct =
          p.stopPct > 0 ? Math.min(p.riskPerTrade / p.stopPct, p.maxPositionPct) : p.maxPositionPct;
        const signal: Signal = {
          kind: "BUY",
          symbol: p.symbol,
          orderType: "MARKET",
          sizePct,
          reason: `밴드 상단 이탈 +${offset}m (upper=${upper.toFixed(4)})`,
        };
        if (p.stopPct > 0) signal.stopLoss = bar.c * (1 - p.stopPct);
        return signal;
      }
      return null;
    },
  };
}

export const concretumPlugin: StrategyPlugin<ConcretumParams> = {
  name: "concretum-noise",
  version: "1.0.0",
  paramsSchema: concretumParamsSchema,
  create: (params) => createConcretumStrategy(params),
};
