# V4 swap calldata for the Universal Router on Robinhood Chain

Corrected `encodeV4Swap()` and `buildCalldata()` for a two-swap Uniswap V4 round trip
(USDG → PONS → USDG) through the Universal Router `0x8876789976dEcBfCbBbe364623C63652db8C0904`
on chain 4663, with the evidence for the fix.

The deliverable is [`js/v4-arb-encoder.js`](js/v4-arb-encoder.js): plain JavaScript, ethers v5,
no other dependency.

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
<script src="vendor/ethers-5.7.2.umd.min.js"></script>  <!-- any ethers v5 build -->
<script src="v4-arb-encoder.js"></script>
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
  await signer.sendTransaction({ to: ROUTER, data });
</script>
```

In Node it is `const E = require("./js/v4-arb-encoder.js")` with `ethers@5` installed.

| Function | Returns |
|---|---|
| `encodeV4Swap({ poolKey, zeroForOne, amountIn, amountOutMinimum, recipient, settleMax?, minHopPriceX36?, hookData? })` | one `V4_SWAP` input, actions `0x060c0e` |
| `buildCalldata({ recipient, usdgIn, ponsAmount, minUsdgOut, buyPool?, sellPool?, deadline? })` | `execute` calldata, commands `0x1010` |
| `buildAtomicCalldata({ recipient, usdgIn, minUsdgOut, buyPool?, sellPool?, deadline? })` | `execute` calldata, commands `0x10`, actions `0x06060e` |
| `encodeExecute(commands, inputs, deadline?)` | `execute` calldata for any inputs |

Amounts are base units (`BigNumber`, string or number). `deadline` defaults to max `uint256`, as
in the brief. `recipient`, `amountOutMinimum` and `minUsdgOut` have no default: pass `0` for a
minimum only if any price is acceptable. I did not have the original HTML file, so these
signatures are mine; adapt the call sites to them.

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
| `js/v4-arb-encoder.js` | the deliverable |
| `js/test/encoder.test.js` | offline test of the deliverable, 18 cases |
| `js/vendor/ethers-5.7.2.umd.min.js` | ethers v5, vendored so the test runs without a network |
| `src/V4SwapCalldata.sol` | the same encoder in Solidity, internal and pure |
| `src/V4SwapCalldataCheck.sol` | an offline shape check that applies the router's length rules |
| `test/Vectors.sol` | the two transactions' inputs and the JavaScript encoder's outputs |
| `test/V4SwapCalldata.t.sol` | 37 Foundry tests, 4 of them fuzz tests |
| `lib/forge-std` | forge-std v1.9.7, vendored as plain files |

The two encoders are tied together through `test/Vectors.sol`: the JavaScript test asserts the
JavaScript produces those bytes, the Foundry tests assert the Solidity produces the same bytes.

```sh
forge build
forge test
forge fmt --check
node js/test/encoder.test.js
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
  passed.

## Deployment parameters

Nothing here is deployed. The Solidity libraries have only internal functions, hold no state and
no funds, have no owner and take no constructor arguments. The addresses in the code are the ones
given in the brief (router, PONS, USDG), each confirmed to have code on chain 4663, with
`symbol()` returning `PONS` and `USDG`.

## Operational responsibilities

Whoever sends the transaction is responsible for:

- granting, and later revoking, the Permit2 allowances for USDG and PONS (not needed for
  `buildAtomicCalldata()`);
- quoting swap 1 immediately before sending and choosing `ponsAmount` and `minUsdgOut`; these two
  numbers are the only protection against slippage and sandwiching, and `0` gives none;
- checking that both pools have liquidity at the current price;
- converting amounts with the right decimals (USDG 6, PONS 18);
- setting a real `deadline` if a stuck transaction should expire; the default never does;
- simulating with `eth_call` before sending, and reviewing this code before using it with
  meaningful funds. Passing tests are not an audit.
