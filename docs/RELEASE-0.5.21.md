# v0.5.21 — 스테이블코인이 달러가 아니라 TTL 로 재어진다

앵커: rate-snapshot.json `anchoredAt` = **2026-07-29**, 통화 **66 종**.
버전: 0.5.20 → **0.5.21**, versionCode 21 → **22**.

---

## 1. 결론

스테이블코인이 TTL 로 표시된다 — **맞음**(android·extension 홈 토큰 목록에 한정).
상장자산(BTC·ETH·SOL·TRX·WETH·WBTC)의 표시가 바뀌었다 — **틀림**(문자 하나 안 바뀜, USD 보조줄 유지).

산출물 v0.5.21: APK 1개 + 데스크톱 번들 2개 + 확장/웹 빌드.
`pnpm -r build` EXIT=0 · `pnpm -r typecheck` EXIT=0 · `pnpm -r test` EXIT=0, **943 통과 · 10 skip · 실패 0**
(계산: i18n 19 + wallet-sdk 711 + shell-core 95 + extension 118 = 943. 기준선 924 → +19, 증가분은 신규 `tests/stable-denom.test.ts` 19 케이스.)

사용자가 보는 변화 1건: USDT 100 개 행이 `≈ $100.00` → **`≈ 0.4054 TTL`**.

---

## 2. 환산 근거와 계산식

벼린 환율표(rate-snapshot.json, anchoredAt 2026-07-29):

```
perTtl = 명목GDP(자국통화) / 인구 / 365
tUSD.perTtl = 246.64798986458746        (1 TTL = 246.648 USD 액면)
→ 1 USD = 1 / 246.64798986458746 = 0.004054361037156683 TTL
```

환산식:

```
TTL = (baseUnits / 10^(토큰 자신의 decimals)) / perTtl(액면 통화)
```

USDT 100 개 (decimals 6, baseUnits 100_000_000):

```
100_000_000 / 10^6 = 100
100 / 246.64798986458746 = 0.40543610371566835 TTL
```

참고 환율(같은 스냅샷, 해당 액면 스테이블은 이번에 0종):
tKRW 141180.04441511573 → 1 KRW = 0.00000708 TTL / tJPY 14740.709198680186 → 1 JPY = 0.00006784 TTL / tEUR 123.07112411918769 → 1 EUR = 0.00812538 TTL.

### decimals 함정 — 안 피하면 10^12 배 틀린다

기존 `tokenAmountToTtl` 은 호출자 decimals 를 버리고 `rate.decimals` 를 쓴다. 그 설계는 토큰 주소 == rate 주소(t{ISO} 통화토큰)일 때만 옳다.
스테이블은 다른 컨트랙트다 — USDT decimals **6**, tUSD decimals **18**.
그대로 쓰면 `1e8 / 1e18 / 246.648 = 4.05e-13 TTL`. 정답 `0.405436 TTL` 대비 **10^12 배** 축소.
그래서 `stableAmountToTtl(baseUnits, tokenDecimals, rate)` 를 신설했다 — 수량은 토큰 자신의 decimals 로 풀고, rate 에서는 `perTtl` 만 쓴다.
decimals 는 **내장 목록 값**이 익스플로러 응답을 이긴다(익스플로러가 조작되면 표시 금액이 임의 배율로 부푼다).

---

## 3. 왜 스테이블은 되고 BTC 는 안 되는가

**경계는 "시장 시세를 입력으로 쓰느냐" 한 줄이다.**

- **스테이블코인**: 1 USDT ≡ 1 USD 는 **발행자가 선언한 액면 단위**다. 시장이 매긴 값이 아니다.
  그 액면 통화(USD)를 벼린 환율(GDP ÷ 인구 ÷ 365)로 TTL 에 옮기는 경로에서 시장 시세를 **한 번도 읽지 않는다**.
  입력은 ① 발행자 선언 단위 ② 저장소 안 GDP·인구 스냅샷, 두 개뿐이다. → **허용.**
- **BTC·ETH·SOL·TRX**: 이들의 달러값은 Binance **시장 시세**다. 이것을 TTL 로 옮기면 시장환율이 벼린 눈금 안으로 들어온다.
  docs/CONTEXT.md §5 "벼린 환율 = TTL 이 기준, 시장환율을 입력으로 쓰지 않는다" 를 정면으로 깬다. → **금지.** 지금처럼 Binance USD 보조줄로 남는다.
