# V4 swap calldata for the Universal Router on Robinhood Chain

Corrected `encodeV4Swap()` and `buildCalldata()` for a two-swap Uniswap V4 round trip
(USDG → PONS → USDG) through the Universal Router `0x8876789976dEcBfCbBbe364623C63652db8C0904`
on chain 4663, with the evidence for the fix.

The deliverables are [`index.html`](index.html) and [`js/v4-arb-encoder.js`](js/v4-arb-encoder.js):
plain JavaScript and the existing vendored ethers v5, with no install or CDN required.

## Follow-up 3: live pool monitor, arbitrage execution, wallet transfer

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
needed), does one `eth_blockNumber` and one `eth_getLogs` on the PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951` for the last **100 blocks**, topic0 =
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
one OR filter in a single `eth_getLogs`, so a poll costs two requests.

Note on this pair: when checked on 2026-11-07, the PONS/USDG pools had **13 swaps in 5 000 blocks**
(12 on 3000/60, 1 on 30000/600). With the brief's 100-block window the pools will usually all be
inactive and the spread table empty; this is the definition the brief asked for, not a fault. A
longer window is a one-constant change (`LOG_WINDOW_BLOCKS`, also `windowBlocks` in
`createPoolMonitor`), but widening it makes the "last tick" staler.

### Display

- **Pools table**: Fee · TickSpacing · Price (tick) · Swaps (100 blocks) · Active?.
- **Top 5 pairwise spreads** between active pools: Pool A (buy) · Pool B (sell) · Spread% · Fee Cost% ·
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
| `createRpcClient(url, fetch?)` | JSON-RPC over HTTP; errors carry `code` and revert `data` |
| `quoteExactIn(request, { poolKey, zeroForOne, amountIn, from? })` | exact quote via the router's price-check revert |
| `createPoolMonitor({ request, pollIntervalMs, retryIntervalMs, windowBlocks, thresholdPercent, onUpdate, onError })` | `start(a, b)`, `stop()`, `pollOnce()`, `getState()` |
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
| `index.html` | live pool monitor, spread table, quote → Permit2 → dry run → send, auto mode, wallet transfer |
| `js/v4-arb-encoder.js` | corrected encoder, Permit2 wallet client, pool monitor, quote, transfers |
| `js/test/encoder.test.js` | offline test of the encoder, 18 cases |
| `js/test/permit2.test.js` | approval and transaction-flow success/failure tests, 43 cases |
| `js/test/monitor.test.js` | pool ids, spreads, monitor schedule and errors, quote, transfers, 21 cases |
| `js/test/ui.test.js` | actual page script event-handler tests, 15 cases |
| `js/test/mock-wallet.js` | stateful EIP-1193 and JSON-RPC test double (allowances, balances, Swap logs, quotes) |
| `js/vendor/ethers-5.7.2.umd.min.js` | ethers v5, vendored so the test runs without a network |
| `src/V4SwapCalldata.sol` | the same encoder in Solidity, internal and pure |
| `src/V4SwapCalldataCheck.sol` | an offline shape check that applies the router's length rules |
| `src/V4PoolMonitor.sol` | pool ids, spread / fee / net bps, slippage, quote-revert and Swap-log decoding |
| `test/Vectors.sol` | the two transactions' inputs and the JavaScript encoder's outputs |
| `test/V4SwapCalldata.t.sol` | 37 Foundry tests, 4 of them fuzz tests |
| `test/V4PoolMonitor.t.sol` | 20 Foundry tests, 4 of them fuzz tests, sharing vectors with the JavaScript |
| `lib/forge-std` | forge-std v1.9.7, vendored as plain files |

The two encoders are tied together through `test/Vectors.sol`: the JavaScript test asserts the
JavaScript produces those bytes, the Foundry tests assert the Solidity produces the same bytes.

```sh
forge build
FOUNDRY_FUZZ_SEED=0x7363613b963c638bcd9c7841cc95581055d780db0b15e0e3b05aeed7bb796d4e forge test
forge fmt --check
node js/test/encoder.test.js
node --test js/test/permit2.test.js js/test/monitor.test.js js/test/ui.test.js
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
- Token A and Token B are ERC20 tokens with `symbol()` and `decimals()`; the native currency
  (`currency0 = 0x0`) is not supported as a pair member.
- The public RPC in the brief answers `eth_getLogs` over 100 blocks with a seven-id topic filter and
  returns revert data on `eth_call`. Quoting goes through that RPC, not the wallet, because some
  wallets strip revert data.
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
| Poll / retry / window | 30 s / 60 s after an RPC error / last 100 blocks (`POLL_INTERVAL_MS`, `RPC_RETRY_MS`, `LOG_WINDOW_BLOCKS`) |
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
- verifying the new wallet address before a whole-balance transfer. The page checks the format, the
  zero address and self-transfers only. A transfer to a wrong address cannot be undone. The ETH
  transfer leaves a gas reserve as dust by design; a second transfer later can move most of it.

The page automates the allowance checks, finite deadline and simulation but cannot guarantee that
prices, liquidity or allowances stay unchanged between the last dry run and mining. A confirmed
receipt means EVM execution succeeded, not that a zero-minimum test made a profit. Static host
deployment, real wallet approvals/swaps, allowance revocation and any independent security review
remain the operator's responsibility.
