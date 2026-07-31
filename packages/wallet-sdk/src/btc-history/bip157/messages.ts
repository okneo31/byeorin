// messages.ts — BIP157/158 라이트클라이언트용 비트코인 와이어 메시지 인코딩·디코딩.
//
// 범위: getheaders/headers, getcfheaders/cfheaders, getcfilters/cfilter,
//       getdata/block(+tx) 및 공용 바이트 유틸(varint·역방향 hex·해시).
// 규칙: 순수 함수만. 전송(ByteTransport)·소켓 코드는 여기 없다 — scan.ts 의 몫.
// 의존: @noble/hashes (기존 SDK 의존성) 외 추가 의존 없음.
//
// 바이트 순서 규약:
//   - "internal" = 와이어에 실리는 그대로 (dsha256 출력 그대로, little-endian 표기 관례).
//   - "display"  = 탐색기·RPC 에 보이는 역방향 hex. 변환은 reverseBytes 로만 한다.

import { sha256 } from '@noble/hashes/sha256';

// ---------------------------------------------------------------------------
// 바이트 유틸
// ---------------------------------------------------------------------------

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrays) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** 복사본을 뒤집어 반환 (원본 불변). internal ↔ display 변환용. */
export function reverseBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i]!;
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error(`hex length must be even: ${hex.length}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`invalid hex at ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

/** display hex(탐색기 표기) → internal 바이트. */
export function displayHashToInternal(hex: string): Uint8Array {
  return reverseBytes(hexToBytes(hex));
}

/** internal 바이트 → display hex(탐색기 표기). */
export function internalHashToDisplay(bytes: Uint8Array): string {
  return bytesToHex(reverseBytes(bytes));
}

/** double-SHA256 — 비트코인 해시 원형. */
export function dsha256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

export const ZERO_HASH = new Uint8Array(32);

// ---------------------------------------------------------------------------
// CompactSize varint (BIP 표기로는 varint — 비트코인 P2P 의 가변 길이 정수)
// ---------------------------------------------------------------------------

export function encodeVarint(n: number | bigint): Uint8Array {
  const v = BigInt(n);
  if (v < 0n) throw new Error('varint must be non-negative');
  if (v < 0xfdn) return new Uint8Array([Number(v)]);
  if (v <= 0xffffn) {
    const b = new Uint8Array(3);
    b[0] = 0xfd;
    b[1] = Number(v & 0xffn);
    b[2] = Number((v >> 8n) & 0xffn);
    return b;
  }
  if (v <= 0xffffffffn) {
    const b = new Uint8Array(5);
    b[0] = 0xfe;
    for (let i = 0; i < 4; i++) b[1 + i] = Number((v >> BigInt(8 * i)) & 0xffn);
    return b;
  }
  if (v <= 0xffffffffffffffffn) {
    const b = new Uint8Array(9);
    b[0] = 0xff;
    for (let i = 0; i < 8; i++) b[1 + i] = Number((v >> BigInt(8 * i)) & 0xffn);
    return b;
  }
  throw new Error('varint too large');
}

export function decodeVarint(
  buf: Uint8Array,
  offset = 0,
): { value: bigint; size: number } {
  if (offset >= buf.length) throw new Error('varint: out of bounds');
  const first = buf[offset]!;
  if (first < 0xfd) return { value: BigInt(first), size: 1 };
  const len = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
  if (offset + 1 + len > buf.length) throw new Error('varint: truncated');
  let v = 0n;
  for (let i = len - 1; i >= 0; i--) v = (v << 8n) | BigInt(buf[offset + 1 + i]!);
  return { value: v, size: 1 + len };
}

// ---------------------------------------------------------------------------
// Reader / Writer
// ---------------------------------------------------------------------------

export class ByteReader {
  constructor(
    private readonly buf: Uint8Array,
    public offset = 0,
  ) {}

  get remaining(): number {
    return this.buf.length - this.offset;
  }

  readBytes(n: number): Uint8Array {
    if (this.remaining < n) throw new Error(`reader: need ${n}, have ${this.remaining}`);
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }

  readU8(): number {
    return this.readBytes(1)[0]!;
  }

  readU16LE(): number {
    const b = this.readBytes(2);
    return b[0]! | (b[1]! << 8);
  }

  readU32LE(): number {
    const b = this.readBytes(4);
    return (b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24)) >>> 0;
  }

  readI32LE(): number {
    const b = this.readBytes(4);
    return b[0]! | (b[1]! << 8) | (b[2]! << 16) | (b[3]! << 24);
  }

  readU64LE(): bigint {
    const b = this.readBytes(8);
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
    return v;
  }

  readVarint(): bigint {
    const { value, size } = decodeVarint(this.buf, this.offset);
    this.offset += size;
    return value;
  }

  /** varint 길이 프리픽스 바이트열. */
  readVarBytes(): Uint8Array {
    const len = this.readVarint();
    if (len > BigInt(this.remaining)) throw new Error('varbytes: truncated');
    return this.readBytes(Number(len));
  }
}

