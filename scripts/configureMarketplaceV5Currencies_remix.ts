// Wires up V5's multi-currency support on an already-deployed mainnet instance: coreToken/
// swapRouter (same proven values already live on PremiumSubscription and V3/V4), 9 whitelisted
// ERC20 payment tokens with a starting minSubnamePricePerYear floor each, and v3PoolForToken for
// the 4 tokens whose real liquidity lives in an ElectroSwap V3 pool instead of the plain V2
// swapRouter path. Run with the marketplace's OWNER account active in MetaMask — every call here
// is owner-only. Run AFTER deployMarketplaceV5_mainnet_remix.ts, with MARKETPLACE_ADDRESS below
// set to the address it printed.
//
// Token liquidity checked live 2026-09-15 against the SAME router (0x072D...FFd7)/its factory
// (0x203D...d15b):
//   BOLT, CORE, DYNO, PDY, FUGAZI  -> real V2 pool exists — plain swapRouter path, v3PoolForToken
//                                     stays address(0)
//   USDC, USDT, CLUB, DCNT         -> NO V2 pool; real liquidity is a V3 pool (0.3% fee tier, WETN
//                                     as token0 in every one of the four) on ElectroSwap's V3
//                                     factory (0xbf6bcbe2be545135391777f3b4698be92e2eb8ca) — pool
//                                     addresses below, v3PoolForToken set for each
//
// minSubnamePricePerYear starting values target roughly the same real-world floor the existing
// ETN minimum represents (1000 ETN/year ~= $0.98 at 2026-09-15's ETN/USD price), derived from
// each token's live pool ratio at that same timestamp. CLUB and DCNT have no independent USD
// price reference at all, so both default to a nominal placeholder (100 tokens) -- update these via
// setMinSubnamePricePerYear once real pricing for those two is known. Every value here (including
// v3PoolForToken itself) is owner-adjustable at any time after this script runs -- none of this is
// a one-time/locked-in decision.
import { ethers } from 'ethers'

const MARKETPLACE_ADDRESS: string = '0x2ac8363A60CB054A948CFdf8b34F3813E4528AE7' // the real, live, verified V5 deployment

// Same values already verified live on PremiumSubscription and V3/V4 (setupMainnetCoreBuyback_remix.ts).
const CORE_TOKEN_ADDRESS = '0x309B916b3A90cb3E071697Ea9680e9217A30066f'
const ROUTER_ADDRESS = '0x072D4706f9A383D5608BD14B09b41683cb95fFd7'

interface TokenConfig {
  symbol: string
  address: string
  decimals: number
  minPricePerYear: string // human units, converted to raw via decimals below
  v3Pool?: string // set only for a token with no V2 pool on ROUTER_ADDRESS's own factory
  note?: string
}

const TOKENS: TokenConfig[] = [
  { symbol: 'BOLT', address: '0x043fAa1b5C5FC9a7dc35171f290c29ECDE0cCff1', decimals: 18, minPricePerYear: '370' },
  { symbol: 'CORE', address: '0x309B916b3A90cb3E071697Ea9680e9217A30066f', decimals: 18, minPricePerYear: '60' },
  { symbol: 'DYNO', address: '0xEe432C220273e4F949007B4c1946562826Efa055', decimals: 18, minPricePerYear: '0.5' },
  { symbol: 'PDY', address: '0xc20d02538368D8F7deBeAeB99D9a8b4d4D1DDC1C', decimals: 18, minPricePerYear: '32000000000' },
  { symbol: 'FUGAZI', address: '0x075533AB8EeC6A6999F07C8bc2f1900eB8312e25', decimals: 18, minPricePerYear: '8' },
  { symbol: 'USDC', address: '0x3187deAd7A2Bd6770F5Fe81495D1B715926AAe6e', decimals: 6, minPricePerYear: '1', v3Pool: '0x2cB2Af7aef7AB4cc3228F9c55EE8542Cb323Ad8A' },
  { symbol: 'USDT', address: '0x48E722f1458b253c2FB0E573F939318D7Dbd54e7', decimals: 6, minPricePerYear: '1', v3Pool: '0x0CC625331C9b22D94fEF29d462aB1c9B26dFF196' },
  { symbol: 'CLUB', address: '0xC9FC4AB00911793D99b5c7Bd01f01203C21D4131', decimals: 18, minPricePerYear: '100', v3Pool: '0x86566c3c78424e3c3c2aDb274FAB551B7262E0ca', note: 'PLACEHOLDER price -- no independent price reference. Adjust once known.' },
  { symbol: 'DCNT', address: '0xE74e4E7A064310466f3bdBd3F3Ce4e8c8F7CF1d5', decimals: 18, minPricePerYear: '100', v3Pool: '0x6cDF9e7c8177BFCEc940E3f195ACf5a9C04ae3CD', note: 'PLACEHOLDER price -- no independent price reference. Adjust once known.' },
]

