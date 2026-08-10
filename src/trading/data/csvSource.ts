/**
 * 로컬 CSV 봉 소스.
 *
 * 토스 API 외의 데이터(브로커 export, Polygon/Databento 덤프 등)로 같은 엔진을 돌릴 수 있게 한다.
 *
 * 지원 컬럼명 (대소문자 무시, 별칭 허용):
 *   시각   : timestamp | time | datetime | date | t
 *   시가   : open  | o
 *   고가   : high  | h
 *   저가   : low   | l
 *   종가   : close | c
 *   거래량 : volume | vol | v
 *   심볼   : symbol | ticker  (없으면 파일명 또는 옵션의 symbol 사용)
 *
 * 시각 파싱 규칙:
 *   - 숫자면 epoch (13자리 ms, 10자리 s 자동 판별)
 *   - offset/Z 가 붙은 ISO8601 이면 그대로 파싱
 *   - offset 이 없는 "YYYY-MM-DD HH:mm[:ss]" 는 `naiveTimezone` (기본 America/New_York) 의
 *     벽시계 시각으로 해석한다. 이걸 명시하지 않으면 UTC 로 잘못 읽혀 세션 판정이 통째로 어긋난다.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { basename, join } from "path";
import { etWallClockToUtcMs } from "../session";
import type { Bar } from "../types";
import { normalizeBars, type BarRequest, type BarSource } from "./source";

export interface CsvSourceOptions {
  /** CSV 파일 또는 디렉터리 경로. 디렉터리면 `{SYMBOL}*.csv` 를 찾는다. */
  path: string;
  /** offset 없는 시각 문자열을 어느 타임존 벽시계로 볼지. 기본 America/New_York. */
  naiveTimezone?: "America/New_York" | "UTC";
  /** 구분자. 기본 자동 판별(`,` 또는 `\t`). */
  delimiter?: string;
}

export class CsvBarSource implements BarSource {
  readonly name = "csv";

  constructor(private readonly options: CsvSourceOptions) {}

  async getBars(request: BarRequest): Promise<Bar[]> {
    const files = this.resolveFiles(request.symbol);
    if (files.length === 0) {
      throw new Error(
        `CSV_NOT_FOUND: ${request.symbol} 에 해당하는 CSV 를 찾지 못했습니다 (${this.options.path})`
      );
    }
    const all: Bar[] = [];
    for (const file of files) {
      all.push(...parseCsvBars(readFileSync(file, "utf-8"), request.symbol, this.options));
    }
    return normalizeBars(all).filter((b) => b.t >= request.fromMs && b.t < request.toMs);
  }

  private resolveFiles(symbol: string): string[] {
    const p = this.options.path;
    if (!existsSync(p)) return [];
    if (statSync(p).isFile()) return [p];
    const upper = symbol.toUpperCase();
    return readdirSync(p)
      .filter((f) => f.toLowerCase().endsWith(".csv"))
      .filter((f) => basename(f).toUpperCase().startsWith(upper))
      .sort()
      .map((f) => join(p, f));
  }
}

const COLUMN_ALIASES: Record<keyof Omit<Bar, "symbol">, string[]> = {
  t: ["timestamp", "time", "datetime", "date", "t"],
  o: ["open", "o"],
  h: ["high", "h"],
  l: ["low", "l"],
  c: ["close", "c"],
  v: ["volume", "vol", "v"],
};

export function parseCsvBars(
  content: string,
  fallbackSymbol: string,
  options: Pick<CsvSourceOptions, "naiveTimezone" | "delimiter">
): Bar[] {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  const delimiter = options.delimiter ?? (lines[0].includes("\t") ? "\t" : ",");
  const header = lines[0].split(delimiter).map((h) => h.trim().toLowerCase().replace(/^"|"$/g, ""));

  const idx: Record<string, number> = {};
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
    const found = header.findIndex((h) => aliases.includes(h));
    if (found < 0) throw new Error(`CSV_MISSING_COLUMN: '${field}' 컬럼을 찾을 수 없습니다 (헤더: ${header.join(",")})`);
    idx[field] = found;
  }
  const symbolIdx = header.findIndex((h) => h === "symbol" || h === "ticker");

  const bars: Bar[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(delimiter).map((c) => c.trim().replace(/^"|"$/g, ""));
    const t = parseTimestamp(cells[idx.t], options.naiveTimezone ?? "America/New_York");
    if (t === null) continue;
    bars.push({
      t,
      o: Number(cells[idx.o]),
      h: Number(cells[idx.h]),
      l: Number(cells[idx.l]),
      c: Number(cells[idx.c]),
      v: Number(cells[idx.v]),
      symbol: (symbolIdx >= 0 ? cells[symbolIdx] : fallbackSymbol).toUpperCase(),
    });
  }
  return bars;
}

export function parseTimestamp(raw: string, naiveTimezone: "America/New_York" | "UTC"): number | null {
  if (!raw) return null;

  // epoch 숫자
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return raw.length <= 10 ? n * 1000 : n;
  }

  // offset 또는 Z 가 붙어 있으면 그대로 신뢰한다.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // offset 없는 벽시계 시각
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const [, y, mo, d, hh, mi] = m;
    if (naiveTimezone === "UTC") {
      return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi));
    }
    return etWallClockToUtcMs(Number(y), Number(mo), Number(d), Number(hh), Number(mi));
  }

  // 날짜만 있는 경우 (일봉)
  const dOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (dOnly) {
    const [, y, mo, d] = dOnly;
    if (naiveTimezone === "UTC") return Date.UTC(Number(y), Number(mo) - 1, Number(d));
    return etWallClockToUtcMs(Number(y), Number(mo), Number(d), 9, 30);
  }

  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
