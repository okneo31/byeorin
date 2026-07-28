// rates.test.ts — 벼린 환율 스냅샷과 조회/환산 API.
//
// 전부 offline: 스냅샷은 저장소에 박혀 있는 앵커라 네트워크가 필요 없다.
// 여기서 검사하는 것은 두 가지다.
//   1) API 가 약속한 대로 동작하는가 (주소 조회 / null 반환 / 정밀도)
//   2) 스냅샷 자체가 형태적으로 성립하는가 (중복·형식·양수)

import { describe, expect, it } from 'vitest';
import {
  RATE_SNAPSHOT,
  crossRate,
  rateByAddress,
  rateByIso,
  snapshot,
  tokenAmountToTtl,
  ttlToTokenAmount,
  type TokenRate,
} from '../src/rates/index.js';

// 스냅샷에 실제로 들어 있는 값들. 하드코딩하는 이유는 스냅샷이 앵커이기
// 때문이다 — 값이 바뀌면 그건 앵커가 바뀐 것이고, 테스트가 알려야 한다.
const TUSD = '0xc00d0FF37e9CE83C269e762644202D4Ab82F023c';
const TVND = '0x0c9F6B8823935594c0cc6d808Cba9D2B06DDF6d6';
const TKRW = '0x371ca60b282E66Ad80deFD85031032D09FA4d6aD';

/** 이더리움 메인넷의 TrueUSD. 심볼이 TUSD 라 tUSD 와 부딪힌다. */
const TRUEUSD_MAINNET = '0x0000000000085d4780B73119b644AE5ecd22b376';

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

