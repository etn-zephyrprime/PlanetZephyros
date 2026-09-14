// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal read-only view into a prior marketplace deployment (e.g. V3), used only by V4's
/// migrateActivation to re-confirm a domain was genuinely already activated there — never called
/// for anything else, and never given write access to the legacy contract.
interface ILegacyMarketplace {
    function domainActivated(bytes32 node) external view returns (bool);
}
