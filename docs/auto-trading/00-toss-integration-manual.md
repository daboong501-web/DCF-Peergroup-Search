# 토스증권 Open API × Claude Code — 미국주식 자동매매 구축 매뉴얼

> 작성일: 2026-08-10 · 대상: 토스증권 계좌를 보유한 개인 투자자
> 기준 스펙: **토스증권 Open API OpenAPI 3.1.0, `info.version` = 1.1.1** (엔드포인트 20개)

---

## 0. 근거와 신뢰도 표기 규칙

| 표기 | 의미 |
|---|---|
| **[확인됨]** | **공식 OpenAPI 스펙 원문(v1.1.1) 및 공식 Overview 문서에서 직접 확인.** 경로·파라미터·enum·에러코드·설명문까지 원문 대조 완료 |
| **[2차자료]** | 공식 문서에서 확인되지 않고 블로그·검색 결과에만 존재. 검증 필요 |
| **[미확인]** | 스펙·문서에 없음. **추정하지 않고 미확인으로 남김** |

**스펙 사본 출처**: `github.com/beoks/tossinvest-skill` → `references/openapi.json` (공식 `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json` 캡처본), `references/official-overview.md`.
본 조사 환경은 `*.tossinvest.com` 이그레스가 차단되어 필자가 원본 URL 을 직접 열지 못했고, 위 사본을 파싱해 작성했습니다. **키 발급 후 최신 스펙과 버전(`info.version`)을 재대조하세요.**

**서버**: `https://openapi.tossinvest.com` (스펙 `servers` 단일 항목) [확인됨]
**연동 방식**: **REST API 만 제공. WebSocket 없음** — 공식 Overview 명시 [확인됨]

---

## 1. 전제 조건 및 신청 절차

### 1.1 공식 Quick Start [확인됨]

공식 Overview 문서의 3단계:

```
1. 클라이언트 등록
   → 토스증권 WTS 로그인 후 [설정] > [Open API] 메뉴에서
     client_id 와 client_secret 을 발급받습니다.
2. 액세스 토큰 발급
   → POST /oauth2/token (Client Credentials Grant)
3. API 호출
   → Authorization: Bearer {access_token}
     계좌·자산 및 주문 카테고리는 X-Tossinvest-Account: {accountSeq} 도 함께
```

> **개인 신청 가능 여부**: 공식 문서가 "토스증권 WTS 로그인 후 설정 메뉴에서 발급"이라고 기술하며,
> 별도 법인 심사·승인 단계를 규정하지 않습니다 → **개인 계좌 보유자가 직접 발급하는 구조** [확인됨].
> 다만 사전 신청/대기열 존재 여부와 소요 기간은 스펙 범위 밖 [미확인].

### 1.2 계좌 요건 [확인됨]

`GET /api/v1/accounts` 설명문 원문:

- 현재는 **종합매매(`BROKERAGE`) 계좌만 반환**하며, 계좌가 없으면 빈 배열
- **자녀계좌는 사용할 수 없음**
- `accountType` enum 은 `BROKERAGE` / `OVERSEAS_DERIVATIVES` / `PENSION_SAVINGS` / `RESHORING_INVESTMENT` 가 정의돼 있으나 **현재 `BROKERAGE` 만 노출**

⇒ **연금저축·ISA·자녀계좌로는 API 매매 불가.** 일반 종합위탁계좌가 필요합니다.

### 1.3 ⚠ 허용 IP 화이트리스트 [2차자료 — 그러나 아키텍처에 결정적]

- 발급 화면의 **[허용 IP 관리]** 에 호출 IP 를 등록해야 하며, 미등록 IP 는 키가 맞아도 **403 차단** [2차자료].
- 공식 스펙에는 403 `edge-blocked` ("허용되지 않은 요청입니다") 코드가 존재해 정황상 부합 [확인됨].
- **Vercel 서버리스는 고정 아웃바운드 IP 가 없습니다** (Enterprise Secure Compute 제외)
  ⇒ **이 레포를 Vercel 에 배포한 채로는 토스 API 호출이 실패할 가능성이 높습니다.** §5 아키텍처 결정의 근거.

### 1.4 사전 자격 요건 [확인됨]

에러코드 `422 prerequisite-required` = "약관 동의·위험 고지 등 사전 자격 요건을 충족하지 않았습니다."
⇒ **해외주식 거래 약관 동의는 토스 앱/WTS 에서 미리 완료**해 두세요. API 로는 해결 불가.

---

## 2. 인증 (OAuth 2.0)

### 2.1 토큰 발급 [확인됨]

**`POST /oauth2/token`** · Rate Limits Group `AUTH` (초당 5회)

```http
POST /oauth2/token HTTP/1.1
Host: openapi.tossinvest.com
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=xxx&client_secret=yyy
```

응답 (`OAuth2TokenResponse` — **공통 `result` envelope 을 쓰지 않고 OAuth2 표준 형식**):
```json
{
  "access_token": "eyJraWQiOiIyMDI2LTA0LTAxLWtleSIsImFsZyI6IlJTMjU2In0...",
  "token_type": "Bearer",
  "expires_in": 86400
}
```

| 항목 | 값 |
|---|---|
| `access_token` 형식 | **JWT** |
| `token_type` | 항상 `Bearer` |
| `expires_in` | 만료까지 남은 초 (예시값 **86400 = 24시간**) |
| 리프레시 토큰 | **제공되지 않음.** 만료 시 동일 엔드포인트로 재발급 |
| 동시 유효 토큰 | **client 당 1개. 재발급 시 이전 토큰은 즉시 무효화** |

### 2.2 🚨 "client 당 토큰 1개" 의 실전 함의 [확인됨]

**재발급이 이전 토큰을 즉시 무효화**하므로:

- **여러 프로세스가 병렬로 토큰을 발급하면 서로를 죽입니다.** (봇 + MCP 서버 + 수동 테스트가 동시에 발급하면 전부 401)
- ⇒ **토큰 발급은 단일 프로세스/단일 캐시로 직렬화**해야 합니다.
- ⇒ 401 수신 시 대응: **재발급 1회 후 재시도**. 무한 재발급 루프는 자기 자신을 계속 무효화합니다.
- ⇒ Vercel 서버리스처럼 인스턴스가 여러 개 뜨는 환경은 **구조적으로 부적합**합니다.

### 2.3 요청 헤더 [확인됨]

```http
Authorization: Bearer {access_token}      # 모든 API 필수
X-Tossinvest-Account: 1                   # 계좌·자산·주문 카테고리 필수 (integer, int64)
Content-Type: application/json            # POST 계열
```

- `X-Tossinvest-Account` 값은 **`GET /api/v1/accounts` 응답의 `accountSeq`** (정수). 계좌번호 문자열이 아님.
- 누락 시 `400 account-header-required`, 존재하지 않는 계좌면 `404 account-not-found`.

### 2.4 응답 Envelope [확인됨]

```jsonc
// 성공 (200) — ApiResponse
{ "result": { /* 엔드포인트별 페이로드 */ } }

// 실패 (4xx/5xx) — ErrorResponse
{ "error": {
    "requestId": "01HXYZABCDEFG123456789",   // 응답 헤더 X-Request-Id 와 동일
    "code": "invalid-request",
    "message": "주문 방향이 올바르지 않습니다.",
    "data": { "field": "side", "allowedValues": ["BUY","SELL"] }  // 코드별 상이
} }
```
- `result` 와 `error` 는 **동시에 나타나지 않습니다.**
- `POST /oauth2/token` 만 이 envelope 을 쓰지 않습니다.
- CS 문의 시 `requestId` 첨부 권장. 누락 시 응답 헤더 `cf-ray` 첨부.

---

## 3. 미국주식 관련 API 인벤토리 (전 20개 엔드포인트) [확인됨]

### 3.1 전체 목록

| 카테고리 | Method | Path | operationId | Rate Group |
|---|---:|---|---|---|
| Auth | POST | `/oauth2/token` | `issueOAuth2Token` | `AUTH` |
| Market Data | GET | `/api/v1/prices` | `getPrices` | `MARKET_DATA` |
| Market Data | GET | `/api/v1/orderbook` | `getOrderbook` | `MARKET_DATA` |
| Market Data | GET | `/api/v1/trades` | `getTrades` | `MARKET_DATA` |
| Market Data | GET | `/api/v1/price-limits` | `getPriceLimit` | `MARKET_DATA` |
| Market Data | GET | `/api/v1/candles` | `getCandles` | **`MARKET_DATA_CHART`** |
| Stock Info | GET | `/api/v1/stocks` | `getStocks` | `STOCK` |
| Stock Info | GET | `/api/v1/stocks/{symbol}/warnings` | `getStockWarnings` | `STOCK` |
| Market Info | GET | `/api/v1/exchange-rate` | `getExchangeRate` | `MARKET_INFO` |
| Market Info | GET | `/api/v1/market-calendar/KR` | `getKrMarketCalendar` | `MARKET_INFO` |
| Market Info | GET | `/api/v1/market-calendar/US` | `getUsMarketCalendar` | `MARKET_INFO` |
| Account | GET | `/api/v1/accounts` | `getAccounts` | **`ACCOUNT`** |
| Asset | GET | `/api/v1/holdings` | `getHoldings` | `ASSET` |
| Order | **POST** | `/api/v1/orders` | `createOrder` | `ORDER` |
| Order | **POST** | `/api/v1/orders/{orderId}/modify` | `modifyOrder` | `ORDER` |
| Order | **POST** | `/api/v1/orders/{orderId}/cancel` | `cancelOrder` | `ORDER` |
| Order History | GET | `/api/v1/orders` | `getOrders` | `ORDER_HISTORY` |
| Order History | GET | `/api/v1/orders/{orderId}` | `getOrder` | `ORDER_HISTORY` |
| Order Info | GET | `/api/v1/buying-power` | `getBuyingPower` | `ORDER_INFO` |
| Order Info | GET | `/api/v1/sellable-quantity` | `getSellableQuantity` | `ORDER_INFO` |
| Order Info | GET | `/api/v1/commissions` | `getCommissions` | `ORDER_INFO` |

