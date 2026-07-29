// ton-jettons.test.ts — TON jetton 조회(인덱서) + jetton transfer 메시지 구성.
// 전부 offline: fetch 와 TonClient 를 가짜로 갈아 끼운다.
//
// 송금 테스트는 서명 대상이 되는 셀을 **다시 파싱해서** 구조를 확인한다.
// jetton 송금은 native 와 레이아웃이 완전히 달라서, "빌드가 던지지 않았다"는
// 것만으로는 아무것도 보장하지 못하기 때문이다.

import { describe, expect, it } from 'vitest';
import {
  Address as TonAddress,
  Cell,
  loadMessageRelaxed,
  type MessageRelaxed,
} from '@ton/ton';
import { TonAdapter } from '../src/chains/ton.js';
import { discoverPortableTokens } from '../src/tokens/portable.js';
import { Wallet } from '../src/index.js';
import type { TransferIntent } from '../src/types.js';

const KNOWN_MNEMONIC =
  'test test test test test test test test test test test junk';

const MASTER = new TonAddress(0, Buffer.alloc(32, 0x11));
const JETTON_WALLET = new TonAddress(0, Buffer.alloc(32, 0x22));
const DEST = new TonAddress(0, Buffer.alloc(32, 0x33));

const OWNER = 'EQAtUn6khf4MxnAB4aQNcDlUPNOsLtU8IOVZbIabFzw9Kbar';

// ── 조회 ─────────────────────────────────────────────────────

