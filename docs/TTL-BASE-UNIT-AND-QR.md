# TTL 이 기준 단위다 · QR 스캔

작업일 2026-08-02 · 기준 커밋 HEAD `8f8ee53` (main, 작업 시작 시점 트리 깨끗) · 현재 미커밋 작업 트리

---

## 1. 결론

**[A] BTC 페그 제거 = 완료.** 두 셸의 페그 상수 12 종과 환산 함수 4 종을 제거했고,
`tokenToUsd` 안의 `peg × btcUsd` 곱셈 분기를 없앴다. 저장소 전체 grep 에서 코드 잔재
**0 건**(남은 3 히트는 이 작업으로 갱신한 문서 서술뿐), 4 종 셸 산출물에서 페그 수치
리터럴(`10/365 = 0.027397…`, `1/300000 = 3.3333e-6`) **0 건**.

**[B] QR 스캔 = 부분 완료.** 디코드·파싱·주소검증은 공용 순수 TS 모듈 하나로 만들었고
단위 테스트 34 건 + 왕복 실측 28 건 전부 통과한다. 4 종 셸에 UI 를 붙였다. 다만
**카메라 실동작을 어느 셸에서도 한 번도 실행하지 않았다** — 브라우저·실기기 검증 0 건.
이미지 파일 경로는 node 에서 실제 QR 비트맵으로 왕복 검증했다.

**빌드 4 종 = 전부 성공.** `pnpm -r --workspace-concurrency=1 build` EXIT=0.

| 셸 | 빌드 | 산출물 |
|---|---|---|
| apps/android | 성공 | `dist/assets/index-*.js` 633,237 B (외 청크) |
| apps/web | 성공 (10.85s) | `dist/assets/index-*.js` 4,867,377 B |
| apps/desktop | 성공 (12.40s) | `dist/assets/index-*.js` 6,699,634 B |
| apps/extension | 성공 | chrome-mv3, Σ 7.1 MB |

> 병렬 `pnpm -r build` 는 1 회 실패했다. 원인은 이번 변경과 무관한 경합이다 —
> `@byeorin/design-system` 의 tsup 이 `dist` 를 clean 하는 동안 `apps/web` 이
> `@byeorin/design-system/tokens.css` 를 읽어 rollup resolve 실패. `dist/tokens.css`
> 는 빌드 후 copy 되는 산출물이다. `--workspace-concurrency=1` 로는 EXIT=0.
> **이 경합은 이번 라운드가 만든 것이 아니고, 고치지도 않았다.**

---

## 2. [A] 무엇이 어떻게 바뀌었나

### 2.1 지운 것

대상 2 파일: `apps/android/src/App.tsx` · `apps/extension/entrypoints/popup/App.tsx`
(두 파일은 구조가 동일해 1:1 로 같은 것을 지웠다.)

| 종류 | 이름 |
|---|---|
| 상수 | `PEG_ANNUAL_BTC` · `PEG_DAYS_PER_YEAR` · `PEG_TTL_PER_DAY` · `TTL_PEG_BTC` · `KWR_PEG_BTC` · `PRICE_PEG_TO_BTC` · `TTL_ANCHOR_BTC` |
| 함수 | `nativeToTtl` · `usdToTtl` · `nativeToBtcRatio` · `nativeToBtc` |
| 파생값 | `btcPerNative`(정의만 있고 호출자 0) · `nativeTtl` · `zionTtl` |
| 분기 | `tokenToUsd` 안의 `peg × btcUsd` — 그 자리는 `return null` |
| 거짓 주석 | "잔액을 BTC 단위로 … 클릭하면 USD 토글"(대응 state 는 이미 없었다) 외 2 건 |

diff 규모: 두 App.tsx 합계 `+108 / -246` (파일당 175 줄 변경).

### 2.2 TTL 표시가 지금 무엇인가

정의상 **1 TTL = 노동자 1 일 품삯**이므로 표시할 N 은 TTL 잔액 그 자체다.

