/**
 * 봉 데이터 소스 추상화.
 *
 * 백테스트와 실거래가 **같은 인터페이스**로 봉을 받는다.
 * - 백테스트: CachedBarSource(로컬 캐시) 또는 CsvBarSource
 * - 실거래  : TossBarSource(REST 폴링)
 * 전략은 이 계층을 전혀 모른다 — 엔진/러너만 안다.
 */

import type { Bar, BarInterval } from "../types";

export interface BarRequest {
  symbol: string;
  interval: BarInterval;
  /** inclusive, epoch ms. */
  fromMs: number;
  /** exclusive, epoch ms. */
  toMs: number;
  /** 수정주가 적용 여부. 소스가 지원하지 않으면 무시된다. */
  adjusted?: boolean;
}

export interface BarSource {
  readonly name: string;
  /** 오름차순·중복 없는 봉 배열을 반환한다. */
  getBars(request: BarRequest): Promise<Bar[]>;
}

/** 여러 심볼을 한 번에 받아 Map 으로 돌려주는 헬퍼. */
export async function getBarsForSymbols(
  source: BarSource,
  symbols: string[],
  interval: BarInterval,
  fromMs: number,
  toMs: number,
  adjusted?: boolean
): Promise<Map<string, Bar[]>> {
  const out = new Map<string, Bar[]>();
  for (const symbol of symbols) {
    out.set(symbol, await source.getBars({ symbol, interval, fromMs, toMs, adjusted }));
  }
  return out;
}

/** 봉 배열의 정합성을 검사한다. 데이터 품질 문제를 조용히 넘기지 않기 위한 장치. */
export function validateBars(bars: Bar[], symbol: string): string[] {
  const problems: string[] = [];
  let prevT = -Infinity;
  for (const [i, bar] of bars.entries()) {
    if (bar.symbol !== symbol) problems.push(`[${i}] symbol 불일치: ${bar.symbol} != ${symbol}`);
    if (!(bar.t > prevT)) problems.push(`[${i}] 시각이 오름차순이 아님 (t=${bar.t})`);
    prevT = bar.t;
    if (!(bar.h >= bar.l)) problems.push(`[${i}] 고가 < 저가 (h=${bar.h}, l=${bar.l})`);
    if (!(bar.h >= bar.o && bar.h >= bar.c)) problems.push(`[${i}] 고가가 시가/종가보다 작음`);
    if (!(bar.l <= bar.o && bar.l <= bar.c)) problems.push(`[${i}] 저가가 시가/종가보다 큼`);
    if (!Number.isFinite(bar.v) || bar.v < 0) problems.push(`[${i}] 거래량 이상 (v=${bar.v})`);
  }
  return problems;
}

/** 중복 제거 + 오름차순 정렬. 모든 소스 구현이 반환 직전에 통과시킨다. */
export function normalizeBars(bars: Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of bars) byTime.set(bar.t, bar);
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b);
}
