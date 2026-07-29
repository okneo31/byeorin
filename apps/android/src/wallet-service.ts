// wallet-service.ts — 안드로이드 셸의 WalletStore 인스턴스 + ERC-20 레지스트리.
//
// 확장판(apps/extension/src/lib/wallet-service.ts)과 같은 역할이되 두 가지가 다르다:
//   - 세션 저장소가 `chrome.storage.session` 이 아니라 비밀번호로 봉인된
//     localStorage 금고(keystore-session.ts)다.
//   - HW(WebHID)/dApp grants 가 없다. Android WebView 에는 WebHID 자체가 없고,
//     인젝션할 페이지도 없기 때문. (HW 는 USB-OTG 네이티브 플러그인으로 별도 트랙.)
//
// import 폭 주의: 여기서 `@byeorin/wallet-sdk` 메인 barrel 을 쓰면 9 체인
// 라이브러리가 초기 청크로 끌려와 첫 화면이 5MB 를 기다리게 된다. core + evm
// 만 정적으로 쓰고, 나머지는 App 이 multichain 을 dynamic import 한다.

import {
  EvmAdapter,
  Erc20,
  TTL_CHAIN,
  TokenRegistry,
  discoverTokens,
  fetchTtlScanTokens,
  authoritativeDecimals,
  type DiscoveredBalance,
  type TokenInfo,
} from '@byeorin/wallet-sdk/evm';
import { createWalletStore } from '@byeorin/shell-core';
import { keystoreSession } from './keystore-session.js';

export const walletStore = createWalletStore({
  defaultAdapter: new EvmAdapter({ chain: TTL_CHAIN }),
  session: keystoreSession,
});

/** TTL 어댑터 (기본 체인). */
export function getTtlAdapter(): EvmAdapter {
  return walletStore.getDefaultAdapter() as EvmAdapter;
}

// ── 사용자 커스텀 ERC-20 ───────────────────────────────────────────────────
//
// 레지스트리는 싱글턴 — 사용자가 추가한 토큰이 화면 전환마다 날아가면 안 된다.
// 영속화 위치는 localStorage (`byeorin:custom-tokens`). 시드가 아니라 공개
// 메타데이터이므로 암호화 대상이 아니다.

const tokenRegistry = new TokenRegistry();
const CUSTOM_TOKENS_KEY = 'byeorin:custom-tokens';

/** 영속화 형식: { [chainId]: TokenInfo[] } */
type CustomTokensStored = Record<string, TokenInfo[]>;

let customTokensLoaded = false;

// TTL 메인넷. 발행 목록 API 를 가진 유일한 체인이라 여기서만 자동 로드한다.
const TTL_CHAIN_ID = 7777;
let ttlScanTokensLoaded = false;

