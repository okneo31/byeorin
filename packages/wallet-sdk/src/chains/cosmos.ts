import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { secp256k1 } from '@noble/curves/secp256k1';
import { toBase64, toBech32 } from '@cosmjs/encoding';
import {
  encodePubkey,
  makeAuthInfoBytes,
  makeSignBytes,
  makeSignDoc,
  Registry,
} from '@cosmjs/proto-signing';
import { defaultRegistryTypes, StargateClient } from '@cosmjs/stargate';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

export interface CosmosAdapterOptions {
  /** Bech32 chain id, e.g. 'cosmoshub-4', 'osmosis-1', 'celestia', 'pacific-1', 'injective-1'. */
  chainId: string;
  /** Bech32 HRP, e.g. 'cosmos', 'osmo', 'celestia', 'sei', 'inj'. */
  bech32Prefix: string;
  /** Tendermint/CometBFT RPC endpoint. */
  rpcUrl: string;
  /** Base denomination, e.g. 'uatom', 'uosmo', 'utia', 'usei', 'inj'. */
  denom: string;
  /** Number of decimals for the base denom. Default 6. */
  decimals?: number;
  /** SLIP-44 coin type. Default 118; 60 for Injective/Evmos-style chains. */
  coinType?: number;
  /** Optional override of default gas limit (default 200_000). */
  defaultGas?: number;
  /** Optional override of default fee amount in `denom` (default 5000). */
  defaultFee?: bigint;
}

/**
 * A minimal stand-in for cosmjs-types `SignDoc`. We never need to construct
 * one directly — we get it from `makeSignDoc(...)` and pass it to
 * `makeSignBytes(...)`. Typing this loosely keeps cosmjs-types out of our
 * direct dependency graph (pnpm hides transitive deps).
 */
type SignDocLike = ReturnType<typeof makeSignDoc>;

export interface CosmosUnsignedTx {
  signDoc: SignDocLike;
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  chainId: string;
  accountNumber: number;
  signerInfo: {
    pubKey: Uint8Array;
    address: string;
  };
}

export interface CosmosSignedTx {
  txBytes: Uint8Array;
  hash: string;
}

const SECP256K1_PUBKEY_TYPE = 'tendermint/PubKeySecp256k1';
const MSG_SEND_TYPE_URL = '/cosmos.bank.v1beta1.MsgSend';

/**
 * Multi-chain Cosmos SDK adapter. Stays non-custodial: signing happens in the
 * Signer (HW or SoftSigner) — we only build & broadcast.
 */
