// btc-history-source.ts — 활동 화면 ↔ @byeorin/wallet-sdk/btc-history 사이의 유일한 접점 (web 셸).
//
// 웹 페이지는 raw TCP 를 못 연다. 그래서 전송은 항상 ws-tcp-transport.ts
// (로컬 릴레이 scripts/btc-relay/server.mjs 경유) 다. 릴레이가 꺼져 있으면
// 이 모듈은 'transport' 실패를 값으로 돌려주고, 화면은 그 사실을 그대로 적는다 —
// 조용한 폴백(다른 서버로 몰래 갈아타기)은 하지 않는다.
//
// 값(런타임) import 는 하지 않는다: SDK 의 scripthash 경로가 @scure/btc-signer 를
// 정적 의존하므로, 정적 import 하면 BTC 를 안 쓰는 사용자의 첫 화면 번들까지
// 커진다. 그래서 fetchBtcHistory 안에서 dynamic import 로 가져온다.
// (타입만 쓰는 import type 은 번들에 아무것도 끌고 오지 않는다.)
//
// 참고: apps/extension/entrypoints/popup/lib/btc-history-source.ts 와 계약이 같다.
// 셸 4종은 서로 별도 복사본이라는 저장소 규약을 따른다.

import type {
  ByteTransport,
  BtcActivityRow,
} from '@byeorin/wallet-sdk/btc-history';

/** 이번 라운드에 배선된 트랙은 Electrum 하나뿐. 'bip157' 은 체크포인트 결정 후. */
export type BtcTrack = 'electrum';

export interface BtcServerSpec {
  host: string;
  port: number;
  tls?: boolean;
}

/**
 * 로컬 WebSocket→TCP 릴레이 주소.
 * 이 값이 가리키는 프로세스는 사용자가 직접 띄운다 — 웹 페이지가 로컬 프로세스를
 * 실행할 수단은 없다. 기동 예:
 *   node scripts/btc-relay/server.mjs --port 18337 \
 *     --allow electrum.blockstream.info:50002
 */
export const RELAY_URL = 'ws://127.0.0.1:18337';

/**
 * 조회에 쓸 Electrum 서버. **정책 미결정 항목**(docs/BTC-HISTORY.md §7②) —
 * 제3자 서버를 쓰면 그 서버가 내 주소를 알게 된다. 결정이 나면 이 한 줄만 바꾼다.
 *
 * tls: true — 릴레이가 대상에 **TLS 로** 접속한다(server.mjs 의 tls=1 경로).
 * 예전 주석은 "릴레이가 TLS 를 대신하므로 tls=false" 라고 적었지만 그것은
 * 거짓이었다: tls=false 면 릴레이는 평문 50001 로 나간다. 릴레이→서버 구간이
 * 인터넷을 지나므로 여기가 평문이면 조회 주소가 경로 전체에 노출된다.
 */
export const ELECTRUM: BtcServerSpec = {
  host: 'electrum.blockstream.info',
  port: 50002,
  tls: true,
};

export interface BtcHistoryQuery {
  /** BTC 주소 (bc1q… 기본). */
  address: string;
  server: BtcServerSpec;
  network?: 'mainnet' | 'testnet';
  /** 정렬 후 앞 N 건. 기본 20. */
  limit?: number;
  requestTimeoutMs?: number;
  connectTimeoutMs?: number;
}

export type BtcHistoryFailure =
  | 'unsupported' // 이 셸/체인/계정으로 불가 (주소 도출 실패 등)
  | 'transport' // 릴레이 미가동 · 소켓 거부 · 비정상 종료
  | 'timeout' // 연결/요청 상한 초과
  | 'server' // ElectrumError (서버가 error 로 응답)
  | 'protocol'; // 응답 형태 불일치

export interface BtcHistoryOk {
  ok: true;
  track: BtcTrack;
  rows: BtcActivityRow[];
  truncated: boolean;
}
export interface BtcHistoryErr {
  ok: false;
  track: BtcTrack;
  failure: BtcHistoryFailure;
  message: string;
}
export type BtcHistoryResult = BtcHistoryOk | BtcHistoryErr;

