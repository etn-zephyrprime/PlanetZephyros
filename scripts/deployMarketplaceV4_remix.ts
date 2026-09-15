// Deploys PlanetZephyrosSubdomainServiceV4 via Remix's injected provider.
//
// Before running:
//  1. In Remix, compile contracts/subnames/PlanetZephyrosSubdomainServiceV4.sol with:
//       Solidity: 0.8.24, Enable optimization (200 runs), EVM Version: london, Enable viaIR
//     (Advanced Configurations in the Solidity Compiler plugin.)
//     EVM Version MUST be london, not the Remix default — Electroneum testnet rejected Cancun
//     opcodes (PUSH0/MCOPY) with "invalid opcode" on a past deploy attempt (see
//     deployMarketplace_mainnet_remix.ts's own header comment), which is why hardhat.config.js
//     pins this exact contract to london. The testnet deploy script for V3 still says "cancun" —
//     that's stale, predating the discovery; don't copy it.
//  2. In "Deploy & Run Transactions", set Environment to "Injected Provider - MetaMask", with
//     MetaMask connected to Electroneum Testnet (chain id 5201420).
//  3. Fill in PROJECT_WALLET and OWNER below. INITIAL_PRICING/INITIAL_GOLDLIST default to empty —
//     mainnet domain ownership (enssubdomain.etn, planetzephyros.etn) doesn't carry over to
//     testnet, so there's nothing safe to pre-fill here; add your own testnet-owned domains if you
//     want to exercise that feature.
//  4. Right click this file in the file explorer -> "Run".

import { deploy } from './ethers-lib'
import { ethers } from 'ethers'

// Electroneum testnet ENS-fork deployment addresses (from NEXT_PUBLIC_ETN_TESTNET_DEPLOYMENT_ADDRESSES)
// — same as deployMarketplace_remix.ts (V3's own testnet script).
const REGISTRAR_CONTROLLER: string = '0x5BFb2958062Ac12d2019Ac1E69243DDbafCCc2c5' // ETHRegistrarController
const NAME_WRAPPER: string = '0x388f495A886644883F41a5958C11382e7c0D23F5' // NameWrapper
const BASE_REGISTRAR: string = '0x7b787b31Ad58D563D7B3938b4bbfAB2c588624C5' // BaseRegistrarImplementation
const DEFAULT_RESOLVER: string = '0x1B148DF21F18cFaEC68b71FBF11692F569658b3D' // PublicResolver

// TODO: fill these in before running
const PROJECT_WALLET: string = '0x0000000000000000000000000000000000000000' // receives brokerage/activation fees
const OWNER: string = '0x0000000000000000000000000000000000000000' // admin control (usually your deployer address)

// No known testnet V3 deployment — leave as zero address unless you have one and want
// migrateActivation to have something real to read from.
const LEGACY_MARKETPLACE: string = '0x0000000000000000000000000000000000000000'

const ZERO_ADDRESS: string = '0x0000000000000000000000000000000000000000'

// Same root every .etn namehash in this app is built from — ETNNamehash.ETN_NODE
// (contracts/EnsSubdomainService/ETNNamehash.sol). Kept in sync by hand (that library is all
// `internal`, no deployed bytecode of its own to call into from a script) — see
// deployMarketplaceV4.js's own comment on this same constant.
const ETN_NODE: string = '0x69a3977d40595dbc343e3fa6ddbd26dbe31cc237836622384941b3c5148974cd'

function computeNode(label: string): string {
  const labelHash = ethers.utils.keccak256(ethers.utils.toUtf8Bytes(label))
  return ethers.utils.keccak256(ethers.utils.concat([ETN_NODE, labelHash]))
}

// Initial ETN subname prices seeded atomically at deploy time — activates AND prices each node in
// one transaction. Only ever list a domain the deploying wallet genuinely owns on NameWrapper (on
// THIS network) — seeding has no ownership check, so seeding a domain you don't actually control
// would just be meaningless on-chain state. Empty by default — see this file's own header comment.
const INITIAL_PRICING: { label: string; priceEtn: string }[] = []

// Nodes exempt from the activation fee entirely. Empty by default, same reasoning as above.
const INITIAL_GOLDLIST: string[] = []

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

    console.log('Deploying PlanetZephyrosSubdomainServiceV4...')
    console.log('  registrarController:', REGISTRAR_CONTROLLER)
    console.log('  nameWrapper:        ', NAME_WRAPPER)
    console.log('  baseRegistrar:      ', BASE_REGISTRAR)
    console.log('  defaultResolver:    ', DEFAULT_RESOLVER)
    console.log('  projectWallet:      ', PROJECT_WALLET)
    console.log('  owner:              ', OWNER)
    console.log('  legacyMarketplace:  ', LEGACY_MARKETPLACE)
    console.log('  initial pricing:', INITIAL_PRICING.length === 0 ? '(none)' : '')
    for (const { label, priceEtn } of INITIAL_PRICING) {
      console.log(`    ${label}.etn -> ${priceEtn} ETN/year (node ${computeNode(label)})`)
    }
    console.log('  initial goldlist:', INITIAL_GOLDLIST.length === 0 ? '(none)' : '')
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
    console.log(`PlanetZephyrosSubdomainServiceV4 deployed to: ${result.address}`)

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
