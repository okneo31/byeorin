// xrp.ts — XRPL 활동 소스. `account_tx` 는 tx **전문**을 주므로 금액·방향·메모까지
// 계약형(ChainActivityRow)으로 파싱한다. throw 금지 — 실패는 값으로 돌려준다.
//
// 엔드포인트: 저장소가 이미 쓰는 도메인 xrplcluster.com (chains/xrp.ts 는 wss://,
// 여기는 같은 도메인의 HTTPS JSON-RPC POST). 무키 수용은 실측 확인함(2026-08-12,
// HTTP 200 + result.status='success').
//
// 읽기 전용: account_tx 하나만 부른다. 브로드캐스트·쓰기 메서드는 없다.

import type {
  ActivityQuery,
  ActivitySourceResult,
  ChainActivityRow,
} from './types.js';
import {
  ACTIVITY_SOURCE_DEFAULT_LIMIT,
  ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS,
} from './types.js';

export const XRP_ACTIVITY_RPC = 'https://xrplcluster.com';

/**
 * Ripple epoch(2000-01-01T00:00:00Z) → UNIX epoch 보정 초.
 * 빼먹으면 모든 거래가 2000년대 초로 표시된다.
 */
const RIPPLE_EPOCH_OFFSET = 946_684_800;

/**
 * XRPL classic 주소 사전검증 — ripple base58 알파벳(자모가 bitcoin 과 다르다),
 * 'r' 시작, 전체 25~35자. 체크섬까지 검증하려면 base58+sha256 의존성이 필요한데
 * 이 서브패스는 fetch 만 쓰는 경량 계약이라 형식 검사까지만 한다. 형식이 맞고
 * 체크섬이 틀린 주소는 서버가 actNotFound 로 알려주므로 빈 목록이 된다.
 */
