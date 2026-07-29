import {
  Client,
  deriveAddress,
  encode,
  encodeForSigning,
  hashes,
  isValidClassicAddress,
} from 'xrpl';
import type {
  AccountLinesRequest,
  AccountLinesResponse,
  AccountLinesTrustline,
  IssuedCurrencyAmount,
  Payment,
} from 'xrpl';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { toCompressedSecp256k1 } from '../crypto/secp.js';
import { withTimeout } from '../transports/rpc-fallback.js';
import type { PortableTokenBalance, TokenCapableAdapter } from '../tokens/portable.js';
import type { Address, TransferIntent, TxHash } from '../types.js';
import type { ChainAdapter, SignRequest, TxContext } from './chain.js';

export type XrpNetwork = 'mainnet' | 'testnet';

export interface XrpAdapterOptions {
  network?: XrpNetwork;
  wsUrl?: string;
  /** trust line 조회 상한(ms). 기본 8000 — 지갑 첫 화면을 막으면 안 된다. */
  tokenTimeoutMs?: number;
}

/**
 * XRPL issued currency 잔액을 bigint 로 옮길 때 쓰는 **고정 자릿수 15**.
 *
 * 왜 고정값을 정해야 하나: XRPL 의 issued currency 에는 decimals 개념이 아예
 * 없다. 발행자가 자릿수를 선언하지 않고, 잔액은 `"12.3456"` 같은 십진 문자열
 * (54비트 가수 + 지수의 부동소수 STAmount)로 온다. 반면
 * `PortableTokenBalance.balance` 는 bigint 이므로 "소수점 이하 몇 자리를 정수로
 * 볼지"를 우리가 반드시 정해야 한다.
 *
 * 15 인 근거: STAmount 의 유효숫자가 15~16 자리다. 소수점 이하를 15 자리까지
 * 담으면 실제로 유통되는 잔액은 정보 손실 없이 정수로 옮겨진다. 더 늘려도 원본에
 * 없던 정밀도를 지어내는 것이고, 줄이면 소수 단위 토큰이 잘린다.
 *
 * 대가를 숨기지 않는다:
 *   - 절댓값이 1e-15 미만인 잔액은 **0 으로 내림**된다.
 *   - 이 자릿수는 **우리 표현 규약이지 체인이 말한 사실이 아니다.** 송금할 때는
 *     다시 십진 문자열로 되돌려 보내므로 조회→송금 왕복은 정확하다.
 */
export const XRP_ISSUED_DECIMALS = 15;

/** XRPL 이 issued currency `value` 에 허용하는 최대 유효숫자 (ripple-binary-codec 기준). */
const XRP_MAX_IOU_PRECISION = 16;

/** account_lines 한 페이지 크기와 최대 페이지 수 (무한 루프 방지). */
const ACCOUNT_LINES_PAGE = 400;
const ACCOUNT_LINES_MAX_PAGES = 10;

export interface XrpUnsignedTx {
  tx: Payment;
}

export interface XrpSignedTx {
  txBlob: string;
  hash: string;
}

const DEFAULT_WS_URL: Record<XrpNetwork, string> = {
  mainnet: 'wss://xrplcluster.com',
  testnet: 'wss://s.altnet.rippletest.net:51233',
};

