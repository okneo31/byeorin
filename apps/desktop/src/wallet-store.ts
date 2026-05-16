// 셸 공용 WalletStore 의 desktop 인스턴스.
// Tauri 웹뷰는 sessionStorage 시맨틱이 일반 브라우저와 동일하므로 WebSessionStore 사용.

import {
  EvmAdapter,
  TTL_CHAIN,
  type HwAppName,
  type HwSigner,
  type WebHidTransport,
} from '@nodong/wallet-sdk';
import { createWalletStore, WebSessionStore } from '@nodong/shell-core';

export const walletStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: new WebSessionStore(),
});

// ── HW(하드웨어) 계정 — 데스크톱 ──────────────────────────────────────────
//
// Tauri 2 의 webview 는 Windows/macOS/Linux 에서 WebHID 를 지원한다 (`tauri.conf`
// 의 capability 설정 필요 — TODO 별도 PR). 본 모듈은 브라우저-호환 경로만 쓰므로
// extension/desktop 양쪽에서 동일하게 동작한다.
//
// node-hid 직속 경로는 v0.5 로 이연. 그때까지 데스크톱도 webview WebHID 만 쓴다.

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

function emit(): void {
  for (const l of hwListeners) l(hwState?.account ?? null);
}

export function subscribeHwState(
  fn: (s: HwAccountState | null) => void,
): () => void {
  hwListeners.add(fn);
  fn(hwState?.account ?? null);
  return () => {
    hwListeners.delete(fn);
  };
}

export function getHwAccount(): HwAccountState | null {
  return hwState?.account ?? null;
}

export async function connectHardware(
  appName: HwAppName,
  derivationPath?: string,
): Promise<HwAccountState> {
  const sdk = await import('@nodong/wallet-sdk');
  const transport = await sdk.WebHidTransport.open({ forceRequest: false });
  const path =
    derivationPath ??
    (appName === 'solana' ? "m/44'/501'/0'/0'" : "m/44'/118'/0'/0/0");
  const signer = new sdk.HwSigner({ transport, appName, derivationPath: path });
  const publicKey = await signer.publicKey();
  const address = hexPreview(publicKey);
  const account: HwAccountState = { appName, address, derivationPath: path, publicKey };
  hwState = { signer, transport, account };
  emit();
  return account;
}

export async function disconnectHardware(): Promise<void> {
  if (!hwState) return;
  try {
    await hwState.transport.close();
  } catch {
    // silent
  }
  hwState = null;
  emit();
}

function hexPreview(bytes: Uint8Array): string {
  let s = '0x';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  }
  return s;
}
