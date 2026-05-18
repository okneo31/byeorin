// 셸 공용 WalletStore 의 extension 인스턴스.
//
// MV3 환경: chrome.storage.session 은 service worker(background) 와 popup
// 양쪽에서 동일 키 스페이스를 공유하므로, 본 모듈은 background/popup 어느 쪽에서
// import 되어도 동일한 시맨틱을 제공한다. 실제 wallet 객체는 각 컨텍스트의 메모리에
// 따로 존재하지만, 세션 저장소가 공유되므로 tryAutoRestore 로 동기화 가능.

// 좁은 import — 본 popup/background 는 EVM 만 사용한다. `@byeorin/wallet-sdk` 의
// 메인 barrel 을 그대로 import 하면 cosmos/ton/xrp/solana/sui/tron/aptos 어댑터가
// 따라 들어와 bundle 이 6MB+ 로 부풀고 (Buffer / WASM 미허용으로) popup 마운트가
// 실패한다. core (Wallet/타입/HW 트랜스포트) + evm (EvmAdapter/TTL_CHAIN) 만 가져온다.
import {
  type HwAppName,
  type HwSigner,
  type WalletAccount,
  type WebHidTransport,
} from '@byeorin/wallet-sdk/core';
import { EvmAdapter, TTL_CHAIN } from '@byeorin/wallet-sdk/evm';
import { createWalletStore, ExtensionSessionStore } from '@byeorin/shell-core';
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

// ── HW(하드웨어) 계정 ─────────────────────────────────────────────────────
//
// v0.4: Ledger Solana/Cosmos 만 지원. soft 월릿과 *공존* 한다 — 사용자는 잠금
// 해제(소프트) + HW 연결을 동시에 할 수도 있고, 둘 중 하나만 할 수도 있다.
// EVM 은 v0.5 로 이연되므로, 본 모듈에서는 HW 계정의 "주소 + 메타" 만 기억하고
// 서명 자체는 본 v0.4 에서 굳이 라우팅하지 않는다 (TTL 메인넷 = EVM 이므로).
//
// 저장 위치: 메모리 only. WebHID 권한과 디바이스는 브라우저가 영속화하므로,
// 팝업 리로드 후 사용자가 다시 "연결" 버튼을 누르면 권한 프롬프트 없이 즉시
// 재연결된다 (`forceRequest: false` 경로).

export interface HwAccountState {
  appName: HwAppName;
  address: string;
  derivationPath: string;
  publicKey: Uint8Array;
}

let hwState: {
  signer: HwSigner;
  transport: WebHidTransport;
  account: HwAccountState;
} | null = null;

const hwListeners = new Set<(s: HwAccountState | null) => void>();

function emitHwChange(): void {
  const snap = hwState?.account ?? null;
  for (const l of hwListeners) l(snap);
}

/** HW 상태 변경 구독. unsubscribe 함수를 반환. */
export function subscribeHwState(
  fn: (s: HwAccountState | null) => void,
): () => void {
  hwListeners.add(fn);
  // 초기값 한 번 흘려준다.
  fn(hwState?.account ?? null);
  return () => {
    hwListeners.delete(fn);
  };
}

export function getHwAccount(): HwAccountState | null {
  return hwState?.account ?? null;
}

/**
 * WebHID 로 Ledger 를 잡고 지정 앱의 첫 계정 주소를 가져온다.
 *
 * 호출 흐름(사용자 관점):
 *   1) 사용자가 "하드웨어 월릿 연결" 클릭(=user gesture)
 *   2) 브라우저가 WebHID chooser 표시 → Ledger Nano 선택
 *   3) Ledger 디바이스에서 해당 앱(Solana/Cosmos) 이 열려 있어야 함
 *   4) 첫 호출 시 디바이스의 "주소 확인" 화면이 뜰 수 있음 → 사용자 확인
 *
 * 실패 케이스:
 *   - WebHID 미지원 브라우저 → throw
 *   - @ledgerhq/* 미설치 → throw (개발 환경)
 *   - 사용자가 chooser 에서 취소 → throw (TransportOpenUserCancelled)
 */
export async function connectHardware(
  appName: HwAppName,
  derivationPath?: string,
): Promise<HwAccountState> {
  // /core subpath 로 dynamic import — 전체 barrel 을 가져오면 popup 이 마운트되는
  // 순간 cosmos/ton/xrp 등이 따라 들어와 bundle 시 chunk 가 통째로 비대해진다.
  const sdk = await import('@byeorin/wallet-sdk/core');
  const transport = await sdk.WebHidTransport.open({ forceRequest: false });
  const path =
    derivationPath ??
    (appName === 'solana' ? "m/44'/501'/0'/0'" : "m/44'/118'/0'/0/0");
  const signer = new sdk.HwSigner({ transport, appName, derivationPath: path });
  const publicKey = await signer.publicKey();
  // v0.4: HW 계정의 "주소" 는 chain-adapter 에 의해 후속 단계에서 계산된다.
  // 현재는 pubkey 헥스 prefix 를 디스플레이용으로 사용한다 (실제 체인 주소는
  // 어댑터 통합 시 채워 넣는다 — TODO v0.5).
  const address = hexPreview(publicKey);
  const account: HwAccountState = { appName, address, derivationPath: path, publicKey };
  hwState = { signer, transport, account };
  emitHwChange();
  return account;
}

/** WebHID 트랜스포트 종료 후 상태 비움. */
export async function disconnectHardware(): Promise<void> {
  if (!hwState) return;
  try {
    await hwState.transport.close();
  } catch {
    // 디바이스가 이미 빠진 경우 등 — silent.
  }
  hwState = null;
  emitHwChange();
}

function hexPreview(bytes: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return s;
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
