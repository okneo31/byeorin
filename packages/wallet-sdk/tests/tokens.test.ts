// tokens.test.ts — Erc20 / TokenRegistry / discoverTokens.
//
// 모두 offline: EvmAdapter.client 를 monkey-patch 해서 readContract 결과를
// 결정적으로 만든다. RPC/network 의존 없다.

import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CHAIN_IDS,
  Erc20,
  EvmAdapter,
  TokenRegistry,
  TTL_CHAIN,
  decodeBalanceOf,
  discoverTokens,
} from '../src/index.js';
import { encodeFunctionData, type Hex } from 'viem';
import { ERC20_ABI } from '../src/tokens/erc20.js';

// 결정성을 위한 dummy adapter — 빌트인 없는 합성 체인. TTL(7777) 을 쓰면
// 이제 스냅샷 유래 66종 빌트인이 함께 조회돼 extraTokens 검증이 오염된다.
function makeAdapter(): EvmAdapter {
  return new EvmAdapter({ chain: { ...TTL_CHAIN, id: 424_242 } });
}

interface Patched {
  client: Record<string, unknown>;
}

function patchReadContract(
  adapter: EvmAdapter,
  impl: (args: {
    address: string;
    functionName: string;
    args?: unknown[];
  }) => unknown,
): void {
  const p = adapter as unknown as Patched;
  p.client.readContract = async (a: {
    address: string;
    functionName: string;
    args?: unknown[];
  }) => impl(a);
}

describe('Erc20', () => {
  it('balanceOf returns bigint from mocked readContract', async () => {
    const adapter = makeAdapter();
    patchReadContract(adapter, ({ functionName }) => {
      if (functionName === 'balanceOf') return 123456789n;
      throw new Error(`unexpected ${functionName}`);
    });
    const erc20 = new Erc20(adapter);
    const bal = await erc20.balanceOf(
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(bal).toBe(123456789n);
  });

  it('decimals/symbol/name pass through', async () => {
    const adapter = makeAdapter();
    patchReadContract(adapter, ({ functionName }) => {
      if (functionName === 'decimals') return 6;
      if (functionName === 'symbol') return 'USDC';
      if (functionName === 'name') return 'USD Coin';
      throw new Error(`unexpected ${functionName}`);
    });
    const erc20 = new Erc20(adapter);
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    expect(await erc20.decimals(token)).toBe(6);
    expect(await erc20.symbol(token)).toBe('USDC');
    expect(await erc20.name(token)).toBe('USD Coin');
  });

  it('transfer() returns a TransferIntent with encoded calldata', () => {
    const adapter = makeAdapter();
    const erc20 = new Erc20(adapter);
    const token = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const to = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const amount = 1_000_000n;
    const intent = erc20.transfer(token, to, amount);
    expect(intent.to).toBe(token);
    expect(intent.amount).toBe(0n);
    expect(intent.asset).toBe('erc20');
    const expected = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to as Hex, amount],
    });
    expect(intent.data).toBe(expected);
  });

  it('decodeBalanceOf round-trips an ABI-encoded uint256', () => {
    // 0x prefix + 64 hex chars = uint256(42).
    const data = ('0x' + '0'.repeat(62) + '2a') as Hex;
    expect(decodeBalanceOf(data)).toBe(42n);
  });

});

