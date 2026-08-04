# 릴리스 0.5.18 — 활동 화면의 토큰 금액·이름

버전: 0.5.17 → **0.5.18** (android versionCode 18 → **19**)
작성 시점 실측 기준. 실행하지 않은 것은 8절에 그대로 적는다.

---

## 1. 결론

- **F2(자릿수) 닫혔다.** 활동 화면이 모든 ERC-20 을 18자리로 가정하던 코드를 4종 셸 전부에서 제거했다. `ASSUMED_TOKEN_DECIMALS` 잔재 0건(`git grep` EXIT=1), `decimals={it.token ? 18 : 18}` 0건, 하드코딩 `'TOK'` 0건.
- **F1(심볼) 3종에서 닫혔다, 1종은 부분.** android·extension 은 셸의 발견 토큰 목록에서, desktop 은 `TokenRegistry` 에서 실제 심볼을 읽는다. **web 은 조회처가 없어 토큰 항목이 항상 "미확인 토큰 + 주소 축약"으로 뜬다** — 금액은 더 이상 틀리지 않지만 이름은 나오지 않는다.
- 산출물 v0.5.18 4종 생성: APK·MSI·NSIS setup·확장(chrome-mv3)·웹 dist.
- `pnpm -r build` EXIT=0. 테스트 wallet-sdk 681 / shell-core 95 / i18n 19, 실패 0 — 기준선과 동일.

---

## 2. F2 — 사용자에게 무엇이었나 (수치)

이름이 안 나온 게 아니라 **금액이 틀렸다.**

옛 코드는 `it.token` 이 있으면 무조건 `decimals = 18` 을 썼다. USDC 는 6자리다.

```
USDC 1.5 의 원장 값(raw) = 1.5 × 10^6      = 1,500,000
옛 표시 = 1,500,000 ÷ 10^18                = 0.0000000000015
표시 함수는 소수 4자리 절사               → "0.0000 토큰"
```

즉 **1.5 USDC 를 받은 사용자의 화면에는 `0.0000 토큰` 이 떴다.** 0 이 아닌 입금이 0 으로 보였다.

반대 방향 오차도 같은 크기다. 자릿수 차 12자리이므로 배율은 10^(18-6) = **10^12 배**.

| 토큰 | decimals | raw 값 | 옛 표시(18 가정) | 새 표시 |
|---|---|---|---|---|
| USDC | 6 | 1,500,000 | 0.0000 | 1.5000 USDC |
| USDC | 6 | 1,234,567,891 | 0.0000 | 1,234.5678 USDC |
| WBTC | 8 | 100,000,000 | 0.0000 | 1.0000 WBTC |
| WBTC | 8 | 12,345 | 0.0000 | 0.0001 WBTC |
| DAI | 18 | 1.5×10^18 | 1.5000 | 1.5000 DAI (변화 없음) |

18자리 토큰만 우연히 맞았다. 6·8자리는 전부 0 으로 뭉개졌다.

**모를 때는 환산하지 않는다.** 자릿수를 확인 못 한 토큰은 소수 변환 함수를 아예 호출하지 않고 최소 단위 그대로 쉼표만 찍는다: `1,500,000  0xa0b8…eb48  최소 단위(자릿수 미상)`. 추측한 소수보다 raw 가 정확하다.

---

## 3. F1 — 심볼은 이제 어디서 오나

우선순위 3단계:

1. **셸이 이미 발견한 토큰 목록** — `discoverPortableTokens` 결과 + 수동 추가분. `PortableTokenBalance{ id, symbol, decimals }` 의 `id` 가 컨트랙트 주소다. 활동 항목의 `it.token` 과 **양쪽 `toLowerCase()`** 로 대조한다(익스플로러는 소문자, discovery 는 체크섬을 준다).
2. **온체인 보충** — 1에서 못 찾은 주소만 `readPortableToken(adapter, id, owner)` 로 조회. 첫 페인트를 막지 않는 별도 effect, `cancelled` 플래그, `try/catch` 로 실패를 삼킨다(이 함수는 설계상 던진다). 고유 주소 **상한 8개** — 공개 RPC rate limit 때문이다(같은 이유로 이 파일은 lookback 을 200→60 으로 낮춘 전례가 있다).
3. **실패/부재 = 모른다고 표시** — 심볼 자리에 주소 축약 `0x1234…cdef`, 금액 옆에 `최소 단위(자릿수 미상)`, 각주에 `미확인 토큰 · 0x1234…cdef · 최소 단위(자릿수 미상)`.

