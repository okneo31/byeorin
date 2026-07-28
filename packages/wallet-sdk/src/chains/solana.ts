import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  clusterApiUrl,
  type Cluster,
} from '@solana/web3.js';
import { base58 } from '@scure/base';
import {
  callWithFallback,
  withFetchTimeout,
  withTimeout,
  type RpcAttempt,
  type RpcEndpoint,
} from '../transports/rpc-fallback.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

/**
 * mainnet-beta 기본 읽기 엔드포인트 (순서 = 시도 순서).
 *
 * 공식 `api.mainnet-beta.solana.com` 은 확장(extension) origin 의 익명 요청을
 * 403 으로 거절하므로 기본 목록에서 제외한다 (docs/CONTEXT.md "RPC override").
 *
 * 각 URL 은 2026-07-28 에 `getHealth` 로 실제 응답을 확인했다:
 *   - publicnode : 200 {"result":"ok"} — 무키 익명 호출 정상.
 *   - OnFinality : 429 `-32029` (API 키 없으면 rate-limit). URL 자체는 유효.
 *   - dRPC       : 400 `code 35 chain is not available on free plan`.
 * 즉 2·3순위는 현재 무키 상태에서 사실상 항상 실패한다. 그래도 목록에 두는
 * 이유는 (a) 백로그 #26 이 지정한 순서이고 (b) 키를 넣거나 요금제가 바뀌면
 * 코드 변경 없이 살아나기 때문. 실질 이중화가 필요하면 `rpcUrls` 로 override.
 */
export const SOLANA_MAINNET_RPC_URLS: readonly string[] = [
  'https://solana-rpc.publicnode.com',
  'https://solana.api.onfinality.io/public',
  'https://solana.drpc.org',
];

/**
 * 읽기 1회 시도 타임아웃.
 *
 * 6초 근거: 확장 popup 은 사용자가 창을 닫으면 그대로 죽는 휘발성 컨텍스트라
 * "무한 대기"가 실제 장애로 관측됐다 (docs/CONTEXT.md, mainnet-beta hang).
 * 정상 공개 RPC 의 getBalance 왕복은 국내에서 대략 0.2~1초 수준이므로 6초면
 * 느린 회선까지 흡수하고, 3곳 전부 실패해도 최악 18초 안에 에러가 확정된다.
 * popup 이 사실상 방치되는 30초대보다 확실히 짧아야 한다.
 */
const DEFAULT_READ_TIMEOUT_MS = 6_000;

/**
 * 쓰기(브로드캐스트) 타임아웃.
 *
 * 읽기보다 길게 잡는 이유: 재시도할 수 없는 호출이기 때문. 여기서 성급하게
 * 끊으면 "실패로 보이지만 실제로는 전파된" tx 가 생겨 사용자가 이중 송금을
 * 시도할 수 있다. 20초는 끊기 위한 값이 아니라 영구 hang 방지용 상한이다.
 */
const DEFAULT_WRITE_TIMEOUT_MS = 20_000;

export interface SolanaAdapterOptions {
  network?: SolanaNetwork;
  /**
   * 단일 엔드포인트. **하위 호환 유지** — 지정하면 읽기/쓰기 모두 이 URL 하나만
   * 쓴다 (fallback 없음). 기존 셸 4종이 이 옵션으로 publicnode 를 고정하고
   * 있으므로 여기에 몰래 fallback 을 끼워 넣지 않는다.
   * `rpcUrls` 와 함께 주면 `rpcUrls` 가 이긴다.
   */
  rpcUrl?: string;
  /**
   * 읽기 fallback 목록 (순서대로 시도). **0번 항목이 쓰기 엔드포인트**가 된다.
   * 미지정 시 mainnet-beta 는 `SOLANA_MAINNET_RPC_URLS`, 그 외 네트워크는
   * `clusterApiUrl(network)` 단일.
   */
  rpcUrls?: readonly string[];
  /** 읽기 1회 시도 타임아웃(ms). 기본 6000. */
  readTimeoutMs?: number;
  /** 쓰기 타임아웃(ms). 기본 20000. */
  writeTimeoutMs?: number;
  /** fetch 주입 — 테스트에서 가짜 RPC 응답을 넣는 용도. */
  fetch?: typeof fetch;
  /** 읽기 fallback 중 엔드포인트가 실패할 때 호출 (로깅/진단용). */
  onRpcAttemptFailed?: (attempt: RpcAttempt) => void;
}

export interface SolanaUnsignedTx {
  tx: Transaction;
}

export interface SolanaSignedTx {
  raw: Uint8Array;
  signature: string;
}

