# 벼린 — 세션 컨텍스트 (Handoff)

> 이 문서의 역할: **새 세션에서 5분 안에 풀 컨텍스트 잡기.**
> 단일 진실원은 [`PLAN.md`](./PLAN.md)지만, "방금 무엇이 어디까지 됐는가"는 이 문서에서 본다.
>
> 마지막 갱신: **2026-07-28** (릴리스 검증 체계 + 금고 하드웨어 바인딩 + 공개 저장소 준비)
> GitHub: <https://github.com/okneo31/byeorin> (private)

---

## 0. 30초 요약

- **브랜드 마이그레이션 완료** (노동자의 지갑 → 벼린/Byeorin). 디자인 시스템 v2.
- **Q0 완료, Q1 진입.** SDK + 4종 SW 셸 + HW 사양/펌웨어 스캐폴드 + 보험 v2 + 보안 감사 모두 끝남.
- **2026-05-25 라운드: Extension popup 풀스코프.** 멀티체인 16 슬롯 + 다중 계정 + import/export + ZION 통합. Stage E1(셀렉터·잔액·송금) 완료, E2(주소록·매트릭스 복사)/E3(활동·토큰) 대기.
- **2026-07-25 라운드: 안드로이드 APK 완성.** `apps/android` 신설 — Capacitor 8 + Vite WebView 셸에 Extension popup UI 를 이식. **9 체인 전부 실기기 경로에서 동작 검증** (Pixel 7 Pro 에뮬레이터, release APK). 확장에 없던 계층 추가: 비밀번호 금고 · 자동 잠금 · 뒤로가기.
- **2026-07-26 라운드: 검증 가능한 보안 + 공개 저장소 준비.** 금고를 AndroidKeyStore(TEE/StrongBox) 키로 한 겹 더 감쌈 · 릴리스 매니페스트/검증기 도입 · **재현 빌드가 실측에서 실패**(clean 후 재빌드 시 해시 불일치, [VERIFIABILITY §2.1](./VERIFIABILITY.md)) · 이력 재작성(force push)으로 APK blob 제거 · LICENSE Apache-2.0 + NOTICE + README + SECURITY 추가 · 온체인 앵커 기록기/검증기 구현(**발행 대기**).
- **다음 행동: 실기기 테스트 피드백 반영** → 송금/스왑 브로드캐스트 확인 → 릴리스 전 항목([apps/android/README.md](../apps/android/README.md) 하단). 검증 트랙은 온체인 앵커 실제 발행(§7 D).

### 2026-07-26 라운드 — 검증 가능한 보안

