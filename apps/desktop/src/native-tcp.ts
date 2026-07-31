// native-tcp.ts — 데스크톱(Tauri 2) ByteTransport 구현.
//
// packages/wallet-sdk/src/btc-history/transport.ts 의 계약을 Rust 측
// src-tauri/src/tcp_bridge.rs (tcp_open / tcp_write / tcp_close 커맨드 +
// "tcp-data"/"tcp-close" 이벤트)로 만족시킨다.
//
// - 계약 타입은 type-only import 라 런타임 의존이 없다 (wallet-sdk 의 exports
//   맵은 dist 만 노출하므로 상대 경로로 소스 타입만 집는다).
// - 인스턴스는 1회용: connect 는 한 번만. 재연결은 새 인스턴스로.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type {
  ByteTransport,
  ByteTransportOptions,
} from '../../../packages/wallet-sdk/src/btc-history/transport';

interface TcpDataEvent {
  socketId: number;
  base64: string;
}

interface TcpCloseEvent {
  socketId: number;
  error?: string | null;
}

type DataCb = (bytes: Uint8Array) => void;
type CloseCb = (err?: Error) => void;

// ── base64 ↔ bytes (웹뷰 내장 atob/btoa, 대용량 대비 청크 인코딩) ─────────

const B64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += B64_CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + B64_CHUNK));
  }
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── 전송 구현 ─────────────────────────────────────────────────────────────

export class TauriTcpTransport implements ByteTransport {
  private socketId: number | null = null;
  private connecting = false;
  private closeFired = false;
  private dataCbs: DataCb[] = [];
  private closeCbs: CloseCb[] = [];
  private unlisteners: UnlistenFn[] = [];
  // tcp_open 반환 전(자기 socketId 를 모르는 동안) 도착한 이벤트 버퍼.
  // id 확정 직후 같은 동기 블록에서 재생하므로 순서가 섞이지 않는다.
  private pendingData: TcpDataEvent[] = [];
  private pendingClose: TcpCloseEvent[] = [];

  async connect(
    host: string,
    port: number,
    opts?: ByteTransportOptions,
  ): Promise<void> {
    if (this.socketId !== null || this.connecting) {
      throw new Error('TauriTcpTransport: 이미 연결됨 — 인스턴스는 1회용');
    }
    this.connecting = true;

    // 리스너를 tcp_open 보다 먼저 등록 — 연결 직후 수신분 유실 방지.
    this.unlisteners.push(
      await listen<TcpDataEvent>('tcp-data', (e) => {
        if (this.socketId === null) {
          if (this.connecting) this.pendingData.push(e.payload);
          return;
        }
        if (e.payload.socketId === this.socketId) this.fireData(e.payload);
      }),
      await listen<TcpCloseEvent>('tcp-close', (e) => {
        if (this.socketId === null) {
          if (this.connecting) this.pendingClose.push(e.payload);
          return;
        }
        if (e.payload.socketId === this.socketId) {
          this.fireClose(e.payload.error ?? undefined);
        }
      }),
    );

    try {
      this.socketId = await invoke<number>('tcp_open', {
        host,
        port,
        tls: opts?.tls ?? false,
        timeoutMs: opts?.timeoutMs ?? null,
      });
    } catch (err) {
      this.connecting = false;
      await this.teardown();
      throw err instanceof Error ? err : new Error(String(err));
    }
    this.connecting = false;

    // id 확정 전 버퍼분 재생 (타 인스턴스 소켓분은 버린다).
    for (const p of this.pendingData.splice(0)) {
      if (p.socketId === this.socketId) this.fireData(p);
    }
    for (const p of this.pendingClose.splice(0)) {
      if (p.socketId === this.socketId) this.fireClose(p.error ?? undefined);
    }
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.socketId === null) {
      throw new Error('TauriTcpTransport: 연결 전에는 send 불가');
    }
    if (this.closeFired) {
      throw new Error('TauriTcpTransport: 종료된 소켓에 send 불가');
    }
    await invoke('tcp_write', {
      socketId: this.socketId,
      base64: bytesToBase64(bytes),
    });
  }

  onData(cb: DataCb): void {
    this.dataCbs.push(cb);
  }

  onClose(cb: CloseCb): void {
    this.closeCbs.push(cb);
  }

  async close(): Promise<void> {
    if (this.socketId === null || this.closeFired) return;
    const id = this.socketId;
    // Rust 쪽 tcp_close 는 읽기 태스크를 abort 하므로 "tcp-close" 이벤트가
    // 오지 않는다 — 자발적 종료의 onClose(무오류) 통지는 여기서 직접 한다.
    await invoke('tcp_close', { socketId: id });
    this.fireClose();
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private fireData(p: TcpDataEvent): void {
    if (this.closeFired) return;
    const bytes = base64ToBytes(p.base64);
    for (const cb of this.dataCbs) cb(bytes);
  }

  private fireClose(error?: string): void {
    if (this.closeFired) return;
    this.closeFired = true;
    void this.teardown();
    const err = error !== undefined ? new Error(error) : undefined;
    for (const cb of this.closeCbs) cb(err);
  }

  private async teardown(): Promise<void> {
    const uns = this.unlisteners.splice(0);
    for (const un of uns) un();
  }
}

/** 셸 주입용 팩토리 — 호출부가 클래스에 결합하지 않게 한다. */
export function createNativeTcpTransport(): ByteTransport {
  return new TauriTcpTransport();
}
