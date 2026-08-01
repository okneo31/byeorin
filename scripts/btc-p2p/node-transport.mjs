// node-transport.mjs — 실피어 시험용 ByteTransport 구현 (node net/tls).
//
// 왜 저장소에 두는가: BIP157 실피어 통합 시험을 여러 부대가 동시에 돌린다.
// 각자 소켓 코드를 새로 쓰면 측정값이 구현 차이로 흔들린다 — 전송은 하나로
// 고정하고, 부대는 프로토콜·측정만 다르게 한다.
//
// 계약: packages/wallet-sdk/src/btc-history/transport.ts 의 ByteTransport.
// 셸 구현(안드로이드 Capacitor·데스크톱 Tauri·확장 WS 릴레이)과 같은 표면이다.

import net from 'node:net';
import tls from 'node:tls';

export class NodeTcpTransport {
  #sock = null;
  #dataCb = null;
  #closeCb = null;
  #backlog = [];
  #closed = false;

  async connect(host, port, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 8000;
    await new Promise((resolve, reject) => {
      const onErr = (e) => {
        cleanup();
        reject(e instanceof Error ? e : new Error(String(e)));
      };
      const onTimeout = () => {
        cleanup();
        this.#sock?.destroy();
        reject(new Error(`connect timeout ${timeoutMs}ms (${host}:${port})`));
      };
      const cleanup = () => {
        clearTimeout(timer);
        this.#sock?.off('error', onErr);
      };
      const timer = setTimeout(onTimeout, timeoutMs);

      this.#sock = opts.tls
        ? tls.connect({ host, port, servername: host }, () => {
            cleanup();
            resolve();
          })
        : net.connect({ host, port }, () => {
            cleanup();
            resolve();
          });
      this.#sock.once('error', onErr);
    });

    // Nagle 비활성 — 요청/응답 왕복 프로토콜에서 작은 프레임이 지연되면
    // 라운드트립이 2배로 뛴다 (실측 519ms → 259ms).
    this.#sock.setNoDelay(true);

    this.#sock.on('data', (buf) => {
      const bytes = new Uint8Array(buf);
      // onData 등록 전에 온 조각은 버려지면 안 된다 — 모아 뒀다 흘려보낸다.
      if (this.#dataCb) this.#dataCb(bytes);
      else this.#backlog.push(bytes);
    });
    this.#sock.on('close', (hadErr) => {
      this.#closed = true;
      this.#closeCb?.(hadErr ? new Error('socket closed with error') : undefined);
    });
    this.#sock.on('error', (e) => {
      this.#closed = true;
      this.#closeCb?.(e);
    });
  }

  async send(bytes) {
    if (!this.#sock || this.#closed) throw new Error('transport: not connected');
    await new Promise((resolve, reject) => {
      this.#sock.write(Buffer.from(bytes), (e) => (e ? reject(e) : resolve()));
    });
  }

  onData(cb) {
    this.#dataCb = cb;
    const pending = this.#backlog;
    this.#backlog = [];
    for (const b of pending) cb(b);
  }

  onClose(cb) {
    this.#closeCb = cb;
  }

  async close() {
    if (!this.#sock) return;
    this.#closed = true;
    await new Promise((resolve) => this.#sock.end(resolve));
    this.#sock.destroy();
  }
}
