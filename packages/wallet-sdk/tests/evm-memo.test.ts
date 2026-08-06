// evm-memo.test.ts — EvmAdapter 가 intent.memo 를 tx.data 로 싣는가.
//
// TTL 체인에는 메모 필드가 없다. 메모 = 평범한 송금 tx 의 data 에 실린 UTF-8
// 바이트다. 여기서 못박는 것 네 가지:
//   1) memo → data (encodeMemo 와 바이트가 같다)
//   2) memo 없으면 data 필드 자체가 없다 (빈 '0x' 도 안 넣는다)
//   3) 수신자가 컨트랙트면 거부 — 메모 바이트가 함수 호출로 해석된다
//   4) estimateGas 가 data 를 받는다 — 안 받으면 21,000 으로 OOG
//
// 라이브 RPC 를 두드리지 않기 위해 client 의 RPC 메서드만 monkey-patch 한다.

import { describe, expect, it } from 'vitest';
import { EvmAdapter, SoftSigner, TTL_CHAIN, encodeMemo } from '../src/index.js';
import type { Hex } from '../src/types.js';

const PRIV = new Uint8Array(32);
PRIV[31] = 1;

const SENDER = '0x0000000000000000000000000000000000000002';
const RECIPIENT = '0x0000000000000000000000000000000000000001';

interface Patched {
  /** estimateGas 가 마지막으로 받은 인자. data 누락을 잡기 위한 스파이. */
  lastEstimate: { data?: string } | null;
  /** getCode 호출 횟수 — 메모 없는 경로에서 왕복이 늘지 않았는지 확인. */
  codeCalls: number;
}

function patchClient(
  adapter: EvmAdapter,
  opts: { eip1559: boolean; code?: Hex; codeThrows?: boolean },
): Patched {
  const client = (adapter as unknown as { client: Record<string, unknown> }).client;
  const spy: Patched = { lastEstimate: null, codeCalls: 0 };
  client.getTransactionCount = async () => 0;
  client.getGasPrice = async () => 1_000_000_000n;
  client.estimateFeesPerGas = async () => ({
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  client.getBlock = async () => ({ baseFeePerGas: opts.eip1559 ? 1_000_000_000n : null });
  // 실제 노드처럼 data 크기에 따라 다른 값을 준다 — estimateGas 에 data 가
  // 안 들어가면 21000n 이 그대로 나와 시험이 실패한다.
  client.estimateGas = async (a: { data?: string }) => {
    spy.lastEstimate = a;
    return a.data ? 21_000n + BigInt((a.data.length - 2) / 2) * 40n : 21_000n;
  };
  // viem 의 getCode 는 '0x' 이면 undefined 를 준다.
  client.getCode = async () => {
    spy.codeCalls += 1;
    if (opts.codeThrows) throw new Error('rpc down');
    return opts.code && opts.code !== '0x' ? opts.code : undefined;
  };
  return spy;
}

function newAdapter(feeMode: 'legacy' | 'eip1559'): EvmAdapter {
  return new EvmAdapter({ chain: TTL_CHAIN, feeMode });
}

const signer = new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });
const ctx = { sender: SENDER, signer };

