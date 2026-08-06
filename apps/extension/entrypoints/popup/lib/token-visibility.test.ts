// token-visibility.test.ts — 가리기 상태 · 검색 · 정렬의 순수 로직 검증.
//
// 렌더링은 테스트하지 않는다(확장 vitest 는 environment: node, jsdom 없음).
// 대신 화면이 위임한 판단 — 무엇이 보이고, 어떤 순서이고, 무엇이 저장되는지 —
// 를 전부 여기서 고정한다.
//
// 입력은 체인 무관 `PortableTokenBalance` 다. EVM 주소만 넣고 테스트하면 "EVM
// 전용" 이라는 낡은 전제가 다시 굳으므로, 비-EVM 식별자(Solana base58 mint,
// Cosmos denom)로도 같은 규칙이 도는지 함께 고정한다.

import { describe, expect, it } from 'vitest';
import { rateByIso, unresolvedRates } from '@byeorin/wallet-sdk/evm';
import {
  EMPTY_HIDDEN,
  HIDDEN_TOKENS_KEY,
  buildTokenRows,
  defaultMetaResolver,
  formatBigNumber,
  formatPerTtl,
  formatTtl,
  hiddenAddresses,
  isHidden,
  loadHidden,
  matchesQuery,
  parseHidden,
  saveHidden,
  selectTokenView,
  serializeHidden,
  sortTokenRows,
  withHidden,
  type HiddenMap,
  type HiddenTokensBackend,
  type BuildTokenRowsOptions,
  type MetaResolver,
  type PortableTokenBalance,
  type TokenMeta,
} from './token-visibility.js';

const CHAIN = 'evm:ttl';

// 주소는 체크섬 표기(대문자 섞임)로 둔다 — 소문자 정규화가 실제로 도는지 보려고.
function token(
  symbol: string,
  id: string,
  balance: bigint,
  decimals = 18,
  source?: string,
): PortableTokenBalance {
  return {
    id,
    symbol,
    name: `${symbol} stable`,
    decimals,
    balance,
    ...(source === undefined ? {} : { source }),
  };
}

const A_KRW = '0xAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaaAAaa0001';
const A_USD = '0xBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbbBBbb0002';
const A_TWD = '0xCCccCCccCCccCCccCCccCCccCCccCCccCCcc0003';

// 스냅샷 실제 주소에 묶이지 않도록 메타를 주입한다. 기본 리졸버는 별도 테스트.
const META: Record<string, TokenMeta> = {
  tKRW: {
    rate: {
      symbol: 'tKRW',
      iso: 'KRW',
      address: A_KRW,
      decimals: 18,
      country: 'Korea, Rep.',
      iso3: 'KOR',
      perTtl: 150_000,
      inputs: {
        gdpLocal: 2_400_000_000_000_000,
        gdpYear: '2024',
        population: 51_000_000,
        populationYear: '2024',
      },
    },
    iso: 'KRW',
    country: 'Korea, Rep.',
    unresolvedReason: null,
  },
  tUSD: {
    rate: {
      symbol: 'tUSD',
      iso: 'USD',
      address: A_USD,
      decimals: 18,
      country: 'United States',
      iso3: 'USA',
      perTtl: 230,
      inputs: {
        gdpLocal: 28_000_000_000_000,
        gdpYear: '2024',
        population: 334_000_000,
        populationYear: '2024',
      },
    },
    iso: 'USD',
    country: 'United States',
    unresolvedReason: null,
  },
  // 환율 없음 — 실제 대만 tTWD 가 이 상태다.
  tTWD: {
    rate: null,
    iso: 'TWD',
    country: 'Taiwan',
    unresolvedReason: 'World Bank 에 해당 국가 없음',
  },
};

const resolve: MetaResolver = (_id, symbol) =>
  META[symbol] ?? { rate: null, iso: null, country: null, unresolvedReason: null };

