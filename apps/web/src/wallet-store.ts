// 셸 공용 WalletStore 의 web 인스턴스.
// 라이프사이클/세션 정책은 @nodong/shell-core 가 담당하고, 이 모듈은 단지
// web 환경(WebSessionStore) 에 맞게 단일 인스턴스를 만들어 노출한다.

import { EvmAdapter, TTL_CHAIN } from '@nodong/wallet-sdk';
import { createWalletStore, WebSessionStore } from '@nodong/shell-core';

export const walletStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: new WebSessionStore(),
});
