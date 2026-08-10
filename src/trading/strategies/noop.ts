/**
 * 아무 주문도 내지 않는 기준선 전략.
 *
 * 실제 매매 로직이 아니다. 인프라(데이터 로딩 → 엔진 → 지표 → 리포트) 배선이
 * 살아 있는지 확인하는 용도이며, 실전 전략은 다른 플러그인으로 등록된다.
 */

import { z } from "zod";
import type { Strategy, StrategyPlugin } from "../strategy";

const paramsSchema = z.object({}).passthrough();
type NoopParams = z.infer<typeof paramsSchema>;

export function createNoopStrategy(): Strategy<NoopParams> {
  return {
    name: "noop",
    version: "1.0.0",
    warmupBars: 0,
    onBar() {
      // 의도적으로 아무 신호도 내지 않는다.
      return null;
    },
  };
}

export const noopPlugin: StrategyPlugin<NoopParams> = {
  name: "noop",
  version: "1.0.0",
  paramsSchema,
  create: () => createNoopStrategy(),
};
