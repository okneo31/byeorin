import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
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
import type {
  PortableTokenBalance,
  TokenCapableAdapter,
} from '../tokens/portable.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type SolanaNetwork = 'mainnet-beta' | 'devnet' | 'testnet';

/**
 * SPL Token Program (원조).
 *
 * 하드코딩하는 이유: 이 값들은 Solana 생태계의 고정 상수이고, 이것만 쓰려고
 * `@solana/spl-token` 의존성을 추가하면 의존성 무게 대비 얻는 게 없다.
 * 명령 인코딩도 아래에서 직접 한다 — 바이트 포맷이 프로그램 ABI 로 고정돼 있다.
 */
const TOKEN_PROGRAM_ID = new PublicKey(
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
);

/**
 * Token-2022 (Token Extensions).
 *
 * **별도 프로그램**이다. 원조 Token Program 만 조회하면 Token-2022 로 발행된
 * 토큰은 지갑에 아예 존재하지 않는 것처럼 보인다 — 그래서 조회도 송금도
 * 두 프로그램을 모두 다룬다.
 */
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
);

/** Associated Token Account 프로그램 — ATA 주소 유도와 생성 명령의 소유자. */
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);

/** 조회 대상 토큰 프로그램. 순서 = RPC 호출 순서(결과는 mint 기준으로 합친다). */
const SPL_TOKEN_PROGRAM_IDS: readonly PublicKey[] = [
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
];

/** SPL Token 명령 discriminator — `TransferChecked`. */
const IX_TRANSFER_CHECKED = 12;

/**
 * ATA 프로그램 명령 discriminator — `CreateIdempotent`.
 *
 * 그냥 `Create`(0) 대신 idempotent 를 쓰는 이유: "없더라" 를 확인한 시점과
 * tx 가 체인에 들어가는 시점 사이에 누군가 같은 ATA 를 먼저 만들면 `Create` 는
 * 실패하고 송금 전체가 날아간다. idempotent 는 이미 있으면 조용히 통과한다.
 */
const IX_CREATE_ATA_IDEMPOTENT = 1;

/**
 * Mint 계정 레이아웃에서 `decimals` 의 바이트 오프셋.
 *
 * mintAuthorityOption(4) + mintAuthority(32) + supply(8) = 44.
 * Token-2022 도 base 82바이트 레이아웃은 동일하고 확장은 그 뒤에 붙으므로
 * 이 오프셋은 두 프로그램에서 같다. RPC 가 jsonParsed 를 못 줄 때만 쓰는
 * 비상 경로다.
 */
const MINT_DECIMALS_OFFSET = 44;

/** portable.ts 의 검증 상한과 맞춘다 — 넘으면 항목을 버린다. */
const MAX_TOKEN_DECIMALS = 36;

/**
 * symbol/name 을 mint 주소에서 파생했다는 표식.
 *
 * SPL 토큰 계정에도 mint 계정에도 사람이 읽을 이름은 없다(Metaplex 메타데이터나
 * Token-2022 메타데이터 확장은 별도 계정/확장이라 여기서 읽지 않는다).
 * 그래서 **이름을 지어내지 않고** mint 주소를 축약해 쓰고, 그게 진짜 심볼이
 * 아니라는 사실을 이 필드로 화면에 넘긴다.
 */
const MINT_DERIVED_LABEL_SOURCE = 'mint-address';

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
  // 1순위. 브라우저 origin 을 받아주고 getBalance 가 잘 된다.
  // **단, getTokenAccountsByOwner 는 403 "blocked parameter" 로 막는다**
  // (실측 2026-07-29). 그래서 토큰 조회는 반드시 다음 순위로 넘어간다.
  'https://solana-rpc.publicnode.com',
  // 토큰 조회가 실제로 되는 유일한 무료 엔드포인트(실측: 2,787 건 반환).
  // 다만 **Origin 헤더가 붙으면 403** 이라 브라우저에서 직접 부르면 막힌다.
  // 안드로이드는 native-http(CapacitorHttp)가 Origin 을 안 붙여 통과하고,
  // Node/데스크톱도 통과한다. 확장 popup 은 이 경로가 막힐 수 있다 —
  // 그 경우 아래 두 곳도 무키로는 실패하므로 토큰 목록이 비게 된다.
  'https://api.mainnet-beta.solana.com',
  // 아래 둘은 무키 상태에서 각각 429/400 이다. 키를 넣으면 살아난다.
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
 *
 * SPL 토큰:
 *   - 조회(`discoverTokens`) 는 순수 읽기 → fallback 을 탄다.
 *   - 송금(`buildTransfer` 의 `intent.asset` 분기) 은 mint/ATA 조회까지 전부
 *     `writeConnection` 한 곳으로만 나간다. 계정 존재 여부를 A 에서 보고
 *     blockhash 를 A 에서 받아 A 로 보내야 판단과 실행의 노드가 일치한다.
 */
