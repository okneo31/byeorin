import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { parseUnits } from 'viem';
import {
  createMnemonic,
  getWordlist,
  type ChainAdapter,
  type TransferIntent,
  type WordlistName,
} from '@byeorin/wallet-sdk/core';
// 타입만 정적 import — 런타임 코드는 0. 16 체인 어댑터 값(DEFAULT_CHAINS)은
// popup mount 시 dynamic import 로 가져와 초기 번들을 가볍게 유지한다.
import type {
  ChainSpec,
  ZionAmmClient as ZionAmmClientType,
  ZionPool,
  ZionSwapQuote,
} from '@byeorin/wallet-sdk/multichain';
import { ShellError, type AccountInfo } from '@byeorin/shell-core';
import { LocaleSwitch, useT } from '@byeorin/i18n/react';
import type { DiscoveredBalance, EvmAdapter } from '@byeorin/wallet-sdk/evm';
import {
  addCustomErc20,
  discoverEvmTokens,
  loadCustomTokensFromStorage,
  walletStore,
} from './wallet-service.js';
import {
  keystoreSession,
  MIN_PASSPHRASE_LENGTH,
} from './keystore-session.js';
import { installAutoLock } from './autolock.js';
import { installBackButton } from './back-button.js';
import { nativeFetch } from './native-http.js';

// 벼린 — 안드로이드 셸 (WebView).
//
// 확장 popup(apps/extension/entrypoints/popup/App.tsx)에서 갈라져 나온 화면이다.
// 9 체인·다중 계정·ZION 스왑까지 동일하게 들고 오되, 플랫폼이 없는 기능은 뺐다:
//   - HW(Ledger/WebHID)  → Android WebView 에 WebHID 가 없다. USB-OTG 네이티브
//                          플러그인이 필요하므로 별도 트랙.
//   - 연결된 사이트/grants → 인젝션할 dApp 페이지가 없다 (EIP-1193 는 확장 전용).
// 대신 앱에만 필요한 계층이 하나 붙는다: 비밀번호로 봉인되는 영구 금고
// (keystore-session.ts). 앱은 껐다 켜도 지갑이 남아 있어야 하기 때문.
//
// 셸 라이프사이클:
//   금고 없음 → (생성/복구) → 비밀번호 설정 → 잠금해제
//   금고 있음 → 비밀번호 입력 → 잠금해제
//   잠금해제 → (계정 추가/전환/제거/키 노출/송금/스왑) → 잠금(금고는 유지)
//
// 잠금해제 후의 mode:
//   - 'home'       : 계정 목록 + 활성 계정 카드
//   - 'add-menu'   : 새 시드 / 복구 / private key import 3개 선택
//   - 'import-pk'  : raw private key 입력 흐름
//   - 'export'     : 활성 계정의 비밀 키 노출 (경고 + 체크박스 게이트)
//   - 'create'     : 3 단계 시드 생성 (잠금 전/후 공용)
//   - 'restore'    : 시드 복구 입력 (잠금 전/후 공용)
//   - 'set-pass'   : 첫 시드 확보 후 금고 비밀번호 설정 (잠금 전 전용)

type Mode =
  | 'home'
  | 'create'
  | 'restore'
  | 'add-menu'
  | 'import-pk'
  | 'export'
  | 'send'
  | 'swap'
  | 'set-pass';

// 송금 금액 검증 — 10진수, 소수점 18자리 이하 (체인별 decimals 는 parseUnits 가 처리).
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

// ZION Phase 1 의 4종 자산 — ActiveAccountCard 와 SwapPane 양쪽이 공유.
// ZionWallet.MD §3 표 그대로. ueth 가 표준 ETH 18 이 아닌 6 decimals 인 점 주의.
type ZionAsset = { denom: string; symbol: string; decimals: number };
const ZION_ASSETS: readonly ZionAsset[] = [
  { denom: 'utrg', symbol: 'kWR', decimals: 6 },
  { denom: 'ubtc', symbol: 'BTC', decimals: 8 },
  { denom: 'uusdt', symbol: 'USDT', decimals: 6 },
  { denom: 'ueth', symbol: 'ETH', decimals: 6 },
];

// 가치 표시 — 잔액을 BTC 단위로 보여주고, 클릭하면 USD 토글.
//
// 시세 출처: Binance `api/v3/ticker/price` 전체 ticker 1회 fetch + 메모리 캐시.
// 각 코인의 BTC pair (예: ETHBTC, SOLBTC) 와 BTCUSDT 만 사용한다.
//
// 미상장 토큰의 페그 — Binance 에 없는 토큰은 BTC 페그로 내재 가치를 둔다.
//   TTL  : 1/300,000 BTC (사용자 정의)
//   kWR  : 1/300,000 BTC (ZION, 미상장 — 후속 확인. TTL 과 동일 가정)
const PRICE_PEG_TO_BTC: Record<string, number> = {
  TTL: 1 / 300_000,
  kWR: 1 / 300_000,
};

/** shell-core 도메인 에러를 i18n 키로 변환. 그 외 Error 는 메시지 그대로. */
function localizeShellError(t: (k: string) => string, e: unknown, fallback: string): string {
  if (e instanceof ShellError) return t(`errors.${e.code}`);
  if (e instanceof Error) return e.message || fallback;
  return fallback;
}

