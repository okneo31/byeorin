// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// 원본: uniswap/v2-core libraries/SafeMath.sol (0.5.16).
// 0.8 에서는 산술이 기본 체크되므로 이 라이브러리는 중복이지만, V2 원본과의
// diff 를 최소로 유지하기 위해 그대로 둔다 (오버플로 시 0.8 패닉이 먼저 걸리며,
// 결과는 동일하게 revert 다). pragma 외 변경 없음.

// a library for performing overflow-safe math, courtesy of DappHub (https://github.com/dapphub/ds-math)

library SafeMath {
    function add(uint x, uint y) internal pure returns (uint z) {
        require((z = x + y) >= x, 'ds-math-add-overflow');
    }

    function sub(uint x, uint y) internal pure returns (uint z) {
        require((z = x - y) <= x, 'ds-math-sub-underflow');
    }

    function mul(uint x, uint y) internal pure returns (uint z) {
        require(y == 0 || (z = x * y) / y == x, 'ds-math-mul-overflow');
    }
}
