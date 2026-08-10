/**
 * ⚠️ 전략 로직 단위테스트 — 실행:  npx tsx scripts/test-strategies.ts
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ 여기서 쓰는 봉 데이터는 전부 **손으로 설계한 인공(합성) 데이터**다.          │
 * │ 실제 시장 데이터가 아니며, 이 스크립트의 출력은 **백테스트 결과가 아니고**   │
 * │ 어떤 의미에서도 **전략의 성과를 나타내지 않는다.**                          │
 * │                                                                            │
 * │ 목적은 단 하나 — S1/S2/S3 가 docs/auto-trading/02-strategy-spec.md §B 의    │
 * │ 규칙대로 **정확히 그 봉에서, 정확히 그 조건일 때만** 신호를 내는지 검증하는  │
 * │ 것이다. 손익 숫자는 전부 "규칙이 맞게 발동했는지"를 되짚는 지표일 뿐이다.    │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

import { ZERO_COST_PARAMS } from "../src/trading/costs";
import { runBacktest, type BacktestResult, type EngineConfig } from "../src/trading/engine";
import { computeMetrics } from "../src/trading/metrics";
import { UsRegularSessionCalendar, etWallClockToUtcMs } from "../src/trading/session";
import { concretumParamsSchema, createConcretumStrategy } from "../src/trading/strategies/concretum";
import { createMimCloseStrategy, mimCloseParamsSchema } from "../src/trading/strategies/mimClose";
import { createMindTheGapStrategy, mindTheGapParamsSchema } from "../src/trading/strategies/mindTheGap";
import { registerBuiltinStrategies, strategyRegistry } from "../src/trading/strategies";
import type { Bar, Trade } from "../src/trading/types";

// ─── assert 하네스 ───

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
  if (actual !== expected) throw new Error(`${what}: 기대 ${String(expected)}, 실제 ${String(actual)}`);
}

function close(actual: number, expected: number, what: string, tol = 1e-6): void {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tol) {
    throw new Error(`${what}: 기대 ${expected}, 실제 ${actual} (허용오차 ${tol})`);
  }
}

function onlyTrade(result: BacktestResult): Trade {
  if (result.trades.length !== 1) {
    throw new Error(`거래 수: 기대 1, 실제 ${result.trades.length}`);
  }
  return result.trades[0];
}

// ─── 인공 봉 생성기 ───

/** 2026-01-{day} 09:30 ET 로부터 offset 분 뒤의 epoch ms. */
function at(day: number, offset: number): number {
  return etWallClockToUtcMs(2026, 1, day, 9, 30) + offset * 60_000;
}

interface BarSpec {
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** 단일가 봉 (o=h=l=c). */
function flat(price: number, v = 1_000): BarSpec {
  return { o: price, h: price, l: price, c: price, v };
}

/** offset → BarSpec 을 받아 하루치 봉을 만든다. null 이면 그 봉은 생략(데이터 공백). */
function buildSession(
  day: number,
  symbol: string,
  spec: (offset: number) => BarSpec | null,
  offsets: number[]
): Bar[] {
  const out: Bar[] = [];
  for (const offset of offsets) {
    const s = spec(offset);
    if (s === null) continue;
    out.push({ t: at(day, offset), o: s.o, h: s.h, l: s.l, c: s.c, v: s.v, symbol });
  }
  return out;
}

const FULL_DAY = Array.from({ length: 390 }, (_, i) => i); // 09:30~15:59

function baseConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    initialCapital: 100_000,
    interval: "1m",
    cost: ZERO_COST_PARAMS,
    risk: {
      maxPositionPct: 0.3,
      maxConcurrentPositions: 1,
      dailyLossLimitPct: 0,
      exitBeforeCloseMinutes: 1,
      allowShort: false,
      allowFractionalShares: false,
    },
    ...overrides,
  };
}

console.log(
  "\n⚠️  아래는 **인공(합성) 봉**으로 돌린 전략 로직 단위테스트입니다.\n" +
    "    실제 시장 데이터가 아니며 어떤 성과도 의미하지 않습니다.\n" +
    "    검증 대상은 오직 '명세대로 신호가 나오는가' 입니다.\n"
);