> 미국주식 자동매매에 **존재하지 않는 것**: 조건부/스톱로스 주문, 실시간 스트리밍(WebSocket),
> 환전, 예약주문, 종목 스크리닝/랭킹 — 전부 스펙에 없음 [확인됨: 20개가 전부].

### 3.2 시세 조회 (토큰만 필요, 계좌 헤더 불필요)

| Path | 필수 파라미터 | 선택 파라미터 | 비고 |
|---|---|---|---|
| `/api/v1/prices` | `symbols` | — | **최대 200종목 콤마구분.** 패턴 `^[A-Za-z0-9.,\-]+$` |
| `/api/v1/orderbook` | `symbol` | — | 호가 사다리 |
| `/api/v1/trades` | `symbol` | — | 최근 체결 |
| `/api/v1/price-limits` | `symbol` | — | 미국주식은 상하한가 개념이 없어 값 없음 |
| `/api/v1/candles` | `symbol`, `interval` | `count`, `before`, `adjusted` | **§3.5 병목** |
| `/api/v1/stocks` | `symbols` | — | 종목명·시장·통화·상장상태·발행주식수 |
| `/api/v1/stocks/{symbol}/warnings` | — | — | 정리매매·단기과열·투자경고/위험·VI |
| `/api/v1/exchange-rate` | — | — | KRW↔USD |
| `/api/v1/market-calendar/US` | — | `date` (YYYY-MM-DD, **미국 현지 날짜**) | §4.3 |

`PriceResponse` [확인됨]:
```jsonc
{ "symbol": "AAPL",
  "timestamp": "2026-03-25T09:30:00.123+09:00",  // nullable (체결 미발생 시)
  "lastPrice": "185.50",                          // ★ decimal "문자열"
  "currency": "USD" }
```
> ⚠ **모든 수치가 decimal 문자열**입니다 (`maxLength: 30`). 금액 계산은 문자열/Decimal 로 유지하고,
> 부동소수점 반올림 오차가 주문 가격에 새어 들어가지 않게 하세요.

### 3.3 계좌 조회 (`X-Tossinvest-Account` 필수)

| Path | 파라미터 | 응답 핵심 |
|---|---|---|
| `/api/v1/accounts` | — (**계좌 헤더 불필요**) | `accountSeq` 획득처 |
| `/api/v1/holdings` | `symbol` (선택) | KR·US 주식만. **해외 옵션·채권 제외.** `symbol` 지정 시 요약도 해당 종목 기준 재계산 |
| `/api/v1/buying-power` | `currency` (**필수**, `KRW`\|`USD`) | `cashBuyingPower` — **미수 미발생 기준 순현금** |
| `/api/v1/sellable-quantity` | `symbol` (필수) | `sellableQuantity` — **KR: 정수 / US: 소수점 포함 가능** |
| `/api/v1/commissions` | `symbol` | `commissionRate` — **% 단위** ("0.015" = 0.015%). 해외주식은 `startDate` null |

> **미국주식 단타는 반드시 `currency=USD`.** `cashBuyingPower` 는 **미수 미발생 기준**이므로
> 이 값을 넘겨 주문하면 `422 insufficient-buying-power`.

### 3.4 주문

| 기능 | Method + Path | 응답 |
|---|---|---|
| 주문 생성 | `POST /api/v1/orders` | `OrderResponse` → `orderId`, `clientOrderId` |
| 주문 정정 | `POST /api/v1/orders/{orderId}/modify` | `OrderOperationResponse` → **새 orderId** |
| 주문 취소 | `POST /api/v1/orders/{orderId}/cancel` | `OrderOperationResponse` → **새 orderId** (바디 `{}` 선택) |
| 주문 목록 | `GET /api/v1/orders` | `status` **필수** (`OPEN`\|`CLOSED`) |
| 주문 상세 | `GET /api/v1/orders/{orderId}` | `Order` |

> 🚨 **정정/취소는 새 orderId 를 발급합니다.** 스펙 원문: *"정정/취소로 새로 발급된 주문 식별자.
> 원주문의 orderId 와 다릅니다."* 상태머신에서 원본 orderId 를 계속 추적하면 주문을 잃어버립니다.

**`GET /api/v1/orders` 의 페이징 동작이 status 에 따라 다름** [확인됨]:

| status | 동작 |
|---|---|
| `OPEN` | `PENDING`, `PARTIAL_FILLED`, `PENDING_CANCEL`, `PENDING_REPLACE` 를 **전량 반환**. `limit`/`cursor` **무시**. `from`/`to` 만 적용 |
| `CLOSED` | `FILLED`, `CANCELED`, `REJECTED`, `REPLACED` 등. `limit`(기본 20, 최대 100)·`cursor`·`from`/`to` 모두 적용 |

⇒ **미체결 전량 취소 루틴은 `status=OPEN` 한 번으로 페이지네이션 없이 끝납니다.** 청산 로직에 유리.

**`OrderStatus` enum (10종)** [확인됨]:
`PENDING` · `PENDING_CANCEL` · `PENDING_REPLACE` · `PARTIAL_FILLED` · `FILLED` · `CANCELED` · `REJECTED` · `CANCEL_REJECTED` · `REPLACE_REJECTED` · `REPLACED`

> - `CANCELED`/`REJECTED`/`REPLACED` 도 **`execution.filledQuantity` 로 부분체결 여부를 확인**해야 합니다. "취소됨 = 미체결"이 아닙니다.
> - `CANCEL_REJECTED`/`REPLACE_REJECTED` 는 **별도 주문 레코드로 생성**되고 원주문은 이전 상태로 복귀합니다.
> - 스펙 명시: *"클라이언트는 unknown code 를 허용하도록 구현해야 합니다."* → enum 을 닫지 말고 fallback 처리.

`Order` 필드: `orderId`, `symbol`, `side`, `orderType`, `timeInForce`, `status`, `price`, `quantity`, `orderAmount`, `currency`, `orderedAt`, `canceledAt`, `execution`

### 3.5 주문 바디 스키마 — `OrderCreateRequest` 는 `oneOf` 2변형 [확인됨]

#### 변형 A — `OrderCreateQuantityBased` (수량 기반)
필수: `symbol`, `side`, `orderType`, `quantity`

| 필드 | 타입/제약 | 설명 |
|---|---|---|
| `clientOrderId` | string, **최대 36자**, `^[a-zA-Z0-9\-_]+$` | **멱등성 키.** §7.4 |
| `symbol` | string | KRX: 6자리 숫자 / US: 영문 티커 |
| `side` | enum | `BUY` \| `SELL` |
| `orderType` | enum | **`LIMIT` \| `MARKET` — 이 둘뿐** |
| `timeInForce` | enum, 기본 `DAY` | **`DAY` \| `CLS`** ← §3.6 |
| `quantity` | string, **`^\d+$` (정수만!)**, 최대 30자 | 소수점 불가 |
| `price` | string, `^\d+(\.\d+)?$` | `LIMIT` 필수 / `MARKET` 전달 시 `400 invalid-request` |
| `confirmHighValueOrder` | boolean, 기본 false | 1억원 이상 주문 시 true 아니면 `400 confirm-high-value-required` |

#### 변형 B — `OrderCreateAmountBased` (금액 기반, **US MARKET 전용**)
필수: `symbol`, `side`, `orderType`(=`MARKET`), `orderAmount`

| 필드 | 제약 |
|---|---|
| `orderAmount` | 달러 금액. **체결 수량은 체결 시점 시장가로 결정** |
| 시간 제약 | **정규장에만 접수. 그 외 `422 amount-order-outside-regular-hours`** |
| `side` | `BUY` \| `SELL` 둘 다 허용 |

> 스펙 원문 대비: *"quantity 는 수량을 확정하고 비용이 변동, orderAmount 는 금액을 확정하고 수량이 변동."*

#### 정정 — `OrderModifyRequest`
필수: `orderType`

| 필드 | 제약 |
|---|---|
| `quantity` | **KR: 필수(양의 정수). US: 전달 불가 → `400 us-modify-quantity-not-supported`** |
| `price` | `LIMIT` 필수 / `MARKET` 전달 불가 |
| `confirmHighValueOrder` | **30억원 이상 주문은 이 플래그와 무관하게 `422 max-order-amount-exceeded`** |

⇒ **미국주식은 수량 정정 불가. 수량을 바꾸려면 취소 후 재주문.**

### 3.6 ★ `timeInForce` = `CLS` → LOC 주문 [확인됨 · 단타 설계의 핵심]

스펙 원문:
> `timeInForce`: 주문 유효 조건. 미전달 시 `DAY`. **`orderType` 과 결합되어 주문 방식이 결정됩니다 (예: `LIMIT` + `CLS` = LOC).**
> - `DAY`: 당일 유효. **정규장 종료까지 미체결분은 자동 취소됩니다.**
> - `CLS`: 장 마감 주문 (At the Close). **현재 미국 주식 + `orderType=LIMIT` 조합만 지원합니다.**

