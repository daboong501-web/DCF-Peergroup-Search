# data/bars — 백테스트용 봉 데이터

## 디렉터리 구조

- `csv/` — 외부에서 조달한 CSV 봉. `src/trading/data/csvSource.ts` 의 `CsvBarSource` 가 읽는다.
- (`data/bars/{SYMBOL}/{interval}/{YYYY-MM-DD}.json`) — `scripts/fetch-bars.ts` 가 토스 API 로
  받아 쓰는 캐시 경로. 이 환경에서는 토스 API 호출이 불가하여 비어 있다.

---

## csv/SPY_daily_2010-2019.csv

| 항목 | 값 |
|---|---|
| 심볼 | `SPY` (SPDR S&P 500 ETF Trust) |
| 봉 단위 | **일봉 (1d)** |
| 기간 | **2010-01-04 ~ 2019-12-30** (2,516 거래일) |
| 컬럼 | `date,open,high,low,close,volume,dividends,splits` |
| 출처 | https://raw.githubusercontent.com/hackingthemarkets/datasets/master/spy.csv |
| 수집 시각 | 2026-08-10 (본 레포에 복사) |

### 알려진 한계 — 이 데이터로 무엇을 말할 수 있고 무엇을 말할 수 없는가

1. **무수정주가(unadjusted)다.** `dividends` 컬럼이 전부 `0.0`, `splits` 가 전부 `0` 으로
   채워져 있어 배당 조정이 되어 있지 않다. SPY 는 연 1.7~2.0% 를 분기배당하므로
   **매수후보유(buy-and-hold) 수익률은 연 약 2%p 과소평가**된다.
   반대로 **인트라데이(open→close) 수익률에는 영향이 없다** — 배당락은 오버나잇 구간에서
   발생하기 때문이다. 즉 오버나잇 수익은 과소평가되고 인트라데이 수익은 편향되지 않는다.
2. **일봉이다.** 분봉이 없으므로 S1(MIM-Close, 30분 신호), S2(Concretum, 30분 격자),
   S3(Mind-the-Gap, 15분 보유) 의 **원 명세를 충실히 백테스트할 수 없다.**
   `docs/auto-trading/03-backtest-report.md` §0 참조.
3. **2019-12-30 에서 끝난다.** 2020 코로나 폭락, 2021 밈주식 국면, 2022 금리인상 약세장,
   2023~2025 국면이 전부 빠져 있다. **저금리 강세장에 편중된 표본**이다.
4. **생존편향은 없다.** SPY 단일 종목이며 전 기간 상장 유지되었다.
   (생존편향은 S&P500 구성종목을 쓰는 S3 에만 해당하며, 이 환경에서는 S3 크로스섹션
   백테스트 자체가 불가능하다.)
5. **OHLC 만 있고 체결 경로가 없다.** 봉 안에서 고가와 저가 중 무엇이 먼저였는지 알 수 없다.
   엔진은 항상 손절이 먼저 닿았다고 가정한다 (보수적).

### 이 환경의 제약 (2026-08-10 기준)

실행 환경의 egress 프록시가 Yahoo Finance, stooq 등 **모든 시장데이터 호스트를 차단**한다
(403). 따라서 추가 데이터(특히 미국주식 1분봉)를 이 환경에서 조달할 수 없다.
사용자 로컬에서 토스 Open API 키로 `scripts/fetch-bars.ts` 를 돌리는 것이 유일한 경로이며
절차는 리포트 §5 에 있다.
