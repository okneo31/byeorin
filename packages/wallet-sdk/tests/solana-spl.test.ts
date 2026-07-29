// solana-spl.test.ts — SPL 토큰 조회/송금.
//
// 네트워크에 절대 나가지 않는다. `solana-rpc-fallback.test.ts` 와 같은 방식으로
// fetch 를 주입해서 URL 별 JSON-RPC 응답을 조립한다 — 그래야 "어떤 엔드포인트로
// 나갔는지"까지 검증할 수 있고, 그게 이 파일의 핵심 회귀 방어선 중 하나다.

import { describe, expect, it } from 'vitest';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { SolanaAdapter } from '../src/index.js';
import type { Signer } from '../src/types.js';

const URL_A = 'https://a.example/rpc';
const URL_B = 'https://b.example/rpc';

const OWNER = 'oeYf6KAJkLYhBuR8CiGc6L4D4Xtfepr85fuDgA9kq96';
const RECIPIENT = 'HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH';
const FAKE_BLOCKHASH = '11111111111111111111111111111111';

// 실재하는 mint 주소들 — base58/32바이트로 유효하기만 하면 되지만, 실제 값을
// 쓰면 축약 심볼이 어떻게 보이는지도 같이 확인된다.
const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MINT_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
/** Token-2022 로 발행된 토큰(PYUSD). 원조 프로그램만 조회하면 안 보인다. */
const MINT_2022 = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const dummySigner: Signer = {
  curve: 'ed25519',
  publicKey: async () => new PublicKey(OWNER).toBytes(),
  sign: async () => new Uint8Array(64),
};

/**
 * ATA 주소 유도 — 구현과 같은 규칙을 테스트에서 독립적으로 다시 계산한다.
 * 시드에 토큰 프로그램 id 가 들어가므로 Token / Token-2022 의 ATA 는 다르다.
 */
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

// ---------------------------------------------------------------------------
// 가짜 RPC
// ---------------------------------------------------------------------------

type RpcHandler = (method: string, params: unknown[], url: string) => unknown;

interface FakeRpc {
  fetch: typeof fetch;
  calls: { url: string; method: string }[];
}

function makeFakeRpc(handlers: Record<string, RpcHandler>): FakeRpc {
  const calls: { url: string; method: string }[] = [];
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
    calls.push({ url, method });

    const handler = handlers[url];
    if (!handler) throw new TypeError(`fetch failed: unknown endpoint ${url}`);
    const result = handler(method, body.params ?? [], url);
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id ?? 1, result }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const deadHandler: RpcHandler = (_method, _params, url) => {
  throw new TypeError(`fetch failed: ${url}`);
};

/** 파싱된 SPL 토큰 계정 1건. `decimals` 는 이상값 주입을 위해 unknown. */
function tokenAccount(opts: {
  pubkey: string;
  program: string;
  mint: string;
  amount: string;
  decimals: unknown;
}): unknown {
  return {
    pubkey: opts.pubkey,
    account: {
      executable: false,
      owner: opts.program,
      lamports: 2_039_280,
      rentEpoch: 0,
      data: {
        program: opts.program === TOKEN_2022_PROGRAM ? 'spl-token-2022' : 'spl-token',
        parsed: {
          type: 'account',
          info: {
            mint: opts.mint,
            owner: OWNER,
            state: 'initialized',
            tokenAmount: {
              amount: opts.amount,
              decimals: opts.decimals,
              uiAmount: 0,
              uiAmountString: '0',
            },
          },
        },
        space: 165,
      },
    },
  };
}

