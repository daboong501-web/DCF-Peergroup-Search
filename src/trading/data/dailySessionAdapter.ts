/**
 * 일봉 → 합성 세션 어댑터.
 *
 * ## 왜 필요한가
 *
 * 엔진(`engine.ts`)은 "세션 안에 여러 봉이 있고, 신호는 **다음 봉**에서 체결된다"를 전제로 한다.
 * 일봉을 그대로 먹이면 세션당 봉이 1개뿐이라
 *   - 신호 다음 봉이 **다음 세션**이 되고,
 *   - 세션 전환 시 `finalizeSession()` 이 대기주문을 지워버려
 * 어떤 주문도 체결되지 않는다. 즉 **일봉은 이 엔진으로 그대로 돌릴 수 없다.**
 *
 * ## 어떻게 바꾸는가
 *
 * 일봉 1개(O,H,L,C,V)를 정규장 안의 **합성 3봉 세션**으로 펼친다.
 *
 * | 합성봉 | ET 시각 | O | H | L | C | V | 역할 |
 * |---|---|---|---|---|---|---|---|
 * | b0 | 09:30 | O | O | O | O | 0 | **판정 봉.** 전략이 당일 시가를 보고 신호를 낸다 |
 * | b1 | 09:31 | O | H | L | C | V | **체결·경로 봉.** b0 신호가 시가 O 에 체결, 손절은 저가 L 로 감시 |
 * | b2 | 15:59 | C | C | C | C | 0 | **종가 봉.** 엔진의 EOD 강제청산이 종가 C 로 청산 |
 *
 * 결과적으로 "**당일 시가 진입 → 당일 종가 청산**" 이 엔진의 정상 경로(다음 봉 시가 체결 +
 * `EOD_LIQUIDATION`)로 정확히 표현된다.
 *
 * ## 이 변환이 도입하는 편향 — 반드시 리포트에 명시할 것
 *
 * 1. **진입 지연이 0 이다.** b0 의 종가와 b1 의 시가가 같은 값(당일 시가)이므로,
 *    "시가를 보고 시가에 산다"가 된다. 실제 1분봉 백테스트라면 09:30 봉 판정 →
 *    09:31 시가 체결로 **1분의 지연**이 붙는다. ⇒ **이 어댑터는 갭 전략에 낙관적이다.**
 * 2. **봉 안의 경로를 모른다.** 하루 전체가 봉 1개(b1)로 압축되므로 고가·저가 도달 순서를
 *    알 수 없다. 엔진은 손절 우선으로 가정한다(보수적).
 * 3. **장중 시간 기반 규칙을 표현할 수 없다.** 15분 보유청산, 30분 격자 등은
 *    이 합성 세션에서 발동 자체가 불가능하다. 즉 **S1·S2·S3 원 명세는 여기서 돌릴 수 없다.**
 *
 * 이 어댑터의 용도는 **일봉만으로 정확히 계산 가능한 명제**(시가→종가 인트라데이 노출,
 * 갭 진입-종가청산 프록시)를 엔진 위에서 재현하는 것뿐이다.
 */

import { etDateKey, etWallClockToUtcMs } from "../session";
import type { Bar } from "../types";

export interface DailySessionAdapterOptions {
  /** 판정 봉의 개장 후 경과분. 기본 0 (09:30). */
  decideOffsetMinutes?: number;
  /** 체결·경로 봉의 개장 후 경과분. 기본 1 (09:31). */
  rangeOffsetMinutes?: number;
  /** 종가 봉의 개장 후 경과분. 기본 389 (15:59 = 16:00 마감 1분 전). */
  closeOffsetMinutes?: number;
  /** 정규장 개장 시각 (ET). 기본 09:30. */
  openHour?: number;
  openMinute?: number;
}

/**
 * 일봉 배열을 합성 세션 봉 배열로 펼친다. 결과는 시간 오름차순.
 * 입력 일봉의 timestamp 는 ET 날짜만 쓰이며 시각은 무시된다.
 */
export function expandDailyBarsToSessions(
  daily: readonly Bar[],
  options: DailySessionAdapterOptions = {}
): Bar[] {
  const decide = options.decideOffsetMinutes ?? 0;
  const range = options.rangeOffsetMinutes ?? 1;
  const closeOff = options.closeOffsetMinutes ?? 389;
  const oh = options.openHour ?? 9;
  const om = options.openMinute ?? 30;

  if (!(decide < range && range < closeOff)) {
    throw new Error(
      `ADAPTER_OFFSETS_INVALID: decide(${decide}) < range(${range}) < close(${closeOff}) 여야 합니다.`
    );
  }

  const out: Bar[] = [];
  for (const d of daily) {
    const key = etDateKey(d.t);
    const [y, m, dd] = key.split("-").map(Number);
    const openMs = etWallClockToUtcMs(y, m, dd, oh, om);
    const at = (offsetMin: number): number => openMs + offsetMin * 60_000;

    out.push({ t: at(decide), o: d.o, h: d.o, l: d.o, c: d.o, v: 0, symbol: d.symbol });
    out.push({ t: at(range), o: d.o, h: d.h, l: d.l, c: d.c, v: d.v, symbol: d.symbol });
    out.push({ t: at(closeOff), o: d.c, h: d.c, l: d.c, c: d.c, v: 0, symbol: d.symbol });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 여러 심볼의 일봉 맵을 한 번에 변환한다. */
export function expandDailyMapToSessions(
  bySymbol: Map<string, Bar[]>,
  options: DailySessionAdapterOptions = {}
): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const [symbol, bars] of bySymbol) {
    out.set(symbol, expandDailyBarsToSessions(bars, options));
  }
  return out;
}
