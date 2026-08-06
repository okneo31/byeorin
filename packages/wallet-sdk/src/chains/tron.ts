// SIGNATURE FORMAT VERIFIED 2026-05-16:
// TronWeb v6 expects r(32)||s(32)||(recovery+27) — i.e. EVM-style v.
// SoftSigner emits raw `recovery` (0|1), so applySignatures must add 27
// before writing the last byte. Cross-checked against
// `tronweb/utils/crypto.signTransaction` (which calls ECKeySign:
// `r.padStart(64,'0') + s.padStart(64,'0') + byte2hexStr(recovery + 27)`).
// See tests/tron.test.ts "signature matches TronWeb's own signer".
import { toUncompressedSecp256k1 } from '../crypto/secp.js';
import type {
  PortableTokenBalance,
  TokenCapableAdapter,
} from '../tokens/portable.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';
import {
  lookupKnownTrc20,
  noteSymbolMismatch,
  reconcileKnownDecimals,
  type KnownTrc20,
} from './trc20-known.js';

// TronWeb v6 ships dual ESM/CJS but its types are loose.
// Use a typed dynamic import via createRequire-style namespace import
// and unwrap `.default` if present (CJS interop quirk).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as TronWebNs from 'tronweb';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const TronWebMod: any = (TronWebNs as any).TronWeb ?? (TronWebNs as any).default?.TronWeb ?? (TronWebNs as any).default ?? TronWebNs;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tronUtils: any = (TronWebNs as any).utils ?? (TronWebNs as any).default?.utils;

export type TronNetwork = 'mainnet' | 'shasta' | 'nile';

/**
 * 토큰 조회 중 생긴, 결과 배열만 봐서는 알 수 없는 사실.
 *
 * `discoverTokens` 는 실패를 던지지 않으므로(계약상 빈 배열), 무엇이 왜 빠졌는지
 * 알려줄 통로가 따로 필요하다. 조용히 버리면 사용자는 "내 토큰이 없어졌다"만 본다.
 */
export type TronTokenNotice =
  | {
      kind: 'truncated';
      /** TronGrid 가 준 (잔액 0 제외) 총 개수. */
      total: number;
      /** 그중 실제로 조회한 개수. */
      kept: number;
    }
  | {
      kind: 'dropped';
      /** 버린 토큰의 컨트랙트 주소. */
      contract: string;
      reason: 'decimals-unreadable' | 'decimals-out-of-range' | 'bad-balance';
    };

export interface TronAdapterOptions {
  network?: TronNetwork;
  fullHost?: string;
  /**
   * TRC-20 보유 목록을 물어볼 TronGrid 계정 API 의 base URL. 기본값은 `fullHost`.
   * fullHost 를 TronGrid 가 아닌 노드로 바꾼 경우 여기만 TronGrid 로 되돌릴 수 있다.
   */
  tokenApiUrl?: string;
  /** TronGrid API 키(`TRON-PRO-API-KEY`). 없으면 무기명 한도로 호출한다. */
  apiKey?: string;
  /** 주입 fetch (테스트용). 미지정 시 호출 시점의 globalThis.fetch. */
  fetch?: typeof fetch;
  /**
   * `discoverTokens` 가 메타데이터를 읽을 토큰 수 상한. 기본 20.
   * 토큰 1개당 계약 호출 3회(decimals/symbol/name)가 나가므로 그대로 왕복 수가 된다.
   */
  maxTokens?: number;
  /**
   * 이름표를 체인에서도 읽을지. 기본 false.
   *
   * 켜도 예전처럼 토큰마다 3 회를 쏘지 않는다 — decimals 를 전부 끝낸 **뒤에**
   * 잔액 큰 순으로 상위 `maxLabelLookups` 개만 symbol() 을 부른다(name() 은
   * 부르지 않는다. name 은 symbol 로 대체되므로 예산 2배를 쓸 이유가 없다).
   *
   * 주의: 이 옵션은 API 키와 무관하다. 키는 TronGrid REST(계정 API)에만 붙고
   * 계약 상수 호출은 tronweb 인스턴스를 타므로 키가 전달되지 않는다.
   * 내장 목록(trc20-known.ts)에 있는 토큰은 이 옵션과 상관없이 RPC 0 회로
   * 이름이 붙는다.
   */
  fetchLabels?: boolean;
  /**
   * `fetchLabels` 가 켜졌을 때 symbol() 을 부를 토큰 수 상한. 기본 5.
   *
   * `maxTokens` 와 분리한 이유: 이름표 예산이 decimals 예산을 잠식하면 안 된다.
   */
  maxLabelLookups?: number;
  /** TronGrid 계정 API 응답 대기 상한(ms). 기본 8000. */
  timeoutMs?: number;
  /** TRC-20 송금의 feeLimit(SUN). 기본 100 TRX. 근거는 DEFAULT_TRC20_FEE_LIMIT_SUN 주석. */
  feeLimitSun?: number;
  /** 조회 중 생긴 알림을 받는다. 미지정이어도 console.warn 은 남는다. */
  onTokenNotice?: (notice: TronTokenNotice) => void;
}

// TronWeb's transaction shape is loose. Keep it as `any` and document.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TronUnsignedTx { tx: any }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface TronSignedTx { tx: any; txid: string }

const DEFAULT_HOST: Record<TronNetwork, string> = {
  mainnet: 'https://api.trongrid.io',
  shasta: 'https://api.shasta.trongrid.io',
  nile: 'https://nile.trongrid.io',
};