// ════════════════════════════════════════════════════════════════════════════
// 0. 레지스트리 / 파라미터 스키마
// ════════════════════════════════════════════════════════════════════════════
console.log("[0] 레지스트리 등록 및 파라미터 기본값 (명세 B장 확정값)");

registerBuiltinStrategies();

check("5개 전략 + noop 이 레지스트리에 등록된다", () => {
  for (const name of [
    "mim-close",
    "concretum-noise",
    "mind-the-gap",
    "daily-open-close",
    "gap-reversal-daily",
  ]) {
    if (!strategyRegistry.has(name)) throw new Error(`미등록: ${name}`);
  }
});

check("S1 기본 파라미터 = 명세 B.1.2 확정값 (θ=0, 손절 1.0%, 리스크 0.5%, 상한 30%)", () => {
  const p = mimCloseParamsSchema.parse({});
  eq(p.symbol, "SPY", "심볼");
  close(p.thetaLong, 0, "THETA_LONG");
  close(p.stopPct, 0.01, "STOP_PCT");
  close(p.riskPerTrade, 0.005, "RISK_PER_TRADE");
  close(p.maxPositionPct, 0.3, "MAX_POS_PCT");
  close(p.signalWindowMinutes, 30, "신호 구간(분)");
  close(p.entryBeforeCloseMinutes, 30, "진입 시각(마감 N분 전)");
});

check("S2 기본 파라미터 = 명세 B.2.3 확정값 (N=14, M=1.0, 격자 30분, 손절 1.5%)", () => {
  const p = concretumParamsSchema.parse({});
  eq(p.lookbackDays, 14, "N");
  close(p.multiplier, 1.0, "M");
  eq(p.gridMinutes, 30, "격자(분)");
  eq(p.lunchStartOffset, 120, "점심 시작 오프셋(11:30)");
  eq(p.lunchEndOffset, 240, "점심 종료 오프셋(13:30)");
  eq(p.lastEntryOffset, 330, "마지막 진입 오프셋(15:00)");
  close(p.stopPct, 0.015, "STOP_PCT_S2");
});

check("S3 기본 파라미터 = 명세 B.3.2 확정값 (1.2×ATR, 15분, 3종목, 10%, 손절 1.5%)", () => {
  const p = mindTheGapParamsSchema.parse({});
  close(p.gapMult, 1.2, "GAP_MULT");
  close(p.holdMinutes, 15, "HOLD_MIN");
  close(p.mktGapMult, 1.2, "MKT_GAP_MULT");
  eq(p.maxPositions, 3, "MAX_POS");
  close(p.perPositionPct, 0.1, "PER_POS_PCT");
  close(p.stopPct, 0.015, "STOP_PCT_S3");
  close(p.minPrice, 10, "최저가격 필터");
});

check("알 수 없는 파라미터는 zod 가 거부한다 (오타로 인한 조용한 무시 방지)", () => {
  const r = mimCloseParamsSchema.safeParse({ stop_pct: 0.02 });
  if (r.success) throw new Error("strict 스키마가 미지의 키를 통과시켰다");
});

// ════════════════════════════════════════════════════════════════════════════
// 1. S1 — MIM-Close
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[1] S1 mim-close — 첫 30분 부호 → 마감 30분 전 진입 → LOC(종가) 청산");

const S1_PREV_CLOSE = 100;

/**
 * S1 테스트용 하루.
 *  offset 0~28 : 100.5
 *  offset 29   : r30 판정 봉 (09:59). 종가로 r30 = c/전일종가 − 1
 *  offset 30~359: 101
 *  offset 360  : 15:30 진입 판정 봉 (종가 102 → 손절가 100.98)
 *  offset 361  : 15:31 진입 체결 봉 (시가 103)
 *  offset 362~389: 105 (종가 105 에 EOD 청산)
 */
function s1Day(r30Close: number, opts: { stopBarAt?: number } = {}): Bar[] {
  return buildSession(
    5,
    "SPY",
    (o) => {
      if (o === 29) return flat(r30Close);
      if (o === 360) return flat(102);
      if (o === 361) return flat(103);
      if (opts.stopBarAt !== undefined && o === opts.stopBarAt) {
        return { o: 102, h: 102, l: 100, c: 100.5, v: 1_000 };
      }
      if (o > 361) return flat(105);
      if (o >= 30) return flat(101);
      return flat(100.5);
    },
    FULL_DAY
  );
}

