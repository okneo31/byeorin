// native-tcp.ts — 네이티브 TcpSocket 플러그인을 ByteTransport 계약으로 감싼다.
//
// 배경: BTC 이력(Electrum, 트랙 B)은 원시 TCP/TLS 스트림을 요구하는데 WebView
// 에는 fetch/WebSocket 뿐이다. 안드로이드 셸은 네이티브 소켓을 직접 열 수
// 있으므로(TcpSocketPlugin.java) 릴레이 서버 없이 붙는다. 프로토콜 계층은
// ByteTransport 만 보고, 이 파일이 그 계약의 안드로이드 구현이다.
//
// 계약 출처: packages/wallet-sdk/src/btc-history/transport.ts — 아직 SDK 의
// export 표면(index/core/…)에 오르지 않아(다른 부대 담당) 소스에서 타입만
// 가져온다. type-only import 라 빌드 산출물에는 아무것도 끌려오지 않는다.
//
// 인스턴스 규칙: 연결 1회용. connect → send/onData → close 후 재사용 불가
// (재연결은 새 인스턴스). 상태 리셋 버그를 만들지 않기 위한 의도적 제약이다.

import { Capacitor, registerPlugin } from '@capacitor/core';
import type { PluginListenerHandle } from '@capacitor/core';
import type {
  ByteTransport,
  ByteTransportOptions,
} from '../../../packages/wallet-sdk/src/btc-history/transport';

/** 네이티브 표면 (TcpSocketPlugin.java 와 1:1). */
interface TcpSocketPlugin {
  open(options: {
    host: string;
    port: number;
    tls?: boolean;
    timeoutMs?: number;
  }): Promise<{ socketId: string }>;
  write(options: { socketId: string; base64: string }): Promise<void>;
  close(options: { socketId: string }): Promise<void>;
  addListener(
    eventName: 'data',
    listener: (ev: { socketId: string; base64: string }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'close',
    listener: (ev: { socketId: string; error?: string }) => void,
  ): Promise<PluginListenerHandle>;
}

const TcpSocket = registerPlugin<TcpSocketPlugin>('TcpSocket');

const DEFAULT_TIMEOUT_MS = 8000; // transport.ts 권장값 — 첫 화면을 막지 않는다.

// ── base64 ↔ Uint8Array ───────────────────────────────────────────────────
// 플러그인 브리지는 문자열만 나르므로 바이트는 base64 로 오간다. WebView 에는
// atob/btoa 가 항상 있다. spread 인자 수 제한(콜스택)을 피하려고 조각내 변환.

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

// ── ByteTransport 구현 ────────────────────────────────────────────────────

/**
 * 안드로이드 네이티브 TCP 전송. 웹(vite dev)에서는 connect 가 명확히 실패한다
 * — 조용히 다른 경로로 폴백해 "왜 이력이 안 오지" 를 만들지 않기 위해.
 */
export class NativeTcpTransport implements ByteTransport {
  private socketId: string | null = null;
  private connecting = false;
  private closed = false;

  private dataCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;

  /** onData 등록 전에 도착한 조각 — 등록 시 순서대로 흘려보낸다. */
  private early: Uint8Array[] = [];
  /**
   * connect 창(open 호출 → socketId 확정) 동안 도착한 이벤트의 대기석.
   * 네이티브 읽기 스레드는 open 응답보다 먼저 'data' 를 쏠 수 있는데, 그 시점의
   * JS 는 아직 자기 socketId 를 모른다. 버리면 첫 조각이 유실되므로 id 별로
   * 붙잡아 뒀다가 확정 후 내 것만 재생한다 (남의 것은 그 인스턴스의 리스너가
   * 각자 받으므로 여기서 버려도 된다).
   */
  private pendingData = new Map<string, Uint8Array[]>();
  private pendingClose = new Map<string, string | undefined>();

  private listeners: PluginListenerHandle[] = [];