/**
 * 이 테스트의 공통 옵션.
 *
 * 시세 표는 **null 을 명시**한다 — 이 파일이 검증하는 것은 가리기·검색·정렬
 * 규칙이지 시세가 아니고, 시세를 넣으면 Binance 표에 따라 테스트가 흔들린다.
 * 옵셔널이 아니라서 빠뜨릴 수 없다(v0.5.22 실사고를 타입으로 막은 자리다).
 */
const OPTS: BuildTokenRowsOptions = { prices: null, resolveMeta: resolve };

const TOKENS: PortableTokenBalance[] = [
  token('tUSD', A_USD, 0n),
  token('tKRW', A_KRW, 3_000_000_000_000_000_000_000_000n), // 3,000,000 tKRW
  token('tTWD', A_TWD, 5_000_000_000_000_000_000n), // 5 tTWD, 환율 없음
];

// ────────── 저장 형태 ──────────

describe('parseHidden', () => {
  it('빈 값/깨진 값은 빈 맵 — 목록 화면을 막지 않는다', () => {
    expect(parseHidden(null)).toEqual({});
    expect(parseHidden('')).toEqual({});
    expect(parseHidden('{ not json')).toEqual({});
    expect(parseHidden('[1,2,3]')).toEqual({});
    expect(parseHidden('"str"')).toEqual({});
  });

  it('주소를 소문자로 정규화하고 중복을 접는다', () => {
    const map = parseHidden(
      JSON.stringify({ [CHAIN]: [A_KRW, A_KRW.toLowerCase(), A_USD] }),
    );
    expect(map[CHAIN]).toEqual([A_KRW.toLowerCase(), A_USD.toLowerCase()]);
  });

  it('배열이 아닌 값·문자열 아닌 원소는 버린다', () => {
    const map = parseHidden(
      JSON.stringify({ [CHAIN]: [A_KRW, 42, null], 'evm:bad': 'nope' }),
    );
    expect(map[CHAIN]).toEqual([A_KRW.toLowerCase()]);
    expect(map['evm:bad']).toBeUndefined();
  });
});

describe('serializeHidden', () => {
  it('빈 체인 항목은 저장하지 않는다', () => {
    expect(serializeHidden({ [CHAIN]: [], 'evm:eth': ['0xaa'] })).toBe(
      JSON.stringify({ 'evm:eth': ['0xaa'] }),
    );
  });

  it('parse ∘ serialize 왕복이 값을 보존한다', () => {
    const map: HiddenMap = { [CHAIN]: [A_KRW.toLowerCase()] };
    expect(parseHidden(serializeHidden(map))).toEqual(map);
  });
});

describe('withHidden / isHidden', () => {
  it('대소문자가 달라도 같은 토큰으로 본다', () => {
    const map = withHidden(EMPTY_HIDDEN, CHAIN, A_KRW, true);
    expect(isHidden(map, CHAIN, A_KRW.toLowerCase())).toBe(true);
    expect(isHidden(map, CHAIN, A_KRW.toUpperCase())).toBe(true);
  });

  it('가리기는 idempotent — 두 번 눌러도 목록이 늘지 않는다', () => {
    const once = withHidden(EMPTY_HIDDEN, CHAIN, A_KRW, true);
    const twice = withHidden(once, CHAIN, A_KRW, true);
    expect(hiddenAddresses(twice, CHAIN)).toHaveLength(1);
    expect(twice).toBe(once); // 변화 없으면 참조까지 유지
  });

  it('되돌리면 항목이 사라진다 — 되돌릴 수 없는 상태를 만들지 않는다', () => {
    const hiddenMap = withHidden(EMPTY_HIDDEN, CHAIN, A_KRW, true);
    const restored = withHidden(hiddenMap, CHAIN, A_KRW, false);
    expect(isHidden(restored, CHAIN, A_KRW)).toBe(false);
    expect(restored[CHAIN]).toBeUndefined();
  });

  it('원본 맵을 변형하지 않는다', () => {
    const before: HiddenMap = { [CHAIN]: [A_USD.toLowerCase()] };
    withHidden(before, CHAIN, A_KRW, true);
    expect(before[CHAIN]).toEqual([A_USD.toLowerCase()]);
  });

  it('체인이 다르면 서로 영향을 주지 않는다', () => {
    const map = withHidden(EMPTY_HIDDEN, CHAIN, A_KRW, true);
    expect(isHidden(map, 'evm:eth', A_KRW)).toBe(false);
  });
});

