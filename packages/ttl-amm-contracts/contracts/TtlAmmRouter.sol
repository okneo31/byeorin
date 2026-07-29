// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

import './interfaces/ITtlAmmFactory.sol';
import './interfaces/ITtlAmmPair.sol';
import './interfaces/IWTTL.sol';
import './libraries/TtlAmmLibrary.sol';
import './libraries/TransferHelper.sol';
import './libraries/SafeMath.sol';

// ─────────────────────────────────────────────────────────────────────────────
// TtlAmmRouter — 사용자 진입점 (원본: uniswap/v2-periphery UniswapV2Router02.sol, 0.6.6).
//
// V2 Router02 의 부분집합이다 — 표면이 좁을수록 감사가 싸다:
//   포함: addLiquidity / addLiquidityNative / removeLiquidity / removeLiquidityNative,
//         swapExactTokensForTokens / swapExactNativeForTokens / swapExactTokensForNative,
//         quote·getAmountOut·getAmountIn·getAmountsOut·getAmountsIn 조회.
//   제외(의도적): FeeOnTransfer 변형 전부(66종 t토큰은 표준 ERC-20),
//         swap*ForExact* (exact-output — 지갑 UX 가 exact-input 만 씀),
//         removeLiquidityWithPermit 변형 (permit 은 Pair 에 남아 있어 필요 시
//         호출자가 직접 permit 후 removeLiquidity 하면 된다).
//
// 그 외 변경 (기능 동일):
//   - ETH → Native 개명 (네이티브 코인이 TTL, WETH → WTTL)
//   - pairFor 가 create2 hash 대신 factory 조회 (TtlAmmLibrary 주석 참조)
//   - 0.6.6 → 0.8.28 기계적 포팅
//
// 다홉 경로: path 배열이 [tUSD, WTTL, tJPY] 이면 한 트랜잭션에 2홉 정산.
// 슬리피지는 amountOutMin/amount{A,B}Min, 기한은 deadline 으로 체인이 강제한다.
// 관리자 함수 없음 — Router 는 상태를 소유하지 않는 무권한 편의 계약이다.
// ─────────────────────────────────────────────────────────────────────────────

