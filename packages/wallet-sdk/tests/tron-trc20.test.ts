// TRC-20 조회/송금 테스트 — 네트워크를 타지 않는다.
//
// 모킹 범위는 딱 두 군데다:
//   1. TronGrid 계정 API → 주입 fetch
//   2. tronweb 의 trigger*Contract / sendTrx → 인스턴스 메서드 교체
//
// 주소 변환(base58 ↔ hex)은 **모킹하지 않는다.** 여기서 틀리면 남의 주소로
// 보내는 버그가 되므로, 진짜 tronweb 의 base58check 구현을 그대로 통과시킨다.
import { beforeEach, describe, expect, it, vi } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import * as TronWebNs from 'tronweb';
import { TronAdapter } from '../src/chains/tron.js';
import type { TronTokenNotice } from '../src/chains/tron.js';
import {
  KNOWN_TRC20,
  lookupKnownTrc20,
  reconcileKnownDecimals,
} from '../src/chains/trc20-known.js';
import type { TxContext } from '../src/chains/chain.js';
import type { Signer } from '../src/types.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const tronUtils: any =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (TronWebNs as any).utils ?? (TronWebNs as any).default?.utils;

/** 체크섬이 실제로 맞는 base58 주소를 hex 에서 만든다. */
function base58From(hex40: string): string {
  return tronUtils.address.fromHex(`41${hex40}`) as string;
}

const OWNER = 'TWer2Ygk5TEheHp3TPuYeqxmB6SsGZmaL6';
const OWNER_HEX = tronUtils.address.toHex(OWNER) as string;
const TOKEN_A = base58From('aa'.repeat(20));
const TOKEN_B = base58From('bb'.repeat(20));
const TOKEN_C = base58From('cc'.repeat(20));
const RECIPIENT = base58From('dd'.repeat(20));
/** 내장 목록에 있는 실제 TRC-20 USDT 컨트랙트. */
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';

// --- ABI 인코딩 헬퍼 (계약 반환값 흉내) ---
function encodeUint(n: number | bigint): string {
  return n.toString(16).padStart(64, '0');
}
function utf8Hex(s: string): string {
  let out = '';
  for (const b of new TextEncoder().encode(s)) {
    out += b.toString(16).padStart(2, '0');
  }
  return out;
}
/** 표준 동적 string 반환값: offset || length || data. */
function encodeString(s: string): string {
  const data = utf8Hex(s);
  const padded =
    data.length === 0 ? '' : data.padEnd(Math.ceil(data.length / 64) * 64, '0');
  return encodeUint(32) + encodeUint(data.length / 2) + padded;
}
/** 구형 ERC-20 을 베낀 토큰이 주는 bytes32 반환값. */
function encodeBytes32(s: string): string {
  return utf8Hex(s).padEnd(64, '0');
}

type ConstantResult = { result: { result: boolean }; constant_result: string[] };
function ok(hex: string): ConstantResult {
  return { result: { result: true }, constant_result: [hex] };
}
const FAILED = { result: { result: false, message: 'REVERT' } };

/** 컨트랙트별 decimals/symbol/name 응답표. 없는 항목은 실패로 취급한다. */
interface TokenMeta {
  decimals?: string;
  symbol?: string;
  name?: string;
}

interface Internals {
  tron: {
    transactionBuilder: {
      triggerConstantContract: ReturnType<typeof vi.fn>;
      triggerSmartContract: ReturnType<typeof vi.fn>;
      sendTrx: ReturnType<typeof vi.fn>;
    };
  };
}

function stubConstantCalls(
  adapter: TronAdapter,
  table: Record<string, TokenMeta>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async (contract: string, selector: string): Promise<unknown> => {
      const meta = table[contract];
      if (!meta) return FAILED;
      const key = selector.startsWith('decimals')
        ? 'decimals'
        : selector.startsWith('symbol')
          ? 'symbol'
          : 'name';
      const v = meta[key];
      return v === undefined ? FAILED : ok(v);
    },
  );
  (adapter as unknown as Internals).tron.transactionBuilder
    .triggerConstantContract = fn;
  return fn;
}