공식 예시 (`usLocBuy`):
```json
{ "symbol": "AAPL", "side": "BUY", "orderType": "LIMIT",
  "timeInForce": "CLS", "quantity": "10", "price": "185.5" }
```

| 조합 | 결과 | 지원 |
|---|---|---|
| `MARKET` + `DAY` | 시장가 | KR·US |
| `LIMIT` + `DAY` | 지정가 (장 종료 시 미체결분 자동취소) | KR·US |
| **`LIMIT` + `CLS`** | **LOC (종가 지정가)** | **US 전용** |
| `MARKET` + `CLS` (MOC) | — | **미지원** |

> **함의 1**: `DAY` 주문은 **정규장 종료 시 자동 취소**되므로, 미체결 지정가가 오버나이트로 남지 않습니다.
> **함의 2**: **LOC 로 확정적 당일청산 설계가 가능합니다** (§6.3).
> **함의 3**: MOC 가 없으므로 "무조건 종가 체결"은 불가 — LOC 는 종가가 지정가 조건을 만족해야 체결됩니다.

### 3.7 미국주식에서만 다른 점 총정리

| 항목 | 미국주식 | 근거 |
|---|---|---|
| **티커 표기법** | **영문 티커 그대로** (`AAPL`). 패턴 `^[A-Za-z0-9.\-]+$` — 대소문자·숫자·`.`·`-` 허용 | [확인됨] |
| **거래소 코드** | **없음.** 어떤 엔드포인트에도 exchange 파라미터가 존재하지 않음 | [확인됨] |
| **시장 구분** | 주문 바디에 market 필드 없음 — **심볼로 서버가 판별** | [확인됨] |
| **통화** | `USD` (`Currency` enum = `KRW`\|`USD`) | [확인됨] |
| **가격 정밀도** | **$1 미만 → 소수점 4자리 / $1 이상 → 소수점 2자리. 초과 자릿수는 절삭(truncate)** | [확인됨] |
| **호가단위 검증** | KR 만 `invalid-tick-size` 계열 검증. US 는 절삭 처리 | [확인됨] |
| **상하한가** | US 는 일일 가격제한 없음 | [확인됨] |
| **주문 수량** | **정수만** (`^\d+$`) | [확인됨] |
| **소수점 매매** | `orderAmount`(달러 금액) 방식만. **US MARKET 전용 + 정규장 한정** | [확인됨] |
| **보유 소수점 수량** | `sellableQuantity` 는 **US 는 소수점 포함 가능** | [확인됨] |
| **수량 정정** | **불가** (`us-modify-quantity-not-supported`) | [확인됨] |
| **LOC** | **US + LIMIT 전용** | [확인됨] |
| **환전** | **API 없음** | [확인됨: 20개 목록에 부재] |
| **수수료** | `commissions` 의 `startDate`/`endDate` 가 해외주식은 null | [확인됨] |

### 3.8 🚨 소수점 포지션의 청산 함정 [확인됨 · 스펙 교차검증으로 발견]

```
orderAmount 로 $100 어치 AAPL 매수  →  0.539 주 보유
                                        ↓
              sellableQuantity = "0.539"  (US는 소수점 반환)
                                        ↓
              quantity 로 매도?  →  quantity 는 ^\d+$ (정수만) → 0.539 전달 불가
              orderAmount 로 매도? →  달러 금액 지정 → 정확히 0 으로 떨어뜨리기 어려움
                                     + 정규장에만 가능
```

**결론: 단타(당일청산) 전략에서는 소수점(`orderAmount`) 주문을 쓰지 마세요.**
정수 수량(`quantity`)만 사용하면 청산이 결정론적으로 끝납니다.
소수점 잔량을 정확히 0으로 만드는 공식 방법은 스펙에서 확인되지 않습니다 [미확인].

---

## 4. 레이트리밋 · 운영 제약

### 4.1 Rate Limits — 클라이언트 × API 그룹 단위 TPS [확인됨]

| Rate Limits Group | 요청 한도 | 피크시간(09:00~09:10 KST) | 해당 엔드포인트 |
|---|---|---|---|
| `AUTH` | 초당 5회 | — | `/oauth2/token` |
| **`ACCOUNT`** | **초당 1회** | — | `/accounts` |
| `ASSET` | 초당 5회 | — | `/holdings` |
| `STOCK` | 초당 5회 | — | `/stocks`, `/stocks/{s}/warnings` |
| `MARKET_INFO` | 초당 3회 | — | `/exchange-rate`, `/market-calendar/*` |
| **`MARKET_DATA`** | **초당 10회** | — | `/prices`, `/orderbook`, `/trades`, `/price-limits` |
| **`MARKET_DATA_CHART`** | **초당 5회** | — | `/candles` |
| **`ORDER`** | **초당 6회** | **초당 3회** | 주문 생성/정정/취소 |
| `ORDER_HISTORY` | 초당 5회 | — | `/orders`, `/orders/{id}` |
| `ORDER_INFO` | 초당 6회 | **초당 3회** | `/buying-power`, `/sellable-quantity`, `/commissions` |

**응답 헤더 (정상·429 모두 포함)** [확인됨]:

| 헤더 | 의미 |
|---|---|
| `X-RateLimit-Limit` | 현재 허용된 초당 요청 수 (burst capacity) |
| `X-RateLimit-Remaining` | 버킷에 남은 토큰 수 (429 시 0) |
| `X-RateLimit-Reset` | 토큰 1개 재충전까지 예상 초 |
| `Retry-After` | 재시도 권장 초 (**429 응답에만**) |

**공식 권장 429 대응**: `Retry-After` 만큼 대기 → 지수 백오프(1s→2s→4s) + jitter → `X-RateLimit-Remaining` 이 낮아지면 선제 감속.
429 코드: `rate-limit-exceeded`, `edge-rate-limit-exceeded`.

> 스펙 명시: **"한도는 운영 상황에 따라 사전 공지 없이 조정될 수 있다"** → 하드코딩 금지, `X-RateLimit-Limit` 기반 적응 필수.
>
> ⚠ **피크시간 완화(09:00~09:10 KST)는 한국장 개장 기준.** 미국장 개장(22:30/23:30 KST)에
> 동일한 축소가 적용되는지는 스펙에 없음 [미확인] → 미국장 개장 직후에도 초당 3회를 가정해 보수적으로 설계 권장.

### 4.2 ★ 스캐너 처리량 산술 — `MARKET_DATA_CHART` 가 병목

**두 축의 비대칭이 설계를 지배합니다:**

| | `/prices` (`MARKET_DATA`) | `/candles` (`MARKET_DATA_CHART`) |
|---|---|---|
| 초당 요청 | 10 | 5 |
| 요청당 종목 | **최대 200** | **1** |
| **초당 처리 종목** | **최대 2,000** | **최대 5** |

⇒ **현재가 스캔은 사실상 무제한, 캔들 스캔은 극도로 희소한 자원.**

**미국 정규장 = 390분 → 1분봉 하루치 = 390봉 → 200봉 상한이므로 종목당 2회 요청**

| 대상 종목 수 N | 하루치 1분봉 최초 적재 (2N req) | 소요(5 req/s) | 최신봉 1회 갱신 (N req) | 소요 |
|---:|---:|---:|---:|---:|
| 10 | 20 | 4초 | 10 | 2초 |
| 25 | 50 | 10초 | 25 | **5초** |
| 50 | 100 | 20초 | 50 | **10초** |
| 100 | 200 | 40초 | 100 | **20초** |
| 200 | 400 | 80초 | 200 | 40초 |
| 300 | 600 | 120초 | 300 | **60초 (한계)** |
| 500 | 1,000 | 200초 | 500 | 100초 (1분봉 주기 초과 ✗) |

**설계 규칙:**
1. **1분봉을 매 분 갱신 가능한 이론적 상한은 300종목** (60초 × 5 req/s). 여유를 두면 **실무 상한 ≈ 100~150종목**.
2. **넓게 보는 1차 스캔은 반드시 `/prices` 배치(200개)로.** 캔들은 좁힌 shortlist 에만.
3. **5분봉·15분봉은 존재하지 않습니다** — `interval` enum 은 **`1m`, `1d` 뿐** [확인됨]. 1분봉을 받아 **로컬에서 리샘플**하세요.
4. `count` 최대 200, `before`(ISO8601, **exclusive**) + 응답 `nextBefore` 로 페이지네이션. `adjusted` 기본 `true`(수정주가).

**권장 2계층 구조:**
```
[1계층] 감시 유니버스 (최대 200종목)
   /prices 배치 1회/초  →  가격·거래 이벤트 감지  (MARKET_DATA 10/s 중 1개만 소비)

[2계층] shortlist (10~30종목)
   /candles 1m  →  기술적 지표 계산·리샘플     (MARKET_DATA_CHART 5/s 로 2~6초마다 전량 갱신)
```

### 4.3 거래 시간 — `market-calendar/US` 를 정답으로 [확인됨]

**`GET /api/v1/market-calendar/US`** — `MARKET_INFO` (초당 3회)

- **4개 세션 각각 nullable**: `dayMarket`, `preMarket`, `regularMarket`, `afterMarket`
- **휴장 시 4세션 모두 null**
- **전일(`previousBusinessDay`) / 당일(`today`) / 익일(`nextBusinessDay`) 3영업일 반환**
- **모든 시간이 KST(+09:00) 기준** — 서머타임 계산 불필요
- `date` 파라미터는 **미국 현지 날짜** 기준

