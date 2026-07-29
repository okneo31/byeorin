import {
  Address as TonAddress,
  Cell,
  WalletContractV4,
  TonClient,
  beginCell,
  external,
  internal,
  storeMessage,
  storeMessageRelaxed,
  SendMode,
  type MessageRelaxed,
} from '@ton/ton';
import { withTimeout } from '../transports/rpc-fallback.js';
import type { PortableTokenBalance, TokenCapableAdapter } from '../tokens/portable.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type TonNetwork = 'mainnet' | 'testnet';

export interface TonAdapterOptions {
  network?: TonNetwork;
  endpoint?: string;
  apiKey?: string;
  /** Default valid_until window in seconds for outgoing external messages (default 60s). */
  timeoutSeconds?: number;
  /**
   * jetton 목록 조회용 인덱서 base URL. 기본 tonapi.io.
   * `null` 이면 jetton 조회를 하지 않는다(빈 배열).
   */
  jettonApiUrl?: string | null;
  /** 인덱서 API 키 (tonapi 무료 티어는 없어도 된다). */
  jettonApiKey?: string;
  /** fetch 주입 — 테스트에서 가짜 응답을 넣는 용도. */
  fetch?: typeof fetch;
  /** 토큰 조회/get-method 호출 상한(ms). 기본 8000. */
  tokenTimeoutMs?: number;
  /**
   * jetton 송금 시 내부 메시지에 실어 보낼 TON(나노톤). 기본 0.05 TON.
   *
   * jetton 전송은 "내 jetton wallet 에게 TON 을 붙여 명령을 보내는 것"이라 수수료로
   * 쓸 TON 이 반드시 함께 가야 한다. 남는 금액은 `response_destination`(= 보낸 사람)
   * 으로 되돌아온다. 부족하면 메시지가 실패하고 **bounce 로 TON 이 돌아온다** —
   * jetton 은 움직이지 않는다.
   */
  jettonGasNanoton?: bigint;
}

/** tonapi base URL. jetton wallet 열거는 체인만으로 불가능해서 인덱서를 쓴다. */
const DEFAULT_JETTON_API: Record<TonNetwork, string> = {
  mainnet: 'https://tonapi.io',
  testnet: 'https://testnet.tonapi.io',
};

/** TEP-74 jetton transfer op code. */
const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** jetton 송금에 붙일 기본 TON (0.05 TON). */
const DEFAULT_JETTON_GAS = 50_000_000n;

/**
 * 코멘트를 함께 보낼 때 수신자에게 전달할 TON(나노톤).
 *
 * jetton wallet 은 `forward_ton_amount` 가 0 보다 커야 `transfer_notification`
 * (= 코멘트가 실려 가는 메시지)을 만든다. 0 이면 코멘트는 그냥 사라진다.
 * 1 나노톤이 관례적인 최소값이다.
 */
const JETTON_FORWARD_TON = 1n;

export interface TonUnsignedTx {
  /** Builder cell that's hashed and signed (walletId | timeout | seqno | action). */
  signingMessage: Cell;
  /** 32-byte Ed25519 pubkey (also used to address-resolve the V4 wallet). */
  pubkey: Uint8Array;
  /** seqno used when building the signing message (informational). */
  seqno: number;
}

export interface TonSignedTx {
  /** Base64-encoded BOC of the external message ready for `client.sendFile`. */
  boc: string;
  /** Hex-encoded external message hash (informational; TON has no canonical "tx hash"). */
  hash: string;
}

const DEFAULT_ENDPOINT: Record<TonNetwork, string> = {
  mainnet: 'https://toncenter.com/api/v2/jsonRPC',
  testnet: 'https://testnet.toncenter.com/api/v2/jsonRPC',
};

/**
 * TonAdapter — Tonkeeper-style v4r2 HD wallet adapter.
 *
 * Curve: Ed25519. Derivation path: m/44'/607'/${account}' (Tonkeeper convention).
 * The `index` arg is intentionally ignored — TON wallets typically expose a
 * single primary key per BIP44 account; sub-account UX is handled via
 * separate `account` values.
 *
 * Address encoding: Wallet V4 code+data → 32-byte hash, then base64url-friendly
 * user-friendly form (bounceable EQ.../UQ... + workchain byte + checksum).
 *
 * Signing target: hash() of the internal "signingMessage" Cell, which is the
 * v4 wallet's signed body: `walletId(32) | timeout(32 | 0xff*32) | seqno(32) |
 * extendedAction`. We mirror what `@ton/ton`'s `createWalletTransferV4` builds
 * but expose the unsigned cell so an external signer (SoftSigner/HW) can sign.
 */