  async connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void> {
    if (!Capacitor.isNativePlatform()) {
      throw new Error(
        'NativeTcpTransport 는 안드로이드 네이티브에서만 동작합니다 — ' +
          '웹/개발 서버(WebView 밖)에는 원시 TCP 소켓이 없습니다.',
      );
    }
    if (this.socketId !== null || this.connecting) {
      throw new Error('NativeTcpTransport 는 연결 1회용입니다 — 재연결은 새 인스턴스로.');
    }
    this.connecting = true;

    // 리스너를 open 보다 먼저 건다 — open 이 풀리기 전에 도착하는 조각까지 잡기 위해.
    this.listeners.push(
      await TcpSocket.addListener('data', (ev) => this.handleData(ev)),
      await TcpSocket.addListener('close', (ev) => this.handleClose(ev)),
    );

    try {
      const { socketId } = await TcpSocket.open({
        host,
        port,
        tls: opts?.tls ?? false,
        timeoutMs: opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
      this.socketId = socketId;

      // connect 창에 대기하던 내 이벤트를 순서대로 재생.
      const buffered = this.pendingData.get(socketId);
      const hadClose = this.pendingClose.has(socketId); // undefined 값 = 정상 종료라 has 로 판정
      const closeError = this.pendingClose.get(socketId);
      this.pendingData.clear();
      this.pendingClose.clear();
      if (buffered) for (const b of buffered) this.deliver(b);
      if (hadClose) this.finishClose(closeError);
    } catch (e) {
      this.connecting = false;
      await this.removeListeners();
      throw e instanceof Error ? e : new Error(String(e));
    } finally {
      this.connecting = false;
    }
  }

  async send(bytes: Uint8Array): Promise<void> {
    if (this.socketId === null || this.closed) {
      throw new Error('NativeTcpTransport: 연결 전이거나 이미 닫혔습니다.');
    }
    await TcpSocket.write({ socketId: this.socketId, base64: bytesToBase64(bytes) });
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCb = cb;
    // 등록 전 도착분을 순서 그대로 밀어준다.
    const backlog = this.early;
    this.early = [];
    for (const b of backlog) cb(b);
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }

  async close(): Promise<void> {
    if (this.socketId === null) {
      // 연결된 적 없음 — 리스너만 정리.
      await this.removeListeners();
      return;
    }
    if (!this.closed) {
      try {
        await TcpSocket.close({ socketId: this.socketId });
      } catch {
        // 네이티브 close 는 멱등이지만, 브리지 오류가 나도 정리는 계속한다.
      }
    }
    // 'close' 이벤트(handleClose)가 리스너 해제와 closeCb 호출을 마무리한다.
    // 이벤트가 이미 지나갔다면 closed=true 라 아래는 이중 해제 방지용 no-op.
    if (this.closed) await this.removeListeners();
  }

  // ── 내부 ────────────────────────────────────────────────────────────────

  private handleData(ev: { socketId: string; base64: string }): void {
    if (this.socketId === null) {
      if (this.connecting) {
        const arr = this.pendingData.get(ev.socketId) ?? [];
        arr.push(base64ToBytes(ev.base64));
        this.pendingData.set(ev.socketId, arr);
      }
      return;
    }
    if (ev.socketId !== this.socketId) return; // 다른 인스턴스의 소켓
    this.deliver(base64ToBytes(ev.base64));
  }

  private handleClose(ev: { socketId: string; error?: string }): void {
    if (this.socketId === null) {
      if (this.connecting) this.pendingClose.set(ev.socketId, ev.error);
      return;
    }
    if (ev.socketId !== this.socketId) return;
    this.finishClose(ev.error);
  }

  private deliver(bytes: Uint8Array): void {
    if (this.dataCb) this.dataCb(bytes);
    else this.early.push(bytes);
  }

  private finishClose(error?: string): void {
    if (this.closed) return;
    this.closed = true;
    void this.removeListeners();
    if (this.closeCb) this.closeCb(error !== undefined ? new Error(error) : undefined);
  }

  private async removeListeners(): Promise<void> {
    const handles = this.listeners;
    this.listeners = [];
    for (const h of handles) {
      try {
        await h.remove();
      } catch {
        // 브리지가 이미 내려간 경우 — 정리 실패는 치명적이지 않다.
      }
    }
  }
}
