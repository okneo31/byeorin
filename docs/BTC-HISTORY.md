# BTC 이력 (BTC History) — 인수인계

> 상태: **SDK·전송 구현 완료(커밋 `15dd271`), 화면 배선 전. 실피어 실측 진행 중.**
> 이 문서 작성 시점: 2026-08-01 · 근거: 커밋 `15dd271` 의 코드와 테스트
> 관련: [`CONTEXT.md`](./CONTEXT.md) · [`VERIFIABILITY.md`](./VERIFIABILITY.md) · [`scripts/btc-relay/README.md`](../scripts/btc-relay/README.md)

이 문서는 BTC 이력 트랙의 **단일 인수인계 문서**다. 여기 적힌 것은 코드와
커밋에서 확인한 사실이고, 아직 재지 않은 것은 §6 에 "측정 중"으로 자리만
잡아 뒀다. 확인하지 않은 수치는 적지 않는다.

---

## 0. 문제 — 비트코인은 잔액을 알려주지 않는다

EVM 체인은 `eth_getBalance` 한 번이면 잔액이 나온다. 비트코인 노드에는 그런
호출이 없다. 주소의 잔액과 이력은 **전 UTXO 집합을 훑은 결과**이고, 그 훑기를
누가 하느냐가 곧 "누가 내 주소를 아느냐"의 문제가 된다.

그래서 트랙이 둘이다. 하나는 남이 훑어 준 결과를 받는 길(Electrum), 하나는
내가 직접 훑는 길(BIP157). 속도와 프라이버시가 정확히 맞바뀐다.

---

## 1. 왜 두 트랙인가 — 속도 vs 프라이버시

| | **Electrum** (트랙 B) | **BIP157/158** (트랙 C) |
|---|---|---|
| 상대 | Electrum 서버(인덱서) — 제3자 또는 자체 운영 | 임의의 BIP157 지원 풀노드 |
| 조회 방식 | 서버에 scripthash 를 **보내고** 이력을 받는다 | 블록 필터를 **받아 와 내 기기에서** 매칭 |
| 서버가 아는 것 | 내가 묻는 scripthash 전부 + 요청 IP + 시각 | 내 주소·scripthash 는 **모른다** |
| 피어가 여전히 아는 것 | (해당 없음) | 내가 **어떤 블록을 받아 갔는지** |
| 첫 응답 | 요청 1회 | 체크포인트~현재 구간의 필터 전부를 받은 뒤 |
| 신뢰 | 서버가 이력을 누락·조작해도 클라이언트가 모른다 | 필터 해시를 cfheaders 체인으로 대조 (§3) |

### 프라이버시 차이를 정확히

**Electrum 쪽 — "서버가 내 주소를 본다"는 말은 과장이 아니다.**
프로토콜은 주소 대신 scripthash(`reverse(sha256(scriptPubKey))`, `electrum/scripthash.ts`)로
묻는다. scripthash 에서 주소를 역산할 수는 없다. 그러나 상대는 전 UTXO 집합을
가진 인덱서다 — 존재하는 모든 스크립트의 scripthash 를 이미 계산해 두고 있으므로
**대조로 주소를 안다.** scripthash 는 프라이버시 장치가 아니라 조회 키다.
한 연결에서 한 지갑의 주소들을 연달아 물으면, 서버는 그 주소들이 **한 지갑에
속한다**는 것까지 묶어서 안다(클러스터링). 여기에 IP 와 시각이 붙는다.

**BIP157 쪽 — "아무도 모른다"도 정확히는 과장이다.**
피어는 블록마다 만들어 둔 필터를 그냥 보내 줄 뿐이라 내가 무엇을 찾는지 모른다.
매칭은 내 기기에서 일어난다. 다만 `scan.ts` 는 **매칭된 블록만** `getdata` 로
받아 온다 — 그래서 피어는 "이 클라이언트가 관심을 가진 블록 집합"을 알게 된다.
BIP158 필터는 오탐(false positive)을 섞도록 설계돼 있어 그 집합이 곧 내 거래
목록은 아니지만, **누출이 0 은 아니다.** 트랙 C 의 정확한 주장은
"주소는 아무도 모른다 · 관심 블록은 상대 피어가 안다"이다.

