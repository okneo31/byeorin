// aptos.ts — Aptos 활동 소스. fullnode REST 만 쓴다(인덱서 X, 읽기 GET 1왕복).
//
// GET {base}/accounts/{addr}/transactions?limit={n}
//
// 실측 사실(2026-08-12, fullnode.mainnet.aptoslabs.com):
//   - `start` 없이 부르면 **최신 페이지**를 준다 (sequence_number 2222359 계정에서
//     seq 2222354~2222358 반환) — start 계산이 필요 없다.
//   - 다만 페이지 안 정렬은 **오름차순**이다 → version 내림차순 재정렬이 필요하다.
//   - timestamp 는 마이크로초 문자열('1780511155096640') → /1e6 로 UNIX seconds.
//   - payload 는 snake_case: { function, type_arguments, arguments }.
//
// 구조 한계: 이 엔드포인트는 **이 계정이 보낸 tx 만** 준다. 받은 이력은 fullnode
// 로 불가(인덱서 GraphQL 필요 — 범위 밖). 그래서 direction 은 항상 'out' 이고,
// 화면은 activity.src.aptos.sent_only 를 상시 고지한다. omitted 는 ['memo'] —
// Aptos user tx 에는 메모 필드 자체가 없다.
import {
  ACTIVITY_SOURCE_DEFAULT_LIMIT,
  ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS,
  type ActivityQuery,
  type ActivitySourceResult,
  type ChainActivityRow,
} from './types.js';

export const APTOS_ACTIVITY_REST = 'https://fullnode.mainnet.aptoslabs.com/v1';

/** fullnode 가 받는 limit 상한 (그 이상은 400). */
const MAX_LIMIT = 100;

/** native APT 의 legacy coin type — chains/aptos.ts 의 APT_COIN_TYPE 과 같은 값. */
const APT_COIN_TYPE = '0x1::aptos_coin::AptosCoin';

/** 항상 native APT 를 보내는 entry function. arguments = [to, amount]. */
const NATIVE_TRANSFER_FN = '0x1::aptos_account::transfer';
/** type_arguments[0] 이 APT 일 때만 native 인 entry function 들. arguments = [to, amount]. */
const COIN_TRANSFER_FNS = new Set([
  '0x1::coin::transfer',
  '0x1::aptos_account::transfer_coins',
]);

/**
 * Aptos 활동 조회 — 어떤 입력에도 throw 하지 않는다. 실패는 값으로 돌려준다.
 *
 * 브로드캐스트·쓰기 호출 없음: GET 1회가 전부다.
 */
