// scripthash.ts — BTC 주소 → Electrum scripthash 변환.
//
// Electrum 프로토콜은 주소가 아니라 "scripthash" 로 조회한다:
//   scripthash = reverse_bytes(sha256(scriptPubKey)) 의 hex
// (https://electrumx.readthedocs.io/en/latest/protocol-basics.html#script-hashes)
//
// scriptPubKey 구성은 기존 SDK 가 이미 쓰는 @scure/btc-signer 의
// Address 코덱 + OutScript 를 재사용한다 (chains/btc.ts 의 scriptForAddress 와
// 같은 수법 — 그 파일은 수정 금지라 여기서 독립 함수로 둔다).
// 지원 주소형: P2PKH(1…) · P2SH(3…) · P2WPKH/P2WSH(bc1q…) · P2TR(bc1p…) —
// 코덱이 디코드하는 전부.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { NETWORK, TEST_NETWORK, Address as BtcAddressCodec, OutScript } from '@scure/btc-signer';
import type { BtcNetwork } from '../../chains/btc.js';

/** 주소 → scriptPubKey 바이트. 디코드 불가 주소는 코덱이 예외를 던진다. */
export function addressToScriptPubKey(address: string, network: BtcNetwork = 'mainnet'): Uint8Array {
  const net = network === 'mainnet' ? NETWORK : TEST_NETWORK;
  return OutScript.encode(BtcAddressCodec(net).decode(address));
}

/** scriptPubKey → Electrum scripthash (sha256 후 바이트 역순 hex). */
export function scriptPubKeyToScripthash(scriptPubKey: Uint8Array): string {
  // sha256() 은 새 배열을 반환하므로 in-place reverse 가 안전하다.
  return bytesToHex(sha256(scriptPubKey).reverse());
}

/**
 * 주소 → Electrum scripthash.
 *
 * 검증된 벡터 (이 저장소에서 @scure/btc-signer + @noble/hashes 로 실측 재계산,
 * electrumx 문서 예시와 일치):
 *   1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa (제네시스 P2PKH)
 *     → 8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161
 */
export function addressToScripthash(address: string, network: BtcNetwork = 'mainnet'): string {
  return scriptPubKeyToScripthash(addressToScriptPubKey(address, network));
}
