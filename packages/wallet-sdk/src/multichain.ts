// multichain.ts — 9 어댑터(EVM/BTC/XRP/Cosmos/SOL/TRON/TON/Aptos/Sui) 를
// "한 줄 factory" 로 묶는 진입점.
//
// 왜 별도 barrel 인가?
//   - 본 모듈은 *모든* 체인 어댑터를 import 하므로 cosmos/ton/xrp/solana/... 라이브러리가
//     전부 끌려온다. EVM 만 쓰는 컨슈머(예: 경량 popup 초기화면)는 본 모듈 대신
//     `./core` + `./evm` 만 import 해야 한다.
//   - 멀티체인 화면을 *실제로 펼칠 때만* 동적 import 하면 초기 번들이 가벼워진다:
//       const mc = await import('@byeorin/wallet-sdk/multichain');
//
// 책임(단일): 체인별 어댑터 생성 방법을 ChainSpec 한 가지 모양으로 통일한다.
// 어카운트 도출/잔액/송금은 여전히 ChainAdapter / Wallet 의 책임 — 본 모듈은
// "어떤 어댑터를 어떻게 만드는가" 만 안다.

import type { ChainAdapter } from './chains/chain.js';
import { EvmAdapter } from './chains/evm.js';
import { EVM_CHAINS, type EvmChainKey } from './chains/registry.js';
import { BtcAdapter } from './chains/btc.js';
import { XrpAdapter } from './chains/xrp.js';
import { SolanaAdapter } from './chains/solana.js';
import { TronAdapter } from './chains/tron.js';
import { TonAdapter } from './chains/ton.js';
import { AptosAdapter } from './chains/aptos.js';
import { SuiAdapter } from './chains/sui.js';
import { CosmosAdapter, type CosmosAdapterOptions } from './chains/cosmos.js';

// CosmosAdapter / 옵션 — multichain 번들에 이미 들어 있으므로 popup 이 동일
// 번들에서 re-import 할 수 있게 노출한다. 직접 사용처: ZION 커스텀 메시지
// 송신(swap, claim-seed 등) 에서 buildTx → sign → broadcast 흐름.
export { CosmosAdapter };
export type { CosmosAdapterOptions };

// ZION AMM — 1차 커스텀 모듈 슬라이스. multichain 번들에 포함시켜 popup 이
// 별도 chunk 없이 multichain 로드 한 번으로 swap 화면까지 진입 가능하게 한다.
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
  type MsgSwapValue,
} from './chains/zion-amm-codec.js';

/**
 * 멀티체인 UI 가 다루는 체인 식별자.
 *
 *  - `evm:<key>`     — EVM_CHAINS 의 키 (ttl, ethereum, polygon, ...)
 *  - `btc`/`xrp`/... — 단일 인스턴스 비-EVM 체인
 *  - `cosmos:<id>`   — Cosmos 계열. chainId 가 식별자 (cosmoshub-4, osmosis-1, ...)
 */
export type ChainKey =
  | `evm:${EvmChainKey}`
  | 'btc'
  | 'xrp'
  | 'solana'
  | 'tron'
  | 'ton'
  | 'aptos'
  | 'sui'
  | `cosmos:${string}`;

/**
 * 한 체인의 "이름 + 메타 + 어댑터 생성법". UI 는 ChainSpec 배열을 받아 셀렉터를
 * 그리고, 사용자가 고른 체인의 `build()` 로 어댑터를 만든다.
 */
export interface ChainSpec {
  key: ChainKey;
  displayName: string;
  /** 어댑터의 curve — UI 가 raw key import 가능 여부 등을 판단할 때 쓴다. */
  curve: 'secp256k1' | 'ed25519';
  /** 네이티브 자산 심볼 (TTL, ETH, BTC, kWR, ...). */
  nativeSymbol: string;
  /** 네이티브 자산 decimals — 잔액(bigint base unit) → 표시값 변환용. */
  nativeDecimals: number;
  /** 새 ChainAdapter 인스턴스를 만든다. 호출마다 새 인스턴스. */
  build(): ChainAdapter;
}

// 비-EVM 단일 인스턴스 체인의 네이티브 자산 메타. 모두 널리 알려진 표준값.
//   BTC satoshi=1e8 · XRP drops=1e6 · SOL lamports=1e9 · TRX sun=1e6
//   TON nanoton=1e9 · APT octas=1e8 · SUI MIST=1e9
const NON_EVM_NATIVE: Record<
  'btc' | 'xrp' | 'solana' | 'tron' | 'ton' | 'aptos' | 'sui',
  { symbol: string; decimals: number }
