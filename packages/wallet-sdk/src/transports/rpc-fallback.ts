// rpc-fallback.ts — 읽기 전용 JSON-RPC 다중 엔드포인트 fallback 유틸.
//
// 왜 별도 파일인가:
//   체인별 어댑터(solana/evm/...)가 공유할 수 있는 순수 로직이고,
//   어댑터 파일 안에 두면 "읽기는 fallback / 쓰기는 단일" 경계가 흐려진다.
//   여기 있는 함수는 **읽기 경로에서만** 호출한다는 것이 규약이다.
//
// 주의: 이 모듈은 트랜잭션 브로드캐스트에 쓰면 안 된다.
//   Solana 는 `recentBlockhash` 를 특정 엔드포인트에서 받아오고, 그 blockhash 가
//   유효한 슬롯 범위 안에 있는 노드로 보내야 한다. A 에서 blockhash 를 받고
//   B 로 보내면 노드 간 슬롯 지연 때문에 BlockhashNotFound 로 거절되거나,
//   최악의 경우 재시도 과정에서 같은 tx 가 두 번 제출될 수 있다.
//   → 쓰기(및 쓰기에 딸린 blockhash 조회)는 항상 단일 엔드포인트.

/** fallback 도중 실패한 엔드포인트 1건의 기록. */
export interface RpcAttempt {
  readonly url: string;
  readonly error: unknown;
}

/** 후보 엔드포인트 하나 — URL 과 그 URL 에 묶인 클라이언트. */
export interface RpcEndpoint<TClient> {
  readonly url: string;
  readonly client: TClient;
}

/**
 * 모든 엔드포인트가 실패했을 때 던지는 에러.
 *
 * message 에 시도한 URL 을 순서대로 모두 남긴다 — 어떤 provider 가 죽었는지
 * 사용자 리포트만 보고 판별할 수 있어야 하기 때문.
 * `cause` 는 **마지막** 실패 에러(요구사항: "마지막 에러를 던지되").
 */
export class AllRpcEndpointsFailedError extends Error {
  readonly attempts: readonly RpcAttempt[];

  constructor(label: string, attempts: readonly RpcAttempt[]) {
    const detail = attempts
      .map((a) => `  - ${a.url}: ${describeError(a.error)}`)
      .join('\n');
    const last = attempts[attempts.length - 1];
    super(
      `${label}: ${attempts.length}개 RPC 엔드포인트가 모두 실패했습니다.\n${detail}`,
      last ? { cause: last.error } : undefined,
    );
    this.name = 'AllRpcEndpointsFailedError';
    this.attempts = attempts;
  }
}

/** 타임아웃으로 중단된 호출. fallback 판정에서 "재시도 대상"이다. */
export class RpcTimeoutError extends Error {
  readonly url: string;
  readonly timeoutMs: number;

  constructor(url: string, timeoutMs: number) {
    super(`RPC 응답 없음 (${timeoutMs}ms 초과): ${url}`);
    this.name = 'RpcTimeoutError';
    this.url = url;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 재시도하면 안 되는 실패인가?
 *
 * 실패 판정 기준 (요구사항: 타임아웃 / HTTP 에러 / RPC 에러 구분):
 *   재시도(= 다음 엔드포인트로 fallback) 하는 것:
 *     - 타임아웃 / abort            → RpcTimeoutError
 *     - 네트워크·DNS·CORS 실패      → fetch 가 던지는 TypeError
 *     - HTTP 4xx/5xx               → web3.js 가 `Error: 429 Too Many Requests...`
 *                                     형태로 던진다 (OnFinality 무키 호출이 이 경우)
 *     - provider 고유 JSON-RPC 에러 → dRPC 의 `code: 35 chain is not available on
 *                                     free plan`, OnFinality 의 `-32029` 등.
 *                                     엔드포인트마다 다르므로 반드시 재시도한다.
 *   재시도하지 않고 즉시 던지는 것:
 *     - JSON-RPC 표준 "요청이 잘못됨" 코드 (-32700, -32600, -32601, -32602).
 *       잘못된 주소 같은 입력 오류는 어느 엔드포인트로 보내도 똑같이 실패하므로,
 *       3번 재시도하면 타임아웃 예산만 3배로 태우고 사용자만 기다리게 된다.
 *   -32603(internal error) 과 -32000..-32099(server error) 는 노드 쪽 문제라
 *   재시도 대상에 남긴다.
 */
export function isNonRetryableRpcError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== 'number') return false;
  return (
    code === -32700 || code === -32600 || code === -32601 || code === -32602
  );
}