const XRP_CLASSIC_ADDRESS_RE =
  /^r[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{24,34}$/;

/** rippled account_tx 응답의 transactions[] 항목 (필요한 필드만). */
interface AccountTxEntry {
  meta?: { TransactionResult?: unknown } | string;
  tx?: Record<string, unknown>;
  /** 일부 rippled(api_version 2)는 tx 대신 tx_json 으로 준다. */
  tx_json?: Record<string, unknown>;
  validated?: unknown;
}

export async function fetchXrpActivity(q: ActivityQuery): Promise<ActivitySourceResult> {
  const chain = 'xrp' as const;
  const address = typeof q.address === 'string' ? q.address.trim() : '';
  if (!XRP_CLASSIC_ADDRESS_RE.test(address)) {
    return {
      ok: false,
      chain,
      failure: 'unsupported',
      message: `xrp: not a classic address: "${address}"`,
    };
  }
  const limit = clampLimit(q.limit);
  const timeoutMs = q.timeoutMs ?? ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS;
  const doFetch = q.fetch ?? globalThis.fetch;
  const endpoint = q.endpoint ?? XRP_ACTIVITY_RPC;

  // 왕복은 1회지만 계약대로 전체 예산 하나를 AbortController 로 강제한다.
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  try {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          method: 'account_tx',
          params: [
            {
              account: address,
              limit,
              ledger_index_min: -1,
              ledger_index_max: -1,
              forward: false,
            },
          ],
        }),
        signal: aborter.signal,
      });
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return { ok: false, chain, failure: 'timeout', message: `xrp: timed out after ${timeoutMs}ms` };
      }
      return { ok: false, chain, failure: 'network', message: `xrp: fetch failed: ${errText(err)}` };
    }
    if (!res.ok) {
      return { ok: false, chain, failure: 'network', message: `xrp: HTTP ${res.status}` };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch (err: unknown) {
      if (isAbortError(err)) {
        return { ok: false, chain, failure: 'timeout', message: `xrp: timed out after ${timeoutMs}ms` };
      }
      return { ok: false, chain, failure: 'protocol', message: 'xrp: response is not JSON' };
    }

    const result = (body as { result?: Record<string, unknown> } | null)?.result;
    if (!result || typeof result !== 'object') {
      return { ok: false, chain, failure: 'protocol', message: 'xrp: missing result object' };
    }
    if (result['status'] === 'error') {
      // 계정이 아직 온체인에 없다 = 이력도 없다. 오류가 아니라 사실이다.
      if (result['error'] === 'actNotFound') {
        return { ok: true, chain, rows: [], omitted: [], truncated: false };
      }
      const detail =
        typeof result['error_message'] === 'string'
          ? result['error_message']
          : typeof result['error'] === 'string'
            ? result['error']
            : 'unknown error';
      return { ok: false, chain, failure: 'server', message: `xrp: ${detail}` };
    }
    const transactions = result['transactions'];
    if (!Array.isArray(transactions)) {
      return { ok: false, chain, failure: 'protocol', message: 'xrp: transactions is not an array' };
    }

    const rows: ChainActivityRow[] = [];
    for (const entry of transactions as AccountTxEntry[]) {
      const row = toRow(entry, address);
      if (row) rows.push(row);
    }
    // 최신이 앞: ledger 내림차순, 동률은 id 사전순(재조회 안정성).
    rows.sort((a, b) => {
      const ah = a.blockNumber ?? -1n;
      const bh = b.blockNumber ?? -1n;
      if (ah !== bh) return ah > bh ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    // marker 가 있으면 서버에 더 있다는 뜻이다.
    const truncated = result['marker'] !== undefined && result['marker'] !== null;
    // account_tx 전문에는 timestamp·방향·상대·금액·메모가 다 들어있다 —
    // 구조적으로 비는 필드 없음. (비-Payment 행에서 금액이 비는 것은 행별 사실.)
    return { ok: true, chain, rows, omitted: [], truncated };
  } catch (err: unknown) {
    // 여기까지 오는 예외는 파싱 로직의 예상 밖 형태뿐이다. throw 금지 계약.
    return { ok: false, chain, failure: 'protocol', message: `xrp: ${errText(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/** transactions[] 1건 → ChainActivityRow. tx 식별자가 없으면 버린다(지어내지 않는다). */
function toRow(entry: AccountTxEntry, self: string): ChainActivityRow | null {
  if (!entry || typeof entry !== 'object') return null;
  const tx = entry.tx ?? entry.tx_json;
  if (!tx || typeof tx !== 'object') return null;
  const hash = tx['hash'];
  if (typeof hash !== 'string' || hash.length === 0) return null;

  // Ripple epoch → UNIX. date 가 없으면 undefined — 0 으로 지어내지 않는다.
  const date = tx['date'];
  const timestamp =
    typeof date === 'number' && Number.isFinite(date) ? date + RIPPLE_EPOCH_OFFSET : undefined;

  const ledger = tx['ledger_index'];
  const blockNumber =
    typeof ledger === 'number' && Number.isSafeInteger(ledger) && ledger >= 0
      ? BigInt(ledger)
      : undefined;

  // meta.TransactionResult: 'tesSUCCESS' 만 성공. meta 가 없거나 문자열(바이너리)이면 unknown.
  const meta = entry.meta;
  const txResult =
    meta && typeof meta === 'object' && typeof meta.TransactionResult === 'string'
      ? meta.TransactionResult
      : null;
  const status: ChainActivityRow['status'] =
    txResult === null ? 'unknown' : txResult === 'tesSUCCESS' ? 'success' : 'failed';

  const account = typeof tx['Account'] === 'string' ? tx['Account'] : undefined;
  const destination = typeof tx['Destination'] === 'string' ? tx['Destination'] : undefined;
  let direction: ChainActivityRow['direction'];
  let counterparty: string | undefined;
  if (account === self && destination === self) {
    direction = 'self';
    counterparty = self;
  } else if (account === self) {
    direction = 'out';
    counterparty = destination; // Destination 없는 유형(OfferCreate 등)은 undefined.
  } else if (destination === self) {
    direction = 'in';
    counterparty = account;
  }

  // Amount 가 drops 십진 문자열일 때만 bigint. 객체(발행통화 IOU)면 undefined —
  // IOU 금액을 XRP 로 지어내지 않는다. rippled api_version 2 는 Payment 의
  // Amount 를 DeliverMax 로 이름만 바꿔 주므로 같은 규칙으로 읽는다.
  const rawAmount = tx['Amount'] ?? tx['DeliverMax'];
  let amount: bigint | undefined;
  if (typeof rawAmount === 'string' && /^\d+$/.test(rawAmount)) {
    try {
      amount = BigInt(rawAmount);
    } catch {
      amount = undefined;
    }
  }

  return {
    id: hash,
    timestamp,
    blockNumber,
    status,
    direction,
    counterparty,
    amount,
    symbol: amount !== undefined ? 'XRP' : undefined,
    memo: decodeMemo(tx['Memos']),
    raw: entry,
  };
}

/** Memos[0].Memo.MemoData(hex) → UTF-8. 형식이 깨지면 undefined (지어내지 않는다). */
function decodeMemo(memos: unknown): string | undefined {
  if (!Array.isArray(memos) || memos.length === 0) return undefined;
  const first = memos[0] as { Memo?: { MemoData?: unknown } } | null;
  const data = first?.Memo?.MemoData;
  if (typeof data !== 'string' || data.length === 0 || data.length % 2 !== 0) return undefined;
  if (!/^[0-9A-Fa-f]+$/.test(data)) return undefined;
  const bytes = new Uint8Array(data.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(data.slice(i * 2, i * 2 + 2), 16);
  }
  try {
    // fatal:true — UTF-8 이 아니면 예외 → undefined. 깨진 글자를 화면에 올리지 않는다.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return ACTIVITY_SOURCE_DEFAULT_LIMIT;
  const n = Math.floor(limit);
  if (n < 1) return 1;
  if (n > 400) return 400; // rippled account_tx 상한.
  return n;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' || err.name === 'TimeoutError')
  );
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
