# 릴리스 0.5.19 — TRON USDT 이름표 (versionCode 20)

날짜 2026-08-04 · 기준 커밋 6529912 (main) · 직전 0.5.18

---

## 1. 결론

- **[A] TRC-20 이름 표시 — 닫혔음.** TRON 의 USDT 가 축약 주소(`TR7NHq…jLj6t`) 대신 `USDT / Tether USD` 로 뜬다. 네트워크 호출 **0회**로 붙인 이름이다. 실제 TronGrid 라이브 조회로 확인했다.
- **[B] TRX 달러 표시 — (가) 로 확정. 결함 아님. 이번에 바꾸지 않았음.** TRX 잔액 자리는 **수량 + 심볼**이고, 달러는 그 아래 **별도 보조 줄**이다. 수량이 달러로 치환된 경로는 코드에 없다. 유지/삭제는 사람이 정할 정책이다.

---

## 2. [A] USDT 가 왜 주소로 보였는가

### 원인 — 버그 아님, 예산 절충이었음

`packages/wallet-sdk/src/chains/tron.ts` 는 무키 TronGrid 를 쓴다. 실측(2026-07-29, 주석 :339 · :493): **연속 3회까지 수락, 4회째 거부, 2초 대기로도 회복 안 됨.**

토큰 1개당 `decimals()` + `symbol()` + `name()` 3회를 병렬로 쏘던 옛 구현의 실측 결과가 **880개 중 0개**였다. 그래서 예산을 `decimals` 하나에 몰아주고(`fetchLabels` 기본 false), 이름은 `shortenAddress(contract)` 로 대체했다(:541, :544).

근거: `decimals` 가 틀리면 **금액이 자릿수째로 거짓**이 되고 화면에서 구별되지 않는다. 이름표는 없어도 주소로 대체 가능하다. 즉 옳은 절충이었다. **문제는 USDT 처럼 주소가 고정된 유명 토큰까지 이 절충에 걸렸다는 것** — 그런 토큰은 RPC 를 한 번도 쓰지 않고 이름을 붙일 수 있다.

### 해결 1 — 내장 목록 (RPC 0회)

신규 `packages/wallet-sdk/src/chains/trc20-known.ts`.

- 엔트리 **1종**: `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` → `USDT` / `Tether USD`.
- 근거(evidence 필드에 기록, 저장소 내 3곳): `apps/android/src/App.tsx:192`, `apps/extension/entrypoints/popup/App.tsx:190`, `packages/shell-core/tests/qr-parse.test.ts:255`.
- **USDC 등은 넣지 않았다** — 저장소 안에 근거가 없다. 기억에서 적으면 지어낸 주소가 되고, 이 값은 라벨이 아니라 매칭 키라 틀리면 다른 컨트랙트를 USDC 로 라벨링한다(사용자가 그것을 골라 송금).
- **decimals 는 비워 뒀다.** 내장 decimals 를 믿어도 아껴지는 RPC 는 0회다 — `decimals()` 호출은 어차피 나간다. 이득 0, 위험만 있다. 필드와 정책(`reconcileKnownDecimals`)은 만들어 두되 **체인 값이 항상 이긴다.**
- 조회는 **정규화 없는 정확 일치**다. EVM `TokenRegistry` 를 재사용하지 않은 이유 2개: `registry.ts:301` 의 `normAddr` 가 `toLowerCase()` 하는데 **TRON base58check 는 대소문자가 정보**다(소문자화하면 송금 불가 문자열), `registry.ts:305` 의 Map 키가 `number` 라 TRON 에 줄 chainId 가 없다.

### 해결 2 — 라벨 예산 정책 (fetchLabels 켤 때만)

- `readTrc20Metadata` 안의 `Promise.all([symbol, name])` **병렬 발사 제거**(구 :531-536). 이 한 줄이 토큰마다 3회 한도를 정면으로 밟고 있었다.
- 신규 2단계 `fillLabels`: decimals 루프가 **완전히 끝난 뒤**에만, 내장목록 미등재 토큰 중 잔액(자릿수 보정) 내림차순 **상위 K개**에 `symbol()` 만 순차 호출. `K = maxLabelLookups` 기본 **5**.
- `name()` 은 부르지 않는다 — 폴백이 `name ?? symbol ?? 축약`(:545)이라 symbol 하나로 두 칸이 채워진다. 라벨 1칸당 호출 1회.
- 2단계 예외는 전부 삼키고 **1단계 결과 배열은 손대지 않는다.**

