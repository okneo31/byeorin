#!/usr/bin/env node
// server.mjs — BTC 이력 트랙 D: WebSocket→TCP 릴레이.
//
// 왜 존재하는가: 확장(MV3)·웹 셸은 raw TCP 소켓을 못 연다. Electrum(50001/50002)·
// BIP157 피어는 TCP 이므로, 셸은 WebSocket 으로 이 릴레이에 붙고 릴레이가 대상
// TCP 로 이어준다. 셸 쪽 구현(apps/*/src/lib/ws-tcp-transport.ts)은 릴레이 뒤에서
// packages/wallet-sdk/src/btc-history/transport.ts 의 ByteTransport 계약으로 수렴한다.
//
// 외부 npm 의존 없음 — node 내장 http/net/tls/crypto 만으로 RFC 6455 핸드셰이크와
// 프레임을 직접 구현한다 (이 저장소 방침: 스크립트는 내장 모듈 우선).
//
// 사용:
//   node scripts/btc-relay/server.mjs --port 18337 --allow electrum.blockstream.info:50001
//
// 접속 규약:
//   ws://127.0.0.1:PORT/tcp?host=H&port=P&tls=0|1
//   - 바이너리 프레임의 페이로드가 그대로 TCP 양방향으로 흐른다 (프레임 경계 무의미 —
//     줄/메시지 조립은 프로토콜 계층 몫, ByteTransport 계약과 동일).
//   - tls=1 이면 릴레이가 대상에 TLS 로 접속한다 (Electrum 50002 류).
//
// 보안 정책:
//   - 기본 바인드 127.0.0.1 — 외부 노출 금지가 기본값.
//   - 대상 화이트리스트: --allow host:port 반복 인자. 기본은 빈 목록 = 전부 거부.
//     이유: 화이트리스트 없는 릴레이는 "임의 host:port 로의 프록시"가 되어, 로컬에
//     접근 가능한 아무 프로세스나 이 릴레이를 밟고 내부망·외부망을 두드릴 수 있다.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

// ── 인자 파싱 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const allow = new Set(); // "host:port" 문자열 집합
let port = 18337;
let bind = '127.0.0.1';
let connectTimeoutMs = 8000;

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--allow') {
    const v = args[++i];
    if (!v || !/^[^:]+:\d+$/.test(v)) fail(`--allow 형식은 host:port — 받은 값: ${v}`);
    allow.add(v);
  } else if (a === '--port') {
    port = Number(args[++i]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('--port 는 1..65535');
  } else if (a === '--bind') {
    bind = args[++i];
    if (!bind) fail('--bind 에 주소가 필요하다');
  } else if (a === '--connect-timeout-ms') {
    connectTimeoutMs = Number(args[++i]);
    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs <= 0) fail('--connect-timeout-ms 는 양수');
  } else if (a === '--help' || a === '-h') {
    console.log(
      'usage: node server.mjs [--port 18337] [--bind 127.0.0.1] ' +
        '[--allow host:port]... [--connect-timeout-ms 8000]\n' +
        '--allow 를 하나도 안 주면 모든 대상이 거부된다 (닫힌 릴레이가 기본).'
    );
    process.exit(0);
  } else {
    fail(`알 수 없는 인자: ${a}`);
  }
}

function fail(msg) {
  console.error(`[btc-relay] ${msg}`);
  process.exit(1);
}

// ── WebSocket 프레임 (RFC 6455 §5) ──────────────────────────────────────────
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };
const MAX_FRAME = 16 * 1024 * 1024; // 프레임당 16 MiB 상한 — 폭주 방어

/** 서버→클라이언트 프레임 (마스크 없음, FIN=1 단일 프레임). */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function encodeClose(code, reason = '') {
  const r = Buffer.from(reason, 'utf8').subarray(0, 123);
  const p = Buffer.alloc(2 + r.length);
  p.writeUInt16BE(code, 0);
  r.copy(p, 2);
  return encodeFrame(OP.CLOSE, p);
}

/**
 * 증분 프레임 파서. TCP 청크 경계와 무관하게 완성된 프레임만 콜백으로 낸다.
 * 반환: 남은 버퍼. 오류 시 onError 호출 후 그대로 반환 (호출측이 연결을 끊는다).
 */
function drainFrames(buf, { onFrame, onError }) {
  for (;;) {
    if (buf.length < 2) return buf;
    const b0 = buf[0];
    const b1 = buf[1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let off = 2;
    if (len === 126) {
      if (buf.length < 4) return buf;
      len = buf.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (buf.length < 10) return buf;
      const big = buf.readBigUInt64BE(2);
      if (big > BigInt(MAX_FRAME)) return onError(1009, 'frame too large'), buf;
      len = Number(big);
      off = 10;
    }
    if (len > MAX_FRAME) return onError(1009, 'frame too large'), buf;
    // RFC 6455 §5.1 — 클라이언트→서버 프레임은 반드시 마스킹.
    if (!masked) return onError(1002, 'client frame not masked'), buf;
    if (buf.length < off + 4 + len) return buf;
    const mask = buf.subarray(off, off + 4);
    const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len)); // 복사 후 언마스크
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    onFrame(opcode, payload, (b0 & 0x80) !== 0);
    buf = buf.subarray(off + 4 + len);
  }
}

