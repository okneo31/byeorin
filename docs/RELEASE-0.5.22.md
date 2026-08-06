# v0.5.22 — 스테이블 산식 수렴 (versionCode 23)

작성 시각 기준 실측. 모든 수치는 직접 실행 결과이고, 실행하지 않은 것은 "미검증"이라고 적었다.

---

## 1. 결론

| 결함 | 판정 | 근거 |
|---|---|---|
| C1 — SDK 순수 함수 소비자 0 | **부분 해소(닫힘 아님)** | apps/ 의 SDK 스테이블 함수 참조 12건 / 4파일. 그러나 android 는 `tokenValueOf`, extension 은 `stableDenomOf`+`stableToTtl` — **표면이 두 벌**이다 |
| C2 — 컨트랙트 주소 복제 | **닫힘** | 판정 경로 하드코딩 주소 **0건**. 잔존 2건은 수동 추가 입력칸 placeholder(android App.tsx:193, extension App.tsx:200) |
| C3 — extension decimals 부재 | **닫힘** | 양 셸 모두 decimals 를 한 번만 확정해 표시·환산에 같이 먹인다. android 의 근거 없는 `decimals: 6` 삭제 |
| C4 — 같은 앱 두 화면 다른 값 | **extension 닫힘 / android 열림** | extension: TokenListPane 에 `chainId` prop 전달(screens/TokenListPane.tsx:60,80,109 + App.tsx:771). android: `buildTokenRows(tokens, hidden, chainKey)` 5번째 인자 미전달 → EVM 스테이블 22종 목록 화면 빈칸 |

산출물: `벼린0.5.22.apk` 5,599,680 B · MSI/NSIS · extension chrome-mv3 · web dist. `pnpm -r build` EXIT=0, `pnpm -r test` EXIT=0 — **954 통과 · 10 skip · 0 실패**(기준선 943 → +11).

---

## 2. 왜 이 라운드가 필요했나

v0.5.21 은 `packages/wallet-sdk/src/rates/stable.ts` 에 `stableDenomOf`·`stableDenomOfEvm`·`listStableDenoms`·`stableToTtl`·`stableFaceRate` 5개를 만들었고, `src/evm.ts` 배럴로 `@byeorin/wallet-sdk/evm` 에 이미 노출돼 있었다. 그런데 **apps/ 의 소비자는 0건**이었다. 두 셸이 각자 `tokenIdentity()` 와 `TRUSTED_TRC20` 맵을 새로 썼다.

그 결과 두 셸의 **데이터가 갈렸다**:
- android App.tsx:301 `['TR7NHq…', { iso: 'USD', decimals: 6 }]`
- extension App.tsx:283 `['TR7NHq…', 'USD']` — decimals 없음

extension 은 decimals 를 외부(TRON 노드가 읽어 준 컨트랙트 `decimals()`)에만 의존했다. 그 값이 n 만큼 틀리면 표시 금액이 **10ⁿ 배**로 어긋난다. 같은 실패 양상을 v0.5.18 에서 이미 한 번 고쳤다(ASSUMED_TOKEN_DECIMALS).

원인 판정(실측): 배럴 부재가 아니었다. 두 셸 모두 이미 `@byeorin/wallet-sdk/evm` 을 import 하고 있었다(android:40, extension:43). **SDK 가 "신원 종류(kind)"와 "시세를 물어도 되는가"를 주지 않아서** 셸이 자기 신원 함수를 짰고, 그 안에 환산 산식까지 같이 넣었다.

---

## 3. 수렴 결과

### 지운 것

