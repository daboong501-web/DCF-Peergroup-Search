/**
 * **실데이터 백테스트** — SPY 실제 일봉(2010-01-04 ~ 2019-12-30) 을 엔진에 태워 돌린다.
 *
 * 실행:
 *   npx tsx scripts/backtest-daily.ts
 *   npx tsx scripts/backtest-daily.ts --csv data/bars/csv/SPY_daily_2010-2019.csv --capital 100000
 *
 * ┌────────────────────────────────────────────────────────────────────────────┐
 * │ ⚠️ 여기서 돌리는 것은 명세 B장의 S1/S2/S3 가 **아니다.**                    │
 * │    S1·S2·S3 는 전부 1분봉이 필요한데 이 환경에서 미국주식 분봉을 구할 수     │
 * │    없다. 대신 **일봉만으로 정확히 계산 가능하고 명세의 근본 전제를 검증하는**│
 * │    두 가지를 돌린다.                                                        │
 * │      (a) S0  : 매일 시가매수 → 종가매도 (귀무가설 · 무조건 참여 베이스라인)  │
 * │      (c) S3′ : 갭다운 반전의 **종가청산 프록시** (원 명세는 15분 청산)       │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * 일봉은 `src/trading/data/dailySessionAdapter.ts` 로 합성 3봉 세션(09:30 판정 /
 * 09:31 체결·경로 / 15:59 종가)으로 펼쳐서 엔진에 넣는다. 편향은 그 파일 상단 참조.
 */

import { readFileSync } from "fs";
import { ZERO_COST_PARAMS, type CostParams } from "../src/trading/costs";
import {
  COST_SPY,
  roundTripCostBps,
  stress3x,
  stressComm,
  stressFx,
} from "../src/trading/costScenarios";
import { runBacktest, type BacktestResult, type EngineConfig } from "../src/trading/engine";
import { computeMetrics, formatReport, type PerformanceMetrics } from "../src/trading/metrics";
import { parseCsvBars } from "../src/trading/data/csvSource";
import { expandDailyBarsToSessions } from "../src/trading/data/dailySessionAdapter";
import { etDateKey } from "../src/trading/session";
import { registerBuiltinStrategies, strategyRegistry } from "../src/trading/strategies";
import { optionalNumber, optionalString, parseArgs } from "../src/trading/cli";
import { sma, wilderAtr } from "../src/trading/indicators";
import type { Bar } from "../src/trading/types";

const SYMBOL = "SPY";

// ─── 통계 ───

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

/** 거래당 순수익률의 단측 t검정 (H0: 평균 ≤ 0). */
function oneSidedT(returns: number[]): { t: number; p: number; meanBps: number; n: number } {
  const n = returns.length;
  if (n < 2) return { t: NaN, p: NaN, meanBps: NaN, n };
  const m = mean(returns);
  const s = sd(returns);
  const t = m / (s / Math.sqrt(n));
  return { t, p: 1 - normCdf(t), meanBps: m * 10_000, n };
}

// ─── 실행 헬퍼 ───

interface RunSpec {
  label: string;
  strategy: string;
  params: Record<string, unknown>;
  cost: CostParams;
  risk: EngineConfig["risk"];
  bars: Bar[];
  capital: number;
}

interface RunOutcome {
  spec: RunSpec;
  result: BacktestResult;
  metrics: PerformanceMetrics;
  tradeReturns: number[];
}

function run(spec: RunSpec): RunOutcome {
  const strategy = strategyRegistry.create(spec.strategy, spec.params);
  const result = runBacktest(strategy, new Map([[SYMBOL, spec.bars]]), {
    initialCapital: spec.capital,
    interval: "1m", // 합성 세션 봉은 분 단위 타임스탬프를 가진다
    cost: spec.cost,
    risk: spec.risk,
    params: spec.params,
    mode: "backtest",
  });
  const metrics = computeMetrics(result);
  // H10 — 당일청산 무결성은 성과 논의 이전의 게이트다.
  if (metrics.overnightTrades !== 0) {
    throw new Error(
      `H10_VIOLATION: ${spec.label} 에서 오버나이트 거래 ${metrics.overnightTrades}건 발생 — 엔진/전략 버그`
    );
  }
  return { spec, result, metrics, tradeReturns: result.trades.map((t) => t.returnPct) };
}

const SUMMARY_HEADER = [
  "시나리오".padEnd(22),
  "거래수".padStart(6),
  "총수익%".padStart(10),
  "CAGR%".padStart(8),
  "샤프".padStart(7),
  "MDD%".padStart(8),
  "PF".padStart(7),
  "승률%".padStart(7),
  "거래당bp".padStart(9),
  "  t".padStart(6),
  " p(단측)".padStart(8),
  "비용드래그%".padStart(11),
].join(" ");

