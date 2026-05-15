/**
 * Mobile wallet store — 셸 공용 코어의 모바일 인스턴스.
 *
 * v0.1: mnemonic 은 MemorySessionStore 가 모듈-스코프 메모리에만 보관한다.
 * 앱 프로세스 종료 = 세션 종료. 키체인 도입 전까지 안전한 기본값.
 *
 * TODO(keychain): persist (and reload) the mnemonic via react-native-keychain
 *   with `accessControl: BIOMETRY_CURRENT_SET_OR_DEVICE_PASSCODE` and
 *   `accessible: WHEN_UNLOCKED_THIS_DEVICE_ONLY`.
 *   키체인 도입 시 새 SessionStore 구현체(예: KeychainSessionStore) 를 추가하고
 *   autoRestoreAllowed 는 생체 인증 게이팅 정책에 맞춰 결정한다.
 */
import { EvmAdapter, TTL_CHAIN } from '@nodong/wallet-sdk';
import { createWalletStore, MemorySessionStore } from '@nodong/shell-core';

export const walletStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: new MemorySessionStore(),
});