export class CosmosAdapter
  implements ChainAdapter<CosmosUnsignedTx, CosmosSignedTx>
{
  readonly id: string;
  readonly displayName: string;
  readonly curve = 'secp256k1' as const;
  readonly coinType: number;
  readonly chainId: string;
  readonly bech32Prefix: string;
  readonly rpcUrl: string;
  readonly denom: string;
  readonly decimals: number;
  readonly defaultGas: number;
  readonly defaultFee: bigint;

  private readonly registry: Registry;

  constructor(opts: CosmosAdapterOptions) {
    this.chainId = opts.chainId;
    this.bech32Prefix = opts.bech32Prefix;
    this.rpcUrl = opts.rpcUrl;
    this.denom = opts.denom;
    this.decimals = opts.decimals ?? 6;
    this.coinType = opts.coinType ?? 118;
    this.defaultGas = opts.defaultGas ?? 200_000;
    this.defaultFee = opts.defaultFee ?? 5000n;
    this.id = `cosmos:${opts.chainId}`;
    this.displayName = opts.chainId;
    // defaultRegistryTypes contains MsgSend, MsgMultiSend, staking, gov, ibc, etc.
    this.registry = new Registry(defaultRegistryTypes);
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  /**
   * Convert a 33-byte compressed secp256k1 pubkey to a bech32 address:
   *   addr = bech32(prefix, ripemd160(sha256(pubkey)))
   *
   * Accepts uncompressed (65-byte) or raw (64-byte) pubkeys too — they're
   * compressed first to match the Cosmos convention.
   */
  pubkeyToAddress(pubkey: Uint8Array): Address {
    const compressed = toCompressedSecp256k1(pubkey);
    const rawAddr = ripemd160(sha256(compressed));
    return toBech32(this.bech32Prefix, rawAddr);
  }

  async getBalance(address: Address): Promise<bigint> {
    const client = await StargateClient.connect(this.rpcUrl);
    try {
      const coin = await client.getBalance(address, this.denom);
      return BigInt(coin.amount);
    } finally {
      client.disconnect();
    }
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<CosmosUnsignedTx> {
    const senderPubkeyRaw = await ctx.signer.publicKey();
    const pubKey = toCompressedSecp256k1(senderPubkeyRaw);
    const sender = ctx.sender;

    // 1. Fetch account info (sequence, accountNumber).
    const client = await StargateClient.connect(this.rpcUrl);
    let accountNumber: number;
    let sequence: number;
    try {
      const account = await client.getAccount(sender);
      if (!account) {
        throw new Error(
          `cosmos: account ${sender} not found on ${this.chainId} ` +
            `(needs at least one inbound tx to exist on-chain)`,
        );
      }
      accountNumber = account.accountNumber;
      sequence = account.sequence;
    } finally {
      client.disconnect();
    }

    // 2. Build TxBody with MsgSend, via Registry so we don't import cosmjs-types directly.
    const bodyBytes = this.registry.encodeTxBody({
      messages: [
        {
          typeUrl: MSG_SEND_TYPE_URL,
          value: {
            fromAddress: sender,
            toAddress: intent.to,
            amount: [{ denom: this.denom, amount: intent.amount.toString() }],
          },
        },
      ],
      memo: intent.memo ?? '',
    });

    // 3. Encode the pubkey as Any and build AuthInfo (default SIGN_MODE_DIRECT).
    const pubkeyAny = encodePubkey({
      type: SECP256K1_PUBKEY_TYPE,
      value: toBase64(pubKey),
    });
    const authInfoBytes = makeAuthInfoBytes(
      [{ pubkey: pubkeyAny, sequence }],
      [{ denom: this.denom, amount: this.defaultFee.toString() }],
      this.defaultGas,
      undefined,
      undefined,
    );

    // 4. Build SignDoc (object holding the four sign components).
    const signDoc = makeSignDoc(
      bodyBytes,
      authInfoBytes,
      this.chainId,
      accountNumber,
    );

    return {
      signDoc,
      bodyBytes,
      authInfoBytes,
      chainId: this.chainId,
      accountNumber,
      signerInfo: { pubKey, address: sender },
    };
  }

  /**
   * Returns the 32-byte sha256 digest of the canonical SignDoc bytes.
   *
   * Why: cosmjs `makeSignBytes(signDoc)` returns the SignDoc proto bytes,
   * but the actual ECDSA signature is computed over `sha256(makeSignBytes(...))`
   * (see cosmos-sdk SIGN_MODE_DIRECT). Our SoftSigner.sign() applies ECDSA
   * directly on whatever bytes we give it, so we must pre-hash here. If we
   * returned the raw SignDoc bytes, the Signer would hash them a second time
   * (noble's secp256k1.sign hashes the input) — wrong.
   *
   * Hardware signers that follow the same "sign whatever I'm given" contract
   * will produce a correct signature for Cosmos thanks to this pre-hash.
   */
  async serializeForSigning(tx: CosmosUnsignedTx): Promise<Uint8Array> {
    const signBytes = makeSignBytes(tx.signDoc);
    return sha256(signBytes);
  }

  /**
   * Cosmos signatures are 64 bytes (r||s). SoftSigner produces 65 bytes
   * (compact 64 + 1 recovery byte). We strip the recovery byte and normalize
   * to low-S — Cosmos chains reject high-S sigs. noble already gives lowS by
   * default, but we defend-in-depth for HW signers.
   */
  async applySignature(
    tx: CosmosUnsignedTx,
    signature: Uint8Array,
  ): Promise<CosmosSignedTx> {
    let sig64: Uint8Array;
    if (signature.length === 65) {
      sig64 = signature.slice(0, 64);
    } else if (signature.length === 64) {
      sig64 = signature;
    } else {
      throw new Error(
        `cosmos: signature must be 64 or 65 bytes, got ${signature.length}`,
      );
    }
    sig64 = normalizeLowS(sig64);

    const txBytes = encodeTxRaw(tx.bodyBytes, tx.authInfoBytes, [sig64]);
    const hash = bytesToHexUpper(sha256(txBytes));
    return { txBytes, hash };
  }

  async broadcast(tx: CosmosSignedTx): Promise<TxHash> {
    const client = await StargateClient.connect(this.rpcUrl);
    try {
      const result = await client.broadcastTx(tx.txBytes);
      return result.transactionHash;
    } finally {
      client.disconnect();
    }
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function toCompressedSecp256k1(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) {
    return pubkey;
  }
  if (pubkey.length === 65 && pubkey[0] === 0x04) {
    return secp256k1.ProjectivePoint.fromHex(pubkey).toRawBytes(true);
  }
  if (pubkey.length === 64) {
    const tagged = new Uint8Array(65);
    tagged[0] = 0x04;
    tagged.set(pubkey, 1);
    return secp256k1.ProjectivePoint.fromHex(tagged).toRawBytes(true);
  }
  throw new Error(`cosmos: bad pubkey length=${pubkey.length}`);
}

function normalizeLowS(sig64: Uint8Array): Uint8Array {
  const sig = secp256k1.Signature.fromCompact(sig64);
  const normalized = sig.normalizeS();
  return normalized.toCompactRawBytes();
}

function bytesToHexUpper(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] as number).toString(16).padStart(2, '0');
  }
  return s.toUpperCase();
}

/**
 * Hand-rolled protobuf encoder for `cosmos.tx.v1beta1.TxRaw`:
 *
 *   message TxRaw {
 *     bytes body_bytes = 1;
 *     bytes auth_info_bytes = 2;
 *     repeated bytes signatures = 3;
 *   }
 *
 * We do this manually because cosmjs-types isn't a direct dep of this package
 * under pnpm (it's a transitive dep of @cosmjs/proto-signing). TxRaw has only
 * three "length-delimited bytes" fields, which is trivial to encode.
 */
function encodeTxRaw(
  bodyBytes: Uint8Array,
  authInfoBytes: Uint8Array,
  signatures: readonly Uint8Array[],
): Uint8Array {
  const chunks: Uint8Array[] = [];
  // field 1: body_bytes (wire type 2)
  chunks.push(varint((1 << 3) | 2), varint(bodyBytes.length), bodyBytes);
  // field 2: auth_info_bytes (wire type 2)
  chunks.push(
    varint((2 << 3) | 2),
    varint(authInfoBytes.length),
    authInfoBytes,
  );
  // field 3: signatures (repeated bytes, wire type 2 — one entry per sig)
  for (const sig of signatures) {
    chunks.push(varint((3 << 3) | 2), varint(sig.length), sig);
  }
  return concat(chunks);
}

function varint(n: number): Uint8Array {
  if (n < 0) throw new Error('cosmos: varint must be non-negative');
  const out: number[] = [];
  let v = n;
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v & 0x7f);
  return new Uint8Array(out);
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}