| 대상 | 위치(삭제 전) | 상태 |
|---|---|---|
| `TRUSTED_TRC20` 로컬 맵 + 하드코딩 주소 | android App.tsx:295-301, extension App.tsx:277-284 | 삭제 |
| 근거 없는 `decimals: 6` | android App.tsx:301 | 삭제 (저장소 안 근거 없음 — trc20-known.ts:62 가 의도적으로 비워 둠) |
| `tokenIdentity()` 함수 본문 | android App.tsx:303-330 | 삭제 (SDK `tokenValueOf` 로 대체) |
| `UNKNOWN_TOKEN`·`BUILTIN_TOKENS` 격리 레지스트리 | android App.tsx:285-293 | 삭제 (SDK 내부로 이동) |
| `STABLE_USD` 심볼 표 + 조회 | android App.tsx:2288-2300, :2306 | 삭제 — **코드 0건**, 주석 1건만 잔존(App.tsx:2183) |
| `rateByIso`·`stableAmountToTtl` import | android App.tsx:41,43 | 삭제 — apps/ 소비 0건 |
| i18n 미사용 키 5종 | ko.ts/en.ts `face_peg`·`face_to_ttl`·`face_hint`·`basis_face`·`basis_anchor` | 삭제 (ko=en=601, 대칭차 0) |

### 남은 단일 출처

| 사실 | 유일한 출처 |
|---|---|
| 스테이블 컨트랙트 주소 | `packages/wallet-sdk/src/tokens/registry.ts`(EVM 22종) · `src/chains/trc20-known.ts`(TRON 1종) |
| 액면 통화(faceIso) 판정 | `rates/stable.ts` `stableDenomOf(id, family, chainId)` |
| 액면 → TTL 환산 | `rates/stable.ts` `stableToTtl` / `tokenValueOf` |
| 신원 종류 + 시세 게이트 | `rates/stable.ts` `tokenIdentityOf` / `tokenValueOf`(`askMarketPrice`) — `evm.ts` 배럴 6심볼 export |

**미수렴 잔존 1건**: extension 이 `tokenValueOf` 를 쓰지 않고 로컬 신원 계층(popup/App.tsx:273 `UNKNOWN_TOKEN`, :280 `BUILTIN_TOKENS`, :290-310 `tokenIdentity`)을 유지한다. 값은 같지만 코드가 두 벌이다.

---

## 4. 4종 셸 × 화면 동일값 실증

기준 입력: USDT 100개 = raw `100000000`, decimals 6. 기대값 `100 / 246.64798986458746 = 0.40543610371566835`.

SDK dist 직접 호출 실측:

| 경로 | ttl | decimals |
|---|---|---|
| `tokenValueOf`(TRON USDT, family='tron', chainId=null) | 0.40543610371566835 | 6 |
| `stableDenomOf`→`stableToTtl`(같은 입력) | 0.40543610371566835 | 6 |
| EVM USDT `0xdAC17F…`, chainId=1 — 양 경로 | 0.40543610371566835 | 6 |
| EVM USDT, chainId=null — 양 경로 | null | — |

double 완전 일치. 하드코딩 6 이 사라져도 체인이 읽어 준 6 이 그대로 통과한다.

화면별 실측:

| 셸 | 계정 카드 | 토큰 목록 화면 | 일치 |
|---|---|---|---|
| android | 0.40543610371566835 TTL | TRON USDT 일치 / **EVM 스테이블 22종 빈칸** | **불일치(C4 열림)** |
| extension | 0.40543610371566835 TTL | 0.40543610371566835 TTL | 일치 |
| web | 토큰 가치 줄 **없음** | 토큰 목록 없음 | 해당 없음 |
| desktop | 토큰 가치 줄 **없음** | 토큰 목록 없음 | 해당 없음 |

web·desktop 은 이번 라운드에서 값 줄을 넣지 않았다. 사실 3건: (1) 두 셸에 토큰 가치 코드가 0건이라 어긋날 값이 없다. (2) 지금 SDK 표면으로 값 줄을 만들면 셸에 산식 분기가 다시 생겨 이번 라운드 목적과 정반대다. (3) 두 셸은 `new EvmAdapter({ chain: TTL_CHAIN })` 단일 체인 고정이고 faceIso 가 붙은 22종 중 TTL(7777) 소속은 **0종**이라, 넣어도 스테이블은 한 건도 뜨지 않는다.

android 목록 화면 EVM 스테이블이 빈칸인 이유: `apps/android/src/screens/TokenListPane.tsx:107` 이 `chainId` 를 안 넘겨 기본 null 이고, EVM 액면은 chainId 스코프로만 판정된다. **틀린 값이 아니라 빈 값**이다.

---

## 5. 경계 회귀 (SDK dist 직접 호출 실측)