- **wrapped(WETH·WBTC·WAVAX)**: 이름이 페그처럼 보여도 값의 출처가 시장이다. 같은 이유로 **영구 제외**. `faceIso` 를 넣지 마라.
- **온체인 DEX 풀 가격**: 우회 경로로 검토했으나 그것도 시장가다. 같은 위반. **없다.**

즉 "BTC 도 같은 식으로 하면 되잖아" 의 답은 **틀림**이다 — BTC 에는 발행자가 선언한 액면이 존재하지 않는다.
이 문장은 `packages/wallet-sdk/src/tokens/registry.ts`(TokenInfo.faceIso 주석), `packages/wallet-sdk/src/chains/trc20-known.ts`, `packages/wallet-sdk/src/rates/stable.ts`, 두 셸의 `tokenIdentity` 주석에 남겼다.

또 하나의 경계: **신원 확인만으로는 부족하다.** WETH 는 이미 `evm-builtin` 신원을 갖는다. 조건은 `신원 확인 ∧ faceIso 등재` 둘 다다.

---

## 4. 대상 토큰 — 23건 (새 주소 0건)

전부 **이미 저장소 안 내장 목록에 있던 주소**다. 신뢰면은 넓어지지 않았고, 단위만 USD → TTL 로 바뀌었다.

| chainId | 체인 | 심볼 | 주소 | 액면 | decimals | 근거 출처 |
|---|---|---|---|---|---|---|
| 1 | Ethereum | USDC | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 | USD | 6 | tokens/registry.ts BUILTIN |
| 1 | Ethereum | USDT | 0xdAC17F958D2ee523a2206206994597C13D831ec7 | USD | 6 | 〃 |
| 1 | Ethereum | DAI | 0x6B175474E89094C44Da98b954EedeAC495271d0F | USD | 18 | 〃 |
| 10 | Optimism | USDC | 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 | USD | 6 | 〃 |
| 10 | Optimism | USDT | 0x94b008aA00579c1307B0EF2c499aD98a8ce58e58 | USD | 6 | 〃 |
| 10 | Optimism | DAI | 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1 | USD | 18 | 〃 |
| 56 | BSC | USDC | 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d | USD | 18 | 〃 |
| 56 | BSC | USDT | 0x55d398326f99059fF775485246999027B3197955 | USD | 18 | 〃 |
| 56 | BSC | DAI | 0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3 | USD | 18 | 〃 |
| 137 | Polygon | USDC | 0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359 | USD | 6 | 〃 |
| 137 | Polygon | USDT | 0xc2132D05D31c914a87C6611C10748AEb04B58e8F | USD | 6 | 〃 |
| 137 | Polygon | DAI | 0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063 | USD | 18 | 〃 |
| 8453 | Base | USDC | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | USD | 6 | 〃 |
| 8453 | Base | DAI | 0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb | USD | 18 | 〃 |
| 42161 | Arbitrum | USDC | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 | USD | 6 | 〃 |
| 42161 | Arbitrum | USDT | 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9 | USD | 6 | 〃 |
| 42161 | Arbitrum | DAI | 0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1 | USD | 18 | 〃 |
| 43114 | Avalanche | USDC | 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E | USD | 6 | registry.ts(2개 리스트 교차 확인 주석) |
| 43114 | Avalanche | USDT | 0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7 | USD | 6 | 〃 |
| 43114 | Avalanche | USDC.e | 0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664 | USD | 6 | 〃 |
| 43114 | Avalanche | USDT.e | 0xc7198437980c041c805A1EDcbA50c1Ce5db95118 | USD | 6 | 〃 |
| 43114 | Avalanche | DAI.e | 0xd586E7F844cEa2F87f50152665BCbc2C279D8d70 | USD | 18 | 〃 |
| — | TRON | USDT | TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t | USD | (없음) | chains/trc20-known.ts KNOWN_TRC20 |

합계 23 = EVM 22 + TRON 1. 실측: `registry.ts` 의 `faceIso: 'USD'` 22건, `trc20-known.ts` 1건, `listStableDenoms()` 반환 23건.

### 근거를 못 대서 **넣지 않은 것**

