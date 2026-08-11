/**
 * 백테스트/실거래 공용 코어 타입.
 *
 * 설계 원칙:
 * 1) 전략은 **주문 의도**만 낸다. 체결가·비용·리스크·포지션사이징은 전부 엔진 책임이다.
 * 2) 전략이 볼 수 있는 데이터는 `StrategyContext` 를 통해서만 노출되며,
 *    그 안에는 **현재 봉까지의 과거 데이터만** 담긴다 (lookahead bias 원천 차단).
 * 3) 백테스트와 실거래가 동일한 `Strategy` 객체를 그대로 재사용한다 (parity break 방지).
 */

// ─── 봉 ───

/**
 * OHLCV 봉.
 * `t` 는 봉 **시작** 시각의 epoch ms (UTC). 토스 API 의 candle.timestamp 와 동일 기준.
 */
export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  symbol: string;
}

export type BarInterval = "1m" | "1d";

// ─── 신호 ───

/**
 * 전략이 낼 수 있는 주문 의도.
 * - `BUY`  : 신규 롱 진입 (또는 롱 증량)
 * - `SELL` : 신규 숏 진입 (또는 숏 증량). 공매도 불가 계좌에서는 엔진이 거부한다.
 * - `EXIT` : 보유 포지션 청산
 */
export type SignalKind = "BUY" | "SELL" | "EXIT";

export type SignalOrderType = "MARKET" | "LIMIT";

export interface Signal {
  kind: SignalKind;
  symbol: string;
  /** 기본 MARKET. LIMIT 이면 limitPrice 필수. */
  orderType?: SignalOrderType;
  limitPrice?: number;
  /** 주문 수량 직접 지정. 미지정 시 엔진의 포지션 사이징 규칙이 결정한다. */
  qty?: number;
  /** 자본 대비 투입 비중 (0~1). qty 미지정 시 사용. 미지정 시 엔진 기본값. */
  sizePct?: number;
  /** 손절가 (절대가격). 엔진이 봉 저가/고가로 감시한다. 토스에는 스톱 주문타입이 없다. */
  stopLoss?: number;
  /** 익절가 (절대가격). */
  takeProfit?: number;
  /**
   * 최대 보유 봉 수. 진입 후 이 봉 수가 지나면 손절·익절에 닿지 않아도 청산한다.
   * "진입할 때 매도 타이밍을 함께 정한다"는 원칙의 시간축 담당.
   */
  maxHoldBars?: number;
  /** 지정가 주문의 유효 봉 수. 기본 1 (다음 봉에서만 유효, 미체결 시 취소). */
  validForBars?: number;
  /** 로깅/분석용 사유. */
  reason?: string;
}

// ─── 포지션 / 체결 / 거래 ───

export interface Position {
  symbol: string;
  /** 양수 = 롱, 음수 = 숏. 0 이 되면 포지션은 제거된다. */
  qty: number;
  /** 평균 진입가 (슬리피지 반영 체결가 기준). */
  avgPrice: number;
  /** 최초 진입 시각 (epoch ms). */
  openedAt: number;
  stopLoss: number | null;
  takeProfit: number | null;
  /** 최대 보유 봉 수. null 이면 시간 청산 없음. */
  maxHoldBars: number | null;
  /** 진입 이후 누적 지불 비용 (수수료 + 슬리피지 + 환전). */
  costPaid: number;
  /** 진입 시 봉 인덱스 (보유 봉 수 계산용). */
  entryBarIndex: number;
}

export type FillReason =
  | "ENTRY"
  | "ADD"
  | "EXIT_SIGNAL"
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TIME_EXIT"
  | "EOD_LIQUIDATION"
  | "DAILY_LOSS_LIMIT";

export interface Fill {
  t: number;
  symbol: string;
  side: "BUY" | "SELL";
  qty: number;
  /** 슬리피지까지 반영된 최종 체결가. */
  price: number;
  /** 슬리피지 적용 전 기준가 (봉 시가/지정가/종가 등). 비용 분해 검증용. */
  refPrice: number;
  orderType: SignalOrderType;
  /** 수수료 + 규제수수료(SEC/TAF). */
  commission: number;
  /** 슬리피지로 인한 추가 비용 (금액). */
  slippageCost: number;
  /** 환전 스프레드 비용 (금액). */
  fxCost: number;
  reason: FillReason;
}

