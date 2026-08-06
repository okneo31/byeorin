// market.ts — Binance ticker 표에서 "이 심볼 1 단위가 몇 USD 인가" 를 찾는 곳.
//
// 왜 SDK 로 올렸는가. 이 조회는 extension App.tsx 와 android App.tsx 에 문자
// 단위로 같은 사본 2 벌로 있었다. 사본은 반드시 갈라진다 — v0.5.21 에서 환산
// 산식이 그렇게 갈라졌고 v0.5.22 를 통째로 그 수습에 썼다.
//
// **여기는 네트워크를 타지 않는다.** fetch 는 셸이 하고, 그 결과 표만 여기로
// 들어온다. I/O 는 셸, 산식은 SDK — 그 경계다.
//
// 그리고 이 표는 **재어지는 자산의 성질**이다. 자(尺)의 성질이 아니다. BTC 를
// TTL 로 재도 TTL 의 눈금은 변하지 않는다 — TTL 의 값은 rate-snapshot 앵커에서
// 오고 그 앵커는 시장을 보지 않는다. docs/CONTEXT.md §5 가 금지한 것은 TTL
// **자신의** 값이 시장을 따라가는 것(옛 페그 TTL = 10/365 BTC)이지, 다른 자산을
// TTL 이라는 단위로 적는 것이 아니다. 방향이 뒤집히면 옛 페그로 되돌아간다.

/**
 * Binance `api/v3/ticker/price` 를 심볼 → 가격으로 접은 표. 셸이 채운다.
 *
 * 값이 string 도 허용인 이유: 그 API 는 가격을 문자열로 준다. 셸마다 Number()
 * 를 다시 짜게 두면 그 변환이 4 벌로 갈라진다 — 여기서 한 번만 한다.
 */
export type PriceTable = Readonly<Record<string, number | string>>;

/** 1 단위가 몇 USD 인지, 그리고 어느 경로로 얻었는지. */
export interface UnitUsd {
  readonly usd: number;
  readonly via: 'direct' | 'btc-bridge' | 'unwrapped';
}

/** 표에서 한 칸을 유한 양수로만 꺼낸다. 0·NaN·빈문자는 값이 아니라 부재다. */
function priceAt(prices: PriceTable, pair: string): number | null {
  const raw = prices[pair];
  if (raw === undefined || raw === null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 심볼 1 단위 → USD. 없으면 null(0 이 아니다 — 0 은 "가치 없음" 으로 읽힌다).
 *
 * **TTL 은 무조건 null 이다.** 호출자가 실수로 TTL 을 상장자산처럼 넘겨도 시세가
 * 곱해질 경로가 없어야 한다. 이 한 줄이 value.ts 의 분기와 별개로 놓인 두 번째
 * 자물쇠다 — 분기 하나가 잘못 고쳐져도 TTL 에 시세가 붙지 않는다.
 *
 * 심볼로 조회하지만 **판정은 여기서 하지 않는다.** 신원 확인은 상위
 * (tokenIdentityOf)에서 이미 끝났고, 미확인 자산은 이 함수까지 오지 않는다.
 * 그 순서가 뒤집히면 가짜 USDT 가 다시 값을 얻는다(v0.5.20 에서 막은 구멍).
 */
export function symbolUnitUsd(symbol: string, prices: PriceTable | null): UnitUsd | null {
  if (!prices) return null;
  const sym = symbol.toUpperCase();
  // **조회보다 먼저 막는다.** 나중에 막으면 표에 WTTLUSDT 페어가 있을 때
  // direct 조회가 먼저 성공해서 자물쇠를 지나간다 — wrapped TTL 은 TTL 이고,
  // 그 순간 TTL 자신의 값이 시장에서 오게 된다(옛 페그와 같은 방향).
  if (sym === 'TTL' || sym === 'WTTL') return null;

  const direct = pairLookup(sym, prices);
  if (direct !== null) return direct;

  // WETH·WBTC 같은 wrapped 는 원본 심볼로 한 번 더. **한 글자만 벗긴다** —
  // 벗긴 결과로 자신을 다시 부르지 않으므로 'WWWBTC' 가 BTC 값을 얻는 일은 없다.
  if (sym.startsWith('W') && sym.length > 1) {
    const inner = pairLookup(sym.slice(1), prices);
    return inner === null ? null : { usd: inner.usd, via: 'unwrapped' };
  }

  // 미상장. 지어낸 환산을 끼워 넣지 않는다.
  return null;
}

/** USDT 페어 → 없으면 BTC 페어 × BTCUSDT 우회. 언랩은 여기서 하지 않는다. */
function pairLookup(sym: string, prices: PriceTable): UnitUsd | null {
  const direct = priceAt(prices, `${sym}USDT`);
  if (direct !== null) return { usd: direct, via: 'direct' };

  // USDT 페어가 없는 자산 커버.
  const btc = priceAt(prices, `${sym}BTC`);
  const btcUsd = priceAt(prices, 'BTCUSDT');
  if (btc !== null && btcUsd !== null) return { usd: btc * btcUsd, via: 'btc-bridge' };
  return null;
}