| 케이스 | 결과 | 판정 |
|---|---|---|
| 가짜 USDT(심볼만 USDT, 주소 `0x1111…1111`, chainId 1) | kind=null, ttl=null, askMarketPrice=false | 차단 |
| 심볼 인자 자체 | `tokenIdentityOf`·`stableDenomOf` 시그니처에 **없음** | 구조적 차단 |
| USDT-ETH 주소 소문자/전체대문자 | 정상 판정(EVM 인덱스 toLowerCase) | 정상 |
| 같은 주소 + chainId 43114(avalanche) | kind=null | 차단 |
| 같은 주소 + chainId=null | kind=null | 차단 |
| TRON USDT 소문자화 / hex41 형식 / 키릴 Т 치환 | 전부 null | 차단(base58check 정확 일치) |
| TRON 주소를 family='evm' 로 | null | 차단 |
| WETH `0xC02a…6Cc2` | kind='evm-builtin', faceIso 없음, ttl=null, **askMarketPrice=true** | 상장자산은 USD 보조줄로 |
| WBTC `0x2260…C599` | kind=null, ttl=null | TTL 환산 불가 |
| TTL 네이티브 | `nativeSymbol === 'TTL'` 이면 nativeUsd=null (android:1217, extension:1222) | TTL→USD 잔재 0. `TTLUSDT`/`ttlUsd` grep 0건 |

**사유 뭉뚱그림 잔존 1건**: `TokenListPane`(android:282, extension:284)은 `row.ttl === null` 이면 무조건 `tokens.no_rate` 하나만 그린다. `TokenRow` 에 kind 필드가 없어 `value_unverified`(신원 미확인)와 `value_unlisted`(시세 없음)를 구분하지 못한다. 계정 카드 쪽 사유는 양 셸 모두 정확하다(android:1652-1658, extension:1694-1700).

---

## 6. diff 줄 수 / 번들 크기

`git diff --numstat`(HEAD=v0.5.18 커밋 대비 — **미커밋 v0.5.21 작업분이 함께 세어진다**):

| 파일 | 추가 | 삭제 |
|---|---|---|
| apps/android/src/App.tsx | 52 | 30 |
| apps/android/src/lib/token-visibility.ts | 21 | 2 |
| apps/extension/entrypoints/popup/App.tsx | 136 | 28 |
| apps/extension/entrypoints/popup/lib/token-visibility.ts | 16 | 2 |
| apps/extension/entrypoints/popup/screens/TokenListPane.tsx | 9 | 2 |
| **합계** | **234** | **64** |

**수렴 라운드인데 추가가 삭제보다 많다 — 지표 미달이다.** 사실 2건: (1) diff 기준이 v0.5.18 커밋이라 v0.5.21 의 스테이블 기능 추가분(액면 판정·근거 문구·화면 줄)이 섞여 있어 이번 라운드 순증감이 아니다. (2) 그 점을 감안해도 extension App.tsx 136/28 은 추가 우세이고, 그 셸이 로컬 신원 계층을 안 지웠다는 사실과 일치한다.

번들 크기 v0.5.21 대조: **불가**. v0.5.21 산출물이 저장소에 남아 있지 않고(dist 미보존), 트리가 미커밋이라 git 에서 v0.5.21 상태를 복원할 수도 없다.
대체 측정: 신규 SDK 신원 계층의 고유 마커 `askMarketPrice` 를 두 산출물 전 청크에서 grep → **web 0건, extension 0건**. SDK import 로 인한 번들 증가분 = 0 바이트.

현재 크기: extension `.output/chrome-mv3` 7,017 KB · android dist 6,716 KB · web dist 23,312 KB · desktop dist 28,105 KB.

APK: 5,599,680 B. v0.5.21 = 5,599,900 B → **-220 B (-0.004%)**.

---

## 7. 산출물 · 서명 · 회귀

