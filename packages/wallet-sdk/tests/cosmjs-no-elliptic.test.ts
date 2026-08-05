import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// @cosmjs/crypto 는 wallet-sdk 의 직접 의존이 아니다(pnpm strict 로 직접 resolve 불가).
// 직접 의존인 @cosmjs/amino 를 앵커로 두 단계 createRequire 로 잡는다.
const r1 = createRequire(import.meta.url);
const r2 = createRequire(r1.resolve('@cosmjs/amino/package.json'));

interface CryptoPkg {
  version: string;
  dependencies: Record<string, string>;
}

interface Secp256k1Signature {
  readonly recovery: number;
  toFixedLength(): Uint8Array;
}

interface CosmjsCrypto {
  Secp256k1: {
    makeKeypair(privkey: Uint8Array): Promise<{ pubkey: Uint8Array; privkey: Uint8Array }>;
    createSignature(messageHash: Uint8Array, privkey: Uint8Array): Promise<Secp256k1Signature>;
    verifySignature(sig: Secp256k1Signature, messageHash: Uint8Array, pubkey: Uint8Array): Promise<boolean>;
    recoverPubkey(sig: Secp256k1Signature, messageHash: Uint8Array): Uint8Array;
    compressPubkey(pubkey: Uint8Array): Uint8Array;
  };
  Bip39: { mnemonicToSeed(mnemonic: unknown): Promise<Uint8Array> };
  EnglishMnemonic: new (s: string) => unknown;
  Slip10: {
    derivePath(curve: unknown, seed: Uint8Array, path: unknown): { privkey: Uint8Array; chainCode: Uint8Array };
  };
  Slip10Curve: { Secp256k1: unknown };
  stringToPath(input: string): unknown;
}

const pkg = r2('@cosmjs/crypto/package.json') as CryptoPkg;
const cosmjsCrypto = r2('@cosmjs/crypto') as CosmjsCrypto;

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('@cosmjs/crypto — elliptic 미유입', () => {
  it('런타임 그래프의 @cosmjs/crypto 는 0.34+ 이고 elliptic 을 의존하지 않는다', () => {
    const [major, minor] = pkg.version.split('.').map(Number);
    expect(major).toBe(0);
    expect(minor).toBeGreaterThanOrEqual(34);
    expect(Object.keys(pkg.dependencies)).not.toContain('elliptic');
    expect(Object.keys(pkg.dependencies)).toContain('@noble/curves');
  });

  // 아래 벡터는 @cosmjs/crypto 0.32.4(elliptic) 와 0.34.1(@noble/curves) 양쪽에서
  // 동일하게 나오는 것을 실측 확인한 값이다. 라이브러리 교체가 결과를 바꾸지 않음을 못박는다.
  it('Secp256k1 서명·Slip10 파생 벡터가 라이브러리 교체 전후로 동일하다', async () => {
    const { Secp256k1, Bip39, EnglishMnemonic, Slip10, Slip10Curve, stringToPath } = cosmjsCrypto;

    const priv = Uint8Array.from(Buffer.from('aa'.repeat(32), 'hex'));
    const msg = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode('byeorin')),
    );

    const kp = await Secp256k1.makeKeypair(priv);
    expect(hex(kp.pubkey)).toBe(
      '046a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3' +
        '36b6fbcb60b5b3d4f1551ac45e5ffc4936466e7d98f6c7c0ec736539f74691a6',
    );
    expect(hex(Secp256k1.compressPubkey(kp.pubkey))).toBe(
      '026a04ab98d9e4774ad806e302dddeb63bea16b5cb5f223ee77478e861bb583eb3',
    );

    const sig = await Secp256k1.createSignature(msg, priv);
    expect(hex(sig.toFixedLength())).toBe(
      '97cbd7b25466a27850a87477a8d94b741c6845f25e80a8c20c5ce43cb7ac6115' +
        '1c2ec21032d05ede073cbd1a04fabf710464fb1d57518f31d69f1d86099c796b' +
        '00',
    );
    expect(sig.recovery).toBe(0);
    expect(await Secp256k1.verifySignature(sig, msg, kp.pubkey)).toBe(true);
    expect(hex(Secp256k1.recoverPubkey(sig, msg))).toBe(hex(kp.pubkey));

    const seed = await Bip39.mnemonicToSeed(
      new EnglishMnemonic(
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      ),
    );
    const slip = Slip10.derivePath(Slip10Curve.Secp256k1, seed, stringToPath("m/44'/118'/0'/0/0"));
    expect(hex(slip.privkey)).toBe(
      'c4a48e2fce1481cd3294b4490f6678090ea98d3d0e5cd984558ab0968741b104',
    );
    expect(hex(slip.chainCode)).toBe(
      '6830de8ac352e82a28113a40d2a2f0e94500a3f244f090fec169283c0df1f2fc',
    );
  });
});
