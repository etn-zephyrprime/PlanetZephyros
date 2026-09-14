// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Trimmed Uniswap V2 router interface, same shape used elsewhere in this repo
/// (see TestCore.sol / ErevosFeeReflection.sol) for buy-and-burn swaps. Purely additive to the
/// existing two functions — swapExactTokensForTokensSupportingFeeOnTransferTokens and
/// getAmountsOut were added for PlanetZephyrosSubdomainServiceV4's ERC20 buyback
/// (buyBackAndBurnToken) and ERC20 activation-fee quoting (activateDomainWithToken); every
/// existing consumer of this interface is unaffected.
interface IUniswapV2Router02Lite {
    function WETH() external pure returns (address);

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable;

    function swapExactTokensForTokensSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external;

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts);
}
