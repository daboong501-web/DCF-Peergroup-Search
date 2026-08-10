/**
 * ⚠️ 엔진 단위테스트 — 실행:  npx tsx scripts/test-engine.ts
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ 여기서 쓰는 봉 데이터는 전부 **손으로 만든 인공 데이터**다.                  │
 * │ 실제 시장 데이터가 아니며, 이 스크립트의 출력은 **백테스트 결과가 아니다.**  │
 * │ 목적은 오직 하나 — 체결가·손절/익절·당일청산·비용·지표 계산이               │
 * │ 손으로 계산한 기대값과 **정확히** 일치하는지 확인하는 것.                    │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { runBacktest, type BacktestResult, type EngineConfig } from "../src/trading/engine";
import { computeMetrics, formatReport } from "../src/trading/metrics";
import { etWallClockToUtcMs } from "../src/trading/session";
import { createScriptedStrategy } from "../src/trading/strategies/scripted";
import { ZERO_COST_PARAMS, computeFillCost, type CostParams } from "../src/trading/costs";
import type { Bar, Signal, Trade } from "../src/trading/types";

// ─── 아주 작은 assert 하네스 ───

let passed = 0;
const failures: string[] = [];

function check(label: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`${label} — ${msg}`);
    console.log(`  ✗ ${label}\n      ${msg}`);
  }
}

function eq(actual: unknown, expected: unknown, what: string): void {
  if (actual !== expected) {
    throw new Error(`${what}: 기대 ${String(expected)}, 실제 ${String(actual)}`);
  }
}

function close(actual: number, expected: number, what: string, tol = 1e-9): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${what}: 기대 ${expected}, 실제 ${actual} (허용오차 ${tol})`);
  }
}

// ─── 인공 봉 생성기 ───

/** 2026-01-05(월) 미국 동부시각 기준으로 (hh:mm) 봉을 만든다. */
function bar(
  hh: number,
  mm: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v = 10_000,
  symbol = "TEST",
  day = 5
): Bar {
  return { t: etWallClockToUtcMs(2026, 1, day, hh, mm), o, h, l, c, v, symbol };
}

/** 단일 심볼 봉 묶음. */
function bars(list: Bar[]): Map<string, Bar[]> {
  return new Map([[list[0].symbol, list]]);
}

/** 수수료 0.1%·왕복스프레드 10bp(=편도 5bp)만 있는 단순 비용 모델. 손계산 가능하도록 나머지는 0. */
const SIMPLE_COST: CostParams = {
  ...ZERO_COST_PARAMS,
  commissionRate: 0.001,
  spreadBps: 10,
};

function baseConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    initialCapital: 10_000,
    interval: "1m",
    cost: ZERO_COST_PARAMS,
    risk: {
      maxPositionPct: 1,
      maxConcurrentPositions: 3,
      dailyLossLimitPct: 0, // 기본은 손실한도 끔 (개별 테스트에서 켠다)
      exitBeforeCloseMinutes: 1,
      allowShort: false,
      allowFractionalShares: false,
    },
    ...overrides,
  };
}

function onlyTrade(result: BacktestResult): Trade {
  if (result.trades.length !== 1) {
    throw new Error(`거래 수: 기대 1, 실제 ${result.trades.length}`);
  }
  return result.trades[0];
}

// ══════════════════════════════════════════════════════════════════════════════
console.log("\n⚠️  아래는 인공(합성) 봉으로 돌린 **엔진 단위테스트**입니다. 백테스트 결과가 아닙니다.\n");

// ─────────────────────────────────────────────────────────────────────────────
// (A) 체결가: 신호는 다음 봉 시가에 체결되고, 슬리피지·수수료가 정확히 붙는가
// ─────────────────────────────────────────────────────────────────────────────
console.log("[A] 체결가 · 수수료 · 슬리피지");

const aBars = [
  bar(9, 30, 100, 100, 100, 100), // idx0: BUY 신호
  bar(9, 31, 100, 100, 100, 100), // idx1: 시가 100 에 체결
  bar(9, 32, 100, 100, 100, 100), // idx2: EXIT 신호
  bar(9, 33, 110, 110, 110, 110), // idx3: 시가 110 에 청산
  bar(9, 34, 110, 110, 110, 110),
];