고정 문구 `activity.label.token`("토큰")을 심볼 자리에 찍는 코드는 셸 4종에서 0건이다. 카탈로그의 키 정의 자체는 남겨 두었다(삭제 시 다른 참조 파손 위험).

신규 i18n 키 2개(ko/en 동시):
- `activity.label.raw_units` — "최소 단위(자릿수 미상)" / "raw units (decimals unknown)"
- `activity.label.unknown_token` — "미확인 토큰" / "Unknown token"

---

## 4. 셸별 적용

| 셸 | 활동 화면 | 심볼 출처 | 온체인 보충 | F2 | F1 |
|---|---|---|---|---|---|
| android | 있음 (`src/screens/ActivityPane.tsx`) | 셸 목록(`tokens={sendTokens}` prop 신설) | 있음 (상한 8) | 닫힘 | 닫힘 |
| extension | 있음 (`popup/screens/ActivityPane.tsx`) | 셸 목록(prop 신설) | 있음 (상한 8) | 닫힘 | 닫힘 |
| desktop | 있음 (`src/views/Activity.tsx`) | `new TokenRegistry().getToken(TTL_CHAIN.id, addr)` | 없음 | 닫힘 | **레지스트리 등재분만** |
| web | **있음** (`src/screens/Activity.tsx`) | 없음 | 없음 | 닫힘 | **미해결 — 항상 주소 축약** |

- android / extension 두 파일은 서로의 복제다. 같은 패치를 양쪽에 넣었고 렌더 로직은 동치다. 변수명만 갈렸다(`extraMeta` ↔ `fetchedMeta`, `ONCHAIN_META_LIMIT` ↔ `TOKEN_META_LOOKUP_LIMIT`).
- desktop / web 은 wallet-store 에 토큰 목록 상태가 없다(grep "token" 0건). desktop 은 배럴이 export 하는 `TokenRegistry` 로 우회했고, web 은 `defaultTokenRegistry` 가 배럴에 없어(배럴 수정은 이번 범위 밖) raw 표기까지만 갔다.
- desktop 은 native 심볼·자릿수를 `TTL_CHAIN.nativeCurrency` 에서 읽도록 바꿔 `activity.label.native`('TTL' 고정) 의존을 걷어냈다.

---

## 5. 검증

**자릿수 케이스 실측** — `scripts/act-out/decimals.test.ts`, `npx vitest run` EXIT=0, 1 file / **11 tests passed / 0 failed**.
2절 표의 값이 전부 이 테스트의 실측 결과다. 추가로:
- `rawAmount`: `1500000n → "1,500,000"`, `0n → "0"`, `123n → "123"` — 소수점 생성 0건.
- `lookupToken` 대소문자: 소문자 익스플로러 주소로 체크섬 목록의 USDC(6)·WBTC(8)·DAI(18) 전부 적중. 미등록 주소·`tokens=null` → `undefined`.

**잔재 grep (전부 0건)**
```
git grep -n "ASSUMED_TOKEN_DECIMALS"   → EXIT=1 (히트 없음)
git grep -n "'TOK'" -- apps            → 0건
git grep -n "activity.label.token" -- apps → 0건 (카탈로그 정의만 잔존)
```

**i18n 정합** — ko 598 / en 598 키, ko-only 0, en-only 0. `ko/en parity` 테스트 통과.

**빌드·테스트** (파이프로 종료코드를 가리지 않았다 — 로그는 파일 리다이렉트, `$?` 직접 출력)

