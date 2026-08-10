/**
 * 스크립트 구동 전략 — **엔진 단위테스트 전용 하네스**.
 *
 * "몇 번째 봉에서 어떤 신호를 낸다"를 미리 적어두고 엔진의 체결·비용·청산 로직만
 * 격리해서 검증한다. 시장을 예측하는 로직이 전혀 없으므로 백테스트 대상이 아니다.
 * 그래서 전역 레지스트리에도 등록하지 않는다 (CLI 로 실행 불가).
 */

import type { Strategy } from "../strategy";
import type { Bar, Signal, StrategyContext } from "../types";

export type ScriptedRule = (bar: Bar, ctx: StrategyContext, index: number) => Signal[] | null;

export function createScriptedStrategy(
  rule: ScriptedRule,
  options: { name?: string; warmupBars?: number } = {}
): Strategy<Record<string, unknown>> {
  const counters = new Map<string, number>();
  return {
    name: options.name ?? "scripted-test-harness",
    version: "0.0.0-test",
    warmupBars: options.warmupBars ?? 0,
    onSessionStart() {
      counters.clear();
    },
    onBar(bar, ctx) {
      const index = counters.get(bar.symbol) ?? 0;
      counters.set(bar.symbol, index + 1);
      return rule(bar, ctx, index);
    },
  };
}