스펙 예시값 (2026-03-25, 서머타임 기간):

| 세션 | 스펙 예시 (KST) | 설명 |
|---|---|---|
| `dayMarket` | `09:00` ~ `16:50` | **데이마켓 세션 (토스증권)** — 토스 고유의 낮 시간대 거래 |
| `preMarket` | `17:00` ~ `22:30` | 프리마켓 |
| `regularMarket` | `22:30` ~ **익일 `05:00`** | 정규장 |
| `afterMarket` | 익일 `05:00` ~ `07:00` | 애프터마켓 |

> **`dayMarket` 은 토스증권이 제공하는 자체 세션**으로 스펙에 "데이마켓 세션 (토스증권)"이라고만 기술돼 있습니다.
> 한국 낮 시간(09:00~16:50 KST)에 미국주식을 거래하는 세션으로 보이나, **유동성·스프레드·주문유형 제약은 [미확인]**.
> 단타에 쓰려면 반드시 사전 검증하세요.

**참고 산술 (스펙 예시와 일치 확인):** 정규장 09:30~16:00 ET →
서머타임(EDT, KST−13) = **22:30~05:00 KST** / 표준시(EST, KST−14) = **23:30~06:00 KST**.
**그래도 하드코딩하지 마세요** — 미국 공휴일·조기폐장(13:00 ET 마감)·서머타임 전환을 캘린더가 모두 흡수합니다.

**세션별 주문 가능 여부:**

| 세션 | 주문 API 로 접수 가능? | 근거 |
|---|---|---|
| 정규장 | ✅ | [확인됨] |
| 프리/애프터/데이마켓 | **주문 바디에 세션 지정 필드가 없음.** 서버가 현재 시각으로 판단하며, 불가 시 `422 order-hours-closed` | [확인됨: 필드 부재 + 에러코드 존재] / 실제 접수 가능 여부는 [미확인] |
| 금액주문(`orderAmount`) | **정규장 전용** (`422 amount-order-outside-regular-hours`) | [확인됨] |

### 4.4 WebSocket — **없음** [확인됨]

공식 Overview 원문: **"토스증권 Open API 는 현재 REST API 만 제공합니다."**
⇒ 실시간 시세는 **폴링만**. §4.2 의 2계층 구조가 폴링 예산을 지키는 방법입니다.

### 4.5 주문 유형 지원 범위 총정리 [확인됨]

| 유형 | 지원 |
|---|---|
| 지정가 (LIMIT) | ✅ |
| 시장가 (MARKET) | ✅ |
| **LOC (LIMIT+CLS)** | ✅ **US 전용** |
| MOC / LOO / MOO | ❌ (`timeInForce` enum = `DAY`,`CLS` 뿐) |
| **STOP / STOP_LIMIT (손절주문)** | ❌ **스펙에 없음** |
| IOC / FOK / GTC | ❌ |
| 조건부·예약 주문 | ❌ 엔드포인트 자체가 없음 |

> 🚨 **서버측 스톱로스가 존재하지 않습니다.**
> 손절은 전적으로 **봇이 폴링으로 감시 → 시장가 청산**해야 합니다.
> **봇 프로세스가 죽으면 손절도 함께 죽습니다.** §5 에서 상시 서버를 요구하고 §7 안전장치를 필수로 두는 이유입니다.

---

## 5. Claude Code 연동 아키텍처

### 5.1 이 레포의 기존 구조 (실측)

```
app/api/[transport]/route.ts   ← createMcpHandler 로 전 툴 등록 (basePath "/api", maxDuration 60, verboseLogs)
src/services/tools/*.ts        ← 툴 1개 = 파일 1개. zod .strict() 스키마 + registerTool + 서비스 위임
src/services/{kicpa,opendart,naver}/  ← 업스트림 클라이언트 (axios, timeout 15000)
src/services/common/           ← stock-code-resolver 등 공통 리졸버
src/services/utils/            ← error-handler.ts(handleApiError), formatters.ts
vercel.json                    ← maxDuration 60
```

컨벤션 (`src/services/tools/naver-market-data.ts`, `src/services/naver/client.ts` 기준):
- zod 스키마는 `.strict()`, 각 필드에 **한글 `.describe()`**
- `registerTool(name, { title, description, inputSchema, annotations }, handler)`
- 반환 `{ content: [{ type: "text" as const, text }] }`, 실패 시 `isError: true`
- 에러는 전부 `handleApiError(error)` 로 통일
- **한글 주석·로그 유지**

### 5.2 두 방식 비교

| 축 | (A) 이 레포에 MCP 툴 추가 (Vercel) | (B) 독립 실행 봇 (고정 IP 상시 서버) |
|---|---|---|
| **허용 IP 화이트리스트** | ❌ Vercel 서버리스는 고정 아웃바운드 IP 없음 → 403 `edge-blocked` 위험 | ✅ VPS IP 등록으로 해결 |
| **"client 당 토큰 1개"** | ❌ **치명적.** 인스턴스마다 발급 → 상호 즉시 무효화 → 전면 401 | ✅ 단일 프로세스가 토큰 캐시 소유 |
| **손절·강제청산 (서버측 스톱 없음)** | ❌ 60초 실행 상한, 상시 감시 불가 | ✅ 상시 루프 |
| **레이트리밋 전역 관리** | ❌ 인스턴스 간 공유 상태 없음 → 그룹 한도 초과 | ✅ 단일 토큰버킷 |
| **1초 폴링** | ❌ Vercel Cron 최소 1분 (Hobby 는 1일 1회) | ✅ |
| **주문 멱등성** | △ `clientOrderId` 로 완화 가능하나 상태 추적이 어려움 | ✅ 로컬 상태 + `clientOrderId` |
| **Claude Code 대화형 조회** | ✅ 자연어 분석에 최적 | △ CLI 로 대체 |
| **기존 DART/네이버 툴과 결합** | ✅ | △ |

### 5.3 ✅ 권고안 — 역할 분리 하이브리드

> **"판단·조회는 MCP, 주문 루프는 독립 봇."**

```
┌──────────────────────────────────┐        ┌───────────────────────────────────┐
│ 이 레포 (Next.js MCP)             │        │ 독립 봇 (고정 IP VPS, 상시 실행)    │
│ ────────────────────────────     │        │ ─────────────────────────────     │
│ · 기존 DART/네이버/베타 툴         │        │ · 토큰 매니저 (단독 소유) ★        │
│ · toss_* 조회 전용 툴 (읽기)      │        │ · 그룹별 레이트리밋 토큰버킷        │
│ · Claude Code 가 대화형 분석      │        │ · /prices 1s 폴링 + /candles 2계층 │
│                                  │        │ · 주문 상태머신 · LOC 청산 · 폴백   │
│ ❌ 주문 툴 절대 금지               │        │ · 킬스위치 · 일일손실한도          │
│ (로컬 dev 에서만 사용 권장)        │        │ ✅ 주문은 오직 여기서만            │
└──────────────────────────────────┘        └───────────────────────────────────┘
                                                        │
                                        토스 Open API (이 VPS IP 만 허용 등록)
```

**핵심 근거는 "client 당 토큰 1개"** 입니다. 두 곳에서 토큰을 발급하면 서로를 죽이므로,
**MCP 서버와 봇을 동시에 라이브로 운영하려면 반드시 서로 다른 client(키쌍)를 쓰거나, MCP 는 봇의 내부 API 를 경유**해야 합니다.

**단계별 권고**
1. **1단계** — 이 레포에 **읽기 전용 `toss_*` 툴**만 추가. **로컬 `npm run dev` 에서만** 사용(로컬 공인 IP 등록). 실제 응답으로 스펙 검증.
2. **2단계** — 고정 IP VPS 에 독립 봇 배치. **주문 권한은 봇에만.**
3. **3단계(선택)** — 봇에 stdio MCP 서버를 내장해 Claude Code 가 봇 상태를 조회. **Vercel 쪽에는 끝까지 주문 툴을 두지 않습니다.**

### 5.4 코드 스켈레톤 (기존 컨벤션 준수)

#### `src/services/toss/types.ts`
```ts
// 토스증권 Open API 타입 (OpenAPI 스펙 v1.1.1 기준)
// 주의: 모든 수치 필드는 decimal "문자열"이다 (maxLength 30). 부동소수점 변환에 유의할 것.

/** 공통 성공 envelope. POST /oauth2/token 만 이 형식을 쓰지 않는다. */
export interface TossApiResponse<T> {
  result: T;
}

/** 공통 에러 envelope */
export interface TossErrorResponse {
  error: {
    requestId: string;
    code: string;      // 예: invalid-request, order-hours-closed
    message: string;
    data?: Record<string, unknown>;
  };
}

/** POST /oauth2/token — OAuth2 표준 형식 */
export interface TossTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number; // 만료까지 남은 초 (예시 86400)
}

/** GET /api/v1/prices — PriceResponse */
export interface TossPrice {
  symbol: string;
  timestamp: string | null; // 체결 미발생 시 null
  lastPrice: string;
  currency: "KRW" | "USD";
}

/** GET /api/v1/candles — CandlePageResponse. interval 은 1m | 1d 뿐이다. */
export interface TossCandle {
  timestamp: string;
  openPrice: string;
  highPrice: string;
  lowPrice: string;
  closePrice: string;
  volume: string;
  currency: "KRW" | "USD";
}
export interface TossCandlePage {
  candles: TossCandle[];
  nextBefore: string; // 다음(더 과거) 페이지 커서. before 파라미터에 그대로 전달
}

/** GET /api/v1/market-calendar/US — 4세션 각각 nullable, 휴장이면 전부 null */
export interface TossUsSession {
  startTime: string; // ISO8601, KST(+09:00)
  endTime: string;
}
export interface TossUsMarketDay {
  date: string;                      // 미국 현지 날짜
  dayMarket: TossUsSession | null;   // 토스증권 데이마켓
  preMarket: TossUsSession | null;
  regularMarket: TossUsSession | null;
  afterMarket: TossUsSession | null;
}
export interface TossUsMarketCalendar {
  today: TossUsMarketDay;
  previousBusinessDay: TossUsMarketDay;
  nextBusinessDay: TossUsMarketDay;
}

/** GET /api/v1/buying-power */
export interface TossBuyingPower {
  currency: "KRW" | "USD";
  cashBuyingPower: string; // 미수 미발생 기준 순현금
}

/** POST /api/v1/orders */
export interface TossOrderCreated {
  orderId: string;
  clientOrderId: string | null;
}

export type TossOrderStatus =
  | "PENDING" | "PENDING_CANCEL" | "PENDING_REPLACE" | "PARTIAL_FILLED"
  | "FILLED" | "CANCELED" | "REJECTED" | "CANCEL_REJECTED"
  | "REPLACE_REJECTED" | "REPLACED";
  // 스펙 주의: "클라이언트는 unknown code 를 허용하도록 구현해야 합니다."
```

