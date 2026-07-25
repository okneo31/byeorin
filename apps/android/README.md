# 벼린 — Android 셸

TTL 생태계 멀티체인 지갑의 안드로이드 앱. **9 체인 어댑터(16 슬롯) 전부 동작한다.**

- 패키지: `top.ttl1.byeorin` · 표시명 `벼린` · versionName `0.5.0`
- 구조: Vite + React (WebView) + Capacitor 8 → 네이티브 APK
- 코드 출처: `apps/extension/entrypoints/popup/App.tsx` (확장 팝업)에서 갈라져 나옴

---

## 왜 React Native 가 아니라 WebView 인가

`PLAN.md` 는 모바일 셸을 RN 0.76 Bare 로 잡아뒀지만, 9 체인 전부를 요구하는 순간
RN 은 선택지에서 빠진다. **Hermes 엔진에 WebAssembly 가 없다.**

| 체인 | 라이브러리 | Hermes | Android WebView |
|---|---|---|---|
| BTC | `@scure/btc-signer` | WASM 경로 실패 | ✅ |
| SOL | `@solana/web3.js` | WASM ed25519 실패 | ✅ |
| TRON | `tronweb` | Node 전제 다수 | ✅ |
| XRP | `xrpl` | ws/Buffer 심 필요 | ✅ |
| EVM·Cosmos·TON·Aptos·Sui | viem / cosmjs / … | 폴리필 다수 | ✅ |

Android WebView 는 Chromium 이라 WASM · WebCrypto · Buffer 폴리필 · dynamic import 가
확장 팝업과 **동일하게** 동작한다. 그래서 2543 줄짜리 팝업 UI 를 재작성 없이 옮길 수
있었고, 9 체인이 첫 빌드부터 살아 있었다.

`apps/mobile` (RN 스캐폴드, 네이티브 프로젝트 없음)은 손대지 않고 남겨뒀다. 네이티브
HW(USB-OTG) 서명처럼 WebView 로 불가능한 요구가 생기면 그때 다시 꺼내는 편이 낫다.

---

## 확장 팝업과 다른 점

| | 확장 | 안드로이드 |
|---|---|---|
| 잠금 | `chrome.storage.session` (브라우저가 알아서 휘발) | **비밀번호로 봉인한 영구 금고** (`keystore-session.ts`) |
| HW(Ledger) | WebHID | 없음 — WebView 에 WebHID 가 없다 |
| 연결된 사이트/grants | EIP-1193 주입 | 없음 — 주입할 dApp 페이지가 없다 |
| 뒤로가기 | 없음 | 하드웨어 뒤로가기 → 화면 스택 (`back-button.ts`) |
| 자동 잠금 | 없음 | 백그라운드 2분 초과 시 (`autolock.ts`) |

### 금고 (`src/keystore-session.ts`)

shell-core 의 `EncryptedKeystoreStore` (scrypt N=2¹⁶ + AES-256-GCM) 를 localStorage
위에 얹고 셸 요구사항 세 가지를 덧댄 계층:

1. **오입력이 지갑을 지우지 않는다.** `WalletStore.tryAutoRestore()` 는 복원 중
   예외가 나면 세션을 지운다. 비밀번호를 그 경로에 그대로 물리면 오타 한 번에
   금고가 날아간다. 그래서 복호화는 `unlock()` 안에서 먼저 끝내고 성공한 평문만
   캐시에 올린다.
2. **계정 전환마다 KDF 를 돌지 않는다.** 캐시는 즉시 갱신, 암호화 저장은 350ms
   디바운스로 백그라운드 처리. 잠금·백그라운드 진입 시 `flush()` 로 확정한다.
3. **`clear()` = 잠금, `wipe()` = 폐기.** 확장에서는 세션이 시드의 유일한 사본이라
   `lock()` 이 곧 폐기였지만, 앱에서 같은 의미면 잠금 버튼 한 번에 지갑이 사라진다.

### ZION AMM 만 네이티브 HTTP (`src/native-http.ts`)

9 체인 RPC 엔드포인트의 CORS 를 전수 실측(2026-07-25)한 결과, 응답에
`Access-Control-Allow-Origin` 이 **없는 것은 `api.zion1.top` (AMM 인덱서) 하나뿐**이다.
확장은 `host_permissions` 로 CORS 를 통째로 우회했지만 WebView 는 평범한
`https://localhost` 오리진이라 그 장치가 없다.

전역 `CapacitorHttp` 패치(모든 fetch 를 네이티브로) 대신 `ZionAmmClient` 에만
네이티브 fetcher 를 주입한다 — 전역 패치는 viem 의 AbortSignal/스트리밍 처리와
충돌할 여지가 있고, 나머지 8 체인은 브라우저 fetch 로 이미 잘 통과한다.

---

## 빌드

사전 조건: Node 20+, pnpm, JDK 17, Android SDK (platform 34+, build-tools).
`scripts/gradle.mjs` 가 SDK/JDK 경로와 `local.properties` 를 알아서 잡는다.

```sh
# 1) 워크스페이스 패키지 빌드 (최초 1회 또는 packages/* 수정 후)
pnpm -w --filter '@byeorin/wallet-sdk' --filter '@byeorin/shell-core' \
        --filter '@byeorin/i18n' --filter '@byeorin/design-system' build

# 2) 릴리스 서명 키스토어 생성 (최초 1회)
node scripts/keystore.mjs
#    → android/keys/byeorin-release.jks + android/keystore.properties
#    ⚠ 둘 다 gitignore 대상. 저장소 밖에 백업할 것 —
#      잃어버리면 같은 앱으로 업데이트를 낼 수 없다.

# 3) APK
pnpm apk            # debug + release 둘 다
pnpm apk:debug      # 디버그만
pnpm apk:release    # 릴리스만
```