export class ByteWriter {
  private chunks: Uint8Array[] = [];

  writeBytes(b: Uint8Array): this {
    this.chunks.push(b);
    return this;
  }

  writeU8(n: number): this {
    return this.writeBytes(new Uint8Array([n & 0xff]));
  }

  writeU16LE(n: number): this {
    return this.writeBytes(new Uint8Array([n & 0xff, (n >> 8) & 0xff]));
  }

  writeU16BE(n: number): this {
    return this.writeBytes(new Uint8Array([(n >> 8) & 0xff, n & 0xff]));
  }

  writeU32LE(n: number): this {
    return this.writeBytes(
      new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]),
    );
  }

  writeU64LE(n: bigint): this {
    const b = new Uint8Array(8);
    for (let i = 0; i < 8; i++) b[i] = Number((n >> BigInt(8 * i)) & 0xffn);
    return this.writeBytes(b);
  }

  writeVarint(n: number | bigint): this {
    return this.writeBytes(encodeVarint(n));
  }

  writeVarBytes(b: Uint8Array): this {
    return this.writeVarint(b.length).writeBytes(b);
  }

  toBytes(): Uint8Array {
    return concatBytes(...this.chunks);
  }
}

// ---------------------------------------------------------------------------
// 블록 헤더 · getheaders / headers
// ---------------------------------------------------------------------------

export const PROTOCOL_VERSION = 70016;

export interface BlockHeader {
  /** 80바이트 원본 (해시 재계산용). */
  raw: Uint8Array;
  version: number;
  /** internal 순서. */
  prevBlockHash: Uint8Array;
  merkleRoot: Uint8Array;
  timestamp: number;
  bits: number;
  nonce: number;
  /** dsha256(raw) — internal 순서. */
  hash: Uint8Array;
}

export function decodeBlockHeader(r: ByteReader): BlockHeader {
  const start = r.offset;
  const version = r.readI32LE();
  const prevBlockHash = new Uint8Array(r.readBytes(32));
  const merkleRoot = new Uint8Array(r.readBytes(32));
  const timestamp = r.readU32LE();
  const bits = r.readU32LE();
  const nonce = r.readU32LE();
  const raw = new Uint8Array(80);
  // subarray 원본 접근을 위해 다시 잘라 복사
  r.offset = start;
  raw.set(r.readBytes(80));
  return { raw, version, prevBlockHash, merkleRoot, timestamp, bits, nonce, hash: dsha256(raw) };
}

/**
 * getheaders 페이로드: version + locator 개수 + locator 해시들 + hash_stop.
 * locator 해시는 internal 순서, 최신 것부터.
 */
