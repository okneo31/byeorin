// xrp-issued.test.ts — XRPL issued currency(트러스트라인 토큰) 조회 · 송금.
// 전부 offline: xrpl Client 를 가짜로 갈아 끼운다. 네트워크 호출 없음.

import { describe, expect, it } from 'vitest';
import type { Payment } from 'xrpl';
import { XrpAdapter, XRP_ISSUED_DECIMALS } from '../src/chains/xrp.js';
import { discoverPortableTokens } from '../src/tokens/portable.js';
import { Wallet } from '../src/index.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

/** 실존하는 XRPL 계정 주소 (genesis). 발행자로 쓴다. */
const ISSUER = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';
/** 테스트 니모닉에서 유도되는 주소. */
const OWNER = 'rnrbiYDUYTJS4JVdSV5FtyCj4HFuRjfLKM';

/** 'TTL' 을 40-hex 비표준 통화 코드로 쓴 것. */
const TTL_HEX = '54544C0000000000000000000000000000000000';

interface FakeXrpClient {
  request: (req: unknown) => Promise<unknown>;
  autofill: (tx: Payment) => Promise<Payment>;
}

/** adapter.client() 를 가짜로 대체한다. 인스턴스 프로퍼티가 프로토타입 메서드를 가린다. */
function installClient(adapter: XrpAdapter, fake: Partial<FakeXrpClient>): void {
  (adapter as unknown as { client: () => Promise<Partial<FakeXrpClient>> }).client =
    async () => fake;
}

function lineRes(lines: unknown[], marker?: unknown): unknown {
  return { result: { lines, ...(marker !== undefined ? { marker } : {}) } };
}

function line(over: Record<string, unknown>): Record<string, unknown> {
  return {
    account: ISSUER,
    currency: 'USD',
    balance: '0',
    limit: '1000000',
    limit_peer: '0',
    quality_in: 0,
    quality_out: 0,
    ...over,
  };
}

/** 서명자 · 발신 주소가 필요한 테스트용 컨텍스트. */
function ctxFor(adapter: XrpAdapter): { sender: string; signer: { curve: 'secp256k1'; publicKey: () => Promise<Uint8Array>; sign: (m: Uint8Array) => Promise<Uint8Array> } } {
  const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
  const acc = w.account(adapter);
  return { sender: acc.address, signer: acc.signer };
}

describe('XrpAdapter.discoverTokens — account_lines (체인 직접)', () => {
  it('트러스트라인을 PortableTokenBalance 로 옮긴다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, {
      request: async () =>
        lineRes([
          line({ currency: 'USD', balance: '123.456' }),
          line({ currency: TTL_HEX, balance: '0.000000000000001' }),
        ]),
    });

    const out = await xrp.discoverTokens(OWNER);
    expect(out.length).toBe(2);

    const usd = out[0]!;
    expect(usd.id).toBe(`USD.${ISSUER}`);
    expect(usd.symbol).toBe('USD');
    expect(usd.decimals).toBe(XRP_ISSUED_DECIMALS);
    // 15 자리 고정 정규화: 123.456 → 123456 * 10^12
    expect(usd.balance).toBe(123_456_000_000_000_000n);
    // 체인에서 직접 읽었으므로 source 는 비어 있다.
    expect(usd.source).toBeUndefined();

    const ttl = out[1]!;
    // id 는 원본 hex 코드를 유지해야 송금 때 되돌릴 수 있다.
    expect(ttl.id).toBe(`${TTL_HEX}.${ISSUER}`);
    // 보여줄 때만 ASCII 로 푼다.
    expect(ttl.symbol).toBe('TTL');
    expect(ttl.balance).toBe(1n);
  });

  it('잔액 0 인 트러스트라인도 포함한다 (사용자가 준비금을 걸고 연 자산)', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, { request: async () => lineRes([line({ balance: '0' })]) });
    const out = await xrp.discoverTokens(OWNER);
    expect(out.length).toBe(1);
    expect(out[0]!.balance).toBe(0n);
  });

  it('1e-15 미만은 0 으로 내려간다 — 15 자리 정규화의 대가', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, {
      request: async () => lineRes([line({ balance: '0.0000000000000001' })]),
    });
    const out = await xrp.discoverTokens(OWNER);
    expect(out[0]!.balance).toBe(0n);
  });

  it('지수 표기(1e-9)도 파싱한다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, { request: async () => lineRes([line({ balance: '1e-9' })]) });
    const out = await xrp.discoverTokens(OWNER);
    expect(out[0]!.balance).toBe(1_000_000n);
  });

  it('음수 잔액(빚진 라인)과 파싱 불가한 값은 버린다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, {
      request: async () =>
        lineRes([
          line({ currency: 'AAA', balance: '-5' }),
          line({ currency: 'BBB', balance: 'not-a-number' }),
          line({ currency: 'CCC', balance: 7 }),
          line({ currency: 'DDD', balance: '2' }),
        ]),
    });
    const out = await xrp.discoverTokens(OWNER);
    expect(out.map((t) => t.symbol)).toEqual(['DDD']);
  });

  it('marker 가 오면 다음 페이지를 이어서 받는다', async () => {
    const xrp = new XrpAdapter();
    let call = 0;
    installClient(xrp, {
      request: async () => {
        call++;
        return call === 1
          ? lineRes([line({ currency: 'AAA', balance: '1' })], { page: 2 })
          : lineRes([line({ currency: 'BBB', balance: '2' })]);
      },
    });
    const out = await xrp.discoverTokens(OWNER);
    expect(call).toBe(2);
    expect(out.map((t) => t.symbol)).toEqual(['AAA', 'BBB']);
  });

  it('요청이 실패하면 던지지 않고 빈 배열', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, {
      request: async () => {
        throw new Error('ws down');
      },
    });
    await expect(xrp.discoverTokens(OWNER)).resolves.toEqual([]);
  });

  it('응답 형식이 다르면 빈 배열', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, { request: async () => ({ result: { lines: 'nope' } }) });
    expect(await xrp.discoverTokens(OWNER)).toEqual([]);
  });

  it('타임아웃이 걸리면 빈 배열 — 첫 화면을 막지 않는다', async () => {
    const xrp = new XrpAdapter({ tokenTimeoutMs: 20 });
    installClient(xrp, { request: () => new Promise(() => {}) });
    expect(await xrp.discoverTokens(OWNER)).toEqual([]);
  });

  it('공통 진입점 discoverPortableTokens 로도 같은 결과', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, {
      request: async () => lineRes([line({ currency: 'USD', balance: '1' })]),
    });
    const out = await discoverPortableTokens(xrp, OWNER);
    expect(out.length).toBe(1);
    expect(out[0]!.id).toBe(`USD.${ISSUER}`);
  });
});

