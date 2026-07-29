// exchange/types.ts — 벼린 거래소(TTL 체인 AMM)의 공유 형태.
//
// 설계 원천: docs/EXCHANGE.md (2026-07-29 확정).
//   - 가격은 풀의 수급이 정한다. 벼린 환율은 창세 가격일 뿐이다.
//   - 모든 풀은 WTTL/t{XXX} 허브 — TTL 은 네이티브 코인이라 페어에 직접 못
//     들어가므로 WETH9 계열의 WTTL 로 감싼다. 교차 교환은 라우터 2홉.
//   - 수수료 33bps (스왑당). 상수곱 x·y=k, Uniswap V2 수학에서 수수료 상수만
//     997/1000 → 9967/10000 으로 바뀐다.
//
// 이 파일은 컨트랙트(E-1)·클라이언트(E-4)·화면(E-5)이 같은 모양을 보게 하는
// 고정점이다. 병렬 작업이 서로를 기다리지 않으려면 계약이 먼저 서야 한다.

/** 스왑 수수료 — 만분율. 33 = 0.33%. 컨트랙트와 견적 수학이 같은 값을 써야 한다. */
export const TTL_AMM_FEE_BPS = 33;

/**
 * 한 풀의 스냅샷. Pair 컨트랙트의 getReserves 를 읽은 결과.
 *
 * ZionPool 과 형태를 맞췄다 — 화면이 두 거래소를 같은 코드로 그릴 수 있게.
 */
export interface TtlAmmPool {
  /** Pair 컨트랙트 주소. */
  pair: string;
  /** 항상 WTTL 주소. 허브 강제의 결과다. */
  tokenTtl: string;
  /** 상대 토큰(t{XXX}) 컨트랙트 주소. */
  token: string;
  /** WTTL 쪽 준비금 (wei). */
  reserveTtl: bigint;
  /** 토큰 쪽 준비금 (base unit). */
  reserveToken: bigint;
}

/**
 * 견적. 슬리피지 보호의 최소 수령량까지 포함한다 —
 * 견적과 체결 사이에 풀이 움직이는 것은 정상이고, 그 허용 폭을 사용자가 정한다.
 */
export interface TtlAmmQuote {
  /** 클라이언트 추정 수령량 (base unit). */
  amountOutEst: bigint;
  /** 슬리피지 허용 반영 최소 수령량 — Router 에 넘겨 체인이 강제한다. */
  minAmountOut: bigint;
  /** 이 견적이 지나는 풀 (1홉 = 1개, 교차 = 2개). */
  route: TtlAmmPool[];
  /** 수수료 합 추정 — **출력 토큰의 base unit** (무수수료 출력 − 실제 출력). 2홉은 홉별 수수료 토큰이 달라 이 단위로만 합산이 성립한다. */
  feeEst: bigint;
}

/** Router 호출을 TransferIntent 로 변환한 결과 — 지갑의 기존 서명·브로드캐스트 경로를 그대로 탄다. */
export interface TtlAmmSwapCall {
  /** Router 컨트랙트 주소 (TransferIntent.to). */
  to: string;
  /** 호출 calldata (TransferIntent.data). */
  data: `0x${string}`;
  /** 함께 보낼 네이티브 TTL (wei). 토큰→토큰이면 0n. */
  value: bigint;
}
