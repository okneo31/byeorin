// gcs.ts — BIP158 Golomb-coded set (basic filter) 디코드·매칭 + 검증용 인코드.
//
// 파라미터 (BIP158 basic filter): P = 19, M = 784931.
// 키 = 블록해시(internal 순서) 앞 16바이트.
// 해시 함수 = SipHash-2-4. 외부 의존 추가 금지이므로 아래에 직접 구현 —
// SipHash 논문(Aumasson & Bernstein, "SipHash: a fast short-input PRF") 부록의
// 공식 테스트 벡터 64개(레퍼런스 구현 veorq/SipHash vectors.h 의 vectors_sip64)로
// 테스트에서 검증한다. GCS 전체는 BIP158 부록 테스트 벡터
// (bitcoin/bips bip-0158/testnet-19.json)로 검증한다.
//
// 규칙: 순수 함수만. 네트워크·전송 없음.

import { concatBytes, decodeVarint, dsha256, encodeVarint } from './messages.js';

// ---------------------------------------------------------------------------
// SipHash-2-4 (64비트 출력) — BigInt 구현. 짧은 입력(스크립트) 대상이라 충분히 빠름.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;

function rotl(x: bigint, b: bigint): bigint {
  return ((x << b) | (x >> (64n - b))) & MASK64;
}

function readU64LE(b: Uint8Array, off: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[off + i]!);
  return v;
}

/** SipHash-2-4. key 는 16바이트, 반환은 64비트 bigint. */
export function siphash24(key: Uint8Array, data: Uint8Array): bigint {
  if (key.length !== 16) throw new Error('siphash key must be 16 bytes');
  const k0 = readU64LE(key, 0);
  const k1 = readU64LE(key, 8);

  let v0 = 0x736f6d6570736575n ^ k0;
  let v1 = 0x646f72616e646f6dn ^ k1;
  let v2 = 0x6c7967656e657261n ^ k0;
  let v3 = 0x7465646279746573n ^ k1;

  const sipround = (): void => {
    v0 = (v0 + v1) & MASK64;
    v1 = rotl(v1, 13n);
    v1 ^= v0;
    v0 = rotl(v0, 32n);
    v2 = (v2 + v3) & MASK64;
    v3 = rotl(v3, 16n);
    v3 ^= v2;
    v0 = (v0 + v3) & MASK64;
    v3 = rotl(v3, 21n);
    v3 ^= v0;
    v2 = (v2 + v1) & MASK64;
    v1 = rotl(v1, 17n);
    v1 ^= v2;
    v2 = rotl(v2, 32n);
  };

  const len = data.length;
  const wholeWords = len >> 3;
  for (let i = 0; i < wholeWords; i++) {
    const m = readU64LE(data, i * 8);
    v3 ^= m;
    sipround();
    sipround();
    v0 ^= m;
  }

  // 마지막 워드: 남은 바이트 + 최상위 바이트에 (len mod 256)
  let last = (BigInt(len) & 0xffn) << 56n;
  for (let i = len - (len & 7); i < len; i++) {
    last |= BigInt(data[i]!) << BigInt(8 * (i & 7));
  }
  v3 ^= last;
  sipround();
  sipround();
  v0 ^= last;

  v2 ^= 0xffn;
  sipround();
  sipround();
  sipround();
  sipround();
  return (v0 ^ v1 ^ v2 ^ v3) & MASK64;
}

// ---------------------------------------------------------------------------
// BIP158 GCS
// ---------------------------------------------------------------------------

/** Golomb-Rice 나머지 비트 수. */
export const GCS_P = 19;
/** 목표 오탐률 파라미터 — 항목당 범위 = N × M. */
export const GCS_M = 784931;

/** 필터 키 = 블록해시(internal 순서) 앞 16바이트. */
export function filterKeyFromBlockHash(blockHashInternal: Uint8Array): Uint8Array {
  if (blockHashInternal.length !== 32) throw new Error('block hash must be 32 bytes');
  return blockHashInternal.slice(0, 16);
}

/** 항목 → [0, f) 범위 값. f = N × M. (siphash × f) >> 64 — 128비트 곱을 BigInt 로. */
export function hashToRange(item: Uint8Array, f: bigint, key: Uint8Array): bigint {
  return (siphash24(key, item) * f) >> 64n;
}

// MSB-우선 비트 스트림
class BitReader {
  private bitPos = 0;
  constructor(private readonly buf: Uint8Array) {}

  readBit(): number {
    const byteIdx = this.bitPos >> 3;
    if (byteIdx >= this.buf.length) throw new Error('gcs: bit stream exhausted');
    const bit = (this.buf[byteIdx]! >> (7 - (this.bitPos & 7))) & 1;
    this.bitPos++;
    return bit;
  }

  readBits(n: number): bigint {
    let v = 0n;
    for (let i = 0; i < n; i++) v = (v << 1n) | BigInt(this.readBit());
    return v;
  }

