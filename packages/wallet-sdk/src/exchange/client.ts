// exchange/client.ts — TTL 체인 AMM 클라이언트 (E-4).
//
// 하는 일 (그리고 이것만):
//   1. listPools    — Factory/Pair 를 JSON-RPC eth_call 로 읽어 풀 스냅샷
//   2. quote        — 상수곱(x·y=k) 견적. 순수 함수, RPC 없음
//   3. buildSwapCall / buildApproveCall — Router/ERC-20 calldata 생성
//
// 하지 않는 일:
//   - 서명·브로드캐스트 — TtlAmmSwapCall 은 TransferIntent(to/data/value)로
//     흘려보내 지갑의 기존 EVM 서명 경로를 그대로 탄다.
//   - 유동성 공급, 풀 생성, 최적 경로 탐색(허브 구조상 경로가 유일하다).
//
// viem 의 ABI 인코더만 쓰고 viem client 는 만들지 않는다 — zion-amm 이 fetch
// 를 직접 쓰는 것과 같은 이유다: 이 모듈은 화면에서 dynamic import 되는
// 무거운 번들에 끌려 들어가면 안 된다. RPC 는 eth_call 하나면 충분하다.
//
// 컨트랙트(E-1)는 병렬 제작 중이라 배포 주소가 아직 없다. 주소는 생성자
// 설정으로 받고, 없거나 형식이 틀리면 생성 시점에 명확히 실패한다 —
// 런타임 깊숙한 곳에서 이상한 revert 를 만나는 것보다 낫다.

import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import {
  TTL_AMM_FEE_BPS,
  type TtlAmmPool,
  type TtlAmmQuote,
  type TtlAmmSwapCall,
} from './types.js';

/** TTL 체인 공개 RPC. 생성자에서 덮어쓸 수 있다. */
export const TTL_AMM_DEFAULT_RPC_URL = 'https://rpc.ttl1.top';

/** 기본 슬리피지 50bps = 0.5%. ZION AMM 클라이언트와 같은 값 — 지갑 UX 일관성. */
export const TTL_AMM_DEFAULT_SLIPPAGE_BPS = 50;

/**
 * 네이티브 TTL 을 가리키는 센티널. TTL 은 ERC-20 이 아니라 주소가 없으므로
 * quote / buildSwapCall 에 이 값을 넘긴다. 견적 수학에서는 WTTL 로 취급되고
 * (Router 가 wrap/unwrap 을 대신 한다), calldata 단계에서만
 * Native 변형(swapExactNativeForTokens 등)으로 갈라진다.
 */
export const TTL_AMM_NATIVE = 'native';

// ── 수수료 상수 유도 ────────────────────────────────────────────────────────
// 반드시 types.ts 의 TTL_AMM_FEE_BPS 에서 유도한다. 9967 을 여기 다시 적으면
// 수수료를 바꿀 때 두 곳이 어긋나는 사고가 난다 (컨트랙트-클라이언트 불일치는
// 견적이 조용히 틀리는 최악의 버그다).
const FEE_DENOM = 10000n;
const FEE_NUM = FEE_DENOM - BigInt(TTL_AMM_FEE_BPS); // 33bps → 9967

// ── ABI — Uniswap V2 표준 시그니처, ETH→Native 이름만 관례대로 치환 ─────────
// 컨트랙트 에이전트와 병렬 작업이라 시그니처가 어긋날 수 있다. 여기 쓴 것이
// 전부이니 배포 전 대조할 것 (보고서에도 명시).
const FACTORY_ABI = parseAbi([
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
]);

const PAIR_ABI = parseAbi([
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
]);

const ROUTER_ABI = parseAbi([
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
  'function swapExactNativeForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline) payable returns (uint256[] amounts)',
  'function swapExactTokensForNative(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline) returns (uint256[] amounts)',
]);

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 value) returns (bool)',
]);

