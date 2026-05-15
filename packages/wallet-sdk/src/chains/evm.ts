import {
  bytesToHex,
  concat,
  createPublicClient,
  hexToBytes,
  http,
  keccak256,
  parseSignature,
  serializeTransaction,
  stringToBytes,
  type Address as ViemAddress,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type Signature,
  type TransactionSerializableLegacy,
  type TransactionSerializableEIP1559,
} from 'viem';
import { publicKeyToAddress } from 'viem/accounts';
import { toUncompressedSecp256k1 } from '../crypto/secp.js';
import type { Signer, Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

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

    // calldata 전파: '0x' / 빈 문자열 / undefined 는 native 전송으로 취급. 그 외는
    // estimateGas 와 직렬화에 모두 calldata 를 포함시킨다 — gas 추정이 native 와
    // 크게 다르므로 누락하면 transfer 가 OOG 로 실패한다.
    const dataField: Hex | undefined =
      intent.data && intent.data !== '0x' ? (intent.data as Hex) : undefined;

    if (useEip1559) {
      const fees = await this.client.estimateFeesPerGas();
      const gas = await this.client.estimateGas({
        account: sender,
        to,
        value: intent.amount,
        ...(dataField ? { data: dataField } : {}),
      });
      const base: TransactionSerializableEIP1559 & { type: 'eip1559' } = {
        type: 'eip1559',
        chainId: this.chain.id,
        nonce,
        to,
        value: intent.amount,
        gas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
      if (dataField) base.data = dataField;
      return base;
    }

    const gasPrice = await this.client.getGasPrice();
    const gas = await this.client.estimateGas({
      account: sender,
      to,
      value: intent.amount,
      ...(dataField ? { data: dataField } : {}),
    });
    const base: TransactionSerializableLegacy & { type: 'legacy' } = {
      type: 'legacy',
      chainId: this.chain.id,
      nonce,
      to,
      value: intent.amount,
      gas,
      gasPrice,
    };
    if (dataField) base.data = dataField;
    return base;
  }

  async signRequests(tx: EvmUnsignedTx): Promise<SignRequest[]> {
    const serialized = serializeTransaction(tx);
    return [{ message: hexToBytes(keccak256(serialized)), prehashed: true }];
  }

  async applySignatures(tx: EvmUnsignedTx, signatures: Uint8Array[]): Promise<EvmSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`evm: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
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

/**
 * EIP-191 personal-sign helper.
 *
 * Computes the canonical Ethereum signed-message digest and signs it with the
 * provided Signer (SoftSigner or HW). Returns a 0x-prefixed 65-byte
 * `r(32) || s(32) || v(1)` hex string with `v ∈ {27, 28}` — the format
 * `eth_sign` / `personal_sign` callers expect.
 *
 * Digest = `keccak256("\x19Ethereum Signed Message:\n" + len(message) + message)`
 *
 * `message` may be:
 *   - a UTF-8 string (encoded to bytes before length-prefixing), or
 *   - a `Uint8Array` (used as-is, length-prefixed).
 *
 * The `address` argument is accepted for symmetry with wallet APIs but is
 * **not** verified against the signer's public key. Callers wiring this into
 * a JSON-RPC bridge should validate the address upstream (see
 * `apps/extension/entrypoints/background.ts::personal_sign`).
 *
 * Cross-checked against MetaMask's personal_sign output and the on-chain
 * `ecrecover` behaviour used by EIP-1271-style verifiers.
 */
export async function signEvmMessage(
  signer: Signer,
  address: Address,
  message: string | Uint8Array,
): Promise<Hex> {
  if (signer.curve !== 'secp256k1') {
    throw new Error(`signEvmMessage: requires secp256k1 signer, got ${signer.curve}`);
  }
  // Accept-but-don't-verify the address. Documented above.
  void address;
  const msgBytes =
    typeof message === 'string' ? stringToBytes(message) : message;
  const prefix = stringToBytes(`\x19Ethereum Signed Message:\n${msgBytes.length}`);
  const digestHex = keccak256(concat([prefix, msgBytes]));
  const sig = await signer.sign(hexToBytes(digestHex));
  if (sig.length !== 65) {
    throw new Error(`signEvmMessage: signature must be 65 bytes, got ${sig.length}`);
  }
  const recovery = sig[64] as number;
  // SoftSigner emits raw recovery {0,1}. Accept pre-encoded v ∈ {27, 28} too
  // (some HW signers add 27 internally).
  let v: number;
  if (recovery === 0 || recovery === 1) {
    v = recovery + 27;
  } else if (recovery === 27 || recovery === 28) {
    v = recovery;
  } else {
    throw new Error(
      `signEvmMessage: recovery byte must be 0|1|27|28, got ${recovery}`,
    );
  }
  const out = new Uint8Array(65);
  out.set(sig.subarray(0, 64), 0);
  out[64] = v;
  return bytesToHex(out);
}

