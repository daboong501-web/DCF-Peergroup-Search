/**
 * 거래비용 모델.
 *
 * 당일청산 단타는 회전율이 극단적으로 높아서 **비용 가정이 전략 성과보다 결과를 더 크게 좌우한다.**
 * 그래서 모든 항목을 파라미터화하고, 기본값의 근거를 아래에 남긴다.
 * 기본값은 "대충 맞는 값"일 뿐이므로 실전 투입 전에 반드시 실제 값으로 교체해야 한다.
 *
 * ── 기본값 근거 ─────────────────────────────────────────────────────────────
 * commissionRate 0.001 (= 0.1%, 편도)
 *   국내 증권사 해외주식 온라인 위탁수수료의 보수적 상단. **실제 값은 반드시
 *   `GET /api/v1/commissions` 의 `commissionRate`(단위 %) 로 덮어쓸 것** — costParamsFromCommissionRate() 참조.
 *
 * spreadBps 5 (= 0.05%, **왕복** bid-ask 스프레드)
 *   대형 미국주식($50~$300, 정규장 1분봉)의 통상 스프레드가 1~3센트인 것을 반영한 값.
 *   시장가 체결은 이 스프레드의 절반(= half-spread)을 항상 불리하게 부담한다고 본다.
 *   유동성이 낮은 종목·개장 직후·급변 구간에서는 이 값을 크게 올려야 한다.
 *
 * marketImpactBps 2 (= 0.02%)
 *   개인 규모 주문이 호가를 밀어내는 정도. half-spread 위에 추가로 얹는다.
 *   주문 규모가 분봉 거래량 대비 유의미해지면 sizeImpactCoef 로 확장한다.
 *
 * secFeeRate 0.0000278 (매도 대금 대비)
 *   SEC Section 31 fee, $27.80 per $1,000,000 (2025 회계연도 요율). **요율은 매년 바뀐다.**
 *
 * tafPerShare 0.000166 / tafCapPerOrder 8.30 (매도만)
 *   FINRA Trading Activity Fee, 주당 $0.000166, 주문당 상한 $8.30. **요율 변경 가능.**
 *
 * fxSpreadBps 10 (= 0.1%, 편도)
 *   원화 계좌에서 달러 주식을 살 때의 환전 스프레드. 매수 시 원화→달러, 매도 시 달러→원화로
 *   양방향 모두 부담한다고 본다. 외화예수금을 유지하며 회전시키면 실질 부담이 줄어들므로
 *   `applyFx=false` 로 끌 수 있다.
 *   (미확인: 토스증권의 실제 환전 스프레드는 API 스펙에 없다. `GET /api/v1/exchange-rate` 의
 *    `basisPoint`(midRate 대비 bp) 로 실측해서 넣는 것을 권장한다.)
 * ───────────────────────────────────────────────────────────────────────────
 */

import type { SignalOrderType } from "./types";

export interface CostParams {
  /** 편도 위탁수수료율 (약정금액 대비 비율. 0.001 = 0.1%). */
  commissionRate: number;
  /** 편도 최소 수수료 (USD). 없으면 0. */
  minCommission: number;
  /** 왕복 bid-ask 스프레드 (bps). 시장가는 이 값의 절반을 부담한다. */
  spreadBps: number;
  /** 시장가 충격 (bps). half-spread 위에 추가. */
  marketImpactBps: number;
  /**
   * 주문 규모 기반 추가 충격 계수 (bps).
   * 추가충격 = sizeImpactCoefBps * sqrt(주문수량 / 해당 봉 거래량).
   * 0 이면 규모 효과를 무시한다.
   */
  sizeImpactCoefBps: number;
  /** 지정가 체결 시 불리하게 잡는 여유 (bps). 기본 0 = 지정가 그대로 체결. */
  limitSlippageBps: number;
  /** SEC Section 31 fee 요율 (매도 대금 대비). */
  secFeeRate: number;
  /** FINRA TAF (매도 주식수당 USD). */
  tafPerShare: number;
  /** FINRA TAF 주문당 상한 (USD). */
  tafCapPerOrder: number;
  /** 편도 환전 스프레드 (bps). */
  fxSpreadBps: number;
  /** 환전 비용 적용 여부. 외화예수금 회전 전략이면 false. */
  applyFx: boolean;
  /** 체결가 반올림 자리수. 미국주식 최소 호가 단위($0.0001)에 맞춘 기본 4. */
  priceRoundDecimals: number;
  /**
   * 호가 단위 (원). 지정하면 `priceRoundDecimals` 대신 이 값의 배수로 체결가를 맞춘다.
   * 국내는 호가 단위가 가격대별로 정해져 있어 임의 소수점 가격이 존재할 수 없다.
   * 반올림 방향은 **항상 불리한 쪽**(매수 올림 / 매도 내림)이라 낙관적 체결이 나오지 않는다.
   * 미지정(undefined)이면 기존 소수점 반올림을 그대로 쓴다 — 미국주식 경로는 영향받지 않는다.
   */
  tickSize?: number;
  /**
   * 매도분 거래세율 (약정금액 대비). 국내주식은 증권거래세가 **매도에만** 붙는다.
   * **ETF 는 증권거래세가 면제**되므로 0 이다. 미지정 시 0.
   */
  sellTaxRate?: number;
}

export const DEFAULT_COST_PARAMS: CostParams = {
  commissionRate: 0.001,
  minCommission: 0,
  spreadBps: 5,
  marketImpactBps: 2,
  sizeImpactCoefBps: 0,
  limitSlippageBps: 0,
  secFeeRate: 0.0000278,
  tafPerShare: 0.000166,
  tafCapPerOrder: 8.3,
  fxSpreadBps: 10,
  applyFx: true,
  priceRoundDecimals: 4,
};

