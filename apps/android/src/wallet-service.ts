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
  });
}