### 왕복 수 대조 (토큰 20개 기준, `maxTokens` 기본 20)

| 경로 | 수정 전 | 수정 후 | 계산식 |
|---|---|---|---|
| 기본(`fetchLabels=false`) | **21** | **21** | 계정 API 1 + decimals 20 |
| 이름표 조회(`fetchLabels=true`) | **61** | **26** | 전: 1 + 20×3(decimals,symbol,name) · 후: 1 + 20 + min(5, 미등재 수) |

기본 경로 왕복 수 **변화 0**. 사용자 신고 증상은 기본 경로에서 **RPC 0회 증가로** 해소된다.

---

## 3. [B] TRX 달러 표시 조사 결과

### 확정 사실 — (가) 다

| 위치 | 내용 |
|---|---|
| `apps/android/src/App.tsx:1538-1541` | 히어로 **메인 줄** = `formatAmount(balance, nativeDecimals)` + `{nativeSymbol}`. TRON 이면 decimals 6 / `TRX`. |
| 같은 파일 :1545-1555 | **보조 줄 1개.** TTL 이면 `노동자 N 일 품삯`, 아니면 `nativeUsd` 가 있을 때만 `≈ $x`. |
| :1215-1221 → :2172 | `nativeUsd` = `tokenToUsd('TRX')` = Binance `TRXUSDT` 직접 매치. |
| `apps/extension/entrypoints/popup/App.tsx:1144-1150 / 1494-1508` | 확장 셸 동일 구조. |

**TRX 수량이 달러 숫자로 치환되는 경로는 4종 셸 어디에도 없다.** TTL 줄과 USD 줄은 같은 `<p>` 슬롯을 if/else 로 배타 사용하므로 동시 표시도 없다.

### 닫힌 결정과 어긋나는가 — 구분

| 항목 | 판정 | 근거 |
|---|---|---|
| TRX 등 외부 상장자산 native 의 `≈ $x` 보조 줄 | **어긋나지 않음.** 사용자 취향과의 차이다. | docs/CONTEXT.md §5(:269-270) 가 "외부 상장자산만 Binance 트랙에서 USD 로 잰다" 로 **명시 허용**. |
| web `apps/web/src/screens/Account.tsx:224-226` · desktop `apps/desktop/src/views/Wallet.tsx:310-312` 의 **TTL** USD 라인 | **어긋남 (§5 위반) 1건.** | §5 는 "TTL 잔액 옆에는 그 정의가 곱셈 0회로 온다". 2026-08-02 라운드에서 android·extension 만 고쳐지고 두 셸이 남았다. web 은 가격이 없어도 `≈ — · 시세 없음` 줄을 **항상** 그려(:225) "TTL 에 달러 시세가 있다"는 전제를 남긴다. 가격원도 Binance 가 아니라 CoinGecko `getPrice('ttl')` 다. |

또한 두 앵커가 만나는 코드는 여전히 **0건**이다: `TTL_PEG_BTC` · `KWR_PEG_BTC` · `nativeToTtl` · `usdToTtl` · `totalUsd` · `portfolioTotal` 전 저장소 grep 히트 0.

### 바꾸려면 — 선택지와 잃는 것

| 선택지 | 얻는 것 | 잃는 것 |
|---|---|---|
| ① 그대로 둔다 | 상장자산의 시세를 사용자가 앱 안에서 본다. §5 준수. | 사용자가 지적한 그 화면이 그대로다. |
| ② 상장자산 native 의 USD 보조 줄을 **끈다** | 4종 셸이 수량만 말한다. "지갑은 환율을 말하지 않는다" 가 일관된다. | BTC·ETH·SOL·TRX·TON·APT·SUI·XRP 8종의 가치 감각을 사용자가 밖에서 찾아야 한다. ZION 4종 자산 줄(:1578-1582)도 같이 사라진다. |
| ③ 토글(설정으로 켜고 끈다) | 양쪽을 다 만족. | shell-core 에 설정 저장소가 **없다**(grep `settings|rpcOverride` 히트 0). 저장소 + 설정 화면 4종을 새로 만들어야 한다. |
| ④ web·desktop 의 **TTL** USD 라인만 제거 | §5 위반 1건이 닫힌다. 취향 문제와 무관하게 규칙 시정. | 없음(잃는 기능이 규칙 위반분이다). |