| 대상 | 왜 안 넣었나 |
|---|---|
| Solana USDC (EPjFWdd5…) | 저장소 안 등장 3곳이 전부 "SPL mint 주소 예시" 플레이스홀더. USDC 라고 단정한 문장 0건. Solana 는 내장 신원 목록 자체가 없다. |
| BUSD · TUSD | 구 `STABLE_USD` 에 **심볼로만** 있었고 주소 근거 0건. |
| KRW·EUR·JPY 액면 스테이블 | 저장소 안 주소 근거 0건. 구조는 ISO 문자열이라 근거가 생기면 항목당 1줄. |
| WETH · WBTC · WAVAX 등 wrapped | 값의 출처가 시장 시세. §3 위반. 영구 제외. |

TRON USDT 의 decimals 는 **비워 뒀다** — 저장소 안에 근거가 없다. 체인에서 읽는다. 추측해서 적지 않았다.

---

## 5. 검증

### 손계산 대조 (빌드된 dist 를 node 로 직접 호출)

| 입력 | 함수 결과 | 손계산 | 차이 |
|---|---|---|---|
| 100 USDT (100_000000n, d=6) | 0.40543610371566835 | 100 / 246.64798986458746 | 0 (double 완전 일치) |
| 100 USDT-BSC (100e18n, d=18) | 0.40543610371566835 | 동일 | 0 — rate.decimals 오염 없음 |
| 0.000001 USDT (1n, d=6) | 4.054361037156684e-9 | 1e-6 / 246.648 | 0 (표시는 `<0.0001`) |
| 100 (KRW 경로 대조) | 0.0007083154026072349 | 100 / 141180.04441511573 | 0 |
| rateByIso('XXX') | **null** (0 아님) | — | "가치 없음" 으로 오독되지 않는다 |

정밀도: `baseUnitsToNumber` 가 정수부/소수부를 분리해 변환하므로 상대오차 ≤ 2^-53 ≈ 1.11e-16. 정수부가 2^53(9,007,199,254,740,992 USDT)을 넘을 때만 접힘. 표시 자릿수(최대 4)에 도달하지 않는다.
가드: tokenDecimals 가 비정수/음수/36 초과면 null.

### 경계 (직접 실행 검증)

| 항목 | 결과 |
|---|---|
| 상장자산이 TTL 환산 경로를 타는가 | **0건**. 내장 목록 8체인 전수 순회 — W*/BTC/ETH/AVAX/BNB/MATIC/SOL/TRX 중 액면이 붙은 항목 0. WETH(0xC02a…) → null. |
| 가짜 USDT(임의 주소 + 심볼 'USDT') | **차단**. `unverified` → `tokens.value_unverified`. v0.5.20 게이트 유지. |
| `addCustomToken` 으로 faceIso 자칭 | **차단**. `faceIso: undefined` 로 지워진다. (desktop Wallet.tsx 가 저장소 유일한 실제 addCustomToken 호출 경로) |
| 체인 분리 | 같은 주소를 chainId 999 로 조회 → null. family 불일치 → null. |
| TRON base58 대소문자 | 소문자화한 문자열 → null. hex(41…) → null. |
| 심볼 경로 | `stableDenomOf` 시그니처에 symbol 인자가 **없다**. 키릴 유사문자 심볼 → null. |
| 스냅샷 오염 | RATE_SNAPSHOT 주소집합 ∩ 액면 색인 = **∅**. ExchangePane 견적 무변경. |
| 두 눈금 동시 표시 | 없음. faceIso 가 있으면 `tokenToUsd` 를 아예 호출하지 않는다. ISO 가 없어 TTL 이 null 이어도 USD 로 되돌아가지 않고 `tokens.value_unlisted`. |
| 가치 합계 | 저장소에 자산 가치 합산 화면 **0건**. 이번에 고칠 합계 없음. |

### 빌드·테스트

```
pnpm -r build      EXIT=0
pnpm -r typecheck  EXIT=0   (error TS 0건)
pnpm -r test       EXIT=0   943 통과 · 10 skip · 실패 0
   i18n 19 + wallet-sdk 711 + shell-core 95 + extension 118 = 943
   기준선 924 → +19 (신규 packages/wallet-sdk/tests/stable-denom.test.ts)
```
파이프로 종료코드를 가린 곳 0건.

---

## 6. 셸별 적용