const aStrategy = createScriptedStrategy((b, ctx, index) => {
  // 미래 참조 차단 검증: history 는 항상 현재 봉까지만이어야 한다.
  if (ctx.history().length !== index + 1) {
    throw new Error(`LOOKAHEAD: history 길이 ${ctx.history().length}, 기대 ${index + 1}`);
  }
  if (ctx.history()[ctx.history().length - 1].t !== b.t) {
    throw new Error("LOOKAHEAD: history 의 마지막 봉이 현재 봉이 아님");
  }
  if (index === 0) return [{ kind: "BUY", symbol: b.symbol, qty: 10 } as Signal];
  if (index === 2) return [{ kind: "EXIT", symbol: b.symbol } as Signal];
  return null;
});

const aResult = runBacktest(aStrategy, bars(aBars), baseConfig({ cost: SIMPLE_COST }));

check("신호는 같은 봉이 아니라 '다음 봉'에서 체결된다 (lookahead 차단)", () => {
  eq(aResult.fills.length, 2, "체결 건수");
  eq(aResult.fills[0].t, aBars[1].t, "매수 체결 시각");
  eq(aResult.fills[1].t, aBars[3].t, "매도 체결 시각");
});

check("매수 체결가 = 100 × (1 + 5bp) = 100.05", () => {
  close(aResult.fills[0].price, 100.05, "매수 체결가");
  close(aResult.fills[0].refPrice, 100, "매수 기준가");
  close(aResult.fills[0].slippageCost, 0.5, "매수 슬리피지 총액"); // 0.05 × 10주
  close(aResult.fills[0].commission, 1.0005, "매수 수수료"); // 100.05 × 10 × 0.1%
});

check("매도 체결가 = 110 × (1 − 5bp) = 109.945", () => {
  close(aResult.fills[1].price, 109.945, "매도 체결가");
  close(aResult.fills[1].slippageCost, 0.55, "매도 슬리피지 총액"); // 0.055 × 10주
  close(aResult.fills[1].commission, 1.09945, "매도 수수료");
});

check("거래 손익: gross 100, 비용 3.14995, net 96.85005", () => {
  const t = onlyTrade(aResult);
  close(t.grossPnl, 100, "gross 손익"); // (110 − 100) × 10
  close(t.commission, 2.09995, "총 수수료");
  close(t.slippageCost, 1.05, "총 슬리피지");
  close(t.netPnl, 96.85005, "net 손익");
  close(t.returnPct, 96.85005 / 1000, "수익률");
});

check("최종 자산 = 10096.85005 (현금 정산과 일치)", () => {
  close(aResult.finalEquity, 10_096.85005, "최종 자산", 1e-8);
});

// ─────────────────────────────────────────────────────────────────────────────
// (B) 손절 / 익절 · 경로 모호성 (같은 봉에서 둘 다 닿으면 손절 우선)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[B] 손절 · 익절 · 경로 모호성");

const bBars = [
  bar(9, 30, 100, 100, 100, 100), // idx0: BUY (stop 98 / target 104)
  bar(9, 31, 100, 100, 100, 100), // idx1: 시가 100 체결
  bar(9, 32, 100, 105, 97, 103), // idx2: 손절(97≤98)·익절(105≥104) 동시 터치
  bar(9, 33, 103, 103, 103, 103),
];

const bStrategy = createScriptedStrategy((b, _ctx, index) =>
  index === 0
    ? [{ kind: "BUY", symbol: b.symbol, qty: 10, stopLoss: 98, takeProfit: 104 } as Signal]
    : null
);

const bResult = runBacktest(bStrategy, bars(bBars), baseConfig());

check("한 봉에서 손절·익절이 모두 닿으면 **손절**로 처리한다 (보수적)", () => {
  const t = onlyTrade(bResult);
  eq(t.exitReason, "STOP_LOSS", "청산 사유");
  close(t.exitPrice, 98, "청산 기준가");
  close(t.grossPnl, -20, "gross 손익"); // (98 − 100) × 10
  close(t.netPnl, -20, "net 손익"); // 비용 0 모델
});

// 익절만 닿는 경우
const bBars2 = [
  bar(9, 30, 100, 100, 100, 100),
  bar(9, 31, 100, 100, 100, 100),
  bar(9, 32, 100, 105, 99, 104), // 익절(105≥104)만 터치, 손절(99>98) 미터치
  bar(9, 33, 104, 104, 104, 104),
];
const bResult2 = runBacktest(bStrategy, bars(bBars2), baseConfig());

