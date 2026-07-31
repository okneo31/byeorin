// btc-electrum.test.ts — Electrum 클라이언트 모듈 (btc-history/electrum) 테스트.
// 실행: pnpm --filter @byeorin/wallet-sdk exec vitest run tests/btc-electrum

import { describe, expect, it } from 'vitest';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import type { ByteTransport, ByteTransportOptions } from '../src/btc-history/transport.js';
import { isByteTransport } from '../src/btc-history/transport.js';
import {
  ElectrumClient,
  ElectrumError,
  addressToScripthash,
  addressToScriptPubKey,
  scriptPubKeyToScripthash,
  toActivityRows,
  type ElectrumHistoryItem,
} from '../src/btc-history/electrum/index.js';

// ── 모의 전송 ──────────────────────────────────────────────────────

/** 스크립트된 응답을 재생하는 ByteTransport. 조각내기(chunking)도 지원. */
class MockTransport implements ByteTransport {
  sentLines: string[] = [];
  connected = false;
  /** 클라이언트가 한 줄 보낼 때마다 호출 — 파싱된 요청과 원문을 준다. */
  onRequest: ((req: { id: number; method: string; params: unknown[] }, line: string) => void) | null =
    null;

  private dataCb: ((bytes: Uint8Array) => void) | null = null;
  private closeCb: ((err?: Error) => void) | null = null;
  private readonly enc = new TextEncoder();
  private readonly dec = new TextDecoder();

  async connect(_host: string, _port: number, _opts?: ByteTransportOptions): Promise<void> {
    this.connected = true;
  }
  async send(bytes: Uint8Array): Promise<void> {
    const line = this.dec.decode(bytes);
    this.sentLines.push(line);
    if (this.onRequest) {
      const req = JSON.parse(line) as { id: number; method: string; params: unknown[] };
      this.onRequest(req, line);
    }
  }
  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataCb = cb;
  }
  onClose(cb: (err?: Error) => void): void {
    this.closeCb = cb;
  }
  async close(): Promise<void> {
    this.connected = false;
    this.closeCb?.();
  }

  /** 서버 → 클라이언트 텍스트 주입. */
  emit(text: string): void {
    this.dataCb?.(this.enc.encode(text));
  }
  /** chunkSize 바이트씩 잘라 주입 — 스트림 조각 시뮬레이션. */
  emitChunked(text: string, chunkSize: number): void {
    const bytes = this.enc.encode(text);
    for (let i = 0; i < bytes.length; i += chunkSize) {
      this.dataCb?.(bytes.subarray(i, i + chunkSize));
    }
  }
  /** 비정상 종료 시뮬레이션. */
  emitClose(err?: Error): void {
    this.closeCb?.(err);
  }
}

function makeClient(opts?: { timeoutMs?: number }) {
  const transport = new MockTransport();
  const client = new ElectrumClient(transport, opts);
  return { transport, client };
}

