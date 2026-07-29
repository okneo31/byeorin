// solana-rpc-fallback.test.ts — 백로그 #26 회귀 방어선.
//
// 핵심 불변식: **읽기는 fallback, 송금은 단일 엔드포인트.**
// 네트워크에 절대 나가지 않는다 — fetch 를 주입해서 URL 별로 응답을 조립한다.

import { describe, expect, it } from 'vitest';
import { PublicKey, Transaction } from '@solana/web3.js';
import { SolanaAdapter } from '../src/index.js';
import { SOLANA_MAINNET_RPC_URLS } from '../src/chains/solana.js';
import type { Signer } from '../src/types.js';

const URL_A = 'https://a.example/rpc';
const URL_B = 'https://b.example/rpc';
const URL_C = 'https://c.example/rpc';

const ADDRESS = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
const RECIPIENT = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
// 32바이트 0 = SystemProgram id. base58 로 유효한 blockhash 형태면 충분하다.
const FAKE_BLOCKHASH = '11111111111111111111111111111111';

type RpcHandler = (method: string, url: string) => unknown;

interface FakeRpc {
  fetch: typeof fetch;
  /** 실제로 요청이 나간 URL 을 순서대로 기록. */
  calls: { url: string; method: string }[];
}

/**
 * URL → 동작 매핑을 받는 가짜 fetch.
 * 핸들러가 던지면 네트워크 실패, 값을 반환하면 JSON-RPC result 로 감싼다.
 */
function makeFakeRpc(handlers: Record<string, RpcHandler>): FakeRpc {
  const calls: { url: string; method: string }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      id?: number;
    };
    const method = body.method ?? '';
    calls.push({ url, method });

    const handler = handlers[url];
    if (!handler) throw new TypeError(`fetch failed: unknown endpoint ${url}`);
    const result = handler(method, url);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** 정상 노드 — 모든 read/write 메서드에 그럴듯한 응답을 준다. */
function healthyHandler(lamports: number, signature: string): RpcHandler {
  return (method) => {
    switch (method) {
      case 'getBalance':
        return { context: { slot: 1 }, value: lamports };
      case 'getLatestBlockhash':
        return {
          context: { slot: 1 },
          value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 100 },
        };
      case 'sendTransaction':
        return signature;
      default:
        return null;
    }
  };
}

/** 항상 죽는 노드. */
const deadHandler: RpcHandler = (_method, url) => {
  throw new TypeError(`fetch failed: ${url}`);
};

/** 응답을 영원히 주지 않는 노드 — 타임아웃 경로 검증용. */
function hangingFetch(): typeof fetch {
  return (async () => new Promise<Response>(() => {})) as typeof fetch;
}

const dummySigner: Signer = {
  curve: 'ed25519',
  publicKey: async () => new PublicKey(ADDRESS).toBytes(),
  sign: async () => new Uint8Array(64),
};

describe('SolanaAdapter — 읽기 fallback', () => {
  it('첫 엔드포인트 실패 → 두 번째에서 성공', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: healthyHandler(42, 'sig'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    await expect(sol.getBalance(ADDRESS)).resolves.toBe(42n);
    // A 를 먼저 때리고, 실패한 뒤에야 B 로 넘어갔다 (순차 시도).
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A, URL_B]);
  });

  it('마지막 엔드포인트까지 내려가서 성공', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: deadHandler,
      [URL_C]: healthyHandler(7, 'sig'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B, URL_C],
      fetch: rpc.fetch,
    });

    await expect(sol.getBalance(ADDRESS)).resolves.toBe(7n);
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A, URL_B, URL_C]);
  });

  it('첫 엔드포인트가 성공하면 나머지는 건드리지 않는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthyHandler(5, 'sig'),
      [URL_B]: healthyHandler(999, 'sig'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    await expect(sol.getBalance(ADDRESS)).resolves.toBe(5n);
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A]);
  });

  it('전부 실패하면 시도한 URL 을 모두 담은 에러를 던진다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: deadHandler,
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    await expect(sol.getBalance(ADDRESS)).rejects.toThrow(
      /RPC 엔드포인트가 모두 실패/,
    );
    await expect(sol.getBalance(ADDRESS)).rejects.toThrow(URL_A);
    await expect(sol.getBalance(ADDRESS)).rejects.toThrow(URL_B);
  });

  it('실패 콜백이 엔드포인트별로 호출된다', async () => {
    const seen: string[] = [];
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: healthyHandler(1, 'sig'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
      onRpcAttemptFailed: (a) => seen.push(a.url),
    });

    await sol.getBalance(ADDRESS);
    expect(seen).toEqual([URL_A]);
  });
});