check("손절 미터치 · 익절만 터치하면 익절 체결", () => {
  const t = onlyTrade(bResult2);
  eq(t.exitReason, "TAKE_PROFIT", "청산 사유");
  close(t.exitPrice, 104, "청산 기준가");
  close(t.grossPnl, 40, "gross 손익");
});

// 갭 하락으로 시가가 이미 손절가를 지나친 경우 → 시가 체결 (더 불리한 쪽)
const bBars3 = [
  bar(9, 30, 100, 100, 100, 100),
  bar(9, 31, 100, 100, 100, 100),
  bar(9, 32, 95, 96, 94, 95), // 시가 95 < 손절가 98
  bar(9, 33, 95, 95, 95, 95),
];
const bResult3 = runBacktest(bStrategy, bars(bBars3), baseConfig());

check("갭으로 손절가를 건너뛰면 지정가가 아니라 시가로 체결한다", () => {
  const t = onlyTrade(bResult3);
  eq(t.exitReason, "STOP_LOSS", "청산 사유");
  close(t.exitPrice, 95, "청산 기준가 (98 이 아니라 시가 95)");
  close(t.grossPnl, -50, "gross 손익");
});

// ─────────────────────────────────────────────────────────────────────────────
// (C) 지정가 체결
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[C] 지정가 주문");

const cBars = [
  bar(9, 30, 100, 100, 100, 100), // idx0: LIMIT BUY @99
  bar(9, 31, 100, 100, 98.5, 99), // idx1: 저가 98.5 ≤ 99 → 99 에 체결
  bar(9, 32, 99, 99, 99, 99), // idx2: LIMIT EXIT @101
  bar(9, 33, 99, 101.5, 99, 101), // idx3: 고가 101.5 ≥ 101 → 101 에 체결
];

const cStrategy = createScriptedStrategy((b, _ctx, index) => {
  if (index === 0)
    return [{ kind: "BUY", symbol: b.symbol, qty: 10, orderType: "LIMIT", limitPrice: 99 } as Signal];
  if (index === 2)
    return [{ kind: "EXIT", symbol: b.symbol, orderType: "LIMIT", limitPrice: 101 } as Signal];
  return null;
});

const cResult = runBacktest(cStrategy, bars(cBars), baseConfig());

check("지정가는 봉 범위가 지정가에 닿아야 체결되고, 지정가에 체결된다", () => {
  eq(cResult.fills.length, 2, "체결 건수");
  close(cResult.fills[0].price, 99, "매수 체결가");
  close(cResult.fills[1].price, 101, "매도 체결가");
  close(onlyTrade(cResult).grossPnl, 20, "gross 손익");
});

// 미체결 → 만료
const cBars2 = [
  bar(9, 30, 100, 100, 100, 100),
  bar(9, 31, 100, 100, 99.5, 100), // 저가 99.5 > 90 → 미체결
  bar(9, 32, 100, 100, 100, 100),
  bar(9, 33, 100, 100, 100, 100),
];
const cStrategy2 = createScriptedStrategy((b, _ctx, index) =>
  index === 0
    ? [{ kind: "BUY", symbol: b.symbol, qty: 10, orderType: "LIMIT", limitPrice: 90 } as Signal]
    : null
);
const cResult2 = runBacktest(cStrategy2, bars(cBars2), baseConfig());

check("지정가에 닿지 않으면 체결되지 않고 유효기간 뒤 만료된다", () => {
  eq(cResult2.fills.length, 0, "체결 건수");
  eq(cResult2.trades.length, 0, "거래 수");
  close(cResult2.finalEquity, 10_000, "최종 자산");
});

// ─────────────────────────────────────────────────────────────────────────────
// (D) 당일청산 강제
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[D] 당일청산 강제");

const dBars = [
  bar(9, 30, 100, 100, 100, 100), // idx0: BUY
  bar(9, 31, 100, 100, 100, 100), // idx1: 시가 100 체결
  bar(15, 58, 102, 102, 102, 102), // 아직 강제청산 시각 전 (16:00 − 1분 = 15:59)
  bar(15, 59, 103, 103, 103, 103), // 강제청산 시각 → 종가 103 에 LOC 모사 청산
];

const dStrategy = createScriptedStrategy((b, _ctx, index) =>
  index === 0 ? [{ kind: "BUY", symbol: b.symbol, qty: 10 } as Signal] : null
);

