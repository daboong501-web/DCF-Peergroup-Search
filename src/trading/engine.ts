/**
 * 봉 리플레이 백테스트 엔진.
 *
 * ## 미래 데이터 참조 금지를 "구조적으로" 보장하는 방법
 *
 * - 봉은 전역 타임라인에 시간 오름차순으로 정렬되어 하나씩 "공개"된다.
 * - 전략에 넘어가는 `ctx.history(symbol)` 은 **공개된 봉만 담긴 내부 배열**이다.
 *   엔진은 이 배열에 미래 봉을 넣지 않으며, 전략은 원본 데이터에 접근할 수 없다.
 * - 전략이 봉 B 에서 낸 신호는 **다음 봉에서 체결**된다. 같은 봉의 종가로 체결하면
 *   "종가를 보고 종가에 산" 셈이 되어 백테스트가 부풀려진다.
 * - 손절/익절만 예외적으로 같은 봉 안에서 처리되는데, 이는 봉 이전에 이미 걸어둔
 *   조건부 청산이라 미래 정보가 아니다.
 *
 * ## 봉 하나의 처리 순서 (중요)
 *
 *   1) 봉 공개 (history 에 append)
 *   2) 직전 봉에서 발생한 대기주문 체결 시도 (MARKET → 시가, LIMIT → 지정가 터치 시)
 *   3) 보유 포지션의 손절/익절 판정 — **경로 모호성은 손절 우선**
 *   4) 강제청산 시각(정규장 종료 N분 전) 도달 시 전량 청산 (LOC 모사)
 *   5) 일일 손실 한도 초과 시 전량 청산 + 당일 신규진입 차단
 *   6) 전략 onBar 호출 → 신호를 다음 봉용 대기주문으로 적재
 *
 * ## 경로 모호성 (path ambiguity)
 *
 * 1분봉 하나 안에서 손절가와 익절가가 **둘 다** 닿을 수 있다. 봉 데이터만으로는
 * 어느 쪽이 먼저였는지 알 수 없다. 이 엔진은 항상 **손절이 먼저 닿았다고 가정**한다.
 * 낙관적 가정(익절 우선)은 백테스트를 체계적으로 부풀리기 때문이다.
 */

import {
  DEFAULT_COST_PARAMS,
  computeFillCost,
  roundTo,
  type CostParams,
} from "./costs";
import { UsRegularSessionCalendar, etDateKey, type SessionCalendar } from "./session";
import { normalizeSignals, type RunMode, type Strategy } from "./strategy";
import {
  DEFAULT_RISK_CONFIG,
  type Bar,
  type BarInterval,
  type Fill,
  type FillReason,
  type Position,
  type RiskConfig,
  type SessionInfo,
  type Signal,
  type SignalOrderType,
  type StrategyContext,
  type Trade,
} from "./types";

export interface EngineConfig {
  initialCapital: number;
  interval: BarInterval;
  cost?: Partial<CostParams>;
  risk?: Partial<RiskConfig>;
  /** 세션 캘린더. 미지정 시 규칙 기반 미국 정규장(09:30~16:00 ET). */
  calendar?: SessionCalendar;
  /** 정규장 밖(프리/애프터) 봉을 전략에 노출할지. 기본 false — 당일청산 단타의 기준은 정규장. */
  includeExtendedHours?: boolean;
  /** 전략 파라미터 (컨텍스트로 그대로 전달). */
  params?: Record<string, unknown>;
  mode?: RunMode;
  /** 전략 로그를 콘솔로 흘릴지. 기본 false (결과 객체에만 담는다). */
  verbose?: boolean;
}

export interface EquityPoint {
  t: number;
  equity: number;
  cash: number;
}

export interface DailySummary {
  date: string;
  startEquity: number;
  endEquity: number;
  netPnl: number;
  grossPnl: number;
  cost: number;
  tradeCount: number;
  /** 일일 손실 한도로 당일 매매가 중단되었는지. */
  haltedByLossLimit: boolean;
}

export interface BacktestResult {
  initialCapital: number;
  finalEquity: number;
  trades: Trade[];
  fills: Fill[];
  equityCurve: EquityPoint[];
  daily: DailySummary[];
  logs: string[];
  warnings: string[];
  barsProcessed: number;
  strategyName: string;
  strategyVersion: string;
  costParams: CostParams;
  riskConfig: RiskConfig;
}

