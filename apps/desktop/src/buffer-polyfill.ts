// Buffer polyfill — **별도 모듈이어야 한다.**
//
// main.tsx 본문에 대입문으로 두면 늦는다. ES import 는 전부 호이스팅되어 먼저
// 평가되고, 본문 statement 는 그 뒤에 돈다. 멀티체인 청크(@cosmjs/crypto 등)가
// 모듈 최상위에서 Buffer 를 참조하므로 그 시점엔 아직 비어 있어 부팅이
// ReferenceError 로 죽는다 — 화면이 통째로 백지가 된다.
//
// 이 파일을 main.tsx 의 **첫 import** 로 두면 대입이 이 모듈의 평가 시점에
// 일어나므로 뒤따르는 어떤 모듈보다 먼저 채워진다.
import { Buffer as BufferPolyfill } from 'buffer';

if (typeof globalThis.Buffer === 'undefined') {
  (globalThis as unknown as { Buffer: typeof BufferPolyfill }).Buffer = BufferPolyfill;
}