const dResult = runBacktest(dStrategy, bars(dBars), baseConfig());

check("정규장 종료 1분 전에 미청산 포지션을 종가로 전량 청산한다 (LOC 모사)", () => {
  const t = onlyTrade(dResult);
  eq(t.exitReason, "EOD_LIQUIDATION", "청산 사유");
  close(t.exitPrice, 103, "청산가 = 15:59 봉 종가");
  close(t.grossPnl, 30, "gross 손익");
  eq(dResult.warnings.filter((w) => w.includes("폴백청산")).length, 0, "폴백 경고 없음");
});

check("당일청산 후 오버나이트 거래가 0 건이다", () => {
  eq(computeMetrics(dResult).overnightTrades, 0, "오버나이트 거래 수");
});

// 폴백: 강제청산 시각 이후 봉이 아예 없는 경우 (거래정지·데이터 공백)
const dBars2 = [
  bar(9, 30, 100, 100, 100, 100),
  bar(9, 31, 100, 100, 100, 100),
  bar(9, 32, 101, 101, 101, 101), // 이후 봉 없음 → 세션 종료 시 폴백 청산
];
const dResult2 = runBacktest(dStrategy, bars(dBars2), baseConfig());

check("강제청산 시각 이후 봉이 없으면 마지막 종가로 폴백 청산하고 경고를 남긴다", () => {
  const t = onlyTrade(dResult2);
  eq(t.exitReason, "EOD_LIQUIDATION", "청산 사유");
  close(t.exitPrice, 101, "청산가 = 마지막 봉 종가");
  if (dResult2.warnings.filter((w) => w.includes("폴백청산")).length !== 1) {
    throw new Error(`폴백 경고 1건이어야 하는데 ${dResult2.warnings.length}건`);
  }
});

// 이틀치: 첫날 포지션이 다음날로 넘어가지 않는지
const eBars = [
  bar(9, 30, 100, 100, 100, 100, 10_000, "TEST", 5),
  bar(9, 31, 100, 100, 100, 100, 10_000, "TEST", 5),
  bar(15, 59, 105, 105, 105, 105, 10_000, "TEST", 5),
  bar(9, 30, 105, 105, 105, 105, 10_000, "TEST", 6), // 다음 영업일
  bar(9, 31, 105, 105, 105, 105, 10_000, "TEST", 6),
  bar(15, 59, 110, 110, 110, 110, 10_000, "TEST", 6),
];
const eResult = runBacktest(dStrategy, bars(eBars), baseConfig());

check("세션이 바뀌어도 포지션이 넘어가지 않는다 (이틀 → 거래 2건, 각 당일청산)", () => {
  eq(eResult.trades.length, 2, "거래 수");
  eq(eResult.daily.length, 2, "거래일 수");
  close(eResult.trades[0].grossPnl, 50, "1일차 gross"); // (105 − 100) × 10
  close(eResult.trades[1].grossPnl, 50, "2일차 gross"); // (110 − 105) × 10
  eq(computeMetrics(eResult).overnightTrades, 0, "오버나이트 거래 수");
});

// ─────────────────────────────────────────────────────────────────────────────
// (E) 일일 손실 한도
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[E] 일일 손실 한도 · 신규진입 차단");

const fBars = [
  bar(9, 30, 100, 100, 100, 100), // idx0: BUY 100주 (= 10,000)
  bar(9, 31, 100, 100, 100, 100), // idx1: 체결
  bar(9, 32, 97, 97, 97, 97), // idx2: 평가손 −300 → 한도(−200) 초과 → 전량 청산 + 차단
  bar(9, 33, 97, 97, 97, 97), // idx3: BUY 신호를 내지만 차단되어야 함
  bar(9, 34, 97, 97, 97, 97),
];

const fStrategy = createScriptedStrategy((b, _ctx, index) =>
  index === 0 || index === 3 ? [{ kind: "BUY", symbol: b.symbol, qty: 100 } as Signal] : null
);

const fResult = runBacktest(
  fStrategy,
  bars(fBars),
  baseConfig({ risk: { ...baseConfig().risk, dailyLossLimitPct: 0.02 } })
);

