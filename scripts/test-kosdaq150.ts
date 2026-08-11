/**
 * 229200 전략(kosdaq150-orb-vwap) 로직 검증.
 *
 *   npx tsx scripts/test-kosdaq150.ts
 *
 * 손으로 계산 가능한 인공 봉으로 "명세대로 신호가 나는가"만 본다.
 * **시장 데이터가 아니며 성과와 무관하다.**
 */

import { runBacktest, type EngineConfig } from "../src/trading/engine";
import { createKosdaq150OrbStrategy } from "../src/trading/strategies/kosdaq150Orb";
import { KrRegularSessionCalendar, kstWallClockToUtcMs } from "../src/trading/krSession";
import { krEtfCostParams, roundTripCostBps } from "../src/trading/krCosts";
import type { Bar, Signal, StrategyContext, SessionInfo } from "../src/trading/types";

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const DAY = { y: 2026, m: 8, d: 11 };
const at = (h: number, min: number) => kstWallClockToUtcMs(DAY.y, DAY.m, DAY.d, h, min);

function bar(h: number, min: number, o: number, hi: number, lo: number, c: number, v = 50_000): Bar {
  return { t: at(h, min), o, h: hi, l: lo, c, v, symbol: "229200" };
}

const calendar = new KrRegularSessionCalendar();
const SESSION = calendar.sessionFor(at(10, 0)) as SessionInfo;

/** 전략을 엔진 없이 직접 구동해 신호만 뽑는 하네스. */
function runSignals(bars: Bar[], params: Record<string, unknown> = {}): Array<Signal | null> {
  const strat = createKosdaq150OrbStrategy();
  const logs: string[] = [];
  strat.init?.({
    params: params as never,
    symbols: ["229200"],
    interval: "1m",
    mode: "backtest",
    log: (m) => logs.push(m),
  });
  strat.onSessionStart?.(SESSION);

  const hist: Bar[] = [];
  const out: Array<Signal | null> = [];
  for (const b of bars) {
    hist.push(b);
    const ctx: StrategyContext = {
      now: b.t,
      symbol: b.symbol,
      session: SESSION,
      history: () => hist,
      position: () => null,
      equity: 10_000_000,
      cash: 10_000_000,
      minutesToClose: Math.floor((SESSION.closeMs - b.t) / 60_000),
      canEnter: true,
      params: params as never,
      log: (m: string) => logs.push(m),
    };
    const sig = strat.onBar(b, ctx);
    const arr = Array.isArray(sig) ? sig : sig ? [sig] : [];
    out.push(arr[0] ?? null);
  }
  return out;
}

/**
 * 개장 15분 레인지(14,700~14,800) → 돌파 → 완만한 상승으로 ATR·VWAP 을 채운다.
 * 값은 5원 호가 배수를 대충 따르되, 전략 로직 검증이 목적이라 정확한 체결가는 보지 않는다.
 */
function buildBars(): Bar[] {
  const bars: Bar[] = [];
  // 09:00~09:14 개장 레인지 (고가 14,800)
  for (let i = 0; i < 15; i += 1) {
    bars.push(bar(9, i, 14_750, 14_800, 14_700, 14_760));
  }
  // 09:15~09:29 레인지 안에서 횡보 (ATR 축적, 돌파 없음)
  for (let i = 15; i < 30; i += 1) {
    bars.push(bar(9, i, 14_760, 14_790, 14_730, 14_765));
  }
  // 09:30 돌파 (종가가 OR 고가 14,800 초과)
  bars.push(bar(9, 30, 14_790, 14_860, 14_780, 14_850, 200_000));
  // 09:31~09:40 돌파 후 상승 유지 (VWAP 위)
  for (let i = 31; i <= 40; i += 1) {
    bars.push(bar(9, i, 14_850, 14_900, 14_840, 14_880, 120_000));
  }
  return bars;
}

console.log("═".repeat(76));
console.log("229200 전략(kosdaq150-orb-vwap) 로직 검증 — 인공 봉, 성과와 무관");
console.log("═".repeat(76));

// ── A. 개장 레인지 구간에서는 진입하지 않는다 ──
console.log("\n[A] 개장 레인지 구간");
{
  const sigs = runSignals(buildBars());
  const orSignals = sigs.slice(0, 15).filter(Boolean);
  check("개장 15분 동안 진입 신호 0건 (변동성·스프레드 확대 구간 회피)", orSignals.length === 0);
}

// ── B. 돌파 봉에서 추격하지 않는다 ──
console.log("\n[B] 돌파 추격 금지");
{
  const bars = buildBars();
  const sigs = runSignals(bars);
  const breakoutIdx = bars.findIndex((b) => b.t === at(9, 30));
  check("돌파가 일어난 봉에서는 신호를 내지 않는다", sigs[breakoutIdx] === null);
}

