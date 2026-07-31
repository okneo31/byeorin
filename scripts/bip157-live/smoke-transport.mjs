// smoke-transport.mjs — createNodeTcpTransport 구조 검사 (네트워크 접속 없음).
import { createNodeTcpTransport } from './node-transport.mjs';

let isByteTransport;
try {
  ({ isByteTransport } = await import('../../packages/wallet-sdk/dist/btc-history.js'));
} catch {
  // dist import 실패 시 5개 메서드 typeof 폴백
  isByteTransport = (v) =>
    typeof v === 'object' && v !== null &&
    typeof v.connect === 'function' &&
    typeof v.send === 'function' &&
    typeof v.onData === 'function' &&
    typeof v.onClose === 'function' &&
    typeof v.close === 'function';
}

const t = createNodeTcpTransport();
const structural = isByteTransport(t);
const counters = typeof t._bytesIn === 'number' && typeof t._bytesOut === 'number';

// 미연결 send 는 거부되어야 한다
let sendRejects = false;
try {
  await t.send(new Uint8Array([0]));
} catch {
  sendRejects = true;
}

// close 는 미연결 상태에서도 idempotent
await t.close();
await t.close();

const pass = structural && counters && sendRejects;
console.log(JSON.stringify({ structural, counters, sendRejectsBeforeConnect: sendRejects, pass }));
process.exit(pass ? 0 : 1);