**이번 릴리스에서 [B] 는 코드 변경 0건이다.** ①~④ 어느 것도 하지 않았다. 사람의 결정을 기다린다.

---

## 4. 셸별 적용 표

| 셸 | TRON 지원 | 셸 코드 변경 | 이유 |
|---|---|---|---|
| android (Capacitor) | 지원 | **0건** | `App.tsx:1321` 이 어댑터 반환 배열을 그대로 setState 하고 :1620 이 `row.symbol` 을 그대로 그린다. 셸은 심볼을 가공하지 않는다 → SDK 수정이 그대로 화면에 반영. |
| extension (WXT/MV3) | 지원 | **0건** | popup `App.tsx:1576-1577`, :1092, :1309 전부 `t.symbol` 그대로. 셸에 주소표를 복제하면 이중 관리가 되고 어긋날 때 화면이 거짓을 말한다. |
| web (Vite 8) | **미지원** | 0건 | `apps/web/src` 전체를 `tron|TRON|TRX` 로 훑어 히트 1건 — `Activity.tsx:219` 의 `<strong>` 오탐. TTL 단일 체인 셸. |
| desktop (Tauri 2) | **미지원** | 0건 | 동일. 히트 1건 `DApp.tsx:220` `<strong>` 오탐. |
| i18n | — | 0건 | 새 문구 없음. 산출물은 UI 문구가 아니라 토큰 symbol/name **데이터**다. |

변경된 소스는 `packages/wallet-sdk/src/chains/` 2파일 + 테스트 1파일뿐이다.

---

## 5. 검증

### TRON 라이브 실조회 (모의 아님, api.trongrid.io)

검증 주소는 기억에서 적지 않고 TronGrid Transfer 이벤트에서 뽑아 base58 변환해 확보했다.

| 항목 | 결과 |
|---|---|
| 주소 `TNksv6RGtoxbmhkobjjMbEAmy9udm2in7v` (USDT 단독 보유) | `symbol="USDT"`, `name="Tether USD"`, `decimals=6`, `balance=10000`(=0.01 USDT) |
| source 문자열 | `trongrid:/v1/accounts(목록·잔액); contract:decimals; symbol,name=내장목록(RPC 0회)` |
| 독립 대조(별도 constant call) | `balanceOf`=10000 일치 · `decimals()`=6 일치 · 온체인 `symbol()`="USDT" 로 내장값과 일치 |
| 왕복 수 | **2** = 계정 API 1 + decimals 1. 이름표 RPC **0회** |

### 미등록 토큰 안전성

주소 `TQgxyP1jDXGBvmgwqnJ7jKkEqWEogfRM5V`, 잔액>0 TRC-20 17종.

- `fetchLabels=false`: 왕복 **18** = 1 + 17. 미등록 토큰은 그대로 축약 심볼(예: `TL81r5…fm82`) + 체인 decimals(18/3/6) + raw balance. **이름을 지어내지 않는다.**
- `fetchLabels=true`: 왕복 **21** = 1 + 17 + symbol 3(K=5 상한, 생존 토큰 3개). 수정 전 동일 조건 = 1 + 17×3 = **52**. 예산 소진 재발 없음.

### 주소 정합성 (자가보고와 무관하게 직접 디코딩)

`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` → base58check 25바이트, 이중 SHA-256 체크섬 일치, payload `41a614f803b6fd780986a42c78ec9c7f77e6ded13c`(0x41 접두 + 20바이트). 목록 엔트리 1건, 근거 없는 주소 **0건**.

조회 지점 2곳 모두 정규화된 base58 을 넘긴다: `tron.ts:431`(수동, :422 normalizeAddress 통과), `tron.ts:576`(`entry.contract` 는 :530 에서 이미 base58 변환). 소문자 입력은 `undefined`(테스트 :507).

### 빌드·테스트 (본 보고서 작성 시점 직접 실행)

| 항목 | 결과 | 기준선 |
|---|---|---|
| `pnpm -r build` | **EXIT=0** (8개 프로젝트) | EXIT=0 |
| `@byeorin/wallet-sdk test` | **EXIT=0** — 42 files, **692 passed** / 10 skipped / 0 failed | 681 → **+11** |
| `@byeorin/shell-core test` | **EXIT=0** — 3 files, **95 passed** / 0 failed | 95 |
| `@byeorin/i18n test` | **EXIT=0** — 1 file, **19 passed** / 0 failed | 19 |
| `pnpm -r typecheck` | EXIT=0 (오류 0) | — |

