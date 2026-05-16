# 노동자의 지갑 — 수동 테스트 가이드 (Manual Test Guide)

본 문서는 **노동자의 지갑(Worker's Wallet)** 4종 셸(웹/확장/데스크톱/모바일) + 하드웨어 월릿 연결 경로를
사람이 직접 단계별로 검증하기 위한 한국어 매뉴얼입니다.

- **대상 빌드**: `pnpm -r build` 후 산출물
- **체인**: TTL Chain ID `7777`, RPC `https://rpc.ttl1.top`, Explorer `https://scan.ttl1.top`
- **API**: `https://api.ttl1.top` (포트 4000)
- **인스톨러 서버**: `http://207.90.195.148:8080`
- **브랜드 명**: 노동자의 지갑 (영문 토글 시에도 브랜드명은 그대로 유지)
- **언어**: Korean primary / English baseline (i18n 토글)

> 한 섹션이 **차단(blocker)** 으로 실패한 경우, 해당 섹션 끝의 안내에 따라 **다음 섹션으로 건너뛰어도 됩니다.**

---

## 목차

| # | 섹션 | 예상 시간 | 자동/수동 |
|---|------|-----------|-----------|
| 0 | 사전 준비 | 15분 | 수동 |
| 1 | 단위/통합 테스트 | 30초 | 자동 |
| 2 | 웹 월릿 | 5분 | 수동 |
| 3 | 브라우저 확장 | 10분 | 수동 |
| 4 | 데스크톱 (Tauri) | 15분 | 수동 |
| 5 | 모바일 (RN) | 30분 | 수동 |
| 6 | 하드웨어 월릿 (Ledger) | 15분 | 수동 |
| 7 | TTL 네트워크 확인 | 1분 | 자동 |
| 8 | 보안 체크리스트 | 10분 | 수동 |
| 9 | 알려진 한계 | 5분 | 정독 |
| 10 | 버그 리포트 | — | — |

**전체 소요 시간: 약 2시간** (모든 섹션 풀로 수행 시)

---

## 0. 사전 준비 (Prerequisites)

### 0.1 필수 도구

| 도구 | 버전 | 용도 | 필수? |
|------|------|------|-------|
| Node.js | 22+ | 전체 빌드/실행 | 필수 |
| pnpm | 9+ | 워크스페이스 관리 | 필수 |
| Chrome / Edge / Firefox | 최신 | 웹/확장 테스트 | 필수 |
| Rust toolchain (rustc, cargo) | 1.75+ | 데스크톱(Tauri) 빌드 | 데스크톱 시 |
| JDK | 17 | Android 빌드 | 모바일(Android) 시 |
| Android Studio | 최신 | Android emulator + SDK | 모바일(Android) 시 |
| Xcode | 15+ | iOS 빌드 (macOS 전용) | 모바일(iOS) 시 |
| Ledger Nano S / X | — | HW signer | HW 시 |
| Ledger Live | 최신 | Cosmos/Solana 앱 설치 | HW 시 |

### 0.2 설치 확인

```bash
node --version    # v22.x.x
pnpm --version    # 9.x.x
rustc --version   # 1.75+ (옵션)
java -version     # 17 (옵션)
```

루트 디렉터리(`D:/TTLCOINWalet`)에서 환경 점검 스크립트 실행:

```bash
pnpm setup-check
```

**출력 해석**:
- 녹색 체크(`OK`): 사용 가능
- 노란색 경고(`WARN`): 옵션 도구 미설치 — 해당 섹션 스킵 가능
- 빨간색 에러(`MISSING`): 필수 도구 없음 — 설치 필요

### 0.3 첫 빌드

```bash
pnpm install     # 약 2분 (lockfile 기준)
pnpm -r build    # 약 3-5분 (모든 패키지)
```

**예상 결과**:
- `packages/wallet-sdk/dist/` 생성
- `packages/shell-core/dist/` 생성
- `packages/i18n/dist/` 생성
- `apps/web/dist/` 생성
- `apps/extension/.output/chrome-mv3/` 생성

**실패 시**:
- `ERR_PNPM_PEER_DEP_ISSUES` → 무시 가능 (peer 경고)
- `error TS2307` → `pnpm -r typecheck` 로 패키지별 오류 확인
- Node 버전 < 22 → `nvm install 22 && nvm use 22`

> **차단 시**: 본 절이 실패하면 이후 어떤 섹션도 진행 불가. 우선 빌드를 통과시켜야 합니다.

---

## 1. 단위/통합 테스트 (자동, 30초)

### 1.1 명령

```bash
pnpm --filter @nodong/wallet-sdk test
pnpm --filter @nodong/shell-core test
pnpm --filter @nodong/extension test
pnpm --filter @nodong/i18n test
```

또는 한 번에:

```bash
pnpm -r --parallel test
```

### 1.2 예상 결과

```
Test Files  18 passed (18)
     Tests  217 passed | 9 skipped (226)
  Duration  ~28s
```

- **217 통과 / 9 스킵 / 0 실패** 이어야 합니다.
- 스킵된 9건은 모두 `// skip: needs TTL testnet`, `// skip: requires Ledger device` 사유.

### 1.3 실패 시 대응

| 증상 | 원인 | 조치 |
|------|------|------|
| `@nodong/wallet-sdk` 실패 | 노드 버전 / SDK 버전 불일치 | `node --version` 확인, 22로 맞춤 |
| `@nodong/shell-core` 실패 | i18n 키 누락 | `pnpm --filter @nodong/i18n build` 재실행 |
| `@nodong/extension` 실패 | jsdom Provider mock | `pnpm -r build` 한 뒤 재시도 |
| 모든 패키지 fail | 빌드 산출물 누락 | 0.3절 재실행 |

> **차단 시**: SDK 또는 shell-core 테스트가 실패하면 이후 모든 셸이 영향을 받음. 우선 수정 후 진행 권장. 단, **수치적으로 5건 이하** 실패라면 셸 테스트는 계속 진행 가능.

---

## 2. 웹 월릿 (5분)

### 2.1 시작

```bash
pnpm --filter @nodong/web dev
```

브라우저에서 `http://localhost:5173` 접속.

### 2.2 체크리스트

#### 2.2.1 브랜드 / i18n
- [ ] 헤더에 **"노동자의 지갑"** 텍스트 + 우상단 **KO / EN** 토글 표시
- [ ] **EN 토글 클릭** → 화면 텍스트가 영문으로 즉시 변환 (페이지 리로드 없이)
- [ ] **브랜드명은 그대로 "노동자의 지갑"** 유지 (영문화 X)
- [ ] **KO 토글 복귀** → 다시 한국어로 즉시 변환

#### 2.2.2 지갑 생성
- [ ] **"지갑 생성"** 버튼 클릭 → mnemonic 화면 진입
- [ ] **12단어 한국어 mnemonic** 표시 (BIP-39 KO wordlist)
- [ ] **복사 버튼** 작동 → 클립보드에 단어 공백 구분으로 복사
- [ ] **"외웠습니다"** 체크박스 클릭 가능
- [ ] 체크 후 **"다음"** 버튼 활성화 → 클릭 가능

#### 2.2.3 Account 화면
- [ ] **TTL 주소** 표시 (예: `0xAbC1...De2F`, 0x 접두 + 40 hex)
- [ ] **QR 코드** 표시
- [ ] **잔액 = 0 TTL** (또는 "잔고 없음" 안내)
- [ ] **체인 표시**: "TTL Mainnet (7777)" 또는 동등

#### 2.2.4 송금 검증
- [ ] **"송금"** 버튼 클릭 → 송금 폼 진입
- [ ] 받는 주소에 **잘못된 형식** 입력 (예: `0x123`) → 빨간색 에러
  - 메시지: **"주소 형식이 올바르지 않습니다"** (또는 동등 문구)
- [ ] 받는 주소에 **정상 주소** + 금액 **0.1 TTL** 입력 → "잔고 부족" 에러
  - RPC 응답 또는 클라이언트 사전 검증으로 차단되어야 함

#### 2.2.5 잠금 / 복구
- [ ] **"잠금"** 버튼 클릭 → 첫 화면(랜딩) 복귀
- [ ] **DevTools → Application → Session Storage** 확인
  - `nd:mnemonic` 키가 있다면 **새로고침 후 사라져야 함** (autoRestoreAllowed=false)
- [ ] **"복구"** 버튼 → 2.2.2의 동일 mnemonic 입력 → **같은 주소**로 복원
- [ ] 페이지 **새로고침(F5)** → 잠금 화면으로 복귀 (자동 복원되지 않음)

### 2.3 트러블슈팅

| 증상 | 조치 |
|------|------|
| 5173 포트 충돌 | `pnpm --filter @nodong/web dev -- --port 5174` |
| 한글 mnemonic이 영문으로 표시 | i18n 빌드 누락. `pnpm --filter @nodong/i18n build` |
| 주소 0x000... 표시 | wallet-sdk 빌드 누락. `pnpm --filter @nodong/wallet-sdk build` |
| RPC 타임아웃 | `https://rpc.ttl1.top` 도달 가능? curl 로 확인 |

> **차단 시**: 다음 섹션(확장)으로 건너뛰기 가능 — 확장은 별개 빌드 산출물 사용.

---

## 3. 브라우저 확장 (10분)

### 3.1 빌드

```bash
pnpm --filter @nodong/extension build
```

산출물: `apps/extension/.output/chrome-mv3/`

### 3.2 Chrome에 로드

1. Chrome 주소창 → `chrome://extensions`
2. 우측 상단 **개발자 모드 ON**
3. **"압축해제된 확장 프로그램 로드"** 버튼 클릭
4. `D:/TTLCOINWalet/apps/extension/.output/chrome-mv3` 폴더 선택
5. 확장 목록에 **"노동자의 지갑"** 등장 확인

### 3.3 체크리스트

#### 3.3.1 Popup 기본 동작
- [ ] 도구바의 확장 아이콘 클릭 → **popup 등장**, 한국어 UI
- [ ] **"지갑 생성"** → 12단어 한국어 mnemonic → Account 화면
- [ ] **잔액 0 TTL**, 주소 0x... 표시

#### 3.3.2 Injected Provider (`window.nodong`)

새 탭에서 `https://example.com` 열고 DevTools Console에서:

```js
window.nodong                                    // 객체가 존재해야 함
await window.nodong.request({method:'eth_chainId'})        // '0x1e61' (7777)
await window.nodong.request({method:'eth_accounts'})       // []  (아직 연결 안 됨)
```

- [ ] `window.nodong` 가 truthy
- [ ] `eth_chainId` → `'0x1e61'`
- [ ] `eth_accounts` → `[]` (빈 배열)

#### 3.3.3 Connect Flow

```js
await window.nodong.request({method:'eth_requestAccounts'})
```

- [ ] **connect 팝업이 새 창**으로 열림 (확장 popup이 아닌 별도 dialog)
- [ ] 팝업에 **origin (`https://example.com`)** 표시
- [ ] **승인** 클릭 → 콘솔에 `[ '0x...' ]` 주소 배열 반환
- [ ] 다시 `await window.nodong.request({method:'eth_accounts'})` → **주소 배열 반환** (allowlist 작동)

#### 3.3.4 연결된 사이트 관리
- [ ] 확장 popup 열기 → **"연결된 사이트"** 메뉴에 `example.com` 표시
- [ ] **연결 해제** 버튼 클릭 → 목록에서 제거
- [ ] 다시 `eth_accounts` 호출 → `[]` 반환 (해제 확인)

#### 3.3.5 EIP-6963 Multi-Wallet Discovery

DevTools Console:

```js
window.addEventListener('eip6963:announceProvider', e => console.log(e.detail.info));
window.dispatchEvent(new Event('eip6963:requestProvider'));
```

- [ ] 콘솔에 다음과 같은 객체 출력:
  ```
  { name: '노동자의 지갑', rdns: 'top.ttl1.nodong', icon: 'data:image/...', uuid: '...' }
  ```

#### 3.3.6 dApp 호환성 (선택, MetaMask Test dApp)

https://metamask.github.io/test-dapp/ 접속 (확장 1개만 활성화 권장 → MetaMask 비활성화)

- [ ] **Connect 버튼** → 우리 확장이 EIP-6963으로 announce 됨 (다중 지갑 환경 시)
- [ ] 연결 후 dApp 화면에 **chainId 7777** 표시
- [ ] **Personal Sign** 클릭 → 우리 confirm 팝업 등장 → 메시지 본문 표시 → 승인 → 서명 결과 표시
- [ ] **Contract Action (Send ERC-20 등)** → confirm 팝업에 **4-byte selector + decoded args** 표시
- [ ] **EIP-712 Sign Typed Data** → confirm 팝업에 **primaryType + JSON 프리뷰** 표시

#### 3.3.7 1시간 기억 토글 (Trusted Grant)
- [ ] 어떤 dApp 승인 화면에서 **"1시간 기억"** 토글 체크 → 승인
- [ ] **같은 dApp에서 60분 내** 동일 method 재호출 → **즉시 자동 승인** (팝업 X)
- [ ] 확장 popup → **"연결된 사이트 + 활성 권한"** UI에 해당 grant 카드 표시
- [ ] **취소** 버튼 클릭 → grant 제거 → 다음 요청부터 다시 팝업 등장

### 3.4 트러블슈팅

| 증상 | 조치 |
|------|------|
| `window.nodong` undefined | content script 미주입. 페이지 새로고침 + 콘솔에서 errors 확인 |
| connect 팝업 안 뜸 | 팝업 차단기 확인. `chrome://settings/content/popups` |
| `eth_chainId` 다른 값 | 빌드 환경 변수 잘못. `pnpm --filter @nodong/extension build` 재실행 |
| EIP-6963 announce 미발생 | inpage script 로드 타이밍. document_start 주입 확인 |

> **차단 시**: 다음 섹션(데스크톱)으로 건너뛰기 가능.

---

## 4. 데스크톱 (Tauri 빌드 가능 시 — 15분)

### 4.1 사전 확인

```bash
rustc --version    # 1.75+
cargo --version
```

미설치 시 `docs/SETUP.md §2` 의 Rust toolchain 설치 안내 따르기.

### 4.2 두 가지 실행 방식

#### A) Vite 단독 (Rust 없어도 됨)
```bash
pnpm --filter @nodong/desktop dev
```
브라우저에서 `http://localhost:5173` (또는 충돌 시 5174) → 데스크톱 셸 **UI만** 검증 가능.

#### B) Full Tauri (Rust 필요)
```bash
pnpm --filter @nodong/desktop tauri dev
```
별도 네이티브 윈도우가 열림. WebHID(하드웨어 월릿)·OS clipboard·시스템 알림 검증 가능.

### 4.3 체크리스트

#### 4.3.1 레이아웃
- [ ] **좌측 사이드바** 메뉴:
  - 지갑 (Wallet)
  - 송수신 (Send / Receive)
  - 포트폴리오 (Portfolio)
  - 활동 (Activity)
  - dApp
  - 하드웨어 (Hardware)
  - 설정 (Settings)
- [ ] 각 메뉴 클릭 시 우측 본문이 해당 뷰로 전환

#### 4.3.2 i18n
- [ ] 설정 → 언어 → **EN 선택** → 사이드바 텍스트 전부 영문화
- [ ] **브랜드명은 "노동자의 지갑"** 유지
- [ ] **KO 복귀** → 한국어 즉시 복원

#### 4.3.3 dApp 뷰
- [ ] WalletConnect URI 페이스트 입력란 표시
- [ ] Reown projectId 미설정 환경에서는 **"준비 중"** 또는 **"WalletConnect 설정 필요"** 안내 표시 (정상)

#### 4.3.4 하드웨어 뷰
- [ ] Ledger 미연결 상태에서 **"WebHID 미지원 또는 디바이스 없음"** 안내 표시
- [ ] Ledger 연결 후 **"연결" 버튼** 활성화 (실제 연결 테스트는 §6)

#### 4.3.5 OS 통합 (Tauri 모드에서만)
- [ ] 송금 후 OS 알림 표시 (Windows: 토스트, macOS: 알림 센터)
- [ ] 메뉴바에서 종료 시 백그라운드 잔존 없음 (Task Manager / Activity Monitor 확인)

### 4.4 트러블슈팅

| 증상 | 조치 |
|------|------|
| `tauri dev` 처음 5분간 hang | Rust 첫 빌드. 정상이며 기다리기 |
| `error: linker 'cc' not found` (Linux) | `sudo apt install build-essential` |
| `error: Microsoft C++ Build Tools` (Windows) | Visual Studio Build Tools 설치 |
| `error: xcode-select --install` (macOS) | 안내대로 실행 |

> **차단 시**: 다음 섹션(모바일)으로 건너뛰기 가능.

---

## 5. 모바일 (네이티브 빌드 가능 시 — 30분)

### 5.1 사전 환경

| 플랫폼 | 요건 |
|--------|------|
| Android | JDK 17, Android Studio, `ANDROID_HOME` 환경변수 |
| iOS | macOS, Xcode 15+, CocoaPods, `xcode-select --install` |

### 5.2 네이티브 폴더 생성 (최초 1회)

`apps/mobile/` 에는 **JS 코드만** 들어 있고 `ios/`, `android/` 네이티브 폴더는 **사용자가 직접 생성**해야 합니다 (라이선스 / 빌드 환경 차이 때문).

```bash
cd apps/mobile
npx @react-native-community/cli@latest init NodongMobile --template react-native-template-typescript@latest
```

생성 결과에서 다음 두 폴더만 `apps/mobile/` 로 복사:
- `ios/`
- `android/`

그리고 패키지명을 **`top.ttl1.nodong.mobile`** 로 변경:

- **Android**: `android/app/build.gradle`
  ```gradle
  applicationId "top.ttl1.nodong.mobile"
  ```
  + `android/app/src/main/AndroidManifest.xml` 의 `package` 속성
- **iOS**: `ios/NodongMobile/Info.plist` 의 `CFBundleIdentifier` →
  ```xml
  <key>CFBundleIdentifier</key>
  <string>top.ttl1.nodong.mobile</string>
  ```

### 5.3 실행

#### Android
```bash
# 에뮬레이터 또는 실 디바이스 USB 연결 후
pnpm --filter @nodong/mobile android
```

#### iOS (macOS 전용)
```bash
cd apps/mobile/ios
pod install
cd ..
pnpm --filter @nodong/mobile ios
```

### 5.4 체크리스트

#### 5.4.1 첫 진입
- [ ] 스플래시 → "노동자의 지갑" 로고
- [ ] 한국어 UI 기본 (디바이스 locale=ko-KR 가정)

#### 5.4.2 지갑 생성 / 복구
- [ ] **지갑 생성** → 12단어 한국어 mnemonic → 백업 화면
- [ ] **복구** → 동일 mnemonic 입력 → 같은 주소 복원

#### 5.4.3 Account / 송금
- [ ] 주소(0x...) + QR 표시
- [ ] 잔액 0 TTL
- [ ] 송금 폼 → 잘못된 주소 입력 시 에러
- [ ] 0.1 TTL 송금 시 잔고 부족 에러

#### 5.4.4 잠금 / 백그라운드
- [ ] **앱 백그라운드 → 5초 → 포그라운드** → 잠금 화면으로 복귀 (시드 메모리 보호)
- [ ] **앱 강제 종료 후 재실행** → 잠금 화면

#### 5.4.5 i18n
- [ ] 설정 → EN → 텍스트 영문화, 브랜드명 유지
- [ ] KO 복귀 정상

#### 5.4.6 dApp 스크린 (placeholder)
- [ ] dApp 탭 진입 → "준비 중" 또는 WC v2 URI 페이스트 입력란 (deep-link 미배선 상태)

### 5.5 트러블슈팅

| 증상 | 조치 |
|------|------|
| `SDK location not found` | `ANDROID_HOME` 환경변수 설정 |
| `Metro bundler` 포트 8081 충돌 | `npx react-native start --port 8082` |
| iOS pod install 실패 | `cd ios && pod repo update && pod install` |
| 한글 폰트 깨짐 | Android: `fonts/` 폴더에 nanum 추가, iOS: Info.plist `UIAppFonts` |

> **차단 시**: 다음 섹션(HW)으로 건너뛰기 가능.

---

## 6. 하드웨어 월릿 (Ledger Nano S/X 보유 시 — 15분)

### 6.1 사전 준비

1. Ledger Nano 를 PC에 **USB 연결**
2. Ledger 화면에서 **PIN 입력**
3. **Cosmos 앱** 열기 (또는 **Solana 앱** — 둘 중 하나만)
4. **Ledger Live 데스크톱 앱은 종료** (USB 점유 충돌 방지)

### 6.2 데스크톱 또는 확장에서 연결 시도

데스크톱 셸: 사이드바 → **하드웨어** → "Ledger 연결"
확장: popup → 설정 → "하드웨어 월릿 추가"

- [ ] 브라우저가 **WebHID 디바이스 chooser** 표시
- [ ] 목록에서 **Ledger Nano S 또는 X** 선택 → "연결"
- [ ] 우리 UI에 **"디바이스에서 확인하세요"** 안내 등장
- [ ] **Ledger 화면**에 주소(또는 derivation path) 표시 → **양버튼 동시 누름** 으로 승인
- [ ] 우리 UI에 **fetch된 주소** 표시
- [ ] **"EVM/BTC는 v0.5 예정"** 안내 배너 보임 (Cosmos/Solana만 지원 명시)

### 6.3 트러블슈팅

| 증상 | 조치 |
|------|------|
| 디바이스 chooser 비어 있음 | USB 케이블 교체 / Ledger PIN 재입력 / 앱 다시 열기 |
| "디바이스 응답 없음" | Ledger Live 등 다른 USB-claim 앱 종료 |
| WebHID 권한 차단 | `chrome://flags` → **Experimental Web Platform features** 활성화 후 재시작 |
| `LockedDeviceError` | Ledger 화면 잠금 해제 후 재시도 |
| 펌웨어 BUILD_ASSERT 작동 | USB VID 미등록 펌웨어 빌드. firmware/ 폴더의 release 펌웨어 사용 |

> **차단 시**: 다음 섹션(TTL 네트워크 확인)으로 건너뛰기 가능.

---

## 7. TTL 네트워크 확인 (자동, 1분)

### 7.1 주소 파생 검증

```bash
node scripts/verify-addresses.mjs
```

**예상 출력**:
```
[1/10] BIP-39 → seed (KO wordlist)              OK
[2/10] BIP-32 m/44'/60'/0'/0/0                  OK
[3/10] EVM address checksum                     OK
...
[10/10] TTL chainId 7777 RPC handshake          OK

Result: 10/10 passed
```

- [ ] **10/10 통과** 확인

### 7.2 메인넷 잔액 조회

브라우저에서:
```
https://scan.ttl1.top/address/<자기 주소>
```

- [ ] Explorer에 본인 주소 페이지 로드
- [ ] 잔액 0 TTL (또는 보유 시 해당 수치)
- [ ] 트랜잭션 히스토리 비어 있음 (테스트 송금 안 했을 시)

> **차단 시**: §8 보안 체크리스트는 네트워크 의존이 없으므로 계속 가능.

---

## 8. 보안 체크리스트 (10분)

### 8.1 시드 저장 위치 (가장 중요)

#### 웹
- DevTools → **Application 탭 → Session Storage** → `http://localhost:5173`
  - [ ] `nd:mnemonic` 키가 보일 수 있음 — **새로고침 후 사라지면 정상**
  - [ ] 이유: `WebSessionStore.autoRestoreAllowed=false` 로 새로고침 시 자동 복원 차단
  - [ ] 실제로는 **메모리만** 사용. 새로고침 = 잠금.
- DevTools → **Application 탭 → Local Storage** 또는 **IndexedDB**
  - [ ] **mnemonic 키가 절대로 없어야 함** (영구 저장 금지)

#### 확장
- DevTools (확장 popup 우클릭 → "검사") → Application → Storage
  - [ ] **`chrome.storage.session`** 에만 mnemonic 존재 (브라우저 종료 시 삭제됨)
  - [ ] **`chrome.storage.local`** 에는 **절대 없음** (영구 저장 금지)
- 콘솔에서:
  ```js
  chrome.storage.local.get(null, console.log)   // mnemonic 키 없음
  chrome.storage.session.get(null, console.log) // 잠금 해제 상태일 때만 mnemonic 있음
  ```

### 8.2 시드 노출 경로 차단
- [ ] DevTools Console 어디에도 **mnemonic 평문이 출력되지 않음**
- [ ] Network 탭 어디에도 mnemonic 본문이 전송되지 않음 (RPC 요청 페이로드 확인)
- [ ] 클립보드는 사용자가 명시적으로 복사한 경우에만 채워짐

### 8.3 dApp 권한 관리
- [ ] **새 origin은 매번 connect 팝업** 등장 (자동 승인 X)
- [ ] **"1시간 기억"** 토글이 **default OFF**
- [ ] 활성 grant 목록에 표시되고 사용자가 즉시 취소 가능
- [ ] grant TTL이 60분 이내로 자동 만료

### 8.4 체인별 격리
- [ ] **Solana** confirm 화면에 EVM 정보(gas, nonce 등) 노출 없음
- [ ] **Cosmos** confirm 화면도 동일
- [ ] **EVM** 화면에는 chainId 7777 명시

### 8.5 잠금 동작
- [ ] **명시적 잠금**: "잠금" 버튼 → 시드 메모리에서 즉시 제거
- [ ] **자동 잠금** (5분 idle 가정): 마우스/키보드 무동작 5분 후 자동 잠금 (설정 가능)
- [ ] **모바일 백그라운드**: 백그라운드 진입 시 즉시 잠금

> **차단 시**: 보안 항목 실패는 **출시 차단(release blocker)**. §9 / §10 만 정보 확인용으로 진행.

---

## 9. 알려진 한계 (꼭 알기)

본 빌드의 **알려진 한계**입니다. 테스트 시 "버그가 아닌" 항목으로 분류:

| # | 항목 | 상태 | 회피 |
|---|------|------|------|
| 1 | **TTL 테스트넷 없음** | 실 송금 검증 불가 | 메인넷 소액으로만 검증 |
| 2 | iOS/Android 네이티브 폴더 미포함 | 사용자가 §5.2로 생성 | — |
| 3 | USB VID 미등록 | 펌웨어 BUILD_ASSERT 작동 | release 펌웨어 사용 |
| 4 | WC v2 모바일 deep-link 미배선 (`nodong://`) | dApp 탭에 "준비 중" | 데스크톱 WC URI 페이스트 사용 |
| 5 | EVM / BTC HW signer | v0.5 예정 | Cosmos/Solana만 HW 가능 |
| 6 | 다국어: KO/EN 만 (현재) | JA/ZH는 후속 | — |
| 7 | Reown projectId 미설정 시 dApp 뷰 placeholder | — | env에 projectId 주입 |
| 8 | Tauri auto-update 미설정 | 수동 재설치 | 인스톨러 서버에서 받기 |

### 9.1 TTL 테스트넷 부재 영향
- **실제 송금 successful 케이스 검증 불가** — 잔고 부족 에러만 확인 가능
- 메인넷에서 실 송금을 하려면 본인 자금 필요
- **본 가이드의 모든 송금 테스트는 "에러 케이스" 만 검증** 합니다 (잘못된 주소, 잔고 부족)

---

## 10. 버그 리포트

### 10.1 보고 채널
- GitHub Issues (리포지토리 공개 시) — 템플릿 미정 시 아래 양식 사용
- 내부 채널: 이메일 또는 슬랙 (운영팀 안내)

### 10.2 양식

```markdown
## 환경
- OS: Windows 11 / macOS 14 / Ubuntu 22.04
- Browser: Chrome 125.0
- Wallet build: <git sha or version>
- 셸: 웹 / 확장 / 데스크톱 / 모바일 / HW

## 재현 단계
1. ...
2. ...
3. ...

## 기대
...

## 실제
...

## 콘솔 로그 / 스크린샷
(첨부)
```

### 10.3 우선순위 분류

| 등급 | 정의 | 예시 |
|------|------|------|
| P0 (Blocker) | 시드 유출, 잘못된 서명, 자금 손실 가능 | mnemonic이 local storage에 저장됨 |
| P1 (Critical) | 핵심 기능 동작 안 함 | 송금 불가, dApp 연결 불가 |
| P2 (Major) | 일부 케이스에서 실패 | EIP-712 일부 형식 미지원 |
| P3 (Minor) | UI 깨짐, 번역 누락 | 한 단어 번역 누락 |

---

## 부록 A. 출시 전 필수 3대 체크 (절대 빠뜨리지 말 것)

1. **시드는 메모리만, 영구 저장소(local storage / chrome.storage.local) 절대 X**
   → §8.1 검증.
2. **dApp 새 origin은 매번 connect 팝업 등장, 1시간 기억 default OFF**
   → §8.3 검증.
3. **체인별 confirm 화면 격리 (EVM/Solana/Cosmos 혼선 없음)**
   → §8.4 검증.

이 세 가지는 **자동 테스트로 보장되지 않는** 사용자 영향이 큰 보안 동작이므로
사람이 매 빌드마다 직접 확인하는 것이 권장됩니다.

---

## 부록 B. 명령어 빠른 참조

```bash
# 환경 점검
pnpm setup-check

# 전체 빌드
pnpm install && pnpm -r build

# 자동 테스트
pnpm -r --parallel test

# 웹
pnpm --filter @nodong/web dev          # 5173

# 확장
pnpm --filter @nodong/extension build  # .output/chrome-mv3/

# 데스크톱
pnpm --filter @nodong/desktop dev          # Vite 단독
pnpm --filter @nodong/desktop tauri dev    # 풀 네이티브

# 모바일
pnpm --filter @nodong/mobile android
pnpm --filter @nodong/mobile ios

# 검증
node scripts/verify-addresses.mjs       # 10/10
```

---

## 부록 C. 셸별 데이터 격리 정리

| 셸 | 시드 저장소 | 잠금 트리거 | 자동 복원? |
|----|------------|------------|-----------|
| 웹 | sessionStorage (메모리 폴백) | 새로고침, 탭 닫기, "잠금" 버튼 | X |
| 확장 | chrome.storage.session | 브라우저 종료, idle timeout, "잠금" | X |
| 데스크톱 (Tauri) | OS keychain 옵션 / 메모리 | 창 종료, idle, "잠금" | OS keychain 시 O |
| 모바일 | Keychain (iOS) / Keystore (Android) + Biometrics | 백그라운드, 강제종료, 잠금 | 생체 인증 시 O |
| HW (Ledger) | 디바이스에 영구 (PC엔 없음) | USB 분리 | 분리 시마다 재연결 |

---

## 마치며
본 가이드는 **v0.4** 빌드 기준입니다. v0.5 에서 다음이 추가될 예정:
- EVM / BTC HW signer
- WC v2 모바일 deep-link
- TTL 테스트넷 또는 dev faucet
- iOS/Android 빌드 산출물 직접 배포

피드백은 §10 양식으로 부탁드립니다.

— 노동자의 지갑 팀
