import {
  NETWORK,
  TEST_NETWORK,
  Transaction,
  SigHash,
  Address as BtcAddressCodec,
  OutScript,
  p2wpkh,
  p2tr,
} from '@scure/btc-signer';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { toCompressedSecp256k1 } from '../crypto/secp.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type BtcNetwork = 'mainnet' | 'testnet';
export type BtcAddressType = 'p2wpkh' | 'p2tr';

export interface BtcAdapterOptions {
  network?: BtcNetwork;
  /**
   * Esplora-compatible API base URL.
   * Defaults: mainnet -> https://blockstream.info/api
   *           testnet -> https://blockstream.info/testnet/api
   */
  apiBaseUrl?: string;
  /** Default 'p2wpkh' (BIP-84 native segwit). 'p2tr' build path is deferred in v0.1. */
  addressType?: BtcAddressType;
}

export interface Utxo {
  txid: string;
  vout: number;
  /** sats */
  value: bigint;
  /** hex-encoded scriptPubKey of the previous output (witness UTXO script) */
  scriptPubKey: string;
}

export interface BtcUnsignedTx {
  /** The in-progress @scure/btc-signer Transaction; mutated in place by applySignatures. */
  tx: Transaction;
  /** UTXOs spent by this transaction, ordered to match tx inputs. */
  inputUtxos: Utxo[];
  /** 33-byte compressed pubkey of the sender (used to attach partialSig). */
  signerPubkey: Uint8Array;
}

export interface BtcSignedTx {
  hex: string;
  txid: string;
}

interface EsploraUtxo {
  txid: string;
  vout: number;
  value: number;
  status?: unknown;
}

const DUST_SATS = 546n;
/** Conservative vsize estimate for a p2wpkh tx: 10.5 base + 68 per input + 31 per output. */
const VBYTES_BASE = 11;
const VBYTES_PER_P2WPKH_INPUT = 68;
const VBYTES_PER_OUTPUT = 31;

export class BtcAdapter implements ChainAdapter<BtcUnsignedTx, BtcSignedTx> {
  readonly curve = 'secp256k1' as const;
  readonly id: string;
  readonly displayName: string;
  readonly coinType: number;
  readonly network: BtcNetwork;
  readonly addressType: BtcAddressType;
  readonly apiBaseUrl: string;
  /** btc-signer NETWORK constant for the chosen network. */
  readonly btcNetwork: typeof NETWORK;

  constructor(opts: BtcAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.addressType = opts.addressType ?? 'p2wpkh';
    this.coinType = this.network === 'mainnet' ? 0 : 1;
    this.id = `btc:${this.network}`;
    this.displayName = this.network === 'mainnet' ? 'Bitcoin' : 'Bitcoin Testnet';
    this.btcNetwork = this.network === 'mainnet' ? NETWORK : TEST_NETWORK;
    this.apiBaseUrl =
      opts.apiBaseUrl ??
      (this.network === 'mainnet'
        ? 'https://blockstream.info/api'
        : 'https://blockstream.info/testnet/api');
  }

