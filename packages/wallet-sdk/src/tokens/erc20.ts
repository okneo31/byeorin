// erc20.ts — 최소 ERC-20 클라이언트.
//
// EvmAdapter 위에 얹어서 ERC-20 컨트랙트에 대한 read 호출(balanceOf, decimals,
// symbol, name)과 transfer calldata 생성을 제공한다.
//
// transfer 는 직접 broadcast 하지 않고 TransferIntent 를 반환한다 — 호출자
// (wallet-store 등)는 이 intent 를 그대로 wallet.transfer() 에 흘려 보내면
// 된다. 이렇게 함으로써 ERC-20 송금도 native 송금과 동일한 서명·브로드캐스트
// 경로를 탄다.
//
// 의도적으로 ABI 는 4 개 함수만 인라인으로 들고 있다 (전체 ERC-20 ABI 를
// 끌어오면 bundle 이 무거워지고, 우리가 호출하는 건 이게 전부이기 때문).

import {
  decodeFunctionResult,
  encodeFunctionData,
  type Hex,
  type PublicClient,
} from 'viem';
import type { EvmAdapter } from '../chains/evm.js';
import type { Address, TransferIntent } from '../types.js';

/**
 * 최소 ERC-20 ABI — 우리가 실제로 호출하는 네 함수만.
 *
 * `as const` 가 결정적이다 — viem 의 타입 추론이 인수/리턴 타입을 정확히
 * 좁히려면 리터럴 ABI 가 필요하다.
 */
export const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }],
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const;

/**
 * Adapter 의 private client 에 접근하기 위한 narrow 인터페이스.
 *
 * 우리는 EvmAdapter 의 내부 구현을 더럽히지 않기 위해 옵션으로 받는다 —
 * 호출자는 `new Erc20(adapter)` 만 하면 되고, 내부적으로 어댑터의 client 를
 * 꺼내 쓴다. evm-data-intent.test.ts 가 동일한 패턴을 쓴다.
 */
interface AdapterWithClient {
  readonly client: PublicClient;
}

export class Erc20 {
  private readonly client: PublicClient;

  constructor(adapter: EvmAdapter) {
    // EvmAdapter 의 client 는 private 이지만 같은 패키지 내에서 정의되어
    // 있으므로 타입 캐스팅으로 안전하게 꺼낸다. 패키지 외부 노출은 아니다.
    this.client = (adapter as unknown as AdapterWithClient).client;
  }

  async balanceOf(token: Address, owner: Address): Promise<bigint> {
    const out = await this.client.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [owner as Hex],
    });
    return out as bigint;
  }

  async decimals(token: Address): Promise<number> {
    const out = await this.client.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: 'decimals',
    });
    return Number(out);
  }

  async symbol(token: Address): Promise<string> {
    const out = await this.client.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: 'symbol',
    });
    return out as string;
  }

  async name(token: Address): Promise<string> {
    const out = await this.client.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: 'name',
    });
    return out as string;
  }

  /**
   * ERC-20 transfer 콜을 위한 TransferIntent 를 만든다.
   *
   * 반환된 intent 는 `wallet.transfer(account, intent)` 로 그대로 전달할 수
   * 있다. EvmAdapter.buildTransfer 가 intent.data 를 보면 native 가 아니라
   * 컨트랙트 호출 트랜잭션을 빌드한다 — value=0, to=token contract.
   *
   * @param token  ERC-20 컨트랙트 주소
   * @param to     실제 수령인
   * @param amount 토큰의 base unit (decimals 적용 후 정수)
   */
  transfer(token: Address, to: Address, amount: bigint): TransferIntent {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [to as Hex, amount],
    });
    return {
      to: token,
      amount: 0n,
      asset: 'erc20',
      data,
    };
  }
}

/**
 * 테스트/오프라인 환경을 위해 ABI 디코딩 헬퍼를 별도로 노출.
 * 운영 코드에선 viem 의 readContract 가 디코딩까지 끝내주므로 직접 호출할 일은 없다.
 */
export function decodeBalanceOf(data: Hex): bigint {
  return decodeFunctionResult({
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    data,
  }) as bigint;
}
