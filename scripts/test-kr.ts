/**
 * 국내(KRX) 세션·비용 모듈 검증.
 *
 *   npx tsx scripts/test-kr.ts
 *
 * 전부 손으로 계산 가능한 고정 입력이다. 시장 데이터가 아니며 성과와 무관하다.
 */

import {
  KrRegularSessionCalendar,
  kstWallClockToUtcMs,
  kstDateKey,
  kstTimeLabel,
  isContinuousTrading,
  minutesFromOpen,
} from "../src/trading/krSession.js";
import { krEtfCostParams, roundTripCostBps, KODEX_KOSDAQ150_TICK_SIZE } from "../src/trading/krCosts.js";
import { computeFillCost, roundToTick, costParamsFromCommissionRate } from "../src/trading/costs.js";

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

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) <= tol;
}

console.log("═".repeat(74));
console.log("국내(KRX) 세션·비용 모듈 검증 — 인공 입력, 시장 성과와 무관");
console.log("═".repeat(74));

// ── A. KST 시각 변환 (서머타임 없음) ──
console.log("\n[A] KST 시각 변환");
{
  const ms = kstWallClockToUtcMs(2026, 8, 11, 9, 0);
  check("KST 09:00 → 날짜키 2026-08-11", kstDateKey(ms) === "2026-08-11", kstDateKey(ms));
  check("KST 09:00 → 라벨 09:00", kstTimeLabel(ms) === "09:00", kstTimeLabel(ms));
  // 서머타임이 없으므로 1월과 8월의 오프셋이 같아야 한다.
  const jan = kstWallClockToUtcMs(2026, 1, 15, 9, 0);
  const aug = kstWallClockToUtcMs(2026, 8, 15, 9, 0);
  const janUtcHour = new Date(jan).getUTCHours();
  const augUtcHour = new Date(aug).getUTCHours();
  check(
    "서머타임 없음 — 1월/8월 09:00 KST 의 UTC 시가 동일 (00시)",
    janUtcHour === 0 && augUtcHour === 0,
    `jan=${janUtcHour} aug=${augUtcHour}`
  );
}

// ── B. 세션 구성 ──
console.log("\n[B] 정규장 세션");
{
  const cal = new KrRegularSessionCalendar(); // 기본 exitBeforeCloseMinutes=15
  const s = cal.sessionFor(kstWallClockToUtcMs(2026, 8, 11, 10, 0));
  check("화요일은 개장", s !== null);
  if (s) {
    check("개장 09:00", kstTimeLabel(s.openMs) === "09:00", kstTimeLabel(s.openMs));
    check("마감 15:30", kstTimeLabel(s.closeMs) === "15:30", kstTimeLabel(s.closeMs));
    check(
      "강제청산 15:15 (단일가 시작 15:20 보다 5분 앞)",
      kstTimeLabel(s.forceExitMs) === "15:15",
      kstTimeLabel(s.forceExitMs)
    );
    check("정규장 길이 390분", (s.closeMs - s.openMs) / 60_000 === 390);
    check(
      "장 시작 30분 경과 계산",
      minutesFromOpen(kstWallClockToUtcMs(2026, 8, 11, 9, 30), s) === 30
    );
  }
  check("토요일은 휴장", cal.sessionFor(kstWallClockToUtcMs(2026, 8, 15, 10, 0)) === null);
  check("일요일은 휴장", cal.sessionFor(kstWallClockToUtcMs(2026, 8, 16, 10, 0)) === null);

  const withHoliday = new KrRegularSessionCalendar({ holidays: ["2026-08-17"] });
  check(
    "지정 휴장일은 세션 없음",
    withHoliday.sessionFor(kstWallClockToUtcMs(2026, 8, 17, 10, 0)) === null
  );
}

// ── C. 단일가 구간 판정 ──
console.log("\n[C] 접속매매 / 종가 단일가 구분");
{
  const cal = new KrRegularSessionCalendar();
  const s = cal.sessionFor(kstWallClockToUtcMs(2026, 8, 11, 10, 0))!;
  const at = (h: number, m: number) => kstWallClockToUtcMs(2026, 8, 11, h, m);
  check("09:00 접속매매", isContinuousTrading(at(9, 0), s));
  check("15:19 접속매매", isContinuousTrading(at(15, 19), s));
  check("15:20 단일가 — 접속매매 아님", !isContinuousTrading(at(15, 20), s));
  check("15:25 단일가 — 접속매매 아님", !isContinuousTrading(at(15, 25), s));
  check("08:59 장전 — 접속매매 아님", !isContinuousTrading(at(8, 59), s));
  check(
    "강제청산 시각(15:15)은 접속매매 안에 있다 — 청산 가능",
    isContinuousTrading(s.forceExitMs, s)
  );
}

