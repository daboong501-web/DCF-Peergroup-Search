/**
 * KODEX 코스닥150 (229200) 단일종목 당일청산 전략 — "개장레인지 돌파 후 VWAP 눌림목 롱".
 *
 * ## 설계 근거
 *
 * 1. **U자형 일중 패턴** — 한국 주식시장의 장중 거래량은 U자형이고, 개장 15분 거래량이
 *    하루 전체의 10.7% 에 달한다. 개장 직후 유동성·변동성이 가장 극적이다.
 *    ⇒ 개장 구간은 **신호를 만드는 데만 쓰고 진입하지 않는다.** 스프레드가 벌어지는 구간에서
 *      시장가로 들어가면 비용 우위(왕복 6.38bps)를 스스로 날린다.
 *
 * 2. **점심 공백** — 11:30~13:30 은 거래량이 얇아 돌파가 잘 실패한다 → 신규진입 금지.
 *
 * 3. **돌파 추격 금지, 눌림목 지정가 진입** — 돌파 순간 시장가로 따라붙지 않고 되돌림을
 *    지정가로 받는다. 이유는 두 가지다:
 *      (a) 가짜 돌파를 한 번 걸러낸다
 *      (b) **지정가는 스프레드를 안 넘어서 슬리피지가 0** 이다 (비용모델 `limitSlippageBps=0`).
 *          왕복비용이 6.38 → 4.69bps 로 떨어진다. 단타에서 이 차이는 결정적이다.
 *
 * 4. **VWAP 을 일중 공정가 기준선으로** — 세력 평단 개념. VWAP 위에서만 롱을 잡는다.
 *
 * 5. **ATR 로 손절·익절을 스케일링** — 블로그에 흔한 "손절 3~7%, 익절 5~15%" 는 **개별주 기준**이라
 *    지수 ETF 에 그대로 쓰면 안 된다. 229200 은 지수를 1배 추종해서 하루 변동폭이 개별주보다
 *    훨씬 작다. 손절폭을 절대%로 박으면 종목 성격과 어긋나므로 **ATR 배수**로 잡는다.
 *
 * 6. **비용 문턱(cost gate)** — 목표 수익이 왕복비용의 배수를 못 넘으면 아예 진입하지 않는다.
 *    비용이 싸다는 것과 아무 때나 들어가도 된다는 것은 다르다.
 *
 * ## 매도 계획은 진입 시점에 전부 확정된다
 *
 * 진입 신호는 `stopLoss`·`takeProfit`·`maxHoldBars` 를 **반드시 함께** 낸다.
 * `requireExitPlan=true` 로 돌리면 하나라도 빠졌을 때 엔진이 진입을 거부한다.
 * 여기에 세션 캘린더의 15:15 강제청산이 최종 안전망으로 겹친다.
 *
 * ## 파라미터 근거 등급
 * - [실증] 검색으로 확인된 시장 사실 (U자형, 개장 15분 10.7%)
 * - [통념] 업계 관행 (손익비 1:2, VWAP 눌림목)
 * - [자체판단·검증대상] 내가 정한 값. **백테스트로 검증하고 불합격이면 폐기한다.**
 */

import { z } from "zod";
import type { Strategy, StrategyPlugin } from "../strategy";
import type { Bar, Signal, StrategyContext } from "../types";
import { wilderAtr } from "../indicators";

