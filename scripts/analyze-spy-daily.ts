/**
 * SPY 실제 일봉(2010-01-04 ~ 2019-12-30)의 **인트라데이 / 오버나잇 수익 분해**.
 *
 * 실행:
 *   npx tsx scripts/analyze-spy-daily.ts
 *   npx tsx scripts/analyze-spy-daily.ts --csv data/bars/csv/SPY_daily_2010-2019.csv
 *
 * 이것은 전략 백테스트가 **아니다.** 명세 A.4 / E.1 의 근본 전제
 *   "미국주식 장기수익의 거의 전부는 오버나잇에서 나오고 인트라데이는 0 또는 음수다"
 * 를 실데이터로 직접 검증하는 산술 계산이다.
 *
 * 정의 (수정주가 아님 — data/bars/README.md 참조)
 *   인트라데이 r_intra(D) = close(D) / open(D) − 1
 *   오버나잇  r_over(D)  = open(D)  / close(D−1) − 1
 *   종가-종가 r_cc(D)    = close(D) / close(D−1) − 1        (≈ (1+r_over)(1+r_intra) − 1)
 *
 * ⚠️ 무수정주가이므로 배당(연 1.7~2.0%)이 빠져 있다. 배당락은 **오버나잇 구간**에서
 *    발생하므로 오버나잇·종가종가 수익은 **과소평가**되고, 인트라데이는 영향이 없다.
 */

import { readFileSync } from "fs";
import { parseCsvBars } from "../src/trading/data/csvSource";
import { etDateKey } from "../src/trading/session";
import { COST_SPY, roundTripCostBps } from "../src/trading/costScenarios";
import { optionalString, parseArgs } from "../src/trading/cli";
import { sma, wilderAtr } from "../src/trading/indicators";
import type { Bar } from "../src/trading/types";

const TRADING_DAYS = 252;

// ─── 통계 헬퍼 ───

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}

interface SeriesStats {
  n: number;
  meanBps: number;
  sdBps: number;
  tStat: number;
  /** 양측 p값 근사 (정규분포). */
  pTwoSided: number;
  annualMeanPct: number;
  annualVolPct: number;
  sharpe: number;
  winRatePct: number;
  cumMultiple: number;
  cumTotalPct: number;
  cagrPct: number;
  maxDrawdownPct: number;
}

/** 표준정규 누적분포 (Abramowitz–Stegun 7.1.26 기반 erf 근사). */
function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

function statsOf(returns: number[], years: number): SeriesStats {
  const n = returns.length;
  const m = mean(returns);
  const s = sd(returns);
  const t = (m / (s / Math.sqrt(n))) as number;
  let cum = 1;
  let peak = 1;
  let mdd = 0;
  for (const r of returns) {
    cum *= 1 + r;
    if (cum > peak) peak = cum;
    const dd = 1 - cum / peak;
    if (dd > mdd) mdd = dd;
  }
  return {
    n,
    meanBps: m * 10_000,
    sdBps: s * 10_000,
    tStat: t,
    pTwoSided: 2 * (1 - normCdf(Math.abs(t))),
    annualMeanPct: m * TRADING_DAYS * 100,
    annualVolPct: s * Math.sqrt(TRADING_DAYS) * 100,
    sharpe: (m / s) * Math.sqrt(TRADING_DAYS),
    winRatePct: (returns.filter((r) => r > 0).length / n) * 100,
    cumMultiple: cum,
    cumTotalPct: (cum - 1) * 100,
    cagrPct: (Math.pow(cum, 1 / years) - 1) * 100,
    maxDrawdownPct: mdd * 100,
  };
}

function fmtRow(label: string, s: SeriesStats): string {
  return [
    label.padEnd(24),
    s.n.toString().padStart(5),
    s.meanBps.toFixed(3).padStart(9),
    s.tStat.toFixed(2).padStart(7),
    s.pTwoSided < 0.0005 ? "<0.001".padStart(7) : s.pTwoSided.toFixed(3).padStart(7),
    s.annualMeanPct.toFixed(2).padStart(9),
    s.annualVolPct.toFixed(2).padStart(8),
    s.sharpe.toFixed(3).padStart(7),
    s.winRatePct.toFixed(1).padStart(7),
    s.cumMultiple.toFixed(3).padStart(8),
    s.cagrPct.toFixed(2).padStart(7),
    s.maxDrawdownPct.toFixed(2).padStart(8),
  ].join(" ");
}

const HEADER = [
  "구분".padEnd(22),
  "  n".padStart(5),
  "일평균bp".padStart(9),
  "  t".padStart(7),
  "  p".padStart(7),
  "연율수익%".padStart(9),
  "연율변동%".padStart(8),
  " 샤프".padStart(7),
  " 승률%".padStart(7),
  "누적배수".padStart(8),
  " CAGR%".padStart(7),
  "  MDD%".padStart(8),
].join(" ");

