/**
 * S3 — Mind the Gap (ATR 정규화 갭다운 인트라데이 반전)
 *
 * 원 출처: QuantConnect Research Forum — *Mind the Gap: An Intraday Reversal Strategy
 *          Using Gap Downs and ATR*
 * 집행 명세: docs/auto-trading/02-strategy-spec.md §B.3
 *
 * 규칙 요약
 *   1) 개장(첫 봉)에서 크로스섹션 스캔을 **단 1회** 수행
 *   2) 시장 전체 급락일(SPY 자체 갭다운 > MKT_GAP_MULT × ATR14) 이면 당일 전면 미진입
 *   3) 자격통과 종목 중 (시가 − 전일종가) / ATR14 < −GAP_MULT 인 종목을 후보로 수집
 *   4) gapAtr 오름차순(갭다운이 큰 순) 상위 MAX_POS 종목을 동시 매수
 *   5) 진입 후 HOLD_MIN 분 경과 시 시간청산
 *
 * ── 크로스섹션 랭킹이 lookahead 가 아닌 이유 ────────────────────────────────
 * 엔진은 봉 처리 순서가 `(1) 그룹 전체 봉 공개 → … → (6) 전략 호출` 이다.
 * 따라서 개장 봉의 `onBar` 안에서 `ctx.history(otherSymbol)` 의 **마지막 원소**는
 * 동일 timestamp 의 개장 봉이며, 미래 봉은 어디에도 없다 (engine.ts 220~276행).
 *
 * ── 일봉 파생값 주입 ────────────────────────────────────────────────────────
 * `onBar` 는 동기 함수이므로 전일종가·ATR14·SMA100·자격여부는 전부 파라미터로 받는다.
 * 값은 **세션일 D 기준 D−1 까지의 일봉만으로** 계산해서 넣어야 한다 (호출자 책임).
 */

import { z } from "zod";
import type { Strategy, StrategyPlugin } from "../strategy";
import type { Bar, SessionInfo, Signal, StrategyContext } from "../types";

/** `{ 심볼: { "YYYY-MM-DD": 값 } }` 형태의 일봉 파생값 맵. */
const symbolDateNumberMap = z.record(z.string(), z.record(z.string(), z.number()));
const symbolDateBoolMap = z.record(z.string(), z.record(z.string(), z.boolean()));

export const mindTheGapParamsSchema = z
  .object({
    /** 스캔 대상 유니버스. 비우면 `prevClose` 의 키를 유니버스로 쓴다. */
    universe: z.array(z.string()).default([]),
    /** 시장 전체 급락 판정에 쓰는 벤치마크 심볼. 이 심볼 자체는 매매하지 않는다. */
    marketSymbol: z.string().default("SPY"),
    /** 갭다운 임계 (ATR14 배수). 원 규칙 1.2. D.5.1 탐색 범위 {0.8, 1.0, 1.2, 1.5}. */
    gapMult: z.number().positive().default(1.2),
    /** 보유 시간(분). 원 규칙 15. D.5.1 탐색 범위 {15, 30}. */
    holdMinutes: z.number().positive().default(15),
    /** 시장 전체 급락 회피 임계. **[자체판단 · 검증대상]** */
    mktGapMult: z.number().positive().default(1.2),
    /** 동시보유 상한. **[자체판단 · 검증대상]** D.5.1 탐색 범위 {1, 3, 5}. */
    maxPositions: z.number().int().positive().default(3),
    /** 종목당 비중. **[자체판단 · 검증대상]** */
    perPositionPct: z.number().positive().max(1).default(0.1),
    /** 하드 손절률. **[자체판단 · 검증대상]** — 원 규칙에 손절 없음. */
    stopPct: z.number().min(0).default(0.015),
    /** 최저 가격 필터 (당일 시가 기준 재확인). **[자체판단 · 검증대상]** */
    minPrice: z.number().nonnegative().default(10),
    /** 전일 일봉 종가. */
    prevClose: symbolDateNumberMap.default({}),
    /** 전일까지의 ATR14 (일봉). */
    atr14: symbolDateNumberMap.default({}),
    /** 전일까지의 SMA100 (일봉 종가). */
    sma100: symbolDateNumberMap.default({}),
    /** Stage-1 자격 통과 여부. 없으면 SMA100 추세 필터만으로 판정한다. */
    eligible: symbolDateBoolMap.default({}),
  })
  .strict();

export type MindTheGapParams = z.infer<typeof mindTheGapParamsSchema>;

interface Candidate {
  sym: string;
  gapAtr: number;
  open: number;
}