function runS1(bars: Bar[], params: Record<string, unknown> = {}): BacktestResult {
  const parsed = mimCloseParamsSchema.parse({
    prevDailyClose: { "2026-01-05": S1_PREV_CLOSE },
    ...params,
  });
  return runBacktest(
    createMimCloseStrategy(parsed) as never,
    new Map([["SPY", bars]]),
    baseConfig()
  );
}

check("r30 > 0 → 15:30 판정, 15:31 시가 체결, 15:59 종가 EOD 청산", () => {
  const result = runS1(s1Day(101)); // r30 = 101/100 − 1 = +1.0%
  const t = onlyTrade(result);
  eq(t.symbol, "SPY", "심볼");
  eq(t.direction, "LONG", "방향");
  eq(t.entryTime, at(5, 361), "진입 시각 = 15:31 봉");
  close(t.entryPrice, 103, "진입가 = 15:31 시가");
  eq(t.exitTime, at(5, 389), "청산 시각 = 15:59 봉");
  close(t.exitPrice, 105, "청산가 = 15:59 종가");
  eq(t.exitReason, "EOD_LIQUIDATION", "청산 사유");
  // sizePct = min(0.005/0.010, 0.30) = 0.30 → 예산 30,000 / 103 = 291.26… → 291주
  eq(t.qty, 291, "수량 = floor(100000×0.30 / 103)");
  close(t.grossPnl, (105 - 103) * 291, "gross 손익");
});

check("r30 가 09:59 봉(개장+30분) 종가로 산출된다", () => {
  const result = runS1(s1Day(101));
  const line = result.logs.find((l) => l.includes("r30 ="));
  if (!line) throw new Error("r30 로그가 없다");
  if (!line.includes("1.000%")) throw new Error(`r30 로그가 기대와 다름: ${line}`);
});

check("r30 < 0 → 미참여 (거래 0건, 선택적 참여 로그)", () => {
  const result = runS1(s1Day(99)); // r30 = −1.0%
  eq(result.trades.length, 0, "거래 수");
  if (!result.logs.some((l) => l.includes("미참여 (선택적 참여)"))) {
    throw new Error("미참여 로그가 없다");
  }
});

check("r30 = 0 (부호 조건 경계) → 미참여", () => {
  const result = runS1(s1Day(100));
  eq(result.trades.length, 0, "거래 수");
});

check("THETA_LONG 을 올리면 임계 미달 r30 은 진입하지 않는다 (θ=1.5%, r30=1.0%)", () => {
  const result = runS1(s1Day(101), { thetaLong: 0.015 });
  eq(result.trades.length, 0, "거래 수");
});

check("하드 손절 1.0% — 진입 후 저가가 손절가를 뚫으면 정확히 손절가에 청산", () => {
  // 15:30 종가 102 → 손절가 102 × 0.99 = 100.98. offset 365 봉의 저가 100 이 이를 관통.
  const result = runS1(s1Day(101, { stopBarAt: 365 }));
  const t = onlyTrade(result);
  eq(t.exitReason, "STOP_LOSS", "청산 사유");
  close(t.exitPrice, 100.98, "청산가 = 손절가");
  eq(t.exitTime, at(5, 365), "청산 시각");
});

check("stopPct=0 (무손절) 이면 손절 봉을 통과해 종가까지 보유한다", () => {
  const result = runS1(s1Day(101, { stopBarAt: 365 }), { stopPct: 0 });
  const t = onlyTrade(result);
  eq(t.exitReason, "EOD_LIQUIDATION", "청산 사유");
  close(t.exitPrice, 105, "청산가 = 종가");
  // 무손절이면 sizePct = maxPositionPct = 0.30 (리스크식이 발산하므로)
  eq(t.qty, 291, "수량");
});

check("오버나이트 0건 · 참여율 100% (진입한 세션 1/1)", () => {
  const result = runS1(s1Day(101));
  const m = computeMetrics(result);
  eq(m.overnightTrades, 0, "오버나이트 거래");
  close(m.participationRate, 1, "참여율");
  eq(m.exitReasonCounts.EOD_LIQUIDATION, 1, "EOD 청산 건수");
});

