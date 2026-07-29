// read-token-evm-sol-tron.test.ts — 수동 토큰 추가(`TokenCapableAdapter.readToken`)
// 를 EVM / Solana / TRON 세 어댑터에서.
//
// **네트워크에 나가지 않는다.** 모킹 방식은 체인별 기존 테스트의 컨벤션을 그대로 쓴다:
//   EVM     evm-portable-tokens.test.ts  — client.readContract monkey-patch
//   Solana  solana-spl.test.ts           — 주입 fetch 로 URL 별 JSON-RPC 조립
//   TRON    tron-trc20.test.ts           — tronweb 인스턴스 메서드 교체 (주소 변환은
//                                          진짜 구현을 통과시킨다)
//
// 이 파일이 지키려는 계약은 하나다: **decimals 를 못 읽으면 등록하지 않는다.**
// 자릿수가 틀리면 잔액이 통째로 거짓이 되는데 사용자는 그걸 알아채지 못한다.

import { describe, expect, it, vi } from 'vitest';
import { PublicKey, SystemProgram } from '@solana/web3.js';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as TronWebNs from 'tronweb';
import { avalanche } from 'viem/chains';
import { EvmAdapter } from '../src/chains/evm.js';
import { SolanaAdapter } from '../src/chains/solana.js';
import { TronAdapter } from '../src/chains/tron.js';
import {
  readPortableToken,
  supportsManualToken,
  type PortableTokenBalance,
} from '../src/tokens/portable.js';

// ---------------------------------------------------------------------------
// EVM
// ---------------------------------------------------------------------------

/** 체크섬(EIP-55) 정본. 입력을 소문자로 줘도 이 표기로 돌아와야 한다. */
const EVM_TOKEN = '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E';
const EVM_OWNER = '0xcccccccccccccccccccccccccccccccccccccccc';

interface EvmPatched {
  client: Record<string, unknown>;
}
type ReadArgs = { address: string; functionName: string; args?: unknown[] };

function patchReadContract(
  adapter: EvmAdapter,
  impl: (a: ReadArgs) => unknown,
): void {
  (adapter as unknown as EvmPatched).client.readContract = async (a: ReadArgs) =>
    impl(a);
}

/** functionName → 반환값. 값이 없으면 그 호출만 실패한다(계약이 그 함수를 안 가짐). */
function evmContract(
  table: Partial<Record<string, unknown>>,
): (a: ReadArgs) => unknown {
  return ({ functionName }) => {
    if (!(functionName in table)) {
      // viem 이 ERC-20 아닌 주소에 read 를 걸었을 때와 같은 모양 — 그냥 던진다.
      throw new Error(`execution reverted: no ${functionName}()`);
    }
    return table[functionName];
  };
}

function evmAdapter(): EvmAdapter {
  return new EvmAdapter({ chain: avalanche });
}

