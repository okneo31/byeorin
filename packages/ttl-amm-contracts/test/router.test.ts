// Router — 유동성 추가/제거(WTTL·native 변형), 스왑 3종, 2홉 경로,
// 슬리피지·deadline 강제.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployFixture,
  deployToken,
  expand18,
  getAmountOutJs,
  DEADLINE,
  type Fixture,
} from "./helpers";
import type { Contract } from "ethers";

describe("TtlAmmRouter", () => {
  let fx: Fixture;
  let tUSD: Contract;
  let tJPY: Contract;
  let wttlAddr: string;
  let usdAddr: string;
  let jpyAddr: string;
  let routerAddr: string;

  beforeEach(async () => {
    fx = await deployFixture();
    tUSD = await deployToken(expand18(100_000_000));
    tJPY = await deployToken(expand18(100_000_000));
    wttlAddr = await fx.wttl.getAddress();
    usdAddr = await tUSD.getAddress();
    jpyAddr = await tJPY.getAddress();
    routerAddr = await fx.router.getAddress();
    await tUSD.approve(routerAddr, ethers.MaxUint256);
    await tJPY.approve(routerAddr, ethers.MaxUint256);
    await fx.wttl.approve(routerAddr, ethers.MaxUint256);
  });

  async function seedNativePool(token: Contract, tokenAddr: string, amountToken: bigint, amountNative: bigint) {
    await fx.router.addLiquidityNative(
      tokenAddr, amountToken, 0n, 0n, fx.deployer.address, DEADLINE,
      { value: amountNative }
    );
  }

  describe("유동성", () => {
    it("addLiquidity — 페어 자동 생성 + LP 발행 (WTTL ERC-20 경로)", async () => {
      await fx.wttl.deposit({ value: expand18(10) });
      await fx.router.addLiquidity(
        wttlAddr, usdAddr, expand18(10), expand18(2_466), 0n, 0n, fx.deployer.address, DEADLINE
      );
      const pairAddr: string = await fx.factory.getPair(wttlAddr, usdAddr);
      const pair = (await ethers.getContractAt("TtlAmmPair", pairAddr)) as unknown as Contract;
      expect(await pair.balanceOf(fx.deployer.address)).to.be.greaterThan(0n);
    });

    it("addLiquidityNative — 네이티브 TTL 이 WTTL 로 감겨 들어가고, 잉여는 환불된다", async () => {
      await seedNativePool(tUSD, usdAddr, expand18(24_665), expand18(100));
      const pairAddr: string = await fx.factory.getPair(wttlAddr, usdAddr);
      expect(await fx.wttl.balanceOf(pairAddr)).to.equal(expand18(100));

      // 두 번째 추가: 비율 밖 잉여 네이티브는 환불 → Router 잔액 0 유지
      await fx.router.addLiquidityNative(
        usdAddr, expand18(2_466) + expand18(1), 0n, 0n, fx.deployer.address, DEADLINE,
        { value: expand18(11) } // 비율상 ~10 만 필요
      );
      expect(await ethers.provider.getBalance(routerAddr)).to.equal(0n);
    });

    it("removeLiquidity — LP 소각으로 두 자산이 돌아온다", async () => {
      await seedNativePool(tUSD, usdAddr, expand18(24_665), expand18(100));
      const pairAddr: string = await fx.factory.getPair(wttlAddr, usdAddr);
      const pair = (await ethers.getContractAt("TtlAmmPair", pairAddr)) as unknown as Contract;
      const lp: bigint = await pair.balanceOf(fx.deployer.address);
      await pair.approve(routerAddr, ethers.MaxUint256);

      const usdBefore: bigint = await tUSD.balanceOf(fx.deployer.address);
      await fx.router.removeLiquidity(wttlAddr, usdAddr, lp, 0n, 0n, fx.deployer.address, DEADLINE);
      expect(await pair.balanceOf(fx.deployer.address)).to.equal(0n);
      expect((await tUSD.balanceOf(fx.deployer.address)) - usdBefore).to.be.greaterThan(0n);
      expect(await fx.wttl.balanceOf(fx.deployer.address)).to.be.greaterThan(0n);
    });

    it("removeLiquidityNative — 네이티브 TTL 로 언랩되어 돌아온다", async () => {
      await seedNativePool(tUSD, usdAddr, expand18(24_665), expand18(100));
      const pairAddr: string = await fx.factory.getPair(wttlAddr, usdAddr);
      const pair = (await ethers.getContractAt("TtlAmmPair", pairAddr)) as unknown as Contract;
      const lp: bigint = await pair.balanceOf(fx.deployer.address);
      await pair.approve(routerAddr, ethers.MaxUint256);

      // 수령자를 제3자로 두어 가스비 회계를 피한다
      const balBefore = await ethers.provider.getBalance(fx.other.address);
      await fx.router.removeLiquidityNative(usdAddr, lp, 0n, 0n, fx.other.address, DEADLINE);
      const balAfter = await ethers.provider.getBalance(fx.other.address);
      expect(balAfter - balBefore).to.be.greaterThan(expand18(99)); // ≈100 TTL (1000 wei 잠김 몫 제외)
    });
  });

  describe("스왑", () => {
    beforeEach(async () => {
      // 창세 비율 시딩: 1 TTL = 246.65 tUSD, 1 TTL = 36,500 tJPY
      await seedNativePool(tUSD, usdAddr, expand18(246_650), expand18(1_000));
      await seedNativePool(tJPY, jpyAddr, expand18(36_500_000), expand18(1_000));
    });

    it("swapExactTokensForTokens 1홉 — 출력이 33bps 산식과 일치한다", async () => {
      const amountIn = expand18(100);
      const expected = getAmountOutJs(amountIn, expand18(246_650), expand18(1_000));
      await fx.router.swapExactTokensForTokens(
        amountIn, 0n, [usdAddr, wttlAddr], fx.user.address, DEADLINE
      );
      expect(await fx.wttl.balanceOf(fx.user.address)).to.equal(expected);
    });

    it("2홉 경로 tUSD→WTTL→tJPY — 한 트랜잭션에 연쇄 정산, 수수료는 홉마다", async () => {
      const amountIn = expand18(1_000); // 1,000 tUSD
      const hop1 = getAmountOutJs(amountIn, expand18(246_650), expand18(1_000));
      const hop2 = getAmountOutJs(hop1, expand18(1_000), expand18(36_500_000));

      const amounts: bigint[] = await fx.router.getAmountsOut(amountIn, [usdAddr, wttlAddr, jpyAddr]);
      expect(amounts[1]).to.equal(hop1);
      expect(amounts[2]).to.equal(hop2);

      await fx.router.swapExactTokensForTokens(
        amountIn, hop2, [usdAddr, wttlAddr, jpyAddr], fx.user.address, DEADLINE
      );
      expect(await tJPY.balanceOf(fx.user.address)).to.equal(hop2);
      // 중간 자산(WTTL)은 사용자에게 남지 않는다
      expect(await fx.wttl.balanceOf(fx.user.address)).to.equal(0n);
    });

    it("swapExactNativeForTokens — 네이티브 입력", async () => {
      const amountIn = expand18(2);
      const expected = getAmountOutJs(amountIn, expand18(1_000), expand18(246_650));
      await fx.router.swapExactNativeForTokens(
        0n, [wttlAddr, usdAddr], fx.user.address, DEADLINE, { value: amountIn }
      );
      expect(await tUSD.balanceOf(fx.user.address)).to.equal(expected);
    });

    it("swapExactTokensForNative — 네이티브 출력", async () => {
      const amountIn = expand18(2_466);
      const expected = getAmountOutJs(amountIn, expand18(246_650), expand18(1_000));
      const balBefore = await ethers.provider.getBalance(fx.other.address);
      await fx.router.swapExactTokensForNative(
        amountIn, 0n, [usdAddr, wttlAddr], fx.other.address, DEADLINE
      );
      expect((await ethers.provider.getBalance(fx.other.address)) - balBefore).to.equal(expected);
    });

    it("native 스왑은 경로 끝단이 WTTL 이 아니면 revert", async () => {
      await expect(
        fx.router.swapExactNativeForTokens(0n, [usdAddr, wttlAddr], fx.user.address, DEADLINE, {
          value: 1n,
        })
      ).to.be.revertedWith("TtlAmmRouter: INVALID_PATH");
      await expect(
        fx.router.swapExactTokensForNative(1n, 0n, [wttlAddr, usdAddr], fx.user.address, DEADLINE)
      ).to.be.revertedWith("TtlAmmRouter: INVALID_PATH");
    });

    it("슬리피지 — minAmountOut 미달이면 revert, 정확히 그 값이면 통과", async () => {
      const amountIn = expand18(100);
      const expected = getAmountOutJs(amountIn, expand18(246_650), expand18(1_000));
      await expect(
        fx.router.swapExactTokensForTokens(
          amountIn, expected + 1n, [usdAddr, wttlAddr], fx.user.address, DEADLINE
        )
      ).to.be.revertedWith("TtlAmmRouter: INSUFFICIENT_OUTPUT_AMOUNT");
      await fx.router.swapExactTokensForTokens(
        amountIn, expected, [usdAddr, wttlAddr], fx.user.address, DEADLINE
      );
    });

    it("deadline 초과 — revert 'TtlAmmRouter: EXPIRED'", async () => {
      const past = 1n; // 1970년 — 확실한 과거
      await expect(
        fx.router.swapExactTokensForTokens(expand18(1), 0n, [usdAddr, wttlAddr], fx.user.address, past)
      ).to.be.revertedWith("TtlAmmRouter: EXPIRED");
      await expect(
        fx.router.addLiquidity(wttlAddr, usdAddr, 1n, 1n, 0n, 0n, fx.deployer.address, past)
      ).to.be.revertedWith("TtlAmmRouter: EXPIRED");
      await expect(
        fx.router.removeLiquidity(wttlAddr, usdAddr, 1n, 0n, 0n, fx.deployer.address, past)
      ).to.be.revertedWith("TtlAmmRouter: EXPIRED");
    });

    it("존재하지 않는 페어 경로는 명시적으로 revert", async () => {
      const orphan = await deployToken(expand18(1));
      await expect(
        fx.router.getAmountsOut(expand18(1), [usdAddr, await orphan.getAddress()])
      ).to.be.revertedWith("TtlAmmLibrary: PAIR_NOT_FOUND");
    });
  });
});
