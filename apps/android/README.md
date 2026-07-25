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

### 금고를 기기에 묶기 (`src/vault-hw.ts` + `VaultCryptoPlugin.java`)

금고는 두 겹이다. 순서가 중요하다:

```
시드 → AES-GCM(scrypt(비밀번호))   ← 안쪽. 사용자만 아는 것
     → AES-GCM(AndroidKeyStore 키) ← 바깥쪽. 이 폰만 아는 것
     → localStorage
```

바깥쪽 키는 TEE/StrongBox 안에서 생성되어 **한 번도 칩 밖으로 나오지 않는다**.
앱조차 키 바이트를 못 본다 — "암복호화 해줘" 라고 요청만 한다. 그래서 저장 파일을
통째로 떠가도 그 폰이 아니면 복호화를 시작조차 못 하고, 오프라인 대입이라는
공격 경로 자체가 사라진다.

**순서를 이렇게 잡은 이유**: 하드웨어 계층이 뚫려도(아래 위협 모델 참고) 공격자가
얻는 것은 여전히 scrypt 로 잠긴 blob 이다. 원점으로 돌아갈 뿐 시드가 바로 나오지
않는다. 반대로 넣었으면 하드웨어 한 겹이 뚫리는 순간 끝이었다.

`EncryptedKeystoreStore` 가 저장소를 `PersistentBackend` 로 주입받는 구조라,
그 자리에 감싸는 백엔드를 끼웠다 — shell-core 는 한 줄도 바뀌지 않았다.

마이그레이션: 이 계층 도입 이전 금고(봉투 없는 EncryptedBlob)는 그대로 열리고,
잠금 해제 직후 자동으로 다시 봉인된다. 셸의 "내용 같으면 저장 건너뛰기" 최적화에
걸려 승급이 안 되던 것을 `lastReadWasWrapped` 로 강제하도록 고쳤다.

실기기에서 하드웨어를 못 쓰면 **보호 수준을 낮춰 저장하지 않고 실패한다.** 지갑이
조용히 약해지는 것보다 눈에 띄게 멈추는 편이 낫다.

#### 이 계층이 막지 못하는 것 (과장하지 않기)

- **칩 벤더 / OEM.** TEE·StrongBox 펌웨어는 비공개이고 서명 주체가 그들이다.
  키 추출 경로가 심겨 있어도 우리가 검증할 방법이 없다. 이론이 아니라 전례가 있다 —
  Qualcomm QSEE 키마스터 키 추출(CVE-2015-6639 / 2016-2431), 삼성 Galaxy S8~S21
  키스토어 IV 재사용 결함(2022). 매번 정확히 여기서 기대는 성질이 깨졌다.
- **물리 공격.** 폴트 인젝션, 전력·전자파 부채널, 디캡. StrongBox 가 문턱을 올리지만
  없애지는 못한다.
- **잠금 해제된 상태의 단말.** 우리 앱으로 코드를 실행할 수 있으면 TEE 에 복호화를
  요청할 수 있다. 그때는 다시 scrypt 대입 싸움이며, 폰 한 대 속도로 제한된다.

즉 이 계층이 파는 것은 "불가능" 이 아니라 **비용 구조의 전환**이다. 원격·대량·저비용
공격을 물리적·단말별·고비용 공격으로 바꾼다. 그래서 폰은 여전히 핫월렛이고,
큰 금액의 근거는 종이 복구 문구와 [벼린 요세](../../hardware/SPEC.md) 쪽에 있다.

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
D:\TTLCOINWalet\벼린.apk                                 ← release 복사본 (실기기용)
```

release 빌드는 저장소 루트의 **`벼린.apk`** 로 항상 복사된다. 폰에 옮길 파일 위치를
하나로 고정해 깊은 Gradle 경로를 매번 찾지 않게 하려는 것. gitignore 대상.

### 업데이트인가, 지우고 새로 까는 것인가

**업데이트다.** release APK 는 언제나 같은 키(`byeorin-release.jks`)로 서명되고
applicationId 도 같으므로, 새 `벼린.apk` 를 덮어 설치하면 안드로이드가 이를 앱
업데이트로 처리한다. 앱 데이터(= 암호화 금고)는 그대로 남고 기존 비밀번호로 열린다.

실측 (2026-07-25, 에뮬레이터):
  v0.5.0(code 1) 설치 → 지갑 복구·금고 생성 → v0.5.1(code 2) 를 `install -r`
  → 잠금 화면으로 부팅(금고 보존) → 기존 비밀번호로 해제 → 같은 계정
  `0xf39F…2266` 복원 확인.

예외 — **지우고 새로 깔아야 하는 경우**:
  - debug ↔ release 를 바꿔 설치할 때. 서명 키가 달라 덮어쓰기가 거부된다
    (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). 이때는 앱 데이터도 함께 사라진다.
  - `versionCode` 를 낮추는 다운그레이드. 안드로이드가 막는다.
  - 금고 저장 포맷을 바꾸는 변경이 들어갈 때. 지금은 해당 없지만, 포맷을 바꾼다면
    마이그레이션을 넣거나 사용자에게 복구 문구로 재설정하도록 안내해야 한다.

그래서 **배포마다 `versionCode` 를 +1** 해야 한다 (같은 값이어도 사이드로드는
되지만, 폰에 깔린 게 새 빌드인지 구분이 안 된다). 앱 푸터에 `v0.5.1 (2)` 형태로
versionName/versionCode 를 띄워 두었으므로 화면에서 바로 확인할 수 있다.

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