export class SolanaAdapter
  implements ChainAdapter<SolanaUnsignedTx, SolanaSignedTx>, TokenCapableAdapter
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

  /**
   * 이 주소가 보유한 SPL 토큰 전부. **읽기 — fallback 대상.**
   *
   * Solana 는 보유 토큰이 계정(ATA)으로 체인에 등록돼 있으므로 EVM 처럼
   * "알려진 컨트랙트를 하나씩 물어보는" 전체 스캔이 필요 없다. 프로그램당
   * `getParsedTokenAccountsByOwner` 한 번, 총 2회 왕복이면 목록이 확정된다.
   *
   * 반환 정책:
   *   - 같은 mint 의 계정이 여러 개면(ATA + 보조 계정) 잔액을 합친다. 화면이
   *     한 토큰을 두 줄로 보게 두지 않는다.
   *   - **잔액 0 도 포함한다.** ATA 가 존재한다는 것 자체가 "이 토큰을 받을
   *     준비가 된 계정"이라는 체인의 사실이고, 숨길지는 화면이 정할 일이다.
   *   - 두 프로그램 중 하나만 실패하면 성공한 쪽만 돌려준다(부분 실패 허용).
   *   - 전부 실패하면 던지지 않고 빈 배열. 토큰 목록 때문에 지갑이 안 열리면 안 된다.
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    let ownerKey: PublicKey;
    try {
      ownerKey = new PublicKey(owner);
    } catch {
      // 주소가 base58 로 파싱되지 않으면 조회할 것이 없다. 던지지 않는다.
      return [];
    }

    const settled = await Promise.allSettled(
      SPL_TOKEN_PROGRAM_IDS.map((programId) =>
        callWithFallback(
          this.readEndpoints,
          (conn) =>
            conn.getParsedTokenAccountsByOwner(ownerKey, { programId }),
          {
            timeoutMs: this.readTimeoutMs,
            label: `solana getParsedTokenAccountsByOwner(${programId.toBase58()})`,
            ...(this.onRpcAttemptFailed
              ? { onAttemptFailed: this.onRpcAttemptFailed }
              : {}),
          },
        ),
      ),
    );

    /** mint → 합산 결과. */
    const byMint = new Map<string, { decimals: number; balance: bigint }>();
    /**
     * 같은 mint 인데 계정마다 decimals 가 다르게 오면 어느 쪽이 참인지 알 수 없다.
     * 자릿수가 틀리면 잔액이 통째로 거짓이 되므로 **추측하지 않고 그 mint 를 버린다.**
     */
    const contradicted = new Set<string>();

    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const { account } of result.value.value) {
        const parsed = parseSplTokenAccount(account.data.parsed);
        // decimals/amount/mint 중 하나라도 못 믿으면 그 계정은 버린다.
        if (!parsed) continue;
        if (contradicted.has(parsed.mint)) continue;

        const prev = byMint.get(parsed.mint);
        if (!prev) {
          byMint.set(parsed.mint, {
            decimals: parsed.decimals,
            balance: parsed.amount,
          });
          continue;
        }
        if (prev.decimals !== parsed.decimals) {
          byMint.delete(parsed.mint);
          contradicted.add(parsed.mint);
          continue;
        }
        prev.balance += parsed.amount;
      }
    }

    // mint 기준 정렬 — RPC 가 주는 순서에 의존하지 않는 결정적 출력.
    return [...byMint.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([mint, v]) => ({
        id: mint,
        // 온체인에 이름이 없다. 지어내는 대신 mint 주소를 축약해서 쓴다.
        symbol: abbreviateMint(mint),
        name: mint,
        decimals: v.decimals,
        balance: v.balance,
        source: MINT_DERIVED_LABEL_SOURCE,
      }));
  }

  /**
   * `intent.asset` 이 있으면 SPL 토큰 송금, 없으면 기존 native SOL 송금.
   *
   * 새 메서드를 만들지 않고 여기서 분기하는 이유: 조회가 돌려준 `id`(mint)를
   * 그대로 `asset` 에 넣으면 송금이 되게 하기 위해서다 — 화면이 조회 결과와
   * 송금 인자를 잇는 변환표를 들고 있지 않아도 된다.
   */
  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<SolanaUnsignedTx> {
    const fromPubkey = new PublicKey(ctx.sender);
    const toPubkey = new PublicKey(intent.to);

    const instructions = intent.asset
      ? await this.buildSplTransferInstructions(
          intent.asset,
          fromPubkey,
          toPubkey,
          intent.amount,
        )
      : [
          SystemProgram.transfer({
            fromPubkey,
            toPubkey,
            lamports: bigintToSafeNumber(intent.amount, 'solana lamports'),
          }),
        ];

    const tx = new Transaction().add(...instructions);
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

  /**
   * SPL 토큰 송금 명령 조립. **전부 `writeConnection` — 읽기 fallback 을 타지 않는다.**
   *
   * 왜 여기서도 fallback 을 금지하나: 이 메서드가 하는 조회(mint 의 프로그램/자릿수,
   * 양쪽 ATA 존재 여부)는 곧바로 tx 의 내용이 된다. A 노드가 "받는 쪽 ATA 있음"
   * 이라고 답해서 생성 명령을 뺐는데 실제 전송은 다른 노드로 나가는 식의 어긋남을
   * 원천 차단한다. 판단과 실행은 같은 노드에서.
   *
   * RPC 왕복 3회: (1) mint 계정, (2) 양쪽 ATA 한 번에, (3) blockhash(호출자 쪽).
   * mint 를 먼저 읽어야 토큰 프로그램을 알고, 그래야 ATA 주소를 유도할 수 있어서
   * (1)과 (2)는 합칠 수 없다.
   */
  private async buildSplTransferInstructions(
    asset: string,
    fromPubkey: PublicKey,
    toPubkey: PublicKey,
    amount: bigint,
  ): Promise<TransactionInstruction[]> {
    if (amount <= 0n) {
      throw new Error('solana spl: 송금 수량은 0보다 커야 합니다.');
    }
    if (amount > MAX_U64) {
      throw new Error(
        `solana spl: 수량 ${amount.toString()} 이 u64 범위를 넘습니다.`,
      );
    }

    let mintPubkey: PublicKey;
    try {
      mintPubkey = new PublicKey(asset);
    } catch {
      throw new Error(`solana spl: asset 이 유효한 mint 주소가 아닙니다: ${asset}`);
    }

    // (1) mint 계정 — 소유 프로그램(Token vs Token-2022)과 decimals 를 여기서 얻는다.
    //     decimals 는 조회 시점 값을 재사용하지 않고 **송금 시점에 다시 읽는다.**
    //     그 값을 transferChecked 에 실으면 체인이 한 번 더 대조해준다.
    const mintAccount = await withTimeout(
      this.writeConnection.getParsedAccountInfo(mintPubkey),
      this.writeTimeoutMs,
      this.writeRpcUrl,
    );
    const mintInfo = mintAccount.value;
    if (!mintInfo) {
      throw new Error(
        `solana spl: mint 계정이 체인에 없습니다: ${mintPubkey.toBase58()}`,
      );
    }

    const tokenProgramId = mintInfo.owner;
    if (
      !tokenProgramId.equals(TOKEN_PROGRAM_ID) &&
      !tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
    ) {
      throw new Error(
        `solana spl: ${mintPubkey.toBase58()} 는 SPL mint 가 아닙니다 (owner=${tokenProgramId.toBase58()}).`,
      );
    }

    const decimals = readMintDecimals(mintInfo.data);
    if (decimals === null) {
      // 자릿수를 모르면 수량의 의미가 정해지지 않는다. 기본값을 넣지 않고 죽는다.
      throw new Error(
        `solana spl: mint ${mintPubkey.toBase58()} 의 decimals 를 읽지 못했습니다.`,
      );
    }

    const fromAta = deriveAssociatedTokenAddress(
      fromPubkey,
      mintPubkey,
      tokenProgramId,
    );
    const toAta = deriveAssociatedTokenAddress(
      toPubkey,
      mintPubkey,
      tokenProgramId,
    );

    // (2) 양쪽 ATA 를 한 번에. 두 번 나눠 물어볼 이유가 없다.
    const [fromAtaInfo, toAtaInfo] = await withTimeout(
      this.writeConnection.getMultipleAccountsInfo([fromAta, toAta]),
      this.writeTimeoutMs,
      this.writeRpcUrl,
    );

    if (!fromAtaInfo) {
      // 보내는 쪽 ATA 가 없다 = 이 토큰을 받은 적이 없다 = 잔액 0.
      // 생성해봐야 빈 계정이므로 조용히 진행하지 않고 이유를 밝히고 죽는다.
      throw new Error(
        `solana spl: 보내는 계정에 ${mintPubkey.toBase58()} 토큰 계정이 없습니다 (잔액 0).`,
      );
    }

    const instructions: TransactionInstruction[] = [];

    if (!toAtaInfo) {
      // SPL 송금이 실패하는 가장 흔한 원인. 받는 쪽 ATA 가 없으면 transfer 는
      // 그냥 실패하므로 **같은 tx 안에서 먼저 만들어준다.** 수수료/렌트는 보내는
      // 쪽(payer)이 낸다 — 받는 사람이 서명할 수 없으니 다른 방법이 없다.
      instructions.push(
        createAssociatedTokenAccountIdempotentInstruction({
          payer: fromPubkey,
          ata: toAta,
          owner: toPubkey,
          mint: mintPubkey,
          tokenProgramId,
        }),
      );
    } else if (!toAtaInfo.owner.equals(tokenProgramId)) {
      // ATA 주소는 프로그램 id 를 시드에 포함하므로 정상 상황에서는 있을 수 없다.
      // 그래도 남의 계정으로 토큰을 밀어 넣는 것보다 멈추는 편이 낫다.
      throw new Error(
        `solana spl: 받는 쪽 계정 ${toAta.toBase58()} 이 토큰 계정이 아닙니다.`,
      );
    }

    instructions.push(
      createTransferCheckedInstruction({
        source: fromAta,
        mint: mintPubkey,
        destination: toAta,
        owner: fromPubkey,
        amount,
        decimals,
        tokenProgramId,
      }),
    );

    return instructions;
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

// ---------------------------------------------------------------------------
// SPL 토큰 보조 함수
// ---------------------------------------------------------------------------

/** u64 상한. SPL 수량은 u64 이므로 넘으면 인코딩 자체가 불가능하다. */
const MAX_U64 = (1n << 64n) - 1n;

/** 파싱된 SPL 토큰 계정에서 우리가 믿고 쓸 수 있는 부분만. */
interface ParsedSplTokenAccount {
  mint: string;
  amount: bigint;
  decimals: number;
}

/**
 * `getParsedTokenAccountsByOwner` 의 `account.data.parsed` 를 좁힌다.
 *
 * RPC 응답은 타입이 `any` 로 오지만 여기서는 `unknown` 으로 받아 한 겹씩 확인한다.
 * 하나라도 기대와 다르면 **보정하지 않고 `null`** — 잘못된 자릿수로 잔액을
 * 만들어내느니 그 토큰을 안 보여주는 편이 낫다.
 */
function parseSplTokenAccount(parsed: unknown): ParsedSplTokenAccount | null {
  const info = asRecord(asRecord(parsed)?.['info']);
  if (!info) return null;

  const mint = info['mint'];
  if (typeof mint !== 'string' || mint.length === 0) return null;

  const tokenAmount = asRecord(info['tokenAmount']);
  if (!tokenAmount) return null;

  const decimals = tokenAmount['decimals'];
  if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > MAX_TOKEN_DECIMALS
  ) {
    return null;
  }

  // `amount` 는 base unit 문자열이다. uiAmount(부동소수)는 정밀도가 깨지므로 안 쓴다.
  const amount = parseBaseUnitString(tokenAmount['amount']);
  if (amount === null) return null;

  return { mint, amount, decimals };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function parseBaseUnitString(v: unknown): bigint | null {
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
}

/**
 * mint 주소를 사람이 구분할 수 있는 짧은 라벨로.
 *
 * 진짜 심볼이 아니다 — `source: 'mint-address'` 가 그 사실을 같이 전달한다.
 */
function abbreviateMint(mint: string): string {
  if (mint.length <= 11) return mint;
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`;
}

/**
 * mint 계정에서 decimals 를 읽는다.
 *
 * 1순위는 RPC 가 파싱해준 `parsed.info.decimals`. RPC 가 jsonParsed 를 못 주면
 * (구버전 노드, Token-2022 확장 미지원 등) 원본 바이트에서 고정 오프셋으로 읽는다.
 * 둘 다 안 되면 `null` — 기본값을 지어내지 않는다.
 */
function readMintDecimals(data: unknown): number | null {
  const parsed = asRecord(asRecord(data)?.['parsed']);
  const info = asRecord(parsed?.['info']);
  const fromParsed = info?.['decimals'];
  if (isValidDecimals(fromParsed)) return fromParsed;

  const bytes = asBytes(data);
  if (bytes && bytes.length > MINT_DECIMALS_OFFSET) {
    const raw = bytes[MINT_DECIMALS_OFFSET];
    if (isValidDecimals(raw)) return raw;
  }
  return null;
}

function isValidDecimals(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isInteger(v) &&
    v >= 0 &&
    v <= MAX_TOKEN_DECIMALS
  );
}

function asBytes(v: unknown): Uint8Array | null {
  return v instanceof Uint8Array ? v : null;
}

/**
 * ATA(Associated Token Account) 주소 유도.
 *
 * 시드에 **토큰 프로그램 id 가 들어간다** — 그래서 같은 mint·같은 소유자라도
 * Token 과 Token-2022 의 ATA 주소가 다르다. 여기를 틀리면 존재하는 계정을
 * "없다"고 판단해 엉뚱한 계정을 만들게 된다.
 */
function deriveAssociatedTokenAddress(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBytes(), tokenProgramId.toBytes(), mint.toBytes()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

function createAssociatedTokenAccountIdempotentInstruction(args: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
  tokenProgramId: PublicKey;
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: args.payer, isSigner: true, isWritable: true },
      { pubkey: args.ata, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: false, isWritable: false },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: args.tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([IX_CREATE_ATA_IDEMPOTENT]),
  });
}

/**
 * `TransferChecked` 명령.
 *
 * 그냥 `Transfer`(3) 대신 이걸 쓰는 이유: mint 와 decimals 를 명령에 같이 실어서
 * **체인이 자릿수를 대조**해준다. 우리가 잘못된 자릿수로 계산했으면 tx 가
 * 성공하는 대신 거절된다 — 자릿수 실수는 조용히 100배 송금이 되므로,
 * 실패하는 쪽이 안전하다.
 */
function createTransferCheckedInstruction(args: {
  source: PublicKey;
  mint: PublicKey;
  destination: PublicKey;
  owner: PublicKey;
  amount: bigint;
  decimals: number;
  tokenProgramId: PublicKey;
}): TransactionInstruction {
  const data = new Uint8Array(10);
  data[0] = IX_TRANSFER_CHECKED;
  new DataView(data.buffer).setBigUint64(1, args.amount, true); // u64 little-endian
  data[9] = args.decimals;

  return new TransactionInstruction({
    programId: args.tokenProgramId,
    keys: [
      { pubkey: args.source, isSigner: false, isWritable: true },
      { pubkey: args.mint, isSigner: false, isWritable: false },
      { pubkey: args.destination, isSigner: false, isWritable: true },
      { pubkey: args.owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from(data),
  });
}
