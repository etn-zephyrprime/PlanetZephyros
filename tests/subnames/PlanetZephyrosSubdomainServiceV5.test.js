// V5-specific coverage only: everything V4 already covers (whitelisting, per-token price floors,
// multi-currency subname pricing/registration, the plain V2-path ERC20 activation/buyback, and
// activation migration semantics) is unchanged logic here and stays covered by
// PlanetZephyrosSubdomainServiceV4.test.js (and, transitively, V3's own suite) — not duplicated.
// What's actually new and tested here: setV3PoolForToken admin control, activateDomainWithToken's
// V3 spot-price quote path, buyBackAndBurnToken's real V3 pool swap + electroSwapV3SwapCallback,
// and withdrawErc20BurnPoolForManualSwap/depositAndBurnCore. "legacy" in this file's fixture is a
// real V4 instance (this deployment's actual immediately-prior contract), not V3.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_YEAR = 365 * 24 * 60 * 60;
const PRICE_PER_SECOND = ethers.parseEther("0.000001");
// Same ROOT_NODE as PlanetZephyrosSubdomainServiceV4.test.js — must stay identical, see that
// file's own comment on MockNameWrapper.ROOT_NODE.
const ROOT_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";

function parentNodeFor(label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([ROOT_NODE, labelHash]));
}

function subNodeFor(parentNode, label) {
  const labelHash = ethers.keccak256(ethers.toUtf8Bytes(label));
  return ethers.keccak256(ethers.concat([parentNode, labelHash]));
}