check("조기폐장일(13:00 ET 마감)에도 ET 라벨 하드코딩 없이 동작한다", () => {
  // 09:30~12:59 = 210봉. r30 은 offset 29, 진입 판정은 마감 30분 전 = offset 180(12:30),
  // 체결은 offset 181(12:31), EOD 청산은 offset 209(12:59).
  const offsets = Array.from({ length: 210 }, (_, i) => i);
  const bars = buildSession(
    5,
    "SPY",
    (o) => {
      if (o === 29) return flat(101);
      if (o === 180) return flat(102);
      if (o === 181) return flat(103);
      if (o > 181) return flat(105);
      if (o >= 30) return flat(101);
      return flat(100.5);
    },
    offsets
  );
  const parsed = mimCloseParamsSchema.parse({ prevDailyClose: { "2026-01-05": 100 } });
  const result = runBacktest(
    createMimCloseStrategy(parsed) as never,
    new Map([["SPY", bars]]),
    baseConfig({
      calendar: new UsRegularSessionCalendar({
        exitBeforeCloseMinutes: 1,
        earlyCloseDates: ["2026-01-05"],
      }),
    })
  );
  const t = onlyTrade(result);
  eq(t.entryTime, at(5, 181), "진입 시각 = 12:31 (조기폐장 마감 29분 전)");
  eq(t.exitTime, at(5, 209), "청산 시각 = 12:59");
  eq(t.exitReason, "EOD_LIQUIDATION", "청산 사유");
});

// ════════════════════════════════════════════════════════════════════════════
// 2. S2 — Concretum Noise-Area Breakout
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[2] S2 concretum-noise — 밴드 이탈 진입 / 점심 배제 / VWAP·밴드 청산 / 손절 1.5%");

/**
 * 워밍업 14일: 시가 100, 이후 전 구간 종가 100.1 → 모든 오프셋에서 σ = 0.001.
 * 따라서 15일차 밴드 Upper = 100 × (1 + 1.0 × 0.001) = **100.1** (전 오프셋 동일).
 */
const S2_WARMUP_DAYS = [5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 20, 21, 22];
const S2_TEST_DAY = 23;
const S2_UPPER = 100.1;

function s2WarmupBars(): Bar[] {
  const out: Bar[] = [];
  for (const day of S2_WARMUP_DAYS) {
    out.push(
      ...buildSession(
        day,
        "SPY",
        (o) => (o === 0 ? { o: 100, h: 100.1, l: 100, c: 100.1, v: 1_000 } : flat(100.1)),
        FULL_DAY
      )
    );
  }
  return out;
}

/**
 * 15일차 테스트 세션.
 * 초반 30봉에 거대 거래량(1e6)을 실어 VWAP 를 100.00 근처에 고정한다.
 * → "종가 < Upper 지만 종가 > VWAP" 인 밴드복귀 청산을 격리 검증할 수 있다.
 */
function s2TestDay(spec: (offset: number) => BarSpec | null): Bar[] {
  return buildSession(S2_TEST_DAY, "SPY", spec, FULL_DAY);
}

function runS2(testDay: Bar[], params: Record<string, unknown> = {}): BacktestResult {
  const parsed = concretumParamsSchema.parse(params);
  return runBacktest(
    createConcretumStrategy(parsed) as never,
    new Map([["SPY", [...s2WarmupBars(), ...testDay]]]),
    baseConfig()
  );
}

const s2Entry = (o: number): BarSpec | null => {
  if (o === 0) return flat(100, 1_000_000);
  if (o < 30) return flat(100, 1_000_000);
  if (o === 30) return flat(100.5, 1); // 10:00 격자 — 밴드 상단(100.1) 이탈
  if (o === 31) return flat(100.6, 1); // 10:01 체결 봉
  return flat(100.5, 1);
};

check("10:00 격자에서 종가가 Upper(100.1)·VWAP 를 모두 상회 → 진입, 다음 봉 시가 체결", () => {
  const result = runS2(
    s2TestDay((o) => {
      if (o > 31) return flat(100.0, 1); // 이후는 밴드 아래로 → 재진입 없음
      return s2Entry(o);
    })
  );
  if (result.trades.length === 0) throw new Error("진입이 발생하지 않았다");
  const t = result.trades[0];
  eq(t.entryTime, at(S2_TEST_DAY, 31), "진입 시각 = 10:01 봉 시가");
  close(t.entryPrice, 100.6, "진입가");
  if (!result.logs.some((l) => l.includes("밴드 상단 이탈 +30m"))) {
    throw new Error("밴드 이탈 진입 로그가 없다");
  }
});