function jsonFetch(body: unknown, ok = true): typeof fetch {
  return (async () =>
    ({
      ok,
      status: ok ? 200 : 500,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

function balance(over: Record<string, unknown> = {}): unknown {
  return {
    balance: '1500000000',
    wallet_address: { address: JETTON_WALLET.toRawString() },
    jetton: {
      address: MASTER.toRawString(),
      name: 'Test Jetton',
      symbol: 'TJT',
      decimals: 9,
    },
    ...over,
  };
}

describe('TonAdapter.discoverTokens — jetton (인덱서)', () => {
  it('인덱서 응답을 옮기고 출처를 남긴다', async () => {
    const ton = new TonAdapter({ fetch: jsonFetch({ balances: [balance()] }) });
    const out = await ton.discoverTokens(OWNER);
    expect(out.length).toBe(1);
    expect(out[0]).toEqual({
      // raw 형(0:…)이 아니라 사용자 친화형으로 정규화한다.
      id: MASTER.toString({ bounceable: true, testOnly: false, urlSafe: true }),
      symbol: 'TJT',
      name: 'Test Jetton',
      decimals: 9,
      balance: 1_500_000_000n,
      // 체인이 아니라 인덱서가 말해준 값이다.
      source: 'tonapi.io',
    });
  });

  it('testnet 은 testnet 인덱서와 testnet 주소 표기를 쓴다', async () => {
    const ton = new TonAdapter({
      network: 'testnet',
      fetch: jsonFetch({ balances: [balance()] }),
    });
    expect(ton.jettonApiUrl).toBe('https://testnet.tonapi.io');
    const out = await ton.discoverTokens(OWNER);
    expect(out[0]!.id).toBe(
      MASTER.toString({ bounceable: true, testOnly: true, urlSafe: true }),
    );
    expect(out[0]!.source).toBe('testnet.tonapi.io');
  });

  it('decimals 를 못 얻거나 정수가 아니면 그 항목을 버린다', async () => {
    for (const bad of [undefined, null, '9', 1.5, -1]) {
      const ton = new TonAdapter({
        fetch: jsonFetch({
          balances: [balance({ jetton: { address: MASTER.toRawString(), symbol: 'X', decimals: bad } })],
        }),
      });
      expect(await ton.discoverTokens(OWNER)).toEqual([]);
    }
  });

  it('symbol 이나 잔액 형식이 깨지면 버린다', async () => {
    const ton = new TonAdapter({
      fetch: jsonFetch({
        balances: [
          balance({ balance: 'abc' }),
          balance({ jetton: { address: MASTER.toRawString(), symbol: '', decimals: 9 } }),
          balance({ jetton: { address: 'not-an-address', symbol: 'Z', decimals: 9 } }),
          balance({ balance: '7' }),
        ],
      }),
    });
    const out = await ton.discoverTokens(OWNER);
    expect(out.map((t) => t.balance)).toEqual([7n]);
  });

  it('HTTP 오류 · 형식 불일치 · 네트워크 실패는 전부 빈 배열', async () => {
    expect(await new TonAdapter({ fetch: jsonFetch({}, false) }).discoverTokens(OWNER)).toEqual([]);
    expect(await new TonAdapter({ fetch: jsonFetch({ nope: 1 }) }).discoverTokens(OWNER)).toEqual([]);
    expect(
      await new TonAdapter({ fetch: jsonFetch({ balances: 'x' }) }).discoverTokens(OWNER),
    ).toEqual([]);
    const boom = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;
    expect(await new TonAdapter({ fetch: boom }).discoverTokens(OWNER)).toEqual([]);
  });

  it('타임아웃이 걸리면 빈 배열 — 첫 화면을 막지 않는다', async () => {
    const hang = ((_u: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_r, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const ton = new TonAdapter({ fetch: hang, tokenTimeoutMs: 20 });
    expect(await ton.discoverTokens(OWNER)).toEqual([]);
  });

  it('jettonApiUrl: null 이면 조회하지 않는다', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return { ok: true, json: async () => ({ balances: [] }) } as unknown as Response;
    }) as unknown as typeof fetch;
    const ton = new TonAdapter({ jettonApiUrl: null, fetch: f });
    expect(await ton.discoverTokens(OWNER)).toEqual([]);
    expect(called).toBe(false);
  });

  it('공통 진입점 discoverPortableTokens 로도 같은 결과', async () => {
    const ton = new TonAdapter({ fetch: jsonFetch({ balances: [balance()] }) });
    const out = await discoverPortableTokens(ton, OWNER);
    expect(out.length).toBe(1);
    expect(out[0]!.symbol).toBe('TJT');
  });
});

// ── 송금 ─────────────────────────────────────────────────────

interface FakeTonClient {
  open: (w: unknown) => { getSeqno: () => Promise<number> };
  runMethod: (
    addr: TonAddress,
    name: string,
    stack: unknown[],
  ) => Promise<{ stack: { readAddress: () => TonAddress } }>;
}

interface RunMethodCall {
  address: string;
  method: string;
}

function installClient(
  adapter: TonAdapter,
  calls: RunMethodCall[],
  seqno = 5,
): void {
  const fake: FakeTonClient = {
    open: () => ({ getSeqno: async () => seqno }),
    runMethod: async (addr, name) => {
      calls.push({ address: addr.toString(), method: name });
      return { stack: { readAddress: () => JETTON_WALLET } };
    },
  };
  (adapter as unknown as { client: FakeTonClient }).client = fake;
}

/** v4 서명 메시지에서 실제 내부 메시지를 다시 꺼낸다. */
function parseSigningMessage(cell: Cell): MessageRelaxed {
  const s = cell.beginParse();
  s.loadUint(32); // walletId
  s.loadUint(32); // timeout (또는 0xffffffff)
  s.loadUint(32); // seqno
  expect(s.loadUint(8)).toBe(0); // op = sendMsg
  s.loadUint(8); // sendMode
  return loadMessageRelaxed(s.loadRef().beginParse());
}

async function buildMessage(
  adapter: TonAdapter,
  intent: TransferIntent,
): Promise<MessageRelaxed> {
  const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
  const acc = w.account(adapter);
  const tx = await adapter.buildTransfer(intent, {
    sender: acc.address,
    signer: acc.signer,
  });
  return parseSigningMessage(tx.signingMessage);
}

describe('TonAdapter.buildTransfer — asset 분기', () => {
  it('asset 없으면 native TON — 받는 사람에게 직접, bounce=false (회귀 금지)', async () => {
    const ton = new TonAdapter();
    installClient(ton, []);
    const msg = await buildMessage(ton, { to: DEST.toString(), amount: 1_000_000_000n });
    if (msg.info.type !== 'internal') throw new Error('expected internal message');
    expect(msg.info.dest.toString()).toBe(DEST.toString());
    expect(msg.info.value.coins).toBe(1_000_000_000n);
    expect(msg.info.bounce).toBe(false);
  });

  it('jetton 송금은 내 jetton wallet 으로 가고, 수량은 body 안에 들어간다', async () => {
    const ton = new TonAdapter();
    const calls: RunMethodCall[] = [];
    installClient(ton, calls);

    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const sender = w.account(ton).address;

    const msg = await buildMessage(ton, {
      to: DEST.toString(),
      amount: 1_500n,
      asset: MASTER.toString(),
    });

    // jetton wallet 주소는 master 계약에게 물어봐서 얻는다 (오프체인 계산 아님).
    expect(calls).toEqual([
      { address: MASTER.toString(), method: 'get_wallet_address' },
    ]);

    if (msg.info.type !== 'internal') throw new Error('expected internal message');
    // 목적지는 받는 사람이 아니라 내 jetton wallet 이다.
    expect(msg.info.dest.toString()).toBe(JETTON_WALLET.toString());
    // 실려 가는 TON 은 수수료용이고, jetton 수량이 아니다.
    expect(msg.info.value.coins).toBe(50_000_000n);
    // 실패 시 TON 이 되돌아와야 한다.
    expect(msg.info.bounce).toBe(true);

    const b = msg.body.beginParse();
    expect(b.loadUint(32)).toBe(0x0f8a7ea5); // TEP-74 transfer
    expect(b.loadUintBig(64)).toBe(0n); // query_id
    expect(b.loadCoins()).toBe(1_500n); // jetton 수량
    expect(b.loadAddress().toString()).toBe(DEST.toString()); // 받는 사람
    expect(b.loadAddress().toString()).toBe(sender); // 잔돈 반환처 = 보낸 사람
    expect(b.loadBit()).toBe(false); // custom_payload 없음
    expect(b.loadCoins()).toBe(0n); // forward_ton_amount
    expect(b.loadBit()).toBe(false); // forward_payload 비어 있음
  });

  it('memo 를 주면 forward_ton_amount 를 붙여 코멘트가 실제로 전달되게 한다', async () => {
    const ton = new TonAdapter();
    installClient(ton, []);
    const msg = await buildMessage(ton, {
      to: DEST.toString(),
      amount: 1n,
      asset: MASTER.toString(),
      memo: '월급',
    });
    const b = msg.body.beginParse();
    b.loadUint(32);
    b.loadUintBig(64);
    b.loadCoins();
    b.loadAddress();
    b.loadAddress();
    b.loadBit();
    // 0 이면 코멘트가 그냥 사라진다.
    expect(b.loadCoins()).toBe(1n);
    expect(b.loadBit()).toBe(true); // forward_payload 는 참조 셀
    const fwd = b.loadRef().beginParse();
    expect(fwd.loadUint(32)).toBe(0); // 텍스트 코멘트 op
    expect(fwd.loadStringTail()).toBe('월급');
  });

  it('jettonGasNanoton 으로 붙여 보낼 TON 을 조정할 수 있다', async () => {
    const ton = new TonAdapter({ jettonGasNanoton: 100_000_000n });
    installClient(ton, []);
    const msg = await buildMessage(ton, {
      to: DEST.toString(),
      amount: 1n,
      asset: MASTER.toString(),
    });
    if (msg.info.type !== 'internal') throw new Error('expected internal message');
    expect(msg.info.value.coins).toBe(100_000_000n);
  });

  it('asset 이 주소가 아니면 던진다 — 조용히 native 로 떨어지지 않는다', async () => {
    const ton = new TonAdapter();
    installClient(ton, []);
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ton);
    await expect(
      ton.buildTransfer(
        { to: DEST.toString(), amount: 1n, asset: 'not-a-jetton' },
        { sender: acc.address, signer: acc.signer },
      ),
    ).rejects.toThrow(/unsupported asset/);
  });

  it('jetton wallet 주소를 못 얻으면 던진다 — 반쯤 된 송금을 만들지 않는다', async () => {
    const ton = new TonAdapter();
    (
      ton as unknown as {
        client: {
          open: () => { getSeqno: () => Promise<number> };
          runMethod: () => Promise<never>;
        };
      }
    ).client = {
      open: () => ({ getSeqno: async () => 5 }),
      runMethod: async () => {
        throw new Error('get-method failed');
      },
    };
    const w = Wallet.fromMnemonic({ mnemonic: KNOWN_MNEMONIC });
    const acc = w.account(ton);
    await expect(
      ton.buildTransfer(
        { to: DEST.toString(), amount: 1n, asset: MASTER.toString() },
        { sender: acc.address, signer: acc.signer },
      ),
    ).rejects.toThrow(/get-method failed/);
  });
});
