// exchange/index.ts — 벼린 거래소(TTL AMM) 공개 표면.
// 계약(types)과 클라이언트(client)를 한 지점에서 재수출한다 —
// 화면·배럴이 exchange 내부 파일 구조를 몰라도 되게.

export {
  TTL_AMM_FEE_BPS,
  type TtlAmmPool,
  type TtlAmmQuote,
  type TtlAmmSwapCall,
} from './types.js';

export {
  TtlAmmClient,
  TTL_AMM_DEFAULT_RPC_URL,
  TTL_AMM_DEFAULT_SLIPPAGE_BPS,
  TTL_AMM_NATIVE,
  type TtlAmmClientOptions,
  type TtlAmmRouteQuote,
} from './client.js';