describe('deny-list 규칙', () => {
  it('저장에 없는 새 토큰은 자동으로 보인다 — allowlist 였다면 영영 안 보인다', () => {
    const map = withHidden(EMPTY_HIDDEN, CHAIN, A_USD, true);
    // 나중에 발행돼 처음 감지된 토큰
    const rows = buildTokenRows(
      [...TOKENS, token('tJPY', '0xDDdd000000000000000000000000000000000004', 0n)],
      map,
      CHAIN,
      OPTS,
    );
    const jpy = rows.find((r) => r.symbol === 'tJPY');
    expect(jpy?.hidden).toBe(false);
  });
});

// ────────── 영속화 (메모리 백엔드) ──────────

function memoryBackend(initial: Record<string, string> = {}): HiddenTokensBackend {
  const store: Record<string, string> = { ...initial };
  return {
    async read(key) {
      return store[key] ?? null;
    },
    async write(key, value) {
      store[key] = value;
    },
    async delete(key) {
      delete store[key];
    },
  };
}

function throwingBackend(): HiddenTokensBackend {
  return {
    async read() {
      throw new Error('chrome.storage.local is unavailable in this runtime');
    },
    async write() {
      throw new Error('chrome.storage.local is unavailable in this runtime');
    },
    async delete() {
      throw new Error('chrome.storage.local is unavailable in this runtime');
    },
  };
}

describe('loadHidden / saveHidden', () => {
  it('쓴 값을 그대로 다시 읽는다', async () => {
    const backend = memoryBackend();
    const map = withHidden(EMPTY_HIDDEN, CHAIN, A_KRW, true);
    expect(await saveHidden(backend, map)).toBe(true);
    expect(await loadHidden(backend)).toEqual(map);
    expect(await backend.read(HIDDEN_TOKENS_KEY)).toBe(serializeHidden(map));
  });

  it('스토리지가 없어도 throw 하지 않는다 — 화면은 메모리로 계속 돈다', async () => {
    const backend = throwingBackend();
    expect(await loadHidden(backend)).toEqual({});
    expect(await saveHidden(backend, { [CHAIN]: ['0xaa'] })).toBe(false);
  });
});

// ────────── 행 구성 ──────────

