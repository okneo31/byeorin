// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// 원본: Uniswap/solidity-lib TransferHelper.sol (v2-periphery 가 사용).
// 변경: safeTransferETH → safeTransferNative 개명(네이티브가 TTL), safeApprove 는
// Router 가 쓰지 않으므로 제거(표면 축소). 그 외 pragma 포팅뿐.

// helper methods for interacting with ERC20 tokens and sending native coin that do not consistently return true/false
library TransferHelper {
    function safeTransfer(address token, address to, uint value) internal {
        // bytes4(keccak256(bytes('transfer(address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FAILED');
    }

    function safeTransferFrom(address token, address from, address to, uint value) internal {
        // bytes4(keccak256(bytes('transferFrom(address,address,uint256)')));
        (bool success, bytes memory data) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, value));
        require(success && (data.length == 0 || abi.decode(data, (bool))), 'TransferHelper: TRANSFER_FROM_FAILED');
    }

    function safeTransferNative(address to, uint value) internal {
        (bool success,) = to.call{value: value}(new bytes(0));
        require(success, 'TransferHelper: NATIVE_TRANSFER_FAILED');
    }
}