function responseLine(id: number, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

// ── scripthash 변환 ────────────────────────────────────────────────

describe('addressToScripthash', () => {
  it('P2PKH — 사토시 제네시스 주소 (electrumx 문서 벡터, 이 저장소에서 재계산 검증)', () => {
    expect(addressToScripthash('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(
      '8b01df4e368ea28f8dc0423bcf7a4923e3a12d307c875e47a0cfbf90b5c39161',
    );
    expect(bytesToHex(addressToScriptPubKey('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'))).toBe(
      '76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac',
    );
  });

  it('P2WPKH — BIP-173 벡터 주소의 알려진 scriptPubKey 와 대조', () => {
    // BIP-173: bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
    //   → scriptPubKey 0014751e76e8199196d454941c45d1b3a323f1433bd6
    const knownScript = hexToBytes('0014751e76e8199196d454941c45d1b3a323f1433bd6');
    expect(bytesToHex(addressToScriptPubKey('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'))).toBe(
      bytesToHex(knownScript),
    );
    expect(addressToScripthash('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toBe(
      scriptPubKeyToScripthash(knownScript),
    );
  });

  it('P2SH — 알려진 hash160 으로 손수 만든 스크립트와 대조', () => {
    // 3P14159f73E4gFr7JterCCQh9QjiTjiZrG 의 hash160 =
    // e9c3dd0c07aac76179ebc76a6c78d4d67c6c160a (base58check 디코드로 확인)
    const knownScript = hexToBytes('a914e9c3dd0c07aac76179ebc76a6c78d4d67c6c160a87');
    expect(bytesToHex(addressToScriptPubKey('3P14159f73E4gFr7JterCCQh9QjiTjiZrG'))).toBe(
      bytesToHex(knownScript),
    );
    expect(addressToScripthash('3P14159f73E4gFr7JterCCQh9QjiTjiZrG')).toBe(
      scriptPubKeyToScripthash(knownScript),
    );
  });

  it('scriptPubKeyToScripthash = reverse(sha256(script)) 정의 그대로', () => {
    const script = hexToBytes('76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac');
    const manual = bytesToHex(sha256(script).reverse());
    expect(scriptPubKeyToScripthash(script)).toBe(manual);
  });

  it('테스트넷 주소는 network 인자로 디코드된다', () => {
    // btc.test.ts 의 검증된 테스트넷 주소 재사용.
    const h = addressToScripthash('tb1qquv9lg5g2r4jkr0ahun0ddfg5xntxjelvmc7t8', 'testnet');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // 메인넷 코덱으로는 디코드 실패해야 한다.
    expect(() => addressToScripthash('tb1qquv9lg5g2r4jkr0ahun0ddfg5xntxjelvmc7t8')).toThrow();
  });
});

// ── 줄 조립 ────────────────────────────────────────────────────────

describe('ElectrumClient — 줄 조립', () => {
  it('응답이 여러 조각으로 쪼개져 와도 조립한다 (3바이트 청크)', async () => {
    const { transport, client } = makeClient();
    transport.onRequest = ({ id }) => {
      transport.emitChunked(responseLine(id, ['ElectrumX 1.16.0', '1.4']), 3);
    };
    await expect(client.version('byeorin-test')).resolves.toEqual(['ElectrumX 1.16.0', '1.4']);
  });

  it('한 조각에 여러 응답이 붙어 와도 각각 처리한다', async () => {
    const { transport, client } = makeClient();
    const reqs: number[] = [];
    transport.onRequest = ({ id }) => {
      reqs.push(id);
      if (reqs.length === 2) {
        // 두 응답을 한 번에 밀어 넣는다.
        transport.emit(
          responseLine(reqs[0]!, { confirmed: 100, unconfirmed: 0 }) +
            responseLine(reqs[1]!, { confirmed: 200, unconfirmed: 5 }),
        );
      }
    };
    const [a, b] = await Promise.all([client.getBalance('aa'.repeat(32)), client.getBalance('bb'.repeat(32))]);
    expect(a).toEqual({ confirmed: 100, unconfirmed: 0 });
    expect(b).toEqual({ confirmed: 200, unconfirmed: 5 });
  });

  it('CRLF 줄끝도 처리한다', async () => {
    const { transport, client } = makeClient();
    transport.onRequest = ({ id }) => {
      transport.emit(JSON.stringify({ jsonrpc: '2.0', id, result: 'deadbeef' }) + '\r\n');
    };
    await expect(client.getTransaction('ab'.repeat(32))).resolves.toBe('deadbeef');
  });
});

// ── id 매칭 ────────────────────────────────────────────────────────

describe('ElectrumClient — id 매칭', () => {
  it('다른 id 의 응답은 절대 배정하지 않는다 (응답 섞임 방지)', async () => {
    const { transport, client } = makeClient({ timeoutMs: 200 });
    transport.onRequest = ({ id }) => {
      // 엉뚱한 id 로 먼저 응답 → 무시되어야 한다. 그 뒤 올바른 id.
      transport.emit(responseLine(id + 999, 'WRONG'));
      transport.emit(responseLine(id, 'raw-tx-hex'));
    };
    await expect(client.getTransaction('cd'.repeat(32))).resolves.toBe('raw-tx-hex');
  });

  it('순서가 뒤바뀐 동시 응답도 각자 제 요청으로 간다', async () => {
    const { transport, client } = makeClient();
    const reqs: { id: number; params: unknown[] }[] = [];
    transport.onRequest = ({ id, params }) => {
      reqs.push({ id, params });
      if (reqs.length === 2) {
        // 두 번째 요청에 먼저 응답 (역순).
        transport.emit(responseLine(reqs[1]!.id, [{ tx_hash: 'b'.repeat(64), height: 2 }]));
        transport.emit(responseLine(reqs[0]!.id, [{ tx_hash: 'a'.repeat(64), height: 1 }]));
      }
    };
    const [h1, h2] = await Promise.all([
      client.getHistory('11'.repeat(32)),
      client.getHistory('22'.repeat(32)),
    ]);
    expect(h1[0]!.tx_hash).toBe('a'.repeat(64));
    expect(h2[0]!.tx_hash).toBe('b'.repeat(64));
  });

  it('숫자가 아닌 id·JSON 아닌 줄은 버리고 계속 동작한다', async () => {
    const { transport, client } = makeClient({ timeoutMs: 200 });
    transport.onRequest = ({ id }) => {
      transport.emit('this is not json\n');
      transport.emit(responseLine('weird-id' as unknown as number, 'X'));
      transport.emit(responseLine(id, 'ok'));
    };
    await expect(client.getTransaction('ef'.repeat(32))).resolves.toBe('ok');
  });
});

// ── 타임아웃 · 오류 · 종료 ─────────────────────────────────────────

describe('ElectrumClient — 타임아웃·오류·종료', () => {
  it('응답이 없으면 timeoutMs 안에 거부된다', async () => {
    const { client } = makeClient({ timeoutMs: 50 });
    await expect(client.version('byeorin-test')).rejects.toThrow(/50ms 초과/);
  });

  it('요청별 timeoutMs 가 클라이언트 기본값을 덮는다', async () => {
    const { client } = makeClient({ timeoutMs: 10_000 });
    await expect(client.getHistory('ab'.repeat(32), { timeoutMs: 50 })).rejects.toThrow(/50ms/);
  });

  it('서버 error 응답은 ElectrumError 로 거부된다', async () => {
    const { transport, client } = makeClient();
    transport.onRequest = ({ id }) => {
      transport.emit(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: 1, message: 'invalid scripthash' },
        }) + '\n',
      );
    };
    const err = await client.getBalance('zz').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ElectrumError);
    expect((err as ElectrumError).code).toBe(1);
    expect((err as ElectrumError).message).toContain('invalid scripthash');
  });

  it('연결이 끊기면 대기 중 요청이 전부 거부된다', async () => {
    const { transport, client } = makeClient();
    const p1 = client.getHistory('11'.repeat(32));
    const p2 = client.getBalance('22'.repeat(32));
    transport.emitClose(new Error('socket reset'));
    await expect(p1).rejects.toThrow('socket reset');
    await expect(p2).rejects.toThrow('socket reset');
    // 닫힌 뒤 새 요청은 즉시 거부.
    await expect(client.version('x')).rejects.toThrow(/닫힌/);
  });

  it('타임아웃 응답 형태 검증 — 어긋난 get_history 결과는 예외', async () => {
    const { transport, client } = makeClient();
    transport.onRequest = ({ id }) => {
      transport.emit(responseLine(id, [{ nope: true }]));
    };
    await expect(client.getHistory('ab'.repeat(32))).rejects.toThrow(/형태가 어긋남/);
  });
});

