// Pair — LP mint/burn 왕복, MINIMUM_LIQUIDITY 영구 소각, K 불변식.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployFixture,
  deployToken,
  createSeededPair,
  expand18,
  sqrtBigint,
  getAmountOutJs,
  reservesFor,
  orientSwap,
  MINIMUM_LIQUIDITY,
  type Fixture,
} from "./helpers";
import type { Contract } from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("TtlAmmPair", () => {
  let fx: Fixture;
  let token: Contract;

  beforeEach(async () => {
    fx = await deployFixture();
    token = await deployToken(expand18(10_000_000));
  });

  it("첫 mint — liquidity = sqrt(a·b) − MINIMUM_LIQUIDITY, 1000 wei 는 address(0) 에 영구 소각", async () => {
    const rTtl = expand18(1_000);
    const rTok = expand18(246_650); // 창세 예시: 1 TTL = 246.65 tUSD
    const pair = await createSeededPair(fx, token, rTtl, rTok);

    const expectedTotal = sqrtBigint(rTtl * rTok);
    expect(await pair.totalSupply()).to.equal(expectedTotal);
    expect(await pair.balanceOf(ZERO)).to.equal(MINIMUM_LIQUIDITY);
    expect(await pair.balanceOf(fx.deployer.address)).to.equal(expectedTotal - MINIMUM_LIQUIDITY);
  });

  it("mint/burn 왕복 — 전량 burn 하면 준비금이 지분 비율대로 돌아온다 (잠긴 1000 wei 몫 제외)", async () => {
    const rTtl = expand18(100);
    const rTok = expand18(30_000);
    const pair = await createSeededPair(fx, token, rTtl, rTok);
    const pairAddr = await pair.getAddress();

    const lp: bigint = await pair.balanceOf(fx.deployer.address);
    const totalSupply: bigint = await pair.totalSupply();

    const wttlBefore: bigint = await fx.wttl.balanceOf(fx.deployer.address);
    const tokBefore: bigint = await token.balanceOf(fx.deployer.address);

    await pair.transfer(pairAddr, lp);
    await pair.burn(fx.deployer.address);

    const expectedTtl = (lp * rTtl) / totalSupply;
    const expectedTok = (lp * rTok) / totalSupply;
    expect((await fx.wttl.balanceOf(fx.deployer.address)) - wttlBefore).to.equal(expectedTtl);
    expect((await token.balanceOf(fx.deployer.address)) - tokBefore).to.equal(expectedTok);

    // MINIMUM_LIQUIDITY 지분만 풀에 남는다 — 풀은 절대 완전히 비지 않는다
    expect(await pair.totalSupply()).to.equal(MINIMUM_LIQUIDITY);
    const [r0, r1] = await pair.getReserves();
    expect(r0 > 0n && r1 > 0n).to.equal(true);
  });

  it("K 불변식 — 스왑 후 k 는 줄지 않고, 수수료만큼 순증한다", async () => {
    const pair = await createSeededPair(fx, token, expand18(500), expand18(120_000));
    const tokenAddr = await token.getAddress();
    const pairAddr = await pair.getAddress();

    const [r0Before, r1Before] = await pair.getReserves();
    const kBefore = r0Before * r1Before;

    // token → WTTL 방향 스왑을 pair 에 직접
    const amountIn = expand18(1_000);
    const { reserveIn, reserveOut } = await reservesFor(pair, tokenAddr);
    const amountOut = getAmountOutJs(amountIn, reserveIn, reserveOut);
    await token.transfer(pairAddr, amountIn);
    const { amount0Out, amount1Out } = await orientSwap(pair, tokenAddr, amountOut);
    await pair.swap(amount0Out, amount1Out, fx.user.address, "0x");

    const [r0After, r1After] = await pair.getReserves();
    const kAfter = r0After * r1After;
    expect(kAfter >= kBefore).to.equal(true, "k must not decrease");
    expect(kAfter > kBefore).to.equal(true, "fee must strictly grow k");
  });

  it("연쇄 스왑에서도 k 는 단조 증가한다", async () => {
    const pair = await createSeededPair(fx, token, expand18(50), expand18(9_777));
    const tokenAddr = await token.getAddress();
    const wttlAddr = await fx.wttl.getAddress();
    const pairAddr = await pair.getAddress();
    await fx.wttl.deposit({ value: expand18(20) });

    let [r0, r1] = await pair.getReserves();
    let kPrev = r0 * r1;

    const swaps: Array<[Contract, string, bigint]> = [
      [token, tokenAddr, expand18(100)],
      [fx.wttl as Contract, wttlAddr, expand18(3)],
      [token, tokenAddr, 123456789012345n],
      [fx.wttl as Contract, wttlAddr, 999999999999n],
    ];
    for (const [inTok, inAddr, amountIn] of swaps) {
      const { reserveIn, reserveOut } = await reservesFor(pair, inAddr);
      const amountOut = getAmountOutJs(amountIn, reserveIn, reserveOut);
      if (amountOut === 0n) continue;
      await inTok.transfer(pairAddr, amountIn);
      const { amount0Out, amount1Out } = await orientSwap(pair, inAddr, amountOut);
      await pair.swap(amount0Out, amount1Out, fx.user.address, "0x");
      const [nr0, nr1] = await pair.getReserves();
      const k = nr0 * nr1;
      expect(k >= kPrev).to.equal(true);
      kPrev = k;
    }
  });

  it("입금 없이 인출만 하는 swap 은 revert (INSUFFICIENT_INPUT_AMOUNT)", async () => {
    const pair = await createSeededPair(fx, token, expand18(10), expand18(1_000));
    await expect(pair.swap(0n, expand18(1), fx.user.address, "0x")).to.be.revertedWith(
      "TtlAmm: INSUFFICIENT_INPUT_AMOUNT"
    );
  });

  it("initialize 는 factory 만 호출할 수 있다", async () => {
    const pair = await createSeededPair(fx, token, expand18(1), expand18(100));
    await expect(
      pair.initialize(fx.user.address, fx.other.address)
    ).to.be.revertedWith("TtlAmm: FORBIDDEN");
  });
});
