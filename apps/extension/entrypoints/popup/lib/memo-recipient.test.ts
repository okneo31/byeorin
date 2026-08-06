// memo-recipient 단위 테스트 — 실제 RPC 는 부르지 않는다(가짜 client 주입).
//
// 확인하는 것은 셋뿐이다: '0x'/undefined 는 EOA, 코드가 있으면 컨트랙트,
// 부를 수 없거나 실패하면 **던진다**(EOA 로 추정하지 않는다).

import { describe, expect, it } from 'vitest';
import { probeRecipientKind } from '../../../entrypoints/popup/lib/memo-recipient.js';

const ADDR = '0x1111111111111111111111111111111111111111';

function fakeAdapter(code: string | undefined | Error): unknown {
  return {
    client: {
      getCode(): Promise<string | undefined> {
        if (code instanceof Error) return Promise.reject(code);
        return Promise.resolve(code);
      },
    },
  };
}

describe('probeRecipientKind', () => {
  it("viem 이 '0x' 를 undefined 로 주는 경우도 EOA 다", async () => {
    await expect(probeRecipientKind(fakeAdapter(undefined), ADDR)).resolves.toBe('eoa');
  });

  it("'0x' 는 EOA", async () => {
    await expect(probeRecipientKind(fakeAdapter('0x'), ADDR)).resolves.toBe('eoa');
  });

  it('코드가 있으면 컨트랙트', async () => {
    await expect(probeRecipientKind(fakeAdapter('0x6080604052'), ADDR)).resolves.toBe(
      'contract',
    );
  });

  it('RPC 가 실패하면 던진다 — 모르는 것을 EOA 로 추정하지 않는다', async () => {
    await expect(
      probeRecipientKind(fakeAdapter(new Error('rpc down')), ADDR),
    ).rejects.toThrow();
  });

  it('getCode 를 못 부르는 어댑터도 던진다', async () => {
    await expect(probeRecipientKind({}, ADDR)).rejects.toThrow(/eth_getCode/);
  });
});
