import { SuiClient, getFullnodeUrl, type CoinStruct } from '@mysten/sui/client';
import { Transaction } from '@mysten/sui/transactions';
import { messageWithIntent } from '@mysten/sui/cryptography';
import { normalizeStructTag, SUI_TYPE_ARG } from '@mysten/sui/utils';
import { blake2b } from '@noble/hashes/blake2b';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type {
  PortableTokenBalance,
  TokenCapableAdapter,
} from '../tokens/portable.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type SuiNetwork = 'mainnet' | 'testnet' | 'devnet';

/** SUI 자체의 coin type — 정규형(`0x000…002::sui::SUI`)으로 한 번만 계산해 둔다. */
const NORMALIZED_SUI_TYPE = normalizeStructTag(SUI_TYPE_ARG);

/**
 * `getCoins` 페이지를 몇 장까지 넘길지. 한 장 기본 50 개 → 500 개.
 *
 * 무한 루프를 막는 상한이다. 여기까지 긁고도 금액이 안 차면 "조각남" 으로
 * 보고한다 — 조용히 부족한 tx 를 만들어 broadcast 에서 터지게 두지 않는다.
 */
const MAX_COIN_PAGES = 10;

/**
 * 한 tx 에서 병합할 코인 오브젝트 최대 개수.
 *
 * Sui 는 tx 당 입력 오브젝트 수에 프로토콜 상한이 있다. 넉넉히 아래로 잡아
 * "입력 too many" 로 거절당하는 대신 우리가 먼저 이유를 말한다.
 */
const MAX_MERGE_COINS = 256;

export interface SuiAdapterOptions {
  network?: SuiNetwork;
  url?: string;
}

export interface SuiUnsignedTx {
  /** Built TransactionData bytes (BCS, no intent prefix, no signature). */
  txBytes: Uint8Array;
  /** Sender's 32-byte Ed25519 pubkey for the final signature blob. */
  pubkey: Uint8Array;
}

export interface SuiSignedTx {
  txBytes: Uint8Array;
  /** Base64 string of (flag(1) || sig(64) || pubkey(32)) — Sui's serialized signature. */
  signature: string;
}

const SUI_ED25519_FLAG = 0x00;

/**
 * SuiAdapter — Sui Wallet (formerly Sui Wallet/Slush) compatible HD adapter.
 *
 * Curve: Ed25519. Path: m/44'/784'/${account}'/0'/${index}' (Sui standard).
 *
 * Address = first 32 bytes of blake2b256(0x00 || pubkey32). The 0x00 is the
 * Ed25519 scheme flag. Sui addresses are 0x-prefixed 64-hex-char strings.
 *
 * Signing target: blake2b256( messageWithIntent('TransactionData', txBytes) ).
 * The intent message prefixes 3 bytes (scope, version, app) before the actual
 * BCS-encoded TransactionData. The 32-byte blake2b256 digest is the Ed25519
 * signing message — Sui's verifier reapplies the same intent hash on-chain.
 */