// ── 알림 (headers.subscribe) ───────────────────────────────────────

describe('ElectrumClient — headersSubscribe · 알림', () => {
  it('구독 결과로 현재 팁을 받고, 이후 알림은 onHeader 로 온다', async () => {
    const { transport, client } = makeClient();
    transport.onRequest = ({ id, method }) => {
      if (method === 'blockchain.headers.subscribe') {
        transport.emit(responseLine(id, { height: 850_000, hex: '00'.repeat(80) }));
      }
    };
    const seen: number[] = [];
    client.onHeader((h) => seen.push(h.height));

    const tip = await client.headersSubscribe();
    expect(tip.height).toBe(850_000);

    // id 없는 서버 알림 주입.
    transport.emit(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'blockchain.headers.subscribe',
        params: [{ height: 850_001, hex: '11'.repeat(80) }],
      }) + '\n',
    );
    expect(seen).toEqual([850_001]);
  });
});

// ── 요청 인코딩 · 전송 계약 ────────────────────────────────────────

describe('ElectrumClient — 요청 인코딩', () => {
  it('요청은 JSON-RPC 2.0 한 줄(\\n 종결)로 나간다', async () => {
    const { transport, client } = makeClient({ timeoutMs: 50 });
    await client.version('byeorin').catch(() => undefined); // 응답은 없음 — 전송분만 검사
    expect(transport.sentLines).toHaveLength(1);
    const line = transport.sentLines[0]!;
    expect(line.endsWith('\n')).toBe(true);
    const req = JSON.parse(line) as Record<string, unknown>;
    expect(req.jsonrpc).toBe('2.0');
    expect(req.method).toBe('server.version');
    expect(req.params).toEqual(['byeorin', '1.4']);
    expect(typeof req.id).toBe('number');
  });

  it('MockTransport 는 ByteTransport 계약을 만족한다', () => {
    expect(isByteTransport(new MockTransport())).toBe(true);
  });
});

