// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Trimmed ElectroSwap V3 pool interface (their Uniswap V3 fork — see
/// IElectroSwapV3PoolState/IElectroSwapV3SwapCallback in the verified UniversalRouter source at
/// 0x2c12c8F15637b7A182DEc202816148A5E767DCEC, whose own additional_sources this was checked
/// against line-for-line) — only what PlanetZephyrosSubdomainServiceV5 needs: slot0() for
/// spot-price quoting (activateDomainWithToken) and swap() for actually executing a trade
/// (buyBackAndBurnToken's V3 leg). Same "trimmed to exactly what's used" convention as
/// IUniswapV2Router02Lite.
interface IElectroSwapV3PoolLite {
    /// @dev sqrtPriceX96 is the only field this contract's price math needs; the rest are returned
    /// because slot0() is a single fixed-shape tuple on the real pool — can't select a subset.
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function token0() external view returns (address);
    function token1() external view returns (address);

    /// @dev amount0/amount1 are negative for the token the pool PAYS OUT and positive for the
    /// token it PULLS IN, from the pool's own perspective — standard Uniswap V3 sign convention.
    /// The pool calls back into msg.sender's electroSwapV3SwapCallback mid-call to collect
    /// whichever amount is positive, before this function returns.
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);
}
