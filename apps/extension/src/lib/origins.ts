// 벼린 — 연결 승인 origin 관리 모듈.
//
// EIP-1102/1193 의 명시적 사용자 동의(per-origin consent)를 영속화한다.
// chrome.storage.local 에는 origin 문자열 배열만 저장한다.
// !!! 보안 경계: 니모닉/세션 정보는 절대 local 에 저장하지 않는다(session 전용). !!!
//
// 형식: 'https://example.com' (스킴 + 호스트, 포트 포함, 경로 미포함).

const KEY = 'nd:approved-origins';

export type Origin = string;

/** 원문 URL 또는 origin 문자열을 정규화한다. 실패 시 null. */
export function normalizeOrigin(input: string | undefined | null): Origin | null {
  if (!input || typeof input !== 'string') return null;
  try {
    const u = new URL(input);
    // origin 은 'scheme://host[:port]' — URL 객체가 자동 산출.
    // 스킴 화이트리스트: http/https/localhost 만 허용.
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

export async function listApprovedOrigins(): Promise<Origin[]> {
  const out = await chrome.storage.local.get(KEY);
  const v = out[KEY] as Origin[] | undefined;
  return Array.isArray(v) ? v.slice() : [];
}

export async function isOriginApproved(origin: Origin | null): Promise<boolean> {
  if (!origin) return false;
  const all = await listApprovedOrigins();
  return all.includes(origin);
}

export async function approveOrigin(origin: Origin): Promise<void> {
  const all = await listApprovedOrigins();
  if (all.includes(origin)) return;
  all.push(origin);
  await chrome.storage.local.set({ [KEY]: all });
}

export async function revokeOrigin(origin: Origin): Promise<void> {
  const all = await listApprovedOrigins();
  const next = all.filter((o) => o !== origin);
  await chrome.storage.local.set({ [KEY]: next });
}