```
nativeLaborDays = (nativeSymbol === 'TTL' && balance !== null)
                ? baseUnitToNumber(balance, nativeDecimals)
                : null
```

곱셈 0 회 · 나눗셈 0 회(단위 환산 `baseUnitToNumber` 제외) · 외부 시세 참조 0 회.
화면 문구는 `tokens.value_labor_days` = `노동자 {v} 일 품삯` / `{v} days of a worker's wage`.
즉 TTL 옆에 오는 것은 **환산값이 아니라 TTL 자신의 정의**다. 사용자 확정 문장
"TTL 은 TTL 이다. 가치가 그 자체다" 가 코드 구조로 성립한다.

### 2.3 t{ISO} 와 kWR 이 TTL 로 재어지는 경로

방향은 반대다 — **통화토큰이 TTL 로 재어진다.**

```
행 = t{ISO} 토큰
  → rateByAddress(주소)  … rate-snapshot.json 의 perTtl ("1 TTL = perTtl 단위의 그 토큰")
  → tokenAmountToTtl(balance, decimals, rate)  = 수량 ÷ perTtl
  → tokens.value_ttl ('≈ {v} TTL')
```

이 경로는 wallet-sdk 에 이미 있던 것이고 `ExchangePane`·`TokenListPane` 이 쓰던 그대로다.
새로 만든 산식은 없다.

`₩`·`원`·`$` 를 `t{ISO}` 행에 붙이는 코드는 두 App.tsx 에 없다(신규 표기 0 건).
`t` 접두는 유지된다 — `docs/CONTEXT.md §5` 의 "t{ISO} 는 실제 그 나라 통화가 아니다"
와 어긋나지 않는다.

**kWR 은 값 표시를 잃었다.** 페그(`1/300,000 BTC`)가 유일한 값 출처였고,
`rate-snapshot.json` 은 EVM 주소 기반이라 ZION native 인 kWR 항목이 없다.
산식을 지어내지 않았고, "환율 없음" 문구도 넣지 않고 빈 자리로 뒀다.
히어로 보조 줄과 ZION 자산 목록 두 곳이 비어 있다.

### 2.4 외부 상장자산 트랙은 그대로

`tokenToUsd()` 의 USDT-direct → `{SYM}BTC × BTCUSDT` → W- 접두 재시도 경로,
`prices` 상태, Binance fetch, `STABLE_USD` 는 전부 유지했다. 제거한 것은 마지막
peg 분기 하나뿐이다.

저장소에 남은 `× btcUsd` 는 `apps/android/src/App.tsx:2099` ·
`apps/extension/entrypoints/popup/App.tsx:2045` 두 곳뿐이고, 둘 다 Binance 트랙의
`{SYM}BTC × BTCUSDT` 다. TTL 이 여기로 들어가는 경로가 있는지 추적한 결과:
`nativeUsd` 가 `nativeSymbol === 'TTL'` 이면 즉시 `null` 을 돌려주므로 **TTL 은
`tokenToUsd` 에 진입하지 않는다.** 두 트랙은 만나지 않는다.

자산을 한 숫자로 더하는 포트폴리오 총액 UI 는 원래 없었고, 만들지 않았다
(`reduce`/`total`/`portfolio` grep 결과 합산 코드 0 건).

---

## 3. [B] QR 스캔 — 셸별 지원 범위

공용 모듈: `packages/shell-core/src/qr/{decode,parse,address,capture,index}.ts` (20,109 B).
캡처(셸마다 다름)와 디코드(공용)를 갈랐다 — `transport.ts` 를 `ByteTransport` 계약으로
가른 것과 같은 수법.

