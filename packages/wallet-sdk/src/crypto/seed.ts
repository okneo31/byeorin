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

export function createMnemonic(
  strength: MnemonicStrength = 128,
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
