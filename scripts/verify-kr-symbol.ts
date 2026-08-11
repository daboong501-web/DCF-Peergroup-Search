/**
 * 국내 단일종목(기본 229200 KODEX 코스닥150) PoC 실측 스크립트.
 *
 *   npx tsx scripts/verify-kr-symbol.ts
 *   npx tsx scripts/verify-kr-symbol.ts --symbol 251340
 *
 * 읽기 전용 — 주문을 내지 않는다.
 *
 * `05-kosdaq150-etf-spec.md` §7.3 의 K1~K5 를 실제 값으로 채우는 것이 목적이다.
 * 이 값들이 확정되기 전에는 전략을 고를 근거가 없다.
 *
 *   K1. 1분봉에 장전 동시호가(08:30~09:00) 봉이 섞이는가
 *   K2. 15:20~15:30 종가 단일가 구간의 봉이 어떻게 나오는가
 *   K3. 실제 호가 스프레드가 몇 틱인가
 *   K4. LP 호가 두께
 *   K5. 종목 메타 검증 (ETF 인가, 레버리지 1배인가, 거래정지 아닌가)
 */

import "dotenv/config";
import { TossClient, TossApiError } from "../src/services/toss/client.js";
import { krEtfCostParams, roundTripCostBps } from "../src/trading/krCosts.js";
import { kstTimeLabel, kstDateKey } from "../src/trading/krSession.js";
import type { Candle } from "../src/services/toss/types.js";

const argv = process.argv.slice(2);
const symbolArg = argv.indexOf("--symbol");
const SYMBOL = symbolArg >= 0 ? argv[symbolArg + 1] : "229200";

function fail(step: string, err: unknown): void {
  const msg =
    err instanceof TossApiError
      ? `${err.status} ${err.code}: ${err.message}`
      : err instanceof Error
        ? err.message
        : String(err);
  console.log(`❌ ${step} — ${msg}`);
}

/** KST 시:분을 분 단위 정수로. */
function kstMinutes(iso: string): number {
  const [h, m] = kstTimeLabel(new Date(iso).getTime()).split(":").map(Number);
  return h * 60 + m;
}

