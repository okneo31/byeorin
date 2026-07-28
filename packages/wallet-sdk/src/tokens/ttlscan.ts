// ttlscan.ts — TTL Scan 이 발행 목록으로 들고 있는 토큰을 가져온다.
//
// 왜 필요한가: 토큰 레지스트리는 코드에 박힌 BUILTIN 목록이다. TTL 에 새 토큰이
// 발행되면 지갑을 새로 배포해야 보인다. 실제로 스테이블 66 종이 발행됐는데
// 지갑에는 하나도 안 보였다.
//
// 그래서 체인이 이미 들고 있는 목록을 그대로 읽는다. 사용자가 토큰 주소를 손으로
// 넣어야 할 이유가 없다 — 발행 사실은 이미 공개돼 있다.
//
// 신뢰 경계: 이 API 는 **무엇을 조회할지**만 정한다. 잔액은 여기서 안 받고
// 반드시 체인에서 balanceOf 로 읽는다. 익스플로러가 거짓 목록을 주면 있지도 않은
// 토큰을 조회해 0 이 나올 뿐이고, 잔액을 부풀릴 수는 없다. 그래서 이 목록을
// 신뢰하는 것과 잔액을 신뢰하는 것은 다른 문제다.

import type { Address } from '../types.js';
import type { TokenInfo } from './registry.js';

/** TTL Scan `/api/tokens` 응답의 한 행. 우리가 쓰는 필드만 좁게 적는다. */
interface TtlScanTokenRow {
  address?: string;
  symbol?: string;
  name?: string;
  decimals?: number;
}

interface TtlScanTokensResponse {
  tokens?: TtlScanTokenRow[];
  total?: number;
}

export interface FetchTtlScanTokensOptions {
  /** 호출자가 주입한 fetch (테스트). 미지정 시 globalThis.fetch. */
  fetch?: typeof fetch;
  /** API base. 기본 `https://scan.ttl1.top/api`. */
  apiUrl?: string;
  /** 한 번에 받을 최대 개수. 기본 500 — 현재 66 종이라 넉넉하다. */
  limit?: number;
  /** 응답 대기 상한(ms). 기본 8000. 지갑 첫 화면을 막으면 안 된다. */
  timeoutMs?: number;
}

const DEFAULT_API = 'https://scan.ttl1.top/api';

/** 0x + 40 hex 만 통과. 익스플로러가 이상한 값을 줘도 레지스트리를 오염시키지 않는다. */
function isEvmAddress(v: unknown): v is string {
  return typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
}

/**
 * TTL Scan 의 토큰 목록을 TokenInfo[] 로 가져온다.
 *
 * 실패(네트워크/타임아웃/형식 불일치)하면 **던지지 않고 빈 배열**을 준다.
 * 토큰 목록은 부가 정보라, 이것 때문에 지갑이 안 열리면 안 된다. 호출자는
 * 빈 배열을 "빌트인만 쓴다" 로 해석하면 된다.
 */
export async function fetchTtlScanTokens(
  opts: FetchTtlScanTokensOptions = {},
): Promise<TokenInfo[]> {
  const f = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
  if (!f) return [];

  const base = (opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, '');
  const url = `${base}/tokens?limit=${opts.limit ?? 500}`;

  // AbortController 로 소켓까지 실제로 끊는다. Promise.race 만 쓰면 요청은
  // 계속 살아 있어 모바일에서 배터리와 소켓을 잡아먹는다.
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 8000);
  try {
    const res = await f(url, {
      headers: { accept: 'application/json' },
      signal: ctl.signal,
    });
    if (!res.ok) return [];
    const body = (await res.json()) as TtlScanTokensResponse;
    if (!body || !Array.isArray(body.tokens)) return [];

    const out: TokenInfo[] = [];
    const seen = new Set<string>();
    for (const r of body.tokens) {
      if (!isEvmAddress(r?.address)) continue;
      const key = r.address.toLowerCase();
      if (seen.has(key)) continue;
      // decimals 는 반드시 정수여야 한다. 틀리면 잔액이 자릿수째로 어긋난다 —
      // 추측해서 18 을 넣느니 그 항목을 버린다.
      if (!Number.isInteger(r.decimals) || (r.decimals as number) < 0) continue;
      const symbol = typeof r.symbol === 'string' && r.symbol.length > 0 ? r.symbol : '?';
      seen.add(key);
      out.push({
        address: r.address as Address,
        symbol,
        name: typeof r.name === 'string' && r.name.length > 0 ? r.name : symbol,
        decimals: r.decimals as number,
        // 코드에 박힌 것이 아니라 밖에서 받아온 목록임을 표시한다.
        custom: true,
      });
    }
    return out;
  } catch {
    // abort 포함. 목록을 못 받아도 지갑은 빌트인으로 계속 동작한다.
    return [];
  } finally {
    clearTimeout(timer);
  }
}
