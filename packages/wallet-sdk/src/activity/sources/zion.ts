// zion.ts — cosmos:zion 활동 소스. LCD tx 검색 2왕복(보낸/받은) 병합.
//
// ZionWallet.MD:25 에 명세된 LCD(lcd.zion1.top)를 쓴다 — RPC(rpc.zion1.top)와
// 다른 도메인이지만 같은 자기 생태계 명세 도메인이다.
//
// 파라미터 실측 (2026-08-12, 읽기 GET):
//   /cosmos/tx/v1beta1/txs?query=message.sender='zion1...' → HTTP 200
//   /cosmos/tx/v1beta1/txs?events=...                      → HTTP 500 "query cannot be empty"
// ZION 은 Cosmos SDK v0.50(multichain.ts ZION_CHAIN_SPEC 주석) — `query=` 로 확정,
// 구식 `events=` 재시도는 넣지 않는다(서버가 아예 못 알아듣는다).
//
// 실측 함정: 이 LCD 는 pagination.limit 을 무시하고 전부 준다
// (limit=1 요청에 total=5, tx_responses 5건 반환 — 2026-08-12). 그래서
// limit 절단은 반드시 클라이언트에서 한다.
//
// 계약(types.ts): throw 금지, 실패는 값. 읽기 GET 만 호출한다.

import type {
  ActivityQuery,
  ActivitySourceErr,
  ActivitySourceResult,
  ChainActivityRow,
  OmittedField,
} from './types.js';
import {
  ACTIVITY_SOURCE_DEFAULT_LIMIT,
  ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS,
} from './types.js';

/** ZionWallet.MD:25 — Cosmos LCD / REST 공개 엔드포인트. */
export const ZION_ACTIVITY_LCD = 'https://lcd.zion1.top';

/**
 * tx_responses 에는 txhash·height·timestamp·code·tx.body 가 전부 있다.
 * direction/counterparty/amount 는 MsgSend 일 때만 채워지지만 그건 행별
 * 사정이지 구조적 공백이 아니다 — omitted 는 빈 배열이다.
 */
const ZION_OMITTED: readonly OmittedField[] = [];

/**
 * bech32 zion 계정 주소. prefix 'zion' + 구분자 '1' + data 38자
 * (20바이트 계정 + 체크섬 6자). 문자셋은 bech32 (1/b/i/o 제외 소문자·숫자).
 */
const ZION_ADDRESS_RE = /^zion1[02-9ac-hj-np-z]{38}$/;

/** utrg 6자리 = 표시 심볼 kWR (multichain.ts ZION_CHAIN_SPEC.nativeSymbol). */
const ZION_NATIVE_DENOM = 'utrg';
const ZION_NATIVE_SYMBOL = 'kWR';

const MSG_SEND_TYPE = '/cosmos.bank.v1beta1.MsgSend';

/** tx_responses[] 원소 (관심 필드만). */
interface TxResponseEntry {
  txhash?: string;
  height?: string;
  timestamp?: string; // RFC3339
  code?: number; // 0 = 성공
  tx?: {
    body?: {
      memo?: string;
      messages?: Array<{
        '@type'?: string;
        from_address?: string;
        to_address?: string;
        amount?: Array<{ denom?: string; amount?: string }>;
      }>;
    };
  };
}

function fail(failure: ActivitySourceErr['failure'], message: string): ActivitySourceErr {
  return { ok: false, chain: 'cosmos', failure, message };
}

/**
 * zion 주소의 최근 tx 를 가져온다. message.sender / transfer.recipient 양방향
 * 2왕복 → txhash 중복제거 병합, height 내림차순·tie-break id 사전순.
 * 어떤 입력에도 throw 하지 않는다 — 실패는 ActivitySourceErr 값이다.
 */