| 셸 | 실시간 카메라 | 이미지 파일 | 필요했던 설정 변경 | 제약 |
|---|---|---|---|---|
| **android** (Capacitor) | 붙였음 (후면, `facingMode:'environment'`) | 있음 | `AndroidManifest.xml` 2 줄: `uses-permission CAMERA` + `uses-feature android.hardware.camera required=false` | 실기기 미검증. CAMERA 선언의 부수효과로 `<input type=file accept=image/*>` 에 "카메라 촬영" 선택지가 뜬다 |
| **web** (Vite) | 붙였음 | 있음 | 없음 | `window.isSecureContext` false 면 카메라 버튼을 렌더하지 않고 파일 경로만 남김. 배포처가 HTTPS 인지 저장소로 확인 불가 |
| **desktop** (Tauri 2) | 조건부 — `enumerateDevices()` 로 `videoinput` ≥1 일 때만 버튼 노출 | 있음 (기본 경로) | 없음 (`tauri.conf.json` 무변경) | WebView2 커스텀 프로토콜에서 getUserMedia 허용 여부 미확인. macOS 는 `NSCameraUsageDescription`·엔타이틀먼트 부재 |
| **extension** (WXT/MV3) | **없음** | 있음 (유일 경로) | 없음 (`wxt.config.ts` 무변경) | popup 은 권한 프롬프트로 포커스를 잃는 순간 문서가 파괴돼 스트림·프롬프트 응답이 사라진다. 우회로(`chrome.tabs.create` 로 전용 스캔 entrypoint)는 만들지 않았다 |

**CSP 는 어느 셸도 바꾸지 않았다.** MediaStream 을 `srcObject` 로만 붙이고 `blob:` URL 을
만들지 않기로 설계 단계에서 못 박은 결과다. `getUserMedia` 자체가 CSP 통제 대상이 아니다.

**코드 외 설정 변경은 안드로이드 매니페스트 2 줄이 전부다.**

의존성 추가: `jsqr@^1.4.0` → `packages/shell-core/package.json` 한 곳. 네이티브 의존 0,
WASM 미사용(= MV3 CSP 무해). 4 종 셸 `package.json` 추가 0 건.
새 Capacitor 플러그인 추가 0 건.

### 3.1 스캔값 처리

`parseScanned(text, chain, opts)` 가 **형식 파싱 + 주소 검증의 단일 관문**이다.
호출부가 검증을 건너뛸 수 없게 만든 것이 요점이다.

- **BIP21** `bitcoin:` — `amount`(BTC 단위 십진) · `label` · `message` 반영. `req-` 미지
  파라미터와 BIP70 `r=` 는 스펙대로 **거절**(`required-param`). `X` 지수 표기는 미지원(`bad-amount`).
- **EIP-681** `ethereum:` — 네이티브 송금은 `value`(wei) → 표시 단위 문자열로 확정 변환.
  `@chain_id` → `chainHint`(예 `7777` → `evm:ttl`). `/transfer` 는 `tokenAddress` 를 주고
  `uint256` 은 **decimals 를 모르므로 변환하지 않고** `tokenAmountRaw` 로 넘긴다
  (임의 18 자리 가정 금지). ENS 이름은 `bad-address`.
- **평문 주소** — trim 후 `isValidAddressFor` 로만 판정.
- `solana:` · `wc:` 등 — `unsupported-scheme`. 원문만 보여 주고 입력란에 넣지 않는다.

주소 검증: EVM 은 혼합 대소문자일 때 **EIP-55 체크섬을 실제로 keccak 으로 검사**한다
(`@noble/hashes` 를 shell-core 가 이미 의존 — 추가 의존 0). BTC·Cosmos·XRP·Solana·
TRON·TON·Aptos·Sui 는 형식(문자집합·길이·HRP) 검증이며 **체크섬 보증이 아니다** —
그래서 4 종 셸이 스캔 후 `scan.address_unchecked`("형식만 확인, 눈으로 대조")를 항상
덧붙인다.

---

## 4. 검증 (직접 실행한 것만)

### 4.1 페그 잔재 전수

