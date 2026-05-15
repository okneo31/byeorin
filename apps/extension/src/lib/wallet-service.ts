// 셸 공용 WalletStore 의 extension 인스턴스.
//
// MV3 환경: chrome.storage.session 은 service worker(background) 와 popup
// 양쪽에서 동일 키 스페이스를 공유하므로, 본 모듈은 background/popup 어느 쪽에서
// import 되어도 동일한 시맨틱을 제공한다. 실제 wallet 객체는 각 컨텍스트의 메모리에
// 따로 존재하지만, 세션 저장소가 공유되므로 tryAutoRestore 로 동기화 가능.

import { EvmAdapter, TTL_CHAIN, type WalletAccount } from '@nodong/wallet-sdk';
import { createWalletStore, ExtensionSessionStore } from '@nodong/shell-core';

export const walletStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: new ExtensionSessionStore(),
});

/** TTL 어댑터 (기존 코드 호환용). */
export function getTtlAdapter(): EvmAdapter {
  return walletStore.getDefaultAdapter() as EvmAdapter;
}

/**
 * 활성 계정 조회. 메모리에 wallet 이 없으면 chrome.storage.session 에서 자동 복원
 * 시도(extension 은 autoRestoreAllowed=true). 잠금 상태면 null.
 *
 * background service worker 는 휴면/재기동될 수 있어 매 호출마다 메모리가 비어있을
 * 가능성이 있다. 따라서 popup 이 unlock 한 직후 background 에서 호출해도 본 헬퍼는
 * 세션 저장소에서 자동 복원해 동작한다.
 */
export async function getActiveAccount(): Promise<WalletAccount | null> {
  if (!walletStore.isUnlocked()) {
    const restored = await walletStore.tryAutoRestore();
    if (!restored) return null;
  }
  return walletStore.getAccount();
}
