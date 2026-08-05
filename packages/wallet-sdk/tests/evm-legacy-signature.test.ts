// evm-legacy-signature.test.ts — EvmAdapter.applySignatures 의 recovery 바이트 정규화.
//
// SoftSigner 는 65바이트 서명의 마지막 바이트에 raw recovery(0|1) 를 넣는다
// (signers/soft.ts:51). 그걸 그대로 viem 의 parseSignature 에 넘기면 `v` 없이
// `yParity` 만 채워지고, legacy 직렬화는 yParity 를 읽지 않고 `35n + v` 를
// 계산해 `Cannot mix BigInt and other types` 로 죽는다. eip1559 는 yParity 를
// 인정해서 살아남을 뿐이다.
//
// 네트워크 접근 0건 — applySignatures 는 client 를 쓰지 않는다. 테스트 5 만
// buildTransfer 를 거치므로 그때만 client 를 monkey-patch 한다.

import { describe, expect, it } from 'vitest';
import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EvmAdapter, SoftSigner, TTL_CHAIN } from '../src/index.js';
import type { EvmUnsignedTx } from '../src/chains/evm.js';

const PRIV = new Uint8Array(32).fill(0xa1);
const PRIV_HEX = `0x${Buffer.from(PRIV).toString('hex')}` as Hex;
const EXPECTED = privateKeyToAccount(PRIV_HEX).address;
const CHAIN_ID = TTL_CHAIN.id;
const NONCES = [0, 1, 2, 3, 4, 5];

function newAdapter(feeMode?: 'legacy' | 'eip1559'): EvmAdapter {
  // 생성자는 RPC 를 열지 않는다(http() 는 지연).
  return new EvmAdapter(feeMode ? { chain: TTL_CHAIN, feeMode } : { chain: TTL_CHAIN });
}

function newSigner(): SoftSigner {
  return new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });
}

function legacyTx(nonce: number): EvmUnsignedTx {
  return {
    type: 'legacy',
    chainId: CHAIN_ID,
    nonce,
    to: '0x2222222222222222222222222222222222222222',
    value: 1n,
    gas: 21_000n,
    gasPrice: 1_000_000_000n,
  };
}

function eip1559Tx(nonce: number): EvmUnsignedTx {
  return {
    type: 'eip1559',
    chainId: CHAIN_ID,
    nonce,
    to: '0x2222222222222222222222222222222222222222',
    value: 1n,
    gas: 21_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1n,
  };
}

async function signTx(adapter: EvmAdapter, tx: EvmUnsignedTx): Promise<Uint8Array> {
  const reqs = await adapter.signRequests(tx);
  return newSigner().sign(reqs[0]!.message);
}

describe('EvmAdapter.applySignatures — recovery 바이트 정규화', () => {
  it.each(NONCES)('legacy round-trip: 서명 → applySignatures → 원 주소 복구 (nonce %i)', async (nonce) => {
    const adapter = newAdapter();
    const tx = legacyTx(nonce);
    const sig65 = await signTx(adapter, tx);
    // 서명자가 raw recovery(0|1) 를 준다는 사실 자체를 고정한다.
    expect(sig65[64]!).toBeLessThan(2);

    const { raw, hash } = await adapter.applySignatures(tx, [sig65]);
    expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(EXPECTED);
    expect(hash).toBe(keccak256(raw));
    // EIP-155: v = chainId*2 + 35 + yParity
    expect(parseTransaction(raw).v).toBe(BigInt(CHAIN_ID) * 2n + 35n + BigInt(sig65[64]!));
  });

  it.each(NONCES)('eip1559 round-trip 은 그대로 유지 (nonce %i)', async (nonce) => {
    const adapter = newAdapter();
    const tx = eip1559Tx(nonce);
    const sig65 = await signTx(adapter, tx);
    const { raw, hash } = await adapter.applySignatures(tx, [sig65]);
    expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(EXPECTED);
    expect(hash).toBe(keccak256(raw));
  });

  it('HW 스타일 v=27|28 도 같은 raw 를 낸다 (legacy·eip1559)', async () => {
    const adapter = newAdapter();
    for (const tx of [legacyTx(3), eip1559Tx(3)]) {
      const sig65 = await signTx(adapter, tx);
      const hw = new Uint8Array(sig65);
      hw[64] = sig65[64]! + 27;
      const soft = await adapter.applySignatures(tx, [sig65]);
      const hwOut = await adapter.applySignatures(tx, [hw]);
      expect(hwOut.raw).toBe(soft.raw);
    }
  });

  it.each([2, 26, 29, 255])('잘못된 recovery 바이트 %i 는 시끄럽게 거절', async (byte) => {
    const adapter = newAdapter();
    const tx = legacyTx(0);
    const sig65 = await signTx(adapter, tx);
    const bad = new Uint8Array(sig65);
    bad[64] = byte;
    await expect(adapter.applySignatures(tx, [bad])).rejects.toThrow(
      /recovery byte must be 0\|1\|27\|28/,
    );
  });

  it("feeMode:'legacy' 어댑터의 buildTransfer → applySignatures 전 구간", async () => {
    const adapter = newAdapter('legacy');
    const client = (adapter as unknown as { client: Record<string, unknown> }).client;
    client.getTransactionCount = async () => 7;
    client.estimateGas = async () => 21_000n;
    client.getGasPrice = async () => 1_000_000_000n;

    const signer = newSigner();
    const tx = await adapter.buildTransfer(
      { to: '0x2222222222222222222222222222222222222222', amount: 1n },
      { sender: EXPECTED, signer },
    );
    expect(tx.type).toBe('legacy');

    const reqs = await adapter.signRequests(tx);
    const sig65 = await signer.sign(reqs[0]!.message);
    const { raw } = await adapter.applySignatures(tx, [sig65]);
    expect(await recoverTransactionAddress({ serializedTransaction: raw })).toBe(EXPECTED);
  });
});