describe('buildTokenRows', () => {
  const rows = buildTokenRows(TOKENS, EMPTY_HIDDEN, CHAIN, OPTS);

  // 값은 **스냅샷에서만** 온다. 가짜 meta(resolve)로는 값을 만들 수 없다 —
  // 화면 표시용 국가·ISO 와 값 산식이 서로 다른 출처를 보기 때문이다. 그래서
  // 아래 두 테스트는 스냅샷의 실제 주소를 쓰고, 기대값도 스냅샷의 perTtl 에서
  // 계산한다. 환율 숫자를 테스트에 적으면 재앵커되는 순간 테스트가 거짓이 된다.
  const KRW = rateByIso('KRW');
  const USD = rateByIso('USD');

  it('환율이 있으면 TTL 환산값을 낸다 — 기대값도 스냅샷에서 계산한다', () => {
    if (KRW === null) return; // 스냅샷에 없으면 이 주장 자체가 성립하지 않는다
    const amount = 3_000_000n * 10n ** BigInt(KRW.decimals);
    const [row] = buildTokenRows(
      [token('tKRW', KRW.address, amount, KRW.decimals)],
      EMPTY_HIDDEN,
      CHAIN,
      { prices: null },
    );
    expect(row!.ttl).toBeCloseTo(3_000_000 / KRW.perTtl, 6);
  });

  it('스냅샷 값이 바뀌면 결과가 따라 바뀐다 — 상수로 박혀 있지 않다', () => {
    if (KRW === null || USD === null) return;
    const one = 10n ** BigInt(KRW.decimals);
    const [k] = buildTokenRows([token('tKRW', KRW.address, one, KRW.decimals)],
      EMPTY_HIDDEN, CHAIN, { prices: null });
    const [u] = buildTokenRows([token('tUSD', USD.address, 10n ** BigInt(USD.decimals), USD.decimals)],
      EMPTY_HIDDEN, CHAIN, { prices: null });
    // 두 값의 비는 두 perTtl 의 역비다. 어느 쪽도 코드에 적혀 있지 않다.
    expect(k!.ttl! / u!.ttl!).toBeCloseTo(USD.perTtl / KRW.perTtl, 6);
  });

  it('환율이 없으면 ttl 은 null — 0 이나 추정치로 채우지 않는다', () => {
    const twd = rows.find((r) => r.symbol === 'tTWD')!;
    expect(twd.meta.rate).toBeNull();
    expect(twd.ttl).toBeNull();
    expect(twd.meta.country).toBe('Taiwan');
    expect(twd.meta.unresolvedReason).toBeTruthy();
  });

  it('잔액 0 도 ttl 은 0 (환율이 있으면) — null 과 구분된다', () => {
    if (USD === null) return;
    const [row] = buildTokenRows(
      [token('tUSD', USD.address, 0n, USD.decimals)],
      EMPTY_HIDDEN,
      CHAIN,
      { prices: null },
    );
    expect(row!.ttl).toBe(0);
  });

  it('key 는 소문자 식별자 — id 는 원본 표기 그대로 남는다', () => {
    expect(rows.every((r) => r.key === r.id.toLowerCase())).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([A_KRW]));
  });

  it('source 를 그대로 물려준다 — 없으면 null (체인에서 직접 읽음)', () => {
    const withSource = buildTokenRows(
      [
        token('tKRW', A_KRW, 1n, 18, 'ttlscan'),
        token('tUSD', A_USD, 1n), // 출처 표기 없음
      ],
      EMPTY_HIDDEN,
      CHAIN,
      OPTS,
    );
    expect(withSource.find((r) => r.symbol === 'tKRW')?.source).toBe('ttlscan');
    expect(withSource.find((r) => r.symbol === 'tUSD')?.source).toBeNull();
  });
});

// ────────── 체인 무관 식별자 ──────────
//
// 이 블록이 "토큰 = EVM" 이라는 전제가 되돌아오는 것을 막는다. 규칙(가리기 ·
// 검색 · 정렬 · 가치 빈자리)이 EVM 주소가 아닌 식별자에서도 똑같이 돌아야 한다.

describe('비-EVM 식별자', () => {
  const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'; // Solana SPL mint
  const DENOM = 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2';

  const rows = buildTokenRows(
    [token('USDC', MINT, 1_000_000n, 6, 'solana-rpc'), token('ATOM', DENOM, 5n, 6)],
    EMPTY_HIDDEN,
    'solana:mainnet',
    // 시세 표를 **명시적으로** null 로 넘긴다. 옵셔널이었다면 배선을 빠뜨려도
    // 타입이 통과하고 화면만 비었을 것이다(v0.5.22 실사고).
    { prices: null },
  );

  it('환율이 없으므로 가치 자리를 비운다 — 0 이나 추정치로 채우지 않는다', () => {
    expect(rows.every((r) => r.ttl === null)).toBe(true);
    expect(rows.every((r) => r.meta.rate === null)).toBe(true);
  });

  it('가리기가 대소문자 구분 없이 왕복한다 (base58 식별자 포함)', () => {
    const map = withHidden(EMPTY_HIDDEN, 'solana:mainnet', MINT, true);
    expect(isHidden(map, 'solana:mainnet', MINT)).toBe(true);
    const back = withHidden(map, 'solana:mainnet', MINT, false);
    expect(isHidden(back, 'solana:mainnet', MINT)).toBe(false);
  });

  it('검색은 심볼과 식별자 조각으로 걸린다', () => {
    const usdc = rows.find((r) => r.symbol === 'USDC')!;
    expect(matchesQuery(usdc, 'usdc')).toBe(true);
    expect(matchesQuery(usdc, MINT.slice(0, 8).toLowerCase())).toBe(true);
    expect(matchesQuery(usdc, 'zzz')).toBe(false);
  });

  it('기본 리졸버는 EVM 주소 형식이 아닌 식별자를 추측하지 않는다', () => {
    // 심볼이 우연히 통화토큰과 같아도(다른 체인의 동명 토큰) 그 나라 통화로
    // 둔갑시키면 안 된다.
    const first = unresolvedRates()[0];
    const symbol = first ? first.symbol : 'tKRW';
    expect(defaultMetaResolver(MINT, symbol)).toEqual({
      rate: null,
      iso: null,
      country: null,
      unresolvedReason: null,
    });
  });
});

