// 스냅샷에 USD 가 없으면 어떻게 되는가.
//
// 답: 값을 **비운다.** 지어낸 계수로 메우지 않는다. 메우는 순간 그 상수가
// 스냅샷과 두 벌이 되고, 두 번째 앵커가 된다.
//
// 이 파일이 따로 있는 이유는 asset-value-snapshot.test.ts 와 같다 —
// rates/index.ts 의 색인이 모듈 로드 시 1 회 만들어져서 스냅샷 모의는 파일
// 단위다.

import { describe, it, expect, vi } from 'vitest';
import type { RateSnapshot } from '../src/rates/types.js';

/** USD 가 없는 앵커. 있을 수 없는 상태지만, 그때 무엇을 하는지가 규칙이다. */
const NO_USD: RateSnapshot = {
  v: 1,
  anchoredAt: '1999-12-31',
  principle: 'test fixture',
  formula: 'test fixture',
  daysPerYear: 365,
  sources: {},
  notes: [],
  rates: [
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

vi.mock('../src/rates/snapshot.js', () => ({ RATE_SNAPSHOT: NO_USD }));

const { assetValueInTtl } = await import('../src/rates/value.js');
const { rateByIso } = await import('../src/rates/index.js');

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

describe('USD 가 없는 앵커 — 폴백하지 않고 비운다', () => {
  it('모의가 실제로 걸렸다', () => {
    expect(rateByIso('USD')).toBeNull();
  });

  it('상장자산: 시세가 있어도 값을 내지 않는다', () => {
    const v = assetValueInTtl(
      { kind: 'coin', symbol: 'BTC', balance: 10n ** 8n, decimals: 8 },
      { prices: { BTCUSDT: '60000' } },
    );
    expect(v.ttl).toBeNull();
    expect(v.basis).toBe('market');
    expect(v.reason).toBe('no-face-rate');
  });

  it('액면 USD 스테이블: 옛 값·기본값으로 떨어지지 않는다', () => {
    const v = assetValueInTtl(
      { kind: 'token', id: USDC, family: 'evm', chainId: 1, symbol: 'USDC', balance: 100_000000n, decimals: 6 },
      { prices: null },
    );
    expect(v.ttl).toBeNull();
    expect(v.basis).toBe('face');
    expect(v.reason).toBe('no-face-rate');
  });

  it('TTL 자신은 앵커에 USD 가 없어도 멀쩡하다 — 애초에 참조하지 않는다', () => {
    const v = assetValueInTtl({ kind: 'ttl', balance: 5n * 10n ** 18n }, { prices: null });
    expect(v.ttl).toBe(5);
    expect(v.reason).toBeUndefined();
  });
});
