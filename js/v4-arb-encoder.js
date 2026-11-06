/*
 * Uniswap V4 swap calldata for the Universal Router on Robinhood Chain (chain id 4663).
 *
 * Router      0x8876789976dEcBfCbBbe364623C63652db8C0904
 * Method      execute(bytes commands, bytes[] inputs, uint256 deadline)   selector 0x3593564c
 *
 * Only dependency: ethers v5 (the global `ethers` in a page, or require("ethers") in Node).
 *
 * Every layout below was read from the successful transaction
 * 0x1143c44db8d6cc05968e3b511a16b64be8f64a92b727b90043777ca87befb6b7 and confirmed by eth_call
 * against the live router. The failing encoder differed from it in three places, each of which
 * reverts on its own:
 *
 *   1. SWAP_EXACT_IN_SINGLE params were the struct's fields laid flat. The router reads the first
 *      word as the OFFSET of the struct, so the params must be abi.encode(struct): a leading 0x20.
 *   2. The struct on this router has a ninth head word, `uint256 minHopPriceX36`, between
 *      amountOutMinimum and hookData. Without it the params are 0x140 bytes and the router's
 *      minimum-length check (0x160) reverts with SliceOutOfBounds() = 0x3b99b53d.
 *   3. Action 0x0e is TAKE(currency, recipient, amount): three words. The failing encoder sent
 *      the two-word TAKE_ALL shape (currency, minAmount), which is action 0x0f, not 0x0e.
 *
 * OPEN_DELTA on this router is 0, not 2^128-1, and it only refers to a credit opened earlier in
 * the SAME V4_SWAP command. See buildCalldata() and buildAtomicCalldata().
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("ethers"));
  } else {
    root.V4ArbEncoder = factory(root.ethers);
  }
})(typeof self !== "undefined" ? self : this, function (ethersLib) {
  "use strict";

  var ethers = ethersLib.ethers || ethersLib;
  var utils = ethers.utils;
  var BigNumber = ethers.BigNumber;
  var abi = utils.defaultAbiCoder;

  var ROUTER = "0x8876789976dEcBfCbBbe364623C63652db8C0904";
  var CHAIN_ID = 4663;
  var PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571"; // 18 decimals
  var USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // 6 decimals
  var NO_HOOKS = ethers.constants.AddressZero; // "no hook" is the zero address in a V4 pool key

  var EXECUTE_SELECTOR = "0x3593564c";
  var COMMAND_V4_SWAP = "0x10";
  var ACTION_SWAP_EXACT_IN_SINGLE = "06";
  var ACTION_SETTLE_ALL = "0c";
  var ACTION_TAKE = "0e";
  var ACTIONS_SWAP_SETTLE_TAKE = "0x" + ACTION_SWAP_EXACT_IN_SINGLE + ACTION_SETTLE_ALL + ACTION_TAKE;
  var ACTIONS_SWAP_SWAP_TAKE = "0x" + ACTION_SWAP_EXACT_IN_SINGLE + ACTION_SWAP_EXACT_IN_SINGLE + ACTION_TAKE;

  // ActionConstants of the router. OPEN_DELTA is zero: "use the whole open delta".
  var OPEN_DELTA = 0;
  // Recipient sentinel the router maps to the caller of execute().
  var MSG_SENDER = "0x0000000000000000000000000000000000000001";

  var MAX_UINT128 = BigNumber.from(2).pow(128).sub(1);
  var MAX_UINT256 = ethers.constants.MaxUint256;

  var POOL_KEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
  var EXACT_IN_SINGLE_TYPE =
    "tuple(" +
    POOL_KEY_TYPE +
    " poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)";

  // The two pools named in the brief. Both exist on chain 4663 (checked through extsload).
  var POOL_A = { currency0: PONS, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: NO_HOOKS };
  var POOL_B = { currency0: PONS, currency1: USDG, fee: 30000, tickSpacing: 600, hooks: NO_HOOKS };

  function fail(message) {
    throw new Error("V4ArbEncoder: " + message);
  }

  function normalisePoolKey(poolKey) {
    if (!poolKey) fail("poolKey is required");
    var key = {
      currency0: utils.getAddress(poolKey.currency0),
      currency1: utils.getAddress(poolKey.currency1),
      fee: poolKey.fee,
      tickSpacing: poolKey.tickSpacing,
      hooks: utils.getAddress(poolKey.hooks === undefined ? NO_HOOKS : poolKey.hooks),
    };
    if (!BigNumber.from(key.currency0).lt(BigNumber.from(key.currency1))) {
      fail("poolKey.currency0 must sort strictly below poolKey.currency1");
    }
    return key;
  }

  function uint128(value, name) {
    if (value === undefined || value === null) fail(name + " is required");
    var n = BigNumber.from(value);
    if (n.lt(0) || n.gt(MAX_UINT128)) fail(name + " does not fit uint128");
    return n;
  }

  function recipientAddress(recipient) {
    if (!recipient) fail("recipient is required");
    var address = utils.getAddress(recipient);
    if (address === ethers.constants.AddressZero) fail("recipient must not be the zero address");
    return address;
  }

  /**
   * abi.encode(ExactInputSingleParams) exactly as the router reads it:
   *
   *   word 0   0x20                offset of the struct (fix 1)
   *   word 1-5 poolKey             currency0, currency1, fee, tickSpacing, hooks
   *   word 6   zeroForOne
   *   word 7   amountIn            0 means OPEN_DELTA
   *   word 8   amountOutMinimum
   *   word 9   minHopPriceX36      amountOut * 1e36 / amountIn floor, 0 disables it (fix 2)
   *   word 10  0x140               offset of hookData from word 1
   *   word 11  hookData length, then the bytes
   */
  function encodeSwapParams(p) {
    var key = normalisePoolKey(p.poolKey);
    return abi.encode(
      [EXACT_IN_SINGLE_TYPE],
      [
        {
          poolKey: key,
          zeroForOne: Boolean(p.zeroForOne),
          amountIn: uint128(p.amountIn, "amountIn"),
          amountOutMinimum: uint128(p.amountOutMinimum, "amountOutMinimum"),
          minHopPriceX36: BigNumber.from(p.minHopPriceX36 === undefined ? 0 : p.minHopPriceX36),
          hookData: p.hookData === undefined ? "0x" : p.hookData,
        },
      ]
    );
  }

  /** SETTLE_ALL(currency, maxAmount): pay the whole debt in `currency` from the caller through Permit2. */
  function encodeSettleAll(currency, maxAmount) {
    return abi.encode(["address", "uint256"], [utils.getAddress(currency), BigNumber.from(maxAmount)]);
  }

  /** TAKE(currency, recipient, amount): three words, amount 0 (OPEN_DELTA) takes the whole credit (fix 3). */
  function encodeTake(currency, recipient, amount) {
    return abi.encode(
      ["address", "address", "uint256"],
      [utils.getAddress(currency), recipientAddress(recipient), BigNumber.from(amount === undefined ? OPEN_DELTA : amount)]
    );
  }

  /** One V4_SWAP input: abi.encode(bytes actions, bytes[] params). */
  function encodeActions(actions, params) {
    if (utils.hexDataLength(actions) !== params.length) fail("one params entry is needed per action");
    return abi.encode(["bytes", "bytes[]"], [actions, params]);
  }

  /**
   * One V4_SWAP input with actions 0x060c0e: swap exact in, settle the input from the caller,
   * take the output to `recipient`.
   *
   * swap = {
   *   poolKey:          { currency0, currency1, fee, tickSpacing, hooks }   currency0 < currency1
   *   zeroForOne:       true sells currency0, false sells currency1
   *   amountIn:         base units of the token sold; a fixed, non-zero amount
   *   amountOutMinimum: base units of the token bought; pass 0 only if you accept any price
   *   recipient:        who receives the output (MSG_SENDER = the caller of execute)
   *   settleMax:        optional cap for SETTLE_ALL, default amountIn
   *   minHopPriceX36:   optional, default 0 (off)
   *   hookData:         optional, default 0x
   * }
   *
   * amountIn must be the real amount. In a command of its own there is no open credit to refer
   * to, so 0 (OPEN_DELTA) reverts with SwapAmountCannotBeZero(), and 2^128-1 is not a sentinel:
   * the router tries to sell that many tokens, which drains the pool to its price floor with the
   * caller's balance or reverts when the balance is short.
   */
  function encodeV4Swap(swap) {
    if (!swap) fail("swap is required");
    var key = normalisePoolKey(swap.poolKey);
    var amountIn = uint128(swap.amountIn, "amountIn");
    if (amountIn.isZero()) {
      fail("amountIn 0 is OPEN_DELTA and a 0x060c0e command has no open credit; use buildAtomicCalldata");
    }
    if (amountIn.eq(MAX_UINT128)) {
      fail("amountIn 2^128-1 is not OPEN_DELTA on this router (OPEN_DELTA is 0); pass the real amount");
    }
    var zeroForOne = Boolean(swap.zeroForOne);
    var currencyIn = zeroForOne ? key.currency0 : key.currency1;
    var currencyOut = zeroForOne ? key.currency1 : key.currency0;
    var settleMax = swap.settleMax === undefined ? amountIn : BigNumber.from(swap.settleMax);
    if (settleMax.lt(amountIn)) fail("settleMax below amountIn always reverts with V4TooMuchRequested");

    return encodeActions(ACTIONS_SWAP_SETTLE_TAKE, [
      encodeSwapParams({
        poolKey: key,
        zeroForOne: zeroForOne,
        amountIn: amountIn,
        amountOutMinimum: swap.amountOutMinimum,
        minHopPriceX36: swap.minHopPriceX36,
        hookData: swap.hookData,
      }),
      encodeSettleAll(currencyIn, settleMax),
      encodeTake(currencyOut, swap.recipient, OPEN_DELTA),
    ]);
  }

  /** execute(commands, inputs, deadline) calldata. One input per command byte. */
  function encodeExecute(commands, inputs, deadline) {
    if (utils.hexDataLength(commands) !== inputs.length) fail("one input is needed per command");
    var args = abi.encode(
      ["bytes", "bytes[]", "uint256"],
      [commands, inputs, deadline === undefined ? MAX_UINT256 : BigNumber.from(deadline)]
    );
    return EXECUTE_SELECTOR + args.slice(2);
  }

  /**
   * The arbitrage as two commands, 0x1010, each with actions 0x060c0e.
   *
   *   swap 1  buyPool,  zeroForOne=false: sell `usdgIn` USDG, receive at least `ponsAmount` PONS
   *   swap 2  sellPool, zeroForOne=true:  sell exactly `ponsAmount` PONS, receive at least `minUsdgOut`
   *
   * The two commands are separate unlocks of the PoolManager, so swap 2 cannot refer to what
   * swap 1 produced. The link between them is `ponsAmount`: it is swap 1's minimum output and
   * swap 2's exact input, so swap 2 never sells more than swap 1 delivered and the whole
   * transaction reverts if swap 1 delivers less. Quote swap 1 first and pass the quote minus
   * your slippage. Anything swap 1 delivers above `ponsAmount` stays with `recipient` as PONS.
   *
   * Because swap 2 settles from the caller's wallet, `recipient` must be the account that calls
   * execute(), and that account needs a Permit2 allowance to the router for USDG and for PONS.
   *
   * args = { recipient, usdgIn, ponsAmount, minUsdgOut, buyPool?, sellPool?, deadline? }
   */
  function buildCalldata(args) {
    if (!args) fail("args are required");
    if (args.minUsdgOut === undefined || args.minUsdgOut === null) fail("minUsdgOut is required");
    var buyPool = args.buyPool || POOL_A;
    var sellPool = args.sellPool || POOL_B;
    var first = encodeV4Swap({
      poolKey: buyPool,
      zeroForOne: false,
      amountIn: args.usdgIn,
      amountOutMinimum: args.ponsAmount,
      recipient: args.recipient,
    });
    var second = encodeV4Swap({
      poolKey: sellPool,
      zeroForOne: true,
      amountIn: args.ponsAmount,
      amountOutMinimum: args.minUsdgOut,
      recipient: args.recipient,
    });
    return encodeExecute(COMMAND_V4_SWAP + COMMAND_V4_SWAP.slice(2), [first, second], args.deadline);
  }

  /**
   * The same round trip in ONE V4_SWAP command, actions 0x06060e, where OPEN_DELTA really works:
   *
   *   swap 1  buyPool,  zeroForOne=false: sell `usdgIn` USDG
   *   swap 2  sellPool, zeroForOne=true:  amountIn = 0 (OPEN_DELTA) sells every PONS swap 1 bought
   *   TAKE    USDG, recipient, 0:         pay out the net USDG gain
   *
   * Inside one unlock the USDG owed by swap 1 nets against the USDG paid by swap 2, so nothing is
   * pulled from the wallet and no Permit2 allowance is needed. It only settles when swap 2
   * returns at least `usdgIn`; otherwise the transaction reverts and costs gas only. For that
   * reason `minUsdgOut` must be at least `usdgIn`.
   *
   * args = { recipient, usdgIn, minUsdgOut, buyPool?, sellPool?, deadline? }
   */
  function buildAtomicCalldata(args) {
    if (!args) fail("args are required");
    var buyPool = normalisePoolKey(args.buyPool || POOL_A);
    var sellPool = normalisePoolKey(args.sellPool || POOL_B);
    if (buyPool.currency0 !== sellPool.currency0 || buyPool.currency1 !== sellPool.currency1) {
      fail("both pools must trade the same pair");
    }
    var usdgIn = uint128(args.usdgIn, "usdgIn");
    if (usdgIn.isZero() || usdgIn.eq(MAX_UINT128)) fail("usdgIn must be a real, non-zero amount");
    var minUsdgOut = uint128(args.minUsdgOut, "minUsdgOut");
    if (minUsdgOut.lt(usdgIn)) fail("minUsdgOut below usdgIn can never settle: there is no SETTLE action");

    var input = encodeActions(ACTIONS_SWAP_SWAP_TAKE, [
      encodeSwapParams({ poolKey: buyPool, zeroForOne: false, amountIn: usdgIn, amountOutMinimum: 0 }),
      encodeSwapParams({ poolKey: sellPool, zeroForOne: true, amountIn: OPEN_DELTA, amountOutMinimum: minUsdgOut }),
      encodeTake(buyPool.currency1, args.recipient, OPEN_DELTA),
    ]);
    return encodeExecute(COMMAND_V4_SWAP, [input], args.deadline);
  }

  return {
    ROUTER: ROUTER,
    CHAIN_ID: CHAIN_ID,
    PONS: PONS,
    USDG: USDG,
    NO_HOOKS: NO_HOOKS,
    POOL_A: POOL_A,
    POOL_B: POOL_B,
    EXECUTE_SELECTOR: EXECUTE_SELECTOR,
    COMMAND_V4_SWAP: COMMAND_V4_SWAP,
    ACTIONS_SWAP_SETTLE_TAKE: ACTIONS_SWAP_SETTLE_TAKE,
    ACTIONS_SWAP_SWAP_TAKE: ACTIONS_SWAP_SWAP_TAKE,
    OPEN_DELTA: OPEN_DELTA,
    MSG_SENDER: MSG_SENDER,
    MAX_UINT128: MAX_UINT128,
    MAX_UINT256: MAX_UINT256,
    encodeSwapParams: encodeSwapParams,
    encodeSettleAll: encodeSettleAll,
    encodeTake: encodeTake,
    encodeActions: encodeActions,
    encodeV4Swap: encodeV4Swap,
    encodeExecute: encodeExecute,
    buildCalldata: buildCalldata,
    buildAtomicCalldata: buildAtomicCalldata,
  };
});
