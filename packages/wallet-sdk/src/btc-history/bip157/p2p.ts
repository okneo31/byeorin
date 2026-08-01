// p2p.ts — 비트코인 P2P 메시지 프레이밍 + version/verack 핸드셰이크 페이로드.
//
// 프레임: magic(4) + command(12, ASCII null 패딩) + length(4 LE) + checksum(4) + payload.
// checksum = dsha256(payload) 앞 4바이트.
//
// 규칙: 순수 함수·순수 상태기계만. 소켓·전송 없음 (scan.ts 의 몫).
//   - sendheaders: 페이로드 없는 협상 메시지 — 우리는 무시한다 (scan.ts 의 무시 목록).
//   - ping → pong: 페이로드 빌더/파서만 여기, 자동 응답은 scan.ts.

import { randomBytes } from '@noble/hashes/utils';

import {
  ByteReader,
  ByteWriter,
  bytesEqual,
  concatBytes,
  dsha256,
} from './messages.js';

// ---------------------------------------------------------------------------
// 네트워크 매직 · 서비스 플래그
// ---------------------------------------------------------------------------

/** mainnet 매직 f9beb4d9. */
export const MAINNET_MAGIC = new Uint8Array([0xf9, 0xbe, 0xb4, 0xd9]);
/** testnet3 매직 (참고용 — 기본은 mainnet). */
export const TESTNET_MAGIC = new Uint8Array([0x0b, 0x11, 0x09, 0x07]);

export const SERVICE_NODE_NETWORK = 1n; // 0x01
export const SERVICE_NODE_WITNESS = 1n << 3n; // 0x08
/** BIP157/158 필터 제공 노드 — 핸드셰이크에서 이 비트를 요구한다. */
export const SERVICE_NODE_COMPACT_FILTERS = 1n << 6n; // 0x40

export function hasCompactFilters(services: bigint): boolean {
  return (services & SERVICE_NODE_COMPACT_FILTERS) !== 0n;
}

// ---------------------------------------------------------------------------
// 프레이밍
// ---------------------------------------------------------------------------

export interface P2PMessage {
  command: string;
  payload: Uint8Array;
}

const HEADER_SIZE = 24;
/** 비트코인 컨센서스 최대 메시지보다 넉넉한 상한 — 폭주 방어. */
const MAX_PAYLOAD_SIZE = 32 * 1024 * 1024;

export function checksum(payload: Uint8Array): Uint8Array {
  return dsha256(payload).slice(0, 4);
}

export function encodeCommand(command: string): Uint8Array {
  const out = new Uint8Array(12);
  for (let i = 0; i < command.length; i++) {
    const c = command.charCodeAt(i);
    if (i >= 12 || c === 0 || c > 0x7f) throw new Error(`invalid command: ${command}`);
    out[i] = c;
  }
  return out;
}