| 항목 | 값 |
|---|---|
| APK | `D:/TTLCOINWalet/벼린0.5.22.apk` 5,599,680 B |
| APK sha256 | `48a9b78a8e46eddd86b9ad7c4bdd20594521265473ed0ad7635f8ed5cfc750ea` |
| 서명 certSha256 | `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480` — **v0.5.21 과 동일 키** |
| versionName / versionCode | 0.5.22 / 23 |
| MSI | `apps/desktop/src-tauri/target/release/bundle/msi/벼린_0.5.22_x64_ko-KR.msi` 8,196,096 B sha256 `5BF71057009151277A52A87EB819EE5E7586AB63021B07EF5BC31A5862CA97D2` |
| NSIS | `.../bundle/nsis/벼린_0.5.22_x64-setup.exe` 7,215,252 B sha256 `185368B7E9AADCFEAC63A2D9FBFBD3138833658D9AB66070CF0E455FAEBBD3AB` |
| extension manifest.json version | 0.5.22 |
| QR 회귀 | `packages/shell-core` `tests/qr-parse.test.ts` **34 통과 · 0 실패**. 회귀 없음 |
| workingTreeClean | **false** — 커밋되지 않은 변경이 섞인 빌드. 매니페스트에 경고로 기록됨. commit=`6529912a637cf7e98e8d1d75accef18f07aef227` |
| 코드 서명(desktop) | 없음(인증서 미지정. 만들지 않았다) |

---

## 8. 남은 것

**결함 미종결 4건 (제품 코드 그대로 v0.5.22 에 담김)**

| # | 내용 | 위치 |
|---|---|---|
| D1 | extension 이 SDK `tokenValueOf` 를 안 쓴다 — 산식이 아직 2벌 | extension App.tsx:273,280,290-310,1637-1662 |
| D2 | android TokenListPane 이 `chainId` 미전달 → EVM 스테이블 22종 목록 화면 빈칸. **이번 라운드가 만든 새 셸 간 불일치**(이전엔 양쪽 다 빈칸) | android screens/TokenListPane.tsx:107 |
| D3 | android token-visibility 의 벼린 환율 경로가 표시 decimals(`authoritativeDecimals(tok.id, v.decimals)`, :327)와 다른 원본 `tok.decimals`(:333)로 TTL 을 낸다 — 한 줄 안 두 자릿수 | android lib/token-visibility.ts:327,333 |
| D4 | 목록 화면 스테이블 decimals 출처가 두 셸에서 다르다(android=내장 우선, extension=`authoritativeDecimals` → 항상 인덱서값). 인덱서 값이 내장값과 갈리는 순간 배율이 갈린다 | android :311-317,327 / extension :304,314,320 |

**사람 결정 대기 4건**

1. **DAI 담보형 soft peg 액면 유지 여부** — DAI 는 발행자 상환 약속이 아니라 담보 시스템이다. 액면 1 USD 로 계속 볼지 미결.
2. **상장자산 USD 보조줄** — 현재 Binance ticker 유지. 바꿀지 미결.
3. **상장자산 TTL 환산** — 현행 정책은 금지(액면 vs 시장 시세 경계). 허용하려면 §5 경계 규정 자체를 개정해야 한다. **사용자 검토 중.**
4. **ZION denom 스테이블 값 소멸** — `STABLE_USD` 삭제로 ZION `uusdt` 의 `$1.00` 이 사라졌다. Binance 에 `USDTUSDT` 페어가 없어 대체 시세 경로 없음. 액면을 다시 붙이려면 ZION denom 의 발행 근거 자료가 저장소에 있어야 한다(현재 없음). 이것은 버그가 아니라 심볼 판정 폐기 정책의 잔여분이다.

**미검증 1건** — 실기기 검증 없음. APK 는 빌드·서명만 확인했고 단말에서 실행하지 않았다.

---

## 9. 경로

- 보고서: `D:/TTLCOINWalet/docs/RELEASE-0.5.22.md`
- APK: `D:/TTLCOINWalet/벼린0.5.22.apk` (+ `.manifest.json`)
- desktop: `D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/{msi,nsis}/`
- extension: `D:/TTLCOINWalet/apps/extension/.output/chrome-mv3/`
- web: `D:/TTLCOINWalet/apps/web/dist/`
- 임시파일: `D:/TTLCOINWalet/scripts/conv-out/` — **비어 있음**(각 부대가 사용 후 삭제 완료). 커밋·푸시 없음.