export class SuiAdapter
  implements ChainAdapter<SuiUnsignedTx, SuiSignedTx>, TokenCapableAdapter
{
  readonly curve = 'ed25519' as const;
  readonly coinType = 784;
  readonly id: string;
  readonly displayName: string;
  readonly network: SuiNetwork;
  private readonly client: SuiClient;

  constructor(opts: SuiAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `sui:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'Sui' : `Sui ${this.network}`;
    const url = opts.url ?? getFullnodeUrl(this.network);
    this.client = new SuiClient({ url });
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0'/${index}'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(`sui: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    // Sui address: blake2b256(flag || pubkey)[..32], 0x-hex encoded.
    const tmp = new Uint8Array(33);
    tmp[0] = SUI_ED25519_FLAG;
    tmp.set(pubkey, 1);
    const digest = blake2b(tmp, { dkLen: 32 });
    return '0x' + bytesToHex(digest);
  }

  async getBalance(address: Address): Promise<bigint> {
    // Default SUI coinType — equivalent to '0x2::sui::SUI'.
    const res = await this.client.getBalance({ owner: address });
    return BigInt(res.totalBalance);
  }

  /**
   * 보유 coin type 을 전부 돌려준다. `suix_getAllBalances` 한 번이면 목록과
   * 합계가 같이 나온다 — 오브젝트를 하나씩 세지 않아도 된다.
   *
   * `decimals`/`symbol` 은 목록에 없어서 coin type 마다
   * `suix_getCoinMetadata` 를 한 번 더 부른다. 병렬로 던져 왕복 한 번에 끝낸다.
   *
   * **metadata 를 못 얻은 코인은 버린다.** decimals 를 추측하면 잔액이
   * 자릿수째로 거짓이 된다 — 안 보이는 건 알아채도 100 배 틀린 숫자는 못
   * 알아챈다. SUI 자체도 포함해서 돌려준다(coin type `0x…2::sui::SUI`);
   * 화면이 native 를 따로 그린다면 그 id 로 걸러라.
   *
   * 실패는 던지지 않고 빈 배열.
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    let balances: Array<{ coinType: string; totalBalance: string }>;
    try {
      balances = await this.client.getAllBalances({ owner });
    } catch {
      return [];
    }

    // metadata 조회는 코인마다 독립이다 — 하나가 없다고 나머지를 버리지 않게
    // allSettled 로 받고 실패한 항목만 뺀다.
    const metas = await Promise.allSettled(
      balances.map((b) => this.client.getCoinMetadata({ coinType: b.coinType })),
    );

    const out: PortableTokenBalance[] = [];
    for (let i = 0; i < balances.length; i++) {
      const b = balances[i]!;
      const settled = metas[i]!;
      if (settled.status !== 'fulfilled') continue;
      const meta = settled.value;
      if (
        meta === null ||
        typeof meta.decimals !== 'number' ||
        !Number.isInteger(meta.decimals) ||
        meta.decimals < 0
      ) {
        continue;
      }
      let balance: bigint;
      try {
        balance = BigInt(b.totalBalance);
      } catch {
        continue;
      }
      if (balance < 0n) continue;
      out.push({
        id: b.coinType,
        symbol: meta.symbol,
        name: meta.name.length > 0 ? meta.name : meta.symbol,
        decimals: meta.decimals,
        balance,
        source: 'sui:getCoinMetadata',
      });
    }
    return out;
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<SuiUnsignedTx> {
    const pubkey = await ctx.signer.publicKey();
    if (pubkey.length !== 32) {
      throw new Error(`sui: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    const tx = await this.buildTransferCommands(intent, ctx.sender);
    tx.setSender(ctx.sender);
    const txBytes = await tx.build({ client: this.client });
    return { txBytes, pubkey };
  }

  /**
   * `intent` 하나를 명령으로 옮긴 `Transaction`. `buildTransfer` 가 sender 를
   * 채우고 직렬화한다.
   *
   * 분리한 이유는 하나다: 명령 구성은 순수하게(네트워크는 `getCoins` 만)
   * 검사할 수 있어야 한다. `tx.build()` 는 가스 시세·오브젝트 해석 때문에
   * 풀노드를 타므로 여기에 섞으면 offline 테스트가 불가능해진다.
   */
  private async buildTransferCommands(
    intent: TransferIntent,
    sender: Address,
  ): Promise<Transaction> {
    const tx = new Transaction();
    const coinType = resolveCoinType(intent.asset);

    if (coinType === null) {
      // ── native(SUI) 경로 — 예전 그대로. 한 줄도 바꾸지 않는다. ──
      // Split `amount` MIST off the gas coin, then transfer the split coin to
      // the recipient. setSender is required for `tx.build()` to populate the
      // sender field in TransactionData.
      const [coin] = tx.splitCoins(tx.gas, [intent.amount]);
      tx.transferObjects([coin], intent.to);
      return tx;
    }

    await this.addCoinTransfer(tx, coinType, sender, intent.to, intent.amount);
    return tx;
  }

  /**
   * non-SUI 코인 송금 명령을 붙인다.
   *
   * Sui 의 잔액은 **오브젝트 여러 개에 흩어져 있다.** `suix_getBalance` 가
   * 100 을 말해도 그게 10 짜리 코인 10 개면, 코인 하나만 집어서 100 을 쪼개려는
   * tx 는 실패한다 — "잔액은 충분한데 안 보내지는" 전형적인 사고다. 그래서
   * 금액이 찰 때까지 오브젝트를 모아 `mergeCoins` 로 합친 뒤 `splitCoins` 한다.
   *
   * 큰 것부터 집는다 — 합치는 오브젝트 수가 줄어 tx 입력 상한에 덜 부딪힌다.
   * 딱 떨어지면 split 을 건너뛰고 합친 코인을 그대로 보낸다(잔액 0 짜리 코인
   * 찌꺼기를 안 만든다).
   *
   * 가스는 SUI 가스 코인에서 따로 나간다 — 이 경로는 가스 코인을 건드리지 않는다.
   */
  private async addCoinTransfer(
    tx: Transaction,
    coinType: string,
    owner: Address,
    to: string,
    amount: bigint,
  ): Promise<void> {
    if (amount <= 0n) {
      throw new Error(`sui: transfer amount must be positive, got ${amount}`);
    }

    const coins = await this.fetchCoins(owner, coinType);
    if (coins.length === 0) {
      throw new Error(`sui: no ${coinType} coin objects owned by ${owner}`);
    }

    // 큰 것부터. balance 는 문자열이라 BigInt 비교로 정렬한다.
    const sorted = [...coins].sort((a, b) => {
      const d = BigInt(b.balance) - BigInt(a.balance);
      return d > 0n ? 1 : d < 0n ? -1 : 0;
    });

    const picked: CoinStruct[] = [];
    let picking = 0n;
    for (const coin of sorted) {
      if (picked.length >= MAX_MERGE_COINS) break;
      picked.push(coin);
      picking += BigInt(coin.balance);
      if (picking >= amount) break;
    }

    if (picking < amount) {
      const total = sorted.reduce((sum, c) => sum + BigInt(c.balance), 0n);
      if (total >= amount) {
        // 전체 잔액은 충분한데 상한까지 긁어도 안 찼다 = 너무 잘게 조각남.
        throw new Error(
          `sui: ${coinType} balance ${total} is enough for ${amount} but is split ` +
            `across too many coin objects (>${MAX_MERGE_COINS}); merge them first`,
        );
      }
      throw new Error(
        `sui: insufficient ${coinType} balance: have ${total}, need ${amount}`,
      );
    }

    const [primary, ...rest] = picked as [CoinStruct, ...CoinStruct[]];
    if (rest.length > 0) {
      tx.mergeCoins(
        primary.coinObjectId,
        rest.map((c) => c.coinObjectId),
      );
    }
    if (picking === amount) {
      // 합친 값이 정확히 금액 — 쪼갤 게 없다.
      tx.transferObjects([primary.coinObjectId], to);
      return;
    }
    const [sent] = tx.splitCoins(primary.coinObjectId, [amount]);
    tx.transferObjects([sent], to);
  }

  /**
   * 소유한 특정 coin type 오브젝트를 전부 (상한까지) 모은다.
   * `suix_getCoins` 는 페이지로 나눠 주므로 커서를 따라간다.
   */
  private async fetchCoins(
    owner: Address,
    coinType: string,
  ): Promise<CoinStruct[]> {
    const out: CoinStruct[] = [];
    let cursor: string | null | undefined;
    for (let page = 0; page < MAX_COIN_PAGES; page++) {
      const res = await this.client.getCoins({ owner, coinType, cursor });
      out.push(...res.data);
      if (!res.hasNextPage || !res.nextCursor) break;
      cursor = res.nextCursor;
    }
    return out;
  }

  async signRequests(tx: SuiUnsignedTx): Promise<SignRequest[]> {
    // Wrap TransactionData with Sui's IntentMessage(scope='TransactionData',
    // version=V0, app=Sui), then blake2b256-hash for the Ed25519 message.
    // The 32-byte blake2b digest is the Ed25519 message — flagged
    // prehashed=true for consistency (informational only; Ed25519's internal
    // hash of a 32-byte digest is harmless).
    const intentMsg = messageWithIntent('TransactionData', tx.txBytes);
    return [{ message: blake2b(intentMsg, { dkLen: 32 }), prehashed: true }];
  }

  async applySignatures(
    tx: SuiUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<SuiSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`sui: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 64) {
      throw new Error(
        `sui: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    // Sui's serialized signature: flag(1) || sig(64) || pubkey(32), base64.
    const blob = new Uint8Array(1 + 64 + 32);
    blob[0] = SUI_ED25519_FLAG;
    blob.set(signature, 1);
    blob.set(tx.pubkey, 1 + 64);
    return { txBytes: tx.txBytes, signature: bytesToBase64(blob) };
  }

  async broadcast(tx: SuiSignedTx): Promise<TxHash> {
    const res = await this.client.executeTransactionBlock({
      transactionBlock: tx.txBytes,
      signature: [tx.signature],
    });
    return res.digest;
  }
}

