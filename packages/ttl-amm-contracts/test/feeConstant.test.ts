// 수수료 상수 정합 — 이 패키지에서 가장 중요한 테스트.
//
// 33bps 상수는 두 곳에 산다:
//   1. TtlAmmPair.swap 의 K 검증: balance×10000 − amountIn×33
//   2. TtlAmmLibrary.getAmountOut/getAmountIn: 9967/10000
// 어긋나면 스왑이 전부 revert 하거나 수수료가 샌다. 아래 테스트는
// "라이브러리가 계산한 최대 출력이 Pair 의 K 검증을 정확히 통과하고,
//  그보다 1 wei 만 더 받으면 revert" 를 여러 준비금·입력 조합에서 못 박는다.
// JS 참조 구현(helpers)과 온체인 Router 게터를 대조해 상수를 삼중 확인한다.

import { expect } from "chai";
import {
  deployFixture,
  deployToken,
  createSeededPair,
  expand18,
  getAmountOutJs,
  getAmountInJs,
  orientSwap,
  reservesFor,
  type Fixture,
} from "./helpers";
import type { Contract } from "ethers";

interface Combo {
  name: string;
  reserveTtl: bigint;
  reserveToken: bigint;
  amountIn: bigint;
}

// 균등·소수(prime)·극단 규모를 섞어 반올림 경계를 훑는다
const COMBOS: Combo[] = [
  { name: "창세 tUSD 비율", reserveTtl: expand18(1_000), reserveToken: expand18(246_650), amountIn: expand18(7) },
  { name: "대칭 풀", reserveTtl: expand18(10_000), reserveToken: expand18(10_000), amountIn: expand18(123) },
  { name: "소수 준비금", reserveTtl: expand18(1) + 7919n, reserveToken: expand18(3) + 104729n, amountIn: 10n ** 15n + 3n },
  { name: "미세 입력", reserveTtl: expand18(500), reserveToken: expand18(80_000), amountIn: 1_000_003n },
  { name: "얕은 풀 큰 입력", reserveTtl: expand18(2), reserveToken: expand18(600), amountIn: expand18(1) },
  { name: "비대칭 극단", reserveTtl: expand18(100_000), reserveToken: expand18(3), amountIn: expand18(999) },
];

describe("수수료 상수 정합 (Pair 10000/33 ↔ Library 9967/10000)", () => {
  let fx: Fixture;

  beforeEach(async () => {
    fx = await deployFixture();
  });

  for (const combo of COMBOS) {
    it(`getAmountOut 경계 [${combo.name}] — 정확히 통과, +1 wei 는 'TtlAmm: K' revert`, async () => {
      const token = await deployToken(expand18(100_000_000));
      const pair = await createSeededPair(fx, token, combo.reserveTtl, combo.reserveToken);
      const tokenAddr = await token.getAddress();
      const pairAddr = await pair.getAddress();

      const { reserveIn, reserveOut } = await reservesFor(pair, tokenAddr);

      // 삼중 대조: JS 참조 == 온체인 라이브러리(Router 게터)
      const outJs = getAmountOutJs(combo.amountIn, reserveIn, reserveOut);
      const outChain: bigint = await fx.router.getAmountOut(combo.amountIn, reserveIn, reserveOut);
      expect(outChain).to.equal(outJs, "라이브러리 상수와 JS 참조 불일치");
      expect(outJs > 0n).to.equal(true, "조합이 무의미함 (출력 0)");

      // 입력을 pair 에 보내고 — 최대 출력 +1 wei 는 K 검증에 걸려야 한다
      await token.transfer(pairAddr, combo.amountIn);
      const over = await orientSwap(pair, tokenAddr, outJs + 1n);
      await expect(
        pair.swap(over.amount0Out, over.amount1Out, fx.user.address, "0x")
      ).to.be.revertedWith("TtlAmm: K");

      // 정확히 최대 출력은 통과해야 한다 (revert 는 상태를 남기지 않으므로 같은 입금 재사용)
      const exact = await orientSwap(pair, tokenAddr, outJs);
      await pair.swap(exact.amount0Out, exact.amount1Out, fx.user.address, "0x");
      expect(await fx.wttl.balanceOf(fx.user.address)).to.equal(outJs);
    });
  }

  it("getAmountIn 경계 — 계산된 입력으로 정확히 통과, 1 wei 부족하면 'TtlAmm: K' revert", async () => {
    const token = await deployToken(expand18(100_000_000));
    const pair = await createSeededPair(fx, token, expand18(1_000), expand18(246_650));
    const tokenAddr = await token.getAddress();
    const pairAddr = await pair.getAddress();

    const desiredOut = expand18(5); // WTTL 5개를 받고 싶다
    const { reserveIn, reserveOut } = await reservesFor(pair, tokenAddr);

    const inJs = getAmountInJs(desiredOut, reserveIn, reserveOut);
    const inChain: bigint = await fx.router.getAmountIn(desiredOut, reserveIn, reserveOut);
    expect(inChain).to.equal(inJs, "라이브러리 상수와 JS 참조 불일치");

    // 1 wei 부족 입금 → K revert
    await token.transfer(pairAddr, inJs - 1n);
    const args = await orientSwap(pair, tokenAddr, desiredOut);
    await expect(
      pair.swap(args.amount0Out, args.amount1Out, fx.user.address, "0x")
    ).to.be.revertedWith("TtlAmm: K");

    // 1 wei 를 더 보내 정확히 채우면 통과
    await token.transfer(pairAddr, 1n);
    await pair.swap(args.amount0Out, args.amount1Out, fx.user.address, "0x");
    expect(await fx.wttl.balanceOf(fx.user.address)).to.equal(desiredOut);
  });

  it("상수 문서 정합 — 라이브러리 산식이 (10000−33)/10000 임을 값으로 확인", async () => {
    // reserveIn=reserveOut=10^24, amountIn=10^22 (1%) 같은 큰 값에서
    // 수수료를 0bps 로 가정한 이론값과의 차이가 정확히 33bps 만큼인지 확인한다.
    const r = 10n ** 24n;
    const amountIn = 10n ** 22n;
    const out: bigint = await fx.router.getAmountOut(amountIn, r, r);
    // 수수료 f bps 일 때 out = amountIn·(10000−f)·r / (r·10000 + amountIn·(10000−f))
    const expect33 = (amountIn * 9967n * r) / (r * 10000n + amountIn * 9967n);
    const expect30 = (amountIn * 9970n * r) / (r * 10000n + amountIn * 9970n); // V2 원본 30bps
    expect(out).to.equal(expect33);
    expect(out).to.not.equal(expect30, "원본 997/1000 이 남아 있다면 실패해야 한다");
  });
});