#### `src/services/toss/client.ts`
```ts
import axios, { AxiosInstance } from "axios";
import type {
  TossApiResponse, TossTokenResponse, TossPrice, TossCandlePage,
  TossUsMarketCalendar, TossBuyingPower,
} from "./types";

const TOSS_API_BASE = "https://openapi.tossinvest.com";

// ★ 토스는 client 당 유효한 access token 이 1개뿐이며, 재발급 시 이전 토큰이 즉시 무효화된다.
//   따라서 토큰 발급은 반드시 프로세스 내에서 직렬화해야 하고,
//   여러 프로세스가 같은 client_id 로 병렬 발급하면 서로를 죽인다.
let cachedToken: { value: string; expiresAt: number } | null = null;
let inflight: Promise<string> | null = null;

const SKEW_MS = 60_000; // 만료 60초 전 선제 갱신

/** OAuth2 Client Credentials 로 access_token 을 획득한다 (캐시 우선, 발급은 직렬화). */
export async function getAccessToken(forceRefresh = false): Promise<string> {
  const now = Date.now();
  if (!forceRefresh && cachedToken && cachedToken.expiresAt - SKEW_MS > now) {
    return cachedToken.value;
  }
  // 동시 호출이 각자 발급해 서로를 무효화하지 않도록 in-flight 프로미스를 공유한다.
  if (inflight) return inflight;

  inflight = (async () => {
    const clientId = process.env.TOSS_CLIENT_ID;
    const clientSecret = process.env.TOSS_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      throw new Error("API_ERROR: TOSS_CLIENT_ID / TOSS_CLIENT_SECRET 환경변수가 없습니다.");
    }

    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
    });

    // 토큰 응답만 공통 result envelope 을 쓰지 않는다 (OAuth2 표준 형식).
    const res = await axios.post<TossTokenResponse>(`${TOSS_API_BASE}/oauth2/token`, form, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 15000,
    });

    cachedToken = {
      value: res.data.access_token,
      expiresAt: Date.now() + res.data.expires_in * 1000,
    };
    return cachedToken.value;
  })().finally(() => { inflight = null; });

  return inflight;
}

/** 인증 헤더가 붙은 axios 인스턴스. 계좌·자산·주문 계열은 accountSeq 를 넘긴다. */
async function authedClient(accountSeq?: number): Promise<AxiosInstance> {
  const token = await getAccessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  // 계좌·자산·주문 카테고리는 X-Tossinvest-Account 헤더가 필수다 (정수 accountSeq).
  if (accountSeq !== undefined) headers["X-Tossinvest-Account"] = String(accountSeq);
  return axios.create({ baseURL: TOSS_API_BASE, headers, timeout: 15000 });
}

/** 성공 응답은 { result: ... } envelope 으로 감싸여 온다. */
function unwrap<T>(body: TossApiResponse<T>): T {
  return body.result;
}

/**
 * 현재가 배치 조회. 최대 200종목을 콤마로 묶는다.
 * MARKET_DATA 그룹은 초당 10회이므로, 200종목 배치 1콜이 종목당 1콜보다 압도적으로 유리하다.
 */
export async function fetchPrices(symbols: string[]): Promise<TossPrice[]> {
  if (symbols.length === 0 || symbols.length > 200) {
    throw new Error("API_ERROR: symbols 는 1~200개여야 합니다.");
  }
  const client = await authedClient();
  const res = await client.get<TossApiResponse<TossPrice[]>>("/api/v1/prices", {
    params: { symbols: symbols.join(",") },
  });
  return unwrap(res.data);
}

/**
 * 캔들 조회. interval 은 "1m" 또는 "1d" 뿐이다 (5분봉·15분봉은 스펙에 없으므로 직접 리샘플해야 한다).
 * count 는 최대 200. 미국 정규장 390분치를 받으려면 nextBefore 로 2회 페이지네이션이 필요하다.
 * MARKET_DATA_CHART 는 초당 5회뿐이라 전체 스캔의 병목이다 — shortlist 에만 사용할 것.
 */
export async function fetchCandles(
  symbol: string,
  interval: "1m" | "1d",
  count = 200,
  before?: string
): Promise<TossCandlePage> {
  const client = await authedClient();
  const res = await client.get<TossApiResponse<TossCandlePage>>("/api/v1/candles", {
    params: { symbol, interval, count, adjusted: true, ...(before ? { before } : {}) },
  });
  return unwrap(res.data);
}

/**
 * 미국 장 운영 정보. 4세션(dayMarket/preMarket/regularMarket/afterMarket) 각각 nullable이고
 * 휴장이면 전부 null이다. 모든 시각이 KST 기준이므로 서머타임을 직접 계산하지 말 것.
 */
export async function fetchUsMarketCalendar(date?: string): Promise<TossUsMarketCalendar> {
  const client = await authedClient();
  const res = await client.get<TossApiResponse<TossUsMarketCalendar>>(
    "/api/v1/market-calendar/US",
    { params: date ? { date } : {} }
  );
  return unwrap(res.data);
}

/** 매수 가능 금액. 미국주식은 반드시 currency="USD". 미수 미발생 기준 순현금이다. */
export async function fetchBuyingPower(
  accountSeq: number,
  currency: "KRW" | "USD"
): Promise<TossBuyingPower> {
  const client = await authedClient(accountSeq);
  const res = await client.get<TossApiResponse<TossBuyingPower>>("/api/v1/buying-power", {
    params: { currency },
  });
  return unwrap(res.data);
}
```

#### `src/services/utils/error-handler.ts` 에 추가할 분기
```ts
// handleApiError 안, axiosErr.response 스위치에 추가한다.
// 토스는 { error: { requestId, code, message, data } } envelope 으로 내려준다.
case 400:
case 409:
case 422: {
  const e = (axiosErr.response.data as { error?: { code?: string; message?: string; requestId?: string } })?.error;
  if (e?.code) {
    return `Error: 토스 API 오류 [${e.code}] ${e.message ?? ""} (requestId: ${e.requestId ?? "-"})`;
  }
  return `Error: 토스 API 요청 거부 (HTTP ${axiosErr.response.status})`;
}
case 401:
  return "Error: 토스 인증 실패. 토큰이 만료되었거나(expired-token), 다른 프로세스가 토큰을 재발급해 무효화되었을 수 있습니다 (client 당 토큰 1개).";
case 403:
  return "Error: 토스 API 접근 거부(edge-blocked/forbidden). 호출 IP가 허용 IP 목록에 등록되어 있는지 확인하세요.";
case 429: {
  const retryAfter = axiosErr.response.headers?.["retry-after"];
  const remaining = axiosErr.response.headers?.["x-ratelimit-remaining"];
  return `Error: 토스 API 호출 한도 초과(rate-limit-exceeded). ${retryAfter ?? "?"}초 후 재시도 (remaining=${remaining ?? "-"}).`;
}
```

#### `src/services/tools/toss-us-quote.ts` (읽기 전용 툴)
```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fetchPrices } from "../toss/client";
import { handleApiError } from "../utils/error-handler";

const TossUsQuoteInputSchema = z.object({
  symbols: z.array(z.string().regex(/^[A-Za-z0-9.\-]+$/))
    .min(1).max(200)
    .describe("종목 심볼 배열. US는 영문 티커(예: 'AAPL'), KR은 6자리 숫자(예: '005930'). 최대 200개"),
  response_format: z.enum(["markdown", "json"])
    .default("markdown")
    .describe("출력 형식"),
}).strict();

type TossUsQuoteInput = z.infer<typeof TossUsQuoteInputSchema>;

export function registerTossUsQuoteTool(server: McpServer): void {
  server.registerTool(
    "toss_quote",
    {
      title: "토스증권 현재가 배치 조회",
      description: `토스증권 Open API로 현재가를 배치 조회합니다 (최대 200종목, 1회 호출).

Args:
  - symbols (string[]): 종목 심볼 배열 (US 티커 또는 KR 6자리)
  - response_format ('markdown' | 'json'): 출력 형식

