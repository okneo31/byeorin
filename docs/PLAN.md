# 노동자의 지갑 — 기획서 (v0.2, 2026-05-15)

> **브랜드: 노동자의 지갑** (Nodong / Worker's Wallet)
>
> 한 줄: **TTL 생태계의 공식 멀티체인 월릿(SW 4종 + 자체 HW)** 을 만든다.
> 비유: "Ledger 디바이스 + MetaMask 확장 + Trust Wallet 모바일 + Keplr 멀티체인" 을 한 브랜드로.

## 핵심 원칙 (v0.3)

1. **멀티체인 풀스펙트럼.** TTL + EVM 다체인 + Cosmos 계열 + Bitcoin + XRP/Ripple + (가능하면) Solana/TRON 등 기존 주요 메인넷 모두. 한 시드에서 체인별 키 파생, 한 UI에서 통합 잔액·전송. Keplr·MetaMask·Phantom·Xaman을 갈아치우는 게 목표.
2. **TTL 체인은 EVM 표준 어댑터로 처리.** TTL은 geth 1.13.15 포크 = MetaMask·viem·ethers 그대로 호환. **TTL fork 커스텀 분석에만** 시간을 쓰지 않는다 — ChainID 7777 자동 등록 + viem 기본 동작. (※ 멀티체인 지원 자체를 줄인다는 뜻이 아님.)
3. **순서: SW 먼저 → HW 직후.** 4종 SW 셸이 안정화되면 HW 착수. SW 안정 없이 HW 양산은 자살.
4. **논커스토디얼.** 운영사는 시드/키 0개 보관.
5. **친노동 정체성.** "노동자의 지갑"이라는 이름은 제품 결정 기준 — 수수료 투명성, 무수수료 옵션, 어려운 용어 한국어화, 단순한 UI.

---

## 0. Executive Snapshot

| 항목 | 현실치 |
|---|---|
| 총 인력 | 풀스택 12 ~ 22명 (보안 펌웨어 3, 임베디드 HW 2, 모바일 3, 웹/확장 3, 데스크톱 1, 디자인 2, 보안 감사 외주, PM 1, QA 2) |
| 총 기간 | **MVP 7개월 → 정식 v1 18개월 → HW 양산 24~30개월** |
| 예상 자본 | $5M ~ $20M (양산 라인·HW 인증·감사 비용 포함) |
| 결정적 의존 | (a) TTL 체인 커스텀 스펙 문서, (b) Secure Element 칩 조달, (c) Apple/Google 심사 통과 |
| 죽일 조건 | TTL 체인 자체 채택이 12개월 내 X명 미달이면 HW 라인 보류 |

> **이건 단순 개발이 아니라 회사다.** "월릿 한 개 만들기"가 아니라 "월릿 회사 차리기"에 가까움을 명확히 한다.

---

## 1. Spec Lock (Grill Me 결과 반영)

| 결정 | 값 | 결정자 |
|---|---|---|
| 목적 | TTL 생태계 공식 월릿 (실제 출시) | User |
| HW 범위 | 풀커스텀 (Secure Element + 자체 PCB + 자체 펌웨어 + 자체 케이스) | User |
| SW 폼팩터 | 모바일(iOS/Android) + 데스크톱 + 브라우저 확장 + 웹(claim/송수신) — **4종 동시** | User |
| 체인 | TTL(EVM 커스텀, geth 1.13.15 포크, ChainID 7777) + 외부 EVM 다체인 + Cosmos SDK 계열 + 기존 체인(BTC/SOL 등) | User |
| 사인 자체 보관 | 사용자 디바이스에만 (논커스토디얼). 운영사는 시드/키 절대 비보관 | 기획 표준 |
| 다국어 | 한/영 1차, 일/중 2차 | 잠정 |

### 1.1 코어 시드/키 표준
- 시드: BIP-39 (12/24 단어, 한국어 워드리스트 포함)
- 파생: BIP-32/44, SLIP-0010(Ed25519 계열)
- SLIP-0044 coin_type:
  - 0 — Bitcoin (BTC)
  - 60 — EVM 다체인 / TTL (chainId로 구분)
  - 118 — Cosmos 계열 (ATOM, OSMO, CELESTIA, ...)
  - 144 — XRP/Ripple
  - 195 — TRON
  - 501 — Solana
  - 461 — Filecoin (선택)
  - 714 — Binance Beacon Chain (선택)
- TTL 자체 coin_type SLIP-0044 신청 검토 (선택, 60 그대로 써도 무방)
- 패스프레이즈: 25번째 단어 옵션 (Trezor 호환)
- Shamir Secret Sharing(SLIP-0039): v2에서 검토 (HW에서만)

### 1.2 TTL 체인 어댑터 — EVM 표준으로 충분

확인된 RPC 응답:
- `eth_chainId` = 0x1e61 (7777) · `web3_clientVersion` = geth 1.13.15 포크 · `eth_gasPrice` ≈ 1 Gwei

**원칙:** TTL은 MetaMask에 7777만 등록하면 그대로 동작하는 EVM 체인이다. **fork 커스텀 분석에 시간 쓰지 않는다.** 표준 EVM이 깨지는 경우만 그때 가서 어댑터에 분기 추가.

**최소 액션:** TTL 코어 팀에 `eth_feeHistory` 지원(EIP-1559) 여부만 한 줄 확인. 나머지는 viem 기본값으로 진행.

---

## 2. 시스템 아키텍처 — Deep Module 설계

> 원칙: **각 모듈은 좁은 인터페이스, 깊은 구현.** 외부에 노출되는 API 수는 최소화. (Ousterhout)

```
┌──────────────────────────────────────────────────────────────────┐
│                     UI Layer (4종 셸)                            │
│  Mobile (RN)  |  Desktop (Tauri)  |  Extension (MV3)  |  Web    │
└──────────────────────────────────────────────────────────────────┘
                          │   (단일 SDK API)
┌──────────────────────────────────────────────────────────────────┐
│              @ttl/wallet-sdk  (TypeScript, 단일 진실원)          │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ AccountManager  · TxBuilder  · SignerRouter  · dAppBridge│  │
│  └──────────────────────────────────────────────────────────┘  │
│                          │ ChainAdapter interface              │
│  ┌────────────┬────────────┬────────────┬────────────┐         │
│  │ TtlAdapter │ EvmAdapter │CosmosAdptr │ BtcAdapter │ ...     │
│  └────────────┴────────────┴────────────┴────────────┘         │
│                          │ SignerRouter                         │
│  ┌────────────┬────────────┬────────────┐                       │
│  │ SoftSigner │ HwSigner   │ WCSigner   │                       │
│  │ (Keystore) │ (USB/BLE)  │(WalletConn)│                       │
│  └────────────┴────────────┴────────────┘                       │
└──────────────────────────────────────────────────────────────────┘
                          │ HID/BLE transport
┌──────────────────────────────────────────────────────────────────┐
│              TTL Hardware Wallet (자체 디바이스)                 │
│   MCU(NRF52840) + SE(SE050 또는 ST31N600) + e-ink + USB-C       │
│   자체 펌웨어: 시크부트 → 코어 OS → 체인별 앱 (sandboxed)         │
└──────────────────────────────────────────────────────────────────┘
```

### 2.1 `@ttl/wallet-sdk` (코어, 모든 셸이 동일하게 import)

**책임 (단일):** "주소·잔액·트랜잭션·서명"이라는 4가지 의미적 명령을 체인 종류와 무관하게 제공한다.

**좁은 외부 API (10개 이하):**
```ts
sdk.unlock(passphrase)              // Keystore 복호화
sdk.listAccounts()
sdk.deriveAccount(chain, index)
sdk.getBalance(account)
sdk.getHistory(account, cursor)
sdk.buildTx(account, intent)        // intent = {to, amount, memo, ...}
sdk.signTx(account, tx)             // 내부에서 SignerRouter 호출
sdk.broadcast(signedTx)
sdk.connectDApp(uri)                // WalletConnect/EIP-1193 게이트
sdk.events.on(...)                  // 상태 구독
```

**깊은 내부:** 체인 어댑터 12종, 시드 암호화, 키 파생, EIP-712/Sign-typed, 메모리 잠금, 사이드채널 방어, RPC 페일오버, Mempool 모니터, 가스 추정.

> **함정 점검:** "다체인이라 일반화해야지" → 일반화는 추상화가 아니라 **공통 의미의 발견**이다. 12체인의 송금이 공통이라면 `signTx`는 깊을 권리가 있다. 다르면 강제 일반화 금지.

### 2.2 ChainAdapter 인터페이스 (좁다)

```ts
interface ChainAdapter {
  id: string;                                  // "ttl", "ethereum", "cosmoshub"
  curve: 'secp256k1' | 'ed25519';
  derivationPath(index: number): string;
  encodeAddress(pubkey: Uint8Array): string;
  buildTx(intent: TxIntent, ctx: ChainContext): UnsignedTx;
  serializeForSign(tx: UnsignedTx): Uint8Array; // HW가 서명할 raw bytes
  applySignature(tx: UnsignedTx, sig: Signature): SignedTx;
  broadcast(tx: SignedTx): Promise<TxHash>;
  watchTx(hash: TxHash): AsyncIterable<TxStatus>;
}
```

체인별 어댑터 우선순위:

| 우선순위 | 어댑터 | 체인 | 커브 | 주소 형식 | 라이브러리 후보 | 출시 |
|---|---|---|---|---|---|---|
| P0 | **EvmAdapter** | TTL(7777), Ethereum, Polygon, BSC, Arbitrum, Optimism, Base, Avalanche | secp256k1 | 0x... 20B | viem | 베타 1차 |
| P0 | **BtcAdapter** | Bitcoin | secp256k1 | bech32(SegWit) + legacy | `@scure/btc-signer` + bitcoinjs-lib | 베타 1차 |
| P0 | **XrpAdapter** | XRP Ledger | secp256k1 / Ed25519 | base58 r... | xrpl.js | 베타 1차 |
| P0 | **CosmosAdapter** | Cosmos Hub, Osmosis, Celestia, Sei, Injective | secp256k1 | bech32(cosmos1..., osmo1...) | @cosmjs/* | 베타 1차 |
| P1 | **SolanaAdapter** | Solana | Ed25519 | base58 | @solana/web3.js | 베타 2차 |
| P1 | **TronAdapter** | TRON | secp256k1 | base58 T... | TronWeb | 베타 2차 |
| P2 | **TonAdapter** | TON | Ed25519 | bounceable | @ton/ton | v1 후 |
| P2 | **AptosAdapter / SuiAdapter** | Aptos/Sui | Ed25519 | hex 32B | aptos-labs/ts-sdk, @mysten/sui | v1 후 |
| P3 | **FilecoinAdapter** | Filecoin | secp256k1/BLS | f1.../f3... | @glif/filecoin-* | v2 |

P0 4종은 "노동자의 지갑" 출시 베이스라인. P1까지가 1년차 목표. P2~P3는 시장 수요 보면서.

> **함정 점검:** "한 어댑터로 다 처리하자" 유혹 거부 — UTXO(BTC)·Account(EVM)·Cosmos SDK 메시지·XRPL은 의미적으로 다른 모델. 강제 일반화는 Shallow Module을 낳는다. `ChainAdapter` 인터페이스만 좁게, 구현은 각자 깊게.

### 2.3 SignerRouter — "어떤 키로 사인할지"만 안다

소프트키 vs 하드웨어를 호출자가 몰라야 함. UI는 `signTx(account, tx)`만 부르고, 라우터가 계정의 등록 형태에 따라 자동 분기.

### 2.4 dAppBridge — EIP-1193, WalletConnect v2, Cosmos Kit

- 브라우저 확장: `window.ethereum`, `window.ttl`(자체), `window.keplr`(호환 모드) 주입
- 모바일/데스크톱: WalletConnect v2 (Reown) 페어링
- TTL 자체 dApp 표준 정의 가능 (Cosmos+EVM 동시 노출 케이스)

---

## 3. Hardware Wallet — TTL Cold

### 3.1 컴포넌트 결정 트리

| 부품 | 1차 후보 | 대안 | 이유 |
|---|---|---|---|
| Secure Element | **NXP SE050** (CC EAL 6+) | ST31N600 (Ledger 사용), Microchip ATECC608B | SE050은 NDA 없이 데이터시트 공개·AppNote 풍부 |
| MCU | **Nordic nRF52840** | STM32L562 (보안코어) | BLE5+USB+넉넉한 Flash. STM32는 BLE 별도 필요 |
| 디스플레이 | 1.54" e-ink (200x200) | OLED 0.96" | 잔상으로 시드/주소 노출 줄임. 전력 ↓ |
| 입력 | 정전식 터치 2버튼 + 휠 | 풀 터치 / 5버튼 | UX와 비용 균형 |
| 전원 | USB-C + 200mAh LiPo | USB-only | BLE 사용 시 배터리 필요 |
| 케이스 | 알루미늄 CNC + 폴리카보 | 풀폴리 | 분해방지·고급감 |

**총 BOM 목표:** $35 ~ $55 (소매가 $129 ~ $179 목표)

### 3.2 펌웨어 아키텍처

```
┌───────────────────────────────┐
│ Secure Bootloader (ROM 잠금)  │ ← 사인된 펌웨어만 부팅
├───────────────────────────────┤
│ Core OS (Zephyr RTOS 기반)    │
│  · Display driver             │
│  · Input driver               │
│  · USB/BLE transport          │
│  · APDU 라우터                │
│  · SE 게이트(키는 SE 안에만)   │
├───────────────────────────────┤
│ App Sandbox (1앱 = 1체인)     │
│  TTL App | EVM App | Cosmos…  │
│  메모리/플래시 segregated      │
└───────────────────────────────┘
```

**핵심 보안 규칙:**
1. 시드는 SE 내부에서만 생성·보관. MCU에는 평문으로 절대 나오지 않음.
2. 서명 트랜잭션은 화면에 항상 "주소, 금액, 가스, 체인" 표시 후 사용자 물리 버튼 확인.
3. 펌웨어 업데이트는 PIN 입력 + 서명 확인 후만 허용. 다운그레이드 금지.
4. 측면 채널: 전력/타이밍 공격은 SE가 흡수. MCU 측 분기는 상수시간.
5. USB/BLE에서 들어오는 데이터는 **명령 화이트리스트**만 통과. 임의 코드 실행 경로 0.

### 3.3 인증 로드맵

| 단계 | 인증 | 시점 | 비용 |
|---|---|---|---|
| 시판 최소 | FCC + CE + KC + RoHS | 양산 직전 | $25k~ |
| 신뢰성 | SE 자체 인증 활용(EAL6+) | SE 채택만으로 일부 확보 | 포함 |
| 권장 | Common Criteria EAL5+ (디바이스 전체) | v2 | $300k~$1M |
| 선택 | SOC2 (백엔드 운영) | 가능 시 | $50k~ |

### 3.4 컴패니언 통신

- USB-HID (Ledger 호환 가능한 APDU 프레이밍 채택 권장 — 생태계 라이브러리 재사용)
- WebUSB / WebHID (Chromium 계열 확장에서 직접 연결)
- BLE GATT (모바일용, AES-CCM 채널 암호화 + 디바이스 페어링 PIN)

---

## 4. 4종 SW 셸

| 셸 | 기술 | 1차 범위 | 출시 |
|---|---|---|---|
| **Web** | Vite + React, viem/cosmjs | 시드 없이 주소만으로 잔액·트랜잭션 조회, claim, 입금 QR. 키 저장 X | T+3개월 |
| **Browser Extension** | MV3, React, Tauri 빌더 | EIP-1193 주입, 다중 계정, dApp 승인 UI | T+5개월 |
| **Desktop** | Tauri (Rust 코어) | HW 월릿 USB 연결, 큰 화면 포트폴리오, 다중 체인 송수신 | T+7개월 |
| **Mobile** | React Native (Expo는 비추 — 네이티브 모듈 많음) | 생체인증, 푸시, QR, WalletConnect | T+9개월 |
| **HW** | 자체 펌웨어 | TTL+EVM 1차, Cosmos 2차 | T+18~24개월 |

> 4종을 동시에 짓는 게 아니라, **SDK가 먼저 굳고 셸은 한 달 간격으로 누적.** 코어가 흔들리면 4번 재작업.

---

## 5. 의존성 검토 (Software Fundamentals — Dependency Check)

새 의존성마다 3가지 질문:
1. **꼭 필요한가** — 직접 짜면 얼마나 걸리나?
2. **유지보수자가 신뢰 가능한가** — 라이선스, 활성도, 보안 사고 이력?
3. **버려질 수 있는가** — 우리가 인터페이스 뒤에 숨겼는가?

### 채택 결정 (긍정)

| 의존성 | 이유 | 우리쪽 추상화 |
|---|---|---|
| `viem` (또는 ethers v6) | EVM JSON-RPC, ABI 인코딩 직접 짜면 6개월 손실 | `EvmAdapter` 내부에만 |
| `@cosmjs/*` | Cosmos SDK 호환의 사실상 표준 | `CosmosAdapter` 내부에만 |
| `@noble/curves`, `@noble/hashes` | 감사된 순수 TS 암호 (의존성 zero) | `crypto/` 모듈 |
| `Tauri` | Electron 100MB+ vs Tauri 10MB, Rust 코어 공유 가능 | Desktop 셸 한정 |
| `Zephyr RTOS` | 펌웨어 RTOS 사실상 표준, Nordic·NXP 모두 1차 지원 | 펌웨어 한정 |

### 거부 (이유 명시)

| 의존성 | 거부 이유 |
|---|---|
| `web3.js` v4 | viem이 더 가볍고 타입 안전. 마이그레이션 가치 X |
| `walletcore` (Trust Wallet 코어) | 매력적이지만 Rust+C++ 결합으로 모바일 빌드 복잡. 자체 SDK 정체성 약해짐 |
| Expo Managed | 네이티브 모듈(HW 통신, 보안 키스토어) 많아 Bare Workflow가 깔끔 |
| Electron | 메모리/디스크. 보안 표면도 큼 |
| Firebase | 익명성·논커스토디얼 원칙과 충돌하는 데이터 흐름 위험. 푸시는 FCM/APNs 직접 |

---

## 6. 단계별 로드맵 (Honest)

> 마일스톤은 "기능"이 아니라 **"확신 가능한 단언"** 단위로 끊는다.

| Quarter | 목표 단언 | 산출물 |
|---|---|---|
| Q1 (M0~3) | "TTL 체인을 SDK 한 줄로 송금할 수 있다" | `@ttl/wallet-sdk` α — TtlAdapter+EvmAdapter, Keystore, 단위/통합 테스트, **Web claim 페이지 베타** |
| Q2 (M4~6) | "MetaMask 없이 TTL dApp에 연결할 수 있다" | **Browser Extension β**, dAppBridge(EIP-1193), 외부 dApp 1개 연동 데모 |
| Q3 (M7~9) | "데스크톱에서 100건 포트폴리오를 무리 없이 본다" | **Desktop β** (Tauri), 가격 피드, 다중계정 |
| Q4 (M10~12) | "iOS/Android 사용자가 QR로 송수신 가능" | **Mobile β**, 생체인증, WalletConnect, App Store 심사 통과 |
| Q5 (M13~15) | "HW 시제품 EVT — 시드 생성, TTL 1건 서명, e-ink 출력" | EVT 보드, 펌웨어 α, USB-HID, Desktop 연동 데모 |
| Q6 (M16~18) | "HW DVT — 폼팩터, BLE, 모바일 페어링" | DVT 보드, BLE 안정화, 외부 보안 감사 1회 |
| Q7 (M19~21) | "HW PVT — 양산 라인 검증, 인증 통과" | FCC/CE/KC, 생산 100대 |
| Q8 (M22~24) | "v1 출시 — 4종 SW + HW 동시 GA" | 정식 양산, 마케팅 |

### Kill Switch
- M6까지 외부 dApp 연동 0건이면 **dApp 전략 재검토**.
- M12까지 SW 활성 사용자 X명 미달이면 **HW 양산 보류**, EVT까지만.
- 보안 감사에서 Critical 1+ 발견 시 해당 단계 통과 보류.

---

## 7. 위협 모델 (요약)

| 공격 벡터 | 완화 |
|---|---|
| 시드 탈취 (악성 SW) | Keystore = 별도 패스프레이즈 PBKDF2(600k+) 또는 Argon2id. 메모리 잠금. HW에선 시드가 SE 외부 X |
| 클립보드 스왑 멀웨어 | 서명 직전 주소 화면 표시 + 주소 일부 강조 |
| 피싱 dApp | 알려진 컨트랙트 DB + WalletGuard 식 시뮬레이션 (eth_call 사전 실행) |
| 공급망 공격(HW) | 변조방지 씰, 부팅 시 펌웨어 서명 + SE attestation |
| 측면 채널 | SE 자체 보호 활용, MCU 상수시간 가드 |
| 분실/도난 | PIN(3회 오답=초기화), Shamir 백업(v2), 패스프레이즈 25th word |
| 정부 명령/계정 동결 | 논커스토디얼 — 운영사가 보관하는 키 0개. 동결 불가 = 책임도 X |

---

## 8. 운영/조직 — 빠뜨리기 쉬운 비용

- **노드 운영:** 자체 RPC 풀(geth 노드 N대) — 외부 RPC 의존 시 검열 위험. 월 $2k~$8k.
- **고객지원:** HW 분실/PIN 잠김 문의 폭증. KB·자동화·인력 동시 필요.
- **법무:** 한국 가상자산이용자보호법, EU MiCA, 미국 OFAC 스크리닝. 비커스토디얼이라도 마케팅·앱스토어 요건 있음.
- **앱스토어 정책:** Apple은 비커스토디얼 월릿에 비교적 우호적이지만 NFT/스왑 인앱결제 강제 케이스 주의.

---

## 9. 즉시 다음 행동 (v0.2 — SW 우선)

**Phase A: SW (Task #1~5,7 추적)**
1. 모노레포 부트스트랩 (`pnpm` + `turbo`) — `packages/sdk`, `apps/web`, `apps/extension`, `apps/desktop`, `apps/mobile` (firmware는 Phase B에 추가).
2. 첫 SDK PR: viem 기반 EvmAdapter, TTL Chain 7777 등록 헬퍼.
3. 브랜드 디자인 시스템 1차 — "노동자의 지갑" 로고/컬러/타이포.
4. 웹 월릿 → 확장 → 데스크톱 → 모바일 순으로 누적 출시.

**Phase B: HW (Task #6, SW 4종 안정화 후)**
- SE 칩 결정(SE050 vs ST31N600), 샘플 발주, EVT 보드 설계.

---

## 9.5 미래 모듈 (v2+ 백로그)

- **보험 시스템 (Insurance)** — 사용자 자산 손실에 대한 보장. 후보 구조:
  - (a) 자체 보험 풀: 사용자 수수료 일부 적립 → 사고 시 DAO 투표로 보상 (Nexus Mutual 식).
  - (b) 외부 커버 프로토콜 연동 (InsurAce, Sherlock 등).
  - (c) HW 디바이스 분실/파손 보증 — 별도 트랙(전통 보험사 제휴).
  - **결정 시점:** SW v1 GA 이후. 보험은 사용자·자산 규모가 일정선 넘어야 의미 있음 (작은 풀은 보험이 아니라 도박).
  - **노동자의 지갑 정체성과 정렬:** 보험은 "친노동" 가치와 강하게 맞물림 — 큰 손실에서 약자 보호. 단, 도덕적 해이/체리피킹 방지 설계 필요.

---

## 10. 결정해주실 미정 사항

- TTL coin_type을 SLIP-0044에 신청할 것인가? (지연되면 derivation 충돌 위험)
- HW 1차 시판 국가 (한국 단독? 한+미+EU?)
- 시드 백업 — 종이 + Shamir + (선택) 운영사 클라우드 보조? **클라우드 보조는 비커스토디얼 원칙과 미세 충돌** — 필요하면 키 분할 후 1조각만, e2e 암호화 권고.
- 브랜드명 — "TTL Wallet" 그대로? 디바이스 명칭? (예: TTL Cold / TTL Stone / TTL Vault)
- 라이선스 — 코어 SDK는 MIT 또는 Apache-2.0 (생태계 확산), 펌웨어는 GPL-3.0 또는 비공개?

---

## 부록 A — 확인된 TTL 체인 정보 (스냅샷, 2026-05-15)

```
eth_chainId         → 0x1e61 (7777)
web3_clientVersion  → ttlcoin/v1.13.15-stable-c5ba367e/linux-amd64/go1.22.12
eth_blockNumber     → ~500,000
eth_gasPrice        → ~1 Gwei
net_version         → 7777
api.ttl1.top        → 디스커버리 엔드포인트 없음 (404) — 별도 문서 필요
```

go-ethereum 1.13.15 베이스 fork → 표준 EVM 라이브러리(viem, ethers) 그대로 사용 가능성 매우 높음. 단, 커스텀 precompile·opcode 여부는 코어 팀 확인 필요.
