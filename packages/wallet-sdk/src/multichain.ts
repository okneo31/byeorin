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

import type { Chain as ViemChain } from 'viem/chains';
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

/** 체인 탐색기. URL 은 템플릿이 아니라 함수다 — 체인마다 경로 규칙이 다르다. */
export interface ChainExplorer {
  /** 표시 이름 ('TTL Scan', 'Etherscan', 'Mempool.space' ...). */
  name: string;
  /** 홈 URL (화면에 안 씀, 출처 기록용). */
  baseUrl: string;
  /** tx 해시/서명/digest → URL. 빈 해시·'0x' 등 못 만드는 입력이면 null. */
  txUrl(hash: string): string | null;
  /** 주소 → URL. 못 만드는 입력이면 null. */
  addressUrl(address: string): string | null;
}

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
  /**
   * 탐색기. 실측(2026-08-12)에서 죽었거나 미확인인 체인은 null — 죽은 링크를
   * 만들지 않는다. (avalanche: snowtrace.io 가 사이트 전체 403.)
   */
  explorer: ChainExplorer | null;
  /** 새 ChainAdapter 인스턴스를 만든다. 호출마다 새 인스턴스. */
  build(): ChainAdapter;
}

// ─── 탐색기 표 ────────────────────────────────────────────────────────────────
// href 전용 — 앱이 이 URL 로 fetch 하지 않는다. 사용자 클릭 링크로만 쓴다.
// 경로는 전부 2026-08-12 GET 실측(공개 RPC 최신 블록의 실존 tx/주소 표본)으로
// 확정된 것만 넣었다. 못 확인한 경로는 null 을 반환한다.

/**
 * viem chain 의 blockExplorers.default 에서 etherscan 계열 공통 경로
 * (`/tx/{hash}` · `/address/{addr}`) 탐색기를 만든다. blockExplorers 가 없으면
 * null. txUrl 은 빈 해시·'0x' 에 null (기존 셸 explorerTxUrl 규칙 승계).
 *
 * TTL Scan 의 /address 라우트는 SPA 라 HTTP 코드로 판정 불가 — 라우터 코드
 * (scan.ttl1.top/js/app.js: `navigate('/address/' + ...)`, `api('/address/' + addr)`)
 * 로 실재 라우트임을 확인했다.
 */
export function evmExplorer(chain: ViemChain): ChainExplorer | null {
  const def = chain.blockExplorers?.default;
  if (!def) return null;
  const base = def.url.replace(/\/+$/, '');
  return {
    name: def.name,
    baseUrl: base,
    txUrl: (hash) => (!hash || hash === '0x' ? null : `${base}/tx/${hash}`),
    addressUrl: (address) => (address ? `${base}/address/${address}` : null),
  };
}

// EVM 실측 예외 (2026-08-12 curl, 브라우저 UA 재시도 포함):
//   avalanche — snowtrace.io 루트까지 403. 산 링크를 못 확인 → 탐색기 자체 없음.
//   arbitrum  — /tx 는 200, /address 는 실존 EOA·시스템주소 전부 403(봇차단 추정,
//               브라우저 실사용 미확인) → addressUrl 만 막는다.
const EVM_EXPLORER_UNAVAILABLE: ReadonlySet<EvmChainKey> = new Set(['avalanche']);
const EVM_ADDRESS_URL_UNAVAILABLE: ReadonlySet<EvmChainKey> = new Set(['arbitrum']);

/** EVM_CHAINS 의 키 하나에 대한 탐색기 — 실측 예외를 적용한 최종형. */
function evmExplorerFor(key: EvmChainKey): ChainExplorer | null {
  if (EVM_EXPLORER_UNAVAILABLE.has(key)) return null;
  const ex = evmExplorer(EVM_CHAINS[key]);
  if (ex === null) return null;
  if (EVM_ADDRESS_URL_UNAVAILABLE.has(key)) return { ...ex, addressUrl: () => null };
  return ex;
}

// 비-EVM 7종. 경로·상태코드는 실측표(2026-08 실존 표본 200 확인) 그대로.
const NON_EVM_EXPLORERS: Record<
  'btc' | 'xrp' | 'solana' | 'tron' | 'ton' | 'aptos' | 'sui',
  ChainExplorer