/** jsonParsed mint 계정 응답. */
function mintAccount(program: string, decimals: number): unknown {
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
          decimals,
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

/** base64 원본 계정 응답 (getMultipleAccounts 용). 존재 여부만 확인한다. */
function rawAccount(program: string): unknown {
  return {
    executable: false,
    owner: program,
    lamports: 2_039_280,
    rentEpoch: 0,
    space: 165,
    data: ['', 'base64'],
  };
}

interface NodeConfig {
  /** programId → 그 프로그램에서 조회되는 토큰 계정들. */
  tokenAccounts?: Record<string, unknown[]>;
  /** mint → { program, decimals }. */
  mints?: Record<string, { program: string; decimals: number }>;
  /** 체인에 실재하는 계정 주소 → 소유 프로그램. 없는 주소는 null 로 응답한다. */
  accounts?: Record<string, string>;
  signature?: string;
}

/** 설정대로 답하는 정상 노드. */
function splNode(cfg: NodeConfig): RpcHandler {
  return (method, params) => {
    switch (method) {
      case 'getTokenAccountsByOwner': {
        const filter = params[1] as { programId?: string } | undefined;
        const programId = filter?.programId ?? '';
        return {
          context: { slot: 1 },
          value: cfg.tokenAccounts?.[programId] ?? [],
        };
      }
      case 'getAccountInfo': {
        const key = String(params[0]);
        const mint = cfg.mints?.[key];
        return {
          context: { slot: 1 },
          value: mint ? mintAccount(mint.program, mint.decimals) : null,
        };
      }
      case 'getMultipleAccounts': {
        const keys = (params[0] as string[]) ?? [];
        return {
          context: { slot: 1 },
          value: keys.map((k) => {
            const program = cfg.accounts?.[k];
            return program ? rawAccount(program) : null;
          }),
        };
      }
      case 'getLatestBlockhash':
        return {
          context: { slot: 1 },
          value: { blockhash: FAKE_BLOCKHASH, lastValidBlockHeight: 100 },
        };
      case 'sendTransaction':
        return cfg.signature ?? 'sig';
      default:
        return null;
    }
  };
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

describe('SolanaAdapter.discoverTokens — 조회', () => {
  it('보유한 SPL 토큰을 mint 기준으로 돌려준다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '1500000',
              decimals: 6,
            }),
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDT, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDT,
              amount: '0',
              decimals: 6,
            }),
          ],
        },
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const tokens = await sol.discoverTokens(OWNER);
    expect(tokens.map((t) => t.id)).toEqual([MINT_USDC, MINT_USDT].sort());

    const usdc = tokens.find((t) => t.id === MINT_USDC);
    expect(usdc?.balance).toBe(1_500_000n);
    expect(usdc?.decimals).toBe(6);

    // 잔액 0 도 숨기지 않는다 — ATA 존재는 체인의 사실이고, 숨김은 화면의 판단.
    expect(tokens.find((t) => t.id === MINT_USDT)?.balance).toBe(0n);

    // 전체 스캔이 아니다: 프로그램당 1회, 총 2회 왕복.
    expect(rpc.calls.filter((c) => c.method === 'getTokenAccountsByOwner')).toHaveLength(2);
  });

  it('Token-2022 토큰도 함께 나온다 (두 프로그램 모두 조회)', async () => {
    const queriedPrograms: string[] = [];
    const rpc = makeFakeRpc({
      [URL_A]: (method, params) => {
        if (method === 'getTokenAccountsByOwner') {
          const filter = params[1] as { programId?: string };
          queriedPrograms.push(filter.programId ?? '');
        }
        return splNode({
          tokenAccounts: {
            [TOKEN_PROGRAM]: [
              tokenAccount({
                pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
                program: TOKEN_PROGRAM,
                mint: MINT_USDC,
                amount: '10',
                decimals: 6,
              }),
            ],
            [TOKEN_2022_PROGRAM]: [
              tokenAccount({
                pubkey: ata(OWNER, MINT_2022, TOKEN_2022_PROGRAM),
                program: TOKEN_2022_PROGRAM,
                mint: MINT_2022,
                amount: '77',
                decimals: 6,
              }),
            ],
          },
        })(method, params, URL_A);
      },
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const tokens = await sol.discoverTokens(OWNER);
    expect(queriedPrograms.sort()).toEqual(
      [TOKEN_PROGRAM, TOKEN_2022_PROGRAM].sort(),
    );
    expect(tokens.find((t) => t.id === MINT_2022)?.balance).toBe(77n);
    expect(tokens).toHaveLength(2);
  });

  it('같은 mint 의 계정이 여러 개면 잔액을 합친다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '100',
              decimals: 6,
            }),
            tokenAccount({
              pubkey: RECIPIENT, // 보조 토큰 계정 (ATA 아님)
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '23',
              decimals: 6,
            }),
          ],
        },
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const tokens = await sol.discoverTokens(OWNER);
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.balance).toBe(123n);
  });

  it('symbol/name 을 지어내지 않는다 — mint 주소 축약 + source 표기', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '1',
              decimals: 6,
            }),
          ],
        },
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const [token] = await sol.discoverTokens(OWNER);
    // "USDC" 라고 부르지 않는다. 온체인 계정에는 그 이름이 없기 때문이다.
    expect(token?.symbol).toBe('EPjF…Dt1v');
    expect(token?.symbol).not.toBe('USDC');
    expect(token?.name).toBe(MINT_USDC);
    expect(token?.source).toBe('mint-address');
  });

  it('decimals 가 이상하면 그 항목을 버린다 (추측하지 않음)', async () => {
    const bad: [string, unknown][] = [
      ['소수', 6.5],
      ['음수', -1],
      ['문자열', '6'],
      ['없음', undefined],
      ['상한 초과', 99],
    ];
    for (const [label, decimals] of bad) {
      const rpc = makeFakeRpc({
        [URL_A]: splNode({
          tokenAccounts: {
            [TOKEN_PROGRAM]: [
              tokenAccount({
                pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
                program: TOKEN_PROGRAM,
                mint: MINT_USDC,
                amount: '1000',
                decimals,
              }),
              tokenAccount({
                pubkey: ata(OWNER, MINT_USDT, TOKEN_PROGRAM),
                program: TOKEN_PROGRAM,
                mint: MINT_USDT,
                amount: '5',
                decimals: 6,
              }),
            ],
          },
        }),
      });
      const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

      const tokens = await sol.discoverTokens(OWNER);
      // 이상한 항목만 사라지고 멀쩡한 항목은 남는다.
      expect(tokens.map((t) => t.id), label).toEqual([MINT_USDT]);
    }
  });

  it('같은 mint 인데 decimals 가 서로 다르면 그 mint 를 통째로 버린다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '1',
              decimals: 6,
            }),
            tokenAccount({
              pubkey: RECIPIENT,
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '1',
              decimals: 9,
            }),
          ],
        },
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(sol.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  it('amount 가 숫자 문자열이 아니면 버린다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '-5',
              decimals: 6,
            }),
          ],
        },
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });
    await expect(sol.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  it('조회가 전부 실패하면 던지지 않고 빈 배열', async () => {
    const rpc = makeFakeRpc({ [URL_A]: deadHandler, [URL_B]: deadHandler });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });
    await expect(sol.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  it('주소가 base58 로 파싱되지 않아도 빈 배열 (던지지 않음)', async () => {
    const rpc = makeFakeRpc({ [URL_A]: splNode({}) });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });
    await expect(sol.discoverTokens('not-a-solana-address!!')).resolves.toEqual(
      [],
    );
    expect(rpc.calls).toHaveLength(0);
  });

  it('한 프로그램만 실패하면 성공한 쪽 결과는 살린다 (부분 실패)', async () => {
    const handler: RpcHandler = (method, params, url) => {
      if (method === 'getTokenAccountsByOwner') {
        const filter = params[1] as { programId?: string };
        if (filter.programId === TOKEN_2022_PROGRAM) {
          throw new TypeError(`fetch failed: ${url}`);
        }
      }
      return splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '42',
              decimals: 6,
            }),
          ],
        },
      })(method, params, url);
    };
    const rpc = makeFakeRpc({ [URL_A]: handler });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const tokens = await sol.discoverTokens(OWNER);
    expect(tokens.map((t) => t.id)).toEqual([MINT_USDC]);
  });

  it('조회는 읽기 fallback 을 탄다 (0번이 죽으면 다음 엔드포인트)', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: splNode({
        tokenAccounts: {
          [TOKEN_PROGRAM]: [
            tokenAccount({
              pubkey: ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
              program: TOKEN_PROGRAM,
              mint: MINT_USDC,
              amount: '9',
              decimals: 6,
            }),
          ],
        },
      }),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    const tokens = await sol.discoverTokens(OWNER);
    expect(tokens.map((t) => t.id)).toEqual([MINT_USDC]);
    // A 를 먼저 때리고 실패한 뒤 B 로 넘어갔다.
    expect(rpc.calls.some((c) => c.url === URL_A)).toBe(true);
    expect(rpc.calls.some((c) => c.url === URL_B)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 송금
// ---------------------------------------------------------------------------

/** SPL 송금이 성공할 수 있는 완전한 노드 설정. */
function healthySplNode(opts: {
  mint: string;
  program: string;
  decimals: number;
  recipientAtaExists: boolean;
  senderAtaExists?: boolean;
}): RpcHandler {
  const accounts: Record<string, string> = {};
  if (opts.senderAtaExists !== false) {
    accounts[ata(OWNER, opts.mint, opts.program)] = opts.program;
  }
  if (opts.recipientAtaExists) {
    accounts[ata(RECIPIENT, opts.mint, opts.program)] = opts.program;
  }
  return splNode({
    mints: { [opts.mint]: { program: opts.program, decimals: opts.decimals } },
    accounts,
  });
}

describe('SolanaAdapter.buildTransfer — asset 분기', () => {
  it('asset 이 없으면 기존 native SOL 경로 그대로 (회귀 방어)', async () => {
    const rpc = makeFakeRpc({ [URL_A]: splNode({}) });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const { tx } = await sol.buildTransfer(
      { to: RECIPIENT, amount: 1_000n },
      { signer: dummySigner, sender: OWNER },
    );

    expect(tx).toBeInstanceOf(Transaction);
    expect(tx.instructions).toHaveLength(1);
    expect(tx.instructions[0]?.programId.equals(SystemProgram.programId)).toBe(
      true,
    );
    expect(tx.recentBlockhash).toBe(FAKE_BLOCKHASH);
    expect(tx.feePayer?.toBase58()).toBe(OWNER);
    // native 경로는 mint/ATA 조회를 전혀 하지 않는다.
    expect(rpc.calls.map((c) => c.method)).toEqual(['getLatestBlockhash']);
  });

  it('native 경로의 lamports 상한 검사가 그대로 살아 있다', async () => {
    const rpc = makeFakeRpc({ [URL_A]: splNode({}) });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: BigInt(Number.MAX_SAFE_INTEGER) + 1n },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it('asset 이 있으면 SPL transferChecked 로 빌드한다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: true,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const { tx } = await sol.buildTransfer(
      { to: RECIPIENT, amount: 1_500_000n, asset: MINT_USDC },
      { signer: dummySigner, sender: OWNER },
    );

    // 받는 쪽 ATA 가 이미 있으므로 생성 명령 없이 transfer 하나만.
    expect(tx.instructions).toHaveLength(1);
    const ix = tx.instructions[0]!;
    expect(ix.programId.toBase58()).toBe(TOKEN_PROGRAM);

    // data = [12(TransferChecked)] + u64 LE amount + [decimals]
    const expected = new Uint8Array(10);
    expected[0] = 12;
    new DataView(expected.buffer).setBigUint64(1, 1_500_000n, true);
    expected[9] = 6;
    expect(new Uint8Array(ix.data)).toEqual(expected);

    // 계정 순서: source, mint, destination, owner(signer)
    expect(ix.keys.map((k) => k.pubkey.toBase58())).toEqual([
      ata(OWNER, MINT_USDC, TOKEN_PROGRAM),
      MINT_USDC,
      ata(RECIPIENT, MINT_USDC, TOKEN_PROGRAM),
      OWNER,
    ]);
    expect(ix.keys[3]?.isSigner).toBe(true);

    // 조회 결과의 id 를 그대로 asset 에 넣으면 송금이 된다 = 같은 식별자.
    expect(tx.feePayer?.toBase58()).toBe(OWNER);
    expect(tx.recentBlockhash).toBe(FAKE_BLOCKHASH);
  });

  it('받는 쪽 ATA 가 없으면 생성 명령을 먼저 넣는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: false,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const { tx } = await sol.buildTransfer(
      { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
      { signer: dummySigner, sender: OWNER },
    );

    expect(tx.instructions).toHaveLength(2);
    const create = tx.instructions[0]!;
    expect(create.programId.toBase58()).toBe(ATA_PROGRAM);
    // CreateIdempotent(1) — 확인 시점과 실행 시점 사이에 남이 먼저 만들어도 안 깨진다.
    expect(new Uint8Array(create.data)).toEqual(new Uint8Array([1]));
    expect(create.keys.map((k) => k.pubkey.toBase58())).toEqual([
      OWNER, // payer
      ata(RECIPIENT, MINT_USDC, TOKEN_PROGRAM),
      RECIPIENT, // owner
      MINT_USDC,
      SystemProgram.programId.toBase58(),
      TOKEN_PROGRAM,
    ]);
    expect(create.keys[0]?.isSigner).toBe(true);

    // 생성 다음에 transfer 가 온다 (순서가 뒤집히면 송금이 실패한다).
    expect(tx.instructions[1]?.programId.toBase58()).toBe(TOKEN_PROGRAM);
    expect(new Uint8Array(tx.instructions[1]!.data)[0]).toBe(12);
  });

  it('보내는 쪽 ATA 가 없으면 명확한 에러로 죽는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: true,
        senderAtaExists: false,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/토큰 계정이 없습니다/);
  });

  it('Token-2022 mint 는 2022 프로그램과 2022 ATA 를 쓴다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_2022,
        program: TOKEN_2022_PROGRAM,
        decimals: 6,
        recipientAtaExists: false,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const { tx } = await sol.buildTransfer(
      { to: RECIPIENT, amount: 5n, asset: MINT_2022 },
      { signer: dummySigner, sender: OWNER },
    );

    expect(tx.instructions[1]?.programId.toBase58()).toBe(TOKEN_2022_PROGRAM);
    // ATA 주소는 프로그램 id 를 시드에 포함하므로 원조 Token 의 주소와 달라야 한다.
    const ata2022 = ata(RECIPIENT, MINT_2022, TOKEN_2022_PROGRAM);
    expect(ata2022).not.toBe(ata(RECIPIENT, MINT_2022, TOKEN_PROGRAM));
    expect(tx.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(ata2022);
  });

  it('decimals 는 송금 시점에 mint 에서 다시 읽는다', async () => {
    // 조회 때 6 이었더라도 여기서 9 를 읽으면 명령에는 9 가 들어가야 한다.
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 9,
        recipientAtaExists: true,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const { tx } = await sol.buildTransfer(
      { to: RECIPIENT, amount: 7n, asset: MINT_USDC },
      { signer: dummySigner, sender: OWNER },
    );
    expect(new Uint8Array(tx.instructions[0]!.data)[9]).toBe(9);
    // mint 계정을 실제로 읽었다.
    expect(rpc.calls.some((c) => c.method === 'getAccountInfo')).toBe(true);
  });

  it('mint 계정이 없으면 죽는다 (자릿수를 지어내지 않음)', async () => {
    const rpc = makeFakeRpc({ [URL_A]: splNode({}) });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/mint 계정이 체인에 없습니다/);
  });

  it('SPL mint 가 아닌 계정을 asset 으로 주면 죽는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: splNode({
        // 소유 프로그램이 SystemProgram 인 평범한 계정.
        mints: {
          [MINT_USDC]: {
            program: SystemProgram.programId.toBase58(),
            decimals: 6,
          },
        },
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/SPL mint 가 아닙니다/);
  });

  it('asset 이 mint 주소 형식이 아니면 죽는다', async () => {
    const rpc = makeFakeRpc({ [URL_A]: splNode({}) });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: 'nope!!' },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/유효한 mint 주소가 아닙니다/);
  });

  it('수량 0 또는 u64 초과는 죽는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: true,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 0n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/0보다 커야/);

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n << 64n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/u64 범위/);
  });

  it('SPL 송금도 서명 요청 1건 (기존 서명 경로 그대로)', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: false,
      }),
    });
    const sol = new SolanaAdapter({ rpcUrls: [URL_A], fetch: rpc.fetch });

    const unsigned = await sol.buildTransfer(
      { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
      { signer: dummySigner, sender: OWNER },
    );
    const reqs = await sol.signRequests(unsigned);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.prehashed).toBe(false);
  });
});