type Hex = `0x${string}`;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** EVM 주소 형식 검사. 체크섬까지는 보지 않는다 — 형식만 어긋나도 즉시 실패가 목적. */
function isAddress(value: string): value is Hex {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** 대소문자 무시 주소 비교. 체인이 체크섬 표기로 돌려줘도 어긋나지 않게. */
function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * V2 getAmountOut — 수수료 반영 상수곱, 전 과정 bigint 바닥 나눗셈.
 *   amountOut = (amountIn × 9967 × reserveOut) / (reserveIn × 10000 + amountIn × 9967)
 * 온체인 Router 의 계산과 자릿수 하나까지 같아야 minAmountOut 이 의미가 있다.
 */
function getAmountOut(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const inWithFee = amountIn * FEE_NUM;
  return (inWithFee * reserveOut) / (reserveIn * FEE_DENOM + inWithFee);
}

/** 수수료 0 가정의 상수곱 — feeEst(수수료가 깎아간 양) 추정에만 쓴다. */
function getAmountOutNoFee(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  return (amountIn * reserveOut) / (reserveIn + amountIn);
}

/**
 * quote() 의 실제 반환형. 고정 계약 TtlAmmQuote 에 입·출력 토큰만 얹었다 —
 * TtlAmmQuote 필드는 그대로라 계약을 깨지 않으면서, buildSwapCall 이 출력이
 * 네이티브인지(swapExactTokensForNative) 견적만 보고 판단할 수 있게 한다.
 * (route 만으로는 "WTTL 로 받기"와 "네이티브로 받기"를 구분할 수 없다.)
 */
export interface TtlAmmRouteQuote extends TtlAmmQuote {
  /** 견적의 입력 토큰 — TTL_AMM_NATIVE 또는 ERC-20 주소 (넘긴 표기 그대로). */
  tokenIn: string;
  /** 견적의 출력 토큰 — TTL_AMM_NATIVE 또는 ERC-20 주소 (넘긴 표기 그대로). */
  tokenOut: string;
}

export interface TtlAmmClientOptions {
  /** JSON-RPC 엔드포인트. 기본은 TTL 공개 RPC. */
  rpcUrl?: string;
  /** Factory 컨트랙트 주소. 배포 후 채워진다 — 없으면 생성자에서 실패. */
  factory: string;
  /** Router 컨트랙트 주소. */
  router: string;
  /** WTTL(래핑된 네이티브) 주소. 모든 풀의 허브 축. */
  wttl: string;
  /** 테스트 주입용 fetch. */
  fetch?: typeof fetch;
  /** 기본 슬리피지(bps). 생략 시 50. */
  slippageBps?: number;
}

/** JSON-RPC 응답 최소 형태. */
interface JsonRpcResponse {
  id?: number | string | null;
  result?: Hex;
  error?: { code: number; message: string };
}

/**
 * 동시성 상한 map. 순서는 입력 순서대로 보존한다.
 * 하나가 던지면 전체가 거부된다 — listPools 의 기존 Promise.all 의미와 같다.
 */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i]!);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

/**
 * TTL 체인 AMM 클라이언트. 무상태 — 화면에서 렌더마다 만들어도 안전하다.
 * 사용감은 ZionAmmClient 와 같은 3단: listPools → quote → build*.
 */
export class TtlAmmClient {
  readonly rpcUrl: string;
  readonly factory: Hex;
  readonly router: Hex;
  readonly wttl: Hex;
  readonly slippageBps: number;
  private readonly fetcher: typeof fetch;
  private rpcId = 1;