```
git grep -n "TTL_PEG_BTC\|PRICE_PEG_TO_BTC\|TTL_ANCHOR_BTC"
→ 3 건, 전부 문서: docs/CHANGELOG.md:169 · docs/CONTEXT.md:262 · docs/CONTEXT.md:356
  (이 세 곳은 §6 에서 이번 작업 결과로 갱신했다)
→ 코드(apps/·packages/) 잔재 0 건
```

산출물 검사: `apps/{android,web,desktop}/dist` + `apps/extension/.output` 에서
`0.027397`(=10/365) · `3.3333e-6`(=1/300000) 검색 → **0 건**.

### 4.2 테스트·빌드 수치

| 항목 | 결과 |
|---|---|
| `pnpm -r --workspace-concurrency=1 build` | EXIT=0, 4 종 셸 전부 성공 |
| `pnpm --filter @byeorin/wallet-sdk test` | 42 파일 **681 passed / 10 skipped / 0 failed** (6.63s) |
| ├ BIP157 기준선 | `58 + 13 + 47 + 6 = 124` / 124 유지 |
| `pnpm --filter @byeorin/shell-core test` | 3 파일 **86 passed / 0 failed** (2.00s) |
| ├ 신규 `qr-parse.test.ts` | **34 passed** (28ms) |
| `pnpm --filter @byeorin/i18n test` | **19 passed** (ko↔en 키 커버리지 포함) |
| `scripts/qrpeg-out/verify-qr.mjs` | **총 28 : PASS 28 / FAIL 0** (exit 0) |

### 4.3 QR 왕복 실측 (verify-qr.mjs, 재실행 가능)

`qrcode` 로 **실제 QR 행렬을 생성** → RGBA 픽셀(6 배 확대, quiet zone 4)로 렌더 →
shell-core 의 `decodeQr`(jsQR) 로 디코드 → `parseScanned` 로 파싱. 원문 문자열 왕복 일치 4 종:

- EVM 평문 `0x52B5…F533` → `kind:'raw'`
- BTC 평문 `bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq` → `kind:'raw'`
- BIP21 `bitcoin:bc1q…?amount=0.125&label=Byeorin` → `bip21`, amount `'0.125'`, chainHint `'btc'`
- EIP-681 `ethereum:pay-0x52B5…@7777?value=2.5e18` → `eip681`, amount `'2.5'`, chainHint `'evm:ttl'`

거부 18 건 전부 성공: 랜덤 노이즈·0×0 이미지 → `null` / 빈 입력 → `empty` /
체인 불일치 주소 → `bad-address`·`chain-mismatch` / `req-`·`r=` → `required-param` /
지수 amount·소수 wei → `bad-amount` / `wc:`·`solana:` → `unsupported-scheme` /
ENS·잘린 주소·EIP-55 어긋난 대소문자 → `bad-address` / `/approve` → `unsupported-scheme`.

> EIP-55 검증이 실제로 동작한다는 것이 검증 중에 확인됐다 — 테스트에 쓴 주소의 대소문자가
> 틀려 모듈이 거부했고, 틀린 쪽은 테스트였다.

### 4.4 무검증 입력 경로 = 0 건

`parseScanned|decodeQrAuto|setTo|onScan` 전수 확인 결과, 스캔 문자열이 주소 입력란에 닿는
경로는 4 개뿐이고 전부 `parseScanned` 관문을 지난다:
`apps/web/src/screens/Send.tsx:112` · `apps/android/src/screens/SendPane.tsx:123` ·
`apps/extension/entrypoints/popup/screens/QrScanField.tsx:46` ·
`apps/desktop/src/components/QrScanner.tsx:83`. 실패하면 전부 `setTo`/`onScan` 을 부르지 않는다.
`parse.ts` 의 `finish()` 가 모든 성공 경로의 단일 출구라 주소 검증 없이 `ok:true` 가 나올 수 없다.

### 4.5 카메라 = 검증 0 건

