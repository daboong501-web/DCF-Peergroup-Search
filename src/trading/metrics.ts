/**
 * 성과지표 계산 + 리포트 포맷.
 *
 * 당일청산 단타에서 제일 중요한 건 "비용 차감 전/후 비교"다.
 * 총수익률만 보면 멀쩡해 보이던 전략이 수수료·슬리피지를 넣는 순간 뒤집히는 일이 흔하다.
 * 그래서 모든 지표를 gross(비용 배제) / net(비용 반영) 두 벌로 낸다.
 */

import type { BacktestResult, DailySummary } from "./engine";
import type { Trade } from "./types";

/** 연간 거래일 수. 샤프 연율화에 사용. */
const TRADING_DAYS_PER_YEAR = 252;

export interface PerformanceMetrics {
  initialCapital: number;
  finalEquity: number;

  /** 비용 차감 후. */
  netProfit: number;
  totalReturnPct: number;
  /** 비용 차감 전 (수수료·슬리피지·환전 전부 제외). */
  grossProfit: number;
  grossReturnPct: number;
  /** 비용이 총수익률에서 깎아먹은 폭 (%p). grossReturnPct - totalReturnPct. */
  costDragPct: number;

  totalCommission: number;
  totalSlippage: number;
  totalFx: number;
  totalCost: number;

  tradeCount: number;
  winCount: number;
  lossCount: number;
  /** 승률 (%). 비용 차감 후 기준. */
  winRatePct: number;
  /** 비용 차감 전 승률 (%). 비용만으로 승패가 뒤집힌 거래를 드러낸다. */
  grossWinRatePct: number;
  avgWin: number;
  avgLoss: number;
  /** 손익비 = 평균이익 / 평균손실. */
  payoffRatio: number;
  /** Profit Factor = 총이익 / 총손실. */
  profitFactor: number;
  avgTradeNetPnl: number;
  avgBarsHeld: number;

  maxDrawdownAmount: number;
  maxDrawdownPct: number;
  /** 일별 수익률 기준 연율화 샤프. 무위험이자율 0 가정. */
  sharpe: number;
  /** 하방편차 기준 연율화 소르티노. */
  sortino: number;

  tradingDays: number;
  winningDays: number;
  losingDays: number;
  /** 청산 사유별 거래 수. 당일청산이 제대로 걸렸는지 확인용. */
  exitReasonCounts: Record<string, number>;
  /** 세션을 넘겨 보유한 거래 수. 당일청산 전략에서는 반드시 0 이어야 한다. */
  overnightTrades: number;

  /**
   * **참여율** (H6) — 최소 1건 이상 거래한 세션 / 전체 세션.
   * 명세 A.4 의 "선택적 참여" 가 실제로 얼마나 선택적인지를 드러낸다.
   * S1 합격선: ≤ 0.60.
   */
  participationRate: number;
  /**
   * **실효 노출** (H6) — 시간가중 평균 노출 비율의 추정치.
   * Σ_거래(진입금액 × 보유봉수) / Σ_봉(총자산). 봉 간격이 균일할 때 정확하다.
   * 합격선: ≤ 0.15. 합성 세션(일봉 어댑터)에서는 봉 수가 인위적이라 해석에 주의.
   */
  effectiveExposure: number;
}

export function computeMetrics(result: BacktestResult): PerformanceMetrics {
  const { trades, daily, initialCapital } = result;
  const finalEquity = result.finalEquity;

  const totalCommission = sum(trades.map((t) => t.commission));
  const totalSlippage = sum(trades.map((t) => t.slippageCost));
  const totalFx = sum(trades.map((t) => t.fxCost));
  const totalCost = totalCommission + totalSlippage + totalFx;

  const netProfit = finalEquity - initialCapital;
  const grossProfit = sum(trades.map((t) => t.grossPnl));

  const wins = trades.filter((t) => t.netPnl > 0);
  const losses = trades.filter((t) => t.netPnl < 0);
  const grossWins = trades.filter((t) => t.grossPnl > 0);

  const grossProfitSum = sum(wins.map((t) => t.netPnl));
  const grossLossSum = Math.abs(sum(losses.map((t) => t.netPnl)));

  const { maxDrawdownAmount, maxDrawdownPct } = computeDrawdown(result);
  const dailyReturns = daily
    .filter((d) => d.startEquity > 0)
    .map((d) => d.endEquity / d.startEquity - 1);

  return {
    initialCapital,
    finalEquity,
    netProfit,
    totalReturnPct: initialCapital > 0 ? (netProfit / initialCapital) * 100 : 0,
    grossProfit,
    grossReturnPct: initialCapital > 0 ? (grossProfit / initialCapital) * 100 : 0,
    costDragPct:
      initialCapital > 0 ? ((grossProfit - netProfit) / initialCapital) * 100 : 0,

    totalCommission,
    totalSlippage,
    totalFx,
    totalCost,

    tradeCount: trades.length,
    winCount: wins.length,
    lossCount: losses.length,
    winRatePct: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    grossWinRatePct: trades.length > 0 ? (grossWins.length / trades.length) * 100 : 0,
    avgWin: wins.length > 0 ? grossProfitSum / wins.length : 0,
    avgLoss: losses.length > 0 ? grossLossSum / losses.length : 0,
    payoffRatio:
      losses.length > 0 && wins.length > 0
        ? grossProfitSum / wins.length / (grossLossSum / losses.length)
        : 0,
    profitFactor: grossLossSum > 0 ? grossProfitSum / grossLossSum : grossProfitSum > 0 ? Infinity : 0,
    avgTradeNetPnl: trades.length > 0 ? sum(trades.map((t) => t.netPnl)) / trades.length : 0,
    avgBarsHeld: trades.length > 0 ? sum(trades.map((t) => t.barsHeld)) / trades.length : 0,

    maxDrawdownAmount,
    maxDrawdownPct,
    sharpe: annualizedSharpe(dailyReturns),
    sortino: annualizedSortino(dailyReturns),

    tradingDays: daily.length,
    winningDays: daily.filter((d) => d.netPnl > 0).length,
    losingDays: daily.filter((d) => d.netPnl < 0).length,
    exitReasonCounts: countBy(trades, (t) => t.exitReason),
    overnightTrades: trades.filter((t) => t.sessionDate !== sessionDateOfExit(t)).length,

    participationRate:
      daily.length > 0 ? daily.filter((d) => d.tradeCount > 0).length / daily.length : 0,
    effectiveExposure: computeEffectiveExposure(result),
  };
}