/** 진입→청산 라운드트립 1건. */
export interface Trade {
  symbol: string;
  direction: "LONG" | "SHORT";
  qty: number;
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  /** 비용 차감 전 손익. */
  grossPnl: number;
  commission: number;
  slippageCost: number;
  fxCost: number;
  /** 비용 차감 후 손익. */
  netPnl: number;
  /** netPnl / (entryPrice * qty). */
  returnPct: number;
  exitReason: FillReason;
  barsHeld: number;
  /** 미국 동부시각 기준 세션 날짜 (YYYY-MM-DD). 당일청산 검증용. */
  sessionDate: string;
}

// ─── 세션 ───

/** 정규장 세션 정보. 당일청산 강제의 기준이 된다. */
export interface SessionInfo {
  /** 미국 동부시각 기준 날짜 (YYYY-MM-DD). */
  date: string;
  /** 정규장 개장 시각 (epoch ms). */
  openMs: number;
  /** 정규장 종료 시각 (epoch ms). */
  closeMs: number;
  /** 이 시각 이후의 봉에서는 강제청산이 발동한다 (closeMs - exitBeforeCloseMinutes). */
  forceExitMs: number;
  /** 조기폐장일(반장) 여부. */
  isEarlyClose: boolean;
}

// ─── 전략 컨텍스트 ───

/**
 * 전략에 노출되는 읽기 전용 뷰.
 * 여기에 담긴 모든 데이터는 **현재 봉 종가 시점까지** 확정된 정보뿐이다.
 */
export interface StrategyContext {
  /** 현재 처리 중인 봉의 시작 시각 (epoch ms). */
  readonly now: number;
  /** 현재 봉의 심볼. */
  readonly symbol: string;
  /** 현재 세션 정보. */
  readonly session: SessionInfo;
  /**
   * 해당 심볼의 과거 봉 (오름차순). **마지막 원소가 현재 봉**이며 그 뒤는 존재하지 않는다.
   * 배열은 방어적으로 readonly 이며 엔진이 미래 봉을 넣지 않는다.
   */
  history(symbol?: string): readonly Bar[];
  /** 현재 보유 포지션. 없으면 null. */
  position(symbol?: string): Readonly<Position> | null;
  /** 현재 총자산 (현금 + 평가금액). */
  readonly equity: number;
  /** 현재 현금. */
  readonly cash: number;
  /** 정규장 종료까지 남은 분. 당일청산 전략이 청산 타이밍 판단에 쓴다. */
  readonly minutesToClose: number;
  /** 이번 세션에서 신규 진입이 허용되는지 (일일 손실한도·강제청산 시간 등). */
  readonly canEnter: boolean;
  /** 전략 파라미터 (백테스트/실거래 동일 값 주입). */
  readonly params: Readonly<Record<string, unknown>>;
  /** 로그. 백테스트에서는 버퍼링, 실거래에서는 즉시 출력. */
  log(message: string): void;
}

// ─── 엔진 설정 ───

export interface RiskConfig {
  /** 1회 진입 시 자본 대비 최대 투입 비중 (0~1). 기본 0.2. */
  maxPositionPct: number;
  /** 동시에 보유할 수 있는 종목 수. 기본 3. */
  maxConcurrentPositions: number;
  /** 일일 손실 한도 (세션 시작 자본 대비 비율, 양수). 초과 시 전량 청산 + 당일 진입 차단. */
  dailyLossLimitPct: number;
  /** 정규장 종료 몇 분 전에 강제청산을 시작할지. 기본 1분. */
  exitBeforeCloseMinutes: number;
  /** 공매도(SELL 신규 진입) 허용 여부. 기본 false. */
  allowShort: boolean;
  /** 소수점 주식 허용 여부. false 면 수량을 내림한다. 기본 false. */
  allowFractionalShares: boolean;
  /**
   * 진입 신호에 **매도 계획이 반드시 포함**되어야 하는지. 기본 false (기존 동작 유지).
   *
   * true 면 진입 신호가 `stopLoss`, `takeProfit`, `maxHoldBars` 를 **전부** 갖고 있어야 하고,
   * 하나라도 빠지면 엔진이 예외를 던져 진입을 거부한다.
   * "살 때 이미 언제 팔지가 정해져 있어야 한다"는 원칙을 코드로 강제하는 스위치다.
   * 빠뜨린 청산 조건은 백테스트에서는 조용히 EOD 청산으로 덮이지만
   * 실거래에서는 그대로 방치된 포지션이 되므로, 실거래 경로는 반드시 true 로 둔다.
   */
  requireExitPlan: boolean;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPositionPct: 0.2,
  maxConcurrentPositions: 3,
  dailyLossLimitPct: 0.02,
  exitBeforeCloseMinutes: 1,
  allowShort: false,
  allowFractionalShares: false,
  requireExitPlan: false,
};
