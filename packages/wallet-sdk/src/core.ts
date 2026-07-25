// 코어 진입점 — 체인 어댑터 의존성 없는 표면만 노출한다.
//
// 왜 별도 barrel 인가?
//   - 브라우저 확장 popup 은 EVM(TTL) 만 사용하지만, `./index.ts` 를 통해 import 하면
//     @cosmjs/* · @ton/* · xrpl · @solana/web3.js 등이 함께 끌려와 bundle 이 6MB+ 로
//     불어나고, Buffer 미정의·MV3 CSP 의 WASM 금지로 popup 자체가 마운트 실패한다.
//   - 본 barrel 은 *체인 모듈을 일절 import 하지 않는다*. 따라서 sideEffects:false 와
//     결합하면 popup chunk 에서 모든 체인 라이브러리가 tree-shake 된다.
//
// 안에 들어가는 것: Wallet · 니모닉/HD 키 · 시그너(Soft/HW) · WebHID 트랜스포트 ·
//                  공용 타입 · ChainAdapter 인터페이스(타입 only).
// 안에 들어가지 *않는* 것: EvmAdapter, BtcAdapter, ... 등 *구현체* 모듈은 일절 없음.
// 체인 별 구현은 `./evm`, `./btc`, ... 등의 subpath 에서 가져온다.

export * from './types.js';
export {
  Wallet,
  accountFromPrivateKey,
  transferAccount,
  privateKeyToHex,
  type WalletAccount,
  type WalletOptions,
} from './wallet.js';
export { SoftSigner, type SoftSignerOptions } from './signers/soft.js';
export {
  HwSigner,
  derToCompactSig,
  type HwSignerOptions,
  type HwTransport,
  type HwAppName,
} from './signers/hw.js';
export { WebHidTransport, type WebHidOpenOptions } from './transports/index.js';
export {
  createMnemonic,
  isValidMnemonic,
  mnemonicToSeed,
  getWordlist,
  NEW_MNEMONIC_WORD_COUNT,
  NEW_MNEMONIC_STRENGTH,
  type WordlistName,
  type MnemonicStrength,
} from './crypto/seed.js';
export { deriveSecp256k1, deriveEd25519, type DerivedKey } from './crypto/hdkey.js';
export type { ChainAdapter, TxContext, SignRequest } from './chains/chain.js';
