import { useCallback, useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { parseUnits } from 'viem';
import {
  createMnemonic,
  getWordlist,
  NEW_MNEMONIC_STRENGTH,
  NEW_MNEMONIC_WORD_COUNT,
  type ChainAdapter,
  type HwAppName,
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
import {
  Addressbook,
  ChromeLocalBackend,
  ShellError,
  type AccountInfo,
  type SelfAddressInput,
} from '@byeorin/shell-core';
import { LocaleSwitch, useT } from '@byeorin/i18n/react';
import type { EvmAdapter } from '@byeorin/wallet-sdk/evm';
import {
  discoverPortableTokens,
  readPortableToken,
  supportsManualToken,
  supportsTokens,
  type PortableTokenBalance,
} from '@byeorin/wallet-sdk/core';
// 벼린 환율 — TTL 통화토큰의 가치는 Binance 시세가 아니라 이 스냅샷에서 온다.
// 주소로 찾는다: 심볼로 찾으면 tUSD 가 대문자화되어 TrueUSD(TUSD)와 충돌한다.
import { rateByAddress, rateByIso, tokenAmountToTtl } from '@byeorin/wallet-sdk/evm';
// TTL 환산값 표기는 토큰 목록 화면과 같은 함수를 쓴다 — 두 화면이 같은 잔액에
// 다른 자릿수를 내면 안 된다.
import { formatTtl } from './lib/token-visibility.js';
import {
  addCustomErc20,
  connectHardware,
  disconnectHardware,
  discoverEvmTokens,
  getHwAccount,
  loadCustomTokensFromStorage,
  loadTtlScanTokens,
  addManualToken,
  loadManualTokens,
  subscribeHwState,
  walletStore,
  type HwAccountState,
} from '../../src/lib/wallet-service.js';
import {
  listApprovedOrigins,
  revokeOrigin,
  type Origin,
} from '../../src/lib/origins.js';
import {
  listActiveGrants,
  revokeAllForOrigin,
  revokeGrant,
  type GrantMethod,
  type GrantRecord,
} from '../../src/lib/grants.js';
// Stage E2/E3 화면들 — App.tsx 가 2500 줄을 넘겨 화면 단위로 분리했다.
import { AddressMatrix } from './screens/AddressMatrix.js';
import {
  AddressbookPane,
  notifyAddressbookChanged,
} from './screens/AddressbookPane.js';
import { ActivityPane } from './screens/ActivityPane.js';
import { SendPane } from './screens/SendPane.js';
import { TokenListPane } from './screens/TokenListPane.js';
import { ExchangePane, type TtlAmmClientLike } from './screens/ExchangePane.js';

// 벼린 — 확장 팝업.
// 셸 라이프사이클: 잠금 → (생성/복구/PK import) → 잠금해제 → (계정 추가/전환/제거/키 노출) → 잠금.
//
// 잠금해제 후의 mode:
//   - 'home'       : 계정 목록 + 활성 계정 카드 + HW + 연결된 사이트/grants
//   - 'add-menu'   : 새 시드 / 복구 / private key import 3개 선택
//   - 'import-pk'  : raw private key 입력 흐름
//   - 'export'     : 활성 계정의 비밀 키 노출 (경고 + 체크박스 게이트)
//   - 'create'     : 3 단계 시드 생성 (잠금 전/후 공용)
//   - 'restore'    : 시드 복구 입력 (잠금 전/후 공용)
//   - 'addresses'  : 활성 계정의 체인별 주소 매트릭스 (Stage E2)
//   - 'addressbook': 주소록 — 내 계정 자동 sync + 외부 주소 CRUD (Stage E2)
//   - 'activity'   : 활동 내역 (Stage E3, EVM 체인 전용)
//   - 'tokens'     : 토큰 목록 — 검색·보기/가리기·벼린 환율 가치 (Stage E4)
//   - 'exchange'   : 내부 거래소 스왑 (TTL 체인 AMM — docs/EXCHANGE.md)

type Mode =
  | 'home'
  | 'create'
  | 'restore'
  | 'add-menu'
  | 'import-pk'
  | 'export'
  | 'send'
  | 'swap'
  | 'addresses'
  | 'addressbook'
  | 'activity'
  | 'tokens'
  | 'exchange';

// 송금 금액 검증 — 10진수, 소수점 18자리 이하 (체인별 decimals 는 parseUnits 가 처리).
const AMOUNT_RE = /^\d+(\.\d{1,18})?$/;

// 시드를 보여준 뒤 되묻는 단어 수. 24 단어 중 6 개.
// 12 단어 시절엔 4 개였다. 단어 수가 두 배가 됐는데 되묻는 수를 그대로 두면
// 확인 강도가 떨어져 6 으로 올렸다 (Ledger/Trezor 가 24 중 2~4 개를 묻는 것보다
// 여전히 엄격하다). 더 올릴 수도 있지만 모바일 입력 부담과의 절충점이다.
const VERIFY_WORD_COUNT = 6;

// ZION Phase 1 의 4종 자산 — ActiveAccountCard 와 SwapPane 양쪽이 공유.
// ZionWallet.MD §3 표 그대로. ueth 가 표준 ETH 18 이 아닌 6 decimals 인 점 주의.
type ZionAsset = { denom: string; symbol: string; decimals: number };
const ZION_ASSETS: readonly ZionAsset[] = [
  { denom: 'utrg', symbol: 'kWR', decimals: 6 },
  { denom: 'ubtc', symbol: 'BTC', decimals: 8 },
  { denom: 'uusdt', symbol: 'USDT', decimals: 6 },
  { denom: 'ueth', symbol: 'ETH', decimals: 6 },
];

// ────────── 수동 토큰 추가 ──────────
//
// 자동 발견이 못 찾는 토큰은 늘 있다 — 인덱서가 모르거나, 목록 API 상한에
// 걸렸거나, 방금 발행됐거나. 그때 사용자가 식별자를 직접 넣을 길이 있어야 한다.
//
// **체인마다 토큰 식별자의 형식이 완전히 다르다.** 예전에는 입력칸이 `0x…` 로
// 고정돼 있었고 비-EVM 체인에서는 "EVM 체인에서만 토큰 추가 가능합니다" 라고
// 거절했다. 지금은 9 체인이 모두 토큰을 다루므로 그 문구는 거짓이다.
//
// 분기를 handleAddCustomToken 안에 흩뿌리지 않고 표 하나로 모은다 — 체인이 늘면
// 이 표에 한 줄이 늘 뿐이고 추가 흐름 자체는 그대로다.

interface ManualTokenHint {
  /** 입력칸 위에 붙는 이름 — "무엇을 넣는가". */
  label: string;
  /** 입력칸 placeholder. 그 체인에서 실제로 통하는 형태만 적는다. */
  placeholder: string;
  /** 예시 한 줄. 형식을 말로 설명하는 것보다 실물 하나를 보여주는 편이 빠르다. */
  example: string;
  /**
   * 체인에 물어보기 전에 형식만으로 걸러낼 수 있을 때의 검사.
   *
   * 없으면 검사하지 않는다 — **모르는 형식을 지레 거절하지 않는다.** 틀린 값은
   * 체인이 답을 못 주는 것으로 드러나고, 그쪽이 우리가 어설픈 정규식으로 정상
   * 토큰을 막는 것보다 낫다.
   */
  pattern?: RegExp;
  patternError?: string;
}

const MANUAL_TOKEN_HINT_FALLBACK: ManualTokenHint = {
  label: '토큰 식별자',
  placeholder: '토큰 식별자',
  example: '이 체인의 식별자 형식은 아직 안내가 없습니다. 체인 문서의 표기를 그대로 넣으세요.',
};

/**
 * chainKey 의 계열 → 입력 안내.
 *
 * 키는 `evm:ttl` · `cosmos:zion` 처럼 `계열:체인` 이거나 `solana` 처럼 계열
 * 하나뿐이다. 앞부분만 보면 둘 다 걸린다.
 */
const MANUAL_TOKEN_HINTS: Readonly<Record<string, ManualTokenHint>> = {
  evm: {
    label: 'ERC-20 컨트랙트 주소',
    placeholder: '0x…',
    example: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    pattern: /^0x[0-9a-fA-F]{40}$/,
    patternError: '컨트랙트 주소가 올바르지 않습니다 (0x + 40자리 16진수).',
  },
  solana: {
    label: 'SPL mint 주소 (base58)',
    placeholder: 'mint 주소',
    example: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  },
  tron: {
    label: 'TRC-20 컨트랙트 주소',
    placeholder: 'T…',
    example: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  },
  cosmos: {
    label: 'denom',
    placeholder: 'utrg 또는 ibc/…',
    example: 'utrg · ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
  },
  sui: {
    label: 'coin type',
    placeholder: '0x2::sui::SUI',
    example: '0x2::sui::SUI',
  },
  aptos: {
    label: 'coin type 또는 FA 주소',
    placeholder: '0x1::aptos_coin::AptosCoin',
    example: '0x1::aptos_coin::AptosCoin · FA 는 0x… 메타데이터 주소',
  },
  ton: {
    label: 'jetton master 주소',
    placeholder: 'EQ…',
    example: 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs',
  },
  xrp: {
    label: '발행 통화 (통화코드.발행자)',
    placeholder: 'USD.r…',
    example: 'USD.rhub8VRN55s94qWKDv6jmDy1pUykJzF3wq',
  },
};

function manualTokenHint(chainKey: string): ManualTokenHint {
  const family = chainKey.split(':')[0] ?? '';
  return MANUAL_TOKEN_HINTS[family] ?? MANUAL_TOKEN_HINT_FALLBACK;
}

/**
 * 이 어댑터가 EVM 이면 chainId, 아니면 null.
 *
 * **저장에만 쓴다.** 읽기는 체인을 묻지 않는다(readPortableToken). 커스텀 토큰을
 * 재시작 후에도 기억하는 저장 계층이 지금은 EVM 레지스트리뿐이라, 어디에 넣을 수
 * 있는지를 판단하는 자리로만 남겨 둔다.
 */
function evmChainIdOf(adapter: unknown): number | null {
  const a = adapter as { chain?: { id?: unknown } };
  const id = a.chain?.id;
  return typeof id === 'number' ? id : null;
}

/** 세션 안에서만 기억하는 수동 추가 토큰. chainKey → 토큰 목록. */
type ManualTokenMap = Readonly<Record<string, readonly PortableTokenBalance[]>>;
const EMPTY_MANUAL_TOKENS: readonly PortableTokenBalance[] = [];

/** 같은 식별자를 다시 넣으면 나중 것이 이긴다. 대소문자 무시 — EVM 주소 때문. */
function mergeManualToken(
  map: ManualTokenMap,
  chainKey: string,
  token: PortableTokenBalance,
): ManualTokenMap {
  const cur = map[chainKey] ?? EMPTY_MANUAL_TOKENS;
  const rest = cur.filter((x) => x.id.toLowerCase() !== token.id.toLowerCase());
  return { ...map, [chainKey]: [...rest, token] };
}

/**
 * 자동 발견 목록 + 수동 추가분.
 *
 * 겹치면 자동 쪽이 이긴다 — 재조회로 갱신된 잔액이 추가 시점의 값보다 새롭다.
 * `null`(조회 중)은 그대로 통과시킨다: 로딩 3상태를 수동 목록이 덮어써서
 * "조회 중" 이 "빈 목록" 으로 보이면 안 된다.
 */
function withManualTokens(
  discovered: PortableTokenBalance[] | null,
  manual: readonly PortableTokenBalance[],
): PortableTokenBalance[] | null {
  if (discovered === null) return null;
  if (manual.length === 0) return discovered;
  const seen = new Set(discovered.map((x) => x.id.toLowerCase()));
  return [...discovered, ...manual.filter((x) => !seen.has(x.id.toLowerCase()))];
}

// 가치 표시 — 잔액을 BTC 단위로 보여주고, 클릭하면 USD 토글.
//
// 시세 출처: Binance `api/v3/ticker/price` 전체 ticker 1회 fetch + 메모리 캐시.
// 각 코인의 BTC pair (예: ETHBTC, SOLBTC) 와 BTCUSDT 만 사용한다.
//
// 미상장 토큰의 페그 — Binance 에 없는 토큰은 BTC 페그로 내재 가치를 둔다.
//
// TTL 은 **노동가치 기준** 으로 잡는다 (2026-07-25 결정).
//
// 단위의 뜻: **1 TTL = 일반 노동자의 하루 품삯** — 마태복음 20장 포도원 일꾼의
// "데나리온" 과 같은 단위다. 하루 일한 사람은 하루치를 받는다.
//
// 그 하루치의 BTC 환산은 설계자 한 사람의 몫을 나누는 데서 나온다:
//   설계자 기준 연봉 1000 BTC ÷ 365 일 = 설계자의 하루
//   설계자의 하루 = 100 TTL (= 노동자 100 명의 하루 품삯)
//   → 1 TTL = 1000 / 365 / 100 = 10/365 ≈ 0.02739726 BTC
//
// 최종 비율 하나로 적지 않고 상수 셋으로 쪼갠 이유: 나중에 바뀌는 값은 "기준
// 연봉" 이나 "설계자 하루당 TTL" 이지 비율이 아니다. 근거가 코드에 남아 있어야
// 다음에 조정할 때 무엇을 건드려야 하는지 바로 보인다.
const PEG_ANNUAL_BTC = 1000; // 설계자 기준 연봉 (BTC)
const PEG_DAYS_PER_YEAR = 365; // 연봉을 나누는 일수
const PEG_TTL_PER_DAY = 100; // 설계자의 하루를 나눈 몫 = 노동자 100 명의 하루 품삯
const TTL_PEG_BTC = PEG_ANNUAL_BTC / PEG_DAYS_PER_YEAR / PEG_TTL_PER_DAY;

// kWR(ZION) 은 **TTL 을 따라가지 않는다.** 예전에 1/300,000 으로 같이 뒀던 건
// "미상장이니 일단 TTL 과 동일하게" 라는 임시 가정이었고, 위 노동가치 근거는
// TTL 전용이다. ZION 쪽 별도 결정이 나올 때까지 옛 값을 유지한다.
const KWR_PEG_BTC = 1 / 300_000;

const PRICE_PEG_TO_BTC: Record<string, number> = {
  TTL: TTL_PEG_BTC,
  kWR: KWR_PEG_BTC,
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
  const [hw, setHw] = useState<HwAccountState | null>(getHwAccount());
  const [hwBusy, setHwBusy] = useState<boolean>(false);
  // 멀티체인 — 16 체인 spec 은 dynamic import 로 로드. 로드 전엔 null (TTL fallback).
  const [chainSpecs, setChainSpecs] = useState<ChainSpec[] | null>(null);
  const [chainSpecsErr, setChainSpecsErr] = useState<string | null>(null);
  const [activeChainKey, setActiveChainKey] = useState<string>('evm:ttl');
  // Binance 시세 캐시 (popup mount 시 1회 fetch). symbol → price (USDT 또는 BTC pair).
  // 예: prices['BTCUSDT']=61234, prices['ETHBTC']=0.0521, ...
  const [prices, setPrices] = useState<Record<string, number> | null>(null);
  // BTC ↔ USD 토글 — 모든 활성 계정 카드가 공유 (사용자가 한 번 USD 켜면 체인 바꿔도 유지).
  // 송금 화면이 쓸 자산 정보 — ActiveAccountCard 가 이미 조회한 값을 끌어올린다.
  // 카드는 mode==='home' 에서만 마운트되므로 App 이 들고 있어야 send 화면에서 산다.
  const [sendTokens, setSendTokens] = useState<PortableTokenBalance[] | null>(null);
  const [sendNativeBalance, setSendNativeBalance] = useState<bigint | null>(null);

  // 내부 거래소(TTL AMM) 클라이언트.
  //
  // **컨트랙트가 아직 배포되지 않았다** — 주소 세 개(factory/router/wttl)가
  // 나오면 아래 상수를 채우고 TtlAmmClient 를 생성하게 바꾼다. null 이면 화면이
  // "거래소가 아직 배포되지 않았습니다" 를 정직하게 그린다. 배포 전인데 있는
  // 척하는 것보다 낫다.
  const ttlAmmClient: TtlAmmClientLike | null = null;

  // 주소록 — 저장은 chrome.storage.local 평문 JSON (공개키 파생물인 주소만 담는다).
  const book = useMemo(() => new Addressbook(new ChromeLocalBackend()), []);

  const methodLabel = (m: GrantMethod): string => t(`popup.method.${m}`);

  const refreshAccounts = useCallback(() => {
    setAccounts(walletStore.listAccounts());
  }, []);

  // 사용자 커스텀 ERC-20 토큰을 storage 에서 registry 로 복원. 한 번만.
  useEffect(() => {
    void loadCustomTokensFromStorage();
    // TTL 발행 토큰 목록을 체인 쪽에서 받아 registry 에 얹는다. 실패해도
    // 빌트인으로 계속 동작하므로 결과를 기다리거나 오류를 띄우지 않는다.
    void loadTtlScanTokens();
  }, []);

  // 내 계정 × 전 체인 주소를 주소록의 self 구역에 자동 반영.
  // 계정/체인 목록이 바뀔 때만 돈다. 계정 수 × 체인 수만큼 adapter 를 만들지만
  // build() 는 RPC 를 때리지 않는 순수 객체 생성이다.
  useEffect(() => {
    if (!chainSpecs || accounts.length === 0) return;
    const inputs: SelfAddressInput[] = [];
    for (const acc of accounts) {
      const accLabel = acc.label ?? t('accounts.no_label', { idx: acc.idx + 1 });
      for (const spec of chainSpecs) {
        try {
          inputs.push({
            label: `${accLabel} · ${spec.displayName}`,
            address: walletStore.getAccountAt(acc.idx, spec.build()).address,
            chainKey: spec.key,
          });
        } catch {
          // 계정 × 체인 미지원 조합 (raw key + ed25519 등) — 주소록에 넣지 않는다.
        }
      }
    }
    void book.syncSelfEntries(inputs).then(notifyAddressbookChanged);
  }, [accounts, chainSpecs, book, t]);

  // HW 상태 구독. wallet-service 의 메모리 상태(transport 점유 시) 와,
  // hw-connect.html 페이지가 chrome.storage.session 에 적는 결과(별도 window
  // 에서 연결한 경우) 두 가지 경로를 모두 본다.
  useEffect(() => subscribeHwState(setHw), []);

  // hw-connect 별도 페이지에서 저장한 HW 결과 — 초기 로드 + 변경 구독.
  useEffect(() => {
    let cancelled = false;
    const HW_KEY = 'nd:hw-account';
    interface HwStored {
      appName: HwAppName;
      address: string;
      derivationPath: string;
      publicKeyHex: string;
      connectedAt: number;
    }
    const toState = (s: HwStored): HwAccountState => ({
      appName: s.appName,
      address: s.address,
      derivationPath: s.derivationPath,
      // 1차 v0.4: 표시만 사용. v0.5 EVM HW 서명 시 정확한 키 활용.
      publicKey: new Uint8Array(),
    });
    void chrome.storage.session.get(HW_KEY).then((data) => {
      if (cancelled) return;
      const v = (data as Record<string, HwStored | undefined>)[HW_KEY];
      if (v) setHw(toState(v));
    });
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ): void => {
      if (area !== 'session' || !(HW_KEY in changes)) return;
      const v = changes[HW_KEY]?.newValue as HwStored | undefined;
      if (v) setHw(toState(v));
      else setHw(null);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);

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

  // 부팅 시 자동 복원 시도(extension 은 autoRestoreAllowed=true).
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

  // ────────── 잠금 해제 / 계정 추가 ──────────

  // 두 의미의 mnemonic 처리:
  //   - locked   → walletStore.unlock(mnemonic)  (첫 계정으로 시작)
  //   - unlocked → walletStore.addMnemonicAccount (새 계정 추가)
  // CreateFlow / RestorePane 양쪽 모두 이 함수를 onFinalize/onSubmit 으로 사용한다.
  async function handleMnemonicSecret(mnemonic: string): Promise<void> {
    setError(null);
    if (walletStore.isUnlocked()) {
      await walletStore.addMnemonicAccount(mnemonic);
    } else {
      await walletStore.unlock(mnemonic);
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

  async function handleLogout(): Promise<void> {
    await walletStore.lock();
    refreshAccounts();
    setMode('home');
  }

  async function handleHwConnect(appName: HwAppName = 'solana'): Promise<void> {
    setError(null);
    // Chrome MV3 popup 안에서 WebHID chooser 를 띄우면 popup 자체가 blur 로
    // 닫혀버린다 (알려진 함정). 대신 별도 페이지(hw-connect.html) 를 새 window
    // 로 열어 그곳에서 디바이스 연결 → 결과를 chrome.storage.session 으로 받음.
    try {
      await chrome.windows.create({
        url: chrome.runtime.getURL(`hw-connect.html?app=${appName}`),
        type: 'popup',
        width: 540,
        height: 640,
      });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[byeorin] open hw-connect window failed:', e);
      setError(e instanceof Error ? e.message : t('errors.unknown'));
    }
  }

  async function handleHwDisconnect(): Promise<void> {
    setHwBusy(true);
    try {
      await disconnectHardware();
      // hw-connect 페이지가 storage 에 적은 결과도 함께 비운다.
      try {
        await chrome.storage.session.remove('nd:hw-account');
      } catch {
        // session storage 가 일시적으로 비가용 — 다음 mount 때 자동 정합.
      }
      setHw(null);
    } finally {
      setHwBusy(false);
    }
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

      {/* 잠금 상태 — 처음 만들기 / 복구 */}
      {!unlocked && mode === 'home' && (
        <section className="card">
          <p className="lead">{t('popup.has_no_wallet')}</p>
          <button className="btn-primary" onClick={() => setMode('create')}>
            {t('popup.create_new')}
          </button>
          <button className="btn-ghost" onClick={() => setMode('restore')}>
            {t('popup.recover_by_mnemonic')}
          </button>
          <HwConnectPanel
            hw={hw}
            busy={hwBusy}
            onConnect={handleHwConnect}
            onDisconnect={handleHwDisconnect}
          />
        </section>
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
            onAddresses={() => setMode('addresses')}
            onAddressbook={() => setMode('addressbook')}
            onActivity={() => setMode('activity')}
            onTokens={() => setMode('tokens')}
            onExchange={() => setMode('exchange')}
            onTokensChange={setSendTokens}
            onNativeBalanceChange={setSendNativeBalance}
            onLock={handleLogout}
            chainSpecs={chainSpecs}
            chainSpecsErr={chainSpecsErr}
            activeChainKey={activeChainKey}
            onChainSelect={setActiveChainKey}
            adapter={effectiveAdapter}
            nativeSymbol={effectiveSymbol}
            nativeDecimals={effectiveDecimals}
            prices={prices}
          />
          <HwConnectPanel
            hw={hw}
            busy={hwBusy}
            onConnect={handleHwConnect}
            onDisconnect={handleHwDisconnect}
          />
          <ConnectedSites methodLabel={methodLabel} />
        </>
      )}

      {/* 송금 화면 — 활성 계정 + 활성 체인. native + ERC-20 토큰(EVM) 둘 다. */}
      {unlocked && mode === 'send' && (
        <SendPane
          onBack={() => setMode('home')}
          adapter={effectiveAdapter}
          nativeSymbol={effectiveSymbol}
          nativeDecimals={effectiveDecimals}
          chainKey={activeChainKey}
          tokens={sendTokens}
          nativeBalance={sendNativeBalance}
          book={book}
        />
      )}

      {/* 체인별 주소 매트릭스 — 활성 계정 기준 */}
      {unlocked && mode === 'addresses' && accounts.length > 0 && (
        <AddressMatrix
          account={accounts.find((a) => a.active) ?? accounts[0]!}
          chainSpecs={chainSpecs}
          onBack={() => setMode('home')}
        />
      )}

      {/* 주소록 */}
      {unlocked && mode === 'addressbook' && (
        <AddressbookPane
          book={book}
          chainSpecs={chainSpecs}
          defaultChainKey={activeChainKey}
          onBack={() => setMode('home')}
        />
      )}

      {/* 토큰 목록 — 66 종 검색 · 보기/가리기 · 벼린 환율 가치 */}
      {unlocked && mode === 'tokens' && (
        <TokenListPane
          tokens={sendTokens}
          chainKey={activeChainKey}
          supported={supportsTokens(effectiveAdapter)}
          onBack={() => setMode('home')}
        />
      )}

      {/* 내부 거래소 — TTL 체인 AMM. 배포 전엔 그 사실을 그대로 그린다. */}
      {unlocked && mode === 'exchange' && (
        <ExchangePane
          client={ttlAmmClient}
          tokens={sendTokens}
          nativeBalance={sendNativeBalance}
          adapter={effectiveAdapter}
          chainKey={activeChainKey}
          onBack={() => setMode('home')}
        />
      )}

      {/* 활동 내역 — EVM 체인 전용. 비-EVM 은 화면 안에서 미지원 안내. */}
      {unlocked && mode === 'activity' && (
        <ActivityPane
          onBack={() => setMode('home')}
          address={accounts.find((a) => a.active)?.address ?? null}
          adapter={effectiveAdapter}
          chainKey={activeChainKey}
          nativeSymbol={effectiveSymbol}
          nativeDecimals={effectiveDecimals}
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
  onAddresses,
  onAddressbook,
  onActivity,
  onTokens,
  onExchange,
  onTokensChange,
  onNativeBalanceChange,
  onLock,
  chainSpecs,
  chainSpecsErr,
  activeChainKey,
  onChainSelect,
  adapter,
  nativeSymbol,
  nativeDecimals,
  prices,
}: {
  accounts: AccountInfo[];
  onSelect: (idx: number) => void;
  onRemove: (idx: number) => void;
  onAddClick: () => void;
  onShowKey: () => void;
  onSend: () => void;
  onSwap: () => void;
  onAddresses: () => void;
  onAddressbook: () => void;
  onActivity: () => void;
  onTokens: () => void;
  onExchange: () => void;
  onTokensChange: (rows: PortableTokenBalance[] | null) => void;
  onNativeBalanceChange: (b: bigint | null) => void;
  onLock: () => void;
  chainSpecs: ChainSpec[] | null;
  chainSpecsErr: string | null;
  activeChainKey: string;
  onChainSelect: (key: string) => void;
  adapter: ChainAdapter;
  nativeSymbol: string;
  nativeDecimals: number;
  prices: Record<string, number> | null;
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
          onAddresses={onAddresses}
          onAddressbook={onAddressbook}
          onActivity={onActivity}
          onTokens={onTokens}
          onExchange={onExchange}
          onTokensChange={onTokensChange}
          onNativeBalanceChange={onNativeBalanceChange}
          onLock={onLock}
          adapter={adapter}
          nativeSymbol={nativeSymbol}
          nativeDecimals={nativeDecimals}
          chainSpecs={chainSpecs}
          chainSpecsErr={chainSpecsErr}
          activeChainKey={activeChainKey}
          onChainSelect={onChainSelect}
          prices={prices}
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
  onAddresses,
  onAddressbook,
  onActivity,
  onTokens,
  onExchange,
  onTokensChange,
  onNativeBalanceChange,
  onLock,
  adapter,
  nativeSymbol,
  nativeDecimals,
  chainSpecs,
  chainSpecsErr,
  activeChainKey,
  onChainSelect,
  prices,
}: {
  account: AccountInfo;
  label: string;
  onShowKey: () => void;
  onSend: () => void;
  onSwap: () => void;
  onAddresses: () => void;
  onAddressbook: () => void;
  onActivity: () => void;
  onTokens: () => void;
  onExchange: () => void;
  /** 발견한 ERC-20 잔액을 상위(App)로 흘려보낸다 — 송금 화면이 재조회 없이 쓴다. */
  onTokensChange: (rows: PortableTokenBalance[] | null) => void;
  /** native 잔액을 상위로. 송금 화면의 잔액 초과 검사에 쓰인다. */
  onNativeBalanceChange: (b: bigint | null) => void;
  onLock: () => void;
  adapter: ChainAdapter;
  nativeSymbol: string;
  nativeDecimals: number;
  chainSpecs: ChainSpec[] | null;
  chainSpecsErr: string | null;
  activeChainKey: string;
  onChainSelect: (key: string) => void;
  prices: Record<string, number> | null;
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
  const [evmTokens, setEvmTokens] = useState<PortableTokenBalance[] | null>(null);
  const [showZeroTokens, setShowZeroTokens] = useState(false);
  // "토큰 추가" 모달: idle | 'open' (입력 폼) | 'adding' (RPC fetch 중)
  const [addTokenMode, setAddTokenMode] = useState<'idle' | 'open' | 'adding'>('idle');
  const [addTokenAddr, setAddTokenAddr] = useState('');
  const [addTokenErr, setAddTokenErr] = useState<string | null>(null);
  // 추가 자체는 됐지만 다음 실행까지 남지 않는 경우의 사실 고지. 에러가 아니다 —
  // 실패로 표시하면 사용자가 다시 넣게 되고, 감추면 사라지는 이유를 알 수 없다.
  const [addTokenWarn, setAddTokenWarn] = useState<string | null>(null);
  // 수동으로 추가한 토큰. **세션 안에서만 산다** — 재시작 후에도 기억하는 저장
  // 계층이 지금은 EVM 레지스트리뿐이라, 비-EVM 은 여기가 유일한 자리다.
  const [manualTokens, setManualTokens] = useState<ManualTokenMap>({});
  // 저장된 수동 추가 토큰을 복원한다. 잔액은 저장하지 않았으므로 0 으로 두고,
  // 자동 발견이 같은 토큰을 집으면 그쪽 잔액이 이긴다(withManualTokens).
  useEffect(() => {
    let cancelled = false;
    void loadManualTokens().then((stored) => {
      if (cancelled) return;
      const restored: Record<string, PortableTokenBalance[]> = {};
      for (const [chainKey, list] of Object.entries(stored)) {
        restored[chainKey] = list.map((t) => ({
          id: t.id,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
          balance: 0n,
          ...(t.source !== undefined ? { source: t.source } : {}),
        }));
      }
      setManualTokens(restored);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 토큰 추가 후 즉시 evmTokens 를 refresh — 트리거용 카운터.
  const [tokenListRev, setTokenListRev] = useState(0);

  // 체인별 입력 안내 · 수동 추가 가능 여부 · 저장 가능 여부.
  const tokenHint = manualTokenHint(activeChainKey);
  const canAddToken = supportsManualToken(adapter);

  const manualForChain = manualTokens[activeChainKey] ?? EMPTY_MANUAL_TOKENS;
  // 화면과 상위(App)가 보는 목록은 "자동 발견 + 수동 추가" 다.
  const allTokens = useMemo(
    () => withManualTokens(evmTokens, manualForChain),
    [evmTokens, manualForChain],
  );
  // 조회는 항상 전체. 여기서만 거른다 — 토글이 RPC 를 유발하지 않는다.
  // ZION 은 바로 위에서 4종 자산 패널을 이미 그리므로 같은 denom 을 이 목록에서
  // 뺀다. 패널 쪽을 없애지 않는 이유: 그쪽은 잔액 0 인 자산도 보여주는 자리다.
  const visibleTokens = (allTokens ?? []).filter(
    (row) =>
      (showZeroTokens || row.balance > 0n) &&
      !(activeChainKey === 'cosmos:zion' && ZION_ASSETS.some((a) => a.denom === row.id)),
  );

  // 조회 결과를 상위(App)로 올린다. 이 카드는 mode==='home' 에서만 마운트되므로,
  // 송금 화면이 열리는 순간 카드가 사라져 값을 잃는다 — App 이 대신 들고 있어야
  // 송금 화면이 같은 RPC 를 두 번 때리지 않는다.
  useEffect(() => {
    onTokensChange(allTokens);
  }, [allTokens, onTokensChange]);
  useEffect(() => {
    onNativeBalanceChange(balance);
  }, [balance, onNativeBalanceChange]);

  // native asset → BTC 비율. 미상장(TTL/kWR) 은 PRICE_PEG_TO_BTC 페그, 그 외는
  // Binance ticker 의 {SYM}BTC pair. BTC 자체는 1:1.
  const btcPerNative = nativeToBtcRatio(nativeSymbol, prices);
  // TTL 기준 환산. TTL 자신은 null 이라 보조 줄이 아예 그려지지 않는다.
  const nativeTtl =
    balance === null ? null : nativeToTtl(balance, nativeDecimals, nativeSymbol, prices);

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
    if (!chainAddress) {
      setEvmTokens(null);
      return;
    }
    let cancelled = false;
    setEvmTokens(null);
    // **체인을 묻지 않는다.** 어댑터가 토큰을 알면 돌려주고 모르면 빈 배열이다.
    // 예전에는 여기서 `evm:` 를 검사해 비-EVM 체인의 토큰을 아예 조회하지 않았다.
    // 그래서 Solana SPL·TRON TRC-20·Cosmos denom 은 지갑에 존재하지 않는 것이나
    // 마찬가지였다.
    //
    // discoverPortableTokens 는 실패해도 던지지 않고 빈 배열을 준다 — 토큰 목록
    // 때문에 지갑이 안 열리면 안 된다.
    void discoverPortableTokens(adapter, chainAddress).then((tokens) => {
      if (!cancelled) setEvmTokens(tokens);
    });
    return () => {
      cancelled = true;
    };
  }, [chainAddress, adapter, activeChainKey, tokenListRev]);

  // 체인이 바뀌면 추가 폼을 비운다. 다른 체인에서 남은 입력·안내가 이 체인의
  // 사실처럼 보이면 안 된다 — 식별자 형식부터 다르다.
  useEffect(() => {
    setAddTokenMode('idle');
    setAddTokenAddr('');
    setAddTokenErr(null);
    setAddTokenWarn(null);
  }, [activeChainKey]);

  /**
   * 수동 토큰 추가 — **체인을 묻지 않는다.**
   *
   * 예전에는 `adapter.chain.id` 유무로 EVM 인지 보고 아니면 "EVM 체인에서만 토큰
   * 추가 가능합니다" 로 거절했다. 9 체인이 모두 토큰을 다루는 지금 그 문구는
   * 거짓이므로 지웠다. 읽기는 `readPortableToken` 하나로 통일하고, 형식 안내만
   * 체인별 표에서 가져온다.
   *
   * `readPortableToken` 은 **던진다.** 사용자가 명시적으로 요청한 동작이라 조용히
   * 실패하면 왜 안 됐는지 알 수 없다 — 이유를 그대로 화면에 올린다.
   */
  async function handleAddCustomToken(): Promise<void> {
    const id = addTokenAddr.trim();
    if (!id || !chainAddress) return;
    if (!canAddToken) {
      // 버튼을 안 그리므로 정상 흐름에서는 도달하지 않는다. 도달하면 사실대로.
      setAddTokenErr('이 체인의 어댑터는 토큰 수동 추가를 아직 지원하지 않습니다.');
      return;
    }
    // 형식 검사는 표가 가진 체인만 한다. 없는 체인은 체인에게 물어본다 —
    // 어설픈 정규식으로 정상 토큰을 막느니 한 번 더 왕복하는 쪽이 낫다.
    if (tokenHint.pattern && !tokenHint.pattern.test(id)) {
      setAddTokenErr(tokenHint.patternError ?? '식별자 형식이 올바르지 않습니다.');
      return;
    }
    setAddTokenErr(null);
    setAddTokenWarn(null);
    setAddTokenMode('adding');
    try {
      const token = await readPortableToken(adapter, id, chainAddress);
      if (token === null) {
        // 던지지 않았는데 값이 없다 = 그 체인의 토큰이 아니거나 decimals 를 못
        // 읽었다. 자릿수를 추측해 채우면 잔액이 통째로 거짓이 되므로 등록하지 않는다.
        setAddTokenErr('이 체인의 토큰이 아니거나 자릿수를 읽지 못했습니다.');
        setAddTokenMode('open');
        return;
      }
      // 영속화 — 모든 체인 공통. chainKey 로 키를 잡는 저장소라 EVM 의 chainId
      // 개념에 묶이지 않는다. 잔액은 저장하지 않는다(체인의 현재 상태라 저장하는
      // 순간 거짓이 된다) — 식별자와 메타데이터만 남기고 잔액은 매번 다시 읽는다.
      try {
        await addManualToken(activeChainKey, {
          id: token.id,
          symbol: token.symbol,
          name: token.name,
          decimals: token.decimals,
          ...(token.source !== undefined ? { source: token.source } : {}),
        });
        // EVM 은 레지스트리에도 넣어야 자동 발견이 다음번에 이 토큰을 집는다.
        // (비-EVM 은 어댑터가 체인에서 직접 목록을 받아오므로 레지스트리가 없다.)
        const evmChainId = evmChainIdOf(adapter);
        if (evmChainId !== null) {
          await addCustomErc20(adapter as unknown as EvmAdapter, evmChainId, token.id);
        }
      } catch (e) {
        // 체인에서 읽는 데는 성공했다. 저장만 실패했으므로 목록에는 올리되
        // 다음 실행에서 사라진다는 사실을 숨기지 않는다.
        setAddTokenWarn(
          `${token.symbol} 을(를) 추가했지만 저장하지 못했습니다 — 지갑을 다시 열면 사라집니다.` +
            (e instanceof Error && e.message ? ` (${e.message})` : ''),
        );
      }
      // 세션 목록에 먼저 넣는다 — 재조회가 늦거나 못 집어도 화면에는 바로 뜬다.
      setManualTokens((cur) => mergeManualToken(cur, activeChainKey, token));
      setAddTokenAddr('');
      setAddTokenMode('idle');
      setTokenListRev((v) => v + 1); // discoverTokens 재실행
    } catch (e) {
      setAddTokenErr(
        e instanceof Error && e.message ? e.message : '토큰을 읽지 못했습니다.',
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
                {/* TTL 은 기준이라 보조 표시가 없다. 나머지 자산만 TTL 로 환산해
                    보여준다 — 이 지갑의 모든 가치는 TTL 로 읽힌다. */}
                {nativeTtl !== null && (
                  <p className="balance-hero__toggle" style={{ cursor: 'default' }}>
                    {t('tokens.value_ttl', { v: formatTtl(nativeTtl) })}
                  </p>
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
                // 이 지갑의 모든 가치는 TTL 로 읽힌다.
                const zionTtl = usdValue === null ? null : usdToTtl(usdValue, prices);
                return (
                  <li key={a.denom} className="zion-assets__row">
                    <span className="zion-assets__symbol">{a.symbol}</span>
                    <span className="zion-assets__amount">
                      {formatAmount(amount, a.decimals)}
                      {zionTtl !== null && (
                        <span className="zion-assets__usd">
                          {t('tokens.value_ttl', { v: formatTtl(zionTtl) })}
                        </span>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}

          {/* 자동 발견 토큰 + 수동 추가분. 기본은 잔액 > 0 만 보여 첫 인상이 깔끔.
              "전체 보기" 토글 시 알려진 토큰 전부 노출 — 사용자가 어떤 토큰을 watch
              가능한지 확인할 수 있다. ZION list 와 같은 스타일.

              **체인으로 막지 않는다.** 예전에는 `evm:` 로 시작하는 체인에서만
              그렸다. 어댑터가 토큰을 아는지(supportsTokens)만 묻는다 — 모르는
              체인에서는 애초에 그릴 것이 없다. */}
          {supportsTokens(adapter) && allTokens !== null && (
            <>
              {visibleTokens.length > 0 && (
                <ul className="zion-assets">
                  {visibleTokens.map((row) => {
                    // 갈림길 하나: 주소가 벼린 환율에 있으면 TTL 환산, 없으면
                    // 기존 Binance/USD 경로. 심볼은 판단에 쓰지 않는다.
                    const rate = rateByAddress(row.id);
                    const ttl = tokenAmountToTtl(row.balance, row.decimals, rate);
                    // 벼린 토큰 심볼을 달았지만 주소가 스냅샷에 없는 토큰 —
                    // 대문자화하면 스테이블 목록에 걸려 "1 달러" 로 보인다
                    // (tUSD → TUSD → TrueUSD). 값을 모르는 것이므로 비워 둔다.
                    const lookalike =
                      rate === null &&
                      /^t[A-Z]{3}$/.test(row.symbol) &&
                      rateByIso(row.symbol.slice(1)) !== null;
                    const usd =
                      rate !== null || lookalike ? null : tokenToUsd(row.symbol, prices);
                    const usdValue =
                      usd !== null && row.balance > 0n
                        ? baseUnitToNumber(row.balance, row.decimals) * usd
                        : null;
                    return (
                      <li key={row.id} className="zion-assets__row">
                        <span className="zion-assets__symbol" title={row.name}>
                          {row.symbol}
                        </span>
                        <span className="zion-assets__amount">
                          {formatAmount(row.balance, row.decimals)}
                          {ttl !== null && row.balance > 0n ? (
                            <span className="zion-assets__usd">
                              {t('tokens.value_ttl', { v: formatTtl(ttl) })}
                            </span>
                          ) : (
                            usdValue !== null &&
                            usdToTtl(usdValue, prices) !== null && (
                              <span className="zion-assets__usd">
                                {t('tokens.value_ttl', {
                                  v: formatTtl(usdToTtl(usdValue, prices)!),
                                })}
                              </span>
                            )
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
                {/* 어댑터가 수동 추가를 못 하면 버튼 자체를 안 그린다. 눌러 놓고
                    "EVM 체인에서만 가능" 같은 거짓 이유를 대지 않기 위해서다. */}
                {canAddToken && (
                  <button
                    type="button"
                    className="zion-assets__toggle"
                    onClick={() => {
                      setAddTokenMode('open');
                      setAddTokenErr(null);
                      setAddTokenWarn(null);
                    }}
                  >
                    + {t('tokens.add')}
                  </button>
                )}
              </div>
              {canAddToken && addTokenMode !== 'idle' && (
                <div className="add-token-form">
                  {/* 라벨·placeholder·예시가 전부 체인에서 온다. 식별자 형식은
                      체인마다 다르고, 틀린 안내는 없는 안내보다 나쁘다. */}
                  <label className="label" htmlFor="add-token-addr">
                    {tokenHint.label}
                  </label>
                  <input
                    id="add-token-addr"
                    type="text"
                    className="verify-row__input"
                    value={addTokenAddr}
                    onChange={(e) => setAddTokenAddr(e.target.value)}
                    placeholder={tokenHint.placeholder}
                    spellCheck={false}
                    autoCapitalize="none"
                    autoCorrect="off"
                    disabled={addTokenMode === 'adding'}
                  />
                  <p className="muted small">예: {tokenHint.example}</p>
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
                      {t('common.cancel')}
                    </button>
                  </div>
                </div>
              )}
              {/* 추가는 됐지만 남지 않는 경우. 폼을 닫은 뒤에도 보여야 한다. */}
              {addTokenWarn && <p className="warn small">{addTokenWarn}</p>}
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
        {/* 내부 거래소 — TTL 체인 전용 (EXCHANGE.md: 66종이 있는 곳에 거래소가 있다) */}
        {activeChainKey === 'evm:ttl' && (
          <button className="btn-ghost btn-sm" onClick={onExchange}>
            {t('exchange.title')}
          </button>
        )}
        {/* 활동 내역 — 비-EVM 에서도 눌러 "미지원" 안내를 볼 수 있게 막지 않는다. */}
        <button className="btn-ghost btn-sm" onClick={onActivity}>
          {t('activity.title')}
        </button>
        {/* 토큰 목록 — **체인을 가리지 않는다.** 어댑터가 토큰을 몰라도 화면에
            들어가 그 이유를 읽을 수 있어야 한다. 예전에는 이 버튼이 EVM 블록
            안에 있어 비-EVM 체인에서는 존재조차 하지 않았다. */}
        <button className="btn-ghost btn-sm" onClick={onTokens}>
          {t('tokens.title')}
        </button>
        <button className="btn-ghost btn-sm" onClick={onAddresses}>
          {t('addresses.title')}
        </button>
        <button className="btn-ghost btn-sm" onClick={onAddressbook}>
          {t('addressbook.title')}
        </button>
        <button className="btn-ghost btn-sm" onClick={onShowKey}>
          {t('accounts.show_key_button')}
        </button>
        <button className="btn-ghost btn-sm" onClick={onLock}>
          {t('common.lock')}
        </button>
      </div>

      <p className="warn small">{t('popup.session_only_warn')}</p>
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
        const c = new m.ZionAmmClient();
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

// ────────── TTL 기준 환산 ──────────
//
// **TTL 은 기준(numeraire)이다. 환산해 보여줄 대상이 아니다.**
//
// 2026-07-29 00:00 KST 의 BTC 63,412.45 로 TTL 의 절대 눈금을 한 번 정하고
// BTC 페깅을 해제했다. 그 전에는 "TTL 이 BTC 로 얼마냐" 를 매번 물었고, 그래서
// BTC 가 움직이면 TTL 표시 가치가 따라 움직였다 — 그게 페깅이다.
//
// 이제 방향이 반대다. 앵커를 고정값으로 박아두고 **"X 가 TTL 로 얼마냐" 만**
// 묻는다. BTC 시세가 움직여도 TTL 은 안 움직이고, 움직이는 것은 BTC 의 TTL
// 가격이다.
//
// 1 TTL ≡ 10/365/100 BTC = 0.02739726 BTC  →  1 BTC = 36.5 TTL (고정)
const TTL_ANCHOR_BTC = PEG_ANNUAL_BTC / PEG_DAYS_PER_YEAR / PEG_TTL_PER_DAY;

/**
 * native 자산 잔액 → TTL. 환산할 수 없으면 null (0 이 아니다 — 0 은 "가치 없음"
 * 으로 오해된다).
 *
 * TTL 자신은 환산하지 않는다. 기준을 기준으로 나누면 늘 1 이고, 화면에
 * "1 TTL ≈ 1 TTL" 을 적을 이유가 없다.
 */
function nativeToTtl(
  balance: bigint,
  decimals: number,
  symbol: string,
  prices: Record<string, number> | null,
): number | null {
  if (symbol === 'TTL') return null;
  const btcPer = nativeToBtcRatio(symbol, prices);
  if (btcPer === null || !(TTL_ANCHOR_BTC > 0)) return null;
  return nativeToBtc(balance, decimals, btcPer) / TTL_ANCHOR_BTC;
}

/**
 * USD 환산값 → TTL. 앵커가 고정이므로 TTL 자신은 재평가되지 않는다.
 *
 * 벼린 환율에 없는 자산(일반 ERC-20, ZION 4종 등)을 TTL 로 보여주기 위한 경로다.
 * 시세로 USD 를 구한 뒤 BTC 를 거쳐 앵커로 나눈다. 시세가 움직이면 그 자산의
 * TTL 가격이 움직일 뿐, TTL 의 가치는 고정이다.
 */
function usdToTtl(usd: number, prices: Record<string, number> | null): number | null {
  const btcUsd = prices?.['BTCUSDT'];
  if (btcUsd === undefined || !(btcUsd > 0) || !(TTL_ANCHOR_BTC > 0)) return null;
  return usd / btcUsd / TTL_ANCHOR_BTC;
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
// 활성 계정의 시드구문(생성은 24, 외부 복구분은 12 일 수 있다) 또는 raw private key 를 표시한다.
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

  // mnemonic 은 3 열 그리드로(단어 수에 따라 행이 늘어난다), raw key 는 한 줄(긴 hex)로.
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
              aria-label={t('create.mnemonic_grid_label', { n: NEW_MNEMONIC_WORD_COUNT })}
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
  // 배열 길이는 반드시 VERIFY_WORD_COUNT 에서 파생시킨다. 예전엔 ['','','','']
  // 처럼 리터럴로 박아 뒀는데, 검증 단어 수를 4 → 6 으로 올리자 5·6 번째 입력이
  // 상태에 저장되지 않아(map 이 기존 4 칸만 순회) 항상 빈 값으로 비교됐다.
  // 정답을 넣어도 "단어가 일치하지 않습니다" 가 뜨는, 지갑 생성 자체가 막히는 버그.
  const [verifyInputs, setVerifyInputs] = useState<string[]>(() =>
    Array<string>(VERIFY_WORD_COUNT).fill(''),
  );
  const [mismatch, setMismatch] = useState<boolean[]>(() =>
    Array<boolean>(VERIFY_WORD_COUNT).fill(false),
  );
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
    const m = createMnemonic(NEW_MNEMONIC_STRENGTH, wordlist).normalize('NFC');
    setMnemonic(m);
    setVerifyIndices(pickIndices(VERIFY_WORD_COUNT, NEW_MNEMONIC_WORD_COUNT));
    setVerifyInputs(Array<string>(VERIFY_WORD_COUNT).fill(''));
    setMismatch(Array<boolean>(VERIFY_WORD_COUNT).fill(false));
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
        <p className="create-step__lead">{t('create.language.lead', { n: NEW_MNEMONIC_WORD_COUNT })}</p>
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
        <p className="create-step__lead">{t('create.lead', { n: NEW_MNEMONIC_WORD_COUNT })}</p>
        <p className="warn small" style={{ margin: 0 }}>
          {t('create.warn')}
        </p>
        <ul
          className="popup-mnemonic-grid"
          aria-label={t('create.mnemonic_grid_label', { n: NEW_MNEMONIC_WORD_COUNT })}
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
          <span>{t('create.checkbox_safe', { n: NEW_MNEMONIC_WORD_COUNT })}</span>
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
              value={verifyInputs[row] ?? ''}
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
        disabled={
          busy ||
          verifyIndices.length === 0 ||
          verifyIndices.some((_, row) => (verifyInputs[row] ?? '').trim() === '')
        }
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

// 전체 단어 중 일부를 비복원 추출. 정렬해서 사용자가 위→아래 순서로 자연스럽게 입력하도록 한다.
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

// ────────── HW(Ledger) 패널 ──────────
function HwConnectPanel({
  hw,
  busy,
  onConnect,
  onDisconnect,
}: {
  hw: HwAccountState | null;
  busy: boolean;
  onConnect: (appName: HwAppName) => void;
  onDisconnect: () => void;
}) {
  const t = useT();
  if (hw) {
    return (
      <div className="hw-panel">
        <p className="label">
          {t('hw.label.title')} · {hw.appName.toUpperCase()}
        </p>
        <p className="addr" title={hw.address}>{shortenAddress(hw.address)}</p>
        <p className="muted small">
          {t('hw.label.derivation_path', { path: hw.derivationPath })}
        </p>
        <button
          className="btn-ghost btn-sm"
          onClick={onDisconnect}
          disabled={busy}
        >
          {t('hw.disconnect')}
        </button>
      </div>
    );
  }
  return (
    <div className="hw-panel">
      <button
        className="btn-ghost"
        onClick={() => onConnect('solana')}
        disabled={busy}
        title={t('hw.connect.title_hint')}
      >
        {busy ? t('hw.connecting') : t('hw.connect.solana')}
      </button>
      <button
        className="btn-ghost"
        onClick={() => onConnect('cosmos')}
        disabled={busy}
      >
        {busy ? t('hw.connecting') : t('hw.connect.cosmos')}
      </button>
      <p className="muted small">{t('hw.evm_v05_note')}</p>
    </div>
  );
}

// ────────── 연결된 사이트 + 활성 grants ──────────
function ConnectedSites({ methodLabel }: { methodLabel: (m: GrantMethod) => string }) {
  const t = useT();
  const [origins, setOrigins] = useState<Origin[] | null>(null);

  const refresh = useCallback(() => {
    listApprovedOrigins().then(setOrigins);
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ): void => {
      if (area === 'local' && 'nd:approved-origins' in changes) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  async function handleRevoke(origin: Origin): Promise<void> {
    await revokeAllForOrigin(origin);
    await revokeOrigin(origin);
    refresh();
  }

  return (
    <>
      <section className="card">
        <h3 className="section-title">{t('popup.connected_sites.title')}</h3>
        {origins === null ? (
          <p className="muted small">{t('common.loading_ellipsis')}</p>
        ) : origins.length === 0 ? (
          <p className="empty-state">{t('popup.connected_sites.empty')}</p>
        ) : (
          <ul className="origin-list">
            {origins.map((o) => (
              <li key={o} className="origin-row">
                <span className="origin-text" title={o}>{o}</span>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    void handleRevoke(o);
                  }}
                >
                  {t('popup.connected_sites.revoke')}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ActiveGrants methodLabel={methodLabel} />
    </>
  );
}

function ActiveGrants({ methodLabel }: { methodLabel: (m: GrantMethod) => string }) {
  const t = useT();
  const [grants, setGrants] = useState<GrantRecord[] | null>(null);

  const refresh = useCallback(() => {
    listActiveGrants().then(setGrants);
  }, []);

  useEffect(() => {
    refresh();
    const onChanged = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ): void => {
      if (area === 'session' && 'nd:method-grants' in changes) refresh();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  async function handleRevoke(
    origin: string,
    method: GrantMethod,
    address: string,
  ): Promise<void> {
    await revokeGrant(origin, method, address);
    refresh();
  }

  return (
    <section className="card">
      <h3 className="section-title">{t('popup.grants.title')}</h3>
      {grants === null ? (
        <p className="muted small">{t('common.loading_ellipsis')}</p>
      ) : grants.length === 0 ? (
        <p className="empty-state">{t('popup.grants.empty')}</p>
      ) : (
        <ul className="origin-list">
          {grants.map((g) => {
            const remainMin = Math.max(
              0,
              Math.ceil((g.expiresAt - Date.now()) / 60_000),
            );
            return (
              <li
                key={`${g.origin}::${g.method}::${g.address}`}
                className="origin-row"
              >
                <div className="grant-info">
                  <span className="origin-text" title={g.origin}>{g.origin}</span>
                  <span className="muted small">
                    {methodLabel(g.method)} · {t('common.minutes_left', { n: remainMin })}
                  </span>
                </div>
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => {
                    void handleRevoke(g.origin, g.method, g.address);
                  }}
                >
                  {t('popup.grants.revoke')}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