export function encodeGetHeaders(
  locatorHashes: Uint8Array[],
  stopHash: Uint8Array = ZERO_HASH,
  version = PROTOCOL_VERSION,
): Uint8Array {
  const w = new ByteWriter().writeU32LE(version).writeVarint(locatorHashes.length);
  for (const h of locatorHashes) {
    if (h.length !== 32) throw new Error('locator hash must be 32 bytes');
    w.writeBytes(h);
  }
  return w.writeBytes(stopHash).toBytes();
}

/** headers 페이로드: 개수 + (80바이트 헤더 + tx count varint(항상 0)) 반복. */
export function decodeHeadersMessage(payload: Uint8Array): BlockHeader[] {
  const r = new ByteReader(payload);
  const count = Number(r.readVarint());
  const out: BlockHeader[] = [];
  for (let i = 0; i < count; i++) {
    out.push(decodeBlockHeader(r));
    r.readVarint(); // tx count — headers 메시지에서는 항상 0
  }
  return out;
}

// ---------------------------------------------------------------------------
// BIP157: getcfheaders / cfheaders · getcfilters / cfilter
// ---------------------------------------------------------------------------

export const FILTER_TYPE_BASIC = 0;

/** BIP157 상한 — getcfheaders 는 요청당 최대 2000, getcfilters 는 최대 1000. */
export const MAX_CFHEADERS_PER_REQUEST = 2000;
export const MAX_CFILTERS_PER_REQUEST = 1000;

export function encodeGetCfHeaders(
  startHeight: number,
  stopHash: Uint8Array,
  filterType = FILTER_TYPE_BASIC,
): Uint8Array {
  if (stopHash.length !== 32) throw new Error('stopHash must be 32 bytes');
  return new ByteWriter()
    .writeU8(filterType)
    .writeU32LE(startHeight)
    .writeBytes(stopHash)
    .toBytes();
}

export interface CfHeadersMessage {
  filterType: number;
  /** internal 순서. */
  stopHash: Uint8Array;
  previousFilterHeader: Uint8Array;
  filterHashes: Uint8Array[];
}

export function decodeCfHeaders(payload: Uint8Array): CfHeadersMessage {
  const r = new ByteReader(payload);
  const filterType = r.readU8();
  const stopHash = new Uint8Array(r.readBytes(32));
  const previousFilterHeader = new Uint8Array(r.readBytes(32));
  const count = Number(r.readVarint());
  const filterHashes: Uint8Array[] = [];
  for (let i = 0; i < count; i++) filterHashes.push(new Uint8Array(r.readBytes(32)));
  return { filterType, stopHash, previousFilterHeader, filterHashes };
}

export function encodeGetCfilters(
  startHeight: number,
  stopHash: Uint8Array,
  filterType = FILTER_TYPE_BASIC,
): Uint8Array {
  if (stopHash.length !== 32) throw new Error('stopHash must be 32 bytes');
  return new ByteWriter()
    .writeU8(filterType)
    .writeU32LE(startHeight)
    .writeBytes(stopHash)
    .toBytes();
}

export interface CfilterMessage {
  filterType: number;
  /** internal 순서. */
  blockHash: Uint8Array;
  /** GCS 필터 원문 (N varint 포함) — gcs.ts 가 해석. */
  filterBytes: Uint8Array;
}

export function decodeCfilter(payload: Uint8Array): CfilterMessage {
  const r = new ByteReader(payload);
  const filterType = r.readU8();
  const blockHash = new Uint8Array(r.readBytes(32));
  const filterBytes = new Uint8Array(r.readVarBytes());
  return { filterType, blockHash, filterBytes };
}

// ---------------------------------------------------------------------------
// getdata / block / tx
// ---------------------------------------------------------------------------

export const INV_BLOCK = 2;
/** witness 포함 블록 요청 (BIP144). txid 계산은 stripped 기준이라 스캔에는 INV_BLOCK 으로 충분. */
export const INV_WITNESS_BLOCK = 0x40000002;

