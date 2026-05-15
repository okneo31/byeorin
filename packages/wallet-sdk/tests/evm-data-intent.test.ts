// evm-data-intent.test.ts — TransferIntent.data 필드 전파 검증.
//
// EvmAdapter.buildTransfer 가 intent.data 를 unsigned tx 의 data 필드로 그대로
// 옮겨담는지 확인한다. 본 동작은 v0.3 의 contract-call 지원(eth_sendTransaction
// with data) 의 SDK 측 기반.
//
// 라이브 RPC 를 두드리지 않기 위해 client 의 RPC 메서드(getTransactionCount,
// estimateFeesPerGas/getGasPrice, estimateGas, getBlock) 만 monkey-patch 한다.
// (broadcast 는 본 테스트의 관심 밖.)

import { describe, expect, it } from 'vitest';
import { EvmAdapter, SoftSigner, TTL_CHAIN } from '../src/index.js';
import type { Hex } from '../src/types.js';

// 결정성을 위해 고정 키.
const PRIV = new Uint8Array(32);
PRIV[31] = 1;

function patchClient(adapter: EvmAdapter, opts: { eip1559: boolean }): void {
  // 어댑터 내부의 private `client` 를 우회적으로 가져온다 — 테스트 한정 패치.
  const client = (adapter as unknown as { client: Record<string, unknown> }).client;
  client.getTransactionCount = async () => 0;
  client.estimateGas = async () => 21000n;
  client.getGasPrice = async () => 1_000_000_000n;
  client.estimateFeesPerGas = async () => ({
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  client.getBlock = async () => ({
    baseFeePerGas: opts.eip1559 ? 1_000_000_000n : null,
  });
}

describe('EvmAdapter — TransferIntent.data 필드 전파', () => {
  it('data 미지정 시 unsigned tx 에 data 필드가 없어야 한다(legacy)', async () => {
    const adapter = new EvmAdapter({ chain: TTL_CHAIN, feeMode: 'legacy' });
    patchClient(adapter, { eip1559: false });
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });

    const unsigned = await adapter.buildTransfer(
      { to: '0x0000000000000000000000000000000000000001', amount: 1n },
      { sender: '0x0000000000000000000000000000000000000002', signer },
    );
    expect(unsigned.type).toBe('legacy');
    expect((unsigned as { data?: unknown }).data).toBeUndefined();
  });

  it("data='0x' 도 미지정과 동일하게 취급한다", async () => {
    const adapter = new EvmAdapter({ chain: TTL_CHAIN, feeMode: 'legacy' });
    patchClient(adapter, { eip1559: false });
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });

    const unsigned = await adapter.buildTransfer(
      {
        to: '0x0000000000000000000000000000000000000001',
        amount: 0n,
        data: '0x' as Hex,
      },
      { sender: '0x0000000000000000000000000000000000000002', signer },
    );
    expect((unsigned as { data?: unknown }).data).toBeUndefined();
  });

  it('명시된 data 를 그대로 unsigned tx 에 전파(legacy)', async () => {
    const adapter = new EvmAdapter({ chain: TTL_CHAIN, feeMode: 'legacy' });
    patchClient(adapter, { eip1559: false });
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });

    // ERC-20 transfer(address,uint256) 셀렉터 + 인자
    const calldata =
      '0xa9059cbb000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0000000000000000000000000000000000000000000000000de0b6b3a7640000' as Hex;
    const unsigned = await adapter.buildTransfer(
      {
        to: '0x0000000000000000000000000000000000000abc',
        amount: 0n,
        data: calldata,
      },
      { sender: '0x0000000000000000000000000000000000000002', signer },
    );
    expect((unsigned as { data?: unknown }).data).toBe(calldata);
  });

  it('명시된 data 를 그대로 unsigned tx 에 전파(eip1559)', async () => {
    const adapter = new EvmAdapter({ chain: TTL_CHAIN, feeMode: 'eip1559' });
    patchClient(adapter, { eip1559: true });
    const signer = new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });

    const calldata =
      '0x095ea7b3000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff' as Hex;
    const unsigned = await adapter.buildTransfer(
      {
        to: '0x0000000000000000000000000000000000000abc',
        amount: 0n,
        data: calldata,
      },
      { sender: '0x0000000000000000000000000000000000000002', signer },
    );
    expect(unsigned.type).toBe('eip1559');
    expect((unsigned as { data?: unknown }).data).toBe(calldata);
  });
});
