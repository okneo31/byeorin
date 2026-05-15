import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, TxContext } from './chain.js';

const TODO = (m: string): never => {
  throw new Error(`btc: ${m} not implemented (Task #1 P0 — Adapter 구현 예정)`);
};

export class BtcAdapter implements ChainAdapter {
  readonly id = 'btc:mainnet';
  readonly displayName = 'Bitcoin';
  readonly curve = 'secp256k1' as const;
  readonly coinType = 0;

  derivationPath(account = 0, index = 0): string {
    return `m/84'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(_pubkey: Uint8Array): Address {
    return TODO('pubkeyToAddress (bech32 P2WPKH)');
  }

  async getBalance(_address: Address): Promise<bigint> {
    return TODO('getBalance');
  }

  async buildTransfer(_intent: TransferIntent, _ctx: TxContext): Promise<unknown> {
    return TODO('buildTransfer (UTXO coin selection)');
  }

  async serializeForSigning(_tx: unknown): Promise<Uint8Array> {
    return TODO('serializeForSigning (per-input sighash)');
  }

  async applySignature(_tx: unknown, _signature: Uint8Array): Promise<unknown> {
    return TODO('applySignature');
  }

  async broadcast(_tx: unknown): Promise<TxHash> {
    return TODO('broadcast');
  }
}
