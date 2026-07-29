// ttl-amm-client.test.ts — TtlAmmClient 오프라인 테스트 (fetch 모킹, RPC 없음).
//
// 검증 축:
//   1. 견적 수학 — 손계산 벡터와 일치 (1홉·2홉, bigint 경계)
//   2. 수수료 상수 — TTL_AMM_FEE_BPS 를 모킹으로 바꾸면 견적이 따라 변한다
//      (클라이언트가 9967 을 이중으로 하드코딩하지 않았음을 증명)
//   3. 슬리피지 — minAmountOut = est × (10000−bps) / 10000
//   4. listPools — 페어 없음 제외 / RPC 실패는 던짐
//   5. buildSwapCall — 세 변형의 calldata 를 viem 으로 되읽어 인자 검증
//   6. 생성자 — 주소 미설정이면 명확한 에러

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeFunctionResult,
  parseAbi,
} from 'viem';
import {
  TtlAmmClient,
  TTL_AMM_DEFAULT_RPC_URL,
  TTL_AMM_DEFAULT_SLIPPAGE_BPS,
  TTL_AMM_NATIVE,
  type TtlAmmClientOptions,
} from '../src/exchange/client.js';
import { TTL_AMM_FEE_BPS, type TtlAmmPool } from '../src/exchange/types.js';

// ── 테스트 고정값 ────────────────────────────────────────────────────────────

const WTTL = '0x1111111111111111111111111111111111111111';
const FACTORY = '0x2222222222222222222222222222222222222222';
const ROUTER = '0x3333333333333333333333333333333333333333';
const TUSD = '0x4444444444444444444444444444444444444444';
const TJPY = '0x5555555555555555555555555555555555555555';
const TNONE = '0x6666666666666666666666666666666666666666'; // 풀 미생성 토큰
const PAIR_USD = '0x7777777777777777777777777777777777777777';
const PAIR_JPY = '0x8888888888888888888888888888888888888888';
const RECIPIENT = '0x9999999999999999999999999999999999999999';
const ZERO = '0x0000000000000000000000000000000000000000';

const baseOpts: TtlAmmClientOptions = {
  factory: FACTORY,
  router: ROUTER,
  wttl: WTTL,
};

// 클라이언트와 별도로 테스트가 직접 정의하는 V2 표준 ABI —
// 클라이언트 인코딩을 같은 파일의 같은 상수로 검증하는 순환을 피한다.
const factoryAbi = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);
const pairAbi = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);
const routerAbi = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);
const erc20Abi = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
]);

/** 준비금 1000:1000 짜리 단순 풀 — 손계산이 쉬운 크기. */
const poolUsd: TtlAmmPool = {
  pair: PAIR_USD,
  tokenTtl: WTTL,
  token: TUSD,
  reserveTtl: 1000n,
  reserveToken: 1000n,
};
const poolJpy: TtlAmmPool = {
  pair: PAIR_JPY,
  tokenTtl: WTTL,
  token: TJPY,
  reserveTtl: 1000n,
  reserveToken: 1000n,
};

/** eth_call 요청을 (to, data) 로 풀어 핸들러에 넘기는 fetch 모킹. */
function rpcMock(
  handler: (to: string, data: `0x${string}`) => `0x${string}`,
): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: number;
      method: string;
      params: [{ to: string; data: `0x${string}` }, string];
    };
    expect(body.method).toBe('eth_call');
    const [{ to, data }] = body.params;
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: handler(to, data) }),
      { status: 200 },
    );
  }) as typeof fetch;
}

// ── 1. 견적 수학 — 손계산 벡터 ──────────────────────────────────────────────