describe('rateByAddress', () => {
  it('대소문자 무관하게 찾는다', () => {
    const asIs = rateByAddress(TUSD);
    const lower = rateByAddress(TUSD.toLowerCase());
    const upper = rateByAddress('0x' + TUSD.slice(2).toUpperCase());
    expect(asIs?.iso).toBe('USD');
    expect(lower).toBe(asIs);
    expect(upper).toBe(asIs);
  });

  it('없는 주소는 null (0 이나 undefined 가 아니다)', () => {
    expect(rateByAddress('0x' + '0'.repeat(40))).toBeNull();
    expect(rateByAddress('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBeNull();
  });

  it('빈 문자열·쓰레기 입력도 예외 없이 null', () => {
    expect(rateByAddress('')).toBeNull();
    expect(rateByAddress('not-an-address')).toBeNull();
  });
});

describe('주소로 찾는 이유 — 심볼 충돌 (회귀)', () => {
  // tUSD 를 심볼로 맞추면 TrueUSD(TUSD) 를 벼린 환율로 오인한다. 실제로
  // 부딪힌 적이 있어서 조회 키를 주소로 못 박았다.
  it('tUSD 를 대문자화하면 TrueUSD 의 심볼과 같아진다', () => {
    const tusd = rateByAddress(TUSD);
    expect(tusd?.symbol).toBe('tUSD');
    expect(tusd?.symbol.toUpperCase()).toBe('TUSD');
  });

  it('심볼 키 맵이었다면 TrueUSD 가 tUSD 환율에 잘못 걸린다', () => {
    // 있어서는 안 되는 구현을 재현해 실패 양상을 못 박아 둔다.
    const bySymbol = new Map<string, TokenRate>();
    for (const r of RATE_SNAPSHOT.rates) bySymbol.set(r.symbol.toUpperCase(), r);
    expect(bySymbol.get('TUSD')?.iso).toBe('USD'); // ← 잘못된 매칭이 성립한다

    // 실제 API 는 주소로 맞추므로 TrueUSD 는 걸리지 않는다.
    expect(rateByAddress(TRUEUSD_MAINNET)).toBeNull();
    expect(rateByAddress(TRUEUSD_MAINNET.toLowerCase())).toBeNull();
  });

  it('TrueUSD 주소는 스냅샷 어디에도 없다', () => {
    const hit = RATE_SNAPSHOT.rates.find(
      (r) => r.address.toLowerCase() === TRUEUSD_MAINNET.toLowerCase(),
    );
    expect(hit).toBeUndefined();
  });
});

describe('rateByIso', () => {
  it('대소문자 무관', () => {
    expect(rateByIso('usd')?.symbol).toBe('tUSD');
    expect(rateByIso('USD')?.symbol).toBe('tUSD');
  });

  it('없는 ISO 는 null', () => {
    expect(rateByIso('XYZ')).toBeNull();
  });
});

describe('tokenAmountToTtl', () => {
  it('decimals 18 base unit 을 정확히 환산', () => {
    const usd = rateByAddress(TUSD)!;
    // 1 TTL = perTtl tUSD 이므로, perTtl 만큼의 토큰은 정확히 1 TTL 이다.
    const oneTtlWorth = 10n ** 18n * 100n; // 100 tUSD
    const ttl = tokenAmountToTtl(oneTtlWorth, 18, usd);
    expect(ttl).toBeCloseTo(100 / usd.perTtl, 12);
  });

  it('환율이 없으면 null — 0 이 아니다', () => {
    // 0 을 돌려주면 화면에서 "가치 없음" 으로 읽힌다. 모르는 것과 없는 것은 다르다.
    expect(tokenAmountToTtl(10n ** 18n, 18, null)).toBeNull();
    expect(tokenAmountToTtl(10n ** 18n, 18, null)).not.toBe(0);
  });

  it('perTtl 이 0 이나 음수인 조작된 rate 도 null', () => {
    const usd = rateByAddress(TUSD)!;
    expect(tokenAmountToTtl(10n ** 18n, 18, { ...usd, perTtl: 0 })).toBeNull();
    expect(tokenAmountToTtl(10n ** 18n, 18, { ...usd, perTtl: -1 })).toBeNull();
    expect(tokenAmountToTtl(10n ** 18n, 18, { ...usd, perTtl: Number.NaN })).toBeNull();
  });

  it('잔액 0 은 0 TTL (null 이 아니다 — 환율은 아는 상태다)', () => {
    const usd = rateByAddress(TUSD)!;
    expect(tokenAmountToTtl(0n, 18, usd)).toBe(0);
  });

  it('decimals 0 도 처리한다', () => {
    const usd = rateByAddress(TUSD)!;
    expect(tokenAmountToTtl(100n, 0, usd)).toBeCloseTo(100 / usd.perTtl, 12);
  });

  it('ttlToTokenAmount 와 왕복', () => {
    const krw = rateByAddress(TKRW)!;
    const ttl = tokenAmountToTtl(10n ** 18n * 1_000_000n, 18, krw)!;
    expect(ttlToTokenAmount(ttl, krw)).toBeCloseTo(1_000_000, 6);
    expect(ttlToTokenAmount(1, null)).toBeNull();
  });
});

describe('큰 수 정밀도 — perTtl 34만 + decimals 18 (tVND)', () => {
  const vnd = rateByAddress(TVND)!;

  it('tVND 가 실제로 그 조합이다', () => {
    expect(vnd.decimals).toBe(18);
    expect(vnd.perTtl).toBeGreaterThan(340_000);
  });

  it('정확히 1 TTL 어치는 오차 없이 1 이 나온다', () => {
    // perTtl 을 18 decimals base unit 으로 올린 값. Number(bigint) 로 한 번에
    // 변환하면 여기서 1.0000000000000002 가 나온다 — 정수부/소수부를 나누는
    // 구현이라야 정확히 1 이다.
    // 346450.1532517109 × 10^18
    const baseUnits = 346450153251710900000000n;

    const naive = Number(baseUnits) / 1e18 / vnd.perTtl;
    expect(naive).not.toBe(1); // 순진한 구현은 어긋난다

    expect(tokenAmountToTtl(baseUnits, 18, vnd)).toBe(1);
  });

  it('1 wei 도 0 으로 뭉개지지 않는다', () => {
    const ttl = tokenAmountToTtl(1n, 18, vnd)!;
    expect(ttl).toBeGreaterThan(0);
    expect(Number.isFinite(ttl)).toBe(true);
    expect(ttl).toBeCloseTo(1e-18 / vnd.perTtl, 30);
  });

  it('조 단위 잔액에서도 상대오차가 1e-12 미만', () => {
    const tokens = 1_234_567_890_123n; // 1.2조 tVND
    const ttl = tokenAmountToTtl(tokens * 10n ** 18n, 18, vnd)!;
    const expected = Number(tokens) / vnd.perTtl;
    expect(Math.abs(ttl - expected) / expected).toBeLessThan(1e-12);
  });

  it('소수부가 정수부를 오염시키지 않는다', () => {
    // 900,719,925,474 토큰 + 1 wei. 1 wei 는 상대적으로 무시 가능하므로
    // 결과는 정수부만 환산한 값과 사실상 같아야 한다.
    const baseUnits = 900_719_925_474n * 10n ** 18n + 1n;
    const ttl = tokenAmountToTtl(baseUnits, 18, vnd)!;
    const expected = 900_719_925_474 / vnd.perTtl;
    expect(Math.abs(ttl - expected) / expected).toBeLessThan(1e-12);
  });
});

describe('crossRate — TTL 절대 눈금이 약분된다', () => {
  const usd = rateByAddress(TUSD)!;
  const krw = rateByAddress(TKRW)!;

  it('1 tUSD 가 몇 tKRW 인가 = perTtl 비율', () => {
    expect(crossRate(usd, krw)).toBe(krw.perTtl / usd.perTtl);
  });

  it('TTL 눈금을 통째로 바꿔도 교환비는 그대로 — 앵커와 무관하다', () => {
    // TTL 이 외부에서 얼마로 평가되든(BTC 앵커가 무엇이든) 두 통화토큰의
    // 교환비는 변하지 않는다. 스케일 k 를 곱해도 약분되어 사라져야 한다.
    for (const k of [1e-9, 0.5, 2, 1e6]) {
      const su: TokenRate = { ...usd, perTtl: usd.perTtl * k };
      const sk: TokenRate = { ...krw, perTtl: krw.perTtl * k };
      expect(crossRate(su, sk)).toBeCloseTo(crossRate(usd, krw)!, 9);
    }
  });

  it('역방향과 곱하면 1', () => {
    const a = crossRate(usd, krw)!;
    const b = crossRate(krw, usd)!;
    expect(a * b).toBeCloseTo(1, 12);
  });

  it('자기 자신과의 교환비는 1', () => {
    expect(crossRate(usd, usd)).toBe(1);
  });

  it('한쪽이라도 없으면 null', () => {
    expect(crossRate(null, krw)).toBeNull();
    expect(crossRate(usd, null)).toBeNull();
    expect(crossRate(null, null)).toBeNull();
    expect(crossRate({ ...usd, perTtl: 0 }, krw)).toBeNull();
  });
});

describe('unresolvedRates — 추측하지 않고 남긴 것', () => {
  it('대만(tTWD)이 실제로 여기 있다', () => {
    const twd = RATE_SNAPSHOT.unresolved.find((u) => u.iso === 'TWD');
    expect(twd).toBeDefined();
    expect(twd!.symbol).toBe('tTWD');
    expect(twd!.country).toBe('Taiwan');
    expect(twd!.reason.length).toBeGreaterThan(0);
  });

  it('tTWD 는 rates 에도 없고 rateByIso 로도 안 잡힌다', () => {
    expect(rateByIso('TWD')).toBeNull();
    expect(RATE_SNAPSHOT.rates.some((r) => r.iso === 'TWD')).toBe(false);
  });

  it('unresolved 는 주소를 갖지 않으므로 rateByAddress 로 잡을 방법이 없다', () => {
    for (const u of RATE_SNAPSHOT.unresolved) {
      expect(u).not.toHaveProperty('address');
    }
  });

  it('resolved 와 unresolved 의 ISO 는 겹치지 않는다', () => {
    const resolved = new Set(RATE_SNAPSHOT.rates.map((r) => r.iso));
    for (const u of RATE_SNAPSHOT.unresolved) {
      expect(resolved.has(u.iso)).toBe(false);
    }
  });

  it('모든 unresolved 항목에 사유가 적혀 있다', () => {
    for (const u of RATE_SNAPSHOT.unresolved) {
      expect(typeof u.reason).toBe('string');
      expect(u.reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('스냅샷 무결성', () => {
  const rates = RATE_SNAPSHOT.rates;

  it('비어 있지 않다', () => {
    expect(rates.length).toBeGreaterThan(0);
  });

  it('모든 perTtl 이 유한한 양수', () => {
    for (const r of rates) {
      expect(Number.isFinite(r.perTtl)).toBe(true);
      expect(r.perTtl).toBeGreaterThan(0);
    }
  });

  it('모든 address 가 0x + 40 hex', () => {
    for (const r of rates) {
      expect(r.address).toMatch(ADDRESS_RE);
    }
  });

  it('모든 decimals 가 음이 아닌 정수', () => {
    for (const r of rates) {
      expect(Number.isInteger(r.decimals)).toBe(true);
      expect(r.decimals).toBeGreaterThanOrEqual(0);
    }
  });

  it('iso 중복 없음', () => {
    const isos = rates.map((r) => r.iso);
    expect(new Set(isos).size).toBe(isos.length);
  });

  it('address 중복 없음 (대소문자 무시)', () => {
    const addrs = rates.map((r) => r.address.toLowerCase());
    expect(new Set(addrs).size).toBe(addrs.length);
  });

  it('symbol 은 t + ISO 형태', () => {
    for (const r of rates) {
      expect(r.symbol).toBe(`t${r.iso}`);
    }
  });

  it('모든 항목이 rateByAddress / rateByIso 로 되찾아진다', () => {
    for (const r of rates) {
      expect(rateByAddress(r.address)).toBe(r);
      expect(rateByIso(r.iso)).toBe(r);
    }
  });
});

describe('snapshot() — 근거를 함께 싣는다', () => {
  it('RATE_SNAPSHOT 그대로를 돌려준다', () => {
    expect(snapshot()).toBe(RATE_SNAPSHOT);
  });

  it('산식·원칙·출처가 비어 있지 않다', () => {
    const s = snapshot();
    expect(s.v).toBe(1);
    expect(s.daysPerYear).toBe(365);
    expect(s.principle.length).toBeGreaterThan(0);
    expect(s.formula.length).toBeGreaterThan(0);
    expect(Object.keys(s.sources).length).toBeGreaterThan(0);
    expect(s.notes.length).toBeGreaterThan(0);
  });

  it('모든 rate 가 inputs 를 싣고 있다 — 근거 없는 숫자를 노출하지 않는다', () => {
    for (const r of snapshot().rates) {
      expect(r.inputs).toBeDefined();
      expect(r.inputs.gdpLocal).toBeGreaterThan(0);
      expect(r.inputs.population).toBeGreaterThan(0);
      expect(r.inputs.gdpYear).toMatch(/\d{4}/);
      expect(r.inputs.populationYear).toMatch(/\d{4}/);
      // 단일 국가면 iso3, 통화동맹이면 회원국 목록 — 둘 중 하나는 반드시 있어야
      // 입력 출처를 되짚을 수 있다.
      if (r.iso3Members) {
        expect(r.iso3Members.length).toBeGreaterThan(1);
        for (const m of r.iso3Members) expect(m).toMatch(/^[A-Z]{3}$/);
        expect(r.iso3).toBeUndefined();
      } else {
        expect(r.iso3).toMatch(/^[A-Z]{3}$/);
      }
    }
  });

  it('perTtl 이 inputs 로 재계산된다 — 산식과 값이 어긋나지 않는다', () => {
    for (const r of snapshot().rates) {
      const recomputed = r.inputs.gdpLocal / r.inputs.population / RATE_SNAPSHOT.daysPerYear;
      expect(recomputed).toBe(r.perTtl);
    }
  });

  it('합성 GDP 는 gdpSynthetic 으로 표시된다 (유로존)', () => {
    const eur = rateByIso('EUR')!;
    expect(eur.inputs.gdpSynthetic).toBeDefined();
    expect(eur.inputs.gdpSynthetic!.length).toBeGreaterThan(0);
    // 합성이 아닌 항목에는 이 필드가 없다.
    expect(rateByIso('USD')!.inputs.gdpSynthetic).toBeUndefined();
  });

  it('BTC 앵커는 이 스냅샷 어디에도 등장하지 않는다 (별개 트랙)', () => {
    const json = JSON.stringify(RATE_SNAPSHOT.rates);
    expect(json).not.toMatch(/btc/i);
    expect(RATE_SNAPSHOT.rates.some((r) => r.iso === 'BTC')).toBe(false);
  });
});