describe('defaultMetaResolver', () => {
  it('스냅샷에 없는 주소/심볼이면 전부 null — 추측하지 않는다', () => {
    const meta = defaultMetaResolver(
      '0x0000000000000000000000000000000000000000',
      'NOPE',
    );
    expect(meta).toEqual({
      rate: null,
      iso: null,
      country: null,
      unresolvedReason: null,
    });
  });

  // 어느 통화가 미해결인지는 데이터 사정에 따라 변한다 — 대만은 World Bank 에
  // 없어 미해결이었다가 IMF 폴백으로 채워졌다. 특정 통화를 못 박는 대신
  // "미해결이면 환율 없이 사유가 나온다" 는 불변식을 검사한다.
  it('미해결 통화는 환율 없이 국가/사유만 나온다', () => {
    const first = unresolvedRates()[0];
    if (!first) {
      // 미해결이 하나도 없는 것은 정상 상태다. 그때는 검사할 대상이 없다.
      expect(unresolvedRates().length).toBe(0);
      return;
    }
    // unresolved 목록은 주소가 없으므로 심볼로 걸린다.
    const meta = defaultMetaResolver(
      '0x0000000000000000000000000000000000000000',
      first.symbol,
    );
    expect(meta.rate).toBeNull();
    expect(meta.country).toBe(first.country);
    expect(meta.unresolvedReason).toBeTruthy();
  });
});

// ────────── 검색 ──────────

describe('matchesQuery', () => {
  const rows = buildTokenRows(TOKENS, EMPTY_HIDDEN, CHAIN, OPTS);
  const krw = rows.find((r) => r.symbol === 'tKRW')!;
  const twd = rows.find((r) => r.symbol === 'tTWD')!;

  it('빈 검색어는 전부 통과', () => {
    expect(matchesQuery(krw, '')).toBe(true);
    expect(matchesQuery(krw, '   ')).toBe(true);
  });

  it('심볼 · ISO · 국가명 · iso3 로 걸린다', () => {
    expect(matchesQuery(krw, 'tkrw')).toBe(true);
    expect(matchesQuery(krw, 'KRW')).toBe(true);
    expect(matchesQuery(krw, 'korea')).toBe(true);
    expect(matchesQuery(krw, 'KOR')).toBe(true);
  });

  it('주소 조각으로도 걸린다', () => {
    expect(matchesQuery(krw, A_KRW.slice(0, 10))).toBe(true);
  });

  it('환율이 없어도 국가명으로 찾을 수 있다', () => {
    expect(matchesQuery(twd, 'taiwan')).toBe(true);
  });

  it('여러 단어는 모두 만족해야 한다(AND)', () => {
    expect(matchesQuery(krw, 'krw korea')).toBe(true);
    expect(matchesQuery(krw, 'krw taiwan')).toBe(false);
  });

  it('무관한 검색어는 걸리지 않는다', () => {
    expect(matchesQuery(krw, 'zzz')).toBe(false);
  });
});

