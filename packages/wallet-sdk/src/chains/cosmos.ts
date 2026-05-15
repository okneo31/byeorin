import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

export interface CosmosAdapterOptions {
  chainId: string;
  bech32Prefix: string;
  rpcUrl: string;
  denom: string;
}

const TODO = (m: string): never => {
  throw new Error(`cosmos: ${m} not implemented (Task #1 P0 — Adapter 구현 예정)`);
};

export class CosmosAdapter implements ChainAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly curve = 'secp256k1' as const;
  readonly coinType = 118;

  constructor(opts: CosmosAdapterOptions) {
    this.id = `cosmos:${opts.chainId}`;
    this.displayName = opts.chainId;
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(_pubkey: Uint8Array): Address {
    return TODO('pubkeyToAddress (bech32)');
  }

  async getBalance(_address: Address): Promise<bigint> {
    return TODO('getBalance');
  }

  async buildTransfer(_intent: TransferIntent, _ctx: TxContext): Promise<unknown> {
    return TODO('buildTransfer (MsgSend)');
  }

  async serializeForSigning(_tx: unknown): Promise<Uint8Array> {
    return TODO('serializeForSigning (SignDoc)');
  }

  async applySignature(_tx: unknown, _signature: Uint8Array): Promise<unknown> {
    return TODO('applySignature');
  }

  async broadcast(_tx: unknown): Promise<TxHash> {
    return TODO('broadcast');
  }
}
