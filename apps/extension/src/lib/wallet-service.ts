// 셸 공용 WalletStore 의 extension 인스턴스.
//
// MV3 환경: chrome.storage.session 은 service worker(background) 와 popup
// 양쪽에서 동일 키 스페이스를 공유하므로, 본 모듈은 background/popup 어느 쪽에서
// import 되어도 동일한 시맨틱을 제공한다. 실제 wallet 객체는 각 컨텍스트의 메모리에
// 따로 존재하지만, 세션 저장소가 공유되므로 tryAutoRestore 로 동기화 가능.

import { EvmAdapter, TTL_CHAIN, type WalletAccount } from '@nodong/wallet-sdk';
import { createWalletStore, ExtensionSessionStore } from '@nodong/shell-core';
import { clearAllGrants } from './grants.js';

const innerStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: new ExtensionSessionStore(),
});

// lock() 을 한 곳에서 가로채 origin+method 자동승인 grant 를 함께 비운다.
// shell-core 의 ExtensionSessionStore.clear() 는 니모닉 키만 제거하므로,
// 'nd:method-grants' 는 본 래퍼가 명시적으로 지워야 한다.
//
// 패턴: 원본 lock 을 .bind 로 묶어둔 뒤 자체 lock 으로 교체. 그러면 background 든
// popup 이든 어디서 walletStore.lock() 을 호출하더라도 grants 가 같이 청소된다.
const originalLock = innerStore.lock.bind(innerStore);
innerStore.lock = async function patchedLock(): Promise<void> {
  try {
    await clearAllGrants();
  } catch {
    // session storage 가 잠시 비가용해도 lock 자체는 진행해야 한다 — 보안 우선.
  }
  await originalLock();
};

export const walletStore = innerStore;

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
