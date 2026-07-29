// 테스트 공용 헬퍼 — 배포 픽스처와 33bps 수수료 수학의 JS 참조 구현.
// 참조 구현은 컨트랙트(TtlAmmLibrary)와 독립적으로 같은 식을 계산한다 —
// 온체인 값과 대조해 상수 정합을 이중으로 못 박기 위해서다.

import { ethers } from "hardhat";
import type { Contract } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

export const FEE_NUMERATOR = 9967n; // 10000 - 33 (33bps)
export const FEE_DENOMINATOR = 10000n;
export const MINIMUM_LIQUIDITY = 1000n;

export function expand18(n: number | bigint): bigint {
  return BigInt(n) * 10n ** 18n;
}

// TtlAmmLibrary.getAmountOut 의 JS 참조 구현 (bigint 정수 나눗셈 = EVM 과 동일)
export function getAmountOutJs(amountIn: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const amountInWithFee = amountIn * FEE_NUMERATOR;
  return (amountInWithFee * reserveOut) / (reserveIn * FEE_DENOMINATOR + amountInWithFee);
}

// TtlAmmLibrary.getAmountIn 의 JS 참조 구현
export function getAmountInJs(amountOut: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  const numerator = reserveIn * amountOut * FEE_DENOMINATOR;
  const denominator = (reserveOut - amountOut) * FEE_NUMERATOR;
  return numerator / denominator + 1n;
}

export function sqrtBigint(value: bigint): bigint {
  if (value < 0n) throw new Error("negative");
  if (value < 2n) return value;
  let x = value;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + value / x) / 2n;
  }
  return x;
}

export interface Fixture {
  deployer: HardhatEthersSigner;
  user: HardhatEthersSigner;
  admin: HardhatEthersSigner; // feeToSetter 보유자
  other: HardhatEthersSigner;
  wttl: Contract;
  factory: Contract;
  router: Contract;
}

export async function deployContract(name: string, ...args: unknown[]): Promise<Contract> {
  const f = await ethers.getContractFactory(name);
  const c = await f.deploy(...args);
  await c.waitForDeployment();
  return c as unknown as Contract;
}

export async function deployFixture(): Promise<Fixture> {
  const [deployer, user, admin, other] = await ethers.getSigners();
  const wttl = await deployContract("WTTL");
  const factory = await deployContract("TtlAmmFactory", admin.address, await wttl.getAddress());
  const router = await deployContract(
    "TtlAmmRouter",
    await factory.getAddress(),
    await wttl.getAddress()
  );
  return { deployer, user, admin, other, wttl, factory, router };
}

export async function deployToken(supply: bigint): Promise<Contract> {
  return deployContract("TestERC20", supply);
}

/** WTTL/token 페어를 만들고 (reserveTtl, reserveToken) 으로 시딩한다. deployer 가 유동성을 댄다. */
export async function createSeededPair(
  fx: Fixture,
  token: Contract,
  reserveTtl: bigint,
  reserveToken: bigint
): Promise<Contract> {
  const wttlAddr = await fx.wttl.getAddress();
  const tokenAddr = await token.getAddress();
  await fx.factory.createPair(wttlAddr, tokenAddr);
  const pairAddr: string = await fx.factory.getPair(wttlAddr, tokenAddr);
  const pair = (await ethers.getContractAt("TtlAmmPair", pairAddr)) as unknown as Contract;
  await fx.wttl.deposit({ value: reserveTtl });
  await fx.wttl.transfer(pairAddr, reserveTtl);
  await token.transfer(pairAddr, reserveToken);
  await pair.mint(fx.deployer.address);
  return pair;
}

/** pair 의 (input, output) 토큰 순서에 맞춰 swap 인자를 만든다. */
export async function orientSwap(
  pair: Contract,
  inputToken: string,
  amountOut: bigint
): Promise<{ amount0Out: bigint; amount1Out: bigint }> {
  const token0: string = await pair.token0();
  if (token0.toLowerCase() === inputToken.toLowerCase()) {
    return { amount0Out: 0n, amount1Out: amountOut };
  }
  return { amount0Out: amountOut, amount1Out: 0n };
}

/** pair 준비금을 (input 기준 reserveIn, reserveOut) 방향으로 읽는다. */
export async function reservesFor(
  pair: Contract,
  inputToken: string
): Promise<{ reserveIn: bigint; reserveOut: bigint }> {
  const token0: string = await pair.token0();
  const [r0, r1] = await pair.getReserves();
  if (token0.toLowerCase() === inputToken.toLowerCase()) {
    return { reserveIn: r0, reserveOut: r1 };
  }
  return { reserveIn: r1, reserveOut: r0 };
}

export const DEADLINE = 10n ** 12n; // 충분히 먼 미래 (unix 초)
