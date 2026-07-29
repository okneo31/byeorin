// evm-portable-tokens.test.ts — EvmAdapter 가 공통 토큰 인터페이스
// (`TokenCapableAdapter`) 를 지키는지.
//
// 전부 offline: tokens.test.ts 와 같은 방식으로 EvmAdapter.client.readContract 를
// monkey-patch 한다. 네트워크 호출은 하지 않는다.

import { describe, expect, it } from 'vitest';
import { avalanche } from 'viem/chains';
import { EvmAdapter, TTL_CHAIN } from '../src/index.js';
import { BUILTIN_CHAIN_IDS, TokenRegistry, type TokenInfo } from '../src/tokens/registry.js';
import { discoverTokens as discoverRegistryTokens } from '../src/tokens/discovery.js';
import {
  discoverPortableTokens,
  supportsTokens,
  type PortableTokenBalance,
} from '../src/tokens/portable.js';
import {
  EVM_TOKEN_SOURCE_BUILTIN,
  EVM_TOKEN_SOURCE_CUSTOM,
  type EvmAdapterOptions,
  type EvmTokenScanTruncation,
} from '../src/chains/evm.js';

const OWNER = '0xcccccccccccccccccccccccccccccccccccccccc';

// 빌트인이 하나도 없는 합성 체인. 예전에는 TTL(7777)이 그 역할이었는데,
// 이제 TTL 빌트인이 환율 스냅샷에서 66 종 생성되므로 "깨끗한 체인" 전제가
// 필요한 테스트는 전부 이쪽을 쓴다.
const CLEAN_CHAIN = { ...TTL_CHAIN, id: 424_242 };
const CLEAN_ID = CLEAN_CHAIN.id;

interface Patched {
  client: Record<string, unknown>;
}

type ReadArgs = { address: string; functionName: string; args?: unknown[] };

function patchReadContract(adapter: EvmAdapter, impl: (a: ReadArgs) => unknown): void {
  const p = adapter as unknown as Patched;
  p.client.readContract = async (a: ReadArgs) => impl(a);
}

function makeAdapter(opts: Partial<EvmAdapterOptions> = {}): EvmAdapter {
  return new EvmAdapter({ chain: CLEAN_CHAIN, ...opts });
}

function token(suffix: string, over: Partial<TokenInfo> = {}): TokenInfo {
  return {
    address: `0xaaaa${suffix.padStart(36, '0')}` as `0x${string}`,
    symbol: `T${suffix}`,
    name: `Token ${suffix}`,
    decimals: 18,
    ...over,
  };
}

