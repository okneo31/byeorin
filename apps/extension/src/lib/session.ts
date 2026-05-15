// chrome.storage.session 래퍼 — 메모리 한정(브라우저 세션 종료 시 휘발).
//
// v0.1 스켈레톤에서는 니모닉을 평문으로 session 에 보관한다.
// TODO(v0.2): passphrase 기반 keystore(AES-GCM + scrypt) 로 전환하고
// 평문 니모닉은 잠금 해제 시점에만 잠시 메모리로 풀고, lock 시 즉시 폐기한다.

const KEY = 'nodong.session';

export interface SessionState {
  mnemonic: string;
  address: string;
}

export async function readSession(): Promise<SessionState | null> {
  // chrome.storage.session 은 service worker / popup 양쪽에서 사용 가능.
  const out = await chrome.storage.session.get(KEY);
  const v = out[KEY] as SessionState | undefined;
  return v ?? null;
}

export async function writeSession(state: SessionState): Promise<void> {
  await chrome.storage.session.set({ [KEY]: state });
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}