describe('XrpAdapter.buildTransfer — asset 분기', () => {
  function fakeAutofill(): Partial<FakeXrpClient> {
    return {
      autofill: async (tx: Payment) => ({
        ...tx,
        Fee: '12',
        Sequence: 1,
        LastLedgerSequence: 100,
      }),
    };
  }

  it('asset 없으면 native XRP — Amount 는 drops 문자열 (회귀 금지)', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, fakeAutofill());
    const { tx } = await xrp.buildTransfer(
      { to: ISSUER, amount: 1_000_000n },
      ctxFor(xrp),
    );
    expect(tx.Amount).toBe('1000000');
    expect(typeof tx.Amount).toBe('string');
  });

  it('asset 이 CUR.issuer 면 Amount 가 객체가 된다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, fakeAutofill());
    const { tx } = await xrp.buildTransfer(
      {
        to: ISSUER,
        amount: 123_456_000_000_000_000n,
        asset: `USD.${ISSUER}`,
      },
      ctxFor(xrp),
    );
    // 조회에서 만든 정수를 그대로 넣으면 원래 십진 값으로 돌아온다.
    expect(tx.Amount).toEqual({
      currency: 'USD',
      issuer: ISSUER,
      value: '123.456',
    });
  });

  it('40-hex 통화 코드도 그대로 실어 보낸다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, fakeAutofill());
    const { tx } = await xrp.buildTransfer(
      { to: ISSUER, amount: 10n ** 15n, asset: `${TTL_HEX}.${ISSUER}` },
      ctxFor(xrp),
    );
    expect(tx.Amount).toEqual({ currency: TTL_HEX, issuer: ISSUER, value: '1' });
  });

  it('형식이 틀린 asset 은 조용히 native 로 떨어지지 않고 던진다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, fakeAutofill());
    const bad = [
      'USD',                       // 발행자 없음
      'USD.not-an-address',        // 발행자 형식 오류
      `USDX.${ISSUER}`,            // 3글자도 40-hex 도 아님
      `XRP.${ISSUER}`,             // native 를 IOU 로 위장
    ];
    for (const asset of bad) {
      await expect(
        xrp.buildTransfer({ to: ISSUER, amount: 1n, asset }, ctxFor(xrp)),
      ).rejects.toThrow(/unsupported asset/);
    }
  });

  it('XRPL 정밀도(16 유효숫자)를 넘는 수량은 던진다', async () => {
    const xrp = new XrpAdapter();
    installClient(xrp, fakeAutofill());
    await expect(
      xrp.buildTransfer(
        { to: ISSUER, amount: 12_345_678_901_234_567n, asset: `USD.${ISSUER}` },
        ctxFor(xrp),
      ),
    ).rejects.toThrow(/precision/);
  });
});
