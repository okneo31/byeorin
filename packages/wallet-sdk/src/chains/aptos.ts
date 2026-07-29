import {
  AccountAuthenticatorEd25519,
  Aptos,
  AptosConfig,
  Ed25519PublicKey,
  Ed25519Signature,
  Network,
  type AccountAuthenticator,
  type InputEntryFunctionData,
  type SimpleTransaction,
  generateSigningMessageForTransaction,
} from '@aptos-labs/ts-sdk';
import { sha3_256 } from '@noble/hashes/sha3';
import type { PortableTokenBalance, TokenCapableAdapter } from '../tokens/portable.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type AptosNetwork = 'mainnet' | 'testnet' | 'devnet';

export interface AptosAdapterOptions {
  network?: AptosNetwork;
  fullnode?: string;
  /**
   * 인덱서(GraphQL) URL. Fungible Asset(FA) 잔액 조회에만 쓴다.
   * `null` 을 주면 인덱서를 아예 쓰지 않고 **체인 직접 조회(Coin)만** 한다.
   */
  indexer?: string | null;
  /** fetch 주입 — 테스트에서 가짜 응답을 넣는 용도. */
  fetch?: typeof fetch;
  /** 토큰 조회 1회 상한(ms). 기본 8000. 지갑 첫 화면을 막으면 안 된다. */
  tokenTimeoutMs?: number;
}

/** fullnode REST base. `/v1` 까지 포함한다. */
const DEFAULT_FULLNODE: Record<AptosNetwork, string> = {
  mainnet: 'https://fullnode.mainnet.aptoslabs.com/v1',
  testnet: 'https://fullnode.testnet.aptoslabs.com/v1',
  devnet: 'https://fullnode.devnet.aptoslabs.com/v1',
};

/** Aptos Labs 인덱서 GraphQL 엔드포인트. */
const DEFAULT_INDEXER: Record<AptosNetwork, string> = {
  mainnet: 'https://api.mainnet.aptoslabs.com/v1/graphql',
  testnet: 'https://api.testnet.aptoslabs.com/v1/graphql',
  devnet: 'https://api.devnet.aptoslabs.com/v1/graphql',
};

/** 계정 리소스 한 번에 받을 개수 상한. */
const RESOURCE_PAGE = 200;
/** 리소스 페이지 최대 반복 (무한 루프 방지). */
const RESOURCE_MAX_PAGES = 10;
/** 인덱서에서 받을 FA 잔액 최대 개수. */
const FA_LIMIT = 100;

/** native APT 의 두 얼굴 — legacy coin type 과 FA metadata 주소. */
const APT_COIN_TYPE = '0x1::aptos_coin::AptosCoin';
const APT_FA_METADATA = '0xa';

export interface AptosUnsignedTx {
  /** SimpleTransaction (BCS-serializable RawTransaction wrapper). */
  rawTxn: SimpleTransaction;
  /** Sender's 32-byte Ed25519 pubkey, required for authenticator assembly. */
  senderPubkey: Uint8Array;
}

export interface AptosSignedTx {
  /** The same SimpleTransaction (needed by `submit.simple`). */
  rawTxn: SimpleTransaction;
  /** Sender authenticator carrying pubkey+signature. */
  senderAuthenticator: AccountAuthenticator;
}

const NETWORK_MAP: Record<AptosNetwork, Network> = {
  mainnet: Network.MAINNET,
  testnet: Network.TESTNET,
  devnet: Network.DEVNET,
};

/**
 * AptosAdapter — Petra-compatible HD wallet adapter.
 *
 * Curve: Ed25519. Path: m/44'/637'/${account}'/0'/${index}' (BIP44 + hardened
 * sub-segments, matching Petra/Aptos CLI defaults).
 *
 * Address (a.k.a. authentication key) = sha3-256(pubkey || 0x00). The trailing
 * 0x00 is Aptos's scheme byte for single-signer Ed25519.
 *
 * Signing target: `generateSigningMessageForTransaction(rawTxn)` returns the
 * already-prefixed sha3-256 prehash that on-chain verifiers re-hash and verify
 * (domain separator: `APTOS::RawTransaction`). The SoftSigner signs the raw
 * 32-byte message — Aptos uses raw Ed25519 signature semantics where the inner
 * hash IS the message.
 */
