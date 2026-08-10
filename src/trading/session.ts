/**
 * 미국 정규장 세션 계산.
 *
 * 당일청산 전략의 모든 시간 판단(세션 경계, 강제청산 시각)은 이 모듈 하나로 모은다.
 * 외부 날짜 라이브러리 없이 `Intl.DateTimeFormat` 의 timeZone 지원만으로 DST 를 처리한다.
 */

import type { SessionInfo } from "./types";

export const US_MARKET_TZ = "America/New_York";

/** 정규장: 09:30 ~ 16:00 ET. 조기폐장일(반장)은 13:00 ET 마감. */
const REGULAR_OPEN = { hour: 9, minute: 30 };
const REGULAR_CLOSE = { hour: 16, minute: 0 };
const EARLY_CLOSE = { hour: 13, minute: 0 };

const ET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: US_MARKET_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function etParts(ms: number): ZonedParts {
  const parts = ET_FORMATTER.formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p ? Number(p.value) : 0;
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/** 해당 시각의 ET 오프셋(ms). DST 를 자동 반영한다. */
function etOffsetMs(ms: number): number {
  const p = etParts(ms);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asIfUtc - ms;
}

/** ET 벽시계 시각(YYYY-MM-DD HH:mm)을 epoch ms 로 변환한다. */
export function etWallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number
): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  let ts = guess - etOffsetMs(guess);
  // DST 경계에서 한 번 더 수렴시킨다.
  const offset2 = etOffsetMs(ts);
  const ts2 = guess - offset2;
  if (ts2 !== ts) ts = ts2;
  return ts;
}

/** epoch ms → ET 기준 날짜 키 (YYYY-MM-DD). 세션 식별자로 쓴다. */
export function etDateKey(ms: number): string {
  const p = etParts(ms);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

/** epoch ms → ET 기준 HH:mm. 로그용. */
export function etTimeLabel(ms: number): string {
  const p = etParts(ms);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** 세션 조회 인터페이스. 백테스트는 규칙 기반, 실거래는 토스 캘린더 API 기반으로 갈아끼운다. */
export interface SessionCalendar {
  /** 해당 시각이 속한 ET 날짜의 정규장 세션. 휴장일이면 null. */
  sessionFor(ms: number): SessionInfo | null;
}

export interface UsSessionCalendarOptions {
  /** 정규장 종료 몇 분 전부터 강제청산할지. */
  exitBeforeCloseMinutes: number;
  /**
   * 조기폐장일 (YYYY-MM-DD, ET). 13:00 ET 마감으로 처리한다.
   * 미지정 시 조기폐장을 모른다 — 실거래에서는 `GET /api/v1/market-calendar/US` 로 채울 것.
   */
  earlyCloseDates?: readonly string[];
  /**
   * 휴장일 (YYYY-MM-DD, ET). 지정하면 해당 날짜는 세션 없음으로 처리한다.
   * 미지정 시 주말만 휴장으로 본다 (봉 데이터가 없는 날은 자연히 건너뛴다).
   */
  holidays?: readonly string[];
}

/** 규칙 기반 미국 정규장 캘린더. 백테스트 기본값. */
export class UsRegularSessionCalendar implements SessionCalendar {
  private readonly earlyClose: Set<string>;
  private readonly holidays: Set<string>;
  private readonly cache = new Map<string, SessionInfo | null>();

  constructor(private readonly options: UsSessionCalendarOptions) {
    this.earlyClose = new Set(options.earlyCloseDates ?? []);
    this.holidays = new Set(options.holidays ?? []);
  }

  sessionFor(ms: number): SessionInfo | null {
    const date = etDateKey(ms);
    const cached = this.cache.get(date);
    if (cached !== undefined) return cached;

    const session = this.buildSession(date);
    this.cache.set(date, session);
    return session;
  }

  private buildSession(date: string): SessionInfo | null {
    if (this.holidays.has(date)) return null;
    const [y, m, d] = date.split("-").map(Number);
    // 주말 판정은 ET 정오 기준 UTC 요일로 한다 (자정 근처 오프셋 문제 회피).
    const noonEt = etWallClockToUtcMs(y, m, d, 12, 0);
    const weekday = new Date(noonEt).getUTCDay();
    if (weekday === 0 || weekday === 6) return null;

    const isEarlyClose = this.earlyClose.has(date);
    const close = isEarlyClose ? EARLY_CLOSE : REGULAR_CLOSE;
    const openMs = etWallClockToUtcMs(y, m, d, REGULAR_OPEN.hour, REGULAR_OPEN.minute);
    const closeMs = etWallClockToUtcMs(y, m, d, close.hour, close.minute);
    const forceExitMs = closeMs - this.options.exitBeforeCloseMinutes * 60_000;

    return { date, openMs, closeMs, forceExitMs, isEarlyClose };
  }
}

/**
 * 토스 `GET /api/v1/market-calendar/US` 응답의 `regularMarket` 세션들로 만드는 캘린더.
 * 실거래에서는 이 쪽이 정확하다 (휴장·조기폐장을 서버가 알려준다).
 */
export class TossSessionCalendar implements SessionCalendar {
  private readonly byDate = new Map<string, SessionInfo>();

  constructor(
    days: ReadonlyArray<{ date: string; regularMarket?: { startTime: string; endTime: string } | null }>,
    private readonly exitBeforeCloseMinutes: number
  ) {
    for (const day of days) {
      if (!day.regularMarket) continue;
      const openMs = Date.parse(day.regularMarket.startTime);
      const closeMs = Date.parse(day.regularMarket.endTime);
      if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) continue;
      this.byDate.set(day.date, {
        date: day.date,
        openMs,
        closeMs,
        forceExitMs: closeMs - exitBeforeCloseMinutes * 60_000,
        // 정규장 길이가 6.5시간 미만이면 조기폐장으로 본다.
        isEarlyClose: closeMs - openMs < 6.5 * 3600_000,
      });
    }
  }

  sessionFor(ms: number): SessionInfo | null {
    return this.byDate.get(etDateKey(ms)) ?? null;
  }

  /** 캘린더에 없는 날짜를 알려준다 (데이터 수집 누락 점검용). */
  get knownDates(): string[] {
    return [...this.byDate.keys()].sort();
  }
}