  constructor(opts: TtlAmmClientOptions) {
    // 컨트랙트가 아직 배포 전이므로 빈 문자열이 흘러들 수 있다.
    // 여기서 막지 않으면 eth_call 이 알 수 없는 형태로 실패한다.
    this.factory = requireAddress(opts.factory, 'factory');
    this.router = requireAddress(opts.router, 'router');
    this.wttl = requireAddress(opts.wttl, 'wttl');
    this.rpcUrl = opts.rpcUrl ?? TTL_AMM_DEFAULT_RPC_URL;
    const slip = opts.slippageBps ?? TTL_AMM_DEFAULT_SLIPPAGE_BPS;
    if (!Number.isInteger(slip) || slip < 0 || slip > 10000) {
      throw new Error(`ttl-amm: slippageBps 는 [0, 10000] 정수여야 한다 (받은 값: ${slip})`);
    }
    this.slippageBps = slip;
    // 전역 fetch 를 직접 잡아두면 브라우저에서 this 바인딩 문제가 날 수 있어 감싼다.
    this.fetcher = opts.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  // ── 1단: 풀 읽기 ─────────────────────────────────────────────────────────

  /**
   * 토큰 주소 목록 → 각각의 WTTL 페어 스냅샷.
   * getPair 가 zero address 를 돌려주는 토큰(풀 미생성)은 조용히 제외한다 —
   * 66종을 단계 시딩하는 설계상 "풀 없음"은 오류가 아니라 정상 상태다.
   * 반면 RPC 자체의 실패는 그대로 던진다 — 빈 목록으로 위장하지 않는다.
   */
  async listPools(tokens: string[]): Promise<TtlAmmPool[]> {
    // 동시성 상한 — 66 종이면 eth_call ~194 건이다. 전부 동시에 쏘면 TTL RPC
    // (프록시)가 burst 에서 응답을 섞는 것을 실측했다 (창세 배포 때 send 응답에
    // 직전 estimateGas 값이 온 사례). 8 개 창으로 흘려보낸다.
    const snapshots = await mapLimit(
      tokens,
      8,
      async (token): Promise<TtlAmmPool | undefined> => {
        const tokenAddr = requireAddress(token, `listPools token '${token}'`);
        const pair = await this.readPairAddress(tokenAddr);
        if (pair === undefined) return undefined;
        return this.readPool(pair, tokenAddr);
      },
    );
    return snapshots.filter((p): p is TtlAmmPool => p !== undefined);
  }

  /** Factory.getPair(WTTL, token). zero address → 풀 없음(undefined). */
  private async readPairAddress(token: Hex): Promise<Hex | undefined> {
    const data = encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: 'getPair',
      args: [this.wttl, token],
    });
    const raw = await this.ethCall(this.factory, data);
    const pair = decodeFunctionResult({
      abi: FACTORY_ABI,
      functionName: 'getPair',
      data: raw,
    });
    return sameAddress(pair, ZERO_ADDRESS) ? undefined : pair;
  }

  /**
   * Pair 의 getReserves + token0 을 읽어 WTTL/토큰 방향을 맞춘 스냅샷.
   * V2 는 주소 정렬로 token0 을 정하지만, 정렬 규칙을 클라이언트가 재현해
   * 가정하는 대신 token0() 을 직접 읽는다 — eth_call 하나 값으로 가정 하나를
   * 지우는 거래는 남는 장사다 (병렬 제작 중인 컨트랙트와 어긋날 여지 축소).
   */
  private async readPool(pair: Hex, token: Hex): Promise<TtlAmmPool> {
    const [reservesRaw, token0Raw] = await Promise.all([
      this.ethCall(
        pair,
        encodeFunctionData({ abi: PAIR_ABI, functionName: 'getReserves' }),
      ),
      this.ethCall(
        pair,
        encodeFunctionData({ abi: PAIR_ABI, functionName: 'token0' }),
      ),
    ]);
    const [reserve0, reserve1] = decodeFunctionResult({
      abi: PAIR_ABI,
      functionName: 'getReserves',
      data: reservesRaw,
    });
    const token0 = decodeFunctionResult({
      abi: PAIR_ABI,
      functionName: 'token0',
      data: token0Raw,
    });
    const wttlIsToken0 = sameAddress(token0, this.wttl);
    if (!wttlIsToken0 && !sameAddress(token0, token)) {
      // 페어가 우리가 물어본 두 토큰과 다른 것을 물고 있다 — Factory 구현이
      // 예상과 다르다는 신호이므로 조용히 넘기지 않는다.
      throw new Error(
        `ttl-amm: 페어 ${pair} 의 token0(${token0})이 WTTL 도 ${token} 도 아니다`,
      );
    }
    return {
      pair,
      tokenTtl: this.wttl,
      token,
      reserveTtl: wttlIsToken0 ? reserve0 : reserve1,
      reserveToken: wttlIsToken0 ? reserve1 : reserve0,
    };
  }

  // ── 2단: 견적 (순수 함수) ────────────────────────────────────────────────

  /**
   * 상수곱 견적. RPC 를 부르지 않는다 — pools 는 listPools 의 스냅샷이다.
   *
   * 경로는 허브 구조상 자동으로 정해진다:
   *   - 한쪽이 WTTL(또는 네이티브 TTL) → 1홉
   *   - 둘 다 t{XXX} → 2홉 (tIn → WTTL → tOut), 홉마다 33bps 를 정확히 누적
   *     (첫 홉의 바닥 나눗셈 출력이 그대로 둘째 홉 입력 — 온체인 Router 와 동일)
   *
   * 풀이 없거나 준비금이 0이면 던진다. 0 이나 추정치를 지어내면 화면이
   * "0 받음"을 정상 견적처럼 그리게 된다 — 실패가 정직하다.
   */
  quote(
    pools: TtlAmmPool[],
    tokenIn: string,
    amountIn: bigint,
    tokenOut: string,
    slippageBpsOverride?: number,
  ): TtlAmmRouteQuote {
    if (amountIn <= 0n) {
      throw new Error('ttl-amm: amountIn 은 양수여야 한다');
    }
    // 네이티브 TTL 은 견적 수학에서 WTTL 과 동일하다 (Router 가 wrap 을 대신).
    const inAddr = sameAddress(tokenIn, TTL_AMM_NATIVE) ? this.wttl : tokenIn;
    const outAddr = sameAddress(tokenOut, TTL_AMM_NATIVE) ? this.wttl : tokenOut;
    if (sameAddress(inAddr, outAddr)) {
      throw new Error(
        'ttl-amm: 입력과 출력이 같다 — WTTL↔네이티브 TTL 은 스왑이 아니라 wrap/unwrap 이다',
      );
    }

    const slip = BigInt(slippageBpsOverride ?? this.slippageBps);
    if (slip < 0n || slip > 10000n) {
      throw new Error('ttl-amm: slippageBps 는 [0, 10000] 이어야 한다');
    }

    let route: TtlAmmPool[];
    let amountOutEst: bigint;
    let noFeeOut: bigint; // 수수료 0 가정의 출력 — feeEst 산출용

    if (sameAddress(inAddr, this.wttl)) {
      // 1홉: WTTL → token
      const pool = this.requirePool(pools, outAddr);
      route = [pool];
      amountOutEst = getAmountOut(amountIn, pool.reserveTtl, pool.reserveToken);
      noFeeOut = getAmountOutNoFee(amountIn, pool.reserveTtl, pool.reserveToken);
    } else if (sameAddress(outAddr, this.wttl)) {
      // 1홉: token → WTTL
      const pool = this.requirePool(pools, inAddr);
      route = [pool];
      amountOutEst = getAmountOut(amountIn, pool.reserveToken, pool.reserveTtl);
      noFeeOut = getAmountOutNoFee(amountIn, pool.reserveToken, pool.reserveTtl);
    } else {
      // 2홉: tIn → WTTL → tOut. 두 풀 모두 있어야 하고, 중간 출력이 0 이면
      // 둘째 홉이 성립하지 않으므로 여기서 끊는다.
      const first = this.requirePool(pools, inAddr);
      const second = this.requirePool(pools, outAddr);
      route = [first, second];
      const mid = getAmountOut(amountIn, first.reserveToken, first.reserveTtl);
      if (mid <= 0n) {
        throw new Error(
          `ttl-amm: 첫 홉(${first.pair}) 출력이 0 — 입력이 너무 작거나 풀이 너무 얕다`,
        );
      }
      amountOutEst = getAmountOut(mid, second.reserveTtl, second.reserveToken);
      const midNoFee = getAmountOutNoFee(amountIn, first.reserveToken, first.reserveTtl);
      noFeeOut = getAmountOutNoFee(midNoFee, second.reserveTtl, second.reserveToken);
    }

    if (amountOutEst <= 0n) {
      throw new Error('ttl-amm: 견적 출력이 0 — 입력이 너무 작거나 풀이 너무 얕다');
    }

    return {
      amountOutEst,
      minAmountOut: (amountOutEst * (10000n - slip)) / 10000n,
      route,
      // 수수료 합 추정 = (수수료 0 가정 출력) − (실제 출력). 홉마다 수수료가
      // 다른 토큰(입력 토큰)으로 떼이므로, 단위를 섞어 더하는 대신 "출력
      // 토큰으로 환산했을 때 얼마를 잃었나"로 표현한다 — 화면에 보여줄 값이다.
      feeEst: noFeeOut - amountOutEst,
      tokenIn,
      tokenOut,
    };
  }

  // ── 3단: calldata ────────────────────────────────────────────────────────

  /**
   * 견적 → Router calldata.
   *
   * 세 변형 (V2 Router02 표준, ETH→Native 이름만 관례):
   *   - 네이티브 TTL 입력  → swapExactNativeForTokens + value=amountIn
   *   - 네이티브 TTL 출력  → swapExactTokensForNative
   *   - 그 외 토큰↔토큰    → swapExactTokensForTokens
   *
   * 주의 — ERC-20 입력이면 Router 가 transferFrom 으로 당겨가므로 스왑 전에
   * approve 가 선행돼야 한다. 화면은 needsApprove() 로 2단(approve → swap)
   * 여부를 판단하고 buildApproveCall() 의 calldata 를 먼저 보내라.
   */
  buildSwapCall(
    quote: TtlAmmRouteQuote,
    tokenIn: string,
    amountIn: bigint,
    recipient: string,
    deadline: bigint,
  ): TtlAmmSwapCall {
    if (amountIn <= 0n) {
      throw new Error('ttl-amm: amountIn 은 양수여야 한다');
    }
    if (deadline <= 0n) {
      throw new Error('ttl-amm: deadline 은 양의 unix 초여야 한다');
    }
    const to = requireAddress(recipient, 'recipient');
    if (!sameAddress(tokenIn, quote.tokenIn)) {
      // 견적과 다른 토큰으로 calldata 를 만들면 경로·최소수령량이 전부
      // 어긋난 채 체인에 나간다 — 여기서 잡는다.
      throw new Error(
        `ttl-amm: tokenIn(${tokenIn})이 견적의 tokenIn(${quote.tokenIn})과 다르다`,
      );
    }
    if (quote.route.length === 0) {
      throw new Error('ttl-amm: 견적의 route 가 비어 있다');
    }

    const nativeIn = sameAddress(tokenIn, TTL_AMM_NATIVE);
    const nativeOut = sameAddress(quote.tokenOut, TTL_AMM_NATIVE);
    const path = this.buildPath(quote.route, nativeIn ? this.wttl : tokenIn);

    if (nativeIn) {
      return {
        to: this.router,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactNativeForTokens',
          args: [quote.minAmountOut, path, to, deadline],
        }),
        value: amountIn, // 네이티브 입력은 msg.value 로 실린다
      };
    }
    if (nativeOut) {
      return {
        to: this.router,
        data: encodeFunctionData({
          abi: ROUTER_ABI,
          functionName: 'swapExactTokensForNative',
          args: [amountIn, quote.minAmountOut, path, to, deadline],
        }),
        value: 0n,
      };
    }
    return {
      to: this.router,
      data: encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'swapExactTokensForTokens',
        args: [amountIn, quote.minAmountOut, path, to, deadline],
      }),
      value: 0n,
    };
  }

  /**
   * ERC-20 approve(router, amount) calldata. 스왑과 같은 TtlAmmSwapCall
   * 형태로 돌려준다 — to 가 Router 가 아니라 토큰 컨트랙트라는 점만 다르고,
   * 지갑의 서명·브로드캐스트 경로(TransferIntent)는 완전히 동일하기 때문이다.
   */
  buildApproveCall(token: string, amount: bigint): TtlAmmSwapCall {
    const tokenAddr = requireAddress(token, 'approve token');
    if (amount < 0n) {
      throw new Error('ttl-amm: approve amount 는 음수일 수 없다');
    }
    return {
      to: tokenAddr,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [this.router, amount],
      }),
      value: 0n,
    };
  }

  /**
   * 이 입력 토큰으로 스왑하려면 approve 선행이 필요한가.
   * 네이티브 TTL 만 예외(값이 msg.value 로 실림) — 나머지 전부 ERC-20 이라
   * Router 의 transferFrom 을 위해 allowance 가 있어야 한다. 화면이 이 값으로
   * approve → swap 2단 UI 를 켠다. (기존 allowance 확인은 화면 몫.)
   */
  needsApprove(tokenIn: string): boolean {
    return !sameAddress(tokenIn, TTL_AMM_NATIVE);
  }

  // ── 내부 ─────────────────────────────────────────────────────────────────

  /** pools 에서 WTTL/token 풀을 찾는다. 없거나 준비금 0 이면 던진다. */
  private requirePool(pools: TtlAmmPool[], token: string): TtlAmmPool {
    const found = pools.find((p) => sameAddress(p.token, token));
    if (!found) {
      throw new Error(`ttl-amm: WTTL/${token} 풀이 없다 — 견적 불가`);
    }
    if (!sameAddress(found.tokenTtl, this.wttl)) {
      // 다른 클라이언트(다른 WTTL)의 풀이 섞여 들어온 경우 — 수학이 성립 안 한다.
      throw new Error(
        `ttl-amm: 풀 ${found.pair} 의 tokenTtl(${found.tokenTtl})이 이 클라이언트의 WTTL(${this.wttl})과 다르다`,
      );
    }
    if (found.reserveTtl <= 0n || found.reserveToken <= 0n) {
      throw new Error(`ttl-amm: 풀 ${found.pair} 준비금이 0 — 견적 불가`);
    }
    return found;
  }

  /** route 를 따라 스왑 경로(주소 배열)를 만든다. 시작점에서 홉마다 반대편으로. */
  private buildPath(route: TtlAmmPool[], start: string): Hex[] {
    const path: Hex[] = [requireAddress(start, 'path start')];
    let current = start;
    for (const pool of route) {
      const next = sameAddress(current, pool.tokenTtl)
        ? pool.token
        : sameAddress(current, pool.token)
          ? pool.tokenTtl
          : undefined;
      if (next === undefined) {
        throw new Error(
          `ttl-amm: 경로 불일치 — ${current} 는 풀 ${pool.pair} 의 어느 쪽도 아니다`,
        );
      }
      path.push(requireAddress(next, 'path hop'));
      current = next;
    }
    return path;
  }

  /** JSON-RPC eth_call. HTTP 실패·RPC error·빈 응답 모두 명확히 던진다. */
  private async ethCall(to: Hex, data: Hex): Promise<Hex> {
    const id = this.rpcId++;
    const res = await this.fetcher(this.rpcUrl, {
      method: 'POST',
      // connection: close — 이 RPC 프록시는 keep-alive 재사용 연결에서 응답을
      // 섞는다 (실측). 브라우저 fetch 는 이 헤더를 무시하므로(금지 헤더) 거기서는
      // 아래 id 검증이 방어선이다.
      headers: { 'content-type': 'application/json', connection: 'close' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
      }),
    });
    if (!res.ok) {
      throw new Error(`ttl-amm: RPC HTTP ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as JsonRpcResponse;
    // 섞인 응답 검출 — 다른 요청의 결과를 이 호출의 결과로 쓰면 견적이 다른
    // 풀의 준비금으로 계산될 수 있다. 조용히 틀리느니 시끄럽게 실패한다.
    if (json.id !== undefined && json.id !== id) {
      throw new Error(
        `ttl-amm: RPC 응답이 섞였다 (보낸 id ${id}, 받은 id ${String(json.id)})`,
      );
    }
    if (json.error) {
      throw new Error(
        `ttl-amm: eth_call 실패 — ${json.error.message} (code ${json.error.code})`,
      );
    }
    if (typeof json.result !== 'string' || json.result === '0x') {
      // '0x' 는 대상 주소에 코드가 없다는 뜻일 가능성이 크다 — 배포 전
      // 주소를 잘못 넣은 경우가 여기서 걸린다.
      throw new Error(
        `ttl-amm: eth_call 빈 응답 (${to}) — 주소에 컨트랙트가 없을 수 있다`,
      );
    }
    return json.result;
  }
}

/** 주소 필수 검사 — 배포 전 빈 값이 흘러드는 것을 생성자·입력 단계에서 차단. */
function requireAddress(value: string | undefined, label: string): Hex {
  if (value === undefined || value === '') {
    throw new Error(
      `ttl-amm: ${label} 주소가 설정되지 않았다 — 컨트랙트 배포 후 주소를 넣어라`,
    );
  }
  if (!isAddress(value)) {
    throw new Error(`ttl-amm: ${label} 주소 형식이 아니다 (받은 값: '${value}')`);
  }
  return value;
}