/**
 * SolanaAdapter — Phantom-compatible HD wallet adapter.
 *
 * Derivation path: m/44'/501'/${index}'/0'  (all hardened — Solana requires it)
 *   The `index` argument (not `account`) drives the sub-key index, matching
 *   Phantom's UX where each derived account differs by index.
 *
 * Lamports caveat: Solana's SystemProgram.transfer takes a JS `number` for
 * lamports. JS `number` is safe up to 2^53-1 ≈ 9.007e15 lamports
 * (≈ 9.007e6 SOL), well beyond any reasonable transfer. We coerce
 * `intent.amount` (bigint) → Number and throw if it would lose precision.
 *
 * RPC 구성 (백로그 #26):
 *   - 읽기(getBalance): `rpcUrls` 를 순서대로 시도, 실패 시 다음 엔드포인트.
 *   - 쓰기(broadcast) 와 쓰기에 딸린 `getLatestBlockhash`: **0번 엔드포인트 고정.**
 *     blockhash 를 A 에서 받아 B 로 보내면 노드 간 슬롯 차이로 BlockhashNotFound
 *     가 나거나 중복 제출 위험이 있다. 따라서 송금 경로는 fallback 하지 않는다.
 */
export class SolanaAdapter
  implements ChainAdapter<SolanaUnsignedTx, SolanaSignedTx>
{
  readonly id: string;
  readonly displayName: string;
  readonly curve = 'ed25519' as const;
  readonly coinType = 501;
  readonly network: SolanaNetwork;

  /** 읽기 후보 (순서 = 시도 순서). */
  readonly rpcUrls: readonly string[];
  /** 쓰기 전용 단일 엔드포인트 = rpcUrls[0]. */
  readonly writeRpcUrl: string;

  private readonly readEndpoints: readonly RpcEndpoint<Connection>[];
  /**
   * 송금 전용 연결. 읽기 fallback 목록과 물리적으로 분리된 필드로 둔다 —
   * 배열 인덱싱으로 접근하면 나중에 누군가 "쓰기도 fallback 시키자"고
   * 실수하기 쉬우므로, 타입 수준에서 단일임을 못 박는다.
   */
  private readonly writeConnection: Connection;
  private readonly readTimeoutMs: number;
  private readonly writeTimeoutMs: number;
  private readonly onRpcAttemptFailed:
    | ((attempt: RpcAttempt) => void)
    | undefined;

  constructor(opts: SolanaAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet-beta';
    this.id = `solana:${this.network}`;
    this.displayName =
      this.network === 'mainnet-beta'
        ? 'Solana'
        : `Solana ${this.network}`;
    this.readTimeoutMs = opts.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS;
    this.writeTimeoutMs = opts.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS;
    this.onRpcAttemptFailed = opts.onRpcAttemptFailed;

    this.rpcUrls = resolveRpcUrls(opts, this.network);
    const primary = this.rpcUrls[0];
    if (!primary) {
      throw new Error('solana: rpcUrls 가 비어 있습니다.');
    }
    this.writeRpcUrl = primary;

    const baseFetch =
      opts.fetch ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);
    const makeConnection = (url: string, timeoutMs: number): Connection =>
      new Connection(url, {
        commitment: 'confirmed',
        // web3.js 는 429 를 받으면 기본적으로 sleep 후 자체 재시도한다.
        // 그러면 우리 fallback 이 도는 대신 popup 이 그냥 멈춘다.
        // 재시도는 우리가 "다음 엔드포인트"로 대신한다.
        disableRetryOnRateLimit: true,
        ...(baseFetch ? { fetch: withFetchTimeout(baseFetch, timeoutMs) } : {}),
      });

    this.readEndpoints = this.rpcUrls.map((url) => ({
      url,
      client: makeConnection(url, this.readTimeoutMs),
    }));
    this.writeConnection = makeConnection(primary, this.writeTimeoutMs);
  }

  // Phantom-compatible path. `index` drives sub-key, `account` reserved.
  derivationPath(account = 0, index = 0): string {
    // Use `index` (not `account`) so callers iterating on indices get
    // distinct Phantom-style addresses. `account` is intentionally unused
    // here to stay aligned with Phantom's default derivation scheme.
    void account;
    return `m/44'/501'/${index}'/0'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(`solana: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    return base58.encode(pubkey);
  }

  /** 읽기 — fallback 대상. */
  async getBalance(address: Address): Promise<bigint> {
    const pubkey = new PublicKey(address);
    const lamports = await callWithFallback(
      this.readEndpoints,
      (conn) => conn.getBalance(pubkey),
      {
        timeoutMs: this.readTimeoutMs,
        label: 'solana getBalance',
        ...(this.onRpcAttemptFailed
          ? { onAttemptFailed: this.onRpcAttemptFailed }
          : {}),
      },
    );
    return BigInt(lamports);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<SolanaUnsignedTx> {
    const lamports = bigintToSafeNumber(intent.amount, 'solana lamports');
    const fromPubkey = new PublicKey(ctx.sender);
    const toPubkey = new PublicKey(intent.to);

    const tx = new Transaction().add(
      SystemProgram.transfer({ fromPubkey, toPubkey, lamports }),
    );
    tx.feePayer = fromPubkey;
    // 읽기 호출이지만 **의도적으로 fallback 하지 않는다.**
    // 이 blockhash 는 곧 broadcast 될 tx 에 박히고, broadcast 는 writeConnection
    // 한 곳으로만 나간다. 다른 엔드포인트에서 받은 blockhash 를 쓰면 노드 간
    // 슬롯 지연 때문에 BlockhashNotFound 로 거절될 수 있으므로, 조회와 전송의
    // 엔드포인트를 반드시 일치시킨다. (백로그 #26: "송금은 단일")
    const { blockhash } = await withTimeout(
      this.writeConnection.getLatestBlockhash('confirmed'),
      this.writeTimeoutMs,
      this.writeRpcUrl,
    );
    tx.recentBlockhash = blockhash;
    return { tx };
  }

  async signRequests(tx: SolanaUnsignedTx): Promise<SignRequest[]> {
    // The Ed25519 signature target is the compiled message bytes,
    // not the full serialized transaction. Ed25519 hashes internally
    // (prehashed=false), so we hand over the raw message.
    return [
      { message: new Uint8Array(tx.tx.serializeMessage()), prehashed: false },
    ];
  }

  async applySignatures(
    tx: SolanaUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<SolanaSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`solana: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 64) {
      throw new Error(
        `solana: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    const feePayer = tx.tx.feePayer;
    if (!feePayer) {
      throw new Error('solana: cannot apply signature without feePayer');
    }
    tx.tx.addSignature(feePayer, Buffer.from(signature));
    const raw = new Uint8Array(tx.tx.serialize());
    return { raw, signature: base58.encode(signature) };
  }

  /**
   * 쓰기 — **fallback 없음. 단일 엔드포인트(`writeRpcUrl`) 고정.**
   *
   * 이유 1) blockhash 일관성: `buildTransfer` 가 이 엔드포인트에서 받은
   *   `recentBlockhash` 로 서명된 tx 다. 다른 노드는 그 blockhash 를 아직
   *   모르거나(슬롯 지연) 이미 만료시켰을 수 있어 거절된다.
   * 이유 2) 중복 제출 위험: 첫 엔드포인트가 tx 를 받고 응답만 늦게 준 상황에서
   *   두 번째로 재전송하면, 같은 서명이 두 번 전파된다. Solana 는 동일 서명을
   *   중복 처리하지 않지만, 사용자에게는 실패로 보이는데 실제로는 성공한
   *   상태가 만들어져 이중 송금을 유도한다.
   * → 실패하면 그대로 던진다. 재시도 여부는 사용자가 결정한다.
   */
  async broadcast(tx: SolanaSignedTx): Promise<TxHash> {
    return withTimeout(
      this.writeConnection.sendRawTransaction(tx.raw, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      }),
      this.writeTimeoutMs,
      this.writeRpcUrl,
    );
  }
}

/**
 * 옵션 → 읽기 엔드포인트 목록.
 *
 * 우선순위: `rpcUrls` > `rpcUrl`(단일, 하위 호환) > 네트워크 기본값.
 * `rpcUrl` 만 준 기존 호출자는 정확히 예전과 같은 단일 엔드포인트 동작을 유지한다.
 */
function resolveRpcUrls(
  opts: SolanaAdapterOptions,
  network: SolanaNetwork,
): readonly string[] {
  if (opts.rpcUrls && opts.rpcUrls.length > 0) return [...opts.rpcUrls];
  if (opts.rpcUrl) return [opts.rpcUrl];
  if (network === 'mainnet-beta') return [...SOLANA_MAINNET_RPC_URLS];
  return [clusterApiUrl(network as Cluster)];
}

function bigintToSafeNumber(value: bigint, label: string): number {
  if (value < 0n) throw new Error(`${label}: must be >= 0`);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(
      `${label}: ${value.toString()} exceeds Number.MAX_SAFE_INTEGER`,
    );
  }
  return Number(value);
}
