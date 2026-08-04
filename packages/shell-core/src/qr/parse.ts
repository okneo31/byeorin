// 스캔 문자열 → 구조화. BIP21 / EIP-681 / 평문 주소.
//
// 형식 파싱만 하고 끝내면 호출부가 검증을 건너뛸 수 있다 — 돈 보내는 자리이므로
// 주소 검증까지 여기서 끝내고, 통과한 것만 ok:true 로 내보낸다.
// 모르는 것은 추측해서 채우지 않는다(토큰 decimals, ENS 이름, 지수 표기 금액).

import type { ChainKey } from '@byeorin/wallet-sdk/multichain';
import { isValidAddressFor, type AddressCheckOptions } from './address.js';

export type ScanKind = 'bip21' | 'eip681' | 'raw';

export interface ScanResult {
  ok: true;
  kind: ScanKind;
  /** 원문 그대로. 체크섬 정규화는 호출부 판단. */
  address: string;
  /** 십진 문자열, 표시 단위(BTC / ETH 등 native). bigint 변환은 호출부. */
  amount?: string;
  /** 확신 가능한 경우에만 채운다. */
  chainHint?: ChainKey;
  /** EIP-681 /transfer 의 토큰 컨트랙트. */
  tokenAddress?: string;
  /** decimals 를 모르므로 변환하지 않은 최소 단위 수량. */
  tokenAmountRaw?: string;
  label?: string;
  message?: string;
  warnings: string[];
}

export type ScanErrorCode =
  | 'empty'
  | 'unsupported-scheme'
  | 'required-param'
  | 'bad-amount'
  | 'bad-address'
  | 'chain-mismatch';

export interface ScanError {
  ok: false;
  code: ScanErrorCode;
  /** 원문(또는 문제가 된 부분). 화면에 보여 주되 입력란에는 넣지 않는다. */
  text: string;
}

export interface ParseOptions extends AddressCheckOptions {}

// EIP-681 @chain_id 역인덱스. wallet-sdk 의 EVM_CHAINS 를 런타임으로 끌어오면
// 레지스트리 전체가 번들에 실리므로 값만 옮겨 적고, 어긋남은 테스트가 잡는다.
const EVM_CHAIN_IDS: Record<number, ChainKey> = {
  7777: 'evm:ttl',
  1: 'evm:ethereum',
  137: 'evm:polygon',
  56: 'evm:bsc',
  42161: 'evm:arbitrum',
  10: 'evm:optimism',
  8453: 'evm:base',
  43114: 'evm:avalanche',
};

const RE_SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/;

export function parseScanned(
  text: string,
  chain: ChainKey,
  opts: ParseOptions = {},
): ScanResult | ScanError {
  const raw = (text ?? '').trim();
  if (raw.length === 0) return err('empty', raw);

  const m = RE_SCHEME.exec(raw);
  if (!m) return finish({ ok: true, kind: 'raw', address: raw, warnings: [] }, chain, opts);

  const scheme = m[1]!.toLowerCase();
  if (scheme === 'bitcoin') return parseBip21(raw.slice(m[0].length), chain, opts);
  if (scheme === 'ethereum') return parseEip681(raw.slice(m[0].length), chain, opts);
  return err('unsupported-scheme', raw);
}

function err(code: ScanErrorCode, text: string): ScanError {
  return { ok: false, code, text };
}

/** 검증 관문 — 모든 성공 경로가 여기를 통과해야 한다. */
function finish(r: ScanResult, chain: ChainKey, opts: ParseOptions): ScanResult | ScanError {
  if (r.address.length === 0) return err('bad-address', r.address);
  if (r.chainHint && r.chainHint !== chain) return err('chain-mismatch', r.address);
  if (!isValidAddressFor(chain, r.address, opts)) return err('bad-address', r.address);
  return r;
}

function splitQuery(rest: string): { head: string; params: URLSearchParams } {
  const q = rest.indexOf('?');
  if (q < 0) return { head: rest, params: new URLSearchParams() };
  return { head: rest.slice(0, q), params: new URLSearchParams(rest.slice(q + 1)) };
}

// ── BIP-0021 ──────────────────────────────────────────────────────────────
const RE_DECIMAL = /^\d+(\.\d+)?$/;