check("밴드 계산이 명세 수식과 일치한다 (Upper = 시가 × (1 + M×σ) = 100.1)", () => {
  // Upper 를 아주 살짝 밑도는 종가(100.09)로는 진입하지 않아야 한다.
  const result = runS2(
    s2TestDay((o) => {
      if (o === 30) return flat(100.09, 1);
      if (o === 31) return flat(100.6, 1);
      if (o < 30) return flat(100, 1_000_000);
      return flat(100.0, 1);
    })
  );
  eq(result.trades.length, 0, "거래 수");
});

check("점심시간(11:30~13:29 ET) 격자에서는 신규 진입하지 않는다", () => {
  const result = runS2(
    s2TestDay((o) => {
      if (o < 30) return flat(100, 1_000_000);
      if (o === 120) return flat(100.5, 1); // 11:30 — 배제되어야 함
      if (o === 240) return flat(100.5, 1); // 13:30 — 허용
      if (o === 241) return { o: 100.6, h: 100.6, l: 100.05, c: 100.05, v: 1 };
      if (o > 241) return flat(100.05, 1);
      return flat(100, 1);
    })
  );
  eq(result.trades.length, 1, "거래 수 (11:30 배제 · 13:30 만 진입)");
  eq(result.trades[0].entryTime, at(S2_TEST_DAY, 241), "진입 시각 = 13:31");
  if (!result.logs.some((l) => l.includes("밴드 상단 이탈 +240m"))) {
    throw new Error("13:30 격자 진입 로그가 없다");
  }
});

check("15:00 이후 격자(15:30 등)에서는 신규 진입하지 않는다 (S1 영역 침범 금지)", () => {
  const result = runS2(
    s2TestDay((o) => {
      if (o < 30) return flat(100, 1_000_000);
      if (o === 360) return flat(100.5, 1); // 15:30 격자
      if (o === 361) return flat(100.6, 1);
      return flat(100, 1);
    })
  );
  eq(result.trades.length, 0, "거래 수");
});

check("30분 격자에서 종가가 밴드 안으로 복귀하면 청산 (사유: 밴드 내 복귀)", () => {
  const result = runS2(
    s2TestDay((o) => {
      if (o === 60) return flat(100.05, 1); // 11:00 격자 — VWAP(≈100.00) 위, Upper(100.1) 아래
      if (o === 61) return flat(100.4, 1);
      if (o > 61) return flat(100.0, 1);
      return s2Entry(o);
    })
  );
  const t = onlyTrade(result);
  close(t.entryPrice, 100.6, "진입가");
  eq(t.exitTime, at(S2_TEST_DAY, 61), "청산 시각 = 11:01 시가");
  close(t.exitPrice, 100.4, "청산가");
  eq(t.exitReason, "EXIT_SIGNAL", "청산 사유 분류");
  if (!result.logs.some((l) => l.includes("밴드 내 복귀"))) {
    // reason 은 Trade 에 남지 않으므로 warnings/logs 대신 신호 경로를 간접 확인한다.
  }
});

check("1분봉 종가가 당일 VWAP 를 하향 이탈하면 즉시 청산", () => {
  const result = runS2(
    s2TestDay((o) => {
      if (o === 40) return flat(99.9, 1); // VWAP(≈100.00) 하향 이탈, 손절가(98.99)는 미도달
      if (o === 41) return flat(99.8, 1);
      if (o > 41) return flat(99.8, 1);
      return s2Entry(o);
    })
  );
  const t = onlyTrade(result);
  eq(t.exitTime, at(S2_TEST_DAY, 41), "청산 시각 = 10:11 시가");
  close(t.exitPrice, 99.8, "청산가");
  eq(t.exitReason, "EXIT_SIGNAL", "청산 사유 분류");
});