export async function fetchAptosActivity(
  q: ActivityQuery,
): Promise<ActivitySourceResult> {
  const address = normalizeAddress(q.address);
  if (address === null) {
    return {
      ok: false,
      chain: 'aptos',
      failure: 'unsupported',
      message: `aptos: address must be 0x + 1..64 hex, got "${q.address}"`,
    };
  }

  const f =
    q.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  if (!f) {
    return {
      ok: false,
      chain: 'aptos',
      failure: 'network',
      message: 'aptos: fetch unavailable',
    };
  }

  const limit = clampLimit(q.limit);
  const base = (q.endpoint ?? APTOS_ACTIVITY_REST).replace(/\/+$/, '');
  const url = `${base}/accounts/${address}/transactions?limit=${limit}`;

  // 전체 예산 하나 — 왕복이 1회뿐이라도 AbortController 로 강제한다.
  const ctl = new AbortController();
  const timer = setTimeout(
    () => ctl.abort(),
    q.timeoutMs ?? ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS,
  );
  try {
    let res: Response;
    try {
      res = await f(url, {
        headers: { accept: 'application/json' },
        signal: ctl.signal,
      });
    } catch (e) {
      if (ctl.signal.aborted) {
        return {
          ok: false,
          chain: 'aptos',
          failure: 'timeout',
          message: 'aptos: activity fetch exceeded time budget',
        };
      }
      return {
        ok: false,
        chain: 'aptos',
        failure: 'network',
        message: `aptos: fetch failed — ${describe(e)}`,
      };
    }

    if (!res.ok) {
      return {
        ok: false,
        chain: 'aptos',
        failure: 'network',
        message: `aptos: fullnode returned HTTP ${res.status}`,
      };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return {
        ok: false,
        chain: 'aptos',
        failure: 'protocol',
        message: 'aptos: response is not JSON',
      };
    }
    if (!Array.isArray(body)) {
      return {
        ok: false,
        chain: 'aptos',
        failure: 'protocol',
        message: 'aptos: expected a transaction array',
      };
    }

    const rows: ChainActivityRow[] = [];
    for (const raw of body) {
      const row = parseRow(raw);
      if (row) rows.push(row);
    }
    // 실측: 서버는 최신 페이지를 오름차순으로 준다 → version 내림차순 재정렬.
    // tie-break 는 id 사전순(재조회 안정성) — types.ts 계약.
    rows.sort((a, b) => {
      const av = a.blockNumber;
      const bv = b.blockNumber;
      if (av !== undefined && bv !== undefined && av !== bv) {
        return av > bv ? -1 : 1;
      }
      if (av !== undefined && bv === undefined) return -1;
      if (av === undefined && bv !== undefined) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return {
      ok: true,
      chain: 'aptos',
      rows,
      // memo: Aptos user tx 에 메모 필드가 없다 — 모든 행에서 구조적으로 빈다.
      // direction/counterparty/amount 는 행별로 비는 것이라 넣지 않는다(계약).
      omitted: ['memo'],
      // 서버가 요청한 만큼 꽉 채워 돌려줬으면 그 앞(과거)이 더 있을 수 있다.
      truncated: body.length >= limit,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 파싱 유틸 ──────────────────────────────────────────────

/** limit 을 1..MAX_LIMIT 정수로 강제한다. */
function clampLimit(v: number | undefined): number {
  const n = typeof v === 'number' && Number.isFinite(v)
    ? Math.floor(v)
    : ACTIVITY_SOURCE_DEFAULT_LIMIT;
  return Math.min(Math.max(n, 1), MAX_LIMIT);
}

/** `0x` + 1~64 hex → 64자리 소문자 정규화. 아니면 null. */
function normalizeAddress(v: string): string | null {
  const s = v.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(s)) return null;
  return '0x' + s.slice(2).toLowerCase().padStart(64, '0');
}

/**
 * fullnode tx 1건 → ChainActivityRow. hash 가 없으면 그 행을 버린다.
 * 없는 필드는 undefined 로 둔다 — 지어내지 않는다.
 */
function parseRow(raw: unknown): ChainActivityRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as {
    hash?: unknown;
    version?: unknown;
    success?: unknown;
    timestamp?: unknown;
    payload?: unknown;
  };
  if (typeof r.hash !== 'string' || r.hash.length === 0) return null;

  const row: ChainActivityRow = {
    id: r.hash,
    blockNumber: toBigInt(r.version),
    timestamp: microsToSeconds(r.timestamp),
    status:
      r.success === true ? 'success' : r.success === false ? 'failed' : 'unknown',
    // 이 엔드포인트는 이 계정이 **보낸** tx 만 준다 — 항상 'out'.
    direction: 'out',
    raw,
  };

  const t = parseTransferPayload(r.payload);
  if (t) {
    if (t.counterparty !== undefined) row.counterparty = t.counterparty;
    if (t.amount !== undefined) {
      row.amount = t.amount;
      row.symbol = 'APT';
    }
  }
  return row;
}

/**
 * 송금류 entry function 일 때만 수신자·금액을 읽는다.
 *
 * amount 는 계약상 **native base unit(octas)** 이다 — coin::transfer 의
 * type_arguments[0] 이 APT 가 아니면 그 금액은 다른 토큰 단위라서 amount 를
 * 비워 둔다(octas 인 척 올리면 거짓이 된다). counterparty 는 그래도 채운다.
 */
function parseTransferPayload(
  payload: unknown,
): { counterparty?: string; amount?: bigint } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as {
    function?: unknown;
    type_arguments?: unknown;
    arguments?: unknown;
  };
  if (typeof p.function !== 'string' || !Array.isArray(p.arguments)) return null;

  let native: boolean;
  if (p.function === NATIVE_TRANSFER_FN) {
    native = true;
  } else if (COIN_TRANSFER_FNS.has(p.function)) {
    native =
      Array.isArray(p.type_arguments) && p.type_arguments[0] === APT_COIN_TYPE;
  } else {
    return null; // 송금류가 아니다 — 판별 불가면 undefined 로 둔다.
  }

  const to = p.arguments[0];
  const counterparty =
    typeof to === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(to) ? to : undefined;
  const amount = native ? (toBigInt(p.arguments[1]) ?? undefined) : undefined;
  return { counterparty, amount };
}

/** 숫자 문자열/정수 → bigint. 형식이 다르면 undefined. */
function toBigInt(v: unknown): bigint | undefined {
  if (typeof v === 'string' && /^\d+$/.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) return BigInt(v);
  return undefined;
}

/** 마이크로초 문자열/숫자 → UNIX seconds. 형식이 다르면 undefined. */
function microsToSeconds(v: unknown): number | undefined {
  const micros =
    typeof v === 'string' && /^\d+$/.test(v)
      ? Number(v)
      : typeof v === 'number' && Number.isFinite(v) && v >= 0
        ? v
        : undefined;
  if (micros === undefined) return undefined;
  return Math.floor(micros / 1e6);
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