describe('EvmAdapter.readToken — 수동 토큰 추가', () => {
  it('supportsManualToken 이 이 어댑터를 수동 추가 가능으로 인식한다', () => {
    expect(supportsManualToken(evmAdapter())).toBe(true);
  });

  it('컨트랙트에서 symbol/name/decimals/balanceOf 를 읽어 채운다', async () => {
    const adapter = evmAdapter();
    let calls = 0;
    patchReadContract(adapter, (a) => {
      calls += 1;
      return evmContract({
        decimals: 6,
        symbol: 'USDC',
        name: 'USD Coin',
        balanceOf: 1_500_000n,
      })(a);
    });

    const out = await adapter.readToken(EVM_TOKEN, EVM_OWNER);
    expect(out).toMatchObject({
      id: EVM_TOKEN,
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      balance: 1_500_000n,
    });
    expect(typeof out?.balance).toBe('bigint');
    // 왕복 4회 — decimals/symbol/name/balanceOf.
    expect(calls).toBe(4);
    expect(out?.source).toContain('erc20.contract:decimals,symbol,name,balanceOf');
  });

  it('id 를 체크섬 주소로 정규화한다 (소문자·대문자로 넣어도 같은 문자열)', async () => {
    const adapter = evmAdapter();
    patchReadContract(
      adapter,
      evmContract({ decimals: 18, symbol: 'X', name: 'X', balanceOf: 0n }),
    );

    const lower = await adapter.readToken(EVM_TOKEN.toLowerCase(), EVM_OWNER);
    const upper = await adapter.readToken(
      `0x${EVM_TOKEN.slice(2).toUpperCase()}`,
      EVM_OWNER,
    );
    expect(lower?.id).toBe(EVM_TOKEN);
    expect(upper?.id).toBe(EVM_TOKEN);
  });

  it('decimals 를 못 읽으면 null — 18 로 추측하지 않는다 (EOA·비표준 계약)', async () => {
    const adapter = evmAdapter();
    // EOA 는 어떤 read 도 응답하지 않는다.
    patchReadContract(adapter, evmContract({}));
    await expect(adapter.readToken(EVM_TOKEN, EVM_OWNER)).resolves.toBeNull();

    // symbol/name 은 있는데 decimals 만 없는 비표준 계약도 마찬가지.
    const partial = evmAdapter();
    patchReadContract(
      partial,
      evmContract({ symbol: 'NODEC', name: 'No Decimals', balanceOf: 5n }),
    );
    await expect(partial.readToken(EVM_TOKEN, EVM_OWNER)).resolves.toBeNull();
  });

  it('decimals 가 말이 안 되는 값이면 null', async () => {
    for (const decimals of [99, -1, 6.5, Number.NaN]) {
      const adapter = evmAdapter();
      patchReadContract(
        adapter,
        evmContract({ decimals, symbol: 'BAD', name: 'Bad', balanceOf: 1n }),
      );
      await expect(
        adapter.readToken(EVM_TOKEN, EVM_OWNER),
        String(decimals),
      ).resolves.toBeNull();
    }
  });

  it('id 형식이 컨트랙트 주소가 아니면 던진다 (조용히 null 이 아니다)', async () => {
    const adapter = evmAdapter();
    patchReadContract(adapter, evmContract({ decimals: 6 }));
    for (const bad of [
      'not-an-address',
      '0x123',
      'B97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // 0x 없음
      `${EVM_TOKEN}00`, // 너무 김
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Solana mint
    ]) {
      await expect(adapter.readToken(bad, EVM_OWNER)).rejects.toThrow(
        /컨트랙트 주소 형식/,
      );
    }
  });

  it('잔액 0 이어도 등록된다 (아직 안 받은 토큰을 미리 추가하는 것은 정상)', async () => {
    const adapter = evmAdapter();
    patchReadContract(
      adapter,
      evmContract({ decimals: 8, symbol: 'NEW', name: 'New', balanceOf: 0n }),
    );

    const out = await adapter.readToken(EVM_TOKEN, EVM_OWNER);
    expect(out?.balance).toBe(0n);
    expect(out?.decimals).toBe(8);
    // 0 이 "조회 실패"가 아니라 "진짜 0" 이라는 사실이 source 로 구별된다.
    expect(out?.source).toContain('balanceOf');
    expect(out?.source).not.toContain('조회실패');
  });

  it('balanceOf 만 실패하면 잔액 0 으로 두되 메타데이터는 채운다', async () => {
    const adapter = evmAdapter();
    patchReadContract(
      adapter,
      evmContract({ decimals: 6, symbol: 'USDC', name: 'USD Coin' }),
    );

    const out = await adapter.readToken(EVM_TOKEN, EVM_OWNER);
    expect(out?.balance).toBe(0n);
    expect(out?.symbol).toBe('USDC');
    expect(out?.source).toContain('balance=0(조회실패)');
  });

  it('symbol/name 을 못 읽으면 주소 축약을 쓰고 source 에 남긴다 (지어내지 않는다)', async () => {
    const adapter = evmAdapter();
    patchReadContract(adapter, evmContract({ decimals: 6, balanceOf: 3n }));

    const out = await adapter.readToken(EVM_TOKEN, EVM_OWNER);
    expect(out?.symbol).toBe(`${EVM_TOKEN.slice(0, 6)}…${EVM_TOKEN.slice(-4)}`);
    expect(out?.name).toBe(out?.symbol);
    expect(out?.source).toContain('symbol=주소축약(읽기실패)');
    expect(out?.source).toContain('name=대체(읽기실패)');
  });

  it('계약이 준 이름표의 제어문자를 지우고 길이를 자른다', async () => {
    const adapter = evmAdapter();
    patchReadContract(
      adapter,
      evmContract({
        decimals: 6,
        symbol: ' US\nDC ',
        name: 'A'.repeat(200),
        balanceOf: 1n,
      }),
    );

    const out = await adapter.readToken(EVM_TOKEN, EVM_OWNER);
    expect(out?.symbol).toBe('USDC');
    expect(out?.name).toHaveLength(64);
  });

  it('portable.ts 의 readPortableToken 을 통과한다', async () => {
    const adapter = evmAdapter();
    patchReadContract(
      adapter,
      evmContract({ decimals: 6, symbol: 'USDC', name: 'USD Coin', balanceOf: 7n }),
    );

    const out = await readPortableToken(adapter, EVM_TOKEN, EVM_OWNER);
    expect(out?.id).toBe(EVM_TOKEN);
    expect(out?.balance).toBe(7n);
  });
});

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

