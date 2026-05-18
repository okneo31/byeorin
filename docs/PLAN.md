# 벼린 — 기획서 (v0.5, 2026-05-18)

> **브랜드: 벼린** (Byeorin) — 포지션 슬로건: **노동자의 지갑** (Worker's Wallet)
>
> 「벼린」 = 단조(벼리다, 무딘 날을 불에 두드려 날카롭게) + 핵심(벼리, 일의 핵심을 쥐다) 이중의미.
>
> 한 줄: **TTL 생태계의 공식 멀티체인 월릿 (SW 4종 + 자체 HW)** 을 만든다.
> 비유: "Ledger 디바이스 + MetaMask 확장 + Trust Wallet 모바일 + Keplr 멀티체인" 을 한 브랜드로.
>
> **HW 디바이스명: 벼린 요세 (Byeorin Yose)** — 요세=요새(要塞), 시드를 지키는 단단한 거점.

## 핵심 원칙 (v0.5)

1. **멀티체인 풀스펙트럼.** TTL + EVM 7종 + Cosmos 계열 + Bitcoin + XRP + Solana + TRON + TON + Aptos + Sui. 한 시드에서 체인별 키 파생, 한 UI에서 통합 잔액·전송.
2. **TTL 체인은 EVM 표준 어댑터로 처리.** TTL = geth 1.13.15 포크 = viem 그대로 호환. ChainID 7777 등록 + viem 기본 동작.
3. **순서: SW 먼저 → HW 직후.** 4종 SW 셸이 안정화되면 HW 착수.
4. **논커스토디얼.** 운영사는 시드/키 0개 보관.
5. **친노동 정체성.** 제품 결정 기준 — 수수료 투명성, 무수수료 옵션, 어려운 용어 한국어화, 단순한 UI.
6. **Signer-agnostic core.** SDK 는 SoftSigner / HwSigner / WCSigner 를 동일한 `Signer` 인터페이스 뒤에 둔다. 셸 코드는 어떤 신호기인지 알 필요가 없다.

---

## 0. Executive Snapshot

| 항목 | 현실치 |
|---|---|
| 총 인력 | 풀스택 12~22명 (보안 펌웨어 3, 임베디드 HW 2, 모바일 3, 웹/확장 3, 데스크톱 1, 디자인 2, 보안 감사 외주, PM 1, QA 2) |
| 총 기간 | **MVP α 완료(Q0) → 정식 v1 18개월 → HW 양산 24~30개월** |
| 예상 자본 | $5M~$20M (양산 라인·HW 인증·감사 비용 포함) |
| 결정적 의존 | (a) TTL 체인 커스텀 스펙 문서, (b) SE050 조달, (c) Apple/Google 심사 통과 |
| 죽일 조건 | TTL 채택이 12개월 내 X명 미달이면 HW 라인 보류 |

---

## 1. Spec Lock

| 결정 | 값 | 결정자 |
|---|---|---|
| 목적 | TTL 생태계 공식 월릿 (실제 출시) | User |
| HW 범위 | 풀커스텀 (SE + 자체 PCB + 자체 펌웨어 + 자체 케이스) | User |
| SW 폼팩터 | 모바일 + 데스크톱 + 브라우저 확장 + 웹 — **4종 동시** | User |
| 체인 | TTL(7777) + 외부 EVM 7종 + Cosmos 계열(Injective 포함) + BTC + XRP + SOL + TRON + TON + Aptos + Sui | User |
| 사인 보관 | 사용자 디바이스에만 (논커스토디얼) | 기획 표준 |
| 다국어 | 한/영 1차, 일/중 2차 | 잠정 |

### 1.1 코어 시드/키 표준

- 시드: BIP-39 (12/24 단어, 한국어/영어 워드리스트 모두 검증, 혼용 거부)
- 파생: BIP-32/44 (secp256k1), SLIP-0010 (Ed25519, RFC 8032 conformance 테스트 통과)
- SLIP-0044 coin_type 매핑은 §2.4 참조
- 패스프레이즈: 25번째 단어 옵션 (BIP-39 §8)
- Shamir(SLIP-0039): v2 (HW에서만)

### 1.2 TTL 체인 — EVM 표준으로 검증 완료

확인된 RPC 응답:
- `eth_chainId` = 0x1e61 (7777) · `web3_clientVersion` = ttlcoin/v1.13.15-stable · `eth_gasPrice` ≈ 1 Gwei

**원칙:** TTL은 ChainID 7777 등록만 하면 그대로 동작하는 EVM 체인이다. fork 커스텀 분석에 시간 쓰지 않는다. 표준 EVM이 깨지는 경우만 분기 추가.

---

## 2. 시스템 아키텍처 — 실제 구현체 (v0.4 기준)

> 원칙: **각 모듈은 좁은 인터페이스, 깊은 구현.** (Ousterhout)
>
> 자세한 다이어그램·표는 [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) 참조.

```
┌──────────────────────────────────────────────────────────────────┐
│                     UI Layer (4종 셸)                            │
│  apps/mobile (RN 0.76 Bare) | apps/desktop (Tauri 2)             │
│  apps/extension (WXT, MV3)  | apps/web (Vite + React)            │
└──────────────────────────────────────────────────────────────────┘
                          │   (uses @byeorin/shell-core)
┌──────────────────────────────────────────────────────────────────┐
│   @byeorin/shell-core                                             │
│   WalletStore + SessionStore(Web/Extension/Memory) + Keystore    │
└──────────────────────────────────────────────────────────────────┘
                          │   (uses @byeorin/wallet-sdk)
┌──────────────────────────────────────────────────────────────────┐
│   @byeorin/wallet-sdk                                             │
│   Wallet.fromMnemonic → Wallet.account(adapter) → transfer       │
│   ┌────────────────────────────────────────────────────────┐    │
│   │ ChainAdapter interface (signRequests[] / applySignatures[])│
│   └────────────────────────────────────────────────────────┘    │
│   9 adapters: EVM | BTC | XRP | Cosmos | Solana | TRON | TON |  │
│               Aptos | Sui                                        │
│   Signers: SoftSigner (in-memory). HwSigner / WCSigner 미구현    │
└──────────────────────────────────────────────────────────────────┘
                          │ (future) USB-HID / BLE GATT, Ledger-compat APDU
┌──────────────────────────────────────────────────────────────────┐
│   firmware/app  (Zephyr skeleton, nRF52840 + SE050 + e-ink)      │
│   Scaffold only — stubs return -ENOSYS. SPEC lock at HW SPEC.    │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 `@byeorin/wallet-sdk` — 실제 API 표면

**책임 (단일):** 한 시드로부터 9개 체인의 계정을 파생하고, intent → unsigned tx → 서명 → 브로드캐스트를 통일된 인터페이스로 노출한다.

**실제 외부 표면:**

```ts
// 1) 시드 → Wallet
const wallet = Wallet.fromMnemonic({
  mnemonic,                       // 한/영 워드리스트 자동 감지 (shell-core)
  passphrase,                     // BIP-39 §8 옵션
  wordlist: 'english' | 'korean'  // 기본 english
});

// 2) 체인 어댑터 + Wallet → 계정
const adapter = new EvmAdapter({ chain: TTL_CHAIN, rpcUrl });
const acc: WalletAccount = wallet.account(adapter, account, index);
// acc = { address, derivationPath, publicKey, signer, adapter }

// 3) 송금
const hash: TxHash = await wallet.transfer(acc, {
  to, amount, asset?, memo?, data?  // data 는 EVM 한정 calldata
});

// 4) 잔액 조회 (어댑터 직호출)
const bal: bigint = await adapter.getBalance(acc.address);

// 5) EIP-191 personal_sign 헬퍼
const sig = await signEvmMessage(acc.signer, acc.address, message);
```

체인별 어댑터는 named export (`EvmAdapter`, `BtcAdapter`, `XrpAdapter`, `CosmosAdapter`, `SolanaAdapter`, `TronAdapter`, `TonAdapter`, `AptosAdapter`, `SuiAdapter`). 모두 동일한 `ChainAdapter` 인터페이스 구현.

> **함정 점검:** v0.2 기획에서 `sdk.unlock` / `sdk.listAccounts` / `sdk.deriveAccount` / `sdk.buildTx` / `sdk.signTx` / `sdk.broadcast` 같은 평면 namespace 를 그렸지만, 실제 구현은 `Wallet` 인스턴스 메서드 + `ChainAdapter` 분리로 갔다. 이유: SignerRouter / dAppBridge / Keystore 책임이 SDK 외부(`shell-core`, 셸 코드)에 더 자연스럽게 들어간다. SDK 자체는 "키-→체인-→tx" 의 순수 데이터플로우만 책임진다.

### 2.2 `ChainAdapter` 인터페이스 (실제 구현)

```ts
export interface SignRequest {
  message: Uint8Array;  // 서명할 바이트
  prehashed: boolean;   // true = 32B digest, false = raw payload (Ed25519)
}

export interface ChainAdapter<TUnsigned = unknown, TSigned = unknown> {
  readonly id: string;            // "ttl", "ethereum", "cosmoshub", ...
  readonly displayName: string;
  readonly curve: 'secp256k1' | 'ed25519';
  readonly coinType: number;      // SLIP-0044

  derivationPath(account?: number, index?: number): string;
  pubkeyToAddress(pubkey: Uint8Array): string;

  getBalance(address: string): Promise<bigint>;
  buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<TUnsigned>;

  /** 1+ sign requests. 단일서명 체인은 1개, BTC 같은 UTXO 는 input 당 1개. */
  signRequests(tx: TUnsigned): Promise<SignRequest[]>;

  /** signatures.length === (await signRequests(tx)).length, 같은 순서. */
  applySignatures(tx: TUnsigned, signatures: Uint8Array[]): Promise<TSigned>;

  broadcast(tx: TSigned): Promise<TxHash>;
}
```

핵심 변경 (v0.2 → v0.4):
- 옛 `serializeForSign` / `applySignature` 의 단일-서명 가정 → `signRequests[]` / `applySignatures[]` 의 N-서명 모델.
- 이유: BTC 의 UTXO 다중-input 서명이 공개 API(`Wallet.transfer`) 에서 자연스럽게 동작해야 했고, HW signer 호환 (input 마다 사용자 확인) 도 같은 모델이 적합.
- `SignRequest.prehashed` 는 HW signer UX 힌트 (digest 인지 raw payload 인지). SoftSigner 는 무시.

### 2.3 SignerRouter — 미구현, 단일 SoftSigner 만 존재

현 시점 SDK 는 `SoftSigner` 한 가지만 가지고 있고, `WalletAccount.signer` 에 인스턴스가 직접 박혀 있다. HW/WC 신호기는 같은 `Signer { curve, publicKey, sign }` 인터페이스를 구현하면 그대로 갈아 끼울 수 있는 설계 — 단, 라우터 객체는 아직 없다 (Q3 도입).

### 2.4 채택된 9 어댑터 — P0/P1/P2 티어

| Tier | 어댑터 | 체인 | 커브 | coin_type | 주소 형식 | 라이브러리 |
|---|---|---|---|---|---|---|
| P0 | `EvmAdapter` | TTL(7777) + Ethereum/Polygon/BSC/Arbitrum/Optimism/Base/Avalanche | secp256k1 | 60 | 0x... 20B | viem |
| P0 | `BtcAdapter` | Bitcoin (BIP-84 p2wpkh) | secp256k1 | 0 | bech32 | @scure/btc-signer + Esplora |
| P0 | `XrpAdapter` | XRP Ledger | secp256k1 | 144 | base58 r... | xrpl v4 |
| P0 | `CosmosAdapter` | Cosmos Hub, Osmosis, Celestia, Sei, **Injective** (evmAddressing) | secp256k1 | 118 (Injective 60) | bech32 | @cosmjs/* |
| P1 | `SolanaAdapter` | Solana | Ed25519 | 501 | base58 | @solana/web3.js |
| P1 | `TronAdapter` | TRON | secp256k1 | 195 | base58check T... | tronweb v6 (r‖s‖v=recovery+27) |
| P2 | `TonAdapter` | TON | Ed25519 | 607 | EQ-bounceable | @ton/ton v15 |
| P2 | `AptosAdapter` | Aptos | Ed25519 | 637 | hex 32B (sha3-256 auth key) | @aptos-labs/ts-sdk v7 |
| P2 | `SuiAdapter` | Sui | Ed25519 | 784 | hex 32B (blake2b-256) | @mysten/sui v1 |

검증: 10/10 derivation 일치 (vs 각 체인의 공식 SDK). [`verification/addresses.txt`](../verification/addresses.txt) 참조.

> v0.2 기획의 12개 (Filecoin/BNB Beacon 등) 는 실제 출시에서 9개로 정리. P3 Filecoin 은 v2 백로그.

### 2.5 SignRequest 모델 + HW signer 스토리

**문제:** HW signer 는 디스플레이가 작고 SE 는 트랜잭션을 파싱하지 않는다. 따라서 펌웨어에는:
- 32-byte digest + curve identifier + BIP32 path 만 전달한다.
- "주소/금액/체인" 같은 휴먼-리더블 요약은 펌웨어가 **자체** 파서로 디스플레이용으로만 재구성한다 (서명 대상이 아님).

**`SignRequest.prehashed: boolean` 의 역할:**
- `true` → 호스트가 이미 32-byte digest 를 만들어 보냈다. SE 는 digest 를 그대로 ECDSA sign. (EVM, BTC, Cosmos 등 secp 체인의 일반적 흐름)
- `false` → 호스트가 raw payload 를 보냈다. SE 가 내부에서 hash 한다 (Ed25519 컨벤션 — 메시지 자체가 서명식의 일부).

**SoftSigner 입장:** `prehashed` 플래그를 무시하고 들어온 바이트를 그대로 서명한다 (`secp256k1` 은 32B digest 가정, `ed25519` 는 raw 메시지 가정).

**adapter 책임:** `applySignatures(tx, sigs)` 에서 chain-specific 인코딩 (예: EVM 의 v=27+recovery, XRPL 의 DER, TRON 의 r‖s‖(recovery+27)) 으로 정규화. HW 가 돌려준 raw recovery 와 SoftSigner 가 돌려준 raw recovery 가 동일 경로로 정규화되도록 적용된다.

---

## 3. Hardware Wallet — 벼린 요세

상세 사양·BOM·핀맵·위협모델: [`hardware/SPEC.md`](../hardware/SPEC.md), [`hardware/BOM.csv`](../hardware/BOM.csv), [`hardware/pin-map.md`](../hardware/pin-map.md), [`hardware/threat-model.md`](../hardware/threat-model.md).

요약:

| 부품 | 1차 채택 | 비고 |
|---|---|---|
| Secure Element | NXP SE050C2 (CC EAL 6+) | I2C, secp256k1/secp256r1/Ed25519, NDA 불필요 |
| MCU | Nordic nRF52840 | BLE 5 + USB-FS, ARM CryptoCell-310 |
| 디스플레이 | GoodDisplay GDEW0154M09 (1.54" e-ink) | SSD1681, 200×200 |
| 입력 | Alps SKRPACE010 × 2 (전면 OK/CANCEL) + C&K PTS526 (측면 power/recovery) | 기계식, 터치 IC 없음 |
| 전원 | EVE LP402025 200mAh LiPo + TI BQ25180 charger/monitor | UN38.3 / IEC 62133 인증 부품 |
| USB | GCT USB4105 mid-mount USB-C 2.0 + PRTR5V0U2X ESD | 5.1k CC pulldown only (no PD) |

**총 BOM 목표:** $35~$55 (1k 볼륨). 소매가 $129~$179.

**핵심 보안 규칙:**
1. 시드는 SE 내부에서만 생성·보관. MCU 평문 0.
2. 서명 전 항상 "주소·금액·가스·체인" e-ink 표시 + 물리 버튼 확인.
3. 펌웨어 업데이트는 PIN + 서명 + anti-rollback counter (SE 보관).
4. SE attestation cert 부팅 시 검증 — 보드 교체 공격 차단.
5. USB/BLE 입력은 명령 화이트리스트만 통과 (임의 코드 실행 경로 0).

인증: FCC + CE + KC + RoHS (PVT 단계). CC EAL5+ 디바이스 전체 인증은 v2.

### 3.5 Firmware skeleton

[`firmware/app/`](../firmware/app/) 에 Zephyr RTOS 기반 스캐폴드 35 파일:
- `src/transport/` — USB-HID + BLE GATT, Ledger-compat APDU 프레이밍
- `src/se/` — SE050 wrapper (anti-rollback counter get/increment 포함)
- `src/keys/` — 키 파생 (전부 SE 위임)
- `src/ui/` — display + button + confirm dialog
- `src/apps/` — chain-app display layers (EVM / Cosmos / BTC) — 트랜잭션 파싱은 디스플레이용만, 서명 대상은 32-byte digest
- `src/bootloader/` — MCUBoot 통합 노트

상태: 컴파일은 통과, 하드웨어-터치 함수는 모두 `-ENOSYS` stub. 다음 마일스톤은 EVT-1 보드에서 SE I2C bring-up + e-ink draw.

`prj.conf` 는 production 프리셋 (CONSOLE/SERIAL/PRINTK/ASSERT/DEBUG=n, BLE_SIGNING=n, CONFIRM_TIMEOUT=60s). 개발용 디버그 트래픽이 양산에 새지 않도록 기본값을 잠가 두었다.

---

## 4. 4종 SW 셸 (실제 채택 기술)

| 셸 | 기술 | 현재 상태 | 다음 목표 |
|---|---|---|---|
| **Web** | Vite + React + `@byeorin/design-system` | 지갑 생성/복구/잔액/송금 (live TTL RPC) 동작 | dApp 연결 데모 |
| **Browser Extension** | **WXT** (MV3), React, `@byeorin/design-system` | EIP-1193 provider 주입, per-origin consent flow, `personal_sign` + `eth_sendTransaction` confirm 팝업 (128-bit nonce binding) | 다중 계정 UI |
| **Desktop** | **Tauri 2** + React (src-tauri scaffold) | 큰-화면 portfolio + multi-account skeleton, triple-state balance UI | USB-HID HW 연결 |
| **Mobile** | **React Native 0.76 Bare** TS, monorepo metro config | 3 스크린 (Home/Account/Send) + DS primitives + 한글 폰트 스택 | 생체인증 + WalletConnect |
| **HW** | 자체 펌웨어 (Zephyr) | 스캐폴드만 | EVT-1 보드 |

**v0.2 → v0.4 변경 사항:**
- Expo Managed 거부 확정 → **RN 0.76 Bare** (네이티브 모듈 자유도 확보).
- 확장은 raw MV3 가 아니라 **WXT** 사용 (HMR, MV2/3 추상화, 빌드 표준화).
- Desktop 은 Electron 거부 확정 → **Tauri 2** (Rust 코어 공유 가능성 + 10MB 번들).

> 4종을 동시에 짓는 게 아니라, **SDK + shell-core 가 먼저 굳고 셸은 한 달 간격으로 누적.** 실제 SDK API 변경 (signRequests[] 도입) 한 번에 4 셸 모두 재배선 비용이 명확히 측정됨 — 코어를 흔들 때마다 비용 4× 라는 점이 wave 2 에서 검증됨.

---

## 5. 의존성 검토

새 의존성마다 3가지 질문 (필요한가 / 신뢰 가능한가 / 버려질 수 있는가).

### 채택 (이유)

| 의존성 | 이유 | 우리쪽 추상화 |
|---|---|---|
| `viem` | EVM JSON-RPC + ABI + EIP-1559 | `EvmAdapter` 내부 |
| `@cosmjs/*` | Cosmos SDK 호환 사실상 표준 | `CosmosAdapter` 내부 |
| `@noble/curves`, `@noble/hashes` | 감사된 순수 TS 암호 (의존성 zero) | `crypto/`, `keystore.ts` |
| `@scure/btc-signer`, `@scure/bip32`, `@scure/bip39` | Paul Miller 라인, 노블 생태계 정합 | `crypto/`, `BtcAdapter` |
| `xrpl` v4 | XRPL 공식 JS | `XrpAdapter` |
| `tronweb` v6 | Tron 공식 JS (단 EVM-style v 정규화는 우리 측에서) | `TronAdapter` |
| `@solana/web3.js`, `@ton/ton`, `@aptos-labs/ts-sdk`, `@mysten/sui` | 각 체인 공식 SDK | 각 어댑터 |
| `Tauri 2` | Electron 100MB+ vs Tauri 10MB | Desktop 셸 한정 |
| `WXT` | MV3 빌드 추상화, HMR | Extension 셸 한정 |
| `Zephyr RTOS` | Nordic/NXP 1차 지원 RTOS | 펌웨어 한정 |

### 거부 (이유 명시)

| 의존성 | 거부 이유 |
|---|---|
| `web3.js` v4 | viem 이 더 가볍고 타입 안전 |
| `walletcore` (Trust) | Rust+C++ 결합 빌드 복잡, 자체 정체성 약화 |
| Expo Managed | 네이티브 모듈 다수 → Bare Workflow |
| Electron | 메모리/디스크/보안 표면 |
| Firebase | 비커스토디얼 원칙과 데이터 흐름 충돌 |

### 공급망 가드 (wave 5 추가)

- `pnpm.overrides` 루트에 `protobufjs ^7.5.8`, `axios ^1.15.2`, `fast-xml-parser ^5.7.0` 강제.
- `.gitignore` env/secrets/keys/keystores/mobileprovisions 패턴 추가.
- `.github/workflows/ci.yml` — typecheck + test + build + `pnpm audit` gate.
- 결과: `pnpm audit` 24 advisories → 1 low (Critical 1→0, High 8→0, Moderate 13→0).

---

## 6. 단계별 로드맵 (v0.4 리베이스라인)

> 마일스톤은 "기능" 이 아니라 **"확신 가능한 단언"** 단위로 끊는다.

### Q0 (완료 — 본 작업의 8 커밋)

| 단언 | 산출물 |
|---|---|
| "한 시드로 9개 체인 주소를 파생할 수 있고, 각 SDK 와 byte-for-byte 일치한다" | `@byeorin/wallet-sdk` α — 9 adapters, 10/10 verification pass |
| "4종 SW 셸이 모두 빌드되고 같은 SDK 를 공유한다" | apps/{web,extension,desktop,mobile} skeleton, `@byeorin/design-system` 토큰+컴포넌트 |
| "셸별 wallet-store 중복이 제거되어 있다" | `@byeorin/shell-core` (WalletStore + SessionStore + Keystore) |
| "HW 사양과 펌웨어 스캐폴드가 외부 벤더 리뷰 가능 수준이다" | `hardware/SPEC.md`, `firmware/app/` 35 파일 |
| "보험 설계가 한 명이 들고 결정 가능한 상태다" | `docs/INSURANCE.md` v2 standalone (849줄) |
| "2차 보안 스윕에서 Critical/High 0 으로 떨어진다" | wave 5 — SDK 83 pass, shell-core 37 pass, audit 1 low |

### Q1 (M0~3) — TTL claim & dApp baseline

- "TTL 1건 송금" 을 web 셸에서 외부 사용자가 수행 가능
- Extension EIP-1193 + WalletConnect v2 (Reown) 1개 외부 dApp 데모

### Q2 (M4~6) — Multi-account & history

- Desktop β — 다중계정, 가격 피드, 100건 portfolio
- 모든 셸에 keystore 영구 보관 + scrypt(N=2^17) unlock 적용

### Q3 (M7~9) — Mobile β + SignerRouter

- Mobile β (생체인증, WalletConnect, App Store 심사)
- `SignerRouter` 도입 — SoftSigner / HwSigner / WCSigner 동일 인터페이스
- HwSigner skeleton (@ledgerhq/hw-transport-webhid 어댑터)

### Q4 (M10~12) — HW EVT-1

- EVT-1 10대 — USB enumeration + SE I2C bring-up + e-ink draw
- Desktop ↔ EVT-1 으로 TTL 1건 서명 데모

### Q5 (M13~15) — HW EVT-2 + BLE

- EVT-2 25대 — BLE 라디오, 배터리, full APDU round-trip
- BTC + TTL EVM end-to-end sign from `apps/desktop`

### Q6 (M16~18) — HW DVT + 보안 감사

- DVT 200대 — final mechanicals, ESD ±8kV, external red team
- SDK + 펌웨어 외부 감사 1회 (zero Critical 통과 조건)

### Q7 (M19~21) — HW PVT + 인증

- PVT 1000대, FCC + CE + KC + RoHS
- USB-IF VID 발급

### Q8 (M22~24) — v1 GA

- 4종 SW + HW 동시 GA, 마케팅, 양산 5k+

### Kill Switch

- Q1 종료까지 외부 dApp 연동 0건이면 **dApp 전략 재검토**
- Q3 종료까지 SW 활성 사용자 X명 미달이면 **HW 양산 보류**, EVT까지만
- 보안 감사에서 Critical 1+ 발견 시 해당 단계 통과 보류
- pnpm audit 에서 High 1+ 발견되면 다음 머지 금지 (CI gate)

---

## 7. 위협 모델 (요약)

| 공격 벡터 | 완화 |
|---|---|
| 시드 탈취 (악성 SW) | Keystore = scrypt N=2^17 (≈256MB, KEYSTORE_PARAMS_DEFAULT) + AES-256-GCM (12B nonce). 매 write 마다 new salt+nonce. HW 에선 시드가 SE 외부 X |
| Wallet locked 우회 | WalletStore.lock() 즉시 getAccount/transfer 거부. broadcast 진행 중인 tx 는 committed work 로 보고 취소 X — 단 lock 이후 새 서명 0 보장 |
| Race conditions (double-click) | concurrent unlock() 동일 니모닉 idempotent, 다른 니모닉 throw |
| 클립보드 스왑 멀웨어 | 서명 직전 주소 화면 표시 + 일부 강조 |
| 피싱 dApp | per-origin consent + 알려진 컨트랙트 DB + WalletGuard 식 시뮬레이션 (v0.3 예정) |
| Direct-URL hijack of confirm popup | 128-bit nonce binding popup ↔ background, sender.id === chrome.runtime.id, onSuspend 시 pending 거부 |
| EIP-6963 통한 account leak | announce 시 account 미포함 (doc-clarified) |
| 공급망 (deps) | pnpm.overrides + audit gate, .gitignore 하드닝 |
| 공급망 (HW) | 변조방지 씰, SE attestation 부팅 검증, APPROTECT factory lock |
| 측면 채널 | SE 자체 보호, MCU 상수시간 가드 (전기 후처리 점검) |
| 분실/도난 | PIN 8회 오답 = SE 시드 wipe, 패스프레이즈 25th word, Shamir(v2) |
| 정부 명령/계정 동결 | 논커스토디얼 — 운영사 보관 키 0개. 동결 불가 = 책임도 X |

상세 펌웨어 측면 위협모델: [`hardware/threat-model.md`](../hardware/threat-model.md).

---

## 8. 운영/조직 — 빠뜨리기 쉬운 비용

- **노드 운영:** 자체 RPC 풀 (geth 노드 N대) — 외부 RPC 의존 시 검열 위험. 월 $2k~$8k.
- **고객지원:** HW 분실/PIN 잠김 문의 폭증 대비. KB·자동화·인력.
- **법무:** 한국 가상자산이용자보호법, EU MiCA, 미국 OFAC. 비커스토디얼이라도 마케팅·앱스토어 요건 있음.
- **앱스토어 정책:** Apple 은 비커스토디얼에 비교적 우호적이지만 NFT/스왑 인앱결제 강제 케이스 주의.
- **보험 트랙 의사결정 비용:** [`docs/INSURANCE.md`](./INSURANCE.md) 의 5개 kill criteria 참조.

---

## 9. 즉시 다음 행동 (v0.5 — Q1 진입)

**SW (Q1)**
1. Web 셸의 TTL claim 페이지를 외부 사용자 테스트로 (피드백 루프)
2. Extension EIP-1193 의 외부 dApp 1개 연동 (WalletConnect v2 Reown)
3. Cross-shell 영구 keystore 마이그레이션 (web in-memory → opt-in localStorage)
4. SignerRouter 인터페이스 정의 (실제 HwSigner 는 Q4 도입)

**HW (Q4 이후 진입을 위한 사전 작업)**
- SE050 vs ST31N600 최종 결정 (lead time 견적, [`hardware/SPEC.md`](../hardware/SPEC.md) §11 Open Questions 11번)
- KiCad EVT-1 schematic 캡쳐 시작 (`hardware/kicad/`)
- USB-IF VID 신청 진행

---

## 9.5 보험 (Insurance)

상세 설계 — [`docs/INSURANCE.md`](./INSURANCE.md) (v2 standalone, 849줄, 추천안·5개 kill 조건·법무 우선 로드맵·벼린 정체성 정렬 점검 포함).

요약: SW 손실은 외부 커버 프로토콜(Nexus / InsurAce / Sherlock) **디스트리뷰션 헬퍼** 트랙, HW 분실/파손은 **전통 보험사(KB / 삼성화재 / 한화) 제휴** 트랙, 자체 풀(Self-pool DAO) 은 v3 백로그로 영구 보류. 결정 시점은 SW v1 GA + 12개월 실데이터.

## 9.6 Encrypted keystore

[`packages/shell-core/src/keystore.ts`](../packages/shell-core/src/keystore.ts).

- KDF: scrypt (RFC 7914). `KEYSTORE_PARAMS_DEFAULT` = N=2^17, r=8, p=1 (≈256MB working set, 데스크톱/확장 1~2초 unlock). `KEYSTORE_PARAMS_FAST` = N=2^16 (BIP-38 동등, 모바일).
- AEAD: AES-256-GCM via WebCrypto subtle, 12-byte random nonce, 16-byte tag.
- 매 write 새 salt(16B) + 새 nonce(12B). 동일 평문/passphrase 라도 ciphertext 가 매번 다름 (확률적 암호화).
- `autoRestoreAllowed=false` — 부팅 시 자동 복원 금지. 사용자가 명시적으로 passphrase 입력해야 read() 동작.
- Timing oracle 차단: 잘못된 passphrase 거부 시점도 scrypt + AES-GCM verify 가 동일하게 수행되어 wallclock 시간 동일.
- 백엔드: `LocalStorageBackend` (web), `ChromeLocalBackend` (extension `chrome.storage.local`).
- 14 tests pass (wave 4) → wave 5 에서 추가 hardening 검증.

---

## 10. 결정해주실 미정 사항

### 닫힌 결정 (v0.5)
- ~~디바이스 명칭~~ → **벼린 요세 (Byeorin Yose)** 확정 (2026-05-18). 음역 일관성 유지. 의미: 요새(要塞)=시드를 지키는 거점.
- ~~브랜드 시각 자산~~ → **확정** (`logo0.{png,svg,_dark.png}`, lockup 가로/세로, 워드마크 한/영, `icons/dist/` 64 파일 전 플랫폼 일괄). 컬러 팔레트 = 잉걸 오렌지/모루 차콜/강철 실버/땀 블루/종이 화이트/밤 모루.

### 열린 결정
- TTL coin_type 을 SLIP-0044 에 신청할 것인가? (현재 60 공유 중)
- HW 1차 시판 국가 (한국 단독? 한+미+EU?)
- 시드 백업 — 종이 + Shamir + (선택) 운영사 클라우드 보조? 클라우드 보조는 비커스토디얼 원칙과 미세 충돌
- 라이선스 — 코어 SDK MIT/Apache-2.0, 펌웨어 GPL-3.0/비공개?

---

## 부록 A — 확인된 TTL 체인 정보

```
eth_chainId         → 0x1e61 (7777)
web3_clientVersion  → ttlcoin/v1.13.15-stable-c5ba367e/linux-amd64/go1.22.12
eth_blockNumber     → ~500,000
eth_gasPrice        → ~1 Gwei
net_version         → 7777
```

go-ethereum 1.13.15 베이스 fork → viem 그대로 사용 가능. 커스텀 precompile·opcode 여부는 코어 팀 확인 필요 (Q1 액션).

## 부록 B — Cross-document index

| 문서 | 역할 |
|---|---|
| [`docs/PLAN.md`](./PLAN.md) | 본 문서. 제품·아키텍처·로드맵의 단일 진실원 |
| [`docs/ARCHITECTURE.md`](./ARCHITECTURE.md) | 시스템 다이어그램 + 모듈 책임 표 + 위협 경계 + 키 invariant |
| [`docs/CHANGELOG.md`](./CHANGELOG.md) | 커밋 단위 변경 기록 (keep-a-changelog) |
| [`docs/INSURANCE.md`](./INSURANCE.md) | 보험 시스템 v2 standalone 설계 |
| [`hardware/SPEC.md`](../hardware/SPEC.md) | HW 사양 v0 (외부 벤더 리뷰용) |
| [`hardware/BOM.csv`](../hardware/BOM.csv), [`pin-map.md`](../hardware/pin-map.md), [`threat-model.md`](../hardware/threat-model.md) | 부속 |
| [`firmware/README.md`](../firmware/README.md) | 펌웨어 빌드/레이아웃 |
| [`verification/addresses.txt`](../verification/addresses.txt) | 10/10 cross-SDK 주소 검증 표 |
