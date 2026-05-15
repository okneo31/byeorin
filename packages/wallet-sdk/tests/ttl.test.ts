import { describe, expect, it } from 'vitest';
import {
  EvmAdapter,
  TTL_CHAIN,
  Wallet,
  createMnemonic,
  isValidMnemonic,
  mnemonicToSeed,
} from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

describe('seed', () => {
  it('generates a 12-word english mnemonic', () => {
    const m = createMnemonic(128, 'english');
    expect(m.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(m)).toBe(true);
  });

  it('generates a 12-word korean mnemonic', () => {
    const m = createMnemonic(128, 'korean');
    expect(m.split(' ')).toHaveLength(12);
    expect(isValidMnemonic(m, 'korean')).toBe(true);
  });

  it('derives deterministic seed from a known mnemonic', () => {
    const seed1 = mnemonicToSeed(KNOWN_MNEMONIC);
    const seed2 = mnemonicToSeed(KNOWN_MNEMONIC);
    expect(seed1).toEqual(seed2);
    expect(seed1.length).toBe(64);
  });
});

describe('TTL chain (live RPC)', () => {
  const ttl = new EvmAdapter({ chain: TTL_CHAIN });

  it('uses Chain ID 7777', () => {
    expect(ttl.chain.id).toBe(7777);
    expect(ttl.id).toBe('evm:7777');
  });

  it('derives an account from mnemonic on the standard EVM path', () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ttl);
    expect(acc.derivationPath).toBe("m/44'/60'/0'/0/0");
    expect(acc.address).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(acc.address.toLowerCase()).toBe(
      '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
    );
  });

  it('fetches balance from the live TTL RPC', async () => {
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ttl);
    const bal = await ttl.getBalance(acc.address);
    expect(typeof bal).toBe('bigint');
    expect(bal >= 0n).toBe(true);
  });
});