/**
 * TRC-20 송금의 기본 feeLimit — 100 TRX(= 1e8 SUN).
 *
 * feeLimit 은 **반드시** 있어야 한다. triggerSmartContract 에서 빠지면 노드가
 * feeLimit 0 으로 취급해 브로드캐스트 즉시 OUT_OF_ENERGY 로 실패한다.
 *
 * 값의 근거: TRC-20 transfer 는 수신자가 그 토큰 잔액을 이미 갖고 있으면 대략
 * 1만~3만 energy, 처음 받는 주소면 그 두 배가량을 쓴다. energy 단가는 네트워크
 * 파라미터로 420 SUN/energy 수준이고(고정값 아님, 거버넌스로 바뀐다), USDT 처럼
 * 혼잡한 계약에는 동적 에너지 배수까지 붙는다. 6만 energy × 420 SUN ≈ 25 TRX 이고,
 * 배수와 향후 단가 인상까지 감안해 4배 여유를 둔 값이 100 TRX 다.
 *
 * 넉넉히 잡아도 손해가 아닌 이유: feeLimit 은 **상한**이고 실제 소비분만 청구된다.
 * 그래서 이 숫자는 "낼 돈"이 아니라 "실패해도 이 이상은 안 잃는다"는 선이다.
 * 위 수치는 관측 기반 추정이므로 정확한 값이 필요하면 `feeLimitSun` 으로 덮어써라.
 */
export const DEFAULT_TRC20_FEE_LIMIT_SUN = 100_000_000;

/** 토큰 1개당 계약 호출 1회(decimals)가 나가므로 상한이 곧 왕복 수다. */
const DEFAULT_MAX_TOKENS = 20;
/**
 * 이름표(symbol) 조회 상한. decimals 예산과 **분리**한다.
 *
 * 5 인 근거: 기본 총 호출이 21회(계정 API 1 + decimals 20)이고, 5 를 더하면
 * 26회 — 옛 3배안(61회)의 1/8 증가폭이다. 화면 상단에 뜨는 잔액 큰 몇 줄만
 * 덮으면 사용자가 실제로 보는 곳의 이름이 채워진다.
 */
const DEFAULT_MAX_LABEL_LOOKUPS = 5;
const DEFAULT_TIMEOUT_MS = 8000;

/** base58check 형식(T + 33자). Tron 주소의 정규 표기. */
const TRON_BASE58_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
/** 내부 hex 형식. 0x41… 도 실무에서 돌아다니므로 함께 받는다. */
const TRON_HEX_RE = /^(0x)?41[0-9a-fA-F]{40}$/;

/** TRC-20 표준 함수 시그니처. */
const SELECTOR_TRANSFER = 'transfer(address,uint256)';
const SELECTOR_DECIMALS = 'decimals()';
const SELECTOR_SYMBOL = 'symbol()';
const SELECTOR_NAME = 'name()';
/** 수동 추가에서만 쓴다. 목록 조회는 잔액을 TronGrid 계정 API 로 한꺼번에 받는다. */
const SELECTOR_BALANCE_OF = 'balanceOf(address)';

/** TronGrid `/v1/accounts/{addr}` 응답 중 우리가 쓰는 부분만 좁게 적는다. */
interface TronGridAccountRow {
  /** `[{ "T…컨트랙트": "잔액문자열" }, …]` — decimals 는 여기 없다. */
  trc20?: Array<Record<string, string>>;
}
interface TronGridAccountResponse {
  data?: TronGridAccountRow[];
}

/** trigger*Contract 응답 중 우리가 쓰는 부분. */
interface TronTriggerResult {
  result?: { result?: boolean; message?: string };
  constant_result?: string[];
  transaction?: unknown;
}

/** TronGrid 가 준 한 줄 — 아직 decimals 를 모르는 상태. */
interface RawTrc20Entry {
  contract: string;
  balance: bigint;
}

/** `source` 문자열의 재료. 2단계에서 갱신하므로 값이 아니라 상태로 들고 있는다. */
interface SourceOpts {
  symbolFromContract: boolean;
  nameFromContract: boolean;
  /** 이름표를 내장 목록에서 가져왔는지(=RPC 0회). */
  symbolFromKnown: boolean;
  /** decimals 대조 결과 등, 숨기면 안 되는 사실. */
  notes?: string[];
  truncation: { total: number; kept: number } | undefined;
}

/**
 * 1단계 결과 한 줄. 2단계(`fillLabels`)가 이름표를 덧칠할 수 있도록
 * 완성된 토큰과 그 재료를 함께 들고 있는다.
 */
interface Trc20MetaResult {
  token: PortableTokenBalance;
  /** 내장 목록에 있으면 2단계에서 건너뛴다 — 이미 이름이 있다. */
  known: KnownTrc20 | undefined;
  srcOpts: SourceOpts;
}

/**
 * TronAdapter — Tron mainnet/shasta/nile.
 *
 * Address derivation mirrors Ethereum's keccak trick but prepends 0x41
 * and base58check-encodes the result (21-byte raw → 25-byte with checksum).
 *
 * Sun caveat: 1 TRX = 1e6 SUN. TronWeb's `sendTrx` accepts a JS `number`
 * (safe up to ~9e15 SUN ≈ 9e9 TRX). We coerce bigint → Number and throw
 * if it would lose precision.
 */