describe('TtlAmmClient.quote — 수학 (손계산 벡터)', () => {
  const client = new TtlAmmClient(baseOpts);

  it('1홉 WTTL→토큰: 1000 in @ 1000/1000 → 499 out (33bps)', () => {
    // 손계산:
    //   inWithFee = 1000 × 9967            = 9,967,000
    //   분모      = 1000 × 10000 + 9,967,000 = 19,967,000
    //   out       = 9,967,000 × 1000 / 19,967,000 = 499.17… → 499 (floor)
    //   minOut    = 499 × 9950 / 10000 = 496.505 → 496 (기본 슬리피지 50bps)
    //   feeEst    = 무수수료 out(1000×1000/2000 = 500) − 499 = 1
    const q = client.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD);
    expect(q.amountOutEst).toBe(499n);
    expect(q.minAmountOut).toBe(496n);
    expect(q.feeEst).toBe(1n);
    expect(q.route).toEqual([poolUsd]);
  });

  it('1홉 토큰→WTTL: 방향을 바꾸면 준비금도 뒤집혀 적용된다', () => {
    // 대칭 풀(1000:1000)이라 값은 같아야 한다 — 방향 매핑 검증이 목적.
    const q = client.quote([poolUsd], TUSD, 1000n, TTL_AMM_NATIVE);
    expect(q.amountOutEst).toBe(499n);
    // 비대칭 풀로 한 번 더: WTTL 2000 / 토큰 1000, 토큰 1000 입력.
    //   inWithFee = 9,967,000
    //   분모      = 1000 × 10000 + 9,967,000 = 19,967,000
    //   out       = 9,967,000 × 2000 / 19,967,000 = 998.35… → 998
    const deep: TtlAmmPool = { ...poolUsd, reserveTtl: 2000n };
    const q2 = client.quote([deep], TUSD, 1000n, TTL_AMM_NATIVE);
    expect(q2.amountOutEst).toBe(998n);
  });

  it('2홉 tUSD→WTTL→tJPY: 홉마다 33bps 누적, 첫 홉 출력 = 둘째 홉 입력', () => {
    // 손계산:
    //   hop1 (1000 tUSD → WTTL, 1000:1000) = 499  (위 벡터와 동일)
    //   hop2 (499 WTTL → tJPY, 1000:1000):
    //     inWithFee = 499 × 9967 = 4,973,533
    //     분모      = 1000 × 10000 + 4,973,533 = 14,973,533
    //     out       = 4,973,533 × 1000 / 14,973,533 = 332.15… → 332
    //   minOut = 332 × 9950 / 10000 = 330.34 → 330
    //   feeEst = 무수수료 경로(500 → 500×1000/1500 = 333) − 332 = 1
    const q = client.quote([poolUsd, poolJpy], TUSD, 1000n, TJPY);
    expect(q.amountOutEst).toBe(332n);
    expect(q.minAmountOut).toBe(330n);
    expect(q.feeEst).toBe(1n);
    expect(q.route).toEqual([poolUsd, poolJpy]);
  });

  it('bigint 경계: MAX_SAFE_INTEGER 를 훌쩍 넘는 준비금에서도 정확', () => {
    // 준비금 10^24, 입력 10^21 — Number 를 거치면 반드시 깨지는 크기.
    const big: TtlAmmPool = {
      ...poolUsd,
      reserveTtl: 10n ** 24n,
      reserveToken: 10n ** 24n,
    };
    const amountIn = 10n ** 21n;
    const q = client.quote([big], TTL_AMM_NATIVE, amountIn, TUSD);
    // 기대값을 공식 그대로 bigint 로 재계산 — Number 경유가 없음을 확인.
    const feeNum = 10000n - BigInt(TTL_AMM_FEE_BPS);
    const inWithFee = amountIn * feeNum;
    const expected = (inWithFee * 10n ** 24n) / (10n ** 24n * 10000n + inWithFee);
    expect(q.amountOutEst).toBe(expected);
    expect(q.amountOutEst > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('amountIn ≤ 0 거부', () => {
    expect(() => client.quote([poolUsd], TUSD, 0n, TTL_AMM_NATIVE)).toThrow(/양수/);
    expect(() => client.quote([poolUsd], TUSD, -1n, TTL_AMM_NATIVE)).toThrow(/양수/);
  });

  it('풀이 없으면 지어내지 않고 던진다', () => {
    expect(() => client.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TJPY)).toThrow(
      /풀이 없다/,
    );
    // 2홉의 둘째 풀이 없어도 마찬가지.
    expect(() => client.quote([poolUsd], TUSD, 1000n, TJPY)).toThrow(/풀이 없다/);
  });

  it('준비금 0 이면 던진다', () => {
    const empty: TtlAmmPool = { ...poolUsd, reserveToken: 0n };
    expect(() => client.quote([empty], TTL_AMM_NATIVE, 1000n, TUSD)).toThrow(
      /준비금이 0/,
    );
  });

  it('출력 추정 0 이면 견적을 만들지 않는다', () => {
    // 아주 깊은 풀에 1 만 넣으면 floor 로 0 이 된다 — 0 견적은 거부.
    const deep: TtlAmmPool = {
      ...poolUsd,
      reserveTtl: 10n ** 18n,
      reserveToken: 10n ** 18n,
    };
    expect(() => client.quote([deep], TTL_AMM_NATIVE, 1n, TUSD)).toThrow(/0/);
  });

  it('입력=출력 (WTTL↔native 포함) 거부', () => {
    expect(() => client.quote([poolUsd], TUSD, 1000n, TUSD)).toThrow(/같다/);
    expect(() => client.quote([poolUsd], TTL_AMM_NATIVE, 1000n, WTTL)).toThrow(
      /wrap/,
    );
  });
});

// ── 2. 수수료 상수 이중화 방지 ──────────────────────────────────────────────

describe('TTL_AMM_FEE_BPS 유도 (하드코딩 이중화 방지)', () => {
  afterEach(() => {
    vi.doUnmock('../src/exchange/types.js');
    vi.resetModules();
  });

  it('상수를 100bps 로 바꾸면 견적이 따라 변한다', async () => {
    vi.resetModules();
    vi.doMock('../src/exchange/types.js', async (importOriginal) => {
      const orig =
        await importOriginal<typeof import('../src/exchange/types.js')>();
      return { ...orig, TTL_AMM_FEE_BPS: 100 };
    });
    const { TtlAmmClient: MockedClient } = await import(
      '../src/exchange/client.js'
    );
    const client = new MockedClient(baseOpts);
    const q = client.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD);
    // 100bps 손계산: inWithFee = 1000×9900 = 9,900,000
    //   분모 = 10,000,000 + 9,900,000 = 19,900,000
    //   out  = 9,900,000 × 1000 / 19,900,000 = 497.48… → 497
    expect(q.amountOutEst).toBe(497n);
    // 33bps 결과(499)와 달라야 한다 — 클라이언트가 9967 을 따로 갖고 있다면
    // 여기서 499 가 나와 실패한다.
    expect(q.amountOutEst).not.toBe(499n);
  });
});