[레이트리밋 주의]
WebSocket이 없어 REST 폴링만 가능합니다. MARKET_DATA 그룹은 초당 10회이며
1회 호출에 200종목까지 묶을 수 있으므로, 종목당 1콜 대신 반드시 배치로 묶으세요.`,
      inputSchema: TossUsQuoteInputSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params: TossUsQuoteInput) => {
      try {
        const prices = await fetchPrices(params.symbols);

        if (params.response_format === "json") {
          return { content: [{ type: "text" as const, text: JSON.stringify(prices, null, 2) }] };
        }

        const lines = [
          "## 토스증권 현재가",
          "",
          "| 종목 | 현재가 | 통화 | 기준시각 |",
          "|------|-------|------|---------|",
          ...prices.map((p) =>
            `| ${p.symbol} | ${p.lastPrice} | ${p.currency} | ${p.timestamp ?? "-"} |`
          ),
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error) }], isError: true };
      }
    }
  );
}
```

#### `app/api/[transport]/route.ts` 등록
```ts
import { registerTossUsQuoteTool } from "@/services/tools/toss-us-quote";
// ... createMcpHandler 콜백 안에서
    // 토스증권 Open API — 읽기 전용.
    // 주문 툴은 이 서버에 두지 않는다: 고정 IP 부재 + "client 당 토큰 1개" 제약 때문.
    registerTossUsQuoteTool(server);
```

#### 환경변수 (`.env.local` — 반드시 `.gitignore`)
```bash
TOSS_CLIENT_ID=...
TOSS_CLIENT_SECRET=...
TOSS_ACCOUNT_SEQ=1          # GET /api/v1/accounts 의 accountSeq
TOSS_DRY_RUN=true           # 기본 true
```

---

## 6. 미국장 단타(당일청산) 운영 매뉴얼

### 6.1 스케줄 — 캘린더 기반 동적 산출

**하드코딩 금지.** 매일 장 시작 전 `market-calendar/US` 를 호출해 `today.regularMarket.startTime/endTime`(KST)을 얻고 **역산**합니다.

```ts
const cal = await fetchUsMarketCalendar();
const reg = cal.today.regularMarket;
if (!reg) { log("오늘은 미국 휴장. 종료."); return; }   // 4세션 전부 null = 휴장

const open  = new Date(reg.startTime);
const close = new Date(reg.endTime);

const T_scan       = new Date(open.getTime()  - 30 * 60_000); // 개장 30분 전 스캔
const T_entryStart = new Date(open.getTime()  +  5 * 60_000); // 개장 5분 후 진입 허용
const T_noNewEntry = new Date(close.getTime() - 30 * 60_000); // 마감 30분 전 신규 중단
const T_locPlace   = new Date(close.getTime() - 25 * 60_000); // 마감 25분 전 LOC 제출
const T_forceExit  = new Date(close.getTime() - 10 * 60_000); // 마감 10분 전 강제 시장가
```

참고 시각 (서머타임/표준시):

| 이벤트 | EDT 기간 (KST) | EST 기간 (KST) |
|---|---|---|
| 정규장 개장 | 22:30 | 23:30 |
| 신규 진입 중단 (close−30m) | 04:30 | 05:30 |
| **LOC 제출 (close−25m)** | **04:35** | **05:35** |
| **강제 시장가 청산 (close−10m)** | **04:50** | **05:50** |
| 정규장 마감 | 05:00 | 06:00 |

> 조기폐장일(13:00 ET 마감)에도 위 코드가 자동으로 맞습니다 — 캘린더가 `endTime` 을 당겨주기 때문입니다.

### 6.2 데이 트레이딩 사이클

```
[장전 T-30m]
  ├ market-calendar/US → 휴장이면 즉시 종료. regularMarket 시각 확보
  ├ 킬스위치 확인 → ON 이면 종료
  ├ buying-power(USD) → 가용 USD 확인 (환전 API 없음 → 부족하면 알림 후 종료)
  ├ commissions(symbol) → 수수료율 확인 (손익분기 계산에 반영)
  └ 유니버스(≤200) 확정 + shortlist(≤30) 1분봉 하루치 적재 (2 req/종목)

[개장 +5m ~ close-30m] 진입·모니터링 (1초 루프)
  ├ /prices 배치 1콜 (유니버스 전체)          ← MARKET_DATA 10/s 중 1개만 소비
  ├ shortlist /candles 1m 갱신 (2~6초 주기)   ← MARKET_DATA_CHART 5/s
  ├ 진입 전 검사: 손실한도·포지션수·주문금액·중복(clientOrderId)
  ├ POST /orders  (LIMIT + DAY, quantity 정수)
  ├ GET /orders?status=OPEN 으로 미체결 추적 (전량 반환, 페이징 불필요)
  ├ 손절/익절 판정 → 청산 (서버측 스톱이 없으므로 봇이 직접)
  └ 429 → Retry-After 대기 + 지수백오프 + jitter

[close-30m] 신규 진입 전면 중단

[close-25m] ★ LOC 청산 1차 (§6.3)

[close-10m] ★ 시장가 청산 폴백 (§6.4)

[마감 후]
  └ GET /orders?status=CLOSED&from&to → 당일 체결 집계 (손익·수수료·환율 기록)
```

### 6.3 1차 청산 — LOC (`LIMIT` + `CLS`) [확인됨 스펙 기반]

미국주식 + `LIMIT` 조합에서만 `timeInForce=CLS` 가 지원되며, 이는 **LOC(Limit On Close)** 입니다.

```ts
/**
 * 1차 청산: LOC(LIMIT + CLS) 로 종가 청산을 예약한다.
 * LOC는 종가가 지정가 조건을 만족할 때만 체결되므로,
 * 매도 LOC의 지정가를 현재가보다 충분히 낮게(공격적으로) 두어 체결 확률을 높인다.
 * (MOC는 스펙에 없으므로 "무조건 종가 체결"은 불가능하다.)
 */
async function placeLocExit(accountSeq: number, symbol: string, qty: string, lastPrice: number) {
  // 공격적 지정가: 현재가 대비 -5%. 종가가 이보다 높기만 하면 체결된다.
  // US 가격 정밀도: $1 이상 소수점 2자리, $1 미만 4자리 (초과분은 서버가 절삭)
  const limit = formatUsPrice(lastPrice * 0.95);

  return placeOrder(accountSeq, {
    clientOrderId: `loc-${symbol}-${tradingDay()}`, // 멱등성: 10분간 유효
    symbol,
    side: "SELL",
    orderType: "LIMIT",
    timeInForce: "CLS",        // ★ LOC
    quantity: qty,             // 정수만 가능 (^\d+$)
    price: limit,
    confirmHighValueOrder: false,
  });
}

/** US 가격 정밀도 규칙에 맞춰 절삭한다 (반올림 아님 — 서버도 절삭한다). */
function formatUsPrice(v: number): string {
  const digits = v < 1 ? 4 : 2;
  const f = Math.pow(10, digits);
  return (Math.floor(v * f) / f).toFixed(digits);
}
```

**LOC 사용 시 주의 [미확인 포함]:**
- **LOC 접수 마감시각(cutoff)이 스펙에 없습니다** [미확인]. 미국 거래소는 통상 15:50 ET 전후로 LOC 신규/취소를 제한합니다.
  → **close−25m 에 제출**하도록 여유를 두고, `422 order-hours-closed` / `422 order-type-not-allowed` 수신 시 즉시 §6.4 폴백으로 전환하세요.
- LOC 는 **체결 보장이 아닙니다.** 반드시 §6.4 폴백과 쌍으로 설계하세요.
- 소수점 포지션은 `quantity` 가 정수만 허용되므로 LOC 청산이 불가능합니다 → §3.8 대로 **소수점 주문을 아예 쓰지 않는 것**이 정답.

### 6.4 2차 청산 — 시장가 강제 폴백 (close−10m) ★ 절대 생략 금지

```ts
/**
 * 강제 전량 청산. 정규장 종료 10분 전 실행한다.
 * 순서가 중요하다: 미체결 주문(진입 지정가 + LOC)을 먼저 취소하지 않으면
 * 매도가능수량이 잠겨 있어 시장가 청산이 거부되거나,
 * 422 opposite-pending-order-exists 로 막힐 수 있다.
 */
async function forceLiquidateAll(accountSeq: number) {
  // 1) 미체결 주문 전량 조회 — status=OPEN 은 전량 반환하므로 페이징이 필요 없다.
  const open = await listOrders(accountSeq, "OPEN");

  // 2) 전량 취소. 취소는 새 orderId 를 발급하므로 원본 id로 추적하지 않는다.
  for (const o of open) {
    try {
      await cancelOrder(accountSeq, o.orderId);
    } catch (e) {
      // already-filled / already-canceled / already-modified 는 정상 흐름이다 (409).
      if (!isBenignConflict(e)) throw e;
    }
    await sleep(200); // ORDER 그룹 초당 6회 준수
  }

  await sleep(2000); // 취소 반영 대기 (PENDING_CANCEL → CANCELED)

  // 3) 보유 종목별 시장가 전량 매도
  const holdings = await fetchHoldings(accountSeq); // ASSET 5/s — 루프 밖에서 1회만
  for (const h of holdings.filter((x) => x.marketCountry === "US")) {
    const { sellableQuantity } = await fetchSellableQuantity(accountSeq, h.symbol);

    // US는 소수점이 올 수 있으나 주문 quantity 는 정수만 허용된다.
    // 정수부만 시장가로 청산하고, 소수 잔량은 별도 경고로 남긴다.
    const whole = Math.floor(Number(sellableQuantity));
    const frac = Number(sellableQuantity) - whole;

    if (whole > 0) {
      await placeOrder(accountSeq, {
        clientOrderId: `exit-${h.symbol}-${tradingDay()}`, // 중복 실행 방지
        symbol: h.symbol,
        side: "SELL",
        orderType: "MARKET",
        quantity: String(whole),
        confirmHighValueOrder: false,
      });
      await sleep(200);
    }
    if (frac > 0) {
      await alertCritical(`${h.symbol}: 소수점 잔량 ${frac} 미청산 (quantity는 정수만 허용).`);
    }
  }

  // 4) 재확인 — "청산했다고 믿었는데 남아있는" 최악을 막는다.
  await sleep(5000);
  const remaining = (await fetchHoldings(accountSeq)).filter((x) => x.marketCountry === "US");
  if (remaining.length > 0) {
    await alertCritical(`청산 실패 잔여 포지션: ${remaining.map((r) => r.symbol).join(", ")}`);
  }
}
```