const MARKETPLACE_ABI = [
  'function setCoreToken(address _coreToken) external',
  'function setSwapRouter(address _swapRouter) external',
  'function setPaymentTokenWhitelisted(address token, bool allowed) external',
  'function setMinSubnamePricePerYear(address token, uint256 minPricePerYear) external',
  'function setV3PoolForToken(address token, address pool) external',
  'function coreToken() view returns (address)',
  'function swapRouter() view returns (address)',
  'function whitelistedPaymentTokens(address) view returns (bool)',
  'function minSubnamePricePerYear(address) view returns (uint256)',
  'function v3PoolForToken(address) view returns (address)',
]

;(async () => {
  try {
    if (!MARKETPLACE_ADDRESS) {
      throw new Error('Set MARKETPLACE_ADDRESS at the top of this script before running.')
    }

    const provider = new ethers.providers.Web3Provider(web3Provider)
    const signer = provider.getSigner()
    const signerAddress = await signer.getAddress()
    console.log('Using account (must be marketplace OWNER):', signerAddress)

    const marketplace = new ethers.Contract(MARKETPLACE_ADDRESS, MARKETPLACE_ABI, signer)

    console.log('\nSetting coreToken...')
    const setCoreTx = await marketplace.setCoreToken(CORE_TOKEN_ADDRESS, { gasLimit: 100000 })
    await setCoreTx.wait()

    console.log('Setting swapRouter...')
    const setRouterTx = await marketplace.setSwapRouter(ROUTER_ADDRESS, { gasLimit: 100000 })
    await setRouterTx.wait()

    for (const t of TOKENS) {
      console.log(`\n${t.symbol} (${t.address})${t.note ? ' -- ' + t.note : ''}`)

      console.log(`  Whitelisting...`)
      const whitelistTx = await marketplace.setPaymentTokenWhitelisted(t.address, true, { gasLimit: 100000 })
      await whitelistTx.wait()

      const rawMinPrice = ethers.utils.parseUnits(t.minPricePerYear, t.decimals)
      console.log(`  Setting minSubnamePricePerYear to ${t.minPricePerYear} ${t.symbol}...`)
      const minPriceTx = await marketplace.setMinSubnamePricePerYear(t.address, rawMinPrice, { gasLimit: 100000 })
      await minPriceTx.wait()

      if (t.v3Pool) {
        console.log(`  Setting v3PoolForToken to ${t.v3Pool}...`)
        const v3PoolTx = await marketplace.setV3PoolForToken(t.address, t.v3Pool, { gasLimit: 100000 })
        await v3PoolTx.wait()
      }
    }

    console.log('\n--- Verifying ---')
    const coreToken = await marketplace.coreToken()
    const swapRouter = await marketplace.swapRouter()
    console.log('coreToken():', coreToken, coreToken.toLowerCase() === CORE_TOKEN_ADDRESS.toLowerCase() ? 'OK' : 'MISMATCH')
    console.log('swapRouter():', swapRouter, swapRouter.toLowerCase() === ROUTER_ADDRESS.toLowerCase() ? 'OK' : 'MISMATCH')

    for (const t of TOKENS) {
      const [isWhitelisted, rawMinPrice, v3Pool] = await Promise.all([
        marketplace.whitelistedPaymentTokens(t.address),
        marketplace.minSubnamePricePerYear(t.address),
        marketplace.v3PoolForToken(t.address),
      ])
      const formatted = ethers.utils.formatUnits(rawMinPrice, t.decimals)
      const v3Ok = t.v3Pool ? v3Pool.toLowerCase() === t.v3Pool.toLowerCase() : v3Pool === '0x0000000000000000000000000000000000000000'
      console.log(`${t.symbol}: whitelisted=${isWhitelisted} minPricePerYear=${formatted} v3Pool=${v3Pool} ${v3Ok ? 'OK' : 'MISMATCH'}`)
    }

    console.log('\nDone.')
  } catch (e) {
    console.log(e.message)
  }
})()