// ── 3. 슬리피지 ─────────────────────────────────────────────────────────────

describe('슬리피지 — minAmountOut = est × (10000−bps) / 10000', () => {
  it('기본 50bps, 생성자 설정, 호출별 override 모두 공식대로', () => {
    const est = 499n; // 위 1홉 벡터의 추정치
    const def = new TtlAmmClient(baseOpts);
    expect(def.slippageBps).toBe(TTL_AMM_DEFAULT_SLIPPAGE_BPS);
    expect(def.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD).minAmountOut).toBe(
      (est * 9950n) / 10000n,
    );

    const wide = new TtlAmmClient({ ...baseOpts, slippageBps: 100 });
    expect(wide.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD).minAmountOut).toBe(
      (est * 9900n) / 10000n,
    );

    const q = def.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD, 0);
    expect(q.minAmountOut).toBe(q.amountOutEst); // 0bps → floor 손실 없음
  });

  it('범위 밖 slippageBps 거부 (생성자·호출 모두)', () => {
    expect(() => new TtlAmmClient({ ...baseOpts, slippageBps: -1 })).toThrow(
      /slippageBps/,
    );
    expect(() => new TtlAmmClient({ ...baseOpts, slippageBps: 10001 })).toThrow(
      /slippageBps/,
    );
    const client = new TtlAmmClient(baseOpts);
    expect(() =>
      client.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD, 10001),
    ).toThrow(/slippageBps/);
  });
});

// ── 4. listPools ────────────────────────────────────────────────────────────