describe('EvmAdapter — TokenCapableAdapter 적합성', () => {
  it('supportsTokens 가 어댑터를 토큰 조회 가능으로 인식한다', () => {
    expect(supportsTokens(makeAdapter())).toBe(true);
  });

  it('PortableTokenBalance 형식을 지킨다 (id=컨트랙트 주소, balance=bigint, source 표기)', async () => {
    const reg = new TokenRegistry();
    // addCustomToken 으로 넣은 토큰은 custom 으로 기록된다 → source 도 custom 표기.
    // 빌트인 표기는 아래 Avalanche 테스트에서 본다.
    const first0 = token('1');
    const second0 = token('2', { symbol: 'CUS', decimals: 6 });
    reg.addCustomToken(CLEAN_ID, first0);
    reg.addCustomToken(CLEAN_ID, second0);

    const adapter = makeAdapter({ tokenRegistry: reg });
    patchReadContract(adapter, ({ address }) => (address.endsWith('1') ? 100n : 250n));

    const out = await adapter.discoverTokens(OWNER);
    expect(out.length).toBe(2);

    const first = out[0] as PortableTokenBalance;
    expect(first.id).toBe(first0.address);
    expect(first.symbol).toBe('T1');
    expect(first.name).toBe('Token 1');
    expect(first.decimals).toBe(18);
    expect(first.balance).toBe(100n);
    expect(typeof first.balance).toBe('bigint');
    expect(first.source).toBe(EVM_TOKEN_SOURCE_CUSTOM);

    expect(out[1]!.decimals).toBe(6);
    expect(out[1]!.balance).toBe(250n);

    // portable.ts 자체 검증기를 통과해야 화면까지 살아서 간다.
    const viaPortable = await discoverPortableTokens(adapter, OWNER);
    expect(viaPortable.length).toBe(2);
  });

  it('빌트인이 있는 체인(Avalanche)에서 실제로 토큰이 나온다', async () => {
    const reg = new TokenRegistry();
    const builtins = reg.getKnownTokens(BUILTIN_CHAIN_IDS.avalanche);
    expect(builtins.length).toBeGreaterThan(0);

    const adapter = new EvmAdapter({ chain: avalanche, tokenRegistry: reg });
    // USDC 만 잔액이 있는 상황.
    const usdc = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
    patchReadContract(adapter, ({ address }) =>
      address.toLowerCase() === usdc.toLowerCase() ? 1_500_000n : 0n,
    );

    const out = await adapter.discoverTokens(OWNER);
    // 잔액 0 도 포함되므로 빌트인 전부가 나온다. USDC 만 잔액이 있다.
    expect(out.length).toBe(builtins.length);
    const found = out.find((t) => t.symbol === 'USDC')!;
    expect(found.id).toBe(usdc);
    expect(found.balance).toBe(1_500_000n);
    expect(out.filter((t) => t.balance > 0n)).toHaveLength(1);
    expect(out[0]!.decimals).toBe(6);
    expect(out[0]!.balance).toBe(1_500_000n);
    expect(out[0]!.source).toBe(EVM_TOKEN_SOURCE_BUILTIN);
  });

  it('레지스트리를 주입하지 않으면 빌트인만 보는 폴백을 쓴다', async () => {
    const adapter = new EvmAdapter({ chain: avalanche });
    patchReadContract(adapter, () => 7n);
    const out = await adapter.discoverTokens(OWNER);
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((t) => t.source === EVM_TOKEN_SOURCE_BUILTIN)).toBe(true);
  });

  it('decimals 가 정수가 아니거나 범위를 벗어난 항목은 버린다 (18 로 추측하지 않는다)', async () => {
    const reg = new TokenRegistry();
    reg.addCustomToken(CLEAN_ID, token('1', { decimals: 6.5 }));
    reg.addCustomToken(CLEAN_ID, token('2', { decimals: -1 }));
    reg.addCustomToken(CLEAN_ID, token('3', { decimals: 99 }));
    reg.addCustomToken(CLEAN_ID, token('4', { decimals: Number.NaN }));
    reg.addCustomToken(CLEAN_ID, token('5', { decimals: 8 }));

    const adapter = makeAdapter({ tokenRegistry: reg });
    patchReadContract(adapter, () => 42n);

    const out = await adapter.discoverTokens(OWNER);
    expect(out.map((t) => t.symbol)).toEqual(['T5']);
    expect(out[0]!.decimals).toBe(8);
  });

  it('모든 조회가 실패하면 빈 배열 (던지지 않는다)', async () => {
    const reg = new TokenRegistry();
    reg.addCustomToken(CLEAN_ID, token('1'));
    reg.addCustomToken(CLEAN_ID, token('2'));

    const adapter = makeAdapter({ tokenRegistry: reg });
    patchReadContract(adapter, () => {
      throw new Error('rpc down');
    });

    await expect(adapter.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  it('레지스트리 자체가 터져도 빈 배열', async () => {
    const broken = {
      getKnownTokens(): TokenInfo[] {
        throw new Error('registry 손상');
      },
    } as unknown as TokenRegistry;

    const adapter = makeAdapter({ tokenRegistry: broken });
    patchReadContract(adapter, () => 1n);

    await expect(adapter.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  // EVM 의 목록은 "레지스트리에 등록된 것" 이다. 잔액 0 을 빼면 화면에서 검색·
  // 가리기 대상이 통째로 사라지고, TTL 66 종 중 보유분만 남아 "무슨 토큰을 볼 수
  // 있나" 를 알 수 없게 된다. 0 을 감출지는 표시 단계가 정한다 — 체인의 사실과
  // 표시 정책을 섞지 않는다.
  it('잔액 0 도 포함한다 — 감추는 것은 화면의 판단이다', async () => {
    const reg = new TokenRegistry();
    reg.addCustomToken(CLEAN_ID, token('1'));
    reg.addCustomToken(CLEAN_ID, token('2'));

    const adapter = makeAdapter({ tokenRegistry: reg });
    patchReadContract(adapter, ({ address }) => (address.endsWith('1') ? 0n : 5n));

    const out = await adapter.discoverTokens(OWNER);
    expect(out.map((t) => t.symbol).sort()).toEqual(['T1', 'T2']);
    expect(out.find((t) => t.symbol === 'T1')!.balance).toBe(0n);
  });
});

describe('EvmAdapter — 토큰 스캔 상한', () => {
  it('상한을 넘으면 콜백으로 알린다 (조용히 자르지 않는다)', async () => {
    const reg = new TokenRegistry();
    for (let i = 1; i <= 5; i += 1) {
      reg.addCustomToken(CLEAN_ID, token(String(i)));
    }

    const seen: EvmTokenScanTruncation[] = [];
    const adapter = makeAdapter({
      tokenRegistry: reg,
      maxTokenScanCalls: 3,
      onTokenScanTruncated: (info) => {
        seen.push(info);
      },
    });
    let calls = 0;
    patchReadContract(adapter, () => {
      calls += 1;
      return 1n;
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(calls).toBe(3);
    expect(out.length).toBe(3);
    expect(seen).toEqual([{ chainId: CLEAN_ID, known: 5, scanned: 3 }]);
  });

  it('상한 안이면 콜백이 안 불린다', async () => {
    const reg = new TokenRegistry();
    reg.addCustomToken(CLEAN_ID, token('1'));

    let fired = 0;
    const adapter = makeAdapter({
      tokenRegistry: reg,
      onTokenScanTruncated: () => {
        fired += 1;
      },
    });
    patchReadContract(adapter, () => 1n);

    await adapter.discoverTokens(OWNER);
    expect(fired).toBe(0);
  });

  it('기본 상한은 TTL Scan 의 66 종을 자르지 않는다', async () => {
    const reg = new TokenRegistry();
    for (let i = 1; i <= 66; i += 1) {
      reg.addCustomToken(CLEAN_ID, token(String(i)));
    }

    let fired = 0;
    const adapter = makeAdapter({
      tokenRegistry: reg,
      onTokenScanTruncated: () => {
        fired += 1;
      },
    });
    patchReadContract(adapter, () => 1n);

    const out = await adapter.discoverTokens(OWNER);
    expect(out.length).toBe(66);
    expect(fired).toBe(0);
  });
});

describe('기존 discoverTokens(adapter, registry, ...) 회귀', () => {
  it('Avalanche 빌트인 보강 후에도 등록 순서와 양수 필터가 그대로다', async () => {
    const reg = new TokenRegistry();
    const adapter = new EvmAdapter({ chain: avalanche });
    const builtins = reg.getKnownTokens(BUILTIN_CHAIN_IDS.avalanche);
    patchReadContract(adapter, ({ address }) =>
      address === builtins[0]!.address || address === builtins[2]!.address ? 9n : 0n,
    );

    const out = await discoverRegistryTokens(adapter, reg, OWNER);
    expect(out.map((r) => r.token.symbol)).toEqual([
      builtins[0]!.symbol,
      builtins[2]!.symbol,
    ]);
    expect(out.every((r) => r.balance === 9n)).toBe(true);
  });

  it('includeZero 옵션은 여전히 0 잔액을 포함한다', async () => {
    const reg = new TokenRegistry();
    const adapter = new EvmAdapter({ chain: avalanche });
    patchReadContract(adapter, () => 0n);

    const zero = await discoverRegistryTokens(adapter, reg, OWNER, { includeZero: true });
    expect(zero.length).toBe(reg.getKnownTokens(BUILTIN_CHAIN_IDS.avalanche).length);

    const nonZero = await discoverRegistryTokens(adapter, reg, OWNER);
    expect(nonZero.length).toBe(0);
  });

  it('extraTokens 경로도 그대로 동작한다', async () => {
    const reg = new TokenRegistry();
    const adapter = makeAdapter();
    patchReadContract(adapter, ({ address }) => (address.endsWith('1') ? 3n : 0n));

    const out = await discoverRegistryTokens(adapter, reg, OWNER, {
      extraTokens: [token('1'), token('2')],
    });
    expect(out.map((r) => r.token.symbol)).toEqual(['T1']);
  });
});
