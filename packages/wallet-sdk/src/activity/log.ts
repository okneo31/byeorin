// log.ts — 계정의 최근 활동(activity) 조회.
//
// 세 가지 경로를 순서대로 시도한다:
//
//   1) TTL Scan 인덱서 API — `GET {base}/indexer/address/{addr}/txs?limit=N`.
//      전체 이력을 한 번의 요청으로 준다. 실측(2026-07-28): 0.64초.
//
//   2) Etherscan-호환 explorer API (`?module=account&action=txlist&...`).
//      TTL 이 아닌 EVM 체인용. TTL Scan 은 이 규격이 **아니다** — 예전 주석은
//      "etherscan 호환이라고 가정한다" 였는데 실측해보니 아니었다. `/api` 에
//      catch-all 라우트가 없어 404 가 나고, 그래서 항상 3) 로 떨어지고 있었다.
//
//   3) Fallback: 최근 N 블록을 스캔.
//      eth_getBlockByNumber 를 **직렬로** 거꾸로 돌기 때문에 비싸다. 실측으로
//      60 블록에 13.8 초가 걸렸다 (블록당 ~230ms RTT). 앞의 두 경로가 모두
//      없는 체인에서만 쓰는 최후 수단이다.
//
// ERC-20 Transfer 는 어느 경로에서든 eth_getLogs 로 따로 긁는다. tx 단위
// 인덱서는 "받은" 토큰 전송을 못 보여주기 때문이다 — 받는 쪽은 tx 의
// from/to 어디에도 안 나오고 로그에만 있다.
//
// 본 모듈은 의도적으로 viem 의 PublicClient 만 의존하고, fetch 는 호출 측이
// inject 할 수 있게 옵션화했다 — 테스트에서 가짜 fetch 를 끼우기 위함.

import {
  hexToBigInt,
  hexToNumber,
  numberToHex,
  type Hex,
  type PublicClient,
} from 'viem';
import type { EvmAdapter } from '../chains/evm.js';
import type { Address, TxHash } from '../types.js';

// PublicClient.request 는 좁은 RPC 호출용 escape hatch. 우리는 eth_getLogs 를
// 미리 정의된 topic 으로 호출해야 하는데, viem 의 getLogs() public API 는
// `event` 또는 `events` 를 ABI 형태로 요구하므로 raw topic 지정엔 부적합하다.
// 또한 테스트가 monkey-patch 한 client.getLogs 는 bigint 형 blockNumber 를
// 돌려주는 경우가 있으므로 loose 타입으로 정의한다.
interface LooseLog {
  address: string;
  blockNumber?: Hex | bigint | null;
  data: Hex;
  topics: ReadonlyArray<Hex | null>;
  transactionHash?: Hex | string | null;
}

export interface Activity {
  hash: TxHash;
  blockNumber: bigint;
  /** UNIX seconds. explorer API 가 string 으로 주는 값을 number 로 정규화. */
  timestamp: number;
  from: Address;
  to: Address;
  /** native 송금이면 wei, 토큰 송금이면 토큰 base unit. */
  value: bigint;
  /** ERC-20 송금 시 토큰 컨트랙트 주소, native 면 undefined. */
  token?: Address;
  /** 'success' | 'failed' | 'pending'. explorer 가 못 주면 'success' 로 추정. */
  status: 'success' | 'failed' | 'pending';
  /**
   * TTL 인덱서가 tx `data` 를 메모로 판정해 디코드해 준 텍스트.
   *
   * 메모가 아닌 tx(일반 송금·계약 호출)이거나, 인덱서 배포 이전 블록이거나,
   * 인덱서를 안 쓰는 경로(로그 스캔·로컬 기록)면 undefined 다. **없는 것이
   * 정상**이므로 화면은 없을 때를 기본으로 그려야 한다.
   */
  memo?: string;
  /** 메모 판정 전 원본 data 의 바이트 수. 2048 초과로 탈락한 경우를 안내할 때 쓴다. */
  memoByteLength?: number;
}

