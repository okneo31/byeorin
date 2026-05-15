import {
  AccountAuthenticatorEd25519,
  Aptos,
  AptosConfig,
  Ed25519PublicKey,
  Ed25519Signature,
  Network,
  type AccountAuthenticator,
  type SimpleTransaction,
  generateSigningMessageForTransaction,
} from '@aptos-labs/ts-sdk';
import { sha3_256 } from '@noble/hashes/sha3';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type AptosNetwork = 'mainnet' | 'testnet' | 'devnet';

export interface AptosAdapterOptions {
  network?: AptosNetwork;
  fullnode?: string;
}

export interface AptosUnsignedTx {
  /** SimpleTransaction (BCS-serializable RawTransaction wrapper). */
  rawTxn: SimpleTransaction;
  /** Sender's 32-byte Ed25519 pubkey, required for authenticator assembly. */
  senderPubkey: Uint8Array;
}

export interface AptosSignedTx {
  /** The same SimpleTransaction (needed by `submit.simple`). */
  rawTxn: SimpleTransaction;
  /** Sender authenticator carrying pubkey+signature. */
  senderAuthenticator: AccountAuthenticator;
}

const NETWORK_MAP: Record<AptosNetwork, Network> = {
  mainnet: Network.MAINNET,
  testnet: Network.TESTNET,
  devnet: Network.DEVNET,
};

/**
 * AptosAdapter — Petra-compatible HD wallet adapter.
 *
 * Curve: Ed25519. Path: m/44'/637'/${account}'/0'/${index}' (BIP44 + hardened
 * sub-segments, matching Petra/Aptos CLI defaults).
 *
 * Address (a.k.a. authentication key) = sha3-256(pubkey || 0x00). The trailing
 * 0x00 is Aptos's scheme byte for single-signer Ed25519.
 *
 * Signing target: `generateSigningMessageForTransaction(rawTxn)` returns the
 * already-prefixed sha3-256 prehash that on-chain verifiers re-hash and verify
 * (domain separator: `APTOS::RawTransaction`). The SoftSigner signs the raw
 * 32-byte message — Aptos uses raw Ed25519 signature semantics where the inner
 * hash IS the message.
 */
export class AptosAdapter implements ChainAdapter<AptosUnsignedTx, AptosSignedTx> {
  readonly curve = 'ed25519' as const;
  readonly coinType = 637;
  readonly id: string;
  readonly displayName: string;
  readonly network: AptosNetwork;
  private readonly aptos: Aptos;

  constructor(opts: AptosAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `aptos:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'Aptos' : `Aptos ${this.network}`;
    const config = new AptosConfig({
      network: NETWORK_MAP[this.network],
      fullnode: opts.fullnode,
    });
    this.aptos = new Aptos(config);
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0'/${index}'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(
        `aptos: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`,
      );
    }
    // Aptos auth key for single Ed25519: sha3-256(pubkey32 || 0x00).
    // The 0x00 byte is the SigningScheme tag for Ed25519SingleKey.
    const buf = new Uint8Array(33);
    buf.set(pubkey, 0);
    buf[32] = 0x00;
    const digest = sha3_256(buf);
    return '0x' + bytesToHex(digest);
  }

  async getBalance(address: Address): Promise<bigint> {
    // Returns octas (1 APT = 1e8 octas) as a JS number — safe for any
    // realistic balance (~9e15 octas ≈ 9e7 APT supply ceiling).
    const octas = await this.aptos.getAccountAPTAmount({
      accountAddress: address,
    });
    return BigInt(octas);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<AptosUnsignedTx> {
    const senderPubkey = await ctx.signer.publicKey();
    if (senderPubkey.length !== 32) {
      throw new Error(
        `aptos: sender pubkey must be 32 bytes ed25519, got ${senderPubkey.length}`,
      );
    }
    const rawTxn = await this.aptos.transaction.build.simple({
      sender: ctx.sender,
      data: {
        function: '0x1::aptos_account::transfer',
        functionArguments: [intent.to, intent.amount],
      },
    });
    return { rawTxn, senderPubkey };
  }

  async signRequests(tx: AptosUnsignedTx): Promise<SignRequest[]> {
    // generateSigningMessageForTransaction returns the domain-prefixed bytes
    // that Ed25519 signs directly (Aptos applies sha3-256 inside its TX
    // prehash; the returned blob includes the `APTOS::RawTransaction`
    // domain separator). Ed25519 hashes internally — prehashed=false.
    return [
      {
        message: generateSigningMessageForTransaction(tx.rawTxn),
        prehashed: false,
      },
    ];
  }

  async applySignatures(
    tx: AptosUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<AptosSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`aptos: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 64) {
      throw new Error(
        `aptos: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    const senderAuthenticator: AccountAuthenticator =
      new AccountAuthenticatorEd25519(
        new Ed25519PublicKey(tx.senderPubkey),
        new Ed25519Signature(signature),
      );
    return { rawTxn: tx.rawTxn, senderAuthenticator };
  }

  async broadcast(tx: AptosSignedTx): Promise<TxHash> {
    const pending = await this.aptos.transaction.submit.simple({
      transaction: tx.rawTxn,
      senderAuthenticator: tx.senderAuthenticator,
    });
    return pending.hash;
  }
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += (b[i] as number).toString(16).padStart(2, '0');
  }
  return s;
}