### 비용 차이가 어디서 나오는가 (구조적 사실)

BIP157 은 체크포인트 이후 **모든 블록의 필터 헤더와 필터**를 받아야 매칭이
성립한다. 요청 단위는 `MAX_CFHEADERS_PER_REQUEST = 2000`, `MAX_CFILTERS_PER_REQUEST = 1000`
(`bip157/messages.ts`). 매칭된 블록은 **필터가 아니라 블록 원본 전체**를 받는다.
즉 시작 높이가 낮을수록 받아야 할 필터 수가 선형으로 늘고, 그것이 §7 의
"체크포인트 시작 높이" 결정이 성능 결정인 이유다. 실제 소요는 §6 — 측정 중.

---

## 2. 구조 — 계약 하나에 셸 4종

프로토콜 계층(Electrum·BIP157)은 소켓을 모른다. 바이트를 주고받는 계약
`ByteTransport` 하나만 보고, 그 구현을 각 셸이 주입한다.

```
   ┌──────────────────────────┐   ┌──────────────────────────┐
   │  electrum/               │   │  bip157/                 │
   │  ElectrumClient          │   │  bip157Scan              │
   │  scripthash · history    │   │  p2p · messages · gcs    │
   └────────────┬─────────────┘   └────────────┬─────────────┘
                └──────────────┬───────────────┘
                    packages/wallet-sdk/src/btc-history/transport.ts
                          interface ByteTransport
                    connect / send / onData / onClose / close
                ┌──────────────┼───────────────┬───────────────┐
                │              │               │               │
        NativeTcpTransport TauriTcpTransport WsTcpTransport   (node net)
        apps/android/      apps/desktop/     apps/extension/  테스트·릴레이
        src/native-tcp.ts  src/native-tcp.ts  apps/web/
                │              │             src/lib/ws-tcp-transport.ts
        Capacitor 플러그인  Tauri 커맨드            │
        TcpSocketPlugin    tcp_bridge.rs      WebSocket
        (Java, 소켓별      (tokio, native-tls)      │
         읽기 스레드)                          scripts/btc-relay/server.mjs
                │              │              (RFC6455 직접 구현, 화이트리스트)
                └──────────────┴───────────────┴──→  대상 TCP/TLS
```

계약 규칙(`transport.ts` 주석):
- 이 파일은 **계약만** 담는다. 구현·의존성 금지 — 어느 셸에서도 import 가능해야 한다.
- 필드 추가는 허용, **기존 시그니처 변경은 합의 없이 금지.**
- 프레임/줄 경계는 전송이 보장하지 않는다. 조립은 프로토콜 계층의 몫.

구현 4종의 공통 규약: **1 인스턴스 = 1 연결. 재연결은 새 인스턴스.**
(상태 리셋 버그를 원천 차단하려는 의도적 제약 — 네 파일 모두 같은 규약을 지킨다.)

셸 구현의 공통 함정과 대응(코드에서 확인):
- 네이티브/Tauri 모두 **`open` 응답보다 데이터 이벤트가 먼저 도착할 수 있다.**
  두 구현 다 리스너를 open 호출 **전에** 걸고, socketId 확정 전 도착분을
  버퍼에 잡아 뒀다가 확정 직후 순서대로 재생한다.
- 브리지는 문자열만 나르므로 바이트는 **base64** 로 오간다(0x8000 청크 인코딩).

---

## 3. 모듈 공개 표면 (코드에서 확인한 시그니처만)

패키지 진입점: `@byeorin/wallet-sdk/btc-history`
(`packages/wallet-sdk/package.json` 의 `exports["./btc-history"]` — dist 3종 매핑 확인.)

### 3.1 전송 계약 — `btc-history/transport.ts`

```ts
interface ByteTransport {
  connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void>;
  send(bytes: Uint8Array): Promise<void>;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: (err?: Error) => void): void;
  close(): Promise<void>;
}
interface ByteTransportOptions { tls?: boolean; timeoutMs?: number }  // 연결 상한 기본 권장 8000
function isByteTransport(v: unknown): v is ByteTransport;             // 주입 전 구조적 검사
```

