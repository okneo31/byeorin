// activity-sources — 비-EVM 활동 소스 5종(solana/xrp/aptos/sui/cosmos:zion) 전용 진입점.
// fetch 만 쓰는 얇은 표면이라 체인 어댑터 라이브러리(@solana/web3.js, xrpl, ...)를 끌지 않는다.
// 셸은 `@byeorin/wallet-sdk/activity-sources` 서브패스로 dynamic import 한다.

export type {
  ActivitySourceChain,
  ActivitySourceFailure,
  OmittedField,
  ChainActivityRow,
  ActivityQuery,
  ActivitySourceOk,
  ActivitySourceErr,
  ActivitySourceResult,
} from './activity/sources/types.js';
export {
  ACTIVITY_SOURCE_DEFAULT_LIMIT,
  ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS,
} from './activity/sources/types.js';

export { SOLANA_ACTIVITY_RPC, fetchSolanaActivity } from './activity/sources/solana.js';
export { XRP_ACTIVITY_RPC, fetchXrpActivity } from './activity/sources/xrp.js';
export { APTOS_ACTIVITY_REST, fetchAptosActivity } from './activity/sources/aptos.js';
export { SUI_ACTIVITY_RPC, fetchSuiActivity } from './activity/sources/sui.js';
// cosmos:zion 소스 — 계약 B-1 의 파일명은 cosmos.ts 였으나 구현은 zion.ts 로 들어왔다.
// 공개 심볼(ZION_ACTIVITY_LCD / fetchCosmosActivity)은 계약 B-3 그대로다.
export { ZION_ACTIVITY_LCD, fetchCosmosActivity } from './activity/sources/zion.js';