check("일일 손실 한도(2% = −200) 초과 시 전량 청산하고 당일 신규진입을 막는다", () => {
  const t = onlyTrade(fResult);
  eq(t.exitReason, "DAILY_LOSS_LIMIT", "청산 사유");
  close(t.grossPnl, -300, "gross 손익"); // (97 − 100) × 100
  close(fResult.finalEquity, 9_700, "최종 자산");
  eq(fResult.fills.length, 2, "체결 건수 (차단 이후 추가 체결 없음)");
  eq(fResult.daily[0].haltedByLossLimit, true, "당일 중단 플래그");
});

// ─────────────────────────────────────────────────────────────────────────────
// (F) 비용 모델 단위 검증
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[F] 비용 모델");

check("시장가 슬리피지 = half-spread + 시장충격, 매수/매도 모두 불리한 방향", () => {
  const p: CostParams = { ...ZERO_COST_PARAMS, spreadBps: 10, marketImpactBps: 5 }; // 편도 5+5 = 10bp
  const buy = computeFillCost(p, { side: "BUY", refPrice: 200, qty: 3, orderType: "MARKET" });
  const sell = computeFillCost(p, { side: "SELL", refPrice: 200, qty: 3, orderType: "MARKET" });
  close(buy.fillPrice, 200.2, "매수 체결가"); // 200 × 1.0010
  close(sell.fillPrice, 199.8, "매도 체결가"); // 200 × 0.9990
  close(buy.slippageCost, 0.6, "매수 슬리피지");
  close(sell.slippageCost, 0.6, "매도 슬리피지");
});

check("지정가는 기본적으로 슬리피지 0", () => {
  const p: CostParams = { ...ZERO_COST_PARAMS, spreadBps: 50, marketImpactBps: 20 };
  const f = computeFillCost(p, { side: "BUY", refPrice: 50, qty: 4, orderType: "LIMIT" });
  close(f.fillPrice, 50, "지정가 체결가");
  close(f.slippageCost, 0, "지정가 슬리피지");
});

check("SEC fee·FINRA TAF 는 매도에만, 환전 스프레드는 양방향에 붙는다", () => {
  const p: CostParams = {
    ...ZERO_COST_PARAMS,
    commissionRate: 0.001,
    secFeeRate: 0.0000278,
    tafPerShare: 0.000166,
    tafCapPerOrder: 8.3,
    fxSpreadBps: 10,
    applyFx: true,
  };
  const buy = computeFillCost(p, { side: "BUY", refPrice: 100, qty: 100, orderType: "MARKET" });
  const sell = computeFillCost(p, { side: "SELL", refPrice: 100, qty: 100, orderType: "MARKET" });
  close(buy.commission, 10, "매수 수수료"); // 10,000 × 0.1%
  close(buy.fxCost, 10, "매수 환전비용"); // 10,000 × 10bp
  close(sell.commission, 10 + 10_000 * 0.0000278 + 100 * 0.000166, "매도 수수료+규제비용");
  close(sell.fxCost, 10, "매도 환전비용");
});

check("TAF 는 주문당 상한($8.30)이 적용된다", () => {
  const p: CostParams = { ...ZERO_COST_PARAMS, tafPerShare: 0.000166, tafCapPerOrder: 8.3 };
  const f = computeFillCost(p, { side: "SELL", refPrice: 10, qty: 1_000_000, orderType: "MARKET" });
  close(f.commission, 8.3, "TAF 상한");
});

// ─────────────────────────────────────────────────────────────────────────────
// (G) 성과지표 계산
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[G] 성과지표 (손계산 가능한 고정 입력)");

/** 지표 함수만 격리 검증하기 위한 인공 결과 객체. 시장 데이터가 아니다. */
function fakeTrade(gross: number, commission: number, slippage: number): Trade {
  return {
    symbol: "TEST",
    direction: "LONG",
    qty: 1,
    entryTime: 0,
    entryPrice: 100,
    exitTime: 0,
    exitPrice: 100,
    grossPnl: gross,
    commission,
    slippageCost: slippage,
    fxCost: 0,
    netPnl: gross - commission - slippage,
    returnPct: 0,
    exitReason: "EXIT_SIGNAL",
    barsHeld: 1,
    sessionDate: "2026-01-05",
  };
}