export class AptosAdapter
  implements ChainAdapter<AptosUnsignedTx, AptosSignedTx>, TokenCapableAdapter
{
  readonly curve = 'ed25519' as const;
  readonly coinType = 637;
  readonly id: string;
  readonly displayName: string;
  readonly network: AptosNetwork;
  /** 토큰 조회에 쓰는 fullnode REST base (체인 직접). */
  readonly fullnodeUrl: string;
  /** FA 조회에 쓰는 인덱서 URL. null 이면 FA 조회를 하지 않는다. */
  readonly indexerUrl: string | null;
  readonly tokenTimeoutMs: number;
  private readonly aptos: Aptos;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: AptosAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `aptos:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'Aptos' : `Aptos ${this.network}`;
    const config = new AptosConfig({
      network: NETWORK_MAP[this.network],
      fullnode: opts.fullnode,
    });
    this.aptos = new Aptos(config);
    this.fullnodeUrl = (opts.fullnode ?? DEFAULT_FULLNODE[this.network]).replace(
      /\/+$/,
      '',
    );
    this.indexerUrl =
      opts.indexer === null
        ? null
        : (opts.indexer ?? DEFAULT_INDEXER[this.network]);
    this.tokenTimeoutMs = opts.tokenTimeoutMs ?? 8_000;
    this.fetchImpl =
      opts.fetch ??
      (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  }

  /**
   * 이 계정이 가진 토큰 전부 — legacy Coin + Fungible Asset(FA).
   *
   * **두 갈래를 쓰고, 출처를 구분해 표시한다:**
   *   1. Coin (`0x1::coin::CoinStore<T>`) — fullnode 계정 리소스를 직접 훑는다.
   *      체인 직접 조회이므로 `source` 를 비워 둔다.
   *   2. FA (`0x1::fungible_asset`) — 소유자의 primary store 는 객체(object) 안에
   *      들어 있어서, **metadata 주소를 미리 모르면 체인만으로는 열거할 수 없다.**
   *      그래서 인덱서 GraphQL 을 쓴다. 이 항목은 `source: 'aptos-indexer'` 로
   *      남긴다 — 남이 말해준 값이라는 뜻이다.
   *
   * 같은 자산이 양쪽에 나오면 **체인 직접 조회가 이긴다.**
   * native APT 는 목록에서 뺀다 — `getBalance` 가 이미 주는 값이라 중복이다.
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    const [coins, fas] = await Promise.all([
      this.discoverCoinStores(owner),
      this.discoverFungibleAssets(owner),
    ]);
    const byId = new Map<string, PortableTokenBalance>();
    for (const t of coins) byId.set(t.id, t);
    for (const t of fas) if (!byId.has(t.id)) byId.set(t.id, t);
    return [...byId.values()];
  }

  /**
   * fullnode 계정 리소스에서 `0x1::coin::CoinStore<T>` 를 훑는다 — 체인 직접 조회.
   *
   * decimals/symbol 은 `0x1::coin::CoinInfo<T>` 에서 읽는다. CoinInfo 는 T 를
   * 선언한 모듈의 계정에 있으므로, coin type 앞부분의 주소로 한 번 더 요청한다.
   * **못 읽으면 그 항목을 버린다.** decimals 를 추측하면 잔액이 자릿수째로 거짓이 된다.
   */
  private async discoverCoinStores(
    owner: string,
  ): Promise<PortableTokenBalance[]> {
    try {
      const stores: { coinType: string; balance: bigint }[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < RESOURCE_MAX_PAGES; page++) {
        const url =
          `${this.fullnodeUrl}/accounts/${owner}/resources?limit=${RESOURCE_PAGE}` +
          (cursor ? `&start=${encodeURIComponent(cursor)}` : '');
        const res: Response = await this.httpGet(url);
        if (!res.ok) break;
        const body: unknown = await res.json();
        if (!Array.isArray(body)) break;
        for (const raw of body) {
          const parsed = parseCoinStore(raw);
          if (parsed) stores.push(parsed);
        }
        cursor = res.headers?.get?.('x-aptos-cursor') ?? null;
        if (!cursor || body.length === 0) break;
      }

      const settled = await Promise.allSettled(
        stores
          .filter((s) => s.coinType !== APT_COIN_TYPE)
          .map(async (s): Promise<PortableTokenBalance | null> => {
            const info = await this.fetchCoinInfo(s.coinType);
            if (!info) return null;
            return {
              id: s.coinType,
              symbol: info.symbol,
              name: info.name,
              decimals: info.decimals,
              balance: s.balance,
              // source 없음 = 체인에서 직접 읽은 값.
            };
          }),
      );
      const out: PortableTokenBalance[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) out.push(r.value);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** `0x1::coin::CoinInfo<T>` 조회. 못 읽거나 decimals 가 정수가 아니면 null. */
  private async fetchCoinInfo(
    coinType: string,
  ): Promise<{ symbol: string; name: string; decimals: number } | null> {
    const moduleAddr = coinType.split('::')[0];
    if (!moduleAddr) return null;
    const resourceType = `0x1::coin::CoinInfo<${coinType}>`;
    const url = `${this.fullnodeUrl}/accounts/${moduleAddr}/resource/${encodeURIComponent(resourceType)}`;
    try {
      const res = await this.httpGet(url);
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: unknown };
      const data = body?.data as
        | { decimals?: unknown; name?: unknown; symbol?: unknown }
        | undefined;
      if (!data) return null;
      const decimals = toDecimals(data.decimals);
      if (decimals === null) return null;
      const symbol = nonEmptyString(data.symbol);
      if (symbol === null) return null;
      return { symbol, name: nonEmptyString(data.name) ?? symbol, decimals };
    } catch {
      return null;
    }
  }

  /**
   * 인덱서 GraphQL 에서 FA 잔액. 체인이 아니라 **인덱서가 말해준 값**이다.
   *
   * `current_fungible_asset_balances` 는 FA(v2) 와 coin(v1) 을 모두 담고 있다.
   * v1 행도 버리지 않는다 — 체인 직접 조회가 실패했을 때의 대체 경로가 되고,
   * 둘 다 성공하면 `discoverTokens` 의 중복 제거에서 체인 값이 이긴다.
   */
  private async discoverFungibleAssets(
    owner: string,
  ): Promise<PortableTokenBalance[]> {
    const endpoint = this.indexerUrl;
    if (!endpoint) return [];
    const query = `query ByeorinFaBalances($owner: String!, $limit: Int!) {
  current_fungible_asset_balances(
    where: { owner_address: { _eq: $owner }, amount: { _gt: "0" } }
    limit: $limit
  ) {
    asset_type
    amount
    metadata { name symbol decimals }
  }
}`;
    try {
      const res = await this.httpPost(endpoint, {
        query,
        variables: { owner, limit: FA_LIMIT },
      });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        data?: { current_fungible_asset_balances?: unknown };
      };
      const rows = body?.data?.current_fungible_asset_balances;
      if (!Array.isArray(rows)) return [];
      const out: PortableTokenBalance[] = [];
      for (const raw of rows) {
        const token = parseFaRow(raw);
        if (token) out.push(token);
      }
      return out;
    } catch {
      return [];
    }
  }

  /**
   * 식별자 하나를 직접 읽는다 — **수동 토큰 추가용.**
   *
   * **갈래를 고르는 규칙이 `buildTransferPayload` 와 완전히 같다** (`isCoinType`
   * → legacy Coin, `isAccountAddress` → FA). 조회에서 Coin 으로 본 것을 송금에서
   * FA 로 보내면 자산 사고이므로, 판별 함수를 새로 만들지 않고 그대로 쓴다.
   *
   *   `0x…::mod::T` → `0x1::coin::CoinInfo<T>` + `CoinStore<T>` (체인 직접, source 없음)
   *   `0x…`        → 인덱서 GraphQL                            (`source: 'aptos-indexer'`)
   *
   * native APT 는 두 표기 모두 null 이다 — `discoverTokens` 가 목록에서 빼는 것과
   * 같은 이유로, `getBalance` 가 이미 주는 값이라 토큰으로 등록할 대상이 아니다.
   *
   * 형식을 모르면 던진다 — 사용자가 방금 입력한 값이라 이유를 알려주는 편이 낫다.
   */
  async readToken(
    id: string,
    owner: string,
  ): Promise<PortableTokenBalance | null> {
    const asset = id.trim();
    if (isCoinType(asset)) return this.readCoinToken(asset, owner);
    if (isAccountAddress(asset)) return this.readFungibleAssetToken(asset, owner);
    throw new Error(
      `aptos: unsupported token id "${id}" — expected coin type "0x…::mod::T" or FA metadata address`,
    );
  }

  /**
   * legacy Coin 갈래 — 체인 직접 조회.
   *
   * 메타는 `discoverCoinStores` 가 쓰는 `fetchCoinInfo` 를 그대로 재사용한다.
   * 잔액은 `0x1::coin::CoinStore<T>` 리소스 하나를 집어 `parseCoinStore` 로 읽는다
   * — 목록 경로가 리소스 전체를 훑으며 쓰는 것과 **같은 파서**다.
   *
   * CoinStore 가 없으면(= 아직 이 코인을 register 하지 않은 계정) 잔액 0 으로
   * 등록한다. 등록과 보유는 다른 문제다.
   */
  private async readCoinToken(
    coinType: string,
    owner: string,
  ): Promise<PortableTokenBalance | null> {
    if (coinType === APT_COIN_TYPE) return null;
    const info = await this.fetchCoinInfo(coinType);
    // decimals 를 못 읽으면 추측하지 않는다.
    if (!info) return null;

    let balance = 0n;
    let resolvedId = coinType;
    try {
      const resourceType = `0x1::coin::CoinStore<${coinType}>`;
      const url = `${this.fullnodeUrl}/accounts/${owner}/resource/${encodeURIComponent(resourceType)}`;
      const res = await this.httpGet(url);
      if (res.ok) {
        const parsed = parseCoinStore(await res.json());
        if (parsed) {
          balance = parsed.balance;
          // 풀노드가 돌려준 표기를 쓴다 — 목록 경로도 같은 곳에서 뽑는다.
          resolvedId = parsed.coinType;
        }
      }
    } catch {
      balance = 0n;
    }

    return {
      id: resolvedId,
      symbol: info.symbol,
      name: info.name,
      decimals: info.decimals,
      balance,
      // source 없음 = 체인에서 직접 읽은 값.
    };
  }

  /**
   * FA 갈래 — 인덱서.
   *
   * FA 는 metadata 주소를 알아도 **체인만으로는 primary store 를 열거할 수 없다**
   * (`discoverFungibleAssets` 주석 참고). 그래서 목록과 마찬가지로 인덱서를 쓰고
   * `source: 'aptos-indexer'` 를 남긴다.
   *
   * 한 번의 GraphQL 로 두 가지를 같이 묻는다:
   *   - 이 소유자의 잔액 행 (목록 경로와 **같은 필드·같은 파서** `parseFaRow`)
   *   - 자산 자체의 메타 (잔액 행이 아예 없을 때 쓸 대체 경로)
   *
   * 잔액 필터(`amount > 0`)는 걸지 않는다 — 목록은 "가진 것"을 보여주는 자리고
   * 여기는 "아직 안 받은 것을 등록"하는 자리라서 그렇다. 값을 만드는 규칙은
   * 그대로다.
   */
  private async readFungibleAssetToken(
    metadataAddress: string,
    owner: string,
  ): Promise<PortableTokenBalance | null> {
    if (normalizeAddress(metadataAddress) === normalizeAddress(APT_FA_METADATA)) {
      return null;
    }
    const endpoint = this.indexerUrl;
    if (!endpoint) {
      throw new Error(
        'aptos: fungible asset lookup needs the indexer, but indexer is disabled (indexer: null)',
      );
    }
    const query = `query ByeorinReadFa($owner: String!, $assetType: String!) {
  current_fungible_asset_balances(
    where: { owner_address: { _eq: $owner }, asset_type: { _eq: $assetType } }
    limit: 1
  ) {
    asset_type
    amount
    metadata { name symbol decimals }
  }
  fungible_asset_metadata(where: { asset_type: { _eq: $assetType } }, limit: 1) {
    asset_type
    name
    symbol
    decimals
  }
}`;
    const res = await this.httpPost(endpoint, {
      query,
      variables: { owner, assetType: metadataAddress },
    });
    if (!res.ok) {
      throw new Error(`aptos: indexer returned HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      data?: {
        current_fungible_asset_balances?: unknown;
        fungible_asset_metadata?: unknown;
      };
    };
    const balanceRows = body?.data?.current_fungible_asset_balances;
    if (Array.isArray(balanceRows) && balanceRows.length > 0) {
      const token = parseFaRow(balanceRows[0]);
      if (token) return token;
    }
    const metaRows = body?.data?.fungible_asset_metadata;
    if (!Array.isArray(metaRows) || metaRows.length === 0) return null;
    const m = metaRows[0] as {
      asset_type?: unknown;
      name?: unknown;
      symbol?: unknown;
      decimals?: unknown;
    } | null;
    if (!m) return null;
    // 잔액 행과 똑같은 파서를 태운다 — 검증 규칙이 갈라지지 않게.
    return parseFaRow({
      asset_type: m.asset_type,
      amount: '0',
      metadata: { name: m.name, symbol: m.symbol, decimals: m.decimals },
    });
  }

  /** GET + AbortController 타임아웃. fetch 가 없으면 실패로 본다. */
  private async httpGet(url: string): Promise<Response> {
    const f = this.fetchImpl;
    if (!f) throw new Error('aptos: fetch unavailable');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.tokenTimeoutMs);
    try {
      return await f(url, {
        headers: { accept: 'application/json' },
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** POST(JSON) + AbortController 타임아웃. */
  private async httpPost(url: string, payload: unknown): Promise<Response> {
    const f = this.fetchImpl;
    if (!f) throw new Error('aptos: fetch unavailable');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.tokenTimeoutMs);
    try {
      return await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        signal: ctl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0'/${index}'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(
        `aptos: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`,
      );
    }
    // Aptos auth key for single Ed25519: sha3-256(pubkey32 || 0x00).
    // The 0x00 byte is the SigningScheme tag for Ed25519SingleKey.
    const buf = new Uint8Array(33);
    buf.set(pubkey, 0);
    buf[32] = 0x00;
    const digest = sha3_256(buf);
    return '0x' + bytesToHex(digest);
  }

  async getBalance(address: Address): Promise<bigint> {
    // Returns octas (1 APT = 1e8 octas) as a JS number — safe for any
    // realistic balance (~9e15 octas ≈ 9e7 APT supply ceiling).
    const octas = await this.aptos.getAccountAPTAmount({
      accountAddress: address,
    });
    return BigInt(octas);
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<AptosUnsignedTx> {
    const senderPubkey = await ctx.signer.publicKey();
    if (senderPubkey.length !== 32) {
      throw new Error(
        `aptos: sender pubkey must be 32 bytes ed25519, got ${senderPubkey.length}`,
      );
    }
    const rawTxn = await this.aptos.transaction.build.simple({
      sender: ctx.sender,
      // asset 이 비어 있으면 **native APT — 기존 entry function 그대로.**
      data: buildTransferPayload(intent),
    });
    return { rawTxn, senderPubkey };
  }

  async signRequests(tx: AptosUnsignedTx): Promise<SignRequest[]> {
    // generateSigningMessageForTransaction returns the domain-prefixed bytes
    // that Ed25519 signs directly (Aptos applies sha3-256 inside its TX
    // prehash; the returned blob includes the `APTOS::RawTransaction`
    // domain separator). Ed25519 hashes internally — prehashed=false.
    return [
      {
        message: generateSigningMessageForTransaction(tx.rawTxn),
        prehashed: false,
      },
    ];
  }

  async applySignatures(
    tx: AptosUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<AptosSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`aptos: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 64) {
      throw new Error(
        `aptos: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    const senderAuthenticator: AccountAuthenticator =
      new AccountAuthenticatorEd25519(
        new Ed25519PublicKey(tx.senderPubkey),
        new Ed25519Signature(signature),
      );
    return { rawTxn: tx.rawTxn, senderAuthenticator };
  }

  async broadcast(tx: AptosSignedTx): Promise<TxHash> {
    const pending = await this.aptos.transaction.submit.simple({
      transaction: tx.rawTxn,
      senderAuthenticator: tx.senderAuthenticator,
    });
    return pending.hash;
  }
}

// ── 토큰 (Coin / FA) 유틸 ──────────────────────────────────────

/**
 * `intent.asset` 을 보고 entry function 을 고른다.
 *
 *   asset 없음        → `0x1::aptos_account::transfer`           (native APT, 기존 경로)
 *   `0x…::mod::T`     → `0x1::aptos_account::transfer_coins<T>`  (legacy Coin)
 *   `0x…` (주소만)    → `0x1::primary_fungible_store::transfer`  (FA)
 *
 * 셋 다 수신자 쪽 저장소가 없으면 알아서 만들어 준다.
 * 형식을 모르면 **던진다** — 조용히 native 로 떨어지면 "토큰을 보낸 줄 알았는데
 * APT 가 나간" 사고가 된다.
 */
function buildTransferPayload(intent: TransferIntent): InputEntryFunctionData {
  const asset = intent.asset?.trim();
  if (!asset) {
    return {
      function: '0x1::aptos_account::transfer',
      functionArguments: [intent.to, intent.amount],
    };
  }
  if (isCoinType(asset)) {
    return {
      function: '0x1::aptos_account::transfer_coins',
      typeArguments: [asset],
      functionArguments: [intent.to, intent.amount],
    };
  }
  if (isAccountAddress(asset)) {
    return {
      function: '0x1::primary_fungible_store::transfer',
      typeArguments: ['0x1::fungible_asset::Metadata'],
      functionArguments: [asset, intent.to, intent.amount],
    };
  }
  throw new Error(
    `aptos: unsupported asset "${asset}" — expected coin type "0x…::mod::T" or FA metadata address`,
  );
}

/** `0xADDR::module::Struct` 형태인가 (제네릭 인자 포함 가능). */
function isCoinType(v: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}::[A-Za-z_][\w]*::[A-Za-z_][\w]*(<.+>)?$/.test(v);
}

/** `0x` + 1~64 hex. */
function isAccountAddress(v: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(v);
}

/** 계정 리소스 1건이 CoinStore 면 { coinType, balance }, 아니면 null. */
function parseCoinStore(
  raw: unknown,
): { coinType: string; balance: bigint } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as { type?: unknown; data?: unknown };
  if (typeof r.type !== 'string') return null;
  const m = /^0x1::coin::CoinStore<(.+)>$/.exec(r.type);
  const coinType = m?.[1];
  if (!coinType) return null;
  const data = r.data as { coin?: { value?: unknown } } | undefined;
  const value = data?.coin?.value;
  const balance = toBigIntAmount(value);
  if (balance === null) return null;
  return { coinType, balance };
}

