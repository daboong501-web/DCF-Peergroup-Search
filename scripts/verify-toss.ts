/**
 * 토스증권 Open API 발급 직후 연결 검증 + PoC 실측 스크립트.
 *
 *   npx tsx scripts/verify-toss.ts
 *
 * 이 스크립트는 **읽기 전용**이다. 주문을 생성/정정/취소하지 않는다.
 * 키를 막 발급받은 직후 돌려서 (1) 연결이 되는지 (2) 문서로 확인하지 못한
 * 항목들이 실제로 어떤 값인지를 한 번에 실측하는 것이 목적이다.
 *
 * 실측 대상(= 매뉴얼/명세에서 [미확인] 으로 남은 것들):
 *   P1. 해외주식 실제 수수료율      → 백테스트 비용가정의 80% 를 차지하는 값
 *   P2. 1분봉에 프리마켓이 포함되는가 → 갭/RVOL 계산의 전제
 *   P3. 캔들 배열의 정렬 순서        → 스펙에 명문화가 없어 코드가 추측하고 있다
 *   P4. 미국 4세션 실제 시각(KST)    → 서머타임/조기폐장 동적 처리 확인
 *   P5. 환전 스프레드(basisPoint)   → 비용모델 입력
 *   P6. 레이트리밋 헤더 실제 값      → 하드코딩 금지, 적응형 처리용
 */

import "dotenv/config";
import { TossClient } from "../src/services/toss/client.js";
import { loadTossAuthConfigFromEnv } from "../src/services/toss/auth.js";
import type { Candle, UsMarketDay } from "../src/services/toss/types.js";

const SYMBOL = process.env.VERIFY_SYMBOL ?? "AAPL";

type Status = "OK" | "FAIL" | "SKIP";
const results: Array<{ step: string; status: Status; detail: string }> = [];

function record(step: string, status: Status, detail: string): void {
  results.push({ step, status, detail });
  const mark = status === "OK" ? "✅" : status === "SKIP" ? "⏭️ " : "❌";
  console.log(`${mark} ${step} — ${detail}`);
}

