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
  defaultTokenRegistry,
  BUILTIN_CHAIN_IDS,
  discoverTokens,
  fetchTtlScanTokens,
  type TokenInfo,
  type DiscoverOpts,
  type DiscoveredBalance,
  type FetchTtlScanTokensOptions,
} from './tokens/index.js';

// 벼린 환율 — TTL 기준, 각국 통화토큰이 여기에 매달린다.
export {
  RATE_SNAPSHOT,
  rateByAddress,
  rateByIso,
  unresolvedRates,
  tokenAmountToTtl,
  stableAmountToTtl,
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

// 스테이블코인 액면(주소 → 통화 ISO) — 셸이 심볼로 판정하지 못하도록 주소
// 기반 조회만 노출한다. 경계 설명은 rates/stable.ts 상단.
export {
  stableDenomOf,
  stableDenomOfEvm,
  listStableDenoms,
  stableToTtl,
  stableFaceRate,
  type StableDenom,
  type StableFamily,
} from './rates/stable.js';

// 토큰 신원 — "값을 매겨도 되는가" 판정 + 환산 + 시세 게이트를 한 번에.
// 셸이 이걸 각자 짜서 두 셸의 decimals·분기 조건이 갈라졌다(v0.5.21).
export {
  tokenIdentityOf,
  tokenValueOf,
  UNKNOWN_TOKEN,
  type TokenIdentity,
  type TokenIdentityKind,
  type TokenValue,
} from './rates/stable.js';

// 통합 환산 — "이 잔액은 몇 TTL 인가" 에 답하는 유일한 함수. TTL 이 자(尺)다.
// 셸은 이것만 부른다. tokenValueOf·stableToTtl·tokenAmountToTtl 을 셸에서
// 조합하면 v0.5.21 처럼 셸 수만큼 갈라진다.
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

// Binance ticker 표 → 1 단위 USD. fetch 는 셸이 하고 표만 여기로 들어온다.
// TTL·WTTL 은 여기서 무조건 null 이다 — TTL 에 시세가 붙는 두 번째 자물쇠.
export { symbolUnitUsd, type PriceTable, type UnitUsd } from './rates/market.js';

export {
  discoverPortableTokens,
  readPortableToken,
  supportsTokens,
  supportsManualToken,
  type PortableTokenBalance,
  type TokenCapableAdapter,
} from './tokens/portable.js';

// 벼린 거래소(TTL 체인 AMM) — 클라이언트와 공유 타입.
export {
  TtlAmmClient,
  TTL_AMM_FEE_BPS,
  TTL_AMM_NATIVE,
  TTL_AMM_DEFAULT_RPC_URL,
  TTL_AMM_DEFAULT_SLIPPAGE_BPS,
  type TtlAmmClientOptions,
  type TtlAmmRouteQuote,
  type TtlAmmPool,
  type TtlAmmQuote,
  type TtlAmmSwapCall,
} from './exchange/index.js';