const SOL_URL_A = 'https://a.example/rpc';
const SOL_URL_B = 'https://b.example/rpc';

const SOL_OWNER = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Token-2022 로 발행된 토큰. 원조 프로그램만 보면 수동 추가조차 막힌다. */
const MINT_2022 = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/** ATA 유도 — 구현과 같은 규칙을 테스트가 독립적으로 다시 계산한다. */
function ata(owner: string, mint: string, program: string): string {
  const [addr] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBytes(),
      new PublicKey(program).toBytes(),
      new PublicKey(mint).toBytes(),
    ],
    new PublicKey(ATA_PROGRAM),
  );
  return addr.toBase58();
}

type SolHandler = (method: string, params: unknown[], url: string) => unknown;

interface FakeRpc {
  fetch: typeof fetch;
  calls: { url: string; method: string; key: string }[];
}

function makeFakeRpc(handlers: Record<string, SolHandler>): FakeRpc {
  const calls: { url: string; method: string; key: string }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : String(input);
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      method?: string;
      params?: unknown[];
      id?: number;
    };
    const method = body.method ?? '';
    const params = body.params ?? [];
    calls.push({ url, method, key: String(params[0] ?? '') });

    const handler = handlers[url];
    if (!handler) throw new TypeError(`fetch failed: unknown endpoint ${url}`);
    const result = handler(method, params, url);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const deadHandler: SolHandler = (_m, _p, url) => {
  throw new TypeError(`fetch failed: ${url}`);
};

/** jsonParsed mint 계정. `decimals: undefined` 로 "자릿수를 못 읽는 mint" 를 만든다. */
function mintAccount(program: string, decimals: number | undefined): unknown {
  return {
    executable: false,
    owner: program,
    lamports: 1_461_600,
    rentEpoch: 0,
    data: {
      program: 'spl-token',
      parsed: {
        type: 'mint',
        info: {
          ...(decimals === undefined ? {} : { decimals }),
          supply: '1000000',
          isInitialized: true,
          mintAuthority: null,
          freezeAuthority: null,
        },
      },
      space: 82,
    },
  };
}

/** jsonParsed 토큰 계정(ATA). */
function tokenAccount(
  program: string,
  mint: string,
  amount: string,
  decimals: number,
): unknown {
  return {
    executable: false,
    owner: program,
    lamports: 2_039_280,
    rentEpoch: 0,
    data: {
      program: program === TOKEN_2022_PROGRAM ? 'spl-token-2022' : 'spl-token',
      parsed: {
        type: 'account',
        info: {
          mint,
          owner: SOL_OWNER,
          state: 'initialized',
          tokenAmount: {
            amount,
            decimals,
            uiAmount: 0,
            uiAmountString: '0',
          },
        },
      },
      space: 165,
    },
  };
}

/** 주소 → 계정 응답표. 표에 없는 주소는 null(체인에 없음)로 답한다. */
function solNode(accounts: Record<string, unknown>): SolHandler {
  return (method, params) => {
    if (method !== 'getAccountInfo') return null;
    const key = String(params[0]);
    return { context: { slot: 1 }, value: accounts[key] ?? null };
  };
}

