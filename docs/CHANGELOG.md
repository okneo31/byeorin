# Changelog

All notable changes to **벼린** (Byeorin / Worker's Wallet) are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Until v0.1 tagging, each commit is its own release entry.

---

## [58bbbe5…76d7820] verifiability: 검증 가능한 보안 — 릴리스 검증 체계 + 금고 하드웨어 바인딩 + 공개 저장소 준비 — 2026-07-26

커밋 8개: `58bbbe5` `c1d85a1` `08e954b` `2316a0c` `83f372e` `b33ebf3` `dfdaff7` `76d7820`.

### Added (android — 금고 하드웨어 바인딩, `58bbbe5`)
- `apps/android/android/app/src/main/java/top/ttl1/byeorin/VaultCryptoPlugin.java` (158줄) — 로컬 Capacitor 플러그인 `isAvailable`/`wrap`/`unwrap`. AndroidKeyStore 에서 AES-256 키 생성, StrongBox 우선 시도 후 미탑재 단말은 TEE 폴백. 서드파티 의존성 0.
- `apps/android/src/vault-hw.ts` (146줄) — shell-core `PersistentBackend` 를 감싸는 백엔드. `EncryptedKeystoreStore` 가 저장소를 인터페이스로 주입받는 구조라 **shell-core 변경 0줄**.
- 금고 계층 순서: `시드 → AES-GCM(scrypt(비밀번호)) → AES-GCM(AndroidKeyStore 키) → localStorage`. 바깥 겹의 키는 칩 밖으로 나오지 않아, 저장 파일만으로는 그 폰 밖에서 복호화를 시작할 수 없다 — 오프라인 대입 경로가 사라진다. 하드웨어 계층이 뚫려도 남는 것은 scrypt 로 잠긴 blob.
- 하드웨어를 쓸 수 없으면 보호 수준을 낮춰 저장하지 않고 실패한다.
- `setUserAuthenticationRequired` 는 켜지 않음 — 생체 재등록/화면잠금 변경으로 키가 무효화되면 금고를 못 여는 사고가 난다.
- `apps/android/README.md` — 이 계층이 **막지 못하는 것**(칩 벤더/OEM, 물리 공격, 잠금 해제된 단말) 명시.

### Added (릴리스 검증 체계, `c1d85a1`)
- `apps/android/scripts/release-manifest.mjs` (165줄) — release 빌드마다 매니페스트 자동 생성. 파일 SHA-256, 서명 인증서 지문, 출처 커밋/브랜치, **작업 트리 청결 여부**, 툴체인 버전, `claims`(주장하지 않는 것).
- `scripts/verify-byeorin-apk.mjs` (122줄) — 제3자용 검증기. 의존성 0, 저장소 없이 파일 하나로 동작. 우리 서버에 아무것도 묻지 않는다.
- `apps/android/scripts/gradle.mjs` — release 빌드 후 매니페스트 자동 생성 (매니페스트 없는 APK 를 만들지 않는다).
- `docs/VERIFIABILITY.md` — 원칙, 공개/비공개 경계(Kerckhoffs), 지금 검증 가능한 것, **아직 못 하는 것**, 로드맵. 난독화 방향은 명시적으로 기각.
- `hardware/SPEC.md` F-11~F-14 — 재현 빌드 / 온체인 앵커 기반 정품 증명 / 사용자 엔트로피 혼합 / 멀티벤더 쿼럼의 한 다리.
- 공개 서명 인증서 지문: `303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480`

### Added (온체인 릴리스 앵커 — 구현 완료, **발행 대기**, `76d7820`)
- `scripts/anchor-release.mjs` (154줄) — 매니페스트 해시를 TTL 체인(ChainID 7777)에 기록. **컨트랙트를 쓰지 않는다** — 0-value 트랜잭션 `data` 에 사람이 읽는 텍스트 한 줄: `byeorin:release:1|sha256=<64hex>|v=<name>+<code>|commit=<40hex>`.
- `scripts/verify-byeorin-apk.mjs` 에 4번째 검사 추가 — `eth_getTransactionByHash` **1회**(O(1))로 ① tx 존재 ② `from` 이 공개 publisher 목록에 있는가 ③ `data` 에 해당 sha256 이 있는가. 검증기는 여전히 **의존성 0**(순수 fetch), viem 은 기록기에서만 사용.
- `anchor-publishers.json` — publisher 허용 목록. 단일 키로 시작하며 그 약점을 문서에 명시. 목록이 비면 `from` 검사를 건너뛰고 경고.
- append-only — 수정·폐기 기능 없음. 커밋 안 된 변경이 섞인 빌드는 기록기가 **거부**한다.
- **드라이런만 확인. 실제 앵커 트랜잭션은 미발행** — publisher 키와 자금이 필요하다. `anchor-publishers.json` 의 `publishers` 는 현재 빈 배열.

### Added (공개 저장소 준비, `b33ebf3`)
- `LICENSE` — Apache License 2.0 원문 (apache.org 에서 수령).
- `NOTICE` — 창작재산권 okneo31 명시 + 상표 조항(§6, 포크는 개명 필요) + 제3자 구성요소.
- `README.md` — 원칙, APK 검증법, 지원 체인(16 슬롯 / 9 어댑터), 금고 2겹 구조, **못 하는 것을 포함한 상태표**.
- `SECURITY.md` — 취약점 신고 절차(72시간 목표 응답), in scope, **문서화된 설계 한계**(칩 벤더·물리 공격·재현 빌드 미보장), 서명 지문 공개.
- 라이선스 = Apache-2.0 으로 확정. 자체 라이선스는 SPDX/GitHub/npm/기업 스캐너가 인식 못 하면 `unknown license` 로 차단되므로 채택하지 않았다.

### Measured — 재현 빌드는 **안 된다** (`2316a0c`)
추측하지 않고 측정했다.

```
증분 빌드 직후          cd3fcb6d27264d60c63cc61575990fc541078e8d2979e3487fdbda7752575b67
gradlew clean 후 재빌드  5363e84330ca8b6d153e5e603830fb7691b6c38421f6585d6b61284ab19002dc
```

- **같은 머신·같은 커밋·같은 툴체인인데 바이트가 다르다.** 다른 사람·다른 머신은 말할 것도 없다.
- 앞서 `08e954b` 에서 재빌드 후 해시가 같게 나온 것은 Gradle 이 130개 태스크를 up-to-date 로 재사용한 증분 빌드였고, 결정성의 근거가 아니었다 — 그렇게 서술했던 것을 문서에서 정정.
- 결과: 매니페스트의 `commit` 이 그 바이트를 만들었다는 **증명은 없다.** 현재는 우리 주장이다.
- 이 사실은 앵커링에도 걸린다 — 재현 빌드 없이 하는 앵커링은 "사실"이 아니라 "주장"을 못 박는다.

### Fixed (매니페스트 정직성, `2316a0c`)
- `벼린.apk` 가 git 에 추적되고 있었다. `.gitignore` 규칙을 **이미 추적 중인 파일 뒤에** 넣어 효력이 없었던 탓에, 빌드마다 5MB 바이너리가 변경으로 잡혀 "작업 트리 더러움" 신호가 상시 켜져 있었다. `git rm --cached` 로 추적 해제.
- 더러움 판정에서 산출물 자신(매니페스트)을 제외. 빼지 않으면 "매니페스트를 쓰는 행위가 트리를 더럽혀 다음 매니페스트가 더럽다고 말하는" 자기참조에 빠진다.
- git 호출에 `core.quotepath=false` — 안 붙이면 한글 경로가 8진 이스케이프로 나와 경로 비교가 맞지 않는다.
- 금고 승급 버그(`58bbbe5`): 셸의 "내용 같으면 저장 건너뛰기" 최적화 탓에 옛 금고가 열리기만 하고 다시 봉인되지 않았다. `lastReadWasWrapped` 로 강제 재기록.

### Changed (이력 재작성, `dfdaff7`)
- 5MB APK blob 3개를 이력에서 제거 (force push). `.git` 42MB → 21MB, 이력 내 `벼린.apk` 0건.
- 검증: 커밋 39 = 39, 파일 455 = 455, 트리 diff 없음 — **소스 유실 없음**.
- 커밋 SHA 가 전부 바뀌어 직전 매니페스트가 존재하지 않는 커밋(`a665666`)을 가리켰다. 새 HEAD 기준으로 재생성.

### Verified (에뮬레이터 실측, `58bbbe5`)
- CDP 로 localStorage 직접 확인. 이전 빌드 금고 `{"v":1,"kdf":"scrypt","N":65536,…}` → 새 빌드 덮어 설치 후 잠금 해제 시 `{"hw":1,"iv":…,"ct":…}` 로 자동 승급, scrypt 파라미터가 저장소에서 완전히 사라짐. 계정 `0xf39F…2266` 그대로 복원.
- 앱 재시작 후 봉인된 금고를 읽는 경로 확인.
- `isAvailable → {available:true, strongBox:false}` (에뮬레이터는 TEE 폴백).

### Artifact
- `top.ttl1.byeorin` **v0.5.2 (versionCode 3)** · 5,221,596 B · sha256 `5363e843…002dc`
- 매니페스트 출처: commit `b33ebf3` (main), `workingTreeClean: true`
- 툴체인: Node v24.15.0 · Gradle 8.14.3 · AGP 8.13.0 · compileSdk 36 / minSdk 24 / targetSdk 36

---

## [v0.5] brand: 노동자의 지갑 → 벼린 (Byeorin) 전면 마이그레이션 + 디자인 시스템 v2 — 2026-05-18

### Brand
- 마스터 브랜드 확정: **벼린** (단조+핵심 이중의미). 포지션 슬로건 "노동자의 지갑" 유지.
- HW 디바이스명: **벼린 요세 (Byeorin Yose)**. 요세=요새, 시드를 지키는 거점.

### Changed (마이그레이션, 185 파일 / 958 replacement, `scripts/migrate_brand.py`)
- 패키지 scope: `@nodong/*` → `@byeorin/*` (5 packages)
- 영문/한글 정식명: `Nodong`/`NODONG_*`/"노동자의 지갑" → `Byeorin`/`BYEORIN_*`/"벼린"
- 펌웨어 보드: `nrf52840_nodong_cold.overlay` → `nrf52840_byeorin_yose.overlay`
- 슬로건 "노동자의 지갑이 세상을 자유롭게"는 placeholder 보호로 그대로 유지

### Added (브랜드 디자인 자산)
- 마스터 심볼: `logo0.{png,svg,_dark.png}` — 모루+불꽃 컨셉 (단조의 순간)
- Lockup 가로/세로 + 워드마크 한/영 (산세리프 Pretendard Black 계열)
- `icons/dist/` — iOS/Android/Web/PWA/Win/macOS/Social 64 파일 일괄
  + favicon.ico, manifest.webmanifest, head-snippet.html 메타파일
- 컬러 팔레트: 잉걸 오렌지 `#E84D1A` / 모루 차콜 `#1A1A1A` / 강철 실버 `#9CA3AF` / 땀 블루 `#2E78D2` / 종이 화이트 `#FAFAF7` / 밤 모루 `#0B0B0D`
- 신규 스크립트: `make_dark_mode.py` (HLS 명도 반전), `downsample_test.py`, `generate_all_icons.py`, `deploy_icons.py`

### Changed (design-system)
- `tokens.css`/`tokens.ts` 컬러 값 새 브랜드 팔레트로 교체 (`--nd-*` prefix는 코드 호환성 위해 유지)
- 시멘틱 aliases 추가: `--nd-ember`(=red), `--nd-anvil`, `--nd-night`, `--nd-steel`, `--nd-sweat`
- `Logo.tsx` 새 모루+불꽃 SVG로 완전 재작성 (옛 곡괭이 컨셉 폐기)

### Distributed (앱별 자산 배포, `scripts/deploy_icons.py`)
- `apps/web/public/` — favicon, apple-touch, og, manifest 6 파일
- `apps/extension/public/icon/` — 16/32/48/128 4 파일
- `apps/desktop/src-tauri/icons/` — Tauri 빌드용 5 파일 + `icon.iconset/` 폴더 (macOS .icns 입력)
- `apps/mobile/assets/AppIcon.appiconset/` + `android-icons/` — RN bare workflow용

### Fixed
- `apps/desktop` Portfolio.tsx:111, Wallet.tsx:109 — implicit any 보완 (`b: bigint`)

### Verified
- `pnpm typecheck` 8/8 워크스페이스 통과 (design-system 갱신 후 재검증 통과)

---

## [c04a852] harden: review wave 5 — 2nd-pass vulnerability hardening — 2026-05-16

### Added
- `signEvmMessage(signer, address, message)` helper in SDK (EIP-191) — extension can now drop its inline hash construction. Byte-equivalence vs `viem.signMessage` verified.
- `KEYSTORE_PARAMS_FAST` preset (scrypt N=2^16) for mobile / low-end devices; default `KEYSTORE_PARAMS_DEFAULT` bumped to N=2^17 (≈256 MB working set).
- SLIP-0010 ed25519 conformance: 4 tests against canonical spec vectors.
- Cross-vendor regression: Aptos / Solana / Cosmos / Osmosis address derivation validated against each chain's official SDK.
- Tron recovery boundary tests: rejects v ∈ {2, 26, 29, 255}.
- `.github/workflows/ci.yml` — typecheck + test + build + `pnpm audit` gate.

### Changed
- Extension popup ↔ background protocol: 128-bit nonce binding. Direct-URL hijack of `connect.html` / `confirm.html` now rejected with friendly Korean error.
- `sender.id === chrome.runtime.id` guard on every message branch.
- `chrome.runtime.onSuspend` rejects pending requests (Service Worker termination safety).
- `WalletStore`: explicit lock-vs-inflight-transfer policy (broadcast completes, subsequent calls throw), idempotent concurrent `unlock()`, explicit-adapter cache bypass.
- `detectWordlist`: mixed Korean/English now rejected with clear Korean error.
- `prj.conf` (firmware) production preset: CONSOLE/SERIAL/PRINTK/ASSERT/DEBUG=n, BLE_SIGNING=n, CONFIRM_TIMEOUT=60s.
- All firmware transport/se/keys files now carry `SECURITY-CRITICAL` header banners.

### Fixed
- BLE write callback (firmware): pre-callback length / offset / null guards.
- HID reassembly (firmware): `rx_reset()` now memsets the buffer on every IDLE transition.
- Extension connect/App: removed origin URL fallback (spoofing risk).
- EIP-6963 announce: documentation clarified that no account leak occurs.

### Security
- `pnpm audit`: 24 advisories → 1 low (Critical 1→0, High 8→0, Moderate 13→0).
- Root `pnpm.overrides`: `protobufjs ^7.5.8`, `axios ^1.15.2`, `fast-xml-parser ^5.7.0`.
- `.gitignore` hardened: env / secrets / keys / keystores / mobileprovisions patterns.
- SE050: anti-rollback `get` / `increment` prototypes added.
- `WalletStore.test.ts`: 20 new tests covering 6 invariants.

### Test metrics
- SDK: **83 pass / 9 skipped / 0 fail** (was 63).
- shell-core: **37 pass** (was 14).

---

## [a334e20] feat: review wave 4 — insurance v2 + keystore + ext confirm + RN UI + Tron fix — 2026-05-16

### Added
- `docs/INSURANCE.md` (849 lines) — v2 standalone insurance system design. Recommends HW = KB insurance bundle + SW = Nexus/InsurAce distribution + self-pool permanently deferred. 5 kill criteria, legal-first roadmap, 벼린 identity alignment check.
- `packages/shell-core/src/keystore.ts` — scrypt (N=2^16) + AES-GCM `EncryptedKeystoreStore` with `LocalStorageBackend` + `ChromeLocalBackend`.
- `apps/extension/entrypoints/confirm/` — consent popup for `personal_sign` and `eth_sendTransaction`. EIP-191 prefixed hash + v=recovery+27. Hard-enforces chainId 7777 and rejects contract calls (data != 0x) until v0.3.
- `apps/mobile/src/ui/` — RN primitives (Button / Card / Input / AddressDisplay / AmountDisplay). 3 screens (Home / Account / Send) migrated from inline styles to primitives.

### Fixed
- **TRON adapter signature** (production-critical silent failure risk): TronWeb v6 expects `r ‖ s ‖ (recovery + 27)` — we were sending raw recovery 0/1. `applySignatures` now normalizes `+27`, while `27/28` pass through unchanged (HW signer path). New offline verification test enforces byte-for-byte equality.

### Test metrics
- SDK: **63 pass / 9 skipped / 0 fail**.
- shell-core: **14 pass**.

---

## [9d3c847] refactor: review wave 3 — secp dedup + Cosmos Injective + mobile DS — 2026-05-16

### Added
- `packages/wallet-sdk/src/crypto/secp.ts` — single source for `toCompressedSecp256k1` / `toUncompressedSecp256k1`. 5 adapters (btc / xrp / evm / tron / cosmos) had identical local helpers — now all import the shared module.
- `CosmosAdapter.evmAddressing` option — Injective / Ethermint family. keccak256 address derivation (same 20 bytes as EVM), `inj` bech32 prefix, `/injective.crypto.v1beta1.ethsecp256k1.PubKey` Any typeUrl.
- New test: same seed yields `inj1...` 20-byte address ≡ EVM `0x...` 20-byte.

### Changed
- `apps/mobile` adopts `@byeorin/design-system` — `tokens.color` / `space` / `radius` / `font`. 6 hardcoded hex literals replaced.
- Korean font stack added (System → Apple SD Gothic Neo / Noto Sans CJK).
- Dark chrome colors retained at v0.1 (DS exposes light palette only for now).

### Test metrics
- SDK: **59 pass / 9 skipped / 0 fail** (3 new Injective tests).

---

## [72887dc] refactor: review wave 2 — ChainAdapter signRequests[] + @byeorin/shell-core — 2026-05-16

### Added
- `@byeorin/shell-core` package — `WalletStore` + `SessionStore` interface. Eliminates wallet-store.ts duplication across 4 shells (web / desktop / mobile / extension).
- `WebSessionStore` (autoRestoreAllowed=false, v0.1 in-memory only — H1 security policy).
- `ExtensionSessionStore` (`chrome.storage.session`, autoRestoreAllowed=true).
- `MemorySessionStore` (mobile default).
- `SignRequest` interface — `{ message: Uint8Array, prehashed: boolean }`. HW-signer hint.
- New test: BTC multi-input signing now works through the public `Wallet.transfer` API.

### Changed
- **`ChainAdapter` interface migration**: `serializeForSigning` / `applySignature` → `signRequests[]` / `applySignatures[]`. All 9 adapters migrated (evm / btc / xrp / cosmos / solana / tron / ton / aptos / sui). Single-signature chains return exactly one request; BTC returns one per input.
- `BtcAdapter` side channel `signingDigests` made `private` (was inadvertently public).
- Hangul regex tightened `[가-힯]` → `[가-힣]` (M3).

### Test metrics
- SDK: **56 pass / 9 skipped / 0 fail** (1 new BTC multi-input test).
- 8 packages typecheck pass.

---

## [1ec8e5b] fix: review wave 1 — security + UX + cleanups — 2026-05-16

### Added
- Extension EIP-1193: per-origin consent flow + connect popup + EIP-6963 announce + scope restricted to `https://` and `localhost` (C1 + H2 + H3).
- Desktop Wallet: triple-state balance UI (loading / error / success) + "retry" button (M1).
- Web / Desktop: `@byeorin/design-system` adoption (Logo / Button / Card / Input / AddressDisplay / AmountDisplay).
- Firmware APDU: APDU_ERR_BAD_LC error code (M5).

### Changed
- Web Send: `viem.parseUnits` replaces float math (C2 — precision bug).
- SDK: `xrpToDrops` adds safe-range guard, rejects negatives, defends against scientific notation (M6).
- SDK: `isValidClassicAddress` re-export moved to `index.ts` (removes tsup warning).
- Firmware APDU parser: handles both short and extended forms.

---

## [8419a53] feat: parallel wave 2 — P2 adapters + HW spec + firmware skeleton — 2026-05-15

### Added
- **`TonAdapter`** — `@ton/ton` v4 wallet, EQ-bounceable addresses, inline-action serialization (ESM-safe).
- **`AptosAdapter`** — Petra derivation path `m/44'/637'/i'/0'/i'`, sha3-256 auth key.
- **`SuiAdapter`** — blake2b-256 address, intent-prefixed signing, base64 `flag ‖ sig ‖ pubkey`.
- `hardware/SPEC.md` (11 sections), `BOM.csv` (39 rows, target ~$35 at 1k), `pin-map.md`, `threat-model.md`.
- `firmware/` Zephyr skeleton (35 files): nRF52840 + SE050 (I2C) + e-ink (SPI3), Ledger-compatible APDU framing, MCUBoot bootloader plan, chain apps (evm / cosmos / btc).

### Test metrics
- SDK: **55 pass / 9 skipped (live) / 0 fail** across **9 chains** (EVM + TTL, BTC, XRP, Cosmos, Solana, TRON, TON, Aptos, Sui).

---

## [6474c9c] feat: parallel wave — SW shells x4 + P0/P1 adapters + design system — 2026-05-15

### Added
- `apps/web` — Vite + React. Wallet generate / recover / balance / transfer against live TTL RPC.
- `apps/extension` — **WXT** (MV3), EIP-1193 provider, popup.
- `apps/desktop` — **Tauri 2** + React, `src-tauri/` Rust scaffold (Rust toolchain not required at this stage).
- `apps/mobile` — **React Native 0.76 Bare** TypeScript, monorepo metro config.
- `packages/design-system` — `@byeorin/design-system`. tokens.css + Logo / Button / Card / Input / AddressDisplay / AmountDisplay.
- `BtcAdapter` — BIP-84 p2wpkh + Esplora, multi-input signing.
- `XrpAdapter` — xrpl v4, half-SHA-512, DER re-encoding.
- `CosmosAdapter` — cosmoshub-4 / osmosis-1 / etc., hand-rolled `TxRaw`.
- `SolanaAdapter` (P1) — Phantom path `m/44'/501'/i'/0'`.
- `TronAdapter` (P1) — tronweb v6 base58check.

### Test metrics
- SDK: **40 pass / 6 skipped (live) / 0 fail**.
- All builds pass: web / extension / desktop / design-system / wallet-sdk.

---

## [05f00a1] init: monorepo + @byeorin/wallet-sdk with EVM/TTL working — 2026-05-15

### Added
- pnpm + turbo monorepo bootstrap.
- `@byeorin/wallet-sdk` initial scaffold: `Wallet.fromMnemonic` → `Wallet.account(adapter)` → `Wallet.transfer(account, intent)` flow.
- `EvmAdapter` working against TTL (chain 7777) via viem.
- `SoftSigner` (secp256k1 / ed25519, 65-byte `r‖s‖recovery` blob for secp).
- BIP-39 (English wordlist) + BIP-32 + SLIP-0010.
- `TTL_CHAIN` + `EVM_CHAINS` (Ethereum / Polygon / BSC / Arbitrum / Optimism / Base / Avalanche).