> = {
  btc: {
    name: 'Mempool.space',
    baseUrl: 'https://mempool.space',
    txUrl: (h) => (h ? `https://mempool.space/tx/${h}` : null),
    addressUrl: (a) => (a ? `https://mempool.space/address/${a}` : null),
  },
  xrp: {
    // 해시는 대문자 hex 64자 — xrplcluster.com ledger 응답 그대로.
    name: 'XRPL Explorer',
    baseUrl: 'https://livenet.xrpl.org',
    txUrl: (h) =>
      /^[0-9a-fA-F]{64}$/.test(h)
        ? `https://livenet.xrpl.org/transactions/${h.toUpperCase()}`
        : null,
    addressUrl: (a) => (a ? `https://livenet.xrpl.org/accounts/${a}` : null),
  },
  solana: {
    name: 'Solana Explorer',
    baseUrl: 'https://explorer.solana.com',
    txUrl: (sig) => (sig ? `https://explorer.solana.com/tx/${sig}` : null),
    addressUrl: (a) => (a ? `https://explorer.solana.com/address/${a}` : null),
  },
  tron: {
    // # fragment 라우팅 — 서버는 경로 무관 동일 셸을 준다.
    name: 'Tronscan',
    baseUrl: 'https://tronscan.org',
    txUrl: (h) => (h ? `https://tronscan.org/#/transaction/${h}` : null),
    addressUrl: (a) => (a ? `https://tronscan.org/#/address/${a}` : null),
  },
  ton: {
    // tonviewer 경로는 hex 해시다. toncenter getTransactions 의
    // transaction_id.hash 는 base64 — hex 로 변환해서 넣어야 한다.
    name: 'Tonviewer',
    baseUrl: 'https://tonviewer.com',
    txUrl: (h) => {
      const hex = tonTxHashToHex(h);
      return hex === null ? null : `https://tonviewer.com/transaction/${hex}`;
    },
    addressUrl: (a) => (a ? `https://tonviewer.com/${a}` : null),
  },
  aptos: {
    name: 'Aptos Explorer',
    baseUrl: 'https://explorer.aptoslabs.com',
    txUrl: (h) =>
      h ? `https://explorer.aptoslabs.com/txn/${h}?network=mainnet` : null,
    addressUrl: (a) =>
      a ? `https://explorer.aptoslabs.com/account/${a}?network=mainnet` : null,
  },
  sui: {
    name: 'Suiscan',
    baseUrl: 'https://suiscan.xyz',
    txUrl: (d) => (d ? `https://suiscan.xyz/mainnet/tx/${d}` : null),
    addressUrl: (a) => (a ? `https://suiscan.xyz/mainnet/account/${a}` : null),
  },
};

/**
 * TON tx 해시 → hex 64자. 이미 hex 면 소문자 정규화, base64(43~44자, toncenter
 * 응답 형식)면 디코드해 32바이트 hex 로. 둘 다 아니면 null.
 */
function tonTxHashToHex(hash: string): string | null {
  if (/^[0-9a-fA-F]{64}$/.test(hash)) return hash.toLowerCase();
  if (!/^[0-9a-zA-Z+/_-]{43}={0,2}$/.test(hash)) return null;
  try {
    // base64url 변형(-,_)도 toncenter v3 에서 온다 — 표준형으로 바꿔 디코드.
    const bin = atob(hash.replace(/-/g, '+').replace(/_/g, '/'));
    if (bin.length !== 32) return null;
    let hex = '';
    for (let i = 0; i < bin.length; i++) {
      hex += bin.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return hex;
  } catch {
    return null;
  }
}

// ZION 탐색기 — 실측(2026-08-12): https://zion1.top/explorer/tx/{대문자 hex 64자}
// 는 실존 해시와 가짜 해시의 응답 본문이 다르다(서버가 tx 별 렌더링) → 실재 라우트.
// /explorer/address·/explorer/account 는 404 — 주소 페이지가 없다 → addressUrl null.
const ZION_EXPLORER: ChainExplorer = {
  name: 'ZION Explorer',
  baseUrl: 'https://zion1.top/explorer',
  txUrl: (h) =>
    /^[0-9a-fA-F]{64}$/.test(h)
      ? `https://zion1.top/explorer/tx/${h.toUpperCase()}`
      : null,
  addressUrl: () => null,
};

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
    // 외부 Cosmos 체인은 탐색기를 지정받지 않는다 — 링크 미표시.
    explorer: null,
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
  explorer: ZION_EXPLORER,
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
    explorer: evmExplorerFor(k),
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
    explorer: NON_EVM_EXPLORERS.btc,
    build: () => new BtcAdapter(),
  },
  {
    key: 'xrp',
    displayName: 'XRP Ledger',
    curve: 'secp256k1',
    nativeSymbol: NON_EVM_NATIVE.xrp.symbol,
    nativeDecimals: NON_EVM_NATIVE.xrp.decimals,
    explorer: NON_EVM_EXPLORERS.xrp,
    build: () => new XrpAdapter(),
  },
  {
    key: 'solana',
    displayName: 'Solana',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.solana.symbol,
    nativeDecimals: NON_EVM_NATIVE.solana.decimals,
    explorer: NON_EVM_EXPLORERS.solana,
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
    explorer: NON_EVM_EXPLORERS.tron,
    build: () => new TronAdapter(),
  },
  {
    key: 'ton',
    displayName: 'TON',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.ton.symbol,
    nativeDecimals: NON_EVM_NATIVE.ton.decimals,
    explorer: NON_EVM_EXPLORERS.ton,
    build: () => new TonAdapter(),
  },
  {
    key: 'aptos',
    displayName: 'Aptos',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.aptos.symbol,
    nativeDecimals: NON_EVM_NATIVE.aptos.decimals,
    explorer: NON_EVM_EXPLORERS.aptos,
    build: () => new AptosAdapter(),
  },
  {
    key: 'sui',
    displayName: 'Sui',
    curve: 'ed25519',
    nativeSymbol: NON_EVM_NATIVE.sui.symbol,
    nativeDecimals: NON_EVM_NATIVE.sui.decimals,
    explorer: NON_EVM_EXPLORERS.sui,
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
