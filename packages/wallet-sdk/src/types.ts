export type Hex = `0x${string}`;
export type Address = string;
export type TxHash = string;
export type Bytes = Uint8Array;

export type Curve = 'secp256k1' | 'ed25519';

export interface TransferIntent {
  to: Address;
  amount: bigint;
  asset?: string;
  memo?: string;
}

export interface AccountKey {
  curve: Curve;
  publicKey: Bytes;
  derivationPath: string;
  privateKey?: Bytes;
}

export interface Signer {
  readonly curve: Curve;
  publicKey(): Promise<Bytes>;
  sign(message: Bytes): Promise<Bytes>;
}
