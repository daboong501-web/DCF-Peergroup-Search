/**
 * 봉 캐시.
 *
 * 목적 두 가지:
 * 1) 레이트리밋 절약 — 캔들 API 는 초당 5회·1회 200봉이라 한 달치 1분봉만 받아도 수십 번 호출한다.
 * 2) 재현성 확보 — 같은 캐시 파일이면 백테스트 결과가 항상 같다. 수정주가 소급 반영으로
 *    과거 결과가 조용히 바뀌는 일을 막는다.
 *
 * 저장 구조: `data/bars/{interval}/{SYMBOL}/{YYYY-MM-DD}.json`  (날짜는 미국 동부시각 세션일)
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";
import { etDateKey } from "../session";
import type { Bar, BarInterval } from "../types";
import { normalizeBars, type BarRequest, type BarSource } from "./source";

export const DEFAULT_CACHE_ROOT = join(process.cwd(), "data", "bars");

interface CacheFile {
  /** 캐시 포맷 버전. 구조가 바뀌면 올린다. */
  schema: 1;
  symbol: string;
  interval: BarInterval;
  /** 미국 동부시각 세션일 (YYYY-MM-DD). */
  sessionDate: string;
  adjusted: boolean | null;
  /** 이 파일을 만든 소스 이름 (예: "toss"). */
  source: string;
  fetchedAt: string;
  /** [t, o, h, l, c, v] 배열. 파일 크기를 줄이려 배열로 저장한다. */
  bars: [number, number, number, number, number, number][];
}

function dayPath(root: string, symbol: string, interval: BarInterval, date: string): string {
  return join(root, interval, symbol.toUpperCase(), `${date}.json`);
}

/** 한 세션일의 캐시를 읽는다. 없으면 null. */
export function readCachedDay(
  symbol: string,
  interval: BarInterval,
  sessionDate: string,
  root = DEFAULT_CACHE_ROOT
): Bar[] | null {
  const path = dayPath(root, symbol, interval, sessionDate);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as CacheFile;
  return parsed.bars.map(([t, o, h, l, c, v]) => ({ t, o, h, l, c, v, symbol: parsed.symbol }));
}

/** 봉을 세션일 단위로 쪼개서 캐시에 저장한다. */
export function writeCachedBars(
  symbol: string,
  interval: BarInterval,
  bars: Bar[],
  meta: { source: string; adjusted?: boolean },
  root = DEFAULT_CACHE_ROOT
): string[] {
  const byDate = new Map<string, Bar[]>();
  for (const bar of bars) {
    const key = etDateKey(bar.t);
    const list = byDate.get(key) ?? [];
    list.push(bar);
    byDate.set(key, list);
  }

  const written: string[] = [];
  for (const [date, dayBars] of byDate) {
    const path = dayPath(root, symbol, interval, date);
    mkdirSync(join(root, interval, symbol.toUpperCase()), { recursive: true });
    const payload: CacheFile = {
      schema: 1,
      symbol: symbol.toUpperCase(),
      interval,
      sessionDate: date,
      adjusted: meta.adjusted ?? null,
      source: meta.source,
      fetchedAt: new Date().toISOString(),
      bars: normalizeBars(dayBars).map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]),
    };
    writeFileSync(path, JSON.stringify(payload));
    written.push(path);
  }
  return written;
}