contract TtlAmmRouter {
    using SafeMath for uint;

    address public immutable factory;
    address public immutable WTTL;

    modifier ensure(uint deadline) {
        require(deadline >= block.timestamp, 'TtlAmmRouter: EXPIRED');
        _;
    }

    constructor(address _factory, address _WTTL) {
        factory = _factory;
        WTTL = _WTTL;
    }

    receive() external payable {
        assert(msg.sender == WTTL); // only accept native coin via fallback from the WTTL contract
    }

    // **** ADD LIQUIDITY ****
    function _addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin
    ) internal returns (uint amountA, uint amountB) {
        // create the pair if it doesn't exist yet
        if (ITtlAmmFactory(factory).getPair(tokenA, tokenB) == address(0)) {
            ITtlAmmFactory(factory).createPair(tokenA, tokenB);
        }
        (uint reserveA, uint reserveB) = TtlAmmLibrary.getReserves(factory, tokenA, tokenB);
        if (reserveA == 0 && reserveB == 0) {
            (amountA, amountB) = (amountADesired, amountBDesired);
        } else {
            uint amountBOptimal = TtlAmmLibrary.quote(amountADesired, reserveA, reserveB);
            if (amountBOptimal <= amountBDesired) {
                require(amountBOptimal >= amountBMin, 'TtlAmmRouter: INSUFFICIENT_B_AMOUNT');
                (amountA, amountB) = (amountADesired, amountBOptimal);
            } else {
                uint amountAOptimal = TtlAmmLibrary.quote(amountBDesired, reserveB, reserveA);
                assert(amountAOptimal <= amountADesired);
                require(amountAOptimal >= amountAMin, 'TtlAmmRouter: INSUFFICIENT_A_AMOUNT');
                (amountA, amountB) = (amountAOptimal, amountBDesired);
            }
        }
    }

    function addLiquidity(
        address tokenA,
        address tokenB,
        uint amountADesired,
        uint amountBDesired,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint amountA, uint amountB, uint liquidity) {
        (amountA, amountB) = _addLiquidity(tokenA, tokenB, amountADesired, amountBDesired, amountAMin, amountBMin);
        address pair = TtlAmmLibrary.pairFor(factory, tokenA, tokenB);
        TransferHelper.safeTransferFrom(tokenA, msg.sender, pair, amountA);
        TransferHelper.safeTransferFrom(tokenB, msg.sender, pair, amountB);
        liquidity = ITtlAmmPair(pair).mint(to);
    }

    function addLiquidityNative(
        address token,
        uint amountTokenDesired,
        uint amountTokenMin,
        uint amountNativeMin,
        address to,
        uint deadline
    ) external payable ensure(deadline) returns (uint amountToken, uint amountNative, uint liquidity) {
        (amountToken, amountNative) = _addLiquidity(
            token,
            WTTL,
            amountTokenDesired,
            msg.value,
            amountTokenMin,
            amountNativeMin
        );
        address pair = TtlAmmLibrary.pairFor(factory, token, WTTL);
        TransferHelper.safeTransferFrom(token, msg.sender, pair, amountToken);
        IWTTL(WTTL).deposit{value: amountNative}();
        assert(IWTTL(WTTL).transfer(pair, amountNative));
        liquidity = ITtlAmmPair(pair).mint(to);
        // refund dust native coin, if any
        if (msg.value > amountNative) TransferHelper.safeTransferNative(msg.sender, msg.value - amountNative);
    }

    // **** REMOVE LIQUIDITY ****
    function removeLiquidity(
        address tokenA,
        address tokenB,
        uint liquidity,
        uint amountAMin,
        uint amountBMin,
        address to,
        uint deadline
    ) public ensure(deadline) returns (uint amountA, uint amountB) {
        address pair = TtlAmmLibrary.pairFor(factory, tokenA, tokenB);
        ITtlAmmPair(pair).transferFrom(msg.sender, pair, liquidity); // send liquidity to pair
        (uint amount0, uint amount1) = ITtlAmmPair(pair).burn(to);
        (address token0,) = TtlAmmLibrary.sortTokens(tokenA, tokenB);
        (amountA, amountB) = tokenA == token0 ? (amount0, amount1) : (amount1, amount0);
        require(amountA >= amountAMin, 'TtlAmmRouter: INSUFFICIENT_A_AMOUNT');
        require(amountB >= amountBMin, 'TtlAmmRouter: INSUFFICIENT_B_AMOUNT');
    }

    function removeLiquidityNative(
        address token,
        uint liquidity,
        uint amountTokenMin,
        uint amountNativeMin,
        address to,
        uint deadline
    ) public ensure(deadline) returns (uint amountToken, uint amountNative) {
        (amountToken, amountNative) = removeLiquidity(
            token,
            WTTL,
            liquidity,
            amountTokenMin,
            amountNativeMin,
            address(this),
            deadline
        );
        TransferHelper.safeTransfer(token, to, amountToken);
        IWTTL(WTTL).withdraw(amountNative);
        TransferHelper.safeTransferNative(to, amountNative);
    }

    // **** SWAP ****
    // requires the initial amount to have already been sent to the first pair
    function _swap(uint[] memory amounts, address[] memory path, address _to) internal {
        for (uint i; i < path.length - 1; i++) {
            (address input, address output) = (path[i], path[i + 1]);
            (address token0,) = TtlAmmLibrary.sortTokens(input, output);
            uint amountOut = amounts[i + 1];
            (uint amount0Out, uint amount1Out) = input == token0 ? (uint(0), amountOut) : (amountOut, uint(0));
            address to = i < path.length - 2 ? TtlAmmLibrary.pairFor(factory, output, path[i + 2]) : _to;
            ITtlAmmPair(TtlAmmLibrary.pairFor(factory, input, output)).swap(amount0Out, amount1Out, to, new bytes(0));
        }
    }

    function swapExactTokensForTokens(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint[] memory amounts) {
        amounts = TtlAmmLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, 'TtlAmmRouter: INSUFFICIENT_OUTPUT_AMOUNT');
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, TtlAmmLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, to);
    }

    function swapExactNativeForTokens(
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external payable ensure(deadline) returns (uint[] memory amounts) {
        require(path[0] == WTTL, 'TtlAmmRouter: INVALID_PATH');
        amounts = TtlAmmLibrary.getAmountsOut(factory, msg.value, path);
        require(amounts[amounts.length - 1] >= amountOutMin, 'TtlAmmRouter: INSUFFICIENT_OUTPUT_AMOUNT');
        IWTTL(WTTL).deposit{value: amounts[0]}();
        assert(IWTTL(WTTL).transfer(TtlAmmLibrary.pairFor(factory, path[0], path[1]), amounts[0]));
        _swap(amounts, path, to);
    }

    function swapExactTokensForNative(
        uint amountIn,
        uint amountOutMin,
        address[] calldata path,
        address to,
        uint deadline
    ) external ensure(deadline) returns (uint[] memory amounts) {
        require(path[path.length - 1] == WTTL, 'TtlAmmRouter: INVALID_PATH');
        amounts = TtlAmmLibrary.getAmountsOut(factory, amountIn, path);
        require(amounts[amounts.length - 1] >= amountOutMin, 'TtlAmmRouter: INSUFFICIENT_OUTPUT_AMOUNT');
        TransferHelper.safeTransferFrom(
            path[0], msg.sender, TtlAmmLibrary.pairFor(factory, path[0], path[1]), amounts[0]
        );
        _swap(amounts, path, address(this));
        IWTTL(WTTL).withdraw(amounts[amounts.length - 1]);
        TransferHelper.safeTransferNative(to, amounts[amounts.length - 1]);
    }

    // **** LIBRARY FUNCTIONS ****
    function quote(uint amountA, uint reserveA, uint reserveB) public pure returns (uint amountB) {
        return TtlAmmLibrary.quote(amountA, reserveA, reserveB);
    }

    function getAmountOut(uint amountIn, uint reserveIn, uint reserveOut) public pure returns (uint amountOut) {
        return TtlAmmLibrary.getAmountOut(amountIn, reserveIn, reserveOut);
    }

    function getAmountIn(uint amountOut, uint reserveIn, uint reserveOut) public pure returns (uint amountIn) {
        return TtlAmmLibrary.getAmountIn(amountOut, reserveIn, reserveOut);
    }

    function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts) {
        return TtlAmmLibrary.getAmountsOut(factory, amountIn, path);
    }

    function getAmountsIn(uint amountOut, address[] memory path) public view returns (uint[] memory amounts) {
        return TtlAmmLibrary.getAmountsIn(factory, amountOut, path);
    }
}