function solAdapter(rpc: FakeRpc, urls: string[] = [SOL_URL_A]): SolanaAdapter {
  return new SolanaAdapter({ rpcUrls: urls, fetch: rpc.fetch });
}

describe('SolanaAdapter.readToken — 수동 토큰 추가', () => {
  it('mint 에서 decimals 를, owner 의 ATA 에서 잔액을 읽는다 (왕복 2회)', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({
        [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6),
        [ata(SOL_OWNER, MINT_USDC, TOKEN_PROGRAM)]: tokenAccount(
          TOKEN_PROGRAM,
          MINT_USDC,
          '1500000',
          6,
        ),
      }),
    });
    const sol = solAdapter(rpc);

    const out = await sol.readToken(MINT_USDC, SOL_OWNER);
    expect(out).toMatchObject({
      id: MINT_USDC,
      decimals: 6,
      balance: 1_500_000n,
      source: 'mint-address',
    });
    // mint → ATA 순서. 합칠 수 없다 (ATA 주소가 mint 의 프로그램 id 에 달렸다).
    expect(rpc.calls.map((c) => c.key)).toEqual([
      MINT_USDC,
      ata(SOL_OWNER, MINT_USDC, TOKEN_PROGRAM),
    ]);
  });

  it('symbol 을 지어내지 않는다 — mint 주소 축약 + source 표기 (discoverTokens 와 같은 규칙)', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({ [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6) }),
    });
    const sol = solAdapter(rpc);

    const out = await sol.readToken(MINT_USDC, SOL_OWNER);
    // 온체인 mint 계정에는 "USDC" 라는 이름이 없다.
    expect(out?.symbol).toBe('EPjF…Dt1v');
    expect(out?.symbol).not.toBe('USDC');
    expect(out?.name).toBe(MINT_USDC);
    expect(out?.source).toBe('mint-address');

    // discoverTokens 가 같은 mint 에 붙이는 라벨과 정확히 같아야 한다 — 자동 발견과
    // 수동 추가가 같은 토큰을 다른 이름으로 보여주면 목록에 두 줄이 생긴다.
    const viaDiscover = await new SolanaAdapter({
      rpcUrls: [SOL_URL_A],
      fetch: makeFakeRpc({
        [SOL_URL_A]: (method, params) => {
          if (method !== 'getTokenAccountsByOwner') return null;
          const filter = params[1] as { programId?: string };
          return {
            context: { slot: 1 },
            value:
              filter.programId === TOKEN_PROGRAM
                ? [
                    {
                      pubkey: ata(SOL_OWNER, MINT_USDC, TOKEN_PROGRAM),
                      account: tokenAccount(TOKEN_PROGRAM, MINT_USDC, '1', 6),
                    },
                  ]
                : [],
          };
        },
      }).fetch,
    }).discoverTokens(SOL_OWNER);
    expect(viaDiscover[0]?.symbol).toBe(out?.symbol);
    expect(viaDiscover[0]?.source).toBe(out?.source);
  });

  it('Token-2022 mint 도 읽는다 (ATA 주소가 2022 프로그램으로 유도된다)', async () => {
    const ata2022 = ata(SOL_OWNER, MINT_2022, TOKEN_2022_PROGRAM);
    expect(ata2022).not.toBe(ata(SOL_OWNER, MINT_2022, TOKEN_PROGRAM));

    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({
        [MINT_2022]: mintAccount(TOKEN_2022_PROGRAM, 9),
        [ata2022]: tokenAccount(TOKEN_2022_PROGRAM, MINT_2022, '77', 9),
      }),
    });
    const sol = solAdapter(rpc);

    const out = await sol.readToken(MINT_2022, SOL_OWNER);
    expect(out?.decimals).toBe(9);
    expect(out?.balance).toBe(77n);
    expect(rpc.calls[1]?.key).toBe(ata2022);
  });

  it('ATA 가 없으면 잔액 0 으로 등록된다 (에러가 아니다)', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({ [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6) }),
    });
    const sol = solAdapter(rpc);

    const out = await sol.readToken(MINT_USDC, SOL_OWNER);
    expect(out?.balance).toBe(0n);
    expect(out?.decimals).toBe(6);
    // "아직 안 받았다" 는 체인의 사실이지 조회 실패가 아니다.
    expect(out?.source).toBe('mint-address');
  });

  it('mint 계정이 체인에 없으면 null', async () => {
    const rpc = makeFakeRpc({ [SOL_URL_A]: solNode({}) });
    await expect(solAdapter(rpc).readToken(MINT_USDC, SOL_OWNER)).resolves.toBeNull();
  });

  it('SPL mint 가 아닌 계정이면 null (EOA·다른 프로그램 소유)', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({
        [MINT_USDC]: mintAccount(SystemProgram.programId.toBase58(), 6),
      }),
    });
    await expect(solAdapter(rpc).readToken(MINT_USDC, SOL_OWNER)).resolves.toBeNull();
  });

  it('decimals 를 못 읽으면 null — 6 이나 9 로 추측하지 않는다', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({
        [MINT_USDC]: mintAccount(TOKEN_PROGRAM, undefined),
        [ata(SOL_OWNER, MINT_USDC, TOKEN_PROGRAM)]: tokenAccount(
          TOKEN_PROGRAM,
          MINT_USDC,
          '999',
          6,
        ),
      }),
    });
    await expect(solAdapter(rpc).readToken(MINT_USDC, SOL_OWNER)).resolves.toBeNull();
  });

  it('id 형식이 mint 주소가 아니면 던진다', async () => {
    const rpc = makeFakeRpc({ [SOL_URL_A]: solNode({}) });
    const sol = solAdapter(rpc);
    for (const bad of [
      'nope!!',
      '',
      '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // EVM 주소
      'TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6', // TRON 주소
    ]) {
      await expect(sol.readToken(bad, SOL_OWNER)).rejects.toThrow(/mint 주소/);
    }
    expect(rpc.calls).toHaveLength(0);
  });

  it('id 를 base58 정본으로 정규화한다', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({ [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6) }),
    });
    // 앞뒤 공백이 섞인 표기는 PublicKey 가 거절하므로, 여기서 확인하는 것은
    // "돌려주는 id 가 우리가 만든 문자열이 아니라 체인의 정본" 이라는 점이다.
    const out = await solAdapter(rpc).readToken(MINT_USDC, SOL_OWNER);
    expect(out?.id).toBe(new PublicKey(MINT_USDC).toBase58());
  });

  it('읽기 fallback 을 탄다 (0번이 죽으면 다음 엔드포인트)', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: deadHandler,
      [SOL_URL_B]: solNode({
        [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6),
        [ata(SOL_OWNER, MINT_USDC, TOKEN_PROGRAM)]: tokenAccount(
          TOKEN_PROGRAM,
          MINT_USDC,
          '5',
          6,
        ),
      }),
    });
    const sol = solAdapter(rpc, [SOL_URL_A, SOL_URL_B]);

    const out = await sol.readToken(MINT_USDC, SOL_OWNER);
    expect(out?.balance).toBe(5n);
    expect(rpc.calls.some((c) => c.url === SOL_URL_A)).toBe(true);
    expect(rpc.calls.some((c) => c.url === SOL_URL_B)).toBe(true);
    // 쓰기 엔드포인트는 건드리지 않았다 — 읽기/쓰기 분리가 그대로다.
    expect(sol.writeRpcUrl).toBe(SOL_URL_A);
  });

  it('owner 가 주소 형식이 아니어도 메타데이터는 등록된다 (잔액만 0)', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({ [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6) }),
    });
    const out = await solAdapter(rpc).readToken(MINT_USDC, 'not-an-address!!');
    expect(out?.decimals).toBe(6);
    expect(out?.balance).toBe(0n);
    expect(out?.source).toContain('조회실패');
  });

  it('portable.ts 의 readPortableToken 을 통과한다', async () => {
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({
        [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6),
        [ata(SOL_OWNER, MINT_USDC, TOKEN_PROGRAM)]: tokenAccount(
          TOKEN_PROGRAM,
          MINT_USDC,
          '42',
          6,
        ),
      }),
    });
    const out: PortableTokenBalance | null = await readPortableToken(
      solAdapter(rpc),
      MINT_USDC,
      SOL_OWNER,
    );
    expect(out?.id).toBe(MINT_USDC);
    expect(out?.balance).toBe(42n);
  });
});