export class TonAdapter
  implements ChainAdapter<TonUnsignedTx, TonSignedTx>, TokenCapableAdapter
{
  readonly curve = 'ed25519' as const;
  readonly coinType = 607;
  readonly id: string;
  readonly displayName: string;
  readonly network: TonNetwork;
  /** jetton 목록 인덱서. null 이면 jetton 조회를 하지 않는다. */
  readonly jettonApiUrl: string | null;
  readonly tokenTimeoutMs: number;
  readonly jettonGasNanoton: bigint;
  private readonly client: TonClient;
  private readonly timeoutSeconds: number;
  private readonly jettonApiKey: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;

  constructor(opts: TonAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `ton:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'TON' : `TON ${this.network}`;
    const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT[this.network];
    this.client = new TonClient({ endpoint, apiKey: opts.apiKey });
    this.timeoutSeconds = opts.timeoutSeconds ?? 60;
    this.jettonApiUrl =
      opts.jettonApiUrl === null
        ? null
        : (opts.jettonApiUrl ?? DEFAULT_JETTON_API[this.network]).replace(
            /\/+$/,
            '',
          );
    this.jettonApiKey = opts.jettonApiKey;
    this.tokenTimeoutMs = opts.tokenTimeoutMs ?? 8_000;
    this.jettonGasNanoton = opts.jettonGasNanoton ?? DEFAULT_JETTON_GAS;
    this.fetchImpl =
      opts.fetch ??
      (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  }

  derivationPath(account = 0, index = 0): string {
    // `index` is intentionally ignored — TON has a single primary key per
    // BIP44 account. Use distinct `account` values for distinct wallets.
    void index;
    return `m/44'/${this.coinType}'/${account}'`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    if (pubkey.length !== 32) {
      throw new Error(`ton: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(pubkey),
    });
    return wallet.address.toString({
      bounceable: true,
      testOnly: this.network === 'testnet',
      urlSafe: true,
    });
  }

  async getBalance(address: Address): Promise<bigint> {
    const parsed = TonAddress.parse(address);
    const sun = await this.client.getBalance(parsed);
    return BigInt(sun);
  }

  /**
   * 이 주소가 가진 jetton 목록.
   *
   * **출처는 인덱서(tonapi)다. 체인 직접 조회가 아니다.** 이유를 숨기지 않는다:
   * TON 에는 "이 주소가 가진 jetton"을 물어볼 수 있는 곳이 없다. jetton 잔액은
   * jetton 종류마다 **따로 배포된 jetton wallet 계약** 안에 들어 있고, 그 주소는
   * `master + owner` 로만 계산된다. 즉 **master 를 미리 알아야** 잔액을 읽을 수
   * 있어서, 모르는 jetton 은 체인만으로 영원히 발견할 수 없다. 그래서 모든 실무
   * 지갑이 인덱서를 쓴다. 우리는 그 사실을 `source` 에 남긴다.
   *
   * 잔액 자체는 인덱서 값을 그대로 쓴다 — 대신 화면이 "인덱서 값"임을 표시할 수
   * 있게 출처를 붙여 보낸다.
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    const base = this.jettonApiUrl;
    const f = this.fetchImpl;
    if (!base || !f) return [];
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.tokenTimeoutMs);
    try {
      const res = await f(
        `${base}/v2/accounts/${encodeURIComponent(owner)}/jettons`,
        {
          headers: {
            accept: 'application/json',
            ...(this.jettonApiKey
              ? { authorization: `Bearer ${this.jettonApiKey}` }
              : {}),
          },
          signal: ctl.signal,
        },
      );
      if (!res.ok) return [];
      const body = (await res.json()) as { balances?: unknown };
      if (!Array.isArray(body?.balances)) return [];
      const source = hostOf(base);
      const out: PortableTokenBalance[] = [];
      for (const raw of body.balances) {
        const token = parseJettonBalance(raw, source, this.network === 'testnet');
        if (token) out.push(token);
      }
      return out;
    } catch {
      // 토큰 목록 때문에 지갑이 안 열리면 안 된다.
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * jetton master 주소로부터 **이 소유자의 jetton wallet 주소**를 체인에서 받아온다.
   *
   * 오프체인 계산(master 코드+데이터로 주소를 직접 유도)도 가능하지만, jetton 구현마다
   * 데이터 레이아웃이 달라 계산이 틀릴 수 있다. 틀린 주소로 보내면 자산 사고다.
   * 그래서 **master 계약이 스스로 답하게** 한다 (`get_wallet_address`, TEP-74 필수 메서드).
   */
  private async resolveJettonWallet(
    master: TonAddress,
    owner: TonAddress,
  ): Promise<TonAddress> {
    const res = await withTimeout(
      this.client.runMethod(master, 'get_wallet_address', [
        { type: 'slice', cell: beginCell().storeAddress(owner).endCell() },
      ]),
      this.tokenTimeoutMs,
      'ton get_wallet_address',
    );
    return res.stack.readAddress();
  }

  /**
   * jetton 송금용 내부 메시지.
   *
   * native 송금과 구조가 완전히 다르다: 받는 사람에게 직접 보내는 것이 아니라
   * **내 jetton wallet 에게 "이만큼 저 사람에게 넘겨라"라고 명령**한다. 그래서
   *   - 목적지 = 내 jetton wallet (받는 사람 아님)
   *   - 메시지 value = 수수료용 TON (보낼 jetton 수량 아님)
   *   - jetton 수량과 받는 사람은 body 안에 들어간다
   *   - bounce = true : 실패하면 붙여 보낸 TON 이 되돌아온다
   */
  private async buildJettonMessage(
    asset: string,
    ownerAddress: TonAddress,
    intent: TransferIntent,
  ): Promise<MessageRelaxed> {
    if (intent.amount < 0n) {
      throw new Error('ton: jetton amount must be >= 0');
    }
    let master: TonAddress;
    let destination: TonAddress;
    try {
      master = TonAddress.parse(asset);
    } catch {
      throw new Error(
        `ton: unsupported asset "${asset}" — expected a jetton master address`,
      );
    }
    try {
      destination = TonAddress.parse(intent.to);
    } catch {
      throw new Error(`ton: invalid destination address "${intent.to}"`);
    }
    const jettonWallet = await this.resolveJettonWallet(master, ownerAddress);

    // TEP-74:
    //   transfer#0f8a7ea5 query_id:uint64 amount:(VarUInteger 16)
    //     destination:MsgAddress response_destination:MsgAddress
    //     custom_payload:(Maybe ^Cell) forward_ton_amount:(VarUInteger 16)
    //     forward_payload:(Either Cell ^Cell)
    const forwardTon = intent.memo ? JETTON_FORWARD_TON : 0n;
    const builder = beginCell()
      .storeUint(JETTON_TRANSFER_OP, 32)
      .storeUint(0, 64) // query_id — 응답을 우리가 추적하지 않으므로 0.
      .storeCoins(intent.amount)
      .storeAddress(destination)
      // 잔돈과 실패 알림은 보낸 사람에게 돌아와야 한다.
      .storeAddress(ownerAddress)
      .storeBit(0) // custom_payload: null
      .storeCoins(forwardTon);
    if (intent.memo) {
      // Either 의 1 = 참조 셀. 코멘트는 표준 텍스트 메시지(op=0) 형식.
      builder
        .storeBit(1)
        .storeRef(
          beginCell().storeUint(0, 32).storeStringTail(intent.memo).endCell(),
        );
    } else {
      builder.storeBit(0); // Either 의 0 = 이 셀에 이어 붙임(= 비어 있음)
    }

    return internal({
      to: jettonWallet,
      value: this.jettonGasNanoton,
      // jetton wallet 은 배포된 계약이다. 실패 시 TON 이 되돌아오도록 반드시 true.
      bounce: true,
      body: builder.endCell(),
    });
  }

  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<TonUnsignedTx> {
    const pubkey = await ctx.signer.publicKey();
    if (pubkey.length !== 32) {
      throw new Error(`ton: ed25519 pubkey must be 32 bytes, got ${pubkey.length}`);
    }
    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(pubkey),
    });

    // Read seqno from chain; 0 means the wallet is not yet deployed and the
    // signing message uses 32 high bits instead of a unix timeout.
    let seqno = 0;
    try {
      const opened = this.client.open(wallet);
      seqno = await opened.getSeqno();
    } catch {
      seqno = 0;
    }

    // asset 이 비어 있으면 **native TON — 기존 경로 그대로.**
    const asset = intent.asset?.trim();
    const message: MessageRelaxed = asset
      ? await this.buildJettonMessage(asset, wallet.address, intent)
      : internal({
          to: TonAddress.parse(intent.to),
          value: intent.amount,
          bounce: false,
          body: intent.memo ? beginCell().storeUint(0, 32).storeStringTail(intent.memo).endCell() : undefined,
        });

    // Mirror createWalletTransferV4 layout exactly so signature verification
    // against on-chain wallet code matches byte-for-byte.
    const signingBuilder = beginCell().storeUint(wallet.walletId, 32);
    if (seqno === 0) {
      for (let i = 0; i < 32; i++) signingBuilder.storeBit(1);
    } else {
      signingBuilder.storeUint(
        Math.floor(Date.now() / 1000) + this.timeoutSeconds,
        32,
      );
    }
    signingBuilder.storeUint(seqno, 32);
    // Inline v4 "sendMsg" extended-action layout (see @ton/ton
    // WalletContractV4Actions.storeExtendedAction): action_op(0) :: u8,
    // then for each message: sendMode :: u8, ref(messageRelaxed).
    const sendMode = SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS;
    signingBuilder.storeUint(0, 8); // op = 'sendMsg'
    signingBuilder.storeUint(sendMode, 8);
    signingBuilder.storeRef(beginCell().store(storeMessageRelaxed(message)));
    const signingMessage = signingBuilder.endCell();

    return { signingMessage, pubkey, seqno };
  }

  async signRequests(tx: TonUnsignedTx): Promise<SignRequest[]> {
    // TON signs the 32-byte Cell representation hash (sha256 over Cell repr).
    // The 32-byte hash is itself the Ed25519 message — Ed25519 hashes it again
    // internally per RFC 8032, which TON's verifier mirrors. Flagging
    // prehashed=true is consistent with secp256k1 convention and informational
    // only for SoftSigner.
    return [{ message: new Uint8Array(tx.signingMessage.hash()), prehashed: true }];
  }

  async applySignatures(
    tx: TonUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<TonSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`ton: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 64) {
      throw new Error(
        `ton: ed25519 signature must be 64 bytes, got ${signature.length}`,
      );
    }
    // Body = signature(64B) || signingMessage cell. v4 uses front-packed sig.
    const body = beginCell()
      .storeBuffer(Buffer.from(signature))
      .storeSlice(tx.signingMessage.beginParse())
      .endCell();

    const wallet = WalletContractV4.create({
      workchain: 0,
      publicKey: Buffer.from(tx.pubkey),
    });

    // Attach stateInit only on first deploy (seqno === 0). Otherwise omit so
    // the external message stays small. This mirrors @ton/ton's provider.external.
    const ext = external({
      to: wallet.address,
      init: tx.seqno === 0 ? wallet.init : undefined,
      body,
    });
    const finalCell = beginCell().store(storeMessage(ext)).endCell();
    const boc = finalCell.toBoc().toString('base64');
    const hash = finalCell.hash().toString('hex');
    return { boc, hash };
  }

  async broadcast(tx: TonSignedTx): Promise<TxHash> {
    await this.client.sendFile(Buffer.from(tx.boc, 'base64'));
    return tx.hash;
  }
}