describe("PlanetZephyrosSubdomainServiceV5", function () {
  async function deployFixture() {
    const [deployer, projectWallet, alice, bob, carol] = await ethers.getSigners();

    const MockBaseRegistrar = await ethers.getContractFactory("MockBaseRegistrar");
    const base = await MockBaseRegistrar.deploy();

    const MockController = await ethers.getContractFactory("MockETHRegistrarController");
    const controller = await MockController.deploy(await base.getAddress(), PRICE_PER_SECOND);
    await base.setController(await controller.getAddress());

    const MockNameWrapper = await ethers.getContractFactory("MockNameWrapper");
    const wrapper = await MockNameWrapper.deploy(await base.getAddress());

    const MockCoreToken = await ethers.getContractFactory("MockCoreToken");
    const core = await MockCoreToken.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const otherToken = await MockERC20.deploy("Other Token", "OTHR"); // a whitelisted token that ISN'T CORE, reachable via the plain V2 path

    // A REAL deployed WETN token (not just a random address like V4's test fixture used) —
    // needed here because buyBackAndBurnToken's new V3 leg (see "V3 pool integration" below)
    // genuinely moves real WETN balances (MockV3Pool pays it out, the marketplace approves/feeds
    // it into router's WETN -> CORE leg), unlike the plain-V2 path's own mock, which never
    // actually holds an intermediate WETH balance at all (see MockRouter's own header comment).
    const weth = await MockERC20.deploy("Wrapped ETN", "WETN");

    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await core.getAddress(), await weth.getAddress(), 1000n);

    // A second whitelisted token, standing in for one of V5's real-world V3-only tokens (USDC/
    // USDT/CLUB/DCNT) — paired with `weth` in a MockV3Pool instead of MockRouter's own V2 path.
    const v3Token = await MockERC20.deploy("V3 Pool Token", "V3TOK");

    const defaultResolver = ethers.Wallet.createRandom().address;

    // A real V4 instance, standing in for "legacyMarketplace" — deployed and used exactly like
    // the live one migrateActivation reads from, not a bespoke mock, so migration tests exercise
    // its actual domainActivated semantics rather than an approximation of them. V4's own
    // legacyMarketplace (V3) is irrelevant here (address(0) — no V3-chain migration needed for
    // these tests), and it gets no initial pricing/goldlist seeding either.
    const LegacyMarketplace = await ethers.getContractFactory("PlanetZephyrosSubdomainServiceV4");
    const legacy = await LegacyMarketplace.deploy(
      await controller.getAddress(),
      await wrapper.getAddress(),
      await base.getAddress(),
      defaultResolver,
      projectWallet.address,
      deployer.address,
      ethers.ZeroAddress,
      [],
      []
    );

    const Marketplace = await ethers.getContractFactory("PlanetZephyrosSubdomainServiceV5");
    const marketplace = await Marketplace.deploy(
      await controller.getAddress(),
      await wrapper.getAddress(),
      await base.getAddress(),
      defaultResolver,
      projectWallet.address,
      deployer.address,
      await legacy.getAddress(),
      [], // initialPricing — empty by default; the "constructor initial pricing" describe block below deploys its own instance with real entries
      [] // initialGoldlist — same, see the "goldlisted" describe block
    );

    // Same neutralization as V3/V4's own fixtures, same reasoning (tiny PRICE_PER_SECOND makes
    // bps-based fees far smaller than any realistic floor) — this file isn't re-testing the floor
    // itself, V3/V4's own suites already do.
    await marketplace.connect(deployer).setMinBrokerageFeePerYear(0);
    await legacy.connect(deployer).setMinBrokerageFeePerYear(0);

    return {
      deployer,
      projectWallet,
      alice,
      bob,
      carol,
      base,
      controller,
      wrapper,
      core,
      otherToken,
      weth,
      v3Token,
      router,
      legacy,
      marketplace,
      defaultResolver,
    };
  }

  async function commitAndWait(ctx, signer, label, secret, referrer, duration = ONE_YEAR, target) {
    const marketplace = target || ctx.marketplace;
    const commitment = await marketplace.computeCommitment(label, duration, secret, referrer);
    await ctx.controller.connect(signer).commit(commitment);
    await time.increase(61);
  }

  /// Registers "alice" as an activated parent domain on `ctx.marketplace` (defaults to V4).
  async function registerName(ctx, signer, label, duration = ONE_YEAR, target) {
    const marketplace = target || ctx.marketplace;
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const referrer = ethers.ZeroHash;
    await commitAndWait(ctx, signer, label, secret, referrer, duration, marketplace);
    const [, , totalPrice] = await marketplace.quoteRegistration(label, duration);
    await marketplace
      .connect(signer)
      .registerName(label, duration, secret, referrer, signer.address, 0, parentNodeFor(label), { value: totalPrice });
  }

  async function withRegisteredParent(label = "alice", duration = 5 * ONE_YEAR) {
    const ctx = await loadFixture(deployFixture);
    await registerName(ctx, ctx.alice, label, duration);
    return ctx;
  }

  // Registers a name directly with the registrar (bypassing the marketplace brokerage) and
  // approves BaseRegistrar, mirroring V3's own "genuinely never wrapped" activation setup — the
  // case activateDomain/activateDomainWithToken exist to handle. File-scope (not just the
  // activateDomainWithToken describe block below) since the goldlist tests need the exact same
  // unactivated-domain setup for the plain ETN activateDomain path.
  async function withUnactivatedDirectRegistration(ctx, signer, label) {
    const { controller, base, marketplace } = ctx;
    const secret = ethers.hexlify(ethers.randomBytes(32));
    const referrer = ethers.ZeroHash;
    const registration = {
      label,
      owner: signer.address,
      duration: ONE_YEAR,
      secret,
      resolver: ethers.ZeroAddress,
      data: [],
      reverseRecord: 0,
      referrer,
    };
    const commitment = await controller.makeCommitment(registration);
    await controller.connect(signer).commit(commitment);
    await time.increase(61);
    const price = await controller.rentPrice(label, ONE_YEAR);
    await controller.connect(signer).register(registration, { value: price.base + price.premium });
    await base.connect(signer).setApprovalForAll(await marketplace.getAddress(), true);
  }

  // ========================================================
  // Whitelisting + per-token minimum price
  // ========================================================
  describe("payment token whitelist", function () {
    it("ETN's own minimum defaults to 1000 on deploy, owner-adjustable", async function () {
      const { marketplace } = await loadFixture(deployFixture);
      expect(await marketplace.minSubnamePricePerYear(ethers.ZeroAddress)).to.equal(ethers.parseEther("1000"));
    });

    it("only owner can whitelist/de-whitelist a token, and address(0) is rejected (ETN is implicit)", async function () {
      const { marketplace, deployer, alice, otherToken } = await loadFixture(deployFixture);
      await expect(
        marketplace.connect(alice).setPaymentTokenWhitelisted(await otherToken.getAddress(), true)
      ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");

      await expect(marketplace.connect(deployer).setPaymentTokenWhitelisted(ethers.ZeroAddress, true)).to.be.revertedWith(
        "ETN is implicitly whitelisted"
      );

      await expect(marketplace.connect(deployer).setPaymentTokenWhitelisted(await otherToken.getAddress(), true))
        .to.emit(marketplace, "PaymentTokenWhitelisted")
        .withArgs(await otherToken.getAddress(), true);
      expect(await marketplace.whitelistedPaymentTokens(await otherToken.getAddress())).to.equal(true);
    });

    it("only owner can set a token's minimum price", async function () {
      const { marketplace, alice, deployer, otherToken } = await loadFixture(deployFixture);
      await expect(
        marketplace.connect(alice).setMinSubnamePricePerYear(await otherToken.getAddress(), 1n)
      ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");

      await expect(marketplace.connect(deployer).setMinSubnamePricePerYear(await otherToken.getAddress(), 500n))
        .to.emit(marketplace, "MinSubnamePricePerYearUpdated")
        .withArgs(await otherToken.getAddress(), 500n);
    });

    it("setSubnamePricePerYear rejects a non-whitelisted token", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, alice, otherToken } = ctx;
      const parentNode = parentNodeFor("alice");
      await expect(
        marketplace.connect(alice).setSubnamePricePerYear(parentNode, await otherToken.getAddress(), ethers.parseEther("1"))
      ).to.be.revertedWith("Token not whitelisted");
    });

    it("setSubnamePricePerYear rejects a price below that token's minimum", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, alice, otherToken } = ctx;
      const parentNode = parentNodeFor("alice");
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(await otherToken.getAddress(), true);
      await marketplace.connect(deployer).setMinSubnamePricePerYear(await otherToken.getAddress(), ethers.parseEther("500"));

      await expect(
        marketplace.connect(alice).setSubnamePricePerYear(parentNode, await otherToken.getAddress(), ethers.parseEther("499"))
      ).to.be.revertedWith("Below minimum price");

      // Exactly at the floor is fine.
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, await otherToken.getAddress(), ethers.parseEther("500"));
      // Clearing (0) is always allowed regardless of the floor.
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, await otherToken.getAddress(), 0n);
    });

    it("de-whitelisting a token stops new sales in it without touching an existing erc20BurnPool balance", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, alice, bob, wrapper, otherToken } = ctx;
      const parentNode = parentNodeFor("alice");
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      const price = ethers.parseEther("500");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);

      await otherToken.mint(bob.address, price);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), price);
      await marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr);
      const poolBefore = await marketplace.erc20BurnPool(tokenAddr);
      expect(poolBefore).to.be.gt(0);

      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, false);
      await otherToken.mint(bob.address, price);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), price);
      await expect(
        marketplace.connect(bob).registerSubname(parentNode, "shop2", ONE_YEAR, tokenAddr)
      ).to.be.revertedWith("Token not whitelisted");

      expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(poolBefore); // untouched
    });
  });

  // ========================================================
  // Multi-currency subname pricing + self-serve registration
  // ========================================================
  describe("multi-currency subname registration", function () {
    async function withWhitelistedToken(ctx) {
      const tokenAddr = await ctx.otherToken.getAddress();
      await ctx.marketplace.connect(ctx.deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      return tokenAddr;
    }

    it("a domain can have an ETN price and an ERC20 price set at once, independently", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, alice } = ctx;
      const parentNode = parentNodeFor("alice");
      const tokenAddr = await withWhitelistedToken(ctx);

      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, ethers.ZeroAddress, ethers.parseEther("1000"));
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, ethers.parseEther("500"));

      expect(await marketplace.quoteSubname(parentNode, ethers.ZeroAddress, ONE_YEAR)).to.equal(ethers.parseEther("1000"));
      expect(await marketplace.quoteSubname(parentNode, tokenAddr, ONE_YEAR)).to.equal(ethers.parseEther("500"));

      // Clearing one leaves the other untouched.
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, 0n);
      expect(await marketplace.quoteSubname(parentNode, ethers.ZeroAddress, ONE_YEAR)).to.equal(ethers.parseEther("1000"));
      expect(await marketplace.quoteSubname(parentNode, tokenAddr, ONE_YEAR)).to.equal(0n);
    });

    it("registers a subname paid in a whitelisted ERC20, splitting 80/20 into erc20BurnPool", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, wrapper, alice, bob, otherToken } = ctx;
      const parentNode = parentNodeFor("alice");
      const tokenAddr = await withWhitelistedToken(ctx);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);

      const pricePerYear = ethers.parseEther("500");
      const sellerAmount = (pricePerYear * 8000n) / 10000n;
      const burnAmount = pricePerYear - sellerAmount;
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, pricePerYear);

      await otherToken.mint(bob.address, pricePerYear);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), pricePerYear);

      const subNode = subNodeFor(parentNode, "shop");
      await expect(marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr))
        .to.emit(marketplace, "SubnameRegistered")
        .withArgs(parentNode, "shop", bob.address, tokenAddr, pricePerYear, sellerAmount, burnAmount);

      expect(await otherToken.balanceOf(alice.address)).to.equal(sellerAmount);
      expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(burnAmount);
      expect(await otherToken.balanceOf(await marketplace.getAddress())).to.equal(burnAmount);
      expect(await wrapper.ownerOf(BigInt(subNode))).to.equal(bob.address);
      // ETN's own burnPool is untouched by an ERC20-denominated sale.
      expect(await marketplace.burnPool()).to.equal(0n);
    });

    it("registerSubname with an ERC20 token rejects any ETN sent alongside it", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, wrapper, alice, bob, otherToken } = ctx;
      const parentNode = parentNodeFor("alice");
      const tokenAddr = await withWhitelistedToken(ctx);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      const price = ethers.parseEther("500");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);
      await otherToken.mint(bob.address, price);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), price);

      await expect(
        marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr, { value: 1 })
      ).to.be.revertedWith("Unexpected ETN sent");
    });

    it("registerSubname reverts without an ERC20 approval", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, wrapper, alice, bob, otherToken } = ctx;
      const parentNode = parentNodeFor("alice");
      const tokenAddr = await withWhitelistedToken(ctx);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      const price = ethers.parseEther("500");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);
      await otherToken.mint(bob.address, price); // minted, but never approved

      await expect(marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr)).to.be.reverted;
    });

    it("registerSubname reverts if the requested currency isn't for sale, even if another currency is", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, wrapper, alice, bob } = ctx;
      const parentNode = parentNodeFor("alice");
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, ethers.ZeroAddress, ethers.parseEther("1000"));
      const tokenAddr = await withWhitelistedToken(ctx);

      await expect(
        marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr)
      ).to.be.revertedWith("Subnames not for sale in this token");
    });
  });

  // ========================================================
  // ERC20-denominated domain activation
  // ========================================================
  describe("activateDomainWithToken", function () {
    it("rejects a non-whitelisted token", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, carol, otherToken } = ctx;
      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");
      const deadline = (await time.latest()) + 300;
      await expect(
        marketplace.connect(carol).activateDomainWithToken(node, "carol", await otherToken.getAddress(), ethers.MaxUint256, deadline)
      ).to.be.revertedWith("Token not whitelisted");
    });

    it("converts the ETN activation fee via the router's live quote and pays projectWallet in the chosen token", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol, otherToken, router, projectWallet } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());

      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");

      // transferFrom needs a real allowance even for a staticCall (it fully executes the function
      // body against current state, just discards the result) — mint/approve before quoting, not after.
      const price = ethers.parseEther("1000000"); // plenty of headroom, exact amount asserted below
      await otherToken.mint(carol.address, price);
      await otherToken.connect(carol).approve(await marketplace.getAddress(), price);

      // Static-call first purely as a sanity check that a quote is obtainable pre-flight (the
      // frontend would use this same pattern to show an estimate before the real tx) — NOT
      // compared for exact equality against the real call below: _activationFee scales with
      // `remaining` (expiry - block.timestamp), so a staticCall and a later real tx in a
      // different block will legitimately quote a slightly different amount as time passes
      // between them. The real tx's own emitted event is the authoritative figure to check.
      const quotedTokenAmount = await marketplace.connect(carol).activateDomainWithToken.staticCall(
        node, "carol", tokenAddr, ethers.MaxUint256, (await time.latest()) + 300
      );
      expect(quotedTokenAmount).to.be.gt(0);

      const deadline = (await time.latest()) + 300;
      const tx = await marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, price, deadline);
      const receipt = await tx.wait();
      const event = receipt.logs.map((l) => { try { return marketplace.interface.parseLog(l); } catch { return null; } }).find((e) => e && e.name === "DomainActivatedWithToken");
      expect(event).to.not.equal(undefined);
      const actualTokenAmountPaid = event.args.tokenAmountPaid;
      expect(actualTokenAmountPaid).to.be.gt(0);

      expect(await marketplace.domainActivated(node)).to.equal(true);
      const projectBalance = await otherToken.balanceOf(projectWallet.address);
      expect(projectBalance).to.equal(actualTokenAmountPaid);
    });

    it("reverts when the live quote exceeds the caller's maxTokenAmount", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol, otherToken, router } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());
      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");

      const deadline = (await time.latest()) + 300;
      await expect(
        marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, 1n, deadline)
      ).to.be.revertedWith("Quote exceeds max token amount");
      expect(await marketplace.domainActivated(node)).to.equal(false);
    });

    it("reverts on an already-expired deadline", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol, otherToken, router } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());
      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");

      await expect(
        marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, ethers.MaxUint256, 1)
      ).to.be.revertedWith("Quote expired");
    });

    it("reverts if already activated", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol, otherToken, router } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());
      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");
      await otherToken.mint(carol.address, ethers.parseEther("1000000"));
      await otherToken.connect(carol).approve(await marketplace.getAddress(), ethers.MaxUint256);
      const deadline = (await time.latest()) + 300;
      await marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, ethers.MaxUint256, deadline);

      await expect(
        marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, ethers.MaxUint256, deadline)
      ).to.be.revertedWith("Already activated");
    });
  });

  // ========================================================
  // ERC20 buyback and burn
  // ========================================================
  describe("buyBackAndBurnToken", function () {
    async function withErc20BurnPool(ctx) {
      const { marketplace, deployer, wrapper, alice, bob, otherToken } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      const price = ethers.parseEther("500");
      const parentNode = parentNodeFor("alice");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);
      await otherToken.mint(bob.address, price);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), price);
      await marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr);
      return tokenAddr;
    }

    it("reverts if there is nothing to burn for that token", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, core, router, otherToken } = ctx;
      await marketplace.connect(deployer).setCoreToken(await core.getAddress());
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());
      const deadline = (await time.latest()) + 300;
      await expect(
        marketplace.connect(deployer).buyBackAndBurnToken(await otherToken.getAddress(), 0, deadline)
      ).to.be.revertedWith("Nothing to burn");
    });

    it("swaps token -> WETN -> CORE and burns it, only owner may call", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, alice, core, router } = ctx;
      const tokenAddr = await withErc20BurnPool(ctx);
      await marketplace.connect(deployer).setCoreToken(await core.getAddress());
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());

      await expect(
        marketplace.connect(alice).buyBackAndBurnToken(tokenAddr, 0, (await time.latest()) + 300)
      ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");

      const pool = await marketplace.erc20BurnPool(tokenAddr);
      const rate = await router.rate();
      const deadline = (await time.latest()) + 300;

      await expect(marketplace.connect(deployer).buyBackAndBurnToken(tokenAddr, 0, deadline))
        .to.emit(marketplace, "BuybackAndBurn")
        .withArgs(tokenAddr, pool, pool * rate);

      expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(0);
      expect(await marketplace.totalCoreBurned()).to.equal(pool * rate);
      expect(await core.totalSupply()).to.equal(0); // minted then burned within the same tx
    });

    it("takes the CORE-direct fast path (no swap) when the whitelisted token IS coreToken", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, alice, wrapper, core } = ctx;
      const coreAddr = await core.getAddress();
      await marketplace.connect(deployer).setCoreToken(coreAddr);
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(coreAddr, true);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);

      const parentNode = parentNodeFor("alice");
      const price = ethers.parseEther("500");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, coreAddr, price);
      await core.mint(ctx.bob.address, price);
      await core.connect(ctx.bob).approve(await marketplace.getAddress(), price);
      await marketplace.connect(ctx.bob).registerSubname(parentNode, "shop", ONE_YEAR, coreAddr);

      const pool = await marketplace.erc20BurnPool(coreAddr);
      expect(pool).to.be.gt(0);
      const supplyBefore = await core.totalSupply();

      // No swapRouter configured at all — proves this path never calls it.
      await expect(marketplace.connect(deployer).buyBackAndBurnToken(coreAddr, 0, (await time.latest()) + 300))
        .to.emit(marketplace, "BuybackAndBurn")
        .withArgs(coreAddr, pool, pool);

      expect(await marketplace.erc20BurnPool(coreAddr)).to.equal(0);
      expect(await marketplace.totalCoreBurned()).to.equal(pool);
      expect(await core.totalSupply()).to.equal(supplyBefore - pool);
    });

    it("reverts on slippage when minCoreOut cannot be met, leaving the pool untouched", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, core, router } = ctx;
      const tokenAddr = await withErc20BurnPool(ctx);
      await marketplace.connect(deployer).setCoreToken(await core.getAddress());
      await marketplace.connect(deployer).setSwapRouter(await router.getAddress());

      const pool = await marketplace.erc20BurnPool(tokenAddr);
      const rate = await router.rate();
      await expect(
        marketplace.connect(deployer).buyBackAndBurnToken(tokenAddr, pool * rate + 1n, (await time.latest()) + 300)
      ).to.be.revertedWith("Insufficient output amount");
      expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(pool);
    });
  });

  // ========================================================
  // Migration from a legacy (V4) deployment
  // ========================================================
  describe("migrateActivation", function () {
    it("carries over an activation from the legacy marketplace for free", async function () {
      const ctx = await loadFixture(deployFixture);
      const { legacy, marketplace, alice } = ctx;
      await registerName(ctx, alice, "alice", ONE_YEAR, legacy);
      const node = parentNodeFor("alice");

      expect(await legacy.domainActivated(node)).to.equal(true);
      expect(await marketplace.domainActivated(node)).to.equal(false);

      await expect(marketplace.migrateActivation(node)).to.emit(marketplace, "ActivationMigrated").withArgs(node);
      expect(await marketplace.domainActivated(node)).to.equal(true);
    });

    it("is permissionless — anyone can call it, not just the domain owner", async function () {
      const ctx = await loadFixture(deployFixture);
      const { legacy, marketplace, alice, bob } = ctx;
      await registerName(ctx, alice, "alice", ONE_YEAR, legacy);
      const node = parentNodeFor("alice");
      await marketplace.connect(bob).migrateActivation(node);
      expect(await marketplace.domainActivated(node)).to.equal(true);
    });

    it("reverts if the node was never activated on the legacy marketplace", async function () {
      const { marketplace } = await loadFixture(deployFixture);
      const node = parentNodeFor("never-activated");
      await expect(marketplace.migrateActivation(node)).to.be.revertedWith("Not activated on legacy marketplace");
    });

    it("reverts if already activated on this (V5) contract", async function () {
      const ctx = await withRegisteredParent(); // activates "alice" directly on V5
      const { marketplace } = ctx;
      const node = parentNodeFor("alice");
      await expect(marketplace.migrateActivation(node)).to.be.revertedWith("Already activated on this contract");
    });

    it("does NOT carry over subname prices — each owner must re-set their own on V5", async function () {
      const ctx = await loadFixture(deployFixture);
      const { legacy, marketplace, alice } = ctx;
      await registerName(ctx, alice, "alice", ONE_YEAR, legacy);
      const node = parentNodeFor("alice");
      await legacy.connect(alice).setSubnamePricePerYear(node, ethers.ZeroAddress, ethers.parseEther("1000"));

      await marketplace.migrateActivation(node);
      expect(await marketplace.subnamePricePerYear(node, ethers.ZeroAddress)).to.equal(0n); // not carried over
    });
  });

  // ========================================================
  // rescueTokens burn-pool protection
  // ========================================================
  describe("rescueTokens", function () {
    it("allows rescuing a balance above the reserved erc20BurnPool amount", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, carol, otherToken } = ctx; // carol: uninvolved in the sale, no pre-existing balance to confound the assertion
      const tokenAddr = await withRegisteredParentPoolHelper(ctx);
      const pool = await marketplace.erc20BurnPool(tokenAddr);
      // Send an extra, genuinely-stray amount on top of the real burn pool balance.
      await otherToken.mint(await marketplace.getAddress(), ethers.parseEther("1"));

      await marketplace.connect(deployer).rescueTokens(tokenAddr, ethers.parseEther("1"), carol.address);
      expect(await otherToken.balanceOf(carol.address)).to.equal(ethers.parseEther("1"));
      expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(pool); // untouched
    });

    it("reverts an attempt to rescue more than the balance above the reserved burn pool", async function () {
      const ctx = await withRegisteredParent();
      const { marketplace, deployer, alice } = ctx;
      const tokenAddr = await withRegisteredParentPoolHelper(ctx);
      const pool = await marketplace.erc20BurnPool(tokenAddr);
      expect(pool).to.be.gt(0);

      await expect(
        marketplace.connect(deployer).rescueTokens(tokenAddr, pool, alice.address)
      ).to.be.revertedWith("Would touch burn pool funds");
    });

    async function withRegisteredParentPoolHelper(ctx) {
      const { marketplace, deployer, wrapper, alice, bob, otherToken } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      const price = ethers.parseEther("500");
      const parentNode = parentNodeFor("alice");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);
      await otherToken.mint(bob.address, price);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), price);
      await marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr);
      return tokenAddr;
    }
  });

  // ========================================================
  // Constructor-seeded initial subname pricing
  // ========================================================
  describe("constructor initial pricing", function () {
    // Deploys its own instance (deployFixture's own marketplace always passes empty arrays) with
    // real InitialSubnamePrice entries, mirroring the real deploy-time use case: seeding prices
    // for domains the deployer already owns, without a separate activateDomain +
    // setSubnamePricePerYear call per domain.
    async function deployWithInitialPricing(initialPricing) {
      const base = await loadFixture(deployFixture);
      const { controller, wrapper, base: baseRegistrar, defaultResolver, projectWallet, deployer, legacy } = base;

      const Marketplace = await ethers.getContractFactory("PlanetZephyrosSubdomainServiceV5");
      const marketplace = await Marketplace.deploy(
        await controller.getAddress(),
        await wrapper.getAddress(),
        await baseRegistrar.getAddress(),
        defaultResolver,
        projectWallet.address,
        deployer.address,
        await legacy.getAddress(),
        initialPricing,
        []
      );
      return { ...base, marketplace };
    }

    it("seeds activation + ETN price atomically for every entry, no separate call needed", async function () {
      const node1 = parentNodeFor("zypto");
      const node2 = parentNodeFor("community");
      const price1 = ethers.parseEther("1250");
      const price2 = ethers.parseEther("2100");

      const { marketplace } = await deployWithInitialPricing([
        { node: node1, pricePerYear: price1 },
        { node: node2, pricePerYear: price2 },
      ]);

      expect(await marketplace.domainActivated(node1)).to.equal(true);
      expect(await marketplace.domainActivated(node2)).to.equal(true);
      expect(await marketplace.subnamePricePerYear(node1, ethers.ZeroAddress)).to.equal(price1);
      expect(await marketplace.subnamePricePerYear(node2, ethers.ZeroAddress)).to.equal(price2);
    });

    it("an empty array seeds nothing, same as deployFixture's own default instance", async function () {
      const { marketplace } = await deployWithInitialPricing([]);
      const node = parentNodeFor("nobody-seeded-this");
      expect(await marketplace.domainActivated(node)).to.equal(false);
      expect(await marketplace.subnamePricePerYear(node, ethers.ZeroAddress)).to.equal(0n);
    });

    it("still enforces the minimum ETN price on each seeded entry", async function () {
      const node = parentNodeFor("toocheap");
      const Marketplace = await ethers.getContractFactory("PlanetZephyrosSubdomainServiceV5");
      const base = await loadFixture(deployFixture);
      await expect(
        Marketplace.deploy(
          await base.controller.getAddress(),
          await base.wrapper.getAddress(),
          await base.base.getAddress(),
          base.defaultResolver,
          base.projectWallet.address,
          base.deployer.address,
          await base.legacy.getAddress(),
          [{ node, pricePerYear: ethers.parseEther("999") }], // below the 1000 ETN default floor
          []
        )
      ).to.be.revertedWith("Below minimum price");
    });

    it("a seeded domain's owner can immediately sell a subname under it, no activateDomain call needed", async function () {
      const node = parentNodeFor("money");
      const price = ethers.parseEther("4000");
      const ctx = await deployWithInitialPricing([{ node, pricePerYear: price }]);
      const { marketplace, wrapper, base, alice, bob, defaultResolver } = ctx;

      // "alice" never went through registerName/activateDomain on THIS marketplace instance at
      // all — the constructor is what activated it. She still needs to genuinely own the wrapped
      // name and approve the marketplace, same as any other seller (the constructor seeds
      // pricing/activation, not ownership or approval, which stay real on-chain facts) — done
      // here entirely through the raw registrar/NameWrapper contracts directly, the marketplace
      // itself never involved in getting her that ownership. wrapETH2LD called directly (not via
      // the marketplace's own _wrapDirectRegistration) needs the NameWrapper contract itself
      // approved as BaseRegistrar operator, not the marketplace.
      await withUnactivatedDirectRegistration(ctx, alice, "money");
      await base.connect(alice).setApprovalForAll(await wrapper.getAddress(), true);
      await wrapper.connect(alice).wrapETH2LD("money", alice.address, 0, defaultResolver);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);

      // Slightly under a year, not exactly ONE_YEAR — withUnactivatedDirectRegistration registers
      // the parent for exactly ONE_YEAR from a few seconds ago (commitAndWait's own 61s wait), so
      // a full-ONE_YEAR subname duration requested now would overshoot the parent's actual
      // remaining expiry by that same handful of seconds ("Duration exceeds parent expiry").
      const duration = ONE_YEAR - 3600;
      const expectedPrice = (price * BigInt(duration)) / BigInt(365 * 24 * 60 * 60); // same pro-ration as quoteSubname
      const expectedSellerAmount = (expectedPrice * 8000n) / 10000n;

      await expect(marketplace.connect(bob).registerSubname(node, "shop", duration, ethers.ZeroAddress, { value: price }))
        .to.emit(marketplace, "SubnameRegistered")
        .withArgs(node, "shop", bob.address, ethers.ZeroAddress, expectedPrice, expectedSellerAmount, expectedPrice - expectedSellerAmount);
    });
  });

  // ========================================================
  // Goldlist — activation fee exemption
  // ========================================================
  describe("goldlisted activation", function () {
    it("only owner can set/unset goldlist status", async function () {
      const { marketplace, alice, deployer } = await loadFixture(deployFixture);
      const node = parentNodeFor("planetzephyros");
      await expect(marketplace.connect(alice).setGoldlisted(node, true)).to.be.revertedWithCustomError(
        marketplace,
        "OwnableUnauthorizedAccount"
      );

      await expect(marketplace.connect(deployer).setGoldlisted(node, true))
        .to.emit(marketplace, "GoldlistUpdated")
        .withArgs(node, true);
      expect(await marketplace.goldlisted(node)).to.equal(true);
    });

    it("activateDomain charges nothing for a goldlisted node, even with a huge minBrokerageFeePerYear-driven fee", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol } = ctx;
      // Undo deployFixture's own neutralization (it zeroes minBrokerageFeePerYear) specifically
      // for this test — the whole point is proving a goldlisted node is exempt EVEN when the
      // floor would otherwise be enormous, the exact real-world case (a very-long-duration name)
      // this feature exists for.
      await marketplace.connect(deployer).setMinBrokerageFeePerYear(ethers.parseEther("25000"));
      await marketplace.connect(deployer).setGoldlisted(parentNodeFor("carol"), true);

      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");

      // Without goldlist this would need a huge payment (25,000 ETN/year x ~1 year remaining) —
      // sending 0 and still succeeding is exactly what proves the exemption works.
      await expect(marketplace.connect(carol).activateDomain(node, "carol"))
        .to.emit(marketplace, "DomainActivated")
        .withArgs(node, carol.address, 0);

      expect(await marketplace.domainActivated(node)).to.equal(true);
    });

    it("a non-goldlisted node still pays the real fee, proving the exemption is genuinely per-node", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol } = ctx;
      await marketplace.connect(deployer).setMinBrokerageFeePerYear(ethers.parseEther("25000"));
      // Deliberately NOT goldlisted.

      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");

      await expect(
        marketplace.connect(carol).activateDomain(node, "carol", { value: 0 })
      ).to.be.revertedWith("Insufficient payment");
    });

    it("activateDomainWithToken charges nothing and never touches the router for a goldlisted node", async function () {
      const ctx = await loadFixture(deployFixture);
      const { marketplace, deployer, carol, otherToken } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await marketplace.connect(deployer).setMinBrokerageFeePerYear(ethers.parseEther("25000"));
      await marketplace.connect(deployer).setGoldlisted(parentNodeFor("carol"), true);
      // Deliberately NOT setting a swap router — proves this path never calls it for a
      // goldlisted (free) activation.

      await withUnactivatedDirectRegistration(ctx, carol, "carol");
      const node = parentNodeFor("carol");
      const deadline = (await time.latest()) + 300;

      await expect(marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, 0, deadline))
        .to.emit(marketplace, "DomainActivatedWithToken")
        .withArgs(node, carol.address, tokenAddr, 0, 0);

      expect(await marketplace.domainActivated(node)).to.equal(true);
    });

    it("goldlist status alone doesn't bypass ownership verification or the expiry check", async function () {
      const { marketplace, deployer, bob } = await loadFixture(deployFixture);
      const node = parentNodeFor("nobody-owns-this-yet");
      await marketplace.connect(deployer).setGoldlisted(node, true);

      // bob never registered/owns "nobody-owns-this-yet" at all — goldlist waives the FEE, not
      // the ownership proof activateDomain still requires.
      await expect(marketplace.connect(bob).activateDomain(node, "nobody-owns-this-yet")).to.be.reverted;
    });
  });

  // ========================================================
  // V3 pool integration (new in V5) — activateDomainWithToken's spot-price quote and
  // buyBackAndBurnToken's real swap execution for a token whose liquidity lives in a V3-style
  // pool instead of the plain V2 swapRouter path. See PlanetZephyrosSubdomainServiceV5.sol's own
  // header comment for the full "why" (ElectroSwap's real Universal Router / V3 pools for
  // USDC/USDT/CLUB/DCNT).
  // ========================================================
  describe("V3 pool integration", function () {
    const SQRT_PRICE_1_1 = 2n ** 96n; // sqrtPriceX96 for a 1:1 price ratio

    async function deployV3Pool(ctx, { token0, token1, sqrtPriceX96 = SQRT_PRICE_1_1, rateToken1PerToken0X18 = ethers.parseEther("1") } = {}) {
      const MockV3Pool = await ethers.getContractFactory("MockV3Pool");
      const pool = await MockV3Pool.deploy(token0, token1, sqrtPriceX96, rateToken1PerToken0X18);
      const poolAddr = await pool.getAddress();
      // Fund the pool with both sides so it can actually pay out either direction of swap.
      await ctx.weth.mint(poolAddr, ethers.parseEther("10000000"));
      await ctx.v3Token.mint(poolAddr, ethers.parseEther("10000000"));
      return pool;
    }

    describe("setV3PoolForToken", function () {
      it("only owner can set it, defaults to address(0) (the plain V2 path), and can be reset", async function () {
        const { marketplace, deployer, alice, v3Token } = await loadFixture(deployFixture);
        const tokenAddr = await v3Token.getAddress();
        expect(await marketplace.v3PoolForToken(tokenAddr)).to.equal(ethers.ZeroAddress);

        const fakePool = ethers.Wallet.createRandom().address;
        await expect(
          marketplace.connect(alice).setV3PoolForToken(tokenAddr, fakePool)
        ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");

        await expect(marketplace.connect(deployer).setV3PoolForToken(tokenAddr, fakePool))
          .to.emit(marketplace, "V3PoolForTokenUpdated")
          .withArgs(tokenAddr, fakePool);
        expect(await marketplace.v3PoolForToken(tokenAddr)).to.equal(fakePool);

        await marketplace.connect(deployer).setV3PoolForToken(tokenAddr, ethers.ZeroAddress);
        expect(await marketplace.v3PoolForToken(tokenAddr)).to.equal(ethers.ZeroAddress);
      });
    });

    describe("activateDomainWithToken via a V3 pool", function () {
      it("quotes from the pool's own spot price (weth = token0)", async function () {
        const ctx = await loadFixture(deployFixture);
        const { marketplace, deployer, carol, v3Token, weth, projectWallet } = ctx;
        const tokenAddr = await v3Token.getAddress();
        // weth deliberately token0 here to exercise _quoteV3's wethIsToken0 === true branch.
        const pool = await deployV3Pool(ctx, { token0: await weth.getAddress(), token1: tokenAddr });

        await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
        await marketplace.connect(deployer).setSwapRouter(await ctx.router.getAddress());
        await marketplace.connect(deployer).setV3PoolForToken(tokenAddr, await pool.getAddress());

        await withUnactivatedDirectRegistration(ctx, carol, "carol");
        const node = parentNodeFor("carol");
        await v3Token.mint(carol.address, ethers.parseEther("1000000"));
        await v3Token.connect(carol).approve(await marketplace.getAddress(), ethers.parseEther("1000000"));

        const deadline = (await time.latest()) + 300;
        const tx = await marketplace
          .connect(carol)
          .activateDomainWithToken(node, "carol", tokenAddr, ethers.parseEther("1000000"), deadline);
        const receipt = await tx.wait();
        const event = receipt.logs
          .map((l) => { try { return marketplace.interface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "DomainActivatedWithToken");
        expect(event).to.not.equal(undefined);

        // sqrtPriceX96 = 2^96 -> spot price 1:1, so the quoted token amount should equal the ETN
        // fee exactly.
        expect(event.args.tokenAmountPaid).to.equal(event.args.etnEquivalentFee);
        expect(event.args.tokenAmountPaid).to.be.gt(0);
        expect(await v3Token.balanceOf(projectWallet.address)).to.equal(event.args.tokenAmountPaid);
        // Proves this path never touches the pool's swap()/callback at all — it's a pure view quote.
        expect(await v3Token.balanceOf(await pool.getAddress())).to.equal(ethers.parseEther("10000000"));
      });

      it("quotes from the pool's own spot price (weth = token1)", async function () {
        const ctx = await loadFixture(deployFixture);
        const { marketplace, deployer, carol, v3Token, weth } = ctx;
        const tokenAddr = await v3Token.getAddress();
        const pool = await deployV3Pool(ctx, { token0: tokenAddr, token1: await weth.getAddress() });

        await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
        await marketplace.connect(deployer).setSwapRouter(await ctx.router.getAddress());
        await marketplace.connect(deployer).setV3PoolForToken(tokenAddr, await pool.getAddress());

        await withUnactivatedDirectRegistration(ctx, carol, "carol");
        const node = parentNodeFor("carol");
        await v3Token.mint(carol.address, ethers.parseEther("1000000"));
        await v3Token.connect(carol).approve(await marketplace.getAddress(), ethers.parseEther("1000000"));

        const deadline = (await time.latest()) + 300;
        const tx = await marketplace
          .connect(carol)
          .activateDomainWithToken(node, "carol", tokenAddr, ethers.parseEther("1000000"), deadline);
        const receipt = await tx.wait();
        const event = receipt.logs
          .map((l) => { try { return marketplace.interface.parseLog(l); } catch { return null; } })
          .find((e) => e && e.name === "DomainActivatedWithToken");

        expect(event.args.tokenAmountPaid).to.equal(event.args.etnEquivalentFee);
      });

      it("reverts when the V3 quote exceeds maxTokenAmount", async function () {
        const ctx = await loadFixture(deployFixture);
        const { marketplace, deployer, carol, v3Token, weth } = ctx;
        const tokenAddr = await v3Token.getAddress();
        const pool = await deployV3Pool(ctx, { token0: await weth.getAddress(), token1: tokenAddr });

        await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
        await marketplace.connect(deployer).setSwapRouter(await ctx.router.getAddress());
        await marketplace.connect(deployer).setV3PoolForToken(tokenAddr, await pool.getAddress());

        await withUnactivatedDirectRegistration(ctx, carol, "carol");
        const node = parentNodeFor("carol");
        const deadline = (await time.latest()) + 300;

        await expect(
          marketplace.connect(carol).activateDomainWithToken(node, "carol", tokenAddr, 1n, deadline)
        ).to.be.revertedWith("Quote exceeds max token amount");
      });
    });

    describe("buyBackAndBurnToken via a V3 pool", function () {
      async function withV3BurnPool(ctx, poolOptions) {
        const { marketplace, deployer, wrapper, alice, bob, v3Token, weth, router } = ctx;
        const tokenAddr = await v3Token.getAddress();
        const pool = await deployV3Pool(ctx, { token0: tokenAddr, token1: await weth.getAddress(), ...poolOptions });

        await marketplace.connect(deployer).setCoreToken(await ctx.core.getAddress());
        await marketplace.connect(deployer).setSwapRouter(await router.getAddress());
        await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
        await marketplace.connect(deployer).setV3PoolForToken(tokenAddr, await pool.getAddress());

        await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
        const price = ethers.parseEther("500");
        const parentNode = parentNodeFor("alice");
        await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);
        await v3Token.mint(bob.address, price);
        await v3Token.connect(bob).approve(await marketplace.getAddress(), price);
        await marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr);

        return { tokenAddr, pool };
      }

      it("swaps token -> WETN (via the V3 pool) -> CORE (via the V2 router) and burns it", async function () {
        const ctx = await withRegisteredParent();
        const { marketplace, deployer, core, router } = ctx;
        // 1 v3Token -> 2 WETN, independent of the (irrelevant here) sqrtPriceX96 default.
        const { tokenAddr } = await withV3BurnPool(ctx, { rateToken1PerToken0X18: ethers.parseEther("2") });

        const burnPoolAmount = await marketplace.erc20BurnPool(tokenAddr);
        const rate = await router.rate();
        const expectedWeth = (burnPoolAmount * ethers.parseEther("2")) / ethers.parseEther("1");
        const expectedCore = expectedWeth * rate;

        const deadline = (await time.latest()) + 300;
        await expect(marketplace.connect(deployer).buyBackAndBurnToken(tokenAddr, 0, deadline))
          .to.emit(marketplace, "BuybackAndBurn")
          .withArgs(tokenAddr, burnPoolAmount, expectedCore);

        expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(0);
        expect(await marketplace.totalCoreBurned()).to.equal(expectedCore);
        expect(await core.totalSupply()).to.equal(0); // minted then burned within the same tx
      });

      it("reverts on slippage when minCoreOut cannot be met, leaving the pool untouched", async function () {
        const ctx = await withRegisteredParent();
        const { marketplace, deployer, router } = ctx;
        const { tokenAddr } = await withV3BurnPool(ctx); // default 1:1 pool rate

        const burnPoolAmount = await marketplace.erc20BurnPool(tokenAddr);
        const rate = await router.rate();
        const expectedCore = burnPoolAmount * rate;
        await expect(
          marketplace.connect(deployer).buyBackAndBurnToken(tokenAddr, expectedCore + 1n, (await time.latest()) + 300)
        ).to.be.revertedWith("Insufficient output amount");
        expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(burnPoolAmount);
      });
    });

    describe("electroSwapV3SwapCallback", function () {
      it("rejects a callback unless msg.sender is exactly the configured pool for that token", async function () {
        const { marketplace, alice, v3Token } = await loadFixture(deployFixture);
        const tokenAddr = await v3Token.getAddress();
        // v3PoolForToken[tokenAddr] is still address(0) — nothing can satisfy msg.sender === it.
        await expect(
          marketplace
            .connect(alice)
            .electroSwapV3SwapCallback(1, 0, ethers.AbiCoder.defaultAbiCoder().encode(["address"], [tokenAddr]))
        ).to.be.revertedWith("Unauthorized callback");
      });
    });
  });

  // ========================================================
  // Manual ERC20 burn pool withdrawal (new in V5) — the escape hatch for a whitelisted token
  // whose accumulated cut buyBackAndBurnToken can't reach automatically (no V2 or V3 path
  // configured at all, or one that's stopped working) — see PlanetZephyrosSubdomainServiceV5.sol's
  // own header comment.
  // ========================================================
  describe("withdrawErc20BurnPoolForManualSwap / depositAndBurnCore", function () {
    async function withErc20BurnPool(ctx) {
      const { marketplace, deployer, wrapper, alice, bob, otherToken } = ctx;
      const tokenAddr = await otherToken.getAddress();
      await marketplace.connect(deployer).setPaymentTokenWhitelisted(tokenAddr, true);
      await wrapper.connect(alice).setApprovalForAll(await marketplace.getAddress(), true);
      const price = ethers.parseEther("500");
      const parentNode = parentNodeFor("alice");
      await marketplace.connect(alice).setSubnamePricePerYear(parentNode, tokenAddr, price);
      await otherToken.mint(bob.address, price);
      await otherToken.connect(bob).approve(await marketplace.getAddress(), price);
      await marketplace.connect(bob).registerSubname(parentNode, "shop", ONE_YEAR, tokenAddr);
      return tokenAddr;
    }

    describe("withdrawErc20BurnPoolForManualSwap", function () {
      it("only owner can call it, decrements erc20BurnPool, and transfers to `to`", async function () {
        const ctx = await withRegisteredParent();
        const { marketplace, deployer, alice, carol, otherToken } = ctx;
        const tokenAddr = await withErc20BurnPool(ctx);
        const pool = await marketplace.erc20BurnPool(tokenAddr);
        expect(pool).to.be.gt(0);

        await expect(
          marketplace.connect(alice).withdrawErc20BurnPoolForManualSwap(tokenAddr, pool, carol.address)
        ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");

        await expect(marketplace.connect(deployer).withdrawErc20BurnPoolForManualSwap(tokenAddr, pool, carol.address))
          .to.emit(marketplace, "Erc20BurnPoolWithdrawnForManualSwap")
          .withArgs(tokenAddr, pool, carol.address);

        expect(await marketplace.erc20BurnPool(tokenAddr)).to.equal(0);
        expect(await otherToken.balanceOf(carol.address)).to.equal(pool);
      });

      it("reverts on an amount exceeding the reserved pool, and on a zero `to`", async function () {
        const ctx = await withRegisteredParent();
        const { marketplace, deployer, carol } = ctx;
        const tokenAddr = await withErc20BurnPool(ctx);
        const pool = await marketplace.erc20BurnPool(tokenAddr);

        await expect(
          marketplace.connect(deployer).withdrawErc20BurnPoolForManualSwap(tokenAddr, pool + 1n, carol.address)
        ).to.be.revertedWith("Amount exceeds reserved pool");

        await expect(
          marketplace.connect(deployer).withdrawErc20BurnPoolForManualSwap(tokenAddr, pool, ethers.ZeroAddress)
        ).to.be.revertedWith("Zero address");
      });

      it("leaves rescueTokens' own protection exactly as strict as before (still can't touch the reserved pool)", async function () {
        const ctx = await withRegisteredParent();
        const { marketplace, deployer, alice } = ctx;
        const tokenAddr = await withErc20BurnPool(ctx);
        const pool = await marketplace.erc20BurnPool(tokenAddr);
        await expect(
          marketplace.connect(deployer).rescueTokens(tokenAddr, pool, alice.address)
        ).to.be.revertedWith("Would touch burn pool funds");
      });
    });

    describe("depositAndBurnCore", function () {
      it("only owner can call it; burns the deposited CORE and credits totalCoreBurned", async function () {
        const ctx = await withRegisteredParent();
        const { marketplace, deployer, alice, core } = ctx;
        const tokenAddr = await withErc20BurnPool(ctx);
        await marketplace.connect(deployer).setCoreToken(await core.getAddress());

        // Simulates the owner having manually withdrawn + swapped otherToken for CORE by hand,
        // entirely outside this contract — depositAndBurnCore only ever sees/verifies the CORE.
        const coreAmount = ethers.parseEther("42");
        await core.mint(deployer.address, coreAmount);
        await core.connect(deployer).approve(await marketplace.getAddress(), coreAmount);

        await expect(
          marketplace.connect(alice).depositAndBurnCore(tokenAddr, coreAmount)
        ).to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");

        const supplyBefore = await core.totalSupply();
        await expect(marketplace.connect(deployer).depositAndBurnCore(tokenAddr, coreAmount))
          .to.emit(marketplace, "BuybackAndBurn")
          .withArgs(tokenAddr, coreAmount, coreAmount);

        expect(await marketplace.totalCoreBurned()).to.equal(coreAmount);
        expect(await core.totalSupply()).to.equal(supplyBefore - coreAmount); // minted then burned
      });

      it("reverts without coreToken configured, and on a zero amount once it is", async function () {
        const { marketplace, deployer, core } = await loadFixture(deployFixture);
        await expect(
          marketplace.connect(deployer).depositAndBurnCore(ethers.ZeroAddress, 1n)
        ).to.be.revertedWith("CORE token not configured");

        await marketplace.connect(deployer).setCoreToken(await core.getAddress());
        await expect(
          marketplace.connect(deployer).depositAndBurnCore(ethers.ZeroAddress, 0n)
        ).to.be.revertedWith("Amount required");
      });
    });
  });
});