| 항목 | 결과 |
|---|---|
| `pnpm -r build` | **EXIT=0** (4종 셸 + packages). Vite 8 유지 |
| wallet-sdk test | EXIT=0 — 42 files / **681 passed** / 10 skipped |
| shell-core test | EXIT=0 — 3 files / **95 passed** |
| i18n test | EXIT=0 — 1 file / **19 passed** |
| extension test | EXIT=0 — 6 files / **118 passed** (activity-pane 19건 포함) |

기준선(681 / 95 / 19)과 정확히 일치. 실패 0.

`git diff --stat`: **32 files changed, 1,359 insertions(+), 338 deletions(-)** — 이 라운드의 다른 작업분(QR, Send 등)이 섞인 수치다. 활동 화면 관련분만: android ActivityPane +100, extension ActivityPane +102, desktop Activity +48, web Activity +40, i18n ko +55 / en +50.

---

## 6. 산출물

| 산출물 | 경로 | 바이트 | 직전판 대비 |
|---|---|---|---|
| APK | `D:/TTLCOINWalet/벼린0.5.18.apk` | 5,597,152 | 0.5.17 5,596,840 → **+312** |
| MSI | `apps/desktop/src-tauri/target/release/bundle/msi/벼린_0.5.18_x64_ko-KR.msi` | 8,192,000 | 8,187,904 → **+4,096** |
| NSIS | `apps/desktop/src-tauri/target/release/bundle/nsis/벼린_0.5.18_x64-setup.exe` | 7,211,403 | 7,210,433 → **+970** |
| 확장 | `apps/extension/.output/chrome-mv3` | 7,099,365 | manifest.json version = 0.5.18 확인 |
| 웹 | `apps/web/dist` | 23,826,805 (소스맵 포함 / 제외 5,728,243) | index-CDQhiwhd.js 5,243,914 |

**APK 해시·서명** (`벼린0.5.18.apk.manifest.json` 원문)
- sha256 `87d2c9425f06bb5a95fe1b534fd3d2e4495659734d478220e473187cbb8f9637`
- signer.certSha256 `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480`
- 기준 인증서 `303f801b…f103480` 과 **일치 = 같은 키로 서명했다. 맞음.** 키스토어를 새로 만들지 않았다.
- MSI/NSIS 는 **코드서명 없음** — Tauri Windows 서명이 원래 미구성이고 이번에 바꾸지 않았다.

**QR 회귀 없음 = 맞음.** APK 안 `assets/public/assets/index-BJpVo0X2.js` 를 단일 추출해 확인:
`getUserMedia` 1건(실코드 `navigator.mediaDevices` 분기), `jsQR` 1건(UMD 배너 — 라이브러리 본체 포함), `videoWidth` 1건, `environment` 3건. QR 스캐너 코드가 0.5.18 APK 에 그대로 들어 있다.

**버전 반영 파일 7개** (잔존 "0.5.17" 0건): web·extension·android·desktop 의 `package.json`, `tauri.conf.json:4`, `Cargo.toml:3`, `android/app/build.gradle:18-19`(versionCode 19 / versionName "0.5.18"). Cargo.lock:183 도 0.5.18 로 일치.

---

## 7. 빌드 시점 소스 상태

**작업 트리는 더럽다. 매니페스트에 그대로 기록했다 — 고치지 않았다.**

```
source.commit           8f8ee530eb8d847e7115551d71df4145a1dce443 (8f8ee53), branch main
source.workingTreeClean false
warning                 "커밋되지 않은 변경이 섞인 빌드다. 이 산출물은 소스로 추적할 수 없다."
```

`git status --short` 실측: **modified 32건 + untracked 10건.** 즉 이 APK 의 sha256 은 커밋 8f8ee53 으로 재현되지 않는다. 해시로 "우리가 배포한 파일"임은 확인되지만, "이 소스에서 나왔음"은 확인되지 않는다. 커밋·푸시는 지시가 없어 하지 않았다.

toolchain: node v24.15.0 / gradle 8.14.3 / AGP 8.13.0 / compileSdk 36 / minSdk 24 / targetSdk 36.

---

## 8. 남은 것