function parseBip21(rest: string, chain: ChainKey, opts: ParseOptions): ScanResult | ScanError {
  const { head, params } = splitQuery(rest);
  // 남이 만든 QR 이다. 잘린 퍼센트 이스케이프('%' 하나, '%zz')면
  // decodeURIComponent 가 URIError 를 던지고, 잡지 않으면 스캔 화면이 죽는다.
  let address: string;
  try {
    address = decodeURIComponent(head).trim();
  } catch {
    return err('bad-address', head);
  }
  const out: ScanResult = { ok: true, kind: 'bip21', address, chainHint: 'btc', warnings: [] };

  for (const [k, v] of params.entries()) {
    const key = k.toLowerCase();
    // 모르는 req- 파라미터가 하나라도 있으면 스펙상 이 URI 를 써서는 안 된다.
    if (key.startsWith('req-') || key === 'r') return err('required-param', k);
    if (key === 'amount') {
      // 스펙의 'X' 지수 표기는 오해석 시 금액 사고이므로 받지 않는다.
      if (!RE_DECIMAL.test(v)) return err('bad-amount', v);
      out.amount = v;
    } else if (key === 'label') out.label = v;
    else if (key === 'message') out.message = v;
    else out.warnings.push(`무시한 파라미터: ${k}`);
  }
  return finish(out, chain, opts);
}

// ── EIP-681 ───────────────────────────────────────────────────────────────
const RE_NUMBER = /^(\d+)(\.\d+)?(e(\d+))?$/;

/** EIP-681 숫자 → 정수 최소단위 문자열. 소수가 남으면 null. */
function toIntegerUnits(n: string): string | null {
  const m = RE_NUMBER.exec(n);
  if (!m) return null;
  const int = m[1]!;
  const frac = m[2] ? m[2].slice(1) : '';
  const exp = m[4] ? Number(m[4]) : 0;
  const digits = int + frac;
  const shift = exp - frac.length;
  if (shift < 0) return null; // 최소단위 아래로 내려간다 = 표현 불가
  return stripLeadingZeros(digits + '0'.repeat(shift));
}

function stripLeadingZeros(s: string): string {
  const t = s.replace(/^0+/, '');
  return t.length === 0 ? '0' : t;
}

/** 최소단위 정수 문자열 → 표시 단위 십진 문자열. 부동소수 오차 없이 문자열로만. */
export function baseUnitsToDecimalString(units: string, decimals: number): string {
  const s = stripLeadingZeros(units).padStart(decimals + 1, '0');
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, '');
  return frac.length > 0 ? `${int}.${frac}` : int;
}

function parseEip681(rest: string, chain: ChainKey, opts: ParseOptions): ScanResult | ScanError {
  const { head, params } = splitQuery(rest);
  let target = head.startsWith('pay-') ? head.slice(4) : head;
  let chainHint: ChainKey | undefined;
  const warnings: string[] = [];
  let fn = '';

  const slash = target.indexOf('/');
  if (slash >= 0) {
    fn = target.slice(slash + 1);
    target = target.slice(0, slash);
  }
  const at = target.indexOf('@');
  if (at >= 0) {
    const idRaw = target.slice(at + 1);
    target = target.slice(0, at);
    const id = Number(idRaw);
    const hit = Number.isInteger(id) ? EVM_CHAIN_IDS[id] : undefined;
    if (hit) chainHint = hit;
    else warnings.push(`모르는 chain_id: ${idRaw}`);
  }
  target = target.trim();
  // ENS 해석은 온체인 조회가 필요하다 — 표현 계층 밖이므로 거절한다.
  if (!/^0x[0-9a-fA-F]{40}$/.test(target)) return err('bad-address', target);

  for (const k of params.keys()) {
    const key = k.toLowerCase();
    if (key === 'gas' || key === 'gaslimit' || key === 'gasprice')
      warnings.push(`무시한 파라미터: ${k}`);
  }

  if (fn === '') {
    const out: ScanResult = { ok: true, kind: 'eip681', address: target, chainHint, warnings };
    const value = params.get('value');
    if (value !== null) {
      const wei = toIntegerUnits(value);
      if (wei === null) return err('bad-amount', value);
      out.amount = baseUnitsToDecimalString(wei, 18);
    }
    return finish(out, chain, opts);
  }

  if (fn === 'transfer') {
    const to = (params.get('address') ?? '').trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return err('bad-address', to);
    const out: ScanResult = {
      ok: true,
      kind: 'eip681',
      address: to,
      tokenAddress: target,
      chainHint,
      warnings,
    };
    const q = params.get('uint256');
    if (q !== null) {
      const units = toIntegerUnits(q);
      if (units === null) return err('bad-amount', q);
      out.tokenAmountRaw = units;
      // 토큰 decimals 를 모르므로 표시 수량으로 바꾸지 않는다.
      out.warnings.push('토큰 수량 미변환(raw uint256)');
    }
    return finish(out, chain, opts);
  }

  return err('unsupported-scheme', fn);
}

/** EIP-681 chain_id 표를 외부(테스트·셸)에서 대조할 수 있게 노출한다. */
export function evmChainKeyForId(chainId: number): ChainKey | undefined {
  return EVM_CHAIN_IDS[chainId];
}
