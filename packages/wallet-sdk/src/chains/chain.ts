import type { Address, Curve, Signer, TransferIntent, TxHash } from '../types.js';

export interface TxContext {
  signer: Signer;
  sender: Address;
}

export interface ChainAdapter<TUnsigned = unknown, TSigned = unknown> {
  readonly id: string;
  readonly displayName: string;
  readonly curve: Curve;
  readonly coinType: number;

  derivationPath(account?: number, index?: number): string;
  pubkeyToAddress(pubkey: Uint8Array): Address;

  getBalance(address: Address): Promise<bigint>;
  buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<TUnsigned>;
  serializeForSigning(tx: TUnsigned): Promise<Uint8Array>;
  applySignature(tx: TUnsigned, signature: Uint8Array): Promise<TSigned>;
  broadcast(tx: TSigned): Promise<TxHash>;
}
