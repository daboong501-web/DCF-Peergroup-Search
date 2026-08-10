/**
 * 토스 API 기반 봉 소스.
 *
 * `GET /api/v1/candles` 는 1회 200봉 제한이 있어 collectCandles() 가 페이지네이션을 돌린다.
 * 미국 정규장 1분봉은 하루 390봉이므로 하루치를 받는 데에도 2회 이상 호출이 필요하다.
 * (Rate Limits Group MARKET_DATA_CHART = 초당 5회 → TossClient 의 토큰버킷이 자동으로 지킨다.)
 */

import { collectCandles } from "../../services/toss/candles";
import type { TossClient } from "../../services/toss/client";
import type { Candle } from "../../services/toss/types";
import type { Bar } from "../types";
import { normalizeBars, type BarRequest, type BarSource } from "./source";

export class TossBarSource implements BarSource {
  readonly name = "toss";

  constructor(
    private readonly client: TossClient,
    private readonly options: { onProgress?: (msg: string) => void } = {}
  ) {}

  async getBars(request: BarRequest): Promise<Bar[]> {
    const candles = await collectCandles(this.client, {
      symbol: request.symbol,
      interval: request.interval,
      fromMs: request.fromMs,
      toMs: request.toMs,
      adjusted: request.adjusted,
      onProgress: (info) =>
        this.options.onProgress?.(
          `  [${request.symbol}] ${info.pages}페이지, 누적 ${info.collected}봉 (가장 오래된 봉 ${info.oldest})`
        ),
    });
    return normalizeBars(candles.map((c) => candleToBar(c, request.symbol)));
  }
}

/**
 * 토스 Candle → 엔진 Bar 변환.
 * 스펙상 가격·거래량은 전부 decimal **문자열**이라 여기서 명시적으로 숫자화한다.
 * timestamp 는 봉 **시작** 시각 (offset 포함 ISO 8601).
 */
export function candleToBar(candle: Candle, symbol: string): Bar {
  const t = Date.parse(candle.timestamp);
  if (!Number.isFinite(t)) {
    throw new Error(`INVALID_CANDLE_TIMESTAMP: ${candle.timestamp}`);
  }
  return {
    t,
    o: toNumber(candle.openPrice, "openPrice"),
    h: toNumber(candle.highPrice, "highPrice"),
    l: toNumber(candle.lowPrice, "lowPrice"),
    c: toNumber(candle.closePrice, "closePrice"),
    v: toNumber(candle.volume, "volume"),
    symbol: symbol.toUpperCase(),
  };
}

function toNumber(raw: string, field: string): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`INVALID_CANDLE_FIELD: ${field}=${raw}`);
  return n;
}
