/**
 * 국내(KRX) 정규장 세션 캘린더.
 *
 * 미국장과 다른 점이 많아 `session.ts` 의 미국 캘린더를 재사용할 수 없다:
 *
 * 1. **서머타임이 없다.** KST 는 연중 UTC+9 고정이라 오프셋 계산이 필요 없다.
 * 2. **종가 단일가(closing call auction)가 있다.** 09:00~15:20 은 접속매매(연속체결),
 *    15:20~15:30 은 단일가 호가접수 후 15:30 에 한 가격으로 일괄 체결된다.
 * 3. **랜덤엔드(random end).** 단일가 종료 시각이 종목별로 랜덤하게 최대 30초 늦춰진다.
 *    → 마감 시각을 초 단위로 신뢰하면 안 된다. 청산은 반드시 여유를 두고 낸다.
 * 4. **미국주식 전용인 LOC(`timeInForce=CLS`) 를 쓸 수 없다.** [확인됨, 스펙 v1.1.1]
 *    스펙 원문: "CLS: 현재 미국 주식 + orderType=LIMIT 조합만 지원합니다."
 *    ⇒ 국내 종목은 **확정적 종가청산 수단이 없다.** 접속매매 시간 안에 직접 청산해야 한다.
 *    이것이 미국 설계를 국내로 그대로 옮길 수 없는 가장 큰 이유다.
 *
 * 그래서 기본 청산 정책은 **단일가 시작(15:20) 이전에 접속매매로 끝내는 것**이다.
 * 단일가에 넘기면 랜덤엔드와 단일가 체결가 불확실성을 동시에 떠안는다.
 */

import type { SessionInfo } from "./types.js";
import type { SessionCalendar } from "./session.js";

export const KR_MARKET_TZ = "Asia/Seoul";
/** KST 는 서머타임이 없어 연중 고정 오프셋이다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 정규장 개시 (접속매매 시작). */
export const KR_REGULAR_OPEN = { hour: 9, minute: 0 };
/** 접속매매 종료 = 종가 단일가 호가접수 시작. */
export const KR_CONTINUOUS_END = { hour: 15, minute: 20 };
/** 정규장 종료 (종가 단일가 체결). 랜덤엔드로 최대 30초 늦춰질 수 있다. */
export const KR_REGULAR_CLOSE = { hour: 15, minute: 30 };

/** KST 벽시계 → UTC 밀리초. */
export function kstWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  return Date.UTC(year, month - 1, day, hour, minute, 0, 0) - KST_OFFSET_MS;
}

/** 해당 시각의 KST 날짜 키 (YYYY-MM-DD). */
export function kstDateKey(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 해당 시각의 KST 시:분 라벨. */
export function kstTimeLabel(ms: number): string {
  const d = new Date(ms + KST_OFFSET_MS);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}

/** 장 시작으로부터 경과 분. */
export function minutesFromOpen(ms: number, session: SessionInfo): number {
  return Math.floor((ms - session.openMs) / 60_000);
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export interface KrSessionCalendarOptions {
  /**
   * 정규장 종료(15:30) 기준 몇 분 전에 강제청산할지.
   * 기본 15분 = 15:15 → 단일가 시작(15:20) 보다 5분 앞선다.
   * **10분 미만으로 줄이면 단일가 구간에 걸려 접속매매 청산이 불가능해진다.**
   */
  exitBeforeCloseMinutes?: number;
  /**
   * 휴장일 (YYYY-MM-DD, KST). 한국 공휴일은 매년 바뀌고 임시공휴일도 생기므로
   * 규칙으로 유도할 수 없다. 실거래에서는 `GET /api/v1/market-calendar/KR` 로 채운다.
   * 미지정 시 주말만 휴장으로 본다 (봉이 없는 날은 자연히 건너뛴다).
   */
  holidays?: readonly string[];
  /**
   * 조기폐장일 (YYYY-MM-DD, KST) → 마감 시각(HH:MM).
   * 수능일 1시간 지연개장, 연말 폐장일 등 국내 특유의 변형을 담는다.
   */
  specialClose?: Readonly<Record<string, { hour: number; minute: number }>>;
  /** 지연개장일 (YYYY-MM-DD, KST) → 개장 시각. 수능일 등. */
  specialOpen?: Readonly<Record<string, { hour: number; minute: number }>>;
}

/**
 * 규칙 기반 KRX 정규장 캘린더. 백테스트 기본값.
 *
 * 주의: 한국 공휴일은 음력·대체공휴일·임시공휴일 때문에 규칙으로 계산할 수 없다.
 * `holidays` 를 비워두면 **평일 휴장일을 개장일로 오인한다.** 다만 그 날은 봉 데이터가
 * 아예 없으므로 백테스트 결과에는 영향이 없고, 실거래에서는 반드시 토스 캘린더를 써야 한다.
 */
export class KrRegularSessionCalendar implements SessionCalendar {
  private readonly holidays: Set<string>;
  private readonly cache = new Map<string, SessionInfo | null>();
  private readonly exitBeforeCloseMinutes: number;

  constructor(private readonly options: KrSessionCalendarOptions = {}) {
    this.holidays = new Set(options.holidays ?? []);
    this.exitBeforeCloseMinutes = options.exitBeforeCloseMinutes ?? 15;
    if (this.exitBeforeCloseMinutes < 10) {
      throw new Error(
        `KR_EXIT_TOO_LATE: exitBeforeCloseMinutes=${this.exitBeforeCloseMinutes} 는 ` +
          `종가 단일가 시작(15:20) 이후라 접속매매 청산이 불가능합니다. 10 이상으로 두세요.`
      );
    }
  }

  sessionFor(ms: number): SessionInfo | null {
    const date = kstDateKey(ms);
    const cached = this.cache.get(date);
    if (cached !== undefined) return cached;
    const session = this.buildSession(date);
    this.cache.set(date, session);
    return session;
  }

  private buildSession(date: string): SessionInfo | null {
    if (this.holidays.has(date)) return null;
    const [y, m, d] = date.split("-").map(Number);
    const noonKst = kstWallClockToUtcMs(y, m, d, 12, 0);
    const weekday = new Date(noonKst + KST_OFFSET_MS).getUTCDay();
    if (weekday === 0 || weekday === 6) return null;

    const open = this.options.specialOpen?.[date] ?? KR_REGULAR_OPEN;
    const close = this.options.specialClose?.[date] ?? KR_REGULAR_CLOSE;
    const openMs = kstWallClockToUtcMs(y, m, d, open.hour, open.minute);
    const closeMs = kstWallClockToUtcMs(y, m, d, close.hour, close.minute);
    const forceExitMs = closeMs - this.exitBeforeCloseMinutes * 60_000;

    return {
      date,
      openMs,
      closeMs,
      forceExitMs,
      isEarlyClose: this.options.specialClose?.[date] !== undefined,
    };
  }
}

/** 접속매매(연속체결) 시간대인지. 단일가 구간이면 false. */
export function isContinuousTrading(ms: number, session: SessionInfo): boolean {
  const [y, m, d] = session.date.split("-").map(Number);
  const continuousEndMs = kstWallClockToUtcMs(
    y,
    m,
    d,
    KR_CONTINUOUS_END.hour,
    KR_CONTINUOUS_END.minute
  );
  return ms >= session.openMs && ms < continuousEndMs;
}
