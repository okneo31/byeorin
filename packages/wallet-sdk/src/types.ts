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
  /**
   * 옵셔널 calldata (EVM 전용). 명시되면 어댑터는 native transfer 대신 계약 호출
   * 트랜잭션을 빌드한다 — `to` 는 계약 주소, `amount` 는 함께 전송할 native value(wei).
   *
   * 단순 native 송금에는 비워두거나 `'0x'` 로 둔다. 비-EVM 어댑터는 본 필드를 무시한다.
   */
  data?: Hex;
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
