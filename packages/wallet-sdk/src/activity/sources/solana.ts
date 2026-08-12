// solana.ts — 솔라나 활동 소스. getSignaturesForAddress 1왕복.
//
// 저장소가 이미 쓰는 RPC(chains/solana.ts 의 SOLANA_MAINNET_RPC_URLS[0],
// publicnode)를 재사용한다. 서명 목록에는 금액·방향·상대가 없다 —
// getTransaction N회 추가 조회는 이번 범위 밖이므로 omitted 로 고지한다.
// 계약(types.ts): throw 금지, 실패는 값. 읽기 메서드만 호출한다.

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

/** chains/solana.ts SOLANA_MAINNET_RPC_URLS[0] 과 같은 도메인 (실측 2026-07-29 살아있음). */
export const SOLANA_ACTIVITY_RPC = 'https://solana-rpc.publicnode.com';

/**
 * 서명 목록이 구조적으로 못 주는 필드.
 * getSignaturesForAddress 응답에는 서명·slot·blockTime·err·memo 뿐이다.
 */
const SOLANA_OMITTED: readonly OmittedField[] = ['direction', 'counterparty', 'amount'];

/** base58 (비트코인 알파벳) 32~44자 — 솔라나 공개키 표기 범위. */
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** getSignaturesForAddress 응답 result[] 원소 (관심 필드만). */
interface SignatureEntry {
  signature: string;
  slot?: number;
  err?: unknown;       // null = 성공, 객체 = 실패
  blockTime?: number | null;
  memo?: string | null;
}

function fail(failure: ActivitySourceErr['failure'], message: string): ActivitySourceErr {
  return { ok: false, chain: 'solana', failure, message };
}

/**
 * 주소의 최근 서명 목록을 가져온다. 최신이 앞, tie-break 는 id 사전순.
 * 어떤 입력에도 throw 하지 않는다 — 실패는 ActivitySourceErr 값이다.
 */
export async function fetchSolanaActivity(q: ActivityQuery): Promise<ActivitySourceResult> {
  try {
    return await run(q);
  } catch (e) {
    // 여기 도달하는 건 계약 위반 버그뿐 — 그래도 throw 대신 값으로 돌려준다.
    return fail('protocol', e instanceof Error ? e.message : String(e));
  }
}

async function run(q: ActivityQuery): Promise<ActivitySourceResult> {
  if (typeof q.address !== 'string' || !SOLANA_ADDRESS_RE.test(q.address)) {
    return fail('unsupported', `solana 주소 형식이 아님: ${String(q.address)}`);
  }
  const limit = clampLimit(q.limit);
  const timeoutMs = q.timeoutMs ?? ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS;
  const doFetch = q.fetch ?? globalThis.fetch;
  const endpoint = q.endpoint ?? SOLANA_ACTIVITY_RPC;

  // 전체 예산 하나 — 1왕복이지만 body 읽기까지 같은 신호로 묶는다.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'getSignaturesForAddress', // 읽기 전용 메서드
          params: [q.address, { limit }],
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      if (ctrl.signal.aborted) return fail('timeout', `${timeoutMs}ms 초과`);
      return fail('network', e instanceof Error ? e.message : String(e));
    }
    if (!res.ok) return fail('network', `HTTP ${res.status}`);

    let json: unknown;
    try {
      json = await res.json();
    } catch (e) {
      if (ctrl.signal.aborted) return fail('timeout', `${timeoutMs}ms 초과`);
      return fail('protocol', `JSON 파싱 실패: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (json === null || typeof json !== 'object') {
      return fail('protocol', 'RPC 응답이 객체가 아님');
    }
    const body = json as { error?: { message?: string; code?: number }; result?: unknown };
    if (body.error) {
      return fail(
        'server',
        `RPC error ${body.error.code ?? ''}: ${body.error.message ?? 'unknown'}`.trim(),
      );
    }
    if (!Array.isArray(body.result)) {
      return fail('protocol', 'result 가 배열이 아님');
    }

    const rows: ChainActivityRow[] = [];
    for (const entry of body.result) {
      if (entry === null || typeof entry !== 'object') {
        return fail('protocol', 'result 원소가 객체가 아님');
      }
      const sig = entry as SignatureEntry;
      if (typeof sig.signature !== 'string' || sig.signature.length === 0) {
        return fail('protocol', 'signature 필드 없음');
      }
      rows.push(toRow(sig, entry));
    }

    // 최신이 앞 (slot 내림차순), slot 이 같거나 없으면 id 사전순 — 재조회 안정성.
    rows.sort((a, b) => {
      const av = a.blockNumber;
      const bv = b.blockNumber;
      if (av !== undefined && bv !== undefined && av !== bv) return av > bv ? -1 : 1;
      if (av !== undefined && bv === undefined) return -1;
      if (av === undefined && bv !== undefined) return 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return {
      ok: true,
      chain: 'solana',
      rows,
      omitted: SOLANA_OMITTED,
      // 요청 limit 만큼 꽉 차 왔으면 그 뒤가 더 있을 수 있다.
      truncated: rows.length >= limit,
    };
  } finally {
    clearTimeout(timer);
  }
}

function toRow(sig: SignatureEntry, raw: unknown): ChainActivityRow {
  // err: null = 성공, 값 = 실패, 필드 자체가 없으면 판정 불가 — 지어내지 않는다.
  const status: ChainActivityRow['status'] =
    sig.err === null ? 'success' : sig.err !== undefined ? 'failed' : 'unknown';
  const row: ChainActivityRow = { id: sig.signature, status, raw };
  if (typeof sig.slot === 'number' && Number.isSafeInteger(sig.slot) && sig.slot >= 0) {
    row.blockNumber = BigInt(sig.slot);
  }
  // blockTime null = 노드가 시각을 모름 → undefined 로 둔다 (0 으로 지어내지 않는다).
  if (typeof sig.blockTime === 'number' && Number.isFinite(sig.blockTime)) {
    row.timestamp = sig.blockTime;
  }
  if (typeof sig.memo === 'string' && sig.memo.length > 0) {
    row.memo = sig.memo;
  }
  return row;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return ACTIVITY_SOURCE_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > 1000) return 1000; // getSignaturesForAddress 상한
  return n;
}
