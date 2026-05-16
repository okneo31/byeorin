// coingecko.ts — 익명 CoinGecko simple/price 호출 + 60초 메모리 캐시.
//
// 익명 한도가 분당 ~50회로 빠듯하기 때문에 모든 호출은 (id, vsCurrency) 단위
// 로 캐시된다. 캐시는 in-memory (프로세스 한정) — UI 가 wallet-sdk 를
// re-instantiate 해도 같은 모듈 인스턴스를 공유하므로 효과적이다.
//
// TTL native 같이 CoinGecko 에 없는 자산은 어떤 입력이든 null 을 반환한다.
// 호출자는 null 을 정상 결과로 취급하고 단순히 가격 라벨을 숨긴다.
//
// 의도적으로 fetch 를 옵션으로 받는다 — 테스트에서 가짜 fetch 로 가격 변동
// 과 캐시 만료를 검증한다.

const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price';
const TTL_MS = 60_000;

export interface PriceClientOptions {
  /** custom fetch (테스트용). 미지정 시 globalThis.fetch. */
  fetch?: typeof fetch;
  /** 캐시 유효시간 override. 기본 60_000ms. 테스트에서만 만지자. */
  cacheTtlMs?: number;
  /** 시간 소스 — Date.now() 기본. 테스트에서 monotonic clock 모킹용. */
  now?: () => number;
}

interface CacheEntry {
  value: number | null;
  expiresAt: number;
}

export class CoinGeckoPriceClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<number | null>>();
  private readonly fetchImpl: typeof fetch;
  private readonly ttl: number;
  private readonly now: () => number;

  constructor(opts: PriceClientOptions = {}) {
    this.fetchImpl =
      opts.fetch ?? (globalThis.fetch?.bind(globalThis) as typeof fetch);
    this.ttl = opts.cacheTtlMs ?? TTL_MS;
    this.now = opts.now ?? (() => Date.now());
  }

  /**
   * (coingeckoId, vsCurrency) 가격 조회.
   *
   * @param id          CoinGecko 코인 ID (예: "usd-coin"). 빈 문자열은 null.
   * @param vsCurrency  기본 'usd'. 'krw' 도 지원.
   * @returns           해당 코인이 CoinGecko 에 없거나 network fail 시 null.
   */
  async getPrice(id: string, vsCurrency: string = 'usd'): Promise<number | null> {
    if (!id) return null;
    const key = `${id}|${vsCurrency}`;
    const now = this.now();

    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > now) {
      return hit.value;
    }

    // 동일 키에 대한 동시 요청은 같은 promise 를 공유한다 — race 조건에서
    // rate-limit 을 두 번 쓰지 않도록.
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const p = this.fetchPrice(id, vsCurrency).then(
      (val) => {
        this.cache.set(key, { value: val, expiresAt: this.now() + this.ttl });
        this.inflight.delete(key);
        return val;
      },
      (err) => {
        this.inflight.delete(key);
        throw err;
      },
    );
    this.inflight.set(key, p);
    return p;
  }

  /** 테스트/로그용 — 캐시를 전부 비운다. */
  clearCache(): void {
    this.cache.clear();
  }

  private async fetchPrice(
    id: string,
    vsCurrency: string,
  ): Promise<number | null> {
    if (!this.fetchImpl) return null;
    const url = `${ENDPOINT}?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(vsCurrency)}`;
    let res;
    try {
      res = await this.fetchImpl(url, { headers: { accept: 'application/json' } });
    } catch {
      return null;
    }
    if (!res.ok) return null;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return null;
    }
    if (!json || typeof json !== 'object') return null;
    const obj = json as Record<string, Record<string, number>>;
    const inner = obj[id];
    if (!inner) return null;
    const val = inner[vsCurrency];
    return typeof val === 'number' ? val : null;
  }
}

// 편의용 싱글톤 — UI 가 별도 인스턴스화 없이 import 만으로 캐시를 공유한다.
let _shared: CoinGeckoPriceClient | null = null;
export function sharedPriceClient(): CoinGeckoPriceClient {
  if (!_shared) _shared = new CoinGeckoPriceClient();
  return _shared;
}

/**
 * 짧은 헬퍼 — 싱글톤을 통해 즉시 가격 1개 조회.
 *
 * @example
 *   const price = await getPrice('usd-coin', 'usd');  // 1.0
 *   const ttl   = await getPrice('ttl', 'usd');       // 보통 null
 */
export async function getPrice(
  id: string,
  vsCurrency: string = 'usd',
): Promise<number | null> {
  return sharedPriceClient().getPrice(id, vsCurrency);
}
