// ws-tcp-transport.ts — BTC 이력 트랙 D: WebSocket 릴레이 위의 ByteTransport (확장 셸).
//
// MV3 확장은 raw TCP 를 못 연다. 대신 로컬 릴레이(scripts/btc-relay/server.mjs)에
// WebSocket 으로 붙고, 릴레이가 대상 TCP(Electrum 등)로 이어준다. 이 클래스는 그
// WebSocket 을 packages/wallet-sdk/src/btc-history/transport.ts 의 ByteTransport
// 계약으로 감싼다 — Electrum/BIP157 프로토콜 계층은 이 뒤에서 셸 구분 없이 동작한다.
//
// MV3 에서 ws://localhost 가 되는 근거 (scripts/btc-relay/README.md 에 상세):
//   - WebSocket 은 CORS 를 타지 않아 host_permissions 불필요.
//   - 이 확장의 CSP(extension_pages)에 connect-src 제한이 없다 (wxt.config.ts).
//   - localhost 는 potentially trustworthy origin 이라 ws:(비암호화)여도 mixed
//     content 차단을 받지 않는다.
//   - 서비스 워커에서 쓰려면 Chrome 116+ (WS 메시지가 SW 활동으로 인정).
//
// import 경로 주의: wallet-sdk 의 package exports 에 btc-history 서브패스가 아직
// 없고 배럴 수정은 D 트랙 범위 밖이라, 계약 파일을 상대 경로로 type-only import
// 한다 (타입만 쓰므로 번들 결과물에는 아무것도 끌려오지 않는다).

import type {
  ByteTransport,
  ByteTransportOptions,
} from '../../../../packages/wallet-sdk/src/btc-history/transport';

const DEFAULT_CONNECT_TIMEOUT_MS = 8000; // 계약 권장값 — 첫 화면을 막지 않는다.

/**
 * WebSocket→TCP 릴레이 위의 ByteTransport.
 * relayUrl 은 생성자 주입 — 예: 'ws://127.0.0.1:18337'.
 * 1 인스턴스 = 1 연결. 재연결은 새 인스턴스로 한다 (다른 셸 구현과 동일 규약).
 */
export class WsTcpTransport implements ByteTransport {
  private readonly relayUrl: string;
  private ws: WebSocket | null = null;
  private dataCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;
  private closeNotified = false;

  constructor(relayUrl: string) {
    // 뒤 슬래시는 흡수 — 'ws://h:p/' 와 'ws://h:p' 모두 허용.
    this.relayUrl = relayUrl.replace(/\/+$/, '');
  }

  connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void> {
    if (this.ws) return Promise.reject(new Error('WsTcpTransport: already connected'));
    const url =
      `${this.relayUrl}/tcp?host=${encodeURIComponent(host)}` +
      `&port=${port}&tls=${opts?.tls ? 1 : 0}`;
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, 'binary');
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        this.ws = null;
        reject(new Error(`WsTcpTransport: relay connect timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };

      ws.onmessage = (ev: MessageEvent) => {
        if (!this.dataCb) return;
        if (ev.data instanceof ArrayBuffer) {
          this.dataCb(new Uint8Array(ev.data));
        } else if (typeof ev.data === 'string') {
          // 릴레이는 바이너리만 보낸다 — 방어적으로 텍스트도 바이트로 넘긴다.
          this.dataCb(new TextEncoder().encode(ev.data));
        }
      };

      // 브라우저 WebSocket 의 error 이벤트에는 상세가 없다 — close 가 항상 뒤따르므로
      // 실패 사유는 close 쪽에서 일괄 처리한다.
      ws.onclose = (ev: CloseEvent) => {
        clearTimeout(timer);
        this.ws = null;
        if (!settled) {
          // open 전에 닫힘 = 연결 실패 (릴레이 미가동, 403 화이트리스트 거부 등).
          settled = true;
          reject(
            new Error(
              `WsTcpTransport: relay connection failed (code=${ev.code}` +
                `${ev.reason ? `, reason=${ev.reason}` : ''})`
            )
          );
          return;
        }
        if (this.closeNotified) return;
        this.closeNotified = true;
        const abnormal = !ev.wasClean || (ev.code !== 1000 && ev.code !== 1005);
        this.closeCb?.(
          abnormal
            ? new Error(`WsTcpTransport: closed abnormally (code=${ev.code}` +
                `${ev.reason ? `, reason=${ev.reason}` : ''})`)
            : undefined
        );
      };
    });
  }

  send(bytes: Uint8Array): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WsTcpTransport: not connected'));
    }
    ws.send(bytes);
    return Promise.resolve();
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCb = cb;
  }

  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }

  close(): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      this.ws = null;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const prev = ws.onclose;
      ws.onclose = (ev: CloseEvent) => {
        // 기존 핸들러(onClose 콜백 통지)를 유지한 채 close() 대기도 푼다.
        if (typeof prev === 'function') prev.call(ws, ev);
        resolve();
      };
      ws.close(1000);
    });
  }
}
