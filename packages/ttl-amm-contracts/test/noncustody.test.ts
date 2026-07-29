// 비수탁 불변식 — 이 시스템의 유일한 관리자 권한(feeToSetter)이 무엇을 하든
// LP 의 유동성 회수는 절대 막히지 않는다. 준비금을 빼가는 권한은 존재하지 않는다.

import { expect } from "chai";
import { ethers } from "hardhat";
import {
  deployFixture,
  deployToken,
  expand18,
  DEADLINE,
  type Fixture,
} from "./helpers";
import type { Contract } from "ethers";

const ZERO = "0x0000000000000000000000000000000000000000";

describe("비수탁 불변식", () => {
  let fx: Fixture;
  let tUSD: Contract;
  let wttlAddr: string;
  let usdAddr: string;
  let routerAddr: string;
  let pair: Contract;

  beforeEach(async () => {
    fx = await deployFixture();
    tUSD = await deployToken(expand18(100_000_000));
    wttlAddr = await fx.wttl.getAddress();
    usdAddr = await tUSD.getAddress();
    routerAddr = await fx.router.getAddress();

    // user 가 LP 가 된다
    await tUSD.transfer(fx.user.address, expand18(50_000));
    await (tUSD.connect(fx.user) as Contract).approve(routerAddr, ethers.MaxUint256);
    await (fx.router.connect(fx.user) as Contract).addLiquidityNative(
      usdAddr, expand18(24_665), 0n, 0n, fx.user.address, DEADLINE,
      { value: expand18(100) }
    );
    const pairAddr: string = await fx.factory.getPair(wttlAddr, usdAddr);
    pair = (await ethers.getContractAt("TtlAmmPair", pairAddr)) as unknown as Contract;
  });

  it("feeToSetter 가 가진 모든 권한을 행사해도 removeLiquidity 는 항상 성공한다", async () => {
    const adminFactory = fx.factory.connect(fx.admin) as Contract;

    // 관리자가 할 수 있는 전부: feeTo 켜기 → 스왑으로 수수료 누적 → feeTo 바꾸기 → setter 넘기기
    await adminFactory.setFeeTo(fx.admin.address);
    await tUSD.approve(routerAddr, ethers.MaxUint256);
    for (let i = 0; i < 3; i++) {
      await fx.router.swapExactTokensForTokens(
        expand18(500), 0n, [usdAddr, wttlAddr], fx.deployer.address, DEADLINE
      );
    }
    await adminFactory.setFeeTo(fx.other.address);
    await adminFactory.setFeeToSetter(fx.other.address);
    await (fx.factory.connect(fx.other) as Contract).setFeeTo(ZERO);
    await (fx.factory.connect(fx.other) as Contract).setFeeToSetter(ZERO); // 완전 포기까지

    // 그 어떤 시점에도 LP 회수는 막히지 않는다
    const lp: bigint = await pair.balanceOf(fx.user.address);
    expect(lp).to.be.greaterThan(0n);
    await (pair.connect(fx.user) as Contract).approve(routerAddr, ethers.MaxUint256);
    const usdBefore: bigint = await tUSD.balanceOf(fx.user.address);
    await (fx.router.connect(fx.user) as Contract).removeLiquidity(
      wttlAddr, usdAddr, lp, 0n, 0n, fx.user.address, DEADLINE
    );
    expect(await pair.balanceOf(fx.user.address)).to.equal(0n);
    expect((await tUSD.balanceOf(fx.user.address)) - usdBefore).to.be.greaterThan(0n);
    expect(await fx.wttl.balanceOf(fx.user.address)).to.be.greaterThan(0n);
  });

  it("Router 없이도 회수된다 — Pair.burn 은 무권한 원시 경로다", async () => {
    // 지갑/Router 가 전부 사라져도 LP 토큰만 있으면 자산을 되찾는다
    const lp: bigint = await pair.balanceOf(fx.user.address);
    await (pair.connect(fx.user) as Contract).transfer(await pair.getAddress(), lp);
    await (pair.connect(fx.user) as Contract).burn(fx.user.address);
    expect(await fx.wttl.balanceOf(fx.user.address)).to.be.greaterThan(0n);
    expect(await tUSD.balanceOf(fx.user.address)).to.be.greaterThan(0n);
  });

  it("프로토콜 수수료는 LP 토큰 발행일 뿐 — 준비금 인출 경로가 아니다", async () => {
    await (fx.factory.connect(fx.admin) as Contract).setFeeTo(fx.admin.address);
    await tUSD.approve(routerAddr, ethers.MaxUint256);
    // V2 의미론: feeOn 이후 첫 유동성 이벤트가 kLast 를 기록하고,
    // 그 뒤 스왑으로 k 가 자란 만큼을 다음 유동성 이벤트에서 정산한다
    await (fx.router.connect(fx.user) as Contract).addLiquidityNative(
      usdAddr, expand18(2_466) + expand18(1), 0n, 0n, fx.user.address, DEADLINE, { value: expand18(10) }
    );
    await fx.router.swapExactTokensForTokens(
      expand18(2_000), 0n, [usdAddr, wttlAddr], fx.deployer.address, DEADLINE
    );
    // 다음 유동성 이벤트에서 feeTo 에게 LP 가 발행된다
    const [r0, r1] = await pair.getReserves();
    await (fx.router.connect(fx.user) as Contract).addLiquidityNative(
      usdAddr, expand18(2_466), 0n, 0n, fx.user.address, DEADLINE, { value: expand18(10) }
    );
    const feeLp: bigint = await pair.balanceOf(fx.admin.address);
    expect(feeLp).to.be.greaterThan(0n);
    // 준비금은 줄지 않았다 (수수료 발행은 지분 희석일 뿐)
    const [nr0, nr1] = await pair.getReserves();
    expect(nr0 >= r0 && nr1 >= r1).to.equal(true);
  });
});