export interface ActivityLogOptions {
  /** 호출자가 inject 한 fetch (테스트). 미지정 시 globalThis.fetch 사용. */
  fetch?: typeof fetch;
  /**
   * Explorer API base — `?module=...` 가 붙기 전까지의 URL.
   * 예) `https://scan.ttl1.top/api`. 미지정 시 adapter.chain.blockExplorers
   * 에서 기본값을 유추한다.
   */
  explorerApiUrl?: string;
  /** 최근 N 블록만 스캔 (fallback 경로). 기본 200. */
  fallbackLookback?: number;
  /**
   * TTL Scan 계열 인덱서 API base — 예) `https://scan.ttl1.top/api`.
   * 미지정 시 TTL 체인(id 7777)에 한해 explorer URL 에서 유추한다. 다른 체인은
   * 이 규격이 아니므로 자동으로 켜지 않는다.
   */
  indexerApiUrl?: string;
  /**
   * ERC-20 Transfer 로그를 훑을 시작 블록. 기본 0n (전체 이력).
   *
   * TTL 은 전체 구간 eth_getLogs 가 212ms 에 끝나서(실측 2026-07-28, 1,125,084
   * 블록) 전체를 봐도 싸다. 로그가 많은 체인에 이 클래스를 쓸 때는 호출자가
   * 구간을 좁혀야 한다.
   */
  erc20FromBlock?: bigint;
}

/** TTL Scan 인덱서의 tx 한 행. `/api/indexer/address/:addr/txs` 응답 형식. */
interface TtlScanTxRow {
  hash?: string;
  block_number?: number;
  from?: string;
  to?: string | null;
  value?: string;
  status?: number;
  timestamp?: number;
  contract_address?: string | null;
  /** 인덱서가 판정·디코드한 메모. 메모가 아니면 null. */
  memo?: string | null;
  /** 판정 전 원본 data 바이트 수. */
  input_size?: number | null;
}

interface TtlScanTxsResponse {
  transactions?: TtlScanTxRow[];
  total?: number;
}

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
// keccak256 ("Transfer(address,address,uint256)") — 토픽 0.
const TRANSFER_TOPIC: Hex =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// TTL 메인넷. 인덱서 규격을 자동으로 켤 유일한 체인이다.
const TTL_SCAN_CHAIN_ID = 7777;

interface EtherscanTxRow {
  hash?: string;
  blockNumber?: string;
  timeStamp?: string;
  from?: string;
  to?: string;
  value?: string;
  contractAddress?: string;
  isError?: string;
  txreceipt_status?: string;
}

interface EtherscanResponse<T> {
  status?: string;
  message?: string;
  result?: T;
}

/**
 * 빈 16진 주소 (topic 의 32 바이트 패딩에서 사용).
 */
function padAddressToTopic(addr: Address): Hex {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  return ('0x' + '0'.repeat(64 - lower.length) + lower) as Hex;
}

function topicToAddress(topic: Hex): Address {
  // 32 바이트 → 마지막 20 바이트만 잘라서 0x 접두 (lowercase, 체크섬 X).
  return ('0x' + topic.slice(2).slice(-40)) as Address;
}

/**
 * Explorer 응답 한 줄 → Activity 변환.
 * 값이 비어 있거나 형식이 어긋나면 null 을 돌려 caller 에서 silently 스킵한다.
 */
function rowToActivity(row: EtherscanTxRow): Activity | null {
  if (!row.hash || !row.from || !row.to) return null;
  let blockNumber = 0n;
  try {
    blockNumber = BigInt(row.blockNumber ?? '0');
  } catch {
    return null;
  }
  let value = 0n;
  try {
    value = BigInt(row.value ?? '0');
  } catch {
    /* 0 으로 둠 */
  }
  const ts = Number(row.timeStamp ?? '0');
  let status: Activity['status'] = 'success';
  if (row.isError === '1') status = 'failed';
  else if (row.txreceipt_status === '0') status = 'failed';

  const tokenAddr = row.contractAddress && row.contractAddress !== ''
    ? (row.contractAddress as Address)
    : undefined;

  const out: Activity = {
    hash: row.hash,
    blockNumber,
    timestamp: Number.isFinite(ts) ? ts : 0,
    from: row.from,
    to: row.to,
    value,
    status,
  };
  if (tokenAddr) out.token = tokenAddr;
  return out;
}

export class ActivityLog {
  private readonly client: PublicClient;
  private readonly explorerApiUrl: string | null;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly fallbackLookback: number;
  private readonly indexerApiUrl: string | null;
  private readonly erc20FromBlock: bigint;

