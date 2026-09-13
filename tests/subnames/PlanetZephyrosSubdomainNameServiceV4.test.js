// V4-specific coverage only: whitelisting, per-token price floors, multi-currency subname
// pricing/registration, ERC20-denominated domain activation, the ERC20 buyback path (including
// the CORE-direct fast path), and activation migration from a legacy (V3) instance. Everything
// V3 already covers (registerName/renewName/ETN activation/ETN buyback/listings) is unchanged
// logic here and stays covered by PlanetZephyrosSubdomainNameServiceV3.test.js — not duplicated.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");

const ONE_YEAR = 365 * 24 * 60 * 60;
const PRICE_PER_SECOND = ethers.parseEther("0.000001");
// Same ROOT_NODE as PlanetZephyrosSubdomainNameServiceV3.test.js — must stay identical, see that
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

describe("PlanetZephyrosSubdomainNameServiceV4", function () {
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
    const otherToken = await MockERC20.deploy("Wrapped ETN", "WETN"); // a whitelisted token that ISN'T CORE

    const wethDummy = ethers.Wallet.createRandom().address;
    const MockRouter = await ethers.getContractFactory("MockRouter");
    const router = await MockRouter.deploy(await core.getAddress(), wethDummy, 1000n);

    const defaultResolver = ethers.Wallet.createRandom().address;

    // A real V3 instance, standing in for "legacyMarketplace" — deployed and used exactly like
    // the live one migrateActivation reads from, not a bespoke mock, so migration tests exercise
    // its actual domainActivated semantics rather than an approximation of them.
    const LegacyMarketplace = await ethers.getContractFactory("PlanetZephyrosSubdomainNameServiceV3");
    const legacy = await LegacyMarketplace.deploy(
      await controller.getAddress(),
      await wrapper.getAddress(),
      await base.getAddress(),
      defaultResolver,
      projectWallet.address,
      deployer.address
    );

    const Marketplace = await ethers.getContractFactory("PlanetZephyrosSubdomainNameServiceV4");
    const marketplace = await Marketplace.deploy(
      await controller.getAddress(),
      await wrapper.getAddress(),
      await base.getAddress(),
      defaultResolver,
      projectWallet.address,
      deployer.address,
      await legacy.getAddress()
    );

    // Same neutralization as V3's own fixture, same reasoning (tiny PRICE_PER_SECOND makes
    // bps-based fees far smaller than any realistic floor) — this file isn't re-testing the floor
    // itself, V3's own suite already does.
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
    // Registers "carol" directly with the registrar (bypassing the marketplace brokerage) and
    // approves BaseRegistrar, mirroring V3's own "genuinely never wrapped" activation setup —
    // the case activateDomain/activateDomainWithToken exist to handle.
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
  // Migration from a legacy (V3) deployment
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

    it("reverts if already activated on this (V4) contract", async function () {
      const ctx = await withRegisteredParent(); // activates "alice" directly on V4
      const { marketplace } = ctx;
      const node = parentNodeFor("alice");
      await expect(marketplace.migrateActivation(node)).to.be.revertedWith("Already activated on this contract");
    });

    it("does NOT carry over subname prices — each owner must re-set their own on V4", async function () {
      const ctx = await loadFixture(deployFixture);
      const { legacy, marketplace, alice } = ctx;
      await registerName(ctx, alice, "alice", ONE_YEAR, legacy);
      const node = parentNodeFor("alice");
      await legacy.connect(alice).setSubnamePricePerYear(node, ethers.parseEther("1000"));

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
});
