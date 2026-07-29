// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// 원본: uniswap/v2-periphery interfaces/IWETH.sol → IWTTL 개명. 그 외 변경 없음.

interface IWTTL {
    function deposit() external payable;
    function transfer(address to, uint value) external returns (bool);
    function withdraw(uint) external;
}
