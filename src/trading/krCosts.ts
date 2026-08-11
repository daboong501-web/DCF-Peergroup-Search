/**
 * 국내 ETF 매매 비용 프리셋 — KODEX 코스닥150 (229200) 기준.
 *
 * 미국주식과 비용 구조가 근본적으로 다르며, 이 차이가 단타 성립 여부를 가른다.
 *
 * | 항목            | 미국주식 (SPY)        | 국내 ETF (229200)          |
 * |-----------------|----------------------|---------------------------|
 * | 위탁수수료 편도  | 0.1% [토스 실측 필요]  | **0.015%** (KRX) [2차자료] |
 * | 매도 거래세      | SEC fee + FINRA TAF   | **0** (ETF 증권거래세 면제) |
 * | 양도소득세       | 22% (250만원 공제)     | **0** (국내주식형 ETF 비과세)|
 * | 환전 스프레드    | 있음                  | **0** (원화 거래)           |
 * | 호가 단위        | $0.01                 | **5원** (2,000원 이상 ETF)  |
 *
 * ⚠️ 아래 수치의 근거 등급:
 * - 수수료 0.015%: [2차자료] 토스증권 국내주식 KRX 0.015% / NXT 0.014%.
 *   **`GET /api/v1/commissions` 로 실측해서 덮어써야 한다** (`costParamsFromCommissionRate`).
 * - 증권거래세 면제 / 매매차익 비과세: [2차자료] 국내주식형 ETF 공통. 세법 변경 시 재확인.
 * - 호가 단위 5원: [2차자료] ETF·ETN 은 2,000원 미만 1원, 2,000원 이상 5원.
 *   229200 은 14,000원대라 5원. **가격이 2,000원 밑으로 내려가면 1원으로 바뀐다.**
 * - 스프레드 1틱 가정: [자체판단 · 검증대상] 유동성공급자(LP)가 붙는 ETF라 통상 1틱이지만,
 *   장 초반·마감 무렵·급변 구간에서는 벌어진다. 실측 전까지는 가정일 뿐이다.
 */

import type { CostParams } from "./costs.js";
import { DEFAULT_COST_PARAMS } from "./costs.js";

/** 229200 의 호가 단위 (원). 2,000원 이상 ETF 구간. */
export const KODEX_KOSDAQ150_TICK_SIZE = 5;

/** 토스증권 국내주식 편도 위탁수수료율 [2차자료 — commissions API 로 실측 필요]. */
export const TOSS_KR_COMMISSION_RATE_KRX = 0.00015; // 0.015%
export const TOSS_KR_COMMISSION_RATE_NXT = 0.00014; // 0.014%

/**
 * 국내 ETF 기본 비용 파라미터.
 *
 * 스프레드는 **호가 단위를 가격으로 나눠 동적으로 구해야** 정확하다.
 * 고정 bps 를 쓰면 가격이 변할 때 틀어지므로 `krEtfCostParams()` 를 쓰라.
 */
export function krEtfCostParams(options: {
  /** 기준 가격 (원). 호가 단위를 bps 로 환산하는 데 쓴다. */
  referencePrice: number;
  /** 호가 단위 (원). 기본 5원. */
  tickSize?: number;
  /** 편도 수수료율. 기본 KRX 0.015%. `commissions` API 실측값으로 덮어쓸 것. */
  commissionRate?: number;
  /** 스프레드를 몇 틱으로 볼지. 기본 1틱. [자체판단 · 검증대상] */
  spreadTicks?: number;
  /** 시장가 추가 충격 (bps). 기본 0 — LP 가 붙는 ETF 라 별도 충격을 가정하지 않는다. */
  marketImpactBps?: number;
  /**
   * 매도 거래세율. **ETF 는 0**. 일반 국내주식에 이 프리셋을 재사용할 때만 설정한다.
   */
  sellTaxRate?: number;
}): CostParams {
  const {
    referencePrice,
    tickSize = KODEX_KOSDAQ150_TICK_SIZE,
    commissionRate = TOSS_KR_COMMISSION_RATE_KRX,
    spreadTicks = 1,
    marketImpactBps = 0,
    sellTaxRate = 0,
  } = options;

  if (!(referencePrice > 0)) throw new Error(`INVALID_REFERENCE_PRICE: ${referencePrice}`);
  if (!(tickSize > 0)) throw new Error(`INVALID_TICK_SIZE: ${tickSize}`);

  // 1틱이 가격의 몇 bps 인가. 이것이 스프레드 비용의 하한이다.
  const tickBps = (tickSize / referencePrice) * 10_000;

  return {
    ...DEFAULT_COST_PARAMS,
    commissionRate,
    minCommission: 0, // 국내는 최소수수료가 없다 [2차자료]
    spreadBps: tickBps * spreadTicks,
    marketImpactBps,
    sizeImpactCoefBps: 0,
    limitSlippageBps: 0,
    // 미국 전용 항목은 전부 0
    secFeeRate: 0,
    tafPerShare: 0,
    tafCapPerOrder: 0,
    fxSpreadBps: 0,
    applyFx: false,
    // 국내는 원 단위 정수 가격 + 호가 단위 배수
    priceRoundDecimals: 0,
    tickSize,
    sellTaxRate,
  };
}

/**
 * 왕복 비용을 bps 로 환산한다 (전략 손익분기점 계산용).
 * 시장가 왕복 기준: (half-spread + 충격) × 2 + 수수료 × 2 + 거래세.
 */
export function roundTripCostBps(params: CostParams): number {
  const slippageOneWay = params.spreadBps / 2 + params.marketImpactBps;
  const commissionOneWay = params.commissionRate * 10_000;
  const sellTax = (params.sellTaxRate ?? 0) * 10_000;
  return slippageOneWay * 2 + commissionOneWay * 2 + sellTax;
}