| 항목 | 내용 |
|---|---|
| 금고 하드웨어 바인딩 | `시드 → AES-GCM(scrypt(비밀번호)) → AES-GCM(AndroidKeyStore 키) → localStorage`. 바깥 겹의 키는 TEE/StrongBox 안에서 생성돼 칩 밖으로 나오지 않음 → 저장 파일만 떠가는 **오프라인 대입 경로 제거**. 하드웨어 계층이 뚫려도 남는 것은 scrypt 로 잠긴 blob. 신규 `VaultCryptoPlugin.java`(로컬 Capacitor 플러그인, 서드파티 의존성 0) + `src/vault-hw.ts`(`PersistentBackend` 래퍼) — **shell-core 변경 0줄**. 하드웨어를 못 쓰면 보호 수준을 낮춰 저장하지 않고 실패. `setUserAuthenticationRequired` 는 켜지 않음(생체 재등록·화면잠금 변경 시 키 무효화 사고). 에뮬레이터 실측: 옛 금고 `{"v":1,"kdf":"scrypt","N":65536,…}` → 새 빌드에서 `{"hw":1,"iv":…,"ct":…}` 자동 승급, 계정 `0xf39F…2266` 복원. `isAvailable → {available:true, strongBox:false}` (에뮬레이터는 TEE 폴백) |
| 릴리스 매니페스트 | `apps/android/scripts/release-manifest.mjs` — release 빌드 때 `gradle.mjs` 가 자동 생성. 담기는 값: 파일 SHA-256 · 서명 인증서 지문 · 출처 커밋/브랜치 · **작업 트리 청결 여부** · 툴체인 버전 · **주장하지 않는 것**(`claims.notClaimed`) |
| 제3자 검증기 | `scripts/verify-byeorin-apk.mjs` — 의존성 0(순수 fetch). 무결성(SHA-256) / 진위(서명 인증서) / 출처(주장) / 온체인 앵커 4항목. 우리 서버에 아무것도 묻지 않음 |
| 공개 서명 인증서 지문 | `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480` |
| **재현 빌드 = 안 됨 (실측)** | 추측이 아니라 측정 결과. 증분 빌드 직후 `cd3fcb6d…75b67` / `gradlew clean` 후 재빌드 `5363e843…002dc`. **같은 머신·같은 커밋·같은 툴체인인데 바이트가 다르다.** 앞선 커밋(`08e954b`)에서 해시가 같게 나온 것은 Gradle 이 산출물 130 태스크를 up-to-date 로 재사용한 증분 빌드였고 결정성의 근거가 아니었다 — 그렇게 서술했던 것을 `2316a0c` 에서 정정. 따라서 매니페스트의 `commit` 이 그 바이트를 만들었다는 **증명은 없고 현재는 주장이다** |
| 매니페스트 정직성 버그 2건 | ① `벼린.apk` 가 git 에 추적 중이라 빌드마다 "작업 트리 더러움" 이 상시 켜져 있었음 — `.gitignore` 규칙을 이미 추적된 파일 뒤에 넣어 효력이 없었다. `git rm --cached` 로 해제. ② 더러움 판정에서 산출물 자신(매니페스트)을 제외 — 빼지 않으면 "매니페스트를 쓰는 행위가 트리를 더럽혀 다음 매니페스트가 더럽다고 말하는" 자기참조. git 호출에 `core.quotepath=false` (한글 경로 8진 이스케이프 방지) |
| 이력 재작성 | 5MB APK blob 3개를 이력에서 제거 (force push). `.git` 42MB → 21MB, 커밋 39 = 39 · 파일 455 = 455 · 트리 diff 없음(소스 유실 없음). 커밋 SHA 가 전부 바뀌어 매니페스트를 새 HEAD 기준으로 재생성 |
| 공개 저장소 준비 | `LICENSE`(Apache-2.0 원문, apache.org 에서 수령) · `NOTICE`(창작재산권 okneo31 + 상표 조항 + 제3자 구성요소) · `README.md`(원칙 · APK 검증법 · 지원 체인 · 금고 구조 · 못 하는 것 포함 상태표) · `SECURITY.md`(신고 절차, in scope / 문서화된 설계 한계) |
| 온체인 앵커 (**발행 대기**) | `scripts/anchor-release.mjs` 기록기 + 검증기 확장. **컨트랙트 없음** — 0-value 트랜잭션 `data` 에 사람이 읽는 텍스트 한 줄 `byeorin:release:1\|sha256=<64hex>\|v=<name>+<code>\|commit=<40hex>`. 검증은 `eth_getTransactionByHash` 1회(O(1)). append-only(수정·폐기 기능 없음). 커밋 안 된 변경이 섞인 빌드는 기록기가 거부. publisher 단일 키로 시작(약점 명시). 드라이런만 확인, **실제 앵커 트랜잭션은 미발행** — `anchor-publishers.json` 의 `publishers` 는 현재 빈 배열 |
| 산출물 | `top.ttl1.byeorin` **v0.5.2 (versionCode 3)** · APK 5,221,596 B · sha256 `5363e843…002dc` · 매니페스트 출처 커밋 `b33ebf3` (main, workingTreeClean=true) |

### 2026-07-25 라운드 — 안드로이드