// ---------------------------------------------------------------------------
// TRON
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tronUtils: any =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TronWebNs as any).utils ?? (TronWebNs as any).default?.utils;

/** 체크섬이 실제로 맞는 base58 주소를 hex 에서 만든다. */
function base58From(hex40: string): string {
  return tronUtils.address.fromHex(`41${hex40}`) as string;
}

const TRON_OWNER = 'TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6';
const TRON_OWNER_HEX = (
  tronUtils.address.toHex(TRON_OWNER) as string
).toLowerCase();
const TRON_TOKEN_HEX40 = 'aa'.repeat(20);
const TRON_TOKEN = base58From(TRON_TOKEN_HEX40);

function encodeUint(n: number | bigint): string {
  return n.toString(16).padStart(64, '0');
}
function utf8Hex(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) out += b.toString(16).padStart(2, '0');
  return out;
}
function encodeString(s: string): string {
  const data = utf8Hex(s);
  const padded =
    data.length === 0 ? '' : data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return encodeUint(32) + encodeUint(data.length / 2) + padded;
}

const TRON_FAILED = { result: { result: false, message: 'REVERT' } };
function tronOk(hex: string): unknown {
  return { result: { result: true }, constant_result: [hex] };
}

interface TronInternals {
  tron: {
    transactionBuilder: {
      triggerConstantContract: ReturnType<typeof vi.fn>;
    };
  };
}

