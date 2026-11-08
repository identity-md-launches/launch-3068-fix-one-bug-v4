# V3 + V4 pool monitor and arbitrage on Robinhood Chain

Corrected `encodeV4Swap()` and `buildCalldata()` for a two-swap Uniswap V4 round trip
(USDG → PONS → USDG) through the Universal Router `0x8876789976dEcBfCbBbe364623C63652db8C0904`
on chain 4663, with the evidence for the fix.

The deliverables are [`index.html`](index.html) and [`js/v4-arb-encoder.js`](js/v4-arb-encoder.js):
plain JavaScript and the existing vendored ethers v5, with no install or CDN required.

## Follow-up 6: All-pairs scanner, Manual mode (one-shot), hardening, Worker fallback

**Mode** now offers **Auto-scan** (unchanged), **All pairs** (new) and **Manual** (re-added as a
one-shot read). All V3 and V4 execution code, the monitor architecture of Auto-scan, the page layout,
the wallet transfer and the activity log are unchanged; the 184 Node tests and 91 Foundry tests of
the earlier follow-ups still pass alongside the new ones.

### All pairs

Token A (one field) against a **Token B list** (textarea, one address per line; default WETH
`0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` and USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`),
plus Window, Protocol and a **WATCH** button (`createAllPairsMonitor`, `parseTokenList`).

- **Discovery, once per list change, one JSON-RPC batch:** for every Token B the pair is sorted by
  BigInt; V3 `factory.getPool(token0, token1, fee)` for fees 100, 500, 3000, 10000; V4 `poolId` for the
  seven tiers and `getLiquidity(poolId)` read through `PoolManager.extsload` at the liquidity slot
  (`keccak256(abi.encode(poolId, 6)) + 3`, Uniswap's `StateLibrary.LIQUIDITY_OFFSET`; the deployed
  PoolManager exposes no `getLiquidity(bytes32)` just as it exposes no `getSlot0`). Non-zero results
  are kept (`liquidityStorageSlot`, `encodeLiquidityCall`, `decodeLiquidityWord`).
- **Per poll (30 s), one batch:** latest block + **ONE** `eth_getLogs` with `address = [all V3
  pools]`, `topics = [0xc42079f9…]` + **ONE** `eth_getLogs` with `address = PoolManager`, `topics =
  [0x40e9cecb…]`, both over the window; V4 logs are filtered to our pool ids client-side. Then the
  existing phase-2 health batch: swap-block timestamps (staleness as before), `liquidity()` of active
  V3 pools, slot0 of active V4 pools. Price = 1.0001^tick of the latest swap, shown as currency1 per
  currency0 after decimals, with the pair's symbols.
- **Pool table:** Token B | Fee | Price | Swaps | Active? | Last Swap | Protocol.
- **Spread table:** every pairwise combination of tradeable pools (`allPairsSpreads`). **Path** reads
  e.g. `V3 0.05% (WETH) → V3 0.30% (USDG)`. Same-pair rows are the existing executable spreads
  (click → quote → dry run → send, unchanged code path). Rows across different Token Bs are tagged
  **3-LEG**, watch-only, no click: they compare Token A's price in two different quote tokens, which
  a two-pool route cannot capture. Auto mode uses `allPairsAutoDecision`: same pair, same protocol only.

### Manual mode (one-shot)

Pool A + Pool B addresses and **READ PRICES**: one read, no polling (`manualMonitor.readOnce`).
Each pool answers `token0()`, `token1()`, `fee()`, `slot0()` and now `liquidity()` (10 `eth_call`s,
one at a time), symbols and decimals once. One spread row: GREEN rows execute through the existing
V3 path; a pool with `liquidity() == 0` is shown **EMPTY** and the row cannot be selected or
auto-executed. The follow-up 5 polling API (`start`) still exists for callers that want it.

### Hardening

- **30000/600 filter:** a V4 pool whose latest tick is ≤ -887000 is **EMPTY** (`DRAINED_TICK`,
  `isDrained`) and excluded from spreads and auto mode; the live 30000/600 PONS/USDG pool sits at
  -887272. V3 pools are not filtered.
- **Gas estimate:** after a quote, `Gas: ~$X (250K gas V3 / 400K gas V4 × eth_gasPrice)` (a mixed
  route is two transactions: 650K) and `Net after gas: $Y` (`estimateGasCost`, `netAfterGas`,
  `fetchEthUsd`). Dollars assume **USDG = $1**; ETH is priced from the first V3 WETH/USDG pool with
  liquidity (tiers 500, 3000, 100, 10000). When currency1 is neither USDG nor WETH, or no such pool
  exists, the line says the USD figure is unavailable instead of guessing. For V4/V4 routes the
  return leg is quoted for display only; the minimum return the transaction enforces is unchanged.
- **Multi-tab lock:** `localStorage["ponsarb_lock"] = Date.now()` on send; on load a value younger
  than 5 minutes written by another tab shows the banner **Another tab active** and disables dry run,
  send and auto mode; `beforeunload` clears the tab's own lock (`createTabLock`). A tab never clears
  another tab's lock.
- **REVOKE ALL** (Section 2, shown when connected): `approve(SwapRouter02, 0)` then
  `approve(Permit2, 0)` for the input token (currency1), each simulated, sent and confirmed before the
  next; allowances already at 0 are skipped (`wallet.revokeAll`). Permit2's own allowance table is not
  touched: with the ERC20 allowance at 0 the router cannot pull anyway; re-approve to trade again.

### RPC and Worker fallback

`RPC_URL` is now the brief's primary, `https://rpc-robinhood.blockmachine.io`; `RPC_FALLBACK_URL` is
`https://robinhood.drpc.org`; the earlier `https://rpc.mainnet.chain.robinhood.com` stays as
`RPC_LEGACY_URL`. The page's RPC client (`createRpcClient(..., { fallbackUrl })`) retries the same
payload once against the fallback on HTTP 429 or 5xx and returns whichever succeeds; when both fail
the primary's error is reported with the fallback's. `worker/rpc-proxy.js` is the same rule as a
Cloudflare Worker (service-worker syntax, `worker/wrangler.toml`): POST JSON-RPC only, bodies
forwarded unchanged (batches included), CORS headers, `x-rpc-upstream` / `x-rpc-fallback` headers.
It is **not deployed** by this job; to use it, deploy it from the operator's own Cloudflare account
and point `RPC_URL` at the Worker.

### Follow-up 6 verification

- `node --test js/test/*.test.js`: 202 cases. New: `allpairs.test.js` (list parsing, liquidity slot,
  All pairs discovery and single-filter polling with pools from two Token Bs, V3/V4-only, back-off,
  the drained-tick filter at -887272, gas estimate, multi-tab lock, client fallback, REVOKE ALL),
  `worker.test.js` (healthy primary, 429/5xx/network fallback, relayed errors, input validation), and
  UI tests for All pairs, the lock banner, REVOKE ALL and the manual EMPTY row. Two follow-up 5 UI
  assertions changed with the brief: Manual mode no longer schedules a poll and reads 10 calls.
- `forge build`, `forge test` (107 tests, 5 suites) with the fuzz seed given for this job and
  `forge fmt --check` pass with the unchanged pinned solc 0.8.26. `src/AllPairsScanner.sol` and
  `test/AllPairsScanner.t.sol` cover the liquidity slot, the drained-tick rule, pairwise counts and
  3-LEG tagging, executable-route checks, gas units/cost/net and the lock freshness rule, success and
  failure paths, 4 fuzz tests.
- Live: the three RPC endpoints answered `eth_chainId = 0x1237` on 2026-11-08. No transaction was
  sent and no live poll was recorded for this follow-up.

### Follow-up 6 assumptions and deployment

| Item | Value |
| --- | --- |
| Primary / fallback RPC | `https://rpc-robinhood.blockmachine.io` / `https://robinhood.drpc.org`, embedded; no key |
| Worker | `worker/rpc-proxy.js`, optional, deployed by the operator (`npx wrangler deploy` in `worker/`); not deployed here |
| V4 liquidity read | `extsload(slot0Slot + 3)`; relies on the deployed PoolManager's standard `pools` layout at slot 6 |
| Drained tick | -887000 inclusive, V4 only |
| Gas budget | 250K V3, 400K V4, 650K mixed, times `eth_gasPrice`; a display estimate, not a limit set on the transaction |
| Dollar prices | USDG = $1; ETH from the V3 WETH/USDG pool's tick; others unavailable |
| Lock | `localStorage` key `ponsarb_lock`, 5 minutes; same browser profile only, not across devices |
| Default Token B list | WETH, USDG (user-editable) |

Operators remain responsible for the Worker's deployment and its Cloudflare account, for watching
both RPC providers' rate limits, for the fact that cross-pair 3-LEG rows are hints and not routes,
for re-approving after REVOKE ALL, and for everything listed under "Operational responsibilities".

## Follow-up 5: Manual pool mode (eth_call only)

A **Mode** field at the top of the page selects **Auto-scan** (everything the page did before,
unchanged, the default) or **Manual**. In Manual mode the Token A, Token B, Protocol and Window
fields are hidden and two fields take their place: **Pool A** and **Pool B**, each a V3 pool
contract address (`0x` and 40 hex digits). **READ PRICES** replaces WATCH PAIR. Switching the mode
stops the other mode's polling at once, so no `eth_getLogs` is sent while Manual is selected.

### What is read, and how often

Every 30 s the page sends, for each pool, four plain `eth_call` requests, one HTTP POST each and
in this order: `token0()`, `token1()`, `fee()`, `slot0()`. That is **8 eth_calls per poll**. On the
first successful read of a pair it also reads `symbol()` and `decimals()` of token0 and token1
(4 more calls), then caches them for as long as the page is open. Nothing else: no `eth_getLogs`,
no JSON-RPC batch, no `eth_getBlockByNumber`. A quote (click the row) and a dry run are one
`eth_call` each, on demand, through the existing V3 creation-call quote and router simulation.

The brief counts the four reads as "6 eth_calls (3 per pool × 2 pools)". Four reads per pool are
eight, and the brief's own total of "6-8 requests per 30 seconds" covers it. The immutable reads
are repeated on purpose: a pool whose address field changed is re-validated with the same code
path, and the cost is two requests per poll.

The brief's `slot0()` ABI has six outputs (`sqrtPriceX96, tick, protocolFee, lpFee, tickSpacing,
unlocked`). The pools deployed on chain 4663 answer with the canonical Uniswap V3 seven-word layout
(`sqrtPriceX96, tick, observationIndex, observationCardinality, observationCardinalityNext,
feeProtocol, unlocked`), verified with `cast call` on both test-vector pools. Both layouts start
with `sqrtPriceX96` then `tick`, which is all the page uses, so `decodeManualSlot0` reads those two
words and accepts either length. A reply shorter than two words is "Invalid pool address".

Price is `1.0001^tick` of slot0, shown as **token1 per token0** after decimals (the page has no
USD feed; the brief's "~$0.18" is PONS in dollars on DEXTools, which corresponds here to about
12 073 PONS per WETH). "Whether the pool has liquidity" is `sqrtPriceX96 > 0`, as the brief defines
it; it does not read `liquidity()`.

### Validation and messages

| Situation | Message | When it is checked |
|---|---|---|
| A field is not `0x` + 40 hex digits (a 66-char V4 poolId, a short paste, a non-hex character) | `Enter a 42-char V3 pool address` (prefixed `Pool A:` / `Pool B:`) | on READ PRICES, before any request |
| Any of the four reads reverts, returns no data, or returns values no V3 pool can have (unsorted or zero tokens, fee above 100%) | `Invalid pool address (0x…: token0() reverted)` | each poll |
| token0 or token1 differ between the pools | `Pools are different pairs` | each poll, before the liquidity check |
| Either pool's `sqrtPriceX96` is 0 | `Pool has no liquidity (Pool B 0x…)` | each poll |
| The same address in both fields | `Pool A and Pool B are the same pool` | each poll |
| The RPC fails (HTTP error, rate limit, timeout) | the RPC message, `RPC error, retrying in 60s` | each poll; the last good row stays visible |

Pool-level errors keep polling at the normal 30 s so a fix on chain (a pool being initialised)
shows up; RPC failures back off 60 s like Auto-scan. A node's JSON-RPC error is treated as a
revert; a rate-limit error (`-32005` or "rate limit" / "too many requests") is treated as an RPC
failure, never as a bad address.

### The spread row

One row: `Pool A (fee · price · address) | Pool B (fee · price · address) | Spread% | Fee Cost% |
Net% | Verdict`. Pool A is the lower-priced pool (buy token0 there) and Pool B the higher-priced;
if the pasted order is the other way round the labels swap and the line under the table says so.
Spread% = (high − low) / low × 100, Fee Cost% = (feeA + feeB) / 10000, Net% = Spread% − Fee Cost%,
GREEN when Net% is strictly above the existing threshold field (default 0.5). The arithmetic is the
existing `rankSpreads` code on two rows. Under the table: "Last read: Xs ago" (ticks every second
without a request), the pair's symbols, decimals and addresses, and both full pool addresses.

### Execution

Clicking the row runs the existing V3+V3 path unchanged: creation-call quote of swap 1 on the buy
pool, quote of the sell leg, APPROVE V3 ROUTER (ERC20 approve to SwapRouter02
`0xcaf681a66d020601342297493863e78c959e5cb2`), BUILD CALLDATA & DRY RUN, SEND, with the 20-minute
deadline, button locking and activity log. The token pair is token0/token1 read from the pools,
never the hidden Token A / Token B fields; the balances and the TRANSFER buttons follow the pools'
tokens too once they are loaded. The dry run keeps the existing check that
`V3Factory.getPool(token0, token1, fee)` equals the pasted address: SwapRouter02 routes by
(pair, fee) through the factory, so a pasted address that is not the factory's pool for its fee
tier can be watched but not traded. Fee tiers outside 0.01 / 0.05 / 0.30 / 1.00 % display but are
refused by the V3 path encoder. Auto mode treats the manual row like any GREEN V3/V3 spread.

### Test vectors, as the chain answers them

The brief lists `0x10cc6bd38112cac182db90b6a71d8bb5939526ba` as the 0.01% PONS/WETH pool. On
chain 4663 that contract's `fee()` returns **10000 (1.00%)**; the factory's 0.01% pool for
WETH/PONS is `0x0f5F5bCC08cAe61d19c9a2d2594C252f1Baddae6`. `0xed50bdeea8adc232f159486192a4157281d722ff`
is the 0.30% pool as stated. Both have token0 = WETH, token1 = PONS. Read on 2026-11-07
(`docs/manual-live.json`, produced by `node scripts/verify-manual-live.js`):

| Pool | fee() | tick | price (PONS per WETH) |
|---|---|---|---|
| `0x10cc…26ba` | 1.00% | 94218 | ≈ 12 349 |
| `0xed50…22ff` | 0.30% | 94267 | ≈ 12 410 |

Spread 0.491%, Fee Cost 1.30%, Net −0.81%, **RED** at that moment (an earlier `cast call` the same
day saw ticks 93992 and 94065, a 0.73% spread; the test fixtures use those). With the factory's
real 0.01% pool in Pool A the Fee Cost is 0.31% as the brief expects. The page prefills the brief's two addresses and shows
whatever the chain returns; the fixtures in `js/test/manual-mock.js` reproduce these live replies.

### Follow-up 5 verification

- **Offline:** `js/test/manual.test.js` (10 cases) covers the 42-character rule including a 66-char
  V4 poolId, the four selectors, both slot0 layouts, every validation message, the 30 s / 60 s
  schedule, exactly 8 `eth_call`s per poll with symbols cached, no logs, no batch, and the rows'
  compatibility with the V3 quote and auto decision. `js/test/ui.test.js` gains 3 page cases:
  field visibility and the single row, the full execution flow from the manual row (pasted in the
  wrong order), and the four error messages plus the threshold recolouring. All 184 JavaScript
  cases pass. `test/V3ManualPool.t.sol` (14 Foundry tests, 2 fuzz) covers the same checks in
  Solidity against pool-shaped mocks: success in both slot0 layouts, no code, a token instead of a
  pool, each of the four reads reverting, impossible token values, different pairs in both
  orders, no liquidity on either side, the same pool twice, malformed slot0 replies, and the
  42-character text rule. `forge build`, `forge test` with the verifier's seed and
  `forge fmt --check` pass (91 tests).
- **Live, read-only:** `scripts/verify-manual-live.js` read both brief pools through the public RPC
  with 12 `eth_call`s and nothing else; a token address in Pool A gave "Invalid pool address", a
  PONS/USDG pool in Pool B gave "Pools are different pairs". No transaction was sent in Manual
  mode; the execution path is the existing V3 one, exercised live in follow-up 4.

## Follow-up 4.1: batch polling

An active poll now sends **two HTTP POSTs**, regardless of the number of active pools:

1. One JSON-RPC array containing the latest block header, V4 Swap logs when enabled, and V3
   Swap logs when enabled and discovery found pools.
2. One array containing each active pool's swap-block header and its existing health read:
   V4 `extsload` for slot0 or V3 `liquidity()`. No active pools means **one POST**; an empty
   JSON-RPC batch is never sent.

The window, tick prices, timestamp ages, status precedence, spreads, auto mode, quotes,
approvals, encoders, wallet transfers and UI are unchanged. Quotes remain individual `eth_call`
requests. Phase 1 errors keep the previous table and retry in **60 seconds**. Phase 2 failures
affect only the relevant health fields/pools; an HTTP failure for that phase leaves all active
pools UNKNOWN. Existing EMPTY/STALE precedence still applies to individual failed reads.
Successful polls, including ones with unknown health, schedule the next cycle in **30 seconds**.

### RPC API and fallback

```js
const rpc = V4ArbEncoder.createRpcClient(V4ArbEncoder.RPC_URL, fetch);
const monitor = V4ArbEncoder.createPoolMonitor({
  request: rpc.request,
  batchRequest: rpc.batchRequest,
  protocol: "Both",
});
await monitor.start(V4ArbEncoder.PONS, V4ArbEncoder.USDG);
// monitor.stop() cancels scheduled polling.
```

`batchRequest([{ method, params }, ...])` assigns sequential IDs shared with `request` and
returns values in **input order**, matching responses by ID. Reverted calls, missing replies,
duplicate IDs and malformed entries return `{ error }` at that index; RPC errors preserve
`message`, `code` and revert `data`. Response order is not assumed, as required by the
[JSON-RPC batch specification](https://www.jsonrpc.org/specification#batch).

Batch HTTP requests have a **30-second timeout** (`batchTimeoutMs`); individual calls keep
their 20-second timeout (`timeoutMs`). A single-object reply or batch rejection, including
an HTTP 400 JSON-RPC invalid-request error, switches that client to sequential requests.
Fallback waits **500 ms** after the rejection and between single calls, including phase
boundaries and concurrent fallback batches. The capability decision lasts until a new RPC
client is created (page reload). Individual call errors keep their positions and do not stop
successful sibling reads. HTTP 429/503, network failures, timeouts and malformed JSON fail
the batch rather than creating a burst of fallback requests; a later cycle still tries batching.

### Initialization and window assumptions

On start/restart, one setup batch reads token symbols/decimals, discovers V3 pools when enabled,
and seeds a block number. Setup is cached for subsequent polls: a cold start with active pools
uses **three POSTs total** (setup + the two poll phases); a regular active poll uses two.
This is necessary because an [`eth_getLogs` filter](https://ethereum.org/developers/docs/apis/json-rpc/#eth_getlogs)
cannot reference a sibling batch result or express `latest - N`.

Phase 1 scans from the previous observed head minus the chosen window through `latest`, then
discards logs outside `[max(0, newHead - window + 1), newHead]`. Thus newly mined blocks are
included and older over-fetched logs never affect swap counts or activity. Windows above
25,000 blocks use two disjoint filters per enabled protocol **inside the same POST**, reserving
room under the RPC's 50,000-block range limit for blocks mined between polls. After a very long
pause, a range failure retains the newly returned head, so the next retry uses a fresh bound.
A backwards head fails the poll and refreshes that bound for the retry instead of publishing
an incomplete window. Changing the window still takes effect on the next poll.

JSON-RPC batches are not atomic chain snapshots: `latest` calls may resolve at slightly
different heads. Logs beyond the returned header are excluded; swaps mined after a log query
has resolved are picked up next cycle. V4 health still reads `latest`, while V3 liquidity is
pinned to the returned header, as before. This remains a live monitor, not a finalized indexer.

### Verification and operations

`node --test js/test/*.test.js` covers reversed IDs, partial/missing/duplicate replies, empty
logs, inactive pools, both protocols, exact window boundaries, head regression, phase failures,
30/60-second scheduling, 30-second aborts, and sequential fallback with a virtual 500-ms clock.
Existing encoder, quote, wallet and UI tests run with the batch-aware mock RPC.

`node scripts/verify-batch-live.js` performs initialization and measures one subsequent read-only
poll. It validates IDs, swap counts, latest ticks, prices, timestamps and health against the raw
batch replies without extra verification requests. It sends no transactions and uses no wallet.
The saved [live result](docs/batch-poll-live.json), **2026-11-07 17:26:51 UTC**, records
**two HTTP 200 POSTs** at block **108578735**, window **3000**: three calls in phase 1, two in
phase 2. V4 3000/60 had five swaps, tick **-293279**, price **0.1835234940302618 USDG/PONS**,
and age **41 seconds**, status **OK**. Other selected V3/V4 pools were inactive in that window.
This is a dated observation, not a prediction of subsequent activity.

`forge build`, `forge test` with fuzz seed
`0xab52a62a4275149a83148f42337cc96dc5e14141fb093a4f0c5b65c0636b083b`, and
`forge fmt --check` pass using the unchanged pinned **solc 0.8.26** (77 Solidity tests).

No contract deployment, new dependency, owner setting or address change is required. Publish
`index.html` and `js/v4-arb-encoder.js` together on the existing static host, retaining the
vendored ethers asset. This repository uses the direct public RPC and contains no Worker.
If an operator uses an external proxy, it must forward JSON arrays unchanged and preserve its
retry-on-429 handling; its old per-request 500-ms delay may be removed. The client fallback's
500-ms delay must remain. Operators remain responsible for RPC/CORS availability, refreshing
cached assets, and the wallet/auto-mode responsibilities documented below.

## Follow-up 4: dual-protocol monitoring and execution

The same page now has **Protocol: V4 / V3 / Both**, default **Both**. Changing it restarts the
monitor and clears the selected quote and prepared transaction, just like changing the pair.
The selector is locked during wallet work. V4 keeps its seven tiers and existing encoder,
router-revert quote, Permit2 APIs, `buildCalldata`, `buildAtomicCalldata`, and transfer section.
V3 is added to `js/v4-arb-encoder.js`; the deployment path and vendored ethers version are unchanged.

### Decisions resolving the brief's contradictions

The rejected attempt identified ABI mismatches. This implementation resolves them rather than
requiring new addresses or leaving V3 disabled:

| Open issue | Decision and reason |
|---|---|
| `pool.getAmountsIn(uint256)` | The supplied V3 pools do not implement it. Quote the real pool's `swap` inside a reverting **creation `eth_call`**, with an ephemeral authenticated callback. No router, wallet, balance, approval, state override or deployed quoter address is needed. |
| `router.multiswap(...)` | The supplied router has standard SwapRouter02 `exactInput((bytes,address,uint256,uint256))`, selector `0xb858183f`. Wrap it in `multicall(uint256,bytes[])`, selector `0x5ae401dc`, so the 20-minute deadline is enforced on chain. A two-hop `exactInput` is one atomic transaction. |
| “Tick from the 7th data word” | Tick is argument 7, but sender and recipient are indexed. Decode tick from **data word 5** of the declared V3 event. The supplied topic is correct. |
| “115-byte path” | Follow the explicit `abi.encodePacked(tokenIn,uint24(feeA),tokenMid,uint24(feeB),tokenOut)` example: **66 bytes** = 20 + 3 + 20 + 3 + 20. Single-hop paths are 43 bytes. |
| “V3 first” for every mixed route | Execute **buy first, sell second**, regardless of protocol. Otherwise a V4-buy/V3-sell spread would require prefunded currency0 or trade in the wrong direction. Both orders are tested. |
| CASHCAT test address omitted | Use the address published by Robinhood only for the optional read-only verification, confirmed through on-chain metadata and the supplied factory. It is not a new deployment parameter or a hardcoded UI pair. |

The standard router interfaces and callback quote mechanism are described in Uniswap's
[V3SwapRouter](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/V3SwapRouter.sol),
[MulticallExtended](https://github.com/Uniswap/swap-router-contracts/blob/main/contracts/base/MulticallExtended.sol),
and [Quoter](https://github.com/Uniswap/v3-periphery/blob/main/contracts/lens/Quoter.sol).
These are interface references; this project does not download or depend on them at build time.

### Monitor and display

V3 discovery calls the supplied factory's `getPool` for fees **100, 500, 3000, 10000**, with the
tokens sorted by BigInt. Zero replies are excluded. Successful discovery is cached until a pair
or protocol restart, including across a later log-scan failure; it is not repeated each poll.
An unsuccessful discovery is retried after 60 seconds. Newly created pools therefore require
**WATCH PAIR** (or a protocol change) to rediscover them.

Each poll reads the latest block and the enabled protocols' logs in one HTTP batch, as described
in follow-up 4.1 above. V3 uses an address-array filter and both protocols share the displayed
window and head. An empty V3 address array is never sent. Each active V3 pool gets a swap-block
timestamp read and `liquidity()` at that head; zero liquidity means **EMPTY**. A failed health read
means **UNKNOWN**, and excess elapsed time means **STALE**, using the existing status functions.
Only OK pools reach spreads. Inactive pools are shown but have no price and get no health reads.
Latest-block/log errors preserve the last successful table and use the existing 60-second retry;
individual health failures do not fail the whole poll. Normal cadence remains 30 seconds.

The pools table has an appended Protocol column and V3 fees are shown as 0.01%, 0.05%, 0.30%, 1.00%.
Prices use the latest swap tick, `1.0001^tick`, scaled by token decimals. The spreads table identifies
each leg's protocol. **Both shows every pairwise combination** of tradeable pools; single-protocol
modes retain the top-five presentation. Pool A is always the lower-price buy, Pool B the sell.
Sorting addresses can change which token is the input: for PONS/WETH, currency1 is **PONS**.

### Quotes, approvals and transactions

`src/V3Quote.sol` supplies the creation-call quote code. Its constructor resolves the pool from
the fixed factory, checks liquidity, creates a temporary callback receiver and calls the pool's
real swap. The authenticated callback reverts with input used and output received before payment.
All temporary creations and pool effects revert. Partial nonzero fills are rejected by the client;
zero output displays the no-liquidity warning and disables execution. Unexpected replies and RPC
failures are errors, never estimates from tick prices. **This code is not a contract to deploy.**
The constructor always reverts, even on successful quotes; no launch manifest is needed.

The quote bytecode is embedded in the existing encoder file. To rebuild it after changing the
Solidity source, run `forge fmt`, `forge build`, then `node scripts/embed-v3-quote.js`.
`node scripts/embed-v3-quote.js --check` verifies it matches the pinned compiler's artifact.
The served page needs no artifact fetch and no network dependency other than RPC.

| Selected route | Approval | Execution |
|---|---|---|
| V4 → V4 | Existing two-token Permit2 flow | Unchanged `buildCalldata`, two V4_SWAP commands in one transaction |
| V3 → V3 | Input token's ERC20 allowance to V3 Router | One two-hop `exactInput` in deadline-bearing `multicall`; the router forwards the full first-hop output |
| V3 → V4 | currency1 → V3 Router, currency0 → Permit2 | V3 single hop, confirmed receipt, V4 single swap |
| V4 → V3 | currency1 → Permit2, currency0 → V3 Router | V4 single swap, confirmed receipt, V3 single hop |

**APPROVE V3 ROUTER** checks the direct ERC20 allowance and grants only 100× that leg's input.
Sufficient limits are skipped. An insufficient nonzero allowance is reset to zero first for tokens
that require it; every approval receipt must succeed before the next prompt. Empty ERC20 return
data is supported; `false` is rejected. V3 never needs Permit2. In mixed routes the Permit2 button
approves only the V4 leg's input, with the same 100× cap and 30-day expiry. Its underlying ERC20
allowance to Permit2 remains a prerequisite, as before. Both approval controls are visible in Both
mode; a control irrelevant to the selected route is disabled.

For any route involving V3, both legs are quoted. The bridge display is buy output minus **0.5%**.
An atomic V3 route quotes the sell with the **full** first-hop output, because that is what the
router forwards. A mixed route quotes the sell with the protected bridge amount, and leaves any
extra first-leg output in the wallet. The final minimum is the larger of the user's field and
the sell quote minus 0.5%; entering zero cannot remove this floor. V4-only's minimum-return
behavior stays unchanged. A nonzero minimum is not a profit guarantee or a gas-cost allowance.

Mixed routes visibly warn **“2 transactions required”** and are **manual-only**. Preparing them
checks both approvals and simulates leg 1; leg 2 cannot be simulated with funds that have not yet
arrived. Sending re-simulates leg 1, waits for its successful receipt, checks the actual increase
in bridge balance, then rechecks the session, deadline and leg-2 allowance before simulating and
submitting leg 2. A failure at any stage stops the sequence. If leg 1 confirmed, its hash and the
remaining bridge balance are shown; restarting the whole route is never automatic. Interrupted
confirmations retain their pending hash. The common deadline is latest chain timestamp + 1200 s.

Auto mode chooses the best eligible **same-protocol** GREEN spread across both protocols; a higher
mixed spread cannot trigger two transactions or conceal an eligible atomic opportunity. Existing
receipt locking, auto-failure handling, wallet-session checks and balance transfers are retained.

### Fixed chain configuration and After launch

| Parameter | Value |
|---|---|
| Chain / RPC | 4663 / `https://rpc.mainnet.chain.robinhood.com` |
| V3 Factory | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| V3 SwapRouter02 | `0xcaf681a66d020601342297493863e78c959e5cb2` |
| V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| V4 Universal Router | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| WETH, 18 decimals | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` |
| USDG, 6 decimals | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` |
| PONS, 18 decimals | `0x39dbed3a2bd333467115de45665cc57f813c4571` |

There is no new owner, recipient, key, deployment, token or external quoter setting to supply.
The connected wallet is the payer and recipient; pair metadata is read from the selected tokens.
Serve/publish the same root `index.html`, `js/v4-arb-encoder.js` and existing `js/vendor/` assets
over HTTP(S). The source, tests and scripts need not be served. No deployment or wallet transaction
was performed in this assignment.

After publishing, the operator connects an EIP-1193 wallet on 4663, checks token addresses and
amounts, funds gas and input tokens, approves the appropriate spenders, and reviews the dry run.
For a failed/interrupted mixed route the operator must inspect both transaction hashes and the
remaining bridge balance before deciding how to unwind or retry; leg 1 cannot be rolled back.
Approvals should be revoked when no longer needed. Fee-on-transfer/rebasing tokens are unsupported;
the balance-increase guard stops a mixed second leg if its funding is short. RPC availability,
price changes, transaction inclusion and ongoing independent security review remain operational
responsibilities. The V4 slot0-based EMPTY limitation documented in follow-up 3.5 remains unchanged.

### Follow-up 4 verification

Offline checks (no installed packages, environment-based test configuration or network required):

```sh
forge build
FOUNDRY_FUZZ_SEED=0x7f2de0555d9e356f083f3341b9bd4a95f44c5b3fcc0daea7edd349a826cf65c9 forge test
forge fmt --check
node scripts/embed-v3-quote.js --check
node --test js/test/*.test.js
```

Foundry tests exercise the actual quote callback, both directions, rollback, missing pools, empty
liquidity, partial fills, invalid callers/deltas and propagated pool failures, including fuzzing.
JavaScript tests exercise discovery/caching/retry races, log ABI and call counts, all statuses,
independent path/calldata decoding, approval success/rejection/reversion/timeout, immutable
preparations, deadline/session/allowance changes, both mixed orders, post-first-leg failures,
protocol switching, display, locking and atomic-only auto mode. Existing V4 tests remain; the old
UI fixture gained an empty V3 factory and its column-count assertion now includes Protocol.
The UI tests execute the actual page script against a small DOM mock, not a real browser extension.

Live read-only observations are in [`artifacts/follow-up4-live.json`](artifacts/follow-up4-live.json)
and [`artifacts/follow-up4-live-50000.json`](artifacts/follow-up4-live-50000.json), with pinned blocks,
addresses, raw quote amounts and window sizes. At the 3000-block snapshot `0x677d861`, PONS/WETH
had active V3 3000/10000 pools and a **0.662% gross spread** (negative after their 1.3% combined fees).
WETH/USDG had active V3 100/500 pools; PONS/USDG retained its active V4 pool. CASHCAT had no swaps
in that short window, so its pools correctly appeared inactive. The longer-window snapshot records
its active pools without changing the default window or inventing a live spread.

Optional reproduction (all calls are read-only; never part of offline tests):

```sh
node scripts/verify-v3-live.js
node scripts/verify-v3-live.js 0x020bfC650A365f8BB26819deAAbF3E21291018b4 --window=50000
```

The optional CASHCAT address is from
[Robinhood's Cash Cat asset statement](https://robinhood.com/ca/en/support/articles/crypto-asset-statements-cashcat/),
verified by `symbol()`/`decimals()` and factory discovery on 4663. Activity and spreads vary with
the head and window; the brief's sample volumes/spreads are not assertions. Live checks confirm
monitoring and pool quotes, not a funded-wallet execution or an independent security audit.

## Follow-up 3.5: window, staleness, slot0 check

The 100-block window showed almost nothing, so the monitor now reads a wider, user-set window and
says how old each pool's last swap is. Three things differ from what the brief assumed; all three
were measured read-only on the live chain on 2026-11-07.

**1. The PoolManager has no `getSlot0`.** `eth_call` of `getSlot0(bytes32)` on
`0x8366a39C…e40951` reverts with empty data, and selector `0xc815641c` is not in its bytecode. Called
as written, every active pool would be UNKNOWN and there would never be a spread. The page reads the
same value the way Uniswap's own `StateLibrary.getSlot0` does: one `eth_call` of
`PoolManager.extsload(keccak256(abi.encode(poolId, 6)))`, unpacked by `decodeSlot0` into the brief's
`(tick, sqrtPriceX96, protocolFee, lpFee)`. Same contract, same number of calls, same meaning.

**2. `sqrtPriceX96 == 0` does not detect an empty pool that has ever traded.** Zero means "never
initialised", and such a pool cannot have a swap in the window, so EMPTY will rarely if ever appear
in practice. The real empty pool passes the check: PONS/USDG 30000/600 has liquidity 0 and
`sqrtPriceX96` at the protocol minimum (tick −887272, price about 3e-27). When its last swap is in
the window (for example at 50 000 blocks) it is **OK**, and its spreads top the table as **GREEN**
with a net near 6e27%. No funds are at risk from this: the quote returns 0, sending stays disabled,
and in auto mode that failed attempt **turns auto mode off**. Checking `liquidity` as well would fix
it; that goes beyond the brief's rule, so it is left for the requester to decide.

**3. Blocks are about 0.105 s apart**, so block counts are short in time:

| Window | Time covered | PONS/USDG result on 2026-11-07 |
|---|---|---|
| 3 000 (default) | about 5 min | 1 active pool (3000/60): "No tradeable spreads" |
| 50 000 (maximum) | about 88 min | 3 active pools: 3000/60, 2500/25, 30000/600 |

A swap older than the window makes its pool **inactive**, not stale, so at the largest window nothing
can be older than about 88 minutes. The default 7200 s limit therefore does not trigger on this chain,
and the red colour (over 2 h) cannot appear. STALE becomes reachable by setting Max staleness below the window's
span. These defaults are the brief's and are unchanged.

### What changed

- **Window (blocks)**: field in section 1, default 3000 (`LOG_WINDOW_BLOCKS`), whole numbers from 50
  to 50000. The next poll uses a new value with no restart. An invalid entry keeps the last valid
  value and says so. The status bar shows the current value at once, and the poll line shows the window
  and block range the last poll used. It stays editable during a pending transaction.
- **Polling**: `eth_blockNumber` is gone. Each poll is `eth_getBlockByNumber("latest", false)`, one
  `eth_getLogs`, then for each active pool one `eth_getBlockByNumber(lastSwapBlock, false)` and one
  slot0 `eth_call`: 2 + 2 × active pools RPC calls, now grouped into two HTTP batches by
  follow-up 4.1 above. Timestamps are not cached.
- **Last Swap** column: latest block timestamp minus the swap block's timestamp, as `Xm ago` or
  `Xh Ym ago`, rounded down to the minute; green under 30 min, yellow from 30 min to 2 h inclusive, red above.
- **Max staleness (seconds)**: beside the threshold, default 7200, applied to the table at once. It
  locks with the threshold during a transaction. An invalid entry keeps the last valid value, so a typo
  cannot loosen the guard while auto mode is on. Exactly at the limit is not stale.
- **Pool marks**, in the Active? column as `yes · STALE`, `yes · EMPTY` or `yes · UNKNOWN`. Price and
  swap count stay visible. The price is still `1.0001^tick` of the last Swap log; slot0's tick is never shown.

| Mark | Condition |
|---|---|
| EMPTY | slot0 read succeeded and `sqrtPriceX96 == 0` |
| STALE | elapsed above Max staleness |
| UNKNOWN | the slot0 read failed or was malformed, or the swap block read failed or returned nothing |

  A definite fact wins over a failed read, in that order. One pool's failed read never fails the poll or
  triggers the 60 s back-off. Failure of the latest block or `eth_getLogs` still does, as before.
  The brief names only slot0 for UNKNOWN; a failed swap block read is treated the same way, because
  without the timestamp the pool's freshness cannot be shown.
- **Spreads** use only active pools with none of those marks. Fewer than two gives **"No tradeable
  spreads"**. Columns, top 5 and GREEN/RED are unchanged.
- **Auto mode** fires on the best GREEN spread whose two pools are both tradeable. An excluded pool in a
  better GREEN spread is logged, e.g. `auto skipped: pool 3000/60 stale (3h 12m)`, once per pool until
  its status changes or auto mode is switched on again. A skip is not a failure and leaves auto mode on.
- **Repair**: a poll still in flight when the pair changes now writes only to its own discarded state.
  The extra per-pool calls made that existing race more likely.

Unchanged: the 30 s cadence, the 60 s retry, the router-revert quote, dry run → send, Permit2, button
locking, the 20-minute deadline, wallet transfers, balances and the activity log. A spread already
selected keeps its Dry run and Send buttons if one of its pools later gets a mark; that guard covers
the table and auto mode, as the brief says, and each send is still simulated first.

New in `js/v4-arb-encoder.js`: `formatElapsed`, `formatDuration`, `stalenessColor`,
`parseWindowBlocks`, `parseMaxStaleness`, `slot0StorageSlot`, `encodeSlot0Call`, `decodeSlot0`,
`poolStatus`, `annotatePools`, `autoDecision`. `createPoolMonitor` now takes `windowBlocks` and
`maxStalenessSeconds` as a number or a function read on every poll.

### Follow-up 3.5 verification

- **Offline:** 34 monitor cases and 22 page cases, the last group of each new, cover the success and failure paths
  above: call counts, live window changes, each boundary, EMPTY, UNKNOWN and recovery, skip logging, and
  the race. Seven deliberate code mutations were each caught. The DOM is a minimal mock, not a browser; no browser or real
  wallet was run.
- **Foundry:** `src/V4PoolMonitor.sol` mirrors the window bounds, Slot0 layout, colours and statuses,
  with 11 new tests (3 of them fuzz) pinned to the live Slot0 words.
- **Live, read-only:** the real `createPoolMonitor` ran against the public RPC at 3 000 and 50 000 blocks with
  the results in the table above. `eth_getLogs` answered the full 50 000-block range. Nothing was sent.

## Follow-up 3: live pool monitor, arbitrage execution, wallet transfer

The window, polling calls and pool table below were updated by follow-up 3.5 above.

The static pool inputs are gone. The page now watches a token pair, ranks the spreads between its
pools, quotes the selected route, and runs the unchanged Permit2 → dry run → send flow against the
selected pools. A bottom section moves whole balances to a new wallet. Serve and open the page as
described in the Permit2 section below; nothing else changed in hosting.

### Token pair

Two fields, **Token A** and **Token B**, default to PONS and USDG. **WATCH PAIR** restarts the monitor
for whatever addresses are in the fields. The page reads `symbol()` and `decimals()` of both tokens
and sorts them by numeric (BigInt) comparison: the lower address is `currency0`, as the PoolManager
requires. For PONS/USDG that gives currency0 = PONS, currency1 = USDG, matching the encoder's
defaults. Identical, zero or malformed addresses are refused before any request is made; a token
without `symbol()` is reported in the status bar and retried.

### Polling

Every **30 s** the page, through the public RPC `https://rpc.mainnet.chain.robinhood.com` (no wallet
needed), reads the latest block and does one `eth_getLogs` on the PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951` for the window (default **3000 blocks**), topic0 =
`0x40e9cecb…ad7112f` (the V4 `Swap` event) and topic1 = the seven pool ids of the pair:

| Fee | Tick spacing | Pool id = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, 0x0)) |
|---|---|---|
| 0 | 1 | computed per pair |
| 0 | 10 | |
| 500 | 10 | |
| 2500 | 25 | |
| 3000 | 60 | PONS/USDG: `0x4be9657e…6c4f38a` |
| 10000 | 200 | |
| 30000 | 600 | PONS/USDG: `0x2e7ba084…50c39b6` |

The tick of each pool's latest swap in the window gives its price, `1.0001^tick` (currency1 per
currency0 in base units; the table shows it scaled by `10^(decimals0 - decimals1)`). A pool with no
swap in the window is **inactive** and has no price. Any failure in the cycle (HTTP error, JSON-RPC
error such as a rate limit, a malformed reply, a token without `symbol()`) is caught: the status bar
shows **"RPC error, retrying in 60s"** with the message, the last good table stays on screen, the
next attempt is scheduled after **60 s**, and polling never stops on its own. The seven pool ids are
one OR filter in a single `eth_getLogs`.

### Display

- **Pools table**: Fee · TickSpacing · Price (tick) · Swaps (window) · Active? · Last Swap.
- **Top 5 pairwise spreads** between tradeable pools: Pool A (buy) · Pool B (sell) · Spread% · Fee Cost% ·
  Net% · Verdict. Pool A is the pool with the **lower** price, where currency0 is cheaper (swap 1 sells
  currency1 there, `zeroForOne = false`); Pool B is the higher-priced pool (swap 2 sells currency0 there,
  `zeroForOne = true`). `Spread% = (high − low) / low × 100`. `Fee Cost% = (feeA + feeB) / 10 000`
  (fees are in hundredths of a basis point, so 3000 + 30000 = 3.3%). `Net% = Spread% − Fee Cost%`.
  **GREEN** when Net% is strictly above the threshold, **RED** otherwise. Price impact, gas and the
  0.5% slippage are not in Net%.
- **Balances**: Token A, Token B and ETH of the connected account at the top of the page, read on
  connect and again after every confirmed transaction (approval, swap, transfer).
- **Status bar**: last poll time, block, window, active count, or the RPC error and retry.

### Execute

Clicking a spread row fills the two `poolKey` objects (shown under *Selected pools*) and quotes
swap 1: the input amount of currency1 (default 0.01) sold on the buy pool. The quote is exact-input
and comes from the **PoolManager executing the swap inside an `eth_call` of the router**: the call
sets the router's `minHopPriceX36` to an unreachable value, so after the PoolManager has swapped the
router reverts with `V4TooLittleReceivedPerHopSingle(minHopPriceX36, actualPriceX36)`, selector
`0x4713c18b`, and `amountOut = actualPriceX36 × amountIn / 1e36`. Nothing is settled, so the quote
needs no allowance, balance or wallet, and it includes tick crossings and the LP fee. Verified live
on 2026-11-07: 0.01 USDG → **52 358 673 121 064 015** PONS base units on 3000/60, **0** on the
empty 30000/600 pool. A quote of **0** shows **"Warning: no liquidity"** and keeps approve, dry run
and send disabled. Otherwise the bridge amount is the quote minus **0.5%** (`applySlippage`,
50 bps), used as swap 1's minimum output and swap 2's exact input exactly as before. If the input
amount changes after a quote, the row has to be selected again.

**Dry run → send** is the existing flow with the selected pools: `prepareSwap()` builds with
`buildCalldata()`, checks both allowance layers for the pair, simulates with `eth_call`, and
`sendSwap()` re-simulates before `eth_sendTransaction`. The deadline is still 20 minutes.

**Auto mode** (checkbox, threshold field, default 0.5%): on every successful poll whose best spread is
GREEN and above the threshold, the page runs quote → dry run → send by itself; the wallet still
asks for the signature. One transaction at a time: while a quote, dry run, wallet prompt or receipt
wait is in progress every poll is ignored, so a 30 s cadence against a slow receipt cannot
double-fire. A receipt that does not arrive within the two-minute wait records the pending hash and
keeps auto mode off until you switch it on again. Any failed attempt (no liquidity, allowance
missing, rejected signature, revert) **switches auto mode off** and logs the reason; polling itself
continues. Auto mode never approves: do the one-time Permit2 approval first.

### TRANSFER TO NEW WALLET

Three buttons, **Transfer Token A / Transfer Token B / Transfer ETH**, send the **whole** balance of
that asset from the connected account to the address in *New wallet address*. The warning
"Sends ALL of this asset to the new address. Cannot undo." is shown, the current balances are shown,
and the buttons stay disabled until the wallet is connected, the acknowledgement box is ticked and
the address is valid, non-zero and different from the connected account. Token transfers call
`token.transfer(newAddress, balanceOf(account))`, simulated with `eth_call` first, for whatever
token is in the field. The ETH transfer sends `balance − 2 × (eth_estimateGas × eth_gasPrice)` with
those gas settings on the transaction, so up to that reserve stays behind as dust; it refuses when
the balance does not cover the reserve. Each result shows the transaction hash after a successful
receipt; a rejection, revert or timeout is reported as a failure and the balances are re-read.

### Unchanged

CONNECT WALLET; the Permit2 approval sequence (currency1/USDG then currency0/PONS, receipt confirmed
before the next, sufficient allowances skipped, ERC20 allowance to Permit2 checked first);
`buildCalldata()` and `buildAtomicCalldata()`; the activity log; the 20-minute deadline; the
simulation-before-send rule, button locking and wallet-change invalidation. The wallet client's old
signatures still work with PONS/USDG defaults; `prepareSwap` additionally accepts `buyPool`,
`sellPool` and `pair`, and `approveBothPermit2` / `checkAllowances` / `checkTokenAllowances` take an
optional `pair`.

### JavaScript API added in `js/v4-arb-encoder.js`

| Function | Purpose |
|---|---|
| `sortPair(tokenA, tokenB)` | `{ currency0, currency1 }` by BigInt order; refuses equal/zero/invalid |
| `poolKeysFor(c0, c1)`, `poolId(key)`, `FEE_TIERS` | the seven hookless keys and their ids |
| `tickToPrice(tick)` | `1.0001^tick` |
| `decodeSwapLog(log)`, `summarisePools(keys, logs)` | Swap-log parsing and the pools table |
| `spreadPercent`, `feeCostPercent`, `rankSpreads(pools, threshold, limit = 5)` | the spreads table |
| `applySlippage(amount, bps = 50)` | the bridge amount |
| `createRpcClient(url, fetch?, options?)` | `request(method, params)` and `batchRequest(calls)`; errors carry `code` and revert `data` |
| `quoteExactIn(request, { poolKey, zeroForOne, amountIn, from? })` | exact quote via the router's price-check revert |
| `createPoolMonitor({ request, batchRequest, pollIntervalMs, retryIntervalMs, windowBlocks, thresholdPercent, onUpdate, onError })` | `start(a, b)`, `stop()`, `pollOnce()`, `getState()` |
| wallet client: `readBalances(tokens, account?)`, `transferAllToken(token, to)`, `transferAllEth(to)` | balances and whole-balance transfers |

### Follow-up 3 verification

- **Offline:** 21 monitor/quote/transfer cases (`js/test/monitor.test.js`), 15 page cases
  (`js/test/ui.test.js`), the 43 Permit2 cases and 18 encoder cases still pass. They cover the
  30 s / 60 s schedule with recorded timers, rate-limit, HTTP and malformed-reply failures and the
  recovery after them, `stop()`, pair changes, the live quote vector, the no-liquidity path, the
  selected pools reaching `buildCalldata`, balances updating after a receipt, auto-mode threshold,
  single-fire under a held receipt, resume after it, switch-off after a failure and after a receipt
  timeout, and token/ETH transfers with their refusals. The DOM is a minimal mock, not a browser.
- **Foundry:** `src/V4PoolMonitor.sol` mirrors the arithmetic (pool ids, spread/fee/net in bps,
  slippage, the quote-revert decoding, Swap-log tick) and `test/V4PoolMonitor.t.sol` adds 20 tests,
  4 of them fuzz, pinned to the same vectors as the JavaScript (pool ids from `cast`, the live quote
  and its bridge amount). 57 Foundry tests pass with the verifier's seed; `forge fmt --check` passes.
- **Live, 2026-11-07, read-only:** the Swap topic equals `keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")`;
  one `eth_getLogs` with the seven ids over 100 blocks works on the public RPC; `extsload` of the
  PoolManager showed liquidity only on 2500/25 and 3000/60; the quote revert gave the amounts above
  from any `from` address; `eth_estimateGas` for a plain ETH transfer returned 21 000. Nothing was
  sent, no key was used.

## Permit2 follow-up: using the page

The supplied repository contained the corrected encoder but **no HTML file**. This follow-up adds
a root `index.html` using that encoder; it does not replace a supplied UI or change any Solidity,
build configuration, dependencies, token, router, or pool.

Serve the repository root as static files (for example, `python3 -m http.server 8080 --bind 127.0.0.1`)
and open `http://127.0.0.1:8080` in a browser with an EIP-1193 wallet. For hosting, publish the root
page and the `js/` directory together, preserving their relative paths. No frontend build is needed.

1. Select **Robinhood Chain, chain ID 4663**, in the wallet and click **CONNECT WALLET**.
   The reference wallet in the assignment is `0xd064E892A3BBb758053922C80098b7f4130444c6`.
   The actual connected account is always the approval owner, transaction sender, and recipient;
   nothing is sent to a hardcoded beneficiary. A wrong chain stops the flow.
2. The input is `ethers.utils.parseUnits("0.01", 6)` = **10,000 USDG base units**.
   The default PONS bridge amount is the explicitly permitted **fixed test amount**,
   `ethers.utils.parseUnits("0.001", 18)` = **1,000,000,000,000,000 base units**. This is not a
   quote. For other testing, enter swap 1's current quoted output minus your chosen slippage.
   The minimum USDG return defaults to **0 for testing** and can be raised in the page.
3. Click **APPROVE PERMIT2 (one-time)**. After checking the tokens' ERC20 allowances to Permit2,
   the page calls `Permit2.approve(token, router, amount, expiration)` for USDG and then PONS
   through the wallet's `eth_sendTransaction`. Each receipt must have status 1 before the next
   transaction is requested. The limits are **100 times the selected test amounts**: initially
   1 USDG and 0.1 PONS. Expiration is the latest block timestamp plus **30 days**, in seconds.
   Sufficient existing Permit2 allowances are skipped. These approvals are reusable, not perpetual:
   repeat only when needed after depletion, expiry, revocation, or an increase in the test amount.
4. Click **BUILD CALLDATA & DRY RUN**. The page uses `buildCalldata()` through `prepareSwap()`
   with the amounts above, the connected recipient and a **20-minute deadline**. It checks both
   allowance layers and calls the router with `eth_call` from that account. It displays the exact
   bytes and enables sending only on success. The atomic helper remains available, but cannot
   accept the requested zero minimum because it has no settlement action for a loss.
5. Click **SEND TRANSACTION**. The page rechecks the account, chain, allowances and deadline,
   repeats `eth_call` with the same transaction, and only then requests `eth_sendTransaction`.
   It reports confirmation only after a successful receipt. A rejection, revert, or failed dry run
   stops the flow. There is no force-send path. Amount edits, account/chain changes and disconnects
   invalidate a previous dry run. Buttons are locked during an operation to prevent duplicate sends.

Approvals are separate transactions: if USDG succeeds and PONS fails, USDG's allowance remains.
Retrying skips sufficient approvals. Receipt polling stops after two minutes; a timeout does **not**
cancel a pending transaction. The activity log retains its hash so the operator can check the wallet
or explorer before retrying. A wallet change during a pending transaction also does not cancel it.

### Both allowance layers are required

| Layer | Transaction destination | Approved spender | Needed for |
|---|---|---|---|
| ERC20 `approve(address,uint256)` | USDG / PONS token | Permit2 | Permit2 pulling tokens from the owner |
| Permit2 `approve(address,address,uint160,uint48)` | Permit2 | Universal Router | Router instructing Permit2 to pull those tokens |

The page implements the second layer requested in this follow-up. The reference wallet already had
the first layer for both tokens when checked. If another wallet lacks it, the page stops with the
token name and Permit2 address; its operator must first approve each token **to Permit2** using
that token's verified contract interface. Approving tokens directly to the router is ineffective.
The page never silently requests additional ERC20 approvals or unlimited allowances.

The ABI is checked against [Uniswap's AllowanceTransfer reference](https://developers.uniswap.org/docs/protocols/permit2/concepts/allowance-transfer).
`amount` is a `uint160`, expiration is a `uint48` Unix timestamp in seconds, and the approve selector
is `0x87517c45`. Values outside those widths are rejected before a wallet request.

### JavaScript wallet API

`V4ArbEncoder.approvePermit2(token, spender, amount, expiration)` is the requested four-argument
browser function. It connects to `window.ethereum`, submits to the pinned Permit2 address and
resolves to the successful receipt. It rejects on wallet errors, invalid parameters, expired
positive approvals, wrong network, missing code, a reverted receipt, or a confirmation timeout.

For a sequence, use one `V4ArbEncoder.createWalletClient(provider, options?)` instance, as the page
does. Its `approvePermit2()` has the same four arguments. Other methods are `connect()`,
`timestamp()`, `checkTokenAllowances(usdgIn, ponsAmount)`,
`approveBothPermit2(usdgLimit, ponsLimit, expiration)`, `checkAllowances(usdgIn, ponsAmount, validUntil?)`,
`prepareSwap({ usdgIn, ponsAmount, minUsdgOut, deadline? })`, `sendSwap(prepared)`, and `destroy()`.
`prepareSwap()` performs the build and dry run, and `sendSwap()` only accepts the most recent
prepared object, once. Returned transaction fields are frozen. `destroy()` detaches wallet listeners.
Options are `onStatus(message)`, `pollIntervalMs` (1000 by default) and `receiptTimeoutMs` (120000).
The page uses defaults; tests use a short polling interval.

To revoke a Permit2 allowance, the wallet owner can call
`approvePermit2(token, ROUTER, 0, 0)` for each token. Zero here explicitly revokes permission;
it is not an unknown deployment value. The underlying ERC20 allowance is independent and must be
revoked separately if desired. The generic approval helper supports the full uint160 range;
only the UI chooses the bounded, reusable limits described above.

### Follow-up verification

- **Offline:** 18 original JavaScript encoding cases, 43 Permit2/wallet cases and 8 UI event-handler
  cases. The tests load the actual page scripts, decode approval and swap calldata, confirm sequential
  receipts, and exercise partial completion, rejections, reverted receipts, pending timeouts,
  wrong networks, changed accounts, allowance expiry/depletion, missing ERC20 allowance, bad input,
  insufficient quoted output, stale deadlines and failed simulations. The UI harness is a minimal
  DOM, not a browser extension or rendering test. Mock RPC success is not evidence of AMM liquidity.
- **Foundry:** `forge build`, all 37 existing `forge test` cases (including 4 fuzz tests, 256 runs
  each with the assignment's seed), and `forge fmt --check`, using pinned solc 0.8.26.
- **Deployed-code integration, 2026-11-06:** verified chain ID, nonempty code at Permit2/router/tokens,
  and token symbols/decimals over the public RPC. Both Permit2 router allowances for the reference
  wallet were `(amount=0, expiration=0)`; both ERC20 allowances to Permit2 were sufficient.
  An Anvil fork of block **107746080**, hash
  `0x6a6fbd7f7b556c02319d3579555ef3457bad7e7530d5a114b19dae1c8d161f3c`, then used the actual
  deployed contracts and wallet client. With the reference account impersonated **only locally**
  and 1 local ETH assigned for gas, USDG approval → successful receipt → PONS approval → successful
  receipt → 2,116-byte `buildCalldata` → `eth_call` → `eth_sendTransaction` succeeded. The swap
  receipt had status 1 and used 212,833 gas. No token balances or Permit2 slots were overridden.
  USDG decreased by 10,000 base units and PONS increased: the second pool returned no USDG at this
  state. This verifies execution, **not a profitable round trip**. The RPC/fork check is supplemental;
  none of the delivered automated tests require a network or a fork.

Nothing was broadcast to Robinhood Chain and no private key was used. The following historical
analysis documents the earlier encoder repair; its block-specific observations are not live quotes.

## What was wrong

The failed transaction does not have one bug in its encoding, it has three. Each one makes the
router revert by itself, so fixing any one or any two still fails. The suspected cause, the
`2^128-1` amount of swap 2, is not what reverted that transaction, but it is wrong too and is
covered in the next section.

Both transactions use actions `0x060c0e`. The difference is in the params of two of the three
actions:

| | Successful `0x1143c44d…befb6b7` | Failed `0xc7d64b70…47eb8c` |
|---|---|---|
| `0x06` swap params, length | `0x180` (12 words) | `0x140` (10 words) |
| `0x06` swap params, word 0 | `0x20`, the offset of the struct | `currency0` (PONS) |
| `0x06` struct head | 9 words: pool key (5), `zeroForOne`, `amountIn`, `amountOutMinimum`, one more word (`0`) | 8 words: the last one is missing |
| `0x0c` settle params | 2 words: currency, max amount | 2 words: the same |
| `0x0e` take params | 3 words: currency, recipient, amount (`0`) | 2 words: currency, `0` |

1. **The struct offset is missing.** The router reads word 0 of the swap params as the offset of
   the struct. The successful transaction has `0x20` there, which is what `abi.encode(struct)`
   produces for a struct with a `bytes` field. The failing encoder laid the fields out flat, so
   the router read the PONS address as an offset.
2. **The struct is one word short.** On this router `ExactInputSingleParams` has a ninth head
   word between `amountOutMinimum` and `hookData`. It is a minimum price for the hop,
   `amountOut * 1e36 / amountIn`, and `0` switches it off, which is what the successful
   transaction sends. Without it the params are `0x140` bytes, below the router's minimum of
   `0x160`. That is the revert the failed transaction actually hit: replaying its input returns
   `0x3b99b53d`, `SliceOutOfBounds()`.
3. **`TAKE` has the wrong shape.** Action `0x0e` is `TAKE(currency, recipient, amount)`, three
   words. The failing encoder sent `(currency, 0)`, the two-word shape of `TAKE_ALL`, which is
   action `0x0f`.

I replayed all eight combinations of these three fixes against the live router with `eth_call`
from the failed transaction's sender, selling 10 000 units of USDG on the pool that transaction
used:

| Struct offset | Ninth word | 3-word take | Result |
|---|---|---|---|
| no | no | no | `SliceOutOfBounds()` (the failed transaction's shape) |
| yes | no | no | reverts, no data |
| no | yes | no | reverts, no data |
| no | no | yes | `SliceOutOfBounds()` |
| yes | yes | no | `SliceOutOfBounds()` |
| yes | no | yes | reverts, no data |
| no | yes | yes | reverts, no data |
| **yes** | **yes** | **yes** | **executes** |

The corrected encoder also reproduces the successful transaction's 1 156-byte input exactly when
given that transaction's parameters. Both the JavaScript and the Solidity tests assert it.

## The `2^128-1` amount of swap 2

The successful transaction has no second swap: its commands are `0x10`, one `V4_SWAP`. So it
cannot show what a second swap's amount should be. What it does show is that its `TAKE` amount is
`0`, and the router took the whole credit. `OPEN_DELTA` on this router is `0`, not `2^128-1`.

What the two candidate values do in swap 2, measured on the live router with the shape fixed:

- **`2^128-1` is taken literally.** The router tries to sell that many PONS, stops when the pool
  reaches its price floor and then pulls whatever that took from the wallet. On the 2500/25 pool
  that was 0.6109 PONS for 0.114838 USDG, emptying the pool's USDG; the call succeeded. On pool A
  it would need about 6.9e16 PONS and reverts for lack of balance. With `amountOutMinimum = 0`
  nothing stops it. The encoder now refuses this value.
- **`0` (the real `OPEN_DELTA`) reverts** with `SwapAmountCannotBeZero()` when swap 2 is a command
  of its own. Each `V4_SWAP` command is a separate unlock of the PoolManager, and a credit cannot
  be carried from one to the next. The encoder refuses this too.

So with commands `0x1010` swap 2 needs a real, fixed amount. `buildCalldata()` takes one number,
`ponsAmount`, and uses it twice: as swap 1's `amountOutMinimum` and as swap 2's `amountIn`. Swap 2
then never sells more than swap 1 delivered, and the transaction reverts if swap 1 delivers less.

If the intent is "sell exactly what swap 1 bought", that needs both swaps in **one** command.
`buildAtomicCalldata()` does that with actions `0x06060e` and swap 2's `amountIn = 0`. The USDG
that swap 1 owes nets against the USDG swap 2 pays, so nothing leaves the wallet, no Permit2
allowance is needed, and the transaction settles only if the round trip returns at least what it
spent. This goes beyond the two functions the brief asked for; use it or ignore it.

## Using it

```html
<script src="js/vendor/ethers-5.7.2.umd.min.js"></script>
<script src="js/v4-arb-encoder.js"></script>
<script>
  const { buildCalldata, ROUTER, POOL_A, POOL_B } = V4ArbEncoder;

  const data = buildCalldata({
    recipient: account,                          // the wallet that sends the transaction
    usdgIn: ethers.utils.parseUnits("0.01", 6),  // USDG has 6 decimals
    ponsAmount: quotedPons.mul(995).div(1000),   // swap 1's quote minus slippage
    minUsdgOut: minUsdgBack,                     // least USDG swap 2 may return
    buyPool: POOL_A,                             // default
    sellPool: POOL_B,                            // default
  });
  // Encoding only. Use the page/client flow above to check allowances, simulate and submit.
</script>
```

In Node it is `const E = require("./js/v4-arb-encoder.js")`; it loads the vendored ethers v5 directly.

| Function | Returns |
|---|---|
| `encodeV4Swap({ poolKey, zeroForOne, amountIn, amountOutMinimum, recipient, settleMax?, minHopPriceX36?, hookData? })` | one `V4_SWAP` input, actions `0x060c0e` |
| `buildCalldata({ recipient, usdgIn, ponsAmount, minUsdgOut, buyPool?, sellPool?, deadline? })` | `execute` calldata, commands `0x1010` |
| `buildAtomicCalldata({ recipient, usdgIn, minUsdgOut, buyPool?, sellPool?, deadline? })` | `execute` calldata, commands `0x10`, actions `0x06060e` |
| `encodeExecute(commands, inputs, deadline?)` | `execute` calldata for any inputs |

Amounts are base units (`BigNumber`, string or number). `deadline` defaults to max `uint256`, as
in the brief. `recipient`, `amountOutMinimum` and `minUsdgOut` have no default: pass `0` for a
minimum only if any price is acceptable. The follow-up page uses these signatures and supplies
a finite deadline instead of the pure encoder's unlimited default.

## Things outside the encoding that will still stop or spoil the transaction

These were visible on chain while testing. None of them is fixed by an encoder.

- **Permit2 allowance.** `SETTLE_ALL` pulls tokens through Permit2
  (`0x000000000022D473030F116dDEE9F6B43aC78BA3`). The failed transaction's sender has approved
  both tokens to Permit2, but has no Permit2 allowance to the router for either. The corrected
  calldata reverts with `AllowanceExpired(0)` until
  `Permit2.approve(token, router, amount, expiration)` is called for USDG and for PONS. The USDG
  approval that wallet gave directly to the router is not used by it. With the allowance supplied
  in the simulation, the corrected calldata executes.
- **USDG has 6 decimals.** The failed transaction sold `1e16` units, which is 0.01 of an
  18-decimal token but 10 000 000 000 USDG. With the shape fixed, that amount reverts with
  `TRANSFER_FROM_FAILED`. 0.01 USDG is `10000`.
- **The pools.** The failed transaction used fee 2500 / tick spacing 25 for both swaps, not the
  two pools in the brief. All three pools exist. Pool B (30000/600) had no liquidity when I
  checked: selling PONS into it returned 0 USDG. With `minUsdgOut = 0` the two-command
  transaction then succeeds and leaves the wallet holding PONS instead of USDG.
- **There was no profit on the brief's route when I checked.** 10 000 units of USDG through pool A
  and back through the 2500/25 pool returned about 9 710 to 9 910. The opposite direction (buy on
  2500/25, sell on A) returned at least break-even in one simulation. Prices move; quote before
  sending.

## What is in the repository

| Path | What it is |
|---|---|
| `index.html` | live pool monitor, Manual pool mode, spread table, quote → Permit2 → dry run → send, auto mode, wallet transfer |
| `js/v4-arb-encoder.js` | corrected encoder, Permit2 wallet client, pool monitor, all-pairs monitor, manual pool reader, quote, gas estimate, tab lock, revoke, transfers |
| `worker/rpc-proxy.js`, `worker/wrangler.toml` | JSON-RPC proxy Worker: Blockmachine primary, one retry against dRPC on 429/5xx |
| `js/test/allpairs.test.js`, `js/test/allpairs-mock.js`, `js/test/worker.test.js` | follow-up 6 tests and the multi-pair mock |
| `src/AllPairsScanner.sol`, `test/AllPairsScanner.t.sol` | follow-up 6 reference arithmetic and its Foundry tests |
| `js/test/manual.test.js` | Manual mode: address rule, the four reads, slot0 layouts, validation messages, monitor schedule, 10 cases |
| `js/test/manual-mock.js` | pool-shaped eth_call double (token0 / token1 / fee / slot0), including the brief's two pools' live replies |
| `scripts/verify-manual-live.js` | optional read-only live check of Manual mode; `docs/manual-live.json` is its output of 2026-11-07 |
| `js/test/encoder.test.js` | offline test of the encoder, 18 cases |
| `js/test/permit2.test.js` | approval and transaction-flow success/failure tests, 43 cases |
| `js/test/monitor.test.js` | pool ids, spreads, monitor schedule and errors, window, staleness, slot0, quote, transfers, 34 cases |
| `js/test/ui.test.js` | actual page script event-handler tests, 22 cases |
| `js/test/mock-wallet.js` | stateful EIP-1193 and JSON-RPC test double (allowances, balances, Swap logs, block times, Slot0, quotes) |
| `js/vendor/ethers-5.7.2.umd.min.js` | ethers v5, vendored so the test runs without a network |
| `src/V4SwapCalldata.sol` | the same encoder in Solidity, internal and pure |
| `src/V4SwapCalldataCheck.sol` | an offline shape check that applies the router's length rules |
| `src/V4PoolMonitor.sol` | pool ids, spread / fee / net bps, slippage, quote-revert, Swap-log and Slot0 decoding, pool status |
| `src/V3ManualPool.sol` | Manual mode reference: the four pool reads by staticcall, slot0 decoding, pair / liquidity / same-pool checks, buy-sell ordering |
| `test/V3ManualPool.t.sol` | 14 Foundry tests, 2 of them fuzz tests, against pool-shaped mocks: success and every failure path |
| `test/Vectors.sol` | the two transactions' inputs and the JavaScript encoder's outputs |
| `test/V4SwapCalldata.t.sol` | 37 Foundry tests, 4 of them fuzz tests |
| `test/V4PoolMonitor.t.sol` | 31 Foundry tests, 7 of them fuzz tests, sharing vectors with the JavaScript |
| `lib/forge-std` | forge-std v1.9.7, vendored as plain files |

The two encoders are tied together through `test/Vectors.sol`: the JavaScript test asserts the
JavaScript produces those bytes, the Foundry tests assert the Solidity produces the same bytes.

```sh
forge build
FOUNDRY_FUZZ_SEED=0xe6b28ac28482a0fc8caab7337860b50a5f4d736b636ed2ad9e629e73e3345aa8 forge test
forge fmt --check
node js/test/encoder.test.js
node --test js/test/permit2.test.js js/test/monitor.test.js js/test/ui.test.js js/test/manual.test.js
```

## How this was verified, and what was not

- Both calldatas were read with `eth_getTransactionByHash` from the RPC in the brief, and both
  receipts with `eth_getTransactionReceipt` (status 1 and status 0). The Blockscout site answered
  with a browser challenge, so I did not use it; the bytes are the chain's own.
- Every statement above about the router's behaviour comes from `eth_call` against the live
  router between blocks 107 715 000 and 107 722 000, sent from the failed transaction's sender, with the
  Permit2 allowance supplied through a state override where noted.
- Nothing was broadcast. No transaction with the corrected calldata exists on chain.
- I did not read the router's source. The name `minHopPriceX36` is inferred: a large value in that
  word reverts with selector `0x4713c18b`, which a signature lookup gives as
  `V4TooLittleReceivedPerHopSingle(uint256,uint256)`, carrying the value sent and
  `amountOut * 1e36 / amountIn`.
- `V4SwapCalldataCheck` is a model of the router's decoding, not the router. It agrees with the
  live router on pass or fail for all eight combinations above. Where the live router reverts
  with no data, the model reverts with its own `MalformedStruct()`.
- `forge build`, `forge test` (with the verifier's fuzz seed) and `forge fmt --check` pass on
  solc 0.8.26. Slither was not available and was not run.

## Assumptions

- The router, PoolManager (`0x8366a39CC670B4001A1121B8F6A443A643e40951`), Permit2 and both tokens
  behave as they did at the blocks above. A router upgrade could change the struct again; the
  byte-for-byte test against the successful transaction pins the layout this code targets.
- `recipient` of `buildCalldata()` is the account that sends the transaction, because swap 2
  settles PONS from the sender's wallet.
- Pools have no hook (`hooks` is the zero address in a V4 pool key) and `hookData` is empty unless
  passed. The monitor only scans the seven hookless tiers listed in the brief; a pool with a hook or
  another tick spacing is invisible to it.
- The quote relies on the router reverting with `V4TooLittleReceivedPerHopSingle(uint256,uint256)`
  (selector `0x4713c18b`, name from a signature lookup, behaviour verified live) after the PoolManager
  has executed the swap. A router upgrade that changes this check breaks quoting, and the page then
  reports "Quote failed" rather than guessing an amount. The PoolManager `Swap` event has the public
  V4 layout, with `tick` as the fifth data word.
- "Price" is `1.0001^tick` of the **last swap in the window**, not the pool's current slot0. It is as
  stale as that swap, and a pool with liquidity but no recent swap counts as inactive.
- Slot0 is read through `extsload` at `keccak256(abi.encode(poolId, 6))`, the `pools` mapping's slot in
  the public V4 PoolManager, confirmed against the live word's fee and tick. Elapsed time is chain time,
  latest block minus swap block, not the browser's clock.
- A pool's status does not measure liquidity. See follow-up 3.5, point 2.
- Token A and Token B are ERC20 tokens with `symbol()` and `decimals()`; the native currency
  (`currency0 = 0x0`) is not supported as a pair member.
- The public RPC in the brief answers `eth_getLogs` over up to 50 000 blocks with a seven-id topic filter and
  returns revert data on `eth_call`. Quoting goes through that RPC, not the wallet, because some
  wallets strip revert data.
- Manual mode trusts the pasted contracts' own `token0()`, `token1()`, `fee()` and `slot0()`
  answers; a contract that imitates a pool is caught only at the dry run, where the factory lookup
  must return the pasted address. Its price is the current slot0 tick, with no staleness measure,
  and `sqrtPriceX96 > 0` says the pool is initialised, not how deep it is: the quote does that.
  The two test-vector pools answer the canonical seven-word V3 `slot0()`, not the brief's six-word
  ABI; only the first two words are used.
- Spread, fee cost and net are price-ratio arithmetic on the two last-swap ticks. They ignore price
  impact of the trade size, the 0.5% slippage buffer, gas and the possibility that either pool has
  moved since its last swap. A GREEN verdict is a signal to quote and simulate, not a profit.

## Deployment parameters

The follow-up page uses these existing deployments, without creating contracts:

| Parameter | Value |
|---|---|
| Chain ID | 4663 (`0x1237`), inherited from the original encoder and verified over RPC |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |
| Router / Permit2 spender | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| USDG | `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`, 6 decimals |
| PONS | `0x39dbed3a2bd333467115de45665cc57f813c4571`, 18 decimals |
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951`, source of the Swap logs |
| Swap topic | `0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f` |
| Fee tiers scanned | (0,1) (0,10) (500,10) (2500,25) (3000,60) (10000,200) (30000,600), hooks `0x0` |
| Pool A / B | Selected from the live spread table (lower-priced pool buys, higher-priced sells); the encoder's defaults 3000/60 and 30000/600 remain its fallback |
| Mode | user-set in the page, default Auto-scan; Manual prefills the brief's two V3 pools `0x10cc6bd38112cac182db90b6a71d8bb5939526ba` and `0xed50bdeea8adc232f159486192a4157281d722ff` (user-editable) |
| Manual reads | `token0()`, `token1()`, `fee()`, `slot0()` per pool, 8 `eth_call`s per 30 s poll, plus `symbol()` and `decimals()` of both tokens once; no `eth_getLogs`, batch or block reads |
| V3 Factory / SwapRouter02 | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` / `0xcaf681a66d020601342297493863e78c959e5cb2`, used by the Manual execution path exactly as in follow-up 4 |
| Poll / retry / window | 30 s / 60 s after an RPC error / user-set, default 3000 blocks, 50 to 50000 (`POLL_INTERVAL_MS`, `RPC_RETRY_MS`, `LOG_WINDOW_BLOCKS`) |
| Max staleness | user-set in the page, default 7200 s (`MAX_STALENESS_SECONDS`) |
| Slot0 read | `PoolManager.extsload(keccak256(abi.encode(poolId, 6)))` (`POOLS_SLOT`) |
| Slippage | 0.5% (`SLIPPAGE_BPS = 50`) off the quoted swap-1 output |
| Auto-mode threshold | user-set in the page, default 0.5% net, strictly above |
| Input amount | 0.01 of currency1 by default, editable in the page |
| Sender / recipient / allowance owner | Connected wallet (reference wallet listed above) |
| RPC for polling and quotes | `https://rpc.mainnet.chain.robinhood.com` from the brief, public, no key, embedded as `RPC_URL` |
| RPC for transactions | The browser wallet's provider |
| Static hosting | Root `index.html`, `js/v4-arb-encoder.js`, and `js/vendor/ethers-5.7.2.umd.min.js` |

Nothing here is deployed. The Solidity libraries have only internal functions, hold no state and
no funds, have no owner and take no constructor arguments. The addresses in the code are the ones
given in the brief (router, PONS, USDG), each confirmed to have code on chain 4663, with
`symbol()` returning `PONS` and `USDG`.

## Operational responsibilities

Whoever sends the transaction is responsible for:

- selecting the target chain and account, paying ETH gas, and reviewing wallet requests;
- maintaining both ERC20 allowances to Permit2 and Permit2 allowances to the router; expiry and
  confirmation do not revoke the separate ERC20 allowance;
- granting, and later revoking, the Permit2 allowances for USDG and PONS (not needed for
  `buildAtomicCalldata()`);
- quoting swap 1 immediately before sending and choosing `ponsAmount` and `minUsdgOut`; these two
  numbers are the only protection against slippage and sandwiching, and `0` gives none;
- checking that both pools have liquidity at the current price;
- converting amounts with the right decimals (USDG 6, PONS 18);
- setting a real `deadline` if a stuck transaction should expire; the default never does;
- simulating with `eth_call` before sending, and reviewing this code before using it with
  meaningful funds. Passing tests are not an audit;
- running the page in **one** browser tab per wallet: each tab polls and, in auto mode, executes on
  its own, and two tabs do not know about each other's pending transactions;
- supervising auto mode: it signs nothing by itself but will request a signature on every qualifying
  poll, it never approves, and it switches itself off after any failure or receipt timeout. Check a
  timed-out transaction in the wallet or explorer before switching it back on;
- the public RPC's availability and rate limits; the page backs off 60 s but cannot make the RPC
  answer. Pool and spread data are only as fresh as the last successful poll shown in the status bar;
- re-approving Permit2 when a new quote's bridge amount, times the test count, exceeds the earlier
  limit, and raising the minimum return above 0 before trading more than a test amount;
- choosing a window and Max staleness that suit the pair: blocks are about 0.105 s apart, so a window's
  time span is short, and the status marks do not show that a pool has liquidity (a quote does);
- in Manual mode, pasting the right pool addresses and checking the symbols, fees and truncated
  addresses the page shows against an explorer before trading; the page validates the shape and
  the pool's own answers, not which pool the operator meant. The address is re-read every poll but
  the pair's symbols and decimals are cached until the page reloads;
- verifying the new wallet address before a whole-balance transfer. The page checks the format, the
  zero address and self-transfers only. A transfer to a wrong address cannot be undone. The ETH
  transfer leaves a gas reserve as dust by design; a second transfer later can move most of it.

The page automates the allowance checks, finite deadline and simulation but cannot guarantee that
prices, liquidity or allowances stay unchanged between the last dry run and mining. A confirmed
receipt means EVM execution succeeded, not that a zero-minimum test made a profit. Static host
deployment, real wallet approvals/swaps, allowance revocation and any independent security review
remain the operator's responsibility.