| 항목 | 내용 |
|---|---|
| 셸 방식 | **Capacitor 8 + Vite WebView.** RN 0.76 Bare 는 Hermes 에 WASM 이 없어 BTC/SOL/TRON 어댑터가 원천 불가 — 9 체인 요구를 만족하는 유일한 경로가 WebView 였다. `apps/mobile` (RN 스캐폴드) 은 그대로 보존. |
| 코드 재사용 | 확장 popup `App.tsx` 2543 줄을 거의 그대로 이식. HW(WebHID)/연결된 사이트(EIP-1193) 만 제거 — 플랫폼에 해당 기능 자체가 없음. |
| 신규 모듈 | `keystore-session.ts` (비밀번호 금고: 오입력 보호 · 디바운스 저장 · clear=잠금/wipe=폐기), `native-http.ts` (ZION AMM 만 CORS 우회), `autolock.ts` (백그라운드 2분), `back-button.ts` |
| CORS 실측 | 9 체인 RPC 중 `api.zion1.top` 만 ACAO 없음 → 그 하나만 네이티브 HTTP. 전역 `CapacitorHttp` 패치는 viem 과 충돌 우려로 배제. |
| 산출물 | `top.ttl1.byeorin` v0.5.0 · release APK 5.0MB (RSA-4096 서명) · debug 6.4MB |
| 잡은 버그 | 런치 테마 `android:background` 가 모든 View 기본 배경으로 상속 → `<select>` 드롭다운 16 행에 스플래시 이미지가 깔림. `android:windowBackground` + core-splashscreen 속성으로 교체. |
| i18n | `vault.*` 24 키 신규 (ko/en). `footer.skeleton` 의 "v0.1 skeleton" 문구 제거. |

### 2026-05-25 라운드 변경 요약 (v0.5 → 작업분)

### 본 라운드 변경 요약 (v0.5 → 작업분)

| 영역 | 변경 |
|---|---|
| `wallet-sdk` | `accountFromPrivateKey` · `transferAccount` 자유함수 · `privateKeyToHex` · `getWordlist`. **새 subpath `@byeorin/wallet-sdk/multichain`** — `ChainSpec` + `DEFAULT_CHAINS` 16종 (EVM 8 + BTC/XRP/SOL/TRON/TON/Aptos/Sui + **ZION**). `ZION_CHAIN_SPEC` + `cosmosChainSpec()` factory. ChainSpec 에 `nativeSymbol`·`nativeDecimals` 메타. ZION 어댑터 호환성 검증 8 tests (defaultFee=0n). private-key 12 tests. |
| `shell-core` | `WalletStore` 다중 계정 매니저 — `addMnemonicAccount/importPrivateKey/selectAccount/listAccounts/removeAccount/exportMnemonic/exportPrivateKey/getActiveIndex/getAccountAt(idx, adapter)`. 세션 직렬화 v2 (JSON), v1 mnemonic-only 자동 마이그레이션. 옛 `unlock(mnemonic)` 시그니처 보존 → Web/Desktop/Mobile 셸 영향 0. 새 `Addressbook` 모듈 (self 자동 sync + external CRUD). 다중계정 15 tests 신규. |
| `apps/extension` | popup 풀 재작성: 16 체인 셀렉터, 다중 계정 셀렉터, 활성 계정 카드(잔액 hero + BTC/USD 토글 + 주소 복사 + QR), 송금 화면, import PK pane, export secret pane, 시드 생성 3단계(언어→표시→검증) + NFKD 정규화 + datalist 자동완성. `qrcode` 의존성. **Buffer polyfill** (`popup/main.tsx`) — cosmos/solana 등 라이브러리 호환. **MV3 CSP `'wasm-unsafe-eval'`** — @solana/web3.js WASM. Binance ticker 시세 1회 fetch. |
| `apps/{web,desktop,mobile}` | **변경 없음.** 옛 단일 계정 흐름 그대로. Stage W/D/M 에서 Extension reference 복제 예정. |
| docs/memory | ZION 메모리 신규 (`project_zion_chain` + `reference_zion_wallet_doc`). 본 문서 갱신. |

### 본 라운드 미완 / 대기

