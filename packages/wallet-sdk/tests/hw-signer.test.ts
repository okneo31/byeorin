// HwSigner — mock-transport based APDU/wiring tests.
//
// 실 디바이스 없이 검증할 수 있는 항목:
//   1) 옵션 검증(빈 path, 잘못된 path)
//   2) curve 선택(Solana → ed25519, Cosmos → secp256k1)
//   3) DER → 64-byte r||s 정규화(`derToCompactSig`) — Ledger Cosmos 앱이
//      반환할 수 있는 DER 형식 처리 경로
//   4) MockHwTransport 가 send(cla, ins, p1, p2, data) 호출을 그대로 기록
//
// 실제 `@ledgerhq/hw-app-*` 통합은 본 SDK 가 동적 import 로만 끌어쓰므로,
// 라이브러리 미설치 환경(=현재 CI) 에서도 본 테스트는 통과해야 한다. 그래서
// app 호출이 들어가는 경로(=signTransaction/sign)는 "라이브러리 없음" 에러 메시지가
// 던져지는 것까지를 검증한다.
//
// 알려진 테스트 벡터(Ledger Solana 앱 GET_PUBLIC_KEY APDU):
//   CLA=0xE0, INS=0x05, P1=0x00, P2=0x00, data=<derivation-path encoded>
// 본 테스트는 MockHwTransport 가 그 호출 모양을 그대로 기록한다는 것을 보인다.

import { describe, expect, it } from 'vitest';
import { HwSigner, derToCompactSig, type HwTransport } from '../src/index.js';

interface ApduCall {
  cla: number;
  ins: number;
  p1: number;
  p2: number;
  data: Uint8Array;
}

class MockHwTransport implements HwTransport {
  readonly calls: ApduCall[] = [];
  private readonly responses: Uint8Array[];
  private closed = false;

  constructor(responses: Uint8Array[] = []) {
    this.responses = responses;
  }

  async send(
    cla: number,
    ins: number,
    p1: number,
    p2: number,
    data?: Uint8Array,
  ): Promise<Uint8Array> {
    this.calls.push({ cla, ins, p1, p2, data: data ?? new Uint8Array() });
    const next = this.responses.shift();
    // Ledger APDU 응답 관례: 마지막 2바이트는 SW(0x9000 = OK). 빈 응답이면
    // SW 만 돌려준다.
    return next ?? new Uint8Array([0x90, 0x00]);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }
}

describe('HwSigner — option validation', () => {
  it('rejects empty derivation path', () => {
    expect(
      () =>
        new HwSigner({
          transport: new MockHwTransport(),
          appName: 'solana',
          derivationPath: '',
        }),
    ).toThrow(/must start with "m\/"/);
  });

  it('rejects derivation path missing "m/" prefix', () => {
    expect(
      () =>
        new HwSigner({
          transport: new MockHwTransport(),
          appName: 'solana',
          derivationPath: "44'/501'/0'/0'",
        }),
    ).toThrow(/must start with "m\/"/);
  });

  it('picks ed25519 curve for solana app', () => {
    const s = new HwSigner({
      transport: new MockHwTransport(),
      appName: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
    });
    expect(s.curve).toBe('ed25519');
    expect(s.appName).toBe('solana');
    expect(s.derivationPath).toBe("m/44'/501'/0'/0'");
  });

  it('picks secp256k1 curve for cosmos app', () => {
    const s = new HwSigner({
      transport: new MockHwTransport(),
      appName: 'cosmos',
      derivationPath: "m/44'/118'/0'/0/0",
    });
    expect(s.curve).toBe('secp256k1');
  });
});

