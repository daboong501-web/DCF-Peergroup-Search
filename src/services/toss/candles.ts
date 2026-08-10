/**
 * 캔들 페이지네이션 수집기.
 *
 * `GET /api/v1/candles` 는 1회 최대 200봉만 준다. 이 모듈은 `before` / `nextBefore` 를
 * 자동으로 돌려서 "지정 기간 전체"를 투명하게 수집한다.
 *
 * 스펙 확인 사항:
 * - `before` 는 **exclusive** 상한 (ISO 8601). 이 시각보다 이전 봉만 반환.
 * - 미지정 시 가장 최신 봉부터 반환.
 * - `nextBefore` 가 null 이면 마지막 페이지.
 * - 응답 예시상 candles 는 **최신→과거 내림차순**이다. 다만 순서를 신뢰하지 않고
 *   수집 후 오름차순으로 직접 정렬한다 (미확인: 정렬 순서가 스펙에 명문화되어 있지 않음).
 * - Rate Limits Group: MARKET_DATA_CHART (초당 5회) — TossClient 의 토큰버킷이 처리한다.
 */

import type { TossClient } from "./client";
import type { Candle, CandleInterval } from "./types";

/** 1회 요청 최대 봉 수 (스펙 상한). */
export const MAX_CANDLES_PER_REQUEST = 200;

export interface CollectCandlesOptions {
  symbol: string;
  interval: CandleInterval;
  /** 수집 시작 시각 (inclusive, epoch ms). */
  fromMs: number;
  /** 수집 종료 시각 (exclusive, epoch ms). */
  toMs: number;
  /** 수정주가 적용 여부. 기본 true (스펙 기본값과 동일). */
  adjusted?: boolean;
  /** 무한 루프 방지용 최대 페이지 수. 기본 500페이지 (= 최대 10만봉). */
  maxPages?: number;
  /** 진행 로그 콜백. */
  onProgress?: (info: { pages: number; collected: number; oldest: string | null }) => void;
}

/**
 * 지정 기간 [fromMs, toMs) 의 캔들을 전부 수집해 **오름차순**으로 반환한다.
 * 중복 timestamp 는 제거한다.
 */
export async function collectCandles(
  client: TossClient,
  options: CollectCandlesOptions
): Promise<Candle[]> {
  const { symbol, interval, fromMs, toMs } = options;
  if (!(toMs > fromMs)) {
    throw new Error(`INVALID_RANGE: toMs(${toMs}) 는 fromMs(${fromMs}) 보다 커야 합니다.`);
  }
  const maxPages = options.maxPages ?? 500;

  /** timestamp(ISO 원문) → Candle. 중복 제거 겸용. */
  const byTimestamp = new Map<number, Candle>();
  // 첫 페이지의 상한은 toMs (exclusive) 그대로 사용한다.
  let before: string | null = new Date(toMs).toISOString();
  let pages = 0;

  while (before !== null && pages < maxPages) {
    const page: Awaited<ReturnType<TossClient["getCandles"]>> = await client.getCandles({
      symbol,
      interval,
      count: MAX_CANDLES_PER_REQUEST,
      before,
      adjusted: options.adjusted,
    });
    pages += 1;

    if (!page.candles || page.candles.length === 0) break;

    let oldestInPage = Number.POSITIVE_INFINITY;
    for (const candle of page.candles) {
      const ts = Date.parse(candle.timestamp);
      if (!Number.isFinite(ts)) continue;
      if (ts < oldestInPage) oldestInPage = ts;
      // 요청 범위 밖은 버린다 (before 가 exclusive 여도 서버가 경계를 어떻게 다루든 안전).
      if (ts >= fromMs && ts < toMs) byTimestamp.set(ts, candle);
    }

    options.onProgress?.({
      pages,
      collected: byTimestamp.size,
      oldest: Number.isFinite(oldestInPage) ? new Date(oldestInPage).toISOString() : null,
    });

    // 이번 페이지의 가장 오래된 봉이 이미 시작점보다 과거면 더 받을 필요가 없다.
    if (oldestInPage <= fromMs) break;

    const next: string | null | undefined = page.nextBefore;
    if (!next) break;
    const nextMs = Date.parse(next);
    // 진전이 없으면(같은 값 반복) 무한 루프를 막기 위해 중단한다.
    if (!Number.isFinite(nextMs) || nextMs >= Date.parse(before)) break;
    before = next;
  }

  return [...byTimestamp.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
}

/** 최신 N봉만 필요할 때 (실거래 워밍업용). count 는 200 초과 시 자동 페이지네이션. */
export async function fetchLatestCandles(
  client: TossClient,
  symbol: string,
  interval: CandleInterval,
  count: number,
  adjusted?: boolean
): Promise<Candle[]> {
  const byTimestamp = new Map<number, Candle>();
  let before: string | undefined = undefined;

  while (byTimestamp.size < count) {
    const page = await client.getCandles({
      symbol,
      interval,
      count: Math.min(MAX_CANDLES_PER_REQUEST, count - byTimestamp.size),
      before,
      adjusted,
    });
    if (!page.candles || page.candles.length === 0) break;
    for (const candle of page.candles) {
      const ts = Date.parse(candle.timestamp);
      if (Number.isFinite(ts)) byTimestamp.set(ts, candle);
    }
    if (!page.nextBefore) break;
    before = page.nextBefore;
  }

  return [...byTimestamp.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-count)
    .map(([, c]) => c);
}
