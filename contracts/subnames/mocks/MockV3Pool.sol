// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IElectroSwapV3SwapCallbackMock {
    function electroSwapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external;
}

/// @dev Minimal stand-in ElectroSwap V3 pool for testing PlanetZephyrosSubdomainServiceV5's direct
/// pool integration — NOT a real V3 AMM (no tick math, no real price-impact/liquidity depth), just
/// enough to exercise the real swap()/electroSwapV3SwapCallback contract this app's own contract
/// actually calls, plus a configurable slot0() spot price for the activation-fee quote tests. Same
/// "stand-in for router MATH, not real liquidity" spirit as MockRouter — a fixed rate, not a
/// simulated order book.
contract MockV3Pool {
    address public immutable token0;
    address public immutable token1;
    uint160 public sqrtPriceX96;
    // token1 out per 1e18 of token0 in (and the inverse, token0 out per 1e18 of token1 in) —
    // deliberately independent of sqrtPriceX96 (tests can set an inconsistent price/rate on
    // purpose to prove the quote path and the swap path each read their own independent value,
    // exactly like the real contract's own separate V2 getAmountsOut vs swap execution never
    // being required to agree either).
    uint256 public immutable rateToken1PerToken0X18;

    constructor(address _token0, address _token1, uint160 _sqrtPriceX96, uint256 _rateToken1PerToken0X18) {
        require(_token0 != _token1, "identical tokens");
        token0 = _token0;
        token1 = _token1;
        sqrtPriceX96 = _sqrtPriceX96;
        rateToken1PerToken0X18 = _rateToken1PerToken0X18;
    }

    /// @dev Test-only — lets a test move the spot price mid-run (e.g. to prove a stale quote gets
    /// re-read live, not cached).
    function setSqrtPriceX96(uint160 _sqrtPriceX96) external {
        sqrtPriceX96 = _sqrtPriceX96;
    }

    function slot0()
        external
        view
        returns (uint160, int24, uint16, uint16, uint16, uint8, bool)
    {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }

    /// @dev Exact-input only (matches the only mode PlanetZephyrosSubdomainServiceV5 ever uses) —
    /// mirrors real Uniswap V3 pool semantics closely enough to exercise the caller's own
    /// callback-payment logic: pays the output token to `recipient` BEFORE calling back for
    /// payment of the input side, then verifies the callback actually paid.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160, /* sqrtPriceLimitX96 — ignored, no real price-impact simulated */
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1) {
        require(amountSpecified > 0, "MockV3Pool: exact input only");
        uint256 amountIn = uint256(amountSpecified);

        uint256 amountOut = zeroForOne
            ? (amountIn * rateToken1PerToken0X18) / 1e18
            : (amountIn * 1e18) / rateToken1PerToken0X18;

        address tokenIn = zeroForOne ? token0 : token1;
        address tokenOut = zeroForOne ? token1 : token0;

        uint256 tokenInBalanceBefore = IERC20(tokenIn).balanceOf(address(this));

        require(IERC20(tokenOut).transfer(recipient, amountOut), "MockV3Pool: payout failed");

        if (zeroForOne) {
            amount0 = int256(amountIn);
            amount1 = -int256(amountOut);
        } else {
            amount1 = int256(amountIn);
            amount0 = -int256(amountOut);
        }

        IElectroSwapV3SwapCallbackMock(msg.sender).electroSwapV3SwapCallback(amount0, amount1, data);

        uint256 tokenInBalanceAfter = IERC20(tokenIn).balanceOf(address(this));
        require(tokenInBalanceAfter >= tokenInBalanceBefore + amountIn, "MockV3Pool: callback underpaid");
    }
}
