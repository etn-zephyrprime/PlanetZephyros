// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";

/// @dev Trimmed to the functions this marketplace calls on NameWrapper, as deployed on
/// Electroneum testnet at NEXT_PUBLIC_ETN_TESTNET_DEPLOYMENT_ADDRESSES.NameWrapper. Matches
/// ens-contracts (ensdomains) INameWrapper signatures exactly so ABI encoding lines up with the
/// deployed contract; IERC1155 gives safeTransferFrom / setApprovalForAll / isApprovedForAll.
interface INameWrapperLite is IERC1155 {
    function wrapETH2LD(
        string calldata label,
        address wrappedOwner,
        uint16 ownerControlledFuses,
        address resolver
    ) external returns (uint64 expires);

    function setSubnodeRecord(
        bytes32 node,
        string calldata label,
        address owner,
        address resolver,
        uint64 ttl,
        uint32 fuses,
        uint64 expiry
    ) external returns (bytes32);

    function ownerOf(uint256 id) external view returns (address owner);

    function getData(uint256 id) external view returns (address owner, uint32 fuses, uint64 expiry);

    function canModifyName(bytes32 node, address addr) external view returns (bool);

    /// @dev DNS wire-format encoded name for `node` (e.g. "\x05alice\x03etn\x00"). Used to
    /// verify a caller-supplied label against a caller-supplied node without this contract ever
    /// needing to know or assume the chain's actual TLD/root node.
    function names(bytes32 node) external view returns (bytes memory);

    /// @dev New in V7. Burns one or more of the caller's OWN owner-controlled fuses on `node`
    /// (bitwise-OR'd with whatever's already burned — this can only ever add restrictions, never
    /// remove one). Used by lockDomainForSubnameSales to let a domain owner burn CANNOT_UNWRAP on
    /// their own already-wrapped 2LD — the prerequisite NameWrapper itself requires before
    /// PARENT_CANNOT_CONTROL can ever be burned on any of that domain's subnames (confirmed
    /// against the deployed contract's own _checkParentFuses: burning a parent-controlled fuse on
    /// a child reverts unless the PARENT's own fuses already have CANNOT_UNWRAP set — verified
    /// live via simulation before this was written, not assumed).
    function setFuses(bytes32 node, uint16 ownerControlledFuses) external returns (uint32);

    /// @dev New in V7. True if every bit in `fuseMask` is burned on `node`. Used to check whether
    /// a domain owner has already burned CANNOT_UNWRAP (the prerequisite for selling protected
    /// subnames) without this contract needing to unpack getData's raw fuses itself.
    function allFusesBurned(bytes32 node, uint32 fuseMask) external view returns (bool);

    /// @dev New in V7. Burns additional fuses on an EXISTING child `labelhash` under `parentNode`
    /// — used by upgradeSubnameToProtected to retroactively add PARENT_CANNOT_CONTROL to a
    /// subname that was originally sold unprotected (fuses = 0), once its parent has since burned
    /// its own CANNOT_UNWRAP. Callable only by whoever controls parentNode (NameWrapper's own
    /// onlyTokenOwner-equivalent check on the PARENT, confirmed against the deployed contract's
    /// own setChildFuses body — not the child's owner, deliberately: this is the parent choosing
    /// to give up power they still hold, not the child claiming something). `expiry` is passed
    /// through to _normaliseExpiry on the real contract; this app always passes the child's own
    /// CURRENT expiry (read via getData first) rather than relying on any special-cased sentinel
    /// value, so this call is never able to change a subname's expiry as a side effect of only
    /// adding a fuse.
    function setChildFuses(bytes32 parentNode, bytes32 labelhash, uint32 fuses, uint64 expiry) external;
}
