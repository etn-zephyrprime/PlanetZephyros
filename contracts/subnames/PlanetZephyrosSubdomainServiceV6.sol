// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
/**
 * Planet Zephyros Name Marketplace V6
 *
 * A wrap-around service for Electroneum's ENS-fork naming system.
 *
 *  1) Registration brokerage: buyers register a new .etn name through this contract instead of
 *     calling ETHRegistrarController directly. This contract forwards the exact base price to
 *     the registrar, wraps the resulting name via NameWrapper straight into the buyer's wallet,
 *     and keeps a configurable brokerage fee on top (100% project revenue). Payable in ETN
 *     (unchanged from V3/V4) or, via activateDomainWithToken, in any owner-whitelisted ERC20 —
 *     see that function's own comment for how the ETN-denominated fee gets converted.
 *
 *  2) Subname self-serve registration + resale: once a buyer owns a wrapped name, they can set a
 *     price — in ETN, or in any owner-whitelisted ERC20, or both at once — for anyone to
 *     self-register a subname of it (buyer picks the label, created on payment via
 *     NameWrapper.setSubnodeRecord), or list an already-wrapped name/subname they own for resale
 *     (resale stays ETN-only, unchanged from V3/V4). Every subname sale splits 80% to the seller
 *     and 20% into a pool, kept in whatever currency it was paid in, that is periodically swapped
 *     for CORE and burned via CORE.burn() — see buyBackAndBurn (ETN pool, unchanged from V3) and
 *     buyBackAndBurnToken (one ERC20 pool at a time, unchanged from V4).
 *
 * V6 vs V5: closes a real, confirmed-exploitable gap in _fulfillSubname. registerSubname always
 * creates a subname with fuses = 0 (unchanged since V3), meaning PARENT_CANNOT_CONTROL is never
 * burned on any subname this contract has ever sold. NameWrapper's own setSubnodeRecord only
 * blocks overwriting an existing subnode when THAT subnode's own PARENT_CANNOT_CONTROL fuse is
 * already burned (see NameWrapper._checkCanCallSetSubnodeOwner) — with it unburned, NameWrapper
 * happily lets the caller (this contract, via the parent owner's own setApprovalForAll) silently
 * reassign an existing, unexpired subname to a brand new owner. _fulfillSubname had no check of
 * its own layered on top, so ANYONE — not just the parent owner — could call registerSubname
 * again for an already-sold label, pay the listed price, and walk away with a subname someone
 * else already paid for and holds. Confirmed live via a read-only eth_call simulation against a
 * real activated domain with an existing paid subname and a nonzero price still set
 * (enssubdomain.etn / admin.enssubdomain.etn, 2026-09-17) — the call succeeded and returned the
 * existing subname's own node, i.e. it would have silently taken over that holder's subname.
 *
 * The fix is a straightforward availability check inside _fulfillSubname: before creating the
 * subnode, read its OWN current owner/expiry from NameWrapper (computing its node the same way
 * the ENS registry itself does — keccak256(parentNode, keccak256(label)), same formula this
 * repo's own off-chain scanners already use) and require it's either never been used or has
 * genuinely expired. This mirrors the exact "expired means reclaimable" rule NameWrapper's own
 * _checkCanCallSetSubnodeOwner already applies for its CANNOT_CREATE_SUBDOMAIN branch, so a real,
 * lapsed subname still becomes available for someone new to register — only an unexpired,
 * currently-held subname is now protected.
 *
 * Deliberately NOT part of this fix: burning PARENT_CANNOT_CONTROL (which would make a subname
 * truly un-revocable, not just protected against a stranger's re-registration). NameWrapper only
 * allows burning that fuse once the PARENT itself has already burned CANNOT_UNWRAP — an
 * irreversible, opt-in step for the parent name that none of this service's existing activated
 * domains have taken. That's a bigger, deliberate design decision for a future version, not a
 * drop-in fix; V6 only closes the "anyone can silently take an existing subname" gap.
 *
 * Everything else below is unchanged from V5 (restated for context, not modified):
 *
 * V5 vs V4: solves a gap V4 has no answer for at all. activateDomainWithToken/buyBackAndBurnToken
 * both need a whitelisted token's real market reachable through `swapRouter`'s plain
 * UniswapV2-style interface (getAmountsOut / swapExactTokensForTokensSupportingFeeOnTransferTokens)
 * — but confirmed live 2026-09-15, several tokens this deployment needs to whitelist (USDC, USDT,
 * CLUB, DCNT) have their real ElectroSwap liquidity sitting in V3-style pools instead. V4 simply
 * can't reach that liquidity: subname pricing/purchase still works fine for such a token
 * (registerSubname takes the ERC20 directly, no swap involved), but activateDomainWithToken has no
 * quote source for it, and every subname sale's 20% cut would land in erc20BurnPool[token] with no
 * way out at all — rescueTokens deliberately refuses to touch anything reserved in erc20BurnPool
 * (a safety feature, not a gap to route around), so those funds would be stuck forever.
 *
 * Rather than integrating ElectroSwap's actual Universal Router (a genuine, verified
 * command-encoded router at 0x2c12c8F15637b7A182DEc202816148A5E767DCEC, with its own separate
 * Permit2 deployment and NFT-marketplace surface this contract has no use for), V5 talks to the
 * underlying ElectroSwap V3 POOL contracts directly — the same standard, narrowly-scoped pattern
 * most production contracts integrating Uniswap V3 use (see IElectroSwapV3PoolLite):
 *   - v3PoolForToken (owner-set per token, via setV3PoolForToken) — address(0) means "use the
 *     existing V2 swapRouter path, unchanged from V4"; set means "this token's real liquidity is
 *     here instead".
 *   - activateDomainWithToken: for a V3-configured token, reads the pool's own slot0() spot price
 *     directly (V3PriceMath.getQuoteFromSqrtPriceX96, the same sqrtPriceX96-to-price conversion
 *     every real V3 integrator uses) instead of swapRouter.getAmountsOut — no swap execution
 *     needed either way, this function has never actually swapped anything (see its own comment).
 *   - buyBackAndBurnToken: for a V3-configured token, executes a real on-chain swap straight
 *     against the pool (token -> WETN via IElectroSwapV3PoolLite.swap() + this contract's own
 *     electroSwapV3SwapCallback, the standard Uniswap V3 push-payment pattern), then feeds the
 *     resulting WETN into the SAME already-existing, unchanged V2 WETN -> CORE leg swapRouter
 *     already provides — only the first hop changes for a V3-configured token, not the whole path.
 * Every existing V2-only token (BOLT, CORE, DYNO, PDY, FUGAZI) is completely unaffected — their
 * v3PoolForToken stays address(0), so both functions take the exact same code path V4 already had,
 * unchanged line-for-line.
 *
 * V4 vs V3 (unchanged in V5/V6, restated for context): subnamePricePerYear/setSubnamePricePerYear/
 * registerSubname/quoteSubname all carry a `paymentToken` parameter (address(0) = ETN, matching
 * V3's behavior exactly when used that way). whitelistedPaymentTokens/minSubnamePricePerYear are
 * the owner-controlled whitelist and per-token price floor — no payment token is hardcoded, and
 * neither is any minimum, including ETN's own (set in the constructor, then owner-adjustable same
 * as every other token). None of V3/V4/V5 has an upgrade path (plain Ownable, immutable
 * constructor wiring — confirmed, not assumed), so this is once again a new deployment:
 * migrateActivation lets a domain already activated on the immediately-prior contract (V5, for
 * this deployment) carry that fact over for free, by re-reading its own domainActivated as the
 * source of truth, rather than an off-chain admin migration list. Deliberately NOT migrated:
 * existing subname prices — those stay each owner's own call to make again here, never something
 * this contract or its owner sets on their behalf (see setSubnamePricePerYear's own access
 * control, unchanged: only the parent domain's own owner/operator, exactly as V3/V4/V5 already
 * enforced).
 *
 * Two more additions, both for day-one deploy convenience rather than the ongoing public flows
 * above (unchanged from V4/V5):
 *
 *  - The constructor can seed initial ETN subname prices for domains the deployer already owns
 *    (see the InitialSubnamePrice struct below) — each entry is marked activated AND priced in
 *    one atomic step at deploy time, skipping the normal "activate, then separately set a price"
 *    two-call sequence. This is a deployer-trusted bootstrap, not a public function: it trusts the
 *    node hashes it's given rather than re-verifying real NameWrapper/BaseRegistrar ownership the
 *    way activateDomain does, since there's no "buyer" to prove ownership against here.
 *
 *  - goldlisted / setGoldlisted: an owner-controlled exemption list that waives the activation fee
 *    entirely for a specific node, still going through the real activateDomain/
 *    activateDomainWithToken flow (full ownership verification, wrap-if-needed, etc. — only the
 *    fee itself is skipped). Exists for the exact case a very-long-duration name produces: the
 *    minBrokerageFeePerYear floor scales with however much time is left on the name, so a name
 *    with (for example) a 100-year remaining expiry would otherwise floor at 100x a normal
 *    activation fee — not a pricing bug, just a formula that assumes ordinary registration
 *    durations, never designed for names that long-lived.
 *
 * Website: https://planetzephyros.xyz/
 */

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "./interfaces/IETHRegistrarController.sol";
import "./interfaces/IPriceOracle.sol";
import "./interfaces/INameWrapperLite.sol";
import "./interfaces/IBurnableERC20.sol";
import "./interfaces/IUniswapV2Router02Lite.sol";
import "./interfaces/IBaseRegistrarLite.sol";
import "./interfaces/ILegacyMarketplace.sol";
import "./interfaces/IElectroSwapV3PoolLite.sol";
import "./libraries/V3PriceMath.sol";
import "../EnsSubdomainService/ETNNamehash.sol";