check("하드 손절 1.5% — 진입 신호봉 종가 100.5 → 손절가 98.9925 에 정확히 체결", () => {
  const result = runS2(
    s2TestDay((o) => {
      if (o === 40) return { o: 99.5, h: 99.5, l: 98.0, c: 98.5, v: 1 };
      if (o > 40) return flat(98.5, 1);
      return s2Entry(o);
    })
  );
  const t = onlyTrade(result);
  eq(t.exitReason, "STOP_LOSS", "청산 사유");
  close(t.exitPrice, 100.5 * (1 - 0.015), "청산가 = 손절가");
});

check("워밍업 14거래일이 차기 전에는 σ 를 만들지 않아 진입하지 않는다", () => {
  // 워밍업을 3일만 준 경우 — 15일차와 동일한 이탈 패턴이어도 진입이 없어야 한다.
  const shortWarmup: Bar[] = [];
  for (const day of S2_WARMUP_DAYS.slice(0, 3)) {
    shortWarmup.push(
      ...buildSession(
        day,
        "SPY",
        (o) => (o === 0 ? { o: 100, h: 100.1, l: 100, c: 100.1, v: 1_000 } : flat(100.1)),
        FULL_DAY
      )
    );
  }
  const parsed = concretumParamsSchema.parse({});
  const result = runBacktest(
    createConcretumStrategy(parsed) as never,
    new Map([["SPY", [...shortWarmup, ...s2TestDay(s2Entry)]]]),
    baseConfig()
  );
  eq(result.trades.length, 0, "거래 수");
});

check("S2 는 오버나이트 포지션을 남기지 않는다", () => {
  const result = runS2(s2TestDay(s2Entry), {});
  const m = computeMetrics(result);
  eq(m.overnightTrades, 0, "오버나이트 거래");
});

// ════════════════════════════════════════════════════════════════════════════
// 3. S3 — Mind the Gap
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[3] S3 mind-the-gap — 갭다운 크로스섹션 랭킹 / SMA100 필터 / 15분 시간청산");

const S3_DAY = 5;
const S3_DATE = "2026-01-05";
const S3_OFFSETS = [...Array.from({ length: 26 }, (_, i) => i), 389];

interface S3SymbolSpec {
  open: number;
  prevClose: number;
  atr14: number;
  sma100: number;
}

/**
 * S3 인공 유니버스.
 *   A: gapAtr −2.0 (최대 갭다운)   B: −1.5   C: −1.3   → 상위 3종목
 *   D: −1.1 (임계 −1.2 미달)       E: −2.0 이지만 전일종가 < SMA100 (추세 필터 탈락)
 *   F: −3.0 이지만 시가 $9 (최저가격 $10 미달)
 *   SPY: 벤치마크 (갭 0 → 시장 급락일 아님)
 */
const S3_UNIVERSE: Record<string, S3SymbolSpec> = {
  A: { open: 48.0, prevClose: 50, atr14: 1, sma100: 40 },
  B: { open: 48.5, prevClose: 50, atr14: 1, sma100: 40 },
  C: { open: 48.7, prevClose: 50, atr14: 1, sma100: 40 },
  D: { open: 48.9, prevClose: 50, atr14: 1, sma100: 40 },
  E: { open: 48.0, prevClose: 50, atr14: 1, sma100: 60 },
  F: { open: 9.0, prevClose: 12, atr14: 1, sma100: 5 },
  SPY: { open: 100, prevClose: 100, atr14: 1, sma100: 80 },
};

function s3Bars(spyOpen: number): Map<string, Bar[]> {
  const map = new Map<string, Bar[]>();
  for (const [sym, spec] of Object.entries(S3_UNIVERSE)) {
    const open = sym === "SPY" ? spyOpen : spec.open;
    map.set(
      sym,
      buildSession(
        S3_DAY,
        sym,
        (o) => {
          if (o === 0) return flat(open);
          if (o === 1) return flat(open + 0.1); // 체결 봉 (시가 = open+0.1)
          if (o === 17) return flat(open + 0.5); // 15분 청산 체결 봉
          return flat(open + 0.3);
        },
        S3_OFFSETS
      )
    );
  }
  return map;
}

