// EVM 전용 진입점.
//
// popup 처럼 EVM/TTL 만 다루는 컨슈머는 본 subpath 를 사용해 chains/cosmos · chains/ton ·
// chains/xrp 등이 bundle 에 끌려오지 않도록 한다. EVM 의존성은 viem 만 추가된다.
// (`./core` 와 함께 사용 — 본 barrel 은 `core` 의 표면을 *덮어쓰지 않는다*.)

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

// ERC-20 토큰 시스템 — popup 의 EVM 자산 list 가 활용. tokens 는 viem/EVM 전용
// 이라 본 subpath 에 묶어도 부담 없다 (cosmos/ton/xrp 안 끌려옴).
export {
  Erc20,
  ERC20_ABI,
  decodeBalanceOf,
  TokenRegistry,
  BUILTIN_CHAIN_IDS,
  discoverTokens,
  fetchTtlScanTokens,
  type TokenInfo,
  type DiscoverOpts,
  type DiscoveredBalance,
  type FetchTtlScanTokensOptions,
} from './tokens/index.js';