### 3.2 Electrum — `btc-history/electrum/`

```ts
class ElectrumClient {
  constructor(transport: ByteTransport, opts?: { timeoutMs?: number });   // 요청 타임아웃 기본 10_000
  connect(host: string, port: number, opts?: ByteTransportOptions): Promise<void>;
  close(): Promise<void>;
  version(clientName: string, protocolVersion?: string): Promise<[string, string]>;
  getHistory(scripthash: string, opts?: ElectrumRequestOptions): Promise<ElectrumHistoryItem[]>;
  getBalance(scripthash: string, opts?: ElectrumRequestOptions): Promise<ElectrumBalance>; // sats
  getTransaction(txid: string, verbose?: false): Promise<string>;
  getTransaction(txid: string, verbose: true): Promise<Record<string, unknown>>;
  headersSubscribe(opts?: ElectrumRequestOptions): Promise<ElectrumHeader>;
  onHeader(cb: (h: ElectrumHeader) => void): void;
  onNotification(cb: (method: string, params: unknown) => void): void;
  request(method: string, params?: unknown[], opts?: ElectrumRequestOptions): Promise<unknown>;
}
class ElectrumError extends Error { method: string; code?: number }

function addressToScriptPubKey(address: string, network?: BtcNetwork): Uint8Array;
function scriptPubKeyToScripthash(scriptPubKey: Uint8Array): string;
function addressToScripthash(address: string, network?: BtcNetwork): string;  // 기본 'mainnet'

function toActivityRows(items: ElectrumHistoryItem[]): BtcActivityRow[];
function isElectrumHistoryItem(v: unknown): v is ElectrumHistoryItem;
```

사용 예 (셸에서 전송을 주입):

```ts
import { ElectrumClient, addressToScripthash, toActivityRows } from '@byeorin/wallet-sdk/btc-history';
import { WsTcpTransport } from './lib/ws-tcp-transport';   // 확장·웹. 다른 셸은 각자 구현

const client = new ElectrumClient(new WsTcpTransport('ws://127.0.0.1:18337'));
await client.connect('electrum.blockstream.info', 50001);
try {
  await client.version('byeorin-wallet');                       // 프로토콜 1.4 협상
  const sh = addressToScripthash('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  const rows = toActivityRows(await client.getHistory(sh));      // [{ txid, height, confirmed, fee?, raw }]
} finally {
  await client.close();
}
```

설계상 **하지 않는 것**(코드 주석에 명시):
- `get_history` 응답에는 `tx_hash` / `height` / (멤풀 항목만) `fee` 뿐이다.
  **입출금 방향과 금액은 이 응답으로 판정할 수 없다** — `transaction.get` 으로
  원문을 받아 입출력을 대조하는 별개 단계가 필요하고, 아직 없다. `toActivityRows` 는
  받은 것만 담고 지어내지 않는다.
- 모르는 id 의 응답은 **어떤 요청에도 배정하지 않고 버린다** (TTL RPC 응답 섞임
  사고의 교훈이 주석에 남아 있다).

### 3.3 BIP157/158 — `btc-history/bip157/`

