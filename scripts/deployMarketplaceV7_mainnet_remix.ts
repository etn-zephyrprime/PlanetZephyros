// Deploys PlanetZephyrosSubdomainServiceV7 to Electroneum MAINNET via Remix's injected provider.
//
// WHY V7 EXISTS: V6 (2026-09-17) closed the gap where a STRANGER could pay to silently take over
// an already-sold subname through registerSubname. It deliberately did NOT close the other half:
// every subname V3 through V6 has ever created is wrapped with fuses = 0, so the subname's own
// PARENT could still reassign it at any time by calling NameWrapper.setSubnodeRecord DIRECTLY,
// bypassing this contract (and its "already taken" check) entirely. Confirmed live via a read-only
// eth_call simulation, 2026-09-17: the real owner of enssubdomain.etn successfully (in simulation)
// reassigned its real "admin" subname to an arbitrary address, with V6 offering no protection
// against its own parent.
//
// V7's fix needs real on-chain cooperation from each parent domain, not just a contract change:
// NameWrapper only allows PARENT_CANNOT_CONTROL to be burned on a subname if the PARENT's own
// fuses already have CANNOT_UNWRAP burned — confirmed against the deployed NameWrapper's own
// _checkParentFuses, and proven end-to-end on a local mainnet fork before this shipped (lock the
// parent -> sell a subname with both fuses burned -> the parent's own later reassignment attempt
// on that exact subname now genuinely reverts, ownership unchanged; a full 16-check fork
// simulation covering every path — new sales, the stranger-takeover check, retroactively
// upgrading an existing V3-era subname, and the constructor's own lock enforcement — all passed).
// CANNOT_UNWRAP is irreversible for whoever burns it (that domain can never be unwrapped back to a
// plain, un-wrapped registration again), so this can only ever be the parent's own deliberate
// choice — see setSubnamePricePerYear/lockDomainForSubnameSales/upgradeSubnameToProtected's own
// comments on this contract for the full mechanics.
//
// PRACTICAL CONSEQUENCE FOR THIS DEPLOY SCRIPT: unlike V6's own script, INITIAL_PRICING below is
// deliberately left EMPTY. V7's constructor now enforces the exact same "parent must have already
// burned CANNOT_UNWRAP" rule V6's own setSubnamePricePerYear didn't have to worry about — seeding
// enssubdomain.etn's price here again (as V6's script did) would make the ENTIRE constructor call
// revert unless enssubdomain.etn has ALREADY been locked on-chain before this script runs. Simpler
// and safer to leave pricing unseeded: after deploying, call lockDomainForSubnameSales then
// setSubnamePricePerYear as two ordinary post-deploy transactions (same order proven on the fork),
// rather than risk a failed deployment over a skipped pre-step. INITIAL_GOLDLIST is unaffected (no
// fuse dependency) and still seeded the same way V6's script did.
//
// LEGACY_MARKETPLACE below points at the real, currently-live V6 deployment
// (0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5) so migrateActivation has something real to read
// from — anyone who activated a domain on V6 carries that over to V7 for free, same as V6's own
// migration from V5 before it. A domain only ever activated on V3 (e.g. community.etn, bank.etn)
// needs FOUR hops to reach V7 (V3->V4, V4->V5, V5->V6, V6->V7, each a separate free
// migrateActivation call) — the frontend's own isDomainActivated/migrationSteps in
// useSubnamePricing.js already walks a chain of this length generically, no code change needed
// there, only config.js's LEGACY_MARKETPLACES list needs V6 added as a new entry once this deploys.
//
// Before running:
//  1. In Remix, compile contracts/subnames/PlanetZephyrosSubdomainServiceV7.sol with:
//       Solidity: 0.8.24, Enable optimization (200 runs), EVM Version: london, Enable viaIR
//     (Advanced Configurations in the Solidity Compiler plugin.)
//     EVM Version MUST be london, not the Remix default — Electroneum rejects Cancun opcodes
//     (PUSH0/MCOPY) — same reasoning V3/V4/V5/V6's own mainnet scripts give, and the same override
//     hardhat.config.js already pins this contract to. NOTE: this contract compiles to within
//     ~90 bytes of the 24576-byte EIP-170 contract-size limit with these exact settings (confirmed
//     via hardhat compile) — if Remix reports a size warning/error with different settings, do not
//     just disable the optimizer or viaIR to work around it; that will very likely push it over.
//  2. In "Deploy & Run Transactions", set Environment to "Injected Provider - MetaMask", with
//     MetaMask connected to Electroneum Mainnet (chain id 52014).
//  3. Double check PROJECT_WALLET, OWNER, and INITIAL_GOLDLIST below before running — this is a
//     real, immutable mainnet deployment, not testnet.
//  4. Right click this file in the file explorer -> "Run".
//
// AFTER deploying:
//  1. Run configureMarketplaceV7Currencies_remix.ts (fill in the new address it prints) to wire up
//     coreToken/swapRouter and whitelist the 9 real payment tokens.
//  2. For enssubdomain.etn (and any other domain you personally own): call
//     lockDomainForSubnameSales(node), THEN setSubnamePricePerYear(node, paymentToken, price) --
//     in that order. planetzephyros.etn's own goldlist entry is seeded below same as V6, but its
//     price (and enssubdomain.etn's) both need re-setting manually post-lock, same as every prior
//     version already required post-migration.
//  3. Update src/config.js's MARKETPLACE_ADDRESS/LEGACY_MARKETPLACES (and the backend's mirrored
//     constants) to point the frontend at V7.
//  4. Every other domain owner: approve V7 on NameWrapper (setApprovalForAll), migrateActivation
//     if needed, then decide whether to lock (irreversible) before continuing to sell subnames.

