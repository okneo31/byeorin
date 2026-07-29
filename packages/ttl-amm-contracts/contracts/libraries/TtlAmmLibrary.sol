// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

import '../interfaces/ITtlAmmPair.sol';
import '../interfaces/ITtlAmmFactory.sol';
import './SafeMath.sol';

// ─────────────────────────────────────────────────────────────────────────────
// TtlAmmLibrary — 견적 수학 (원본: uniswap/v2-periphery UniswapV2Library.sol, 0.6.6).
//
// ★ 의도적 기능 변경 — 수수료 상수:
//     getAmountOut/getAmountIn 의 997/1000 → 9967/10000 (33bps).
//   TtlAmmPair.swap 의 K 검증(×10000 − amountIn×33)과 반드시 같은 상수다.
//
// 그 외 변경:
//   - pairFor: V2 는 create2 init code hash 를 하드코딩해 주소를 오프체인
//     계산한다 — 포크 시 hash 불일치가 고전적 사고 지점이라, factory.getPair
//     조회로 대체했다 (홉당 SLOAD 조회 1회 추가, 주소 오류 가능성 0).
//     존재하지 않는 페어는 명시적으로 revert 한다.
//   - 0.6.6 → 0.8.28 기계적 포팅.
// ─────────────────────────────────────────────────────────────────────────────

library TtlAmmLibrary {
    using SafeMath for uint;

    // returns sorted token addresses, used to handle return values from pairs sorted in this order
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        require(tokenA != tokenB, 'TtlAmmLibrary: IDENTICAL_ADDRESSES');
        (token0, token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'TtlAmmLibrary: ZERO_ADDRESS');
    }

    // V2 와 달리 init code hash 를 하드코딩하지 않고 factory 에 조회한다
    function pairFor(address factory, address tokenA, address tokenB) internal view returns (address pair) {
        (address token0, address token1) = sortTokens(tokenA, tokenB);
        pair = ITtlAmmFactory(factory).getPair(token0, token1);
        require(pair != address(0), 'TtlAmmLibrary: PAIR_NOT_FOUND');
    }

    // fetches and sorts the reserves for a pair
    function getReserves(address factory, address tokenA, address tokenB) internal view returns (uint reserveA, uint reserveB) {
        (address token0,) = sortTokens(tokenA, tokenB);
        (uint reserve0, uint reserve1,) = ITtlAmmPair(pairFor(factory, tokenA, tokenB)).getReserves();
        (reserveA, reserveB) = tokenA == token0 ? (reserve0, reserve1) : (reserve1, reserve0);
    }

    // given some amount of an asset and pair reserves, returns an equivalent amount of the other asset
    function quote(uint amountA, uint reserveA, uint reserveB) internal pure returns (uint amountB) {
        require(amountA > 0, 'TtlAmmLibrary: INSUFFICIENT_AMOUNT');
        require(reserveA > 0 && reserveB > 0, 'TtlAmmLibrary: INSUFFICIENT_LIQUIDITY');
        amountB = amountA.mul(reserveB) / reserveA;
    }

    // given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
    function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) internal pure returns (uint amountOut) {
        require(amountIn > 0, 'TtlAmmLibrary: INSUFFICIENT_INPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'TtlAmmLibrary: INSUFFICIENT_LIQUIDITY');
        // ★ 수수료 상수 33bps — V2 원본은 997/1000. TtlAmmPair.swap 과 동일 상수.
        uint amountInWithFee = amountIn.mul(9967);
        uint numerator = amountInWithFee.mul(reserveOut);
        uint denominator = reserveIn.mul(10000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }

    // given an output amount of an asset and pair reserves, returns a required input amount of the other asset
    function getAmountIn(uint amountOut, uint reserveIn, uint reserveOut) internal pure returns (uint amountIn) {
        require(amountOut > 0, 'TtlAmmLibrary: INSUFFICIENT_OUTPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'TtlAmmLibrary: INSUFFICIENT_LIQUIDITY');
        // ★ 수수료 상수 33bps — V2 원본은 1000/997. TtlAmmPair.swap 과 동일 상수.
        uint numerator = reserveIn.mul(amountOut).mul(10000);
        uint denominator = reserveOut.sub(amountOut).mul(9967);
        amountIn = (numerator / denominator).add(1);
    }

    // performs chained getAmountOut calculations on any number of pairs
    function getAmountsOut(address factory, uint amountIn, address[] memory path) internal view returns (uint[] memory amounts) {
        require(path.length >= 2, 'TtlAmmLibrary: INVALID_PATH');
        amounts = new uint[](path.length);
        amounts[0] = amountIn;
        for (uint i; i < path.length - 1; i++) {
            (uint reserveIn, uint reserveOut) = getReserves(factory, path[i], path[i + 1]);
            amounts[i + 1] = getAmountOut(amounts[i], reserveIn, reserveOut);
        }
    }

    // performs chained getAmountIn calculations on any number of pairs
    function getAmountsIn(address factory, uint amountOut, address[] memory path) internal view returns (uint[] memory amounts) {
        require(path.length >= 2, 'TtlAmmLibrary: INVALID_PATH');
        amounts = new uint[](path.length);
        amounts[amounts.length - 1] = amountOut;
        for (uint i = path.length - 1; i > 0; i--) {
            (uint reserveIn, uint reserveOut) = getReserves(factory, path[i - 1], path[i]);
            amounts[i - 1] = getAmountIn(amounts[i], reserveIn, reserveOut);
        }
    }
}
