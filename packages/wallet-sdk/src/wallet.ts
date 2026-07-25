import { secp256k1 } from '@noble/curves/secp256k1';
import type { Address, TransferIntent, TxHash } from './types.js';
import type { ChainAdapter } from './chains/chain.js';
import { deriveEd25519, deriveSecp256k1 } from './crypto/hdkey.js';
import { isValidMnemonic, mnemonicToSeed, type WordlistName } from './crypto/seed.js';
import { SoftSigner } from './signers/soft.js';

export interface WalletAccount {
  address: Address;
  /**
   * BIP-32 파생 경로. 시드 기반 계정은 항상 채워진다.
   * raw private key 로 import 된 계정은 빈 문자열(`''`).
   * 호출자가 raw-import 인지 분기해야 할 때 본 필드의 `!== ''` 로 판단할 수 있다.
   */
  derivationPath: string;
  publicKey: Uint8Array;
  signer: SoftSigner;
  adapter: ChainAdapter;
}

export interface WalletOptions {
  mnemonic: string;
  passphrase?: string;
  wordlist?: WordlistName;
}

export class Wallet {
  private readonly seed: Uint8Array;

  private constructor(seed: Uint8Array) {
    this.seed = seed;
  }

  static fromMnemonic(opts: WalletOptions): Wallet {
    const wl = opts.wordlist ?? 'english';
    if (!isValidMnemonic(opts.mnemonic, wl)) {
      throw new Error('wallet: invalid mnemonic for selected wordlist');
    }
    return new Wallet(mnemonicToSeed(opts.mnemonic, opts.passphrase ?? ''));
  }

  account(adapter: ChainAdapter, account = 0, index = 0): WalletAccount {
    const path = adapter.derivationPath(account, index);
    const derived =
      adapter.curve === 'secp256k1'
        ? deriveSecp256k1(this.seed, path)
        : deriveEd25519(this.seed, path);
    const signer = new SoftSigner({ curve: adapter.curve, privateKey: derived.privateKey });
    const address = adapter.pubkeyToAddress(derived.publicKey);
    return {
      address,
      derivationPath: path,
      publicKey: derived.publicKey,
      signer,
      adapter,
    };
  }

  async transfer(acc: WalletAccount, intent: TransferIntent): Promise<TxHash> {
    return transferAccount(acc, intent);
  }
}

/**
 * 0x-prefix 가 있어도/없어도 받는 hex 문자열을 32바이트 Uint8Array 로 파싱.
 * 길이/문자 검증 + secp256k1 의 경우 0 < d < n 검증은 호출자가 수행.
 */
function hexToBytes32(hex: string): Uint8Array {
  let s = hex.trim();
  if (s.startsWith('0x') || s.startsWith('0X')) s = s.slice(2);
  if (s.length !== 64) {
    throw new Error(`wallet: privateKey hex must be 64 chars (32 bytes), got ${s.length}`);
  }
  if (!/^[0-9a-fA-F]+$/.test(s)) {
    throw new Error('wallet: privateKey hex contains non-hex characters');
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * 시드 파생 없이 32바이트 raw private key 로 WalletAccount 를 직접 만든다.
 *
 * 용도: MetaMask "Import Account" 와 동등한 단일 계정 import.
 *
 * 제약:
 *   - secp256k1 어댑터만 지원한다. EVM/BTC/XRP/Cosmos/TRON 모두 secp256k1 이므로
 *     실제 사용 케이스 대부분을 커버한다. Ed25519 raw-key import 는 사용 빈도가
 *     매우 낮아 v0.6 이후 백로그.
 *   - 키 검증은 @noble/curves 의 `isValidPrivateKey` (0 < d < n) 에 위임.
 *   - 반환 WalletAccount.derivationPath 는 빈 문자열 — caller 가 raw-import 임을 인지하는 sentinel.
 *
 * @example
 *   const acc = accountFromPrivateKey('0xac0974...', new EvmAdapter({ chain: TTL_CHAIN, rpcUrl }));
 *   await transferAccount(acc, { to, amount });
 */
export function accountFromPrivateKey(
  privateKey: Uint8Array | string,
  adapter: ChainAdapter,
): WalletAccount {
  if (adapter.curve !== 'secp256k1') {
    throw new Error(
      `wallet: accountFromPrivateKey supports secp256k1 only, got ${adapter.curve}`,
    );
  }
  const bytes = typeof privateKey === 'string' ? hexToBytes32(privateKey) : privateKey;
  if (bytes.length !== 32) {
    throw new Error(`wallet: privateKey must be 32 bytes, got ${bytes.length}`);
  }
  if (!secp256k1.utils.isValidPrivateKey(bytes)) {
    throw new Error('wallet: privateKey is out of secp256k1 valid range');
  }
  const signer = new SoftSigner({ curve: 'secp256k1', privateKey: bytes });
  const publicKey = secp256k1.getPublicKey(bytes, false);
  const address = adapter.pubkeyToAddress(publicKey);
  return {
    address,
    derivationPath: '',
    publicKey,
    signer,
    adapter,
  };
}

/**
 * WalletAccount 의 어댑터/시그너만 가지고 송금을 수행하는 자유 함수.
 *
 * Wallet 인스턴스(시드) 없이도 동작하므로 raw-key import 된 계정에 그대로 사용할 수 있다.
 * Wallet.transfer 도 본 함수를 호출한다 — 단일 경로 보장.
 */
export async function transferAccount(
  acc: WalletAccount,
  intent: TransferIntent,
): Promise<TxHash> {
  const unsigned = await acc.adapter.buildTransfer(intent, {
    sender: acc.address,
    signer: acc.signer,
  });
  const requests = await acc.adapter.signRequests(unsigned);
  const signatures: Uint8Array[] = [];
  for (const req of requests) {
    signatures.push(await acc.signer.sign(req.message));
  }
  const signed = await acc.adapter.applySignatures(unsigned, signatures);
  return acc.adapter.broadcast(signed);
}

/**
 * raw private key 를 0x-prefix 64자 hex 문자열로 직렬화.
 * export(키 노출) 흐름에서 사용.
 */
export function privateKeyToHex(privateKey: Uint8Array): string {
  if (privateKey.length !== 32) {
    throw new Error(`wallet: privateKey must be 32 bytes, got ${privateKey.length}`);
  }
  let s = '0x';
  for (let i = 0; i < 32; i++) {
    s += privateKey[i]!.toString(16).padStart(2, '0');
  }
  return s;
}