  derivationPath(account = 0, index = 0): string {
    // BIP-84 (p2wpkh) or BIP-86 (p2tr); both use coin type 0 (mainnet) / 1 (testnet).
    const purpose = this.addressType === 'p2tr' ? 86 : 84;
    return `m/${purpose}'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 33 || (pubkey[0] !== 0x02 && pubkey[0] !== 0x03)) {
      throw new Error(`btc: pubkeyToAddress expects 33-byte compressed key, got ${pubkey.length}`);
    }
    if (this.addressType === 'p2tr') {
      // BIP-340 x-only pubkey: drop the parity byte.
      const xonly = pubkey.slice(1, 33);
      const out = p2tr(xonly, undefined, this.btcNetwork);
      if (!out.address) throw new Error('btc: failed to derive p2tr address');
      return out.address;
    }
    const out = p2wpkh(pubkey, this.btcNetwork);
    if (!out.address) throw new Error('btc: failed to derive p2wpkh address');
    return out.address;
  }

  async getBalance(address: Address): Promise<bigint> {
    const utxos = await this.fetchUtxos(address);
    let sum = 0n;
    for (const u of utxos) sum += u.value;
    return sum;
  }

  async buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<BtcUnsignedTx> {
    if (this.addressType === 'p2tr') {
      throw new Error('btc: p2tr build not implemented in v0.1');
    }

    const rawPubkey = await ctx.signer.publicKey();
    const senderPubkey = toCompressedSecp256k1(rawPubkey);
    const payment = p2wpkh(senderPubkey, this.btcNetwork);
    if (!payment.address || payment.address !== ctx.sender) {
      throw new Error(`btc: sender ${ctx.sender} does not match signer pubkey`);
    }

    const amount = intent.amount;
    if (amount <= 0n) throw new Error('btc: amount must be > 0 sats');

    const [allUtxos, feeRate] = await Promise.all([
      this.fetchUtxos(ctx.sender),
      this.fetchFeeRate(),
    ]);
    if (allUtxos.length === 0) throw new Error('btc: no spendable UTXOs');

    // Greedy largest-first selection. Iterates: try N inputs, compute fee with change,
    // see if it covers amount + fee; if change < dust drop it and re-evaluate.
    const sorted = [...allUtxos].sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
    const picked: Utxo[] = [];
    let inputSum = 0n;
    let fee = 0n;
    let change = 0n;
    let withChange = true;

    for (const u of sorted) {
      picked.push(u);
      inputSum += u.value;

      // Recompute fee assuming 1 destination + optional change output.
      let outCount = 1 + (withChange ? 1 : 0);
      let vbytes = VBYTES_BASE + picked.length * VBYTES_PER_P2WPKH_INPUT + outCount * VBYTES_PER_OUTPUT;
      fee = BigInt(Math.ceil(vbytes * feeRate));

      if (inputSum < amount + fee) continue;

      change = inputSum - amount - fee;
      if (change < DUST_SATS) {
        // Dust change: absorb into fee, recompute without change output.
        withChange = false;
        outCount = 1;
        vbytes = VBYTES_BASE + picked.length * VBYTES_PER_P2WPKH_INPUT + outCount * VBYTES_PER_OUTPUT;
        fee = BigInt(Math.ceil(vbytes * feeRate));
        if (inputSum < amount + fee) {
          // Need another input.
          withChange = true; // reset for next iteration
          continue;
        }
        change = 0n;
      }
      break;
    }

    if (inputSum < amount + fee) {
      throw new Error(
        `btc: insufficient funds — need ${amount + fee} sats (incl. fee ${fee}), have ${inputSum}`,
      );
    }

    const tx = new Transaction();
    for (const u of picked) {
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        witnessUtxo: {
          amount: u.value,
          script: hexToBytes(u.scriptPubKey),
        },
        sequence: 0xfffffffd, // RBF-enabled
      });
    }
    tx.addOutputAddress(intent.to, amount, this.btcNetwork);
    if (withChange && change > 0n) {
      tx.addOutputAddress(ctx.sender, change, this.btcNetwork);
    }

    return { tx, inputUtxos: picked, signerPubkey: senderPubkey };
  }

  /**
   * Returns one SignRequest per input (BTC's per-input sighash digest as
   * produced by `Transaction.preimageWitnessV0`). The result of
   * `applySignatures` must consume the signatures in the same order.
   */
  async signRequests(tx: BtcUnsignedTx): Promise<SignRequest[]> {
    return this.computeSigningDigests(tx).map((digest) => ({
      message: digest,
      prehashed: true,
    }));
  }

  /** Internal: per-input 32-byte sighash digests. */
  private computeSigningDigests(tx: BtcUnsignedTx): Uint8Array[] {
    const digests: Uint8Array[] = [];
    for (let i = 0; i < tx.inputUtxos.length; i++) {
      const u = tx.inputUtxos[i]!;
      const script = hexToBytes(u.scriptPubKey);
      digests.push(tx.tx.preimageWitnessV0(i, script, SigHash.ALL, u.value));
    }
    return digests;
  }

  /**
   * Apply per-input signatures. Each signature is the 65-byte `r(32)||s(32)||recovery(1)`
   * compact form produced by `SoftSigner` (we discard the recovery byte and re-encode to DER,
   * which is what Bitcoin p2wpkh witness expects). Accepts 64-byte compact too.
   */
  async applySignatures(tx: BtcUnsignedTx, signatures: Uint8Array[]): Promise<BtcSignedTx> {
    if (signatures.length !== tx.inputUtxos.length) {
      throw new Error(
        `btc: signature count ${signatures.length} != input count ${tx.inputUtxos.length}`,
      );
    }
    for (let i = 0; i < signatures.length; i++) {
      const sig = signatures[i]!;
      if (sig.length !== 64 && sig.length !== 65) {
        throw new Error(`btc: signature[${i}] must be 64 or 65 bytes, got ${sig.length}`);
      }
      const r = bigIntFromBE(sig.slice(0, 32));
      const s = bigIntFromBE(sig.slice(32, 64));
      // Reconstruct via Signature class, normalize to low-S (BIP-146), then DER-encode.
      let sigObj = new secp256k1.Signature(r, s);
      if (sigObj.hasHighS()) sigObj = sigObj.normalizeS();
      const der = sigObj.toDERRawBytes();
      const sigWithHashType = new Uint8Array(der.length + 1);
      sigWithHashType.set(der, 0);
      sigWithHashType[der.length] = SigHash.ALL;
      tx.tx.updateInput(i, { partialSig: [[tx.signerPubkey, sigWithHashType]] });
      tx.tx.finalizeIdx(i);
    }
    return { hex: tx.tx.hex, txid: tx.tx.id };
  }

  async broadcast(tx: BtcSignedTx): Promise<TxHash> {
    const res = await fetch(`${this.apiBaseUrl}/tx`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: tx.hex,
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`btc: broadcast failed (${res.status}): ${body}`);
    return body.trim();
  }

  /** Fetch UTXOs from an Esplora-compatible endpoint. */
  async fetchUtxos(address: Address): Promise<Utxo[]> {
    const res = await fetch(`${this.apiBaseUrl}/address/${address}/utxo`);
    if (!res.ok) {
      throw new Error(`btc: fetchUtxos failed (${res.status}) for ${address}`);
    }
    const list = (await res.json()) as EsploraUtxo[];
    // Esplora returns UTXOs without scriptPubKey; we derive it for the sender's address type.
    // For p2wpkh we cannot infer the script from the address bytes here without bech32 decode,
    // so we ask the caller's adapter to provide the script via p2wpkh again. The simplest
    // approach: re-derive from the address.
    const script = this.scriptForAddress(address);
    const scriptHex = bytesToHex(script);
    return list.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: BigInt(u.value),
      scriptPubKey: scriptHex,
    }));
  }

  /** Fetch Esplora 6-block target fee rate (sats/vB). Falls back to 5 sats/vB. */
  async fetchFeeRate(target = 6): Promise<number> {
    try {
      const res = await fetch(`${this.apiBaseUrl}/fee-estimates`);
      if (!res.ok) return 5;
      const obj = (await res.json()) as Record<string, number>;
      const rate = obj[String(target)] ?? obj['6'] ?? obj['10'];
      if (typeof rate === 'number' && rate > 0) return rate;
      return 5;
    } catch {
      return 5;
    }
  }

  /** Decode the witness scriptPubKey for an address (bech32 / base58) via btc-signer. */
  private scriptForAddress(address: Address): Uint8Array {
    const decoded = BtcAddressCodec(this.btcNetwork).decode(address);
    return OutScript.encode(decoded);
  }
}

function bigIntFromBE(bytes: Uint8Array): bigint {
  let out = 0n;
  for (let i = 0; i < bytes.length; i++) out = (out << 8n) | BigInt(bytes[i]!);
  return out;
}
