/**
 * 전략 플러그인 부트스트랩.
 *
 * 새 전략을 추가하는 방법:
 *   1) `src/trading/strategies/<이름>.ts` 에 `StrategyPlugin` 을 export 한다.
 *   2) 아래 registerBuiltinStrategies() 에 한 줄 추가한다.
 *   3) `npx tsx scripts/backtest.ts --strategy <이름>` 으로 즉시 실행된다.
 *
 * 전략 파일은 엔진·API·데이터 계층을 import 하면 안 된다. `../strategy` 와 `../types` 만 쓴다.
 * 이 제약이 백테스트-실거래 parity 를 지켜준다.
 */

import { strategyRegistry } from "../strategy";
import { noopPlugin } from "./noop";

let bootstrapped = false;

export function registerBuiltinStrategies(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  strategyRegistry.register(noopPlugin);
  // 실전 전략 플러그인은 여기에 추가한다.
}

export { strategyRegistry };