function readStored(): CustomTokensStored {
  try {
    const raw = localStorage.getItem(CUSTOM_TOKENS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as CustomTokensStored;
  } catch {
    return {};
  }
}

/** localStorage → registry 복원. 멱등. */
export async function loadCustomTokensFromStorage(): Promise<void> {
  if (customTokensLoaded) return;
  customTokensLoaded = true;
  const stored = readStored();
  for (const [chainIdStr, tokens] of Object.entries(stored)) {
    const chainId = Number(chainIdStr);
    if (!Number.isFinite(chainId) || !Array.isArray(tokens)) continue;
    for (const t of tokens) tokenRegistry.addCustomToken(chainId, t);
  }
}

/**
 * TTL Scan 이 들고 있는 발행 토큰 목록을 registry 에 넣는다. 멱등.
 *
 * 왜: 레지스트리의 BUILTIN 은 코드에 박힌 목록이라, 체인에 새 토큰이 발행돼도
 * 앱을 새로 배포하기 전까지 보이지 않는다. 실제로 스테이블 66 종이 발행됐는데
 * 지갑에는 하나도 안 떴다. 사용자가 주소를 손으로 넣을 이유가 없다 —
 * 발행 사실은 이미 공개돼 있다.
 *
 * 목록은 **무엇을 조회할지**만 정한다. 잔액은 여기서 안 받고 체인에서
 * balanceOf 로 읽는다. 가짜 주소는 환율이 안 붙는다. decimals 는 스냅샷 값이 이긴다 — 익스플로러가 그걸로 표시 수량을 부풀릴 수 있기 때문이다.
 *
 * localStorage 에 저장하지 않는다 — 발행 목록은 체인 쪽 사실이라 매번 최신을
 * 받는 편이 맞고, 사용자가 손으로 추가한 토큰과 섞이면 지울 수도 없어진다.
 * 실패하면 조용히 빌트인만 쓴다 (fetchTtlScanTokens 가 빈 배열을 준다).
 */
export async function loadTtlScanTokens(chainId: number = TTL_CHAIN_ID): Promise<number> {
  if (chainId !== TTL_CHAIN_ID) return 0;
  if (ttlScanTokensLoaded) return 0;
  const tokens = await fetchTtlScanTokens();
  if (tokens.length === 0) return 0;
  ttlScanTokensLoaded = true;
  for (const t of tokens) {
    // 익스플로러가 준 decimals 를 그대로 믿지 않는다. 환율 스냅샷은 저장소에
    // 커밋된 앵커라 같은 주소의 정답을 이미 들고 있고, 그쪽이 이긴다.
    // 안 그러면 익스플로러가 장악됐을 때 보여지는 수량이 임의 배율로 부푼다.
    tokenRegistry.addCustomToken(chainId, {
      ...t,
      decimals: authoritativeDecimals(t.address, t.decimals),
    });
  }
  return tokens.length;
}

/** registry + localStorage 양쪽에 등록. 중복 주소는 no-op. */
function persistCustomToken(chainId: number, info: TokenInfo): void {
  tokenRegistry.addCustomToken(chainId, info);
  try {
    const map = readStored();
    const key = String(chainId);
    const list = map[key] ?? [];
    if (!list.some((t) => t.address.toLowerCase() === info.address.toLowerCase())) {
      list.push(info);
      map[key] = list;
      localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(map));
    }
  } catch {
    // 저장 실패해도 메모리 registry 는 갱신된 상태 — 다음 실행에서만 사라진다.
  }
}

/**
 * 컨트랙트 주소 → ERC-20 메타데이터를 체인에서 읽어 registry + 저장소에 등록.
 * 주소가 ERC-20 이 아니면 throw.
 */
export async function addCustomErc20(
  adapter: EvmAdapter,
  chainId: number,
  contractAddress: string,
): Promise<TokenInfo> {
  const erc20 = new Erc20(adapter);
  const addr = contractAddress.trim() as `0x${string}`;
  const [symbol, name, decimals] = await Promise.all([
    erc20.symbol(addr),
    erc20.name(addr),
    erc20.decimals(addr),
  ]);
  const info: TokenInfo = { address: addr, symbol, name, decimals, custom: true };
  persistCustomToken(chainId, info);
  return info;
}

/** EVM 체인의 보유 토큰 자동 탐색. 기본은 양수 잔액만. */
export async function discoverEvmTokens(
  adapter: EvmAdapter,
  ownerAddress: string,
  opts: { includeZero?: boolean } = {},
): Promise<DiscoveredBalance[]> {
  return discoverTokens(adapter, tokenRegistry, ownerAddress as `0x${string}`, {
    includeZero: opts.includeZero,
    // 기본 상한 50 은 TTL 발행 66 종을 조용히 잘라낸다 — 잘린 토큰은 잔액이
    // 있어도 화면에 안 나온다. 여유를 둬 전부 본다. TTL RPC 는 병렬 조회를
    // 감당한다(배치 50건 209ms 실측).
    maxRpcCalls: 256,
  });
}
// ────────── 체인 무관 수동 토큰 저장소 ──────────
//
// 왜 별도인가: 기존 `nd:custom-tokens` 는 `Record<chainId(number), TokenInfo[]>`
// 다. chainId 는 EVM 에만 있는 개념이라 Solana·Cosmos·XRP 를 담을 수 없다.
// 그래서 chainKey(`evm:ttl`, `solana`, `cosmos:zion`) 로 키를 잡는 저장소를
// 따로 둔다. 기존 것을 마이그레이션하지 않는 이유는 EVM 커스텀 토큰이 이미
// 레지스트리 경로로 잘 동작하고 있어서, 건드리면 회귀만 생기기 때문이다.
//
// **잔액은 저장하지 않는다.** 잔액은 체인의 현재 상태라 저장하는 순간 거짓이
// 된다. 식별자와 메타데이터만 남기고 잔액은 매번 어댑터에게 다시 묻는다.

