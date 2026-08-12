// sui.ts — Sui 활동 소스. suix_queryTransactionBlocks 를 JSON-RPC POST 로 읽는다.
//
// **2왕복이 필수다.** 이 메서드의 filter 는 FromAddress / ToAddress 를 한 번에
// 하나만 받는다(OR 필터 없음) — 보낸 것과 받은 것을 모두 보려면 두 번 조회해
// digest 로 병합하는 수밖에 없다. 두 요청은 병렬로 던지고 AbortController
// 하나로 전체 예산(timeoutMs)을 같이 강제한다. 양쪽 모두에 나온 digest 는
// direction:'self' 다.
//
// throw 금지 — 실패는 값(ActivitySourceErr)으로 돌려준다 (types.ts 계약).
// 읽기 메서드 하나만 부른다. 브로드캐스트·쓰기 호출 없음.

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

/** 저장소가 이미 쓰는 Sui JSON-RPC (chains/sui.ts 와 같은 도메인 — CORS 열림). */
export const SUI_ACTIVITY_RPC = 'https://sui-rpc.publicnode.com';

/**
 * Sui 에는 tx 메모 필드가 없다 — 모든 행에서 구조적으로 비므로 고지한다.
 * timestamp/amount 등은 행별로 우연히 빌 수 있을 뿐이라 넣지 않는다 (계약).
 */
const SUI_OMITTED: readonly OmittedField[] = ['memo'];

/** SUI 네이티브 coin type 의 정규형 address 부분 (0x + 63개 0 + 2). */
const SUI_COIN_ADDRESS = '0x' + '0'.repeat(63) + '2';

/**
 * Sui 주소 정규화: 0x + hex 1~64자 → 소문자 + 64자 zero-pad.
 * (`0x2` 와 `0x000…002` 는 같은 주소 — balanceChanges 비교도 이 형으로 한다.)
 * 형식이 아니면 null — 조회 없이 failure:'unsupported' 로 돌려준다.
 */
function normalizeSuiAddress(input: string): string | null {
  const t = input.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(t)) return null;
  return '0x' + t.slice(2).toLowerCase().padStart(64, '0');
}

/** coinType 문자열이 SUI 네이티브(`…::sui::SUI`)인지 — 주소 부분을 정규화해 비교. */
function isSuiCoinType(coinType: string): boolean {
  const parts = coinType.split('::');
  if (parts.length !== 3 || parts[1] !== 'sui' || parts[2] !== 'SUI') return false;
  return normalizeSuiAddress(parts[0] ?? '') === SUI_COIN_ADDRESS;
}

/** 응답 항목에서 안전하게 꺼내기 위한 최소 형태 — 검증은 코드에서 한다. */
interface SuiQueryPage {
  data: unknown[];
  hasNextPage: boolean;
}

type RpcPageResult =
  | { ok: true; page: SuiQueryPage }
  | { ok: false; failure: ActivitySourceErr['failure']; message: string };

function err(
  failure: ActivitySourceErr['failure'],
  message: string,
): ActivitySourceErr {
  return { ok: false, chain: 'sui', failure, message };
}

