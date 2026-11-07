/*
 * Uniswap V4 swap calldata for the Universal Router on Robinhood Chain (chain id 4663).
 *
 * Router      0x8876789976dEcBfCbBbe364623C63652db8C0904
 * Method      execute(bytes commands, bytes[] inputs, uint256 deadline)   selector 0x3593564c
 *
 * Only dependency: ethers v5 (the global `ethers` in a page, or the vendored build in Node).
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
 *
 * Follow-up 3 adds, in this same file: pool ids and tick prices for the seven fee tiers of any
 * pair (sortPair, poolKeysFor, poolId, tickToPrice), a Swap-log pool monitor that polls every
 * 30 s and backs off 60 s on RPC errors (createPoolMonitor), pairwise spread ranking
 * (rankSpreads), an exact-input quote recovered from the router's price-check revert
 * (quoteExactIn), and whole-balance token / ETH transfers in the wallet client.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/ethers-5.7.2.umd.min.js"));
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
  var PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
  var POOL_MANAGER = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
  var RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
  var CHAIN_ID = 4663;
  var PONS = "0x39dbed3a2bd333467115de45665cc57f813c4571"; // 18 decimals
  var USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"; // 6 decimals
  var NO_HOOKS = ethers.constants.AddressZero; // "no hook" is the zero address in a V4 pool key

  // PoolManager Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
  //                  uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)
  var SWAP_TOPIC = "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f";
  var SWAP_DATA_TYPES = ["int128", "int128", "uint160", "uint128", "int24", "uint24"];
  // The seven fee / tick spacing combinations the monitor scans, in the brief's order.
  var FEE_TIERS = [[0, 1], [0, 10], [500, 10], [2500, 25], [3000, 60], [10000, 200], [30000, 600]];
  var LOG_WINDOW_BLOCKS = 100;
  var POLL_INTERVAL_MS = 30000;
  var RPC_RETRY_MS = 60000;
  var SLIPPAGE_BPS = 50; // 0.5%
  var MIN_TICK = -887272;
  var MAX_TICK = 887272;
  // V4TooLittleReceivedPerHopSingle(uint256 minHopPriceX36, uint256 actualPriceX36): the router's
  // price check, which fires after the PoolManager has executed the swap and before settlement.
  var QUOTE_REVERT_SELECTOR = "0x4713c18b";
  var X36 = BigNumber.from(10).pow(36);

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
  var MAX_UINT160 = BigNumber.from(2).pow(160).sub(1);
  var MAX_UINT48 = BigNumber.from(2).pow(48).sub(1);
  var MAX_UINT256 = ethers.constants.MaxUint256;
  var PERMIT2_ABI = [
    "function approve(address token,address spender,uint160 amount,uint48 expiration)",
    "function allowance(address owner,address token,address spender) view returns (uint160 amount,uint48 expiration,uint48 nonce)",
  ];
  var permit2Interface = new utils.Interface(PERMIT2_ABI);
  var tokenInterface = new utils.Interface([
    "function allowance(address owner,address spender) view returns (uint256)",
    "function balanceOf(address owner) view returns (uint256)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function transfer(address to,uint256 amount) returns (bool)",
  ]);

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

  // ------------------------------------------------------------------ pools and prices

  /** currency0 is the numerically lower address (BigInt comparison), as the PoolManager requires. */
  function sortPair(tokenA, tokenB) {
    if (!tokenA || !tokenB) fail("both token addresses are required");
    var a = utils.getAddress(tokenA);
    var b = utils.getAddress(tokenB);
    if (a === b) fail("Token A and Token B must be different addresses");
    if (a === ethers.constants.AddressZero || b === ethers.constants.AddressZero) fail("enter ERC20 token addresses");
    /* global BigInt */
    return BigInt(a) < BigInt(b) ? { currency0: a, currency1: b } : { currency0: b, currency1: a };
  }

  /** The seven hookless pool keys of a pair, in FEE_TIERS order. */
  function poolKeysFor(currency0, currency1) {
    return FEE_TIERS.map(function (tier) {
      return normalisePoolKey({ currency0: currency0, currency1: currency1, fee: tier[0], tickSpacing: tier[1], hooks: NO_HOOKS });
    });
  }

  /** PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)). */
  function poolId(poolKey) {
    return utils.keccak256(abi.encode([POOL_KEY_TYPE], [normalisePoolKey(poolKey)]));
  }

  /** Price of currency0 in currency1 base units: 1.0001^tick. */
  function tickToPrice(tick) {
    var t = Number(tick);
    if (!Number.isInteger(t) || t < MIN_TICK || t > MAX_TICK) fail("tick out of range");
    return Math.pow(1.0001, t);
  }

  /** The Swap log's pool id, tick and position. Throws on a log that is not a PoolManager Swap. */
  function decodeSwapLog(log) {
    if (!log || !log.topics || log.topics[0] !== SWAP_TOPIC || log.topics.length < 2) fail("not a Swap log");
    var decoded = abi.decode(SWAP_DATA_TYPES, log.data);
    return {
      poolId: log.topics[1].toLowerCase(),
      blockNumber: BigNumber.from(log.blockNumber).toNumber(),
      logIndex: log.logIndex === undefined ? 0 : BigNumber.from(log.logIndex).toNumber(),
      sqrtPriceX96: decoded[2],
      liquidity: decoded[3],
      tick: BigNumber.from(decoded[4]).toNumber(),
      fee: BigNumber.from(decoded[5]).toNumber(),
    };
  }

  /**
   * One row per pool key: swap count in the window, the tick of the latest swap and its price.
   * A pool with no swap in the window is inactive and has no price.
   */
  function summarisePools(poolKeys, logs) {
    if (!Array.isArray(logs)) fail("logs must be an array");
    var rows = poolKeys.map(function (key) {
      var normalised = normalisePoolKey(key);
      return { poolKey: normalised, poolId: poolId(normalised), fee: normalised.fee, tickSpacing: normalised.tickSpacing,
        swaps: 0, tick: null, price: null, active: false, lastBlock: null, lastIndex: null };
    });
    var byId = {};
    rows.forEach(function (row) { byId[row.poolId] = row; });
    logs.forEach(function (log) {
      if (!log || !log.topics || log.topics[0] !== SWAP_TOPIC || !log.topics[1]) return;
      var row = byId[log.topics[1].toLowerCase()];
      if (!row) return;
      var swap = decodeSwapLog(log);
      row.swaps += 1;
      if (row.lastBlock === null || swap.blockNumber > row.lastBlock ||
        (swap.blockNumber === row.lastBlock && swap.logIndex >= row.lastIndex)) {
        row.lastBlock = swap.blockNumber;
        row.lastIndex = swap.logIndex;
        row.tick = swap.tick;
        row.price = tickToPrice(swap.tick);
      }
    });
    rows.forEach(function (row) { row.active = row.swaps > 0; });
    return rows;
  }

  /** Percent of the pool's input the LP fee takes: fee is in hundredths of a basis point. */
  function feeCostPercent(feeA, feeB) {
    return (Number(feeA) + Number(feeB)) / 10000;
  }

  /** Price gap as a percent of the lower price. */
  function spreadPercent(priceA, priceB) {
    var a = Number(priceA);
    var b = Number(priceB);
    if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) fail("prices must be positive numbers");
    return Math.abs(a - b) / Math.min(a, b) * 100;
  }

  /**
   * Every pair of active pools, best net first, at most `limit` rows. `buy` is the pool with the
   * lower price (currency0 is cheaper there: sell currency1 into it, zeroForOne=false) and `sell`
   * the pool with the higher price (zeroForOne=true). GREEN means net% is above the threshold.
   */
  function rankSpreads(pools, thresholdPercent, limit) {
    var threshold = thresholdPercent === undefined ? 0.5 : Number(thresholdPercent);
    if (!Number.isFinite(threshold) || threshold < 0) fail("threshold must be a non-negative percent");
    var max = limit === undefined ? 5 : limit;
    var active = pools.filter(function (pool) { return pool.active && pool.price !== null && pool.price > 0; });
    var spreads = [];
    for (var i = 0; i < active.length; i++) {
      for (var j = i + 1; j < active.length; j++) {
        var buy = active[i].price <= active[j].price ? active[i] : active[j];
        var sell = buy === active[i] ? active[j] : active[i];
        var spread = spreadPercent(buy.price, sell.price);
        var feeCost = feeCostPercent(buy.fee, sell.fee);
        var net = spread - feeCost;
        spreads.push({ buy: buy, sell: sell, spreadPercent: spread, feeCostPercent: feeCost, netPercent: net,
          verdict: net > threshold ? "GREEN" : "RED" });
      }
    }
    spreads.sort(function (x, y) { return y.netPercent - x.netPercent; });
    return spreads.slice(0, max);
  }

  /** amount * (10000 - bps) / 10000, rounded down. */
  function applySlippage(amount, bps) {
    var basis = bps === undefined ? SLIPPAGE_BPS : Number(bps);
    if (!Number.isInteger(basis) || basis < 0 || basis > 10000) fail("slippage must be whole basis points, 0 to 10000");
    return BigNumber.from(amount).mul(10000 - basis).div(10000);
  }

  // ------------------------------------------------------------------ JSON-RPC and quotes

  /** Minimal JSON-RPC over HTTP client. Errors carry the node's `code` and revert `data`. */
  function createRpcClient(url, fetchImpl, options) {
    options = options || {};
    var doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (typeof doFetch !== "function") fail("fetch is not available; pass a fetch implementation");
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) fail("RPC url must be an http(s) URL");
    var timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs;
    var nextId = 0;
    async function request(method, params) {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
      try {
        var response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method: method, params: params || [] }),
          signal: controller ? controller.signal : undefined,
        });
        if (!response || !response.ok) fail("RPC HTTP error " + (response ? response.status : "no response"));
        var body = await response.json();
        if (!body || typeof body !== "object") fail("RPC returned no JSON object");
        if (body.error) {
          var error = new Error("RPC error: " + (body.error.message || "unknown"));
          error.code = body.error.code;
          error.data = body.error.data;
          throw error;
        }
        return body.result;
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }
    return { request: request, url: url };
  }

  /** Revert data from the shapes wallets and nodes use: a string, nested objects, or inside the message. */
  function extractRevertData(error) {
    var seen = [];
    function walk(value, depth) {
      if (depth > 6 || value === null || value === undefined) return null;
      if (typeof value === "string") {
        var match = /0x[0-9a-fA-F]{8,}/.exec(value);
        return match ? match[0] : null;
      }
      if (typeof value !== "object" || seen.indexOf(value) !== -1) return null;
      seen.push(value);
      var keys = ["data", "originalError", "error", "cause", "info", "body", "message"];
      for (var i = 0; i < keys.length; i++) {
        var found = walk(value[keys[i]], depth + 1);
        if (found) return found;
      }
      return null;
    }
    return walk(error, 0);
  }

  /** The calldata the quote simulates: one swap whose minHopPriceX36 can never be met. */
  function encodeQuoteCalldata(poolKey, zeroForOne, amountIn) {
    var input = encodeV4Swap({ poolKey: poolKey, zeroForOne: zeroForOne, amountIn: amountIn, amountOutMinimum: 0,
      recipient: MSG_SENDER, minHopPriceX36: MAX_UINT256 });
    return encodeExecute(COMMAND_V4_SWAP, [input], MAX_UINT256);
  }

  /** amountOut from V4TooLittleReceivedPerHopSingle revert data, or null if the data is something else. */
  function decodeQuoteRevert(revertData, amountIn) {
    if (typeof revertData !== "string" || revertData.slice(0, 10).toLowerCase() !== QUOTE_REVERT_SELECTOR) return null;
    if (utils.hexDataLength(revertData) !== 68) return null;
    var decoded = abi.decode(["uint256", "uint256"], "0x" + revertData.slice(10));
    return decoded[1].mul(BigNumber.from(amountIn)).div(X36);
  }

  /**
   * Exact-input quote. The PoolManager executes the swap inside an eth_call of the router; the
   * router's price check then reverts with the achieved price (amountOut * 1e36 / amountIn), from
   * which amountOut is recovered. Nothing is settled, so no allowance or balance is needed.
   * Returns 0 when the pool exists but has no liquidity on the path. Rejects when the pool is
   * not initialised, the RPC fails, or the router did not answer with its price check.
   */
  async function quoteExactIn(request, args) {
    if (typeof request !== "function") fail("request function is required");
    if (!args) fail("quote args are required");
    var key = normalisePoolKey(args.poolKey);
    var amountIn = uint128(args.amountIn, "amountIn");
    if (amountIn.isZero() || amountIn.eq(MAX_UINT128)) fail("amountIn must be a real, non-zero amount");
    var zeroForOne = Boolean(args.zeroForOne);
    var transaction = { to: ROUTER, data: encodeQuoteCalldata(key, zeroForOne, amountIn) };
    if (args.from) transaction.from = utils.getAddress(args.from);
    try {
      await request("eth_call", [transaction, "latest"]);
    } catch (error) {
      var amountOut = decodeQuoteRevert(extractRevertData(error), amountIn);
      if (amountOut !== null) return amountOut;
      var wrapped = new Error("Quote failed for pool " + key.fee + "/" + key.tickSpacing + ": " +
        (error && error.message ? error.message : String(error)));
      wrapped.cause = error;
      throw wrapped;
    }
    fail("quote simulation did not revert with the router's price check; router behaviour changed");
  }

  // ------------------------------------------------------------------ live pool monitor

  /**
   * Polls the PoolManager's Swap logs for the seven fee tiers of one pair.
   *
   * options: request(method, params) (required), pollIntervalMs (30000), retryIntervalMs (60000),
   *          windowBlocks (100), thresholdPercent (number or function, 0.5), onUpdate(state),
   *          onError(error, state), now().
   *
   * start(tokenA, tokenB) resolves after the first poll attempt and keeps polling until stop().
   * Any RPC failure (metadata, block number, logs) is caught: the state records the error, the
   * next attempt is scheduled after retryIntervalMs, and polling never stops by itself.
   */
  function createPoolMonitor(options) {
    options = options || {};
    var request = options.request;
    if (typeof request !== "function") fail("request function is required");
    var pollMs = options.pollIntervalMs === undefined ? POLL_INTERVAL_MS : options.pollIntervalMs;
    var retryMs = options.retryIntervalMs === undefined ? RPC_RETRY_MS : options.retryIntervalMs;
    var windowBlocks = options.windowBlocks === undefined ? LOG_WINDOW_BLOCKS : options.windowBlocks;
    if (!Number.isFinite(pollMs) || pollMs < 0 || !Number.isFinite(retryMs) || retryMs < 0) fail("invalid intervals");
    if (!Number.isInteger(windowBlocks) || windowBlocks < 1) fail("windowBlocks must be a positive integer");
    var onUpdate = options.onUpdate || function () {};
    var onError = options.onError || function () {};
    var now = options.now || function () { return Date.now(); };
    var thresholdOption = options.thresholdPercent === undefined ? 0.5 : options.thresholdPercent;
    var threshold = typeof thresholdOption === "function" ? thresholdOption : function () { return thresholdOption; };

    var tokens = null;
    var running = false;
    var generation = 0;
    var timer = null;
    var state = freshState();

    function freshState() {
      return { pair: null, pools: [], spreads: [], blockNumber: null, fromBlock: null, lastPoll: null,
        lastError: null, retryAt: null, nextPollMs: null, polls: 0, errors: 0 };
    }

    async function readString(token, name) {
      var result = await request("eth_call", [{ to: token, data: tokenInterface.encodeFunctionData(name, []) }, "latest"]);
      if (!result || result === "0x") fail("no " + name + "() at " + token);
      return tokenInterface.decodeFunctionResult(name, result)[0];
    }

    /** Sort the pair and read symbol() and decimals() of both tokens. */
    async function loadPair(tokenA, tokenB) {
      var sorted = sortPair(tokenA, tokenB);
      var pair = { tokenA: utils.getAddress(tokenA), tokenB: utils.getAddress(tokenB),
        currency0: sorted.currency0, currency1: sorted.currency1, keys: poolKeysFor(sorted.currency0, sorted.currency1) };
      pair.symbol0 = String(await readString(pair.currency0, "symbol"));
      pair.decimals0 = BigNumber.from(await readString(pair.currency0, "decimals")).toNumber();
      pair.symbol1 = String(await readString(pair.currency1, "symbol"));
      pair.decimals1 = BigNumber.from(await readString(pair.currency1, "decimals")).toNumber();
      pair.symbolA = pair.tokenA === pair.currency0 ? pair.symbol0 : pair.symbol1;
      pair.symbolB = pair.tokenB === pair.currency0 ? pair.symbol0 : pair.symbol1;
      pair.decimalsA = pair.tokenA === pair.currency0 ? pair.decimals0 : pair.decimals1;
      pair.decimalsB = pair.tokenB === pair.currency0 ? pair.decimals0 : pair.decimals1;
      return pair;
    }

    /** One scan: latest block, Swap logs of the seven pools over the window, table and spreads. */
    async function pollOnce() {
      if (!tokens) fail("start(tokenA, tokenB) first");
      var pair = state.pair || await loadPair(tokens[0], tokens[1]);
      var latest = BigNumber.from(await request("eth_blockNumber", [])).toNumber();
      var fromBlock = Math.max(0, latest - (windowBlocks - 1));
      var logs = await request("eth_getLogs", [{
        address: POOL_MANAGER,
        fromBlock: utils.hexValue(fromBlock),
        toBlock: utils.hexValue(latest),
        topics: [SWAP_TOPIC, pair.keys.map(poolId)],
      }]);
      if (!Array.isArray(logs)) fail("eth_getLogs did not return a list");
      var pools = summarisePools(pair.keys, logs);
      var scale = Math.pow(10, pair.decimals0 - pair.decimals1);
      pools.forEach(function (pool) { pool.displayPrice = pool.price === null ? null : pool.price * scale; });
      state.pair = pair;
      state.pools = pools;
      state.spreads = rankSpreads(pools, threshold());
      state.blockNumber = latest;
      state.fromBlock = fromBlock;
      state.lastPoll = now();
      state.lastError = null;
      state.retryAt = null;
      state.polls += 1;
      return state;
    }

    async function cycle() {
      if (!running) return;
      var mine = generation;
      var delay = pollMs;
      try {
        await pollOnce();
        if (mine !== generation) return;
        onUpdate(state);
      } catch (error) {
        if (mine !== generation) return;
        delay = retryMs;
        state.errors += 1;
        state.lastError = error && error.message ? error.message : String(error);
        state.retryAt = now() + retryMs;
        onError(error, state);
        onUpdate(state);
      }
      if (mine !== generation || !running) return;
      state.nextPollMs = delay;
      timer = setTimeout(cycle, delay);
    }

    function stop() {
      running = false;
      generation += 1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }

    function start(tokenA, tokenB) {
      stop();
      sortPair(tokenA, tokenB); // validate synchronously so a bad pair never starts a loop
      tokens = [tokenA, tokenB];
      state = freshState();
      running = true;
      return cycle();
    }

    return { start: start, stop: stop, pollOnce: pollOnce, loadPair: loadPair,
      getState: function () { return state; }, isRunning: function () { return running; } };
  }

  /** Permit2 uses uint160/uint48, NOT ERC20's approve(address,uint256). Zero amount revokes. */
  function encodePermit2Approve(token, spender, amount, expiration) {
    var approved = BigNumber.from(amount);
    var expires = BigNumber.from(expiration);
    if (approved.lt(0) || approved.gt(MAX_UINT160)) fail("amount does not fit uint160");
    if (expires.lt(0) || expires.gt(MAX_UINT48)) fail("expiration does not fit uint48 (Unix seconds)");
    return permit2Interface.encodeFunctionData("approve", [
      recipientAddress(token), recipientAddress(spender), approved, expires,
    ]);
  }

  /**
   * EIP-1193 wallet flow. No keys, signer, RPC URL, network switch or transaction on page load.
   * connect() binds an account on chain 4663; account/chain changes invalidate pending work.
   * options: onStatus(message), pollIntervalMs (default 1000), receiptTimeoutMs (default 120000).
   */
  function createWalletClient(provider, options) {
    options = options || {};
    if (!provider || typeof provider.request !== "function") fail("No wallet found; use an EIP-1193 browser wallet");
    var session = null;
    var prepared = null;
    var pollInterval = options.pollIntervalMs === undefined ? 1000 : options.pollIntervalMs;
    var receiptTimeout = options.receiptTimeoutMs === undefined ? 120000 : options.receiptTimeoutMs;
    if (!Number.isFinite(pollInterval) || pollInterval < 0 || !Number.isFinite(receiptTimeout) || receiptTimeout <= 0) {
      fail("invalid receipt polling settings");
    }
    var status = options.onStatus || function () {};
    var request = function (method, params) { return provider.request({ method: method, params: params || [] }); };

    function invalidate() { session = null; prepared = null; }
    if (typeof provider.on === "function") {
      ["accountsChanged", "chainChanged", "disconnect"].forEach(function (event) { provider.on(event, invalidate); });
    }

    async function assertSession(expected) {
      if (!expected || session !== expected) fail("Wallet changed or disconnected; connect again");
      var chain = await request("eth_chainId");
      if (!BigNumber.from(chain).eq(CHAIN_ID)) {
        invalidate();
        fail("Select Robinhood Chain (4663) in your wallet and reconnect");
      }
      var accounts = await request("eth_accounts");
      if (!accounts.length || utils.getAddress(accounts[0]) !== expected.account || session !== expected) {
        invalidate();
        fail("Wallet account changed; connect again");
      }
    }

    async function connect() {
      invalidate();
      var accounts = await request("eth_requestAccounts");
      if (!accounts.length) fail("Wallet returned no accounts");
      var next = { account: recipientAddress(accounts[0]) };
      session = next;
      try { await assertSession(next); } catch (error) { invalidate(); throw error; }
      return next.account;
    }

    async function timestamp() {
      var block = await request("eth_getBlockByNumber", ["latest", false]);
      if (!block || !block.timestamp) fail("Could not read the latest block timestamp");
      return BigNumber.from(block.timestamp).toNumber();
    }

    async function requireCode(address) {
      var code = await request("eth_getCode", [address, "latest"]);
      if (!code || /^0x0*$/.test(code)) fail("No contract code at " + address + " on this chain");
    }

    async function readPermit2(account, token) {
      var result = await request("eth_call", [{
        to: PERMIT2, data: permit2Interface.encodeFunctionData("allowance", [account, token, ROUTER]),
      }, "latest"]);
      return permit2Interface.decodeFunctionResult("allowance", result);
    }

    /**
     * The pair a swap settles in. Default: PONS (currency0) / USDG (currency1). A pair carries
     * currency0, currency1 and optional symbol0/symbol1 for messages. The "USDG" amount of the
     * original API is the currency1 amount and the "PONS" amount the currency0 amount.
     */
    function resolvePair(pair) {
      if (!pair) return { currency0: utils.getAddress(PONS), currency1: utils.getAddress(USDG), symbol0: "PONS", symbol1: "USDG" };
      var sorted = sortPair(pair.currency0, pair.currency1);
      if (sorted.currency0 !== utils.getAddress(pair.currency0)) fail("pair.currency0 must sort below pair.currency1");
      return { currency0: sorted.currency0, currency1: sorted.currency1,
        symbol0: pair.symbol0 || labelFor(sorted.currency0), symbol1: pair.symbol1 || labelFor(sorted.currency1) };
    }

    function labelFor(token, pair) {
      var address = utils.getAddress(token);
      if (pair && address === pair.currency0) return pair.symbol0;
      if (pair && address === pair.currency1) return pair.symbol1;
      if (address === utils.getAddress(USDG)) return "USDG";
      if (address === utils.getAddress(PONS)) return "PONS";
      return address;
    }

    /** [[currency1, amount1, label1], [currency0, amount0, label0]]: currency1 (USDG) first. */
    function pairEntries(pair, amount1, amount0) {
      return [[pair.currency1, amount1, pair.symbol1], [pair.currency0, amount0, pair.symbol0]];
    }

    async function checkTokenAllowances(usdgAmount, ponsAmount, pair) {
      var expected = session;
      var resolved = resolvePair(pair);
      await assertSession(expected);
      for (var entry of pairEntries(resolved, usdgAmount, ponsAmount)) {
        var result = await request("eth_call", [{
          to: entry[0], data: tokenInterface.encodeFunctionData("allowance", [expected.account, PERMIT2]),
        }, "latest"]);
        if (tokenInterface.decodeFunctionResult("allowance", result)[0].lt(entry[1])) {
          fail(entry[2] + " ERC20 allowance to Permit2 is too low. Approve the token to " + PERMIT2 +
            " first; an ERC20 approval to the router is not used");
        }
      }
      await assertSession(expected);
    }

    async function checkAllowances(usdgAmount, ponsAmount, validUntil, pair) {
      var expected = session;
      var resolved = resolvePair(pair);
      await checkTokenAllowances(usdgAmount, ponsAmount, resolved);
      var until = validUntil === undefined ? await timestamp() : validUntil;
      for (var entry of pairEntries(resolved, usdgAmount, ponsAmount)) {
        var allowed = await readPermit2(expected.account, entry[0]);
        if (allowed.amount.lt(entry[1]) || BigNumber.from(allowed.expiration).lt(until)) {
          fail(entry[2] + " Permit2 allowance is insufficient or expires too soon; click APPROVE PERMIT2");
        }
      }
      await assertSession(expected);
    }

    /** Native and ERC20 balances of `account` (default: the connected account). Read-only. */
    async function readBalances(tokens, account) {
      var owner = account ? utils.getAddress(account) : (session ? session.account : null);
      if (!owner) fail("Wallet changed or disconnected; connect again");
      var eth = BigNumber.from(await request("eth_getBalance", [owner, "latest"]));
      var balances = [];
      for (var token of tokens || []) {
        var result = await request("eth_call", [{
          to: utils.getAddress(token), data: tokenInterface.encodeFunctionData("balanceOf", [owner]),
        }, "latest"]);
        if (!result || result === "0x") fail("no balanceOf() at " + token);
        balances.push(tokenInterface.decodeFunctionResult("balanceOf", result)[0]);
      }
      return { account: owner, eth: eth, tokens: balances };
    }

    async function waitReceipt(hash, expected) {
      var start = Date.now();
      while (Date.now() - start < receiptTimeout) {
        await assertSession(expected);
        var receipt = await request("eth_getTransactionReceipt", [hash]);
        if (receipt) {
          await assertSession(expected);
          if (!receipt.status || !BigNumber.from(receipt.status).eq(1)) fail("Transaction reverted: " + hash);
          return receipt;
        }
        await new Promise(function (resolve) { setTimeout(resolve, pollInterval); });
      }
      var timeout = new Error("V4ArbEncoder: Confirmation timed out; transaction may still be pending. Check " + hash +
        " before retrying");
      timeout.pendingHash = hash;
      throw timeout;
    }

    async function submit(transaction, expected, label) {
      await assertSession(expected);
      var hash = await request("eth_sendTransaction", [transaction]);
      status(label + " submitted: " + hash);
      var receipt = await waitReceipt(hash, expected);
      status(label + " confirmed: " + hash);
      return receipt;
    }

    /** Calls Permit2.approve through the wallet and resolves ONLY after a successful receipt. */
    async function approveForSession(token, spender, amount, expiration, expected, pair) {
      var data = encodePermit2Approve(token, spender, amount, expiration);
      await assertSession(expected);
      if (!BigNumber.from(amount).isZero() && BigNumber.from(expiration).lte(await timestamp())) {
        fail("expiration must be a future Unix timestamp in seconds");
      }
      await requireCode(PERMIT2);
      prepared = null;
      var label = labelFor(token, pair);
      return submit({ from: expected.account, to: PERMIT2, data: data, value: "0x0",
        chainId: utils.hexValue(CHAIN_ID) }, expected, label + " Permit2 approval");
    }

    function approvePermit2(token, spender, amount, expiration) {
      return approveForSession(token, spender, amount, expiration, session);
    }

    /**
     * currency1 (USDG) then currency0 (PONS); never request the next approval before the
     * previous receipt succeeds. `pair` is optional and defaults to PONS/USDG.
     */
    async function approveBothPermit2(usdgAmount, ponsAmount, expiration, pair) {
      var expected = session;
      var resolved = resolvePair(pair);
      // Validate BOTH before the first wallet transaction, so an invalid PONS limit sends nothing.
      encodePermit2Approve(resolved.currency1, ROUTER, usdgAmount, expiration);
      encodePermit2Approve(resolved.currency0, ROUTER, ponsAmount, expiration);
      if (BigNumber.from(usdgAmount).isZero() || BigNumber.from(ponsAmount).isZero()) fail("approval limits must be positive");
      await assertSession(expected);
      var validUntil = (await timestamp()) + 1200;
      if (BigNumber.from(expiration).lt(validUntil)) fail("approval expiration must cover the next 20 minutes");
      prepared = null;
      for (var entry of pairEntries(resolved, usdgAmount, ponsAmount)) {
        await assertSession(expected);
        var allowed = await readPermit2(expected.account, entry[0]);
        if (session !== expected) fail("Wallet changed or disconnected; connect again");
        if (allowed.amount.gte(entry[1]) && BigNumber.from(allowed.expiration).gte(validUntil)) {
          status(entry[2] + " Permit2 allowance already sufficient; skipped");
          continue;
        }
        await approveForSession(entry[0], ROUTER, entry[1], expiration, expected, resolved);
      }
      await assertSession(expected);
    }

    /**
     * Build with the connected account as recipient, check allowances, and eth_call the exact tx.
     * args = { usdgIn, ponsAmount, minUsdgOut, deadline?, buyPool?, sellPool?, pair? }. The pools
     * default to POOL_A / POOL_B; both must trade the same pair, whose currency1 is the input.
     */
    async function prepareSwap(args) {
      prepared = null;
      if (!args) fail("args are required");
      // Snapshot values before the first await; later caller edits cannot change what was simulated.
      var buyPool = normalisePoolKey(args.buyPool || POOL_A);
      var sellPool = normalisePoolKey(args.sellPool || POOL_B);
      if (buyPool.currency0 !== sellPool.currency0 || buyPool.currency1 !== sellPool.currency1) {
        fail("both pools must trade the same pair");
      }
      if (poolId(buyPool) === poolId(sellPool)) fail("buy and sell pool are the same pool");
      var pair = resolvePair({ currency0: buyPool.currency0, currency1: buyPool.currency1,
        symbol0: args.pair && args.pair.symbol0, symbol1: args.pair && args.pair.symbol1 });
      args = { usdgIn: uint128(args.usdgIn, "usdgIn"), ponsAmount: uint128(args.ponsAmount, "ponsAmount"),
        minUsdgOut: uint128(args.minUsdgOut, "minUsdgOut"), deadline: args.deadline };
      var expected = session;
      await assertSession(expected);
      var now = await timestamp();
      var deadline = args.deadline === undefined ? now + 1200 : BigNumber.from(args.deadline).toNumber();
      if (deadline <= now) fail("Swap deadline has expired; build and dry run again");
      var data = buildCalldata({ recipient: expected.account, usdgIn: args.usdgIn, ponsAmount: args.ponsAmount,
        minUsdgOut: args.minUsdgOut, deadline: deadline, buyPool: buyPool, sellPool: sellPool });
      await requireCode(ROUTER);
      await checkAllowances(args.usdgIn, args.ponsAmount, deadline, pair);
      var transaction = Object.freeze({ from: expected.account, to: ROUTER, data: data, value: "0x0",
        chainId: utils.hexValue(CHAIN_ID) });
      await request("eth_call", [transaction, "latest"]);
      await assertSession(expected);
      prepared = Object.freeze({ transaction: transaction, deadline: deadline,
        usdgIn: BigNumber.from(args.usdgIn), ponsAmount: BigNumber.from(args.ponsAmount),
        buyPool: Object.freeze(buyPool), sellPool: Object.freeze(sellPool), pair: Object.freeze(pair) });
      status("Calldata built; eth_call dry run succeeded");
      return prepared;
    }

    /** Always re-simulate before requesting a signature. No force-send path after a failed call. */
    async function sendSwap(candidate) {
      if (!candidate || candidate !== prepared) fail("Build and dry run this swap first");
      prepared = null; // one submission per successful preparation, including rejected signatures
      var expected = session;
      await assertSession(expected);
      if ((await timestamp()) >= candidate.deadline) fail("Swap deadline has expired; build and dry run again");
      await checkAllowances(candidate.usdgIn, candidate.ponsAmount, candidate.deadline, candidate.pair);
      await request("eth_call", [candidate.transaction, "latest"]);
      return submit(candidate.transaction, expected, "Swap");
    }

    function transferTarget(to, expected) {
      var target = recipientAddress(to);
      if (target === expected.account) fail("The new wallet must differ from the connected account");
      return target;
    }

    /**
     * token.transfer(to, balanceOf(account)) through the wallet: the WHOLE balance, irreversible.
     * Simulated with eth_call first; resolves after a successful receipt with { hash, amount }.
     */
    async function transferAllToken(token, to) {
      var expected = session;
      await assertSession(expected);
      var target = transferTarget(to, expected);
      var asset = utils.getAddress(token);
      await requireCode(asset);
      var balance = (await readBalances([asset], expected.account)).tokens[0];
      if (balance.isZero()) fail("Nothing to transfer: the " + labelFor(asset) + " balance is 0");
      var transaction = { from: expected.account, to: asset, value: "0x0",
        data: tokenInterface.encodeFunctionData("transfer", [target, balance]), chainId: utils.hexValue(CHAIN_ID) };
      var result = await request("eth_call", [transaction, "latest"]);
      if (result && result !== "0x" && !tokenInterface.decodeFunctionResult("transfer", result)[0]) {
        fail("token.transfer simulation returned false");
      }
      prepared = null;
      var receipt = await submit(transaction, expected, labelFor(asset) + " transfer of " + balance.toString() + " base units");
      return { hash: receipt.transactionHash, amount: balance, receipt: receipt };
    }

    /**
     * Sends the whole native balance minus a gas reserve of 2 x (estimated gas x gas price); the
     * reserve that is not spent stays behind as dust. Resolves after a successful receipt.
     */
    async function transferAllEth(to) {
      var expected = session;
      await assertSession(expected);
      var target = transferTarget(to, expected);
      var balance = (await readBalances([], expected.account)).eth;
      var gasPrice = BigNumber.from(await request("eth_gasPrice", []));
      var gas = BigNumber.from(await request("eth_estimateGas", [{ from: expected.account, to: target, value: "0x1" }]));
      if (gas.isZero() || gasPrice.isZero()) fail("Gas estimate or gas price is zero; cannot size the transfer");
      var reserve = gas.mul(gasPrice).mul(2);
      if (balance.lte(reserve)) fail("ETH balance " + balance.toString() + " wei does not cover the gas reserve of " + reserve.toString() + " wei");
      var value = balance.sub(reserve);
      var transaction = { from: expected.account, to: target, value: value.toHexString(), gas: gas.toHexString(),
        gasPrice: gasPrice.toHexString(), chainId: utils.hexValue(CHAIN_ID) };
      prepared = null;
      var receipt = await submit(transaction, expected, "ETH transfer of " + value.toString() + " wei");
      return { hash: receipt.transactionHash, amount: value, reserve: reserve, receipt: receipt };
    }

    function destroy() {
      invalidate();
      if (typeof provider.removeListener === "function") {
        ["accountsChanged", "chainChanged", "disconnect"].forEach(function (event) { provider.removeListener(event, invalidate); });
      }
    }

    return { connect: connect, timestamp: timestamp, approvePermit2: approvePermit2,
      approveBothPermit2: approveBothPermit2, checkTokenAllowances: checkTokenAllowances,
      checkAllowances: checkAllowances, prepareSwap: prepareSwap, sendSwap: sendSwap,
      readBalances: readBalances, transferAllToken: transferAllToken, transferAllEth: transferAllEth,
      request: request, account: function () { return session ? session.account : null; },
      invalidate: invalidate, destroy: destroy };
  }

  /** Four-argument browser convenience API. For repeated operations use createWalletClient(). */
  async function approvePermit2(token, spender, amount, expiration) {
    var client = createWalletClient(typeof window !== "undefined" ? window.ethereum : undefined);
    try {
      await client.connect();
      return await client.approvePermit2(token, spender, amount, expiration);
    } finally { client.destroy(); }
  }

  return {
    ROUTER: ROUTER,
    PERMIT2: PERMIT2,
    POOL_MANAGER: POOL_MANAGER,
    RPC_URL: RPC_URL,
    PERMIT2_ABI: PERMIT2_ABI,
    CHAIN_ID: CHAIN_ID,
    PONS: PONS,
    USDG: USDG,
    NO_HOOKS: NO_HOOKS,
    POOL_A: POOL_A,
    POOL_B: POOL_B,
    SWAP_TOPIC: SWAP_TOPIC,
    FEE_TIERS: FEE_TIERS,
    LOG_WINDOW_BLOCKS: LOG_WINDOW_BLOCKS,
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    RPC_RETRY_MS: RPC_RETRY_MS,
    SLIPPAGE_BPS: SLIPPAGE_BPS,
    QUOTE_REVERT_SELECTOR: QUOTE_REVERT_SELECTOR,
    sortPair: sortPair,
    poolKeysFor: poolKeysFor,
    poolId: poolId,
    tickToPrice: tickToPrice,
    decodeSwapLog: decodeSwapLog,
    summarisePools: summarisePools,
    feeCostPercent: feeCostPercent,
    spreadPercent: spreadPercent,
    rankSpreads: rankSpreads,
    applySlippage: applySlippage,
    createRpcClient: createRpcClient,
    extractRevertData: extractRevertData,
    encodeQuoteCalldata: encodeQuoteCalldata,
    decodeQuoteRevert: decodeQuoteRevert,
    quoteExactIn: quoteExactIn,
    createPoolMonitor: createPoolMonitor,
    EXECUTE_SELECTOR: EXECUTE_SELECTOR,
    COMMAND_V4_SWAP: COMMAND_V4_SWAP,
    ACTIONS_SWAP_SETTLE_TAKE: ACTIONS_SWAP_SETTLE_TAKE,
    ACTIONS_SWAP_SWAP_TAKE: ACTIONS_SWAP_SWAP_TAKE,
    OPEN_DELTA: OPEN_DELTA,
    MSG_SENDER: MSG_SENDER,
    MAX_UINT128: MAX_UINT128,
    MAX_UINT160: MAX_UINT160,
    MAX_UINT48: MAX_UINT48,
    MAX_UINT256: MAX_UINT256,
    encodeSwapParams: encodeSwapParams,
    encodeSettleAll: encodeSettleAll,
    encodeTake: encodeTake,
    encodeActions: encodeActions,
    encodeV4Swap: encodeV4Swap,
    encodeExecute: encodeExecute,
    buildCalldata: buildCalldata,
    buildAtomicCalldata: buildAtomicCalldata,
    encodePermit2Approve: encodePermit2Approve,
    approvePermit2: approvePermit2,
    createWalletClient: createWalletClient,
  };
});