  constructor(adapter: EvmAdapter, opts: ActivityLogOptions = {}) {
    this.client = (
      adapter as unknown as { readonly client: PublicClient }
    ).client;
    const g = globalThis.fetch
      ? (globalThis.fetch.bind(globalThis) as typeof fetch)
      : undefined;
    this.fetchImpl = opts.fetch ?? g;
    this.fallbackLookback = opts.fallbackLookback ?? 200;

    // 명시 URL 우선. 없으면 adapter.chain.blockExplorers 의 default 에서 유추.
    if (opts.explorerApiUrl) {
      this.explorerApiUrl = opts.explorerApiUrl;
    } else {
      const explorer = adapter.chain.blockExplorers?.default?.url;
      this.explorerApiUrl = explorer ? explorer.replace(/\/+$/, '') + '/api' : null;
    }

    // 인덱서는 TTL Scan 전용 규격이다. 다른 체인의 explorer 에 같은 경로를
    // 찔러봐야 404 만 받고 한 왕복을 버리므로, 체인 id 로 명시 판정한다.
    if (opts.indexerApiUrl) {
      this.indexerApiUrl = opts.indexerApiUrl.replace(/\/+$/, '');
    } else if (adapter.chain.id === TTL_SCAN_CHAIN_ID) {
      this.indexerApiUrl = this.explorerApiUrl;
    } else {
      this.indexerApiUrl = null;
    }
    this.erc20FromBlock = opts.erc20FromBlock ?? 0n;
  }

  /**
   * 최근 활동 조회. 우선 explorer API 를 시도하고 실패(404/네트워크/JSON 오류)
   * 시 RPC fallback 으로 떨어진다.
   *
   * @param address  대상 주소
   * @param limit    반환할 최대 건수 (정렬 후 자르기). 기본 20.
   */
  async list(address: Address, limit = 20): Promise<Activity[]> {
    // ① TTL Scan 인덱서. 전체 이력을 한 요청으로 준다.
    //
    // 인덱서가 **응답에 성공했다면 0건이어도 그게 정답이다.** 여기서 빈 배열을
    // 보고 아래 느린 스캔으로 떨어지면, 거래가 없는 계정이 13초를 기다린 끝에
    // 똑같이 "없음" 을 보게 된다. 그래서 "형식이 아니다/실패했다"(null) 와
    // "물어봤고 없다"([]) 를 구분한다.
    if (this.indexerApiUrl && this.fetchImpl) {
      const rows = await this.fromIndexer(address, limit).catch(() => null);
      if (rows !== null) {
        const tokens = await this.erc20FromLogs(address).catch(() => []);
        return sortDescAndCap([...rows, ...tokens], limit);
      }
    }

    // ② etherscan 호환 explorer (TTL 이 아닌 EVM 체인).
    if (this.explorerApiUrl && this.fetchImpl) {
      try {
        const out = await this.fromExplorer(address, limit);
        if (out.length > 0) return out;
        // 0건이면 fallback 으로 한 번 더 시도 — 신규 체인에서 흔한 케이스.
      } catch {
        // 무시하고 fallback.
      }
    }

    // ③ 최후 수단 — 직렬 블록 스캔. 비싸다.
    try {
      return await this.fromRpcFallback(address, limit);
    } catch {
      return [];
    }
  }

  /**
   * TTL Scan 인덱서 조회.
   *
   * @returns 정상 응답이면 Activity[] (0건도 유효한 답). 이 규격이 아니거나
   *          HTTP 오류면 null — 호출자가 다음 경로로 넘어가라는 신호다.
   */
  private async fromIndexer(
    address: Address,
    limit: number,
  ): Promise<Activity[] | null> {
    if (!this.indexerApiUrl || !this.fetchImpl) return null;
    const url =
      `${this.indexerApiUrl}/indexer/address/${encodeURIComponent(address)}/txs` +
      `?limit=${limit}`;
    const body = await this.fetchJson<TtlScanTxsResponse>(url);
    // etherscan 형식 응답(`{status, result}`)이 여기로 들어오면 transactions 가
    // 없다. 그때는 이 규격이 아니라고 보고 다음 경로로 넘긴다.
    if (!body || !Array.isArray(body.transactions)) return null;

    const out: Activity[] = [];
    for (const r of body.transactions) {
      if (!r || typeof r.hash !== 'string') continue;
      let value = 0n;
      try {
        value = BigInt(r.value ?? '0');
      } catch {
        // 숫자로 못 읽는 값은 0 으로 두되 항목 자체는 버리지 않는다.
      }
      out.push({
        hash: r.hash as Hex,
        blockNumber: BigInt(r.block_number ?? 0),
        timestamp: Number(r.timestamp ?? 0),
        from: ((r.from ?? '0x') as string) as Address,
        // 컨트랙트 생성 tx 는 to 가 null 이고 생성된 주소가 따로 온다.
        to: ((r.to ?? r.contract_address ?? '0x') as string) as Address,
        value,
        status: r.status === 0 ? 'failed' : 'success',
        // 인덱서가 메모로 인정한 것만 온다. null 이면 메모 아닌 tx 다 —
        // 빈 문자열로 바꾸지 않는다(화면이 "메모 있음"으로 오해한다).
        // input_data 는 74자에서 잘리므로 메모 읽기에 절대 쓰지 않는다.
        ...(typeof r.memo === 'string' && r.memo.length > 0 ? { memo: r.memo } : {}),
        ...(typeof r.input_size === 'number' && r.input_size > 0
          ? { memoByteLength: r.input_size }
          : {}),
      });
    }
    return out;
  }