export async function fetchCosmosActivity(q: ActivityQuery): Promise<ActivitySourceResult> {
  try {
    return await run(q);
  } catch (e) {
    // 여기 도달하는 건 계약 위반 버그뿐 — 그래도 throw 대신 값으로 돌려준다.
    return fail('protocol', e instanceof Error ? e.message : String(e));
  }
}

async function run(q: ActivityQuery): Promise<ActivitySourceResult> {
  if (typeof q.address !== 'string' || !ZION_ADDRESS_RE.test(q.address)) {
    return fail('unsupported', `zion 주소 형식이 아님: ${String(q.address)}`);
  }
  const limit = clampLimit(q.limit);
  const timeoutMs = q.timeoutMs ?? ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS;
  const doFetch = q.fetch ?? globalThis.fetch;
  const endpoint = q.endpoint ?? ZION_ACTIVITY_LCD;

  // 전체 예산 하나 — 2왕복(병렬)과 body 읽기까지 같은 신호로 묶는다.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const [sent, received] = await Promise.all([
      fetchOne(doFetch, endpoint, `message.sender='${q.address}'`, limit, ctrl, timeoutMs),
      fetchOne(doFetch, endpoint, `transfer.recipient='${q.address}'`, limit, ctrl, timeoutMs),
    ]);
    if (!sent.ok) return sent.err;
    if (!received.ok) return received.err;

    // txhash 중복제거 병합. 방향은 어느 쿼리에서 왔는지가 아니라 MsgSend 의
    // from/to 로 판정한다 (자기 자신에게 보내면 양쪽 쿼리에 다 잡힌다).
    const byHash = new Map<string, ChainActivityRow>();
    for (const entry of [...sent.entries, ...received.entries]) {
      const row = toRow(entry, q.address);
      if (!row.ok) return row.err;
      if (!byHash.has(row.row.id)) byHash.set(row.row.id, row.row);
    }

    // 최신이 앞 (height 내림차순), 같으면 id 사전순 — 재조회 안정성.
    const rows = [...byHash.values()].sort((a, b) => {
      const av = a.blockNumber;
      const bv = b.blockNumber;
      if (av !== undefined && bv !== undefined && av !== bv) return av > bv ? -1 : 1;
      if (av !== undefined && bv === undefined) return -1;
      if (av === undefined && bv !== undefined) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    // LCD 가 pagination.limit 을 무시하므로(파일 상단 실측) 여기서 절단한다.
    const truncated = rows.length > limit;
    return {
      ok: true,
      chain: 'cosmos',
      rows: truncated ? rows.slice(0, limit) : rows,
      omitted: ZION_OMITTED,
      truncated,
    };
  } finally {
    clearTimeout(timer);
  }
}

type FetchOneResult =
  | { ok: true; entries: TxResponseEntry[] }
  | { ok: false; err: ActivitySourceErr };

async function fetchOne(
  doFetch: typeof fetch,
  endpoint: string,
  condition: string,
  limit: number,
  ctrl: AbortController,
  timeoutMs: number,
): Promise<FetchOneResult> {
  const url =
    `${endpoint}/cosmos/tx/v1beta1/txs` +
    `?query=${encodeURIComponent(condition)}` +
    `&order_by=ORDER_BY_DESC&pagination.limit=${limit}`;

  let res: Response;
  try {
    res = await doFetch(url, { signal: ctrl.signal }); // 읽기 GET
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, err: fail('timeout', `${timeoutMs}ms 초과`) };
    return { ok: false, err: fail('network', e instanceof Error ? e.message : String(e)) };
  }

  if (!res.ok) {
    // LCD 는 실패를 HTTP 4xx/5xx + {code,message} JSON 으로 준다 — 그건 'server'.
    // JSON 조차 아니면(리버스프록시 502 등) 'network'.
    let detail: unknown = null;
    try {
      detail = await res.json();
    } catch {
      /* JSON 아님 — network 로 처리 */
    }
    if (detail !== null && typeof detail === 'object') {
      const m = (detail as { message?: unknown }).message;
      if (typeof m === 'string') {
        return { ok: false, err: fail('server', `LCD error (HTTP ${res.status}): ${m}`) };
      }
    }
    return { ok: false, err: fail('network', `HTTP ${res.status}`) };
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    if (ctrl.signal.aborted) return { ok: false, err: fail('timeout', `${timeoutMs}ms 초과`) };
    return {
      ok: false,
      err: fail('protocol', `JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`),
    };
  }

  if (json === null || typeof json !== 'object') {
    return { ok: false, err: fail('protocol', 'LCD 응답이 객체가 아님') };
  }
  const body = json as { tx_responses?: unknown };
  if (!Array.isArray(body.tx_responses)) {
    return { ok: false, err: fail('protocol', 'tx_responses 가 배열이 아님') };
  }
  for (const entry of body.tx_responses) {
    if (entry === null || typeof entry !== 'object') {
      return { ok: false, err: fail('protocol', 'tx_responses 원소가 객체가 아님') };
    }
  }
  return { ok: true, entries: body.tx_responses as TxResponseEntry[] };
}