| 셸 | 표시 변경 | 내용 |
|---|---|---|
| android (Capacitor) | **있음** | 홈 인라인 토큰 목록: 액면 확인된 스테이블 행이 `≈ $100.00` → `≈ 0.4054 TTL`. `TokenIdentity` 를 `{kind, faceIso?, decimals?}` 객체로 교체. TRC-20 USDT 는 decimals 6 을 셸 상수로 보유. |
| extension (WXT/MV3) | **있음** | android 와 동일 로직. `STABLE_USD` 표 삭제. TRUSTED_TRC20 은 ISO 만 보유(§8 참조). |
| web (Vite) | **없음** | 토큰 목록(Account.tsx)에 가치 줄 자체가 없다(심볼·이름·수량 3개). 얹을 지점 없음. |
| desktop (Tauri 2) | **없음** | 동일(Wallet.tsx 수량만). 버전만 0.5.21. |

i18n: 신규 키 5종 추가(`tokens.face_peg`, `face_to_ttl`, `face_hint`, `basis_face`, `basis_anchor`). ko/en 각 606키, 편차 0.
값 사유 표기 규칙 무변경 — 주소 미확인 → `value_unverified`, 확인됐으나 값 출처 없음 → `value_unlisted`.

---

## 7. 산출물

| 산출물 | 경로 | 크기(B) | sha256 |
|---|---|---|---|
| Android APK | D:\TTLCOINWalet\벼린0.5.21.apk | 5,599,900 | 23d8aa59b3ba679904ea1e707659aa1e3c9e1a323f7d1fa1bae86d5882b65b69 |
| Desktop MSI | apps\desktop\src-tauri\target\release\bundle\msi\벼린_0.5.21_x64_ko-KR.msi | 8,192,000 | 488f5ce763749030b1c347081da0a9411aac771da568824c2b8404d60ae72d7d |
| Desktop NSIS | apps\desktop\src-tauri\target\release\bundle\nsis\벼린_0.5.21_x64-setup.exe | 7,219,273 | 8dffff0de051b173962a606d3041cc24ce7b3363ab14d98fbd3f4f59987557d3 |
| Extension | apps\extension\.output\chrome-mv3 | 7,107,298 | (디렉터리, manifest version 0.5.21) |
| Web | apps\web\dist | 23,836,390 (sourcemap 포함) | (디렉터리) |

**서명**: APK signer certSha256 = `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480` — v0.5.20 기준값 `303f801b…f103480` 과 **일치**. 키스토어 신규 생성 0건.
데스크톱 MSI·EXE 는 **코드서명 없음**(tauri.conf.json 에 signing 설정 0건).

**QR 회귀 없음** — APK 내부 번들 직접 추출 후 계수: `assets/public/assets/index-md6LT5Ef.js` 에 jsQR 2, getUserMedia 2, facingMode 1, environment 4. 카메라 스캐너 경로 존속.

**이번 변경 탑재 확인**(APK 번들 내부): `faceIso` index 36 / dist 24 / multichain 24건. TRON USDT 주소 index 3 / dist 1 / multichain 1건. tUSD perTtl `246.64798986458746` 세 청크 각 1건.

**workingTreeClean = false** — 커밋되지 않은 변경이 섞인 빌드다. 매니페스트에 그대로 기록했다. 이 산출물은 커밋(6529912)만으로 재현되지 않는다.
버전 범프 파일 7개: apps/{web,extension,android,desktop}/package.json · apps/desktop/src-tauri/{tauri.conf.json,Cargo.toml} · apps/android/android/app/build.gradle(versionCode 22 / versionName 0.5.21). Cargo.lock 은 cargo 가 자동 갱신.
apps/mobile 은 미사용이라 건드리지 않았다(0.0.1 유지).

---

## 8. 남은 것

**(가) 페그를 무조건 믿는다 — 우회 경로 없음.**
`faceIso` 는 "발행자가 선언한 액면 단위" 지 "시장가" 가 아니다. 디페그(UST 류)를 탐지하려면 시장 시세를 입력으로 써야 하고, 그것이 §5 가 금지하는 바로 그 입력이다. 온체인 DEX 풀 가격도 시장가라 동일 위반이다. **지갑 안에 자동 탐지 경로는 없다고 단정한다.**
대응은 수동 1줄: 해당 항목의 `faceIso` 를 지운다 → 신원(kind)은 남고 값만 비어 `tokens.value_unlisted` 로 떨어진다. 토큰이 목록에서 사라지지 않으므로 **잔액·송금 영향 0**. 이 한계는 registry.ts·trc20-known.ts 필드 주석에 기록했다. 지금 조치 대상 0건.
DAI 는 담보형 soft peg 로 2020-03 에 1 USD 를 벗어난 전례가 있다. 이번에는 포함했다 — 뺄지는 사람 결정.

