/**
 * 토스 Open API 로 1분봉(또는 일봉)을 받아 `data/bars/` 캐시에 저장한다.
 *
 * 사용법:
 *   TOSS_CLIENT_ID=... TOSS_CLIENT_SECRET=... \
 *   npx tsx scripts/fetch-bars.ts --symbols AAPL,MSFT --from 2026-01-02 --to 2026-01-31
 *
 * 옵션:
 *   --symbols   쉼표구분 티커 (필수)
 *   --from      시작일 YYYY-MM-DD, 미국 동부시각 기준 (필수)
 *   --to        종료일 YYYY-MM-DD, 포함 (필수)
 *   --interval  1m | 1d (기본 1m)
 *   --adjusted  true | false (기본 true — 스펙 기본값과 동일)
 *   --force     캐시가 있어도 다시 받는다
 *   --dry-run   실제 호출 없이 계획(요청 수·예상 소요시간)만 출력
 *
 * 레이트리밋: 캔들은 MARKET_DATA_CHART 그룹(초당 5회)이며 TossClient 가 자동으로 지킨다.
 */

import { TossClient } from "../src/services/toss/client";
import { MAX_CANDLES_PER_REQUEST } from "../src/services/toss/candles";
import {
  flag,
  loadDotEnv,
  optionalString,
  parseArgs,
  parseDateRange,
  parseSymbols,
  requireString,
} from "../src/trading/cli";
import { CachedBarSource, writeCachedBars } from "../src/trading/data/cache";
import { validateBars } from "../src/trading/data/source";
import { TossBarSource } from "../src/trading/data/tossSource";
import type { BarInterval } from "../src/trading/types";

async function main(): Promise<void> {
  loadDotEnv();
  const args = parseArgs(process.argv.slice(2));
  const symbols = parseSymbols(requireString(args, "symbols"));
  const { fromMs, toMs } = parseDateRange(requireString(args, "from"), requireString(args, "to"));
  const interval = (optionalString(args, "interval") ?? "1m") as BarInterval;
  if (interval !== "1m" && interval !== "1d") {
    throw new Error("ARG_INVALID: --interval 은 1m 또는 1d 만 지원합니다 (토스 스펙 제약).");
  }
  const adjustedRaw = optionalString(args, "adjusted");
  const adjusted = adjustedRaw === undefined ? undefined : adjustedRaw !== "false";
  const dryRun = flag(args, "dry-run");
  const force = flag(args, "force");

  const cache = new CachedBarSource();
  const rangeDays = Math.ceil((toMs - fromMs) / 86_400_000);

  console.log("─".repeat(66));
  console.log(`봉 수집 계획: ${symbols.join(", ")}`);
  console.log(`기간        : ${optionalString(args, "from")} ~ ${optionalString(args, "to")} (ET, ${rangeDays}일)`);
  console.log(`봉 단위     : ${interval} / 수정주가: ${adjusted ?? "기본(true)"}`);
  console.log("─".repeat(66));

  for (const symbol of symbols) {
    const missing = force ? null : cache.missingDates(symbol, interval, fromMs, toMs);
    if (missing && missing.length === 0) {
      console.log(`[${symbol}] 캐시 완비 — 건너뜁니다 (--force 로 강제 재수집 가능)`);
      continue;
    }
    // 정규장 1분봉은 하루 390봉 → 200봉/요청 기준 대략적인 요청 수를 미리 알려준다.
    const barsPerDay = interval === "1m" ? 390 : 1;
    const estimatedBars = (missing?.length ?? rangeDays) * barsPerDay;
    const estimatedCalls = Math.ceil(estimatedBars / MAX_CANDLES_PER_REQUEST);
    console.log(
      `[${symbol}] 미수집 세션일 ${missing?.length ?? rangeDays}일 → 예상 봉 ${estimatedBars}개, ` +
        `예상 요청 ${estimatedCalls}회 (초당 5회 제한 → 최소 ${(estimatedCalls / 5).toFixed(1)}초)`
    );
  }

  if (dryRun) {
    console.log("\n[--dry-run] 실제 API 호출 없이 계획만 출력했습니다.");
    return;
  }

  const client = new TossClient();
  const source = new TossBarSource(client, { onProgress: (m) => console.log(m) });

  for (const symbol of symbols) {
    console.log(`\n[${symbol}] 수집 시작...`);
    const bars = await source.getBars({ symbol, interval, fromMs, toMs, adjusted });
    if (bars.length === 0) {
      console.log(`[${symbol}] 받은 봉이 없습니다 (휴장 구간이거나 상장 전일 수 있습니다).`);
      continue;
    }
    const problems = validateBars(bars, symbol);
    if (problems.length > 0) {
      console.warn(`[${symbol}] 데이터 정합성 경고 ${problems.length}건 (앞 5건):`);
      for (const p of problems.slice(0, 5)) console.warn(`   ${p}`);
    }
    const written = writeCachedBars(symbol, interval, bars, { source: "toss", adjusted });
    console.log(
      `[${symbol}] ${bars.length}봉 저장 완료 → ${written.length}개 파일 ` +
        `(${new Date(bars[0].t).toISOString()} ~ ${new Date(bars[bars.length - 1].t).toISOString()})`
    );
  }
}

main().catch((err: unknown) => {
  console.error(`\n실패: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