contract PlanetZephyrosSubdomainServiceV6 is Ownable, ReentrancyGuard {
    // ========================
    // Immutable protocol wiring
    // ========================
    IETHRegistrarController public immutable registrarController;
    INameWrapperLite public immutable nameWrapper;
    IBaseRegistrarLite public immutable baseRegistrar;

    /// @notice The immediately-prior marketplace's own deployed address (V5 for this deployment),
    /// kept only so migrateActivation can re-read its domainActivated mapping — never called for
    /// anything else. address(0) if there's nothing to migrate from.
    ILegacyMarketplace public immutable legacyMarketplace;

    // ========================
    // Fee configuration
    // ========================
    uint256 private constant BPS_DENOM = 10000;
    uint256 public constant SELLER_BPS = 8000; // 80% to seller on every marketplace sale
    uint256 public constant BURN_BPS = 2000; // 20% into the CORE buyback/burn pool
    uint256 public constant MAX_BROKERAGE_BPS = 5000; // 50% hard ceiling

    /// @notice Brokerage surcharge on top of the registrar's own price, kept as project revenue.
    uint256 public brokerageBps = 5000; // 50% default

    /// @notice Owner-adjustable floor under the brokerage fee, denominated per 365 days —
    /// protects project revenue in ETN terms regardless of how ETN's own market value moves.
    /// brokerageBps alone could compute an unacceptably small fee for cheap/short registrations;
    /// this is applied as max(bps-based fee, minBrokerageFeePerYear * duration / 365 days).
    /// Manually adjustable, not oracle-driven — the owner updates it if ETN's value moves.
    uint256 public minBrokerageFeePerYear = 25_000 ether;

    address public defaultResolver;
    address payable public projectWallet;

    address public coreToken;
    address public swapRouter;

    uint256 public burnPool; // ETN burn pool — unchanged from V3/V4/V5
    uint256 public totalCoreBurned;

    /// @notice ERC20 burn pools, one per token that's ever been paid in — separate from burnPool
    /// (ETN) since each needs its own swap path/leg when bought back (see buyBackAndBurnToken).
    mapping(address => uint256) public erc20BurnPool;

    bool public paused;

    // ========================
    // Whitelisted payment tokens + per-token price floor
    // ========================
    /// @notice ERC20 tokens a domain owner may price/sell subnames in, beyond ETN (which is
    /// always implicitly accepted and never appears in this mapping). Owner-controlled, not
    /// hardcoded — see setPaymentTokenWhitelisted.
    mapping(address => bool) public whitelistedPaymentTokens;

    /// @notice Owner-adjustable floor under a subname's per-year price, keyed by payment token
    /// (address(0) = ETN). Same "floor, not a fixed price, owner updates it as values move"
    /// spirit as minBrokerageFeePerYear above, just generalized to be per-token instead of a
    /// single global value — every whitelisted token needs its own floor since their real-world
    /// values are entirely unrelated to each other and to ETN's.
    mapping(address => uint256) public minSubnamePricePerYear;

    /// @notice Owner-set ElectroSwap V3 pool (paired against WETN) for a whitelisted token whose
    /// real liquidity swapRouter's plain V2-style interface can't reach at all — address(0) (the
    /// default for every token) means "use the V2 swapRouter path", unchanged from V4. See this
    /// contract's own header comment for the full reasoning (unchanged from V5).
    mapping(address => address) public v3PoolForToken;

    // ========================
    // Domain activation
    // ========================
    /// @notice Nodes that have paid their way into the marketplace, either by registering
    /// through registerName, by having a subname created through registerSubname (fee already
    /// captured in that sale's 80/20 split), or via a retroactive activateDomain payment.
    /// setSubnamePricePerYear/listExistingName require this before a node can be used in the marketplace.
    mapping(bytes32 => bool) public domainActivated;

    /// @notice Nodes exempt from the activation fee entirely — activateDomain/
    /// activateDomainWithToken still run their full ownership/wrap logic for a goldlisted node,
    /// only the fee itself becomes 0. Owner-controlled, not hardcoded — see setGoldlisted. See
    /// this contract's own header comment for why this exists (a very-long-duration name's
    /// minBrokerageFeePerYear floor scales with however much time is left on it).
    mapping(bytes32 => bool) public goldlisted;

    /// @notice One entry for the constructor's optional initial-pricing seed — see the
    /// constructor's own parameter and this contract's header comment.
    struct InitialSubnamePrice {
        bytes32 node;
        uint256 pricePerYear;
    }

    // ========================
    // Marketplace listings (resale of an already-wrapped name/subname)
    // ========================
    struct Listing {
        address seller;
        uint256 tokenId;
        uint256 price;
        bool active;
    }

    uint256 public nextListingId = 1;
    mapping(uint256 => Listing) public listings;

    // ========================
    // Subname self-serve registration
    // ========================
    uint256 public constant MAX_SUBNAME_DURATION = 100 * 365 days; // sanity ceiling only

    /// @notice Price (in wei of `paymentToken`, address(0) = ETN) per 365 days the parent domain
    /// owner charges for anyone to self-register a subname under their domain. 0 means not for
    /// sale IN THAT TOKEN — a domain can have a price set in several tokens at once (e.g. both
    /// ETN and CORE), each independent; clearing one doesn't affect the others.
    mapping(bytes32 => mapping(address => uint256)) public subnamePricePerYear;

    // ========================
    // Events
    // ========================
    event NameRegistered(
        address indexed buyer,
        string label,
        uint256 basePrice,
        uint256 brokerageFee,
        address wrappedTo,
        uint16 fuses
    );
    event ExistingNameListed(uint256 indexed listingId, address indexed seller, uint256 indexed tokenId, uint256 price);
    event SubnamePricePerYearSet(bytes32 indexed parentNode, address indexed paymentToken, uint256 pricePerYear);
    event SubnameRegistered(bytes32 indexed parentNode, string label, address indexed buyer, address indexed paymentToken, uint256 price, uint256 sellerAmount, uint256 burnAmount);
    event ListingCancelled(uint256 indexed listingId);
    event ListingSold(uint256 indexed listingId, address indexed buyer, address indexed seller, uint256 price, uint256 sellerAmount, uint256 burnAmount);
    event BrokerageBpsUpdated(uint256 brokerageBps);
    event MinBrokerageFeePerYearUpdated(uint256 minBrokerageFeePerYear);
    event ProjectWalletUpdated(address projectWallet);
    event DefaultResolverUpdated(address resolver);
    event CoreTokenUpdated(address coreToken);
    event SwapRouterUpdated(address swapRouter);
    event PausedUpdated(bool paused);
    /// @dev `token` is address(0) for the ETN pool (buyBackAndBurn) or the ERC20 address for a
    /// token pool (buyBackAndBurnToken, or a manual depositAndBurnCore closing the loop on a
    /// withdrawErc20BurnPoolForManualSwap) — one event covers all three paths, branch on `token`
    /// off-chain.
    event BuybackAndBurn(address indexed token, uint256 amountSpent, uint256 coreBurned);
    event TokensRescued(address token, uint256 amount, address to);
    event DomainActivated(bytes32 indexed node, address indexed payer, uint256 feePaid);
    event DomainActivatedWithToken(bytes32 indexed node, address indexed payer, address indexed paymentToken, uint256 tokenAmountPaid, uint256 etnEquivalentFee);
    event NameRenewed(address indexed payer, string label, uint256 basePrice, uint256 brokerageFee, uint256 newExpiry);
    event PaymentTokenWhitelisted(address indexed token, bool allowed);
    event MinSubnamePricePerYearUpdated(address indexed token, uint256 minPricePerYear);
    event ActivationMigrated(bytes32 indexed node);
    event GoldlistUpdated(bytes32 indexed node, bool status);
    event Erc20BurnPoolWithdrawnForManualSwap(address indexed token, uint256 amount, address indexed to);
    /// @notice pool == address(0) means the token was reset to the default V2 swapRouter path.
    event V3PoolForTokenUpdated(address indexed token, address pool);

    modifier whenNotPaused() {
        require(!paused, "Marketplace paused");
        _;
    }

    constructor(
        address _registrarController,
        address _nameWrapper,
        address _baseRegistrar,
        address _defaultResolver,
        address payable _projectWallet,
        address _owner,
        address _legacyMarketplace,
        InitialSubnamePrice[] memory _initialPricing,
        bytes32[] memory _initialGoldlist
    ) Ownable(_owner) {
        require(_registrarController != address(0), "Zero registrar controller");
        require(_nameWrapper != address(0), "Zero name wrapper");
        require(_baseRegistrar != address(0), "Zero base registrar");
        require(_projectWallet != address(0), "Zero project wallet");

        registrarController = IETHRegistrarController(_registrarController);
        nameWrapper = INameWrapperLite(_nameWrapper);
        baseRegistrar = IBaseRegistrarLite(_baseRegistrar);
        defaultResolver = _defaultResolver;
        projectWallet = _projectWallet;
        // Zero address is a valid, deliberate choice (nothing to migrate from) — not required
        // non-zero, unlike the wiring above that this contract genuinely can't function without.
        legacyMarketplace = ILegacyMarketplace(_legacyMarketplace);

        // Same non-hardcoded, owner-adjustable floor every other token gets (setMinSubnamePricePerYear)
        // — set here purely as ETN's own starting value, matching the number this service has
        // always used for subname pricing. Set BEFORE the initial-pricing loop below, which checks
        // against it.
        minSubnamePricePerYear[address(0)] = 1000 ether;

        // Deployer-trusted bootstrap — see this contract's own header comment. Each entry is
        // marked activated (an owner-seeded price with domainActivated left false would sit
        // inert: nothing downstream re-checks domainActivated once a price exists, so leaving it
        // false here would just be a misleading public flag, not an extra safety gate) and priced
        // in ETN, still subject to the same minimum-price floor setSubnamePricePerYear itself
        // enforces (checked above, not skipped).
        for (uint256 i = 0; i < _initialPricing.length; i++) {
            bytes32 node = _initialPricing[i].node;
            uint256 pricePerYear = _initialPricing[i].pricePerYear;
            require(pricePerYear >= minSubnamePricePerYear[address(0)], "Below minimum price");

            domainActivated[node] = true;
            subnamePricePerYear[node][address(0)] = pricePerYear;
            emit DomainActivated(node, _owner, 0);
            emit SubnamePricePerYearSet(node, address(0), pricePerYear);
        }

        for (uint256 i = 0; i < _initialGoldlist.length; i++) {
            goldlisted[_initialGoldlist[i]] = true;
            emit GoldlistUpdated(_initialGoldlist[i], true);
        }
    }

    // ========================================================
    // Flow A: registration brokerage
    // ========================================================

    /// @notice Builds the Registration struct a buyer must hash (via computeCommitment) and
    /// commit on ETHRegistrarController directly, before calling registerName here. Owner is
    /// forced to this contract because it must temporarily hold the raw name to wrap it;
    /// resolver/data/reverseRecord are forced off because proxying them through this contract's
    /// commit-reveal cycle cannot be proven safe against the registrar's own record-setting
    /// authorisation checks — buyers set resolver records themselves after they own the wrapped
    /// name.
    function buildRegistration(
        string calldata label,
        uint256 duration,
        bytes32 secret,
        bytes32 referrer
    ) public view returns (IETHRegistrarController.Registration memory registration) {
        registration = IETHRegistrarController.Registration({
            label: label,
            owner: address(this),
            duration: duration,
            secret: secret,
            resolver: address(0),
            data: new bytes[](0),
            reverseRecord: 0,
            referrer: referrer
        });
    }

    /// @notice Convenience view so integrators don't need to hardcode this contract's address
    /// client-side when building the commitment to pass to ETHRegistrarController.commit().
    function computeCommitment(
        string calldata label,
        uint256 duration,
        bytes32 secret,
        bytes32 referrer
    ) external view returns (bytes32) {
        return registrarController.makeCommitment(buildRegistration(label, duration, secret, referrer));
    }

    /// @dev Shared by quoteRegistration/_quoteRegistrationChecked/quoteRenewal/
    /// _quoteRenewalChecked — the brokerage fee is whichever is larger: the percentage-based fee,
    /// or the per-year minimum floor scaled to this duration.
    function _brokerageFeeFor(uint256 basePrice, uint256 duration) internal view returns (uint256) {
        uint256 pctFee = (basePrice * brokerageBps) / BPS_DENOM;
        uint256 minFee = (minBrokerageFeePerYear * duration) / 365 days;
        return pctFee > minFee ? pctFee : minFee;
    }

    /// @notice Quotes the registrar's own price plus this contract's brokerage fee.
    function quoteRegistration(
        string calldata label,
        uint256 duration
    ) external view returns (uint256 basePrice, uint256 brokerageFee, uint256 totalPrice) {
        IPriceOracle.Price memory p = registrarController.rentPrice(label, duration);
        basePrice = p.base + p.premium;
        brokerageFee = _brokerageFeeFor(basePrice, duration);
        totalPrice = basePrice + brokerageFee;
    }

    /// @notice Registers a name via ETHRegistrarController and wraps it directly to
    /// `wrappedOwner`. Caller must have already called ETHRegistrarController.commit() with the
    /// exact commitment returned by computeCommitment(label, duration, secret, referrer), and
    /// waited out the registrar's minCommitmentAge. `expectedNode` is the wrapped name's ENS
    /// node (e.g. ethers.namehash("label.<tld>") computed off-chain) — this contract verifies it
    /// against NameWrapper's own record after wrapping, rather than assuming any particular
    /// root/TLD itself, and marks it activated so setSubnamePricePerYear/listExistingName work
    /// immediately.
    function registerName(
        string calldata label,
        uint256 duration,
        bytes32 secret,
        bytes32 referrer,
        address wrappedOwner,
        uint16 ownerControlledFuses,
        bytes32 expectedNode
    ) external payable nonReentrant whenNotPaused returns (uint64 expiry) {
        require(wrappedOwner != address(0), "Zero wrapped owner");

        (uint256 basePrice, uint256 brokerageFee, uint256 totalRequired) = _quoteRegistrationChecked(label, duration);

        registrarController.register{value: basePrice}(buildRegistration(label, duration, secret, referrer));

        expiry = _wrapAndActivate(label, wrappedOwner, ownerControlledFuses, expectedNode);

        _settleRegistration(brokerageFee, totalRequired);

        emit NameRegistered(msg.sender, label, basePrice, brokerageFee, wrappedOwner, ownerControlledFuses);
    }

    /// @dev Split out of registerName purely to keep that function's stack usage low enough to
    /// compile without viaIR (Remix's default codegen). Mirrors quoteRegistration's math.
    function _quoteRegistrationChecked(
        string calldata label,
        uint256 duration
    ) internal view returns (uint256 basePrice, uint256 brokerageFee, uint256 totalRequired) {
        IPriceOracle.Price memory p = registrarController.rentPrice(label, duration);
        basePrice = p.base + p.premium;
        brokerageFee = _brokerageFeeFor(basePrice, duration);
        totalRequired = basePrice + brokerageFee;
        require(msg.value >= totalRequired, "Insufficient payment");
    }

    /// @dev Split out of registerName for the same reason as _quoteRegistrationChecked. This
    /// contract is the raw registrant at this point; approve NameWrapper and wrap straight to
    /// the buyer, then verify/activate expectedNode.
    function _wrapAndActivate(
        string calldata label,
        address wrappedOwner,
        uint16 ownerControlledFuses,
        bytes32 expectedNode
    ) internal returns (uint64 expiry) {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        baseRegistrar.approve(address(nameWrapper), tokenId);
        expiry = nameWrapper.wrapETH2LD(label, wrappedOwner, ownerControlledFuses, defaultResolver);

        require(_firstLabelMatches(nameWrapper.names(expectedNode), label), "expectedNode mismatch");
        domainActivated[expectedNode] = true;
    }

    /// @dev Split out of registerName for the same reason as _quoteRegistrationChecked.
    function _settleRegistration(uint256 brokerageFee, uint256 totalRequired) internal {
        if (brokerageFee > 0) {
            (bool ok, ) = projectWallet.call{value: brokerageFee}("");
            require(ok, "Brokerage transfer failed");
        }

        uint256 refund = msg.value - totalRequired;
        if (refund > 0) {
            (bool ok2, ) = payable(msg.sender).call{value: refund}("");
            require(ok2, "Refund failed");
        }
    }

    /// @notice Quotes the registrar's own renewal price plus this contract's brokerage fee.
    /// Renewals never carry a premium (unlike fresh registrations) — the real registrar's
    /// renew() only ever checks against price.base, so this mirrors that exactly rather than
    /// reusing quoteRegistration's base+premium math.
    function quoteRenewal(
        string calldata label,
        uint256 duration
    ) external view returns (uint256 basePrice, uint256 brokerageFee, uint256 totalPrice) {
        IPriceOracle.Price memory p = registrarController.rentPrice(label, duration);
        basePrice = p.base;
        brokerageFee = _brokerageFeeFor(basePrice, duration);
        totalPrice = basePrice + brokerageFee;
    }

    /// @notice Renews a name via ETHRegistrarController, forwarding the exact base renewal
    /// price and keeping a brokerage fee on top, same revenue model as registerName. Anyone can
    /// renew any name (matching the real registrar's own renew(), which isn't ownership-gated).
    function renewName(
        string calldata label,
        uint256 duration,
        bytes32 referrer
    ) external payable nonReentrant whenNotPaused returns (uint256 newExpiry) {
        (uint256 basePrice, uint256 brokerageFee, uint256 totalRequired) = _quoteRenewalChecked(label, duration);

        registrarController.renew{value: basePrice}(label, duration, referrer);
        newExpiry = baseRegistrar.nameExpires(uint256(keccak256(bytes(label))));

        _settleRenewal(brokerageFee, totalRequired);

        emit NameRenewed(msg.sender, label, basePrice, brokerageFee, newExpiry);
    }

    /// @dev Split out of renewName for the same stack-depth reason as the registration helpers.
    /// Mirrors quoteRenewal's math.
    function _quoteRenewalChecked(
        string calldata label,
        uint256 duration
    ) internal view returns (uint256 basePrice, uint256 brokerageFee, uint256 totalRequired) {
        IPriceOracle.Price memory p = registrarController.rentPrice(label, duration);
        basePrice = p.base;
        brokerageFee = _brokerageFeeFor(basePrice, duration);
        totalRequired = basePrice + brokerageFee;
        require(msg.value >= totalRequired, "Insufficient payment");
    }

    /// @dev Split out of renewName for the same reason as _quoteRenewalChecked.
    function _settleRenewal(uint256 brokerageFee, uint256 totalRequired) internal {
        if (brokerageFee > 0) {
            (bool ok, ) = projectWallet.call{value: brokerageFee}("");
            require(ok, "Brokerage transfer failed");
        }

        uint256 refund = msg.value - totalRequired;
        if (refund > 0) {
            (bool ok2, ) = payable(msg.sender).call{value: refund}("");
            require(ok2, "Refund failed");
        }
    }

    /// @notice Retroactively activates a name that was registered directly with
    /// ETHRegistrarController (bypassing this marketplace's brokerage), so its owner can start
    /// using setSubnamePricePerYear/listExistingName. Fee is brokerageBps of what the registrar would
    /// charge today to register this exact name for however much time is actually left on it
    /// (read from NameWrapper), so it can't be gamed by under-declaring duration.
    function activateDomain(
        bytes32 node,
        string calldata label
    ) external payable nonReentrant whenNotPaused returns (uint256 fee) {
        bool wasWrapped = _requireNodeOwner(node, label, msg.sender);
        require(!domainActivated[node], "Already activated");

        // Always computed (preserves _activationFee's own expiry check regardless of goldlist
        // status — a goldlisted-but-expired name still shouldn't activate), only the CHARGE is
        // waived for a goldlisted node.
        uint256 computedFee = _activationFee(node, label);
        fee = goldlisted[node] ? 0 : computedFee;
        require(msg.value >= fee, "Insufficient payment");

        // A name registered directly through ETHRegistrarController and never wrapped only gets
        // as far as this require/fee math via BaseRegistrar fallbacks — nothing downstream of
        // activation (setSubnamePricePerYear, registerSubname, resale) works without the name
        // actually being wrapped, since all of that reads NameWrapper directly. So activation
        // itself now performs the wrap for that case, not just a flag flip.
        if (!wasWrapped) {
            _wrapDirectRegistration(label, msg.sender);
        }

        domainActivated[node] = true;
        _settleActivation(fee);

        emit DomainActivated(node, msg.sender, fee);
    }

    /// @dev Names registered directly through ETHRegistrarController but never wrapped — the
    /// exact case activateDomain exists to handle — have no NameWrapper data at all: ownerOf and
    /// names() both return zero/empty for them, not "not found". Checking NameWrapper alone (as
    /// this used to) meant activateDomain could never succeed for a genuinely unwrapped name,
    /// contradicting its own stated purpose. Checks NameWrapper first (covers a name that's
    /// already wrapped, e.g. re-checking one already activated), falling back to the raw
    /// BaseRegistrar registrant for the unwrapped case — verifying label really matches node via
    /// ETNNamehash instead of nameWrapper.names(node), which is equally unset pre-wrap. Ownership
    /// and label-match stay separate requires (not one combined bool) so each keeps its own
    /// distinct revert reason, same as before this fallback existed. Returns whether the name was
    /// already wrapped at check time, so activateDomain knows whether it still needs wrapping.
    function _requireNodeOwner(
        bytes32 node,
        string calldata label,
        address account
    ) internal view returns (bool wasWrapped) {
        address wrappedOwner = nameWrapper.ownerOf(uint256(node));
        if (wrappedOwner != address(0)) {
            require(wrappedOwner == account, "Not name owner");
            require(_firstLabelMatches(nameWrapper.names(node), label), "Label mismatch");
            return true;
        }

        bytes32 labelHash = keccak256(bytes(label));
        require(baseRegistrar.ownerOf(uint256(labelHash)) == account, "Not name owner");
        require(ETNNamehash.etnNode(labelHash) == node, "Label mismatch");
        return false;
    }

    /// @dev Pulls a directly-registered (never wrapped) name into NameWrapper custody, wrapped
    /// straight back to its own owner. Mirrors _wrapAndActivate's exact approach for freshly
    /// registered names (this contract becomes the momentary registrant, then wraps as itself —
    /// nameWrapper.wrapETH2LD requires registrant == msg.sender, so this contract has to actually
    /// hold the token to call it, not merely be approved for it) — the only difference is the
    /// token starts out owned by `owner` instead of freshly registered to this contract, so it
    /// has to be pulled in first via a standard ERC721 operator transfer. Requires `owner` to have
    /// already called baseRegistrar.setApprovalForAll(address(this), true); reverts with a clear
    /// reason if they haven't, rather than surfacing BaseRegistrar's own generic ERC721 revert.
    function _wrapDirectRegistration(string calldata label, address owner) internal {
        uint256 tokenId = uint256(keccak256(bytes(label)));
        require(baseRegistrar.isApprovedForAll(owner, address(this)), "Approve BaseRegistrar first");

        baseRegistrar.transferFrom(owner, address(this), tokenId);
        baseRegistrar.approve(address(nameWrapper), tokenId);
        nameWrapper.wrapETH2LD(label, owner, 0, defaultResolver);
    }

    /// @dev Split out of activateDomain to keep its stack usage low enough to compile without
    /// viaIR (Remix's default codegen).
    function _activationFee(bytes32 node, string calldata label) internal view returns (uint256 fee) {
        (, , uint64 wrappedExpiry) = nameWrapper.getData(uint256(node));
        uint256 expiry = wrappedExpiry;
        // Same unwrapped-name gap as _isNodeOwner above — NameWrapper has no expiry recorded for
        // a name that was never wrapped, so fall back to the real registrar expiry.
        if (expiry == 0) {
            expiry = baseRegistrar.nameExpires(uint256(keccak256(bytes(label))));
        }
        require(expiry > block.timestamp, "Name expired");
        uint256 remaining = expiry - block.timestamp;

        IPriceOracle.Price memory p = registrarController.rentPrice(label, remaining);
        uint256 basePrice = p.base + p.premium;
        fee = _brokerageFeeFor(basePrice, remaining);
    }

    /// @dev Split out of activateDomain for the same reason as _activationFee.
    function _settleActivation(uint256 fee) internal {
        if (fee > 0) {
            (bool ok, ) = projectWallet.call{value: fee}("");
            require(ok, "Activation fee transfer failed");
        }

        uint256 refund = msg.value - fee;
        if (refund > 0) {
            (bool ok2, ) = payable(msg.sender).call{value: refund}("");
            require(ok2, "Refund failed");
        }
    }

    /// @notice Same activation as activateDomain, but paid in a whitelisted ERC20 instead of ETN.
    /// The activation fee itself stays authoritatively denominated in ETN (_activationFee's own
    /// math, unchanged) — this just converts that ETN amount into `paymentToken` at the router's
    /// live on-chain rate, via getAmountsOut, at the moment of payment. That's a real market
    /// rate, not a third-party price feed: no oracle is needed because the router's own reserves
    /// ARE the price source, read fresh inside this same transaction.
    ///
    /// For a token with v3PoolForToken[paymentToken] set, the quote instead comes from that
    /// pool's own live slot0() spot price (V3PriceMath) — no swap executed either way, on V2 or
    /// V3; this function has never swapped anything, only quoted (see this contract's own header
    /// comment for why the two paths exist).
    ///
    /// `maxTokenAmount` is the caller's own slippage cap (revert if the live quote wants more than
    /// they're willing to pay) and `deadline` bounds how long this specific quote is valid for.
    function activateDomainWithToken(
        bytes32 node,
        string calldata label,
        address paymentToken,
        uint256 maxTokenAmount,
        uint256 deadline
    ) external nonReentrant whenNotPaused returns (uint256 tokenAmountPaid) {
        require(whitelistedPaymentTokens[paymentToken], "Token not whitelisted");
        require(deadline >= block.timestamp, "Quote expired");

        bool wasWrapped = _requireNodeOwner(node, label, msg.sender);
        require(!domainActivated[node], "Already activated");

        // Always computed (preserves _activationFee's own expiry check regardless of goldlist
        // status), only the CHARGE is waived for a goldlisted node — see activateDomain's own
        // comment on this same pattern.
        uint256 computedEtnFee = _activationFee(node, label);
        uint256 etnFee = goldlisted[node] ? 0 : computedEtnFee;

        if (!wasWrapped) {
            _wrapDirectRegistration(label, msg.sender);
        }
        domainActivated[node] = true;

        // A goldlisted (or otherwise free) activation needs no quote and no router at all —
        // tokenAmountPaid stays 0, nothing to transfer. Only a genuinely non-zero fee needs
        // swapRouter configured (both the V2 and V3 quote paths below read WETH() off it, even
        // though the V3 path never actually calls swapRouter to swap anything).
        if (etnFee > 0) {
            require(swapRouter != address(0), "Swap router not configured");
            address v3Pool = v3PoolForToken[paymentToken];
            if (v3Pool != address(0)) {
                tokenAmountPaid = _quoteV3(v3Pool, etnFee);
            } else {
                address weth = IUniswapV2Router02Lite(swapRouter).WETH();
                address[] memory path = new address[](2);
                path[0] = weth;
                path[1] = paymentToken;
                uint256[] memory amounts = IUniswapV2Router02Lite(swapRouter).getAmountsOut(etnFee, path);
                tokenAmountPaid = amounts[amounts.length - 1];
            }
            require(tokenAmountPaid <= maxTokenAmount, "Quote exceeds max token amount");
            require(IERC20(paymentToken).transferFrom(msg.sender, projectWallet, tokenAmountPaid), "Fee transfer failed");
        }

        emit DomainActivatedWithToken(node, msg.sender, paymentToken, tokenAmountPaid, etnFee);
    }

    /// @dev Split out of activateDomainWithToken for the same stack-depth reason as the other
    /// flows. Quotes `etnFee` wei of WETN in terms of `pool`'s other token, from its live spot
    /// price — see this contract's own header comment on why a spot read is an accepted,
    /// bounded-exposure trade-off for a one-off activation fee (same class already accepted by
    /// the V2 getAmountsOut path this mirrors).
    function _quoteV3(address pool, uint256 etnFee) internal view returns (uint256 tokenAmountPaid) {
        address weth = IUniswapV2Router02Lite(swapRouter).WETH();
        bool wethIsToken0 = IElectroSwapV3PoolLite(pool).token0() == weth;
        (uint160 sqrtPriceX96, , , , , , ) = IElectroSwapV3PoolLite(pool).slot0();
        tokenAmountPaid = V3PriceMath.getQuoteFromSqrtPriceX96(sqrtPriceX96, etnFee, wethIsToken0);
    }

    /// @notice Carries a domain's activation status over from legacyMarketplace for free —
    /// activation there was already paid for, once, and shouldn't need paying again just because
    /// the marketplace contract itself moved. Permissionless (anyone can call it for any node,
    /// not just the domain's own owner) and trustless: it re-reads legacyMarketplace's own
    /// domainActivated mapping as the objective source of truth rather than trusting an off-chain
    /// admin-supplied list, so there's no bulk-import step, no gas-limit risk from batching many
    /// nodes in one tx, and no way for this to mark something activated that wasn't genuinely
    /// already paid for there. Deliberately does NOT carry over subname prices — see this
    /// contract's own header comment for why that stays each owner's own action, never something a
    /// migration sets on their behalf.
    function migrateActivation(bytes32 node) external {
        require(address(legacyMarketplace) != address(0), "No legacy marketplace configured");
        require(!domainActivated[node], "Already activated on this contract");
        require(legacyMarketplace.domainActivated(node), "Not activated on legacy marketplace");
        domainActivated[node] = true;
        emit ActivationMigrated(node);
    }

    /// @dev Compares the first (leftmost) DNS-wire-encoded label in `encoded` against `label`,
    /// without assuming anything about what follows it (the TLD/root). Used to verify a
    /// caller-supplied node/label pair against NameWrapper's own authoritative record.
    function _firstLabelMatches(bytes memory encoded, string calldata label) internal pure returns (bool) {
        bytes memory labelBytes = bytes(label);
        if (encoded.length < 1 + labelBytes.length) return false;
        if (uint8(encoded[0]) != labelBytes.length) return false;
        for (uint256 i = 0; i < labelBytes.length; i++) {
            if (encoded[1 + i] != labelBytes[i]) return false;
        }
        return true;
    }

    // ========================================================
    // Flow B: subname self-serve registration + resale marketplace
    // ========================================================

    /// @notice Sets (or clears, with pricePerYear=0) the per-year price, in `paymentToken`
    /// (address(0) = ETN), for self-serve subname registration under a domain the caller
    /// owns/controls. Requires the domain to already be activated. Each payment token's price is
    /// independent — setting/clearing one currency's listing never touches any other's, so a
    /// domain can be for sale in several currencies at once (e.g. 1000 ETN AND 500 CORE).
    function setSubnamePricePerYear(bytes32 parentNode, address paymentToken, uint256 pricePerYear) external whenNotPaused {
        require(domainActivated[parentNode], "Domain not activated");
        require(nameWrapper.canModifyName(parentNode, msg.sender), "Not parent owner/operator");
        require(paymentToken == address(0) || whitelistedPaymentTokens[paymentToken], "Token not whitelisted");
        require(pricePerYear == 0 || pricePerYear >= minSubnamePricePerYear[paymentToken], "Below minimum price");
        subnamePricePerYear[parentNode][paymentToken] = pricePerYear;
        emit SubnamePricePerYearSet(parentNode, paymentToken, pricePerYear);
    }

    /// @notice Quotes what `duration` seconds of a subname under `parentNode` costs, in
    /// `paymentToken`, at its current per-year rate. No external calls, so registerSubname can
    /// call this directly (unlike quoteRegistration/_quoteRegistrationChecked's duplication,
    /// which exists specifically because that math calls out to registrarController.rentPrice
    /// and needs the stack headroom).
    function quoteSubname(bytes32 parentNode, address paymentToken, uint256 duration) public view returns (uint256 price) {
        price = (subnamePricePerYear[parentNode][paymentToken] * duration) / 365 days;
    }

    /// @dev Computes a child's ENS node from its parent's node and its own label, the same
    /// formula the ENS registry itself uses for every subnode (keccak256(parent, keccak256(label)))
    /// — NOT specific to any particular TLD/root, unlike ETNNamehash.etnNode/projectNode above
    /// (which only handle one/two labels directly under .etn). Matches computeSubnode() in this
    /// repo's own off-chain scanners (marketplaceWatcher.js, activatedDomainsCache.js) exactly, so
    /// a node this computes always lines up with what those already compute for the same label.
    function _computeSubnode(bytes32 parentNode, string calldata label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parentNode, keccak256(bytes(label))));
    }

    /// @notice Self-serve subname registration: buyer picks the label, duration, and which of the
    /// parent owner's listed currencies to pay in, then pays that currency's per-year rate scaled
    /// to duration — the subname is created and wrapped directly to the buyer. Same 80/20
    /// seller/burn split as buyListing, via _settleSale, just settled in whichever currency was
    /// actually used. The new subname is itself immediately activated, so its new owner can set
    /// their own subname price / resell it right away.
    ///
    /// For an ERC20 paymentToken, the caller must have already called
    /// IERC20(paymentToken).approve(address(this), price) (or more) — same shape as every other
    /// ERC20 spend-approval already required elsewhere in this app (e.g. NameWrapper's
    /// setApprovalForAll for listings). msg.value must be exactly 0 in that case; ETN sent
    /// alongside an ERC20-denominated purchase would just be stuck, so this is rejected outright
    /// rather than silently accepted.
    function registerSubname(
        bytes32 parentNode,
        string calldata label,
        uint256 duration,
        address paymentToken
    ) external payable nonReentrant whenNotPaused returns (bytes32 subNode) {
        require(duration > 0 && duration <= MAX_SUBNAME_DURATION, "Invalid duration");
        require(paymentToken == address(0) || whitelistedPaymentTokens[paymentToken], "Token not whitelisted");
        uint256 price = quoteSubname(parentNode, paymentToken, duration);
        require(price > 0, "Subnames not for sale in this token");
        if (paymentToken == address(0)) {
            require(msg.value >= price, "Insufficient payment");
        } else {
            require(msg.value == 0, "Unexpected ETN sent");
        }

        address seller = nameWrapper.ownerOf(uint256(parentNode));
        subNode = _fulfillSubname(parentNode, label, seller, duration);

        (uint256 sellerAmount, uint256 burnAmount) = _settleSale(seller, price, paymentToken);

        emit SubnameRegistered(parentNode, label, msg.sender, paymentToken, price, sellerAmount, burnAmount);
    }

    /// @dev Split out of registerSubname to keep its stack usage low enough to compile without
    /// viaIR (Remix's default codegen).
    ///
    /// V6 FIX: added the "label already taken" availability check below — see this contract's
    /// own header comment for the full incident this closes. Every subname this contract has ever
    /// created (V3 through V5, and still here in V6) is wrapped with fuses = 0, so
    /// PARENT_CANNOT_CONTROL is never burned on it. NameWrapper's own setSubnodeRecord only blocks
    /// overwriting an EXISTING subnode when that subnode's own PARENT_CANNOT_CONTROL fuse is
    /// already burned — with it unburned, NameWrapper itself raises no objection to this contract
    /// silently reassigning someone's already-paid-for subname to a brand new caller. Without a
    /// check here, on V5 (and every version before it), calling registerSubname again for an
    /// already-sold label — by ANYONE, not just the parent owner — would pay the current price and
    /// walk away with a subname somebody else already holds. This require closes exactly that gap:
    /// it treats an existing, unexpired subnode as unavailable, while a genuinely expired one
    /// (past its own recorded expiry) stays legitimately re-registerable — the same rule
    /// NameWrapper's own _checkCanCallSetSubnodeOwner already applies for its own
    /// CANNOT_CREATE_SUBDOMAIN branch, so this doesn't change what SHOULD be purchasable, only
    /// blocks taking something that's still someone else's.
    function _fulfillSubname(
        bytes32 parentNode,
        string calldata label,
        address seller,
        uint256 duration
    ) internal returns (bytes32 subNode) {
        require(nameWrapper.canModifyName(parentNode, seller), "Parent owner lost control");
        require(nameWrapper.isApprovedForAll(seller, address(this)), "Marketplace not approved by parent owner");

        (, , uint64 parentExpiry) = nameWrapper.getData(uint256(parentNode));
        uint64 expiry = uint64(block.timestamp + duration);
        require(expiry <= parentExpiry, "Duration exceeds parent expiry");

        bytes32 candidateSubNode = _computeSubnode(parentNode, label);
        (address existingOwner, , uint64 existingExpiry) = nameWrapper.getData(uint256(candidateSubNode));
        require(existingOwner == address(0) || existingExpiry <= block.timestamp, "Label already taken");

        subNode = nameWrapper.setSubnodeRecord(parentNode, label, msg.sender, defaultResolver, 0, 0, expiry);
        domainActivated[subNode] = true;
    }

    /// @notice Lists an already-wrapped name/subname the caller owns for resale. Caller must
    /// have called nameWrapper.setApprovalForAll(marketplace, true).
    function listExistingName(uint256 tokenId, uint256 price) external whenNotPaused returns (uint256 listingId) {
        require(price > 0, "Price required");
        require(domainActivated[bytes32(tokenId)], "Domain not activated");
        require(nameWrapper.ownerOf(tokenId) == msg.sender, "Not token owner");
        require(nameWrapper.isApprovedForAll(msg.sender, address(this)), "Marketplace not approved");

        listingId = nextListingId++;
        listings[listingId] = Listing({
            seller: msg.sender,
            tokenId: tokenId,
            price: price,
            active: true
        });

        emit ExistingNameListed(listingId, msg.sender, tokenId, price);
    }

    function cancelListing(uint256 listingId) external {
        Listing storage l = listings[listingId];
        require(l.active, "Not active");
        require(l.seller == msg.sender || msg.sender == owner(), "Not authorised");
        l.active = false;
        emit ListingCancelled(listingId);
    }

    /// @notice Buys an active listing, transferring the existing NameWrapper token from seller
    /// to buyer. Every sale splits 80% seller / 20% burn pool.
    function buyListing(uint256 listingId) external payable nonReentrant whenNotPaused {
        Listing storage l = listings[listingId];
        require(l.active, "Not active");
        require(msg.value >= l.price, "Insufficient payment");

        address seller = l.seller;
        uint256 price = l.price;
        l.active = false; // effects before interactions

        nameWrapper.safeTransferFrom(seller, msg.sender, l.tokenId, 1, "");

        (uint256 sellerAmount, uint256 burnAmount) = _settleSale(seller, price, address(0));

        emit ListingSold(listingId, msg.sender, seller, price, sellerAmount, burnAmount);
    }

    /// @dev Split out of buyListing/registerSubname for the same stack-depth reason as the other
    /// flows. buyListing always passes address(0) (resale stays ETN-only, unchanged from V3/V4/V5);
    /// registerSubname passes whichever currency the buyer actually chose.
    function _settleSale(address seller, uint256 price, address paymentToken) internal returns (uint256 sellerAmount, uint256 burnAmount) {
        sellerAmount = (price * SELLER_BPS) / BPS_DENOM;
        burnAmount = price - sellerAmount;

        if (paymentToken == address(0)) {
            burnPool += burnAmount;

            (bool ok, ) = payable(seller).call{value: sellerAmount}("");
            require(ok, "Seller payment failed");

            uint256 refund = msg.value - price;
            if (refund > 0) {
                (bool ok2, ) = payable(msg.sender).call{value: refund}("");
                require(ok2, "Refund failed");
            }
        } else {
            erc20BurnPool[paymentToken] += burnAmount;

            // Two separate transferFrom calls (not one transferFrom-to-self then an internal
            // forward) deliberately — a fee-on-transfer ERC20 whitelisted here would otherwise
            // have its transfer fee deducted once from the FULL price and then silently misapply
            // across both legs; splitting the calls means each leg's fee (if any) is deducted
            // only from that leg, matching what "80/20 of price" is supposed to mean regardless
            // of the token's own transfer behavior.
            require(IERC20(paymentToken).transferFrom(msg.sender, seller, sellerAmount), "Seller payment failed");
            require(IERC20(paymentToken).transferFrom(msg.sender, address(this), burnAmount), "Burn pool transfer failed");
        }
    }

    // ========================================================
    // CORE buyback and burn
    // ========================================================

    /// @notice Swaps the accumulated burn pool for CORE and burns it via CORE.burn(). Owner-only
    /// and slippage-guarded by the caller-supplied minCoreOut, matching the manual-trigger
    /// pattern already used by this repo's other fee-reflection contracts.
    function buyBackAndBurn(uint256 minCoreOut, uint256 deadline) external onlyOwner nonReentrant {
        require(coreToken != address(0) && swapRouter != address(0), "Buyback not configured");
        uint256 amount = burnPool;
        require(amount > 0, "Nothing to burn");
        burnPool = 0;

        address[] memory path = new address[](2);
        path[0] = IUniswapV2Router02Lite(swapRouter).WETH();
        path[1] = coreToken;

        uint256 balanceBefore = IERC20(coreToken).balanceOf(address(this));

        IUniswapV2Router02Lite(swapRouter).swapExactETHForTokensSupportingFeeOnTransferTokens{value: amount}(
            minCoreOut,
            path,
            address(this),
            deadline
        );

        uint256 received = IERC20(coreToken).balanceOf(address(this)) - balanceBefore;
        require(received > 0, "Swap failed");

        IBurnableERC20(coreToken).burn(received);
        totalCoreBurned += received;

        emit BuybackAndBurn(address(0), amount, received);
    }

    /// @notice Swaps one whitelisted ERC20's accumulated burn pool for CORE and burns it —
    /// the ERC20 counterpart to buyBackAndBurn above, one token at a time (each pool needs its
    /// own swap path, so there's no single call that drains every token's pool at once). Routes
    /// token -> WETN -> CORE explicitly: a UniswapV2-style router never auto-routes, the caller
    /// always supplies the exact hop path, and WETN is read from the router itself (same WETH()
    /// call the ETN path already makes) rather than stored separately. If the whitelisted token
    /// IS coreToken itself, there's nothing to swap — the 20% cut is already CORE — so that case
    /// skips the router entirely and burns directly.
    ///
    /// For a token with v3PoolForToken[token] set, the first hop instead executes as a real V3
    /// swap straight against that pool (see _swapExactInputV3/electroSwapV3SwapCallback) — the
    /// WETN -> CORE leg is exactly the same swapRouter call either way, only the first hop's
    /// source changes. See this contract's own header comment for the full reasoning.
    function buyBackAndBurnToken(address token, uint256 minCoreOut, uint256 deadline) external onlyOwner nonReentrant {
        require(coreToken != address(0), "CORE token not configured");
        uint256 amount = erc20BurnPool[token];
        require(amount > 0, "Nothing to burn");
        erc20BurnPool[token] = 0;

        if (token == coreToken) {
            IBurnableERC20(coreToken).burn(amount);
            totalCoreBurned += amount;
            emit BuybackAndBurn(token, amount, amount);
            return;
        }

        // Only the swap path (not the CORE-direct fast path above) actually needs a router —
        // used for the WETN -> CORE leg regardless of whether the first hop is V2 or V3.
        require(swapRouter != address(0), "Swap router not configured");
        address weth = IUniswapV2Router02Lite(swapRouter).WETH();
        address v3Pool = v3PoolForToken[token];

        uint256 balanceBefore = IERC20(coreToken).balanceOf(address(this));

        if (v3Pool != address(0)) {
            uint256 wethReceived = _swapExactInputV3(v3Pool, token, amount);

            address[] memory wethToCorePath = new address[](2);
            wethToCorePath[0] = weth;
            wethToCorePath[1] = coreToken;

            IERC20(weth).approve(swapRouter, wethReceived);
            IUniswapV2Router02Lite(swapRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(
                wethReceived,
                minCoreOut,
                wethToCorePath,
                address(this),
                deadline
            );
        } else {
            address[] memory path = new address[](3);
            path[0] = token;
            path[1] = weth;
            path[2] = coreToken;

            IERC20(token).approve(swapRouter, amount);
            IUniswapV2Router02Lite(swapRouter).swapExactTokensForTokensSupportingFeeOnTransferTokens(
                amount,
                minCoreOut,
                path,
                address(this),
                deadline
            );
        }

        uint256 received = IERC20(coreToken).balanceOf(address(this)) - balanceBefore;
        require(received > 0, "Swap failed");

        IBurnableERC20(coreToken).burn(received);
        totalCoreBurned += received;

        emit BuybackAndBurn(token, amount, received);
    }

    /// @dev Split out of buyBackAndBurnToken. Executes a real, immediate exact-input V3 swap of
    /// `amountIn` of `tokenIn` for `pool`'s other token, straight against the pool (no router
    /// involved on this leg at all) — the standard Uniswap V3 direct-pool integration pattern:
    /// the pool sends the output token to this contract BEFORE calling back into
    /// electroSwapV3SwapCallback below, which must push-pay whatever input amount the pool says
    /// it's still owed before swap() returns. No price limit is applied (the standard "accept any
    /// resulting price" sentinel) since the overall trade's real protection is minCoreOut, checked
    /// by the caller once the whole token -> WETN -> CORE journey completes, not this one leg in
    /// isolation.
    function _swapExactInputV3(address pool, address tokenIn, uint256 amountIn) internal returns (uint256 amountOut) {
        require(amountIn <= uint256(type(int256).max), "Amount too large for V3 swap");

        bool tokenInIsToken0 = IElectroSwapV3PoolLite(pool).token0() == tokenIn;
        uint160 sqrtPriceLimitX96 = tokenInIsToken0
            ? V3PriceMath.MIN_SQRT_RATIO_PLUS_ONE
            : V3PriceMath.MAX_SQRT_RATIO_MINUS_ONE;

        (int256 amount0, int256 amount1) = IElectroSwapV3PoolLite(pool).swap(
            address(this),
            tokenInIsToken0,
            int256(amountIn),
            sqrtPriceLimitX96,
            abi.encode(tokenIn)
        );

        amountOut = uint256(-(tokenInIsToken0 ? amount1 : amount0));
    }

    /// @notice ElectroSwap V3 pool swap callback (IElectroSwapV3SwapCallback) — called by the pool
    /// mid-swap() to collect whatever input token amount it's still owed. `msg.sender` is checked
    /// against v3PoolForToken[tokenIn] (decoded from `data`, which this contract encoded itself in
    /// _swapExactInputV3 above — never caller-supplied), the exact owner-configured, trusted pool
    /// address for that token: only the real pool this contract itself just called swap() on can
    /// ever satisfy that check, so there's no PoolAddress/factory computation needed to rule out a
    /// malicious contract spoofing this callback. Deliberately NOT nonReentrant — this fires
    /// synchronously inside a call already made from within a nonReentrant-guarded function
    /// (_swapExactInputV3's own caller), never as a fresh external entry into this contract.
    function electroSwapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        address tokenIn = abi.decode(data, (address));
        require(msg.sender == v3PoolForToken[tokenIn], "Unauthorized callback");

        // Exactly one of these is positive (what this contract owes the pool for the input side
        // of an exact-input swap); the other is negative (already sent to this contract as the
        // swap's output, nothing to do with it here).
        uint256 amountOwed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        require(amountOwed > 0, "Nothing owed");
        require(IERC20(tokenIn).transfer(msg.sender, amountOwed), "V3 swap payment failed");
    }

    /// @notice Pulls `amount` of `token`'s reserved erc20BurnPool balance out to `to` (almost
    /// always the owner's own wallet), for swapping to CORE by hand outside this contract — see
    /// this contract's own header comment for exactly why this exists (a whitelisted token whose
    /// real liquidity buyBackAndBurnToken's plain UniswapV2-style path can't reach at all).
    /// Deliberately its own function rather than an exception carved into rescueTokens: this is a
    /// genuine, deliberate withdrawal FROM the reserved pool (decrementing erc20BurnPool[token]
    /// itself, with its own event), not a "recover a stray transfer, but never touch reserved
    /// funds" safety valve — keeping the two conceptually and functionally separate means
    /// rescueTokens' own protection stays exactly as strict as it already was.
    function withdrawErc20BurnPoolForManualSwap(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        require(to != address(0), "Zero address");
        require(amount > 0 && amount <= erc20BurnPool[token], "Amount exceeds reserved pool");
        erc20BurnPool[token] -= amount;
        require(IERC20(token).transfer(to, amount), "Withdrawal transfer failed");
        emit Erc20BurnPoolWithdrawnForManualSwap(token, amount, to);
    }

    /// @notice Closes the loop on withdrawErc20BurnPoolForManualSwap: owner sends the CORE they
    /// received from swapping a withdrawn token's balance by hand back into this contract, which
    /// burns it and credits totalCoreBurned exactly as buyBackAndBurnToken's own swap-path would
    /// have — so the site's "Total CORE Burned" figure still reflects it, even though the swap leg
    /// itself happened off-chain. `originalToken` is purely for the emitted event's own
    /// bookkeeping/auditability (which withdrawal this deposit corresponds to); it doesn't have to
    /// be a currently-whitelisted token and nothing here reads erc20BurnPool for it — the CORE
    /// amount actually burned is the only thing this function verifies. Requires the caller to
    /// have already called IERC20(coreToken).approve(address(this), coreAmount).
    function depositAndBurnCore(address originalToken, uint256 coreAmount) external onlyOwner nonReentrant {
        require(coreToken != address(0), "CORE token not configured");
        require(coreAmount > 0, "Amount required");
        require(IERC20(coreToken).transferFrom(msg.sender, address(this), coreAmount), "CORE transfer failed");

        IBurnableERC20(coreToken).burn(coreAmount);
        totalCoreBurned += coreAmount;

        emit BuybackAndBurn(originalToken, coreAmount, coreAmount);
    }

    // ========================================================
    // Admin
    // ========================================================

    function setBrokerageBps(uint256 _brokerageBps) external onlyOwner {
        require(_brokerageBps <= MAX_BROKERAGE_BPS, "Brokerage too high");
        brokerageBps = _brokerageBps;
        emit BrokerageBpsUpdated(_brokerageBps);
    }

    function setMinBrokerageFeePerYear(uint256 _minBrokerageFeePerYear) external onlyOwner {
        minBrokerageFeePerYear = _minBrokerageFeePerYear;
        emit MinBrokerageFeePerYearUpdated(_minBrokerageFeePerYear);
    }

    function setProjectWallet(address payable _projectWallet) external onlyOwner {
        require(_projectWallet != address(0), "Zero address");
        projectWallet = _projectWallet;
        emit ProjectWalletUpdated(_projectWallet);
    }

    function setDefaultResolver(address _resolver) external onlyOwner {
        defaultResolver = _resolver;
        emit DefaultResolverUpdated(_resolver);
    }

    function setCoreToken(address _coreToken) external onlyOwner {
        coreToken = _coreToken;
        emit CoreTokenUpdated(_coreToken);
    }

    function setSwapRouter(address _swapRouter) external onlyOwner {
        swapRouter = _swapRouter;
        emit SwapRouterUpdated(_swapRouter);
    }

    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        emit PausedUpdated(_paused);
    }

    /// @notice Adds or removes an ERC20 from the set domain owners may price/sell subnames in
    /// (setSubnamePricePerYear/registerSubname) and pay activation fees in
    /// (activateDomainWithToken). Not a fixed list anywhere else in this contract — every check
    /// reads this mapping live, so revoking a token immediately stops new listings/sales in it
    /// without needing to touch anything already sold (existing erc20BurnPool[token] balances and
    /// past sales are unaffected either way).
    function setPaymentTokenWhitelisted(address token, bool allowed) external onlyOwner {
        require(token != address(0), "ETN is implicitly whitelisted");
        whitelistedPaymentTokens[token] = allowed;
        emit PaymentTokenWhitelisted(token, allowed);
    }

    /// @notice Sets the per-year price floor for `token` (address(0) = ETN). A domain owner's
    /// setSubnamePricePerYear call for that token must clear this floor (or be exactly 0, meaning
    /// "not for sale") — same non-hardcoded, owner-adjustable-as-values-move design as
    /// minBrokerageFeePerYear, just one floor per token instead of a single global value.
    function setMinSubnamePricePerYear(address token, uint256 minPricePerYear) external onlyOwner {
        minSubnamePricePerYear[token] = minPricePerYear;
        emit MinSubnamePricePerYearUpdated(token, minPricePerYear);
    }

    /// @notice Points `token` at its ElectroSwap V3 pool (paired against WETN) for
    /// activateDomainWithToken's quoting and buyBackAndBurnToken's first swap leg — pass
    /// address(0) to reset `token` back to the default V2 swapRouter path. Does NOT itself verify
    /// `pool` is a real, correctly-paired ElectroSwap V3 pool for `token`/WETN — the owner is
    /// trusted to pass the right address, same trust level every other admin setter here already
    /// has (setCoreToken/setSwapRouter/setPaymentTokenWhitelisted all work the same way); a wrong
    /// address here would simply make quotes/swaps for that token revert or behave nonsensically,
    /// not create any exposure beyond that token's own already-whitelisted functionality.
    function setV3PoolForToken(address token, address pool) external onlyOwner {
        v3PoolForToken[token] = pool;
        emit V3PoolForTokenUpdated(token, pool);
    }

    /// @notice Exempts (or un-exempts) `node` from the activation fee entirely — see this
    /// contract's own header comment for why this exists. Does NOT skip activateDomain/
    /// activateDomainWithToken's ownership verification or wrapping logic, only the fee; a
    /// goldlisted node still needs its real owner to call one of those functions (or be seeded
    /// pre-activated via the constructor instead, if the deployer prefers to skip that call too).
    function setGoldlisted(bytes32 node, bool status) external onlyOwner {
        goldlisted[node] = status;
        emit GoldlistUpdated(node, status);
    }

    /// @notice Rescues ERC20 tokens accidentally sent to this contract. This is capped to
    /// whatever's ABOVE the amount reserved in erc20BurnPool for the given token, so the owner
    /// can still recover a stray/mistaken transfer without being able to sweep real burn-pool
    /// funds under the same function — see withdrawErc20BurnPoolForManualSwap above for the
    /// deliberate, separate way to actually withdraw FROM the reserved pool itself.
    function rescueTokens(address token, uint256 amount, address to) external onlyOwner {
        require(to != address(0), "Zero address");
        uint256 balance = IERC20(token).balanceOf(address(this));
        uint256 reserved = erc20BurnPool[token];
        require(balance >= reserved, "Balance below reserved burn pool");
        require(amount <= balance - reserved, "Would touch burn pool funds");
        require(IERC20(token).transfer(to, amount), "Rescue transfer failed");
        emit TokensRescued(token, amount, to);
    }
}
