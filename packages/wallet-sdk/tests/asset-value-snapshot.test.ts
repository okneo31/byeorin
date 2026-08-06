// 스냅샷을 바꾸면 결과가 따라 바뀐다 — 상수 박기를 구조적으로 잡는 테스트.
//
// 왜 별도 파일인가. rates/index.ts 는 모듈 로드 시 RATE_SNAPSHOT 으로 색인을
// 한 번 만든다. 그래서 스냅샷 모의는 파일 단위로만 갈아끼울 수 있고, 같은
// 파일에 진짜 스냅샷을 쓰는 테스트를 섞으면 둘 중 하나가 거짓말을 한다.
//
// 여기 숫자(perTtl 200·1000, 시세 400)는 **테스트 픽스처**다. 손계산을 눈으로
// 검산할 수 있게 고른 값이고, 소스의 환율 상수가 아니다. 진짜 스냅샷 값이
// 이 파일 어디에도 없는 것이 요점이다 — 있으면 재앵커 때 이 테스트가
// 통과하면서 화면은 틀리게 된다.

import { describe, it, expect, vi } from 'vitest';
import type { RateSnapshot } from '../src/rates/types.js';

/** 손계산이 되는 값만 넣은 가짜 앵커. 실제 66 종과는 아무 관계가 없다. */
const FAKE: RateSnapshot = {
  v: 1,
  anchoredAt: '1999-12-31',
  principle: 'test fixture',
  formula: 'test fixture',
  daysPerYear: 365,
  sources: {},
  notes: [],
  rates: [
    {
      symbol: 'tUSD',
      iso: 'USD',
      address: '0x1111111111111111111111111111111111111111',
      decimals: 18,
      country: 'Testland',
      perTtl: 200,
      inputs: { gdpLocal: 1, gdpYear: '1999', population: 1, populationYear: '1999' },
    },
    {
      symbol: 'tKRW',
      iso: 'KRW',
      address: '0x2222222222222222222222222222222222222222',
      decimals: 18,
      country: 'Testland2',
      perTtl: 1000,
      inputs: { gdpLocal: 1, gdpYear: '1999', population: 1, populationYear: '1999' },
    },
  ],
  unresolved: [],
};

vi.mock('../src/rates/snapshot.js', () => ({ RATE_SNAPSHOT: FAKE }));

const { assetValueInTtl, sumTtl } = await import('../src/rates/value.js');
const { rateByIso } = await import('../src/rates/index.js');

/** 이더리움 메인넷 USDC — 내장 목록의 액면 USD 스테이블. decimals 6. */
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('가짜 앵커 주입 — 값이 스냅샷을 따라간다', () => {
  it('모의가 실제로 걸렸다 (진짜 스냅샷이 아니다)', () => {
    expect(rateByIso('USD')?.perTtl).toBe(200);
  });

  it('face: 100 USDC ÷ perTtl 200 = 0.5 TTL (손계산)', () => {
    const v = assetValueInTtl(
      { kind: 'token', id: USDC, family: 'evm', chainId: 1, symbol: 'USDC', balance: 100_000000n, decimals: 6 },
      { prices: null },
    );
    expect(v.basis).toBe('face');
    expect(v.volatile).toBe(false);
    // 내장 목록 decimals 6 이 이긴다 — 인자로 준 값과 갈라지면 한 줄이 자기모순.
    expect(v.decimals).toBe(6);
    expect(v.ttl).toBeCloseTo(0.5, 12);
  });

  it('byeorin-rate: 2000 tKRW ÷ perTtl 1000 = 2 TTL (손계산)', () => {
    const v = assetValueInTtl(
      {
        kind: 'token',
        id: FAKE.rates[1]!.address,
        family: 'evm',
        chainId: 1,
        symbol: 'tKRW',
        balance: 2000n * 10n ** 18n,
        decimals: 18,
      },
      { prices: null },
    );
    expect(v.basis).toBe('byeorin-rate');
    expect(v.ttl).toBeCloseTo(2, 12);
  });

  it('market: 3 ETH × 400 USD ÷ perTtl 200 = 6 TTL (손계산)', () => {
    const v = assetValueInTtl(
      { kind: 'coin', symbol: 'ETH', balance: 3n * 10n ** 18n, decimals: 18 },
      { prices: { ETHUSDT: '400' } },
    );
    expect(v.basis).toBe('market');
    expect(v.volatile).toBe(true);
    expect(v.ttl).toBeCloseTo(6, 10);
    expect(v.market?.unitUsd).toBe(400);
    expect(v.market?.via).toBe('direct');
    // 1 USD 당 TTL = 1 / perTtl. 근거 패널이 이 수를 그대로 쓴다.
    expect(v.market?.usdPerTtl).toBeCloseTo(1 / 200, 15);
  });

  it('perTtl 이 2 배가 되면 TTL 값은 절반이 된다', () => {
    // 같은 입력을 두 앵커에 재는 대신, 같은 앵커 안에서 perTtl 이 2 배 차이나는
    // 두 통화로 확인한다 — vi.mock 은 파일 단위라 한 파일에 앵커를 둘 둘 수 없다.
    // FAKE 의 tKRW(1000) 는 tUSD(200) 의 5 배다.
    const usd = rateByIso('USD')!.perTtl;
    const krw = rateByIso('KRW')!.perTtl;
    expect(krw / usd).toBe(5);

    const one = 10n ** 18n;
    const a = assetValueInTtl(
      { kind: 'token', id: FAKE.rates[0]!.address, family: 'evm', chainId: 1, symbol: 'tUSD', balance: one, decimals: 18 },
      { prices: null },
    );
    const b = assetValueInTtl(
      { kind: 'token', id: FAKE.rates[1]!.address, family: 'evm', chainId: 1, symbol: 'tKRW', balance: one, decimals: 18 },
      { prices: null },
    );
    // 같은 수량이라도 perTtl 이 5 배면 TTL 은 1/5 이다.
    expect(a.ttl! / b.ttl!).toBeCloseTo(5, 12);
  });

  it('TTL 잔액은 앵커를 바꿔도 자기 자신이다 — perTtl 이 곱해지지 않는다', () => {
    const v = assetValueInTtl({ kind: 'ttl', balance: 7n * 10n ** 18n }, { prices: null });
    expect(v.basis).toBe('self');
    expect(v.ttl).toBe(7);
  });

  it('sumTtl — 값 미상은 더하지 않고 센다', () => {
    const known = assetValueInTtl(
      { kind: 'coin', symbol: 'ETH', balance: 10n ** 18n, decimals: 18 },
      { prices: { ETHUSDT: '400' } },
    );
    const unknown = assetValueInTtl(
      { kind: 'coin', symbol: 'NOSUCHCOIN', balance: 10n ** 18n, decimals: 18 },
      { prices: { ETHUSDT: '400' } },
    );
    const s = sumTtl([known, unknown]);
    expect(s.ttl).toBeCloseTo(2, 10); // 1 × 400 ÷ 200
    expect(s.missing).toBe(1);
    expect(s.volatile).toBe(true);
  });
});