export class XrpAdapter
  implements ChainAdapter<XrpUnsignedTx, XrpSignedTx>, TokenCapableAdapter
{
  readonly curve = 'secp256k1' as const;
  readonly coinType = 144;
  readonly id: string;
  readonly displayName = 'XRP Ledger';
  readonly network: XrpNetwork;
  readonly wsUrl: string;
  readonly tokenTimeoutMs: number;

  private _client: Client | null = null;

  constructor(opts: XrpAdapterOptions = {}) {
    this.network = opts.network ?? 'mainnet';
    this.wsUrl = opts.wsUrl ?? DEFAULT_WS_URL[this.network];
    this.id = `xrp:${this.network}`;
    this.tokenTimeoutMs = opts.tokenTimeoutMs ?? 8_000;
  }

  derivationPath(account = 0, index = 0): string {
    return `m/44'/${this.coinType}'/${account}'/0/${index}`;
  }

  pubkeyToAddress(pubkey: Uint8Array): Address {
    const compressed = toCompressedSecp256k1(pubkey);
    return deriveAddress(bytesToHex(compressed).toUpperCase());
  }

  async getBalance(address: Address): Promise<bigint> {
    const client = await this.client();
    try {
      const xrp = await client.getXrpBalance(address);
      // getXrpBalance returns a decimal XRP number (string-parsed to JS number).
      // Convert to drops (1 XRP = 1_000_000 drops) without floating-point loss.
      return xrpToDrops(xrp);
    } catch (err: unknown) {
      if (isActNotFound(err)) return 0n;
      throw err;
    }
  }

  /**
   * 이 계정의 issued currency(= trust line) 잔액 전부.
   *
   * 출처는 **체인 직접 조회**다 — `account_lines` 한 방이면 rippled 가 trust line 을
   * 전부 준다. 인덱서가 필요 없으므로 `source` 를 비워 둔다(= 체인 자체).
   *
   * 잔액 0 인 trust line 도 포함한다. XRPL 의 trust line 은 사용자가 준비금(reserve)
   * 을 걸고 **명시적으로 개설한 것**이라, 0 이어도 "내가 다루는 토큰"으로 보는 편이
   * 사용자 인식에 맞다 (Solana 의 ATA 와 같은 취급).
   *
   * 잔액이 음수인 줄은 버린다. 음수는 이 계정이 상대편 관점에서 발행자라 **빚을 진**
   * 상태이고, 보낼 수 있는 자산이 아니다. (PortableTokenBalance.balance 도 >= 0 만
   * 허용한다.)
   */
  async discoverTokens(owner: string): Promise<PortableTokenBalance[]> {
    try {
      const client = await this.client();
      const out: PortableTokenBalance[] = [];
      let marker: unknown;
      for (let page = 0; page < ACCOUNT_LINES_MAX_PAGES; page++) {
        const req: AccountLinesRequest = {
          command: 'account_lines',
          account: owner,
          ledger_index: 'validated',
          limit: ACCOUNT_LINES_PAGE,
          ...(marker !== undefined ? { marker } : {}),
        };
        // WebSocket 은 응답이 안 오면 그대로 매달린다. 호출 단위 상한을 건다.
        const res = await withTimeout(
          client.request(req),
          this.tokenTimeoutMs,
          this.wsUrl,
        );
        const lines = res?.result?.lines;
        if (!Array.isArray(lines)) break;
        for (const line of lines) {
          const token = trustLineToToken(line);
          if (token) out.push(token);
        }
        marker = res.result.marker;
        if (marker === undefined || marker === null) break;
      }
      return out;
    } catch {
      // 토큰 목록 때문에 지갑이 안 열리면 안 된다.
      return [];
    }
  }

  /**
   * `CUR.issuer` 하나를 직접 읽는다 — **수동 토큰 추가용.**
   *
   * 식별자 판별은 송금과 **같은 `parseIssuedAsset`** 을 쓴다. 조회에서 통과한
   * 문자열이 송금에서 거절당하는(또는 그 반대) 일이 생기지 않게 한다.
   *
   * 조회 경로도 목록과 같다: `account_lines` → `trustLineToToken`. 다만 `peer`
   * 로 발행자를 좁혀 페이지를 덜 넘긴다 (같은 명령·같은 파서라 값은 동일하다).
   *
   * **decimals 는 언제나 15 다.** XRPL 에는 자릿수 개념이 자체가 없고 15 는
   * 우리 표현 규약이다 (`XRP_ISSUED_DECIMALS` 주석 참고). 즉 "체인에서 못 읽어서
   * 추측해야 하는 값" 이 아니라 **고정 상수**이므로, trust line 이 없어도 자릿수가
   * 틀릴 위험이 없다.
   *
   * 그래서 **trust line 이 없으면 잔액 0 으로 등록한다.** 아직 안 받은 토큰을
   * 미리 넣어 두는 것은 정상적인 사용이고, 등록해 둬야 화면에서 수신 준비
   * (TrustSet) 로 이어갈 수 있다. 주의: trust line 없이는 실제로 받을 수 없다 —
   * 등록은 목록에 넣는 것일 뿐 수신 준비가 아니다.
   *
   * 잔액이 음수인 줄(= 이 계정이 발행자라 빚진 상태)도 잔액 0 으로 등록한다.
   * `PortableTokenBalance.balance` 가 음수를 담을 수 없어서다. 목록이 그 줄을
   * 아예 빼는 것과 다르지만, 다른 것은 "보여줄지" 정책뿐이고 id·symbol·decimals
   * 값 규칙은 같다.
   */
  async readToken(
    id: string,
    owner: string,
  ): Promise<PortableTokenBalance | null> {
    const parsed = parseIssuedAsset(id.trim());
    if (!parsed) {
      throw new Error(
        `xrp: unsupported token id "${id}" — expected issued currency "CUR.issuer"`,
      );
    }
    const line = await this.findTrustLine(owner, parsed.currency, parsed.issuer);
    if (line) {
      const token = trustLineToToken(line);
      if (token) return token;
    }
    const symbol = decodeXrpCurrency(parsed.currency);
    return {
      id: `${parsed.currency}.${parsed.issuer}`,
      symbol,
      name: symbol,
      decimals: XRP_ISSUED_DECIMALS,
      balance: 0n,
      // source 없음 = 체인에서 직접 확인한 결과(없음 포함).
    };
  }

  /**
   * 특정 발행자·통화의 trust line 하나를 찾는다. 없으면 null.
   *
   * `discoverTokens` 와 같은 `account_lines` 명령을 쓰되 `peer` 로 발행자를 좁힌다.
   * 계정 자체가 없으면(actNotFound) trust line 도 없는 것이므로 null.
   */
  private async findTrustLine(
    owner: string,
    currency: string,
    issuer: string,
  ): Promise<AccountLinesTrustline | null> {
    const client = await this.client();
    let marker: unknown;
    for (let page = 0; page < ACCOUNT_LINES_MAX_PAGES; page++) {
      const req: AccountLinesRequest = {
        command: 'account_lines',
        account: owner,
        ledger_index: 'validated',
        limit: ACCOUNT_LINES_PAGE,
        peer: issuer,
        ...(marker !== undefined ? { marker } : {}),
      };
      let res: AccountLinesResponse;
      try {
        res = await withTimeout(client.request(req), this.tokenTimeoutMs, this.wsUrl);
      } catch (err: unknown) {
        // 계정이 아직 온체인에 없다 = trust line 도 없다. 그 외 오류는 던진다 —
        // 사용자가 명시적으로 요청한 동작이라 이유를 알려주는 편이 낫다.
        if (isActNotFound(err)) return null;
        throw err;
      }
      const lines = res?.result?.lines;
      if (!Array.isArray(lines)) return null;
      for (const line of lines) {
        if (line?.currency === currency && line?.account === issuer) return line;
      }
      marker = res.result.marker;
      if (marker === undefined || marker === null) return null;
    }
    return null;
  }

  async buildTransfer(intent: TransferIntent, ctx: TxContext): Promise<XrpUnsignedTx> {
    if (intent.amount < 0n) throw new Error('xrp: amount must be >= 0');
    const client = await this.client();
    const pubkey = await ctx.signer.publicKey();
    const compressed = toCompressedSecp256k1(pubkey);
    // asset 이 비어 있으면 **native XRP — Amount 는 drops 십진 문자열.**
    // 기존 경로를 그대로 둔다. asset 이 있을 때만 객체 Amount 로 분기한다.
    const asset = intent.asset?.trim();
    const amount: Payment['Amount'] = asset
      ? toIssuedAmount(asset, intent.amount)
      : intent.amount.toString();
    const base: Payment = {
      TransactionType: 'Payment',
      Account: ctx.sender,
      Destination: intent.to,
      Amount: amount,
      // XRPL serializes SigningPubKey into both the signing pre-image and the
      // final tx blob, so it must be present before encodeForSigning.
      SigningPubKey: bytesToHex(compressed).toUpperCase(),
    };
    const tx = await client.autofill(base);
    return { tx };
  }

  async signRequests(tx: XrpUnsignedTx): Promise<SignRequest[]> {
    // XRPL ECDSA-secp256k1 signs `SHA512(encodeForSigning)[:32]` (the "half"
    // SHA-512 used by rippled). Our SoftSigner does NOT prehash, so this
    // method must return the 32-byte digest, not the raw signing pre-image.
    const hex = encodeForSigning(tx.tx);
    const pre = hexToBytes(hex);
    return [{ message: sha512(pre).slice(0, 32), prehashed: true }];
  }

  async applySignatures(tx: XrpUnsignedTx, signatures: Uint8Array[]): Promise<XrpSignedTx> {
    if (signatures.length !== 1) {
      throw new Error(`xrp: expected 1 signature, got ${signatures.length}`);
    }
    const signature = signatures[0]!;
    if (signature.length !== 65) {
      throw new Error(`xrp: signature must be 65 bytes (r||s||recovery), got ${signature.length}`);
    }
    const signerPubKey = tx.tx.SigningPubKey;
    if (!signerPubKey) {
      throw new Error('xrp: SigningPubKey missing from tx; set it before applySignatures');
    }
    const r = bytesToBigInt(signature.subarray(0, 32));
    const s = bytesToBigInt(signature.subarray(32, 64));
    const sig = new secp256k1.Signature(r, s);
    const normalized = sig.hasHighS() ? sig.normalizeS() : sig;
    const der = normalized.toDERRawBytes();

    const signedTx: Payment = {
      ...tx.tx,
      TxnSignature: bytesToHex(der).toUpperCase(),
    };
    const txBlob = encode(signedTx);
    const hash = hashes.hashSignedTx(txBlob);
    return { txBlob, hash };
  }

  async broadcast(tx: XrpSignedTx): Promise<TxHash> {
    const client = await this.client();
    const res = await client.submitAndWait(tx.txBlob);
    // Prefer the on-chain tx hash when present, else our locally-computed hash.
    const result = res.result as { hash?: string };
    return result.hash ?? tx.hash;
  }

  /**
   * Returns a connected xrpl Client. Cached for reuse across calls.
   */
  async client(): Promise<Client> {
    if (this._client && this._client.isConnected()) return this._client;
    if (!this._client) this._client = new Client(this.wsUrl);
    if (!this._client.isConnected()) await this._client.connect();
    return this._client;
  }

  /**
   * Disconnect and release the underlying WebSocket client.
   * Safe to call multiple times.
   */
  async close(): Promise<void> {
    if (!this._client) return;
    if (this._client.isConnected()) {
      await this._client.disconnect();
    }
    this._client = null;
  }

  /**
   * Helper for callers that need to set the SigningPubKey on a built tx
   * before calling signRequests. The XRPL serialization includes
   * SigningPubKey, so it must be present in both signing and final blobs.
   */
  attachSigningPubKey(tx: XrpUnsignedTx, pubkey: Uint8Array): XrpUnsignedTx {
    const compressed = toCompressedSecp256k1(pubkey);
    return {
      tx: { ...tx.tx, SigningPubKey: bytesToHex(compressed).toUpperCase() },
    };
  }
}