| Task | 상태 | 내용 |
|---|---|---|
| #20 Stage E2 | 다음 | 계정 카드의 9 체인 주소 row + 원클릭 복사, 주소록 화면(자동 sync + 외부 추가), 송금 시 주소록 추천 |
| #20 Stage E3 | 그 다음 | 활동 내역(Activity) + ERC-20 토큰 목록 + 토큰 송금 분기 |
| #26 | 후속 | SolanaAdapter — 멀티 RPC fallback (read-only): publicnode → OnFinality → dRPC. 송금은 단일 (`recent_blockhash` 일관성) |
| #13/14/15 Stage W/D/M | Extension 완성 후 | Web/Desktop/Mobile 셸을 Extension reference 패턴으로. Mobile 만 RN 재작성, Web/Desktop 은 거의 복붙 |
| #16 | Stage B 묶음 | extension e2e smoke 확장, 위협모델 갱신, CONTEXT/PLAN closed 처리 |
| #23/24/25 Z2/Z3/Z4 | 별도 트랙 | ZION 커스텀 메시지(job/amm/pop/bankext/poms) + 기능 UI(잡마켓·AMM·PoP·BTC브릿지) + zion-api 연동 |
| #27 TTL 가치표시 | 완료 | **1 TTL = 노동자 하루 품삯(데나리온)**. 환산은 설계자 연봉 1000 BTC ÷ 365일 = 설계자의 하루 = 100 TTL → 1 TTL = 10/365 ≈ 0.02739726 BTC (2026-07-25 개정, 이전 1/300,000). kWR 은 따라가지 않고 1/300,000 별도 트랙 |

### 본 라운드 외부 결정 (사용자 확정)

- **멀티체인 = 9 어댑터 풀스코프** (PLAN §2.4 전체). Cosmos 슬롯 = **ZION 단독** (외부 Cosmos Hub/Osmosis 등은 후속 추가).
- **풀 ZION 기능** 목표 (job/amm/pop/BTC브릿지) — 별도 트랙 Z2~Z4.
- **원클릭 주소 복사** = 각 체인 row 옆에 (체인당 1개씩) — Stage E2 에서 구현.
- **주소록** = self 자동 sync — `shell-core/Addressbook` 모듈 완성. UI 는 E2.
- **가치 표시** = native 잔액 메인 + BTC 환산 보조 (클릭하면 USD 토글). 천 단위 쉼표. 시세 = Binance ticker. TTL 페그 = 10/365 BTC (노동가치 기준).
- **MV3 popup 멀티체인 인프라** = WASM CSP `'wasm-unsafe-eval'` 허용 + Buffer polyfill 필수. multichain 청크는 dynamic import 로 분리 (popup 초기 78kB, multichain 5.76MB lazy).
- **RPC override** = `ethereum`/`solana` 만 publicnode 로 override (viem default 와 mainnet-beta 가 extension origin 거부 또는 hang). 나머지 EVM/비-EVM 은 라이브러리 기본 RPC.

---

## 1. 정체성 (변경 금지 / 단일 진실원)