```ts
// 스캔 (오케스트레이션)
function bip157Scan(transport: ByteTransport, opts: ScanOptions): Promise<ScanResult>;

interface ScanCheckpoint { height: number; blockHash: Uint8Array; filterHeader: Uint8Array }  // 둘 다 32바이트 internal
interface ScanOptions {
  host: string; port: number;
  watchScripts: Uint8Array[];      // 관심 scriptPubKey 원문
  checkpoint: ScanCheckpoint;      // 이 블록 "다음"부터 스캔
  knownOutpoints?: string[];       // "txid:vout" — 지출 감지 시드
  stopAtHeight?: number; magic?: Uint8Array; userAgent?: string;
  messageTimeoutMs?: number;       // 기본 20_000
  blockBatchSize?: number;         // getdata 배치, 기본 16
  tls?: boolean; connectTimeoutMs?: number;
}
interface ScanResult {
  tipHeight: number; tipHash: string;
  records: ScanTxRecord[];         // { height, blockHash, txid, timestamp, receivedOutputs[], spentOutpoints[] }
  matchedBlockCount: number; scannedFilterCount: number;
  ownedOutpoints: string[];        // 다음 스캔의 knownOutpoints 로 넘긴다
}

// P2P 계층
const MAINNET_MAGIC, TESTNET_MAGIC, SERVICE_NODE_COMPACT_FILTERS /* 0x40 */, PROTOCOL_VERSION /* 70016 */;
function hasCompactFilters(services: bigint): boolean;
function encodeMessage(command: string, payload: Uint8Array, magic?: Uint8Array): Uint8Array;
class P2PFrameDecoder { push(chunk: Uint8Array): P2PMessage[] }
function buildVersionPayload(opts?: BuildVersionOptions): Uint8Array;
function parseVersionPayload(payload: Uint8Array): VersionFields;
function buildPingPayload(nonce: bigint), parsePingPayload(p), buildPongPayload(nonce);

// 와이어 메시지
function encodeGetHeaders(locator), decodeHeadersMessage(payload): BlockHeader[];
function encodeGetCfHeaders(startHeight, stopHash), decodeCfHeaders(payload): CfHeadersMessage;
function encodeGetCfilters(startHeight, stopHash), decodeCfilter(payload): CfilterMessage;
function encodeGetData(entries: { type: number; hash: Uint8Array }[]);
function decodeTx(r: ByteReader): DecodedTx;  decodeBlock(payload): DecodedBlock;  isCoinbase(tx);
const MAX_CFHEADERS_PER_REQUEST = 2000, MAX_CFILTERS_PER_REQUEST = 1000, FILTER_TYPE_BASIC = 0;

// BIP158 GCS
const GCS_P = 19, GCS_M = 784931;
function siphash24(key: Uint8Array /* 16바이트 */, data: Uint8Array): bigint;
function filterKeyFromBlockHash(blockHashInternal): Uint8Array;   // 블록해시 앞 16바이트
function hashToRange(item, f: bigint, key): bigint;
function encodeGcsFilter(...), decodeGcsFilterValues(...), gcsMatchAny(filterBytes, key, items): boolean;
function computeFilterHash(filterBytes), computeFilterHeader(filterHash, prevHeader);
```

사용 예:

```ts
import { bip157Scan } from '@byeorin/wallet-sdk/btc-history';

const result = await bip157Scan(transport, {
  host: 'x.x.x.x', port: 8333,
  watchScripts: [scriptPubKeyBytes],
  checkpoint: { height, blockHash, filterHeader },   // ← §7 결정 대기
  stopAtHeight: undefined,                            // 피어의 최신까지
});
// result.records: 우리 스크립트로 들어온 출력 / 우리 outpoint 를 소비한 입력
```

`bip157Scan` 이 실제로 하는 검증(코드 확인):
1. 핸드셰이크에서 상대 services 에 `NODE_COMPACT_FILTERS` 가 없으면 **거절**한다.
2. cfheaders 는 체크포인트의 `filterHeader` 에 연결되지 않으면 예외. 개수·stopHash 도 대조.
3. 받은 cfilter 는 `computeFilterHash` 로 다시 계산해 cfheaders 가 준 해시와 대조 —
   틀리면 `"peer lied"` 로 중단한다.

**의도적으로 하지 않는 것**(코드 주석에 명시된 한계):
- **PoW 목표(bits) 검증·누적 난이도 비교를 하지 않는다.** 헤더의 연결성만 본다.
  악의적 피어가 가짜 저난이도 체인을 줄 수 있다 → 복수 피어 교차 확인 또는
  체크포인트 갱신 정책을 위에 얹어야 한다. **아직 없다.**
- 재조직은 마지막 공통 조상까지 단순 롤백. **체크포인트보다 깊은 재조직은 예외를 던진다.**
- 단일 피어 전용. `Peer.next()` 는 동시 대기를 지원하지 않는다(순차 프로토콜).