// ── jetton 유틸 ───────────────────────────────────────────────

/**
 * tonapi `/v2/accounts/{addr}/jettons` 의 balances 1건 → PortableTokenBalance.
 *
 * `id` 는 jetton **master** 주소를 사용자 친화형(EQ…/kQ…)으로 정규화해 담는다.
 * 인덱서는 raw 형(`0:hex`)으로 주는데, 두 형태가 섞이면 화면에서 같은 토큰이
 * 다른 것처럼 보인다. 송금 쪽 `TonAddress.parse` 는 두 형태를 모두 받는다.
 */
function parseJettonBalance(
  raw: unknown,
  source: string,
  testOnly: boolean,
): PortableTokenBalance | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as {
    balance?: unknown;
    jetton?: {
      address?: unknown;
      name?: unknown;
      symbol?: unknown;
      decimals?: unknown;
    } | null;
  };
  const jetton = r.jetton;
  if (!jetton || typeof jetton.address !== 'string') return null;
  if (typeof r.balance !== 'string' || !/^\d+$/.test(r.balance)) return null;
  // decimals 를 못 얻으면 추측하지 않고 버린다 — 자릿수가 틀리면 잔액이 통째로 거짓이다.
  const decimals = jetton.decimals;
  if (
    typeof decimals !== 'number' ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36
  ) {
    return null;
  }
  const symbol =
    typeof jetton.symbol === 'string' && jetton.symbol.length > 0
      ? jetton.symbol
      : null;
  if (symbol === null) return null;

  let id: string;
  try {
    id = TonAddress.parse(jetton.address).toString({
      bounceable: true,
      testOnly,
      urlSafe: true,
    });
  } catch {
    return null;
  }
  return {
    id,
    symbol,
    name:
      typeof jetton.name === 'string' && jetton.name.length > 0
        ? jetton.name
        : symbol,
    decimals,
    balance: BigInt(r.balance),
    // 체인이 아니라 인덱서가 말해준 값이다.
    source,
  };
}

/** URL 에서 호스트만. 파싱 실패하면 원본을 그대로 쓴다 (source 는 표시용). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

