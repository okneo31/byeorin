// discovery.ts — 사용자가 보유한 ERC-20 잔액을 탐색.
//
// "탐색" 이라는 단어는 좀 거창하다 — 우리는 절대 체인 전체를 인덱싱하지
// 않는다. 그건 사용자 RPC 한도를 폭파시키는 길이다. 대신, 미리 알고 있는
// 토큰 목록(=TokenRegistry)을 돌면서 balanceOf 를 병렬로 호출하고, 0 이
// 아닌 잔액만 결과로 돌려준다.
//
// RPC 보호:
//   - maxRpcCalls 옵션 (기본 50). 토큰 목록이 더 많으면 앞에서 자른다.
//   - balanceOf 가 reject 하면 그 토큰만 스킵 (혹은 컨트랙트가 없을 수도).
//   - 호출은 Promise.all 한 번에 — 토큰 수가 50 미만이면 사실상 동시 호출.
//
// 호출자(UI)는 maxRpcCalls 를 RPC provider 의 burst 한도에 맞춰 조절하면 된다.

import { Erc20 } from './erc20.js';
import type { TokenInfo, TokenRegistry } from './registry.js';
import type { EvmAdapter } from '../chains/evm.js';
import type { Address } from '../types.js';

export interface DiscoveredBalance {
  token: TokenInfo;
  balance: bigint;
}

export interface DiscoverOpts {
  /** 추가로 검사할 토큰 (예: UI 에서 "최근 본 토큰"). registry 에 없어도 OK. */
  extraTokens?: readonly TokenInfo[];
  /**
   * 본 함수가 발행할 RPC 호출 상한. 기본 50.
   * 토큰 목록이 한도를 넘으면 앞에서 잘리고 console.warn 한 줄 남긴다.
   */
  maxRpcCalls?: number;
  /** chainId. 미지정 시 adapter.chain.id 를 쓴다. */
  chainId?: number;
  /**
   * 잔액 0 인 토큰도 결과에 포함. 기본 `false` — UI 첫 인상이 깔끔해진다.
   * "전체 보기" 토글에서 true 로 호출해 사용자가 어떤 토큰들이 watch
   * 가능한지 확인할 수 있게 한다.
   */
  includeZero?: boolean;
}

/**
 * 알려진 토큰들에 대한 balanceOf 결과 중 양수만 반환.
 *
 * 결과는 입력 순서를 유지한다 (registry → extra). 0 잔액 토큰은 결과에서
 * 제외된다. 컨트랙트 자체가 호출 실패하는 경우도 silently 제외 — UI 에서는
 * 그저 "보유 토큰 목록" 으로 보이면 충분하다.
 */
export async function discoverTokens(
  adapter: EvmAdapter,
  registry: TokenRegistry,
  owner: Address,
  opts: DiscoverOpts = {},
): Promise<DiscoveredBalance[]> {
  const chainId = opts.chainId ?? adapter.chain.id;
  const known = registry.getKnownTokens(chainId);
  const extra = opts.extraTokens ?? [];
  const all = [...known, ...extra];
  const max = opts.maxRpcCalls ?? 50;

  let targets = all;
  if (all.length > max) {
    // 앞에서 자르는 게 가장 단순하고, 빌트인 토큰이 우선 시청되도록 한다.
    targets = all.slice(0, max);
    // eslint-disable-next-line no-console
    console.warn(
      `[discoverTokens] 토큰 ${all.length}개 중 상위 ${max}개만 조회 (maxRpcCalls)`,
    );
  }

  const erc20 = new Erc20(adapter);
  const results = await Promise.all(
    targets.map(async (token) => {
      try {
        const bal = await erc20.balanceOf(token.address, owner);
        return { token, balance: bal } as DiscoveredBalance;
      } catch {
        // 컨트랙트가 없거나 RPC 가 거절 → 무시. UI 는 "안 보임" 으로 처리.
        return null;
      }
    }),
  );

  const nonNull = results.filter((r): r is DiscoveredBalance => r !== null);
  return opts.includeZero ? nonNull : nonNull.filter((r) => r.balance > 0n);
}