describe('SolanaAdapter — SPL 송금은 read fallback 을 타지 않는다 (핵심 회귀 방어선)', () => {
  it('0번 엔드포인트가 죽으면 실패한다 — 다음으로 넘어가지 않는다', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: deadHandler,
      [URL_B]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: true,
      }),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    // B 가 멀쩡해도 B 로 새면 안 된다. mint/ATA 판단과 blockhash·broadcast 가
    // 서로 다른 노드에서 오면 tx 가 깨진다.
    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/fetch failed/);

    expect(rpc.calls.every((c) => c.url === URL_A)).toBe(true);
    expect(rpc.calls.some((c) => c.url === URL_B)).toBe(false);
  });

  it('성공 경로도 0번 엔드포인트만 쓴다 (mint·ATA·blockhash 전부)', async () => {
    const rpc = makeFakeRpc({
      [URL_A]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: false,
      }),
      [URL_B]: healthySplNode({
        mint: MINT_USDC,
        program: TOKEN_PROGRAM,
        decimals: 6,
        recipientAtaExists: false,
      }),
    });
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: rpc.fetch,
    });

    await sol.buildTransfer(
      { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
      { signer: dummySigner, sender: OWNER },
    );

    expect(rpc.calls).toEqual([
      { url: URL_A, method: 'getAccountInfo' }, // mint
      { url: URL_A, method: 'getMultipleAccounts' }, // 양쪽 ATA
      { url: URL_A, method: 'getLatestBlockhash' },
    ]);
    expect(sol.writeRpcUrl).toBe(URL_A);
  });

  it('SPL 송금 경로는 무한 대기하지 않는다', async () => {
    const hanging = (async () => new Promise<Response>(() => {})) as typeof fetch;
    const sol = new SolanaAdapter({
      rpcUrls: [URL_A, URL_B],
      fetch: hanging,
      writeTimeoutMs: 60,
    });

    await expect(
      sol.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: MINT_USDC },
        { signer: dummySigner, sender: OWNER },
      ),
    ).rejects.toThrow(/응답 없음/);
  });
});