/** TronGrid `/v1/accounts/{addr}` 응답을 흉내내는 fetch. */
function gridFetch(
  trc20: Array<Record<string, string>>,
  opts: { ok?: boolean; throws?: boolean } = {},
): typeof fetch {
  return vi.fn(async () => {
    if (opts.throws) throw new Error('network down');
    return {
      ok: opts.ok ?? true,
      json: async () => ({ data: [{ trc20 }] }),
    };
  }) as unknown as typeof fetch;
}

const DUMMY_SIGNER: Signer = {
  curve: 'secp256k1',
  publicKey: async () => new Uint8Array(33),
  sign: async () => new Uint8Array(65),
};
const CTX: TxContext = { signer: DUMMY_SIGNER, sender: OWNER };

let notices: TronTokenNotice[];
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  notices = [];
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

function makeAdapter(
  fetchImpl: typeof fetch,
  extra: { maxTokens?: number; feeLimitSun?: number; fetchLabels?: boolean } = {},
): TronAdapter {
  return new TronAdapter({
    network: 'mainnet',
    fetch: fetchImpl,
    onTokenNotice: (n) => notices.push(n),
    ...extra,
  });
}

describe('TronAdapter.discoverTokens (offline)', () => {
  // 기본은 토큰당 decimals 1 회다. 무키 TronGrid 는 IP 할당량을 금방 소진하고
  // 회복도 안 되는데, 토큰마다 symbol/name 까지 부르면 예산이 3 배로 나가
  // 대부분이 decimals 조차 못 읽고 사라진다(실측: 880 개 중 0 개).
  // 이름표는 fetchLabels 로만 켠다.
  it('라벨 조회를 켜면 decimals 를 전부 끝낸 뒤 symbol 만 더 부른다', async () => {
    const f = gridFetch([{ [TOKEN_A]: '1500000' }, { [TOKEN_B]: '42' }]);
    const adapter = makeAdapter(f, { fetchLabels: true });
    const calls = stubConstantCalls(adapter, {
      [TOKEN_A]: {
        decimals: encodeUint(6),
        symbol: encodeString('USDT'),
        name: encodeString('Tether USD'),
      },
      [TOKEN_B]: {
        decimals: encodeUint(18),
        symbol: encodeBytes32('OLD'),
        name: encodeBytes32('Old Style'),
      },
    });

    const out = await adapter.discoverTokens(OWNER);

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: TOKEN_A,
      symbol: 'USDT',
      // name() 은 부르지 않는다 — 이름 칸은 symbol 로 채운다.
      name: 'USDT',
      decimals: 6,
      balance: 1500000n,
    });
    // id 는 base58 컨트랙트 주소 — 그대로 TransferIntent.asset 에 쓰인다.
    expect(out[0]!.id).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(out[1]).toMatchObject({
      id: TOKEN_B,
      symbol: 'OLD',
      decimals: 18,
      balance: 42n,
    });

    // 왕복 수: 계정 API 1회 + decimals 2회 + symbol 2회 = 4. (옛 3배안은 6회)
    expect(f).toHaveBeenCalledTimes(1);
    expect(calls).toHaveBeenCalledTimes(4);
    // 컨트랙트를 하나씩 balanceOf 로 묻지 않았다.
    const selectors = calls.mock.calls.map((c) => c[1] as string);
    expect(selectors.some((s) => s.startsWith('balanceOf'))).toBe(false);
    expect(new Set(selectors)).toEqual(new Set(['decimals()', 'symbol()']));
    // **순서가 곧 우선순위다.** decimals 가 전부 끝난 뒤에 symbol 이 나간다.
    expect(selectors).toEqual([
      'decimals()',
      'decimals()',
      'symbol()',
      'symbol()',
    ]);
  });

  it('잔액과 목록이 TronGrid 출처임을 source 에 적는다', async () => {
    const adapter = makeAdapter(gridFetch([{ [TOKEN_A]: '10' }]));
    stubConstantCalls(adapter, {
      [TOKEN_A]: {
        decimals: encodeUint(6),
        symbol: encodeString('AAA'),
        name: encodeString('A Token'),
      },
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(out[0]!.source).toContain('trongrid');
    expect(out[0]!.source).toContain('contract:decimals');
  });

  it('계정 API 를 /v1/accounts/{base58} 로 부른다', async () => {
    const f = gridFetch([]);
    const adapter = makeAdapter(f);
    await adapter.discoverTokens(OWNER);
    const url = (f as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as string;
    expect(url).toBe(`https://api.trongrid.io/v1/accounts/${OWNER}`);
  });

  it('decimals 를 못 읽으면 그 토큰을 버린다 (추측하지 않는다)', async () => {
    const adapter = makeAdapter(
      gridFetch([{ [TOKEN_A]: '100' }, { [TOKEN_B]: '200' }]),
    );
    stubConstantCalls(adapter, {
      [TOKEN_A]: { symbol: encodeString('NODEC'), name: encodeString('No Dec') },
      [TOKEN_B]: {
        decimals: encodeUint(8),
        symbol: encodeString('OK'),
        name: encodeString('Fine'),
      },
    });

    const out = await adapter.discoverTokens(OWNER);

    // 부분 실패 → 성공한 것만.
    expect(out.map((t) => t.id)).toEqual([TOKEN_B]);
    // 버린 이유가 드러난다.
    expect(notices).toContainEqual({
      kind: 'dropped',
      contract: TOKEN_A,
      reason: 'decimals-unreadable',
    });
    expect(warn).toHaveBeenCalled();
  });

  it('decimals 가 말이 안 되는 값이면 버린다', async () => {
    const adapter = makeAdapter(gridFetch([{ [TOKEN_A]: '100' }]));
    stubConstantCalls(adapter, {
      [TOKEN_A]: {
        decimals: encodeUint(99),
        symbol: encodeString('BAD'),
        name: encodeString('Bad'),
      },
    });

    expect(await adapter.discoverTokens(OWNER)).toEqual([]);
    expect(notices).toContainEqual({
      kind: 'dropped',
      contract: TOKEN_A,
      reason: 'decimals-out-of-range',
    });
  });

  it('symbol 을 못 읽으면 주소 축약을 쓰고 source 에 남긴다 (지어내지 않는다)', async () => {
    const adapter = makeAdapter(gridFetch([{ [TOKEN_A]: '7' }]));
    stubConstantCalls(adapter, { [TOKEN_A]: { decimals: encodeUint(2) } });

    const out = await adapter.discoverTokens(OWNER);
    expect(out).toHaveLength(1);
    expect(out[0]!.symbol).toBe(`${TOKEN_A.slice(0, 6)}…${TOKEN_A.slice(-4)}`);
    expect(out[0]!.source).toContain('symbol=주소축약');
    expect(out[0]!.decimals).toBe(2);
  });

  it('API 가 실패하면 빈 배열이고 계약 호출도 안 한다', async () => {
    for (const f of [
      gridFetch([], { ok: false }),
      gridFetch([], { throws: true }),
    ]) {
      const adapter = makeAdapter(f);
      const calls = stubConstantCalls(adapter, {
        [TOKEN_A]: { decimals: encodeUint(6) },
      });
      await expect(adapter.discoverTokens(OWNER)).resolves.toEqual([]);
      expect(calls).not.toHaveBeenCalled();
    }
  });

  it('응답이 이상해도 던지지 않는다', async () => {
    const weird = vi.fn(async () => ({
      ok: true,
      json: async () => ({ data: [] }),
    })) as unknown as typeof fetch;
    const adapter = makeAdapter(weird);
    await expect(adapter.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  it('주소가 아닌 owner 를 줘도 던지지 않는다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    await expect(adapter.discoverTokens('not-an-address')).resolves.toEqual([]);
  });

  it('잔액 0 인 토큰은 계약 호출 없이 제외한다', async () => {
    const adapter = makeAdapter(
      gridFetch([{ [TOKEN_A]: '0' }, { [TOKEN_B]: '5' }]),
    );
    const calls = stubConstantCalls(adapter, {
      [TOKEN_A]: { decimals: encodeUint(6) },
      [TOKEN_B]: {
        decimals: encodeUint(6),
        symbol: encodeString('B'),
        name: encodeString('B'),
      },
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(out.map((t) => t.id)).toEqual([TOKEN_B]);
    // 잔액 0 은 계약 호출 없이 걸러지고, 남은 1 개에 decimals 1 회만 쓴다.
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('상한에 걸리면 잘라내되 그 사실을 알린다', async () => {
    const adapter = makeAdapter(
      gridFetch([
        { [TOKEN_A]: '1' },
        { [TOKEN_B]: '2' },
        { [TOKEN_C]: '3' },
      ]),
      { maxTokens: 1 },
    );
    const meta = {
      decimals: encodeUint(6),
      symbol: encodeString('X'),
      name: encodeString('X'),
    };
    const calls = stubConstantCalls(adapter, {
      [TOKEN_A]: meta,
      [TOKEN_B]: meta,
      [TOKEN_C]: meta,
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(out).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(1); // 1개분 · decimals 만
    // 알림, 로그, 그리고 결과 배열 자체에 흔적이 남는다.
    expect(notices).toContainEqual({ kind: 'truncated', total: 3, kept: 1 });
    expect(warn).toHaveBeenCalled();
    expect(out[0]!.source).toContain('truncated:1/3');
  });

  it('TronGrid 가 컨트랙트를 hex 로 줘도 base58 id 로 정규화한다', async () => {
    const hexKey = `41${'aa'.repeat(20)}`;
    const adapter = makeAdapter(gridFetch([{ [hexKey]: '9' }]));
    stubConstantCalls(adapter, {
      [TOKEN_A]: {
        decimals: encodeUint(6),
        symbol: encodeString('A'),
        name: encodeString('A'),
      },
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe(TOKEN_A);
  });
});

// 사용자 신고(2026-08-04): "USDT 토큰이 컨트랙트 주소로 표시된다".
// 원인은 예산 절충이었고, 주소가 고정된 토큰은 그 절충에 걸릴 이유가 없다.
describe('TronAdapter — 내장 TRC-20 이름표 (RPC 0회)', () => {
  it('USDT 는 라벨 조회 없이 이름이 나온다 (계약 호출은 decimals 1회뿐)', async () => {
    const adapter = makeAdapter(gridFetch([{ [USDT]: '1500000' }]));
    const calls = stubConstantCalls(adapter, {
      // symbol/name 은 일부러 주지 않는다 — 안 불러야 정상이다.
      [USDT]: { decimals: encodeUint(6) },
    });

    const out = await adapter.discoverTokens(OWNER);

    expect(out[0]).toMatchObject({
      id: USDT,
      symbol: 'USDT',
      name: 'Tether USD',
      decimals: 6,
      balance: 1500000n,
    });
    expect(calls).toHaveBeenCalledTimes(1);
    expect(calls.mock.calls[0]![1]).toBe('decimals()');
    // 이름표의 출처를 숨기지 않는다.
    expect(out[0]!.source).toContain('내장목록');
  });

  it('내장 토큰이라도 decimals 는 체인에서 읽는다 — 못 읽으면 버린다', async () => {
    const adapter = makeAdapter(gridFetch([{ [USDT]: '1500000' }]));
    stubConstantCalls(adapter, {}); // decimals 실패

    expect(await adapter.discoverTokens(OWNER)).toEqual([]);
    expect(notices).toContainEqual({
      kind: 'dropped',
      contract: USDT,
      reason: 'decimals-unreadable',
    });
  });

  it('체인 decimals 가 6 이 아니어도 체인값을 따른다 (내장값이 이기지 않는다)', async () => {
    const adapter = makeAdapter(gridFetch([{ [USDT]: '100' }]));
    stubConstantCalls(adapter, { [USDT]: { decimals: encodeUint(2) } });

    const out = await adapter.discoverTokens(OWNER);
    expect(out[0]!.decimals).toBe(2);
  });

  it('내장 토큰에는 라벨 조회 예산을 쓰지 않는다', async () => {
    const adapter = makeAdapter(
      gridFetch([{ [USDT]: '5000000' }, { [TOKEN_A]: '1000000' }]),
      { fetchLabels: true },
    );
    const calls = stubConstantCalls(adapter, {
      [USDT]: { decimals: encodeUint(6), symbol: encodeString('WRONG') },
      [TOKEN_A]: { decimals: encodeUint(6), symbol: encodeString('AAA') },
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(out.find((t) => t.id === USDT)!.symbol).toBe('USDT');
    expect(out.find((t) => t.id === TOKEN_A)!.symbol).toBe('AAA');
    // decimals 2회 + symbol 1회(내장 토큰 제외). USDT 에는 안 나갔다.
    expect(calls).toHaveBeenCalledTimes(3);
    const symbolTargets = calls.mock.calls
      .filter((c) => (c[1] as string) === 'symbol()')
      .map((c) => c[0] as string);
    expect(symbolTargets).toEqual([TOKEN_A]);
  });

  it('미등록 토큰은 예전처럼 주소 축약으로 안전하게 떨어진다', async () => {
    const adapter = makeAdapter(gridFetch([{ [TOKEN_A]: '7' }]));
    stubConstantCalls(adapter, { [TOKEN_A]: { decimals: encodeUint(2) } });

    const out = await adapter.discoverTokens(OWNER);
    expect(out[0]!.symbol).toBe(`${TOKEN_A.slice(0, 6)}…${TOKEN_A.slice(-4)}`);
    expect(out[0]!.source).toContain('symbol=주소축약');
    expect(out[0]!.source).not.toContain('내장목록');
  });

  it('라벨 예산은 잔액 큰 순으로 쓰고 상한을 넘지 않는다', async () => {
    const adapter = makeAdapter(
      gridFetch([
        { [TOKEN_A]: '1' }, // decimals 0 → 1
        { [TOKEN_B]: '900' }, // decimals 0 → 900
        { [TOKEN_C]: '50' }, // decimals 0 → 50
      ]),
      { fetchLabels: true, maxLabelLookups: 1 },
    );
    const calls = stubConstantCalls(adapter, {
      [TOKEN_A]: { decimals: encodeUint(0), symbol: encodeString('A') },
      [TOKEN_B]: { decimals: encodeUint(0), symbol: encodeString('B') },
      [TOKEN_C]: { decimals: encodeUint(0), symbol: encodeString('C') },
    });

    const out = await adapter.discoverTokens(OWNER);
    expect(out.find((t) => t.id === TOKEN_B)!.symbol).toBe('B');
    expect(calls).toHaveBeenCalledTimes(4); // decimals 3 + symbol 1
    const symbolTargets = calls.mock.calls
      .filter((c) => (c[1] as string) === 'symbol()')
      .map((c) => c[0] as string);
    expect(symbolTargets).toEqual([TOKEN_B]);
  });

  it('라벨 조회가 실패해도 1단계 결과는 그대로 남는다', async () => {
    const adapter = makeAdapter(gridFetch([{ [TOKEN_A]: '9' }]), {
      fetchLabels: true,
    });
    const calls = vi.fn(async (_c: string, selector: string) => {
      if (selector.startsWith('decimals')) return ok(encodeUint(6));
      throw new Error('quota exceeded');
    });
    (adapter as unknown as Internals).tron.transactionBuilder
      .triggerConstantContract = calls as unknown as ReturnType<typeof vi.fn>;

    const out = await adapter.discoverTokens(OWNER);
    expect(out).toHaveLength(1);
    expect(out[0]!.decimals).toBe(6);
    expect(out[0]!.symbol).toContain('…');
  });

  it('수동 추가에서도 symbol 을 못 읽으면 내장 이름표로 대체한다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    stubConstantCalls(adapter, { [USDT]: { decimals: encodeUint(6) } });

    const out = await adapter.readToken(USDT, OWNER);
    expect(out).toMatchObject({ symbol: 'USDT', name: 'Tether USD', decimals: 6 });
    expect(out!.source).toContain('symbol=내장목록');
  });
});

describe('trc20-known 목록 자체', () => {
  it('주소를 정규화하지 않는다 — 소문자 입력은 아는 토큰이 아니다', () => {
    expect(lookupKnownTrc20(USDT)).toBeDefined();
    expect(lookupKnownTrc20(USDT.toLowerCase())).toBeUndefined();
    expect(lookupKnownTrc20(USDT.toUpperCase())).toBeUndefined();
  });

  it('모든 엔트리가 유효한 base58check 주소이고 근거를 갖는다', () => {
    for (const t of KNOWN_TRC20) {
      expect(t.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
      // 진짜 체크섬 검증 — 오타 주소는 여기서 걸린다.
      expect(tronUtils.crypto.isAddressValid(t.address)).toBe(true);
      // hex 왕복이 같은 주소로 돌아온다.
      expect(tronUtils.address.fromHex(tronUtils.address.toHex(t.address))).toBe(
        t.address,
      );
      expect(t.evidence.length).toBeGreaterThan(0);
      expect(t.symbol.length).toBeGreaterThan(0);
    }
  });

  it('decimals 대조는 체인값을 채택하고 불일치를 기록한다', () => {
    const known = { address: 'T', symbol: 'X', name: 'X', decimals: 6, evidence: 'e' };
    expect(reconcileKnownDecimals(known, 8)).toMatchObject({ decimals: 8 });
    expect(reconcileKnownDecimals(known, 8).note).toContain('불일치');
    expect(reconcileKnownDecimals(known, 6).note).toBeUndefined();
    // 체인을 못 읽었을 때만 내장 폴백, 그리고 미검증임을 적는다.
    expect(reconcileKnownDecimals(known, null).decimals).toBe(6);
    expect(reconcileKnownDecimals(known, null).note).toContain('미검증');
    // 내장 decimals 가 없으면 폴백도 없다 — 추측하지 않는다.
    expect(reconcileKnownDecimals(undefined, null).decimals).toBeNull();
  });
});

describe('TronAdapter.buildTransfer — asset 분기 (offline)', () => {
  function stubBuilders(adapter: TronAdapter): Internals['tron']['transactionBuilder'] {
    const tb = (adapter as unknown as Internals).tron.transactionBuilder;
    tb.triggerSmartContract = vi.fn(async () => ({
      result: { result: true },
      transaction: { txID: 'de'.repeat(32), raw_data: {} },
    }));
    tb.sendTrx = vi.fn(async () => ({ txID: 'ab'.repeat(32) }));
    return tb;
  }

  it('asset 이 없으면 기존 native 경로 그대로다 (회귀 방어)', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = stubBuilders(adapter);

    const out = await adapter.buildTransfer(
      { to: RECIPIENT, amount: 1_000_000n },
      CTX,
    );

    expect(tb.sendTrx).toHaveBeenCalledWith(RECIPIENT, 1_000_000, OWNER);
    expect(tb.triggerSmartContract).not.toHaveBeenCalled();
    expect(out.tx.txID).toBe('ab'.repeat(32));
  });

  it('asset 이 있으면 TRC-20 transfer(address,uint256) 를 부른다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = stubBuilders(adapter);

    const out = await adapter.buildTransfer(
      { to: RECIPIENT, amount: 123_456n, asset: TOKEN_A },
      CTX,
    );

    expect(tb.sendTrx).not.toHaveBeenCalled();
    expect(tb.triggerSmartContract).toHaveBeenCalledTimes(1);
    const [contract, selector, options, params, issuer] =
      tb.triggerSmartContract.mock.calls[0]!;
    expect(selector).toBe('transfer(address,uint256)');
    expect(contract).toBe(`41${'aa'.repeat(20)}`);
    expect(issuer).toBe(OWNER_HEX.toLowerCase());
    expect(params).toEqual([
      { type: 'address', value: `41${'dd'.repeat(20)}` },
      { type: 'uint256', value: '123456' },
    ]);
    expect((options as { callValue: number }).callValue).toBe(0);
    expect(out.tx.txID).toBe('de'.repeat(32));
  });

  it('feeLimit 을 반드시 설정한다 (기본 100 TRX, 덮어쓰기 가능)', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = stubBuilders(adapter);
    await adapter.buildTransfer(
      { to: RECIPIENT, amount: 1n, asset: TOKEN_A },
      CTX,
    );
    const opts = tb.triggerSmartContract.mock.calls[0]![2] as {
      feeLimit?: number;
    };
    expect(opts.feeLimit).toBe(100_000_000);

    const custom = makeAdapter(gridFetch([]), { feeLimitSun: 25_000_000 });
    const tb2 = stubBuilders(custom);
    await custom.buildTransfer(
      { to: RECIPIENT, amount: 1n, asset: TOKEN_A },
      CTX,
    );
    expect(
      (tb2.triggerSmartContract.mock.calls[0]![2] as { feeLimit?: number })
        .feeLimit,
    ).toBe(25_000_000);
  });

  it('base58 T… 과 0x41… hex 를 같은 hex 파라미터로 변환한다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = stubBuilders(adapter);

    await adapter.buildTransfer(
      { to: RECIPIENT, amount: 1n, asset: TOKEN_A },
      CTX,
    );
    await adapter.buildTransfer(
      {
        to: `0x41${'dd'.repeat(20)}`,
        amount: 1n,
        asset: `41${'aa'.repeat(20)}`,
      },
      CTX,
    );

    const [c1, , , p1] = tb.triggerSmartContract.mock.calls[0]!;
    const [c2, , , p2] = tb.triggerSmartContract.mock.calls[1]!;
    expect(c2).toBe(c1);
    expect(p2).toEqual(p1);
    // '0x41…' 를 그대로 tronweb 에 넘겼다면 '4141…' 이 됐을 것이다.
    expect(c1).not.toMatch(/^4141/);
  });

  it('체크섬이 깨진 주소는 트랜잭션을 만들지 않고 던진다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = stubBuilders(adapter);
    // 마지막 글자만 바꾼 주소 — 형식은 맞지만 base58check 가 깨진다.
    const tampered = `${RECIPIENT.slice(0, 33)}${
      RECIPIENT.endsWith('a') ? 'b' : 'a'
    }`;

    await expect(
      adapter.buildTransfer(
        { to: tampered, amount: 1n, asset: TOKEN_A },
        CTX,
      ),
    ).rejects.toThrow(/tron/);
    await expect(
      adapter.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: 'not-an-address' },
        CTX,
      ),
    ).rejects.toThrow(/asset/);
    expect(tb.triggerSmartContract).not.toHaveBeenCalled();
  });

  it('큰 금액을 Number 로 뭉개지 않는다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = stubBuilders(adapter);
    // 2^53 을 넘는 값 — Number 를 거치면 조용히 자릿수가 바뀐다.
    const huge = 123456789012345678901234567890n;
    await adapter.buildTransfer(
      { to: RECIPIENT, amount: huge, asset: TOKEN_A },
      CTX,
    );
    const params = tb.triggerSmartContract.mock.calls[0]![3] as Array<{
      value: string;
    }>;
    expect(params[1]!.value).toBe(huge.toString());
  });

  it('노드가 계약 호출 생성을 거부하면 던진다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    const tb = (adapter as unknown as Internals).tron.transactionBuilder;
    tb.triggerSmartContract = vi.fn(async () => ({
      result: { result: false, message: 'CONTRACT_VALIDATE_ERROR' },
    }));
    await expect(
      adapter.buildTransfer(
        { to: RECIPIENT, amount: 1n, asset: TOKEN_A },
        CTX,
      ),
    ).rejects.toThrow(/CONTRACT_VALIDATE_ERROR/);
  });

  it('0 이하 금액은 거부한다', async () => {
    const adapter = makeAdapter(gridFetch([]));
    stubBuilders(adapter);
    await expect(
      adapter.buildTransfer(
        { to: RECIPIENT, amount: 0n, asset: TOKEN_A },
        CTX,
      ),
    ).rejects.toThrow(/amount/);
  });
});