헤드리스 환경에서 `getUserMedia` 를 실행할 수 없다. **어느 셸에서도 카메라를 열어 QR 을
읽어 본 적이 없다.** 코드 판독으로 확인한 것은 실패 처리뿐이다 — 4 종 모두 권한 거부·
장치 없음·비 secure context 를 예외가 아닌 분기로 흡수해 파일 경로로 떨어지고,
언마운트 시 `controller.stop() → source.close() → track.stop()` 으로 카메라 표시등을 끈다.

---

## 5. 사용자 확정 대비 검토

확정 문장: **"TTL 은 TTL 이다. 가치가 그 자체다. 원화스테이블·달러스테이블 등이 TTL 을
기준으로 재어진다."**

**화면에서 실제로 이렇게 보인다** (코드 기준. 실기기 렌더는 확인하지 못했다):

| 자리 | 보이는 것 | 눈금 |
|---|---|---|
| TTL 체인 히어로 | `1,234.56 TTL` / 아래 `노동자 1,234.56 일 품삯` | 없음 (정의) |
| `t{ISO}` 토큰 행 (tKRW·tUSD…) | `수량 tKRW` / `≈ 4.05 TTL` | **TTL** |
| 외부 상장자산 (BTC·ETH·SOL…) | `수량 BTC` / `≈ $63,412.45` | Binance USD |
| kWR (ZION native) | 수량만. **보조 줄 비어 있음** | 없음 |

확정 5 개 항목 대조:

1. TTL 을 다른 것으로 환산해 보조 표시하지 않는다 — **맞음.** 곱셈 0 회, TTL 이 `tokenToUsd` 에 진입하지 않는다.
2. 방향이 반대 (t{ISO} 가 TTL 로 재어진다) — **맞음.** `tokenAmountToTtl = 수량 ÷ perTtl`.
3. 상수 삭제 · `peg × btcUsd` 제거 — **맞음.** 코드 잔재 0, 산출물 리터럴 0.
4. 두 앵커가 만나지 않는다 — **맞음.** 상장자산 Binance 트랙 유지, 잇는 코드 0.
5. `t` 접두 유지, `원`·`₩`·`$` 를 t{ISO} 에 붙이지 않는다 — **맞음.** 신규 표기 0 건.

**부분적으로 남은 것 1 건: kWR.** 확정 문장은 "원화스테이블·달러스테이블 등이 TTL 로
재어진다" 인데, kWR 은 재어지지 않고 **비어 있다.** 페그를 지운 것은 확정대로지만
"TTL 로 재어진다" 쪽이 아직 성립하지 않는다. `rate-snapshot.json` 이 EVM 주소 기반이라
ZION native 인 kWR 항목이 없기 때문이고, 산식을 지어내는 것은 금지 사항이라 비웠다.
→ §6-1.

---

## 6. 남은 것

### 6.1 사람 결정이 필요한 것

1. ~~**kWR 을 TTL 로 재는 근거.**~~ **결정됨 (2026-08-02): ZION 소관이므로 지갑이 정하지
   않는다. 값 표시 없음을 유지한다.** 근거 — `ZionWallet.MD:79-83` 의 Keplr currencies 에서
   BTC·USDT·ETH 에는 `coinGeckoId` 가 붙어 있는데 kWR 에만 없다. ZION 스스로 kWR 의 외부
   시세를 두지 않았다는 뜻이고, kWR 은 `stakeCurrency`·`feeCurrencies` 인 그 체인의 기축이지
   가격이 매겨지는 대상이 아니다. 삭제한 `1 kWR = 1/300,000 BTC` 는 ZION 이 준 값이 아니라
   지갑이 만들어낸 값이었다 — 명세 어디에도 없다.
   우회 경로도 따졌다: ZION 에 AMM(`zion.amm.v1`, `GET /v1/amm/pools`)이 있어 풀 리저브에서
   가격을 끌어낼 수는 있다(체인이 실제로 가진 기능이라 발명이 아니다). 그러나 명세가
   USDT·ETH·mock 을 "AMM 시드용 **테스트** 코인"으로 명시하고(`:52-54`), ETH 는 decimals 가
   표준 18 이 아닌 6 이며(`:53`), peg-out(ZION→BTC)은 Phase 1 미오픈(`:281`)이다. 테스트 풀
   가격을 실가치로 쓰면 지운 페그보다 더 나쁜 거짓이 된다. kWR 에 값을 붙이려면 ZION 쪽에서
   기준이 먼저 정해져야 한다.
