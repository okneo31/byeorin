// assetValueInTtl — "이 잔액은 몇 TTL 인가" 의 단일 답.
//
// 이 파일은 **진짜 스냅샷**으로 돈다. 그래서 여기에는 기대값 숫자를 적지
// 않는다 — 적으면 재앵커 때 이 파일이 거짓이 된다. 대신 관계를 검사한다:
// 같은 액면은 같은 값이 나오는가, TTL 에 시세가 곱해지지 않는가, 값을 못 내면
// 사유가 붙는가.
//
// 손계산 대조와 "스냅샷을 바꾸면 결과가 따라 바뀐다" 는 가짜 앵커를 주입하는
// asset-value-snapshot.test.ts · asset-value-no-usd.test.ts 가 맡는다.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assetValueInTtl, sumTtl, type AssetValue } from '../src/rates/value.js';
import { symbolUnitUsd } from '../src/rates/market.js';
import { rateByIso, RATE_SNAPSHOT } from '../src/rates/index.js';

/** 이더리움 메인넷 내장 목록. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // 액면 USD, decimals 6
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'; // 액면 없음 → 시세 경로
const UNKNOWN = '0x00000000000000000000000000000000deadbeef'; // 내장에 없다

const ONE = 10n ** 18n;

describe('TTL 자신 — 어떤 시세도 곱해지지 않는다', () => {
  // 이것이 옛 페그(TTL = 10/365 BTC)와의 경계선이다. 방향이 뒤집히면 여기서
  // 먼저 깨진다.
  const prices = { BTCUSDT: '60000', ETHUSDT: '3000', TTLUSDT: '999999', WTTLUSDT: '888888' };

  it('시세표를 무엇으로 주든 값이 같다', () => {
    const bal = 1234n * ONE;
    const withPrices = assetValueInTtl({ kind: 'ttl', balance: bal }, { prices });
    const without = assetValueInTtl({ kind: 'ttl', balance: bal }, { prices: null });
    const absurd = assetValueInTtl({ kind: 'ttl', balance: bal }, { prices: { TTLUSDT: '1e12' } });

    expect(withPrices.ttl).toBe(1234);
    expect(without.ttl).toBe(1234);
    expect(absurd.ttl).toBe(1234);
  });

  it("basis 는 self, volatile 은 false — 환산이 아니라 자기 자신이다", () => {
    const v = assetValueInTtl({ kind: 'ttl', balance: ONE }, { prices });
    expect(v.basis).toBe('self');
    expect(v.volatile).toBe(false);
    expect(v.faceRate).toBeNull();
    expect(v.market).toBeUndefined();
  });

  it('symbolUnitUsd 는 TTL·WTTL 에 무조건 null — 두 번째 자물쇠', () => {
    expect(symbolUnitUsd('TTL', prices)).toBeNull();
    expect(symbolUnitUsd('ttl', prices)).toBeNull();
    expect(symbolUnitUsd('WTTL', prices)).toBeNull();
    expect(symbolUnitUsd('wttl', prices)).toBeNull();
    // 다른 심볼은 정상 조회된다 — 위 null 이 "표가 비어서" 가 아님을 못박는다.
    expect(symbolUnitUsd('BTC', prices)?.usd).toBe(60000);
  });

  it('bad decimals 면 TTL 도 비운다 — 틀린 배율로 찍느니 빈칸', () => {
    const v = assetValueInTtl({ kind: 'ttl', balance: ONE, decimals: 99 }, { prices: null });
    expect(v.ttl).toBeNull();
    expect(v.reason).toBe('bad-decimals');
  });
});

describe('상장자산 — 시세 → 벼린 USD 환율 → TTL', () => {
  it('같은 USD 값이면 어느 심볼이든 같은 TTL 이 된다', () => {
    // 1 BTC @ 60000 과 20 ETH @ 3000 은 둘 다 60000 USD 다.
    const prices = { BTCUSDT: '60000', ETHUSDT: '3000' };
    const btc = assetValueInTtl({ kind: 'coin', symbol: 'BTC', balance: 10n ** 8n, decimals: 8 }, { prices });
    const eth = assetValueInTtl({ kind: 'coin', symbol: 'ETH', balance: 20n * ONE, decimals: 18 }, { prices });
    expect(btc.ttl).toBeCloseTo(eth.ttl!, 8);
  });

  it('시세는 TTL 값에 비례한다 — 시세 2 배면 TTL 2 배', () => {
    const a = assetValueInTtl(
      { kind: 'coin', symbol: 'ETH', balance: ONE, decimals: 18 },
      { prices: { ETHUSDT: '3000' } },
    );
    const b = assetValueInTtl(
      { kind: 'coin', symbol: 'ETH', balance: ONE, decimals: 18 },
      { prices: { ETHUSDT: '6000' } },
    );
    expect(b.ttl! / a.ttl!).toBeCloseTo(2, 12);
  });

  it('volatile:true 로 표시된다 — 화면이 고정 액면과 구분할 수 있어야 한다', () => {
    const v = assetValueInTtl(
      { kind: 'coin', symbol: 'SOL', balance: 10n ** 9n, decimals: 9 },
      { prices: { SOLUSDT: '150' } },
    );
    expect(v.basis).toBe('market');
    expect(v.volatile).toBe(true);
    expect(v.market?.via).toBe('direct');
    // 근거 패널이 "150 USD × usdPerTtl" 를 그릴 수 있다.
    expect(v.market!.usdPerTtl).toBeCloseTo(1 / rateByIso('USD')!.perTtl, 18);
  });

  it('USDT 페어가 없으면 BTC 우회', () => {
    const v = assetValueInTtl(
      { kind: 'coin', symbol: 'XYZ', balance: ONE, decimals: 18 },
      { prices: { XYZBTC: '0.5', BTCUSDT: '60000' } },
    );
    expect(v.market?.via).toBe('btc-bridge');
    expect(v.market?.unitUsd).toBe(30000);
  });

  it('시세표가 없으면 unlisted — 0 이 아니다', () => {
    const v = assetValueInTtl(
      { kind: 'coin', symbol: 'BTC', balance: 10n ** 8n, decimals: 8 },
      { prices: null },
    );
    expect(v.ttl).toBeNull();
    expect(v.reason).toBe('unlisted');
  });
});

describe('토큰 — 주소로 신원이 확인된 것에만 값을 매긴다', () => {
  it('신원 미확인이면 시세가 있어도 unverified', () => {
    // 심볼이 USDT 여도, 시세표에 USDT 가 있어도 값을 얻지 못한다.
    // 이 한 줄이 v0.5.20 에서 막은 가짜 토큰 구멍이다.
    const v = assetValueInTtl(
      { kind: 'token', id: UNKNOWN, family: 'evm', chainId: 1, symbol: 'USDT', balance: 100n * ONE, decimals: 18 },
      { prices: { USDTUSDT: '1', BTCUSDT: '60000' } },
    );
    expect(v.ttl).toBeNull();
    expect(v.reason).toBe('unverified');
    expect(v.identity.kind).toBeNull();
  });

  it('액면 스테이블은 시세표 없이도 값이 나오고 volatile 이 아니다', () => {
    const v = assetValueInTtl(
      { kind: 'token', id: USDC, family: 'evm', chainId: 1, symbol: 'USDC', balance: 100_000000n, decimals: 6 },
      { prices: null },
    );
    expect(v.basis).toBe('face');
    expect(v.volatile).toBe(false);
    expect(v.ttl).not.toBeNull();
    expect(v.faceRate?.iso).toBe('USD');
  });

  it('액면 100 USD == 상장자산 100 USD 어치 — 두 경로가 같은 자를 쓴다', () => {
    const face = assetValueInTtl(
      { kind: 'token', id: USDC, family: 'evm', chainId: 1, symbol: 'USDC', balance: 100_000000n, decimals: 6 },
      { prices: null },
    );
    const market = assetValueInTtl(
      { kind: 'coin', symbol: 'ETH', balance: ONE, decimals: 18 },
      { prices: { ETHUSDT: '100' } },
    );
    expect(face.ttl).toBeCloseTo(market.ttl!, 10);
  });

  it('내장 목록 decimals 가 익스플로러 값을 이긴다', () => {
    // 인자로 18 을 주지만 USDC 는 6 이다. 표시 배율 조작을 막는 지점.
    const v = assetValueInTtl(
      { kind: 'token', id: USDC, family: 'evm', chainId: 1, symbol: 'USDC', balance: 100_000000n, decimals: 18 },
      { prices: null },
    );
    expect(v.decimals).toBe(6);
  });

  it('chainId 가 다르면 같은 주소라도 신원이 아니다', () => {
    const v = assetValueInTtl(
      { kind: 'token', id: USDC, family: 'evm', chainId: 999999, symbol: 'USDC', balance: 100_000000n, decimals: 6 },
      { prices: null },
    );
    expect(v.reason).toBe('unverified');
  });

  it('t{ISO} 통화토큰은 byeorin-rate 로, 시세를 묻지 않는다', () => {
    const t = RATE_SNAPSHOT.rates[0]!;
    const v = assetValueInTtl(
      { kind: 'token', id: t.address, family: 'evm', chainId: 1, symbol: t.symbol, balance: ONE, decimals: 18 },
      { prices: null },
    );
    expect(v.basis).toBe('byeorin-rate');
    expect(v.volatile).toBe(false);
    expect(v.ttl).toBeCloseTo(1 / t.perTtl, 15);
  });

  it('액면 없는 내장 토큰(WETH)은 시세 경로로 간다', () => {
    const v = assetValueInTtl(
      { kind: 'token', id: WETH, family: 'evm', chainId: 1, symbol: 'WETH', balance: ONE, decimals: 18 },
      { prices: { ETHUSDT: '3000' } },
    );
    expect(v.basis).toBe('market');
    expect(v.identity.kind).toBe('evm-builtin');
    expect(v.market?.via).toBe('unwrapped');
  });
});

describe('정밀도 — bigint 로 버티다 한 곳에서만 내려온다', () => {
  it('decimals 18 · 2^53 을 넘는 잔액에서 상위 자릿수가 뭉개지지 않는다', () => {
    const huge = 123_456_789n * ONE; // Number 로 통째 변환하면 깨지는 크기
    const t = RATE_SNAPSHOT.rates.find((r) => r.iso === 'USD')!;
    const v = assetValueInTtl(
      { kind: 'token', id: t.address, family: 'evm', chainId: 1, symbol: t.symbol, balance: huge, decimals: 18 },
      { prices: null },
    );
    const expected = 123_456_789 / t.perTtl;
    expect(Math.abs(v.ttl! / expected - 1)).toBeLessThan(1e-12);
  });
});

describe('sumTtl — 빠진 것을 숨긴 합계는 거짓이다', () => {
  const val = (ttl: number | null, volatile = false): AssetValue =>
    ({ ttl, basis: volatile ? 'market' : 'face', volatile, decimals: 18, identity: { kind: null }, faceRate: null }) as AssetValue;

  it('값 미상은 0 으로 때우지 않고 센다', () => {
    const s = sumTtl([val(1), val(null), val(2), val(null)]);
    expect(s.ttl).toBe(3);
    expect(s.missing).toBe(2);
  });

  it('시세 항목이 하나라도 섞이면 volatile', () => {
    expect(sumTtl([val(1), val(2)]).volatile).toBe(false);
    expect(sumTtl([val(1), val(2, true)]).volatile).toBe(true);
  });

  it('값 미상만 있으면 합계 0 · missing 만큼 — 화면이 이 둘을 같이 보여야 한다', () => {
    const s = sumTtl([val(null), val(null)]);
    expect(s.ttl).toBe(0);
    expect(s.missing).toBe(2);
  });
});

describe('환율 상수 박기 금지 — 소스에 환율 숫자 리터럴이 없다', () => {
  // 이 테스트가 규칙의 본체다. 문서에 적힌 금지는 문장이지만 이건 실패한다.
  // perTtl 은 scripts/build-rate-snapshot.mjs 를 다시 돌리면 66 종이 전부
  // 바뀐다. 소스에 박힌 숫자는 그 순간부터 스냅샷과 다른 값 = 두 번째 앵커다.
  const files = ['value.ts', 'market.ts', 'stable.ts', 'index.ts'];

  /** 주석을 지운다 — 설명문의 숫자까지 잡으면 규칙이 아니라 문체 검사가 된다. */
  function stripComments(src: string): string {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  }

  for (const f of files) {
    it(`rates/${f}`, () => {
      const path = fileURLToPath(new URL(`../src/rates/${f}`, import.meta.url));
      const code = stripComments(readFileSync(path, 'utf8'));
      // 소수점 3 자리 이상 = 환율값의 모양(246.647…, 0.00405436).
      expect(code.match(/\d+\.\d{3,}/g)).toBeNull();
      // 1000 이상의 정수 리터럴 = perTtl 정수부의 모양(346450…).
      // decimals(18·36)·bps 같은 작은 상수는 통과시킨다.
      expect(code.match(/(?<![\w.])\d{4,}(?![\w.])/g)).toBeNull();
    });
  }

  it('perTtl 은 함수 인자·스냅샷 조회로만 들어온다', () => {
    const path = fileURLToPath(new URL('../src/rates/value.ts', import.meta.url));
    const code = stripComments(readFileSync(path, 'utf8'));
    // perTtl 이 등장하는 모든 줄은 rate 객체에서 읽는 형태여야 한다.
    for (const line of code.split('\n')) {
      if (!line.includes('perTtl')) continue;
      expect(line).toMatch(/(?:rate|usdRate)\.perTtl/);
    }
  });
});
