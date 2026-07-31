# btc-relay — WebSocket→TCP 릴레이 (BTC 이력 트랙 D)

확장(MV3)·웹 셸은 raw TCP 를 못 연다. 이 릴레이는 셸의 WebSocket 접속을 받아
대상 TCP(Electrum 50001/50002, BIP157 피어 등)로 이어준다. 셸 쪽 짝은
`apps/extension/src/lib/ws-tcp-transport.ts` · `apps/web/src/lib/ws-tcp-transport.ts` —
둘 다 `packages/wallet-sdk/src/btc-history/transport.ts` 의 `ByteTransport` 계약을
릴레이 뒤에서 그대로 만족한다.

외부 npm 의존 없음 — node 내장 `http`/`net`/`tls`/`crypto` 만으로 RFC 6455
핸드셰이크·프레임을 직접 구현했다. node 18+ 면 그대로 돈다
(`smoke-test.mjs` 만 타입 스트리핑·전역 WebSocket 때문에 node 22.6+ 필요).

## 실행

```sh
node scripts/btc-relay/server.mjs --port 18337 --allow electrum.blockstream.info:50001
```

| 옵션 | 기본 | 설명 |
| --- | --- | --- |
| `--port` | `18337` | 리슨 포트 |
| `--bind` | `127.0.0.1` | 바인드 주소 — 기본은 로컬 전용 |
| `--allow host:port` | (없음) | 허용 대상. **반복 지정 가능. 하나도 없으면 전부 거부** |
| `--connect-timeout-ms` | `8000` | 대상 TCP 연결 수립 상한 |

접속 규약: `ws://127.0.0.1:18337/tcp?host=H&port=P&tls=0|1`
바이너리 프레임의 페이로드가 대상 TCP 와 그대로 양방향으로 흐른다. 프레임 경계에
의미 없음 — 줄/메시지 조립은 프로토콜 계층 몫(ByteTransport 계약과 동일).
`tls=1` 이면 릴레이가 대상에 TLS 로 붙는다(Electrum 50002 류). `GET /` 는 헬스체크
(현재 allow 목록 반환).

## 화이트리스트 정책

기본이 **빈 목록 = 전부 거부**인 이유: 화이트리스트 없는 WS→TCP 릴레이는 임의
host:port 프록시다. 로컬의 아무 프로세스(악성 웹페이지가 localhost 로 쏘는 요청
포함)나 릴레이를 밟고 내부망·외부망 어디든 두드릴 수 있게 된다. 그래서 대상은
운영자가 `--allow` 로 명시한 것만 통과시키고, 그 외에는 403 으로 끊는다.

```sh
# TLS 포트까지 함께 여는 예
node scripts/btc-relay/server.mjs \
  --allow electrum.blockstream.info:50001 \
  --allow electrum.blockstream.info:50002
```

## MV3 확장에서 ws://localhost 가 되는 조건 — 문서·실험 근거

결론: **manifest 변경 없이 된다. `host_permissions` 불필요함.** 근거 세 갈래
(확인일 2026-07-31):

1. **host_permissions 불필요.** Chrome 공식 문서 "Use WebSockets in service
   workers"(developer.chrome.com/docs/extensions/how-to/web-platform/websockets)의
   manifest 요구사항은 `"minimum_chrome_version": "116"` 하나뿐이고 권한 항목이
   없다. `host_permissions` 의 효능은 fetch/XHR 의 CORS 우회인데(이 저장소
   `apps/extension/wxt.config.ts` 14–18행 주석과 동일 논리), WebSocket 핸드셰이크는
   CORS 검사를 타지 않는다.
2. **CSP 가 막지 않는다.** MV3 `extension_pages` 기본 CSP 는
   `script-src 'self'; object-src 'self';` — `connect-src` 가 없어 네트워크 연결을
   제한하지 않는다(developer.chrome.com/docs/extensions/reference/manifest/content-security-policy).
   이 저장소 확장의 실제 CSP(`script-src 'self' 'wasm-unsafe-eval'; object-src 'self';`,
   wxt.config.ts 44–46행)도 `connect-src` 미지정 — 제한 없음.
3. **mixed content 차단 대상 아님.** W3C Secure Contexts §3.1
   (w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy):
   "If origin's host matches one of the CIDR notations 127.0.0.0/8 or ::1/128,
   return 'Potentially Trustworthy'." — 이 루프백 규칙은 **스킴 무관**이라
   `ws://127.0.0.1` 도 신뢰 origin 이고, MDN Mixed content 문서도 "content
   accessed from loopback addresses such as http://127.0.0.1/ or http://localhost/"
   를 secure origin 으로 명시한다. `localhost` 이름은 UA 의 루프백 해석 보장이
   조건(Chrome 은 보장)이므로, relay URL 은 무조건 성립하는 `ws://127.0.0.1` 을
   권장한다. localhost 밖 릴레이는 `wss://` 필요.

주의 — 서비스 워커(background)에서 쓸 경우: Chrome 116+ 부터 WS 메시지가 SW
활동으로 인정되어 30초 활동 창 안에서 메시지가 오가면 SW 가 유지된다(위 1번
문서). popup 등 extension page 에서는 페이지가 열려 있는 동안 무관.

실험 근거: `smoke-test.mjs` 가 브라우저와 동일한 WebSocket API(node 전역
WebSocket = undici, `new WebSocket(url, 'binary')` subprotocol 협상 포함)로 실제
셸 구현(`apps/extension/src/lib/ws-tcp-transport.ts`)을 그대로 실행해 왕복을
실측했다 — 2026-07-31, electrum.blockstream.info:50001 대상: ws open 21 ms,
`server.version` 왕복(릴레이의 TCP 연결 포함) 347 ms, 총 368 ms. 같은 세션 계열의
TCP 직결 전례 406 ms 와 동급. 비허용 대상(example.com:80)은 403 거부 → 클라이언트
close code 1006 확인.

## 스모크 테스트

```sh
# 터미널 1
node scripts/btc-relay/server.mjs --allow electrum.blockstream.info:50001
# 터미널 2 (node 22.6+)
node scripts/btc-relay/smoke-test.mjs
```
