import { describe, expect, it } from 'vitest';
import { Wallet } from '../src/index.js';
import { CosmosAdapter } from '../src/chains/cosmos.js';
import {
  DEFAULT_CHAINS,
  ZION_CHAIN_SPEC,
  findChainSpec,
} from '../src/multichain.js';

// BIP39 표준 테스트 벡터.
const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

describe('ZION chain spec', () => {
  it('is registered in DEFAULT_CHAINS', () => {
    const zion = DEFAULT_CHAINS.find((c) => c.key === 'cosmos:zion');
    expect(zion).toBeDefined();
    expect(zion).toBe(ZION_CHAIN_SPEC);
  });

  it('findChainSpec resolves cosmos:zion', () => {
    expect(findChainSpec('cosmos:zion')).toBe(ZION_CHAIN_SPEC);
  });

  it('ZION_CHAIN_SPEC has secp256k1 curve and Zion display name', () => {
    expect(ZION_CHAIN_SPEC.curve).toBe('secp256k1');
    expect(ZION_CHAIN_SPEC.displayName).toBe('Zion');
    expect(ZION_CHAIN_SPEC.key).toBe('cosmos:zion');
  });

  it('builds a CosmosAdapter wired to ZION Phase 1 values', () => {
    const adapter = ZION_CHAIN_SPEC.build() as CosmosAdapter;
    expect(adapter).toBeInstanceOf(CosmosAdapter);
    expect(adapter.chainId).toBe('zion');
    expect(adapter.bech32Prefix).toBe('zion');
    expect(adapter.rpcUrl).toBe('https://rpc.zion1.top');
    expect(adapter.denom).toBe('utrg');
    expect(adapter.decimals).toBe(6);
    expect(adapter.coinType).toBe(118);
    // Phase 1: 수수료 AnteHandler 미와이어업 → fee 0.
    expect(adapter.defaultFee).toBe(0n);
    // gas_limit 은 ZION 명세 권장값(200_000)과 CosmosAdapter 기본값이 일치.
    expect(adapter.defaultGas).toBe(200_000);
    // ZION 은 classic Cosmos 주소 — Ethermint(evmAddressing) 아님.
    expect(adapter.evmAddressing).toBe(false);
  });
});

describe('ZION account derivation', () => {
  const adapter = ZION_CHAIN_SPEC.build();

  it('uses the standard Cosmos derivation path (coin type 118)', () => {
    expect(adapter.derivationPath()).toBe("m/44'/118'/0'/0/0");
  });

  it('derives a zion1... bech32 address from a mnemonic', () => {
    const wallet = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = wallet.account(adapter);
    // ZION 계정 주소는 bech32, HRP 'zion'.
    expect(acc.address.startsWith('zion1')).toBe(true);
    // classic Cosmos: ripemd160(sha256(pubkey)) = 20바이트 → bech32 길이 39자 근방.
    expect(acc.address.length).toBeGreaterThanOrEqual(39);
    expect(acc.derivationPath).toBe("m/44'/118'/0'/0/0");
  });

  it('derivation is deterministic — same mnemonic → same zion address', () => {
    const a1 = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC }).account(adapter);
    const a2 = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC }).account(adapter);
    expect(a1.address).toBe(a2.address);
  });

  it('shares the same key as other coin-type-118 Cosmos chains', () => {
    // ZION 은 표준 Cosmos coin type 118 — 동일 니모닉이면 ATOM/OSMO 와 같은
    // 공개키에서 파생된다 (HRP 만 다름). publicKey 바이트 일치로 확인.
    // (ZION 노드 자체의 표준 Cosmos 동작은 Keplr 연동으로 이미 검증됨 — 본 스위트는
    //  우리 CosmosAdapter 설정이 ZION 값과 일치하는지만 본다.)
    const zionAcc = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC }).account(adapter);
    const cosmosHub = new CosmosAdapter({
      chainId: 'cosmoshub-4',
      bech32Prefix: 'cosmos',
      rpcUrl: 'https://example.invalid',
      denom: 'uatom',
    });
    const atomAcc = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC }).account(cosmosHub);
    expect(zionAcc.publicKey).toEqual(atomAcc.publicKey);
    // 주소는 HRP 가 달라 다르게 나온다.
    expect(zionAcc.address.startsWith('zion1')).toBe(true);
    expect(atomAcc.address.startsWith('cosmos1')).toBe(true);
  });
});