/**
 * selector → 반환 hex. 없는 항목은 실패로 답한다.
 * `limit` 을 주면 그 횟수를 넘긴 호출부터 전부 실패한다 — 무키 TronGrid 의
 * 연속 호출 한도(실측 3회)를 흉내내기 위한 것이다.
 */
function stubTronCalls(
  adapter: TronAdapter,
  table: Partial<Record<string, string>>,
  limit = Number.POSITIVE_INFINITY,
): ReturnType<typeof vi.fn> {
  let n = 0;
  const fn = vi.fn(
    async (
      _contract: string,
      selector: string,
      _opts: unknown,
      _params: unknown,
    ): Promise<unknown> => {
      n += 1;
      if (n > limit) return TRON_FAILED;
      const key = selector.split('(')[0] as string;
      const v = table[key];
      return v === undefined ? TRON_FAILED : tronOk(v);
    },
  );
  (adapter as unknown as TronInternals).tron.transactionBuilder
    .triggerConstantContract = fn;
  return fn;
}

function tronAdapter(): TronAdapter {
  // fetch 는 쓰지 않는다 — readToken 은 TronGrid 계정 API 를 거치지 않고
  // 계약에 직접 묻는다. 그게 목록 조회와 다른 점이다.
  return new TronAdapter({ network: 'mainnet' });
}