// ─── 일봉 파생값 ───

// ─── 메인 ───

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = optionalString(args, "csv") ?? "data/bars/csv/SPY_daily_2010-2019.csv";
  const bars = parseCsvBars(readFileSync(csvPath, "utf-8"), "SPY", {}).sort((a, b) => a.t - b.t);

  console.log("═".repeat(118));
  console.log("SPY 실제 일봉 — 인트라데이 / 오버나잇 수익 분해");
  console.log("═".repeat(118));
  console.log(`데이터   : ${csvPath}`);
  console.log(`출처     : https://raw.githubusercontent.com/hackingthemarkets/datasets/master/spy.csv`);
  console.log(`기간     : ${etDateKey(bars[0].t)} ~ ${etDateKey(bars[bars.length - 1].t)}  (${bars.length} 거래일)`);
  console.log(`주가유형 : 무수정(unadjusted) — 배당 미반영. 오버나잇/종가종가는 과소평가, 인트라데이는 무편향`);
  console.log("");

  const intraday: number[] = [];
  const overnight: number[] = [];
  const closeToClose: number[] = [];
  const dates: string[] = [];

  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prev = bars[i - 1];
    intraday.push(b.c / b.o - 1);
    overnight.push(b.o / prev.c - 1);
    closeToClose.push(b.c / prev.c - 1);
    dates.push(etDateKey(b.t));
  }

  const years = (bars[bars.length - 1].t - bars[0].t) / (365.2425 * 86_400_000);

  // ── (1) 비용 차감 전 ──
  console.log("── (1) 거래비용 차감 전 (gross) ──");
  console.log(HEADER);
  console.log("─".repeat(118));
  console.log(fmtRow("인트라데이 (시가→종가)", statsOf(intraday, years)));
  console.log(fmtRow("오버나잇 (종가→시가)", statsOf(overnight, years)));
  console.log(fmtRow("종가-종가 (매수후보유)", statsOf(closeToClose, years)));
  console.log("");

  // ── (2) 비용 차감 후 ──
  const rtBps = roundTripCostBps(COST_SPY, mean(bars.map((b) => b.c)));
  const rt = rtBps / 10_000;
  console.log(`── (2) 거래비용 차감 후 (net) — 왕복 ${rtBps.toFixed(2)}bp 를 매 거래일 차감 ──`);
  console.log("   비용 구성: 위탁수수료 편도 0.10%×2 + half-spread 0.5bp×2 + 시장충격 2bp×2 + SEC/TAF");
  console.log("   ※ '매수후보유'는 10년에 왕복 1회뿐이므로 사실상 비용 무시 가능 — 비교 대상이 아님");
  console.log(HEADER);
  console.log("─".repeat(118));
  console.log(fmtRow("인트라데이 net", statsOf(intraday.map((r) => r - rt), years)));
  console.log(fmtRow("오버나잇 net", statsOf(overnight.map((r) => r - rt), years)));
  console.log("");

  // ── (3) 연도별 인트라데이 / 오버나잇 ──
  console.log("── (3) 연도별 수익률 (%) — gross ──");
  const byYear = new Map<string, { intra: number[]; over: number[]; cc: number[] }>();
  for (let i = 0; i < dates.length; i++) {
    const y = dates[i].slice(0, 4);
    const e = byYear.get(y) ?? { intra: [], over: [], cc: [] };
    e.intra.push(intraday[i]);
    e.over.push(overnight[i]);
    e.cc.push(closeToClose[i]);
    byYear.set(y, e);
  }
  const cumPct = (xs: number[]): number => (xs.reduce((a, b) => a * (1 + b), 1) - 1) * 100;
  const cumNetPct = (xs: number[]): number =>
    (xs.reduce((a, b) => a * (1 + b - rt), 1) - 1) * 100;
  console.log(
    "연도    일수   인트라데이   인트라데이(net)   오버나잇   오버나잇(net)   종가-종가"
  );
  for (const [y, e] of [...byYear.entries()].sort()) {
    console.log(
      [
        y,
        String(e.intra.length).padStart(5),
        cumPct(e.intra).toFixed(2).padStart(11),
        cumNetPct(e.intra).toFixed(2).padStart(17),
        cumPct(e.over).toFixed(2).padStart(11),
        cumNetPct(e.over).toFixed(2).padStart(15),
        cumPct(e.cc).toFixed(2).padStart(11),
      ].join(" ")
    );
  }
  console.log("");

  // ── (4) 인트라데이 드리프트의 하위구간 안정성 ──
  console.log("── (4) 인트라데이 드리프트의 구간 안정성 (전반 50% vs 후반 50%) ──");
  const half = Math.floor(intraday.length / 2);
  const firstHalf = intraday.slice(0, half);
  const secondHalf = intraday.slice(half);
  console.log(HEADER);
  console.log("─".repeat(118));
  console.log(fmtRow(`전반 ${dates[0]}~${dates[half - 1]}`, statsOf(firstHalf, years / 2)));
  console.log(
    fmtRow(`후반 ${dates[half]}~${dates[dates.length - 1]}`, statsOf(secondHalf, years / 2))
  );
  console.log("");

  // ── (5) S3 일봉 프록시의 표본 규모 사전 점검 ──
  console.log("── (5) S3 일봉 프록시 조건 충족일 수 (갭다운 > k×ATR14 & 전일종가 > SMA100) ──");
  const atr = wilderAtr(bars, 14);
  const smaClose = sma(
    bars.map((b) => b.c),
    100
  );
  for (const k of [0.8, 1.0, 1.2, 1.5]) {
    let hits = 0;
    let hitsNoSma = 0;
    for (let i = 1; i < bars.length; i++) {
      const a = atr[i - 1];
      const s = smaClose[i - 1];
      const pc = bars[i - 1].c;
      if (a === null || !(a > 0)) continue;
      const gapAtr = (bars[i].o - pc) / a;
      if (gapAtr < -k) {
        hitsNoSma += 1;
        if (s !== null && pc > s) hits += 1;
      }
    }
    console.log(
      `  GAP_MULT=${k.toFixed(1)} : SMA100 필터 적용 ${String(hits).padStart(3)}일` +
        ` / 미적용 ${String(hitsNoSma).padStart(3)}일  (전체 ${bars.length - 1}일 중)`
    );
  }
  console.log("");
  console.log("※ 명세 D.4 의 최소 표본 규칙은 '전략별 최소 100 트레이드'다. 위 표본이 100 미만이면");
  console.log("   해당 파라미터의 판정은 **결론 유보**이며 합격도 불합격도 아니다.");
  console.log("");

  // ── (6) 선택적 참여가 넘어야 할 문턱 — 조건부 부분집합 탐색 ──
  console.log("── (6) 명세 A.4 의 검증: '조건부 부분집합에 양의 기대값' 이 비용을 넘는가 ──");
  console.log(`   참여한 날의 인트라데이 평균이 왕복비용 ${rtBps.toFixed(1)}bp 를 넘지 못하면`);
  console.log(`   그 전략은 참여율이 얼마든 반드시 손실이다. 무조건 참여 시 평균은 ${(mean(intraday) * 10_000).toFixed(2)}bp 다.`);
  console.log("");
  console.log("   ⚠️ 아래는 **탐색적(exploratory) 계산**이며 전략이 아니다. 다중검정 보정을 하지 않았고,");
  console.log("      명세 D.5.1 의 파라미터 탐색 범위 밖이므로 어떤 것도 채택 대상이 아니다.");
  console.log("");
  const conditions: Array<[string, (i: number) => boolean]> = [
    ["오버나잇 갭 > 0", (i) => overnight[i] > 0],
    ["오버나잇 갭 < 0", (i) => overnight[i] < 0],
    ["오버나잇 갭 > +0.5%", (i) => overnight[i] > 0.005],
    ["오버나잇 갭 < −0.5%", (i) => overnight[i] < -0.005],
    ["전일 종가-종가 > 0", (i) => i > 0 && closeToClose[i - 1] > 0],
    ["전일 종가-종가 < 0", (i) => i > 0 && closeToClose[i - 1] < 0],
    ["전일 인트라데이 > 0", (i) => i > 0 && intraday[i - 1] > 0],
    ["전일 인트라데이 < 0", (i) => i > 0 && intraday[i - 1] < 0],
  ];
  console.log(
    "조건".padEnd(24) +
      "참여일".padStart(7) +
      "참여율%".padStart(8) +
      "인트라데이평균bp".padStart(17) +
      "  t".padStart(7) +
      "비용초과?".padStart(11)
  );
  console.log("─".repeat(80));
  for (const [label, pred] of conditions) {
    const subset: number[] = [];
    for (let i = 0; i < intraday.length; i++) if (pred(i)) subset.push(intraday[i]);
    const s = statsOf(subset, years);
    console.log(
      label.padEnd(24) +
        String(subset.length).padStart(7) +
        ((subset.length / intraday.length) * 100).toFixed(1).padStart(8) +
        s.meanBps.toFixed(2).padStart(17) +
        s.tStat.toFixed(2).padStart(7) +
        (s.meanBps > rtBps ? "예" : "아니오").padStart(11)
    );
  }
  console.log("");
  console.log(`   → 어떤 조건도 ${rtBps.toFixed(1)}bp 문턱을 넘지 못하면, 일봉 관측치만으로 만든 선택적 참여는`);
  console.log("     비용을 이길 수 없다는 뜻이다. S1/S2/S3 의 엣지는 **분봉 구조에만 존재**해야 한다.");
  console.log("═".repeat(118));
}

main();
