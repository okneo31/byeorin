import {
  bytesToHex,
  createPublicClient,
  hexToBytes,
  http,
  keccak256,
  parseSignature,
  serializeTransaction,
  type Address as ViemAddress,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type Signature,
  type TransactionSerializableLegacy,
  type TransactionSerializableEIP1559,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { secp256k1 } from '@noble/curves/secp256k1';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

export type EvmUnsignedTx =
  | (TransactionSerializableLegacy & { type: 'legacy' })
  | (TransactionSerializableEIP1559 & { type: 'eip1559' });

export interface EvmSignedTx {
  raw: Hex;
  hash: Hex;
}

export interface EvmAdapterOptions {
  chain: ViemChain;
  rpcUrl?: string;
  feeMode?: 'auto' | 'legacy' | 'eip1559';
  coinType?: number;
}

export class EvmAdapter implements ChainAdapter<EvmUnsignedTx, EvmSignedTx> {
  readonly curve = 'secp256k1' as const;
  readonly id: string;
  readonly displayName: string;
  readonly coinType: number;
  readonly chain: ViemChain;
  private readonly client: PublicClient;
  private readonly feeMode: 'auto' | 'legacy' | 'eip1559';

  constructor(opts: EvmAdapterOptions) {
    this.chain = opts.chain;
    this.id = `evm:${opts.chain.id}`;
    this.displayName = opts.chain.name;
    this.coinType = opts.coinType ?? 60;
    this.feeMode = opts.feeMode ?? 'auto';
    const url = opts.rpcUrl ?? opts.chain.rpcUrls.default.http[0];
    if (!url) throw new Error(`evm: no rpcUrl for ${opts.chain.name}`);
    this.client = createPublicClient({ chain: opts.chain, transport: http(url) });
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    const uncompressed = toUncompressedSecp256k1(pubkey);
    return publicKeyToAddress(bytesToHex(uncompressed));
  }

  async getBalance(address: Address): Promise<bigint> {
    return this.client.getBalance({ address: address as ViemAddress });
  }

  async buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<EvmUnsignedTx> {
    const sender = ctx.sender as ViemAddress;
    const to = intent.to as ViemAddress;
    const nonce = await this.client.getTransactionCount({ address: sender, blockTag: 'pending' });
    const useEip1559 = await this.shouldUseEip1559();

    if (useEip1559) {
      const fees = await this.client.estimateFeesPerGas();
      const gas = await this.client.estimateGas({ account: sender, to, value: intent.amount });
      return {
        type: 'eip1559',
        chainId: this.chain.id,
        nonce,
        to,
        value: intent.amount,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    }

    const gasPrice = await this.client.getGasPrice();
    const gas = await this.client.estimateGas({ account: sender, to, value: intent.amount });
    return {
      type: 'legacy',
      chainId: this.chain.id,
      nonce,
      to,
      value: intent.amount,
      gas,
      gasPrice,
    };
  }

  async serializeForSigning(tx: EvmUnsignedTx): Promise<Uint8Array> {
    const serialized = serializeTransaction(tx);
    return hexToBytes(keccak256(serialized));
  }

  async applySignature(tx: EvmUnsignedTx, signature: Uint8Array): Promise<EvmSignedTx> {
    if (signature.length !== 65) {
      throw new Error(`evm: signature must be 65 bytes, got ${signature.length}`);
    }
    const sig = parseSignature(bytesToHex(signature)) as Signature;
    const raw = serializeTransaction(tx, sig);
    return { raw, hash: keccak256(raw) };
  }

  async broadcast(tx: EvmSignedTx): Promise<TxHash> {
    return this.client.sendRawTransaction({ serializedTransaction: tx.raw });
  }

  private async shouldUseEip1559(): Promise<boolean> {
    if (this.feeMode === 'legacy') return false;
    if (this.feeMode === 'eip1559') return true;
    try {
      const block = await this.client.getBlock({ blockTag: 'latest' });
      return block.baseFeePerGas != null;
    } catch {
      return false;
    }
  }
}

function toUncompressedSecp256k1(pubkey: Uint8Array): Uint8Array {
  if (pubkey.length === 65 && pubkey[0] === 0x04) return pubkey;
  if (pubkey.length === 64) {
    const out = new Uint8Array(65);
    out[0] = 0x04;
    out.set(pubkey, 1);
    return out;
  }
  if (pubkey.length === 33 && (pubkey[0] === 0x02 || pubkey[0] === 0x03)) {
    return secp256k1.ProjectivePoint.fromHex(pubkey).toRawBytes(false);
  }
  throw new Error(`evm: bad pubkey length=${pubkey.length}`);
}
