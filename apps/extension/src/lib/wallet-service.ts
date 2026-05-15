// SDK 어댑터/월릿을 한 번만 만들어 들고 다니는 얇은 래퍼.
// background / popup 양쪽에서 동일 인터페이스로 호출한다.

import { EvmAdapter, TTL_CHAIN, Wallet, type WalletAccount } from '@nodong/wallet-sdk';
import { readSession } from './session.js';

let cachedAdapter: EvmAdapter | null = null;

export function getTtlAdapter(): EvmAdapter {
  if (!cachedAdapter) {
    cachedAdapter = new EvmAdapter({ chain: TTL_CHAIN });
  }
  return cachedAdapter;
}

export async function getActiveAccount(): Promise<WalletAccount | null> {
  const session = await readSession();
  if (!session) return null;
  const wallet = Wallet.fromMnemonic({ mnemonic: session.mnemonic });
  return wallet.account(getTtlAdapter());
}
