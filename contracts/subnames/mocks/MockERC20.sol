// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Generic stand-in for a whitelisted ERC20 payment token (V4's multi-currency subname
/// pricing/activation) — a plain ERC20 with an open mint for test setup. Deliberately separate
/// from MockCoreToken: tests need to exercise a whitelisted token that ISN'T coreToken itself, to
/// cover buyBackAndBurnToken's actual swap path (its CORE-direct fast path is what's tested
/// against MockCoreToken as the whitelisted token instead).
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
