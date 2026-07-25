import { ripemd160 } from '@noble/hashes/ripemd160';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { toBase64, toBech32 } from '@cosmjs/encoding';
import {
  encodePubkey,
  makeAuthInfoBytes,
  makeSignBytes,
  makeSignDoc,
  Registry,
  type GeneratedType,
} from '@cosmjs/proto-signing';
import { defaultRegistryTypes, StargateClient } from '@cosmjs/stargate';
import {
  toCompressedSecp256k1,
  toUncompressedSecp256k1,
} from '../crypto/secp.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

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
  /**
   * Extra proto message types to register on the adapter's `Registry` beyond
   * `defaultRegistryTypes` (which already covers MsgSend / staking / gov /
   * ibc). Pass this to enable chain-specific custom messages — e.g. ZION's
   * `/zion.amm.v1.MsgSwap`, `/zion.job.v1.MsgClaimJob`, `/zion.bankext.v1.MsgClaimSeed`.
   *
   * Each entry is `[typeUrl, GeneratedType]` — the same pair you'd pass to
   * `registry.register(...)`. Order matters only if two entries share a
   * typeUrl (last one wins).
   */
  customMsgTypes?: ReadonlyArray<readonly [string, GeneratedType]>;
  /**
   * Use EVM-style (Ethermint) address derivation instead of the classic
   * Cosmos `ripemd160(sha256(pubkey))`. When `true`:
   *   - 20-byte raw address = `keccak256(uncompressed_pubkey[1:])[-20:]`
   *     (identical bytes to the matching EVM `0x..` address).
   *   - Pubkey is encoded as `Any` with type URL
   *     `/injective.crypto.v1beta1.ethsecp256k1.PubKey` instead of
   *     `/cosmos.crypto.secp256k1.PubKey`.
   *   - bech32 HRP from `bech32Prefix` is unchanged.
   * Required for Ethermint-style chains: Injective (`inj`), Evmos (`evmos`),
   * Cronos POS (`crc`), Berachain Cosmos (`bera`), etc. All such chains also
   * use `coinType: 60`, but coinType alone is not a sufficient signal (some
   * chains migrate to 60 without switching the address scheme), so we keep
   * this opt-in explicit.
   */
  evmAddressing?: boolean;
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
const ETHSECP256K1_PUBKEY_TYPE_URL =
  '/injective.crypto.v1beta1.ethsecp256k1.PubKey';
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
  readonly evmAddressing: boolean;

  /**
   * Proto `Registry` for tx-body encoding. Read-only by convention — pass
   * `customMsgTypes` at construction time instead of mutating at runtime, so
   * the adapter's message vocabulary stays a deterministic part of its
   * identity. Exposed for `registry.lookupType(...)` and similar introspection.
   */
  readonly registry: Registry;

  constructor(opts: CosmosAdapterOptions) {
    this.chainId = opts.chainId;
    this.bech32Prefix = opts.bech32Prefix;
    this.rpcUrl = opts.rpcUrl;
    this.denom = opts.denom;
    this.decimals = opts.decimals ?? 6;
    this.coinType = opts.coinType ?? 118;
    this.defaultGas = opts.defaultGas ?? 200_000;
    this.defaultFee = opts.defaultFee ?? 5000n;
    this.evmAddressing = opts.evmAddressing ?? false;
    this.id = `cosmos:${opts.chainId}`;
    this.displayName = opts.chainId;
    // defaultRegistryTypes contains MsgSend, MsgMultiSend, staking, gov, ibc, etc.
    // customMsgTypes are layered on top so chain-specific messages
    // (ZION's MsgSwap / MsgClaimJob / MsgClaimSeed, etc.) become first-class.
    this.registry = new Registry(defaultRegistryTypes);
    if (opts.customMsgTypes) {
      for (const [typeUrl, type] of opts.customMsgTypes) {
        this.registry.register(typeUrl, type);
      }
    }
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  /**
   * Convert a secp256k1 pubkey to a bech32 address.
   *
   * Classic Cosmos:
   *   addr = bech32(prefix, ripemd160(sha256(compressed_pubkey)))
   *
   * Ethermint (`evmAddressing: true`, used by Injective/Evmos/Cronos POS):
   *   addr = bech32(prefix, keccak256(uncompressed_pubkey[1:])[-20:])
   *   — i.e. the same 20-byte payload as the matching EVM `0x..` address,
   *   just wrapped in bech32.
   *
   * Accepts compressed (33-byte), uncompressed (65-byte), or raw (64-byte)
   * pubkeys — they're normalized to the form each scheme needs.
   */
  pubkeyToAddress(pubkey: Uint8Array): Address {
    const raw20 = this.evmAddressing
      ? keccak_256(toUncompressedSecp256k1(pubkey).slice(1)).slice(-20)
      : ripemd160(sha256(toCompressedSecp256k1(pubkey)));
    return toBech32(this.bech32Prefix, raw20);
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

  /**
   * 주소의 *모든 denom* 잔액을 한 번에 가져온다. ZION 처럼 한 계정이 여러
   * 자산(utrg/ubtc/uusdt/ueth) 을 보유하는 경우에 사용.
   *
   * 결과는 chain 에 *존재하는* 잔액만 포함 — 0 인 자산은 빠질 수 있다.
   * UI 가 "정의된 자산 목록 × 잔액 맵" 으로 매핑하는 게 안전하다.
   *
   * RPC 1 회 호출 (`/cosmos/bank/v1beta1/balances/{address}` 의 RPC ABCI 등가).
   */
  async getAllBalances(
    address: Address,
  ): Promise<Array<{ denom: string; amount: bigint }>> {
    const client = await StargateClient.connect(this.rpcUrl);
    try {
      const coins = await client.getAllBalances(address);
      return coins.map((c) => ({ denom: c.denom, amount: BigInt(c.amount) }));
    } finally {
      client.disconnect();
    }
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<CosmosUnsignedTx> {
    // Standard kWR/uatom/etc. send → one MsgSend. All Cosmos chains accept
    // this; ZION's bankext SendRestriction mirrors it to the Available bucket
    // automatically (see ZionWallet.MD §7).
    return this.buildTx(
      [
        {
          typeUrl: MSG_SEND_TYPE_URL,
          value: {
            fromAddress: ctx.sender,
            toAddress: intent.to,
            amount: [{ denom: this.denom, amount: intent.amount.toString() }],
          },
        },
      ],
      ctx,
      intent.memo !== undefined ? { memo: intent.memo } : undefined,
    );
  }

  /**
   * Build an unsigned Cosmos tx from arbitrary registered messages.
   *
   * This is the general path that `buildTransfer` reuses for plain MsgSend.
   * Pass `customMsgTypes` to the constructor first to register your chain's
   * proto types (e.g. ZION AMM/job/bankext) — then `messages[*].typeUrl`
   * must match a registered entry and `value` must match its proto shape.
   *
   * Returns a `CosmosUnsignedTx` ready for `signRequests` → Signer →
   * `applySignatures` → `broadcast`. The signing pipeline is identical to
   * MsgSend's — only the message contents differ.
   */
  async buildTx(
    messages: ReadonlyArray<{ typeUrl: string; value: unknown }>,
    ctx: TxContext,
    opts?: { memo?: string },
  ): Promise<CosmosUnsignedTx> {
    if (messages.length === 0) {
      throw new Error('cosmos: buildTx requires at least one message');
    }
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

    // 2. Build TxBody via Registry — handles MsgSend out of the box and any
    // customMsgTypes registered at construction.
    const bodyBytes = this.registry.encodeTxBody({
      messages: messages.map((m) => ({ typeUrl: m.typeUrl, value: m.value })),
      memo: opts?.memo ?? '',
    });

    // 3. Encode the pubkey as Any and build AuthInfo (default SIGN_MODE_DIRECT).
    // Ethermint chains (Injective/Evmos/Cronos POS) use a different type URL
    // — the underlying proto message is still `PubKey { bytes key = 1 }`, so
    // we hand-encode it to avoid needing the injective protobuf bindings.
    const pubkeyAny = this.evmAddressing
      ? {
          typeUrl: ETHSECP256K1_PUBKEY_TYPE_URL,
          value: encodePubKeyProtoBytes(pubKey),
        }
      : encodePubkey({
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
  async signRequests(tx: CosmosUnsignedTx): Promise<SignRequest[]> {
    const signBytes = makeSignBytes(tx.signDoc);
    return [{ message: sha256(signBytes), prehashed: true }];
  }

  /**
   * Cosmos signatures are 64 bytes (r||s). SoftSigner produces 65 bytes
   * (compact 64 + 1 recovery byte). We strip the recovery byte and normalize
   * to low-S — Cosmos chains reject high-S sigs. noble already gives lowS by
   * default, but we defend-in-depth for HW signers.
   */
  async applySignatures(
    tx: CosmosUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<CosmosSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`cosmos: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
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

/**
 * Hand-encode the proto message:
 *   message PubKey { bytes key = 1; }
 * used by both `/cosmos.crypto.secp256k1.PubKey` and the Ethermint variants
 * (`/injective.crypto.v1beta1.ethsecp256k1.PubKey`, the `evmos` equivalent,
 * etc.). The body is identical — only the `Any` typeUrl differs.
 */
function encodePubKeyProtoBytes(key: Uint8Array): Uint8Array {
  // field 1, wire type 2 (length-delimited)
  return concat([varint((1 << 3) | 2), varint(key.length), key]);
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

export function varint(n: number): Uint8Array {
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

export function concat(parts: readonly Uint8Array[]): Uint8Array {
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
