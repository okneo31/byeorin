/**
 * Mobile wallet store.
 *
 * v0.1: mnemonic is held in module-scope memory only. The app process
 * dying = the session ending. This is deliberate — losing the in-memory
 * mnemonic is safer than persisting it before secure storage is wired.
 *
 * TODO(keychain): persist (and reload) the mnemonic via react-native-keychain
 *   with `accessControl: BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE` and
 *   `accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
 * TODO(biometric): gate `loadFromKeychain()` behind a biometric prompt before
 *   reading the secret.
 */
import {
  EvmAdapter,
  TTL_CHAIN,
  Wallet,
  isValidMnemonic,
  type WalletAccount,
  type WordlistName,
} from '@nodong/wallet-sdk';

let wallet: Wallet | null = null;
let account: WalletAccount | null = null;
let adapter: EvmAdapter | null = null;

function ensureAdapter(): EvmAdapter {
  if (!adapter) {
    adapter = new EvmAdapter({ chain: TTL_CHAIN });
  }
  return adapter;
}

function detectWordlist(mnemonic: string): WordlistName {
  return /[가-힯]/.test(mnemonic) ? 'korean' : 'english';
}

export function setMnemonic(mnemonic: string): WalletAccount {
  const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
  const wordlist = detectWordlist(trimmed);
  if (!isValidMnemonic(trimmed, wordlist)) {
    throw new Error('유효하지 않은 복구 문구입니다.');
  }
  wallet = Wallet.fromMnemonic({ mnemonic: trimmed, wordlist });
  account = wallet.account(ensureAdapter());
  return account;
}

export function getAccount(): WalletAccount | null {
  return account;
}

export function getWallet(): Wallet | null {
  return wallet;
}

export function getAdapter(): EvmAdapter {
  return ensureAdapter();
}

export function clear(): void {
  wallet = null;
  account = null;
}

export function hasSession(): boolean {
  return account != null;
}
