<div align="center">

# 벼린 (Byeorin)

**노동자의 지갑** · TTL 생태계 멀티체인 비수탁 지갑

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

</div>

---

시드는 사용자 기기 밖으로 나가지 않습니다. 우리는 사용자의 자산에 접근할 수 없고,
복구해 줄 수도 없습니다. 그 대신 **우리가 만든 것을 누구나 확인할 수 있게** 합니다.

## 원칙 — 검증 가능한 보안

> **규칙은 누구나 검증 가능하게. 권한은 아무나가 아니게.**

목표는 "가장 안전한 지갑"이 아닙니다. 그건 검증할 수 없는 주장이고, 사용자는
믿거나 말거나 둘 중 하나가 됩니다. 우리가 겨냥하는 건 **누구나 확인할 수 있는
보안**입니다.

이 지갑을 쓸 사람은 칩을 뜯어 확인할 수 없습니다. 그가 실제로 기댈 수 있는 건
두 가지뿐입니다 — *여러 사람이 같은 것을 봤다*, *누가 몰래 바꿀 수 없다*.
그래서 **공개 검증은 가난한 사람의 감사(audit)** 입니다.

자세한 내용과 **아직 못 하는 것**: [`docs/VERIFIABILITY.md`](docs/VERIFIABILITY.md)

## 받은 APK가 진짜인지 확인하기

우리 서버에 아무것도 묻지 않고, 손에 든 파일만으로 확인합니다.

**파일명이 버전을 담습니다.** 산출물은 `벼린<versionName>.apk`, 매니페스트는
`벼린<versionName>.apk.manifest.json` 입니다. 릴리스마다 이름이 바뀌므로
아래 예시의 `0.5.16` 자리에 손에 든 파일의 버전을 넣으십시오.

```sh
node scripts/verify-byeorin-apk.mjs 벼린0.5.16.apk 벼린0.5.16.apk.manifest.json
```

```
[  OK  ] 무결성 (SHA-256)      5363e843…002dc
[  OK  ] 진위 (서명 인증서)     303f801b…03480
[  OK  ] 출처 (주장)           commit a665666 (main)
```

서명 인증서 지문 — 이 값과 다른 APK 는 벼린이 만든 것이 아닙니다:

```
303f801bb44af8c494b6e89844fbe86c36bd6f48ab404a4b6c0228fa3f103480
```

## 지원 체인 (16 슬롯 / 9 어댑터)

| | |
|---|---|
| **EVM** | TTL (ChainID 7777) · Ethereum · Polygon · BNB · Arbitrum · Optimism · Base · Avalanche |
| **Cosmos** | ZION (kWR · BTC · USDT · ETH + AMM 스왑) |
| **기타** | Bitcoin · XRP Ledger · Solana · TRON · TON · Aptos · Sui |

## 저장소 구조

```
apps/
  android/     Capacitor 8 + Vite WebView → APK. 9 체인 전부 동작 (실사용 셸)
  extension/   브라우저 확장 (MV3, EIP-1193)
  web/         Vite + React
  desktop/     Tauri 2
  mobile/      RN 0.76 스캐폴드 — android/ 로 대체됨 (보존)
packages/
  wallet-sdk/  코어 SDK — 9 체인 어댑터, BIP-39/32 키 파생
  shell-core/  WalletStore + SessionStore + Keystore (scrypt + AES-256-GCM)
  design-system/ · i18n/
firmware/      벼린 요세 (Zephyr, nRF52840 + SE050 + e-ink)
hardware/      요세 사양 · BOM · 위협 모델
docs/          PLAN · ARCHITECTURE · VERIFIABILITY · INSURANCE
```

## 왜 모바일이 React Native 가 아닌가

9 체인 전부를 요구하면 RN 은 선택지에서 빠집니다. **Hermes 엔진에 WebAssembly 가
없어** BTC(`@scure/btc-signer`) · SOL(`@solana/web3.js`) · TRON 어댑터가 원천적으로
못 돕니다. Android WebView 는 Chromium 이라 WASM · WebCrypto 가 그대로 동작합니다.
자세한 근거: [`apps/android/README.md`](apps/android/README.md)

## 금고 — 두 겹, 순서가 중요합니다

```
시드 → AES-GCM(scrypt(비밀번호))   ← 안쪽. 사용자만 아는 것
     → AES-GCM(AndroidKeyStore 키) ← 바깥쪽. 이 폰만 아는 것
```

바깥쪽 키는 TEE/StrongBox 밖으로 나오지 않습니다. 저장 파일을 통째로 떠가도 그 폰이
아니면 복호화를 시작조차 못 합니다. 하드웨어 계층이 뚫려도 공격자가 얻는 건 여전히
scrypt 로 잠긴 blob 입니다 — 반대 순서였으면 한 겹에 끝이었습니다.

**막지 못하는 것**(칩 벤더·물리 공격·잠금 해제된 단말)은
[`apps/android/README.md`](apps/android/README.md) 에 전례와 함께 적어 두었습니다.

## 빌드

```sh
pnpm install
pnpm -r build                    # 워크스페이스 패키지
cd apps/android && pnpm apk      # → D:\...\벼린<versionName>.apk + manifest
```

`<versionName>` 은 `apps/android/android/app/build.gradle` 의 `versionName` 에서
읽어 붙습니다 — 별도로 이름을 정하지 않습니다.

상세: [`apps/android/README.md`](apps/android/README.md)

## 상태

작동하는 것과 아닌 것을 섞어 말하지 않습니다.

- ✅ 9 체인 주소 파생 · 잔액 조회 · 네이티브 송금 · ZION AMM 견적
- ✅ 다중 계정 · 시드 24 단어(한/영) · 비밀번호 금고 · 하드웨어 바인딩 · 자동 잠금
- ✅ 릴리스 무결성·진위 검증
- ⬜ 재현 빌드 (**안 됨** — 실측 확인, [VERIFIABILITY §2.1](docs/VERIFIABILITY.md))
- ⬜ 온체인 릴리스 앵커링
- ⬜ 실기기 송금/스왑 브로드캐스트 검증
- ⬜ 벼린 요세 (하드웨어) — 사양·펌웨어 스캐폴드 단계
- ⬜ 외부 보안 감사

## 보안 신고

취약점은 공개 이슈 대신 [`SECURITY.md`](SECURITY.md) 의 절차를 따라 주세요.

## 라이선스

[Apache License 2.0](LICENSE). 창작재산권은 okneo31 에게 있으며, 파생물은
[`NOTICE`](NOTICE) 표기를 유지해야 합니다. "벼린"·"Byeorin" 상표는 라이선스
대상이 아닙니다 — 포크는 다른 이름을 써야 합니다.
