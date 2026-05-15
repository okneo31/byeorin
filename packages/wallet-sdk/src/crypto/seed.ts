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
