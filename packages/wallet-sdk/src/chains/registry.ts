import {
  arbitrum,
  avalanche,
  base,
  bsc,
  mainnet as ethereum,
  optimism,
  polygon,
  type Chain as ViemChain,
} from 'viem/chains';

export const TTL_CHAIN: ViemChain = {
  id: 7777,
  name: 'TTL',
  nativeCurrency: { name: 'TTL', symbol: 'TTL', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.ttl1.top'], webSocket: ['wss://ws.ttl1.top'] },
  },
  blockExplorers: {
    default: { name: 'TTL Scan', url: 'https://scan.ttl1.top' },
  },
} as const;

export const EVM_CHAINS = {
  ttl: TTL_CHAIN,
  ethereum,
  polygon,
  bsc,
  arbitrum,
  optimism,
  base,
  avalanche,
} as const;

export type EvmChainKey = keyof typeof EVM_CHAINS;

export function getEvmChain(key: EvmChainKey): ViemChain {
  return EVM_CHAINS[key];
}

export function listEvmChains(): readonly ViemChain[] {
  return Object.values(EVM_CHAINS);
}
