// registry.ts — chainId → 알려진 ERC-20 토큰 목록.
//
// 각 chainId 마다 "기본 내장" 토큰(USDC/USDT/WETH/DAI) 을 들고 있고, 사용자가
// 직접 추가한 커스텀 토큰을 메모리 상에 누적한다. 영속화는 호출자 책임 —
// shell-core 가 keystore/localStorage 정책을 관리한다.
//
// 의도적으로 wrapped native(WETH/WBNB/WMATIC) 도 포함했다 — 사용자가
// DEX 에서 받아오는 케이스가 압도적으로 많기 때문.
//
// TTL(7777) 은 환율 스냅샷(rates/snapshot.ts — 커밋된 앵커)에서 66 종을
// 생성한다. 예전에는 빈 배열이었고 익스플로러 API(loadTtlScanTokens)로만
// 채웠는데, 그 목록이 들어가는 registry 와 어댑터 폴백 registry 가 **서로 다른
// 인스턴스**라 자동 발견에 한 번도 반영되지 않았다 (실기기 0.5.8~0.5.10 에서
// 교환 화면 자산이 TTL 하나뿐이던 원인). 스냅샷은 저장소에 커밋된 검증 가능한
// 앵커고 창세 시딩의 입력과 같은 출처라, 네트워크 없이도 항상 정확하다.

import type { Address } from '../types.js';
import { RATE_SNAPSHOT } from '../rates/snapshot.js';

export interface TokenInfo {
  /** ERC-20 컨트랙트 주소 (체크섬/소문자 무관). */
  address: Address;
  /** 표시용 심볼 — ex. "USDC". */
  symbol: string;
  /** 사람 읽기용 풀네임 — ex. "USD Coin". */
  name: string;
  /** 토큰 base-unit 소수 자릿수. */
  decimals: number;
  /** 커스텀(사용자 추가) 토큰인지. */
  custom?: boolean;
  /** CoinGecko 가격 조회용 ID (있다면). */
  coingeckoId?: string;
}

// chainId 상수 — viem/chains 와 일치.
const CHAIN_ETHEREUM = 1;
const CHAIN_POLYGON = 137;
const CHAIN_ARBITRUM = 42_161;
const CHAIN_OPTIMISM = 10;
const CHAIN_BASE = 8_453;
const CHAIN_BSC = 56;
const CHAIN_AVALANCHE = 43_114;
const CHAIN_TTL = 7_777;

/**
 * 빌트인 디폴트. 호출자는 절대 이 객체를 수정하지 말 것 — registry 가 복사본을
 * 만들어 보관한다.
 */
