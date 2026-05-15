import {
  EvmAdapter,
  TTL_CHAIN,
  Wallet,
  isValidMnemonic,
  type WalletAccount,
} from '@nodong/wallet-sdk';

const STORAGE_KEY = 'nd:mnemonic';

let wallet: Wallet | null = null;
let account: WalletAccount | null = null;
let adapter: EvmAdapter | null = null;

function ensureAdapter(): EvmAdapter {
  if (!adapter) {
    adapter = new EvmAdapter({ chain: TTL_CHAIN });
  }
  return adapter;
}

function detectWordlist(mnemonic: string): 'english' | 'korean' {
  // crude detection: any hangul char -> korean
  return /[가-힯]/.test(mnemonic) ? 'korean' : 'english';
}

function loadFromSession(): void {
  if (wallet) return;
  if (typeof sessionStorage === 'undefined') return;
  const m = sessionStorage.getItem(STORAGE_KEY);
  if (!m) return;
  try {
    wallet = Wallet.fromMnemonic({ mnemonic: m, wordlist: detectWordlist(m) });
    account = wallet.account(ensureAdapter());
  } catch {
    sessionStorage.removeItem(STORAGE_KEY);
    wallet = null;
    account = null;
  }
}

export function setMnemonic(mnemonic: string): WalletAccount {
  const trimmed = mnemonic.trim().replace(/\s+/g, ' ');
  const wordlist = detectWordlist(trimmed);
  if (!isValidMnemonic(trimmed, wordlist)) {
    throw new Error('유효하지 않은 복구 문구입니다.');
  }
  wallet = Wallet.fromMnemonic({ mnemonic: trimmed, wordlist });
  account = wallet.account(ensureAdapter());
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.setItem(STORAGE_KEY, trimmed);
  }
  return account;
}

export function getAccount(): WalletAccount | null {
  if (!account) loadFromSession();
  return account;
}

export function getWallet(): Wallet | null {
  if (!wallet) loadFromSession();
  return wallet;
}

export function getAdapter(): EvmAdapter {
  return ensureAdapter();
}

export function clear(): void {
  wallet = null;
  account = null;
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(STORAGE_KEY);
  }
}

export function hasSession(): boolean {
  if (account) return true;
  if (typeof sessionStorage === 'undefined') return false;
  return sessionStorage.getItem(STORAGE_KEY) != null;
}