// ─── 내부 상태 ───

interface OpenPosition {
  symbol: string;
  /** 양수 = 롱, 음수 = 숏. */
  qty: number;
  /** 비용 반영 평균 체결가. */
  avgFillPrice: number;
  /** 비용 배제 평균 기준가 (gross 손익 계산용). */
  avgRefPrice: number;
  openedAt: number;
  entryBarIndex: number;
  stopLoss: number | null;
  takeProfit: number | null;
  maxHoldBars: number | null;
  entryCommission: number;
  entrySlippage: number;
  entryFx: number;
  sessionDate: string;
}

interface PendingOrder {
  symbol: string;
  side: "BUY" | "SELL";
  /** EXIT 신호에서 나온 청산 주문인지. */
  isExit: boolean;
  orderType: SignalOrderType;
  limitPrice: number | null;
  qty: number | null;
  sizePct: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  maxHoldBars: number | null;
  barsRemaining: number;
  reason: string | undefined;
  createdAt: number;
}

export function runBacktest(
  strategy: Strategy<Record<string, unknown>>,
  barsBySymbol: Map<string, Bar[]>,
  config: EngineConfig
): BacktestResult {
  const cost: CostParams = { ...DEFAULT_COST_PARAMS, ...(config.cost ?? {}) };
  const risk: RiskConfig = { ...DEFAULT_RISK_CONFIG, ...(config.risk ?? {}) };
  const calendar =
    config.calendar ??
    new UsRegularSessionCalendar({ exitBeforeCloseMinutes: risk.exitBeforeCloseMinutes });
  const params = config.params ?? {};
  const mode: RunMode = config.mode ?? "backtest";

  // ── 결과 버퍼 ──
  const trades: Trade[] = [];
  const fills: Fill[] = [];
  const equityCurve: EquityPoint[] = [];
  const daily: DailySummary[] = [];
  const logs: string[] = [];
  const warnings: string[] = [];

  // ── 계좌 상태 ──
  let cash = config.initialCapital;
  const positions = new Map<string, OpenPosition>();
  const pending = new Map<string, PendingOrder[]>();
  const history = new Map<string, Bar[]>();
  const lastBar = new Map<string, Bar>();
  let barsProcessed = 0;

  // ── 세션 상태 ──
  let currentSession: SessionInfo | null = null;
  let sessionStartEquity = config.initialCapital;
  let sessionRealizedGross = 0;
  let sessionCost = 0;
  let sessionTradeCount = 0;
  let sessionHalted = false;

  const log = (msg: string): void => {
    logs.push(msg);
    if (config.verbose) console.log(msg);
  };

  strategy.init?.({
    params,
    symbols: [...barsBySymbol.keys()],
    interval: config.interval,
    mode,
    log,
  });

  // ── 타임라인 구성: 같은 timestamp 의 봉들을 한 묶음으로 처리한다 ──
  const timeline = buildTimeline(barsBySymbol);

  for (const group of timeline) {
    const t = group.t;
    const session = calendar.sessionFor(t);

    // 정규장 밖 봉 처리
    const inRegular = session !== null && t >= session.openMs && t < session.closeMs;
    if (!inRegular && !config.includeExtendedHours) {
      // 세션이 끝난 뒤 남은 포지션이 있으면 폴백 청산 (데이터 공백 등으로 강제청산이 안 걸린 경우).
      if (currentSession && (session === null || session.date !== currentSession.date)) {
        finalizeSession(t);
      }
      continue;
    }
    if (session === null) continue;

    // 세션 전환
    if (!currentSession || currentSession.date !== session.date) {
      if (currentSession) finalizeSession(t);
      currentSession = session;
      sessionStartEquity = markToMarket();
      sessionRealizedGross = 0;
      sessionCost = 0;
      sessionTradeCount = 0;
      sessionHalted = false;
      strategy.onSessionStart?.(session);
    }

    // (1) 봉 공개
    for (const bar of group.bars) {
      const hist = history.get(bar.symbol) ?? [];
      hist.push(bar);
      history.set(bar.symbol, hist);
      lastBar.set(bar.symbol, bar);
      barsProcessed += 1;
    }

    // (2)~(5) 체결·리스크 처리
    for (const bar of group.bars) {
      fillPendingOrders(bar, session);
      applyStopAndTarget(bar, session);
    }

    // (4) 강제청산: 정규장 종료 N분 전 이후 봉 → LOC 모사(종가 체결)
    if (t >= session.forceExitMs) {
      for (const bar of group.bars) {
        const pos = positions.get(bar.symbol);
        if (pos) closePosition(pos, bar.c, bar.t, "LIMIT", "EOD_LIQUIDATION", session);
      }
      pending.clear();
    }

    // (5) 일일 손실 한도
    if (!sessionHalted && risk.dailyLossLimitPct > 0) {
      const dayPnl = markToMarket() - sessionStartEquity;
      if (dayPnl <= -risk.dailyLossLimitPct * sessionStartEquity) {
        sessionHalted = true;
        log(
          `[리스크] ${session.date} 일일 손실 한도 도달 (${dayPnl.toFixed(2)} / 한도 ${(
            -risk.dailyLossLimitPct * sessionStartEquity
          ).toFixed(2)}) → 전량 청산 및 당일 신규진입 차단`
        );
        for (const bar of group.bars) {
          const pos = positions.get(bar.symbol);
          if (pos) closePosition(pos, bar.c, bar.t, "MARKET", "DAILY_LOSS_LIMIT", session);
        }
        // 다른 심볼 포지션도 마지막 종가로 청산.
        for (const pos of [...positions.values()]) {
          const lb = lastBar.get(pos.symbol);
          if (lb) closePosition(pos, lb.c, t, "MARKET", "DAILY_LOSS_LIMIT", session);
        }
        pending.clear();
      }
    }

    // (6) 전략 호출
    for (const bar of group.bars) {
      const hist = history.get(bar.symbol) ?? [];
      const ctx = makeContext(bar, session, hist);
      const output = strategy.onBar(bar, ctx);
      const warmup = strategy.warmupBars ?? 0;
      if (hist.length < warmup) continue; // 워밍업 구간 신호는 버린다.
      for (const signal of normalizeSignals(output)) {
        queueSignal(signal, bar, session);
      }
    }

    equityCurve.push({ t, equity: markToMarket(), cash });
  }

  // 스트림 종료 처리
  if (currentSession) finalizeSession(Number.POSITIVE_INFINITY);

  return {
    initialCapital: config.initialCapital,
    finalEquity: markToMarket(),
    trades,
    fills,
    equityCurve,
    daily,
    logs,
    warnings,
    barsProcessed,
    strategyName: strategy.name,
    strategyVersion: strategy.version,
    costParams: cost,
    riskConfig: risk,
  };

  // ─────────────────────────── 내부 함수 ───────────────────────────

  /** 현재 총자산 = 현금 + 포지션 평가액 (마지막 종가 기준). */
  function markToMarket(): number {
    let equity = cash;
    for (const pos of positions.values()) {
      const lb = lastBar.get(pos.symbol);
      const price = lb ? lb.c : pos.avgFillPrice;
      equity += pos.qty * price;
    }
    return equity;
  }

  function makeContext(bar: Bar, session: SessionInfo, hist: Bar[]): StrategyContext {
    const equity = markToMarket();
    const canEnter =
      !sessionHalted &&
      bar.t < session.forceExitMs &&
      (positions.has(bar.symbol) || positions.size < risk.maxConcurrentPositions);
    return {
      now: bar.t,
      symbol: bar.symbol,
      session,
      history: (symbol?: string) => (symbol ? history.get(symbol) ?? [] : hist),
      position: (symbol?: string) => toPublicPosition(positions.get(symbol ?? bar.symbol)),
      equity,
      cash,
      minutesToClose: (session.closeMs - bar.t) / 60_000,
      canEnter,
      params,
      log,
    };
  }

  function toPublicPosition(pos: OpenPosition | undefined): Position | null {
    if (!pos) return null;
    return {
      symbol: pos.symbol,
      qty: pos.qty,
      avgPrice: pos.avgFillPrice,
      openedAt: pos.openedAt,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      maxHoldBars: pos.maxHoldBars,
      costPaid: pos.entryCommission + pos.entrySlippage + pos.entryFx,
      entryBarIndex: pos.entryBarIndex,
    };
  }

  /** 전략 신호를 다음 봉용 대기주문으로 적재한다. */
  function queueSignal(signal: Signal, bar: Bar, session: SessionInfo): void {
    const symbol = signal.symbol || bar.symbol;
    const orderType: SignalOrderType = signal.orderType ?? "MARKET";
    if (orderType === "LIMIT" && !(signal.limitPrice && signal.limitPrice > 0)) {
      warnings.push(`[무시] LIMIT 신호에 limitPrice 가 없습니다 (${symbol} @ ${bar.t})`);
      return;
    }

    const pos = positions.get(symbol);

    if (signal.kind === "EXIT") {
      if (!pos) return; // 포지션 없으면 무시
      pushPending(symbol, {
        symbol,
        side: pos.qty > 0 ? "SELL" : "BUY",
        isExit: true,
        orderType,
        limitPrice: signal.limitPrice ?? null,
        qty: signal.qty ?? Math.abs(pos.qty),
        sizePct: null,
        stopLoss: null,
        takeProfit: null,
        maxHoldBars: null,
        barsRemaining: signal.validForBars ?? 1,
        reason: signal.reason,
        createdAt: bar.t,
      });
      return;
    }

    // 신규/증량 진입
    if (sessionHalted) return;
    if (bar.t >= session.forceExitMs) return; // 강제청산 구간에서는 신규진입 금지
    if (signal.kind === "SELL" && !pos && !risk.allowShort) {
      warnings.push(`[무시] 공매도 비허용 설정에서 SELL 진입 신호 (${symbol} @ ${bar.t})`);
      return;
    }
    if (!pos && positions.size >= risk.maxConcurrentPositions) {
      warnings.push(`[무시] 동시 보유 종목수 한도(${risk.maxConcurrentPositions}) 초과 (${symbol})`);
      return;
    }

    // 매도 계획 강제 — 살 때 이미 언제 팔지가 정해져 있어야 한다.
    if (risk.requireExitPlan) {
      const missing: string[] = [];
      if (signal.stopLoss === undefined) missing.push("stopLoss");
      if (signal.takeProfit === undefined) missing.push("takeProfit");
      if (signal.maxHoldBars === undefined) missing.push("maxHoldBars");
      if (missing.length > 0) {
        throw new Error(
          `EXIT_PLAN_REQUIRED: ${symbol} 진입 신호에 매도 계획이 없습니다 (누락: ${missing.join(", ")}). ` +
            `requireExitPlan=true 에서는 손절가·익절가·최대보유봉수를 진입 시점에 전부 정해야 합니다.`
        );
      }
    }

    pushPending(symbol, {
      symbol,
      side: signal.kind === "BUY" ? "BUY" : "SELL",
      isExit: false,
      orderType,
      limitPrice: signal.limitPrice ?? null,
      qty: signal.qty ?? null,
      sizePct: signal.sizePct ?? null,
      stopLoss: signal.stopLoss ?? null,
      takeProfit: signal.takeProfit ?? null,
      maxHoldBars: signal.maxHoldBars ?? null,
      barsRemaining: signal.validForBars ?? 1,
      reason: signal.reason,
      createdAt: bar.t,
    });
  }

  function pushPending(symbol: string, order: PendingOrder): void {
    const list = pending.get(symbol) ?? [];
    list.push(order);
    pending.set(symbol, list);
  }

  /** (2) 직전 봉에서 적재된 대기주문을 이 봉에서 체결 시도. */
  function fillPendingOrders(bar: Bar, session: SessionInfo): void {
    const list = pending.get(bar.symbol);
    if (!list || list.length === 0) return;

    const survivors: PendingOrder[] = [];
    for (const order of list) {
      // 같은 봉에서 만들어진 주문은 다음 봉부터 유효 (lookahead 차단의 핵심).
      if (order.createdAt >= bar.t) {
        survivors.push(order);
        continue;
      }

      const refPrice = resolveFillReference(order, bar);
      if (refPrice === null) {
        order.barsRemaining -= 1;
        if (order.barsRemaining > 0) survivors.push(order);
        continue;
      }

      if (order.isExit) {
        const pos = positions.get(bar.symbol);
        if (!pos) continue;
        const qty = Math.min(order.qty ?? Math.abs(pos.qty), Math.abs(pos.qty));
        closePosition(pos, refPrice, bar.t, order.orderType, "EXIT_SIGNAL", session, qty);
      } else {
        openOrAdd(order, refPrice, bar, session);
      }
    }
    pending.set(bar.symbol, survivors);
  }

  /**
   * 주문의 체결 기준가를 정한다.
   * - MARKET: 봉 시가 (신호 발생 다음 봉의 시가에 들어간다는 현실적 가정)
   * - LIMIT : 봉 범위가 지정가에 닿아야 체결. 시가가 이미 유리하면 시가로 체결.
   */
  function resolveFillReference(order: PendingOrder, bar: Bar): number | null {
    if (order.orderType === "MARKET") return bar.o;
    const limit = order.limitPrice;
    if (limit === null) return null;
    if (order.side === "BUY") {
      if (bar.o <= limit) return bar.o; // 시가가 지정가보다 낮게 열림 → 더 유리한 시가 체결
      if (bar.l <= limit) return limit;
      return null;
    }
    if (bar.o >= limit) return bar.o;
    if (bar.h >= limit) return limit;
    return null;
  }

  /** 진입(신규/증량) 체결. */
  function openOrAdd(order: PendingOrder, refPrice: number, bar: Bar, session: SessionInfo): void {
    const existing = positions.get(bar.symbol);
    const equity = markToMarket();
    const qty = resolveQuantity(order, refPrice, equity);
    if (qty <= 0) {
      warnings.push(`[무시] 수량 0 으로 계산되어 진입 실패 (${bar.symbol} @ ${bar.t})`);
      return;
    }

    const breakdown = computeFillCost(cost, {
      side: order.side,
      refPrice,
      qty,
      orderType: order.orderType,
      barVolume: bar.v,
    });

    const signedQty = order.side === "BUY" ? qty : -qty;
    const cashDelta =
      order.side === "BUY"
        ? -(breakdown.fillPrice * qty) - breakdown.commission - breakdown.fxCost
        : breakdown.fillPrice * qty - breakdown.commission - breakdown.fxCost;

    if (order.side === "BUY" && cash + cashDelta < -1e-9) {
      warnings.push(`[무시] 현금 부족으로 진입 실패 (${bar.symbol} @ ${bar.t})`);
      return;
    }

    cash += cashDelta;
    sessionCost += breakdown.commission + breakdown.slippageCost + breakdown.fxCost;

    const reason: FillReason = existing ? "ADD" : "ENTRY";
    const fill: Fill = {
      t: bar.t,
      symbol: bar.symbol,
      side: order.side,
      qty,
      price: breakdown.fillPrice,
      refPrice,
      orderType: order.orderType,
      commission: breakdown.commission,
      slippageCost: breakdown.slippageCost,
      fxCost: breakdown.fxCost,
      reason,
    };
    fills.push(fill);

    if (existing) {
      const totalQty = existing.qty + signedQty;
      if (Math.abs(totalQty) < 1e-12) {
        // 반대 방향 증량으로 청산되는 경우는 지원하지 않는다 (EXIT 신호를 쓸 것).
        warnings.push(`[경고] 반대방향 진입으로 포지션이 0 이 되었습니다 (${bar.symbol})`);
        positions.delete(bar.symbol);
        return;
      }
      const prevAbs = Math.abs(existing.qty);
      const addAbs = qty;
      existing.avgFillPrice =
        (existing.avgFillPrice * prevAbs + breakdown.fillPrice * addAbs) / (prevAbs + addAbs);
      existing.avgRefPrice = (existing.avgRefPrice * prevAbs + refPrice * addAbs) / (prevAbs + addAbs);
      existing.qty = totalQty;
      existing.entryCommission += breakdown.commission;
      existing.entrySlippage += breakdown.slippageCost;
      existing.entryFx += breakdown.fxCost;
      if (order.stopLoss !== null) existing.stopLoss = order.stopLoss;
      if (order.takeProfit !== null) existing.takeProfit = order.takeProfit;
      if (order.maxHoldBars !== null) existing.maxHoldBars = order.maxHoldBars;
    } else {
      positions.set(bar.symbol, {
        symbol: bar.symbol,
        qty: signedQty,
        avgFillPrice: breakdown.fillPrice,
        avgRefPrice: refPrice,
        openedAt: bar.t,
        entryBarIndex: (history.get(bar.symbol)?.length ?? 1) - 1,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
        maxHoldBars: order.maxHoldBars,
        entryCommission: breakdown.commission,
        entrySlippage: breakdown.slippageCost,
        entryFx: breakdown.fxCost,
        sessionDate: session.date,
      });
    }

    const ctx = makeContext(bar, session, history.get(bar.symbol) ?? []);
    strategy.onFill?.(fill, ctx);
  }

  /** 포지션 사이징. 우선순위: 신호 qty > 신호 sizePct > risk.maxPositionPct. */
  function resolveQuantity(order: PendingOrder, price: number, equity: number): number {
    if (order.qty !== null && order.qty > 0) {
      return normalizeQty(order.qty);
    }
    const pct = Math.min(order.sizePct ?? risk.maxPositionPct, risk.maxPositionPct);
    const budget = Math.max(0, Math.min(equity * pct, order.side === "BUY" ? cash : equity * pct));
    return normalizeQty(budget / price);
  }

  function normalizeQty(qty: number): number {
    if (risk.allowFractionalShares) return roundTo(qty, 6);
    return Math.floor(qty + 1e-9);
  }

  /**
   * (3) 손절/익절 판정.
   * **경로 모호성**: 한 봉에서 손절가와 익절가가 모두 닿으면 손절을 먼저 처리한다 (보수적).
   * 갭 오픈으로 시가가 이미 손절/익절을 지나쳤으면 시가로 체결한다 (지정가보다 불리한 현실 반영).
   */
  function applyStopAndTarget(bar: Bar, session: SessionInfo): void {
    const pos = positions.get(bar.symbol);
    if (!pos) return;
    const isLong = pos.qty > 0;

    const stopHit =
      pos.stopLoss !== null && (isLong ? bar.l <= pos.stopLoss : bar.h >= pos.stopLoss);
    const targetHit =
      pos.takeProfit !== null && (isLong ? bar.h >= pos.takeProfit : bar.l <= pos.takeProfit);

    if (stopHit && pos.stopLoss !== null) {
      // 갭으로 시가가 이미 손절가를 지나쳤다면 시가 체결 (더 불리한 쪽).
      const refPrice = isLong
        ? Math.min(bar.o, pos.stopLoss)
        : Math.max(bar.o, pos.stopLoss);
      closePosition(pos, refPrice, bar.t, "MARKET", "STOP_LOSS", session);
      return;
    }
    if (targetHit && pos.takeProfit !== null) {
      const refPrice = isLong
        ? Math.max(bar.o, pos.takeProfit)
        : Math.min(bar.o, pos.takeProfit);
      closePosition(pos, refPrice, bar.t, "LIMIT", "TAKE_PROFIT", session);
      return;
    }

    // 시간 청산: 손절·익절 어느 쪽에도 닿지 않은 채 계획한 보유 봉 수를 넘기면 정리한다.
    // 손절/익절보다 뒤에 두는 이유 — 같은 봉에서 가격 조건이 먼저 성립했다면 그쪽이 실제 체결이다.
    if (pos.maxHoldBars !== null) {
      const barIndex = (history.get(bar.symbol)?.length ?? 1) - 1;
      if (barIndex - pos.entryBarIndex >= pos.maxHoldBars) {
        closePosition(pos, bar.c, bar.t, "MARKET", "TIME_EXIT", session);
      }
    }
  }

  /** 포지션 청산(전량 또는 일부). Trade 레코드를 만든다. */
  function closePosition(
    pos: OpenPosition,
    refPrice: number,
    t: number,
    orderType: SignalOrderType,
    reason: FillReason,
    session: SessionInfo,
    qtyOverride?: number
  ): void {
    const posAbs = Math.abs(pos.qty);
    const qty = Math.min(qtyOverride ?? posAbs, posAbs);
    if (qty <= 0) return;
    const isLong = pos.qty > 0;
    const side: "BUY" | "SELL" = isLong ? "SELL" : "BUY";

    const breakdown = computeFillCost(cost, { side, refPrice, qty, orderType });

    cash += isLong
      ? breakdown.fillPrice * qty - breakdown.commission - breakdown.fxCost
      : -(breakdown.fillPrice * qty) - breakdown.commission - breakdown.fxCost;

    // 부분청산이면 진입 비용을 비례 배분한다.
    const share = qty / posAbs;
    const entryCommission = pos.entryCommission * share;
    const entrySlippage = pos.entrySlippage * share;
    const entryFx = pos.entryFx * share;

    const grossPnl = (isLong ? refPrice - pos.avgRefPrice : pos.avgRefPrice - refPrice) * qty;
    const commission = entryCommission + breakdown.commission;
    const slippageCost = entrySlippage + breakdown.slippageCost;
    const fxCost = entryFx + breakdown.fxCost;
    const netPnl = grossPnl - commission - slippageCost - fxCost;

    sessionRealizedGross += grossPnl;
    sessionCost += breakdown.commission + breakdown.slippageCost + breakdown.fxCost;
    sessionTradeCount += 1;

    const fill: Fill = {
      t,
      symbol: pos.symbol,
      side,
      qty,
      price: breakdown.fillPrice,
      refPrice,
      orderType,
      commission: breakdown.commission,
      slippageCost: breakdown.slippageCost,
      fxCost: breakdown.fxCost,
      reason,
    };
    fills.push(fill);

    const barIndex = (history.get(pos.symbol)?.length ?? 1) - 1;
    trades.push({
      symbol: pos.symbol,
      direction: isLong ? "LONG" : "SHORT",
      qty,
      entryTime: pos.openedAt,
      entryPrice: pos.avgRefPrice,
      exitTime: t,
      exitPrice: refPrice,
      grossPnl,
      commission,
      slippageCost,
      fxCost,
      netPnl,
      returnPct: netPnl / (pos.avgRefPrice * qty),
      exitReason: reason,
      barsHeld: Math.max(0, barIndex - pos.entryBarIndex),
      sessionDate: pos.sessionDate,
    });

    if (qty >= posAbs - 1e-12) {
      positions.delete(pos.symbol);
    } else {
      pos.qty = isLong ? pos.qty - qty : pos.qty + qty;
      pos.entryCommission -= entryCommission;
      pos.entrySlippage -= entrySlippage;
      pos.entryFx -= entryFx;
    }

    const lb = lastBar.get(pos.symbol);
    if (lb) {
      const ctx = makeContext(lb, session, history.get(pos.symbol) ?? []);
      strategy.onFill?.(fill, ctx);
    }
  }

  /**
   * 세션 마감 처리.
   * 강제청산 시각 이후 봉이 아예 없었던 경우(거래정지·데이터 공백)의 **폴백**으로,
   * 남은 포지션을 그 세션 마지막 봉 종가에 시장가 비용으로 청산한다.
   */
  function finalizeSession(_nextT: number): void {
    const session = currentSession;
    if (!session) return;

    for (const pos of [...positions.values()]) {
      const lb = lastBar.get(pos.symbol);
      const price = lb ? lb.c : pos.avgFillPrice;
      warnings.push(
        `[폴백청산] ${session.date} ${pos.symbol}: 강제청산 시각 이후 봉이 없어 마지막 종가(${price})로 청산했습니다.`
      );
      closePosition(pos, price, lb?.t ?? session.closeMs, "MARKET", "EOD_LIQUIDATION", session);
    }
    pending.clear();

    const endEquity = markToMarket();
    daily.push({
      date: session.date,
      startEquity: sessionStartEquity,
      endEquity,
      netPnl: endEquity - sessionStartEquity,
      grossPnl: sessionRealizedGross,
      cost: sessionCost,
      tradeCount: sessionTradeCount,
      haltedByLossLimit: sessionHalted,
    });
    currentSession = null;
  }
}

// ─── 타임라인 ───

interface BarGroup {
  t: number;
  bars: Bar[];
}

/** 심볼별 봉들을 시간 오름차순의 단일 타임라인으로 병합한다. 같은 시각은 심볼명 순. */
export function buildTimeline(barsBySymbol: Map<string, Bar[]>): BarGroup[] {
  const byTime = new Map<number, Bar[]>();
  for (const [symbol, bars] of barsBySymbol) {
    for (const bar of bars) {
      if (bar.symbol !== symbol) {
        throw new Error(`BAR_SYMBOL_MISMATCH: key=${symbol}, bar.symbol=${bar.symbol}`);
      }
      const list = byTime.get(bar.t) ?? [];
      list.push(bar);
      byTime.set(bar.t, list);
    }
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([t, bars]) => ({ t, bars: bars.sort((x, y) => x.symbol.localeCompare(y.symbol)) }));
}

/** 봉 배열을 ET 세션 날짜별로 묶는다 (리포트·캐시 저장용). */
export function groupBarsBySessionDate(bars: Bar[]): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const bar of bars) {
    const key = etDateKey(bar.t);
    const list = out.get(key) ?? [];
    list.push(bar);
    out.set(key, list);
  }
  return out;
}