const gResult: BacktestResult = {
  initialCapital: 1_000,
  finalEquity: 1_020,
  trades: [fakeTrade(40, 2, 1), fakeTrade(-15, 2, 1), fakeTrade(4, 2, 1)], // net: +37, −18, +1
  fills: [],
  equityCurve: [
    { t: 1, equity: 1_000, cash: 0 },
    { t: 2, equity: 1_050, cash: 0 },
    { t: 3, equity: 990, cash: 0 },
    { t: 4, equity: 1_020, cash: 0 },
  ],
  daily: [
    { date: "2026-01-05", startEquity: 1_000, endEquity: 1_020, netPnl: 20, grossPnl: 29, cost: 9, tradeCount: 2, haltedByLossLimit: false },
    { date: "2026-01-06", startEquity: 1_020, endEquity: 1_020, netPnl: 0, grossPnl: 0, cost: 0, tradeCount: 1, haltedByLossLimit: false },
  ],
  logs: [],
  warnings: [],
  barsProcessed: 4,
  strategyName: "metrics-fixture",
  strategyVersion: "0.0.0-test",
  costParams: ZERO_COST_PARAMS,
  riskConfig: baseConfig().risk as never,
};

const gMetrics = computeMetrics(gResult);

check("총수익률 / gross 수익률 / 비용 드래그", () => {
  close(gMetrics.netProfit, 20, "net 손익");
  close(gMetrics.totalReturnPct, 2, "총수익률 %");
  close(gMetrics.grossProfit, 29, "gross 손익"); // 40 − 15 + 4
  close(gMetrics.grossReturnPct, 2.9, "gross 수익률 %");
  close(gMetrics.costDragPct, 0.9, "비용 드래그 %p"); // (29 − 20) / 1000
});

check("비용 분해 합계", () => {
  close(gMetrics.totalCommission, 6, "총 수수료");
  close(gMetrics.totalSlippage, 3, "총 슬리피지");
  close(gMetrics.totalCost, 9, "총 비용");
});

check("승률 · 손익비 · Profit Factor", () => {
  eq(gMetrics.tradeCount, 3, "거래 수");
  eq(gMetrics.winCount, 2, "승 거래 수");
  eq(gMetrics.lossCount, 1, "패 거래 수");
  close(gMetrics.winRatePct, (2 / 3) * 100, "승률 %", 1e-9);
  close(gMetrics.avgWin, 19, "평균이익"); // (37 + 1) / 2
  close(gMetrics.avgLoss, 18, "평균손실");
  close(gMetrics.payoffRatio, 19 / 18, "손익비");
  close(gMetrics.profitFactor, 38 / 18, "Profit Factor");
});

check("최대낙폭 = 1050 → 990, 60 (5.714286%)", () => {
  close(gMetrics.maxDrawdownAmount, 60, "MDD 금액");
  close(gMetrics.maxDrawdownPct, (60 / 1_050) * 100, "MDD %");
});

check("샤프 = sqrt(126) ≈ 11.2249722 (일별수익률 2%, 0% / 252일 연율화)", () => {
  close(gMetrics.sharpe, Math.sqrt(126), "샤프", 1e-9);
});

check("일별 손익 집계", () => {
  eq(gMetrics.tradingDays, 2, "거래일 수");
  eq(gMetrics.winningDays, 1, "수익일 수");
  eq(gMetrics.losingDays, 0, "손실일 수");
});

// ─────────────────────────────────────────────────────────────────────────────
// 리포트 스모크 (형식이 깨지지 않는지)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\n[H] 리포트 렌더링 스모크 테스트");

check("formatReport 가 예외 없이 문자열을 만든다", () => {
  const text = formatReport(aResult, computeMetrics(aResult), {
    banner: "⚠️ 인공 데이터 기반 엔진 단위테스트 출력입니다. 실제 백테스트 결과가 아닙니다.",
    maxTradeRows: 5,
  });
  if (!text.includes("백테스트 결과")) throw new Error("리포트 헤더 누락");
  if (!text.includes("비용으로 잃은 폭")) throw new Error("비용 비교 섹션 누락");
});

// ─────────────────────────────────────────────────────────────────────────────
console.log("\n" + "═".repeat(70));
if (failures.length === 0) {
  console.log(`✅ 전체 통과: ${passed}개 검증 항목`);
  console.log("   (인공 데이터 기반 엔진 단위테스트 — 시장 성과와 무관합니다)");
} else {
  console.log(`❌ 실패 ${failures.length}건 / 통과 ${passed}건`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exitCode = 1;
}
console.log("═".repeat(70) + "\n");