/**
 * 시간가중 평균 노출 추정치.
 * 분자: Σ_거래 (진입금액 × 보유봉수), 분모: Σ_봉 총자산.
 * `barsHeld` 가 0 인 거래(같은 봉 진입·청산)는 최소 1봉으로 센다.
 */
function computeEffectiveExposure(result: BacktestResult): number {
  const denom = sum(result.equityCurve.map((p) => p.equity));
  if (!(denom > 0)) return 0;
  const numer = sum(
    result.trades.map((t) => t.entryPrice * t.qty * Math.max(1, t.barsHeld))
  );
  return numer / denom;
}

/** 봉 단위 자산곡선 기준 최대낙폭. */
function computeDrawdown(result: BacktestResult): {
  maxDrawdownAmount: number;
  maxDrawdownPct: number;
} {
  let peak = result.initialCapital;
  let maxDdAmount = 0;
  let maxDdPct = 0;
  for (const point of result.equityCurve) {
    if (point.equity > peak) peak = point.equity;
    const dd = peak - point.equity;
    if (dd > maxDdAmount) maxDdAmount = dd;
    const ddPct = peak > 0 ? dd / peak : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }
  return { maxDrawdownAmount: maxDdAmount, maxDrawdownPct: maxDdPct * 100 };
}

function annualizedSharpe(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = sum(dailyReturns) / dailyReturns.length;
  const variance =
    sum(dailyReturns.map((r) => (r - mean) ** 2)) / (dailyReturns.length - 1);
  const sd = Math.sqrt(variance);
  if (sd === 0) return 0;
  return (mean / sd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

function annualizedSortino(dailyReturns: number[]): number {
  if (dailyReturns.length < 2) return 0;
  const mean = sum(dailyReturns) / dailyReturns.length;
  const downside = dailyReturns.filter((r) => r < 0);
  if (downside.length === 0) return mean > 0 ? Infinity : 0;
  const dd = Math.sqrt(sum(downside.map((r) => r ** 2)) / downside.length);
  if (dd === 0) return 0;
  return (mean / dd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/** 청산 시각의 ET 세션 날짜. 당일청산 위반 탐지용. */
function sessionDateOfExit(trade: Trade): string {
  // engine 의 etDateKey 와 동일 규칙. 순환 import 를 피하려고 여기서 직접 계산한다.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(trade.exitTime));
}

function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}

function countBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// ─── 리포트 ───

export interface ReportOptions {
  /** 거래 로그를 몇 건까지 출력할지. 0 이면 생략. 기본 20. */
  maxTradeRows?: number;
  /** 일별 손익을 출력할지. 기본 true. */
  showDaily?: boolean;
  /** 리포트 상단에 붙일 주의문구. 인공 데이터 테스트임을 명시할 때 사용. */
  banner?: string;
}

export function formatReport(
  result: BacktestResult,
  metrics: PerformanceMetrics,
  options: ReportOptions = {}
): string {
  const lines: string[] = [];
  const money = (v: number): string => v.toFixed(2);
  const pct = (v: number): string => `${v.toFixed(2)}%`;

  if (options.banner) {
    lines.push(options.banner, "");
  }

  lines.push("═".repeat(70));
  lines.push(`백테스트 결과 — ${result.strategyName} v${result.strategyVersion}`);
  lines.push("═".repeat(70));
  lines.push(`처리 봉 수        : ${result.barsProcessed}`);
  lines.push(`거래일 수         : ${metrics.tradingDays} (승 ${metrics.winningDays} / 패 ${metrics.losingDays})`);
  lines.push("");
  lines.push("── 수익 (비용 차감 전 / 후) ──");
  lines.push(`초기자본          : ${money(metrics.initialCapital)}`);
  lines.push(`최종자산          : ${money(metrics.finalEquity)}`);
  lines.push(`총손익 (gross)    : ${money(metrics.grossProfit)}  (${pct(metrics.grossReturnPct)})`);
  lines.push(`총손익 (net)      : ${money(metrics.netProfit)}  (${pct(metrics.totalReturnPct)})`);
  lines.push(`비용으로 잃은 폭  : ${pct(metrics.costDragPct)}  ← 이 값이 gross 수익보다 크면 전략은 비용을 못 넘긴다`);
  lines.push("");
  lines.push("── 비용 분해 ──");
  lines.push(`수수료·규제비용   : ${money(metrics.totalCommission)}`);
  lines.push(`슬리피지          : ${money(metrics.totalSlippage)}`);
  lines.push(`환전 스프레드     : ${money(metrics.totalFx)}`);
  lines.push(`합계              : ${money(metrics.totalCost)}`);
  lines.push("");
  lines.push("── 거래 통계 ──");
  lines.push(`거래 수           : ${metrics.tradeCount}`);
  lines.push(`승률 (net)        : ${pct(metrics.winRatePct)}  [gross ${pct(metrics.grossWinRatePct)}]`);
  lines.push(`평균이익 / 평균손실: ${money(metrics.avgWin)} / ${money(metrics.avgLoss)}`);
  lines.push(`손익비 (payoff)   : ${metrics.payoffRatio.toFixed(3)}`);
  lines.push(`Profit Factor     : ${fmtRatio(metrics.profitFactor)}`);
  lines.push(`거래당 평균손익   : ${money(metrics.avgTradeNetPnl)}`);
  lines.push(`평균 보유 봉 수   : ${metrics.avgBarsHeld.toFixed(1)}`);
  lines.push("");
  lines.push("── 리스크 ──");
  lines.push(`MDD               : ${money(metrics.maxDrawdownAmount)}  (${pct(metrics.maxDrawdownPct)})`);
  lines.push(`샤프 (연율화)     : ${metrics.sharpe.toFixed(3)}`);
  lines.push(`소르티노 (연율화) : ${fmtRatio(metrics.sortino)}`);
  lines.push("");
  lines.push("── 청산 사유 ──");
  for (const [reason, count] of Object.entries(metrics.exitReasonCounts).sort()) {
    lines.push(`  ${reason.padEnd(18)}: ${count}`);
  }
  lines.push(`오버나이트 거래   : ${metrics.overnightTrades} (당일청산 전략이면 0 이어야 함)`);
  lines.push("");
  lines.push("── 참여 (H6) ──");
  lines.push(`참여율            : ${(metrics.participationRate * 100).toFixed(1)}%  (S1 합격선 ≤ 60%)`);
  lines.push(`실효 노출(추정)   : ${(metrics.effectiveExposure * 100).toFixed(2)}%  (합격선 ≤ 15%)`);

  if (options.showDaily !== false && result.daily.length > 0) {
    lines.push("");
    lines.push("── 일별 손익 ──");
    lines.push("날짜         시작자산      종료자산      순손익    총손익(gross)   비용   거래수  중단");
    for (const d of result.daily) {
      lines.push(formatDailyRow(d));
    }
  }

  const maxRows = options.maxTradeRows ?? 20;
  if (maxRows > 0 && result.trades.length > 0) {
    lines.push("");
    lines.push(`── 거래 로그 (앞 ${Math.min(maxRows, result.trades.length)}건 / 전체 ${result.trades.length}건) ──`);
    lines.push("종목    방향   수량   진입가    청산가    gross     비용     net       사유");
    for (const t of result.trades.slice(0, maxRows)) {
      lines.push(
        [
          t.symbol.padEnd(7),
          t.direction.padEnd(6),
          String(t.qty).padStart(5),
          t.entryPrice.toFixed(4).padStart(9),
          t.exitPrice.toFixed(4).padStart(9),
          t.grossPnl.toFixed(2).padStart(9),
          (t.commission + t.slippageCost + t.fxCost).toFixed(2).padStart(8),
          t.netPnl.toFixed(2).padStart(9),
          "  " + t.exitReason,
        ].join(" ")
      );
    }
  }

  if (result.warnings.length > 0) {
    lines.push("");
    lines.push(`── 경고 (${result.warnings.length}건, 앞 10건) ──`);
    for (const w of result.warnings.slice(0, 10)) lines.push(`  ${w}`);
  }

  return lines.join("\n");
}

function formatDailyRow(d: DailySummary): string {
  return [
    d.date,
    d.startEquity.toFixed(2).padStart(12),
    d.endEquity.toFixed(2).padStart(12),
    d.netPnl.toFixed(2).padStart(10),
    d.grossPnl.toFixed(2).padStart(13),
    d.cost.toFixed(2).padStart(8),
    String(d.tradeCount).padStart(6),
    d.haltedByLossLimit ? "   중단" : "",
  ].join(" ");
}

function fmtRatio(v: number): string {
  if (!Number.isFinite(v)) return "∞";
  return v.toFixed(3);
}
