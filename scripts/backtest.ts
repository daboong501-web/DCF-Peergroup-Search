/**
 * 캐시된(또는 CSV) 1분봉으로 백테스트를 돌리고 성과 리포트를 출력한다.
 *
 * 사용법:
 *   npx tsx scripts/backtest.ts --strategy noop --symbols AAPL --from 2026-01-02 --to 2026-01-31 --capital 10000
 *
 * 옵션:
 *   --strategy   등록된 전략 이름 (필수). 목록은 --list 로 확인.
 *   --symbols    쉼표구분 티커 (필수)
 *   --from/--to  YYYY-MM-DD, 미국 동부시각 기준, 양끝 포함 (필수)
 *   --capital    초기자본 (기본 10000)
 *   --interval   1m | 1d (기본 1m)
 *   --params     전략 파라미터 JSON (예: '{"lookback":20}')
 *   --source     cache | csv (기본 cache)
 *   --csv-path   --source csv 일 때 CSV 파일/디렉터리 경로
 *   --commission / --spread-bps / --impact-bps / --fx-bps  비용 파라미터 덮어쓰기
 *   --no-fx      환전 스프레드 비용 끄기
 *   --max-position-pct / --max-positions / --daily-loss-pct / --exit-before-close
 *   --dry-run    데이터 가용성과 설정만 점검하고 엔진은 돌리지 않는다
 *   --list       등록된 전략 목록 출력 후 종료
 */

import { runBacktest, type EngineConfig } from "../src/trading/engine";
import { computeMetrics, formatReport } from "../src/trading/metrics";
import { registerBuiltinStrategies, strategyRegistry } from "../src/trading/strategies";
import {
  flag,
  loadDotEnv,
  optionalNumber,
  optionalString,
  parseArgs,
  parseDateRange,
  parseSymbols,
  requireString,
} from "../src/trading/cli";
import { CachedBarSource } from "../src/trading/data/cache";
import { CsvBarSource } from "../src/trading/data/csvSource";
import { getBarsForSymbols, validateBars, type BarSource } from "../src/trading/data/source";
import type { BarInterval } from "../src/trading/types";

async function main(): Promise<void> {
  loadDotEnv();
  registerBuiltinStrategies();
  const args = parseArgs(process.argv.slice(2));

  if (flag(args, "list")) {
    console.log("등록된 전략:");
    for (const name of strategyRegistry.list()) console.log(`  - ${name}`);
    return;
  }

  const strategyName = requireString(args, "strategy");
  const symbols = parseSymbols(requireString(args, "symbols"));
  const { fromMs, toMs } = parseDateRange(requireString(args, "from"), requireString(args, "to"));
  const interval = (optionalString(args, "interval") ?? "1m") as BarInterval;
  const capital = optionalNumber(args, "capital") ?? 10_000;

  const rawParams = optionalString(args, "params");
  const params = rawParams ? (JSON.parse(rawParams) as Record<string, unknown>) : {};

  const sourceKind = optionalString(args, "source") ?? "cache";
  const source: BarSource =
    sourceKind === "csv"
      ? new CsvBarSource({ path: requireString(args, "csv-path") })
      : new CachedBarSource();

  console.log("─".repeat(66));
  console.log(`전략     : ${strategyName}`);
  console.log(`종목     : ${symbols.join(", ")}`);
  console.log(`기간     : ${optionalString(args, "from")} ~ ${optionalString(args, "to")} (ET)`);
  console.log(`초기자본 : ${capital}`);
  console.log(`데이터   : ${source.name}`);
  console.log("─".repeat(66));

  const barsBySymbol = await getBarsForSymbols(source, symbols, interval, fromMs, toMs);

  let totalBars = 0;
  let hasData = true;
  for (const [symbol, bars] of barsBySymbol) {
    totalBars += bars.length;
    if (bars.length === 0) {
      hasData = false;
      console.warn(
        `[${symbol}] 봉 데이터가 없습니다. 먼저 다음을 실행하세요:\n` +
          `  npx tsx scripts/fetch-bars.ts --symbols ${symbol} --from ${optionalString(args, "from")} --to ${optionalString(args, "to")}`
      );
      continue;
    }
    const problems = validateBars(bars, symbol);
    if (problems.length > 0) {
      console.warn(`[${symbol}] 데이터 정합성 경고 ${problems.length}건 (앞 3건):`);
      for (const p of problems.slice(0, 3)) console.warn(`   ${p}`);
    }
    console.log(
      `[${symbol}] ${bars.length}봉 (${new Date(bars[0].t).toISOString()} ~ ${new Date(bars[bars.length - 1].t).toISOString()})`
    );
  }

  const strategy = strategyRegistry.create(strategyName, params);

  const config: EngineConfig = {
    initialCapital: capital,
    interval,
    params,
    mode: "backtest",
    cost: {
      ...(optionalNumber(args, "commission") !== undefined
        ? { commissionRate: optionalNumber(args, "commission") }
        : {}),
      ...(optionalNumber(args, "spread-bps") !== undefined
        ? { spreadBps: optionalNumber(args, "spread-bps") }
        : {}),
      ...(optionalNumber(args, "impact-bps") !== undefined
        ? { marketImpactBps: optionalNumber(args, "impact-bps") }
        : {}),
      ...(optionalNumber(args, "fx-bps") !== undefined
        ? { fxSpreadBps: optionalNumber(args, "fx-bps") }
        : {}),
      ...(flag(args, "no-fx") ? { applyFx: false } : {}),
    },
    risk: {
      ...(optionalNumber(args, "max-position-pct") !== undefined
        ? { maxPositionPct: optionalNumber(args, "max-position-pct") }
        : {}),
      ...(optionalNumber(args, "max-positions") !== undefined
        ? { maxConcurrentPositions: optionalNumber(args, "max-positions") }
        : {}),
      ...(optionalNumber(args, "daily-loss-pct") !== undefined
        ? { dailyLossLimitPct: optionalNumber(args, "daily-loss-pct") }
        : {}),
      ...(optionalNumber(args, "exit-before-close") !== undefined
        ? { exitBeforeCloseMinutes: optionalNumber(args, "exit-before-close") }
        : {}),
    },
  };

  if (flag(args, "dry-run")) {
    console.log("\n[--dry-run] 설정 점검만 수행했습니다. 엔진은 실행하지 않았습니다.");
    console.log(`  전략 인스턴스 : ${strategy.name} v${strategy.version}`);
    console.log(`  총 봉 수      : ${totalBars}`);
    console.log(`  데이터 준비   : ${hasData && totalBars > 0 ? "OK" : "부족"}`);
    console.log(`  비용 설정     : ${JSON.stringify(config.cost)}`);
    console.log(`  리스크 설정   : ${JSON.stringify(config.risk)}`);
    return;
  }

  if (totalBars === 0) {
    throw new Error("NO_DATA: 봉 데이터가 없어 백테스트를 실행할 수 없습니다.");
  }

  const result = runBacktest(strategy, barsBySymbol, config);
  const metrics = computeMetrics(result);
  console.log("");
  console.log(formatReport(result, metrics));
}

main().catch((err: unknown) => {
  console.error(`\n실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