---

## 4. 검증 상태 — 무엇이 확인됐고 무엇이 아닌가

`VERIFIABILITY.md` 의 원칙대로 **OK / 단위 / 미검증**을 섞지 않는다.
"확인하지 못한 것에 OK 를 주면 도구가 사실보다 많은 것을 주장한다."

| 대상 | 상태 | 근거 |
|---|---|---|
| SipHash-2-4 구현 | **공식 벡터 검증** | 레퍼런스(veorq/SipHash `vectors_sip64`) 64개 전부 일치 |
| BIP158 GCS 인코딩 | **공식 벡터 검증** | BIP158 부록 `testnet-19.json` 8블록 — 인코드 결과가 공식 필터 바이트와 hex 단위 일치 |
| 필터 헤더 체인 | **공식 벡터 검증** | 같은 벡터의 공식 filter header 와 일치 |
| 블록·세그윗 tx 디코드 | **공식 벡터 검증** | 벡터 블록(testnet 1263442 등) 디코드 → 헤더 해시 재현 |
| 빈 필터(N=0) 처리 | **공식 벡터 검증** | testnet 1414221 |
| P2P 프레이밍·체크섬·매직 | 단위 테스트만 | 자체 라운드트립(1바이트씩 주입·복수 메시지 분할·손상 거부) |
| version/verack·ping/pong 페이로드 | 단위 테스트만 | 자체 라운드트립 + 레이아웃 검사 |
| Electrum 줄 조립·id 매칭·타임아웃·오류 | 단위 테스트만 | MockTransport 기반 |
| scripthash 변환 P2PKH·P2WPKH·P2SH | 벡터 대조 | electrumx 문서 벡터(제네시스) · BIP-173 · 손수 만든 P2SH |
| scripthash 변환 **P2TR** | **미검증** | 코드는 지원한다고 쓰여 있으나(`bc1p…`) **테스트 벡터가 없다** |
| **`bip157Scan` 오케스트레이션 전체** | **미검증** | 테스트가 `scan.ts` 를 import 하지 않는다 — 466줄에 자동 테스트 0 |
| **실 피어 통합 (BIP157)** | **미검증** | C 부대가 명시. §6 측정 중 |
| **mainnet 벡터** | **미검증** | 검증된 GCS 벡터는 전부 testnet |
| **복수 피어 교차 확인** | **미검증** | 코드에 기능 자체가 없다(단일 피어) |
| Electrum 실서버 왕복 | 코드 있으나 **기본 미실행** | `describe.skip` — 수동으로 켜야 돈다 (`btc-electrum.test.ts` 말미) |
| WS 릴레이 왕복 | 1회 실측 (자동 테스트 아님) | `smoke-test.mjs`, 2026-07-31: ws open 21ms · `server.version` 왕복 347ms · 총 368ms. 비허용 대상은 403 → close 1006 |
| 셸 전송 구현 4종 | **자동 테스트 없음** | Java/Rust/WS 모두 단위 테스트 없음. WS 구현만 스모크로 1회 실행됨 |

테스트 규모(커밋 `15dd271` 기재): Electrum 21건(+ 라이브 1건 skip), BIP157 58건.
워크스페이스 전체 846건 통과 · typecheck 10/10.

> 요약하면: **암호·인코딩 계층은 공식 벡터로 막혀 있고, 네트워크 위에서 실제로
> 돌아가는 것을 본 적은 아직 없다.** 그 간극이 §6 이다.

---

## 5. 릴레이 보안 정책 — 기본이 "전부 거부"인 이유

확장(MV3)·웹 셸은 raw TCP 를 못 연다. 그래서 `scripts/btc-relay/server.mjs` 가
WebSocket 을 받아 대상 TCP 로 잇는다(외부 npm 0, RFC 6455 직접 구현).