async function main(): Promise<void> {
  console.log("═".repeat(76));
  console.log(`국내 종목 PoC 실측 — ${SYMBOL} (읽기 전용, 주문 없음)`);
  console.log("═".repeat(76));

  const client = new TossClient();

  // ── K5. 종목 메타 검증 ──
  let lastPrice = 0;
  try {
    const [info] = await client.getStocks([SYMBOL]);
    console.log(`\n[K5] 종목 메타`);
    console.log(`  name=${info.name} / market=${info.market} / securityType=${info.securityType}`);
    console.log(`  leverageFactor=${info.leverageFactor ?? "null"} / status=${info.status}`);
    const kr = info.koreanMarketDetail as
      | { krxTradingSuspended?: boolean; liquidationTrading?: boolean; nxtSupported?: boolean }
      | null
      | undefined;
    if (kr) {
      console.log(
        `  거래정지=${kr.krxTradingSuspended} / 정리매매=${kr.liquidationTrading} / NXT지원=${kr.nxtSupported}`
      );
    }
    if (info.securityType !== "ETF") {
      console.log(`  ⚠️  securityType 이 ETF 가 아닙니다 — 봇 시작 검증에서 중단 대상입니다.`);
    }
    if (info.leverageFactor && Number(info.leverageFactor) !== 1) {
      console.log(
        `  ⚠️  레버리지 ${info.leverageFactor} 배입니다. 229200(1배)과 위험이 전혀 다릅니다.`
      );
    }
  } catch (err) {
    fail("[K5] 종목 메타", err);
  }

  // ── 현재가 + 비용 산출 ──
  try {
    const [p] = await client.getPrices([SYMBOL]);
    lastPrice = Number(p.lastPrice);
    // 호가 단위는 가격대에서 동적으로 결정된다 (ETF: 2,000원 미만 1원 / 이상 5원)
    const tickSize = lastPrice < 2000 ? 1 : 5;
    const params = krEtfCostParams({ referencePrice: lastPrice, tickSize });
    console.log(`\n[비용] 현재가 ${lastPrice.toLocaleString()}원 / 호가단위 ${tickSize}원`);
    console.log(
      `  1틱 = ${((tickSize / lastPrice) * 10_000).toFixed(2)}bps → 왕복비용 ${roundTripCostBps(params).toFixed(2)}bps (스프레드 1틱 가정)`
    );
    console.log(`  ⇒ 거래당 기대수익이 이 값을 넘지 못하면 그 전략은 폐기 대상입니다.`);
  } catch (err) {
    fail("[비용] 현재가", err);
  }

  // ── K3/K4. 호가 스프레드·LP 두께 실측 ──
  try {
    const ob = await client.getOrderbook(SYMBOL);
    const bestAsk = Number(ob.asks[0]?.price);
    const bestBid = Number(ob.bids[0]?.price);
    console.log(`\n[K3/K4] 호가 (${ob.timestamp ?? "시각없음"})`);
    if (Number.isFinite(bestAsk) && Number.isFinite(bestBid) && bestBid > 0) {
      const tickSize = bestBid < 2000 ? 1 : 5;
      const spread = bestAsk - bestBid;
      const ticks = spread / tickSize;
      const spreadBps = (spread / ((bestAsk + bestBid) / 2)) * 10_000;
      console.log(
        `  최우선 매수 ${bestBid.toLocaleString()} / 매도 ${bestAsk.toLocaleString()} → 스프레드 ${spread}원 = ${ticks}틱 (${spreadBps.toFixed(2)}bps)`
      );
      console.log(
        ticks <= 1
          ? `  ✅ 1틱 — krCosts.ts 의 spreadTicks=1 가정이 이 시점에는 맞습니다.`
          : `  ⚠️ ${ticks}틱 — 비용 가정을 spreadTicks=${Math.ceil(ticks)} 로 올려서 백테스트하세요.`
      );
      // LP 두께: 최우선 호가 잔량
      const askVol = Number(ob.asks[0]?.volume ?? 0);
      const bidVol = Number(ob.bids[0]?.volume ?? 0);
      console.log(
        `  최우선 잔량: 매수 ${bidVol.toLocaleString()}주 / 매도 ${askVol.toLocaleString()}주` +
          ` (주문수량이 이보다 크면 다음 호가로 밀립니다)`
      );
    } else {
      console.log(`  호가가 비어 있습니다 (장 시간 외일 수 있음): ${JSON.stringify(ob).slice(0, 300)}`);
    }
    console.log(`  ⚠️ 한 번의 스냅샷입니다. 시간대별로 여러 번 재실행해 분포를 보세요.`);
  } catch (err) {
    fail("[K3/K4] 호가", err);
  }

  // ── K1/K2. 1분봉 시간대 분포 ──
  try {
    const page = await client.getCandles({ symbol: SYMBOL, interval: "1m", count: 200 });
    const candles: Candle[] = page.candles ?? [];
    if (candles.length === 0) {
      console.log(`\n[K1/K2] 1분봉 0건 — 휴장일이거나 데이터가 없습니다.`);
    } else {
      const sorted = [...candles].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      console.log(`\n[K1/K2] 1분봉 ${sorted.length}건`);
      console.log(
        `  범위: ${kstDateKey(new Date(first.timestamp).getTime())} ${kstTimeLabel(new Date(first.timestamp).getTime())}` +
          ` ~ ${kstTimeLabel(new Date(last.timestamp).getTime())}`
      );

      const preOpen = sorted.filter((c) => kstMinutes(c.timestamp) < 9 * 60);
      const auction = sorted.filter((c) => {
        const m = kstMinutes(c.timestamp);
        return m >= 15 * 60 + 20 && m < 15 * 60 + 30;
      });
      const afterClose = sorted.filter((c) => kstMinutes(c.timestamp) >= 15 * 60 + 30);

      console.log(
        `  K1 장전(09:00 이전) 봉: ${preOpen.length}건` +
          (preOpen.length
            ? ` → ⚠️ 동시호가 봉이 섞입니다. 시가·갭 계산에서 반드시 제외하세요.`
            : ` → 정규장만 제공되는 것으로 보입니다.`)
      );
      console.log(
        `  K2 종가단일가(15:20~15:30) 봉: ${auction.length}건` +
          (auction.length
            ? ` (거래량>0: ${auction.filter((c) => Number(c.volume) > 0).length}건)`
            : "")
      );
      console.log(
        `  15:30 이후 봉: ${afterClose.length}건` +
          (afterClose.length ? ` → ⚠️ NXT 시간외가 섞일 수 있습니다.` : "")
      );

      // 봉 간격 결측
      let gaps = 0;
      for (let i = 1; i < sorted.length; i += 1) {
        const d =
          (new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()) /
          60_000;
        if (d > 1.5) gaps += 1;
      }
      console.log(`  결측 구간: ${gaps}곳 / nextBefore=${page.nextBefore ?? "null"}`);
      console.log(
        `  정렬: ${new Date(candles[0].timestamp) < new Date(candles[candles.length - 1].timestamp) ? "오름차순" : "내림차순"}`
      );
    }
  } catch (err) {
    fail("[K1/K2] 1분봉", err);
  }

  // ── 장 운영 캘린더 ──
  try {
    const cal = await client.getKrMarketCalendar();
    console.log(`\n[캘린더] KR — 통합(KRX+NXT) 기준이라 정규장 마감 판정에 그대로 쓰지 말 것`);
    for (const [label, day] of [
      ["전영업일", cal.previousBusinessDay],
      ["당일", cal.today],
      ["익영업일", cal.nextBusinessDay],
    ] as const) {
      const ih = day.integrated;
      if (!ih) {
        console.log(`  ${label} ${day.date}: 휴장`);
        continue;
      }
      const fmt = (s?: { startTime: string; endTime: string } | null) =>
        s ? `${kstTimeLabel(new Date(s.startTime).getTime())}~${kstTimeLabel(new Date(s.endTime).getTime())}` : "없음";
      console.log(
        `  ${label} ${day.date}: pre=${fmt(ih.preMarket)} regular=${fmt(ih.regularMarket)} after=${fmt(ih.afterMarket)}`
      );
    }
    console.log(`  ⇒ 당일청산 기준은 KRX 정규장 15:30 으로 고정하고, 위 값은 휴장일 판정에만 쓰세요.`);
  } catch (err) {
    fail("[캘린더] KR", err);
  }

  console.log("\n" + "═".repeat(76));
  console.log("이 결과를 docs/auto-trading/05-kosdaq150-etf-spec.md §7.3 표에 채워 넣으세요.");
  console.log("특히 K6(인트라데이 드리프트 유의성)는 분봉을 모은 뒤 별도 분석이 필요합니다:");
  console.log(`  npx tsx scripts/fetch-bars.ts --symbols ${SYMBOL} --interval 1m --days 7`);
  console.log("═".repeat(76));
}

main().catch((err) => {
  console.error("예상치 못한 오류:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