export function createMindTheGapStrategy(params: MindTheGapParams): Strategy<MindTheGapParams> {
  const p = params;
  const universe = p.universe.length > 0 ? p.universe : Object.keys(p.prevClose);

  let rankedAtT: number | null = null;

  const lookup = (
    table: Record<string, Record<string, number>>,
    sym: string,
    date: string
  ): number | null => {
    const v = table[sym]?.[date];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  };

  /** `ctx.history(sym)` 의 마지막 원소가 정확히 시각 t 의 봉일 때만 돌려준다. */
  const lastBarAt = (sym: string, t: number, ctx: StrategyContext): Bar | null => {
    const hist = ctx.history(sym);
    if (hist.length === 0) return null;
    const last = hist[hist.length - 1];
    return last.t === t ? last : null;
  };

  return {
    name: "mind-the-gap",
    version: "1.0.0",
    warmupBars: 0,
    paramsSchema: mindTheGapParamsSchema,

    onSessionStart(session: SessionInfo): void {
      rankedAtT = null;
      void session;
    },

    onBar(bar: Bar, ctx: StrategyContext): Signal | Signal[] | null {
      const offset = Math.round((bar.t - ctx.session.openMs) / 60_000);
      const d = ctx.session.date;

      // ── (1) 개장 봉에서 크로스섹션 랭킹을 단 1회 수행
      if (offset === 0 && rankedAtT !== bar.t) {
        rankedAtT = bar.t;

        // (1-a) 시장 전체 급락일 회피
        const mkt = lastBarAt(p.marketSymbol, bar.t, ctx);
        const mktPrev = lookup(p.prevClose, p.marketSymbol, d);
        const mktAtr = lookup(p.atr14, p.marketSymbol, d);
        if (mkt && mktPrev !== null && mktAtr !== null && mktAtr > 0) {
          if (mkt.o - mktPrev < -p.mktGapMult * mktAtr) {
            ctx.log(`[S3] ${d} 시장 전체 급락일 → 당일 전면 미진입`);
            return null;
          }
        }

        // (1-b) 후보 수집
        const cands: Candidate[] = [];
        for (const sym of universe) {
          if (sym === p.marketSymbol) continue;
          const eligTable = p.eligible[sym];
          if (eligTable && eligTable[d] === false) continue;

          const prev = lookup(p.prevClose, sym, d);
          const atr = lookup(p.atr14, sym, d);
          const sma = lookup(p.sma100, sym, d);
          if (prev === null || atr === null || !(atr > 0)) continue;
          // 추세 필터 — 전일 종가 > SMA100 (원 규칙)
          if (sma !== null && !(prev > sma)) continue;

          const b = lastBarAt(sym, bar.t, ctx);
          if (b === null) continue; // 당일 개장 봉이 없으면 스킵 (데이터 공백)
          if (b.o < p.minPrice) continue;

          const gapAtr = (b.o - prev) / atr;
          if (gapAtr < -p.gapMult) cands.push({ sym, gapAtr, open: b.o });
        }

        // (1-c) 랭킹 및 신호 생성 — 갭다운이 큰 순(gapAtr 오름차순) 상위 MAX_POS
        cands.sort((a, b) => a.gapAtr - b.gapAtr);
        const picks = cands.slice(0, p.maxPositions);
        if (cands.length > 0) {
          ctx.log(`[S3] ${d} 후보 ${cands.length}종목 중 ${picks.length}종목 진입`);
        }
        if (picks.length === 0) return null;
        if (!ctx.canEnter) return null;

        return picks.map((pick) => {
          const signal: Signal = {
            kind: "BUY",
            symbol: pick.sym,
            orderType: "MARKET",
            sizePct: p.perPositionPct,
            reason: `gapdown ${pick.gapAtr.toFixed(2)}×ATR`,
          };
          if (p.stopPct > 0) signal.stopLoss = pick.open * (1 - p.stopPct);
          return signal;
        });
      }

      // ── (2) 보유 HOLD_MIN 분 경과 → 시간청산
      const pos = ctx.position(bar.symbol);
      if (pos && pos.qty > 0 && bar.t - pos.openedAt >= p.holdMinutes * 60_000) {
        return {
          kind: "EXIT",
          symbol: bar.symbol,
          orderType: "MARKET",
          reason: `${p.holdMinutes}분 시간청산`,
        };
      }

      return null;
    },
  };
}

export const mindTheGapPlugin: StrategyPlugin<MindTheGapParams> = {
  name: "mind-the-gap",
  version: "1.0.0",
  paramsSchema: mindTheGapParamsSchema,
  create: (params) => createMindTheGapStrategy(params),
};
