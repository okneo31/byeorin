// btc-history-source.ts — 활동 화면 ↔ @byeorin/wallet-sdk/btc-history 사이의 유일한 접점.
//
// 이 파일이 하는 일은 셋뿐이다.
//   1) Electrum 왕복 순서를 한 곳에 고정한다 (client 생성 → connect → version → history).
//   2) 던지는 예외를 **값**으로 바꾼다 — 화면은 try/catch 없이 분기만 한다.
//   3) 서버 주소·릴레이 주소를 상수 한 곳에 모은다 (정책 결정 시 1줄 교체).
//
// SDK 는 재구현하지 않는다. ElectrumClient/addressToScripthash/toActivityRows 를 그대로 쓴다.
//
// **값 import 는 반드시 dynamic import 로 한다** (fetchBtcHistory 본문 안).
// btc-history 배럴의 scripthash.ts 가 @scure/btc-signer 를 정적 의존해서, 정적으로
// 걸면 popup 초기 번들에 통째로 실린다. ActivityPane.tsx:11-14 가 ActivityLog 를
// dynamic import 하는 것과 같은 이유·같은 수법이다. 타입만 정적으로 가져온다
// (타입은 번들에 아무것도 남기지 않는다).

import type { ByteTransport, BtcActivityRow } from '@byeorin/wallet-sdk/btc-history';

// ────────── 서버 상수 ──────────
//
// 확장(MV3)은 raw TCP 를 못 연다. 로컬 릴레이(scripts/btc-relay/server.mjs)가
// WebSocket→TCP 를 이어 주는데, tls: true 를 주면 릴레이가 대상에 **TLS 로**
// 접속한다(server.mjs 의 tls=1 경로). 예전 주석은 "TLS 도 릴레이가 대신하므로
// tls=false" 라고 적었지만 거짓이었다 — tls=false 면 릴레이는 평문 50001 로
// 나가고, 릴레이→서버 구간이 인터넷을 지나므로 조회 주소가 경로 전체에 노출된다.
// 릴레이는 사용자가 직접 띄워야 한다
// (`--allow electrum.blockstream.info:50002`. 기본 allow 는 빈 목록 = 전부 거부).
//
// 제3자 Electrum 서버를 쓰면 "그 서버가 내 주소를 안다" 가 기본값이 된다.
// 서버 정책은 아직 미결정 사항(docs/BTC-HISTORY.md §7②)이라 여기 한 줄로 모아 둔다.
export const RELAY_URL = 'ws://127.0.0.1:18337';
export const ELECTRUM: BtcServerSpec = {
  host: 'electrum.blockstream.info',
  port: 50002,
  tls: true,
};

const DEFAULT_LIMIT = 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;

// ────────── 계약 ──────────

/** 지금 배선된 트랙은 Electrum 하나뿐. 'bip157' 은 체크포인트 결정 후. */
export type BtcTrack = 'electrum';

export interface BtcServerSpec {
  host: string;
  port: number;
  tls?: boolean;
}