describe('TtlAmmClient.listPools — eth_call 읽기', () => {
  /** Factory·Pair 두 개를 흉내내는 핸들러. */
  function chainHandler(to: string, data: `0x${string}`): `0x${string}` {
    if (to === FACTORY) {
      const forUsd = encodeFunctionData({
        abi: factoryAbi,
        functionName: 'getPair',
        args: [WTTL, TUSD],
      });
      const forJpy = encodeFunctionData({
        abi: factoryAbi,
        functionName: 'getPair',
        args: [WTTL, TJPY],
      });
      const pair = data === forUsd ? PAIR_USD : data === forJpy ? PAIR_JPY : ZERO;
      return encodeFunctionResult({
        abi: factoryAbi,
        functionName: 'getPair',
        result: pair,
      });
    }
    const wantReserves = encodeFunctionData({
      abi: pairAbi,
      functionName: 'getReserves',
    });
    const wantToken0 = encodeFunctionData({ abi: pairAbi, functionName: 'token0' });
    if (to === PAIR_USD) {
      // token0 = WTTL — reserve0 이 WTTL 쪽.
      if (data === wantToken0) {
        return encodeFunctionResult({
          abi: pairAbi,
          functionName: 'token0',
          result: WTTL,
        });
      }
      if (data === wantReserves) {
        return encodeFunctionResult({
          abi: pairAbi,
          functionName: 'getReserves',
          result: [1000n, 246_650n, 0],
        });
      }
    }
    if (to === PAIR_JPY) {
      // token0 = TJPY — 반대 방향. reserve0 이 토큰 쪽임을 클라이언트가
      // token0() 로 알아내야 한다.
      if (data === wantToken0) {
        return encodeFunctionResult({
          abi: pairAbi,
          functionName: 'token0',
          result: TJPY,
        });
      }
      if (data === wantReserves) {
        return encodeFunctionResult({
          abi: pairAbi,
          functionName: 'getReserves',
          result: [5000n, 42n, 0],
        });
      }
    }
    throw new Error(`예상 밖의 eth_call: to=${to} data=${data}`);
  }

  it('페어 있는 토큰만 풀로, token0 방향까지 맞춰 매핑한다', async () => {
    const client = new TtlAmmClient({ ...baseOpts, fetch: rpcMock(chainHandler) });
    const pools = await client.listPools([TUSD, TNONE, TJPY]);
    expect(pools).toHaveLength(2); // TNONE 은 getPair = zero → 제외
    const usd = pools.find((p) => p.token === TUSD);
    const jpy = pools.find((p) => p.token === TJPY);
    expect(usd).toBeDefined();
    expect(jpy).toBeDefined();
    // token0 = WTTL 인 풀: reserve0 → reserveTtl
    expect(usd!.reserveTtl).toBe(1000n);
    expect(usd!.reserveToken).toBe(246_650n);
    expect(usd!.tokenTtl).toBe(WTTL);
    // token0 = 토큰인 풀: reserve0 → reserveToken (방향 뒤집힘)
    expect(jpy!.reserveTtl).toBe(42n);
    expect(jpy!.reserveToken).toBe(5000n);
    expect(jpy!.pair.toLowerCase()).toBe(PAIR_JPY);
  });

  it('RPC HTTP 실패는 빈 목록으로 위장하지 않고 던진다', async () => {
    const failFetch = (async () =>
      new Response('down', { status: 503, statusText: 'Service Unavailable' })) as typeof fetch;
    const client = new TtlAmmClient({ ...baseOpts, fetch: failFetch });
    await expect(client.listPools([TUSD])).rejects.toThrow(/503/);
  });

  it('JSON-RPC error 응답도 던진다', async () => {
    const errFetch = (async () =>
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: -32000, message: 'execution reverted' },
        }),
        { status: 200 },
      )) as typeof fetch;
    const client = new TtlAmmClient({ ...baseOpts, fetch: errFetch });
    await expect(client.listPools([TUSD])).rejects.toThrow(/execution reverted/);
  });

  it("result '0x' (컨트랙트 없음) 도 던진다", async () => {
    const emptyFetch = (async () =>
      new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x' }), {
        status: 200,
      })) as typeof fetch;
    const client = new TtlAmmClient({ ...baseOpts, fetch: emptyFetch });
    await expect(client.listPools([TUSD])).rejects.toThrow(/빈 응답/);
  });
});

// ── 5. buildSwapCall — calldata 되읽기 검증 ─────────────────────────────────