export interface FallbackOptions {
  /** 엔드포인트 1곳당 허용 시간(ms). 초과하면 RpcTimeoutError 후 다음으로. */
  readonly timeoutMs: number;
  /** 에러 메시지 접두사. 예: 'solana getBalance'. */
  readonly label: string;
  /** 실패 관찰용 훅 (로깅/테스트). 던져도 fallback 을 막지 않는다. */
  readonly onAttemptFailed?: (attempt: RpcAttempt) => void;
}

/**
 * 엔드포인트를 **순서대로** 시도한다. 첫 성공에서 즉시 반환.
 *
 * 병렬(Promise.any)이 아니라 순차인 이유: 무료 공개 RPC 는 IP 단위 rate-limit
 * 이 빡빡하다. 매 조회마다 3곳을 동시에 때리면 정상 엔드포인트까지 429 로
 * 밀려나서, fallback 이 오히려 가용성을 떨어뜨린다.
 */
export async function callWithFallback<TClient, TResult>(
  endpoints: readonly RpcEndpoint<TClient>[],
  op: (client: TClient, url: string) => Promise<TResult>,
  opts: FallbackOptions,
): Promise<TResult> {
  if (endpoints.length === 0) {
    throw new Error(`${opts.label}: RPC 엔드포인트가 하나도 없습니다.`);
  }

  const attempts: RpcAttempt[] = [];
  for (const ep of endpoints) {
    try {
      return await withTimeout(
        op(ep.client, ep.url),
        opts.timeoutMs,
        ep.url,
      );
    } catch (error) {
      // 입력 자체가 잘못된 요청이면 다른 엔드포인트도 똑같이 실패한다.
      // 그대로 던져서 사용자가 타임아웃 × N 만큼 기다리지 않게 한다.
      if (isNonRetryableRpcError(error)) throw error;
      attempts.push({ url: ep.url, error });
      opts.onAttemptFailed?.({ url: ep.url, error });
    }
  }
  throw new AllRpcEndpointsFailedError(opts.label, attempts);
}

/**
 * 프로미스에 상한 시간을 건다.
 *
 * fetch 쪽 AbortSignal 만으로 부족한 이유: 라이브러리가 소켓 아래에서 자체
 * 재시도/큐잉을 하면(web3.js 의 429 재시도 등) fetch 1회 타임아웃을 지켜도
 * 호출자는 계속 대기한다. 확장 popup 은 이 상태에서 그대로 멈춰버린다.
 * 그래서 "호출 단위" 상한을 한 겹 더 둔다.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  url: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new RpcTimeoutError(url, timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    // 타이머를 반드시 걷는다. 안 걷으면 Node 이벤트 루프가 살아남아
    // 테스트 러너/백그라운드 서비스워커가 종료되지 않는다.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * fetch 에 AbortSignal 기반 타임아웃을 입힌다.
 *
 * `withTimeout` 은 호출자를 풀어줄 뿐 소켓은 그대로 열려 있다. 확장 환경에서
 * 죽은 엔드포인트로 향한 커넥션이 쌓이면 브라우저의 호스트당 커넥션 한도를
 * 먹어버리므로, 전송 계층에서도 실제로 끊어준다.
 */
export function withFetchTimeout(
  baseFetch: typeof fetch,
  timeoutMs: number,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new RpcTimeoutError(String(input), timeoutMs));
    }, timeoutMs);
    try {
      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