| 정책 | 값 | 이유 |
|---|---|---|
| 대상 화이트리스트 | `--allow host:port` 반복. **기본 빈 목록 = 전부 거부** | 화이트리스트 없는 WS→TCP 릴레이는 **임의 host:port 프록시**다. 로컬의 아무 프로세스(악성 웹페이지가 localhost 로 쏘는 요청 포함)나 릴레이를 밟고 내부망·외부망 어디든 두드릴 수 있다 |
| 바인드 | 기본 `127.0.0.1` | 외부 노출이 기본값이 되지 않게. 루프백 밖으로 열려면 명시적 `--bind` |
| 거부 방식 | 목록에 없으면 **403** 후 종료 (클라이언트는 close 1006 으로 관측) | 조용히 실패시키지 않는다 |
| 연결 상한 | `--connect-timeout-ms` 기본 8000 | 계약 권장값과 동일 |
| 헬스체크 | `GET /` → 현재 allow 목록 반환 | 운영자가 무엇이 열려 있는지 볼 수 있게 |

```sh
node scripts/btc-relay/server.mjs --port 18337 \
  --allow electrum.blockstream.info:50001 \
  --allow electrum.blockstream.info:50002
```

`--allow` 가 비면 기동 로그에 경고를 찍는다. 접속 규약은
`ws://127.0.0.1:18337/tcp?host=H&port=P&tls=0|1`, `tls=1` 이면 릴레이가 대상에 TLS 로 붙는다.

MV3 에서 `ws://127.0.0.1` 이 **manifest 변경 0줄로** 되는 근거 3갈래(WebSocket 은
CORS 를 안 타므로 host_permissions 불필요 · 이 확장 CSP 에 `connect-src` 없음 ·
루프백은 potentially trustworthy origin 이라 mixed content 대상 아님)는
[`scripts/btc-relay/README.md`](../scripts/btc-relay/README.md) 에 출처와 함께 정리돼 있다.

### TLS 신뢰 정책 (네이티브 셸)

- 안드로이드: 플랫폼 기본 `SSLSocketFactory` + **`setEndpointIdentificationAlgorithm("HTTPS")`
  명시**. 기본 `SSLSocket` 은 호스트명 대조를 생략하므로 명시적으로 켰다.
  결과적으로 **자가서명 Electrum 서버는 거부된다** — 신뢰 완화는 별도 결정 없이 하지 않는다.
- 데스크톱: `native-tls` 기본 검증(`TlsConnector::new()`), 검증 우회 플래그 없음.

> 자체 Electrum 서버를 세울 경우(§7) **정식 인증서가 필요**하다는 뜻이다.
> 자가서명으로 가려면 신뢰 완화를 결정해야 하고, 그건 지금 안 한 결정이다.

---

## 6. 측정 중 (자리표 — 실측 후 채운다)

아래는 **아직 재지 않았다.** 숫자를 지어 넣지 말고, 측정한 사람이 조건과 함께 채운다.

| 항목 | 상태 | 채울 것 |
|---|---|---|
| 실 피어 핸드셰이크 (BIP157) | **측정 중** | 피어 주소·소요·`NODE_COMPACT_FILTERS` 보유 피어 비율 |
| cfheaders 처리량 | **측정 중** | 2000개 배치 왕복 시간, 구간당 총 소요 |
| cfilters 처리량 | **측정 중** | 1000개 배치 왕복 시간, 바이트량 |
| E2E 스캔 | **측정 중** | 체크포인트~팁 구간 스캔 총 소요·매칭 블록 수·다운로드 바이트 |
| 복수 피어 일치율 | **측정 중** | 같은 구간을 서로 다른 피어에서 받았을 때 필터 헤더 일치 여부 |
| Electrum 실서버 이력 | 부분 실측 (세션 기록) | `server.version` 406ms · `get_history` 3.6s (electrum.blockstream.info:50001). 자동 테스트로 승격 여부 미정 |
| 셸별 전송 실동작 | **미측정** | 안드로이드 실기기 · Tauri 데스크톱 · 확장 popup 각각의 왕복 |

> 실측 스크립트는 별도 부대가 작업 중이며 이 문서 작성 시점에 **커밋되지 않았다**
> (`scripts/btc-p2p/`, `scripts/bip157-live/` 가 미추적 상태로 존재). 커밋되면
> 경로를 여기에 고정한다.