describe('EvmAdapter — memo → tx.data', () => {
  it('memo 가 encodeMemo 결과 그대로 data 에 실린다 (legacy)', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false });
    const unsigned = await adapter.buildTransfer(
      { to: RECIPIENT, amount: 1n, memo: '계약금 3차' },
      ctx,
    );
    expect(unsigned.type).toBe('legacy');
    expect((unsigned as { data?: unknown }).data).toBe(encodeMemo('계약금 3차'));
    // to·value 는 그대로 — 메모는 수신자도 금액도 바꾸지 않는다.
    expect(unsigned.to?.toLowerCase()).toBe(RECIPIENT);
    expect(unsigned.value).toBe(1n);
  });

  it('memo 가 data 에 실린다 (eip1559)', async () => {
    const adapter = newAdapter('eip1559');
    patchClient(adapter, { eip1559: true });
    const unsigned = await adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: '한글 메모' }, ctx);
    expect(unsigned.type).toBe('eip1559');
    expect((unsigned as { data?: unknown }).data).toBe(encodeMemo('한글 메모'));
  });

  it('memo 없으면 data 필드가 아예 없다 — 빈 0x 도 안 넣는다', async () => {
    const adapter = newAdapter('legacy');
    const spy = patchClient(adapter, { eip1559: false });
    const unsigned = await adapter.buildTransfer({ to: RECIPIENT, amount: 1n }, ctx);
    expect('data' in unsigned).toBe(false);
    expect(spy.lastEstimate?.data).toBeUndefined();
  });

  it('빈 문자열 memo 는 메모 없음과 같다 (data 없음)', async () => {
    const adapter = newAdapter('legacy');
    const spy = patchClient(adapter, { eip1559: false });
    const unsigned = await adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: '' }, ctx);
    expect('data' in unsigned).toBe(false);
    expect(spy.codeCalls).toBe(0);
  });

  it('가스 추정에 data 가 들어간다 — 빠지면 OOG 로 죽는다', async () => {
    const adapter = newAdapter('legacy');
    const spy = patchClient(adapter, { eip1559: false });
    const memo = 'a'.repeat(1000);
    const unsigned = await adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo }, ctx);
    expect(spy.lastEstimate?.data).toBe(encodeMemo(memo));
    expect(unsigned.gas).toBe(21_000n + 1000n * 40n);
  });

  it('규칙 위반 메모는 던진다 (1 바이트)', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false });
    await expect(adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: 'a' }, ctx)).rejects.toThrow(
      /규칙 위반/,
    );
  });
});

describe('EvmAdapter — 수신자 컨트랙트 차단', () => {
  it('수신자가 컨트랙트면 거부한다', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false, code: '0x60806040' });
    await expect(
      adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: '안녕하세요' }, ctx),
    ).rejects.toThrow(/컨트랙트다/);
  });

  it('getCode 가 실패하면 fail-closed — 조용히 보내지 않는다', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false, codeThrows: true });
    await expect(
      adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: '안녕하세요' }, ctx),
    ).rejects.toThrow(/확인하지 못했다/);
  });

  it('메모 없는 송금은 getCode 를 아예 부르지 않는다 (RPC 왕복 증가 0)', async () => {
    const adapter = newAdapter('legacy');
    const spy = patchClient(adapter, { eip1559: false, code: '0x60806040' });
    await adapter.buildTransfer({ to: RECIPIENT, amount: 1n }, ctx);
    expect(spy.codeCalls).toBe(0);
  });

  it('메모 있는 송금은 getCode 를 1회 부른다', async () => {
    const adapter = newAdapter('legacy');
    const spy = patchClient(adapter, { eip1559: false });
    await adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: '메모' }, ctx);
    expect(spy.codeCalls).toBe(1);
  });
});

describe('EvmAdapter — memo 배타 규칙 (tx.data 는 한 칸뿐이다)', () => {
  const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  it('memo + data 는 던진다', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false });
    await expect(
      adapter.buildTransfer(
        { to: RECIPIENT, amount: 0n, memo: '메모', data: '0xa9059cbb' as Hex },
        ctx,
      ),
    ).rejects.toThrow(/함께 쓸 수 없다/);
  });

  it('memo + asset(ERC-20) 은 던진다', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false });
    await expect(
      adapter.buildTransfer({ to: RECIPIENT, amount: 1n, memo: '메모', asset: TOKEN }, ctx),
    ).rejects.toThrow(/ERC-20/);
  });

  it('asset 만(메모 없음)은 기존대로 성공한다 — 회귀 방지', async () => {
    const adapter = newAdapter('legacy');
    patchClient(adapter, { eip1559: false });
    const unsigned = await adapter.buildTransfer({ to: RECIPIENT, amount: 1n, asset: TOKEN }, ctx);
    expect(unsigned.to?.toLowerCase()).toBe(TOKEN);
    expect(unsigned.value).toBe(0n);
    expect((unsigned as { data?: string }).data?.startsWith('0xa9059cbb')).toBe(true);
  });
});
