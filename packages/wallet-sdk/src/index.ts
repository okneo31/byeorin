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
export {
  TTL_CHAIN,
  EVM_CHAINS,
  getEvmChain,
  listEvmChains,
  type EvmChainKey,
} from './chains/registry.js';
export {
  EvmAdapter,
  signEvmMessage,
  type EvmAdapterOptions,
  type EvmUnsignedTx,
  type EvmSignedTx,
} from './chains/evm.js';
export { BtcAdapter } from './chains/btc.js';
export { XrpAdapter } from './chains/xrp.js';
export { isValidClassicAddress } from 'xrpl';
export { CosmosAdapter, type CosmosAdapterOptions } from './chains/cosmos.js';
export {
  ZionAmmClient,
  ZION_API_BASE,
  ZION_AMM_DEFAULT_SLIPPAGE_BPS,
  type ZionPool,
  type ZionSwapQuote,
  type ZionAmmClientOptions,
} from './chains/zion-amm.js';
export {
  ZION_AMM_MSG_SWAP_TYPE_URL,
  ZION_AMM_TYPES,
  encodeMsgSwap,
  type MsgSwapValue,
} from './chains/zion-amm-codec.js';
export { SolanaAdapter, type SolanaAdapterOptions } from './chains/solana.js';
export { TronAdapter, type TronAdapterOptions } from './chains/tron.js';
export { TonAdapter, type TonAdapterOptions } from './chains/ton.js';
export { AptosAdapter, type AptosAdapterOptions } from './chains/aptos.js';
export { SuiAdapter, type SuiAdapterOptions } from './chains/sui.js';
export {
  WalletConnectSigner,
  type WcConnectionRequest,
  type WcSession,
  type WcSessionProposal,
  type WcSessionProposalDecision,
  type WcSessionProposalHandler,
  type WcRequestHandler,
  type WcRequest,
  type WcNamespace,
  type WcMetadata,
  type WcDelegate,
  type WalletConnectSignerOptions,
  type WalletKitLike,
} from './dapp/index.js';

// ── ERC-20 토큰 / 활동 로그 / 가격 피드 ─────────────────
export {
  Erc20,
  ERC20_ABI,
  decodeBalanceOf,
  TokenRegistry,
  BUILTIN_CHAIN_IDS,
  discoverTokens,
  type TokenInfo,
  type DiscoverOpts,
  type DiscoveredBalance,
} from './tokens/index.js';
export {
  ActivityLog,
  type Activity,
  type ActivityLogOptions,
} from './activity/index.js';
export {
  CoinGeckoPriceClient,
  sharedPriceClient,
  getPrice,
  type PriceClientOptions,
} from './prices/index.js';

// ── 벼린 환율 / 통합 환산 ────────────────────────────────
//
// 루트 배럴에도 낸다. v0.5.21 에 `/evm` 에만 있어서 그 subpath 를 쓰지 않는
// 셸(desktop·web)이 산식을 자기 파일에 복제했다 — 표면이 갈리면 값이 갈린다.
export {
  RATE_SNAPSHOT,
  rateByAddress,
  rateByIso,
  unresolvedRates,
  baseUnitsToNumber,
  authoritativeDecimals,
  ttlToTokenAmount,
  crossRate,
  snapshot as rateSnapshot,
  type RateSnapshot,
  type TokenRate,
  type UnresolvedRate,
  type RateInputs,
} from './rates/index.js';

// 주소 기반 신원 판정만 노출한다. 심볼 문자열로 판정할 길을 열어 주지 않는다.
export {
  stableDenomOf,
  stableDenomOfEvm,
  listStableDenoms,
  stableFaceRate,
  tokenIdentityOf,
  UNKNOWN_TOKEN,
  type StableDenom,
  type StableFamily,
  type TokenIdentity,
  type TokenIdentityKind,
} from './rates/stable.js';

// "이 잔액은 몇 TTL 인가" 에 답하는 유일한 함수. 셸은 이것만 부른다.
export {
  assetValueInTtl,
  sumTtl,
  type AssetRef,
  type AssetValue,
  type ValueBasis,
  type ValueReason,
  type ValueContext,
  type MarketBasis,
  type TtlSum,
} from './rates/value.js';

export { symbolUnitUsd, type PriceTable, type UnitUsd } from './rates/market.js';

// ── 메모 (TTL 체인 tx.data UTF-8) ────────────────────────
// 규칙 원본은 서버 wallet-api/memo.js. 셸에서 다시 짜지 마라.
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