/**
 * 비용 0 모델. **엔진 단위테스트 및 "비용 차감 전" 비교 계산 전용.**
 * 실제 백테스트에 쓰면 결과가 현실과 무관해진다.
 */
export const ZERO_COST_PARAMS: CostParams = {
  commissionRate: 0,
  minCommission: 0,
  spreadBps: 0,
  marketImpactBps: 0,
  sizeImpactCoefBps: 0,
  limitSlippageBps: 0,
  secFeeRate: 0,
  tafPerShare: 0,
  tafCapPerOrder: 0,
  fxSpreadBps: 0,
  applyFx: false,
  priceRoundDecimals: 4,
};

/** `GET /api/v1/commissions` 의 commissionRate(단위 %) 를 비율로 바꿔 반영한다. */
export function costParamsFromCommissionRate(
  base: CostParams,
  commissionRatePercent: string | number
): CostParams {
  const pct = typeof commissionRatePercent === "string"
    ? Number(commissionRatePercent)
    : commissionRatePercent;
  if (!Number.isFinite(pct)) {
    throw new Error(`INVALID_COMMISSION_RATE: ${commissionRatePercent}`);
  }
  return { ...base, commissionRate: pct / 100 };
}

export interface FillCostInput {
  side: "BUY" | "SELL";
  /** 슬리피지 적용 전 기준가 (시장가면 봉 시가/종가, 지정가면 지정가). */
  refPrice: number;
  qty: number;
  orderType: SignalOrderType;
  /** 해당 봉 거래량. sizeImpactCoefBps > 0 일 때만 사용. */
  barVolume?: number;
}

export interface FillCostBreakdown {
  /** 슬리피지 반영 최종 체결가. */
  fillPrice: number;
  /** 주당 슬리피지 (항상 >= 0, 불리한 방향). */
  slippagePerShare: number;
  /** 슬리피지 총액 = slippagePerShare * qty. */
  slippageCost: number;
  /** 위탁수수료 + SEC fee + TAF. */
  commission: number;
  /** 환전 스프레드 비용. */
  fxCost: number;
  /** 총 비용 (슬리피지 + 수수료 + 환전). */
  totalCost: number;
}

/** 체결가와 비용을 한 번에 계산한다. 엔진은 이 함수 외에서 비용을 만들지 않는다. */
export function computeFillCost(params: CostParams, input: FillCostInput): FillCostBreakdown {
  const { side, refPrice, qty, orderType } = input;
  if (qty <= 0) throw new Error(`INVALID_QTY: ${qty}`);
  if (!(refPrice > 0)) throw new Error(`INVALID_PRICE: ${refPrice}`);

  let slippageBps: number;
  if (orderType === "MARKET") {
    slippageBps = params.spreadBps / 2 + params.marketImpactBps;
    if (params.sizeImpactCoefBps > 0 && input.barVolume && input.barVolume > 0) {
      slippageBps += params.sizeImpactCoefBps * Math.sqrt(qty / input.barVolume);
    }
  } else {
    slippageBps = params.limitSlippageBps;
  }

  // 매수는 위로, 매도는 아래로 — 항상 불리한 방향.
  const direction = side === "BUY" ? 1 : -1;
  const rawFillPrice = refPrice * (1 + (direction * slippageBps) / 10_000);
  // 호가 단위가 있으면 그 배수로, 없으면 소수점 자리수로 맞춘다.
  // 호가 단위 반올림은 불리한 쪽으로만 — 매수는 올리고 매도는 내린다.
  const fillPrice =
    params.tickSize && params.tickSize > 0
      ? roundToTick(rawFillPrice, params.tickSize, side)
      : roundTo(rawFillPrice, params.priceRoundDecimals);
  const slippagePerShare = Math.abs(fillPrice - refPrice);
  const slippageCost = slippagePerShare * qty;

  const notional = fillPrice * qty;

  let commission = Math.max(notional * params.commissionRate, params.minCommission);
  if (side === "SELL") {
    // SEC fee 와 FINRA TAF 는 매도에만 부과된다.
    commission += notional * params.secFeeRate;
    commission += Math.min(qty * params.tafPerShare, params.tafCapPerOrder);
    // 국내 증권거래세도 매도에만 부과된다 (ETF 는 면제라 0).
    commission += notional * (params.sellTaxRate ?? 0);
  }

  const fxCost = params.applyFx ? (notional * params.fxSpreadBps) / 10_000 : 0;

  return {
    fillPrice,
    slippagePerShare,
    slippageCost,
    commission,
    fxCost,
    totalCost: slippageCost + commission + fxCost,
  };
}

/**
 * 호가 단위의 배수로 맞춘다. 방향은 항상 불리한 쪽:
 * 매수는 올림(더 비싸게), 매도는 내림(더 싸게). 낙관적 체결을 원천 차단한다.
 */
export function roundToTick(value: number, tickSize: number, side: "BUY" | "SELL"): number {
  if (!(tickSize > 0)) throw new Error(`INVALID_TICK_SIZE: ${tickSize}`);
  const ticks = value / tickSize;
  // 부동소수 오차로 이미 정수인 값이 한 틱 밀리지 않도록 여유를 준다.
  const EPS = 1e-9;
  const rounded = side === "BUY" ? Math.ceil(ticks - EPS) : Math.floor(ticks + EPS);
  return roundTo(rounded * tickSize, 6);
}

export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON * Math.sign(value)) * factor) / factor;
}
