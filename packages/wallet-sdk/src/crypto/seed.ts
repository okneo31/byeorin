import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from '@scure/bip39';
import { wordlist as english } from '@scure/bip39/wordlists/english';
import { wordlist as korean } from '@scure/bip39/wordlists/korean';

export type WordlistName = 'english' | 'korean';

const WORDLISTS: Record<WordlistName, readonly string[]> = {
  english,
  korean,
};

/**
 * BIP39 워드리스트(2048 단어)를 read-only 로 노출한다.
 *
 * 사용처: UI 의 자동완성 datalist, 단어 유효성 사전 검사. 셸이
 * `@scure/bip39` 를 직접 의존하지 않도록 SDK 가 단일 진입점이 된다.
 */
export function getWordlist(wordlist: WordlistName): readonly string[] {
  return WORDLISTS[wordlist];
}

export type MnemonicStrength = 128 | 160 | 192 | 224 | 256;

/**
 * 벼린이 **새로 만드는** 시드구문의 단어 수. 항상 24 (2026-07-25 확정).
 *
 * 왜 24인가 — 보안 때문이 아니다. 12 단어(128 비트)면 이미 secp256k1/ed25519 의
 * 실질 보안 상한(~128 비트)을 채우므로, 시드를 256 비트로 올려도 파생 키가 더
 * 강해지지는 않는다. 이유는 **하드웨어 지갑(벼린 요세)과의 형식 통일** 이다.
 * 한 브랜드 안에서 SW 는 12 단어, HW 는 24 단어를 뱉으면 사용자가 두 형식을
 * 관리하게 된다. 대신 필사 부담이 2 배가 된다는 비용을 지불한다.
 *
 * ⚠ 이 값은 **생성에만** 적용된다. 복구(임포트)는 12 단어도 계속 받아야 한다 —
 * MetaMask/Trust/Coinbase 등 대부분의 외부 지갑이 12 단어이고, 이를 막으면
 * 외부 사용자가 벼린으로 이주할 수 없다. 검증은 `isValidMnemonic` 이
 * BIP-39 체크섬으로 하므로 단어 수를 따로 강제하지 않는다.
 */
export const NEW_MNEMONIC_WORD_COUNT = 24;

/** 위 단어 수에 대응하는 BIP-39 엔트로피 비트 (24 단어 = 256 비트). */
export const NEW_MNEMONIC_STRENGTH: MnemonicStrength = 256;

/**
 * 새 시드구문을 만든다. 기본값이 곧 벼린의 정책(24 단어)이므로, 셸이 강도를
 * 깜빡하고 호출해도 정책에서 벗어나지 않는다.
 */
export function createMnemonic(
  strength: MnemonicStrength = NEW_MNEMONIC_STRENGTH,
  wordlist: WordlistName = 'english',
): string {
  return generateMnemonic(WORDLISTS[wordlist] as string[], strength);
}

export function isValidMnemonic(
  mnemonic: string,
  wordlist: WordlistName = 'english',
): boolean {
  return validateMnemonic(mnemonic, WORDLISTS[wordlist] as string[]);
}

export function mnemonicToSeed(
  mnemonic: string,
  passphrase = '',
): Uint8Array {
  return mnemonicToSeedSync(mnemonic, passphrase);
}