const MANUAL_TOKENS_KEY = 'nd:manual-tokens';

/** 저장 형식 — 잔액 없는 메타데이터만. */
export interface ManualTokenRecord {
  id: string;
  symbol: string;
  name: string;
  decimals: number;
  /** 읽어온 출처(체인 직접 / 인덱서). 화면이 신뢰도를 표시한다. */
  source?: string;
}

type ManualTokensStored = Record<string, ManualTokenRecord[]>;

function sameId(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** chainKey 별 수동 추가 토큰 목록. 실패하면 빈 객체 — 지갑을 막지 않는다. */
export async function loadManualTokens(): Promise<ManualTokensStored> {
  try {
    const raw = await readManualRaw();
    if (!raw || typeof raw !== 'object') return {};
    const out: ManualTokensStored = {};
    for (const [chainKey, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const kept = list.filter(isManualRecord);
      if (kept.length > 0) out[chainKey] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** 추가. 같은 id 가 이미 있으면 메타데이터를 갱신한다. */
export async function addManualToken(
  chainKey: string,
  token: ManualTokenRecord,
): Promise<void> {
  if (!isManualRecord(token)) {
    // decimals 가 틀린 값을 저장하면 그 뒤로 계속 거짓 잔액을 보여준다.
    throw new Error('수동 토큰 형식이 올바르지 않습니다.');
  }
  const all = await loadManualTokens();
  const list = all[chainKey] ?? [];
  const idx = list.findIndex((t) => sameId(t.id, token.id));
  if (idx >= 0) list[idx] = token;
  else list.push(token);
  all[chainKey] = list;
  await writeManualRaw(all);
}

/** 제거. 없으면 no-op. */
export async function removeManualToken(chainKey: string, id: string): Promise<void> {
  const all = await loadManualTokens();
  const list = all[chainKey];
  if (!list) return;
  const next = list.filter((t) => !sameId(t.id, id));
  if (next.length === 0) delete all[chainKey];
  else all[chainKey] = next;
  await writeManualRaw(all);
}

/**
 * 저장된 값이 쓸 만한지 본다. **decimals 가 정수가 아니면 버린다** — 저장소가
 * 손상됐거나 옛 형식이 섞였을 때 거짓 잔액을 화면에 올리지 않기 위한 방어선이다.
 */
function isManualRecord(v: unknown): v is ManualTokenRecord {
  if (typeof v !== 'object' || v === null) return false;
  const t = v as ManualTokenRecord;
  return (
    typeof t.id === 'string' &&
    t.id.length > 0 &&
    typeof t.symbol === 'string' &&
    typeof t.name === 'string' &&
    typeof t.decimals === 'number' &&
    Number.isInteger(t.decimals) &&
    t.decimals >= 0 &&
    t.decimals <= 36
  );
}

async function readManualRaw(): Promise<unknown> {
  const raw = localStorage.getItem(MANUAL_TOKENS_KEY);
  return raw === null ? undefined : (JSON.parse(raw) as unknown);
}

async function writeManualRaw(all: ManualTokensStored): Promise<void> {
  localStorage.setItem(MANUAL_TOKENS_KEY, JSON.stringify(all));
}
