// btc-history-source.ts — 활동 화면 ↔ @byeorin/wallet-sdk/btc-history 사이의 유일한 접점.
//
// 안드로이드 셸 판. 확장(popup)판과 다른 점은 전송뿐이다 — 여기서는 네이티브
// TcpSocket 플러그인(NativeTcpTransport)이 TLS 를 직접 물므로 릴레이 프로세스가
// 필요 없다. 서버 상수도 그래서 TLS 포트(50002)를 쓴다.
//
// SDK 는 **dynamic import** 로만 가져온다. btc-history 배럴의 scripthash.ts 가
// @scure/btc-signer 를 정적으로 물고 있어, 정적 import 하면 BTC 를 한 번도 안 보는
// 사용자의 초기 번들에까지 실린다. ActivityPane 이 ActivityLog 를 dynamic import
// 하는 것과 같은 이유·같은 수법이다.
//
// 이 파일은 **던지지 않는다.** 실패도 값(BtcHistoryResult)으로 돌려주고, 화면은
// try/catch 없이 분기만 한다.

import type { ByteTransport } from '../../../../packages/wallet-sdk/src/btc-history/transport';
import type { BtcActivityRow } from '../../../../packages/wallet-sdk/src/btc-history/electrum/history';

export type { BtcActivityRow };

/**
 * 이력 트랙. 지금은 Electrum 하나뿐이다.
 * 'bip157' 은 신뢰 앵커(체크포인트)가 정해진 뒤에 붙는다 — mainnet 체크포인트가
 * 제네시스(높이 0) 하나뿐이라 지금 붙이면 첫 이력까지 필터 전량을 받아야 한다.
 */
export type BtcTrack = 'electrum';

export interface BtcServerSpec {
  host: string;
  port: number;
  tls?: boolean;
}

/**
 * Electrum 서버. **이 상수 1곳만 고치면 서버가 바뀐다.**
 * 안드로이드는 네이티브가 TLS 를 직접 하고 호스트명 검증이 켜져 있으므로 정식
 * 인증서를 가진 서버여야 한다 → 50002(TLS).
 *
 * 주의: 제3자 서버를 쓰는 한 "그 서버가 내 주소를 안다" 가 기본값이다.
 * scripthash 는 조회 키이지 프라이버시 장치가 아니다. 서버 정책은 미결정 사항
 * (docs/BTC-HISTORY.md §7②) — 여기서 대신 결정하지 않았다.
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
  /** 이 셸/체인/계정으로 불가 (주소 도출 실패 등). */
  | 'unsupported'
  /** 소켓 거부·비정상 종료 (네이티브 플러그인 없음 포함). */
  | 'transport'
  /** 연결/요청 상한 초과. */
  | 'timeout'
  /** 서버가 error 로 응답 (ElectrumError). */
  | 'server'
  /** 응답 형태 불일치. */
  | 'protocol';

export interface BtcHistoryOk {
  ok: true;
  track: BtcTrack;
  rows: BtcActivityRow[];
  /** limit 때문에 잘렸나. */
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
const DEFAULT_CONNECT_TIMEOUT_MS = 8_000;

/** 어느 단계에서 터졌는지 — 실패 분류의 근거. */
type Phase = 'connect' | 'handshake' | 'address' | 'query';

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** 클라이언트가 만든 타임아웃 문구( client.ts:186 ) 판정. 서버 문구가 아니다. */
function looksLikeTimeout(msg: string): boolean {
  return msg.includes('timeout') || msg.includes('응답 없음') || msg.includes('초과');
}

/**
 * 표시 순서: 멤풀(height <= 0) 먼저, 그 다음 height 내림차순.
 * 순수 함수 — 입력 배열을 바꾸지 않는다.
 *
 * Electrum 은 컨펌 항목을 블록 순서(오름차순)로, 멤풀 항목을 그 뒤에 준다.
 * 화면은 최신이 위라 뒤집는다. height 가 같으면 서버가 준 순서를 유지한다.
 */
export function sortBtcRowsForDisplay(rows: BtcActivityRow[]): BtcActivityRow[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => {
      const aMempool = a.row.height <= 0;
      const bMempool = b.row.height <= 0;
      if (aMempool !== bMempool) return aMempool ? -1 : 1;
      if (a.row.height !== b.row.height) return b.row.height - a.row.height;
      return a.i - b.i; // 동률은 서버가 준 순서 그대로 (Array.sort 안정성에 기대지 않는다)
    })
    .map((x) => x.row);
}

/**
 * BTC 이력 조회 (Electrum 트랙). **던지지 않는다.**
 *
 * transport 는 인스턴스가 아니라 **팩토리**로 받는다 — ByteTransport 구현은
 * 1 인스턴스 = 1 연결이라(native-tcp.ts:12) 재조회 때마다 새로 만들어야 한다.
 *
 * 호출 순서는 고정이다. ElectrumClient 생성이 connect 보다 **먼저**여야 한다 —
 * 생성자가 onData/onClose 를 걸기 때문에(client.ts:72-73), 뒤집으면 첫 조각을
 * 흘린다.
 */
export async function fetchBtcHistory(
  makeTransport: () => ByteTransport,
  q: BtcHistoryQuery,
): Promise<BtcHistoryResult> {
  const track: BtcTrack = 'electrum';
  const limit = q.limit ?? DEFAULT_LIMIT;

  let mod: typeof import('@byeorin/wallet-sdk/btc-history');
  try {
    mod = await import('@byeorin/wallet-sdk/btc-history');
  } catch (e) {
    // 번들/CSP 문제 — 조회 자체가 불가능하다.
    return { ok: false, track, failure: 'unsupported', message: messageOf(e) };
  }

  const { ElectrumClient, ElectrumError, addressToScripthash, toActivityRows } = mod;

  const transport = makeTransport();
  const client = new ElectrumClient(transport, {
    timeoutMs: q.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  let phase: Phase = 'connect';
  try {
    await client.connect(q.server.host, q.server.port, {
      tls: q.server.tls ?? false,
      timeoutMs: q.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    });

    phase = 'handshake';
    await client.version('byeorin-wallet', '1.4');

    phase = 'address';
    const scripthash = addressToScripthash(q.address, q.network ?? 'mainnet');

    phase = 'query';
    const rows = toActivityRows(await client.getHistory(scripthash));

    const sorted = sortBtcRowsForDisplay(rows);
    return {
      ok: true,
      track,
      rows: sorted.slice(0, limit),
      truncated: sorted.length > limit,
    };
  } catch (e) {
    const message = messageOf(e);
    // 서버가 error 로 답한 것 — 우리 쪽 문제가 아니다.
    if (e instanceof ElectrumError) return { ok: false, track, failure: 'server', message };
    // 주소를 scripthash 로 못 바꿈 = 이 계정/주소로는 조회 불가.
    if (phase === 'address') return { ok: false, track, failure: 'unsupported', message };
    if (looksLikeTimeout(message)) return { ok: false, track, failure: 'timeout', message };
    if (phase === 'connect') return { ok: false, track, failure: 'transport', message };
    // handshake/query 의 형태 불일치는 프로토콜 문제로 본다.
    return { ok: false, track, failure: 'protocol', message };
  } finally {
    // 소켓을 남기지 않는다. close 실패는 이미 끝난 조회를 뒤엎지 않는다.
    try {
      await client.close();
    } catch {
      // 네이티브 브리지가 이미 내려간 경우 등 — 정리 실패는 결과를 바꾸지 않는다.
    }
  }
}