// ── D. 단일가 청산 불가 방어 ──
console.log("\n[D] 잘못된 청산 시각 방어");
{
  let threw = false;
  try {
    new KrRegularSessionCalendar({ exitBeforeCloseMinutes: 5 }); // 15:25 → 단일가 구간
  } catch {
    threw = true;
  }
  check("exitBeforeCloseMinutes=5 (15:25, 단일가 구간) 은 생성 자체를 거부", threw);
  check(
    "exitBeforeCloseMinutes=10 (15:20 경계) 는 허용",
    new KrRegularSessionCalendar({ exitBeforeCloseMinutes: 10 }) !== null
  );
}

// ── E. 호가 단위 반올림 (항상 불리한 방향) ──
console.log("\n[E] 호가 단위 반올림");
{
  check("매수 14,781 → 14,785 (올림)", roundToTick(14781, 5, "BUY") === 14785);
  check("매도 14,779 → 14,775 (내림)", roundToTick(14779, 5, "SELL") === 14775);
  check("매수 14,780 → 14,780 (이미 틱 배수, 안 밀림)", roundToTick(14780, 5, "BUY") === 14780);
  check("매도 14,780 → 14,780 (이미 틱 배수, 안 밀림)", roundToTick(14780, 5, "SELL") === 14780);
  check("2,000원 미만 1원 틱: 매수 1,234.2 → 1,235", roundToTick(1234.2, 1, "BUY") === 1235);
}

// ── F. 229200 비용 모델 ──
console.log("\n[F] KODEX 코스닥150 (229200) 비용");
{
  const REF = 14780; // 2026-08-11 네이버 실측 현재가
  const p = krEtfCostParams({ referencePrice: REF });

  const tickBps = (KODEX_KOSDAQ150_TICK_SIZE / REF) * 10_000;
  check("호가단위 5원 = 3.383bps", near(tickBps, 3.3829499, 1e-5), tickBps.toFixed(5));
  check("스프레드 = 1틱", near(p.spreadBps, tickBps, 1e-9));
  check("증권거래세 0 (ETF 면제)", (p.sellTaxRate ?? 0) === 0);
  check("환전비용 미적용", p.applyFx === false && p.fxSpreadBps === 0);
  check("미국 전용 수수료 0", p.secFeeRate === 0 && p.tafPerShare === 0);
  check("호가단위 5원 설정됨", p.tickSize === 5);

  const rt = roundTripCostBps(p);
  // half-spread(1.6915) × 2 + 수수료(1.5) × 2 = 3.3829 + 3.0 = 6.3829
  check("왕복비용 = 6.383bps", near(rt, 6.3829499, 1e-4), rt.toFixed(4));

  // 매수/매도 체결과 비용
  const buy = computeFillCost(p, { side: "BUY", refPrice: REF, qty: 100, orderType: "MARKET" });
  const sell = computeFillCost(p, { side: "SELL", refPrice: REF, qty: 100, orderType: "MARKET" });
  check(
    "매수 체결가는 호가단위 배수이고 기준가 이상",
    buy.fillPrice % 5 === 0 && buy.fillPrice >= REF,
    String(buy.fillPrice)
  );
  check(
    "매도 체결가는 호가단위 배수이고 기준가 이하",
    sell.fillPrice % 5 === 0 && sell.fillPrice <= REF,
    String(sell.fillPrice)
  );
  check("매도에 SEC/TAF/거래세 없음 → 수수료는 순수 위탁수수료",
    near(sell.commission, sell.fillPrice * 100 * 0.00015, 1e-9),
    sell.commission.toFixed(4)
  );

  // 일반 국내주식(거래세 있는 경우)과의 대조 — ETF 면제 효과 확인
  const stockLike = krEtfCostParams({ referencePrice: REF, sellTaxRate: 0.0018 });
  check(
    "거래세 0.18% 를 넣으면 왕복비용이 18bps 증가",
    near(roundTripCostBps(stockLike) - rt, 18, 1e-6),
    (roundTripCostBps(stockLike) - rt).toFixed(4)
  );
}

// ── G. commissions API 실측값 반영 ──
console.log("\n[G] 수수료 실측값 덮어쓰기");
{
  const base = krEtfCostParams({ referencePrice: 14780 });
  const measured = costParamsFromCommissionRate(base, "0.015"); // API 는 % 단위로 준다
  check("commissionRate '0.015'% → 0.00015", near(measured.commissionRate, 0.00015, 1e-12));
  check("덮어써도 호가단위는 유지", measured.tickSize === 5);
}

// ── 요약 ──
console.log("\n" + "═".repeat(74));
if (failed === 0) {
  console.log(`✅ 전체 통과: ${passed}개 검증 항목`);
  console.log("   (인공 입력 기반 모듈 테스트 — 시장 성과와 무관합니다)");
} else {
  console.log(`❌ 실패 ${failed}개 / 통과 ${passed}개`);
  process.exitCode = 1;
}
console.log("═".repeat(74));
