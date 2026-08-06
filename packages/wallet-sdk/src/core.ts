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

// 체인 무관 토큰 계층 — 9 체인이 같은 형식으로 토큰을 돌려준다.
export {
  discoverPortableTokens,
  readPortableToken,
  supportsTokens,
  supportsManualToken,
  type PortableTokenBalance,
  type TokenCapableAdapter,
} from './tokens/portable.js';

// 메모 — TTL 체인은 메모를 평범한 송금 tx 의 data 에 UTF-8 로 싣는다. 규칙은
// 서버 인덱서(wallet-api/memo.js)와 한 글자도 어긋나면 안 되므로 셸 4종이
// 각자 짜지 못하게 여기 한 곳에만 둔다. 의존성 0 이라 core 에 실어도 안전하다.
// (./evm 에는 일부러 내지 않는다 — 셸이 core 와 evm 을 함께 import 하므로
//  양쪽에 같은 이름을 내면 한 파일에서 둘 다 가져올 때 충돌한다.)
export {
  encodeMemo,
  decodeMemo,
  validateMemo,
  memoByteLength,
  splitMemoLinks,
  MemoError,
  MEMO_MIN_BYTES,
  MEMO_MAX_BYTES,
  MEMO_ALLOWED_CONTROLS,
  type MemoCheck,
  type MemoRejectReason,
  type MemoSegment,
} from './memo.js';
