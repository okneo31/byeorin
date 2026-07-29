// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// 원본: uniswap/v2-core interfaces/IUniswapV2Callee.sol.
// 변경: 콜백 이름 uniswapV2Call → ttlAmmCall (브랜드 개명 — 기능 동일).

interface ITtlAmmCallee {
    function ttlAmmCall(address sender, uint amount0, uint amount1, bytes calldata data) external;
}
