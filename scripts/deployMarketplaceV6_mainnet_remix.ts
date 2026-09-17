// Deploys PlanetZephyrosSubdomainServiceV6 to Electroneum MAINNET via Remix's injected provider.
//
// WHY V6 EXISTS: registerSubname's _fulfillSubname had no check that a label wasn't already
// taken. Every subname this contract has ever created (V3 through V5) is wrapped with fuses = 0,
// so NameWrapper's own PARENT_CANNOT_CONTROL protection is never active on it — anyone (not just
// the parent owner) could call registerSubname again for an already-sold label, pay the listed
// price, and silently take over a subname someone else already held. Confirmed exploitable live
// via a read-only eth_call simulation against enssubdomain.etn's real "admin" subname, 2026-09-17.
// V5, V4, and V3 were all paused (setPaused(true), owner-only) on 2026-09-17 to close this
// immediately — see this contract's own header comment for the fix itself (an availability check
// in _fulfillSubname). V5/V4/V3 stay paused permanently after V6 replaces them; they cannot be
// patched in place (no upgrade path, plain Ownable/immutable wiring, same as every version so far).
//
// LEGACY_MARKETPLACE below points at the real, currently-live V5 deployment
// (0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7) so migrateActivation has something real to read
// from — anyone who activated a domain on V5 carries that over to V6 for free, same as V5's own
// migration from V4 before it. A domain only ever activated on V3 (e.g. community.etn, bank.etn)
// needs THREE hops to reach V6 (V3->V4, V4->V5, V5->V6, each a separate free migrateActivation
// call) — the frontend's own isDomainActivated/migrationSteps in useSubnamePricing.js already
// walks a chain of this length generically, no code change needed there, only config.js's
// LEGACY_MARKETPLACES list needs V5 added as a new entry once this deploys.
//
// INITIAL_PRICING/INITIAL_GOLDLIST below mirror V5's own — enssubdomain.etn and planetzephyros.etn
// are the only two domains confirmed on-chain (NameWrapper.ownerOf) to belong to PROJECT_WALLET/
// OWNER. Re-seeding enssubdomain.etn's price here is a convenience (subname prices are NOT carried
// over by migrateActivation — see PlanetZephyrosSubdomainServiceV6.sol's own header comment), not
// required; planetzephyros.etn's own price (1000 ETN, set manually post-V5-deploy, not seeded by
// V5's own constructor either) needs the same manual setSubnamePricePerYear call again here after
// migrating. Its goldlist entry is largely symbolic once migrateActivation runs for it (an
// already-activated domain can't be re-activated, goldlisted or not) but costs nothing to keep for
// documentation/consistency.
//
// Before running:
//  1. In Remix, compile contracts/subnames/PlanetZephyrosSubdomainServiceV6.sol with:
//       Solidity: 0.8.24, Enable optimization (200 runs), EVM Version: london, Enable viaIR
//     (Advanced Configurations in the Solidity Compiler plugin.)
//     EVM Version MUST be london, not the Remix default — Electroneum rejects Cancun opcodes
//     (PUSH0/MCOPY) — same reasoning V3/V4/V5's own mainnet scripts give, and the same override
//     hardhat.config.js already pins this contract to.
//  2. In "Deploy & Run Transactions", set Environment to "Injected Provider - MetaMask", with
//     MetaMask connected to Electroneum Mainnet (chain id 52014).
//  3. Double check PROJECT_WALLET, OWNER, INITIAL_PRICING, and INITIAL_GOLDLIST below before
//     running — this is a real, immutable mainnet deployment, not testnet.
//  4. Right click this file in the file explorer -> "Run".
//
// AFTER deploying: run configureMarketplaceV6Currencies_remix.ts next (fill in the new address
// it prints) to wire up coreToken/swapRouter and whitelist the 9 real payment tokens — none of
// that is seeded by the constructor, unlike pricing/goldlist above. Then update
// src/config.js's MARKETPLACE_ADDRESS/LEGACY_MARKETPLACES (and the backend's mirrored constants)
// to point the frontend at V6.

import { deploy } from './ethers-lib'
import { ethers } from 'ethers'

