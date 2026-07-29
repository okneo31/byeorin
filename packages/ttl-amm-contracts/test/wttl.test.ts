// WTTL — WETH9 포트가 원본과 같은 행동인지.

import { expect } from "chai";
import { ethers } from "hardhat";
import { deployContract, expand18 } from "./helpers";

describe("WTTL", () => {
  it("deposit/withdraw 왕복 — 잔액과 totalSupply 가 네이티브 예치량을 따른다", async () => {
    const [a] = await ethers.getSigners();
    const wttl = await deployContract("WTTL");
    await wttl.deposit({ value: expand18(3) });
    expect(await wttl.balanceOf(a.address)).to.equal(expand18(3));
    expect(await wttl.totalSupply()).to.equal(expand18(3));
    await wttl.withdraw(expand18(1));
    expect(await wttl.balanceOf(a.address)).to.equal(expand18(2));
    expect(await wttl.totalSupply()).to.equal(expand18(2));
  });

  it("receive() — 단순 송금도 deposit 으로 처리된다 (WETH9 fallback 동작)", async () => {
    const [a] = await ethers.getSigners();
    const wttl = await deployContract("WTTL");
    await a.sendTransaction({ to: await wttl.getAddress(), value: expand18(5) });
    expect(await wttl.balanceOf(a.address)).to.equal(expand18(5));
  });

  it("무한 allowance 는 transferFrom 에서 차감되지 않는다 (WETH9 동작)", async () => {
    const [a, b] = await ethers.getSigners();
    const wttl = await deployContract("WTTL");
    await wttl.deposit({ value: expand18(2) });
    await wttl.approve(b.address, ethers.MaxUint256);
    await (wttl.connect(b) as typeof wttl).transferFrom(a.address, b.address, expand18(1));
    expect(await wttl.allowance(a.address, b.address)).to.equal(ethers.MaxUint256);
  });

  it("잔액 초과 withdraw 는 revert", async () => {
    const wttl = await deployContract("WTTL");
    await expect(wttl.withdraw(1n)).to.be.reverted;
  });
});