describe('TronAdapter.readToken — 수동 토큰 추가', () => {
  it('decimals → balanceOf → symbol → name 순으로 계약에 묻는다 (왕복 4회)', async () => {
    const adapter = tronAdapter();
    const calls = stubTronCalls(adapter, {
      decimals: encodeUint(6),
      balanceOf: encodeUint(1_500_000n),
      symbol: encodeString('USDT'),
      name: encodeString('Tether USD'),
    });

    const out = await adapter.readToken(TRON_TOKEN, TRON_OWNER);
    expect(out).toMatchObject({
      id: TRON_TOKEN,
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      balance: 1_500_000n,
    });

    // 잔액을 TronGrid 목록이 아니라 계약에 직접 물었다 — 목록에 없어서 수동으로
    // 추가하는 상황에서 목록을 다시 믿으면 잔액이 항상 0 으로 나온다.
    expect(calls).toHaveBeenCalledTimes(4);
    expect(calls.mock.calls.map((c) => c[1] as string)).toEqual([
      'decimals()',
      'balanceOf(address)',
      'symbol()',
      'name()',
    ]);
    // balanceOf 인자는 hex(41…) 로 넘긴다. base58 을 그대로 주면 인코더에 따라
    // 다른 주소가 된다.
    expect(calls.mock.calls[1]![3]).toEqual([
      { type: 'address', value: TRON_OWNER_HEX },
    ]);
    // 무인자 호출은 예전 그대로 빈 배열.
    expect(calls.mock.calls[0]![3]).toEqual([]);
    expect(out?.source).toContain('contract:decimals,balanceOf,symbol,name');
  });

  it('decimals 를 못 읽으면 null — 6/18 로 추측하지 않고 뒷 호출도 안 한다', async () => {
    const adapter = tronAdapter();
    const calls = stubTronCalls(adapter, {
      symbol: encodeString('NODEC'),
      name: encodeString('No Dec'),
    });

    await expect(adapter.readToken(TRON_TOKEN, TRON_OWNER)).resolves.toBeNull();
    // 자릿수가 없으면 나머지를 읽어봐야 등록할 수 없다. 예산을 쓰지 않는다.
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('decimals 가 말이 안 되는 값이면 null', async () => {
    for (const d of [99, 200]) {
      const adapter = tronAdapter();
      stubTronCalls(adapter, {
        decimals: encodeUint(d),
        balanceOf: encodeUint(1),
        symbol: encodeString('BAD'),
        name: encodeString('Bad'),
      });
      await expect(
        adapter.readToken(TRON_TOKEN, TRON_OWNER),
        String(d),
      ).resolves.toBeNull();
    }
  });

  it('id 형식/체크섬이 틀리면 던진다', async () => {
    const adapter = tronAdapter();
    const calls = stubTronCalls(adapter, { decimals: encodeUint(6) });

    // 마지막 글자만 바꾼 주소 — 형식은 맞지만 base58check 가 깨진다.
    const tampered = `${TRON_TOKEN.slice(0, 33)}${
      TRON_TOKEN.endsWith('a') ? 'b' : 'a'
    }`;
    for (const bad of [
      'not-an-address',
      '',
      tampered,
      '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E', // EVM 주소
    ]) {
      await expect(adapter.readToken(bad, TRON_OWNER)).rejects.toThrow(/tron/);
    }
    expect(calls).not.toHaveBeenCalled();
  });

  it('0x41… hex 로 넣어도 base58 정본 id 로 돌려준다', async () => {
    const adapter = tronAdapter();
    stubTronCalls(adapter, {
      decimals: encodeUint(6),
      balanceOf: encodeUint(1),
      symbol: encodeString('A'),
      name: encodeString('A'),
    });

    const fromHex = await adapter.readToken(`0x41${TRON_TOKEN_HEX40}`, TRON_OWNER);
    expect(fromHex?.id).toBe(TRON_TOKEN);
    expect(fromHex?.id).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('잔액 0 이어도 등록된다 (조회 실패와 구별된다)', async () => {
    const adapter = tronAdapter();
    stubTronCalls(adapter, {
      decimals: encodeUint(8),
      balanceOf: encodeUint(0),
      symbol: encodeString('NEW'),
      name: encodeString('New'),
    });

    const out = await adapter.readToken(TRON_TOKEN, TRON_OWNER);
    expect(out?.balance).toBe(0n);
    expect(out?.decimals).toBe(8);
    expect(out?.source).toContain('balanceOf');
    expect(out?.source).not.toContain('조회실패');
  });

  it('balanceOf 를 못 읽으면 잔액 0 으로 두되 메타데이터는 채운다', async () => {
    const adapter = tronAdapter();
    stubTronCalls(adapter, {
      decimals: encodeUint(6),
      symbol: encodeString('USDT'),
      name: encodeString('Tether USD'),
    });

    const out = await adapter.readToken(TRON_TOKEN, TRON_OWNER);
    expect(out?.balance).toBe(0n);
    expect(out?.symbol).toBe('USDT');
    expect(out?.source).toContain('balance=0(조회실패)');
  });

  it('무키 한도(연속 3회)에 걸려 name 이 잘려도 등록은 된다', async () => {
    const adapter = tronAdapter();
    // 4회째부터 거부 — 실측된 무키 TronGrid 의 동작.
    stubTronCalls(
      adapter,
      {
        decimals: encodeUint(6),
        balanceOf: encodeUint(123),
        symbol: encodeString('USDT'),
        name: encodeString('Tether USD'),
      },
      3,
    );

    const out = await adapter.readToken(TRON_TOKEN, TRON_OWNER);
    // 잃어도 가장 손해가 적은 항목을 마지막에 뒀다: 자릿수·잔액·심볼은 살았다.
    expect(out?.decimals).toBe(6);
    expect(out?.balance).toBe(123n);
    expect(out?.symbol).toBe('USDT');
    expect(out?.name).toBe('USDT'); // name 실패 → symbol 로 대체
    expect(out?.source).toContain('name=대체(읽기실패)');
  });

  it('symbol 도 못 읽으면 주소 축약을 쓴다 (지어내지 않는다)', async () => {
    const adapter = tronAdapter();
    stubTronCalls(adapter, {
      decimals: encodeUint(2),
      balanceOf: encodeUint(7),
    });

    const out = await adapter.readToken(TRON_TOKEN, TRON_OWNER);
    expect(out?.symbol).toBe(`${TRON_TOKEN.slice(0, 6)}…${TRON_TOKEN.slice(-4)}`);
    expect(out?.name).toBe(out?.symbol);
    expect(out?.source).toContain('symbol=주소축약(읽기실패)');
  });

  it('owner 가 주소가 아니면 던진다 (상수 호출에 owner_address 가 필수)', async () => {
    const adapter = tronAdapter();
    const calls = stubTronCalls(adapter, { decimals: encodeUint(6) });
    await expect(adapter.readToken(TRON_TOKEN, 'nope')).rejects.toThrow(/owner/);
    expect(calls).not.toHaveBeenCalled();
  });

  it('portable.ts 의 readPortableToken 을 통과한다', async () => {
    const adapter = tronAdapter();
    stubTronCalls(adapter, {
      decimals: encodeUint(6),
      balanceOf: encodeUint(9),
      symbol: encodeString('USDT'),
      name: encodeString('Tether USD'),
    });

    const out = await readPortableToken(adapter, TRON_TOKEN, TRON_OWNER);
    expect(out?.id).toBe(TRON_TOKEN);
    expect(out?.balance).toBe(9n);
  });
});

// ---------------------------------------------------------------------------
// 세 체인 공통 계약
// ---------------------------------------------------------------------------

describe('readToken 공통 계약', () => {
  it('세 어댑터 모두 수동 추가를 지원한다고 답한다', () => {
    const rpc = makeFakeRpc({ [SOL_URL_A]: solNode({}) });
    expect(supportsManualToken(evmAdapter())).toBe(true);
    expect(supportsManualToken(solAdapter(rpc))).toBe(true);
    expect(supportsManualToken(tronAdapter())).toBe(true);
  });

  it('돌려준 id 는 그대로 송금 asset 으로 쓸 수 있는 형식이다', async () => {
    // EVM: 체크섬 컨트랙트 주소 → buildTransfer 의 asset 정규식을 통과해야 한다.
    const evm = evmAdapter();
    patchReadContract(
      evm,
      evmContract({ decimals: 6, symbol: 'U', name: 'U', balanceOf: 1n }),
    );
    const evmToken = await evm.readToken(EVM_TOKEN.toLowerCase(), EVM_OWNER);
    expect(evmToken?.id).toMatch(/^0x[0-9a-fA-F]{40}$/);

    // TRON: base58 T… → normalizeAddress 를 통과해야 한다.
    const tron = tronAdapter();
    stubTronCalls(tron, {
      decimals: encodeUint(6),
      balanceOf: encodeUint(1),
      symbol: encodeString('A'),
      name: encodeString('A'),
    });
    const tronToken = await tron.readToken(`41${TRON_TOKEN_HEX40}`, TRON_OWNER);
    expect(tronToken?.id).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);

    // Solana: base58 mint → PublicKey 로 파싱돼야 한다.
    const rpc = makeFakeRpc({
      [SOL_URL_A]: solNode({ [MINT_USDC]: mintAccount(TOKEN_PROGRAM, 6) }),
    });
    const solToken = await solAdapter(rpc).readToken(MINT_USDC, SOL_OWNER);
    expect(() => new PublicKey(solToken?.id ?? '')).not.toThrow();
  });
});
