// log.ts — 계정의 최근 활동(activity) 조회.
//
// 두 가지 경로를 지원:
//
//   1) Etherscan-호환 explorer API (TTL: https://scan.ttl1.top/api).
//      ?module=account&action=txlist&address=... 형식. TTL Scan 이 실제로
//      etherscan-compatible 인지는 인터넷 검증이 필요한데, 본 SDK 차원에선
//      "그렇다고 가정 → 실패하면 fallback" 정책으로 간다.
//
//   2) Fallback: 최근 N 블록을 스캔.
//      eth_getBlockByNumber 를 거꾸로 돌며 from/to 가 일치하는 native tx 를
//      추출 + eth_getLogs 로 ERC-20 Transfer 이벤트 토픽을 긁어 합친다.
//      RPC 한도가 빠듯한 환경에선 N=200 정도가 적당. 호출자가 lookback 으로
//      조절한다.
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
}

// ERC-20 Transfer(address indexed from, address indexed to, uint256 value)
// keccak256 ("Transfer(address,address,uint256)") — 토픽 0.
const TRANSFER_TOPIC: Hex =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

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
  }

  /**
   * 최근 활동 조회. 우선 explorer API 를 시도하고 실패(404/네트워크/JSON 오류)
   * 시 RPC fallback 으로 떨어진다.
   *
   * @param address  대상 주소
   * @param limit    반환할 최대 건수 (정렬 후 자르기). 기본 20.
   */
  async list(address: Address, limit = 20): Promise<Activity[]> {
    if (this.explorerApiUrl && this.fetchImpl) {
      try {
        const out = await this.fromExplorer(address, limit);
        if (out.length > 0) return out;
        // 0건이면 fallback 으로 한 번 더 시도 — 신규 체인에서 흔한 케이스.
      } catch {
        // 무시하고 fallback.
      }
    }
    try {
      return await this.fromRpcFallback(address, limit);
    } catch {
      return [];
    }
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

    const acc: Activity[] = [];
    for (const log of [...logsFrom, ...logsTo]) {
      const topics = log.topics;
      const fromTopic = topics[1];
      const toTopic = topics[2];
      if (!fromTopic || !toTopic) continue;
      let value = 0n;
      try {
        value = hexToBigInt(log.data);
      } catch {
        /* skip */
      }
      const blk =
        typeof log.blockNumber === 'bigint'
          ? log.blockNumber
          : log.blockNumber
            ? hexToBigInt(log.blockNumber)
            : 0n;
      acc.push({
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

    // Native transfer 스캔 — 최근 lookback 블록을 거꾸로 훑는다. 큰 lookback
    // 으로는 절대 호출하지 말 것 (코스트가 O(lookback)). RPC 가 batched 가
    // 아니라면 직렬 호출이 RTT 의 N 배가 되므로 limit 만큼만 채우면 중단.
    const native = await this.scanNativeRecent(address, from, latest, limit);
    acc.push(...native);

    acc.sort((x, y) => (y.blockNumber > x.blockNumber ? 1 : -1));
    return acc.slice(0, limit);
  }

  /**
   * eth_getLogs 를 raw topic 으로 호출한다. viem 의 public getLogs() 는 ABI
   * event 객체를 요구하므로 본 메서드는 두 경로로 시도:
   *   1) 어댑터 client 가 모킹된 getLogs 를 들고 있으면 거기로 위임.
   *   2) 그렇지 않으면 client.request 로 eth_getLogs 직접 호출.
   *
   * 테스트가 client.getLogs 를 monkey-patch 한 경우 (1) 로 자연스럽게 떨어진다.
   */
  private async rawGetLogs(
    fromBlock: Hex,
    toBlock: Hex,
    topics: ReadonlyArray<Hex | null>,
  ): Promise<LooseLog[]> {
    const client = this.client as unknown as {
      getLogs?: (args: unknown) => Promise<unknown>;
      request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
    };
    if (typeof client.getLogs === 'function') {
      try {
        const out = (await client.getLogs({
          fromBlock,
          toBlock,
          topics,
        })) as LooseLog[];
        return out;
      } catch {
        // viem 의 정식 getLogs 는 topics arg 를 거절할 수 있다 — request 로 폴백.
      }
    }
    try {
      const out = (await client.request({
        method: 'eth_getLogs',
        params: [{ fromBlock, toBlock, topics }],
      })) as LooseLog[];
      return out;
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

// 테스트가 RPC fallback 로직을 검증할 때 헬퍼로 쓸 수 있도록 노출.
export const _internal = {
  TRANSFER_TOPIC,
  padAddressToTopic,
  topicToAddress,
  rowToActivity,
  numberToHex,
  hexToNumber,
};