function xrpToDrops(xrp: number): bigint {
  if (!Number.isFinite(xrp)) throw new Error(`xrp: non-finite balance ${xrp}`);
  if (xrp < 0) throw new Error(`xrp: negative balance ${xrp}`);
  if (xrp === 0) return 0n;
  if (xrp >= 1e15) throw new Error(`xrp: balance ${xrp} exceeds safe range`);
  // Use a string to avoid binary floating-point rounding for typical balances.
  const s = xrp.toFixed(6);
  if (s.includes('e') || s.includes('E')) {
    throw new Error(`xrp: unexpected scientific notation in toFixed result: ${s}`);
  }
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = (frac + '000000').slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}

// ── issued currency (토큰) 유틸 ────────────────────────────────

/**
 * trust line 1건 → PortableTokenBalance. 쓸 수 없는 줄이면 null.
 *
 * `id` 는 `CUR.issuer` — 이걸 그대로 `TransferIntent.asset` 에 넣으면 송금이 된다.
 * 통화 코드는 **원본 그대로** 담는다. 40-hex 비표준 코드를 사람이 읽는 문자열로
 * 바꿔서 id 에 넣으면 다시 원본으로 되돌릴 수 없어 송금이 깨진다. 사람이 읽는
 * 형태는 `symbol` 에만 쓴다.
 */