/** suix_queryTransactionBlocks 1회 호출 (filter 하나). throw 하지 않는다. */
async function queryPage(
  fetchImpl: typeof fetch,
  endpoint: string,
  filter: Record<string, string>,
  limit: number,
  signal: AbortSignal,
  timedOut: () => boolean,
): Promise<RpcPageResult> {
  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'suix_queryTransactionBlocks',
        params: [
          {
            filter,
            options: { showEffects: true, showBalanceChanges: true },
          },
          null, // cursor — 첫 페이지만. 넘치면 truncated 로 고지한다.
          limit,
          true, // descending_order — 최신이 앞.
        ],
      }),
      signal,
    });
  } catch (e) {
    if (timedOut()) return { ok: false, failure: 'timeout', message: 'sui: 조회 예산 초과' };
    return {
      ok: false,
      failure: 'network',
      message: `sui: fetch 실패 — ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!res.ok) {
    return { ok: false, failure: 'network', message: `sui: HTTP ${res.status}` };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    if (timedOut()) return { ok: false, failure: 'timeout', message: 'sui: 조회 예산 초과' };
    return { ok: false, failure: 'protocol', message: 'sui: JSON 이 아닌 응답' };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, failure: 'protocol', message: 'sui: 응답이 객체가 아님' };
  }
  const rpcError = (body as { error?: unknown }).error;
  if (rpcError !== undefined && rpcError !== null) {
    const msg =
      typeof rpcError === 'object' && rpcError !== null && 'message' in rpcError
        ? String((rpcError as { message: unknown }).message)
        : JSON.stringify(rpcError);
    return { ok: false, failure: 'server', message: `sui: RPC 오류 — ${msg}` };
  }
  const result = (body as { result?: unknown }).result;
  if (
    typeof result !== 'object' ||
    result === null ||
    !Array.isArray((result as { data?: unknown }).data)
  ) {
    return { ok: false, failure: 'protocol', message: 'sui: result.data 배열 없음' };
  }
  return {
    ok: true,
    page: {
      data: (result as { data: unknown[] }).data,
      hasNextPage: (result as { hasNextPage?: unknown }).hasNextPage === true,
    },
  };
}

/** balanceChanges 원소에서 {owner주소(정규형), coinType, amount} 를 안전 추출. */
function readBalanceChange(
  raw: unknown,
): { owner: string; coinType: string; amount: bigint } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const rec = raw as { owner?: unknown; coinType?: unknown; amount?: unknown };
  if (typeof rec.owner !== 'object' || rec.owner === null) return null;
  const addr = (rec.owner as { AddressOwner?: unknown }).AddressOwner;
  if (typeof addr !== 'string') return null; // ObjectOwner/Shared 는 상대 후보 아님.
  const owner = normalizeSuiAddress(addr);
  if (owner === null) return null;
  if (typeof rec.coinType !== 'string' || typeof rec.amount !== 'string') return null;
  let amount: bigint;
  try {
    amount = BigInt(rec.amount);
  } catch {
    return null;
  }
  return { owner, coinType: rec.coinType, amount };
}

/** 한 tx 항목 → 행. digest 가 없으면 식별 불가라 null (지어내지 않는다). */
function toRow(
  raw: unknown,
  self: string,
  direction: 'in' | 'out',
): ChainActivityRow | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const item = raw as {
    digest?: unknown;
    timestampMs?: unknown;
    checkpoint?: unknown;
    effects?: unknown;
    balanceChanges?: unknown;
  };
  if (typeof item.digest !== 'string' || item.digest.length === 0) return null;

  // timestampMs 는 string|null — null 이면 undefined 로 둔다 (0 으로 안 지어냄).
  let timestamp: number | undefined;
  if (typeof item.timestampMs === 'string') {
    const ms = Number(item.timestampMs);
    if (Number.isFinite(ms) && ms >= 0) timestamp = Math.floor(ms / 1000);
  }

  // checkpoint(string|null) → blockNumber.
  let blockNumber: bigint | undefined;
  if (typeof item.checkpoint === 'string') {
    try {
      blockNumber = BigInt(item.checkpoint);
    } catch {
      blockNumber = undefined;
    }
  }

  // effects.status.status: 'success' | 'failure'. 없으면 'unknown'.
  let status: ChainActivityRow['status'] = 'unknown';
  if (typeof item.effects === 'object' && item.effects !== null) {
    const st = (item.effects as { status?: unknown }).status;
    if (typeof st === 'object' && st !== null) {
      const v = (st as { status?: unknown }).status;
      if (v === 'success') status = 'success';
      else if (v === 'failure') status = 'failed';
    }
  }

  // balanceChanges: self 소유 SUI 변화 합의 절대값 = amount (가스 포함 — 서버
  // 원문 그대로, 재구성하지 않는다). self 아닌 첫 AddressOwner = counterparty.
  let amount: bigint | undefined;
  let counterparty: string | undefined;
  if (Array.isArray(item.balanceChanges)) {
    let selfDelta: bigint | undefined;
    for (const bcRaw of item.balanceChanges) {
      const bc = readBalanceChange(bcRaw);
      if (bc === null) continue;
      if (bc.owner === self) {
        if (isSuiCoinType(bc.coinType)) {
          selfDelta = (selfDelta ?? 0n) + bc.amount;
        }
      } else if (counterparty === undefined) {
        counterparty = bc.owner;
      }
    }
    if (selfDelta !== undefined) {
      amount = selfDelta < 0n ? -selfDelta : selfDelta;
    }
  }

  return {
    id: item.digest,
    timestamp,
    blockNumber,
    status,
    direction,
    counterparty,
    amount,
    symbol: amount !== undefined ? 'SUI' : undefined,
    raw,
  };
}

/**
 * Sui 활동 조회 — FromAddress / ToAddress 2왕복 병합.
 * 어떤 입력에도 throw 하지 않는다. 실패는 ActivitySourceErr 값.
 */
export async function fetchSuiActivity(
  q: ActivityQuery,
): Promise<ActivitySourceResult> {
  const self = normalizeSuiAddress(q.address);
  if (self === null) {
    return err('unsupported', `sui: 주소 형식 아님 — ${JSON.stringify(q.address)}`);
  }

  const rawLimit = q.limit ?? ACTIVITY_SOURCE_DEFAULT_LIMIT;
  const limit =
    Number.isInteger(rawLimit) && rawLimit > 0
      ? rawLimit
      : ACTIVITY_SOURCE_DEFAULT_LIMIT;
  const budgetMs = q.timeoutMs ?? ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS;
  const fetchImpl = q.fetch ?? globalThis.fetch;
  const endpoint = q.endpoint ?? SUI_ACTIVITY_RPC;

  // 전체 예산 하나 — 두 왕복이 컨트롤러 하나를 공유한다.
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, budgetMs);

  let fromRes: RpcPageResult;
  let toRes: RpcPageResult;
  try {
    [fromRes, toRes] = await Promise.all([
      queryPage(
        fetchImpl, endpoint, { FromAddress: self }, limit,
        controller.signal, () => timedOut,
      ),
      queryPage(
        fetchImpl, endpoint, { ToAddress: self }, limit,
        controller.signal, () => timedOut,
      ),
    ]);
  } catch (e) {
    // queryPage 는 throw 하지 않으므로 여기 오면 코드 결함이지만, 계약(throw
    // 금지)을 지키기 위해 값으로 감싼다.
    clearTimeout(timer);
    return err(
      timedOut ? 'timeout' : 'protocol',
      `sui: 내부 오류 — ${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!fromRes.ok) return err(fromRes.failure, fromRes.message);
  if (!toRes.ok) return err(toRes.failure, toRes.message);

  // digest 병합 — From 결과가 먼저 행을 만들고, To 쪽에도 있으면 'self' 로 승격.
  const byDigest = new Map<string, ChainActivityRow>();
  for (const raw of fromRes.page.data) {
    const row = toRow(raw, self, 'out');
    if (row !== null) byDigest.set(row.id, row);
  }
  for (const raw of toRes.page.data) {
    const row = toRow(raw, self, 'in');
    if (row === null) continue;
    const existing = byDigest.get(row.id);
    if (existing !== undefined) {
      // 보낸 목록과 받은 목록 양쪽에 나온 digest = 자기 자신에게 보낸 tx.
      existing.direction = 'self';
    } else {
      byDigest.set(row.id, row);
    }
  }

  // 최신이 앞: timestamp ↓ → checkpoint ↓ → id 사전순 (tie-break, 재조회 안정성).
  // timestamp/checkpoint 가 없는 행은 있는 행 뒤로 보낸다 — 순서를 지어내지 않는다.
  const rows = [...byDigest.values()].sort((a, b) => {
    const at = a.timestamp;
    const bt = b.timestamp;
    if (at !== undefined && bt !== undefined && at !== bt) return bt - at;
    if (at !== undefined && bt === undefined) return -1;
    if (at === undefined && bt !== undefined) return 1;
    const ab = a.blockNumber;
    const bb = b.blockNumber;
    if (ab !== undefined && bb !== undefined && ab !== bb) return bb > ab ? 1 : -1;
    if (ab !== undefined && bb === undefined) return -1;
    if (ab === undefined && bb !== undefined) return 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const truncated =
    rows.length > limit || fromRes.page.hasNextPage || toRes.page.hasNextPage;

  return {
    ok: true,
    chain: 'sui',
    rows: rows.slice(0, limit),
    omitted: SUI_OMITTED,
    truncated,
  };
}