export function decodeCommand(bytes: Uint8Array): string {
  let end = 0;
  while (end < 12 && bytes[end] !== 0) end++;
  // null 패딩 뒤에 non-null 이 오면 규격 위반
  for (let i = end; i < 12; i++) {
    if (bytes[i] !== 0) throw new Error('command: non-null after padding');
  }
  let s = '';
  for (let i = 0; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
}

/** 완성 프레임 한 개 인코드. */
export function encodeMessage(
  command: string,
  payload: Uint8Array,
  magic: Uint8Array = MAINNET_MAGIC,
): Uint8Array {
  const w = new ByteWriter()
    .writeBytes(magic)
    .writeBytes(encodeCommand(command))
    .writeU32LE(payload.length)
    .writeBytes(checksum(payload))
    .writeBytes(payload);
  return w.toBytes();
}

/**
 * 스트림 → 프레임 조립기. ByteTransport.onData 가 주는 임의 조각을 push 하면
 * 완성된 메시지 배열을 돌려준다. push 는 chunk 를 복사해 보관한다 — 셸 전송이
 * 재사용 버퍼를 넘겨도 안전하다 (계약을 셸 3종에 강제하는 것보다 프레임 1개분
 * 복사가 싸다). 매직/체크섬 불일치는 즉시 throw — 스트림 동기가
 * 깨진 것이므로 연결을 끊는 것이 맞다.
 */
export class P2PFrameDecoder {
  private buffer: Uint8Array = new Uint8Array(0);

  constructor(private readonly magic: Uint8Array = MAINNET_MAGIC) {}

  push(chunk: Uint8Array): P2PMessage[] {
    // 버퍼가 비어 있을 때만 호출자 버퍼 참조가 남는다 — 그 경로만 복사한다.
    // (concatBytes 경로는 이미 복사, 이후 subarray 는 자기 소유 버퍼의 뷰)
    this.buffer = this.buffer.length === 0 ? chunk.slice() : concatBytes(this.buffer, chunk);
    const out: P2PMessage[] = [];
    for (;;) {
      if (this.buffer.length < HEADER_SIZE) break;
      if (!bytesEqual(this.buffer.subarray(0, 4), this.magic)) {
        throw new Error('p2p: bad magic — stream out of sync');
      }
      const r = new ByteReader(this.buffer, 4);
      const command = decodeCommand(r.readBytes(12));
      const length = r.readU32LE();
      if (length > MAX_PAYLOAD_SIZE) throw new Error(`p2p: payload too large (${length})`);
      const expectChecksum = r.readBytes(4);
      if (this.buffer.length < HEADER_SIZE + length) break; // 더 기다림
      const payload = new Uint8Array(
        this.buffer.subarray(HEADER_SIZE, HEADER_SIZE + length),
      );
      if (!bytesEqual(checksum(payload), expectChecksum)) {
        throw new Error(`p2p: bad checksum for '${command}'`);
      }
      this.buffer = this.buffer.subarray(HEADER_SIZE + length);
      out.push({ command, payload });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------
// version / verack
// ---------------------------------------------------------------------------

export const DEFAULT_USER_AGENT = '/byeorin-bip157:0.0.1/';

export interface VersionFields {
  version: number;
  services: bigint;
  timestamp: bigint;
  nonce: bigint;
  userAgent: string;
  startHeight: number;
  relay: boolean;
}

export interface BuildVersionOptions {
  /** 우리가 제공하는 서비스 — 라이트클라이언트는 0. */
  services?: bigint;
  timestampSec?: bigint;
  nonce?: bigint;
  userAgent?: string;
  startHeight?: number;
  /** BIP37 relay — false 면 상대가 tx 를 밀어주지 않는다 (필터 스캔에 적합). */
  relay?: boolean;
  protocolVersion?: number;
}

/** u64 nonce — 자기연결 감지용이므로 64비트 전역을 CSPRNG 로 채운다.
 *  @noble/hashes randomBytes = globalThis.crypto 기반 — 전 셸 공통. */
function randomNonce64(): bigint {
  const b = randomBytes(8);
  return new DataView(b.buffer, b.byteOffset, 8).getBigUint64(0, true);
}

/** net_addr (version 메시지 내부, 타임스탬프 없는 26바이트): services + IPv6(16) + port(BE). */
function writeNetAddr(w: ByteWriter, services: bigint): void {
  w.writeU64LE(services).writeBytes(new Uint8Array(16)).writeU16BE(0);
}

export function buildVersionPayload(opts: BuildVersionOptions = {}): Uint8Array {
  const {
    services = 0n,
    timestampSec = BigInt(Math.floor(Date.now() / 1000)),
    nonce = randomNonce64(),
    userAgent = DEFAULT_USER_AGENT,
    startHeight = 0,
    relay = false,
    protocolVersion = 70016,
  } = opts;

  const w = new ByteWriter()
    .writeU32LE(protocolVersion)
    .writeU64LE(services)
    .writeU64LE(timestampSec);
  writeNetAddr(w, 0n); // addr_recv — 익명 스캔이므로 0 주소
  writeNetAddr(w, services); // addr_from
  w.writeU64LE(nonce);
  const ua = new TextEncoder().encode(userAgent);
  w.writeVarint(ua.length).writeBytes(ua);
  w.writeU32LE(startHeight);
  w.writeU8(relay ? 1 : 0);
  return w.toBytes();
}

export function parseVersionPayload(payload: Uint8Array): VersionFields {
  const r = new ByteReader(payload);
  const version = r.readI32LE();
  const services = r.readU64LE();
  const timestamp = r.readU64LE();
  r.readBytes(26); // addr_recv
  r.readBytes(26); // addr_from
  const nonce = r.readU64LE();
  const ua = r.readVarBytes();
  const userAgent = new TextDecoder().decode(ua);
  const startHeight = r.readI32LE();
  // relay 필드는 70001+ 에서 선택적
  const relay = r.remaining > 0 ? r.readU8() !== 0 : true;
  return { version, services, timestamp, nonce, userAgent, startHeight, relay };
}

/** verack 은 페이로드 없음 — 프레임 전체를 돌려준다. */
export function buildVerackMessage(magic: Uint8Array = MAINNET_MAGIC): Uint8Array {
  return encodeMessage('verack', new Uint8Array(0), magic);
}

// ---------------------------------------------------------------------------
// ping / pong
// ---------------------------------------------------------------------------

export function buildPingPayload(nonce: bigint): Uint8Array {
  return new ByteWriter().writeU64LE(nonce).toBytes();
}

export function parsePingPayload(payload: Uint8Array): bigint {
  return new ByteReader(payload).readU64LE();
}

/** ping 을 받으면 같은 nonce 로 pong. */
export function buildPongPayload(pingNonce: bigint): Uint8Array {
  return buildPingPayload(pingNonce);
}
