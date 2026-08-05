// evm-asset-transfer.test.ts — asset(ERC-20) 규약에서 legacy/eip1559 두 분기가
// **같은 대상 주소**를 쓰는지 고정한다.
//
// buildTransfer 는 "무엇을 어디로 보낼지"(target/value/dataField)를 한 곳에서
// 정하는데, 그 결과를 소비하는 코드가 수수료 분기마다 복제돼 있었다. legacy 쪽만
// target 이 아니라 to(수신자)를 써서, asset 을 넣으면 토큰 컨트랙트가 아니라
// 수신자 EOA 로 value 0 + transfer calldata 가 나갔다 — 체인은 성공 처리하고
// 토큰은 1 wei 도 움직이지 않는다(수수료만 나간다).
//
// 라이브 RPC 를 두드리지 않기 위해 client 의 RPC 메서드만 monkey-patch 한다
// (evm-data-intent.test.ts 와 동일한 patchClient 패턴).

import { describe, expect, it } from 'vitest';
import { EvmAdapter, SoftSigner, TTL_CHAIN } from '../src/index.js';

const PRIV = new Uint8Array(32);
PRIV[31] = 1;

const SENDER = '0x0000000000000000000000000000000000000002';
const RECIPIENT = '0x0000000000000000000000000000000000000001';
// 소문자로 둔다. 대문자를 섞으면 EIP-55 체크섬을 맞춰야 하고, 틀린 체크섬은
// buildTransfer 는 통과하지만 signRequests 에서 예외가 난다.
const TOKEN = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** transfer(0x…0001, 1_000_000) 의 calldata. 셀렉터 + 32바이트 인자 2개. */
const EXPECTED_CALLDATA =
  '0xa9059cbb' +
  '0000000000000000000000000000000000000000000000000000000000000001' +
  '00000000000000000000000000000000000000000000000000000000000f4240';

/** estimateGas 가 받은 인자를 담아 두는 곳. 목이 인자를 버리면 그 회귀를 못 잡는다. */
type GasArgs = { to?: unknown; data?: unknown; value?: unknown };

function patchClient(
  adapter: EvmAdapter,
  opts: { eip1559: boolean },
  seen?: GasArgs[],
): void {
  const client = (adapter as unknown as { client: Record<string, unknown> }).client;
  client.getTransactionCount = async () => 0;
  client.estimateGas = async (args: GasArgs) => {
    seen?.push(args);
    return 51_000n;
  };
  client.getGasPrice = async () => 1_000_000_000n;
  client.estimateFeesPerGas = async () => ({
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  client.getBlock = async () => ({
    baseFeePerGas: opts.eip1559 ? 1_000_000_000n : null,
  });
}

async function build(feeMode: 'legacy' | 'eip1559', intent: {
  to: string;
  amount: bigint;
  asset?: string;
}, seen?: GasArgs[]) {
  const adapter = new EvmAdapter({ chain: TTL_CHAIN, feeMode });
  patchClient(adapter, { eip1559: feeMode === 'eip1559' }, seen);
  const signer = new SoftSigner({ curve: 'secp256k1', privateKey: PRIV });
  return adapter.buildTransfer(intent, { sender: SENDER, signer });
}

describe('EvmAdapter — asset(ERC-20) 전송의 대상 주소', () => {
  it('legacy + asset 이면 to 가 토큰 컨트랙트여야 한다', async () => {
    const unsigned = await build('legacy', {
      to: RECIPIENT,
      amount: 1_000_000n,
      asset: TOKEN,
    });
    expect(unsigned.type).toBe('legacy');
    expect(String(unsigned.to).toLowerCase()).toBe(TOKEN.toLowerCase());
  });

  it('legacy + asset 의 data 는 transfer(수신자,금액) calldata 이고 value 는 0', async () => {
    const unsigned = await build('legacy', {
      to: RECIPIENT,
      amount: 1_000_000n,
      asset: TOKEN,
    });
    expect((unsigned as { data?: unknown }).data).toBe(EXPECTED_CALLDATA);
    expect(unsigned.value).toBe(0n);
  });

  it('legacy 와 eip1559 가 같은 intent 에서 to/data/value 를 동일하게 만든다', async () => {
    const intent = { to: RECIPIENT, amount: 1_000_000n, asset: TOKEN };
    const l = await build('legacy', intent);
    const e = await build('eip1559', intent);

    expect([l.to, (l as { data?: unknown }).data, l.value]).toEqual([
      e.to,
      (e as { data?: unknown }).data,
      e.value,
    ]);
    // 갈라지는 것은 수수료 필드뿐이다.
    expect((l as { gasPrice?: bigint }).gasPrice).toBeDefined();
    expect((e as { maxFeePerGas?: bigint }).maxFeePerGas).toBeDefined();
  });

  // 가스 추정도 토큰 컨트랙트를 대상으로 해야 한다. 수신자 EOA 로 추정하면
  // ERC-20 전송을 native 전송(21,000)으로 잡아 실전에서 out-of-gas 로 죽는다.
  // unsigned.to 만 보는 단언은 이 회귀를 못 잡는다 — 추정 인자를 직접 고정한다.
  it.each(['legacy', 'eip1559'] as const)(
    '%s + asset 의 가스 추정 대상도 토큰 컨트랙트다',
    async (feeMode) => {
      const seen: GasArgs[] = [];
      await build(feeMode, { to: RECIPIENT, amount: 1_000_000n, asset: TOKEN }, seen);

      expect(seen).toHaveLength(1);
      expect(String(seen[0].to).toLowerCase()).toBe(TOKEN);
      expect(seen[0].data).toBe(EXPECTED_CALLDATA);
      expect(seen[0].value).toBe(0n);
    },
  );

  it('native(asset 없음) legacy 는 to 가 수신자 그대로', async () => {
    const unsigned = await build('legacy', { to: RECIPIENT, amount: 1n });
    expect(unsigned.to).toBe(RECIPIENT);
    expect((unsigned as { data?: unknown }).data).toBeUndefined();
    expect(unsigned.value).toBe(1n);
  });
});