> = {
  btc: { symbol: 'BTC', decimals: 8 },
  xrp: { symbol: 'XRP', decimals: 6 },
  solana: { symbol: 'SOL', decimals: 9 },
  tron: { symbol: 'TRX', decimals: 6 },
  ton: { symbol: 'TON', decimals: 9 },
  aptos: { symbol: 'APT', decimals: 8 },
  sui: { symbol: 'SUI', decimals: 9 },
};

/**
 * Cosmos 계열 체인의 ChainSpec 을 만든다.
 *
 * Cosmos 어댑터는 chainId/bech32Prefix/rpcUrl/denom 이 필수다 — 체인마다 다르고
 * 라이브러리 기본값이 없으므로 호출자가 명시해야 한다.
 *
 * @example
 *   cosmosChainSpec({
 *     displayName: 'Cosmos Hub',
 *     chainId: 'cosmoshub-4', bech32Prefix: 'cosmos',
 *     rpcUrl: 'https://...', denom: 'uatom',
 *   })
 */
export function cosmosChainSpec(
  opts: CosmosAdapterOptions & { displayName: string; nativeSymbol: string },
): ChainSpec {
  return {
    key: `cosmos:${opts.chainId}`,
    displayName: opts.displayName,
    curve: 'secp256k1',
    nativeSymbol: opts.nativeSymbol,
    nativeDecimals: opts.decimals ?? 6,
    build: () => new CosmosAdapter(opts),
  };
}

/**
 * ZION — TTL 생태계의 자체 Cosmos SDK v0.50 체인. 벼린 멀티체인 월렛의 Cosmos 슬롯.
 *
 * 값 출처: D:\TTLCOINWalet\ZionWallet.MD (ZION Phase 1, 2026-05-22 스냅샷).
 *
 * ⚠ Phase 1 함정 (CosmosAdapter 호환성 검증 필요):
 *   - 수수료 AnteHandler 미와이어업 — Fee.amount 는 빈배열/`0utrg`, gas_limit 고정값.
 *     `'auto'` 가스 시뮬레이션에 의존하면 안 된다.
 *   - chain-id 는 `zion` (코드 상수 `zion-phase1` 아님).
 *   - DenomMetadata 미등록 — utrg=6 등 exponent 를 하드코딩해야 한다.
 */
// ZION 의 ChainSpec 은 `cosmosChainSpec()` 위에서 한 단계 더 — customMsgTypes 에
// ZION_AMM_TYPES 를 직접 끼워 넣는다. 그래야 `ZION_CHAIN_SPEC.build()` 가
// 반환하는 CosmosAdapter 가 즉시 `/zion.amm.v1.MsgSwap` 을 이해한다 (popup 이
// 별도 어댑터를 만들 필요 없음).
//
// 직접 cosmosChainSpec() 을 호출하지 않고 CosmosAdapter 를 직접 wiring 하는
// 이유: cosmosChainSpec() 은 CosmosAdapterOptions 만 받고 customMsgTypes 도
// 그 안에 있긴 하지만, ChainSpec.build() 가 매번 새 인스턴스를 만들도록
// 옵션 객체를 클로저로 잡아두는 패턴이 더 명료하다.
//
// 후속 모듈(job/bankext/pop) 메시지 타입을 추가하려면 이 배열 한 줄을 늘리면 됨.
import { ZION_AMM_TYPES } from './chains/zion-amm-codec.js';

const ZION_ADAPTER_OPTIONS = {
  chainId: 'zion',
  bech32Prefix: 'zion',
  rpcUrl: 'https://rpc.zion1.top',
  denom: 'utrg',
  decimals: 6,
  coinType: 118,
  // ZION Phase 1 은 수수료 AnteHandler 가 없다 — fee 를 0utrg 로 둔다.
  // (5000 을 넣어도 차감되지 않지만, Phase 2 와의 일관성을 위해 0 으로 명시.)
  defaultFee: 0n,
  // gas_limit 은 CosmosAdapter 기본값 200_000 이 ZION 명세 권장값과 일치 — 생략.
  customMsgTypes: ZION_AMM_TYPES,
} as const satisfies CosmosAdapterOptions;

export const ZION_CHAIN_SPEC: ChainSpec = {
  key: 'cosmos:zion',
  displayName: 'Zion',
  curve: 'secp256k1',
  nativeSymbol: 'kWR',
  nativeDecimals: 6,
  build: () => new CosmosAdapter(ZION_ADAPTER_OPTIONS),
};

