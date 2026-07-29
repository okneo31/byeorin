// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// 테스트 전용 ERC-20 — 배포 대상이 아니다. 66종 t토큰의 대역.
// (원본: uniswap/v2-core test/ERC20.sol 과 같은 역할.)

import '../TtlAmmERC20.sol';

contract TestERC20 is TtlAmmERC20 {
    constructor(uint _totalSupply) {
        _mint(msg.sender, _totalSupply);
    }
}
