/**
 * 명세 §D.3 의 거래비용 가정을 코드로 고정한 것.
 *
 * ⚠️ `commissionRate` 0.001 은 **[미확인] 추정치**다. 왕복 총비용의 약 80% 를 차지하므로
 *    `GET /api/v1/commissions` 실측 후 즉시 교체하고 **백테스트를 전량 재실행**해야 한다
 *    (명세 E.4 G0).
 */

import { ZERO_COST_PARAMS, type CostParams } from "./costs";

/** Base case — S1 / S2 (SPY). 명세 D.3.1. 왕복 총비용 ≈ 25.3bp. */
export const COST_SPY: CostParams = {
  commissionRate: 0.001, // 편도 0.1% ★[미확인]
  minCommission: 0,
  spreadBps: 1, // 왕복 bid-ask
  marketImpactBps: 2, // [자체판단 · 검증대상]
  sizeImpactCoefBps: 0,
  limitSlippageBps: 0,
  secFeeRate: 0.0000278, // SEC Section 31 ($27.80 / $1M, FY2025)
  tafPerShare: 0.000166, // FINRA TAF
  tafCapPerOrder: 8.3,
  fxSpreadBps: 10, // 편도 [미확인]
  applyFx: false, // base case — USD 예수금 회전 전제 (명세 D.3.3)
  priceRoundDecimals: 2, // US $1 이상 소수점 2자리
};

/** Base case — S3 (S&P500 대형주). 명세 D.3.2. 왕복 총비용 ≈ 29.3bp. */
export const COST_LARGECAP: CostParams = {
  ...COST_SPY,
  spreadBps: 3,
  marketImpactBps: 3,
};

/** H7 스트레스: 스프레드·시장충격 3배. */
export function stress3x(base: CostParams): CostParams {
  return { ...base, spreadBps: base.spreadBps * 3, marketImpactBps: base.marketImpactBps * 3 };
}

/** 매 거래마다 환전이 발생하는 시나리오. */
export function stressFx(base: CostParams): CostParams {
  return { ...base, applyFx: true };
}

/** 수수료 실측이 나쁘게 나올 경우 (편도 0.25%). */
export function stressComm(base: CostParams, rate = 0.0025): CostParams {
  return { ...base, commissionRate: rate };
}

export { ZERO_COST_PARAMS };

/**
 * 왕복 비용의 이론 하한(bp)을 산술로 계산한다. 명세 D.3.4 의 표를 코드로 재현한 것.
 * 매도측 SEC/TAF 는 가격에 의존하므로 대표가격 `price` 를 받는다.
 */
export function roundTripCostBps(cost: CostParams, price = 200): number {
  const slipOneWay = cost.spreadBps / 2 + cost.marketImpactBps;
  const commission = cost.commissionRate * 2 * 10_000;
  const sec = cost.secFeeRate * 10_000;
  const taf = (cost.tafPerShare / price) * 10_000;
  const fx = cost.applyFx ? cost.fxSpreadBps * 2 : 0;
  return slipOneWay * 2 + commission + sec + taf + fx;
}