**이중화 권고**: 강제청산은 **메인 봇과 독립된 프로세스/호스트**에서도 한 번 더 트리거하세요.
`clientOrderId` 멱등성(10분 유효) 덕분에 **중복 실행이 안전**합니다 — 같은 키면 이전 주문 결과를 그대로 재반환합니다.

### 6.5 스케줄러 구성

| | Vercel Cron | 상시 서버(VPS) |
|---|---|---|
| 최소 주기 | 1분 (Hobby 1일 1회) | 제한 없음 |
| 실행 시간 | 60초 (`vercel.json`) | 무제한 |
| 고정 IP | ❌ | ✅ |
| 토큰 단일성 | ❌ 인스턴스마다 발급 → 상호 무효화 | ✅ |
| 손절 감시 (서버측 스톱 없음) | ❌ | ✅ |

**결론: 상시 서버 필수.** 성능이 아니라 **안전** 때문입니다.

```
systemd 구성 예시
  ├ toss-bot.service       : Restart=always, 상시 실행
  ├ 내부 스케줄러          : 매일 캘린더로 시각 재계산 (cron 표현식 하드코딩 금지)
  ├ toss-liquidator.timer  : 독립 강제청산 트리거 (멱등성으로 중복 안전)
  └ 워치독                 : 하트비트 끊기면 즉시 알림 + 청산 트리거
```

---

## 7. 리스크 · 법규 · 안전장치

### 7.1 에러 코드 전체 표 [확인됨 — 공식 Overview 원문]

| HTTP | 코드 | 발생 이유 | 봇 대응 |
|---|---|---|---|
| 400 | `invalid-request` | 호가 유형·방향·수량·금액·필수 파라미터 누락 등 | **재시도 금지.** 버그로 간주, 알림 |
| 400 | `confirm-high-value-required` | 1억원 이상인데 `confirmHighValueOrder` != true | 의도적이면 플래그 설정 |
| 400 | `account-header-required` | `X-Tossinvest-Account` 누락 | 버그 |
| 400 | `us-modify-quantity-not-supported` | US 정정에 `quantity` 전달 | 취소 후 재주문으로 전환 |
| 401 | `invalid-token` / `expired-token` | 토큰 무효·만료 | **재발급 1회 후 재시도** |
| 401 | `edge-blocked` | `Authorization` 헤더 미전달 | 버그 |
| 401 | `login-user-not-found` | 토큰 대응 로그인 정보 없음 | 알림 |
| 403 | `edge-blocked` / `forbidden` | 허용되지 않은 요청 / 권한 부족 | **IP 화이트리스트 확인** |
| 404 | `stock-not-found` / `exchange-rate-not-found` | 대상 없음 | 유니버스에서 제외 |
| 404 | `account-not-found` | accountSeq 오류 | 버그 |
| 404 | `order-not-found` | orderId 없음 | 상태 재조회 |
| **409** | `request-in-progress` | **동일 `clientOrderId` 요청 처리 중** | **대기 후 조회.** 재전송 금지 |
| **409** | `already-filled` / `already-canceled` / `already-modified` / `already-rejected` | 정정·취소 대상이 이미 종료 상태 | **정상 흐름.** 무시하고 진행 |
| 409 | `already-processing` | 동일 주문 정정/취소 처리 중 | 대기 후 조회 |
| 422 | `insufficient-buying-power` | 매수 가능 금액 부족 | 진입 스킵 |
| **422** | `order-hours-closed` | **주문 접수 불가 시간** | 세션 판정 재확인, 폴백 |
| 422 | `stock-restricted` | 거래 제한 종목 | 유니버스 제외 |
| 422 | `price-out-of-range` | 상/하한가 벗어남 | 가격 재산출 |
| **422** | `opposite-pending-order-exists` | **동일 종목 반대방향 대기주문 존재** | **먼저 취소 후 재시도** |
| 422 | `order-type-not-allowed` | 사용 불가 호가 유형 | **LOC 폴백 트리거** |
| 422 | `prerequisite-required` | 약관 동의·위험 고지 미충족 | 앱에서 수동 해결 |
| 422 | `amount-order-outside-regular-hours` | 금액주문 정규장 외 (US) | 수량주문으로 전환 |
| 422 | `modify-restricted` / `cancel-restricted` | 정정/취소 제한 주문 | 폴백 |
| 422 | `max-order-amount-exceeded` | 30억원 이상 주문 | 버그 |
| 429 | `rate-limit-exceeded` / `edge-rate-limit-exceeded` | 초당 한도 초과 | `Retry-After` + 백오프 |
| 500 | `internal-error` / `maintenance` | 서버 장애 / 점검 | 백오프. **주문은 재시도 전 반드시 조회** |

> 🚨 **주문 POST 는 자동 재시도 금지.** 타임아웃/500 시 재전송하면 중복 체결됩니다.
> `clientOrderId` 를 붙였다면 **10분 내 동일 키 재전송은 안전**하지만, 그 외에는
> **`GET /orders` 로 상태를 확인한 뒤에만** 판단하세요.

### 7.2 ★ `clientOrderId` — 중복주문 방지의 정답 [확인됨]

스펙 원문:
> 클라이언트 지정 주문 식별자. 멱등성 키로 사용됩니다.
> - **미전달: 멱등성 미적용. 매 요청을 별개 주문으로 처리합니다.**
> - **전달: 동일 값으로 재요청 시 이전 주문 결과를 그대로 재반환합니다.**
> - 서버는 자동 생성하지 않습니다. 최대 36자, 영숫자 및 `-`, `_` 허용.
> - **멱등성 키는 10분간 유효하며, 이후 동일 값으로 재요청 시 새 주문으로 처리됩니다.**

```ts
/**
 * 멱등키 설계 규칙
 *  - 반드시 전달할 것. 미전달 = 중복주문 무방비.
 *  - 36자 이내, ^[a-zA-Z0-9\-_]+$ (콜론·슬래시·한글 불가)
 *  - "재시도해도 같은 값"이어야 의미가 있다 → 시각(now) 을 넣으면 안 된다.
 *  - 10분 후 만료되므로, 장시간 재시도에는 멱등성이 사라진다. 그 뒤엔 조회로 확인할 것.
 */
function makeClientOrderId(kind: "entry" | "exit" | "loc", symbol: string, signalSeq: number) {
  // 예: entry-AAPL-20260810-17  (17자)
  return `${kind}-${symbol}-${tradingDay()}-${signalSeq}`.slice(0, 36);
}
```
- `409 request-in-progress` = 같은 키가 처리 중 → **대기 후 조회**. 재전송하지 마세요.

### 7.3 PDT · 결제주기 (자동매매 성립 여부를 좌우)

| 항목 | 내용 | 신뢰도 |
|---|---|---|
| PDT 규정 | 미국 FINRA 규정. **마진계좌**에서 5영업일 내 4회 이상 데이트레이딩 시 **최소 $25,000** 유지 요구 | [2차자료] |
| 적용 범위 | **마진계좌 대상. 현금계좌는 비대상** | [2차자료] |
| **토스증권 미국주식 계좌 적용 여부** | **[미확인]** — 스펙·공식문서 범위 밖. 국내 증권사 해외주식은 통상 현금(예수금) 기반이라 비대상이라는 것이 통설이나 **공식 확인 없음** | **[미확인]** |
| **매도대금 당일 재사용(재매수) 가능 여부** | **[미확인] · 단타 성립 여부를 좌우하는 최대 변수.** 미국 결제주기는 T+1 이며, 재사용이 막히면 **하루 1회전**밖에 못 함 | **[미확인]** |

> `buying-power` 가 **"미수거래를 제외한 현금 기반(미수 미발생 기준)"** 을 반환한다는 점 [확인됨] 은,
> 미결제 매도대금이 이 값에 즉시 반영되지 않을 가능성을 시사합니다.
> **드라이런 기간에 "매도 직후 buying-power 가 얼마나 증가하는지"를 반드시 실측하세요.** 이것이 회전율의 실질 상한입니다.

### 7.4 세금

| 항목 | 내용 |
|---|---|
| 세목 | 해외주식 **양도소득세** (분류과세, 금융소득종합과세 비대상) |
| 기본공제 | **연간 250만원** |
| 세율 | 초과분 **22%** (양도소득세 20% + 지방소득세 2%) |
| 신고 | 매년 **5월** 확정신고 (전년 1/1~12/31 실현손익) |
| 손익통산 | 같은 과세기간 내 해외주식 간 통산 가능. **이월공제 없음** |
| 환율 | 양도가액·취득가액 모두 **결제일 기준 환율**로 원화 환산 → 환차익도 과세 대상 |
| 수수료 | `commissions` 는 **% 단위** ("0.015" = 0.015%). 필요경비로 차감 |

