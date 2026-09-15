// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./FullMath.sol";

/// @title Minimal Uniswap V3 sqrtPriceX96 price math, for PlanetZephyrosSubdomainServiceV5's
/// V3-pool activation-fee quoting (activateDomainWithToken) and no-price-limit swap sentinels
/// (buyBackAndBurnToken's V3 leg).
///
/// getQuoteFromSqrtPriceX96 mirrors the well-established pattern from Uniswap's own
/// OracleLibrary.getQuoteAtTick (adapted to take a live sqrtPriceX96 spot price directly, since
/// this contract reads slot0() itself rather than a tick-based TWAP oracle) — the same two-path
/// split (plain squaring when sqrtPriceX96 fits a uint128, FullMath.mulDiv's 512-bit precision
/// otherwise) that library uses to avoid overflow across the whole valid sqrtPriceX96 range,
/// not just realistic/expected price ratios.
library V3PriceMath {
    // TickMath.MIN_SQRT_RATIO + 1 / MAX_SQRT_RATIO - 1 — the standard Uniswap V3 "accept any
    // resulting price" sentinels for swap()'s sqrtPriceLimitX96 parameter (a real 0 is rejected
    // by every V3 pool implementation; this is the actual "no limit" value, not 0).
    uint160 internal constant MIN_SQRT_RATIO_PLUS_ONE = 4295128740;
    uint160 internal constant MAX_SQRT_RATIO_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    /// @notice Given a pool's current sqrtPriceX96 and an amount of its `baseToken`, returns the
    /// equivalent amount of its other token (`quoteToken`) at that spot price.
    /// @param sqrtPriceX96 The pool's current slot0().sqrtPriceX96 (sqrt(token1/token0), Q64.96)
    /// @param baseAmount Amount of baseToken to convert
    /// @param baseIsToken0 Whether baseToken is the pool's token0 (false = token1)
    function getQuoteFromSqrtPriceX96(
        uint160 sqrtPriceX96,
        uint256 baseAmount,
        bool baseIsToken0
    ) internal pure returns (uint256 quoteAmount) {
        if (sqrtPriceX96 <= type(uint128).max) {
            uint256 ratioX192 = uint256(sqrtPriceX96) * sqrtPriceX96;
            quoteAmount = baseIsToken0
                ? FullMath.mulDiv(ratioX192, baseAmount, 1 << 192)
                : FullMath.mulDiv(1 << 192, baseAmount, ratioX192);
        } else {
            uint256 ratioX128 = FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
            quoteAmount = baseIsToken0
                ? FullMath.mulDiv(ratioX128, baseAmount, 1 << 128)
                : FullMath.mulDiv(1 << 128, baseAmount, ratioX128);
        }
    }
}