/** 캐시에 존재하는 세션일 목록. */
export function listCachedDates(
  symbol: string,
  interval: BarInterval,
  root = DEFAULT_CACHE_ROOT
): string[] {
  const dir = join(root, interval, symbol.toUpperCase());
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

/**
 * [fromMs, toMs) 구간에 걸치는 ET 날짜 키를 모두 만든다 (주말 제외).
 * 공휴일은 여기서 걸러낼 수 없으므로, 데이터가 없는 날은 빈 마커 파일로 표시해
 * "받았는데 봉이 없는 날"과 "아직 안 받은 날"을 구분한다.
 */
export function enumerateSessionDates(fromMs: number, toMs: number): string[] {
  const dates: string[] = [];
  const DAY = 86_400_000;
  // ET 오프셋 차이를 흡수하려고 하루 앞뒤로 여유를 준다.
  for (let t = fromMs - DAY; t <= toMs + DAY; t += DAY) {
    const key = etDateKey(t);
    if (dates[dates.length - 1] !== key) dates.push(key);
  }
  return [...new Set(dates)]
    .sort()
    .filter((d) => {
      const [y, m, dd] = d.split("-").map(Number);
      const weekday = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
      return weekday !== 0 && weekday !== 6;
    });
}

/**
 * 봉이 없는 세션일(공휴일·상장 전 등)을 빈 캐시 파일로 표시한다.
 * 이게 없으면 휴장일 때문에 매번 API 를 다시 때리게 된다.
 */
export function writeEmptyDayMarkers(
  symbol: string,
  interval: BarInterval,
  dates: string[],
  meta: { source: string; adjusted?: boolean },
  root = DEFAULT_CACHE_ROOT
): number {
  mkdirSync(join(root, interval, symbol.toUpperCase()), { recursive: true });
  let count = 0;
  for (const date of dates) {
    const path = dayPath(root, symbol, interval, date);
    if (existsSync(path)) continue;
    const payload: CacheFile = {
      schema: 1,
      symbol: symbol.toUpperCase(),
      interval,
      sessionDate: date,
      adjusted: meta.adjusted ?? null,
      source: meta.source,
      fetchedAt: new Date().toISOString(),
      bars: [],
    };
    writeFileSync(path, JSON.stringify(payload));
    count += 1;
  }
  return count;
}

/** 로컬 캐시만 읽는 소스. 네트워크를 전혀 쓰지 않는다 (백테스트 기본 경로). */
export class CachedBarSource implements BarSource {
  readonly name = "cache";

  constructor(private readonly root: string = DEFAULT_CACHE_ROOT) {}

  async getBars(request: BarRequest): Promise<Bar[]> {
    const out: Bar[] = [];
    for (const date of enumerateSessionDates(request.fromMs, request.toMs)) {
      const day = readCachedDay(request.symbol, request.interval, date, this.root);
      if (day) out.push(...day);
    }
    return normalizeBars(out).filter((b) => b.t >= request.fromMs && b.t < request.toMs);
  }

  /** 캐시에 없는 세션일 목록. fetch-bars 스크립트가 뭘 더 받아야 하는지 알려준다. */
  missingDates(symbol: string, interval: BarInterval, fromMs: number, toMs: number): string[] {
    const have = new Set(listCachedDates(symbol, interval, this.root));
    return enumerateSessionDates(fromMs, toMs).filter((d) => !have.has(d));
  }
}

/**
 * 업스트림 소스를 감싸서 캐시 미스일 때만 원본을 호출하는 소스.
 * 실거래 워밍업에서도 쓸 수 있다.
 */
export class CacheBackedBarSource implements BarSource {
  readonly name: string;

  constructor(
    private readonly upstream: BarSource,
    private readonly root: string = DEFAULT_CACHE_ROOT
  ) {
    this.name = `cache+${upstream.name}`;
  }

  async getBars(request: BarRequest): Promise<Bar[]> {
    const cache = new CachedBarSource(this.root);
    const cached = await cache.getBars(request);
    const missing = cache.missingDates(
      request.symbol,
      request.interval,
      request.fromMs,
      request.toMs
    );
    if (missing.length === 0) return cached;

    const fresh = await this.upstream.getBars(request);
    if (fresh.length > 0) {
      writeCachedBars(request.symbol, request.interval, fresh, {
        source: this.upstream.name,
        adjusted: request.adjusted,
      });
    }
    return normalizeBars([...cached, ...fresh]).filter(
      (b) => b.t >= request.fromMs && b.t < request.toMs
    );
  }
}
