/**
 * 전략 인터페이스 — 이 인프라의 핵심 계약(contract).
 *
 * ## 설계 근거
 *
 * 1) **Lookahead bias 원천 차단**
 *    전략은 `onBar(bar, ctx)` 로만 호출되고, `ctx.history()` 에는 현재 봉까지만 들어 있다.
 *    엔진은 미래 봉을 컨텍스트에 넣지 않으며, 전략에게 원본 봉 배열을 넘기지 않는다.
 *    전략이 낸 신호는 **다음 봉**에서 체결된다 (같은 봉 종가로 체결하면 미래 정보를 쓰는 셈).
 *
 * 2) **백테스트 ↔ 실거래 parity**
 *    엔진(backtest)과 실행기(live)가 **동일한 Strategy 객체**를 그대로 소비한다.
 *    전략은 API 클라이언트·주문·체결·비용·리스크를 전혀 모른다. 그래서 이중 구현이 생기지 않는다.
 *
 * 3) **동기 함수로 고정**
 *    `onBar` 는 `async` 가 아니다. 비동기를 허용하면 실거래에서 봉 처리 순서가 뒤섞이고
 *    백테스트와 결과가 갈린다. 외부 조회가 필요하면 `init()` 단계에서 미리 받아 파라미터로 넣는다.
 *
 * 4) **전략은 의도만, 엔진이 실행**
 *    전략 반환값은 `Signal`(BUY/SELL/EXIT + 선택적 손절·익절·지정가)뿐이다.
 *    수량 결정, 체결 시뮬레이션, 수수료·슬리피지, 일일 손실한도, 당일청산은 모두 엔진 책임이다.
 */

import type { ZodType } from "zod";
import type { Bar, BarInterval, Fill, SessionInfo, Signal, StrategyContext } from "./types";

/** 전략 실행 모드. 동일 전략 객체가 세 모드에서 그대로 쓰인다. */
export type RunMode = "backtest" | "paper" | "live";

/** `init()` 에 전달되는 1회성 컨텍스트. 네트워크 조회 등 준비 작업은 여기서만 한다. */
export interface StrategyInitContext<P> {
  readonly params: P;
  readonly symbols: readonly string[];
  readonly interval: BarInterval;
  readonly mode: RunMode;
  log(message: string): void;
}

/** `onBar` 반환 타입. 아무것도 안 할 때는 아무거나 falsy 를 돌려주면 된다. */
export type SignalOutput = Signal | Signal[] | null | undefined | void;

/**
 * 전략 인터페이스.
 *
 * @typeParam P 전략 파라미터 타입. `paramsSchema` 로 zod 검증된 값이 주입된다.
 */
export interface Strategy<P = Record<string, unknown>> {
  /** 전략 식별자. 리포트/레지스트리 키로 쓰인다. */
  readonly name: string;

  /** 전략 버전. 파라미터·로직 변경 시 올려서 백테스트 결과의 재현성을 추적한다. */
  readonly version: string;

  /**
   * 이 전략이 판단을 시작하기 전에 필요한 최소 과거 봉 수.
   * 엔진은 `history().length < warmupBars` 인 동안 `onBar` 를 호출하되,
   * 전략이 낸 신호를 무시한다(워밍업 구간). 기본 0.
   */
  readonly warmupBars?: number;

  /** 파라미터 zod 스키마. 있으면 엔진이 실행 전에 검증한다. */
  readonly paramsSchema?: ZodType<P>;

  /** 1회 초기화. 실행 모드/심볼/파라미터를 받는다. */
  init?(ctx: StrategyInitContext<P>): void;

  /** 정규장 세션 시작 시 호출. 세션 단위 내부 상태를 리셋하는 자리. */
  onSessionStart?(session: SessionInfo): void;

  /**
   * 봉 1개 처리. **이 전략의 유일한 의사결정 지점.**
   *
   * @param bar 방금 마감된 봉. `ctx.history()` 의 마지막 원소와 동일하다.
   * @param ctx 현재 봉 시점까지의 상태. 미래 데이터는 절대 포함되지 않는다.
   * @returns 주문 의도. 엔진이 다음 봉에서 체결을 시도한다.
   */
  onBar(bar: Bar, ctx: StrategyContext): SignalOutput;

  /** 체결 통지. 전략이 자체 상태를 갱신할 때 사용 (선택). */
  onFill?(fill: Fill, ctx: StrategyContext): void;

  /** 정규장 세션 종료(강제청산 포함) 후 호출. */
  onSessionEnd?(session: SessionInfo): void;
}

/**
 * 전략 플러그인 등록 단위.
 * 다른 에이전트가 만드는 전략은 이 형태로 `strategyRegistry.register()` 하면 된다.
 */
export interface StrategyPlugin<P = Record<string, unknown>> {
  name: string;
  version?: string;
  /** 파라미터 스키마. 기본값은 zod `.default()` 로 표현한다. */
  paramsSchema?: ZodType<P>;
  /** 검증된 파라미터로 전략 인스턴스를 만든다. 매 실행마다 새 인스턴스가 생성된다. */
  create(params: P): Strategy<P>;
}

/** 전략 레지스트리. 이름 → 플러그인. */
export class StrategyRegistry {
  private readonly plugins = new Map<string, StrategyPlugin<never>>();

  register<P>(plugin: StrategyPlugin<P>): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`STRATEGY_ALREADY_REGISTERED: 전략 이름이 중복됩니다 (${plugin.name})`);
    }
    this.plugins.set(plugin.name, plugin as unknown as StrategyPlugin<never>);
  }

  has(name: string): boolean {
    return this.plugins.has(name);
  }

  list(): string[] {
    return [...this.plugins.keys()].sort();
  }

  /** 원시 파라미터를 zod 로 검증한 뒤 전략 인스턴스를 만든다. */
  create(name: string, rawParams: unknown = {}): Strategy<Record<string, unknown>> {
    const plugin = this.plugins.get(name);
    if (!plugin) {
      throw new Error(
        `STRATEGY_NOT_FOUND: '${name}' 전략이 없습니다. 등록된 전략: ${this.list().join(", ") || "(없음)"}`
      );
    }
    const schema = plugin.paramsSchema as ZodType<unknown> | undefined;
    let params: unknown = rawParams;
    if (schema) {
      const parsed = schema.safeParse(rawParams);
      if (!parsed.success) {
        throw new Error(
          `STRATEGY_PARAMS_INVALID: '${name}' 파라미터 검증 실패 — ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`
        );
      }
      params = parsed.data;
    }
    const create = plugin.create as (p: unknown) => Strategy<Record<string, unknown>>;
    return create(params);
  }
}

/** 프로세스 전역 레지스트리. 전략 플러그인 파일은 import 시점에 여기에 등록한다. */
export const strategyRegistry = new StrategyRegistry();

/** `onBar` 반환값을 항상 배열로 정규화한다. */
export function normalizeSignals(output: SignalOutput): Signal[] {
  if (!output) return [];
  return Array.isArray(output) ? output.filter(Boolean) : [output];
}