export const kosdaq150OrbParams = z
  .object({
    /** 개장 레인지를 만드는 분 수. [실증] 개장 15분에 거래량이 집중된다. */
    openingRangeMinutes: z.number().int().positive().default(15),
    /** ATR 기간 (봉 단위). [통념] Wilder 기본 14. */
    atrPeriod: z.number().int().positive().default(14),
    /** 손절폭 = 진입가 − stopAtrMult × ATR. [자체판단·검증대상] */
    stopAtrMult: z.number().positive().default(1.0),
    /** 익절폭 = 진입가 + targetAtrMult × ATR. [통념] 손익비 1:2 */
    targetAtrMult: z.number().positive().default(2.0),
    /** 최대 보유 봉 수. 안 움직이면 자리만 차지하므로 정리한다. [자체판단·검증대상] */
    maxHoldBars: z.number().int().positive().default(60),
    /** 눌림목 지정가 = 돌파가 − pullbackAtrMult × ATR. [자체판단·검증대상] */
    pullbackAtrMult: z.number().positive().default(0.3),
    /** 지정가 유효 봉 수. 이 안에 안 채워지면 취소한다. [자체판단·검증대상] */
    limitValidBars: z.number().int().positive().default(5),
    /** 점심 공백 시작/종료 (장 시작 후 경과 분). 11:30~13:30 = 150~270분. [실증적 통념] */
    lunchStartMin: z.number().int().nonnegative().default(150),
    lunchEndMin: z.number().int().nonnegative().default(270),
    /** 신규진입 마감 (장 시작 후 경과 분). 14:50 = 350분. 최대보유를 감안한 값. */
    lastEntryMin: z.number().int().positive().default(350),
    /** 왕복 거래비용 (bps). krCosts.roundTripCostBps() 값을 주입한다. */
    roundTripCostBps: z.number().nonnegative().default(6.38),
    /** 목표수익이 왕복비용의 몇 배를 넘어야 진입할지. [자체판단·검증대상] */
    minEdgeMultiple: z.number().positive().default(3),
    /** 자본 대비 투입 비중. */
    sizePct: z.number().positive().max(1).default(0.3),
    /** 하루 최대 진입 횟수. 과매매 방지. [자체판단·검증대상] */
    maxEntriesPerDay: z.number().int().positive().default(2),
  })
  .strict();

export type Kosdaq150OrbParams = z.infer<typeof kosdaq150OrbParams>;

interface DayState {
  date: string;
  /** 개장 레인지 고가/저가. */
  orHigh: number | null;
  orLow: number | null;
  /** 개장 레인지가 확정되었는지. */
  orFixed: boolean;
  /** 돌파가 발생했는지 (돌파 후에만 눌림목을 노린다). */
  brokeOut: boolean;
  /** 돌파 시점 가격. */
  breakoutPrice: number | null;
  entries: number;
  /** 당일 VWAP 누적. */
  cumPv: number;
  cumVol: number;
}

function freshDay(date: string): DayState {
  return {
    date,
    orHigh: null,
    orLow: null,
    orFixed: false,
    brokeOut: false,
    breakoutPrice: null,
    entries: 0,
    cumPv: 0,
    cumVol: 0,
  };
}

/** 전형가(typical price) 기반 당일 VWAP. */
function vwapOf(state: DayState): number | null {
  return state.cumVol > 0 ? state.cumPv / state.cumVol : null;
}