// ── history 변환 ───────────────────────────────────────────────────

describe('toActivityRows', () => {
  it('Electrum 이 준 필드만 담는다 — 컨펌·멤풀 혼합, 순서 보존', () => {
    const items: ElectrumHistoryItem[] = [
      { tx_hash: 'a'.repeat(64), height: 800_000 },
      { tx_hash: 'b'.repeat(64), height: 0, fee: 1234 },
      { tx_hash: 'c'.repeat(64), height: -1, fee: 200 },
    ];
    const rows = toActivityRows(items);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ txid: 'a'.repeat(64), height: 800_000, confirmed: true });
    expect(rows[0]!.fee).toBeUndefined();
    expect(rows[1]).toMatchObject({ txid: 'b'.repeat(64), height: 0, confirmed: false, fee: 1234 });
    expect(rows[2]).toMatchObject({ txid: 'c'.repeat(64), height: -1, confirmed: false, fee: 200 });
    expect(rows[1]!.raw).toBe(items[1]);
  });

  it('형태가 어긋난 항목은 조용히 버리지 않고 예외를 던진다', () => {
    expect(() => toActivityRows([{ txid: 'oops' } as unknown as ElectrumHistoryItem])).toThrow(
      /get_history\[0\]/,
    );
  });
});

// ── 라이브 테스트 (기본 skip) ──────────────────────────────────────
//
// 실행 방법: 아래 describe.skip 을 describe 로 바꾸고
//   pnpm --filter @byeorin/wallet-sdk exec vitest run tests/btc-electrum -t 라이브
// 네트워크 필요: electrum.blockstream.info:50001 (TCP, 평문).
// 실측 근거(이 저장소 세션): server.version 406ms · get_history 3.6s.

describe.skip('ElectrumClient — 라이브 (electrum.blockstream.info:50001)', () => {
  it('제네시스 주소 이력을 실서버에서 받는다', async () => {
    const net = await import('node:net');
    const socket = new net.Socket();
    const transport: ByteTransport = {
      connect: (host, port, opts) =>
        new Promise<void>((resolve, reject) => {
          if (opts?.tls) return reject(new Error('이 라이브 테스트는 평문 50001 전용'));
          socket.setTimeout(opts?.timeoutMs ?? 8000, () => socket.destroy(new Error('connect timeout')));
          socket.once('error', reject);
          socket.connect(port, host, () => {
            socket.setTimeout(0);
            resolve();
          });
        }),
      send: (bytes) =>
        new Promise<void>((resolve, reject) =>
          socket.write(bytes, (e) => (e ? reject(e) : resolve())),
        ),
      onData: (cb) => socket.on('data', (buf: Buffer) => cb(new Uint8Array(buf))),
      onClose: (cb) => socket.on('close', () => cb()),
      close: async () => void socket.destroy(),
    };

    const client = new ElectrumClient(transport, { timeoutMs: 15_000 });
    await client.connect('electrum.blockstream.info', 50001);
    try {
      const [server, protocol] = await client.version('byeorin-wallet-test');
      expect(protocol).toBe('1.4');
      expect(server.length).toBeGreaterThan(0);

      const scripthash = addressToScripthash('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
      const history = await client.getHistory(scripthash);
      expect(history.length).toBeGreaterThan(0);
      // 제네시스 코인베이스는 프로토콜상 지출 불가라 이력이 계속 쌓이기만 한다.
      const rows = toActivityRows(history);
      expect(rows[0]!.confirmed).toBe(true);
    } finally {
      await client.close();
    }
  }, 30_000);
});