  /**
   * ERC-20 Transfer 로그를 긁는다 (보낸 것 + 받은 것).
   *
   * tx 단위 인덱서로는 **받은** 토큰 전송을 볼 수 없다 — 받는 쪽 주소는 tx 의
   * from/to 어디에도 없고 로그 topic 에만 있기 때문이다. 그래서 어느 경로를
   * 타든 이건 따로 부른다.
   */
  private async erc20FromLogs(address: Address): Promise<Activity[]> {
    const padded = padAddressToTopic(address);
    const fromHex = numberToHex(this.erc20FromBlock);
    const [logsFrom, logsTo] = await Promise.all([
      this.rawGetLogs(fromHex, 'latest' as Hex, [TRANSFER_TOPIC, padded, null]),
      this.rawGetLogs(fromHex, 'latest' as Hex, [TRANSFER_TOPIC, null, padded]),
    ]);
    return logsToActivities([...logsFrom, ...logsTo]);
  }

  private async fromExplorer(address: Address, limit: number): Promise<Activity[]> {
    if (!this.explorerApiUrl || !this.fetchImpl) return [];

    // native txlist + ERC-20 tokentx 를 둘 다 긁어서 합친다.
    const base = this.explorerApiUrl;
    const a = encodeURIComponent(address);
    const nativeUrl =
      `${base}?module=account&action=txlist&address=${a}` +
      `&sort=desc&page=1&offset=${limit}`;
    const tokenUrl =
      `${base}?module=account&action=tokentx&address=${a}` +
      `&sort=desc&page=1&offset=${limit}`;

    const [nat, tok] = await Promise.all([
      this.fetchJson<EtherscanResponse<EtherscanTxRow[]>>(nativeUrl),
      this.fetchJson<EtherscanResponse<EtherscanTxRow[]>>(tokenUrl).catch(
        () => null,
      ),
    ]);

    const acc: Activity[] = [];
    if (Array.isArray(nat?.result)) {
      for (const r of nat.result) {
        const a = rowToActivity(r);
        if (a) acc.push(a);
      }
    }
    if (tok && Array.isArray(tok.result)) {
      for (const r of tok.result) {
        const a = rowToActivity(r);
        if (a) acc.push(a);
      }
    }
    acc.sort((x, y) => {
      if (y.blockNumber !== x.blockNumber) {
        return y.blockNumber > x.blockNumber ? 1 : -1;
      }
      return y.timestamp - x.timestamp;
    });
    return acc.slice(0, limit);
  }