산출물:

```
android/app/build/outputs/apk/debug/app-debug.apk       (~6.4 MB)
android/app/build/outputs/apk/release/app-release.apk   (~5.0 MB, 서명됨)
```

`pnpm apk*` 는 내부적으로 `vite build` → `cap sync android` → Gradle 순으로 돈다.
웹 코드만 고쳤다면 `pnpm sync` 후 Gradle 만 다시 돌려도 된다.

### 실기기 설치

```sh
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

또는 APK 파일을 단말로 옮겨 파일 관리자에서 실행 (`알 수 없는 앱 설치` 허용 필요).

> 같은 단말에 덮어 설치하려면 서명이 같아야 한다. debug 와 release 는 서명이
> 다르므로 서로 덮어쓰지 못한다 — 바꿔 설치하려면 먼저 지울 것.

### 개발 중 (브라우저)

```sh
pnpm dev     # http://localhost:5183 — WebView 와 동일한 코드가 그대로 돈다
```

---

## 검증 상태 (2026-07-25, Pixel 7 Pro 에뮬레이터 · API 36)

release APK 를 설치해 실제로 확인한 것:

- [x] 앱 기동 · 다크 테마 · 한국어 · 런처 아이콘/스플래시
- [x] 니모닉 복구 → 금고 비밀번호 설정 → 잠금 해제
- [x] EVM 주소 파생 (`0xf39F…2266`) + **TTL 잔액 조회 성공** (rpc.ttl1.top)
- [x] Binance 시세 fetch → BTC 환산 표시
- [x] 체인 셀렉터 16 슬롯 전부 표시 (multichain 5MB 청크 dynamic import 성공)
- [x] Bitcoin 전환 → bech32 주소 (`bc1q4q…73te`) + blockstream 잔액 조회
- [x] ZION 전환 → bech32 (`zion15…2jhq`) + 4자산(kWR/BTC/USDT/ETH) 조회
- [x] **ZION AMM 스왑 견적** — 풀 ID 1, 소각 1/180, 수수료 3.33%, 예상 0.0012 BTC
      (= `api.zion1.top` 네이티브 HTTP 우회 동작 확인)
- [x] 하드웨어 뒤로가기 → 앱 종료 대신 홈 복귀
- [x] 잠금 → 재잠금해제 → 금고·계정·체인 선택 보존
- [x] **틀린 비밀번호에도 금고가 지워지지 않음**
- [x] 앱 재설치 후에도 금고 유지

시드구문 24 단어 (2026-07-25 추가):
- [x] 영어 24 단어 생성 → 6 단어 되묻기 → 금고 저장 → 계정 생성
- [x] **한국어 24 단어 전 흐름** — `adb shell input text` 는 ASCII 만 되지만,
      WebView 원격 디버깅(CDP)의 `Input.insertText` 로 한글 입력을 자동화했다.
      DOM 에서 단어를 직접 읽으므로 스크린샷 판독도 불필요.
      (스크립트 예시는 커밋 메시지 참조 — 디버그 빌드에서만 붙는다.)
- [x] 한글 24 단어 3 열 그리드 — 잘림 0, 가로 스크롤 0 (최장 "아스팔트")

미검증 (실기기에서 확인 필요):
- 실제 송금/스왑 브로드캐스트 (테스트 계정에 잔액 0)
- 저사양 단말에서의 scrypt 체감 속도
- 다양한 WebView 버전 (에뮬레이터는 최신)

---

## 릴리스 전 남은 일

- [ ] **`FLAG_SECURE`** — 시드 표시/키 노출 화면에서 스크린샷·화면녹화 차단.
      지금은 테스트 편의를 위해 끄고 있다 (사용자가 화면을 찍어 피드백해야 하므로).
      `MainActivity` 에서 `getWindow().setFlags(LayoutParams.FLAG_SECURE, …)`.
- [x] ~~WebView 원격 디버깅이 release 에서도 열려 있던 문제~~ — `MainActivity` 가
      `BuildConfig.DEBUG` 일 때만 켜도록 수정 (2026-07-25). release/debug 양쪽에서
      devtools 소켓 유무로 검증함.
- [ ] `versionCode` 증가 규칙 — 배포마다 +1 (지금 1).
- [ ] Play 배포 시 AAB (`bundleRelease`) + Play App Signing 등록.
- [ ] 생체 인증 잠금 해제 (androidx.biometric) — 비밀번호 대체가 아니라 보조 수단.
- [ ] QR 스캐너 (카메라 권한) — 주소 입력 편의.
- [ ] 저사양 단말 대응: scrypt N 을 단말 성능에 따라 조정할지 결정.

## 알려진 함정 (다시 밟지 말 것)

- **런치 테마의 `android:background`** — Capacitor 템플릿 기본값이지만, 이 속성은
  창 배경이 아니라 *그 테마로 만들어지는 모든 View 의 기본 배경* 이다. 액티비티
  테마에 두면 네이티브 `<select>` 드롭다운 각 행에 스플래시 이미지가 통째로 깔린다
  (체인 셀렉터 16 행에 로고가 하나씩 — 에뮬레이터에서 실제로 재현됨).
  창 배경은 `android:windowBackground`, 스플래시는 core-splashscreen 전용 속성으로.
- **XML 주석 안의 `--`** — `values/*.xml` 에서 빌드가 깨진다 (`mergeResources` 실패).
  CSS 변수명(`--popup-bg`)을 주석에 적을 때 주의.
- **`gradlew.bat` 는 절대 경로로 호출** — cwd 를 android/ 로 줘도 Windows 는 현재
  디렉터리를 PATH 처럼 뒤지지 않는다.
