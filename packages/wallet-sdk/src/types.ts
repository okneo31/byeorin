export type Hex = `0x${string}`;
export type Address = string;
export type TxHash = string;
export type Bytes = Uint8Array;

export type Curve = 'secp256k1' | 'ed25519';

export interface TransferIntent {
  to: Address;
  amount: bigint;
  asset?: string;
  /**
   * 체인 기록에 남기는, 사람이 읽는 메모.
   *
   * 담기는 자리는 체인마다 다르다 — cosmos 는 tx memo, ton 은 comment cell,
   * **EVM 은 tx.data 에 UTF-8 바이트**(TTL 인덱서 규칙, `memo.ts` 참고).
   * EVM 에서는 `data`·`asset` 과 **동시에 쓸 수 없다** — 셋 다 tx.data 한 칸을
   * 쓰기 때문이다. 어댑터가 규칙 위반이면 던진다(조용히 버리지 않는다).
   * 메모를 안 쓰면 비워둔다 — 빈 문자열·`'0x'` 를 data 에 넣지 않는다.
   */
  memo?: string;
  /**
   * 옵셔널 calldata (EVM 전용). 명시되면 어댑터는 native transfer 대신 계약 호출
   * 트랜잭션을 빌드한다 — `to` 는 계약 주소, `amount` 는 함께 전송할 native value(wei).
   *
   * **메모 용도로 쓰지 않는다.** 메모는 `memo` 필드다 — 어댑터가 수신자 EOA 검사와
   * 서버 판정 규칙 검사를 걸어야 하는데, calldata 로 위장해 들어오면 그 검사가
   * 걸리지 않는다.
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