describe('SolanaAdapter — 타임아웃', () => {
  it('응답 없는 엔드포인트는 readTimeoutMs 후 포기하고 다음으로 넘어간다', async () => {
    const healthy = makeFakeRpc({ [URL_B]: healthyHandler(11, 'sig') });
    // A 는 영원히 pending, B 는 정상.
    const routed = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : String(input);
      if (url === URL_A) return hangingFetch()(input, init);
      return healthy.fetch(input, init);
    }) as typeof fetch;

    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: routed,
      readTimeoutMs: 80,
    });

    const started = Date.now();
    await expect(sol.getBalance(ADDRESS)).resolves.toBe(11n);
    const elapsed = Date.now() - started;
    // 타임아웃이 실제로 걸렸다 (>= 80ms) 그리고 무한 대기하지 않았다.
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('전부 응답이 없으면 타임아웃 에러로 끝난다 (hang 하지 않음)', async () => {
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: hangingFetch(),
      readTimeoutMs: 60,
    });

    await expect(sol.getBalance(ADDRESS)).rejects.toThrow(
      /RPC 엔드포인트가 모두 실패/,
    );
  });

  it('송금 경로도 무한 대기하지 않는다', async () => {
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: hangingFetch(),
      writeTimeoutMs: 60,
    });

    await expect(
      sol.broadcast({ raw: new Uint8Array([1, 2, 3]), signature: 'sig' }),
    ).rejects.toThrow(/응답 없음/);
  });
});

describe('SolanaAdapter — 송금은 단일 엔드포인트 (핵심 회귀 방어선)', () => {
  it('broadcast 는 0번 엔드포인트가 죽어도 다음으로 넘어가지 않는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: healthyHandler(1, 'SHOULD_NOT_BE_USED'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    await expect(
      sol.broadcast({ raw: new Uint8Array([1, 2, 3]), signature: 'sig' }),
    ).rejects.toThrow(/fetch failed/);

    // 두 번째 엔드포인트를 절대 건드리면 안 된다.
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A]);
    expect(rpc.calls.some((c) => c.url === URL_B)).toBe(false);
  });

  it('broadcast 성공 경로도 0번 엔드포인트만 쓴다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthyHandler(1, 'TXSIG_FROM_A'),
      [URL_B]: healthyHandler(1, 'TXSIG_FROM_B'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    await expect(
      sol.broadcast({ raw: new Uint8Array([9]), signature: 'sig' }),
    ).resolves.toBe('TXSIG_FROM_A');
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A]);
  });

  it('buildTransfer 의 getLatestBlockhash 도 fallback 하지 않는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: healthyHandler(1, 'sig'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    // blockhash 를 B 에서 받아오면 broadcast(=A) 와 엔드포인트가 어긋난다.
    // 그래서 A 가 죽으면 buildTransfer 자체가 실패해야 한다.
    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1_000n },
        { signer: dummySigner, sender: ADDRESS },
      ),
    ).rejects.toThrow(/fetch failed/);
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A]);
  });

  it('blockhash 조회와 broadcast 가 같은 엔드포인트로 나간다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthyHandler(1, 'TXSIG_FROM_A'),
      [URL_B]: healthyHandler(1, 'TXSIG_FROM_B'),
      [URL_C]: healthyHandler(1, 'TXSIG_FROM_C'),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B, URL_C],
      fetch: rpc.fetch,
    });

    const unsigned = await sol.buildTransfer(
      { to: RECIPIENT, amount: 1_000n },
      { signer: dummySigner, sender: ADDRESS },
    );
    expect(unsigned.tx).toBeInstanceOf(Transaction);
    expect(unsigned.tx.recentBlockhash).toBe(FAKE_BLOCKHASH);

    await sol.broadcast({ raw: new Uint8Array([1]), signature: 'sig' });

    expect(rpc.calls).toEqual([
      { url: URL_A, method: 'getLatestBlockhash' },
      { url: URL_A, method: 'sendTransaction' },
    ]);
    expect(sol.writeRpcUrl).toBe(URL_A);
  });
});

