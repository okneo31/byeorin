// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// 원본: uniswap/v2-core interfaces/IUniswapV2Factory.sol.
// 변경: WTTL() 게터 추가 (허브 강제 — Factory 가 WTTL 주소를 보관한다).

interface ITtlAmmFactory {
    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    function WTTL() external view returns (address);

    function feeTo() external view returns (address);
    function feeToSetter() external view returns (address);

    function getPair(address tokenA, address tokenB) external view returns (address pair);
    function allPairs(uint) external view returns (address pair);
    function allPairsLength() external view returns (uint);

    function createPair(address tokenA, address tokenB) external returns (address pair);

    function setFeeTo(address) external;
    function setFeeToSetter(address) external;
}