---

## 7. 결정 대기 (사용자 결정 필요)

화면 배선을 시작하려면 아래 셋이 먼저 정해져야 한다. 커밋 `15dd271` 이
"화면 배선은 다음 라운드 — 서버 정책·체크포인트 결정 필요"로 남긴 지점이다.

**① 기본 경로: Electrum vs BIP157**
- Electrum 기본 → 첫 화면이 빠르다. 대신 **기본값이 "서버가 내 주소를 본다"** 가 된다.
- BIP157 기본 → 기본값이 프라이버시. 대신 첫 이력까지의 대기(§6 측정 중)를
  사용자가 감당해야 하고, 단일 피어 신뢰 문제(§3.3 한계)를 먼저 메워야 한다.
- 혼합(빠른 경로로 보여주고 뒤에서 검증) 도 구조상 가능하다 — 두 트랙이 같은
  전송 계약 위에 있으므로. 어느 쪽이든 **사용자에게 무엇이 노출되는지 화면에
  적을 것인지**가 함께 결정돼야 한다.

**② Electrum 서버 정책: 제3자 vs 자체**
- 제3자(예: blockstream) → 운영 비용 0, 프라이버시는 그 서버에 맡긴다.
- 자체 운영 → 프라이버시는 우리 손에, 대신 인덱서 운영 비용 + 정식 TLS 인증서
  필요(§5) + "우리 서버를 믿어라"가 되어 `VERIFIABILITY.md` 의 논지와 긴장이 생긴다.
- 사용자 지정 서버 허용 여부(고급 설정)도 이 결정에 포함된다.

**③ 체크포인트 시작 높이 (BIP157)**
- `ScanCheckpoint` 는 높이 + 블록해시 + 필터 헤더 3개를 요구한다. 이 값은
  **코드에 박히는 신뢰 앵커**다 — 이보다 깊은 재조직은 처리하지 않고 예외를 던진다.
- 낮게 잡을수록 오래된 이력을 잡지만 받아야 할 필터가 선형으로 늘어난다(§1).
- 지갑이 새로 만든 주소만 다룬다면 "지갑 생성 시점" 기준도 가능하다 — 대신
  **가져온(import) 주소의 과거 이력은 못 본다.** 이건 UX 결정이다.

---

## 8. 파일 인벤토리

| 경로 | 내용 |
|---|---|
| `packages/wallet-sdk/src/btc-history/transport.ts` | `ByteTransport` 계약 (결합점) |
| `packages/wallet-sdk/src/btc-history/electrum/{client,scripthash,history,index}.ts` | Electrum 클라이언트 |
| `packages/wallet-sdk/src/btc-history/bip157/{p2p,messages,gcs,scan,index}.ts` | BIP157/158 라이트클라이언트 |
| `packages/wallet-sdk/src/btc-history.ts` | 공개 배럴 → `@byeorin/wallet-sdk/btc-history` |
| `packages/wallet-sdk/tests/btc-{electrum,bip157}.test.ts` | 테스트 |
| `apps/android/src/native-tcp.ts` + `.../TcpSocketPlugin.java` | 안드로이드 전송 |
| `apps/desktop/src/native-tcp.ts` + `src-tauri/src/tcp_bridge.rs` | 데스크톱 전송 |
| `apps/extension/src/lib/ws-tcp-transport.ts` · `apps/web/src/lib/ws-tcp-transport.ts` | WS 릴레이 전송 (두 파일 구현 동일 — 공용화는 배럴 합의 후) |
| `scripts/btc-relay/{server.mjs,smoke-test.mjs,README.md}` | WS→TCP 릴레이 |

미해결 위생 항목: 셸 4종이 계약 타입을 **패키지 exports 가 아니라 상대 경로
소스에서** type-only import 하고 있다(`../../../packages/wallet-sdk/src/btc-history/transport`).
작성 당시 서브패스가 없어서였고, 지금은 `exports["./btc-history"]` 가 있으므로
정리 가능하다. 타입만 쓰므로 번들 결과물에는 영향이 없다.