  /** Golomb-Rice: 단항 몫(1…10) + P비트 나머지. */
  readGolombRice(p: number): bigint {
    let q = 0n;
    while (this.readBit() === 1) q++;
    const r = this.readBits(p);
    return (q << BigInt(p)) | r;
  }
}

class BitWriter {
  private bytes: number[] = [];
  private cur = 0;
  private curBits = 0;

  writeBit(bit: number): void {
    this.cur = (this.cur << 1) | (bit & 1);
    this.curBits++;
    if (this.curBits === 8) {
      this.bytes.push(this.cur);
      this.cur = 0;
      this.curBits = 0;
    }
  }

  writeBits(value: bigint, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.writeBit(Number((value >> BigInt(i)) & 1n));
  }

  writeGolombRice(value: bigint, p: number): void {
    let q = value >> BigInt(p);
    while (q > 0n) {
      this.writeBit(1);
      q--;
    }
    this.writeBit(0);
    this.writeBits(value & ((1n << BigInt(p)) - 1n), p);
  }

  /** 남은 비트는 0 패딩. */
  toBytes(): Uint8Array {
    const out = this.bytes.slice();
    if (this.curBits > 0) out.push((this.cur << (8 - this.curBits)) & 0xff);
    return new Uint8Array(out);
  }
}

/**
 * 필터 인코드 (검증·왕복 테스트용 — 지갑 스캔 자체는 디코드/매칭만 쓴다).
 * items 는 원시 바이트 항목(스크립트) — 동일 항목은 중복 제거 후 N 을 센다.
 */
export function encodeGcsFilter(
  items: Uint8Array[],
  key: Uint8Array,
  p = GCS_P,
  m = GCS_M,
): Uint8Array {
  // 원시 항목 중복 제거 (BIP158: 필터 내용은 집합)
  const seen = new Set<string>();
  const unique: Uint8Array[] = [];
  for (const it of items) {
    const k = Array.from(it, (b) => b.toString(16).padStart(2, '0')).join('');
    if (!seen.has(k)) {
      seen.add(k);
      unique.push(it);
    }
  }

  const n = unique.length;
  if (n === 0) return encodeVarint(0); // "00" — 빈 필터 (BIP158 벡터 height 1414221)

  const f = BigInt(n) * BigInt(m);
  const values = unique.map((it) => hashToRange(it, f, key)).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const w = new BitWriter();
  let prev = 0n;
  for (const v of values) {
    w.writeGolombRice(v - prev, p); // 해시 충돌 시 delta 0 도 그대로 기록
    prev = v;
  }
  return concatBytes(encodeVarint(n), w.toBytes());
}

/** 필터 전체 디코드 — 항목 해시값 목록 복원 (검증·디버깅용). */
export function decodeGcsFilterValues(
  filterBytes: Uint8Array,
  p = GCS_P,
): { n: number; values: bigint[] } {
  const { value: nBig, size } = decodeVarint(filterBytes, 0);
  const n = Number(nBig);
  const values: bigint[] = [];
  if (n === 0) return { n, values };
  const r = new BitReader(filterBytes.subarray(size));
  let acc = 0n;
  for (let i = 0; i < n; i++) {
    acc += r.readGolombRice(p);
    values.push(acc);
  }
  return { n, values };
}

/**
 * 관심 항목 중 하나라도 필터에 들었는지 검사 (오탐 확률 ≈ 1/M per item).
 * targets 를 먼저 해시·정렬한 뒤 필터 값과 병합 순회 — 필터는 한 번만 디코드.
 */
export function gcsMatchAny(
  filterBytes: Uint8Array,
  key: Uint8Array,
  targets: Uint8Array[],
  p = GCS_P,
  m = GCS_M,
): boolean {
  if (targets.length === 0) return false;
  const { value: nBig, size } = decodeVarint(filterBytes, 0);
  const n = Number(nBig);
  if (n === 0) return false;

  const f = BigInt(n) * BigInt(m);
  const targetHashes = targets
    .map((t) => hashToRange(t, f, key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const r = new BitReader(filterBytes.subarray(size));
  let acc = 0n;
  let ti = 0;
  for (let i = 0; i < n; i++) {
    acc += r.readGolombRice(p);
    while (ti < targetHashes.length && targetHashes[ti]! < acc) ti++;
    if (ti === targetHashes.length) return false; // 남은 타깃 없음
    if (targetHashes[ti] === acc) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 필터 헤더 체인 (BIP157)
// ---------------------------------------------------------------------------

/** filter_hash = dsha256(필터 원문). internal 순서. */
export function computeFilterHash(filterBytes: Uint8Array): Uint8Array {
  return dsha256(filterBytes);
}

/** filter_header = dsha256(filter_hash ‖ prev_filter_header). internal 순서. */
export function computeFilterHeader(
  filterHash: Uint8Array,
  prevFilterHeader: Uint8Array,
): Uint8Array {
  if (filterHash.length !== 32 || prevFilterHeader.length !== 32) {
    throw new Error('filter header inputs must be 32 bytes');
  }
  return dsha256(concatBytes(filterHash, prevFilterHeader));
}
