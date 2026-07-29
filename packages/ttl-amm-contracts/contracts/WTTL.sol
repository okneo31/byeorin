// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity =0.8.28;

// ─────────────────────────────────────────────────────────────────────────────
// WTTL — Wrapped TTL.
//
// 원본: WETH9 (mainnet 0xC02a...6Cc2, Solidity 0.4.18). TTL 은 네이티브 코인이라
// ERC-20 페어에 직접 들어갈 수 없으므로 WETH9 와 같은 방식으로 감싼다.
//
// V2/WETH9 원본 대비 변경 (기계적 포팅 외 기능 변경 없음):
//   - 이름/심볼: "Wrapped Ether"/"WETH" → "Wrapped TTL"/"WTTL"
//   - 0.4.18 → 0.8.28 문법 포팅: 익명 fallback → receive(),
//     msg.sender.transfer → payable(msg.sender).transfer, uint(-1) → type(uint).max
//
// 로직·저장 구조·이벤트는 WETH9 그대로다. 관리자 없음, 업그레이드 불가,
// deposit/withdraw 는 누구도 막을 수 없다.
// ─────────────────────────────────────────────────────────────────────────────

contract WTTL {
    string public name = "Wrapped TTL";
    string public symbol = "WTTL";
    uint8 public decimals = 18;

    event Approval(address indexed src, address indexed guy, uint wad);
    event Transfer(address indexed src, address indexed dst, uint wad);
    event Deposit(address indexed dst, uint wad);
    event Withdrawal(address indexed src, uint wad);

    mapping(address => uint) public balanceOf;
    mapping(address => mapping(address => uint)) public allowance;

    receive() external payable {
        deposit();
    }

    function deposit() public payable {
        balanceOf[msg.sender] += msg.value;
        emit Deposit(msg.sender, msg.value);
    }

    function withdraw(uint wad) public {
        require(balanceOf[msg.sender] >= wad);
        balanceOf[msg.sender] -= wad;
        payable(msg.sender).transfer(wad);
        emit Withdrawal(msg.sender, wad);
    }

    function totalSupply() public view returns (uint) {
        return address(this).balance;
    }

    function approve(address guy, uint wad) public returns (bool) {
        allowance[msg.sender][guy] = wad;
        emit Approval(msg.sender, guy, wad);
        return true;
    }

    function transfer(address dst, uint wad) public returns (bool) {
        return transferFrom(msg.sender, dst, wad);
    }

    function transferFrom(address src, address dst, uint wad) public returns (bool) {
        require(balanceOf[src] >= wad);

        if (src != msg.sender && allowance[src][msg.sender] != type(uint).max) {
            require(allowance[src][msg.sender] >= wad);
            allowance[src][msg.sender] -= wad;
        }

        balanceOf[src] -= wad;
        balanceOf[dst] += wad;

        emit Transfer(src, dst, wad);

        return true;
    }
}