  private async fetchJson<T>(url: string): Promise<T> {
    if (!this.fetchImpl) throw new Error('no fetch impl');
    const res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`explorer http ${res.status}`);
    return (await res.json()) as T;
  }

  private async fromRpcFallback(
    address: Address,
    limit: number,
  ): Promise<Activity[]> {
    const latest = await this.client.getBlockNumber();
    const from = latest > BigInt(this.fallbackLookback)
      ? latest - BigInt(this.fallbackLookback)
      : 0n;

    // ERC-20 Transfer 로그 (from = address, to = address 모두).
    // viem 의 getLogs() public API 는 ABI event 인자를 요구해서 raw topic 지정에
    // 적합하지 않다. 우리는 항상 같은 topic[0] 을 쓰기 때문에 underlying RPC
    // 의 raw topics 필드를 그대로 쓰는 게 옳다 — 테스트 호환성을 위해
    // monkey-patch 된 client.getLogs 를 먼저 시도하고, 실패 시 request 로 폴백.
    const padded = padAddressToTopic(address);
    const fromHex = numberToHex(from);
    const toHex = numberToHex(latest);
    const [logsFrom, logsTo] = await Promise.all([
      this.rawGetLogs(fromHex, toHex, [TRANSFER_TOPIC, padded, null]),
      this.rawGetLogs(fromHex, toHex, [TRANSFER_TOPIC, null, padded]),
    ]);

    const acc: Activity[] = logsToActivities([...logsFrom, ...logsTo]);

    // Native transfer 스캔 — 최근 lookback 블록을 거꾸로 훑는다. 큰 lookback
    // 으로는 절대 호출하지 말 것 (코스트가 O(lookback)). RPC 가 batched 가
    // 아니라면 직렬 호출이 RTT 의 N 배가 되므로 limit 만큼만 채우면 중단.
    const native = await this.scanNativeRecent(address, from, latest, limit);
    acc.push(...native);

    acc.sort((x, y) => (y.blockNumber > x.blockNumber ? 1 : -1));
    return acc.slice(0, limit);
  }

  /**
   * eth_getLogs 를 raw topic 으로 호출한다.
   *
   * **client.request 만 쓴다.** 예전에는 "테스트가 monkey-patch 하기 쉽게"
   * viem 의 client.getLogs 를 먼저 시도하고 실패 시 request 로 떨어졌는데,
   * 실사용에서 그 경로가 재앙이었다 — viem 의 getLogs 는 우리가 넘기는 raw
   * topics 배열을 처리하지 못한 채 **41초를 매달렸다가** 타임아웃했다(실측
   * 2026-07-28). 같은 질의를 request 로 직접 쏘면 617ms 다.
   *
   * 즉 모킹 편의를 위해 둔 우회로가 모든 실사용 호출에 41초를 얹고 있었다.
   * 테스트는 client.request 를 모킹한다 — 실제로 타는 경로와 같아진다.
   */
  private async rawGetLogs(
    fromBlock: Hex,
    toBlock: Hex,
    topics: ReadonlyArray<Hex | null>,
  ): Promise<LooseLog[]> {
    const client = this.client as unknown as {
      request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
    };
    try {
      const out = (await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock, toBlock, topics }],
      })) as LooseLog[];
      return Array.isArray(out) ? out : [];
    } catch {
      return [];
    }
  }

  private async scanNativeRecent(
    address: Address,
    fromBlock: bigint,
    toBlock: bigint,
    limit: number,
  ): Promise<Activity[]> {
    const lower = address.toLowerCase();
    const out: Activity[] = [];
    // 최근부터 거꾸로.
    for (let n = toBlock; n >= fromBlock && out.length < limit; n -= 1n) {
      let block;
      try {
        block = await this.client.getBlock({
          blockNumber: n,
          includeTransactions: true,
        });
      } catch {
        // RPC 가 못 주면 그 블록은 스킵 (다음 블록으로 진행).
        continue;
      }
      const txs = (block.transactions ?? []) as Array<{
        hash?: Hex;
        from?: Hex;
        to?: Hex | null;
        value?: bigint;
      }>;
      for (const tx of txs) {
        const from = tx.from?.toLowerCase();
        const to = tx.to?.toLowerCase();
        if (from !== lower && to !== lower) continue;
        out.push({
          hash: tx.hash ?? ('0x' as Hex),
          blockNumber: block.number ?? n,
          timestamp: Number(block.timestamp ?? 0n),
          from: (tx.from ?? '0x') as Address,
          to: (tx.to ?? '0x') as Address,
          value: tx.value ?? 0n,
          status: 'success',
        });
        if (out.length >= limit) break;
      }
    }
    return out;
  }
}

/** ERC-20 Transfer 로그 배열 → Activity[]. 로그에는 시각이 없어 timestamp=0. */
function logsToActivities(logs: LooseLog[]): Activity[] {
  const out: Activity[] = [];
  for (const log of logs) {
    const fromTopic = log.topics[1];
    const toTopic = log.topics[2];
    if (!fromTopic || !toTopic) continue;
    let value = 0n;
    try {
      value = hexToBigInt(log.data);
    } catch {
      /* 값을 못 읽어도 항목은 남긴다 */
    }
    const blk =
      typeof log.blockNumber === 'bigint'
        ? log.blockNumber
        : log.blockNumber
          ? hexToBigInt(log.blockNumber)
          : 0n;
    out.push({
      hash: ((log.transactionHash as Hex | undefined) ?? '0x') as Hex,
      blockNumber: blk,
      timestamp: 0,
      from: topicToAddress(fromTopic as Hex),
      to: topicToAddress(toTopic as Hex),
      value,
      token: log.address as Address,
      status: 'success',
    });
  }
  return out;
}

/** 블록 내림차순(같으면 시각 내림차순) 정렬 후 limit 만큼 자른다. */
function sortDescAndCap(items: Activity[], limit: number): Activity[] {
  items.sort((x, y) => {
    if (y.blockNumber !== x.blockNumber) {
      return y.blockNumber > x.blockNumber ? 1 : -1;
    }
    return y.timestamp - x.timestamp;
  });
  return items.slice(0, limit);
}

// 테스트가 RPC fallback 로직을 검증할 때 헬퍼로 쓸 수 있도록 노출.
export const _internal = {
  TRANSFER_TOPIC,
  padAddressToTopic,
  topicToAddress,
  rowToActivity,
  numberToHex,
  hexToNumber,
};