describe('TtlAmmClient.buildSwapCall — 세 변형', () => {
  const client = new TtlAmmClient(baseOpts);
  const deadline = 1_753_800_000n;

  it('네이티브 입력 → swapExactNativeForTokens + value', () => {
    const q = client.quote([poolUsd], TTL_AMM_NATIVE, 1000n, TUSD);
    const call = client.buildSwapCall(q, TTL_AMM_NATIVE, 1000n, RECIPIENT, deadline);
    expect(call.to).toBe(ROUTER);
    expect(call.value).toBe(1000n); // 네이티브는 msg.value 로
    const decoded = decodeFunctionData({ abi: routerAbi, data: call.data });
    expect(decoded.functionName).toBe('swapExactNativeForTokens');
    expect(decoded.args).toEqual([496n, [WTTL, TUSD], RECIPIENT, deadline]);
  });

  it('네이티브 출력 → swapExactTokensForNative, value 0', () => {
    const q = client.quote([poolUsd], TUSD, 1000n, TTL_AMM_NATIVE);
    const call = client.buildSwapCall(q, TUSD, 1000n, RECIPIENT, deadline);
    expect(call.to).toBe(ROUTER);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: routerAbi, data: call.data });
    expect(decoded.functionName).toBe('swapExactTokensForNative');
    expect(decoded.args).toEqual([1000n, 496n, [TUSD, WTTL], RECIPIENT, deadline]);
  });

  it('토큰↔토큰 (2홉) → swapExactTokensForTokens, 경로 3개', () => {
    const q = client.quote([poolUsd, poolJpy], TUSD, 1000n, TJPY);
    const call = client.buildSwapCall(q, TUSD, 1000n, RECIPIENT, deadline);
    expect(call.to).toBe(ROUTER);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: routerAbi, data: call.data });
    expect(decoded.functionName).toBe('swapExactTokensForTokens');
    expect(decoded.args).toEqual([
      1000n,
      330n, // 2홉 손계산 벡터의 minOut
      [TUSD, WTTL, TJPY],
      RECIPIENT,
      deadline,
    ]);
  });

  it('견적과 다른 tokenIn 이 들어오면 던진다', () => {
    const q = client.quote([poolUsd], TUSD, 1000n, TTL_AMM_NATIVE);
    expect(() =>
      client.buildSwapCall(q, TJPY, 1000n, RECIPIENT, deadline),
    ).toThrow(/tokenIn/);
  });

  it('buildApproveCall — approve(router, amount) 를 토큰 주소로', () => {
    const call = client.buildApproveCall(TUSD, 123_456n);
    expect(call.to).toBe(TUSD);
    expect(call.value).toBe(0n);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(decoded.functionName).toBe('approve');
    expect(decoded.args).toEqual([ROUTER, 123_456n]);
  });

  it('needsApprove — 네이티브만 false, ERC-20 은 true', () => {
    expect(client.needsApprove(TTL_AMM_NATIVE)).toBe(false);
    expect(client.needsApprove(TUSD)).toBe(true);
    expect(client.needsApprove(WTTL)).toBe(true); // WTTL 도 ERC-20 이다
  });
});

// ── 6. 생성자 — 주소 미설정 ─────────────────────────────────────────────────

describe('TtlAmmClient 생성자 — 배포 전 주소 방어', () => {
  it('factory/router/wttl 각각 비어 있으면 어느 것이 문제인지 말하고 던진다', () => {
    expect(() => new TtlAmmClient({ ...baseOpts, factory: '' })).toThrow(
      /factory 주소가 설정되지 않았다/,
    );
    expect(() => new TtlAmmClient({ ...baseOpts, router: '' })).toThrow(
      /router 주소가 설정되지 않았다/,
    );
    expect(() => new TtlAmmClient({ ...baseOpts, wttl: '' })).toThrow(
      /wttl 주소가 설정되지 않았다/,
    );
  });

  it('주소 형식이 아니면 던진다', () => {
    expect(() => new TtlAmmClient({ ...baseOpts, factory: '0x123' })).toThrow(
      /형식/,
    );
    expect(() => new TtlAmmClient({ ...baseOpts, router: 'not-an-address' })).toThrow(
      /형식/,
    );
  });

  it('기본값 — rpcUrl 과 slippageBps', () => {
    const client = new TtlAmmClient(baseOpts);
    expect(client.rpcUrl).toBe(TTL_AMM_DEFAULT_RPC_URL);
    expect(client.rpcUrl).toBe('https://rpc.ttl1.top');
    expect(client.slippageBps).toBe(50);
  });
});