/**
 * 기본 체인 매트릭스 — EVM 8종 + BTC/XRP/SOL/TRON/TON/Aptos/Sui + ZION.
 *
 * EVM·비EVM 체인은 라이브러리 기본 RPC 로 옵션 없이 build 된다.
 * ZION 은 TTL 생태계의 Cosmos 체인 — `rpc.zion1.top` 으로 고정 설정돼 있다.
 * 외부 Cosmos(Cosmos Hub/Osmosis 등)는 추후 `cosmosChainSpec()` 으로 추가한다.
 */
// EVM 체인별 RPC override. viem 의 chain.rpcUrls.default 가 익명/CORS 거부 또는
// hang 하는 케이스에만 명시. publicnode 는 "{chain}-rpc.publicnode.com" 패턴으로
// CORS·익명 친화적. 다른 체인이 막히면 같은 패턴으로 추가하면 된다.
const EVM_RPC_OVERRIDES: Partial<Record<EvmChainKey, string>> = {
  ethereum: 'https://ethereum-rpc.publicnode.com',
};

export const DEFAULT_CHAINS: readonly ChainSpec[] = [
  ...(Object.keys(EVM_CHAINS) as EvmChainKey[]).map((k): ChainSpec => ({
    key: `evm:${k}`,
    displayName: EVM_CHAINS[k].name,
    curve: 'secp256k1',
    nativeSymbol: EVM_CHAINS[k].nativeCurrency.symbol,
    nativeDecimals: EVM_CHAINS[k].nativeCurrency.decimals,
    build: () => new EvmAdapter({
      chain: EVM_CHAINS[k],
      ...(EVM_RPC_OVERRIDES[k] !== undefined ? { rpcUrl: EVM_RPC_OVERRIDES[k] } : {}),
    }),
  })),
  {
    key: 'btc',
    displayName: 'Bitcoin',
    curve: 'secp256k1',
    nativeSymbol: NON_EVM_NATIVE.btc.symbol,
    nativeDecimals: NON_EVM_NATIVE.btc.decimals,
    build: () => new BtcAdapter(),
  },
  {
    key: 'xrp',
    displayName: 'XRP Ledger',
    curve: 'secp256k1',
    nativeSymbol: NON_EVM_NATIVE.xrp.symbol,
    nativeDecimals: NON_EVM_NATIVE.xrp.decimals,
    build: () => new XrpAdapter(),
  },
  {
    key: 'solana',
    displayName: 'Solana',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.solana.symbol,
    nativeDecimals: NON_EVM_NATIVE.solana.decimals,
    // 무인자 기본값 = SOLANA_MAINNET_RPC_URLS (publicnode → OnFinality → dRPC).
    // 읽기만 그 순서로 fallback 하고, 송금은 0번(publicnode) 고정이다 — blockhash 를
    // A 에서 받아 B 로 보내면 tx 가 깨진다.
    // 공식 api.mainnet-beta.solana.com 은 extension origin 익명 요청을 거부(403)해
    // 기본 목록에 없다.
    // 실측 주의(2026-07-28): 2·3순위는 무키 상태에서 각각 429/400 을 돌려주므로
    // 지금은 실질 이중화가 아니다. 키를 넣거나 요금제가 바뀌면 코드 변경 없이 산다.
    build: () => new SolanaAdapter(),
  },
  {
    key: 'tron',
    displayName: 'TRON',
    curve: 'secp256k1',
    nativeSymbol: NON_EVM_NATIVE.tron.symbol,
    nativeDecimals: NON_EVM_NATIVE.tron.decimals,
    build: () => new TronAdapter(),
  },
  {
    key: 'ton',
    displayName: 'TON',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.ton.symbol,
    nativeDecimals: NON_EVM_NATIVE.ton.decimals,
    build: () => new TonAdapter(),
  },
  {
    key: 'aptos',
    displayName: 'Aptos',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.aptos.symbol,
    nativeDecimals: NON_EVM_NATIVE.aptos.decimals,
    build: () => new AptosAdapter(),
  },
  {
    key: 'sui',
    displayName: 'Sui',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.sui.symbol,
    nativeDecimals: NON_EVM_NATIVE.sui.decimals,
    build: () => new SuiAdapter(),
  },
  ZION_CHAIN_SPEC,
];

/** ChainKey 로 DEFAULT_CHAINS 에서 spec 을 찾는다. 없으면 undefined. */
export function findChainSpec(key: ChainKey): ChainSpec | undefined {
  return DEFAULT_CHAINS.find((c) => c.key === key);
}

// 셸이 어댑터를 갈아끼울 수 있게 노출한다.
// 안드로이드는 Solana 를 native HTTP(CapacitorHttp)로 태워야 한다 — 토큰 조회를
// 받아주는 무료 엔드포인트가 Origin 헤더를 403 으로 막기 때문이다.
export { SolanaAdapter, type SolanaAdapterOptions } from './chains/solana.js';
