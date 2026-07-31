#!/usr/bin/env node
// smoke-test.mjs — 릴레이 왕복 실측: WS → 릴레이 → TCP → Electrum server.version.
//
// 모형이 아니라 실제 셸 구현(apps/extension/src/lib/ws-tcp-transport.ts)을 그대로
// 실행한다 — node 22.6+ 의 타입 스트리핑이 .ts 를 직접 로드하고, node 22+ 의 전역
// WebSocket(undici)이 브라우저와 같은 표면을 제공하므로 subprotocol 에코까지 실측된다.
//
// 선행: 릴레이가 떠 있어야 한다.
//   node scripts/btc-relay/server.mjs --port 18337 --allow electrum.blockstream.info:50001
// 실행:
//   node scripts/btc-relay/smoke-test.mjs [ws://127.0.0.1:18337] [host] [port]

import { performance } from 'node:perf_hooks';

const relayUrl = process.argv[2] ?? 'ws://127.0.0.1:18337';
const host = process.argv[3] ?? 'electrum.blockstream.info';
const port = Number(process.argv[4] ?? 50001);

const { WsTcpTransport } = await import('../../apps/extension/src/lib/ws-tcp-transport.ts');

const t = new WsTcpTransport(relayUrl);
const dec = new TextDecoder();
let lineBuf = '';
let resolveLine;
const firstLine = new Promise((res) => (resolveLine = res));

t.onData((bytes) => {
  lineBuf += dec.decode(bytes, { stream: true });
  const nl = lineBuf.indexOf('\n');
  if (nl >= 0) resolveLine(lineBuf.slice(0, nl));
});
t.onClose((err) => {
  if (err) {
    console.error(`[smoke] closed abnormally: ${err.message}`);
    process.exit(1);
  }
});

const t0 = performance.now();
await t.connect(host, port, { tls: false, timeoutMs: 8000 });
const tOpen = performance.now();

const req = { id: 0, method: 'server.version', params: ['byeorin-relay-smoke', '1.4'] };
await t.send(new TextEncoder().encode(JSON.stringify(req) + '\n'));
const tSend = performance.now();

const line = await Promise.race([
  firstLine,
  new Promise((_, rej) => setTimeout(() => rej(new Error('response timeout 10s')), 10_000)),
]);
const tResp = performance.now();

console.log(`[smoke] target        : ${host}:${port} via ${relayUrl}`);
console.log(`[smoke] ws open       : ${(tOpen - t0).toFixed(0)} ms`);
console.log(`[smoke] rtt send→line : ${(tResp - tSend).toFixed(0)} ms (릴레이 TCP 연결 포함)`);
console.log(`[smoke] total         : ${(tResp - t0).toFixed(0)} ms`);
console.log(`[smoke] response      : ${line}`);

const parsed = JSON.parse(line);
if (parsed.id !== 0 || !Array.isArray(parsed.result)) {
  console.error('[smoke] FAIL: server.version 응답 형태가 아니다');
  process.exit(1);
}
await t.close();
console.log('[smoke] OK');
process.exit(0);
