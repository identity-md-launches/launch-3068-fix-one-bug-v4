/**
 * Cross-DEX price + LP depth reader for the Pons Arb UI (job 9). READ-ONLY: eth_call only, no
 * swaps, no approvals, no wallet. Reads the pools of the active Token A / Token B pair on the
 * non-Uniswap DEXes of Robinhood Chain (4663) and gives the page one row per pool: price
 * (1.0001^tick, token1 per token0 in base units, the same math as the V3 reads), raw liquidity()
 * and a status, plus the spread against the best Uniswap V3 price of the same pair.
 *
 * Factory keys. The SushiSwap V3 factory is a UniswapV3Factory: getPool(token0, token1, fee).
 * The Ramses factory at 0xE0c4…54A8 is a Ramses CL (Slipstream-shaped) factory keyed by tick
 * spacing: getPool(token0, token1, int24 tickSpacing); the fee-keyed selector is not in its runtime
 * and every fee-keyed call reverts (verified live 2026-11-10, see docs/cross-dex-live.json). Its
 * pools carry their own fee(), which can change, so CL rows read the fee instead of configuring it.
 *
 * Errors never throw out of a poll: a failed read marks its row "error" and keeps the last good
 * price and liquidity; a failed factory read marks the DEX "error"; a zero getPool address is
 * skipped silently. With no pools on either DEX the table is simply empty.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/ethers-5.7.2.umd.min.js"));
  } else {
    root.CrossDexReader = factory(root.ethers);
  }
})(typeof self !== "undefined" ? self : this, function (ethersLib) {
  "use strict";

  var ethers = ethersLib.ethers || ethersLib;
  var utils = ethers.utils;
  var BigNumber = ethers.BigNumber;
  var abi = utils.defaultAbiCoder;

  var CHAIN_ID = 4663;
  /** Same cadence as the existing monitor. */
  var POLL_INTERVAL_MS = 30000;

  var DEXES = [
    {
      name: "SushiSwap V3",
      type: "v3",
      factory: "0xE51960f1B45f1C9FB6D166E6a884F866fC70433B",
      fees: [100, 500, 3000],
    },
    {
      // The brief lists this DEX as type "v3" with fees [100, 500, 3000]; the deployed factory is
      // tick-spacing keyed (see the file comment), so it is read as type "cl" over every spacing the
      // factory has enabled (tickSpacingInitialFee(ts) != 0). Pool fees are read from each pool.
      name: "Ramses V3",
      type: "cl",
      factory: "0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8",
      tickSpacings: [1, 5, 10, 50, 100, 200, 500],
    },
  ];

  var STATUS_OK = "OK";
  var STATUS_NO_POOL = "no pool";
  var STATUS_ERROR = "error";

  var MIN_TICK = -887272;
  var MAX_TICK = 887272;
  var MAX_UINT128 = BigNumber.from(2).pow(128).sub(1);

  var feeFactoryInterface = new utils.Interface(["function getPool(address,address,uint24) view returns (address)"]);
  var tickSpacingFactoryInterface = new utils.Interface(["function getPool(address,address,int24) view returns (address)"]);
  var poolInterface = new utils.Interface([
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick)",
    "function liquidity() view returns (uint128)",
    "function fee() view returns (uint24)",
  ]);

  function fail(message) { throw new Error("CrossDexReader: " + message); }

  function messageOf(error) { return error && error.message ? error.message : String(error); }

  // ------------------------------------------------------------------ pure helpers

  /** token0 is the lower address (BigInt comparison, as the page sorts currencies). */
  function sortTokens(tokenA, tokenB) {
    if (!tokenA || !tokenB) fail("both token addresses are required");
    var a = utils.getAddress(String(tokenA).trim());
    var b = utils.getAddress(String(tokenB).trim());
    if (a === ethers.constants.AddressZero || b === ethers.constants.AddressZero) fail("enter ERC20 token addresses");
    if (a === b) fail("Token A and Token B must be different addresses");
    /* global BigInt */
    return BigInt(a) < BigInt(b) ? { token0: a, token1: b } : { token0: b, token1: a };
  }

  /** Price of token0 in token1 base units: 1.0001^tick. */
  function tickToPrice(tick) {
    var t = Number(tick);
    if (!Number.isInteger(t) || t < MIN_TICK || t > MAX_TICK) fail("tick out of range");
    return Math.pow(1.0001, t);
  }

  /** "0.30%" for 3000; "—" for an unknown fee. */
  function formatFee(fee) {
    if (fee === null || fee === undefined) return "—";
    var value = Number(fee);
    if (!Number.isFinite(value) || value < 0) fail("invalid fee");
    return (value / 10000).toFixed(2) + "%";
  }

  /** The raw liquidity() value with thousands separators: 12410 → "12,410". "—" for none. */
  function formatLiquidity(liquidity) {
    if (liquidity === null || liquidity === undefined) return "—";
    var digits = BigNumber.from(liquidity).toString();
    return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }

  /** (DEX price − Uni price) / Uni price × 100; null when either side is missing. */
  function spreadVsUni(dexPrice, uniPrice) {
    if (!(typeof dexPrice === "number" && dexPrice > 0) || !(typeof uniPrice === "number" && uniPrice > 0)) return null;
    return (dexPrice - uniPrice) / uniPrice * 100;
  }

  /** "+0.05%", "-0.11%", "0.00%"; "—" for null. */
  function formatSpread(value) {
    if (value === null || value === undefined || !Number.isFinite(value)) return "—";
    var text = value.toFixed(2);
    if (text === "-0.00") text = "0.00";
    return (value > 0 && text !== "0.00" ? "+" : "") + text + "%";
  }

  function isHexWords(result, words) {
    return typeof result === "string" && utils.isHexString(result) && utils.hexDataLength(result) >= 32 * words;
  }

  /**
   * The best Uniswap V3 reference for the pair: among the monitor's V3 pools of these two tokens that
   * are priced and tradeable (status OK or none), the one with the greatest active liquidity; with no
   * liquidity figures, the first priced pool (lowest fee). Returns { price, pool } or null.
   */
  function bestUniPool(pools, pair) {
    if (!Array.isArray(pools)) return null;
    var best = null;
    pools.forEach(function (pool) {
      if (!pool || (pool.protocol || "V4") !== "V3") return;
      if (!(typeof pool.price === "number" && pool.price > 0)) return;
      if (pool.status !== undefined && pool.status !== STATUS_OK) return;
      if (pair) {
        if (!pool.currency0 || !pool.currency1) return;
        if (pool.currency0.toLowerCase() !== pair.token0.toLowerCase() || pool.currency1.toLowerCase() !== pair.token1.toLowerCase()) return;
      }
      var liquidity = pool.liquidity === null || pool.liquidity === undefined ? BigNumber.from(0) : BigNumber.from(pool.liquidity);
      if (pool.liquidity !== null && pool.liquidity !== undefined && liquidity.isZero()) return; // EMPTY: never a reference
      if (best === null || liquidity.gt(best.liquidity)) best = { price: pool.price, pool: pool, liquidity: liquidity };
    });
    return best === null ? null : { price: best.price, pool: best.pool };
  }

  function bestUniPrice(pools, pair) {
    var best = bestUniPool(pools, pair);
    return best === null ? null : best.price;
  }

  // ------------------------------------------------------------------ eth_call payloads and replies

  function checkDex(dex) {
    if (!dex || typeof dex.name !== "string" || !dex.name) fail("DEX needs a name");
    if (dex.type !== "v3" && dex.type !== "cl") fail("DEX " + dex.name + ": type must be v3 or cl");
    utils.getAddress(dex.factory);
    var tiers = dex.type === "v3" ? dex.fees : dex.tickSpacings;
    if (!Array.isArray(tiers) || !tiers.length) fail("DEX " + dex.name + ": " + (dex.type === "v3" ? "fees" : "tickSpacings") + " must be a non-empty array");
    tiers.forEach(function (tier) {
      if (!Number.isInteger(Number(tier))) fail("DEX " + dex.name + ": invalid tier " + tier);
    });
    return dex;
  }

  /** The getPool eth_call of every configured tier of one DEX, in configuration order. */
  function discoveryCalls(dex, pair) {
    checkDex(dex);
    var factory = utils.getAddress(dex.factory);
    if (dex.type === "v3") {
      return dex.fees.map(function (fee) {
        return { dex: dex.name, type: "v3", tier: Number(fee), fee: Number(fee), tickSpacing: null, method: "eth_call",
          params: [{ to: factory, data: feeFactoryInterface.encodeFunctionData("getPool", [pair.token0, pair.token1, Number(fee)]) }, "latest"] };
      });
    }
    return dex.tickSpacings.map(function (tickSpacing) {
      return { dex: dex.name, type: "cl", tier: Number(tickSpacing), fee: null, tickSpacing: Number(tickSpacing), method: "eth_call",
        params: [{ to: factory, data: tickSpacingFactoryInterface.encodeFunctionData("getPool", [pair.token0, pair.token1, Number(tickSpacing)]) }, "latest"] };
    });
  }

  /** The pool address of a getPool reply, or null for the zero address (skipped silently). */
  function decodePoolAddress(result) {
    if (!isHexWords(result, 1)) fail("getPool reply is not a 32-byte word");
    var address = abi.decode(["address"], utils.hexDataSlice(result, 0, 32))[0];
    return address === ethers.constants.AddressZero ? null : address;
  }

  /** slot0() and liquidity() of a pool; CL pools also fee(), which is per pool and may change. */
  function poolReadCalls(dex, address) {
    var to = utils.getAddress(address);
    var calls = [
      { name: "slot0", method: "eth_call", params: [{ to: to, data: poolInterface.encodeFunctionData("slot0", []) }, "latest"] },
      { name: "liquidity", method: "eth_call", params: [{ to: to, data: poolInterface.encodeFunctionData("liquidity", []) }, "latest"] },
    ];
    if (dex.type === "cl") calls.push({ name: "fee", method: "eth_call", params: [{ to: to, data: poolInterface.encodeFunctionData("fee", []) }, "latest"] });
    return calls;
  }

  /** sqrtPriceX96 and tick: the first two words of any slot0 layout (seven outputs live, six declared). */
  function decodeSlot0(result) {
    if (!isHexWords(result, 2)) fail("slot0 reply is too short");
    var decoded = abi.decode(["uint160", "int24"], utils.hexDataSlice(result, 0, 64));
    return { sqrtPriceX96: decoded[0], tick: Number(decoded[1]) };
  }

  function decodeLiquidity(result) {
    if (!isHexWords(result, 1)) fail("liquidity reply is not a 32-byte word");
    var value = BigNumber.from(utils.hexDataSlice(result, 0, 32));
    if (value.gt(MAX_UINT128)) fail("liquidity does not fit uint128");
    return value;
  }

  function decodeFee(result) {
    if (!isHexWords(result, 1)) fail("fee reply is not a 32-byte word");
    return Number(abi.decode(["uint24"], utils.hexDataSlice(result, 0, 32))[0]);
  }

  // ------------------------------------------------------------------ the reader

  /**
   * Sends a list of {method, params} calls through batchRequest when the client has one (one HTTP
   * request), else one request each. Resolves an array aligned with the calls whose entries are the
   * raw result or { error }; rejects only when the transport itself failed.
   */
  async function sendAll(options, calls) {
    if (!calls.length) return [];
    if (typeof options.batchRequest === "function") {
      var replies = await options.batchRequest(calls.map(function (call) { return { method: call.method, params: call.params }; }));
      if (!Array.isArray(replies) || replies.length !== calls.length) fail("batch reply does not match the calls");
      return replies;
    }
    return Promise.all(calls.map(function (call) {
      return Promise.resolve().then(function () { return options.request(call.method, call.params); })
        .then(function (result) { return result; }, function (error) { return { error: error }; });
    }));
  }

  function rowKey(dexName, type, tier) { return dexName + "|" + type + "|" + tier; }

  function emptyRow(entry) {
    return { dex: entry.dex, type: entry.type, tier: entry.tier, fee: entry.fee, tickSpacing: entry.tickSpacing, address: null,
      tick: null, sqrtPriceX96: null, price: null, liquidity: null, status: STATUS_NO_POOL, error: null, updatedAt: null };
  }

  function copyRow(row) { return Object.assign({}, row); }

  /**
   * createCrossDexReader({ request, batchRequest?, dexes?, pollIntervalMs?, onUpdate?, now? })
   *   .start(tokenA, tokenB)    — polls every pollIntervalMs until stop(); resolves after the first read
   *   .readOnce(tokenA, tokenB) — one read, no timer (Manual mode: same cadence as READ PRICES)
   *   .poll()                   — one read of the current pair
   *   .stop()                   — cancels the timer; a read in flight is discarded
   *   .getState()               — { pair, rows, lastPoll, lastError, errors, polls, polling }
   * A row: { dex, type, tier, fee, tickSpacing, address, tick, sqrtPriceX96, price, liquidity, status, error, updatedAt }.
   * Rows keep DEX configuration order; a DEX whose factory read failed and has no row gets one
   * placeholder row with status "error" so the failure is visible.
   */
  function createCrossDexReader(options) {
    options = options || {};
    if (typeof options.request !== "function" && typeof options.batchRequest !== "function") fail("request function is required");
    var dexes = (options.dexes || DEXES).map(checkDex);
    var pollMs = options.pollIntervalMs === undefined ? POLL_INTERVAL_MS : options.pollIntervalMs;
    if (!(Number.isFinite(pollMs) && pollMs > 0)) fail("pollIntervalMs must be positive");
    var now = typeof options.now === "function" ? options.now : function () { return Date.now(); };
    var onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : function () {};
    var state = { pair: null, rows: [], lastPoll: null, lastError: null, errors: 0, polls: 0, polling: false };
    var timer = null;
    var generation = 0;

    function getState() {
      return { pair: state.pair ? { token0: state.pair.token0, token1: state.pair.token1 } : null, rows: state.rows.map(copyRow),
        lastPoll: state.lastPoll, lastError: state.lastError, errors: state.errors, polls: state.polls, polling: state.polling };
    }

    function notify() { onUpdate(getState()); }

    function stop() {
      generation += 1;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      state.polling = false;
    }

    function previousRows() {
      var byKey = {};
      state.rows.forEach(function (row) { if (row.tier !== null) byKey[rowKey(row.dex, row.type, row.tier)] = row; });
      return byKey;
    }

    function withError(row, error) {
      var copy = copyRow(row);
      copy.status = STATUS_ERROR;
      copy.error = messageOf(error);
      return copy; // price, liquidity and tick are the last good values
    }

    async function cycle(gen, pair) {
      var previous = previousRows();
      var entries = [];
      dexes.forEach(function (dex) { discoveryCalls(dex, pair).forEach(function (call) { entries.push({ dex: dex, call: call }); }); });
      var rows = [];
      var anyError = false;
      var timestamp = now();
      var discovered;
      try {
        discovered = await sendAll(options, entries.map(function (entry) { return entry.call; }));
      } catch (error) {
        // The transport failed: every known row shows "error" and keeps its data; nothing is dropped.
        if (gen !== generation) return;
        var kept = state.rows.map(function (row) { return withError(row, error); });
        if (!kept.length) kept = dexes.map(function (dex) { return Object.assign(emptyRow({ dex: dex.name, type: dex.type, tier: null, fee: null, tickSpacing: null }), { status: STATUS_ERROR, error: messageOf(error) }); });
        state.rows = kept;
        state.lastError = messageOf(error);
        state.errors += 1;
        state.polls += 1;
        return;
      }
      if (gen !== generation) return;
      var reads = [];
      var dexFailures = {};
      var dexRows = {};
      entries.forEach(function (entry, i) {
        var call = entry.call;
        var key = rowKey(call.dex, call.type, call.tier);
        var prev = previous[key];
        var reply = discovered[i];
        var failure = null;
        var address = null;
        if (reply && reply.error) failure = reply.error;
        else {
          try { address = decodePoolAddress(reply); } catch (error) { failure = error; }
        }
        dexRows[call.dex] = dexRows[call.dex] || 0;
        if (failure) {
          anyError = true;
          dexFailures[call.dex] = messageOf(failure);
          if (prev) { rows.push(withError(prev, failure)); dexRows[call.dex] += 1; }
          return;
        }
        if (address === null) {
          // Skipped silently, unless the tier had a pool before: then the row stays and says so.
          if (prev && prev.address) { var gone = copyRow(prev); gone.status = STATUS_NO_POOL; gone.error = null; rows.push(gone); dexRows[call.dex] += 1; }
          return;
        }
        var row = prev && prev.address && prev.address.toLowerCase() === address.toLowerCase() ? copyRow(prev) : emptyRow(call);
        row.address = address;
        row.error = null;
        rows.push(row);
        dexRows[call.dex] += 1;
        reads.push({ row: row, calls: poolReadCalls(entry.dex, address) });
      });
      // A DEX whose factory could not be read and has nothing to show gets one visible "error" row.
      dexes.forEach(function (dex) {
        if (dexFailures[dex.name] && !dexRows[dex.name]) {
          var placeholder = emptyRow({ dex: dex.name, type: dex.type, tier: null, fee: null, tickSpacing: null });
          placeholder.status = STATUS_ERROR;
          placeholder.error = dexFailures[dex.name];
          rows.push(placeholder);
        }
      });
      if (reads.length) {
        var flat = [];
        reads.forEach(function (read) { read.calls.forEach(function (call) { flat.push(call); }); });
        var replies = null;
        var transportError = null;
        try { replies = await sendAll(options, flat); } catch (error) { transportError = error; }
        if (gen !== generation) return;
        var offset = 0;
        reads.forEach(function (read) {
          var row = read.row;
          var own = replies === null ? null : replies.slice(offset, offset + read.calls.length);
          offset += read.calls.length;
          try {
            if (transportError) throw transportError;
            own.forEach(function (reply) { if (reply && reply.error) throw reply.error; });
            var slot0 = decodeSlot0(own[0]);
            var liquidity = decodeLiquidity(own[1]);
            var fee = read.calls.length > 2 ? decodeFee(own[2]) : row.fee;
            row.sqrtPriceX96 = slot0.sqrtPriceX96.toString();
            row.liquidity = liquidity.toString();
            row.fee = fee;
            row.updatedAt = timestamp;
            if (slot0.sqrtPriceX96.isZero()) {
              // Created but never initialised: there is no price to show.
              row.tick = null;
              row.price = null;
              row.status = STATUS_NO_POOL;
            } else {
              row.tick = slot0.tick;
              row.price = tickToPrice(slot0.tick);
              row.status = STATUS_OK;
            }
            row.error = null;
          } catch (error) {
            anyError = true;
            row.status = STATUS_ERROR;
            row.error = messageOf(error);
            // price, liquidity and tick stay as last read (null when never read)
          }
        });
      }
      // Rows in DEX order, then configuration order (placeholders after the DEX's own rows).
      var order = {};
      dexes.forEach(function (dex, d) {
        var tiers = dex.type === "v3" ? dex.fees : dex.tickSpacings;
        tiers.forEach(function (tier, t) { order[rowKey(dex.name, dex.type, Number(tier))] = d * 1000 + t; });
        order[rowKey(dex.name, dex.type, null)] = d * 1000 + 999;
      });
      rows.sort(function (x, y) { return order[rowKey(x.dex, x.type, x.tier)] - order[rowKey(y.dex, y.type, y.tier)]; });
      state.rows = rows;
      state.lastPoll = timestamp;
      state.lastError = null;
      state.polls += 1;
      if (anyError) state.errors += 1;
    }

    async function runOnce(gen, schedule) {
      var pair = state.pair;
      state.polling = true;
      try {
        await cycle(gen, pair);
      } catch (error) {
        // Defensive: a bug in the cycle itself must not stop the page; it shows as a poll error.
        if (gen === generation) { state.lastError = messageOf(error); state.errors += 1; state.polls += 1; }
      } finally {
        if (gen === generation) {
          state.polling = false;
          // Named so a test harness can tell this timer from the monitor's.
          if (schedule) timer = setTimeout(function crossDexPoll() { timer = null; runOnce(gen, true); }, pollMs);
          notify();
        }
      }
    }

    function begin(tokenA, tokenB, schedule) {
      var pair = sortTokens(tokenA, tokenB); // throws synchronously: nothing is requested for a bad field
      stop();
      var gen = generation;
      state.pair = pair;
      state.rows = [];
      state.lastPoll = null;
      state.lastError = null;
      return runOnce(gen, schedule);
    }

    return {
      start: function (tokenA, tokenB) { return begin(tokenA, tokenB, true); },
      readOnce: function (tokenA, tokenB) { return begin(tokenA, tokenB, false); },
      poll: function () { if (!state.pair) fail("no pair: call start or readOnce first"); return runOnce(generation, false); },
      stop: stop,
      getState: getState,
      dexes: dexes,
    };
  }

  return {
    CHAIN_ID: CHAIN_ID,
    DEXES: DEXES,
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    STATUS_OK: STATUS_OK,
    STATUS_NO_POOL: STATUS_NO_POOL,
    STATUS_ERROR: STATUS_ERROR,
    MIN_TICK: MIN_TICK,
    MAX_TICK: MAX_TICK,
    sortTokens: sortTokens,
    tickToPrice: tickToPrice,
    formatFee: formatFee,
    formatLiquidity: formatLiquidity,
    spreadVsUni: spreadVsUni,
    formatSpread: formatSpread,
    bestUniPool: bestUniPool,
    bestUniPrice: bestUniPrice,
    discoveryCalls: discoveryCalls,
    decodePoolAddress: decodePoolAddress,
    poolReadCalls: poolReadCalls,
    decodeSlot0: decodeSlot0,
    decodeLiquidity: decodeLiquidity,
    decodeFee: decodeFee,
    createCrossDexReader: createCrossDexReader,
  };
});