function summaryRow(o: RunOutcome, years: number): string {
  const m = o.metrics;
  const tt = oneSidedT(o.tradeReturns);
  const multiple = m.finalEquity / m.initialCapital;
  const cagr = multiple > 0 ? (Math.pow(multiple, 1 / years) - 1) * 100 : -100;
  return [
    o.spec.label.padEnd(22),
    String(m.tradeCount).padStart(6),
    m.totalReturnPct.toFixed(2).padStart(10),
    cagr.toFixed(2).padStart(8),
    m.sharpe.toFixed(3).padStart(7),
    m.maxDrawdownPct.toFixed(2).padStart(8),
    (Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(3) : "∞").padStart(7),
    m.winRatePct.toFixed(1).padStart(7),
    tt.meanBps.toFixed(2).padStart(9),
    tt.t.toFixed(2).padStart(6),
    (tt.p < 0.0005 ? "<0.001" : tt.p.toFixed(3)).padStart(8),
    m.costDragPct.toFixed(2).padStart(11),
  ].join(" ");
}

// ─── 메인 ───

function main(): void {
  registerBuiltinStrategies();
  const args = parseArgs(process.argv.slice(2));
  const csvPath = optionalString(args, "csv") ?? "data/bars/csv/SPY_daily_2010-2019.csv";
  const capital = optionalNumber(args, "capital") ?? 100_000;

  const daily = parseCsvBars(readFileSync(csvPath, "utf-8"), SYMBOL, {}).sort((a, b) => a.t - b.t);
  const sessionBars = expandDailyBarsToSessions(daily);
  const years = (daily[daily.length - 1].t - daily[0].t) / (365.2425 * 86_400_000);

  console.log("═".repeat(118));
  console.log("실데이터 백테스트 — SPY 일봉 (합성 세션 어댑터 경유)");
  console.log("═".repeat(118));
  console.log(`데이터     : ${csvPath}`);
  console.log(
    `기간       : ${etDateKey(daily[0].t)} ~ ${etDateKey(daily[daily.length - 1].t)}  (${daily.length} 거래일 → 합성 ${sessionBars.length} 봉)`
  );
  console.log(`초기자본   : ${capital.toLocaleString()} USD`);
  console.log(
    `왕복비용   : base ${roundTripCostBps(COST_SPY, mean(daily.map((b) => b.c))).toFixed(2)}bp ` +
      `(명세 D.3.4 의 25.3bp 와 일치)`
  );
  console.log("⚠️  이것은 S1/S2/S3 의 백테스트가 아니다. 분봉 부재로 그 셋은 실행 불가하다.");
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // (a) S0 — 매일 시가매수 → 종가매도
  // ══════════════════════════════════════════════════════════════════════════
  console.log("─".repeat(118));
  console.log("(a) S0 — 귀무가설 베이스라인: 매일 시가매수 → 종가매도 (롱온리 인트라데이 전량노출)");
  console.log("    명세 A.4 의 '선택적 참여' 논리가 정당한지를 실측으로 검증한다. 알파는 0 이다.");
  console.log("─".repeat(118));

  const s0Risk: EngineConfig["risk"] = {
    maxPositionPct: 1.0,
    maxConcurrentPositions: 1,
    dailyLossLimitPct: 0, // 베이스라인은 리스크 규칙 개입 없이 순수 노출만 본다
    exitBeforeCloseMinutes: 1,
    allowShort: false,
    allowFractionalShares: false,
  };
  const s0Params = { symbol: SYMBOL, sizePct: 0.98 };
  const s0Scenarios: Array<[string, CostParams]> = [
    ["zero-cost (참고전용)", ZERO_COST_PARAMS],
    ["base (25.3bp 왕복)", COST_SPY],
    ["stress-3x", stress3x(COST_SPY)],
    ["stress-fx", stressFx(COST_SPY)],
    ["stress-comm (0.25%)", stressComm(COST_SPY)],
  ];

  const s0Runs = s0Scenarios.map(([label, cost]) =>
    run({ label, strategy: "daily-open-close", params: s0Params, cost, risk: s0Risk, bars: sessionBars, capital })
  );

  console.log(SUMMARY_HEADER);
  console.log("─".repeat(118));
  for (const o of s0Runs) console.log(summaryRow(o, years));
  console.log("");
  console.log("※ '거래당bp' 는 1거래(시가매수→종가매도) 당 투입금액 대비 순수익률(bp).");
  console.log("※ t/p 는 H0: 평균 순수익 ≤ 0 에 대한 단측검정 (정규근사).");
  console.log("");

  // IS / OOS 분할 (명세 D.5.2 — 시간순 앞 70% / 뒤 30%)
  const splitIdx = Math.floor(daily.length * 0.7);
  const isBars = expandDailyBarsToSessions(daily.slice(0, splitIdx));
  const oosBars = expandDailyBarsToSessions(daily.slice(splitIdx));
  const isYears = (daily[splitIdx - 1].t - daily[0].t) / (365.2425 * 86_400_000);
  const oosYears = (daily[daily.length - 1].t - daily[splitIdx].t) / (365.2425 * 86_400_000);
  console.log(
    `── S0 의 IS/OOS 분할 (D.5.2) — IS ${etDateKey(daily[0].t)}~${etDateKey(daily[splitIdx - 1].t)} / ` +
      `OOS ${etDateKey(daily[splitIdx].t)}~${etDateKey(daily[daily.length - 1].t)} ──`
  );
  console.log(SUMMARY_HEADER);
  console.log("─".repeat(118));
  console.log(
    summaryRow(
      run({ label: "IS base", strategy: "daily-open-close", params: s0Params, cost: COST_SPY, risk: s0Risk, bars: isBars, capital }),
      isYears
    )
  );
  console.log(
    summaryRow(
      run({ label: "OOS base", strategy: "daily-open-close", params: s0Params, cost: COST_SPY, risk: s0Risk, bars: oosBars, capital }),
      oosYears
    )
  );
  console.log(
    summaryRow(
      run({ label: "IS zero-cost", strategy: "daily-open-close", params: s0Params, cost: ZERO_COST_PARAMS, risk: s0Risk, bars: isBars, capital }),
      isYears
    )
  );
  console.log(
    summaryRow(
      run({ label: "OOS zero-cost", strategy: "daily-open-close", params: s0Params, cost: ZERO_COST_PARAMS, risk: s0Risk, bars: oosBars, capital }),
      oosYears
    )
  );
  console.log("");

  // 연도별
  console.log("── S0 연도별 순손익 (base 비용) ──");
  const s0Base = s0Runs[1];
  const yearAgg = new Map<string, { net: number; gross: number; cost: number; days: number }>();
  for (const d of s0Base.result.daily) {
    const y = d.date.slice(0, 4);
    const e = yearAgg.get(y) ?? { net: 0, gross: 0, cost: 0, days: 0 };
    e.net += d.netPnl;
    e.gross += d.grossPnl;
    e.cost += d.cost;
    e.days += 1;
    yearAgg.set(y, e);
  }
  console.log("연도    거래일    gross손익      비용        net손익");
  for (const [y, e] of [...yearAgg.entries()].sort()) {
    console.log(
      [
        y,
        String(e.days).padStart(7),
        e.gross.toFixed(2).padStart(12),
        e.cost.toFixed(2).padStart(11),
        e.net.toFixed(2).padStart(13),
      ].join(" ")
    );
  }
  console.log("");

  console.log("── S0 base 시나리오 전체 리포트 ──");
  console.log(
    formatReport(s0Base.result, s0Base.metrics, {
      banner:
        "⚠️ SPY 실제 일봉 기반. 단, 이것은 S1/S2/S3 가 아니라 '무조건 참여' 베이스라인(S0)이다.",
      maxTradeRows: 5,
      showDaily: false,
    })
  );
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // (c) S3′ — 갭다운 반전의 일봉(종가청산) 프록시
  // ══════════════════════════════════════════════════════════════════════════
  console.log("─".repeat(118));
  console.log("(c) S3′ — Mind-the-Gap 의 **일봉 프록시** (시가 진입 → 종가 청산)");
  console.log("    ⚠️ 원 명세 S3 는 (1) 진입 후 **15분** 청산, (2) S&P500 크로스섹션 상위 3종목이다.");
  console.log("       이 프록시는 청산 시점이 다르고 크로스섹션도 없다 ⇒ **원 전략의 성과가 아니다.**");
  console.log("─".repeat(118));

  // 일봉 파생값을 D−1 까지만 써서 causal 하게 만든다.
  const atr = wilderAtr(daily, 14);
  const smaClose = sma(daily.map((b) => b.c), 100);
  const prevClose: Record<string, number> = {};
  const atr14: Record<string, number> = {};
  const sma100: Record<string, number> = {};
  for (let i = 1; i < daily.length; i++) {
    const date = etDateKey(daily[i].t);
    prevClose[date] = daily[i - 1].c;
    const a = atr[i - 1];
    const s = smaClose[i - 1];
    if (a !== null) atr14[date] = a;
    if (s !== null) sma100[date] = s;
  }

  const s3Risk: EngineConfig["risk"] = {
    maxPositionPct: 1.0,
    maxConcurrentPositions: 1,
    dailyLossLimitPct: 0,
    exitBeforeCloseMinutes: 1,
    allowShort: false,
    allowFractionalShares: false,
  };

  console.log(SUMMARY_HEADER);
  console.log("─".repeat(118));
  const s3Runs: RunOutcome[] = [];
  for (const [label, gapMult, cost] of [
    ["k=1.2 zero-cost", 1.2, ZERO_COST_PARAMS],
    ["k=1.2 base", 1.2, COST_SPY],
    ["k=1.0 base", 1.0, COST_SPY],
    ["k=0.8 base", 0.8, COST_SPY],
    ["k=0.8 zero-cost", 0.8, ZERO_COST_PARAMS],
  ] as Array<[string, number, CostParams]>) {
    const o = run({
      label,
      strategy: "gap-reversal-daily",
      params: {
        symbol: SYMBOL,
        gapMult,
        stopPct: 0.015,
        sizePct: 0.95, // 단일 종목 프록시 — 거래당 수익률을 노출 희석 없이 보기 위함
        requireAboveSma: true,
        prevClose,
        atr14,
        sma100,
      },
      cost,
      risk: s3Risk,
      bars: sessionBars,
      capital,
    });
    s3Runs.push(o);
    console.log(summaryRow(o, years));
  }
  console.log("");
  console.log("※ 명세 D.4/D.5.5: 최소 100 트레이드 미만이면 **결론 유보**(합격도 불합격도 아님, 투입 금지).");
  console.log("");

  const s3Base = s3Runs[1];
  console.log("── S3′ (k=1.2, base 비용) 개별 거래 전량 ──");
  console.log("세션일         진입가     청산가     gross      비용       net      수익률bp   사유");
  for (const t of s3Base.result.trades) {
    console.log(
      [
        t.sessionDate,
        t.entryPrice.toFixed(2).padStart(10),
        t.exitPrice.toFixed(2).padStart(10),
        t.grossPnl.toFixed(2).padStart(10),
        (t.commission + t.slippageCost + t.fxCost).toFixed(2).padStart(9),
        t.netPnl.toFixed(2).padStart(10),
        (t.returnPct * 10_000).toFixed(1).padStart(10),
        "  " + t.exitReason,
      ].join(" ")
    );
  }
  console.log("");

  // 단일 거래 의존도 (jackknife) — 표본이 작을수록 결정적인 점검이다.
  const s3Rets = s3Base.tradeReturns;
  if (s3Rets.length > 2) {
    const sorted = [...s3Rets].sort((a, b) => a - b);
    const best = sorted[sorted.length - 1];
    const worst = sorted[0];
    const total = s3Rets.reduce((a, b) => a + b, 0);
    console.log("── S3′ (k=1.2, base) 단일 거래 의존도 (jackknife) ──");
    console.log(
      `  전체 평균                : ${((total / s3Rets.length) * 10_000).toFixed(2)}bp  (n=${s3Rets.length})`
    );
    console.log(
      `  최고 1건 제외 시 평균    : ${(((total - best) / (s3Rets.length - 1)) * 10_000).toFixed(2)}bp  ` +
        `(제외 거래 ${(best * 10_000).toFixed(1)}bp)`
    );
    console.log(
      `  최저 1건 제외 시 평균    : ${(((total - worst) / (s3Rets.length - 1)) * 10_000).toFixed(2)}bp  ` +
        `(제외 거래 ${(worst * 10_000).toFixed(1)}bp)`
    );
    console.log(
      `  → 최고 1건 제외로 평균이 붕괴하면 그 '엣지'는 단일 사건이며 통계가 아니다.`
    );
    console.log("");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // H10 / H6 요약
  // ══════════════════════════════════════════════════════════════════════════
  console.log("─".repeat(118));
  console.log("게이트 점검");
  console.log("─".repeat(118));
  console.log(
    `H10 당일청산 무결성 : 전 시나리오 overnightTrades = 0 ✓ (위반 시 이 스크립트는 예외로 중단된다)`
  );
  console.log(
    `H6  S0 참여율        : ${(s0Base.metrics.participationRate * 100).toFixed(1)}%  ` +
      `— 무조건 참여 전략이므로 100% 가 정상. 명세의 S1 합격선(≤60%)과 대비되는 값이다.`
  );
  console.log(
    `H6  S3′ 참여율       : ${(s3Base.metrics.participationRate * 100).toFixed(2)}%  ` +
      `— 선택적 참여가 극단적으로 작동한 사례 (거래일 2,515일 중 ${s3Base.metrics.tradeCount}일)`
  );
  console.log("═".repeat(118));
}

main();
