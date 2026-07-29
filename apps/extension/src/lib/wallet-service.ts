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
//
// **WebHidTransport / HwSigner 는 값으로 정적 import**. 이전엔 type-only +
// 동적 import 였는데 vite/rollup 이 wallet-sdk/core 의 결과물을 popup chunk
// 가 아닌 다른 chunk (origins, background) 로 옮기면서 sideEffects:false 와
// 결합해 namespace member 들을 tree-shake — 런타임에 sdk.WebHidTransport 가
// undefined 가 됐다. core entry 는 cosmos/ton 같은 무거운 deps 가 없어 popup
// chunk 에 포함돼도 부담이 없다.
import {
  HwSigner,
  WebHidTransport,
  type HwAppName,
  type WalletAccount,
} from '@byeorin/wallet-sdk/core';
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

// ERC-20 토큰 레지스트리 — popup 마운트마다 새로 만들지 않고 한 번만.
// 사용자 커스텀 토큰을 누적해야 하므로 singleton 이 자연스럽다.
// chrome.storage.local 의 'nd:custom-tokens' 키로 영속화 — popup 부팅 시
// loadCustomTokensFromStorage() 가 storage → registry 로 복원한다.
const tokenRegistry = new TokenRegistry();

const CUSTOM_TOKENS_KEY = 'nd:custom-tokens';

// 영속화 형식: { [chainId]: TokenInfo[] }
type CustomTokensStored = Record<string, TokenInfo[]>;

let _customTokensLoaded = false;

// TTL 메인넷. 발행 목록 API 를 가진 유일한 체인이라 여기서만 자동 로드한다.
const TTL_CHAIN_ID = 7777;
let _ttlScanTokensLoaded = false;

/** chrome.storage.local 에서 사용자 커스텀 토큰을 registry 로 복원. 멱등. */
export async function loadCustomTokensFromStorage(): Promise<void> {
  if (_customTokensLoaded) return;
  _customTokensLoaded = true;
  try {
    const data = (await chrome.storage.local.get(CUSTOM_TOKENS_KEY)) as Record<
      string,
      CustomTokensStored | undefined
    >;
    const stored = data[CUSTOM_TOKENS_KEY];
    if (!stored) return;
    for (const [chainIdStr, tokens] of Object.entries(stored)) {
      const chainId = Number(chainIdStr);
      if (!Number.isFinite(chainId)) continue;
      for (const t of tokens) tokenRegistry.addCustomToken(chainId, t);
    }
  } catch {
    // storage 비가용 — 다음 popup mount 에서 다시 시도.
    _customTokensLoaded = false;
  }
}

/**
 * TTL Scan 이 들고 있는 발행 토큰 목록을 registry 에 넣는다. 멱등.
 *
 * 왜: 레지스트리의 BUILTIN 은 코드에 박힌 목록이라, 체인에 새 토큰이 발행돼도
 * 확장을 새로 배포하기 전까지 보이지 않는다. 실제로 스테이블 66 종이 발행됐는데
 * 지갑에는 하나도 안 떴다. 사용자가 주소를 손으로 넣을 이유가 없다 —
 * 발행 사실은 이미 공개돼 있다.
 *
 * 목록은 **무엇을 조회할지**만 정한다. 잔액은 여기서 안 받고 체인에서
 * balanceOf 로 읽는다. 가짜 주소는 환율이 안 붙는다. decimals 는 스냅샷 값이 이긴다 — 익스플로러가 그걸로 표시 수량을 부풀릴 수 있기 때문이다.
 *
 * storage 에 저장하지 않는다 — 발행 목록은 체인 쪽 사실이라 매번 최신을 받는
 * 편이 맞고, 사용자가 손으로 추가한 토큰과 섞이면 지울 수도 없어진다.
 * 실패하면 조용히 빌트인만 쓴다 (fetchTtlScanTokens 가 빈 배열을 준다).
 */