2. **확장에서 카메라를 별도 탭으로 여는 entrypoint(`entrypoints/scan/`) 를 신설할지.**
   지금은 확장만 이미지 전용이다.
3. ~~**안드로이드 CAMERA 권한 선언 승인.**~~ **승인됨 (2026-08-02).** `CAMERA` 는 이 앱이
   `INTERNET` 외에 요구하는 유일한 권한이다. 저장소·연락처는 여전히 요구하지 않는다 —
   "요구하지 않는 권한이 곧 방어선" 원칙은 폐기가 아니라 예외 하나를 명시적으로 기록한
   것이다. 선언 없이는 WebView 의 `getUserMedia` 가 런타임 프롬프트조차 뜨지 못하고 즉시
   거부되므로, 실시간 스캔을 넣는 이상 우회 경로가 없다. `uses-feature required="false"` 를
   함께 둬서 카메라 없는 단말이 스토어에서 걸러지지 않게 했고, 권한을 거부해도 이미지 파일
   경로가 그대로 남는다(`QrScanner.tsx:60-61`).
4. **웹 셸의 실제 배포처와 프로토콜.** 저장소에 호스팅 설정 파일이 없다. HTTP 면 카메라 0%.
5. **`chainHint` 가 현재 선택 체인과 다를 때** — 지금은 `chain-mismatch` 로 거절만 하고
   체인을 자동 전환하지 않는다.
6. **`wc:` (WalletConnect 페어링) 스캔 지원 여부.** 지금은 `unsupported-scheme`.
7. **스캔 진입점.** 지금은 Send 화면 하나뿐. 주소록 추가에는 붙이지 않았다.
8. **데스크톱 macOS 배포 여부.** 배포한다면 `Info.plist` + 엔타이틀먼트 작업이 별건.

### 6.2 확인된 결함 (이 보고 부대 소유가 아니라 고치지 않았다)

1. **`apps/android/src/screens/SendPane.tsx:125` — i18n 키 형식 불일치.**
   `t(\`scan.error.${res.code}\`)` 인데 `ScanErrorCode` 는 케밥(`bad-address`),
   카탈로그 키는 스네이크(`scan.error.bad_address`). i18n 은 미존재 키를 키 문자열
   그대로 반환하므로 **화면에 `scan.error.bad-address` 원문이 뜬다.** web·extension 은
   `replace(/-/g,'_')` 를 하고 안드로이드만 빠졌다.
2. **안드로이드에서 쓰는 i18n 키 3 종이 카탈로그에 없다** — `scan.token_unknown` ·
   `scan.file_no_qr` · `scan.pick_image` (ko.ts grep 0 건). 같은 이유로 키 원문이 노출된다.
3. **`packages/shell-core/src/qr/parse.ts:102` — `decodeURIComponent(head)` 가 던진다.**
   실행 재현 확인: `parseScanned('bitcoin:1BvBMS%ZZ','btc')` → `URIError: URI malformed`.
   `ScanError` 반환이 아니라 예외다. 호출부 4 곳 어디도 `try/catch` 로 감싸지 않는다.
4. **`apps/android/src/screens/QrScanner.tsx:82` — 1.5s `setTimeout` 을 성공 시에도
   `clearTimeout` 하지 않는다.** 실제로 읽었는데 "못 읽음" 이 함께 뜰 수 있다.