// Electroneum MAINNET ENS-fork deployment addresses — same as V3/V4/V5's own mainnet scripts
// (network-wide contracts, not specific to which marketplace version calls them).
const REGISTRAR_CONTROLLER: string = '0x5cD5CEFDc5925cA6A9A38D2AA810d5aeD360b21C' // ETHRegistrarController
const NAME_WRAPPER: string = '0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64' // NameWrapper
const BASE_REGISTRAR: string = '0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59' // BaseRegistrarImplementation
const DEFAULT_RESOLVER: string = '0xDb4A3Abb6703232e20a118a104e7f4EbB3e2738D' // PublicResolver

// Same value used for both — a plain EOA, not a multisig. Real brokerage/activation revenue and
// full owner() admin control (fee rates, whitelist, goldlist, pause, CORE token/router wiring,
// rescueTokens, and V5's v3PoolForToken/manual-burn-pool functions, unchanged in V6) route through
// this single key on mainnet. Same address V3/V4/V5 already use.
const PROJECT_WALLET: string = '0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099'
const OWNER: string = '0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099'

// The real, currently-live (paused) V5 marketplace — see this file's own header comment.
const LEGACY_MARKETPLACE: string = '0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7'

const ZERO_ADDRESS: string = '0x0000000000000000000000000000000000000000'

// Same root every .etn namehash in this app is built from — ETNNamehash.ETN_NODE
// (contracts/EnsSubdomainService/ETNNamehash.sol). Kept in sync by hand (that library is all
// `internal`, no deployed bytecode of its own to call into from a script).
const ETN_NODE: string = '0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd'

function computeNode(label: string): string {
  const labelHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label))
  return ethers.utils.keccak256(ethers.utils.concat([ETN_NODE, labelHash]))
}

// Confirmed on-chain (NameWrapper.ownerOf) to belong to PROJECT_WALLET/OWNER — see this file's
// own header comment.
const INITIAL_PRICING: { label: string; priceEtn: string }[] = [
  { label: 'enssubdomain', priceEtn: '5000' },
]

// planetzephyros.etn: same owner, has a 100-year remaining expiry — without this, its activation
// fee would floor at 100x minBrokerageFeePerYear (2,500,000 ETN at the 25,000 ETN/year default).
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

    console.log('Deploying PlanetZephyrosSubdomainServiceV6 to MAINNET...')
    console.log('  registrarController:', REGISTRAR_CONTROLLER)
    console.log('  nameWrapper:        ', NAME_WRAPPER)
    console.log('  baseRegistrar:      ', BASE_REGISTRAR)
    console.log('  defaultResolver:    ', DEFAULT_RESOLVER)
    console.log('  projectWallet:      ', PROJECT_WALLET)
    console.log('  owner:              ', OWNER)
    console.log('  legacyMarketplace:  ', LEGACY_MARKETPLACE)
    console.log('  initial pricing:')
    for (const { label, priceEtn } of INITIAL_PRICING) {
      console.log(`    ${label}.etn -> ${priceEtn} ETN/year (node ${computeNode(label)})`)
    }
    console.log('  initial goldlist:')
    for (const label of INITIAL_GOLDLIST) {
      console.log(`    ${label}.etn (node ${computeNode(label)})`)
    }

    const result = await deploy('PlanetZephyrosSubdomainServiceV6', [
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
    console.log(`PlanetZephyrosSubdomainServiceV6 deployed to MAINNET: ${result.address}`)
    console.log('Next: run configureMarketplaceV6Currencies_remix.ts with MARKETPLACE_ADDRESS set to the address above.')

    // Sanity check the seed actually landed as intended, reading it back from the freshly
    // deployed contract rather than just trusting the constructor call succeeded silently.
    for (const { label, priceEtn } of INITIAL_PRICING) {
      const node = computeNode(label)
      const activated = await result.domainActivated(node)
      const price = await result.subnamePricePerYear(node, ZERO_ADDRESS)
      const ok = activated && price.eq(ethers.utils.parseEther(priceEtn))
      console.log(`  verify ${label}.etn: activated=${activated} price=${ethers.utils.formatEther(price)} ETN ${ok ? '✓' : '✗ MISMATCH'}`)
    }
    for (const label of INITIAL_GOLDLIST) {
      const node = computeNode(label)
      const isGoldlisted = await result.goldlisted(node)
      console.log(`  verify ${label}.etn goldlisted: ${isGoldlisted ? '✓' : '✗ MISMATCH'}`)
    }
  } catch (e) {
    console.log(e.message)
  }
})()