describe('SolanaAdapter — 옵션 하위 호환', () => {
  it('rpcUrl 단독 지정은 예전처럼 단일 엔드포인트로 동작한다', async () => {
    const rpc = makeFakeRpc({ [URL_A]: healthyHandler(3, 'sig') });
    const sol = new SolanaAdapter({ rpcUrl: URL_A, fetch: rpc.fetch });

    expect(sol.rpcUrls).toEqual([URL_A]);
    expect(sol.writeRpcUrl).toBe(URL_A);
    await expect(sol.getBalance(ADDRESS)).resolves.toBe(3n);
    expect(rpc.calls.map((c) => c.url)).toEqual([URL_A]);
  });

  it('rpcUrl 은 기본 fallback 목록으로 새지 않는다 (몰래 확장 금지)', async () => {
    const rpc = makeFakeRpc({ [URL_A]: deadHandler });
    const sol = new SolanaAdapter({ rpcUrl: URL_A, fetch: rpc.fetch });

    await expect(sol.getBalance(ADDRESS)).rejects.toThrow();
    // publicnode 등 기본 목록으로 절대 넘어가지 않는다.
    expect(rpc.calls.every((c) => c.url === URL_A)).toBe(true);
  });

  it('rpcUrls 가 rpcUrl 보다 우선한다', () => {
    const sol = new SolanaAdapter({
      rpcUrl: URL_C,
      rpcUrls: [URL_A, URL_B],
    });
    expect(sol.rpcUrls).toEqual([URL_A, URL_B]);
    expect(sol.writeRpcUrl).toBe(URL_A);
  });

  it('mainnet-beta 기본값 순서 — publicnode 다음이 공식 RPC 다', () => {
    const sol = new SolanaAdapter();
    expect(sol.rpcUrls).toEqual([
      'https://solana-rpc.publicnode.com',
      // publicnode 는 getTokenAccountsByOwner 를 403 으로 막는다(실측). 토큰
      // 조회를 실제로 받아주는 유일한 무료 엔드포인트가 여기라 2순위로 둔다.
      'https://api.mainnet-beta.solana.com',
      'https://solana.api.onfinality.io/public',
      'https://solana.drpc.org',
    ]);
    expect(sol.writeRpcUrl).toBe('https://solana-rpc.publicnode.com');
  });

  it('devnet/testnet 은 clusterApiUrl 단일 유지', () => {
    const dev = new SolanaAdapter({ network: 'devnet' });
    expect(dev.rpcUrls).toHaveLength(1);
    expect(dev.rpcUrls[0]).toContain('devnet');
  });

  it('빈 rpcUrls 는 기본 목록으로 떨어진다', () => {
    const sol = new SolanaAdapter({ rpcUrls: [] });
    // 개수를 못 박지 않는다 — 엔드포인트 목록은 가용성에 따라 늘고 준다.
    // 지켜야 할 것은 "빈 배열이면 기본 목록으로 떨어진다" 이다.
    expect(sol.rpcUrls).toEqual(SOLANA_MAINNET_RPC_URLS);
  });
});
