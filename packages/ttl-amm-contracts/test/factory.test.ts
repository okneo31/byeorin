// Factory — 허브 강제(유일한 구조 변경)와 V2 표준 feeTo/feeToSetter 권한 경계.

import { expect } from "chai";
import { deployFixture, deployToken, expand18, type Fixture } from "./helpers";
import type { Contract } from "ethers";

describe("TtlAmmFactory", () => {
  let fx: Fixture;
  let tUSD: Contract;
  let tJPY: Contract;

  beforeEach(async () => {
    fx = await deployFixture();
    tUSD = await deployToken(expand18(1_000_000));
    tJPY = await deployToken(expand18(1_000_000));
  });

  describe("허브 강제", () => {
    it("WTTL 없는 페어(tUSD/tJPY)는 revert — 유동성은 66갈래에만 모인다", async () => {
      await expect(
        fx.factory.createPair(await tUSD.getAddress(), await tJPY.getAddress())
      ).to.be.revertedWith("TtlAmm: NOT_WTTL_PAIR");
    });

    it("WTTL/토큰 페어는 누구나 무허가로 생성한다", async () => {
      const wttlAddr = await fx.wttl.getAddress();
      const tokenAddr = await tUSD.getAddress();
      // 권한 없는 임의 계정이 생성
      await (fx.factory.connect(fx.other) as Contract).createPair(wttlAddr, tokenAddr);
      const pairAddr: string = await fx.factory.getPair(wttlAddr, tokenAddr);
      expect(pairAddr).to.not.equal("0x0000000000000000000000000000000000000000");
      // 역방향 매핑도 채워진다
      expect(await fx.factory.getPair(tokenAddr, wttlAddr)).to.equal(pairAddr);
      expect(await fx.factory.allPairsLength()).to.equal(1n);
    });

    it("토큰 순서를 바꿔도(WTTL 이 tokenB) 통과한다", async () => {
      await fx.factory.createPair(await tJPY.getAddress(), await fx.wttl.getAddress());
      expect(await fx.factory.allPairsLength()).to.equal(1n);
    });

    it("동일 주소 페어는 revert", async () => {
      const wttlAddr = await fx.wttl.getAddress();
      await expect(fx.factory.createPair(wttlAddr, wttlAddr)).to.be.revertedWith(
        "TtlAmm: IDENTICAL_ADDRESSES"
      );
    });

    it("중복 생성은 revert (순서 뒤집어도)", async () => {
      const wttlAddr = await fx.wttl.getAddress();
      const tokenAddr = await tUSD.getAddress();
      await fx.factory.createPair(wttlAddr, tokenAddr);
      await expect(fx.factory.createPair(wttlAddr, tokenAddr)).to.be.revertedWith(
        "TtlAmm: PAIR_EXISTS"
      );
      await expect(fx.factory.createPair(tokenAddr, wttlAddr)).to.be.revertedWith(
        "TtlAmm: PAIR_EXISTS"
      );
    });
  });

  describe("feeTo/feeToSetter — V2 표준 그대로", () => {
    it("feeToSetter 만 setFeeTo 할 수 있다", async () => {
      await expect(fx.factory.setFeeTo(fx.deployer.address)).to.be.revertedWith(
        "TtlAmm: FORBIDDEN"
      );
      await (fx.factory.connect(fx.admin) as Contract).setFeeTo(fx.admin.address);
      expect(await fx.factory.feeTo()).to.equal(fx.admin.address);
    });

    it("feeToSetter 만 setFeeToSetter 할 수 있다", async () => {
      await expect(fx.factory.setFeeToSetter(fx.deployer.address)).to.be.revertedWith(
        "TtlAmm: FORBIDDEN"
      );
      await (fx.factory.connect(fx.admin) as Contract).setFeeToSetter(fx.other.address);
      expect(await fx.factory.feeToSetter()).to.equal(fx.other.address);
    });
  });

  describe("renounce — setFeeToSetter(0) 는 일방향이다", () => {
    it("포기 후에는 이전 setter 를 포함해 누구도 권한을 되찾지 못한다", async () => {
      const zero = "0x0000000000000000000000000000000000000000";
      await (fx.factory.connect(fx.admin) as Contract).setFeeToSetter(zero);
      expect(await fx.factory.feeToSetter()).to.equal(zero);

      // 이전 setter 도, 다른 누구도 영구히 불가 — address(0) 은 서명할 수 없다
      for (const signer of [fx.admin, fx.deployer, fx.user, fx.other]) {
        await expect(
          (fx.factory.connect(signer) as Contract).setFeeTo(signer.address)
        ).to.be.revertedWith("TtlAmm: FORBIDDEN");
        await expect(
          (fx.factory.connect(signer) as Contract).setFeeToSetter(signer.address)
        ).to.be.revertedWith("TtlAmm: FORBIDDEN");
      }
    });
  });
});