function trustLineToToken(line: AccountLinesTrustline): PortableTokenBalance | null {
  if (!line || typeof line.currency !== 'string' || typeof line.account !== 'string') {
    return null;
  }
  if (line.currency.length === 0 || line.account.length === 0) return null;
  const balance = decimalToBaseUnits(line.balance, XRP_ISSUED_DECIMALS);
  if (balance === null) return null;
  const symbol = decodeXrpCurrency(line.currency);
  return {
    id: `${line.currency}.${line.account}`,
    symbol,
    // XRPL 은 토큰 이름을 온체인에 두지 않는다 (발행자 도메인의 xrp-ledger.toml
    // 을 따로 읽어야 안다). 없는 정보를 지어내지 않고 symbol 을 그대로 쓴다.
    name: symbol,
    decimals: XRP_ISSUED_DECIMALS,
    balance,
    // source 없음 = 체인에서 직접 읽은 값.
  };
}

/**
 * 통화 코드를 사람이 읽는 문자열로. 표준 3글자는 그대로, 40-hex 는 ASCII 로 해독.
 * ASCII 가 아니면(demurrage/비표준 바이트) 해독을 포기하고 hex 를 그대로 보여준다 —
 * 억지로 예쁘게 만들다 다른 토큰과 같은 이름이 되는 편이 더 위험하다.
 */
