// 주소 형식 검증 — 스캔값을 송금 입력란에 넣기 전의 최소 방어선.
//
// 여기서 하는 것은 "형식" 검증이지 체크섬 보증이 아니다(EVM 만 예외로 EIP-55 를
// 실제로 계산한다 — keccak 은 이미 의존 중인 @noble/hashes 에 있다). bech32/
// base58check 체크섬은 wallet-sdk 를 external 로 둔 이 패키지에서 계산하지 않는다
// — 필요하면 셸이 wallet-sdk 경유로 2단 확인한다.

import { keccak_256 } from '@noble/hashes/sha3';
import type { ChainKey } from '@byeorin/wallet-sdk/multichain';

export interface AddressCheckOptions {
  /** cosmos 계열의 HRP. 호출부(셸)가 ChainSpec 에서 꺼내 넘긴다. */
  bech32Prefix?: string;
}

const RE_EVM = /^0x[0-9a-fA-F]{40}$/;
const RE_BTC_BASE58 = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const RE_BTC_BECH32 = /^(bc1|BC1)[0-9A-Za-z]{11,71}$/;
const RE_BECH32_ANY = /^[a-z][a-z0-9]{1,82}1[02-9ac-hj-np-z]{6,}$/;
const RE_XRP = /^r[1-9A-HJ-NP-Za-km-z]{24,34}$/;
const RE_SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const RE_TRON = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const RE_TON = /^[EU]Q[A-Za-z0-9_-]{46}$/;
const RE_APTOS = /^0x[0-9a-fA-F]{1,64}$/;
const RE_SUI = /^0x[0-9a-fA-F]{64}$/;

/** 혼합 대소문자 EVM 주소의 EIP-55 체크섬. 전부 대/소문자면 체크섬 없음으로 본다. */
export function isEip55Checksum(address: string): boolean {
  const body = address.slice(2);
  const lower = body.toLowerCase();
  const hash = keccak_256(new TextEncoder().encode(lower));
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0x0f;
    const c = body[i]!;
    if (c >= 'a' && c <= 'f' && nibble >= 8) return false;
    if (c >= 'A' && c <= 'F' && nibble < 8) return false;
  }
  return true;
}

/** 대소문자가 섞여 있는가 = 체크섬을 주장하는 주소인가. */
export function hasMixedCase(address: string): boolean {
  const body = address.slice(2);
  return /[a-f]/.test(body) && /[A-F]/.test(body);
}

export function isValidAddressFor(
  chain: ChainKey,
  address: string,
  opts: AddressCheckOptions = {},
): boolean {
  const a = address.trim();
  if (a.length === 0) return false;
  if (chain.startsWith('evm:')) {
    if (!RE_EVM.test(a)) return false;
    // 체크섬을 주장하는 주소만 검사한다 — 전부 소문자 주소는 스펙상 유효하다.
    return hasMixedCase(a) ? isEip55Checksum(a) : true;
  }
  if (chain.startsWith('cosmos:')) {
    if (!RE_BECH32_ANY.test(a)) return false;
    if (opts.bech32Prefix) return a.startsWith(`${opts.bech32Prefix}1`);
    return true;
  }
  switch (chain) {
    case 'btc':
      if (RE_BTC_BASE58.test(a)) return true;
      // bech32 는 대소문자 혼용이 금지다.
      return RE_BTC_BECH32.test(a) && (a === a.toLowerCase() || a === a.toUpperCase());
    case 'xrp':
      return RE_XRP.test(a);
    case 'solana':
      return RE_SOL.test(a);
    case 'tron':
      return RE_TRON.test(a);
    case 'ton':
      return RE_TON.test(a);
    case 'aptos':
      return RE_APTOS.test(a);
    case 'sui':
      return RE_SUI.test(a);
    default:
      return false;
  }
}