import { deploy } from './ethers-lib'
import { ethers } from 'ethers'

// Electroneum MAINNET ENS-fork deployment addresses — same as V3/V4/V5/V6's own mainnet scripts
// (network-wide contracts, not specific to which marketplace version calls them).
const REGISTRAR_CONTROLLER: string = '0x5cD5CEFDc5925cA6A9A38D2AA810d5aeD360b21C' // ETHRegistrarController
const NAME_WRAPPER: string = '0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64' // NameWrapper
const BASE_REGISTRAR: string = '0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59' // BaseRegistrarImplementation
const DEFAULT_RESOLVER: string = '0xDb4A3Abb6703232e20a118a104e7f4EbB3e2738D' // PublicResolver

// Same value used for both — a plain EOA, not a multisig. Real brokerage/activation revenue and
// full owner() admin control (fee rates, whitelist, goldlist, pause, CORE token/router wiring,
// rescueTokens, v3PoolForToken/manual-burn-pool, and V7's own lockDomainForSubnameSales/
// upgradeSubnameToProtected functions being called BY DOMAIN OWNERS, not this key — this key's own
// admin surface is unchanged from V6) route through this single key on mainnet. Same address
// V3/V4/V5/V6 already use.
const PROJECT_WALLET: string = '0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099'
const OWNER: string = '0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099'

// The real, currently-live V6 marketplace — see this file's own header comment.
const LEGACY_MARKETPLACE: string = '0xFD8944132Cf464Fb756F98D1d203Edf74A2B7aD5'

const ZERO_ADDRESS: string = '0x0000000000000000000000000000000000000000'

// Same root every .etn namehash in this app is built from — ETNNamehash.ETN_NODE
// (contracts/EnsSubdomainService/ETNNamehash.sol). Kept in sync by hand (that library is all
// `internal`, no deployed bytecode of its own to call into from a script).
const ETN_NODE: string = '0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd'

function computeNode(label: string): string {
  const labelHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label))
  return ethers.utils.keccak256(ethers.utils.concat([ETN_NODE, labelHash]))
}

// Deliberately empty — see this file's own header comment on why V7 can't safely seed pricing at
// deploy time the way V6's script did (the constructor now enforces the same domain-must-be-locked
// rule as the public setSubnamePricePerYear, and neither enssubdomain.etn nor planetzephyros.etn
// is locked as of writing). Set prices manually, post-deploy, after locking each domain.
const INITIAL_PRICING: { label: string; priceEtn: string }[] = []

// planetzephyros.etn: same owner, has a 100-year remaining expiry — without this, its activation
// fee would floor at 100x minBrokerageFeePerYear (2,500,000 ETN at the 25,000 ETN/year default).
// Unaffected by the lock requirement (goldlisting has no fuse dependency) — same as V6's script.
const INITIAL_GOLDLIST: string[] = ['planetzephyros']

;(async () => {
  try {
    if (PROJECT_WALLET === ZERO_ADDRESS || OWNER === ZERO_ADDRESS) {
      throw new Error('Set PROJECT_WALLET and OWNER at the top of this script before running.')
    }

    const initialPricing = INITIAL_PRICING.map(({ label, priceEtn }) => ({
      node: computeNode(label),
      pricePerYear: ethers.utils.parseEther(priceEtn),
    }))
    const initialGoldlist = INITIAL_GOLDLIST.map(computeNode)

    console.log('Deploying PlanetZephyrosSubdomainServiceV7 to MAINNET...')
    console.log('  registrarController:', REGISTRAR_CONTROLLER)
    console.log('  nameWrapper:        ', NAME_WRAPPER)
    console.log('  baseRegistrar:      ', BASE_REGISTRAR)
    console.log('  defaultResolver:    ', DEFAULT_RESOLVER)
    console.log('  projectWallet:      ', PROJECT_WALLET)
    console.log('  owner:              ', OWNER)
    console.log('  legacyMarketplace:  ', LEGACY_MARKETPLACE)
    console.log('  initial pricing:    (none — see this script\'s own header comment)')
    console.log('  initial goldlist:')
    for (const label of INITIAL_GOLDLIST) {
      console.log(`    ${label}.etn (node ${computeNode(label)})`)
    }

    const result = await deploy('PlanetZephyrosSubdomainServiceV7', [
      REGISTRAR_CONTROLLER,
      NAME_WRAPPER,
      BASE_REGISTRAR,
      DEFAULT_RESOLVER,
      PROJECT_WALLET,
      OWNER,
      LEGACY_MARKETPLACE,
      initialPricing,
      initialGoldlist,
    ])
    console.log(`PlanetZephyrosSubdomainServiceV7 deployed to MAINNET: ${result.address}`)
    console.log('Next: run configureMarketplaceV7Currencies_remix.ts with MARKETPLACE_ADDRESS set to the address above.')
    console.log('Then: for each domain you own, call lockDomainForSubnameSales(node) before setSubnamePricePerYear.')

    for (const label of INITIAL_GOLDLIST) {
      const node = computeNode(label)
      const isGoldlisted = await result.goldlisted(node)
      console.log(`  verify ${label}.etn goldlisted: ${isGoldlisted ? '✓' : '✗ MISMATCH'}`)
    }
  } catch (e) {
    console.log(e.message)
  }
})()