export class TronAdapter
  implements ChainAdapter<TronUnsignedTx, TronSignedTx>, TokenCapableAdapter
{
  readonly id: string;
  readonly displayName: string;
  readonly curve = 'secp256k1' as const;
  readonly coinType = 195;
  readonly network: TronNetwork;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly tron: any;
  private readonly tokenApiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly maxTokens: number;
  private readonly fetchLabels: boolean;
  private readonly maxLabelLookups: number;
  private readonly timeoutMs: number;
  private readonly feeLimitSun: number;
  private readonly onTokenNotice: ((n: TronTokenNotice) => void) | undefined;

  constructor(opts: TronAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.id = `tron:${this.network}`;
    this.displayName =
      this.network === 'mainnet' ? 'TRON' : `TRON ${this.network}`;
    const host = opts.fullHost ?? DEFAULT_HOST[this.network];
    if (!TronWebMod) {
      throw new Error('tron: TronWeb module unavailable');
    }
    this.tron = new TronWebMod({ fullHost: host });
    this.tokenApiUrl = (opts.tokenApiUrl ?? host).replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch;
    this.maxTokens =
      opts.maxTokens !== undefined && opts.maxTokens > 0
        ? Math.floor(opts.maxTokens)
        : DEFAULT_MAX_TOKENS;
    this.fetchLabels = opts.fetchLabels === true;
    this.maxLabelLookups =
      opts.maxLabelLookups !== undefined && opts.maxLabelLookups >= 0
        ? Math.floor(opts.maxLabelLookups)
        : DEFAULT_MAX_LABEL_LOOKUPS;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.feeLimitSun = opts.feeLimitSun ?? DEFAULT_TRC20_FEE_LIMIT_SUN;
    this.onTokenNotice = opts.onTokenNotice;
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    const uncompressed = toUncompressedSecp256k1(pubkey);
    // computeAddress takes either 65-byte (with 0x04) or 64-byte (no prefix)
    // and returns 21 bytes: [0x41, ...keccak256(pub[1:])[-20:]].
    const addressBytes: number[] = tronUtils.crypto.computeAddress(
      Array.from(uncompressed),
    );
    return tronUtils.crypto.getBase58CheckAddress(addressBytes);
  }

  async getBalance(address: Address): Promise<bigint> {
    const sun = await this.tron.trx.getBalance(address);
    return BigInt(sun);
  }

  /**
   * `intent.asset` 이 있으면 TRC-20 계약 호출, 없으면 기존 native TRX 송금.
   *
   * 분기는 여기 한 곳뿐이다 — 새 메서드를 만들지 않는 이유는 화면이 "토큰 송금"과
   * "코인 송금"을 다른 코드로 부르지 않게 하기 위해서다.
   */
  async buildTransfer(
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<TronUnsignedTx> {
    if (intent.asset) {
      return this.buildTrc20Transfer(intent.asset, intent, ctx);
    }
    const sun = bigintToSafeNumber(intent.amount, 'tron sun');
    const tx = await this.tron.transactionBuilder.sendTrx(
      intent.to,
      sun,
      ctx.sender,
    );
    return { tx };
  }

  /**
   * TRC-20 `transfer(address,uint256)` 호출 트랜잭션을 만든다.
   *
   * 금액은 Number 로 내리지 않는다 — native 경로와 달리 TRC-20 은 decimals 18 짜리
   * 토큰이 흔해서 잔액이 쉽게 2^53 을 넘고, Number 를 거치면 조용히 자릿수가
   * 뭉개진다. ABI 인코더에 10진 문자열로 그대로 넘긴다.
   */
  private async buildTrc20Transfer(
    asset: string,
    intent: TransferIntent,
    ctx: TxContext,
  ): Promise<TronUnsignedTx> {
    if (intent.amount <= 0n) {
      throw new Error('tron trc20: amount must be > 0');
    }
    // 주소 형식 변환은 전부 여기서 끝낸다. base58 T… 을 그대로 ABI 에 넣으면
    // 인코더 구현에 따라 다른 주소가 될 수 있으므로 41… hex 로 못박는다.
    // 변환 함수는 base58check 체크섬을 검증하고 왕복 일치까지 확인한다.
    const contract = this.normalizeAddress(asset, 'asset');
    const to = this.normalizeAddress(intent.to, 'to');
    const owner = this.normalizeAddress(ctx.sender, 'sender');

    const res: TronTriggerResult =
      await this.tron.transactionBuilder.triggerSmartContract(
        contract.hex,
        SELECTOR_TRANSFER,
        // feeLimit 은 선택 항목이 아니다 — DEFAULT_TRC20_FEE_LIMIT_SUN 주석 참고.
        // callValue 0: TRC-20 전송에 TRX 를 함께 보내지 않는다.
        { feeLimit: this.feeLimitSun, callValue: 0 },
        [
          { type: 'address', value: to.hex },
          { type: 'uint256', value: intent.amount.toString() },
        ],
        owner.hex,
      );

    if (res?.result?.result !== true || !res.transaction) {
      const msg = res?.result?.message ?? 'unknown';
      throw new Error(`tron trc20: triggerSmartContract failed (${msg})`);
    }
    return { tx: res.transaction };
  }

  /**
   * 이 주소가 보유한 TRC-20 을 돌려준다.
   *
   * 호출 구성 (토큰 N 개 기준 왕복 1 + 3N):
   *   1. TronGrid `GET /v1/accounts/{addr}` 1회 — 보유 목록과 잔액을 한 번에 받는다.
   *      컨트랙트를 하나씩 balanceOf 로 물어보지 않는다.
   *   2. 토큰마다 계약 상수 호출 3회 — decimals()/symbol()/name().
   *      TronGrid 응답에 decimals 가 없어서 어쩔 수 없다.
   *
   * 실패는 던지지 않고 빈 배열. 일부 토큰만 실패하면 성공한 것만 돌려준다.
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    try {
      const ownerAddr = this.normalizeAddress(owner, 'owner');
      const all = await this.fetchTrc20Balances(ownerAddr.base58);
      if (all.length === 0) return [];

      const kept = all.slice(0, this.maxTokens);
      const truncation =
        kept.length < all.length
          ? { total: all.length, kept: kept.length }
          : undefined;
      if (truncation) {
        // 조용히 자르지 않는다: 알림 + console.warn + 남은 항목의 source 표시.
        this.notice({ kind: 'truncated', ...truncation });
      }

      // **순차 처리한다.** 병렬로 쏘면 무키 TronGrid 의 연속 호출 한도(실측 3회)를
      // 즉시 넘겨 대부분이 실패한다. 느려도 결과가 나오는 편이 낫다 — 빠르게
      // 아무것도 못 가져오는 것은 빠른 게 아니다.
      //
      // 한 토큰이 실패해도 다음으로 넘어간다(부분 성공 허용).
      const results: Array<Trc20MetaResult | null> = [];
      for (const e of kept) {
        results.push(await this.readTrc20Metadata(ownerAddr.base58, e, truncation));
      }
      const alive = results.filter((r): r is Trc20MetaResult => r !== null);

      // **2단계 — decimals 가 전부 끝난 뒤에만 시작한다.**
      // 여기서 무슨 일이 나도 위 배열은 손대지 않는다. 이름표는 없어도 되지만
      // decimals 는 없으면 그 토큰이 사라지기 때문이다.
      await this.fillLabels(ownerAddr.base58, alive);

      return alive.map((r) => r.token);
    } catch {
      // 목록을 못 만들어도 지갑은 열려야 한다.
      return [];
    }
  }

  /**
   * 컨트랙트 주소 하나를 받아 그 TRC-20 이 무엇인지 체인에서 읽는다. **수동 추가용.**
   *
   * 호출 구성 — **계약 상수 호출 최대 4회, 순차.** 순서가 곧 우선순위다:
   *   1. `decimals()`   — 없으면 이 토큰은 등록 자체가 불가능하다.
   *   2. `balanceOf(owner)` — 화면에 숫자로 뜨는 값.
   *   3. `symbol()`     — 없으면 주소 축약으로 대체된다.
   *   4. `name()`       — 없으면 symbol 로 대체된다.
   *
   * **왜 목록 조회(`discoverTokens`)와 예산 정책이 다른가.**
   * 실측(2026-07-29): 무키 TronGrid 는 연속 3 회까지만 받고 4 회째부터 거부하며
   * 2 초를 기다려도 회복되지 않는다. 그래서 `discoverTokens` 는 토큰마다 `decimals`
   * 한 번만 쓴다 — 토큰 수만큼 곱해지기 때문이다. 하지만 수동 추가는 **토큰 한
   * 개짜리 단발 요청**이라 곱해지지 않는다. 사용자가 명시적으로 "이 토큰을 추가해
   * 달라"고 한 한 건이므로, 예산을 아껴 주소 축약을 보여주는 것보다 symbol/name 까지
   * 읽어 제대로 보여주는 편이 낫다.
   *
   * 그래도 4 회째(`name`)는 무키 환경에서 거부될 수 있다. 그 순서로 둔 이유가
   * 그것이다 — 잘려도 잃는 것이 가장 적은 항목을 마지막에 둔다. 잔액을 계약에
   * 직접 묻는 이유도 같다: TronGrid 목록은 수동 추가가 필요해진 바로 그 상황
   * (목록에 안 나옴)에서 0 을 돌려주므로, 그 값을 잔액이라고 보여주면 거짓이 된다.
   *
   * 실패의 종류:
   *   - **주소 형식/체크섬이 틀리면 던진다.** 사용자가 방금 붙여넣은 문자열이
   *     주소가 아니라는 사실은 즉시 알려줘야 한다. `normalizeAddress` 가 base58check
   *     검증과 왕복 일치까지 확인하므로 오타 주소는 여기서 걸린다.
   *   - **decimals 를 못 읽으면 null.** TRC-20 이 아닌 계약이거나 존재하지 않는
   *     주소가 여기 해당한다. 6/18 로 추측하지 않는다 — 자릿수가 틀리면 잔액이
   *     통째로 거짓이 되는데 사용자는 그걸 알아채지 못한다.
   */
  async readToken(id: string, owner: string): Promise<PortableTokenBalance | null> {
    // 던진다. 형식 오류는 사용자가 고칠 수 있는 문제이고, 이 경로는 사용자가
    // 명시적으로 요청한 단발 동작이라 이유를 알려주는 편이 낫다.
    const contract = this.normalizeAddress(id, 'token');
    // owner 도 여기서 검증한다 — 상수 호출에 owner_address 가 필수라 우회할 수 없다.
    const ownerAddr = this.normalizeAddress(owner, 'owner');

    const decRaw = await this.constantCall(
      ownerAddr.base58,
      contract.base58,
      SELECTOR_DECIMALS,
    );
    const known = lookupKnownTrc20(contract.base58);
    const decimalsBig = decRaw === null ? null : decodeAbiUint(decRaw);
    const onChainDec =
      decimalsBig === null || decimalsBig < 0n || decimalsBig > 36n
        ? null
        : Number(decimalsBig);
    // 체인값 우선. 못 읽었을 때만 내장 폴백을 쓰고 미검증임을 source 에 남긴다.
    const rec = reconcileKnownDecimals(known, onChainDec);
    if (rec.decimals === null) {
      // 자릿수를 모르면 등록하지 않는다. (범위 밖 값도 신뢰할 수 없으므로 같은 처리.)
      return null;
    }

    // **순차 호출.** 병렬로 쏘면 무키 TronGrid 의 연속 호출 한도를 즉시 넘겨
    // 뒤쪽이 통째로 실패한다 — discoverTokens 가 같은 이유로 순차다.
    const balRaw = await this.constantCall(
      ownerAddr.base58,
      contract.base58,
      SELECTOR_BALANCE_OF,
      // hex(41…) 로 넘긴다. base58 을 그대로 주면 인코더 구현에 따라 다른 주소가 된다.
      [{ type: 'address', value: ownerAddr.hex }],
    );
    const balance = balRaw === null ? null : decodeAbiUint(balRaw);

    const symRaw = await this.constantCall(
      ownerAddr.base58,
      contract.base58,
      SELECTOR_SYMBOL,
    );
    const symbol = symRaw === null ? null : decodeAbiString(symRaw);

    const nameRaw = await this.constantCall(
      ownerAddr.base58,
      contract.base58,
      SELECTOR_NAME,
    );
    const name = nameRaw === null ? null : decodeAbiString(nameRaw);

    const fallback = shortenAddress(contract.base58);
    return {
      // 그대로 TransferIntent.asset 에 넣으면 송금이 된다. 0x41… hex 로 넣었어도
      // base58 정본으로 돌려줘 조회와 송금이 같은 문자열을 보게 한다.
      id: contract.base58,
      // 체인 → 내장 목록 → 주소축약. 체인이 먼저인 이유는 내장 목록이 낡을 수
      // 있어서고, 내장 목록이 축약보다 먼저인 이유는 축약은 정보가 아니어서다.
      symbol: symbol ?? known?.symbol ?? fallback,
      name: name ?? known?.name ?? symbol ?? fallback,
      decimals: rec.decimals,
      // 잔액을 못 구해도 등록 자체는 되게 한다 — 아직 안 받은 토큰을 미리 등록하는
      // 것은 정상이다. 다만 0 의 출처가 무엇인지는 source 에 남긴다.
      balance: balance ?? 0n,
      source: buildManualSource({
        balanceFromContract: balance !== null,
        symbolFromContract: symbol !== null,
        nameFromContract: name !== null,
        symbolFromKnown: symbol === null && known !== undefined,
        nameFromKnown: name === null && known !== undefined,
        notes: [rec.note, noteSymbolMismatch(known, symbol)].filter(
          (n): n is string => n !== undefined,
        ),
      }),
    };
  }

  /**
   * TronGrid 계정 API 에서 (컨트랙트, 잔액) 쌍을 뽑는다.
   *
   * 잔액 0 인 항목은 여기서 버린다 — 남기면 그것 때문에 계약 호출 3회가 더 나가고,
   * 화면에는 0 만 늘어난다. "전부 보기"가 필요해지면 그때 옵션으로 연다.
   */
  private async fetchTrc20Balances(
    ownerBase58: string,
  ): Promise<RawTrc20Entry[]> {
    const f =
      this.fetchImpl ??
      (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) return [];

    const url = `${this.tokenApiUrl}/v1/accounts/${ownerBase58}`;
    // AbortController 로 소켓까지 끊는다. race 만 쓰면 요청은 계속 살아 있다.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (this.apiKey) headers['TRON-PRO-API-KEY'] = this.apiKey;
      const res = await f(url, { headers, signal: ctl.signal });
      if (!res.ok) return [];
      const body = (await res.json()) as TronGridAccountResponse;
      const row = Array.isArray(body?.data) ? body.data[0] : undefined;
      const list = row && Array.isArray(row.trc20) ? row.trc20 : [];

      const out: RawTrc20Entry[] = [];
      const seen = new Set<string>();
      for (const item of list) {
        if (typeof item !== 'object' || item === null) continue;
        for (const [rawContract, rawBalance] of Object.entries(item)) {
          // TronGrid 는 base58 로 주지만 hex 로 주는 배포본도 있어 둘 다 받는다.
          let contract: string;
          try {
            contract = this.normalizeAddress(rawContract, 'contract').base58;
          } catch {
            continue;
          }
          if (seen.has(contract)) continue;
          if (typeof rawBalance !== 'string' || !/^\d+$/.test(rawBalance)) {
            this.notice({ kind: 'dropped', contract, reason: 'bad-balance' });
            continue;
          }
          const balance = BigInt(rawBalance);
          seen.add(contract);
          if (balance === 0n) continue;
          out.push({ contract, balance });
        }
      }
      return out;
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 컨트랙트에서 decimals/symbol/name 을 읽어 PortableTokenBalance 를 완성한다.
   *
   * decimals 를 못 읽으면 **버린다.** 6 이나 18 로 추측하면 잔액이 자릿수째로
   * 거짓이 되고, 그 거짓은 화면에서 구별되지 않는다. symbol/name 은 틀려도
   * 금액을 왜곡하지 않으므로, 못 읽으면 주소 축약으로 대체하고 source 에 남긴다.
   */
  private async readTrc20Metadata(
    ownerBase58: string,
    entry: RawTrc20Entry,
    truncation: { total: number; kept: number } | undefined,
  ): Promise<Trc20MetaResult | null> {
    // **decimals 만 먼저, 단독으로.**
    //
    // 실측(2026-07-29): 무키 TronGrid 는 연속 3 회까지만 받고 4 회째부터 거부한다.
    // 예전에는 토큰마다 decimals/symbol/name 3 회를 한꺼번에 쐈고, 그래서 첫
    // 토큰만 성공하고 나머지는 전부 `decimals-unreadable` 로 버려졌다 — 실제
    // 주소로 조회하면 880 개 중 0 개가 나왔다. 모킹 테스트로는 잡히지 않는다.
    //
    // 잔액을 옳게 보여주는 데 반드시 필요한 것은 decimals 뿐이다. symbol/name 은
    // 없으면 주소 축약으로 대체할 수 있으므로, 예산을 decimals 에 먼저 쓴다.
    const decRaw = await this.constantCall(ownerBase58, entry.contract, SELECTOR_DECIMALS);

    const known = lookupKnownTrc20(entry.contract);
    const decimalsBig = decRaw === null ? null : decodeAbiUint(decRaw);
    // 범위 밖 값은 읽지 못한 것과 같이 취급한다 — portable.ts 의 검증 상한과 같은
    // 선이고, 벗어난 값을 그대로 쓰면 잔액이 자릿수째로 거짓이 된다.
    const outOfRange =
      decimalsBig !== null && (decimalsBig < 0n || decimalsBig > 36n);
    const onChain = decimalsBig === null || outOfRange ? null : Number(decimalsBig);
    // 체인값이 항상 이긴다. 내장값은 체인을 못 읽었을 때만, 그 사실을 적어서 쓴다.
    const rec = reconcileKnownDecimals(known, onChain);
    if (rec.decimals === null) {
      this.notice({
        kind: 'dropped',
        contract: entry.contract,
        reason: outOfRange ? 'decimals-out-of-range' : 'decimals-unreadable',
      });
      return null;
    }

    // 이름표는 **이 루프에서 한 번도 조회하지 않는다.**
    //
    // 실측(2026-07-29): 무키 TronGrid 는 IP 할당량을 금방 소진하고, 소진되면
    // 2 초를 기다려도 회복되지 않는다. 토큰마다 symbol/name 까지 부르면 예산이
    // 3 배로 나가 대부분의 토큰이 decimals 조차 못 읽고 버려진다 — 실제 주소로
    // 880 개 중 0 개가 나왔다. 이름표가 필요하면 decimals 를 전부 끝낸 뒤
    // `fillLabels` 가 별도로 가져온다.
    //
    // 대신 주소가 고정된 유명 토큰은 **RPC 0 회**로 이름이 붙는다. 그 주소가
    // 무엇인지는 체인에 물어보지 않아도 아는 공개 사실이기 때문이다.
    const fallback = shortenAddress(entry.contract);
    const srcOpts: SourceOpts = {
      symbolFromContract: false,
      nameFromContract: false,
      symbolFromKnown: known !== undefined,
      notes: rec.note ? [rec.note] : [],
      truncation,
    };

    return {
      token: {
        id: entry.contract, // 그대로 TransferIntent.asset 에 넣으면 송금이 된다.
        symbol: known?.symbol ?? fallback,
        name: known?.name ?? known?.symbol ?? fallback,
        decimals: rec.decimals,
        balance: entry.balance,
        source: buildSource(srcOpts),
      },
      known,
      srcOpts,
    };
  }

  /**
   * 2단계 — 이름표가 아직 축약 주소인 토큰의 symbol() 만 뒤늦게 채운다.
   *
   * 규칙 4가지. 전부 예산 때문이다:
   *   1. decimals 루프가 **끝난 뒤에만** 부른다(호출자가 순서를 지킨다).
   *   2. `fetchLabels` 가 켜졌을 때만. 기본값은 여전히 추가 호출 0 회다.
   *   3. `name()` 은 부르지 않는다 — 이름 칸은 symbol 로 대체되므로,
   *      호출 1 회당 이름표 1 칸이 채워지는 쪽이 예산 대비 두 배 낫다.
   *   4. 내장 목록으로 이미 이름이 붙은 토큰은 건너뛴다.
   *
   * 잔액 큰 순인 이유: 화면 위쪽, 즉 사용자가 실제로 보는 줄이 먼저 이름을
   * 얻는다. 정렬은 decimals 를 아는 지금 시점에 해야 자릿수가 다른 토큰끼리
   * 비교가 어긋나지 않는다.
   *
   * 실패는 전부 삼킨다. 이름표를 못 얻는 것은 축약 주소로 되돌아가는 것뿐이다.
   */
  private async fillLabels(
    ownerBase58: string,
    results: Trc20MetaResult[],
  ): Promise<void> {
    if (!this.fetchLabels || this.maxLabelLookups <= 0) return;

    const targets = results
      .filter((r) => r.known === undefined)
      .sort((a, b) => {
        const av = scaleDown(a.token.balance, a.token.decimals);
        const bv = scaleDown(b.token.balance, b.token.decimals);
        return av === bv ? 0 : av < bv ? 1 : -1;
      })
      .slice(0, this.maxLabelLookups);

    // 순차. 병렬로 쏘면 실측 3 회 한도를 즉시 밟는다.
    for (const r of targets) {
      let symbol: string | null = null;
      try {
        const raw = await this.constantCall(
          ownerBase58,
          r.token.id,
          SELECTOR_SYMBOL,
        );
        symbol = raw === null ? null : decodeAbiString(raw);
      } catch {
        symbol = null;
      }
      if (symbol === null || symbol === '') continue;
      r.token.symbol = symbol;
      r.token.name = symbol;
      r.srcOpts.symbolFromContract = true;
      r.token.source = buildSource(r.srcOpts);
    }
  }

  /**
   * 계약 상수 호출 1회. 실패하면 던지지 않고 null — 부분 실패를 허용한다.
   *
   * `params` 는 기본 빈 배열이라 무인자 호출(decimals/symbol/name)은 예전 그대로다.
   * `balanceOf(address)` 처럼 인자가 있는 호출만 넘겨 쓴다.
   */
  private async constantCall(
    ownerBase58: string,
    contractBase58: string,
    selector: string,
    params: ReadonlyArray<{ type: string; value: string }> = [],
  ): Promise<string | null> {
    try {
      const res: TronTriggerResult =
        await this.tron.transactionBuilder.triggerConstantContract(
          contractBase58,
          selector,
          {},
          [...params],
          // owner_address 는 상수 호출에도 필수다. 비워두면 노드가 거절한다.
          ownerBase58,
        );
      if (res?.result?.result !== true) return null;
      const cr = res.constant_result;
      if (!Array.isArray(cr)) return null;
      const first = cr[0];
      return typeof first === 'string' && first.length > 0 ? first : null;
    } catch {
      return null;
    }
  }

  /**
   * 주소를 base58/hex 양쪽으로 정규화한다.
   *
   * 여기서 틀리면 남의 주소로 보낸다. 그래서 (1) 형식을 정규식으로 먼저 거르고,
   * (2) TronWeb 변환을 태우고, (3) 되돌려서 원본과 같은지 확인한다. base58check
   * 체크섬은 decodeBase58Address 가 검사하므로 오타 주소는 여기서 걸린다.
   */
  private normalizeAddress(
    addr: string,
    label: string,
  ): { base58: string; hex: string } {
    if (typeof addr !== 'string' || addr.length === 0) {
      throw new Error(`tron: ${label} address is empty`);
    }
    let base58: string;
    if (TRON_BASE58_RE.test(addr)) {
      base58 = addr;
    } else if (TRON_HEX_RE.test(addr)) {
      // TronWeb 의 fromHex 는 앞의 '0x' 를 '41' 로 **치환**한다. '0x41…' 을 그대로
      // 넘기면 '4141…' 이 되어 전혀 다른 주소가 나오므로 0x 는 우리가 먼저 뗀다.
      const hex = addr.replace(/^0x/, '');
      try {
        base58 = this.tron.address.fromHex(hex) as string;
      } catch {
        throw new Error(`tron: ${label} address is not convertible: ${addr}`);
      }
    } else {
      throw new Error(`tron: ${label} address has unknown format: ${addr}`);
    }

    let hex: string;
    try {
      hex = (this.tron.address.toHex(base58) as string).toLowerCase();
    } catch {
      throw new Error(`tron: ${label} address failed base58check: ${addr}`);
    }
    if (!TRON_HEX_RE.test(hex) || this.tron.address.fromHex(hex) !== base58) {
      throw new Error(`tron: ${label} address roundtrip mismatch: ${addr}`);
    }
    return { base58, hex };
  }

  private notice(n: TronTokenNotice): void {
    // eslint-disable-next-line no-console
    console.warn(`[tron:discoverTokens] ${describeNotice(n)}`);
    this.onTokenNotice?.(n);
  }

  async signRequests(tx: TronUnsignedTx): Promise<SignRequest[]> {
    // The signing target is sha256(raw_data_hex), which Tron precomputes
    // and exposes as `txID`. Convert hex → bytes.
    const txid: string = tx.tx.txID;
    if (typeof txid !== 'string' || txid.length !== 64) {
      throw new Error('tron: malformed unsigned tx (missing/bad txID)');
    }
    return [{ message: hexToBytes(txid), prehashed: true }];
  }

  async applySignatures(
    tx: TronUnsignedTx,
    signatures: Uint8Array[],
  ): Promise<TronSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`tron: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 65) {
      throw new Error(
        `tron: secp256k1 signature must be 65 bytes (r||s||v), got ${signature.length}`,
      );
    }
    // SoftSigner emits the last byte as raw recovery (0 or 1).
    // TronWeb's reference signer encodes the last byte as (recovery + 27)
    // — see ECKeySign in tronweb/utils/crypto.js. Normalize here so a
    // raw `recovery >= 2` is rejected and a `27/28` byte from a hardware
    // signer that already encoded `v` is left untouched.
    const recoveryRaw = signature[64] as number;
    let v: number;
    if (recoveryRaw === 0 || recoveryRaw === 1) {
      v = recoveryRaw + 27;
    } else if (recoveryRaw === 27 || recoveryRaw === 28) {
      v = recoveryRaw;
    } else {
      throw new Error(
        `tron: signature recovery byte must be 0|1|27|28, got ${recoveryRaw}`,
      );
    }
    const normalized = new Uint8Array(signature);
    normalized[64] = v;
    const hex = bytesToHex(normalized);
    tx.tx.signature = [hex];
    return { tx: tx.tx, txid: tx.tx.txID };
  }

  async broadcast(tx: TronSignedTx): Promise<TxHash> {
    await this.tron.trx.sendRawTransaction(tx.tx);
    return tx.txid;
  }
}

/**
 * `source` 문자열을 만든다.
 *
 * 목록과 잔액은 체인에서 직접 읽은 것이 아니라 **TronGrid 가 말해준 값**이다.
 * 신뢰도가 다르므로 숨기지 않는다. decimals/symbol 은 계약에서 읽었다는 사실,
 * symbol 을 못 읽어 주소로 대체했다는 사실, 상한에 걸려 목록이 잘렸다는 사실도
 * 같은 문자열에 담는다 — 화면이 배열 하나만 받아도 다 알 수 있어야 한다.
 */
function buildSource(o: SourceOpts): string {
  const parts = ['trongrid:/v1/accounts(목록·잔액)'];
  const read = ['decimals'];
  if (o.symbolFromContract) read.push('symbol');
  if (o.nameFromContract) read.push('name');
  parts.push(`contract:${read.join(',')}`);
  // 내장 목록에서 온 이름표는 그렇다고 적는다 — 어디서 온 값인지 화면이 알 수
  // 있어야 한다. 체인에서 읽은 값과 같은 표기로 뭉뚱그리지 않는다.
  if (!o.symbolFromContract && o.symbolFromKnown) {
    parts.push('symbol,name=내장목록(RPC 0회)');
  } else {
    if (!o.symbolFromContract) parts.push('symbol=주소축약(읽기실패)');
    if (!o.nameFromContract) parts.push('name=대체(읽기실패)');
  }
  for (const n of o.notes ?? []) parts.push(n);
  if (o.truncation) {
    parts.push(`truncated:${o.truncation.kept}/${o.truncation.total}`);
  }
  return parts.join('; ');
}

/**
 * 수동 추가(`readToken`)의 `source`.
 *
 * 목록 조회와 문자열을 나누는 이유: 이쪽은 목록도 잔액도 TronGrid 가 말해준 값이
 * 아니라 **전부 계약에서 직접 읽은 값**이다. 신뢰도가 다르므로 같은 표기로
 * 뭉뚱그리지 않는다. 무엇을 못 읽어 대체했는지도 같은 줄에 남긴다.
 */
function buildManualSource(o: {
  balanceFromContract: boolean;
  symbolFromContract: boolean;
  nameFromContract: boolean;
  symbolFromKnown?: boolean;
  nameFromKnown?: boolean;
  notes?: string[];
}): string {
  const read = ['decimals'];
  if (o.balanceFromContract) read.push('balanceOf');
  if (o.symbolFromContract) read.push('symbol');
  if (o.nameFromContract) read.push('name');
  const parts = [`contract:${read.join(',')}`];
  if (!o.balanceFromContract) parts.push('balance=0(조회실패)');
  if (!o.symbolFromContract) {
    parts.push(o.symbolFromKnown ? 'symbol=내장목록' : 'symbol=주소축약(읽기실패)');
  }
  if (!o.nameFromContract) {
    parts.push(o.nameFromKnown ? 'name=내장목록' : 'name=대체(읽기실패)');
  }
  for (const n of o.notes ?? []) parts.push(n);
  return parts.join('; ');
}

function describeNotice(n: TronTokenNotice): string {
  return n.kind === 'truncated'
    ? `토큰 ${n.total}개 중 ${n.kept}개만 조회 (maxTokens 상한)`
    : `${n.contract} 제외 — ${n.reason}`;
}

/**
 * 이름표 우선순위를 정하려고 잔액을 자릿수로 나눈 정수부만 뽑는다.
 *
 * raw 잔액끼리 비교하면 decimals 가 다른 토큰 사이에서 순서가 뒤집힌다
 * (6자리 1 USDT 와 18자리 0.000001 토큰). 화면 정렬용이 아니라 예산 배분용
 * 비교이므로 소수부는 버려도 된다.
 */
function scaleDown(balance: bigint, decimals: number): bigint {
  if (decimals <= 0) return balance;
  return balance / 10n ** BigInt(decimals);
}

/** `TR7NHq…LjLj6t` 꼴. symbol 을 못 읽었을 때 지어내는 대신 쓴다. */
function shortenAddress(addr: string): string {
  return addr.length <= 12 ? addr : `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** ABI 반환값의 첫 32바이트 워드를 uint 로 읽는다. */
function decodeAbiUint(hex: string): bigint | null {
  const h = stripHexPrefix(hex);
  if (h.length < 64 || !/^[0-9a-fA-F]+$/.test(h)) return null;
  try {
    return BigInt(`0x${h.slice(0, 64)}`);
  } catch {
    return null;
  }
}

/**
 * ABI 반환값을 문자열로 읽는다.
 *
 * 표준 TRC-20 은 동적 string(오프셋+길이+데이터)을 주지만, 구형 ERC-20 을 그대로
 * 베낀 토큰은 bytes32 를 준다. 후자는 결과가 정확히 32바이트라 구분된다.
 * 못 읽으면 null — 여기서 지어내면 화면에 가짜 이름이 뜬다.
 */
function decodeAbiString(hex: string): string | null {
  const h = stripHexPrefix(hex);
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) {
    return null;
  }
  if (h.length === 64) {
    // bytes32: 뒤쪽 0 패딩을 떼고 UTF-8 로 읽는다.
    return sanitizeText(hexToUtf8(h.replace(/(00)+$/, '')));
  }
  if (h.length < 128) return null;
  const offset = Number(BigInt(`0x${h.slice(0, 64)}`));
  const lenAt = offset * 2;
  if (!Number.isSafeInteger(offset) || lenAt + 64 > h.length) return null;
  const len = Number(BigInt(`0x${h.slice(lenAt, lenAt + 64)}`));
  // 1KB 를 넘는 symbol/name 은 정상이 아니다. 화면을 밀어버리기 전에 막는다.
  if (!Number.isSafeInteger(len) || len === 0 || len > 1024) return null;
  const data = h.slice(lenAt + 64, lenAt + 64 + len * 2);
  if (data.length !== len * 2) return null;
  return sanitizeText(hexToUtf8(data));
}

function hexToUtf8(hex: string): string {
  if (hex.length === 0) return '';
  return new TextDecoder('utf-8').decode(hexToBytes(hex));
}

/**
 * 계약이 준 텍스트를 그대로 믿지 않는다. 제어문자(줄바꿈으로 UI 를 깨거나 다른
 * 토큰인 척하는 데 쓰인다)를 지우고 길이를 자른다. 남는 게 없으면 null.
 */
function sanitizeText(s: string): string | null {
  // 제어문자는 정규식 대신 코드포인트로 거른다 — 소스에 제어문자를 직접
  // 적으면 파일 자체가 오염된다.
  let cleaned = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    cleaned += ch;
  }
  cleaned = cleaned.trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

function stripHexPrefix(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
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

function hexToBytes(hex: string): Uint8Array {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) throw new Error('tron: bad hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) {
    s += (b[i] as number).toString(16).padStart(2, '0');
  }
  return s;
}