/** 인덱서 FA 행 1건 → PortableTokenBalance. 메타를 못 얻으면 null. */
function parseFaRow(raw: unknown): PortableTokenBalance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as {
    asset_type?: unknown;
    amount?: unknown;
    metadata?: { name?: unknown; symbol?: unknown; decimals?: unknown } | null;
  };
  if (typeof r.asset_type !== 'string' || r.asset_type.length === 0) return null;
  // native APT 는 목록에서 뺀다 — getBalance 가 이미 주는 값이다.
  if (r.asset_type === APT_COIN_TYPE) return null;
  if (isAccountAddress(r.asset_type) && normalizeAddress(r.asset_type) === normalizeAddress(APT_FA_METADATA)) {
    return null;
  }
  const balance = toBigIntAmount(r.amount);
  if (balance === null) return null;
  // decimals 를 못 얻으면 추측하지 않고 버린다.
  const decimals = toDecimals(r.metadata?.decimals);
  if (decimals === null) return null;
  const symbol = nonEmptyString(r.metadata?.symbol);
  if (symbol === null) return null;
  return {
    id: r.asset_type,
    symbol,
    name: nonEmptyString(r.metadata?.name) ?? symbol,
    decimals,
    balance,
    // 체인이 아니라 인덱서가 말해준 값이다. 숨기지 않는다.
    source: 'aptos-indexer',
  };
}

/** `0xa` 처럼 짧게 쓴 주소를 64자리로 맞춘다 (동일 자산 판별용). */
function normalizeAddress(v: string): string {
  return '0x' + v.slice(2).toLowerCase().padStart(64, '0');
}

/** 문자열/숫자 잔액 → bigint. 음수·소수·형식 오류면 null. */
function toBigIntAmount(v: unknown): bigint | null {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) return null;
    return BigInt(v);
  }
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  return BigInt(v);
}

/** decimals 는 0~36 정수만. 아니면 null (= 항목을 버린다). */
function toDecimals(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 36) {
    return null;
  }
  return v;
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += (b[i] as number).toString(16).padStart(2, '0');
  }
  return s;
}