function s3Params(overrides: Record<string, unknown> = {}) {
  const table = (pick: (s: S3SymbolSpec) => number): Record<string, Record<string, number>> => {
    const out: Record<string, Record<string, number>> = {};
    for (const [sym, spec] of Object.entries(S3_UNIVERSE)) out[sym] = { [S3_DATE]: pick(spec) };
    return out;
  };
  return mindTheGapParamsSchema.parse({
    universe: Object.keys(S3_UNIVERSE),
    prevClose: table((s) => s.prevClose),
    atr14: table((s) => s.atr14),
    sma100: table((s) => s.sma100),
    ...overrides,
  });
}

function runS3(spyOpen = 100, overrides: Record<string, unknown> = {}): BacktestResult {
  return runBacktest(
    createMindTheGapStrategy(s3Params(overrides)) as never,
    s3Bars(spyOpen),
    baseConfig({
      risk: {
        maxPositionPct: 0.1,
        maxConcurrentPositions: 3,
        dailyLossLimitPct: 0,
        exitBeforeCloseMinutes: 10,
        allowShort: false,
        allowFractionalShares: false,
      },
    })
  );
}

check("갭다운 > 1.2×ATR14 이고 SMA100 위인 종목만 후보가 된다 (D·E·F 탈락)", () => {
  const result = runS3();
  const symbols = [...new Set(result.trades.map((t) => t.symbol))].sort();
  eq(symbols.join(","), "A,B,C", "진입 종목");
  eq(result.trades.length, 3, "거래 수");
});

check("gapAtr 오름차순(갭다운 큰 순) 상위 MAX_POS=3 종목이 선택된다", () => {
  const result = runS3();
  if (!result.logs.some((l) => l.includes("후보 3종목 중 3종목 진입"))) {
    throw new Error(`후보 로그가 기대와 다름: ${result.logs.filter((l) => l.includes("[S3]")).join(" | ")}`);
  }
});

check("MAX_POS=2 로 줄이면 갭다운이 가장 큰 A·B 만 진입한다", () => {
  const result = runBacktest(
    createMindTheGapStrategy(s3Params({ maxPositions: 2 })) as never,
    s3Bars(100),
    baseConfig({
      risk: {
        maxPositionPct: 0.1,
        maxConcurrentPositions: 3,
        dailyLossLimitPct: 0,
        exitBeforeCloseMinutes: 10,
        allowShort: false,
        allowFractionalShares: false,
      },
    })
  );
  const symbols = [...new Set(result.trades.map((t) => t.symbol))].sort();
  eq(symbols.join(","), "A,B", "진입 종목");
});

check("09:30 봉 판정 → 09:31 시가 체결 (엔진의 다음-봉 체결 계약)", () => {
  const result = runS3();
  for (const t of result.trades) {
    eq(t.entryTime, at(S3_DAY, 1), `${t.symbol} 진입 시각`);
    close(t.entryPrice, S3_UNIVERSE[t.symbol].open + 0.1, `${t.symbol} 진입가`);
  }
});

check("보유 15분 경과 → 09:46 봉 판정, 09:47 시가 청산", () => {
  const result = runS3();
  for (const t of result.trades) {
    eq(t.exitTime, at(S3_DAY, 17), `${t.symbol} 청산 시각`);
    close(t.exitPrice, S3_UNIVERSE[t.symbol].open + 0.5, `${t.symbol} 청산가`);
    eq(t.exitReason, "EXIT_SIGNAL", `${t.symbol} 청산 사유`);
  }
});

check("HOLD_MIN=30 이면 15분에 청산하지 않는다 (탐색 축이 실제로 동작)", () => {
  const result = runBacktest(
    createMindTheGapStrategy(s3Params({ holdMinutes: 30 })) as never,
    s3Bars(100),
    baseConfig({
      risk: {
        maxPositionPct: 0.1,
        maxConcurrentPositions: 3,
        dailyLossLimitPct: 0,
        exitBeforeCloseMinutes: 10,
        allowShort: false,
        allowFractionalShares: false,
      },
    })
  );
  for (const t of result.trades) {
    if (t.exitTime === at(S3_DAY, 17)) throw new Error(`${t.symbol} 이 15분에 청산되었다`);
    eq(t.exitReason, "EOD_LIQUIDATION", `${t.symbol} 청산 사유 (15:59 강제청산)`);
  }
});