**(나) 두 셸이 갈린 지점 2건 (사람 결정 필요).**
1. `STABLE_USD` 심볼 표: android(App.tsx:2294, :2306)에 **남아 있고** extension 에는 **없다**. 결과: ZION 자산줄의 `uusdt`(심볼 USDT)가 android 에서는 `$1.00 × 수량`, extension 에서는 Binance 에 `USDTUSDT` 페어가 없어 값 없음. BUSD·TUSD 도 android 에서만 1달러를 얻는다 — 심볼 판정 잔여 구멍이 android 에만 있다.
   남긴 이유: 주소가 없는 두 호출자(네이티브 심볼, ZION denom)를 주소로 옮길 근거가 저장소에 없다. 지우면 그 둘이 값을 통째로 잃는다. **두 셸을 어느 쪽으로 맞출지는 사람 결정.**
2. extension 의 `TRUSTED_TRC20` 은 ISO 만 담아 TRC-20 USDT 의 decimals 를 익스플로러 응답에 의존한다(android 는 6 을 내장 상수로 보유). TronScan 이 decimals 를 18 로 주면 extension 표시가 10^12 배 축소된다. **미해소.**

**(다) 화면 두 곳의 표시가 다르다.** `lib/token-visibility.ts`(TokenListPane 경로)는 `faceIso`·`rateByIso` 참조 0건이라 스테이블을 여전히 `tokens.no_rate` 로 그린다. 홈 인라인 목록만 TTL 을 낸다. **미해소.**

**(라) `packages/wallet-sdk/src/rates/stable.ts` 는 프로덕션 소비자 0건.** 신규 19 케이스가 지키는 경로를 셸이 타지 않고, 두 셸이 각자 TRUSTED_TRC20 을 복제해 TRON 주소가 3곳에 존재한다. 셸에 테스트 러너가 없으므로 **출하 경로의 경계는 현재 어떤 테스트도 지키지 않는다.**

**(마) 신규 i18n 키 5종 전량 미사용.** apps/** 소비자 grep 0건. 액면 사실(1 USDT ≡ 1 USD)을 근거 패널로 옮긴다는 설계가 화면에 도달하지 않았다.

**(바) 미등록 스테이블.** Solana USDC, BUSD, TUSD, 원화·유로·엔 액면 스테이블 — 근거가 생기면 항목당 1줄. 없는 채로 넣지 않는다.

**(사) 상장자산 USD 보조줄 — 사람 결정.** BTC·ETH·SOL·TRX 는 §3 에 따라 TTL 로 옮길 수 없다. 달러 보조줄을 계속 둘지, 아예 값을 비울지는 기술 판단이 아니라 정책 결정이다.

**(아) 실기기 미검증.** APK 는 빌드·서명·번들 내용까지만 확인했다. 실제 안드로이드 기기에서 USDT 잔액을 띄워 `0.4054 TTL` 이 그려지는 것은 확인하지 않았다.

**(자) web·desktop 은 가치 줄이 없다.** 4종 셸 표시 통일을 원하면 별건 신규 작업(화면 설계 포함).

---

## 9. 경로

- 보고서: D:\TTLCOINWalet\docs\RELEASE-0.5.21.md
- 변경 로그: D:\TTLCOINWalet\docs\CHANGELOG.md
- APK: D:\TTLCOINWalet\벼린0.5.21.apk / 매니페스트 D:\TTLCOINWalet\벼린0.5.21.apk.manifest.json
- 환율 스냅샷: D:\TTLCOINWalet\rate-snapshot.json
- 신규 소스: packages\wallet-sdk\src\rates\stable.ts · packages\wallet-sdk\src\chains\trc20-known.ts
- 신규 테스트: packages\wallet-sdk\tests\stable-denom.test.ts
- 임시파일: **0건**. D:\TTLCOINWalet\scripts\stable-out\ 은 생성되지 않았다(실측 확인).
- 커밋·푸시: **0건**. 트리는 미커밋 상태 그대로다.