`git diff --stat`: 13 files changed, 413 insertions(+), 72 deletions(-). untracked 2건(`trc20-known.ts`, `벼린0.5.19.apk.manifest.json`).

---

## 6. 산출물

| 산출물 | 크기(B) | 0.5.18 대비 | sha256 |
|---|---|---|---|
| `벼린0.5.19.apk` | 5,598,648 | +1,496 | `5a9cf8d148cd301caad344d451ef4e3b7395dad95b3c2792b0deb9fcf481dad7` |
| `벼린_0.5.19_x64_ko-KR.msi` | 8,196,096 | +4,096 | `dd16f2ad2258e3c5bb46988a3349c12b9050f81efe2502fbce8a59247a6397bb` |
| `벼린_0.5.19_x64-setup.exe` | 7,215,768 | +4,365 | `4ac6bb3e0c01d191775597a6311c668e46e51881a2924205ace449bddc170e78` |
| extension `.output/chrome-mv3` | 7,103,254 | — | manifest `"version":"0.5.19"` 확인 |
| web `dist` | 23,833,589 (소스맵 포함) | — | — |

**서명 키 — 동일.** `certSha256 = 303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480` 로 0.5.18 과 같다. 덮어 설치해도 지갑이 유지된다. 키스토어는 새로 만들지 않았다.

**QR 회귀 없음.** APK 를 파일 단위로 풀어 검사: `assets/public/assets/index-CQH7ix6D.js` 에 `jsQR` 2회, `getUserMedia` 2회 출현.

**내장 목록 번들 확인.** `multichain-Z3yVz65l.js` 안에 `"USDT"` · `"Tether USD"`(9회) · `TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t` 실재.

**`workingTreeClean: false`** — 매니페스트에 경고가 동봉돼 있다: "커밋되지 않은 변경이 섞인 빌드다. 이 산출물은 소스로 추적할 수 없다." 이번 라운드 변경분이 미커밋 상태다. **배포하려면 커밋 후 재빌드해야 매니페스트가 소스와 짝이 맞는다.**

버전 상향 7파일: web/extension/android/desktop `package.json`, `tauri.conf.json:4`, `Cargo.toml:3`(+Cargo.lock:183), `build.gradle:18-19`(versionCode 19→20).

---

## 7. 남은 것

### 미완 — 실측으로 새로 드러난 결함 1건

**토큰이 많은 계정에서는 USDT 항목 자체가 사라진다.** 주소 `TQgxyP1j…RM5V`(17종 보유)에서 decimals 17회 중 성공 3~4회, 나머지 13~14회가 무키 TronGrid 한도로 실패해 `tron.ts:585-593` 이 토큰을 통째로 드롭한다. 2회 반복 모두 `TR7NHqje…` 가 `decimals-unreadable` 로 드롭됐다. 같은 호출을 단독으로 쏘면 6/6 성공하므로 원인은 컨트랙트가 아니라 **연속 호출 한도**다.

- 이는 **수정 전에도 있던 동작이다 — 회귀가 아니다.**
- 내장 이름표는 "USDT 가 목록에 남았을 때"만 효과가 있다.
- 해결 경로는 이미 만들어져 있다: `KnownTrc20.decimals` 폴백. 현재 USDT 엔트리에 decimals 가 없어 비활성이다. **이번 검증에서 온체인 `decimals()`=6 이 실측됐으므로 근거는 이제 존재한다** — 다음 라운드에 채우면 이 경로가 살아난다.

### 미검증

- **실기기 화면 확인 안 함.** APK 안에 내장 목록이 번들된 것까지만 확인했다. 안드로이드 실기기에서 TRON 지갑을 열어 USDT 줄을 눈으로 본 적은 없다.
- desktop MSI/NSIS 는 **설치·기동하지 않았다.** 번들 생성까지만. 코드 서명 없음(Tauri 설정에 서명 항목 없음).
- `pnpm -r typecheck` 1회차가 EXIT=2 로 실패했다(desktop TS7016 `@byeorin/wallet-sdk` 선언 파일 못 찾음 14건). 재실행 EXIT=0, baseline 도 EXIT=0 — **재현되지 않았다.** 빌드 직후 dist d.ts 가시성 타이밍으로 보이나 **원인 미확정이다.** CI 에서 build 와 typecheck 를 병렬로 돌리면 다시 나올 수 있다.
- 무키 TronGrid 한도의 정확한 회복 규칙은 모른다. "연속 3회/4회째 거부"만 실측이다.

