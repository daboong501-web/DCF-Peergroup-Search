/**
 * 일봉 파생 지표. **전략 파일이 아니라 백테스트 준비 단계(init 주입용)에서 쓴다.**
 *
 * 모든 함수는 인덱스 `i` 의 값이 "**i번째 봉까지의** 값"이 되도록 반환한다.
 * 즉 세션일 D 의 전략에 넣을 값은 반드시 **D−1 인덱스**의 값을 써야 한다.
 * 이 규칙을 어기면 그 자체가 미래참조(lookahead)다.
 */

import type { Bar } from "./types";

/**
 * Wilder ATR (True Range 의 Wilder 평활).
 * 초기값은 최초 `period` 개 TR 의 단순평균, 이후 `ATR_t = (ATR_{t−1}×(p−1) + TR_t) / p`.
 * QuantConnect 의 기본 ATR 정의와 동일하다.
 */
export function wilderAtr(bars: readonly Bar[], period = 14): (number | null)[] {
  const tr: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    if (i === 0) {
      tr.push(bars[i].h - bars[i].l);
      continue;
    }
    const pc = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  const out: (number | null)[] = new Array(bars.length).fill(null);
  let atr = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
    } else {
      atr = (atr * (period - 1) + tr[i]) / period;
    }
    out[i] = atr;
  }
  return out;
}

/** 단순이동평균. 표본이 부족한 앞 구간은 null. */
export function sma(values: readonly number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 20일 평균 거래량 (S3 Stage-1 자격조건 ADV20). */
export function adv(bars: readonly Bar[], period = 20): (number | null)[] {
  return sma(
    bars.map((b) => b.v),
    period
  );
}