function decodeXrpCurrency(code: string): string {
  if (!/^[0-9A-Fa-f]{40}$/.test(code)) return code;
  const bytes = hexToBytes(code);
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  const head = bytes.subarray(0, end);
  if (head.length === 0) return code.toUpperCase();
  for (const b of head) {
    if (b < 0x20 || b > 0x7e) return code.toUpperCase();
  }
  return new TextDecoder().decode(head);
}

/**
 * 십진 문자열 → `decimals` 자리 정수(bigint).
 *
 * 다음 경우 null (= 그 항목을 버린다):
 *   - 숫자로 파싱되지 않음
 *   - 0 이 아닌 음수 (빚진 trust line)
 * 소수점 이하 `decimals` 자리를 넘는 부분은 0 방향으로 내린다.
 */
function decimalToBaseUnits(raw: unknown, decimals: number): bigint | null {
  if (typeof raw !== 'string') return null;
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(raw.trim());
  if (!m) return null;
  const frac = m[3] ?? '';
  const expRaw = m[4];
  const exp = expRaw === undefined ? 0 : Number(expRaw);
  if (!Number.isFinite(exp) || Math.abs(exp) > 200) return null;

  let value: bigint;
  try {
    value = BigInt((m[2] ?? '') + frac);
  } catch {
    return null;
  }
  const shift = decimals - frac.length + exp;
  value =
    shift >= 0 ? value * 10n ** BigInt(shift) : value / 10n ** BigInt(-shift);
  // "-0.0" 처럼 값이 0 인 음수 표기는 0 으로 받아준다.
  if (m[1] === '-' && value > 0n) return null;
  return value;
}

/** `decimals` 자리 정수 → 십진 문자열. 뒤따르는 0 은 정리한다. */
function baseUnitsToDecimal(v: bigint, decimals: number): string {
  const unit = 10n ** BigInt(decimals);
  const whole = (v / unit).toString();
  const frac = (v % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac.length > 0 ? `${whole}.${frac}` : whole;
}

/** `CUR.issuer` 파싱. 형식이 아니면 null. */
function parseIssuedAsset(
  asset: string,
): { currency: string; issuer: string } | null {
  const dot = asset.indexOf('.');
  if (dot <= 0) return null;
  const currency = asset.slice(0, dot);
  const issuer = asset.slice(dot + 1);
  // 표준 3글자 코드 또는 40-hex 비표준 코드만 통과.
  const okCurrency =
    /^[0-9A-Fa-f]{40}$/.test(currency) ||
    /^[A-Za-z0-9?!@#$%^&*<>(){}[\]|]{3}$/.test(currency);
  if (!okCurrency) return null;
  // "XRP" 는 trust line 통화가 될 수 없다. IOU 로 위장한 native 송금을 막는다.
  if (currency.toUpperCase() === 'XRP') return null;
  if (!isValidClassicAddress(issuer)) return null;
  return { currency, issuer };
}

/**
 * `asset` + base unit 수량 → Payment.Amount 객체.
 *
 * 같은 통화·같은 발행자로 보내는 직접 결제라 path/SendMax 가 필요 없다. 통화를
 * 바꾸는 cross-currency 결제는 여기서 다루지 않는다.
 *
 * 형식이 틀리면 **던진다.** 모르는 asset 을 조용히 무시하면 "토큰을 보낸 줄 알았는데
 * native XRP 가 나간" 상황이 되고, 그건 자산 사고다.
 */
function toIssuedAmount(asset: string, amount: bigint): IssuedCurrencyAmount {
  const parsed = parseIssuedAsset(asset);
  if (!parsed) {
    throw new Error(
      `xrp: unsupported asset "${asset}" — expected issued currency "CUR.issuer"`,
    );
  }
  if (amount < 0n) throw new Error('xrp: amount must be >= 0');
  const value = baseUnitsToDecimal(amount, XRP_ISSUED_DECIMALS);
  const significant = value.replace('.', '').replace(/^0+/, '').replace(/0+$/, '');
  if (significant.length > XRP_MAX_IOU_PRECISION) {
    throw new Error(
      `xrp: issued amount ${value} exceeds XRPL precision (${XRP_MAX_IOU_PRECISION} significant digits)`,
    );
  }
  return { currency: parsed.currency, issuer: parsed.issuer, value };
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

function isActNotFound(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { data?: { error?: string }; message?: string };
  if (e.data?.error === 'actNotFound') return true;
  if (typeof e.message === 'string' && e.message.includes('actNotFound')) return true;
  return false;
}
