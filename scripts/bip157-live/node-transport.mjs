// node-transport.mjs — node:net 기반 ByteTransport 구현 (bip157-live 시험용).
// 계약: packages/wallet-sdk/src/btc-history/transport.ts 의 ByteTransport.
//   connect(host, port, opts?) / send(bytes) / onData(cb) / onClose(cb) / close()
// 부가(비표준): _bytesIn / _bytesOut — 소켓 단위 송수신 바이트 실측 카운터.

import net from 'node:net';
import tls from 'node:tls';

export function createNodeTcpTransport() {
  /** @type {import('node:net').Socket | import('node:tls').TLSSocket | null} */
  let socket = null;
  /** @type {((bytes: Uint8Array) => void) | null} */
  let dataCb = null;
  /** @type {((err?: Error) => void) | null} */
  let closeCb = null;
  let closed = false;
  let closeNotified = false;
  /** @type {Error | undefined} */
  let pendingErr;

  const notifyClose = (err) => {
    if (closeNotified) return;
    closeNotified = true;
    if (closeCb) closeCb(err);
  };

  const transport = {
    _bytesIn: 0,
    _bytesOut: 0,

    connect(host, port, opts) {
      if (socket) return Promise.reject(new Error('transport: already connected'));
      if (closed) return Promise.reject(new Error('transport: closed'));
      const timeoutMs = opts?.timeoutMs ?? 8000;

      return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const err = new Error(`transport: connect timeout after ${timeoutMs}ms (${host}:${port})`);
          try { sock.destroy(err); } catch { /* ignore */ }
          reject(err);
        }, timeoutMs);

        const onConnect = () => {
          if (settled) { return; }
          settled = true;
          clearTimeout(timer);
          resolve();
        };

        const sock = opts?.tls
          ? tls.connect({ host, port, servername: host }, onConnect)
          : net.connect({ host, port }, onConnect);
        socket = sock;

        sock.on('data', (chunk) => {
          transport._bytesIn += chunk.length;
          if (dataCb) dataCb(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.length));
        });

        sock.on('error', (err) => {
          pendingErr = err;
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            reject(err);
          }
          // 'close' 가 뒤따라오며 notifyClose(pendingErr) 를 수행한다.
        });

        sock.on('close', () => {
          closed = true;
          notifyClose(pendingErr);
        });
      });
    },

    send(bytes) {
      if (!socket || closed || socket.destroyed) {
        return Promise.reject(new Error('transport: not connected'));
      }
      return new Promise((resolve, reject) => {
        socket.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), (err) => {
          if (err) reject(err);
          else {
            transport._bytesOut += bytes.byteLength;
            resolve();
          }
        });
      });
    },

    onData(cb) {
      dataCb = cb;
    },

    onClose(cb) {
      closeCb = cb;
      // 이미 닫힌 뒤 등록되면 즉시 통지 (idempotent close 와 짝).
      if (closed && !closeNotified) notifyClose(pendingErr);
    },

    close() {
      if (closed && (!socket || socket.destroyed)) {
        closed = true;
        return Promise.resolve();
      }
      closed = true;
      const sock = socket;
      if (!sock) return Promise.resolve();
      return new Promise((resolve) => {
        if (sock.destroyed) { resolve(); return; }
        sock.once('close', () => resolve());
        sock.destroy();
      });
    },
  };

  return transport;
}