// ── HTTP 서버 + Upgrade ─────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, allow: [...allow] }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.on('upgrade', (req, socket, head) => {
  const deny = (code, text) => {
    socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };

  let url;
  try {
    url = new URL(req.url, 'http://relay.invalid');
  } catch {
    return deny(400, 'Bad Request');
  }
  if (url.pathname !== '/tcp') return deny(404, 'Not Found');
  if ((req.headers.upgrade || '').toLowerCase() !== 'websocket') return deny(400, 'Bad Request');
  const wsKey = req.headers['sec-websocket-key'];
  if (!wsKey) return deny(400, 'Bad Request');

  const host = url.searchParams.get('host') || '';
  const targetPort = Number(url.searchParams.get('port'));
  const useTls = url.searchParams.get('tls') === '1';
  if (!host || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
    return deny(400, 'Bad Request');
  }

  // 화이트리스트 — 없는 대상은 무조건 거부 (기본 빈 목록 = 전부 거부).
  if (!allow.has(`${host}:${targetPort}`)) {
    console.log(`[btc-relay] deny ${host}:${targetPort} (not in --allow)`);
    return deny(403, 'Forbidden');
  }

  // 핸드셰이크 응답. 클라이언트가 subprotocol 을 제시했고 그 안에 'binary' 가 있으면
  // 반드시 에코해야 한다 — 안 하면 브라우저가 연결을 스스로 끊는다 (RFC 6455 §4.2.2).
  const accept = crypto.createHash('sha1').update(wsKey + WS_GUID).digest('base64');
  const offered = String(req.headers['sec-websocket-protocol'] || '')
    .split(',')
    .map((s) => s.trim());
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
  ];
  if (offered.includes('binary')) lines.push('Sec-WebSocket-Protocol: binary');
  socket.write(lines.join('\r\n') + '\r\n\r\n');
  socket.setNoDelay(true);

  // ── 대상 TCP 연결 및 양방향 파이프 ──
  const label = `${host}:${targetPort}${useTls ? ' (tls)' : ''}`;
  let wsBuf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
  let wsClosed = false;

  const sendWs = (frame) => {
    if (!wsClosed && socket.writable) socket.write(frame);
  };
  const shutdown = (code, reason) => {
    if (wsClosed) return;
    wsClosed = true;
    clearTimeout(connectTimer);
    sendWsRaw(encodeClose(code, reason));
    socket.end();
    target.destroy();
  };
  // shutdown 내부용 — wsClosed 검사 없이 마지막 close 프레임을 내보낸다.
  const sendWsRaw = (frame) => {
    if (socket.writable) socket.write(frame);
  };

  const target = useTls
    ? tls.connect({ host, port: targetPort, servername: host })
    : net.connect({ host, port: targetPort });
  target.setNoDelay(true);

  // 연결 수립 타임아웃만 건다 — 수립 후에는 유휴 타임아웃 없음 (구독형 프로토콜 지원).
  let connected = false;
  const connectTimer = setTimeout(() => {
    if (!connected) {
      console.log(`[btc-relay] ${label} connect timeout`);
      shutdown(1011, 'target connect timeout');
    }
  }, connectTimeoutMs);

  target.on(useTls ? 'secureConnect' : 'connect', () => {
    connected = true;
    clearTimeout(connectTimer);
    console.log(`[btc-relay] open ${label}`);
  });
  target.on('data', (chunk) => sendWs(encodeFrame(OP.BIN, chunk)));
  target.on('error', (err) => {
    console.log(`[btc-relay] ${label} tcp error: ${err.message}`);
    shutdown(1011, `tcp error: ${err.code || err.message}`.slice(0, 100));
  });
  target.on('close', () => shutdown(1000, 'tcp closed'));

  socket.on('data', (chunk) => {
    wsBuf = drainFrames(Buffer.concat([wsBuf, chunk]), {
      onFrame(opcode, payload) {
        if (opcode === OP.BIN || opcode === OP.TEXT || opcode === OP.CONT) {
          if (target.writable) target.write(payload);
        } else if (opcode === OP.PING) {
          sendWs(encodeFrame(OP.PONG, payload));
        } else if (opcode === OP.CLOSE) {
          shutdown(1000, '');
        } // PONG 은 무시
      },
      onError(code, reason) {
        console.log(`[btc-relay] ${label} ws protocol error: ${reason}`);
        shutdown(code, reason);
      },
    });
  });
  socket.on('error', () => {
    wsClosed = true;
    target.destroy();
  });
  socket.on('close', () => {
    wsClosed = true;
    target.destroy();
    console.log(`[btc-relay] close ${label}`);
  });
});

server.listen(port, bind, () => {
  console.log(`[btc-relay] listening ws://${bind}:${port}/tcp?host=H&port=P&tls=0|1`);
  if (allow.size === 0) {
    console.log('[btc-relay] 경고: --allow 가 비어 있어 모든 대상이 거부된다.');
  } else {
    console.log(`[btc-relay] allow: ${[...allow].join(', ')}`);
  }
});