const DEFAULT_LIMIT = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

/**
 * 표시 순서: 멤풀(height <= 0) 먼저, 그 다음 height 내림차순.
 * 순수 함수 — 입력 배열을 바꾸지 않는다.
 */
export function sortBtcRowsForDisplay(rows: BtcActivityRow[]): BtcActivityRow[] {
  return [...rows].sort((a, b) => {
    const aMempool = a.height <= 0;
    const bMempool = b.height <= 0;
    if (aMempool !== bMempool) return aMempool ? -1 : 1;
    if (aMempool && bMempool) {
      // 둘 다 멤풀: -1(부모 미컨펌) 이 0(부모 컨펌) 보다 나중.
      return b.height - a.height;
    }
    return b.height - a.height;
  });
}

/** 메시지 문자열로 타임아웃을 가려낸다 — SDK 는 전용 에러 타입을 두지 않았다. */
function looksLikeTimeout(msg: string): boolean {
  return msg.includes('timeout') || msg.includes('응답 없음');
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * BTC 이력 조회. **던지지 않는다 — 실패도 값으로 준다.**
 * 화면은 try/catch 없이 ok 분기만 하면 된다.
 *
 * makeTransport 는 인스턴스가 아니라 팩토리다: 전송 계약이 "1 인스턴스 = 1 연결"
 * 이라 재시도할 때마다 새 인스턴스가 필요하기 때문이다.
 */
export async function fetchBtcHistory(
  makeTransport: () => ByteTransport,
  q: BtcHistoryQuery,
): Promise<BtcHistoryResult> {
  const fail = (failure: BtcHistoryFailure, message: string): BtcHistoryErr => ({
    ok: false,
    track: 'electrum',
    failure,
    message,
  });

  let sdk: typeof import('@byeorin/wallet-sdk/btc-history');
  try {
    sdk = await import('@byeorin/wallet-sdk/btc-history');
  } catch (e) {
    return fail('unsupported', errMessage(e));
  }

  const { ElectrumClient, ElectrumError, addressToScripthash, toActivityRows } = sdk;

  // 주소 → scripthash 는 연결 전에 끝낸다. 못 만드는 주소면 소켓을 열 이유가 없다.
  let scripthash: string;
  try {
    scripthash = addressToScripthash(q.address, q.network ?? 'mainnet');
  } catch (e) {
    return fail('unsupported', errMessage(e));
  }

  const transport = makeTransport();
  // 생성자가 onData/onClose 를 건다 — connect 보다 반드시 먼저 만든다.
  // (뒤에 만들면 첫 프레임을 잃는다.)
  const client = new ElectrumClient(transport, {
    timeoutMs: q.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  let connected = false;
  try {
    try {
      await client.connect(q.server.host, q.server.port, {
        tls: q.server.tls ?? false,
        timeoutMs: q.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
      connected = true;
    } catch (e) {
      const msg = errMessage(e);
      // 릴레이 미가동/화이트리스트 거부는 여기로 온다.
      return fail(looksLikeTimeout(msg) ? 'timeout' : 'transport', msg);
    }

    await client.version('byeorin-wallet', '1.4');
    const items = await client.getHistory(scripthash);
    const rows = sortBtcRowsForDisplay(toActivityRows(items));
    const limit = q.limit ?? DEFAULT_LIMIT;
    return {
      ok: true,
      track: 'electrum',
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
    };
  } catch (e) {
    if (e instanceof ElectrumError) return fail('server', errMessage(e));
    const msg = errMessage(e);
    if (looksLikeTimeout(msg)) return fail('timeout', msg);
    // 연결이 끊긴 뒤의 예외는 전송 문제, 그 밖은 응답 형태 문제로 본다.
    if (msg.includes('연결이 끊김') || msg.includes('not connected')) {
      return fail('transport', msg);
    }
    return fail('protocol', msg);
  } finally {
    if (connected) {
      try {
        await client.close();
      } catch {
        // 닫기 실패는 결과에 영향을 주지 않는다.
      }
    }
  }
}
