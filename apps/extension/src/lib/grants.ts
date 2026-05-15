// 노동자의 지갑 — origin+method 별 "1시간 자동 승인" 저장소.
//
// 정책 요약:
//  - 저장: chrome.storage.session (휘발) — 브라우저 재시작 또는 lock() 시 사라진다.
//  - 키: `${origin}::${method}` → expiry epoch(ms).
//  - 사용자가 confirm popup 에서 "이 사이트에서 1시간 동안 자동 승인" 체크박스를
//    켜고 승인하면 본 모듈이 grant 를 기록한다. 다음 동일 origin+method 호출은
//    popup 없이 즉시 통과.
//  - 만료/취소 시 즉시 삭제. lock() 흐름은 clearAllGrants() 를 호출해 전체 무효화.
//
// 보안 경계:
//  - grants 는 origin 별 "connect 동의" 보다 좁은 권한. connect 가 안 된 dApp 은
//    isOriginApproved 체크 단계에서 이미 거절되므로 grant 는 보조 게이트일 뿐.
//  - personal_sign / eth_sendTransaction / eth_signTypedData_v4 각각 별도 grant.
//  - 서명 대상(메시지/typed data 내용) 자체에는 묶이지 않는다 — 1시간 안에는
//    동일 origin 이 임의 메시지를 자동 서명받을 수 있다는 점을 사용자에게 경고한다.

const KEY = 'nd:method-grants';

export type GrantMethod =
  | 'personal_sign'
  | 'eth_sendTransaction'
  | 'eth_signTypedData_v4';

export type GrantRecord = {
  origin: string;
  method: GrantMethod;
  expiresAt: number; // epoch ms
};

type GrantMap = Record<string, number>; // key -> expiresAt

/** "1시간" 정책 — 정확히 60분. 만료 시점에 도달하면 즉시 무효. */
export const GRANT_TTL_MS = 60 * 60 * 1000;

function makeKey(origin: string, method: GrantMethod): string {
  return `${origin}::${method}`;
}

function parseKey(key: string): { origin: string; method: GrantMethod } | null {
  const idx = key.lastIndexOf('::');
  if (idx < 0) return null;
  const origin = key.slice(0, idx);
  const method = key.slice(idx + 2) as GrantMethod;
  if (
    method !== 'personal_sign' &&
    method !== 'eth_sendTransaction' &&
    method !== 'eth_signTypedData_v4'
  ) {
    return null;
  }
  return { origin, method };
}

async function readAll(): Promise<GrantMap> {
  // chrome.storage.session 은 MV3 에서 background 와 popup 이 공유. 잠금 시 clear.
  const out = await chrome.storage.session.get(KEY);
  const v = out[KEY] as GrantMap | undefined;
  return v && typeof v === 'object' ? v : {};
}

async function writeAll(map: GrantMap): Promise<void> {
  await chrome.storage.session.set({ [KEY]: map });
}

/** 만료된 항목을 정리한 사본을 반환. (저장소 갱신은 호출부 책임) */
function compact(map: GrantMap, now: number): GrantMap {
  const next: GrantMap = {};
  for (const [k, v] of Object.entries(map)) {
    if (typeof v === 'number' && v > now) next[k] = v;
  }
  return next;
}

/**
 * origin+method 에 유효한 grant 가 있는지 확인. 만료된 항목은 부수효과로 정리.
 */
export async function hasGrant(origin: string, method: GrantMethod): Promise<boolean> {
  const now = Date.now();
  const map = await readAll();
  const key = makeKey(origin, method);
  const exp = map[key];
  if (typeof exp !== 'number' || exp <= now) {
    // 만료/부재. 만료된 항목이 섞여 있으면 청소.
    if (exp !== undefined) {
      const next = compact(map, now);
      await writeAll(next);
    }
    return false;
  }
  return true;
}

/** GRANT_TTL_MS 만큼 grant 발급(또는 갱신). */
export async function addGrant(origin: string, method: GrantMethod): Promise<void> {
  const now = Date.now();
  const map = compact(await readAll(), now);
  map[makeKey(origin, method)] = now + GRANT_TTL_MS;
  await writeAll(map);
}

/** 단일 grant 취소. */
export async function revokeGrant(origin: string, method: GrantMethod): Promise<void> {
  const map = await readAll();
  const key = makeKey(origin, method);
  if (!(key in map)) return;
  delete map[key];
  await writeAll(map);
}

/**
 * 특정 origin 의 모든 grant 제거(연결 해제 시 호출 권장).
 */
export async function revokeAllForOrigin(origin: string): Promise<void> {
  const map = await readAll();
  let changed = false;
  for (const k of Object.keys(map)) {
    const parsed = parseKey(k);
    if (parsed && parsed.origin === origin) {
      delete map[k];
      changed = true;
    }
  }
  if (changed) await writeAll(map);
}

/**
 * 모든 grant 삭제. lock() 흐름에서 호출 — chrome.storage.session 자체는 lock 시
 * shell-core 의 ExtensionSessionStore.clear() 가 니모닉만 비우므로, grants 키는
 * 명시적으로 지워야 한다.
 */
export async function clearAllGrants(): Promise<void> {
  await chrome.storage.session.remove(KEY);
}

/** 활성(미만료) grant 의 평탄 리스트. UI 표시용. */
export async function listActiveGrants(): Promise<GrantRecord[]> {
  const now = Date.now();
  const map = await readAll();
  const out: GrantRecord[] = [];
  for (const [k, v] of Object.entries(map)) {
    if (typeof v !== 'number' || v <= now) continue;
    const parsed = parseKey(k);
    if (!parsed) continue;
    out.push({ origin: parsed.origin, method: parsed.method, expiresAt: v });
  }
  // 만료된 항목이 있었으면 청소(부수효과 OK — 다음 호출이 가벼워진다).
  const compacted = compact(map, now);
  if (Object.keys(compacted).length !== Object.keys(map).length) {
    await writeAll(compacted);
  }
  return out;
}