function describeError(err: unknown): string {
  if (err && typeof err === "object" && "status" in err && "code" in err) {
    const e = err as { status: number; code: string; message: string };
    return `${e.status} ${e.code}: ${e.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * 발급 화면의 [허용 IP 관리] 누락은 403 으로 나타난다. 가장 흔한 첫 실패라 따로 안내한다.
 *
 * 토큰 발급 실패는 TossApiError 가 아니라 `TOSS_AUTH_FAILED: HTTP 403` 같은 평문 Error 로
 * 올라온다. 허용 IP 미등록은 바로 이 토큰 발급 단계에서 터지므로, 메시지에서도 상태코드를
 * 읽어내야 안내가 뜬다.
 */
function hintFor(err: unknown): string | null {
  let status: number | undefined;
  let code: string | undefined;

  if (err && typeof err === "object" && "status" in err) {
    ({ status, code } = err as { status: number; code?: string });
  } else if (err instanceof Error) {
    const m = /HTTP (\d{3})/.exec(err.message);
    if (m) status = Number(m[1]);
    else if (/invalid_client|unauthorized/i.test(err.message)) status = 401;
  }
  if (status === undefined) return null;
  if (status === 403) {
    return (
      "403 입니다. 토스증권 WTS → 설정 → Open API → [허용 IP 관리] 에 지금 이 머신의 공인 IP 가\n" +
      "     등록되어 있는지 확인하세요. 키가 맞아도 미등록 IP 는 차단됩니다.\n" +
      "     현재 공인 IP 확인: curl -s https://ifconfig.me"
    );
  }
  if (status === 401) {
    return (
      "401 입니다. client_id/secret 오타이거나, **다른 프로세스가 같은 client_id 로 토큰을 재발급해\n" +
      "     이 토큰이 무효화**되었을 수 있습니다 (토스는 client 당 유효 토큰이 1개뿐입니다).\n" +
      "     봇/MCP 서버/수동 테스트를 동시에 돌리고 있지 않은지 확인하세요."
    );
  }
  if (status === 422 && code === "prerequisite-required") {
    return "약관 동의·위험 고지 등 사전 자격 요건이 미충족입니다. 토스증권 앱/WTS 에서 먼저 동의하세요.";
  }
  return null;
}

function toKst(iso: string): string {
  return new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", hour12: false });
}

/** 미국 동부 기준 시:분 (프리마켓 판정용). */
function etHourMinute(iso: string): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return { hour: get("hour"), minute: get("minute") };
}

function describeSession(label: string, day: UsMarketDay): string {
  const s = day[label as "preMarket" | "regularMarket" | "afterMarket" | "dayMarket"];
  if (!s) return `${label}=휴장(null)`;
  return `${label}=${toKst(s.startTime)}~${toKst(s.endTime)}`;
}

async function main(): Promise<void> {
  console.log("═".repeat(78));
  console.log("토스증권 Open API 연결 검증 (읽기 전용 — 주문을 내지 않습니다)");
  console.log("═".repeat(78));

  // ── 0. 환경변수 ──
  try {
    const cfg = loadTossAuthConfigFromEnv();
    record(
      "0. 환경변수",
      "OK",
      `TOSS_CLIENT_ID=${cfg.clientId.slice(0, 4)}…(${cfg.clientId.length}자), base=${cfg.baseUrl}`
    );
  } catch (err) {
    record("0. 환경변수", "FAIL", describeError(err));
    console.log("\n.env 파일을 만들고 키를 넣으세요. 템플릿: cp .env.example .env");
    process.exitCode = 1;
    return;
  }

  const client = new TossClient();

  // ── 1. 토큰 발급 (가장 먼저 실패하는 지점) ──
  try {
    const rate = await client.getExchangeRate("USD", "KRW");
    record(
      "1. 토큰 발급 + 인증 호출",
      "OK",
      `USD/KRW rate=${rate.rate} mid=${rate.midRate} basisPoint=${rate.basisPoint}`
    );
    // P5: 환전 스프레드 실측
    const bp = Number(rate.basisPoint);
    record(
      "P5. 환전 스프레드 실측",
      Number.isFinite(bp) ? "OK" : "FAIL",
      Number.isFinite(bp)
        ? `basisPoint=${bp} → 비용모델의 fxSpreadBp 를 이 값으로 설정하세요 (코드 기본값 10bp)`
        : `basisPoint 파싱 실패: ${rate.basisPoint}`
    );
  } catch (err) {
    record("1. 토큰 발급 + 인증 호출", "FAIL", describeError(err));
    const hint = hintFor(err);
    if (hint) console.log(`\n  ⚠️  ${hint}\n`);
    process.exitCode = 1;
    return;
  }

  // ── 2. 계좌 조회 → accountSeq ──
  try {
    const accounts = await client.getAccounts();
    if (accounts.length === 0) {
      record("2. 계좌 조회", "FAIL", "계좌가 0건입니다. 토스증권 계좌를 먼저 개설하세요.");
    } else {
      const lines = accounts
        .map((a) => `accountSeq=${a.accountSeq} type=${a.accountType} no=${a.accountNo}`)
        .join(" | ");
      record("2. 계좌 조회", "OK", lines);
      const brokerage = accounts.find((a) => a.accountType === "BROKERAGE") ?? accounts[0];
      console.log(
        `     → .env 에 TOSS_ACCOUNT_SEQ=${brokerage.accountSeq} 를 넣으세요 (주문/잔고 API 필수 헤더).`
      );
    }
  } catch (err) {
    record("2. 계좌 조회", "FAIL", describeError(err));
    const hint = hintFor(err);
    if (hint) console.log(`\n  ⚠️  ${hint}\n`);
  }

  // ── P1. 수수료 실측 (비용가정의 핵심) ──
  try {
    const commissions = await client.getCommissions();
    const us = commissions.find((c) => c.marketCountry === "US");
    if (us) {
      const ratePct = Number(us.commissionRate);
      record(
        "P1. 해외주식 수수료율 실측",
        "OK",
        `commissionRate=${us.commissionRate}% → 편도 ${(ratePct * 100).toFixed(2)}bp, 왕복 ${(ratePct * 200).toFixed(2)}bp`
      );
      console.log(
        `     → 백테스트 비용가정(코드 기본 0.1% = 편도 10bp)과 다르면 costs.ts 의 commissionRate 를 교체하세요.`
      );
    } else {
      record("P1. 해외주식 수수료율 실측", "FAIL", `US 항목 없음: ${JSON.stringify(commissions)}`);
    }
  } catch (err) {
    record("P1. 해외주식 수수료율 실측", "FAIL", describeError(err));
  }

  // ── P4. 미국 장 운영 시간 ──
  let regularOpenIso: string | null = null;
  try {
    const cal = await client.getUsMarketCalendar();
    const today = cal.today;
    const labels = ["preMarket", "regularMarket", "afterMarket", "dayMarket"];
    record(
      "P4. 미국 장 운영시간(KST)",
      "OK",
      `${today.date} | ${labels.map((l) => describeSession(l, today)).join(" | ")}`
    );
    regularOpenIso = today.regularMarket?.startTime ?? cal.previousBusinessDay.regularMarket?.startTime ?? null;
    if (!today.regularMarket) {
      console.log("     → 오늘은 미국 휴장입니다. 캔들 검사는 직전 영업일 기준으로 진행합니다.");
    }
  } catch (err) {
    record("P4. 미국 장 운영시간(KST)", "FAIL", describeError(err));
  }

  // ── P2/P3. 1분봉: 정렬 순서 + 프리마켓 포함 여부 ──
  try {
    const page = await client.getCandles({ symbol: SYMBOL, interval: "1m", count: 200 });
    const candles: Candle[] = page.candles ?? [];
    if (candles.length === 0) {
      record("P2/P3. 1분봉 조회", "FAIL", `${SYMBOL} 1분봉이 0건입니다.`);
    } else {
      // P3: 정렬 순서
      const first = new Date(candles[0].timestamp).getTime();
      const last = new Date(candles[candles.length - 1].timestamp).getTime();
      const order = first < last ? "오름차순(과거→최신)" : first > last ? "내림차순(최신→과거)" : "단일봉";
      record(
        "P3. 캔들 정렬 순서",
        "OK",
        `${order} — ${candles.length}봉, ${toKst(candles[0].timestamp)} … ${toKst(candles[candles.length - 1].timestamp)}`
      );
      console.log(
        `     → candles.ts 는 수신 후 오름차순으로 재정렬하므로 어느 쪽이든 안전하지만, 실제 값을 기록해 두세요.`
      );

      // P2: 프리마켓 포함 여부 (ET 09:30 이전 / 16:00 이후 봉이 있는가)
      const outside = candles.filter((c) => {
        const { hour, minute } = etHourMinute(c.timestamp);
        const mins = hour * 60 + minute;
        return mins < 9 * 60 + 30 || mins >= 16 * 60;
      });
      const withVolume = outside.filter((c) => Number(c.volume) > 0);
      if (outside.length === 0) {
        record(
          "P2. 프리마켓/애프터마켓 포함 여부",
          "OK",
          "정규장(09:30–16:00 ET) 밖의 봉이 0건 → **1분봉은 정규장만 제공**하는 것으로 보임"
        );
        console.log(
          "     → 갭 계산에 프리마켓 거래량을 쓸 수 없습니다. 명세의 프리마켓 의존 조건을 재검토하세요."
        );
      } else {
        record(
          "P2. 프리마켓/애프터마켓 포함 여부",
          "OK",
          `정규장 밖 봉 ${outside.length}건 (거래량>0 인 것 ${withVolume.length}건) → **시간외 봉이 포함됨**`
        );
        console.log(
          "     → 정규장만 쓰려면 엔진에 세션 필터를 켜야 합니다. 백테스트/실거래 모두 동일하게 적용할 것."
        );
      }

      // 봉 간격 점검 (결측 확인)
      const sorted = [...candles].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      let gaps = 0;
      for (let i = 1; i < sorted.length; i += 1) {
        const diff =
          (new Date(sorted[i].timestamp).getTime() - new Date(sorted[i - 1].timestamp).getTime()) / 60000;
        if (diff > 1.5) gaps += 1;
      }
      record(
        "P3b. 1분봉 결측",
        "OK",
        `연속하지 않은 구간 ${gaps}곳 (세션 경계 포함). nextBefore=${page.nextBefore ?? "null(마지막 페이지)"}`
      );
    }
  } catch (err) {
    record("P2/P3. 1분봉 조회", "FAIL", describeError(err));
    const hint = hintFor(err);
    if (hint) console.log(`\n  ⚠️  ${hint}\n`);
  }

  // ── P6. 레이트리밋 헤더 실측 ──
  try {
    const prices = await client.getPrices([SYMBOL, "MSFT", "SPY"]);
    record(
      "P6. 현재가 다건 조회",
      "OK",
      prices.map((p) => `${p.symbol}=${p.lastPrice}${p.timestamp ? "" : "(체결없음)"}`).join(" ")
    );
    console.log(
      "     → 레이트리밋 실제 한도는 응답헤더 X-RateLimit-Limit 로 확인하세요 (client.ts 가 파싱합니다)."
    );
  } catch (err) {
    record("P6. 현재가 다건 조회", "FAIL", describeError(err));
  }

  // ── 요약 ──
  console.log("\n" + "═".repeat(78));
  const ok = results.filter((r) => r.status === "OK").length;
  const fail = results.filter((r) => r.status === "FAIL").length;
  console.log(`검증 완료: 성공 ${ok} / 실패 ${fail}`);
  if (fail > 0) {
    console.log("\n실패 항목:");
    for (const r of results.filter((x) => x.status === "FAIL")) {
      console.log(`  - ${r.step}: ${r.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\n다음 단계: 지난 1주일 분봉 수집 →");
    console.log("  npx tsx scripts/fetch-bars.ts --symbols SPY --interval 1m --days 7");
  }
  console.log("═".repeat(78));
}

main().catch((err) => {
  console.error("예상치 못한 오류:", describeError(err));
  process.exitCode = 1;
});
