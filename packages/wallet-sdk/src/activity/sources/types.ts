// types.ts — 활동 소스 5종(solana/xrp/aptos/sui/cosmos) 공통 계약.
// btc-history-source.ts 의 BtcHistoryResult 패턴을 따른다: throw 금지, 실패는 값.

export type ActivitySourceChain = 'solana' | 'xrp' | 'aptos' | 'sui' | 'cosmos';

export type ActivitySourceFailure =
  | 'unsupported' // 주소 형식 불일치 등 이 입력으로는 불가
  | 'network'     // fetch 거부·HTTP 4xx/5xx
  | 'timeout'     // timeoutMs 초과 (AbortController)
  | 'server'      // RPC 가 error 객체로 응답
  | 'protocol';   // 응답 형태 불일치

/** 이 소스가 구조적으로 못 주는 필드 — 지어내지 않고 화면에 고지한다. */
export type OmittedField = 'timestamp' | 'direction' | 'counterparty' | 'amount' | 'memo';

export interface ChainActivityRow {
  /** tx 식별자: solana signature · xrp hash · aptos hash · sui digest · cosmos txhash. */
  id: string;
  /** UNIX seconds. 소스가 못 주면 undefined — 0 으로 지어내지 않는다. */
  timestamp?: number;
  /** slot(솔라나)·ledger_index(XRP)·version(Aptos)·checkpoint(Sui)·height(Cosmos). */
  blockNumber?: bigint;
  status: 'success' | 'failed' | 'unknown';
  direction?: 'in' | 'out' | 'self';
  counterparty?: string;
  /** 네이티브 금액 base unit(lamports/drops/octas/MIST/utrg). 판별 불가면 undefined. */
  amount?: bigint;
  /** amount 의 단위 심볼. amount 가 undefined 면 이 필드도 undefined. */
  symbol?: string;
  memo?: string;
  /** 서버 원문 — 상위 재해석용. 화면에 직접 올리지 않는다. */
  raw: unknown;
}

export interface ActivityQuery {
  address: string;
  /** 최신순 앞 N 건. 기본 20 (i18n 'activity.count_with_max' 와 맞물림). */
  limit?: number;
  /** 조회 전체 예산(ms). 기본 10_000. 왕복이 여러 번이어도 합산 예산 하나다. */
  timeoutMs?: number;
  /** 테스트 주입용. 기본 globalThis.fetch. */
  fetch?: typeof fetch;
  /** 엔드포인트 override. 기본은 각 소스 파일 상단 상수. */
  endpoint?: string;
}

export interface ActivitySourceOk {
  ok: true;
  chain: ActivitySourceChain;
  rows: ChainActivityRow[]; // 최신이 앞. 정렬 tie-break 는 id 사전순(재조회 안정성).
  /** 모든 행에서 구조적으로 비는 필드. 행별로 우연히 비는 것은 넣지 않는다. */
  omitted: readonly OmittedField[];
  truncated: boolean;
}
export interface ActivitySourceErr {
  ok: false;
  chain: ActivitySourceChain;
  failure: ActivitySourceFailure;
  message: string;
}
export type ActivitySourceResult = ActivitySourceOk | ActivitySourceErr;

export const ACTIVITY_SOURCE_DEFAULT_LIMIT = 20;
export const ACTIVITY_SOURCE_DEFAULT_TIMEOUT_MS = 10_000;