> **단타 함의**: 회전율이 높으면 매년 실현손익이 확정됩니다. **이월공제가 없으므로**
> 연말에 손실 종목을 실현해 통산하는 것이 유효한 절세 수단입니다.
> 봇이 **연 누계 실현손익을 추적**하도록 만드세요.

### 7.5 환율 리스크

- 손익은 USD 로 발생하고 KRW 로 평가됩니다. **환전 API 가 없으므로 [확인됨] 봇은 USD 부족을 스스로 해결할 수 없습니다.**
- ⇒ **USD 예수금을 사전 확보**하고, 부족 시 **알림 후 당일 정지**하도록 설계하세요.
- `GET /api/v1/exchange-rate` 로 환율을 기록해 **USD·KRW 이중 장부**를 남기세요.

### 7.6 필수 안전장치

```ts
/** 자동매매 안전장치. 모든 기본값은 보수적이어야 한다. */
interface SafetyConfig {
  dryRun: boolean;                 // 기본 true. 주문 API 대신 의도만 로깅
  killSwitchPath: string;          // 이 파일이 존재하면 신규주문 중단 + 청산
  maxDailyLossUsd: number;         // 일일 손실 한도. 도달 시 전량청산 후 당일 종료
  maxPositionCount: number;        // 동시 보유 종목 수 상한
  maxOrderAmountUsd: number;       // 1주문 최대 금액 (fat-finger 방지)
  maxDailyOrderCount: number;      // 일일 주문 건수 상한 (폭주 방지)
  allowedSymbols?: string[];       // 화이트리스트
  noNewEntryBeforeCloseMin: number; // 마감 N분 전 신규 중단 (기본 30)
  locBeforeCloseMin: number;        // LOC 제출 (기본 25)
  forceExitBeforeCloseMin: number;  // 시장가 강제청산 (기본 10)
  useFractional: false;             // ★ 단타에서는 항상 false (§3.8)
}
```

| 안전장치 | 구현 |
|---|---|
| **드라이런** | `TOSS_DRY_RUN=true` 기본. **최소 1주일 드라이런 후 실거래** |
| **킬스위치** | 파일 존재 여부를 **매 루프마다** 확인 → 신규 중단 + 기존 포지션 청산 |
| **일일 손실 한도** | 도달 시 즉시 전량청산 + 당일 재진입 금지 |
| **주문 금액/수량 상한** | 주문 직전 하드 검증. 초과 시 **예외로 중단**(클램핑 금지 — 버그를 숨김) |
| **중복주문 방지** | **`clientOrderId` 필수 전달** (§7.2) + 로컬 in-flight 맵 |
| **주문 후 검증** | POST 성공 = 접수일 뿐. `GET /orders/{orderId}` 로 상태 확인 |
| **부분체결 처리** | `CANCELED`/`REJECTED`/`REPLACED` 도 `execution.filledQuantity` 확인 필수 |
| **레이트리밋** | 그룹별 토큰버킷 + `X-RateLimit-Remaining` 적응형 감속 |
| **재시도 정책** | 조회는 재시도 OK. **주문 POST 는 멱등키 없이 재시도 금지** |
| **unknown enum 허용** | 스펙 명시 요구사항. `OrderStatus`·`Currency` 등에 fallback |
| **시크릿 관리** | `.env` 는 `.gitignore`. **이 레포는 공개일 수 있으므로 키 커밋 절대 금지** |
| **감사 로그** | 주문 의도·요청·응답·orderId 변화·requestId 를 append-only 로 기록 |

### 7.7 법규 일반

- 개인이 **자기 계산으로** 자동매매하는 것은 문제 없습니다. **타인 자금 운용은 투자일임업 등록 대상**입니다.
- Open API 이용약관(호출 한도·재배포·상업적 이용)은 신청 시 원문 확인 필요 [미확인].
- 시세 데이터의 **재배포·제3자 제공은 통상 금지**입니다.

---

## 8. 미확인 항목 및 다음 확인 액션

### 8.1 미확인 목록

| # | 항목 | 영향도 | 확인 방법 |
|---|---|---|---|
| 1 | **매도대금 당일 재사용(재매수) 가능 여부 / 일일 회전 제한** | 🔴 최상 — 단타 성립 여부 | 드라이런 중 매도 직후 `buying-power` 증분 실측 + 고객센터 문의 |
| 2 | **LOC(CLS) 접수·취소 마감시각(cutoff)** | 🔴 최상 — 청산 설계 | 실계좌 소액 테스트로 마감 N분 전 접수 성공 시각 측정 |
| 3 | **프리마켓/애프터마켓/데이마켓에서 주문 접수 가능 여부** (바디에 세션 필드 없음) | 🔴 최상 | 각 세션에 소액 지정가 접수 → `422 order-hours-closed` 여부 확인 |
| 4 | **`dayMarket`(토스 데이마켓) 의 실체** — 유동성·스프레드·주문유형 제약 | 🟠 상 | 토스 고객센터 / 실측 |
| 5 | **소수점 포지션의 정확한 전량 청산 방법** (quantity 정수 제약) | 🟠 상 | 소수점 주문을 쓰지 않으면 회피 가능. 쓸 거면 고객센터 문의 |
| 6 | **PDT 룰의 토스 미국주식 계좌 적용 여부** | 🟠 상 | 고객센터 문의 |
| 7 | **미국장 개장 시각의 ORDER 그룹 피크 완화 적용 여부** (문서는 09:00~09:10 KST 만 명시) | 🟠 상 | 개장 직후 `X-RateLimit-Limit` 헤더 관측 |
| 8 | **허용 IP 화이트리스트** — 존재·등록 개수·반영 지연 (공식 문서 미기재, 2차자료만) | 🔴 최상 — 아키텍처 결정 | WTS 설정 화면 직접 확인 |
| 9 | 사전 신청 → 발급 가능까지 소요 기간 | 🟡 중 | 실제 신청 |
| 10 | Open API 이용약관 (재배포·상업적 이용·제재) | 🟡 중 | 신청 시 약관 원문 |
| 11 | 미국주식 실제 수수료율 값 | 🟡 중 | `GET /api/v1/commissions` 호출 |
| 12 | `execution` 객체의 상세 필드 (부분체결 수량·평균단가) | 🟡 중 | 스펙 `OrderExecution` 재확인 |
| 13 | WebSocket 지원 시점 | 🟢 하 | 공식 공지 모니터링 |
| 14 | 스펙 버전 갱신 (본 문서는 v1.1.1 기준) | 🟢 하 | `info.version` 주기적 확인 |

### 8.2 사용자 실행 체크리스트

```
□ 1.  토스증권 종합매매(BROKERAGE) 계좌 확인 — 연금/ISA/자녀계좌는 API 사용 불가
□ 2.  토스 앱/WTS 에서 해외주식 약관·위험고지 동의 완료 (미완 시 422 prerequisite-required)
□ 3.  WTS 로그인 → [설정] > [Open API] → client_id / client_secret 발급 (secret 즉시 백업)
□ 4.  ★ 봇을 돌릴 호스트를 먼저 정하고 그 고정 IP를 허용 IP에 등록
        (Vercel 배포본은 고정 IP가 없어 사용 불가)
□ 5.  POST /oauth2/token 으로 토큰 발급 확인
□ 6.  GET /api/v1/accounts → accountSeq 확보 (ACCOUNT 그룹 초당 1회이므로 캐시할 것)
□ 7.  GET /api/v1/market-calendar/US → 4세션 시각 확인, dayMarket 실체 파악
□ 8.  openapi.json 의 info.version 이 1.1.1 인지 확인, 다르면 본 문서 §3 재대조
□ 9.  읽기 전용 호출로 1주일 관측 (레이트리밋 헤더·응답 스키마 실측)
□ 10. 드라이런 1주일 — 특히 #1(매도대금 재사용), #2(LOC cutoff), #3(세션별 주문) 실측
□ 11. 최소 금액 실거래 — 안전장치 전부 ON, useFractional=false
```

---

## 참고 자료

**공식 1차 자료** (본 문서의 근거. 조사 환경에서는 이그레스 차단으로 사본을 사용)
- OpenAPI 스펙: `https://openapi.tossinvest.com/openapi-docs/latest/openapi.json` (**v1.1.1**, OpenAPI 3.1.0)
- Overview: `https://openapi.tossinvest.com/openapi-docs/overview.md`
- API 인덱스: `https://openapi.tossinvest.com/openapi-docs/latest/api-reference/README.md`
- 개발자 문서: `https://developers.tossinvest.com/docs` · 에이전트용 `https://developers.tossinvest.com/llms.txt`
- 소개: `https://corp.tossinvest.com/ko/open-api`

**사용한 스펙 사본**
- `github.com/beoks/tossinvest-skill` → `references/openapi.json`, `references/official-overview.md`, `references/workflows.md`, `scripts/tossinvest.py`

**[2차자료]** (허용 IP·신청 절차 등 공식 문서 미기재 항목)
- pulse-know.com / baseload.co.kr / braindetox.kr / sikiyo.com 의 2026년 토스 Open API 가이드 (WebSearch 요약)
- `github.com/JungHoonGhae/tossinvest-cli` — 공식 API + 비공식 WTS 하이브리드 클라이언트.
  ※ WTS 내부 API 경로는 **토스 이용약관 위반 소지**가 있으므로 자동매매에 사용하지 마세요.