type ToRowResult = { ok: true; row: ChainActivityRow } | { ok: false; err: ActivitySourceErr };

function toRow(entry: TxResponseEntry, self: string): ToRowResult {
  if (typeof entry.txhash !== 'string' || entry.txhash.length === 0) {
    return { ok: false, err: fail('protocol', 'txhash 필드 없음') };
  }

  // code: 0 = 성공, 그 외 숫자 = 실패. 필드가 없으면 판정 불가 — 지어내지 않는다.
  const status: ChainActivityRow['status'] =
    entry.code === 0 ? 'success' : typeof entry.code === 'number' ? 'failed' : 'unknown';

  const row: ChainActivityRow = { id: entry.txhash, status, raw: entry };

  if (typeof entry.height === 'string' && /^\d+$/.test(entry.height)) {
    row.blockNumber = BigInt(entry.height);
  }
  if (typeof entry.timestamp === 'string') {
    const ms = Date.parse(entry.timestamp); // RFC3339
    if (Number.isFinite(ms)) row.timestamp = Math.floor(ms / 1000);
  }

  const memo = entry.tx?.body?.memo;
  if (typeof memo === 'string' && memo.length > 0) row.memo = memo;

  // direction/counterparty/amount 는 첫 메시지가 MsgSend 일 때만.
  // 커스텀 메시지(/zion.amm.v1.MsgSwap 등)는 undefined 로 둔다.
  const msg = entry.tx?.body?.messages?.[0];
  if (msg !== undefined && msg !== null && msg['@type'] === MSG_SEND_TYPE) {
    const from = typeof msg.from_address === 'string' ? msg.from_address : undefined;
    const to = typeof msg.to_address === 'string' ? msg.to_address : undefined;
    if (from === self && to === self) {
      row.direction = 'self';
    } else if (from === self) {
      row.direction = 'out';
      if (to !== undefined) row.counterparty = to;
    } else if (to === self) {
      row.direction = 'in';
      if (from !== undefined) row.counterparty = from;
    }
    // 네이티브(utrg)만 금액으로 올린다. 다른 denom(upi 등 — 실측 존재)은
    // 판별 범위 밖이라 undefined 로 둔다.
    const coin = msg.amount?.[0];
    if (
      coin !== undefined &&
      coin !== null &&
      coin.denom === ZION_NATIVE_DENOM &&
      typeof coin.amount === 'string' &&
      /^\d+$/.test(coin.amount)
    ) {
      row.amount = BigInt(coin.amount);
      row.symbol = ZION_NATIVE_SYMBOL;
    }
  }

  return { ok: true, row };
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ACTIVITY_SOURCE_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > 100) return 100; // LCD pagination.limit 상한 관례 (어차피 클라이언트 절단)
  return n;
}