**미완 (코드로 확정)**
1. **web 셸의 F1.** 활동 화면은 있으나 토큰 목록도 레지스트리 조회도 없다. 알려진 토큰(USDC 등)도 영원히 "미확인 토큰"으로 뜬다. 사용자 신고 문구 "토큰명 안 나옴"이 web 에서는 그대로 남는다. 해결하려면 `defaultTokenRegistry` 를 배럴에 export 하거나 web wallet-store 에 토큰 목록 상태를 넣어야 한다 — 둘 다 이번 범위 밖이었다.
2. **desktop 의 온체인 보충 없음.** 레지스트리 미등재 토큰은 raw 표기로 남는다. `walletStore.getDefaultAdapter()` 가 `unknown` 캐스팅으로만 쓰여 EvmAdapter 접근이 확인되지 않았다.
3. **android ActivityPane 의 온체인 보충 effect 에 `isEvm` 가드가 없다**(extension 에는 있다). 비EVM 에서는 items 가 null 이라 실행되지 않아 **현재는 무해**하나, 두 복제 파일이 갈린 지점이다.
4. **android/extension 변수·상수명 불일치** — 복제 관계 유지에 불리하다.
5. `activity.label.native` 의 ko 값이 `'TTL'` 로 박혀 있다. 지금은 참조가 없어 표시에 영향 없다.

**미검증**
- **실기기·에뮬레이터 구동 0회.** 화면을 실제로 본 검증이 없다. 판정은 전부 소스·테스트·grep·빌드 기반이다.
- 온체인 보충의 실제 RPC 왕복을 돌려보지 않았다 — 상한 8은 코드로만 확인했다.
- android·desktop·web 워크스페이스에 테스트 하네스가 없다. 이 세 셸의 수정은 tsc + 빌드 통과 외 자동 검증이 없다(extension 복제본 테스트가 android 로직을 간접 커버).
- MSI/NSIS 설치·구동 안 함. Tauri 네이티브 cargo 재빌드 외 실행 없음.

**사람 결정 필요**
1. **커밋 여부.** 지금 커밋하지 않으면 v0.5.18 산출물은 재현 불가 상태로 남는다.
2. **web 셸 F1 을 이번 릴리스에 포함할지, 다음으로 미룰지.** 미루면 web 사용자에게는 이름 문제가 남는다.
3. 배럴(`packages/wallet-sdk/src/index.ts`)에 `defaultTokenRegistry`·`readPortableToken`·`PortableTokenBalance` 를 export 할지. 현재는 셸들이 `/core` 서브패스로 우회하고 있다.

---

## 9. 경로

**산출물**
- `D:/TTLCOINWalet/벼린0.5.18.apk` · `D:/TTLCOINWalet/벼린0.5.18.apk.manifest.json`
- `D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/msi/벼린_0.5.18_x64_ko-KR.msi`
- `D:/TTLCOINWalet/apps/desktop/src-tauri/target/release/bundle/nsis/벼린_0.5.18_x64-setup.exe`
- `D:/TTLCOINWalet/apps/extension/.output/chrome-mv3`
- `D:/TTLCOINWalet/apps/web/dist`

**수정 파일**
- `D:/TTLCOINWalet/apps/android/src/screens/ActivityPane.tsx` · `apps/android/src/App.tsx`
- `D:/TTLCOINWalet/apps/extension/entrypoints/popup/screens/ActivityPane.tsx` · `.../popup/App.tsx`
- `D:/TTLCOINWalet/apps/desktop/src/views/Activity.tsx`
- `D:/TTLCOINWalet/apps/web/src/screens/Activity.tsx`
- `D:/TTLCOINWalet/packages/i18n/src/messages/ko.ts` · `en.ts`
- 버전: 4종 `package.json`, `tauri.conf.json`, `Cargo.toml`, `android/app/build.gradle`
- `D:/TTLCOINWalet/docs/CHANGELOG.md`

**임시파일** (`D:/TTLCOINWalet/scripts/act-out/` — 커밋·푸시 안 했다)
- `decimals.test.ts` (11 케이스 검증 테스트) · `desktop-vite.log` · `ext-build.log` · `tauri-build.log` · `web-build.log`
