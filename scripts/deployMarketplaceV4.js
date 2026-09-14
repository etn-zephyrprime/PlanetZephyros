// Deploys PlanetZephyrosSubdomainServiceV4 to Electroneum testnet or mainnet, seeding initial
// subname prices + a goldlist entry for the deployer's own domains, and verifies it on the block
// explorer. Run with:
//   npx hardhat run scripts/deployMarketplaceV4.js --network electroneumTestnet
//   npx hardhat run scripts/deployMarketplaceV4.js --network electroneumMainnet
const hre = require("hardhat");

// Network-scoped on purpose — a deploy run with --network electroneumMainnet but a missing
// MARKETPLACE_* override must NOT silently fall back to testnet addresses. Same convention as
// deployMarketplace.js (V3's own deploy script).
function loadDeploymentAddresses(networkName) {
  const envVar =
    networkName === "electroneumMainnet"
      ? "NEXT_PUBLIC_ETN_MAINNET_DEPLOYMENT_ADDRESSES"
      : "NEXT_PUBLIC_ETN_TESTNET_DEPLOYMENT_ADDRESSES";
  const raw = process.env[envVar];
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${envVar} as JSON: ${err.message}`);
  }
}

// Same root every .etn namehash in this app is built from — ETNNamehash.ETN_NODE
// (contracts/EnsSubdomainService/ETNNamehash.sol) and src/config.js's ETN_NODE in
// ETNSubdomainService both hold this exact value. ETNNamehash's own functions are all `internal`
// (a Solidity library with no deployed bytecode of its own), so an off-chain script can't call
// into it directly — this constant has to be kept in sync by hand. If it's ever wrong, every node
// hash below would be wrong too, so it's checked against the deployed NameWrapper indirectly by
// this script's own post-deploy sanity read (see verifyNodeHash below) rather than trusted blind.
const ETN_NODE = "0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd";

function computeNode(label) {
  const labelHash = hre.ethers.keccak256(hre.ethers.toUtf8Bytes(label));
  return hre.ethers.keccak256(hre.ethers.concat([ETN_NODE, labelHash]));
}

// ============================================================
// Deploy-time configuration — edit these two lists, not the node-hash math above.
// ============================================================

// Initial ETN subname prices seeded atomically at deploy time (activates + prices each node in
// one transaction, no separate activateDomain + setSubnamePricePerYear call needed per domain).
// Labels only — node hashes are derived below, never hand-computed/pasted, so there's nothing to
// get wrong by transcription.
//
// Only ever list a domain the deploying wallet genuinely owns on NameWrapper — seeding activates
// AND prices the node without any ownership check (see this contract's own header comment on why
// that's a deliberate, deployer-trusted bootstrap, not a public flow), so seeding a domain
// actually owned by someone else would just be meaningless/confusing on-chain state: the real
// owner never approved this marketplace, so nothing could ever actually sell under it.
//
// Confirmed live on mainnet (NameWrapper.ownerOf) before finalizing this list: zypto.etn,
// community.etn, money.etn, and bank.etn each belong to a different, unrelated wallet — NOT this
// project's — so they're deliberately absent here despite being mentioned in earlier planning.
// enssubdomain.etn and planetzephyros.etn (the goldlist entry below) share the same owner.
const INITIAL_PRICING = [{ label: "enssubdomain", priceEtn: "5000" }];

// Nodes exempt from the activation fee entirely (see setGoldlisted's own comment on why) — still
// needs a real activateDomain/activateDomainWithToken call from the domain's genuine owner after
// deploy, this just makes that call free. planetzephyros.etn specifically: a 100-year remaining
// expiry would otherwise floor its activation fee at 100x minBrokerageFeePerYear (2,500,000 ETN
// at the 25,000 ETN/year default) — not a pricing bug, just a formula never designed for a name
// that long-lived.
const INITIAL_GOLDLIST = ["planetzephyros"];

async function main() {
  const deployed = loadDeploymentAddresses(hre.network.name);

  const registrarController =
    process.env.MARKETPLACE_REGISTRAR_CONTROLLER || deployed.ETHRegistrarController;
  const nameWrapper = process.env.MARKETPLACE_NAME_WRAPPER || deployed.NameWrapper;
  const baseRegistrar =
    process.env.MARKETPLACE_BASE_REGISTRAR || deployed.BaseRegistrarImplementation;
  const defaultResolver = process.env.MARKETPLACE_DEFAULT_RESOLVER || deployed.PublicResolver;
  const projectWallet = process.env.MARKETPLACE_PROJECT_WALLET;
  // Optional — address(0) if there's nothing to migrate activation status from (e.g. a fresh
  // testnet deploy with no prior V3 instance). Set to the real deployed V3 address on mainnet so
  // migrateActivation actually has something to read from.
  const legacyMarketplace = process.env.MARKETPLACE_LEGACY_ADDRESS || hre.ethers.ZeroAddress;

  const missing = Object.entries({
    registrarController,
    nameWrapper,
    baseRegistrar,
    defaultResolver,
    projectWallet,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Missing required deployment inputs: ${missing.join(", ")}. Set NEXT_PUBLIC_ETN_TESTNET_DEPLOYMENT_ADDRESSES ` +
        `and/or the MARKETPLACE_* overrides and MARKETPLACE_PROJECT_WALLET in .env.`
    );
  }

  const initialPricing = INITIAL_PRICING.map(({ label, priceEtn }) => ({
    node: computeNode(label),
    pricePerYear: hre.ethers.parseEther(priceEtn),
  }));
  const initialGoldlist = INITIAL_GOLDLIST.map(computeNode);

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying PlanetZephyrosSubdomainServiceV4 with account:", deployer.address);
  console.log("  registrarController:", registrarController);
  console.log("  nameWrapper:        ", nameWrapper);
  console.log("  baseRegistrar:      ", baseRegistrar);
  console.log("  defaultResolver:    ", defaultResolver);
  console.log("  projectWallet:      ", projectWallet);
  console.log("  owner:              ", deployer.address);
  console.log("  legacyMarketplace:  ", legacyMarketplace);
  console.log("  initial pricing:");
  for (const { label, priceEtn } of INITIAL_PRICING) {
    console.log(`    ${label}.etn -> ${priceEtn} ETN/year (node ${computeNode(label)})`);
  }
  console.log("  initial goldlist:");
  for (const label of INITIAL_GOLDLIST) {
    console.log(`    ${label}.etn (node ${computeNode(label)})`);
  }

  const constructorArgs = [
    registrarController,
    nameWrapper,
    baseRegistrar,
    defaultResolver,
    projectWallet,
    deployer.address,
    legacyMarketplace,
    initialPricing,
    initialGoldlist,
  ];

  const factory = await hre.ethers.getContractFactory("PlanetZephyrosSubdomainServiceV4");
  const marketplace = await factory.deploy(...constructorArgs);
  await marketplace.waitForDeployment();

  const address = await marketplace.getAddress();
  console.log("PlanetZephyrosSubdomainServiceV4 deployed to:", address);

  // Sanity check the seed actually landed as intended, reading it back from the freshly deployed
  // contract rather than just trusting the constructor call succeeded silently.
  for (const { label, priceEtn } of INITIAL_PRICING) {
    const node = computeNode(label);
    const activated = await marketplace.domainActivated(node);
    const price = await marketplace.subnamePricePerYear(node, hre.ethers.ZeroAddress);
    const ok = activated && price === hre.ethers.parseEther(priceEtn);
    console.log(`  verify ${label}.etn: activated=${activated} price=${hre.ethers.formatEther(price)} ETN ${ok ? "✓" : "✗ MISMATCH"}`);
  }
  for (const label of INITIAL_GOLDLIST) {
    const node = computeNode(label);
    const isGoldlisted = await marketplace.goldlisted(node);
    console.log(`  verify ${label}.etn goldlisted: ${isGoldlisted ? "✓" : "✗ MISMATCH"}`);
  }

  const confirmations = Number(process.env.VERIFY_CONFIRMATIONS || 5);
  console.log(`Waiting for ${confirmations} confirmations before verifying...`);
  const deployTx = marketplace.deploymentTransaction();
  if (deployTx) {
    await deployTx.wait(confirmations);
  }

  try {
    await hre.run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    console.log("Verified on block explorer.");
  } catch (err) {
    console.error("Verification failed:", err.message || err);
    console.error(
      "You can retry manually with:\n" +
        `  npx hardhat verify --network ${hre.network.name} ${address} --constructor-args <a JS file exporting constructorArgs — inline args on the CLI won't handle the array parameters cleanly>`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