describe('TokenRegistry', () => {
  it('builtin tokens 7 EVM 체인 + TTL 66종 (환율 스냅샷 유래)', () => {
    const reg = new TokenRegistry();
    expect(reg.getKnownTokens(BUILTIN_CHAIN_IDS.ethereum).length).toBe(4);
    expect(reg.getKnownTokens(BUILTIN_CHAIN_IDS.polygon).length).toBe(4);
    expect(reg.getKnownTokens(BUILTIN_CHAIN_IDS.arbitrum).length).toBe(4);
    expect(reg.getKnownTokens(BUILTIN_CHAIN_IDS.optimism).length).toBe(4);
    expect(reg.getKnownTokens(BUILTIN_CHAIN_IDS.base).length).toBe(3); // USDT 빠짐
    expect(reg.getKnownTokens(BUILTIN_CHAIN_IDS.bsc).length).toBe(4);
    // TTL 은 커밋된 환율 스냅샷에서 생성 — 네트워크 없이도 66종이 보여야 한다.
    // 빈 배열이던 시절엔 자동 발견이 TTL 에서 0건이었다 (실기기 0.5.8~0.5.10).
    const ttl = reg.getKnownTokens(BUILTIN_CHAIN_IDS.ttl);
    expect(ttl.length).toBe(66);
    const usd = ttl.find((t) => t.symbol === 'tUSD');
    expect(usd?.address).toBe('0xc00d0FF37e9CE83C269e762644202D4Ab82F023c');
    expect(usd?.decimals).toBe(18);
    // 빌트인은 custom 표식이 없어야 한다 — 화면이 출처를 구분한다.
    expect(usd?.custom).toBeUndefined();
  });

  it('defaultTokenRegistry 는 항상 같은 인스턴스 — 셸과 어댑터 폴백의 결합점', async () => {
    const { defaultTokenRegistry } = await import('../src/tokens/registry.js');
    expect(defaultTokenRegistry()).toBe(defaultTokenRegistry());
  });

  it('addCustomToken 은 idempotent (동일 주소 재추가 시 no-op)', () => {
    const reg = new TokenRegistry();
    const cid = 424_242; // 빌트인 없는 합성 체인 — TTL 은 이제 66종이 내장이다
    reg.addCustomToken(cid, {
      address: '0xDEADBEEFcafebabeDEADBEEFcafebabeDEADBEEF',
      symbol: 'TST',
      name: 'Test Token',
      decimals: 18,
    });
    reg.addCustomToken(cid, {
      address: '0xdeadbeefcafebabedeadbeefcafebabedeadbeef', // 소문자
      symbol: 'TST2',
      name: 'Dup',
      decimals: 18,
    });
    const list = reg.getKnownTokens(cid);
    expect(list.length).toBe(1);
    expect(list[0]!.symbol).toBe('TST'); // 첫번째 등록만 유지
    expect(list[0]!.custom).toBe(true);
  });

  it('getToken 은 대소문자 무관 조회', () => {
    const reg = new TokenRegistry();
    const lower = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
    const hit = reg.getToken(BUILTIN_CHAIN_IDS.ethereum, lower);
    expect(hit?.symbol).toBe('USDC');
  });
});

describe('discoverTokens', () => {
  it('returns only positive balances, in original order', async () => {
    const adapter = makeAdapter();
    const reg = new TokenRegistry();
    // TTL chain 은 빈 — extraTokens 만으로 검증한다.
    const extra = [
      { address: '0xaaaa000000000000000000000000000000000001', symbol: 'A', name: 'A', decimals: 18 },
      { address: '0xaaaa000000000000000000000000000000000002', symbol: 'B', name: 'B', decimals: 18 },
      { address: '0xaaaa000000000000000000000000000000000003', symbol: 'C', name: 'C', decimals: 18 },
    ];
    patchReadContract(adapter, ({ address }) => {
      if (address.endsWith('1')) return 100n;
      if (address.endsWith('2')) return 0n; // 0 → 필터링
      if (address.endsWith('3')) return 500n;
      return 0n;
    });
    const out = await discoverTokens(
      adapter,
      reg,
      '0xcccccccccccccccccccccccccccccccccccccccc',
      { extraTokens: extra },
    );
    expect(out.map((r) => r.token.symbol)).toEqual(['A', 'C']);
    expect(out[0]!.balance).toBe(100n);
    expect(out[1]!.balance).toBe(500n);
  });

  it('caps RPC calls at maxRpcCalls', async () => {
    const adapter = makeAdapter();
    const reg = new TokenRegistry();
    const extra = Array.from({ length: 80 }, (_, i) => ({
      address: ('0xaaaa' + i.toString(16).padStart(36, '0')) as `0x${string}`,
      symbol: `T${i}`,
      name: `T${i}`,
      decimals: 18,
    }));
    let calls = 0;
    patchReadContract(adapter, () => {
      calls += 1;
      return 1n;
    });
    const out = await discoverTokens(
      adapter,
      reg,
      '0xcccccccccccccccccccccccccccccccccccccccc',
      { extraTokens: extra, maxRpcCalls: 50 },
    );
    expect(calls).toBe(50);
    expect(out.length).toBe(50);
  });

  it('swallows per-token RPC errors silently', async () => {
    const adapter = makeAdapter();
    const reg = new TokenRegistry();
    const extra = [
      { address: '0xaaaa000000000000000000000000000000000001', symbol: 'A', name: 'A', decimals: 18 },
      { address: '0xaaaa000000000000000000000000000000000002', symbol: 'B', name: 'B', decimals: 18 },
    ];
    patchReadContract(adapter, ({ address }) => {
      if (address.endsWith('1')) throw new Error('rpc 보이콧');
      return 10n;
    });
    const out = await discoverTokens(
      adapter,
      reg,
      '0xcccccccccccccccccccccccccccccccccccccccc',
      { extraTokens: extra },
    );
    expect(out.length).toBe(1);
    expect(out[0]!.token.symbol).toBe('B');
  });
});