| 항목 | 값 | 비고 |
|---|---|---|
| 마스터 브랜드 | **벼린** (Byeorin) | 단조(벼리다) + 핵심(벼리) 이중의미 |
| 포지션 슬로건 | "노동자의 지갑" (Worker's Wallet) | 정식명 아님, 부제·헤더 카피 |
| 슬로건 | "노동자의 지갑이 세상을 자유롭게" | 마이그레이션 시 placeholder 보호 |
| HW 디바이스명 | **벼린 요세** (Byeorin Yose) | 요세=요새(要塞), 시드 보관 거점 |
| 패키지 scope | `@byeorin/*` (5 packages) | 마이그레이션 완료 |
| 루트 package | `byeorin-wallet` | |
| 펌웨어 보드 | `nrf52840_byeorin_yose` | overlay 파일도 rename됨 |

### 컬러 팔레트 (v2)

| 토큰 | HEX | 용도 |
|---|---|---|
| `--nd-red` / `--nd-ember` | `#E84D1A` | 잉걸 오렌지 — primary action |
| `--nd-ink` / `--nd-anvil` | `#1A1A1A` | 모루 차콜 — 본문/로고 |
| `--nd-black` / `--nd-night` | `#0B0B0D` | 밤 모루 — 다크모드 배경 |
| `--nd-steel` | `#9CA3AF` | 강철 실버 — 보더/비활성 |
| `--nd-sweat` | `#2E78D2` | 땀 블루 — 정보/링크 |
| `--nd-paper` | `#FAFAF7` | 종이 화이트 — 라이트 배경 |
| `--nd-yellow` | `#F4C430` | 따뜻한 강조 (유지) |

> `--nd-*` prefix는 호환성 위해 유지. 새 코드는 의미적 alias(`--nd-ember`/`anvil`/`night`/`steel`/`sweat`) 사용 권장.

---

## 2. 자산 인벤토리

### 디자인 자산 (`D:\TTLCOINWalet\`)
| 파일 | 용도 |
|---|---|
| `logo0.png` (4MB, 2048×2048) | 마스터 심볼 (모루+불꽃) |
| `logo0.svg` (956KB, 벡터) | 마스터 심볼 벡터 버전 |
| `logo0_dark.png` | 다크모드 자동 변환 (HLS 명도 반전) |
| `lockup가로.png` | Lockup B (심볼+워드마크 가로) |
| `lockup세로.png` | Lockup A (심볼+워드마크 세로) |
| `벼린 워드마크.png` | 한글 워드마크 단독 (메탈릭 음각) |
| `BYEORINWordMark.png` | 영문 워드마크 (스텐실 세리프) |

### 앱 아이콘 패키지 (`icons/dist/`)

64 파일 — iOS/Android/Web/PWA/Win/macOS/Social 일괄. 자세한 폴더 구조는 [`icons/dist/README.md`](../icons/dist/README.md).

각 앱에 배포 완료된 상태 (deploy_icons.py, 17 타겟):
- `apps/web/public/` — favicon{,.ico,.png}, apple-touch, og.{png,jpg}, manifest.webmanifest
- `apps/extension/public/icon/` — 16/32/48/128
- `apps/desktop/src-tauri/icons/` — Tauri 5 파일 + `icon.iconset/` (macOS .icns 입력)
- `apps/mobile/assets/AppIcon.appiconset/` + `android-icons/` — RN bare workflow

### 옛 자산 (아카이브 후보)
- `branding/raw/*.svg` — 옛 곡괭이 컨셉 (Concept A/B/C, og.svg, mark.svg, logo-wordmark.svg)
- `verification/icon-concepts/*.svg` — 옛 아이콘 컨셉
- 텍스트는 마이그레이션됐지만 그래픽은 옛것. **삭제 또는 아카이브 결정 미정**.

---

## 3. 스크립트 인벤토리 (`scripts/`)

브랜드/디자인 자동화 5종:

| 스크립트 | 용도 |
|---|---|
| `make_dark_mode.py` | logo0.png → logo0_dark.png. HLS 명도 반전 + 좌표 마스킹 |
| `downsample_test.py` | 다양한 사이즈(16~512px) 다운샘플 테스트 |
| `generate_all_icons.py` | 전 플랫폼 자산 일괄 생성 (64파일 → `icons/dist/`) |
| `deploy_icons.py` | `icons/dist/` → 각 앱 적절한 위치로 (17 타겟) |
| `migrate_brand.py` | 브랜드 텍스트 일괄 치환 (dry-run/--apply, 슬로건 보호) |

릴리스 검증 2종 (2026-07-26 신설):

| 스크립트 | 용도 |
|---|---|
| `verify-byeorin-apk.mjs` | **제3자용 검증기.** 의존성 0(순수 fetch). 무결성/진위/출처/온체인 앵커 4항목 대조 |
| `anchor-release.mjs` | 릴리스 매니페스트 해시를 TTL 체인(7777)에 앵커링. 기본 드라이런, `--send` + `BYEORIN_ANCHOR_KEY` 로 발행 |

> 매니페스트 생성기는 안드로이드 앱 쪽에 있다 — `apps/android/scripts/release-manifest.mjs` (release 빌드 시 `gradle.mjs` 가 자동 호출).

기존 코어 도구 (참고):
- `setup-check.mjs`, `verify-addresses.mjs`, `devnet-round-trip.mjs`, `generate-extension-icons.mjs`

---

## 4. 모노레포 구조

```
D:\TTLCOINWalet\
├── apps/
│   ├── android/     ★ Capacitor 8 + Vite WebView → APK. 9 체인 전부 동작 (실사용 셸)
│   ├── mobile/      RN 0.76 Bare TS — 네이티브 프로젝트 없음. android/ 로 대체됨(보존)
│   ├── web/         Vite + React
│   ├── desktop/     Tauri 2 (src-tauri 포함)
│   └── extension/   WXT (MV3)
├── packages/
│   ├── wallet-sdk/  코어 SDK (9 체인 어댑터: EVM/BTC/XRP/Cosmos/Sol/Tron/TON/Aptos/Sui)
│   ├── shell-core/  WalletStore + SessionStore + Keystore (scrypt N=2^17 + AES-256-GCM)
│   ├── design-system/  토큰 + Logo/Button/Card/Input/AddressDisplay/AmountDisplay
│   └── i18n/        한/영 (일/중은 2차)
├── firmware/
│   └── app/         Zephyr RTOS, nRF52840 + SE050 + e-ink. 컴파일 통과, HW-터치는 -ENOSYS stub
├── hardware/        SPEC.md, BOM.csv, pin-map.md, threat-model.md
├── verification/    10/10 cross-SDK 주소 검증 + test-dapp.html
├── docs/            PLAN.md(v0.5), ARCHITECTURE.md, VERIFIABILITY.md, CHANGELOG.md, INSURANCE.md, CONTEXT.md(본문)
├── icons/dist/      64 파일 앱 아이콘 패키지
├── scripts/         자동화 (위 §3)
├── branding/raw/    옛 곡괭이 자산 (정리 후보)
├── LICENSE, NOTICE, README.md, SECURITY.md   공개 저장소 세트 (2026-07-26)
├── anchor-publishers.json   앵커 publisher 허용 목록 (chainId 7777, 현재 비어 있음)
├── 벼린.apk (git 미추적) + 벼린.apk.manifest.json (추적 — 공개 검증 근거)
├── BYEORINWordMark.png, lockup{가로,세로}.png, 벼린 워드마크.png, logo0.{png,svg,_dark.png}
└── package.json (byeorin-wallet, pnpm workspace)
```

---

## 5. 닫힌 결정 (재논의 X)

- **라이선스 = 전체 Apache-2.0** (2026-07-26). 창작재산권은 okneo31, NOTICE 표기
  의무(§4(d))로 파생물에도 표기가 따라간다. "벼린"·"Byeorin"·"벼린 요세" 상표는
  라이선스 대상이 아니다(§6) — 포크는 다른 이름을 써야 한다. 자체 라이선스를
  쓰지 않은 이유: SPDX/GitHub/npm/기업 스캐너가 인식 못 하면 `unknown license` 로
  차단된다. 파일: [`LICENSE`](../LICENSE), [`NOTICE`](../NOTICE).
- **검증 가능한 보안** (2026-07-25) — "규칙은 누구나 검증 가능하게, 권한은 아무나가
  아니게". 목표는 "최고의 보안"이 아니라 확인 가능한 보안. 규칙을 이해 못 하게 만드는
  방향(난독화)은 채택하지 않는다 — 감사 불가능한 규칙은 중앙 권위를 재발명한다.
  절차와 로드맵은 [`docs/VERIFIABILITY.md`](./VERIFIABILITY.md), 요세 요구사항은
  SPEC F-11~F-14.
- 마스터 브랜드 = 벼린 (2026-05-17)
- HW 디바이스명 = 벼린 요세 (2026-05-18)
- 워드마크 폰트 = 굵은 산세리프 (Pretendard Black 계열). 명조 X
- 로고 컨셉 = 모루 + 불꽃 (단조의 순간)
- 컬러 팔레트 = 잉걸 오렌지/모루 차콜/강철 실버/땀 블루/종이 화이트/밤 모루
- 패키지 scope = `@byeorin/*`
- design-system CSS 변수 prefix = `--nd-` 유지 (의미: 노동의 디자인)
- Expo Managed 거부 → RN 0.76 Bare (2026-05, 스캐폴드만)
- **모바일 셸 = Capacitor 8 + WebView** (2026-07-25). RN 유지 시 Hermes 에 WASM 이 없어
  BTC/SOL/TRON 어댑터가 원천 불가 → "9 체인 전부" 요구와 양립하지 않는다. `apps/mobile`
  RN 스캐폴드는 지우지 않고 보존 (USB-OTG HW 서명 등 네이티브 요구가 생기면 재사용).
- Electron 거부 → Tauri 2
- 확장 raw MV3 거부 → WXT

## 6. 열린 결정 ([PLAN.md §10](./PLAN.md))

- TTL coin_type SLIP-0044 신청? (현재 60 공유)
- HW 1차 시판 국가 (한국 단독? 한+미+EU?)
- 시드 백업 정책 (종이 + Shamir + 클라우드 보조?)
- 요세 펌웨어를 공개·재현 가능하게 낼지 ([SPEC F-11](../hardware/SPEC.md), [VERIFIABILITY §2](./VERIFIABILITY.md) 에 "미결정"으로 기재)

> 라이선스 항목은 2026-07-26 에 닫혔다 → §5.

---

## 7. 다음 작업 후보 (우선순위)

### A. PLAN.md §9 "즉시 다음 행동" — Q1 본격 실행
1. **Web TTL claim 페이지** 외부 사용자 테스트 (피드백 루프)
2. **Extension EIP-1193** WalletConnect v2 (Reown) 외부 dApp 1개 연동
3. **Cross-shell 영구 keystore** 마이그레이션 (web in-memory → opt-in localStorage)
4. **SignerRouter** 인터페이스 정의 (HwSigner 실제는 Q4)

### B. 정리/위생 작업
- 옛 곡괭이 자산 (`branding/raw/`, `verification/icon-concepts/`) 삭제/아카이브 결정
- 옛 커밋 author 정리 — 현재 41 커밋 중 **19개**가 `*@nodong.local` 봇 author
  (`c4213e8` = design-pickaxe 등). 2026-07-26 이력 재작성 때는 author 를 건드리지
  않아 그대로 남아 있다. history rewrite + force push 필요.
- Mobile/Android RN bare 빌드에 새 아이콘 wire up

### C. HW Q4 진입 사전작업
- SE050 vs ST31N600 최종 결정 (lead time 견적)
- KiCad EVT-1 스키매틱 캡쳐 시작 (`hardware/kicad/`)
- USB-IF VID 신청

### D. 검증 체계 ([VERIFIABILITY.md §3](./VERIFIABILITY.md) 로드맵)
1. **온체인 릴리스 앵커 실제 발행** (로드맵 1순위) — 기록기/검증기는 `76d7820` 에서
   구현 완료, 드라이런만 확인됨. 발행에 필요한 것: publisher 개인키
   (`BYEORIN_ANCHOR_KEY`) + ChainID 7777 가스. 발행 후 publisher 주소를
   `anchor-publishers.json`(현재 `publishers: []`) 에 넣고 매니페스트에 `anchor.txHash` 기록.
2. **재현 빌드** (2순위) — 현재 **안 됨**(실측, §0 표). `SOURCE_DATE_EPOCH` 로 zip
   타임스탬프 고정, AGP/Gradle/JDK 핀 고정, 컨테이너 빌드. 서명 전 APK 기준으로
   재현성 확보 후 서명은 분리 검증.
3. **앱 내 빌드 커밋 표시** (3순위) — 푸터가 현재 `v0.5.2 (3)` 까지만 표시하므로
   실행 중인 앱과 매니페스트를 커밋 단위로 대조할 수단이 없음.

---

## 8. 빠른 명령 reference

```bash
# 모노레포 빌드/테스트/타입체크
pnpm install        # lockfile 재생성
pnpm typecheck      # 8 워크스페이스 전체
pnpm test           # 9 워크스페이스 (firmware 제외)
pnpm build          # 전체 빌드

# 디자인 자동화
python scripts/make_dark_mode.py
python scripts/downsample_test.py
python scripts/generate_all_icons.py
python scripts/deploy_icons.py

# 브랜드 마이그레이션 (재실행 시)
python scripts/migrate_brand.py            # dry-run
python scripts/migrate_brand.py --apply    # 실제 적용

# 릴리스 검증 (매니페스트는 release 빌드 시 자동 생성)
cd apps/android && pnpm apk                 # → 벼린.apk + 벼린.apk.manifest.json
node scripts/verify-byeorin-apk.mjs 벼린.apk 벼린.apk.manifest.json
node scripts/anchor-release.mjs                              # 앵커 드라이런
BYEORIN_ANCHOR_KEY=0x… node scripts/anchor-release.mjs --send  # 실제 발행 (미실행)

# Git (origin = github.com/okneo31/byeorin, main 추적 중)
git status
git log --oneline -5
git push                                    # 추가 변경 후
```

---

## 9. 주요 인물·계정

- **사용자**: okneo31 (GitHub) / okneojjjajh@gmail.com
- **GitHub 리포**: <https://github.com/okneo31/byeorin> (private)
- **TTL 체인**: ChainID 7777, geth 1.13.15 포크, MetaMask 그대로 호환
  - eth_chainId = 0x1e61, eth_gasPrice ≈ 1 Gwei

---

## 10. Cross-document index

| 문서 | 역할 |
|---|---|
| [`docs/PLAN.md`](./PLAN.md) | **단일 진실원** — 제품·아키텍처·로드맵 (v0.5) |
| [`docs/VERIFIABILITY.md`](./VERIFIABILITY.md) | **검증 가능한 보안** — 원칙·현재 검증 가능한 것·아직 못 하는 것·로드맵 |
| [`docs/CONTEXT.md`](./CONTEXT.md) | **본 문서** — 현재 상태 스냅샷, 세션 인수인계 |
| [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | 시스템 다이어그램 + 모듈 책임 + 위협 경계 + 키 invariant |
| [`docs/CHANGELOG.md`](./CHANGELOG.md) | 커밋 단위 변경 기록 (v0.5 entry 포함) |
| [`docs/INSURANCE.md`](./INSURANCE.md) | 보험 시스템 v2 (849줄, 5개 kill criteria) |
| [`README.md`](../README.md) | 저장소 첫 화면 — 원칙 · APK 검증법 · 지원 체인 · 금고 구조 · 상태표 |
| [`SECURITY.md`](../SECURITY.md) | 취약점 신고 절차 · in scope · 문서화된 설계 한계 |
| [`LICENSE`](../LICENSE) | Apache License 2.0 원문 |
| [`NOTICE`](../NOTICE) | 창작재산권(okneo31) 표기 · 상표 조항 · 제3자 구성요소 |
| [`hardware/SPEC.md`](../hardware/SPEC.md) | HW 사양 v0 (외부 벤더 리뷰용). 검증 요구 F-11~F-14 |
| [`apps/android/README.md`](../apps/android/README.md) | 안드로이드 셸 — 금고 2겹 구조와 **막지 못하는 것** |
| [`firmware/README.md`](../firmware/README.md) | 펌웨어 빌드/레이아웃 |
| [`icons/dist/README.md`](../icons/dist/README.md) | 아이콘 패키지 플랫폼별 적용법 |

---

## 11. 새 세션 시작 시 권장 동작 (AI 에이전트용)

1. **본 문서 (`CONTEXT.md`)를 먼저 읽는다.** 핵심 결정·자산·다음 작업 5분 안에 파악.
2. **PLAN.md §9** 로 진입해 Q1 액션 중 하나를 시작하거나, 사용자에게 다음 작업 확정 질문.
3. **메모리 시스템** (`C:\Users\jjjaj\.claude\projects\D--TTLCOINWalet\memory\`)도 함께 활용 — 사용자 선호, 피드백, 닫힌 결정 디테일은 그쪽에 있음.
4. **자동 변환된 옛 잔재** (`branding/raw/*.svg`, `verification/icon-concepts/*.svg`)에 옛 곡괭이 그래픽이 남아있음을 인지. 새 곡괭이 아님.
5. **package.json name = `byeorin-wallet`**, 모든 패키지 `@byeorin/*`. 옛 `@nodong/*` 출현 시 마이그레이션 누락이므로 즉시 처리.
6. **HW 디바이스명은 "벼린 요세"** (Byeorin Yose). "벼린 콜드" 또는 "벼린 모루" 같은 옛 후보는 폐기.