export function App() {
  const t = useT();
  // 다중 계정 상태 — walletStore.listAccounts() 의 메모리 스냅샷.
  // 모든 add/remove/select/lock 후에 refreshAccounts 로 동기화한다.
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [mode, setMode] = useState<Mode>('home');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 금고 상태 — 디스크에 암호화 blob 이 있는지. 첫 화면 분기의 기준.
  const [hasVault, setHasVault] = useState<boolean>(() => keystoreSession.hasVault());
  // 'set-pass' 단계로 넘어갈 때 임시로 붙들고 있는 시드. 비밀번호가 정해지는
  // 즉시 금고에 봉인되고 여기서 비워진다.
  const pendingMnemonic = useRef<string | null>(null);
  // 멀티체인 — 16 체인 spec 은 dynamic import 로 로드. 로드 전엔 null (TTL fallback).
  const [chainSpecs, setChainSpecs] = useState<ChainSpec[] | null>(null);
  const [chainSpecsErr, setChainSpecsErr] = useState<string | null>(null);
  const [activeChainKey, setActiveChainKey] = useState<string>('evm:ttl');
  // Binance 시세 캐시 (popup mount 시 1회 fetch). symbol → price (USDT 또는 BTC pair).
  // 예: prices['BTCUSDT']=61234, prices['ETHBTC']=0.0521, ...
  const [prices, setPrices] = useState<Record<string, number> | null>(null);
  // BTC ↔ USD 토글 — 모든 활성 계정 카드가 공유 (사용자가 한 번 USD 켜면 체인 바꿔도 유지).
  const [showUsd, setShowUsd] = useState(false);

  const refreshAccounts = useCallback(() => {
    setAccounts(walletStore.listAccounts());
  }, []);

  // 사용자 커스텀 ERC-20 토큰을 storage 에서 registry 로 복원. 한 번만.
  useEffect(() => {
    void loadCustomTokensFromStorage();
  }, []);

  // 암호화 저장 실패(스토리지 가득참 등)는 조용히 넘기면 다음 실행에서 계정이
  // 사라진다. 사용자에게 즉시 노출한다.
  useEffect(() => {
    keystoreSession.setPersistErrorHandler((e) => {
      setError(localizeShellError(t, e, t('errors.unknown')));
    });
  }, [t]);

  // Binance 시세 fetch — popup mount 시 1회. 약 100KB JSON (전체 ticker), 단순.
  // 실패는 silent: prices=null → 잔액 카드에 "—" 표시.
  useEffect(() => {
    let cancelled = false;
    void fetch('https://api.binance.com/api/v3/ticker/price')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: unknown) => {
        if (cancelled || !Array.isArray(j)) return;
        const map: Record<string, number> = {};
        for (const item of j as Array<{ symbol: string; price: string }>) {
          const p = Number(item.price);
          if (Number.isFinite(p) && p > 0) map[item.symbol] = p;
        }
        setPrices(map);
      })
      .catch(() => {
        // 시세 fetch 실패는 잔액 표시 자체를 막지 않는다 — prices=null 로 두면 "—".
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 멀티체인 spec 로드 — popup mount 시 한 번. cosmos/ton/xrp/... 라이브러리가
  // 이 chunk 에 담기므로 dynamic import 로 초기 popup 렌더를 막지 않는다.
  //
  // 실패 케이스 — MV3 CSP 위반, crypto/Buffer externalize, 네트워크 미러 등 —
  // 는 콘솔과 UI 양쪽에 표면화한다. silent pending 상태로 두면 셀렉터가 영원히
  // disabled 가 되어 진단이 어렵다.
  useEffect(() => {
    let cancelled = false;
    setChainSpecsErr(null);
    void import('@byeorin/wallet-sdk/multichain')
      .then((m) => {
        if (cancelled) return;
        // eslint-disable-next-line no-console
        console.info('[byeorin] multichain loaded:', m.DEFAULT_CHAINS.length, 'chains');
        setChainSpecs([...m.DEFAULT_CHAINS]);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error('[byeorin] multichain import failed:', e);
        if (!cancelled) setChainSpecsErr(msg);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // 활성 체인 spec / 어댑터. multichain 로드 전 또는 미발견 시 null → TTL fallback.
  const activeSpec = useMemo(
    () => chainSpecs?.find((c) => c.key === activeChainKey) ?? null,
    [chainSpecs, activeChainKey],
  );
  const activeAdapter = useMemo<ChainAdapter | null>(
    () => activeSpec?.build() ?? null,
    [activeSpec],
  );
  // 로드 전이면 wallet-service 의 TTL EvmAdapter 로 폴백.
  const effectiveAdapter: ChainAdapter = activeAdapter ?? walletStore.getDefaultAdapter();
  const effectiveSymbol = activeSpec?.nativeSymbol ?? 'TTL';
  const effectiveDecimals = activeSpec?.nativeDecimals ?? 18;

  // 부팅. 앱은 항상 잠긴 상태로 시작한다 — 금고가 있어도 비밀번호 없이는
  // tryAutoRestore 가 false 를 돌려준다(autoRestoreAllowed 가 캐시 유무로
  // 결정되므로). 여기서는 로딩 플래그만 내린다.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await walletStore.tryAutoRestore();
      } catch {
        // 손상된 세션은 store 가 조용히 비운다.
      }
      if (cancelled) return;
      refreshAccounts();
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshAccounts]);

  // 백그라운드 자동 잠금. 잠금 진입 시 대기 중인 암호화 저장을 먼저 확정한다.
  useEffect(
    () =>
      installAutoLock({
        shouldLock: () => walletStore.isUnlocked(),
        onLock: () => {
          void walletStore.lock().then(() => {
            refreshAccounts();
            setMode('home');
          });
        },
        onSuspend: () => {
          void keystoreSession.flush();
        },
      }),
    [refreshAccounts],
  );

  // 안드로이드 뒤로가기 → 화면 스택. mode 를 ref 로 읽어 리스너를 매 렌더마다
  // 재등록하지 않는다 (등록/해제가 네이티브 브릿지 왕복이라 비싸다).
  const modeRef = useRef<Mode>(mode);
  modeRef.current = mode;
  useEffect(
    () =>
      installBackButton({
        isHome: () => modeRef.current === 'home',
        goHome: () => {
          // 'set-pass' 에서 빠져나가면 아직 봉인되지 않은 시드는 버려진다.
          if (modeRef.current === 'set-pass') pendingMnemonic.current = null;
          setMode('home');
        },
      }),
    [],
  );

  // ────────── 잠금 해제 / 계정 추가 ──────────

  // 두 의미의 mnemonic 처리:
  //   - unlocked → walletStore.addMnemonicAccount (새 계정 추가)
  //   - locked   → 아직 금고가 없다는 뜻이므로 비밀번호 설정 단계로 넘긴다.
  //                (금고가 있는데 잠긴 상태에서는 애초에 생성 화면에 못 들어온다.)
  // CreateFlow / RestorePane 양쪽 모두 이 함수를 onFinalize/onSubmit 으로 사용한다.
  async function handleMnemonicSecret(mnemonic: string): Promise<void> {
    setError(null);
    if (walletStore.isUnlocked()) {
      await walletStore.addMnemonicAccount(mnemonic);
      refreshAccounts();
      setMode('home');
      return;
    }
    // 첫 지갑 — 비밀번호가 정해져야 금고에 봉인할 수 있다. 시드는 그때까지만
    // 메모리에 붙들고 있는다.
    pendingMnemonic.current = mnemonic;
    setMode('set-pass');
  }

  /** 첫 지갑의 금고 비밀번호 확정 → 암호화 저장까지 완료. */
  async function handleSetPassphrase(passphrase: string): Promise<void> {
    setError(null);
    const mnemonic = pendingMnemonic.current;
    if (mnemonic === null) {
      throw new ShellError('wallet.locked', 'no pending secret to seal');
    }
    keystoreSession.initialize(passphrase);
    await walletStore.unlock(mnemonic);
    // 디바운스를 기다리지 않고 즉시 확정한다 — 여기서 실패하면 사용자가 바로
    // 알아야 한다 (시드를 방금 적어둔 시점이라 복구 가능).
    await keystoreSession.flush();
    pendingMnemonic.current = null;
    setHasVault(true);
    refreshAccounts();
    setMode('home');
  }

  /**
   * 저장된 금고 열기. 비밀번호가 틀리면 throw 하고 **금고는 그대로 남는다**
   * (keystore-session.ts 의 오입력 보호 참고).
   */
  async function handleUnlock(passphrase: string): Promise<void> {
    setError(null);
    await keystoreSession.unlock(passphrase);
    const restored = await walletStore.tryAutoRestore();
    if (!restored) {
      // 복호화는 됐는데 blob 이 계정으로 복원되지 않는 경우 — 포맷 손상.
      // 메모리만 잠그고(금고 보존) 사용자에게 알린다.
      await keystoreSession.clear();
      throw new ShellError('keystore.corrupt_blob', 'vault could not be restored');
    }
    refreshAccounts();
    setMode('home');
  }

  async function handleImportPrivateKey(hex: string, label: string | null): Promise<void> {
    setError(null);
    if (!walletStore.isUnlocked()) {
      // PK import 진입 자체가 잠금 해제 상태에서만 가능하지만 방어적으로 한 번 더 검사.
      throw new ShellError('wallet.locked', 'wallet locked');
    }
    await walletStore.importPrivateKey(hex, label);
    refreshAccounts();
    setMode('home');
  }

  async function handleSelectAccount(idx: number): Promise<void> {
    setError(null);
    try {
      await walletStore.selectAccount(idx);
      refreshAccounts();
    } catch (e) {
      setError(localizeShellError(t, e, t('errors.unknown')));
    }
  }

  async function handleRemoveAccount(idx: number): Promise<void> {
    setError(null);
    try {
      await walletStore.removeAccount(idx);
      refreshAccounts();
    } catch (e) {
      setError(localizeShellError(t, e, t('errors.unknown')));
    }
  }

  /**
   * 잠금 — 메모리의 계정만 내린다. 디스크의 암호화 금고는 남으므로 다음에
   * 비밀번호만 넣으면 그대로 돌아온다. (확장에서는 같은 버튼이 세션 폐기였다.)
   */
  async function handleLogout(): Promise<void> {
    await walletStore.lock();
    refreshAccounts();
    setMode('home');
  }

  /** 지갑 초기화 — 금고 자체를 지운다. 시드가 없으면 영구 손실. */
  async function handleWipeVault(): Promise<void> {
    setError(null);
    if (walletStore.isUnlocked()) await walletStore.lock();
    await keystoreSession.wipe();
    pendingMnemonic.current = null;
    setHasVault(false);
    refreshAccounts();
    setMode('home');
  }

  if (loading) {
    return (
      <main className="popup">
        <BrandHeader t={t} />
        <p className="muted">{t('common.loading_ellipsis')}</p>
      </main>
    );
  }

  const unlocked = accounts.length > 0;

  return (
    <main className="popup">
      <BrandHeader t={t} />

      {/* 잠금 상태 · 금고 있음 — 비밀번호 입력 */}
      {!unlocked && mode === 'home' && hasVault && (
        <UnlockPane onUnlock={handleUnlock} onWipe={handleWipeVault} />
      )}

      {/* 잠금 상태 · 금고 없음 — 처음 만들기 / 복구 */}
      {!unlocked && mode === 'home' && !hasVault && (
        <section className="card">
          <p className="lead">{t('popup.has_no_wallet')}</p>
          <button className="btn-primary" onClick={() => setMode('create')}>
            {t('popup.create_new')}
          </button>
          <button className="btn-ghost" onClick={() => setMode('restore')}>
            {t('popup.recover_by_mnemonic')}
          </button>
        </section>
      )}

      {/* 첫 지갑의 금고 비밀번호 설정 */}
      {!unlocked && mode === 'set-pass' && (
        <SetPassphrasePane
          onSubmit={handleSetPassphrase}
          onCancel={() => {
            pendingMnemonic.current = null;
            setMode('home');
          }}
        />
      )}

      {/* 잠금 해제 상태 — 계정 목록 + 활성 카드 */}
      {unlocked && mode === 'home' && (
        <>
          <AccountListCard
            accounts={accounts}
            onSelect={handleSelectAccount}
            onRemove={handleRemoveAccount}
            onAddClick={() => setMode('add-menu')}
            onShowKey={() => setMode('export')}
            onSend={() => setMode('send')}
            onSwap={() => setMode('swap')}
            onLock={handleLogout}
            chainSpecs={chainSpecs}
            chainSpecsErr={chainSpecsErr}
            activeChainKey={activeChainKey}
            onChainSelect={setActiveChainKey}
            adapter={effectiveAdapter}
            nativeSymbol={effectiveSymbol}
            nativeDecimals={effectiveDecimals}
            prices={prices}
            showUsd={showUsd}
            onToggleUsd={() => setShowUsd((v) => !v)}
          />
        </>
      )}

      {/* 송금 화면 — 활성 계정 + 활성 체인 기준 네이티브 송금. ERC-20 토큰은 Stage E2. */}
      {unlocked && mode === 'send' && (
        <SendPane
          onBack={() => setMode('home')}
          adapter={effectiveAdapter}
          nativeSymbol={effectiveSymbol}
          nativeDecimals={effectiveDecimals}
          chainKey={activeChainKey}
        />
      )}

      {/* 스왑 화면 — ZION AMM. 활성 체인이 'cosmos:zion' 일 때만 진입 가능. */}
      {unlocked && mode === 'swap' && (
        <SwapPane
          onBack={() => setMode('home')}
          adapter={effectiveAdapter}
          nativeSymbol={effectiveSymbol}
          nativeDecimals={effectiveDecimals}
          chainKey={activeChainKey}
        />
      )}

      {/* 계정 추가 메뉴 */}
      {mode === 'add-menu' && (
        <AddAccountMenu
          onPickCreate={() => setMode('create')}
          onPickRestore={() => setMode('restore')}
          onPickImportPk={() => setMode('import-pk')}
          onBack={() => setMode('home')}
        />
      )}

      {/* 시드 생성 (잠금 전/후 공용) */}
      {mode === 'create' && (
        <CreateFlow
          onFinalize={handleMnemonicSecret}
          onCancel={() => setMode(unlocked ? 'add-menu' : 'home')}
        />
      )}

      {/* 시드 복구 (잠금 전/후 공용) */}
      {mode === 'restore' && (
        <RestorePane
          onSubmit={handleMnemonicSecret}
          onCancel={() => setMode(unlocked ? 'add-menu' : 'home')}
        />
      )}

      {/* private key import — 잠금 해제 상태에서만 진입 가능 */}
      {mode === 'import-pk' && (
        <ImportPrivateKeyPane
          onImport={handleImportPrivateKey}
          onCancel={() => setMode('add-menu')}
        />
      )}

      {/* 활성 계정 비밀 키 노출 */}
      {mode === 'export' && unlocked && (
        <ExportSecretPane
          account={accounts.find((a) => a.active) ?? null}
          onClose={() => setMode('home')}
        />
      )}

      {error ? <p className="error">{error}</p> : null}
      <footer>{t('footer.skeleton')}</footer>
    </main>
  );
}

// ────────── BrandHeader ──────────
//
// Playwright smoke 가 `header.brand >> text=벼린` 으로 셀렉트하므로 구조는 유지.
function BrandHeader({ t }: { t: (k: string) => string }) {
  const brandName = t('brand.name');
  // toolbar 아이콘과 동일한 PNG 마스터 사용 — design-system 의 Logo SVG 는
  // 옛 디자인이라 toolbar 와 시각 일관성이 깨졌다. 48px PNG 를 28px 로 표시.
  return (
    <header className="brand">
      <div className="brand__left">
        <img
          src="/icon/48.png"
          width={28}
          height={28}
          alt="벼린"
          title="Brand mark"
        />
        <span className="brand__wordmark">{brandName}</span>
      </div>
      <div className="brand__right">
        <LocaleSwitch showLabel={false} />
      </div>
    </header>
  );
}

// ────────── 계정 목록 카드 ──────────
//
// 활성 계정은 큰 카드 — 잔액(TTL), 주소+복사, QR 토글, 송금/키보기/잠금.
// 비활성 계정은 컴팩트 row 로 아래 카드에 모인다. row 의 "활성으로" 버튼이 전환.
// 마지막 1 개 계정 제거는 store 가 throw 한다.
function AccountListCard({
  accounts,
  onSelect,
  onRemove,
  onAddClick,
  onShowKey,
  onSend,
  onSwap,
  onLock,
  chainSpecs,
  chainSpecsErr,
  activeChainKey,
  onChainSelect,
  adapter,
  nativeSymbol,
  nativeDecimals,
  prices,
  showUsd,
  onToggleUsd,
}: {
  accounts: AccountInfo[];
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
  onAddClick: () => void;
  onShowKey: () => void;
  onSend: () => void;
  onSwap: () => void;
  onLock: () => void;
  chainSpecs: ChainSpec[] | null;
  chainSpecsErr: string | null;
  activeChainKey: string;
  onChainSelect: (key: string) => void;
  adapter: ChainAdapter;
  nativeSymbol: string;
  nativeDecimals: number;
  prices: Record<string, number> | null;
  showUsd: boolean;
  onToggleUsd: () => void;
}) {
  const t = useT();
  const active = accounts.find((a) => a.active) ?? null;
  const others = accounts.filter((a) => !a.active);

  const labelOf = (a: AccountInfo): string =>
    a.label ?? t('accounts.no_label', { idx: a.idx + 1 });

  return (
    <>
      {/* 활성 계정 — 체인 셀렉터 + 잔액 + 주소(복사) + QR + 액션 */}
      {active && (
        <ActiveAccountCard
          account={active}
          label={labelOf(active)}
          onShowKey={onShowKey}
          onSend={onSend}
          onSwap={onSwap}
          onLock={onLock}
          adapter={adapter}
          nativeSymbol={nativeSymbol}
          nativeDecimals={nativeDecimals}
          chainSpecs={chainSpecs}
          chainSpecsErr={chainSpecsErr}
          activeChainKey={activeChainKey}
          onChainSelect={onChainSelect}
          prices={prices}
          showUsd={showUsd}
          onToggleUsd={onToggleUsd}
        />
      )}

      {/* 비활성 계정 목록 + 추가 버튼 */}
      <section className="card">
        <h3 className="section-title">{t('accounts.title')}</h3>
        {others.length === 0 ? (
          <p className="empty-state">—</p>
        ) : (
          <ul className="origin-list">
            {others.map((a) => (
              <li key={a.idx} className="origin-row account-row">
                <div className="grant-info">
                  <span className="origin-text" title={a.address}>
                    {shortenAddress(a.address)}
                  </span>
                  <span className="muted small">
                    {t(`accounts.kind.${a.kind === 'mnemonic' ? 'mnemonic' : 'private_key'}`)}
                    {' · '}
                    {labelOf(a)}
                  </span>
                </div>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => onSelect(a.idx)}
                  title={t('accounts.select_button')}
                >
                  {t('accounts.select_button')}
                </button>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    if (window.confirm(t('accounts.confirm_remove'))) onRemove(a.idx);
                  }}
                  title={t('accounts.remove_button')}
                >
                  {t('accounts.remove_button')}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="btn-ghost" onClick={onAddClick}>
          {t('accounts.add_button')}
        </button>
      </section>
    </>
  );
}

// ────────── 활성 계정 카드 (멀티체인) ──────────
//
// 체인 셀렉터 + 활성 체인 잔액 + 그 체인의 주소(복사) + QR + 송금/키보기/잠금.
//
// 활성 계정 × 활성 체인 → 주소: walletStore.getAccountAt(idx, adapter) 로 도출.
// AccountInfo.address 는 defaultAdapter(TTL) 기준이므로 다른 체인에서는 못 쓴다.
//
// raw key 계정 + ed25519 체인(Solana/TON/Aptos/Sui) 조합은 SDK 가 지원하지
// 않는다 (raw key import 는 secp256k1 전용) — 그 경우 "미지원" 을 표시한다.
function ActiveAccountCard({
  account,
  label,
  onShowKey,
  onSend,
  onSwap,
  onLock,
  adapter,
  nativeSymbol,
  nativeDecimals,
  chainSpecs,
  chainSpecsErr,
  activeChainKey,
  onChainSelect,
  prices,
  showUsd,
  onToggleUsd,
}: {
  account: AccountInfo;
  label: string;
  onShowKey: () => void;
  onSend: () => void;
  onSwap: () => void;
  onLock: () => void;
  adapter: ChainAdapter;
  nativeSymbol: string;
  nativeDecimals: number;
  chainSpecs: ChainSpec[] | null;
  chainSpecsErr: string | null;
  activeChainKey: string;
  onChainSelect: (key: string) => void;
  prices: Record<string, number> | null;
  showUsd: boolean;
  onToggleUsd: () => void;
}) {
  const t = useT();
  const [chainAddress, setChainAddress] = useState<string | null>(null);
  const [addrUnsupported, setAddrUnsupported] = useState(false);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [balanceErr, setBalanceErr] = useState<string | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [showQr, setShowQr] = useState(false);
  const [copied, setCopied] = useState(false);
  // ZION 활성 시 4종 자산(utrg/ubtc/uusdt/ueth) 잔액 맵. denom → base-unit bigint.
  // 다른 체인일 때는 null 로 두고 활성 카드의 ZION 자산 list 자체를 안 그린다.
  const [zionBalances, setZionBalances] = useState<Record<string, bigint> | null>(null);
  // EVM 체인의 자동 발견 토큰. 다른 체인일 때 null. includeZero 토글에 따라
  // 양수 잔액만 / 빌트인 4종 전부 보여줌.
  const [evmTokens, setEvmTokens] = useState<DiscoveredBalance[] | null>(null);
  const [showZeroTokens, setShowZeroTokens] = useState(false);
  // "토큰 추가" 모달: idle | 'open' (입력 폼) | 'adding' (RPC fetch 중)
  const [addTokenMode, setAddTokenMode] = useState<'idle' | 'open' | 'adding'>('idle');
  const [addTokenAddr, setAddTokenAddr] = useState('');
  const [addTokenErr, setAddTokenErr] = useState<string | null>(null);
  // 토큰 추가 후 즉시 evmTokens 를 refresh — 트리거용 카운터.
  const [tokenListRev, setTokenListRev] = useState(0);

  // native asset → BTC 비율. 미상장(TTL/kWR) 은 PRICE_PEG_TO_BTC 페그, 그 외는
  // Binance ticker 의 {SYM}BTC pair. BTC 자체는 1:1.
  const btcPerNative = nativeToBtcRatio(nativeSymbol, prices);
  // BTC USD — Binance 의 BTCUSDT.
  const btcUsd = prices?.['BTCUSDT'] ?? null;

  // 활성 계정 × 활성 체인 → 주소. getAccountAt 은 sync.
  useEffect(() => {
    setChainAddress(null);
    setAddrUnsupported(false);
    try {
      const acc = walletStore.getAccountAt(account.idx, adapter);
      setChainAddress(acc.address);
    } catch {
      // raw key 계정 + ed25519 체인 등 — 해당 계정으로 이 체인은 못 쓴다.
      setAddrUnsupported(true);
    }
  }, [account.idx, adapter]);

  // 잔액 — chainAddress 기준. cleanup 으로 race 차단.
  useEffect(() => {
    if (!chainAddress) return;
    let cancelled = false;
    setBalanceLoading(true);
    setBalanceErr(null);
    setBalance(null);
    void (async () => {
      try {
        const bal = await adapter.getBalance(chainAddress);
        if (!cancelled) setBalance(bal);
      } catch (e) {
        if (!cancelled) {
          setBalanceErr(
            e instanceof Error
              ? t('account.balance_failed_with_reason', { reason: e.message })
              : t('account.balance_failed'),
          );
        }
      } finally {
        if (!cancelled) setBalanceLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainAddress, adapter, t]);

  // ZION 활성 시 4종 자산 잔액을 한 번에 fetch. adapter.getAllBalances 가 있는
  // (= CosmosAdapter) 체인에서만 호출. ZION 외 Cosmos 체인은 4종 매핑이 의미
  // 없지만 코드 일관성 측면에서 동일 호출 흐름을 유지 — 단순히 표시는 ZION 일
  // 때만 한다 (UI 분기).
  useEffect(() => {
    if (!chainAddress || activeChainKey !== 'cosmos:zion') {
      setZionBalances(null);
      return;
    }
    const a = adapter as unknown as {
      getAllBalances?: (addr: string) => Promise<Array<{ denom: string; amount: bigint }>>;
    };
    if (typeof a.getAllBalances !== 'function') {
      setZionBalances(null);
      return;
    }
    let cancelled = false;
    void a
      .getAllBalances(chainAddress)
      .then((coins) => {
        if (cancelled) return;
        const map: Record<string, bigint> = {};
        for (const c of coins) map[c.denom] = c.amount;
        setZionBalances(map);
      })
      .catch(() => {
        if (!cancelled) setZionBalances({});
      });
    return () => {
      cancelled = true;
    };
  }, [chainAddress, adapter, activeChainKey]);

  // EVM 체인 활성 시 ERC-20 토큰 자동 탐색 (TokenRegistry 빌트인 + 사용자 커스텀).
  // 양수 잔액 토큰만 노출 — 0 인 USDC 같은 건 list 에 안 보임. RPC 호출은
  // 빌트인 토큰 수만큼(체인당 3~4개) 발생, maxRpcCalls 안전망 50.
  useEffect(() => {
    if (!chainAddress || !activeChainKey.startsWith('evm:')) {
      setEvmTokens(null);
      return;
    }
    // adapter 가 EvmAdapter 가 아니면 (이론상 불가, 방어) 노출 안 함.
    const a = adapter as unknown as { chain?: { id?: number } };
    if (!a.chain || typeof a.chain.id !== 'number') {
      setEvmTokens(null);
      return;
    }
    let cancelled = false;
    setEvmTokens(null);
    void discoverEvmTokens(adapter as unknown as EvmAdapter, chainAddress, {
      includeZero: showZeroTokens,
    })
      .then((tokens) => {
        if (!cancelled) setEvmTokens(tokens);
      })
      .catch(() => {
        if (!cancelled) setEvmTokens([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chainAddress, adapter, activeChainKey, showZeroTokens, tokenListRev]);

  async function handleAddCustomToken(): Promise<void> {
    if (!addTokenAddr.trim() || !chainAddress) return;
    const a = adapter as unknown as { chain?: { id?: number } };
    if (!a.chain || typeof a.chain.id !== 'number') {
      setAddTokenErr('EVM 체인에서만 토큰 추가 가능합니다.');
      return;
    }
    const addr = addTokenAddr.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) {
      setAddTokenErr('컨트랙트 주소가 올바르지 않습니다 (0x + 40자리 hex).');
      return;
    }
    setAddTokenErr(null);
    setAddTokenMode('adding');
    try {
      await addCustomErc20(adapter as unknown as EvmAdapter, a.chain.id, addr);
      setAddTokenAddr('');
      setAddTokenMode('idle');
      setTokenListRev((v) => v + 1); // discoverTokens 재실행
    } catch (e) {
      setAddTokenErr(
        e instanceof Error ? e.message : '토큰 metadata 조회 실패 — 컨트랙트 주소 확인',
      );
      setAddTokenMode('open');
    }
  }

  // QR — chainAddress 기준.
  useEffect(() => {
    if (!chainAddress) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void QRCode.toDataURL(chainAddress, {
      margin: 1,
      width: 200,
      color: { dark: '#0a0a0a', light: '#fafaf7' },
    }).then((url) => {
      if (!cancelled) setQrDataUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [chainAddress]);

  async function copyAddress(): Promise<void> {
    if (!chainAddress) return;
    try {
      await navigator.clipboard.writeText(chainAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 권한 거부 — 사용자는 주소 표시 영역에서 직접 선택해 복사 가능.
    }
  }

  return (
    <section className="card">
      {/* 체인 셀렉터 — 16 체인. multichain 로드 전엔 TTL 단일. */}
      <label className="label" htmlFor="chain-select">
        {t('chain.label')}
        {!chainSpecs && !chainSpecsErr && (
          <span className="muted small"> · {t('common.loading_ellipsis')}</span>
        )}
      </label>
      <select
        id="chain-select"
        className="chain-select"
        value={activeChainKey}
        onChange={(e) => onChainSelect(e.target.value)}
        disabled={!chainSpecs}
      >
        {chainSpecs ? (
          chainSpecs.map((c) => (
            <option key={c.key} value={c.key}>
              {c.displayName}
            </option>
          ))
        ) : (
          <option value="evm:ttl">TTL</option>
        )}
      </select>
      {chainSpecsErr && (
        <p className="error small" role="alert">
          multichain load failed: {chainSpecsErr}
        </p>
      )}

      <p className="account-kind-badge">
        {t(`accounts.kind.${account.kind === 'mnemonic' ? 'mnemonic' : 'private_key'}`)}
        {' · '}
        {label}
      </p>

      {addrUnsupported ? (
        <p className="warn small" role="alert">
          {t('chain.unsupported_for_account')}
        </p>
      ) : (
        <>
          {/* 잔액 히어로 — 위: native 잔액(메인), 아래: BTC/USD 환산(보조, 토글) */}
          <div className="balance-hero">
            {balanceLoading ? (
              <span className="muted small">{t('account.balance_loading')}</span>
            ) : balanceErr ? (
              <span className="error small" role="alert">{balanceErr}</span>
            ) : balance === null ? (
              <p className="balance-hero__value muted">—</p>
            ) : (
              <>
                <p className="balance-hero__value">
                  {formatAmount(balance, nativeDecimals)}
                  <span className="balance-hero__symbol">{nativeSymbol}</span>
                </p>
                {btcPerNative !== null && (
                  <button
                    type="button"
                    className="balance-hero__toggle"
                    onClick={onToggleUsd}
                    title={showUsd ? 'BTC' : 'USD'}
                  >
                    ≈ {showUsd && btcUsd !== null
                      ? `$${formatUsdValue(nativeToBtc(balance, nativeDecimals, btcPerNative) * btcUsd)}`
                      : `${formatBtcValue(nativeToBtc(balance, nativeDecimals, btcPerNative))} BTC`}
                  </button>
                )}
              </>
            )}
          </div>

          {/* ZION 4종 자산 — kWR(native 히어로 위) 외에도 BTC/USDT/ETH 표시.
              잔액 0 인 자산도 노출해 사용자가 어떤 자산을 받을 수 있는지 가시화.
              kWR 줄이 위 히어로와 중복되지만, "4종을 함께" 본다는 ZION 자산
              매트릭스의 메시지를 보존한다. */}
          {activeChainKey === 'cosmos:zion' && zionBalances !== null && (
            <ul className="zion-assets">
              {ZION_ASSETS.map((a) => {
                const amount = zionBalances[a.denom] ?? 0n;
                const usd = tokenToUsd(a.symbol, prices);
                const usdValue =
                  usd !== null && amount > 0n
                    ? baseUnitToNumber(amount, a.decimals) * usd
                    : null;
                return (
                  <li key={a.denom} className="zion-assets__row">
                    <span className="zion-assets__symbol">{a.symbol}</span>
                    <span className="zion-assets__amount">
                      {formatAmount(amount, a.decimals)}
                      {usdValue !== null && (
                        <span className="zion-assets__usd">
                          ≈ ${formatUsdValue(usdValue)}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* EVM 체인 활성 시 ERC-20 자동 발견 토큰. 기본은 잔액 > 0 만 보여
              첫 인상이 깔끔. "전체 보기" 토글 시 빌트인 4종 모두 노출 — 사용자가
              어떤 토큰을 watch 가능한지 확인할 수 있다. ZION list 와 같은 스타일. */}
          {activeChainKey.startsWith('evm:') && evmTokens !== null && (
            <>
              {evmTokens.length > 0 && (
                <ul className="zion-assets">
                  {evmTokens.map((t) => {
                    const usd = tokenToUsd(t.token.symbol, prices);
                    const usdValue =
                      usd !== null && t.balance > 0n
                        ? baseUnitToNumber(t.balance, t.token.decimals) * usd
                        : null;
                    return (
                      <li key={t.token.address} className="zion-assets__row">
                        <span className="zion-assets__symbol" title={t.token.name}>
                          {t.token.symbol}
                        </span>
                        <span className="zion-assets__amount">
                          {formatAmount(t.balance, t.token.decimals)}
                          {usdValue !== null && (
                            <span className="zion-assets__usd">
                              ≈ ${formatUsdValue(usdValue)}
                            </span>
                          )}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="zion-assets__actions">
                <button
                  type="button"
                  className="zion-assets__toggle"
                  onClick={() => setShowZeroTokens((v) => !v)}
                >
                  {showZeroTokens ? '잔액 0 숨기기' : '전체 보기'}
                </button>
                <button
                  type="button"
                  className="zion-assets__toggle"
                  onClick={() => {
                    setAddTokenMode('open');
                    setAddTokenErr(null);
                  }}
                >
                  + 토큰 추가
                </button>
              </div>
              {addTokenMode !== 'idle' && (
                <div className="add-token-form">
                  <label className="label" htmlFor="add-token-addr">
                    컨트랙트 주소 (0x...)
                  </label>
                  <input
                    id="add-token-addr"
                    type="text"
                    className="verify-row__input"
                    value={addTokenAddr}
                    onChange={(e) => setAddTokenAddr(e.target.value)}
                    placeholder="0x..."
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={addTokenMode === 'adding'}
                  />
                  {addTokenErr && <p className="error small">{addTokenErr}</p>}
                  <div className="add-token-form__actions">
                    <button
                      type="button"
                      className="btn-primary btn-sm"
                      onClick={() => {
                        void handleAddCustomToken();
                      }}
                      disabled={addTokenMode === 'adding' || !addTokenAddr.trim()}
                    >
                      {addTokenMode === 'adding' ? '조회 중…' : '추가'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-sm"
                      onClick={() => {
                        setAddTokenMode('idle');
                        setAddTokenAddr('');
                        setAddTokenErr(null);
                      }}
                      disabled={addTokenMode === 'adding'}
                    >
                      취소
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* 주소 + 복사 / QR 토글 */}
          <div className="address-row">
            <span className="addr address-row__text" title={chainAddress ?? ''}>
              {chainAddress ? shortenAddress(chainAddress) : '…'}
            </span>
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                void copyAddress();
              }}
              disabled={!chainAddress}
              title={t('account.copy_address')}
            >
              {copied ? t('common.copied') : t('account.copy_address')}
            </button>
            <button
              className="btn-ghost btn-sm"
              onClick={() => setShowQr((v) => !v)}
              aria-expanded={showQr}
              aria-controls="popup-qr-panel"
            >
              {showQr ? t('account.hide_qr') : t('account.show_qr')}
            </button>
          </div>

          {showQr && qrDataUrl && (
            <div id="popup-qr-panel" className="qr-inline">
              <img src={qrDataUrl} alt={t('account.qr_help')} />
              <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>
                {t('account.qr_help')}
              </p>
            </div>
          )}
        </>
      )}

      {/* 주요 액션 */}
      <div className="account-actions">
        <button
          className="btn-primary btn-sm"
          onClick={onSend}
          disabled={addrUnsupported}
        >
          {t('account.send')}
        </button>
        {activeChainKey === 'cosmos:zion' && (
          <button
            className="btn-ghost btn-sm"
            onClick={onSwap}
            disabled={addrUnsupported}
            title="ZION AMM"
          >
            {t('account.swap')}
          </button>
        )}
        <button className="btn-ghost btn-sm" onClick={onShowKey}>
          {t('accounts.show_key_button')}
        </button>
        <button className="btn-ghost btn-sm" onClick={onLock}>
          {t('common.lock')}
        </button>
      </div>

      <p className="warn small">{t('vault.session_note')}</p>
    </section>
  );
}

// ────────── 송금 화면 ──────────
//
// Web Send.tsx 의 핵심을 popup 폭에 맞춰 포팅. 1차는 native TTL 만 지원하고
// ERC-20 송금은 Stage A2 (토큰 목록 도입과 함께) 에서 활성화한다.
//
// 단계: 'compose' (주소/금액 입력) → 'review' (요약 + 확정) → 'sent' / 'error'.
function SendPane({
  onBack,
  adapter,
  nativeSymbol,
  nativeDecimals,
  chainKey,
}: {
  onBack: () => void;
  adapter: ChainAdapter;
  nativeSymbol: string;
  nativeDecimals: number;
  chainKey: string;
}) {
  const t = useT();
  type Step = 'compose' | 'review';
  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'sent'; hash: string }
    | { kind: 'error'; message: string };

  const [step, setStep] = useState<Step>('compose');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // TTL(evm:ttl) 만 익스플로러 링크를 노출한다 — scan.ttl1.top 은 TTL 전용.
  const isTtl = chainKey === 'evm:ttl';
  const isEvm = chainKey.startsWith('evm:');
  const trimmedTo = to.trim();
  const trimmedAmount = amount.trim();
  // EVM 은 0x+40hex 엄격 검증. 비-EVM(cosmos bech32, solana base58 등)은 형식이
  // 체인마다 달라 popup 에서 일괄 검증하지 않고 non-empty 만 본다 — 잘못된 주소는
  // 어댑터의 broadcast 단계에서 실패한다.
  const validAddress = isEvm
    ? /^0x[0-9a-fA-F]{40}$/.test(trimmedTo)
    : trimmedTo.length > 0;
  const validAmount = AMOUNT_RE.test(trimmedAmount) && Number(trimmedAmount) > 0;
  const showAmountError = trimmedAmount.length > 0 && !validAmount;
  const locked = status.kind === 'pending' || status.kind === 'sent';
  const canProceed = validAddress && validAmount && !locked;

  async function performSend(): Promise<void> {
    let value: bigint;
    try {
      // 활성 체인의 decimals 로 파싱 — EVM 18, Cosmos 6, BTC 8 등.
      value = parseUnits(trimmedAmount, nativeDecimals);
    } catch {
      setStatus({ kind: 'error', message: t('send.amount_invalid') });
      return;
    }
    const intent: TransferIntent = { to: trimmedTo, amount: value };
    setStatus({ kind: 'pending' });
    try {
      // 활성 체인 어댑터로 송금 — defaultAdapter(TTL) 아님.
      const hash = await walletStore.transfer(intent, adapter);
      setStatus({ kind: 'sent', hash });
    } catch (err) {
      let msg: string;
      if (err instanceof ShellError) msg = t(`errors.${err.code}`);
      else if (err instanceof Error) msg = err.message || t('send.failed');
      else msg = t('send.failed');
      setStatus({ kind: 'error', message: msg });
    }
  }

  if (step === 'review') {
    const shortTo =
      trimmedTo.length > 14 ? `${trimmedTo.slice(0, 6)}…${trimmedTo.slice(-4)}` : trimmedTo;

    return (
      <section className="card">
        <h2 className="create-step__title">{t('send.review_title')}</h2>
        <p className="create-step__lead">
          {t('send.review_summary', {
            amount: trimmedAmount,
            symbol: nativeSymbol,
            address: shortTo,
          })}
        </p>
        <div className="send-review__row">
          <span className="muted small">{t('send.review_gas_label')}</span>
          <span className="small">{t('send.review_gas_unknown')}</span>
        </div>
        <p className="warn small" style={{ margin: 0 }}>
          {t('send.review_irreversible')}
        </p>

        {status.kind === 'pending' && (
          <p className="muted small">{t('send.pending')}</p>
        )}
        {status.kind === 'sent' && (
          <div className="send-sent">
            <p className="label">{t('send.sent_title')}</p>
            <p className="addr send-hash" title={status.hash}>
              {shortenAddress(status.hash)}
            </p>
            {isTtl && (
              <a
                href={`https://scan.ttl1.top/tx/${status.hash}`}
                target="_blank"
                rel="noreferrer"
                className="small"
              >
                {t('send.view_in_explorer')}
              </a>
            )}
          </div>
        )}
        {status.kind === 'error' && <p className="error">{status.message}</p>}

        {status.kind === 'sent' ? (
          <button className="btn-primary" onClick={onBack}>
            {t('send.back_to_wallet')}
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={!canProceed}
            onClick={() => {
              void performSend();
            }}
          >
            {status.kind === 'pending' ? t('send.sending') : t('send.review_confirm')}
          </button>
        )}
        <button
          className="btn-ghost"
          onClick={() => setStep('compose')}
          disabled={status.kind === 'pending' || status.kind === 'sent'}
        >
          {t('send.review_edit')}
        </button>
      </section>
    );
  }

  // step === 'compose'
  return (
    <section className="card">
      <h2 className="create-step__title">{t('send.title')}</h2>
      <p className="create-step__lead">{t('send.lead_native', { symbol: nativeSymbol })}</p>

      <label className="label" htmlFor="send-to">
        {t('send.to_label')}
      </label>
      <textarea
        id="send-to"
        rows={2}
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder={isEvm ? '0x...' : ''}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
        disabled={locked}
      />
      {trimmedTo.length > 0 && !validAddress && (
        <p className="error small">{t('send.to_invalid')}</p>
      )}

      <label className="label" htmlFor="send-amount">
        {t('send.amount_label', { symbol: nativeSymbol })}
      </label>
      <input
        id="send-amount"
        type="text"
        inputMode="decimal"
        className="verify-row__input"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.0"
        disabled={locked}
      />
      {showAmountError && <p className="error small">{t('send.amount_invalid')}</p>}

      <button
        className="btn-primary"
        disabled={!canProceed}
        onClick={() => setStep('review')}
      >
        {t('send.next_step')}
      </button>
      <button className="btn-ghost" onClick={onBack}>
        {t('common.back')}
      </button>
    </section>
  );
}

// ────────── 스왑 화면 (ZION AMM) ──────────
//
// 활성 체인이 'cosmos:zion' 일 때만 진입한다. mount 시:
//   1. multichain 번들 dynamic import → ZionAmmClient 로드 (대부분 캐시 hit —
//      App.tsx 가 chainSpecs 로드 시 이미 가져왔음)
//   2. listPools() 한 번 — 자산 쌍 변경마다 fetch 하지 않고 메모리에서 매칭
//
// SignAndBroadcast 흐름은 transferAccount 와 동일하지만 buildTransfer 대신
// CosmosAdapter.buildTx([swapMsg], ctx) 를 직접 호출한다.
//
// 1차 슬라이스 한계: kWR/BTC/USDT/ETH 4종 자산만 노출, 멀티홉 X, LP X.

// ZION Phase 1 의 4종 자산 — ActiveAccountCard 와 SwapPane 양쪽이 공유.
// ZionWallet.MD §3 표 그대로. ueth 가 표준 ETH 18 이 아닌 6 decimals 인 점 주의
// (ZION Phase 1 의 AMM 시드용 테스트 코인 — Phase 2 에서 18 로 마이그레이션 가능).
// 본 file-top 으로 옮긴 이유: 활성 카드의 자산 list 가 같은 매핑을 써야 잔액
// 표시 ↔ 스왑 selector 가 정확히 동일한 자산 어휘(Ubiquitous Language)를 갖는다.
// (이전엔 SwapPane 함수 안에 갇혀 있었음.)

function SwapPane({
  onBack,
  adapter,
  chainKey,
}: {
  onBack: () => void;
  adapter: ChainAdapter;
  // SendPane 과 시그니처를 맞추기 위해 받지만 본 화면은 native 잔액에 의존하지
  // 않는다 (자산 쌍을 자체 셀렉터로 고름). 사용 안 함을 명시.
  nativeSymbol: string;
  nativeDecimals: number;
  chainKey: string;
}) {
  const t = useT();
  type Status =
    | { kind: 'idle' }
    | { kind: 'pending' }
    | { kind: 'sent'; hash: string }
    | { kind: 'error'; message: string };

  const [fromAsset, setFromAsset] = useState<ZionAsset>(ZION_ASSETS[0]!);
  const [toAsset, setToAsset] = useState<ZionAsset>(ZION_ASSETS[1]!);
  const [amount, setAmount] = useState('');
  const [client, setClient] = useState<ZionAmmClientType | null>(null);
  const [pools, setPools] = useState<ZionPool[] | null>(null);
  const [poolErr, setPoolErr] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  // 활성 체인이 ZION 이 아니면 진입 자체가 차단되어야 하지만 방어적으로 안내만.
  const isZion = chainKey === 'cosmos:zion';

  // multichain 번들 dynamic import → ZionAmmClient 로 인스턴스화 + 풀 1회 fetch.
  useEffect(() => {
    if (!isZion) return;
    let cancelled = false;
    void import('@byeorin/wallet-sdk/multichain')
      .then((m) => {
        if (cancelled) return;
        // ZION AMM 인덱서(api.zion1.top)는 CORS 헤더를 주지 않는다. 확장은
        // host_permissions 로 우회했지만 WebView 는 평범한 https://localhost
        // 오리진이라 브라우저 fetch 로는 응답을 못 읽는다. 이 한 곳만 네이티브
        // HTTP 로 태운다 (native-http.ts 주석 참고).
        const c = new m.ZionAmmClient({ fetch: nativeFetch });
        setClient(c);
        return c.listPools();
      })
      .then((ps) => {
        if (cancelled || !ps) return;
        setPools(ps);
        setPoolErr(null);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setPools([]);
        setPoolErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [isZion]);

  // 자산 쌍 → 메모리에서 가장 깊은 풀 선택.
  const pool: ZionPool | null = useMemo(() => {
    if (!pools || fromAsset.denom === toAsset.denom) return null;
    const matches = pools.filter(
      (p) =>
        (p.denomA === fromAsset.denom && p.denomB === toAsset.denom) ||
        (p.denomA === toAsset.denom && p.denomB === fromAsset.denom),
    );
    if (matches.length === 0) return null;
    return matches.reduce((best, p) =>
      p.reserveA + p.reserveB > best.reserveA + best.reserveB ? p : best,
    );
  }, [pools, fromAsset, toAsset]);

  // 수량 → bigint base-unit. AMOUNT_RE 는 send 화면과 같은 검증.
  const trimmedAmount = amount.trim();
  const amountInfo = useMemo(() => {
    if (!AMOUNT_RE.test(trimmedAmount)) return { value: null as bigint | null, valid: false };
    if (Number(trimmedAmount) <= 0) return { value: null as bigint | null, valid: false };
    try {
      return { value: parseUnits(trimmedAmount, fromAsset.decimals), valid: true };
    } catch {
      return { value: null as bigint | null, valid: false };
    }
  }, [trimmedAmount, fromAsset]);

  // 견적 — 풀과 수량이 둘 다 준비된 경우에만.
  const quote: ZionSwapQuote | null = useMemo(() => {
    if (!client || !pool || !amountInfo.valid || amountInfo.value === null) return null;
    try {
      return client.quote(pool, amountInfo.value, toAsset.denom);
    } catch {
      return null;
    }
  }, [client, pool, amountInfo, toAsset]);

  const sameDenom = fromAsset.denom === toAsset.denom;
  const noPool = pools !== null && pool === null && !sameDenom;
  const locked = status.kind === 'pending' || status.kind === 'sent';
  const canSubmit = !locked && !!quote && !!pool && !!client;

  async function performSwap(): Promise<void> {
    if (!client || !pool || !quote || !amountInfo.value) return;
    setStatus({ kind: 'pending' });
    try {
      // 활성 계정의 ZION 주소 + signer 얻기.
      const accounts = walletStore.listAccounts();
      const activeIdx = accounts.findIndex((a) => a.active);
      if (activeIdx < 0) {
        throw new ShellError('account.not_found', 'no active account');
      }
      const acc = walletStore.getAccountAt(activeIdx, adapter);

      const msg = client.buildSwapMessage({
        swapper: acc.address,
        pool,
        amountIn: amountInfo.value,
        denomOut: toAsset.denom,
        quote,
      });

      // adapter 는 ZION 활성 시 CosmosAdapter — 따라서 buildTx 가 존재한다.
      // 정적 타입은 ChainAdapter 라 좁히지 못하므로 method 존재만 확인.
      const ca = adapter as unknown as {
        buildTx?: typeof import('@byeorin/wallet-sdk/multichain').CosmosAdapter.prototype.buildTx;
        signRequests: ChainAdapter['signRequests'];
        applySignatures: ChainAdapter['applySignatures'];
        broadcast: ChainAdapter['broadcast'];
      };
      if (typeof ca.buildTx !== 'function') {
        throw new Error('swap: adapter does not support buildTx (expected CosmosAdapter)');
      }

      const unsigned = await ca.buildTx([msg], { sender: acc.address, signer: acc.signer });
      const requests = await ca.signRequests(unsigned);
      const signatures: Uint8Array[] = [];
      for (const r of requests) {
        signatures.push(await acc.signer.sign(r.message));
      }
      const signed = await ca.applySignatures(unsigned, signatures);
      const hash = await ca.broadcast(signed);
      setStatus({ kind: 'sent', hash });
    } catch (err) {
      let msg: string;
      if (err instanceof ShellError) msg = t(`errors.${err.code}`);
      else if (err instanceof Error) msg = err.message || t('swap.failed');
      else msg = t('swap.failed');
      setStatus({ kind: 'error', message: msg });
    }
  }

  if (!isZion) {
    return (
      <section className="card">
        <p className="warn">{t('swap.zion_only')}</p>
        <button className="btn-ghost" onClick={onBack}>
          {t('common.back')}
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2 className="create-step__title">{t('swap.title')}</h2>
      <p className="create-step__lead">{t('swap.lead')}</p>

      {pools === null && client === null && !poolErr && (
        <p className="muted small">{t('swap.loading_pool')}</p>
      )}
      {poolErr && (
        <p className="error small" role="alert">
          {t('swap.pool_load_failed', { reason: poolErr })}
        </p>
      )}

      <label className="label" htmlFor="swap-from">
        {t('swap.from_label')}
      </label>
      <select
        id="swap-from"
        className="chain-select"
        value={fromAsset.denom}
        onChange={(e) => {
          const a = ZION_ASSETS.find((x) => x.denom === e.target.value);
          if (a) setFromAsset(a);
        }}
        disabled={locked}
      >
        {ZION_ASSETS.map((a) => (
          <option key={a.denom} value={a.denom}>
            {a.symbol}
          </option>
        ))}
      </select>

      <label className="label" htmlFor="swap-to">
        {t('swap.to_label')}
      </label>
      <select
        id="swap-to"
        className="chain-select"
        value={toAsset.denom}
        onChange={(e) => {
          const a = ZION_ASSETS.find((x) => x.denom === e.target.value);
          if (a) setToAsset(a);
        }}
        disabled={locked}
      >
        {ZION_ASSETS.map((a) => (
          <option key={a.denom} value={a.denom}>
            {a.symbol}
          </option>
        ))}
      </select>

      {sameDenom && <p className="error small">{t('swap.same_denom')}</p>}

      <label className="label" htmlFor="swap-amount">
        {t('swap.amount_label', { symbol: fromAsset.symbol })}
      </label>
      <input
        id="swap-amount"
        type="text"
        inputMode="decimal"
        className="verify-row__input"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="0.0"
        disabled={locked}
      />
      {trimmedAmount.length > 0 && !amountInfo.valid && (
        <p className="error small">{t('swap.amount_invalid')}</p>
      )}

      {noPool && <p className="error small">{t('swap.no_pool')}</p>}

      {pool && quote && (
        <div className="swap-summary">
          <div className="muted small">
            {t('swap.pool_label')}: {pool.id.toString()}
          </div>
          <div className="muted small">
            {t('swap.burn_label')}:{' '}
            {formatAmount(quote.burnTotal, fromAsset.decimals)} {fromAsset.symbol}
          </div>
          <div className="muted small">
            {t('swap.fee_label')}:{' '}
            {formatAmount(quote.feeTotal, fromAsset.decimals)} {fromAsset.symbol}{' '}
            ({(pool.feeBps / 100).toFixed(2)}%)
          </div>
          <div className="small">
            {t('swap.estimate_label')}: ≈{' '}
            {formatAmount(quote.amountOutEst, toAsset.decimals)} {toAsset.symbol}
          </div>
          <div className="small">
            {t('swap.min_label')}: ≥{' '}
            {formatAmount(quote.minAmountOut, toAsset.decimals)} {toAsset.symbol}
          </div>
        </div>
      )}

      {status.kind === 'pending' && (
        <p className="muted small">{t('swap.pending')}</p>
      )}
      {status.kind === 'sent' && (
        <div className="send-sent">
          <p className="label">{t('swap.sent_title')}</p>
          <p className="addr send-hash" title={status.hash}>
            {shortenAddress(status.hash)}
          </p>
        </div>
      )}
      {status.kind === 'error' && <p className="error">{status.message}</p>}

      {status.kind === 'sent' ? (
        <button className="btn-primary" onClick={onBack}>
          {t('send.back_to_wallet')}
        </button>
      ) : (
        <button
          className="btn-primary"
          disabled={!canSubmit}
          onClick={() => {
            void performSwap();
          }}
        >
          {status.kind === 'pending' ? t('swap.pending') : t('swap.confirm')}
        </button>
      )}
      <button
        className="btn-ghost"
        onClick={onBack}
        disabled={status.kind === 'pending'}
      >
        {t('common.back')}
      </button>
    </section>
  );
}

// 천 단위 쉼표 — 정수부에만 적용. 소수부는 그대로. "1234567.8900" → "1,234,567.8900".
function withCommas(s: string): string {
  const dot = s.indexOf('.');
  const head = dot === -1 ? s : s.slice(0, dot);
  const tail = dot === -1 ? '' : s.slice(dot);
  const sign = head.startsWith('-') ? '-' : '';
  const digits = sign ? head.slice(1) : head;
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + tail;
}

// bigint base-unit 잔액 → "0.0000" 한 단위 표기. decimals 는 체인별 (EVM 18,
// Cosmos 6, BTC 8 등) — 표시는 항상 소수점 4자리로 자른다. 정수부엔 천 단위 쉼표.
function formatAmount(base: bigint | null, decimals: number): string {
  if (base == null) return '0.0000';
  const factor = 10n ** BigInt(decimals);
  const whole = base / factor;
  const frac = base % factor;
  const fracStr = (Number(frac) / Number(factor)).toFixed(4).slice(2);
  return `${withCommas(whole.toString())}.${fracStr}`;
}

// native 심볼 → 1 unit native = X BTC. 미상장(TTL/kWR) 은 PRICE_PEG_TO_BTC,
// 그 외는 Binance {SYM}BTC pair. BTC 는 1:1. 시세 없으면 null (UI 에서 "—" 표시).
function nativeToBtcRatio(
  symbol: string,
  prices: Record<string, number> | null,
): number | null {
  const peg = PRICE_PEG_TO_BTC[symbol];
  if (peg !== undefined) return peg;
  if (symbol === 'BTC') return 1;
  if (!prices) return null;
  const pair = `${symbol.toUpperCase()}BTC`;
  return prices[pair] ?? null;
}

// 임의 ERC-20/ZION 토큰 심볼 → 1 unit = X USD. Binance ticker 의 {SYM}USDT pair
// 를 우선 시도, 없으면 {SYM}BTC × BTCUSDT 우회. 스테이블코인 (USDC/USDT/DAI)
// 은 ticker 없거나 = 1 로 봐도 무방한 케이스 — 명시적으로 1 로 매핑한다.
const STABLE_USD: Readonly<Record<string, number>> = {
  USDT: 1,
  USDC: 1,
  DAI: 1,
  BUSD: 1,
  TUSD: 1,
};
function tokenToUsd(
  symbol: string,
  prices: Record<string, number> | null,
): number | null {
  const sym = symbol.toUpperCase();
  if (STABLE_USD[sym] !== undefined) return STABLE_USD[sym]!;
  if (!prices) return null;
  // 직접 USDT 페어가 있으면 최단 경로
  const direct = prices[`${sym}USDT`];
  if (direct !== undefined && direct > 0) return direct;
  // BTC 페어 + BTCUSDT 우회 — ETHBTC, WETHBTC 같은 wrapped 자산 커버
  const btc = prices[`${sym}BTC`];
  const btcUsd = prices['BTCUSDT'];
  if (btc !== undefined && btc > 0 && btcUsd !== undefined && btcUsd > 0) {
    return btc * btcUsd;
  }
  // WETH/WBTC 같은 wrapped 는 원본 심볼로 한 번 더 시도
  if (sym.startsWith('W') && sym.length > 1) {
    return tokenToUsd(sym.slice(1), prices);
  }
  // ZION 미상장 — kWR 은 PEG 으로 매핑
  const peg = PRICE_PEG_TO_BTC[sym];
  if (peg !== undefined && btcUsd !== undefined && btcUsd > 0) {
    return peg * btcUsd;
  }
  return null;
}

// base-unit bigint 잔액 × decimals × 1 unit → number (USD 또는 BTC).
// BigInt 정확도를 number 로 좁히는 지점은 마지막 곱셈 한 번만.
function baseUnitToNumber(amount: bigint, decimals: number): number {
  const factor = 10n ** BigInt(decimals);
  const whole = amount / factor;
  const frac = amount % factor;
  return Number(whole) + Number(frac) / Number(factor);
}

// 잔액(bigint base-unit) + 체인 decimals + (1 native = X BTC) → BTC 수량.
// BigInt 정확도를 number 로 좁히는 지점은 마지막 곱셈 한 번만.
function nativeToBtc(balance: bigint, decimals: number, btcPerNative: number): number {
  const factor = 10n ** BigInt(decimals);
  const whole = balance / factor;
  const frac = balance % factor;
  const nativeAsNum = Number(whole) + Number(frac) / Number(factor);
  return nativeAsNum * btcPerNative;
}

// BTC 표시 — 값 크기에 따라 자릿수 조정. 정수부 천 단위 쉼표.
function formatBtcValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0.00000000';
  const fixed =
    v >= 1 ? v.toFixed(4) : v >= 0.001 ? v.toFixed(6) : v.toFixed(8);
  return withCommas(fixed);
}

// USD 표시 — 1 이상은 cent, 그 이하는 4자리. 정수부 천 단위 쉼표.
function formatUsdValue(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v === 0) return '0.00';
  const fixed = v >= 1 ? v.toFixed(2) : v.toFixed(4);
  return withCommas(fixed);
}

// ────────── 계정 추가 메뉴 ──────────
function AddAccountMenu({
  onPickCreate,
  onPickRestore,
  onPickImportPk,
  onBack,
}: {
  onPickCreate: () => void;
  onPickRestore: () => void;
  onPickImportPk: () => void;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <section className="card">
      <h2 className="create-step__title">{t('add.title')}</h2>
      <button className="btn-primary" onClick={onPickCreate}>
        {t('add.choice_new_mnemonic')}
      </button>
      <button className="btn-ghost" onClick={onPickRestore}>
        {t('add.choice_recover_mnemonic')}
      </button>
      <button className="btn-ghost" onClick={onPickImportPk}>
        {t('add.choice_import_private_key')}
      </button>
      <button className="btn-ghost" onClick={onBack}>
        {t('add.back')}
      </button>
    </section>
  );
}

// ────────── Private key import ──────────
//
// 32바이트 raw key 의 hex 입력. 0x prefix 유무 모두 허용 (store 가 정규화).
// 라벨은 옵션 — UI 가 빈 문자열을 null 로 변환해 store 에 전달.
function ImportPrivateKeyPane({
  onImport,
  onCancel,
}: {
  onImport: (hex: string, label: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [hex, setHex] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await onImport(hex.trim(), label.trim() === '' ? null : label.trim());
    } catch (e) {
      setError(localizeShellError(t, e, t('errors.privateKey.invalid')));
    } finally {
      setBusy(false);
    }
  }

  // 형태만 빠르게 검사 — 정밀 검증은 store/SDK 가 처리.
  const looksValid = useMemo(() => {
    const s = hex.trim().replace(/^0x/i, '');
    return s.length === 64 && /^[0-9a-fA-F]+$/.test(s);
  }, [hex]);

  return (
    <section className="card">
      <h2 className="create-step__title">{t('import.private_key.title')}</h2>
      <p className="create-step__lead">{t('import.private_key.lead')}</p>

      <label className="label" htmlFor="pk-input">
        {t('import.private_key.label')}
      </label>
      <textarea
        id="pk-input"
        rows={3}
        value={hex}
        onChange={(e) => setHex(e.target.value)}
        placeholder={t('import.private_key.placeholder')}
        spellCheck={false}
        autoCapitalize="none"
        autoCorrect="off"
      />

      <label className="label" htmlFor="pk-label-input">
        {t('import.private_key.label_optional')}
      </label>
      <input
        id="pk-label-input"
        type="text"
        className="verify-row__input"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder={t('import.private_key.label_placeholder')}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        disabled={busy}
      />

      <button
        className="btn-primary"
        disabled={!looksValid || busy}
        onClick={() => {
          void submit();
        }}
      >
        {busy ? t('common.loading_ellipsis') : t('import.private_key.confirm')}
      </button>
      <button className="btn-ghost" onClick={onCancel} disabled={busy}>
        {t('common.cancel')}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

// ────────── 비밀 키 노출 ──────────
//
// 활성 계정의 시드구문(12 단어) 또는 raw private key 를 표시한다.
// 보안 게이트: 경고 + 체크박스 → 표시 버튼. 표시 후에는 숨기기 토글.
//
// 클립보드 복사는 noopener — 다른 페이지로 새는 경로 없음.
function ExportSecretPane({
  account,
  onClose,
}: {
  account: AccountInfo | null;
  onClose: () => void;
}) {
  const t = useT();
  const [acked, setAcked] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!account) {
    return (
      <section className="card">
        <p className="error">{t('errors.account.not_found')}</p>
        <button className="btn-ghost" onClick={onClose}>
          {t('common.back')}
        </button>
      </section>
    );
  }

  async function doReveal(): Promise<void> {
    setError(null);
    try {
      const s =
        account!.kind === 'mnemonic'
          ? await walletStore.exportMnemonic(account!.idx)
          : await walletStore.exportPrivateKey(account!.idx);
      setSecret(s);
      setRevealed(true);
    } catch (e) {
      setError(localizeShellError(t, e, t('errors.unknown')));
    }
  }

  function doHide(): void {
    setSecret(null);
    setRevealed(false);
    setCopied(false);
  }

  async function doCopy(): Promise<void> {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // 권한 거부 시 — 사용자는 화면에서 직접 복사 가능.
    }
  }

  // mnemonic 은 12 단어를 4×3 그리드로, raw key 는 한 줄(긴 hex)로.
  return (
    <section className="card">
      <h2 className="create-step__title">{t('export.title')}</h2>
      <p className="warn small" style={{ margin: 0 }}>
        {t('export.warn')}
      </p>
      <p className="create-step__lead">
        {account.kind === 'mnemonic'
          ? t('export.kind_mnemonic')
          : t('export.kind_private_key')}
      </p>

      {!revealed ? (
        <>
          <label className="safe-check">
            <input
              type="checkbox"
              checked={acked}
              onChange={(e) => setAcked(e.target.checked)}
            />
            <span>{t('export.checkbox')}</span>
          </label>
          <button
            className="btn-primary"
            disabled={!acked}
            onClick={() => {
              void doReveal();
            }}
          >
            {t('export.reveal_button')}
          </button>
        </>
      ) : (
        <>
          {account.kind === 'mnemonic' && secret ? (
            <ul
              className="popup-mnemonic-grid"
              aria-label={t('create.mnemonic_grid_label')}
            >
              {secret
                .split(/\s+/)
                .filter(Boolean)
                .map((w, i) => (
                  <li
                    key={`${i}-${w}`}
                    className="popup-mnemonic-cell"
                    aria-label={t('create.word_index_label', { n: i + 1 })}
                  >
                    <span className="popup-mnemonic-cell__index" aria-hidden="true">
                      {i + 1}
                    </span>
                    <span className="popup-mnemonic-cell__word">{w}</span>
                  </li>
                ))}
            </ul>
          ) : (
            <p className="addr export-key" title={secret ?? ''}>
              {secret}
            </p>
          )}
          <div className="account-actions">
            <button
              className="btn-ghost btn-sm"
              onClick={() => {
                void doCopy();
              }}
            >
              {copied ? t('export.copied') : t('export.copy')}
            </button>
            <button className="btn-ghost btn-sm" onClick={doHide}>
              {t('export.hide_button')}
            </button>
          </div>
        </>
      )}

      <button className="btn-ghost" onClick={onClose}>
        {t('common.back')}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

// ────────── 시드 복구 입력 ──────────
function RestorePane({
  onSubmit,
  onCancel,
}: {
  onSubmit: (mnemonic: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      await onSubmit(text);
    } catch (e) {
      setError(localizeShellError(t, e, t('recover.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <label className="label" htmlFor="m">
        {t('popup.mnemonic_label')}
      </label>
      <textarea
        id="m"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('popup.mnemonic_placeholder')}
      />
      <button
        className="btn-primary"
        onClick={() => {
          void submit();
        }}
        disabled={busy}
      >
        {busy ? t('common.loading_ellipsis') : t('home.recover_button')}
      </button>
      <button className="btn-ghost" onClick={onCancel} disabled={busy}>
        {t('common.cancel')}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

// ────────── 지갑 생성 3단계 흐름 ──────────
//
// 단계: 'language' → 'show' → 'verify' → onFinalize.
// 한국어 BIP39 wordlist 는 NFKD 자모분리 형태로 저장돼 있어 IME(NFC) 와의 비교가
// 어긋난다. 표시·복사·split 은 NFC 로 통일, 비교만 양쪽 NFKD 로 통일한다.
function CreateFlow({
  onFinalize,
  onCancel,
}: {
  onFinalize: (mnemonic: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  type Step = 'language' | 'show' | 'verify';
  const [step, setStep] = useState<Step>('language');
  const [wordlist, setWordlist] = useState<WordlistName>('korean');
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [verifyIndices, setVerifyIndices] = useState<number[]>([]);
  const [verifyInputs, setVerifyInputs] = useState<string[]>(['', '', '', '']);
  const [mismatch, setMismatch] = useState<boolean[]>([false, false, false, false]);
  const [copied, setCopied] = useState(false);
  const [safeAck, setSafeAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const words = useMemo(
    () => (mnemonic ? mnemonic.split(/\s+/).filter(Boolean) : []),
    [mnemonic],
  );

  function goShow(): void {
    setError(null);
    // BIP39 한국어 wordlist 는 NFKD 자모분리. 표시/복사/split 일관성을 위해 NFC 통일.
    // mnemonicToSeed 는 PBKDF2 시점에 자체 NFKD 정규화하므로 키 derivation 동일.
    const m = createMnemonic(128, wordlist).normalize('NFC');
    setMnemonic(m);
    setVerifyIndices(pickIndices(4, 12));
    setVerifyInputs(['', '', '', '']);
    setMismatch([false, false, false, false]);
    setSafeAck(false);
    setCopied(false);
    setStep('show');
  }

  async function copyMnemonic(): Promise<void> {
    if (!mnemonic) return;
    try {
      await navigator.clipboard.writeText(mnemonic);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError(t('create.copy_failed'));
    }
  }

  function goVerify(): void {
    setError(null);
    setStep('verify');
  }

  function setVerifyInputAt(i: number, v: string): void {
    setVerifyInputs((prev) => prev.map((x, j) => (j === i ? v : x)));
    setMismatch((prev) => prev.map((x, j) => (j === i ? false : x)));
  }

  async function submitVerify(): Promise<void> {
    if (!mnemonic) return;
    // 한국어 wordlist 가 NFKD, 입력은 NFC 가 섞일 수 있으므로 양쪽을 NFKD 통일 비교.
    const fresh = verifyIndices.map((idx, i) => {
      const user = (verifyInputs[i] ?? '').trim().normalize('NFKD');
      const expected = (words[idx] ?? '').normalize('NFKD');
      return user !== expected;
    });
    if (fresh.some(Boolean)) {
      setMismatch(fresh);
      setError(t('create.verify.failed'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onFinalize(mnemonic);
    } catch (e) {
      setError(localizeShellError(t, e, t('create.failed')));
    } finally {
      setBusy(false);
    }
  }

  if (step === 'language') {
    return (
      <section className="card">
        <h2 className="create-step__title">{t('create.language.title')}</h2>
        <p className="create-step__lead">{t('create.language.lead')}</p>
        <div className="lang-toggle" role="radiogroup" aria-label={t('common.language')}>
          <LanguageOption
            current={wordlist}
            value="korean"
            label={t('common.korean')}
            onPick={setWordlist}
          />
          <LanguageOption
            current={wordlist}
            value="english"
            label={t('common.english')}
            onPick={setWordlist}
          />
        </div>
        <button className="btn-primary" onClick={goShow}>
          {t('create.language.next')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          {t('common.cancel')}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </section>
    );
  }

  if (step === 'show') {
    return (
      <section className="card">
        <h2 className="create-step__title">{t('create.title')}</h2>
        <p className="create-step__lead">{t('create.lead')}</p>
        <p className="warn small" style={{ margin: 0 }}>
          {t('create.warn')}
        </p>
        <ul
          className="popup-mnemonic-grid"
          aria-label={t('create.mnemonic_grid_label')}
        >
          {words.map((w, i) => (
            <li
              key={`${i}-${w}`}
              className="popup-mnemonic-cell"
              aria-label={t('create.word_index_label', { n: i + 1 })}
            >
              <span className="popup-mnemonic-cell__index" aria-hidden="true">
                {i + 1}
              </span>
              <span className="popup-mnemonic-cell__word">{w}</span>
            </li>
          ))}
        </ul>
        <button className="btn-ghost btn-sm" onClick={copyMnemonic}>
          {copied ? t('common.copied') : t('common.copy')}
        </button>
        <label className="safe-check">
          <input
            type="checkbox"
            checked={safeAck}
            onChange={(e) => setSafeAck(e.target.checked)}
          />
          <span>{t('create.checkbox_safe')}</span>
        </label>
        <button className="btn-primary" disabled={!safeAck} onClick={goVerify}>
          {t('create.confirm_done')}
        </button>
        <button className="btn-ghost" onClick={onCancel}>
          {t('create.show.back')}
        </button>
        {error ? <p className="error">{error}</p> : null}
      </section>
    );
  }

  // step === 'verify'
  const datalistId = `bip39-${wordlist}`;
  return (
    <section className="card">
      <h2 className="create-step__title">{t('create.verify.title')}</h2>
      <p className="create-step__lead">{t('create.verify.lead')}</p>
      <div className="verify-list">
        {verifyIndices.map((wordIndex, row) => (
          <div className="verify-row" key={wordIndex}>
            <span className="verify-row__label" aria-hidden="true">
              {t('create.verify.input_label', { n: wordIndex + 1 })}
            </span>
            <input
              type="text"
              className={
                mismatch[row]
                  ? 'verify-row__input verify-row__input--mismatch'
                  : 'verify-row__input'
              }
              value={verifyInputs[row]}
              onChange={(e) => setVerifyInputAt(row, e.target.value)}
              placeholder={t('create.verify.input_placeholder')}
              aria-label={t('create.verify.input_label', { n: wordIndex + 1 })}
              list={datalistId}
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={busy}
            />
          </div>
        ))}
      </div>
      <WordlistDatalist id={datalistId} wordlist={wordlist} />
      <button
        className="btn-primary"
        onClick={() => {
          void submitVerify();
        }}
        disabled={busy || verifyInputs.some((v) => v.trim() === '')}
      >
        {busy ? t('common.loading_ellipsis') : t('create.verify.confirm')}
      </button>
      <button
        className="btn-ghost"
        onClick={() => {
          setStep('show');
          setError(null);
        }}
        disabled={busy}
      >
        {t('create.verify.back')}
      </button>
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

function LanguageOption({
  current,
  value,
  label,
  onPick,
}: {
  current: WordlistName;
  value: WordlistName;
  label: string;
  onPick: (v: WordlistName) => void;
}) {
  const active = current === value;
  return (
    <label
      className={active ? 'lang-toggle__opt lang-toggle__opt--active' : 'lang-toggle__opt'}
    >
      <input
        className="sr-only"
        type="radio"
        name="create-wordlist"
        value={value}
        checked={active}
        onChange={() => onPick(value)}
      />
      <span>{label}</span>
    </label>
  );
}

function WordlistDatalist({ id, wordlist }: { id: string; wordlist: WordlistName }) {
  // BIP39 한국어 wordlist 는 NFKD — IME(NFC) 의 prefix 매칭을 위해 NFC 변환 후 노출.
  const words = useMemo(
    () => getWordlist(wordlist).map((w) => w.normalize('NFC')),
    [wordlist],
  );
  return (
    <datalist id={id}>
      {words.map((w) => (
        <option key={w} value={w} />
      ))}
    </datalist>
  );
}

// 12 중 4 개 비복원 추출. 정렬해서 사용자가 위→아래 순서로 자연스럽게 입력하도록 한다.
// 비-암호적 Math.random 으로 충분: 게이트가 아니라 학습 보조이고, 인덱스 예측은 무의미.
function pickIndices(count: number, max: number): number[] {
  const pool = Array.from({ length: max }, (_, i) => i);
  for (let i = max - 1; i >= max - count; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(max - count).sort((a, b) => a - b);
}

function shortenAddress(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}


// ────────── 금고 잠금 해제 ──────────
//
// 앱 부팅 시 저장된 금고가 있으면 가장 먼저 뜨는 화면. 확장에는 없던 계층이다
// (확장은 브라우저 세션이 곧 잠금이었다).
//
// 오입력 처리: keystoreSession.unlock 은 실패해도 금고를 건드리지 않는다.
// 그래서 시도 횟수 제한을 두지 않는다 — 제한을 두면 정작 주인이 잠기고,
// 오프라인 공격자에게는 아무 장벽이 되지 않는다 (blob 을 통째로 뽑아가면
// 우리 UI 를 거치지 않으므로). 실질 방어선은 scrypt 비용이다.
function UnlockPane({
  onUnlock,
  onWipe,
}: {
  onUnlock: (passphrase: string) => Promise<void>;
  onWipe: () => Promise<void>;
}) {
  const t = useT();
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeAck, setWipeAck] = useState(false);

  async function submit(): Promise<void> {
    if (busy || pass.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await onUnlock(pass);
      setPass('');
    } catch (e) {
      setErr(localizeShellError(t, e, t('errors.unknown')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card vault-pane">
      <h3 className="section-title">{t('vault.unlock.title')}</h3>
      <label className="label" htmlFor="vault-pass">
        {t('vault.unlock.label')}
      </label>
      <input
        id="vault-pass"
        className="input"
        type="password"
        inputMode="text"
        autoComplete="current-password"
        autoFocus
        value={pass}
        placeholder={t('vault.unlock.placeholder')}
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        disabled={busy}
      />
      <button
        className="btn-primary"
        onClick={() => void submit()}
        disabled={busy || pass.length === 0}
      >
        {busy ? t('vault.unlock.working') : t('vault.unlock.action')}
      </button>
      {err ? <p className="error">{err}</p> : null}
      <p className="muted small">{t('vault.locked_note')}</p>

      {!wipeOpen ? (
        <button className="btn-ghost btn-sm" onClick={() => setWipeOpen(true)}>
          {t('vault.wipe.action')}
        </button>
      ) : (
        <div className="danger-zone">
          <p className="warn">{t('vault.wipe.confirm')}</p>
          <label className="safe-check">
            <input
              type="checkbox"
              checked={wipeAck}
              onChange={(e) => setWipeAck(e.target.checked)}
            />
            <span>{t('vault.wipe.ack')}</span>
          </label>
          <button
            className="btn-danger"
            disabled={!wipeAck || busy}
            onClick={() => {
              setBusy(true);
              void onWipe().finally(() => {
                setBusy(false);
                setWipeOpen(false);
                setWipeAck(false);
              });
            }}
          >
            {t('vault.wipe.do')}
          </button>
          <button
            className="btn-ghost btn-sm"
            onClick={() => {
              setWipeOpen(false);
              setWipeAck(false);
            }}
          >
            {t('vault.wipe.cancel')}
          </button>
        </div>
      )}
    </section>
  );
}

// ────────── 금고 비밀번호 설정 (첫 지갑) ──────────
//
// 시드를 확보한 직후에만 들어온다. 여기서 확정돼야 시드가 디스크에 봉인되므로,
// 취소하면 방금 만든 시드는 버려진다 — 그 사실을 화면에 명시한다.
function SetPassphrasePane({
  onSubmit,
  onCancel,
}: {
  onSubmit: (passphrase: string) => Promise<void>;
  onCancel: () => void;
}) {
  const t = useT();
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tooShort = pass.length > 0 && pass.length < MIN_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && pass !== confirm;
  const ready =
    pass.length >= MIN_PASSPHRASE_LENGTH && pass === confirm && !busy;

  async function submit(): Promise<void> {
    if (!ready) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(pass);
      setPass('');
      setConfirm('');
    } catch (e) {
      setErr(localizeShellError(t, e, t('errors.unknown')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card vault-pane">
      <h3 className="section-title">{t('vault.set.title')}</h3>
      <p className="muted small">{t('vault.set.explain')}</p>

      <label className="label" htmlFor="vault-new-pass">
        {t('vault.set.label', { n: MIN_PASSPHRASE_LENGTH })}
      </label>
      <input
        id="vault-new-pass"
        className="input"
        type="password"
        autoComplete="new-password"
        autoFocus
        value={pass}
        onChange={(e) => setPass(e.target.value)}
        disabled={busy}
      />
      {tooShort ? (
        <p className="error">
          {t('vault.set.too_short', { n: MIN_PASSPHRASE_LENGTH })}
        </p>
      ) : null}

      <label className="label" htmlFor="vault-confirm-pass">
        {t('vault.set.confirm_label')}
      </label>
      <input
        id="vault-confirm-pass"
        className="input"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void submit();
        }}
        disabled={busy}
      />
      {mismatch ? <p className="error">{t('vault.set.mismatch')}</p> : null}

      <button className="btn-primary" onClick={() => void submit()} disabled={!ready}>
        {busy ? t('vault.set.working') : t('vault.set.action')}
      </button>
      <button className="btn-ghost btn-sm" onClick={onCancel} disabled={busy}>
        {t('vault.set.cancel')}
      </button>
      {err ? <p className="error">{err}</p> : null}
      <p className="muted small">{t('vault.autolock_note')}</p>
    </section>
  );
}