/**
 * `intent.asset` → 보낼 coin type. `null` 이면 native(가스 코인) 경로.
 *
 * SUI 자체를 명시해도 `null` 을 준다 — SUI 는 곧 가스 코인이라 기존 경로가
 * 더 싸고(오브젝트 조회 0 회) 이미 검증돼 있다. `0x2::sui::SUI` 와
 * `0x000…002::sui::SUI` 는 같은 것이므로 정규화해서 비교한다.
 *
 * coin type 문법이 아니면 native 로 조용히 되돌리지 않고 던진다 — 다른 자산을
 * 고른 사용자에게 SUI 가 나가는 것보다 실패가 낫다.
 */
function resolveCoinType(asset: string | undefined): string | null {
  if (asset === undefined) return null;
  const trimmed = asset.trim();
  if (trimmed.length === 0) return null;
  let normalized: string;
  try {
    normalized = normalizeStructTag(trimmed);
  } catch {
    throw new Error(
      `sui: intent.asset must be a coin type (e.g. '0x2::sui::SUI'), got ${JSON.stringify(asset)}`,
    );
  }
  return normalized === NORMALIZED_SUI_TYPE ? null : normalized;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += (b[i] as number).toString(16).padStart(2, '0');
  }
  return s;
}

function bytesToBase64(b: Uint8Array): string {
  // Node Buffer is available in our target runtime; fall back to btoa
  // when running in a browser-like env without Buffer.
  if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('base64');
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i] as number);
  return btoa(s);
}
