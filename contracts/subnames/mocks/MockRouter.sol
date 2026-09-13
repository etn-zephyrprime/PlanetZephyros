// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./MockCoreToken.sol";

/// @dev Stand-in DEX router for buy-and-burn tests: mints CORE to the recipient at a fixed
/// rate, honouring amountOutMin so slippage-protection tests can exercise a revert path.
/// getAmountsOut/swapExactTokensForTokensSupportingFeeOnTransferTokens added for V4's ERC20
/// activation-fee quoting and ERC20 buyback — same flat `rate` used for every hop, regardless of
/// which token is actually on the other end, since this is a stand-in for router MATH, not for
/// any particular pool's real liquidity.
contract MockRouter {
    MockCoreToken public immutable coreToken;
    address public immutable weth;
    uint256 public immutable rate; // output token (wei) minted/transferred per 1 wei of input

    constructor(MockCoreToken _coreToken, address _weth, uint256 _rate) {
        coreToken = _coreToken;
        weth = _weth;
        rate = _rate;
    }

    function WETH() external view returns (address) {
        return weth;
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable {
        require(block.timestamp <= deadline, "Expired");
        require(path[path.length - 1] == address(coreToken), "Bad path");

        uint256 amountOut = msg.value * rate;
        require(amountOut >= amountOutMin, "Insufficient output amount");

        coreToken.mint(to, amountOut);
    }

    /// @dev Quote-only, no state change — matches activateDomainWithToken's use (a quote, never
    /// an executed swap) and buyBackAndBurnToken's own getAmountsOut-style expectations. Returns
    /// an array the same length as `path`, with every entry but the last left at 0 (real routers
    /// fill in each hop's intermediate amount; callers here only ever read the last element, same
    /// as the real contract's own `amounts[amounts.length - 1]`).
    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        amounts = new uint256[](path.length);
        amounts[0] = amountIn;
        amounts[path.length - 1] = amountIn * rate;
    }

    /// @dev ERC20-in counterpart to swapExactETHForTokensSupportingFeeOnTransferTokens, for
    /// buyBackAndBurnToken. Pulls amountIn of path[0] from the caller (must already be approved —
    /// same requirement the real router has), mints the CORE-equivalent to `to`.
    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(block.timestamp <= deadline, "Expired");
        require(path[path.length - 1] == address(coreToken), "Bad path");

        require(IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn), "transferFrom failed");

        uint256 amountOut = amountIn * rate;
        require(amountOut >= amountOutMin, "Insufficient output amount");

        coreToken.mint(to, amountOut);
    }
}