describe('HwSigner — error surfacing on a non-conforming transport', () => {
  // @ledgerhq/hw-app-* 는 optionalDependency 이므로 워크스페이스에 *설치되어
  // 있을 수도, 없을 수도* 있다. 두 경우 모두 적절한 에러가 surfacing 되어야 한다:
  //   - 미설치: "not installed" 메시지 (HwSigner 가 던지는 것)
  //   - 설치됨: lib 가 MockHwTransport 의 빠진 메서드를 호출하다 실패
  // 어느 쪽이든 사용자 입장에서는 *에러가 던져진다* 는 보장이 중요하다 — 실 디바이스가
  // 없는 환경에서 임의로 호출했을 때 hang 하거나 무음 통과하면 안 된다.
  it('throws (one way or another) when signing solana without a real device', async () => {
    const transport = new MockHwTransport();
    const s = new HwSigner({
      transport,
      appName: 'solana',
      derivationPath: "m/44'/501'/0'/0'",
    });
    await expect(s.sign(new Uint8Array([1, 2, 3]))).rejects.toThrow();
  });

  it('throws (one way or another) when fetching cosmos pubkey without a real device', async () => {
    const transport = new MockHwTransport();
    const s = new HwSigner({
      transport,
      appName: 'cosmos',
      derivationPath: "m/44'/118'/0'/0/0",
    });
    await expect(s.publicKey()).rejects.toThrow();
  });
});

describe('MockHwTransport — APDU recording', () => {
  // 직접 send 호출 모양을 검증. Ledger Solana 앱의 GET_PUBLIC_KEY APDU 헤더 모양과
  // 일치하는지 확인 — `@ledgerhq/hw-app-solana` 가 설치되면 실제 호출도 이 헤더로
  // 나간다.
  it('records each send call faithfully', async () => {
    const transport = new MockHwTransport([
      // 가짜 GET_PUBLIC_KEY 응답: 32-byte pubkey + 0x9000
      new Uint8Array([...new Uint8Array(32).fill(0xab), 0x90, 0x00]),
    ]);
    const data = new Uint8Array([0x05, 0x80, 0x00, 0x00, 0x2c]);
    const resp = await transport.send(0xe0, 0x05, 0x00, 0x00, data);
    expect(transport.calls).toHaveLength(1);
    const call = transport.calls[0];
    expect(call).toBeDefined();
    if (!call) throw new Error('unreachable');
    expect(call.cla).toBe(0xe0);
    expect(call.ins).toBe(0x05);
    expect(call.p1).toBe(0x00);
    expect(call.p2).toBe(0x00);
    expect(Array.from(call.data)).toEqual(Array.from(data));
    expect(resp.length).toBe(34);
  });

  it('returns 0x9000 OK when no scripted response is queued', async () => {
    const transport = new MockHwTransport();
    const resp = await transport.send(0xe0, 0x04, 0x00, 0x00);
    expect(Array.from(resp)).toEqual([0x90, 0x00]);
  });

  it('marks closed after close()', async () => {
    const transport = new MockHwTransport();
    expect(transport.isClosed()).toBe(false);
    await transport.close();
    expect(transport.isClosed()).toBe(true);
  });
});

describe('derToCompactSig — DER → 64-byte r||s normalisation', () => {
  // Ledger Cosmos 앱은 버전에 따라 DER 또는 r||s 를 반환한다. 우리는 둘 다
  // 받아 64-byte r||s 로 통일한다.
  it('decodes a canonical DER (no leading zero) into 64-byte r||s', () => {
    // 0x30 06  02 02 0102  02 02 0304  → r=0102, s=0304
    const der = new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x01, 0x02, 0x02, 0x02, 0x03, 0x04]);
    const sig = derToCompactSig(der);
    expect(sig.length).toBe(64);
    // r = 30 bytes zero || 0x01 0x02
    expect(sig[30]).toBe(0x01);
    expect(sig[31]).toBe(0x02);
    // s = 30 bytes zero || 0x03 0x04
    expect(sig[62]).toBe(0x03);
    expect(sig[63]).toBe(0x04);
  });

  it('strips the DER positive-padding 0x00 prefix on r/s', () => {
    // r = 0x00 80 (DER 양수 표현용 0x00) → 실제 r 는 0x80
    // s = 0x00 ff → 실제 s 는 0xff
    const der = new Uint8Array([
      0x30, 0x08,
      0x02, 0x02, 0x00, 0x80,
      0x02, 0x02, 0x00, 0xff,
    ]);
    const sig = derToCompactSig(der);
    expect(sig[31]).toBe(0x80);
    expect(sig[63]).toBe(0xff);
    // 앞 31 바이트는 0
    for (let i = 0; i < 31; i++) expect(sig[i]).toBe(0);
  });

  it('throws on non-sequence input', () => {
    expect(() => derToCompactSig(new Uint8Array([0x00, 0x01]))).toThrow();
  });
});
