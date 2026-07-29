// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

import './TtlAmmPair.sol';

// ─────────────────────────────────────────────────────────────────────────────
// TtlAmmFactory — 페어 생성 (원본: uniswap/v2-core UniswapV2Factory.sol, 0.5.16).
//
// ★ 의도적 기능 변경은 단 하나 — WTTL 허브 강제:
//     createPair 는 두 토큰 중 하나가 WTTL 이 아니면 revert 한다.
//   이유: 임의 페어(tUSD/tJPY 직접 풀)를 허용하면 유동성이 66×65/2 = 2,145
//   갈래로 쪼개져 전부 얕아진다. 허브 강제로 유동성은 66갈래(WTTL/tXXX)에만
//   모이고, 모든 가격이 TTL 표시가 된다 (docs/EXCHANGE.md §4).
//   페어 생성 자체는 V2 그대로 무허가 — 누구나 새 WTTL/토큰 풀을 열 수 있다.
//
// 관리자 권한은 V2 표준 feeTo/feeToSetter 뿐이다:
//   - feeTo: 프로토콜 수수료 수령 주소 (LP 토큰 발행 방식 — 준비금 인출 아님)
//   - feeToSetter: feeTo 를 바꿀 수 있는 유일한 키.
//     setFeeToSetter(address(0)) 로 일방향 포기하면 이후 영구히 아무도 없다.
//   어떤 경로로도 준비금·LP 인출을 막을 수 없다 — 비수탁의 선.
//
// 그 외 변경: 0.5.16 → 0.8.28 기계적 포팅 (constructor 가시성 제거 등).
// ─────────────────────────────────────────────────────────────────────────────

contract TtlAmmFactory {
    address public immutable WTTL; // ★ 허브 — 모든 페어의 한쪽은 반드시 이 토큰

    address public feeTo;
    address public feeToSetter;

    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint);

    constructor(address _feeToSetter, address _WTTL) {
        require(_WTTL != address(0), 'TtlAmm: ZERO_ADDRESS');
        feeToSetter = _feeToSetter;
        WTTL = _WTTL;
    }

    function allPairsLength() external view returns (uint) {
        return allPairs.length;
    }

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, 'TtlAmm: IDENTICAL_ADDRESSES');
        require(tokenA == WTTL || tokenB == WTTL, 'TtlAmm: NOT_WTTL_PAIR'); // ★ 허브 강제
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), 'TtlAmm: ZERO_ADDRESS');
        require(getPair[token0][token1] == address(0), 'TtlAmm: PAIR_EXISTS'); // single check is sufficient
        bytes memory bytecode = type(TtlAmmPair).creationCode;
        bytes32 salt = keccak256(abi.encodePacked(token0, token1));
        assembly {
            pair := create2(0, add(bytecode, 32), mload(bytecode), salt)
        }
        TtlAmmPair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair; // populate mapping in the reverse direction
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function setFeeTo(address _feeTo) external {
        require(msg.sender == feeToSetter, 'TtlAmm: FORBIDDEN');
        feeTo = _feeTo;
    }

    function setFeeToSetter(address _feeToSetter) external {
        require(msg.sender == feeToSetter, 'TtlAmm: FORBIDDEN');
        feeToSetter = _feeToSetter;
    }
}