export interface BtcHistoryQuery {
  /** BTC 주소 (bc1q… 기본). EVM 주소를 넘기면 'unsupported' 로 떨어진다. */
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

// ────────── 순수 함수 (테스트 대상) ──────────

/**
 * 표시 순서: 멤풀(height <= 0) 먼저, 그 다음 height 내림차순.
 *
 * Electrum 의 get_history 는 컨펌분을 높이 오름차순으로 주고 멤풀분을 뒤에 붙인다.
 * 화면은 최신이 위라, 뒤집어 준다. 원 배열은 건드리지 않는다(복사 후 정렬).
 * 같은 높이면 txid 사전순 — 같은 목록이 재조회마다 흔들리지 않게 하는 tie-break 다.
 */
export function sortBtcRowsForDisplay(rows: BtcActivityRow[]): BtcActivityRow[] {
  return [...rows].sort((a, b) => {
    const aPending = a.height <= 0;
    const bPending = b.height <= 0;
    if (aPending !== bPending) return aPending ? -1 : 1;
    if (aPending && bPending) {
      // 멤풀끼리: -1(부모 미컨펌)이 0(부모 컨펌)보다 뒤. 높이 내림차순과 같은 규칙.
      if (a.height !== b.height) return b.height - a.height;
      return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
    }
    if (a.height !== b.height) return b.height - a.height;
    return a.txid < b.txid ? -1 : a.txid > b.txid ? 1 : 0;
  });
}

/**
 * 예외 → 실패 종류. stage 는 어느 단계에서 터졌는지 (connect 실패는 전송 문제다).
 *
 * isElectrumError 를 인자로 받는 이유: 이 함수는 dynamic import 없이 테스트할 수
 * 있어야 하는데 ElectrumError 클래스는 dynamic import 뒤에나 손에 잡힌다.
 */
export function classifyBtcFailure(
  e: unknown,
  stage: 'connect' | 'request' | 'decode',
  isElectrumError: (v: unknown) => boolean,
): BtcHistoryFailure {
  if (isElectrumError(e)) return 'server';
  const msg = e instanceof Error ? e.message : String(e);
  // ElectrumClient 는 요청 상한 초과를 'timeout' 문구로, 연결 상한 초과도 마찬가지로 낸다.
  if (/timeout|timed out|응답 없음/i.test(msg)) return 'timeout';
  if (stage === 'connect') return 'transport';
  if (stage === 'decode') return 'protocol';
  // 요청 도중 소켓이 끊기면(릴레이 종료 등) 전송 문제다.
  if (/closed|not connected|socket|relay|연결/i.test(msg)) return 'transport';
  return 'protocol';
}

// ────────── 조회 ──────────

function errMessage(e: unknown, fallback: string): string {
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

/**
 * Electrum 트랙 BTC 이력 조회. **던지지 않는다** — 실패도 값으로 준다.
 *
 * makeTransport 가 인스턴스가 아니라 팩토리인 이유: 셸 transport 4종의 공통 규약이
 * "1 인스턴스 = 1 연결, 재연결은 새 인스턴스" 라서다. 재시도가 같은 인스턴스를
 * 다시 쓰면 'already connected' 로 죽는다.
 *
 * 호출 순서를 바꾸면 첫 조각을 잃는다 — ElectrumClient 생성자가 onData/onClose 를
 * 걸기 때문에 **connect 보다 먼저 생성**해야 한다.
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
    // 청크 로드 실패(CSP·번들 누락). 조용히 빈 목록으로 넘기지 않는다.
    return {
      ok: false,
      track,
      failure: 'unsupported',
      message: errMessage(e, 'btc-history 모듈을 불러오지 못했습니다'),
    };
  }
  const isElectrumError = (v: unknown): boolean => v instanceof mod.ElectrumError;

  // scripthash 도출 — 주소가 BTC 주소가 아니면 여기서 걸린다(EVM 주소 등).
  let scripthash: string;
  try {
    scripthash = mod.addressToScripthash(q.address, q.network ?? 'mainnet');
  } catch (e) {
    return {
      ok: false,
      track,
      failure: 'unsupported',
      message: errMessage(e, 'BTC 주소가 아닙니다'),
    };
  }

  const transport = makeTransport();
  // 생성이 먼저다. 생성자가 transport.onData/onClose 를 건다.
  const client = new mod.ElectrumClient(transport, {
    timeoutMs: q.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  });

  try {
    try {
      await client.connect(q.server.host, q.server.port, {
        tls: q.server.tls ?? false,
        timeoutMs: q.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      });
    } catch (e) {
      return {
        ok: false,
        track,
        failure: classifyBtcFailure(e, 'connect', isElectrumError),
        message: errMessage(e, '연결 실패'),
      };
    }

    try {
      // 프로토콜 협상. 이걸 건너뛰면 서버가 이후 요청을 거절할 수 있다.
      await client.version('byeorin-wallet', '1.4');
    } catch (e) {
      return {
        ok: false,
        track,
        failure: classifyBtcFailure(e, 'request', isElectrumError),
        message: errMessage(e, 'version 실패'),
      };
    }

    let items;
    try {
      items = await client.getHistory(scripthash);
    } catch (e) {
      return {
        ok: false,
        track,
        failure: classifyBtcFailure(e, 'request', isElectrumError),
        message: errMessage(e, 'get_history 실패'),
      };
    }

    try {
      // toActivityRows 는 형태가 어긋나면 던진다 — 그게 'protocol' 이다.
      const all = sortBtcRowsForDisplay(mod.toActivityRows(items));
      return {
        ok: true,
        track,
        rows: all.slice(0, limit),
        truncated: all.length > limit,
      };
    } catch (e) {
      return {
        ok: false,
        track,
        failure: classifyBtcFailure(e, 'decode', isElectrumError),
        message: errMessage(e, '응답 형태 불일치'),
      };
    }
  } finally {
    // 연결에 실패했어도 소켓이 열려 있을 수 있다 — close 는 항상 시도한다.
    // close 자체의 실패는 화면에 올릴 것이 없으므로 삼킨다.
    try {
      await client.close();
    } catch {
      /* 닫기 실패는 결과를 바꾸지 않는다 */
    }
  }
}