export function createKosdaq150OrbStrategy(): Strategy<Kosdaq150OrbParams> {
  let p: Kosdaq150OrbParams = kosdaq150OrbParams.parse({});
  let day: DayState | null = null;

  return {
    name: "kosdaq150-orb-vwap",
    version: "1.0.0",
    warmupBars: 20,
    paramsSchema: kosdaq150OrbParams,

    init(ctx) {
      p = kosdaq150OrbParams.parse(ctx.params ?? {});
      ctx.log(
        `[kosdaq150-orb] OR=${p.openingRangeMinutes}분 손절=${p.stopAtrMult}×ATR ` +
          `익절=${p.targetAtrMult}×ATR 최대보유=${p.maxHoldBars}봉 ` +
          `비용문턱=${(p.roundTripCostBps * p.minEdgeMultiple).toFixed(2)}bps`
      );
    },

    onSessionStart(session) {
      day = freshDay(session.date);
    },

    onBar(bar: Bar, ctx: StrategyContext): Signal[] | null {
      if (!day || day.date !== ctx.session.date) day = freshDay(ctx.session.date);

      // VWAP 누적은 매 봉 갱신한다 (진입 여부와 무관).
      const typical = (bar.h + bar.l + bar.c) / 3;
      day.cumPv += typical * bar.v;
      day.cumVol += bar.v;

      const elapsedMin = Math.floor((bar.t - ctx.session.openMs) / 60_000);

      // ── 1. 개장 레인지 형성 구간: 신호만 만들고 진입하지 않는다 ──
      if (elapsedMin < p.openingRangeMinutes) {
        day.orHigh = day.orHigh === null ? bar.h : Math.max(day.orHigh, bar.h);
        day.orLow = day.orLow === null ? bar.l : Math.min(day.orLow, bar.l);
        return null;
      }
      if (!day.orFixed) day.orFixed = true;
      if (day.orHigh === null) return null;

      // ── 2. 이미 포지션이 있으면 아무것도 하지 않는다 ──
      // 청산은 진입 때 건 손절·익절·최대보유와 엔진의 15:15 강제청산이 담당한다.
      if (ctx.position()) return null;

      if (!ctx.canEnter) return null;
      if (day.entries >= p.maxEntriesPerDay) return null;

      // ── 3. 시간대 필터 ──
      if (elapsedMin >= p.lunchStartMin && elapsedMin < p.lunchEndMin) return null; // 점심 공백
      if (elapsedMin >= p.lastEntryMin) return null; // 신규진입 마감

      // ── 4. 돌파 확인 ──
      if (!day.brokeOut) {
        if (bar.c > day.orHigh) {
          day.brokeOut = true;
          day.breakoutPrice = bar.c;
        }
        return null; // 돌파한 봉에서는 추격하지 않는다
      }

      // ── 5. VWAP 위에서만 롱 ──
      const vwap = vwapOf(day);
      if (vwap === null || bar.c < vwap) return null;

      // ── 6. ATR 산출 ──
      const hist = ctx.history();
      const atrSeries = wilderAtr(hist, p.atrPeriod);
      const atr = atrSeries[atrSeries.length - 1];
      if (atr === null || !(atr > 0)) return null;

      // ── 7. 눌림목 지정가와 매도 계획을 함께 계산한다 ──
      const limitPrice = bar.c - p.pullbackAtrMult * atr;
      if (!(limitPrice > 0)) return null;

      const stopLoss = limitPrice - p.stopAtrMult * atr;
      const takeProfit = limitPrice + p.targetAtrMult * atr;
      if (!(stopLoss > 0)) return null;

      // ── 8. 비용 문턱 — 목표수익이 왕복비용의 배수를 못 넘으면 진입하지 않는다 ──
      const edgeBps = ((takeProfit - limitPrice) / limitPrice) * 10_000;
      const requiredBps = p.roundTripCostBps * p.minEdgeMultiple;
      if (edgeBps < requiredBps) return null;

      day.entries += 1;
      return [
        {
          kind: "BUY",
          symbol: bar.symbol,
          orderType: "LIMIT",
          limitPrice,
          sizePct: p.sizePct,
          stopLoss,
          takeProfit,
          maxHoldBars: p.maxHoldBars,
          validForBars: p.limitValidBars,
          reason:
            `OR돌파(${day.orHigh.toFixed(0)}) 후 VWAP(${vwap.toFixed(0)}) 위 눌림목 ` +
            `ATR=${atr.toFixed(1)} 목표=${edgeBps.toFixed(1)}bps(문턱 ${requiredBps.toFixed(1)})`,
        },
      ];
    },
  };
}

/**
 * 229200 개장레인지 돌파 후 VWAP 눌림목 지정가 롱.
 * 당일청산이며 매도 계획(손절·익절·최대보유)을 진입 시점에 확정한다.
 */
export const kosdaq150OrbPlugin: StrategyPlugin = {
  name: "kosdaq150-orb-vwap",
  version: "1.0.0",
  create: () => createKosdaq150OrbStrategy() as unknown as Strategy<Record<string, unknown>>,
};