5. 이미지 파일의 크기·해상도 상한이 4 종 셸 어디에도 없다(초대형 이미지 → 캔버스 메모리).

### 6.3 검증하지 못한 것

- **카메라 실동작 — 4 종 전부 0 건.** Android CAMERA 런타임 프롬프트, Capacitor
  `BridgeWebChromeClient.onPermissionRequest` 승인, Tauri WebView2 커스텀 프로토콜에서의
  `getUserMedia`, 후면 카메라 선택, 실제 디코드 성공률 — 전부 모른다.
- **`BarcodeDetector` 네이티브 경로 미실행.** node 에 없어 jsQR 폴백만 검증됐다.
- **실기기·브라우저 렌더 0 건.** kWR 히어로가 값 없이 뜨는 화면을 눈으로 본 사람이 없다.
- **번들 크기 이전 대비 증분 미실측.** HEAD `8f8ee53` baseline 을 재빌드하지 못했다
  (worktree 에 pnpm 심볼릭 `node_modules` 가 없고 공유 스토어 손상 위험 때문에 install 을
  돌리지 않았다). jsQR 자체 minify 실측은 130,469 B(gzip 47,247 B), QR 소스 20,109 B.

### 6.4 작업 중 사고 (사실 기록)

작업 도중 `git stash` 가 다른 부대의 작업분까지 함께 빼내 `stash pop` 이 충돌한 사건이
1 회, 파일 편집이 외부에서 되돌아간 사건이 2 회 있었다. 최종 상태는 위 빌드·테스트로
검증했으나, `apps/desktop/src/views/Send.tsx` 와 `apps/web/src/screens/Send.tsx` 는
stash 시점 버전과 워크트리 버전이 서로 다른 작업이라 병합하지 않고 워크트리 버전을 뒀다.
**두 파일의 소유 부대가 자기 변경분이 남아 있는지 재확인해야 한다.**

---

## 7. 산출물

### 변경 파일 (미커밋, 15 modified / 6 신규 · `+564 / -276`)

**[A] 페그 제거**
- `apps/android/src/App.tsx`
- `apps/extension/entrypoints/popup/App.tsx`
- `packages/i18n/src/messages/{ko,en}.ts` (tokens 4 키 + scan 33 키)

**[B] QR — 공용 모듈**
- `packages/shell-core/src/qr/{decode,parse,address,capture,index}.ts` (신규)
- `packages/shell-core/src/index.ts` (re-export 1 줄)
- `packages/shell-core/package.json` (`jsqr@^1.4.0`)
- `packages/shell-core/tests/qr-parse.test.ts` (신규, 34 테스트)
- `pnpm-lock.yaml`

**[B] QR — 셸 연결**
- `apps/android/src/screens/QrScanner.tsx` (신규) · `apps/android/src/screens/SendPane.tsx`
- `apps/android/android/app/src/main/AndroidManifest.xml`
- `apps/extension/entrypoints/popup/screens/QrScanField.tsx` (신규) · `.../screens/SendPane.tsx`
- `apps/web/src/components/QrScanModal.tsx` (신규) · `apps/web/src/screens/Send.tsx` · `apps/web/src/styles.css`
- `apps/desktop/src/components/QrScanner.tsx` (신규) · `apps/desktop/src/views/Send.tsx`

**문서**
- `docs/TTL-BASE-UNIT-AND-QR.md` (이 문서, 신규)
- `docs/CONTEXT.md` — §5 "코드는 아직 따라오지 않았다" 블록을 닫음, §E 미해결 0 번을 닫음(kWR 미정으로 대체)
- `docs/CHANGELOG.md` — `[Unreleased]` 항목 추가, :169 Known limitation 을 해소 표기로 갱신

### 임시파일 (지우지 않음)

- `D:/TTLCOINWalet/scripts/qrpeg-out/verify-qr.mjs` — QR 왕복·거부 검증 28 건. `node` 로 직접 재실행 가능.

**커밋·푸시하지 않았다.**