const BUILTIN: Readonly<Record<number, readonly TokenInfo[]>> = {
  [CHAIN_ETHEREUM]: [
    {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      coingeckoId: 'tether',
    },
    {
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      address: '0x6B175474E89094C44Da98b954EedeAC495271d0F',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  [CHAIN_POLYGON]: [
    {
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      coingeckoId: 'tether',
    },
    {
      address: '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      address: '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  [CHAIN_ARBITRUM]: [
    {
      address: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      coingeckoId: 'tether',
    },
    {
      address: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  [CHAIN_OPTIMISM]: [
    {
      address: '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      coingeckoId: 'tether',
    },
    {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      address: '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  [CHAIN_BASE]: [
    {
      address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0x4200000000000000000000000000000000000006',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      address: '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  [CHAIN_BSC]: [
    {
      address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 18,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0x55d398326f99059fF775485246999027B3197955',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 18,
      coingeckoId: 'tether',
    },
    {
      address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      address: '0x1AF3F329e8BE154074D8769D1FFa4eE058B1DBc3',
      symbol: 'DAI',
      name: 'Dai Stablecoin',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  // Avalanche C-Chain. 빌트인이 0 종이라 이 체인에서는 토큰이 하나도 안 보였다.
  //
  // 주소는 전부 두 곳 이상에서 대조했다 — Trader Joe 토큰 리스트
  // (raw.githubusercontent.com/traderjoe-xyz/joe-tokenlists/main/mc.tokenlist.json)
  // 와 CoinGecko Avalanche 리스트(tokens.coingecko.com/avalanche/all.json), 일부는
  // Snowtrace 의 컨트랙트 라벨까지. decimals 도 같은 두 리스트에서 일치를 확인했다.
  //
  // 브릿지 자산(`.e`)을 네이티브 발행분과 **둘 다** 넣는다. 이름이 비슷하다고 하나만
  // 넣으면 다른 쪽을 들고 있는 사용자에게는 잔액이 0 으로 보인다. 둘은 서로 다른
  // 컨트랙트이고 서로 교환되지 않는다.
  [CHAIN_AVALANCHE]: [
    {
      // Circle 이 C-Chain 에 직접 발행한 네이티브 USDC (Snowtrace 라벨 "Circle: USDC Token").
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      // Tether 네이티브 발행분 (Snowtrace 라벨 "Tether: Tether Token", 심볼 USDt).
      address: '0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7',
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      coingeckoId: 'tether',
    },
    {
      address: '0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7',
      symbol: 'WAVAX',
      name: 'Wrapped AVAX',
      decimals: 18,
      coingeckoId: 'wrapped-avax',
    },
    {
      // Avalanche Bridge 로 넘어온 구 USDC. 네이티브 USDC 와 별개 컨트랙트다.
      address: '0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664',
      symbol: 'USDC.e',
      name: 'USD Coin (Bridged)',
      decimals: 6,
      coingeckoId: 'usd-coin',
    },
    {
      address: '0xc7198437980c041c805A1EDcbA50c1Ce5db95118',
      symbol: 'USDT.e',
      name: 'Tether USD (Bridged)',
      decimals: 6,
      coingeckoId: 'tether',
    },
    {
      address: '0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB',
      symbol: 'WETH.e',
      name: 'Wrapped Ether (Bridged)',
      decimals: 18,
      coingeckoId: 'weth',
    },
    {
      // decimals 8 — 다른 스테이블과 달리 여기만 8 이다. 18 로 넣으면 잔액이
      // 10^10 배로 어긋난다.
      address: '0x50b7545627a5162F82A992c33b87aDc75187B218',
      symbol: 'WBTC.e',
      name: 'Wrapped BTC (Bridged)',
      decimals: 8,
      coingeckoId: 'wrapped-bitcoin',
    },
    {
      address: '0xd586E7F844cEa2F87f50152665BCbc2C279D8d70',
      symbol: 'DAI.e',
      name: 'Dai Stablecoin (Bridged)',
      decimals: 18,
      coingeckoId: 'dai',
    },
  ],
  // 환율 스냅샷에서 기계 생성 — 주소·심볼·decimals 의 출처는 커밋된 앵커다.
  [CHAIN_TTL]: RATE_SNAPSHOT.rates.map((r) => ({
    address: r.address as Address,
    symbol: r.symbol,
    name: `TTL ${r.iso} Stable`,
    decimals: r.decimals,
  })),
};

/**
 * 같은 토큰을 두 번 등록하는 일을 막기 위해 주소를 소문자로 normalize.
 * Ethereum 주소는 체크섬 케이스가 정보가 아니라 표기 옵션일 뿐이므로 안전하다.
 */
function normAddr(a: Address): string {
  return a.toLowerCase();
}

/**
 * Chain ID 별 토큰 레지스트리.
 *
 * 빌트인 리스트는 생성 시 한 번 복사되어 사용자 커스텀과 같은 배열에 들어간다.
 * `addCustomToken` 은 중복(주소가 이미 존재) 시 silently no-op — caller 의
 * UI 흐름을 단순화하기 위함이다 (이미 추가됐다고 에러 띄울 일은 거의 없다).
 */
export class TokenRegistry {
  private readonly tokens = new Map<number, TokenInfo[]>();

  constructor() {
    for (const [k, v] of Object.entries(BUILTIN)) {
      this.tokens.set(Number(k), v.map((t) => ({ ...t })));
    }
  }

  /** 해당 체인의 알려진 토큰 (빌트인 + 사용자 커스텀). 정의되지 않은 체인은 빈 배열. */
  getKnownTokens(chainId: number): TokenInfo[] {
    const arr = this.tokens.get(chainId);
    return arr ? arr.slice() : [];
  }

  /**
   * 커스텀 토큰을 등록한다. 동일 주소가 이미 있으면 no-op.
   *
   * 호출자는 일반적으로 `Erc20.decimals()/symbol()/name()` 으로 metadata 를
   * 먼저 얻은 다음 본 메서드를 부른다. (DiscoveryUI 의 "토큰 추가" 모달.)
   */
  addCustomToken(chainId: number, info: TokenInfo): void {
    const list = this.tokens.get(chainId) ?? [];
    const target = normAddr(info.address);
    if (list.some((t) => normAddr(t.address) === target)) return;
    list.push({ ...info, custom: info.custom ?? true });
    this.tokens.set(chainId, list);
  }

  /** 특정 토큰 조회. 미존재 시 undefined. */
  getToken(chainId: number, address: Address): TokenInfo | undefined {
    const list = this.tokens.get(chainId);
    if (!list) return undefined;
    const target = normAddr(address);
    return list.find((t) => normAddr(t.address) === target);
  }

  /** 디버깅/관리용 — 등록된 체인 ID 목록. */
  listChainIds(): number[] {
    return Array.from(this.tokens.keys());
  }
}

/**
 * 프로세스 전역 공용 registry.
 *
 * 어댑터의 폴백 registry 와 셸(wallet-service)의 registry 가 서로 다른
 * 인스턴스면, ttlscan 톱업·수동 추가 토큰이 자동 발견 경로에 영영 반영되지
 * 않는다 — 실제로 그 사고가 났다. 셸과 어댑터 폴백은 반드시 이 하나를 쓴다.
 * (테스트나 격리가 필요한 곳만 `new TokenRegistry()` 로 따로 만든다.)
 */
let shared: TokenRegistry | undefined;
export function defaultTokenRegistry(): TokenRegistry {
  shared ??= new TokenRegistry();
  return shared;
}

// 빌트인 체인 ID 상수도 외부에 노출 (테스트 등에서 마법 숫자 회피).
export const BUILTIN_CHAIN_IDS = {
  ethereum: CHAIN_ETHEREUM,
  polygon: CHAIN_POLYGON,
  arbitrum: CHAIN_ARBITRUM,
  optimism: CHAIN_OPTIMISM,
  base: CHAIN_BASE,
  bsc: CHAIN_BSC,
  avalanche: CHAIN_AVALANCHE,
  ttl: CHAIN_TTL,
} as const;