// ────────── 정렬 ──────────

describe('sortTokenRows', () => {
  it('보유(잔액>0) 우선 → 심볼순', () => {
    const rows = buildTokenRows(
      [
        token('tZAR', '0x0000000000000000000000000000000000000009', 0n),
        token('tUSD', A_USD, 0n),
        token('tKRW', A_KRW, 1n),
        token('tTWD', A_TWD, 1n),
      ],
      EMPTY_HIDDEN,
      CHAIN,
      OPTS,
    );
    expect(sortTokenRows(rows).map((r) => r.symbol)).toEqual([
      'tKRW',
      'tTWD',
      'tUSD',
      'tZAR',
    ]);
  });

  it('원본 배열을 변형하지 않는다', () => {
    const rows = buildTokenRows(TOKENS, EMPTY_HIDDEN, CHAIN, OPTS);
    const before = rows.map((r) => r.symbol);
    sortTokenRows(rows);
    expect(rows.map((r) => r.symbol)).toEqual(before);
  });
});

// ────────── 뷰 조합 ──────────

describe('selectTokenView', () => {
  const hidden = withHidden(EMPTY_HIDDEN, CHAIN, A_USD, true);
  const rows = buildTokenRows(TOKENS, hidden, CHAIN, OPTS);

  it('기본 목록에서 가린 토큰이 빠진다', () => {
    const view = selectTokenView(rows, { query: '', showHidden: false });
    expect(view.rows.map((r) => r.symbol)).toEqual(['tKRW', 'tTWD']);
    expect(view.hiddenCount).toBe(1);
    expect(view.visibleCount).toBe(2);
  });

  it('가린 항목 보기로 확인·복구 대상을 찾을 수 있다', () => {
    const view = selectTokenView(rows, { query: '', showHidden: true });
    expect(view.rows.map((r) => r.symbol)).toEqual(['tUSD']);
  });

  it('검색어는 현재 탭 안에서만 적용된다', () => {
    const view = selectTokenView(rows, { query: 'usd', showHidden: false });
    expect(view.rows).toHaveLength(0);
    // 검색 결과는 비어도 "보이는 항목이 없다" 는 뜻이 아니다 — 화면이 둘을 구분한다.
    expect(view.visibleCount).toBe(2);
  });

  it('개수는 검색어의 영향을 받지 않는다', () => {
    const view = selectTokenView(rows, { query: 'zzzz', showHidden: false });
    expect(view.hiddenCount).toBe(1);
    expect(view.visibleCount).toBe(2);
  });
});

// ────────── 포맷 ──────────

describe('formatTtl', () => {
  it('1 이상은 소수 2 자리 + 천 단위 쉼표', () => {
    expect(formatTtl(1234.5)).toBe('1,234.50');
  });

  it('1 미만은 소수 4 자리 — 유효숫자를 잃지 않는다', () => {
    expect(formatTtl(0.1234)).toBe('0.1234');
  });

  it('0 은 그냥 0', () => {
    expect(formatTtl(0)).toBe('0');
  });

  it('표시 한계보다 작은 양수는 0 으로 뭉개지 않는다', () => {
    expect(formatTtl(0.00001)).toBe('<0.0001');
  });
});

describe('formatBigNumber / formatPerTtl', () => {
  it('큰 수는 지수 표기 없이 쉼표로 끊는다', () => {
    expect(formatBigNumber(2_400_000_000_000_000)).toBe('2,400,000,000,000,000');
  });

  it('perTtl 은 크기에 따라 자릿수를 바꾼다', () => {
    expect(formatPerTtl(150_000)).toBe('150,000.00');
    expect(formatPerTtl(230)).toBe('230.0000');
    expect(formatPerTtl(0.0123456789)).toBe('0.012346');
  });

  it('환율이 0/음수면 대시', () => {
    expect(formatPerTtl(0)).toBe('—');
    expect(formatPerTtl(Number.NaN)).toBe('—');
  });
});
