// 셸 공용 WalletStore 의 desktop 인스턴스.
// Tauri 웹뷰는 sessionStorage 시맨틱이 일반 브라우저와 동일하므로 WebSessionStore 사용.

import { EvmAdapter, TTL_CHAIN } from '@nodong/wallet-sdk';
import { createWalletStore, WebSessionStore } from '@nodong/shell-core';

export const walletStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: new WebSessionStore(),
});