### 사람이 결정할 것

1. **[B] 상장자산 native 의 USD 보조 줄 — 유지할 것인가 끌 것인가.** §5 위반이 아니므로 규칙으로 결정되지 않는다. 위 §3 의 ①~③ 중 선택.
2. **web·desktop 의 TTL USD 라인(§5 위반 1건) — 제거할 것인가.** 위 §3 의 ④.
3. **TRC-20 USDT 에 `≈ $1` 줄이 새로 붙는다.** 심볼이 `USDT` 가 되면 `App.tsx:2157-2163` 의 `STABLE_USD` 하드코딩에 걸린다. 이 하드코딩은 **심볼만 보고 $1 을 단정**하므로, 심볼이 `USDT` 인 위조 컨트랙트도 $1 로 찍힌다. 1번을 결정하기 전에는 신고가 반복될 수 있다.
4. **커밋 여부.** 현재 워킹트리 미커밋. APK 매니페스트가 `workingTreeClean: false` 다.

### 백로그 (이번 범위 밖)

- `tron.ts:69` 의 `maxTokens` 주석이 아직 "토큰 1개당 계약 호출 3회(decimals/symbol/name)" 라고 적혀 있다. 실제는 1회다(같은 파일 :129 주석은 맞게 적혀 있음).
- `tron.ts:826` — `fillLabels` 성공 후 `nameFromContract` 가 false 로 남아 source 에 `name=대체(읽기실패)` 가 붙는다. name 은 실제로 체인 symbol 에서 유래하므로 문구가 사실과 어긋난다(금액·주소에는 영향 없음).
- **API 키를 넣을 자리가 없다.** `apiKey`(tron.ts:58)는 TronGrid REST 헤더(:441)에만 붙고, constant call 은 키 없는 tronweb 인스턴스(:188)를 탄다. 게다가 `multichain.ts:236` 이 `build: () => new TronAdapter()` 무인자이고 shell-core 에 설정 저장소가 없다. "키 있으면 fetchLabels 켜라"(:70) 는 현 코드로 성립하지 않는다. 선행 3건: ① tronweb 헤더 주입, ② `ChainSpec.build` 옵션 경로, ③ 셸 설정 화면.
- 진짜 지연 로딩(라벨을 화면 그린 뒤 채우기)은 어댑터가 배열 1개를 반환하는 계약이라 불가. `onTokenLabels` 콜백 + 셸 4종 대응이 필요하다.

---

## 8. 경로

**신규·수정 소스**
- `D:\TTLCOINWalet\packages\wallet-sdk\src\chains\trc20-known.ts` (신규)
- `D:\TTLCOINWalet\packages\wallet-sdk\src\chains\tron.ts`
- `D:\TTLCOINWalet\packages\wallet-sdk\tests\tron-trc20.test.ts`

**산출물**
- `D:\TTLCOINWalet\벼린0.5.19.apk` / `D:\TTLCOINWalet\벼린0.5.19.apk.manifest.json`
- `D:\TTLCOINWalet\apps\desktop\src-tauri\target\release\bundle\msi\벼린_0.5.19_x64_ko-KR.msi`
- `D:\TTLCOINWalet\apps\desktop\src-tauri\target\release\bundle\nsis\벼린_0.5.19_x64-setup.exe`
- `D:\TTLCOINWalet\apps\extension\.output\chrome-mv3`
- `D:\TTLCOINWalet\apps\web\dist`

**문서**
- `D:\TTLCOINWalet\docs\RELEASE-0.5.19.md` (이 파일)
- `D:\TTLCOINWalet\docs\CHANGELOG.md` (v0.5.19 항목)

**임시파일 — 잔존 0건.** `D:\TTLCOINWalet\scripts\tron-out\` 는 검증 부대가 사용 후 폴더째 삭제했다. 본 보고서 작성 시점 `ls` 결과: 디렉터리 없음. 저장소 안 임시파일 0건, 커밋·푸시 0건.
