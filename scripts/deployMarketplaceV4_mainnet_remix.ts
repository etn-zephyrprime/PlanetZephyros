// Deploys PlanetZephyrosSubdomainServiceV4 to Electroneum MAINNET via Remix's injected provider.
//
// LEGACY_MARKETPLACE below points at the real, currently-live V3 deployment
// (0x392fd031910e5D58650160f41a501ccc29B1eD13, per deployMarketplace_mainnet_remix.ts's own
// header) so migrateActivation has something real to read from.
//
// INITIAL_PRICING/INITIAL_GOLDLIST below are pre-filled with the domains confirmed live on-chain
// (NameWrapper.ownerOf) to actually belong to PROJECT_WALLET/OWNER before this was written:
// enssubdomain.etn and planetzephyros.etn. zypto.etn, community.etn, money.etn, and bank.etn were
// each confirmed to belong to a different, unrelated wallet and are deliberately absent — see
// scripts/lib comment in deployMarketplaceV4.js's own INITIAL_PRICING for the same finding.
//
// Before running:
//  1. In Remix, compile contracts/subnames/PlanetZephyrosSubdomainServiceV4.sol with:
//       Solidity: 0.8.24, Enable optimization (200 runs), EVM Version: london, Enable viaIR
//     (Advanced Configurations in the Solidity Compiler plugin.)
//     EVM Version MUST be london, not the Remix default — Electroneum testnet rejected Cancun
//     opcodes (PUSH0/MCOPY) with "invalid opcode" on a past deploy attempt, which is why
//     hardhat.config.js pins this exact contract to london. Using london here too costs nothing
//     and avoids re-risking the same failure if mainnet's EVM turns out to be equally behind —
//     same reasoning deployMarketplace_mainnet_remix.ts (V3's own mainnet script) already gives.
//  2. In "Deploy & Run Transactions", set Environment to "Injected Provider - MetaMask", with
//     MetaMask connected to Electroneum Mainnet (chain id 52014).
//  3. Double check PROJECT_WALLET, OWNER, INITIAL_PRICING, and INITIAL_GOLDLIST below before
//     running — this is a real, immutable mainnet deployment, not testnet.
//  4. Right click this file in the file explorer -> "Run".

import { deploy } from './ethers-lib'
import { ethers } from 'ethers'

// Electroneum MAINNET ENS-fork deployment addresses — same as deployMarketplace_mainnet_remix.ts
// (V3's own mainnet script), confirmed on-chain there before being reused here unchanged (these
// are network-wide contracts, not specific to which marketplace version calls them).
const REGISTRAR_CONTROLLER: string = '0x5cD5CEFDc5925cA6A9A38D2AA810d5aeD360b21C' // ETHRegistrarController
const NAME_WRAPPER: string = '0xd8F4B1A91469B05d9E0b15Cac4917Ee47b2A6f64' // NameWrapper
const BASE_REGISTRAR: string = '0x5207496C1248BbD2AeeDd57Bde44dd9d4E9F1b59' // BaseRegistrarImplementation
const DEFAULT_RESOLVER: string = '0xDb4A3Abb6703232e20a118a104e7f4EbB3e2738D' // PublicResolver

// Same value used for both — a plain EOA, not a multisig. Real brokerage/activation revenue and
// full owner() admin control (fee rates, whitelist, goldlist, pause, CORE token/router wiring,
// rescueTokens) route through this single key on mainnet. Same address V3 already uses.
const PROJECT_WALLET: string = '0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099'
const OWNER: string = '0x3Fd2e5B4AC0efF6DFDF2446abddAB3f66B425099'

// The real, currently-live V3 marketplace — see this file's own header comment.
const LEGACY_MARKETPLACE: string = '0x392fd031910e5D58650160f41a501ccc29B1eD13'

const ZERO_ADDRESS: string = '0x0000000000000000000000000000000000000000'

// Same root every .etn namehash in this app is built from — ETNNamehash.ETN_NODE
// (contracts/EnsSubdomainService/ETNNamehash.sol). Kept in sync by hand (that library is all
// `internal`, no deployed bytecode of its own to call into from a script).
const ETN_NODE: string = '0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd'

function computeNode(label: string): string {
  const labelHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label))
  return ethers.utils.keccak256(ethers.utils.concat([ETN_NODE, labelHash]))
}

// Confirmed on-chain (NameWrapper.ownerOf) to belong to PROJECT_WALLET/OWNER above — see this
// file's own header comment.
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

    console.log('Deploying PlanetZephyrosSubdomainServiceV4 to MAINNET...')
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

    const result = await deploy('PlanetZephyrosSubdomainServiceV4', [
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
    console.log(`PlanetZephyrosSubdomainServiceV4 deployed to MAINNET: ${result.address}`)

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