export async function loadTtlScanTokens(chainId: number = TTL_CHAIN_ID): Promise<number> {
  if (chainId !== TTL_CHAIN_ID) return 0;
  if (_ttlScanTokensLoaded) return 0;
  const tokens = await fetchTtlScanTokens();
  if (tokens.length === 0) return 0;
  _ttlScanTokensLoaded = true;
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

/** 새 커스텀 토큰을 registry + storage 양쪽에 등록. 중복 주소는 silently no-op. */
async function persistCustomToken(chainId: number, info: TokenInfo): Promise<void> {
  tokenRegistry.addCustomToken(chainId, info);
  try {
    const data = (await chrome.storage.local.get(CUSTOM_TOKENS_KEY)) as Record<
      string,
      CustomTokensStored | undefined
    >;
    const map: CustomTokensStored = data[CUSTOM_TOKENS_KEY] ?? {};
    const key = String(chainId);
    const list = map[key] ?? [];
    if (!list.some((t) => t.address.toLowerCase() === info.address.toLowerCase())) {
      list.push(info);
      map[key] = list;
      await chrome.storage.local.set({ [CUSTOM_TOKENS_KEY]: map });
    }
  } catch {
    // storage 실패해도 메모리 registry 는 갱신된 상태. 다음 mount 때 복원 안 됨.
  }
}

/**
 * 컨트랙트 주소 → ERC-20 metadata (symbol/name/decimals) 자동 fetch 후
 * registry 와 storage 에 등록. 잘못된 주소면 throw.
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
  const info: TokenInfo = {
    address: addr,
    symbol,
    name,
    decimals,
    custom: true,
  };
  await persistCustomToken(chainId, info);
  return info;
}

/**
 * EVM 체인의 보유 토큰 자동 탐색. 기본은 양수 잔액만 (첫 인상 깔끔).
 * `includeZero: true` 면 잔액 0 토큰도 포함 ("전체 보기" 토글용).
 */
export async function discoverEvmTokens(
  adapter: EvmAdapter,
  ownerAddress: string,
  opts: { includeZero?: boolean } = {},
): Promise<DiscoveredBalance[]> {
  return discoverTokens(adapter, tokenRegistry, ownerAddress as `0x${string}`, {
    includeZero: opts.includeZero,
    // 기본 상한 50 은 TTL 발행 66 종을 조용히 잘라낸다 — 잘린 토큰은 잔액이
    // 있어도 화면에 안 나온다. 여유를 둬 전부 본다.
    maxRpcCalls: 256,
  });
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
  // top-level 정적 import 로 받은 값 사용 — dynamic import 시도는 tree-shake
  // 에 의해 namespace 가 비어버리는 위험이 있었다 (직전 인시던트).
  //
  // 명시 진단: 어떤 식별자가 undefined 인지 정확히 알려줘 후속 디버깅을 단축.
  // 정적 import 가 성공한 정상 빌드라면 두 식별자 모두 함수/클래스로 도달한다.
  // 사용자 console 에 명확한 메시지가 나오면 (a) chrome 캐시 / (b) tree-shake /
  // (c) ESM-CJS interop 중 어느 쪽인지 즉시 판별 가능.
  if (typeof WebHidTransport === 'undefined' || typeof WebHidTransport.open !== 'function') {
    throw new Error(
      `wallet-service: WebHidTransport unavailable (got ${typeof WebHidTransport}). ` +
        `Try removing the unpacked extension at chrome://extensions/ and re-loading ` +
        `apps/extension/.output/chrome-mv3. If this persists, the bundle is corrupt — ` +
        `report this with the full popup console log.`,
    );
  }
  if (typeof HwSigner !== 'function') {
    throw new Error(
      `wallet-service: HwSigner unavailable (got ${typeof HwSigner}). ` +
        `Same remedy as WebHidTransport unavailable.`,
    );
  }
  // `WebHidTransport.open` 안에서 ledger 가 `device.open()` 호출 시 device 가
  // undefined 인 케이스를 친절하게 풀어 설명한다. 흔한 원인:
  //   1) Ledger 가 USB 에 안 꽂혀 있음 — chooser 가 빈 채 뜸
  //   2) 사용자가 chooser 에서 'Cancel'
  //   3) Chrome MV3 popup blur 로 chooser 가 강제 닫힘 (popup 클릭 후 다른
  //      창을 만지면 popup 이 사라지고 chooser 도 같이 닫힘 — 알려진 함정)
  //   4) Ledger 가 다른 앱에 점유 중 (Ledger Live 가 켜져있는 등)
  // 위 모두 ledger 내부에서는 `undefined.open` 형태의 raw TypeError 로 표면화된다.
  let transport;
  try {
    transport = await WebHidTransport.open({ forceRequest: false });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("reading 'open'") ||
      msg.toLowerCase().includes('no device') ||
      msg.toLowerCase().includes('cancel')
    ) {
      throw new Error(
        'Ledger 디바이스를 찾지 못했거나 선택이 취소되었습니다. ' +
          '확인사항: ① Ledger 를 USB 에 연결 ② 디바이스 잠금 해제(PIN 입력) ' +
          '③ Ledger Live 가 켜져있다면 종료 (앱 점유 충돌) ' +
          '④ 디바이스에서 해당 앱(Solana/Cosmos)을 연 뒤 다시 시도. ' +
          '※ MV3 popup 의 chooser 가 다른 창 클릭으로 닫히는 함정도 있으니, ' +
          '버튼 클릭 후 chooser 가 뜨면 popup 영역에서 마우스를 떼지 않은 채로 ' +
          '선택해 주세요.',
      );
    }
    throw e;
  }
  const path =
    derivationPath ??
    (appName === 'solana' ? "m/44'/501'/0'/0'" : "m/44'/118'/0'/0/0");
  const signer = new HwSigner({ transport, appName, derivationPath: path });
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
  const data = (await chrome.storage.local.get(MANUAL_TOKENS_KEY)) as Record<string, unknown>;
  return data[MANUAL_TOKENS_KEY];
}

async function writeManualRaw(all: ManualTokensStored): Promise<void> {
  await chrome.storage.local.set({ [MANUAL_TOKENS_KEY]: all });
}