export function encodeGetData(entries: { type: number; hash: Uint8Array }[]): Uint8Array {
  const w = new ByteWriter().writeVarint(entries.length);
  for (const e of entries) {
    if (e.hash.length !== 32) throw new Error('inv hash must be 32 bytes');
    w.writeU32LE(e.type).writeBytes(e.hash);
  }
  return w.toBytes();
}

export interface TxInput {
  /** internal 순서. */
  prevTxid: Uint8Array;
  prevVout: number;
  scriptSig: Uint8Array;
  sequence: number;
}

export interface TxOutput {
  value: bigint;
  scriptPubKey: Uint8Array;
}

export interface DecodedTx {
  /** dsha256(stripped serialization) — internal 순서. */
  txid: Uint8Array;
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
  hasWitness: boolean;
}

export function isCoinbase(tx: DecodedTx): boolean {
  return (
    tx.inputs.length === 1 &&
    tx.inputs[0]!.prevVout === 0xffffffff &&
    bytesEqual(tx.inputs[0]!.prevTxid, ZERO_HASH)
  );
}

/** 트랜잭션 하나 디코드 — segwit(마커 0x00 0x01) 지원, txid 는 stripped 재직렬화로 계산. */
export function decodeTx(r: ByteReader): DecodedTx {
  const version = r.readI32LE();

  // segwit 마커 감지: 다음 바이트가 0x00 이면 (입력 0개인 tx 는 비표준) marker+flag.
  let hasWitness = false;
  const peekOffset = r.offset;
  const marker = r.readU8();
  let inputCount: number;
  if (marker === 0x00) {
    const flag = r.readU8();
    if (flag !== 0x01) throw new Error(`tx: bad segwit flag 0x${flag.toString(16)}`);
    hasWitness = true;
    inputCount = Number(r.readVarint());
  } else {
    r.offset = peekOffset;
    inputCount = Number(r.readVarint());
  }

  const inputs: TxInput[] = [];
  for (let i = 0; i < inputCount; i++) {
    inputs.push({
      prevTxid: new Uint8Array(r.readBytes(32)),
      prevVout: r.readU32LE(),
      scriptSig: new Uint8Array(r.readVarBytes()),
      sequence: r.readU32LE(),
    });
  }

  const outputCount = Number(r.readVarint());
  const outputs: TxOutput[] = [];
  for (let i = 0; i < outputCount; i++) {
    outputs.push({
      value: r.readU64LE(),
      scriptPubKey: new Uint8Array(r.readVarBytes()),
    });
  }

  if (hasWitness) {
    // 각 입력마다 witness 스택 — txid 에는 들어가지 않으므로 소비만 한다.
    for (let i = 0; i < inputCount; i++) {
      const stackItems = Number(r.readVarint());
      for (let j = 0; j < stackItems; j++) r.readVarBytes();
    }
  }

  const lockTime = r.readU32LE();

  // txid = dsha256(stripped serialization) — marker/flag/witness 제외 재직렬화.
  const w = new ByteWriter().writeU32LE(version >>> 0).writeVarint(inputs.length);
  for (const inp of inputs) {
    w.writeBytes(inp.prevTxid)
      .writeU32LE(inp.prevVout)
      .writeVarBytes(inp.scriptSig)
      .writeU32LE(inp.sequence);
  }
  w.writeVarint(outputs.length);
  for (const out of outputs) w.writeU64LE(out.value).writeVarBytes(out.scriptPubKey);
  w.writeU32LE(lockTime);
  const txid = dsha256(w.toBytes());

  return { txid, version, inputs, outputs, lockTime, hasWitness };
}

export interface DecodedBlock {
  header: BlockHeader;
  transactions: DecodedTx[];
}

export function decodeBlock(payload: Uint8Array): DecodedBlock {
  const r = new ByteReader(payload);
  const header = decodeBlockHeader(r);
  const txCount = Number(r.readVarint());
  const transactions: DecodedTx[] = [];
  for (let i = 0; i < txCount; i++) transactions.push(decodeTx(r));
  return { header, transactions };
}