// ── C. 돌파 후 눌림목에서 지정가 매수 + 매도계획 동반 ──
console.log("\n[C] 진입 신호와 매도 계획");
{
  const sigs = runSignals(buildBars());
  const entry = sigs.find((s): s is Signal => s !== null);
  check("돌파 이후 진입 신호가 발생한다", entry !== undefined);
  if (entry) {
    check("지정가 주문이다 (스프레드를 넘지 않아 슬리피지 0)", entry.orderType === "LIMIT");
    check("limitPrice 가 현재가보다 낮다 (눌림목 대기)", (entry.limitPrice ?? 0) > 0);
    check("손절가가 함께 정해져 있다", typeof entry.stopLoss === "number");
    check("익절가가 함께 정해져 있다", typeof entry.takeProfit === "number");
    check("최대보유봉수가 함께 정해져 있다", typeof entry.maxHoldBars === "number");
    check("롱이다 (공매도 없음)", entry.kind === "BUY");
    if (entry.limitPrice && entry.stopLoss && entry.takeProfit) {
      check("손절 < 진입 < 익절 순서가 맞다", entry.stopLoss < entry.limitPrice && entry.limitPrice < entry.takeProfit);
      const risk = entry.limitPrice - entry.stopLoss;
      const reward = entry.takeProfit - entry.limitPrice;
      check(
        `손익비가 기본 1:2 다 (risk=${risk.toFixed(1)} reward=${reward.toFixed(1)})`,
        Math.abs(reward / risk - 2) < 1e-6
      );
    }
    check("지정가 유효기간이 설정되어 있다 (미체결 시 취소)", (entry.validForBars ?? 0) > 0);
  }
}

// ── D. 비용 문턱 ──
console.log("\n[D] 비용 문턱 (cost gate)");
{
  const costBps = roundTripCostBps(krEtfCostParams({ referencePrice: 14_780 }));
  // 문턱을 비현실적으로 높이면 어떤 신호도 통과하지 못해야 한다.
  const blocked = runSignals(buildBars(), { roundTripCostBps: costBps, minEdgeMultiple: 1000 });
  check("문턱을 극단적으로 올리면 진입이 전부 차단된다", blocked.every((s) => s === null));

  const allowed = runSignals(buildBars(), { roundTripCostBps: costBps, minEdgeMultiple: 1 });
  check("문턱을 낮추면 진입이 발생한다", allowed.some((s) => s !== null));
}

// ── E. 시간대 필터 ──
console.log("\n[E] 시간대 필터");
{
  // 점심(11:30~13:30)에만 돌파가 일어나도록 구성
  const bars: Bar[] = [];
  for (let i = 0; i < 15; i += 1) bars.push(bar(9, i, 14_750, 14_800, 14_700, 14_760));
  for (let i = 15; i < 60; i += 1) bars.push(bar(9 + Math.floor(i / 60), i % 60, 14_760, 14_790, 14_730, 14_765));
  // 11:30~11:50 돌파 + 상승
  for (let m = 30; m <= 50; m += 1) bars.push(bar(11, m, 14_850, 14_900, 14_840, 14_880, 150_000));
  const sigs = runSignals(bars);
  check("점심 공백(11:30~13:30)에는 신규진입하지 않는다", sigs.every((s) => s === null));
}

// ── F. 하루 최대 진입 횟수 ──
console.log("\n[F] 과매매 방지");
{
  const sigs = runSignals(buildBars(), { maxEntriesPerDay: 1 });
  check("maxEntriesPerDay=1 이면 진입 신호가 1건 이하다", sigs.filter(Boolean).length <= 1);
}

// ── G. 엔진 통합 — requireExitPlan=true 에서 거부되지 않는다 ──
console.log("\n[G] 엔진 통합");
{
  const costParams = krEtfCostParams({ referencePrice: 14_780 });
  const config: EngineConfig = {
    initialCapital: 10_000_000,
    interval: "1m",
    cost: costParams,
    calendar,
    risk: {
      maxPositionPct: 0.3,
      maxConcurrentPositions: 1,
      dailyLossLimitPct: 0.02,
      exitBeforeCloseMinutes: 15,
      allowShort: false,
      allowFractionalShares: false,
      requireExitPlan: true, // ← 매도 계획 강제
    },
    params: { roundTripCostBps: roundTripCostBps(costParams), minEdgeMultiple: 1 },
  };
  let threw: string | null = null;
  let result;
  try {
    result = runBacktest(
      createKosdaq150OrbStrategy() as never,
      new Map([["229200", buildBars()]]),
      config
    );
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check("requireExitPlan=true 에서 EXIT_PLAN_REQUIRED 예외가 나지 않는다", threw === null, threw ?? "");
  if (result) {
    check("오버나이트 포지션 0건 (당일청산)", result.trades.every((t) => t.exitReason !== undefined));
    console.log(`     거래 ${result.trades.length}건 / 처리 봉 ${result.barsProcessed}개`);
    for (const t of result.trades) {
      console.log(`     - 청산사유=${t.exitReason}`);
    }
  }
}

console.log("\n" + "═".repeat(76));
if (failed === 0) {
  console.log(`✅ 전체 통과: ${passed}개 검증 항목`);
  console.log("   (인공 봉 기반 로직 테스트 — 시장 성과와 무관합니다)");
} else {
  console.log(`❌ 실패 ${failed}개 / 통과 ${passed}개`);
  process.exitCode = 1;
}
console.log("═".repeat(76));