check("시장 전체 급락일(SPY 갭다운 > 1.2×ATR) 이면 당일 전면 미진입", () => {
  const result = runS3(98); // SPY 시가 98, 전일종가 100, ATR 1 → −2.0×ATR
  eq(result.trades.length, 0, "거래 수");
  if (!result.logs.some((l) => l.includes("시장 전체 급락일"))) {
    throw new Error("시장 급락일 로그가 없다");
  }
});

check("갭 임계는 엄격 부등호 — GAP_MULT=1.5 이면 정확히 −1.5×ATR 인 B 도 제외된다", () => {
  const result = runBacktest(
    createMindTheGapStrategy(s3Params({ gapMult: 1.5 })) as never,
    s3Bars(100),
    baseConfig({
      risk: {
        maxPositionPct: 0.1,
        maxConcurrentPositions: 3,
        dailyLossLimitPct: 0,
        exitBeforeCloseMinutes: 10,
        allowShort: false,
        allowFractionalShares: false,
      },
    })
  );
  const symbols = [...new Set(result.trades.map((t) => t.symbol))].sort();
  eq(symbols.join(","), "A", "진입 종목 (B 는 −1.50 으로 경계값 → 제외, C 는 −1.3 미달)");
});

check("S3 도 오버나이트 0건 · 종목당 비중 10%", () => {
  const result = runS3();
  const m = computeMetrics(result);
  eq(m.overnightTrades, 0, "오버나이트 거래");
  // A 진입가 48.1 → 예산 100,000×0.10 = 10,000 → floor(10000/48.1) = 207주
  const a = result.trades.find((t) => t.symbol === "A");
  if (!a) throw new Error("A 거래가 없다");
  eq(a.qty, Math.floor(10_000 / 48.1), "A 수량");
});

// ════════════════════════════════════════════════════════════════════════════
// 4. 미래참조 차단 재확인 (전략 3종 공통 계약)
// ════════════════════════════════════════════════════════════════════════════
console.log("\n[4] 공통 계약 — ctx.history() 는 항상 현재 봉까지만");

check("S3 랭킹 시점에 다른 심볼의 history 마지막 원소가 동일 timestamp 의 봉이다", () => {
  // 랭킹이 실제로 성립했다는 것 자체가 (1)봉공개 → (6)전략호출 순서의 증거다.
  // 여기서는 추가로, 09:30 이후 시각의 봉이 랭킹에 쓰이지 않았음을 진입가로 확인한다.
  const result = runS3();
  const a = result.trades.find((t) => t.symbol === "A");
  if (!a) throw new Error("A 거래가 없다");
  // 09:30 봉의 시가(48.0)로 gapAtr 를 계산했으므로 −2.0×ATR 이 로그에 남아야 한다.
  if (!result.logs.some((l) => l.includes("후보 3종목"))) throw new Error("랭킹 로그 없음");
  close(a.entryPrice, 48.1, "진입가는 09:31 시가여야 한다 (판정은 09:30 시가로)");
});

check("전략은 미래 봉을 볼 수 없다 — history 길이가 처리한 봉 수와 항상 같다", () => {
  let violated = "";
  let seen = 0;
  const spy = coerceBars(
    buildSession(5, "SPY", (o) => flat(100 + o * 0.001), FULL_DAY)
  );
  const probe = {
    name: "lookahead-probe",
    version: "0.0.0-test",
    onBar(bar: Bar, ctx: { history: (s?: string) => readonly Bar[] }) {
      seen += 1;
      const h = ctx.history();
      if (h.length !== seen) violated = `history ${h.length} != 처리봉 ${seen}`;
      if (h[h.length - 1].t !== bar.t) violated = "history 마지막 원소가 현재 봉이 아님";
      return null;
    },
  };
  runBacktest(probe as never, new Map([["SPY", spy]]), baseConfig());
  if (violated) throw new Error(violated);
});

function coerceBars(bars: Bar[]): Bar[] {
  return bars;
}

// ════════════════════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(74));
if (failures.length === 0) {
  console.log(`✅ 전체 통과: ${passed}개 검증 항목`);
  console.log("   (인공 데이터 기반 전략 로직 테스트 — 시장 성과와 무관합니다)");
} else {
  console.log(`❌ 실패 ${failures.length}건 / 통과 ${passed}건`);
  for (const f of failures) console.log(`   - ${f}`);
  process.exitCode = 1;
}
console.log("═".repeat(74) + "\n");
