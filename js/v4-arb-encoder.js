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
 *
 * Follow-up 3.5 adds: a user-settable log window (50 to 50000 blocks, default 3000), the elapsed
 * time since each pool's last swap (latest block timestamp minus swap block timestamp), a slot0
 * read per active pool, and pool statuses (OK, STALE, EMPTY, UNKNOWN) that keep a pool out of the
 * spreads and auto mode (poolStatus, annotatePools, autoDecision).
 *
 * Follow-up 5 adds Manual mode: two pasted V3 pool addresses read with eth_call only, token0,
 * token1, fee and slot0 per pool, one request at a time, no logs, no batch, no block reads
 * (parseManualPoolAddress, readManualPool, validateManualPools, manualSpread, createManualMonitor).
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
  var LOG_WINDOW_BLOCKS = 3000;
  var MIN_WINDOW_BLOCKS = 50;
  var MAX_WINDOW_BLOCKS = 50000;
  var MAX_STALENESS_SECONDS = 7200; // default of the page's "Max staleness" field
  var STALENESS_YELLOW_SECONDS = 1800; // Last Swap colour: green below 30 min
  var STALENESS_RED_SECONDS = 7200; // Last Swap colour: red above 2 h
  // The deployed PoolManager has no getSlot0(bytes32): that call reverts with empty data on chain
  // 4663 (checked 2026-11-07). Uniswap's own StateLibrary.getSlot0 reads the same value this way:
  // extsload(keccak256(abi.encode(poolId, POOLS_SLOT))).
  var POOLS_SLOT = 6;
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

  var poolManagerInterface = new utils.Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);

  var POOL_KEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
  var EXACT_IN_SINGLE_TYPE =
    "tuple(" +
    POOL_KEY_TYPE +
    " poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,uint256 minHopPriceX36,bytes hookData)";

  // The two pools named in the brief. Both exist on chain 4663 (checked through extsload).
  var POOL_A = { currency0: PONS, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: NO_HOOKS };
  var POOL_B = { currency0: PONS, currency1: USDG, fee: 30000, tickSpacing: 600, hooks: NO_HOOKS };

  // V3 additions. The supplied deployments use standard SwapRouter02, not multiswap/getAmountsIn.
  var V3_FACTORY = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";
  var V3_ROUTER = "0xcaf681a66d020601342297493863e78c959e5cb2";
  var WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
  var V3_FEE_TIERS = [100, 500, 3000, 10000];
  // Derive the topic from the declared ABI; indexed addresses live in topics, not data words.
  var V3_SWAP_TOPIC = utils.id("Swap(address,address,int256,int256,uint160,uint128,int24)");
  var v3FactoryInterface = new utils.Interface(["function getPool(address,address,uint24) view returns (address)"]);
  var v3PoolInterface = new utils.Interface(["function liquidity() view returns (uint128)"]);
  var v3RouterInterface = new utils.Interface([
    "function exactInput(tuple(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256)",
    "function multicall(uint256 deadline,bytes[] data) payable returns (bytes[])",
  ]);
  var v3TokenInterface = new utils.Interface(["function approve(address spender,uint256 amount) returns (bool)"]);
  var V3_QUOTE_SELECTOR = utils.id("V3QuoteResult(uint256,uint256)").slice(0, 10);
  // BEGIN GENERATED V3 QUOTE BYTECODE (scripts/embed-v3-quote.js)
  var V3_QUOTE_BYTECODE = "0x608060405234801561000f575f80fd5b506040516108d33803806108d383398101604081905261002e91610306565b6001600160a01b038416158061004b57506001600160a01b038316155b806100675750826001600160a01b0316846001600160a01b0316145b8061007957506001600160801b038116155b1561009757604051630951f7bd60e11b815260040160405180910390fd5b6001600160a01b03808416908516105f731f7d7550b1b028f7571e69a784071f0205fd2efa631698ee82836100cc57866100ce565b875b846100d957886100db565b875b6040516001600160e01b031960e085901b1681526001600160a01b0392831660048201529116602482015262ffffff87166044820152606401602060405180830381865afa15801561012f573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101539190610360565b90506001600160a01b03811661017c57604051630951f7bd60e11b815260040160405180910390fd5b806001600160a01b0316631a6865026040518163ffffffff1660e01b8152600401602060405180830381865afa1580156101b8573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101dc9190610380565b6001600160801b03165f0361021157604051635fe077e360e11b81525f60048201819052602482015260440160405180910390fd5b808260405161021f906102c8565b6001600160a01b03909216825215156020820152604001604051809103905ff08015801561024f573d5f803e3d5ffd5b506040516320e9b73b60e01b81526001600160801b03851660048201526001600160a01b0391909116906320e9b73b906024015f604051808303815f87803b158015610299575f80fd5b505af11580156102ab573d5f803e3d5ffd5b5050505060405163030ad99760e01b815260040160405180910390fd5b6105398061039a83390190565b80516001600160a01b03811681146102eb575f80fd5b919050565b80516001600160801b03811681146102eb575f80fd5b5f805f8060808587031215610319575f80fd5b610322856102d5565b9350610330602086016102d5565b9250604085015162ffffff81168114610347575f80fd5b9150610355606086016102f0565b905092959194509250565b5f60208284031215610370575f80fd5b610379826102d5565b9392505050565b5f60208284031215610390575f80fd5b610379826102f056fe60e060405234801561000f575f80fd5b5060405161053938038061053983398101604081905261002e91610072565b6001600160a01b03821661005557604051630951f7bd60e11b815260040160405180910390fd5b336080526001600160a01b039190911660a052151560c0526100b9565b5f8060408385031215610083575f80fd5b82516001600160a01b0381168114610099575f80fd5b602084015190925080151581146100ae575f80fd5b809150509250929050565b60805160a05160c05161043d6100fc5f395f818160ef0152818161011a01528181610250015261028001525f818160bf015261020f01525f606b015261043d5ff3fe608060405234801561000f575f80fd5b5060043610610034575f3560e01c806320e9b73b14610038578063fa461e331461004d575b5f80fd5b61004b610046366004610316565b610060565b005b61004b61005b366004610343565b610204565b336001600160a01b037f00000000000000000000000000000000000000000000000000000000000000001614158061009f57506001600160801b038116155b156100bd57604051630951f7bd60e11b815260040160405180910390fd5b7f00000000000000000000000000000000000000000000000000000000000000006001600160a01b031663128acb08307f0000000000000000000000000000000000000000000000000000000000000000846001600160801b03167f00000000000000000000000000000000000000000000000000000000000000006101575773fffd8963efd1fc6a506488495d951d5263988d2561015e565b6401000276a45b60405160e086901b6001600160e01b03191681526001600160a01b03948516600482015292151560248401526044830191909152909116606482015260a060848201525f60a482015260c40160408051808303815f875af11580156101c5573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906101e991906103bf565b505060405163030ad99760e01b815260040160405180910390fd5b336001600160a01b037f0000000000000000000000000000000000000000000000000000000000000000161461024d57604051630951f7bd60e11b815260040160405180910390fd5b5f7f0000000000000000000000000000000000000000000000000000000000000000610279578361027b565b845b90505f7f00000000000000000000000000000000000000000000000000000000000000006102a957856102ab565b845b90505f8212806102ba57505f81135b806102c85750600160ff1b81145b156102e657604051630951f7bd60e11b815260040160405180910390fd5b816102f0826103e1565b604051635fe077e360e11b81526004810192909252602482015260440160405180910390fd5b5f60208284031215610326575f80fd5b81356001600160801b038116811461033c575f80fd5b9392505050565b5f805f8060608587031215610356575f80fd5b8435935060208501359250604085013567ffffffffffffffff81111561037a575f80fd5b8501601f8101871361038a575f80fd5b803567ffffffffffffffff8111156103a0575f80fd5b8760208284010111156103b1575f80fd5b949793965060200194505050565b5f80604083850312156103d0575f80fd5b505080516020909101519092909150565b5f600160ff1b820161040157634e487b7160e01b5f52601160045260245ffd5b505f039056fea2646970667358221220d801d5830da366b26e2ba517b66c12e71d864bec08cc5abe24ed6f3d68bbfe6464736f6c634300081a0033";
  // END GENERATED V3 QUOTE BYTECODE

  // Follow-up 5: Manual mode. Two pasted V3 pool addresses, read with eth_call only (no logs, no batch).
  var MANUAL_ADDRESS_ERROR = "Enter a 42-char V3 pool address";
  var MANUAL_INVALID_ERROR = "Invalid pool address";
  var MANUAL_PAIR_ERROR = "Pools are different pairs";
  var MANUAL_LIQUIDITY_ERROR = "Pool has no liquidity";
  var MANUAL_SAME_POOL_ERROR = "Pool A and Pool B are the same pool";
  var MANUAL_READS = ["token0", "token1", "fee", "slot0"];
  // slot0 is declared as the brief gives it (six outputs). The deployed pools answer with the
  // canonical V3 seven-word layout; both start with sqrtPriceX96 then tick, which is all the
  // page uses, so decodeManualSlot0 reads those two words and accepts either length.
  var v3ManualPoolInterface = new utils.Interface([
    "function token0() view returns (address)",
    "function token1() view returns (address)",
    "function fee() view returns (uint24)",
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee, uint8 tickSpacing, bool unlocked)",
  ]);

  /** A pasted pool address: exactly 0x + 40 hex digits. Throws the brief's message otherwise. */
  function parseManualPoolAddress(text, label) {
    var value = String(text === undefined || text === null ? "" : text).trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) throw new Error((label ? label + ": " : "") + MANUAL_ADDRESS_ERROR);
    var address = utils.getAddress(value.toLowerCase());
    if (address === ethers.constants.AddressZero) throw new Error((label ? label + ": " : "") + MANUAL_ADDRESS_ERROR);
    return address;
  }

  /** The four eth_call params of one pool, in MANUAL_READS order: token0, token1, fee, slot0. */
  function manualPoolCalls(address) {
    var pool = parseManualPoolAddress(address);
    return MANUAL_READS.map(function (name) {
      return { method: "eth_call", params: [{ to: pool, data: v3ManualPoolInterface.encodeFunctionData(name, []) }, "latest"] };
    });
  }

  /** sqrtPriceX96 and tick from a slot0 reply of at least two words (six- or seven-output layout). */
  function decodeManualSlot0(result) {
    if (typeof result !== "string" || !utils.isHexString(result) || utils.hexDataLength(result) < 64) fail("slot0 reply is too short");
    var words = abi.decode(["uint256", "int256"], utils.hexDataSlice(result, 0, 64));
    if (words[0].gt(MAX_UINT160)) fail("sqrtPriceX96 does not fit uint160");
    var tick = words[1];
    if (tick.lt(MIN_TICK) || tick.gt(MAX_TICK)) fail("tick out of range");
    return { sqrtPriceX96: words[0], tick: tick.toNumber() };
  }

  function manualInvalid(address, detail) {
    var error = new Error(MANUAL_INVALID_ERROR + " (" + address + (detail ? ": " + detail : "") + ")");
    error.manualCode = "INVALID_POOL";
    error.address = address;
    return error;
  }

  /** A node's JSON-RPC error is a revert or a missing contract; anything else is transport. */
  function isRevertError(error) {
    if (!error || error.code === undefined || error.code === null) return false;
    if (error.code === -32005 || /rate.?limit|too many requests/i.test(error.message || "")) return false;
    return true;
  }

  /**
   * Decode the four replies of manualPoolCalls into one V3 row shaped like the auto-scan's V3
   * rows (protocol, address, poolId, fee, currency0, currency1, tick, price, sqrtPriceX96).
   * An empty reply ("0x": no contract or no such function) is an invalid pool.
   */
  function decodeManualPool(address, results) {
    var pool = parseManualPoolAddress(address);
    function read(i, name) {
      var result = rpcResult(results[i]);
      if (typeof result !== "string" || !utils.isHexString(result) || result === "0x") throw manualInvalid(pool, name + "() returned no data");
      try {
        if (name === "slot0") return decodeManualSlot0(result);
        return v3ManualPoolInterface.decodeFunctionResult(name, result)[0];
      } catch (error) { throw manualInvalid(pool, name + "() reply could not be decoded"); }
    }
    var token0 = utils.getAddress(read(0, "token0"));
    var token1 = utils.getAddress(read(1, "token1"));
    var fee = BigNumber.from(read(2, "fee")).toNumber();
    var slot0 = read(3, "slot0");
    if (token0 === ethers.constants.AddressZero || token1 === ethers.constants.AddressZero || token0 === token1 ||
      !BigNumber.from(token0).lt(BigNumber.from(token1))) throw manualInvalid(pool, "token0/token1 are not a sorted pair");
    if (fee > 1000000) throw manualInvalid(pool, "fee() is not a V3 fee");
    return { protocol: "V3", manual: true, address: pool, poolId: pool.toLowerCase(), fee: fee,
      currency0: token0, currency1: token1, tickSpacing: null, tick: slot0.tick, sqrtPriceX96: slot0.sqrtPriceX96,
      price: tickToPrice(slot0.tick), active: true, swaps: null, lastBlock: null, lastIndex: null };
  }

  /** "0.01%", "1.00%", for any fee in hundredths of a basis point (no fee-tier whitelist). */
  function formatManualFee(fee) { return (Number(fee) / 10000).toFixed(2) + "%"; }

  /** "0x10cc…26ba" for the table. */
  function truncateAddress(address) {
    var value = utils.getAddress(address);
    return value.slice(0, 6) + "…" + value.slice(-4);
  }

  /** "Last read: 12s ago". */
  function formatLastRead(seconds) {
    var s = Math.max(0, Math.floor(Number(seconds)));
    if (!Number.isFinite(s)) fail("elapsed time must be a number of seconds");
    return "Last read: " + s + "s ago";
  }

  /**
   * Read one pool with four sequential eth_calls (never a batch). A revert, an empty reply or a
   * reply that does not decode is "Invalid pool address"; a transport failure is rethrown as is
   * so the monitor can back off instead of blaming the address.
   */
  async function readManualPool(request, address) {
    if (typeof request !== "function") fail("request function is required");
    var pool = parseManualPoolAddress(address);
    var calls = manualPoolCalls(pool);
    var results = [];
    for (var i = 0; i < calls.length; i++) {
      try { results.push(await request(calls[i].method, calls[i].params)); } catch (error) {
        if (isRevertError(error)) throw manualInvalid(pool, MANUAL_READS[i] + "() reverted");
        throw error;
      }
    }
    return decodeManualPool(pool, results);
  }

  /**
   * The checks of the brief, in its order: same token0 and token1 (same pair, same order), both
   * sqrtPriceX96 > 0, and not the same pool twice. Returns the rows ordered buy (lower price) then sell.
   */
  function validateManualPools(poolA, poolB) {
    if (poolA.currency0 !== poolB.currency0 || poolA.currency1 !== poolB.currency1) {
      var pairError = new Error(MANUAL_PAIR_ERROR);
      pairError.manualCode = "DIFFERENT_PAIRS";
      throw pairError;
    }
    [poolA, poolB].forEach(function (pool, i) {
      if (BigNumber.from(pool.sqrtPriceX96).isZero()) {
        var liquidityError = new Error(MANUAL_LIQUIDITY_ERROR + " (" + (i === 0 ? "Pool A" : "Pool B") + " " + pool.address + ")");
        liquidityError.manualCode = "NO_LIQUIDITY";
        throw liquidityError;
      }
    });
    if (poolA.address === poolB.address) {
      var sameError = new Error(MANUAL_SAME_POOL_ERROR);
      sameError.manualCode = "SAME_POOL";
      throw sameError;
    }
    return poolA.price <= poolB.price ? [poolA, poolB] : [poolB, poolA];
  }

  /** The single manual spread row: buy = lower price, sell = higher. Same arithmetic as rankSpreads. */
  function manualSpread(poolA, poolB, thresholdPercent) {
    var ordered = validateManualPools(poolA, poolB);
    return pairSpreads(ordered, readThreshold(thresholdPercent))[0];
  }

  /**
   * Manual-mode monitor: every pollIntervalMs it reads token0, token1, fee and slot0 of both pools
   * (8 eth_calls, one at a time), reads symbol() and decimals() of the two tokens once per pair
   * (cached), validates, and publishes { pair, pools, spread, lastRead }. Never eth_getLogs, never a
   * batch, never eth_getBlockByNumber. A pool-level failure (invalid, different pairs, no
   * liquidity) is reported in state.lastError and retried at the normal interval; a transport
   * failure backs off retryIntervalMs like the auto-scan monitor.
   *
   * options: request (required), pollIntervalMs (30000), retryIntervalMs (60000),
   *          thresholdPercent (number or function, 0.5), onUpdate(state), onError(error, state), now().
   */
  function createManualMonitor(options) {
    options = options || {};
    var request = options.request;
    if (typeof request !== "function") fail("request function is required");
    var pollMs = options.pollIntervalMs === undefined ? POLL_INTERVAL_MS : options.pollIntervalMs;
    var retryMs = options.retryIntervalMs === undefined ? RPC_RETRY_MS : options.retryIntervalMs;
    if (!Number.isFinite(pollMs) || pollMs < 0 || !Number.isFinite(retryMs) || retryMs < 0) fail("invalid intervals");
    var onUpdate = options.onUpdate || function () {};
    var onError = options.onError || function () {};
    var now = options.now || function () { return Date.now(); };
    var thresholdOption = options.thresholdPercent === undefined ? 0.5 : options.thresholdPercent;
    var threshold = typeof thresholdOption === "function" ? thresholdOption : function () { return thresholdOption; };
    var addresses = null;
    var running = false;
    var generation = 0;
    var timer = null;
    var symbolCache = {}; // token address → { symbol, decimals }, read once
    var state = freshState();

    function freshState() {
      return { mode: "Manual", addresses: null, pair: null, pools: [], spreads: [], spread: null, lastRead: null,
        lastError: null, errorCode: null, retryAt: null, nextPollMs: null, polls: 0, errors: 0, protocol: "V3" };
    }

    async function tokenMeta(token) {
      if (symbolCache[token]) return symbolCache[token];
      var meta = {};
      for (var name of ["symbol", "decimals"]) {
        var result = await request("eth_call", [{ to: token, data: tokenInterface.encodeFunctionData(name, []) }, "latest"]);
        if (!result || result === "0x") fail("no " + name + "() at " + token);
        meta[name] = tokenInterface.decodeFunctionResult(name, result)[0];
      }
      symbolCache[token] = { symbol: String(meta.symbol), decimals: BigNumber.from(meta.decimals).toNumber() };
      return symbolCache[token];
    }

    async function pollOnce() {
      if (!addresses) fail("start(poolA, poolB) first");
      var current = state;
      var rows = [];
      for (var i = 0; i < 2; i++) {
        try { rows.push(await readManualPool(request, addresses[i])); } catch (error) {
          if (error.manualCode) error.message = (i === 0 ? "Pool A" : "Pool B") + ": " + error.message;
          throw error;
        }
      }
      validateManualPools(rows[0], rows[1]);
      var meta0 = await tokenMeta(rows[0].currency0);
      var meta1 = await tokenMeta(rows[0].currency1);
      var pair = { tokenA: rows[0].currency0, tokenB: rows[0].currency1, currency0: rows[0].currency0, currency1: rows[0].currency1,
        symbol0: meta0.symbol, decimals0: meta0.decimals, symbol1: meta1.symbol, decimals1: meta1.decimals };
      pair.symbolA = pair.symbol0;
      pair.symbolB = pair.symbol1;
      pair.decimalsA = pair.decimals0;
      pair.decimalsB = pair.decimals1;
      var scale = Math.pow(10, pair.decimals0 - pair.decimals1);
      rows.forEach(function (row, index) {
        row.label = index === 0 ? "Pool A" : "Pool B";
        row.displayPrice = row.price * scale;
        row.empty = false;
        row.elapsedSeconds = 0;
        row.healthError = null;
        row.status = STATUS_OK;
      });
      var spread = manualSpread(rows[0], rows[1], threshold());
      current.addresses = addresses.slice();
      current.pair = pair;
      current.pools = rows;
      current.spread = spread;
      current.spreads = [spread];
      current.lastRead = now();
      current.lastError = null;
      current.errorCode = null;
      current.retryAt = null;
      current.polls += 1;
      return current;
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
        // A definite answer about the pools is re-read at the normal interval; the RPC backs off.
        delay = error.manualCode ? pollMs : retryMs;
        state.errors += 1;
        state.lastError = error && error.message ? error.message : String(error);
        state.errorCode = error.manualCode || "RPC";
        state.retryAt = now() + delay;
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

    /** Validates both addresses synchronously (42 chars) so a bad field never starts a loop. */
    function start(poolA, poolB) {
      stop();
      var a = parseManualPoolAddress(poolA, "Pool A");
      var b = parseManualPoolAddress(poolB, "Pool B");
      addresses = [a, b];
      state = freshState();
      state.addresses = [a, b];
      running = true;
      return cycle();
    }

    return { start: start, stop: stop, pollOnce: pollOnce, getState: function () { return state; },
      isRunning: function () { return running; } };
  }

  function protocolOf(pool) { return pool.protocol || "V4"; }

  function normaliseProtocol(protocol) {
    if (["V3", "V4", "Both"].indexOf(protocol) === -1) fail("Protocol must be V3, V4 or Both");
    return protocol;
  }

  function v3Fee(fee) {
    var value = Number(fee);
    if (V3_FEE_TIERS.indexOf(value) === -1) fail("unsupported V3 fee tier");
    return value;
  }

  function formatV3Fee(fee) { return (v3Fee(fee) / 10000).toFixed(2) + "%"; }

  function v3DiscoveryCalls(pair) {
    return V3_FEE_TIERS.map(function (fee) {
      return { method: "eth_call", params: [{ to: V3_FACTORY,
        data: v3FactoryInterface.encodeFunctionData("getPool", [pair.currency0, pair.currency1, fee]) }, "latest"] };
    });
  }

  function decodeV3Pools(pair, results) {
    var pools = V3_FEE_TIERS.map(function (fee, i) {
      var result = rpcResult(results[i]);
      var address = v3FactoryInterface.decodeFunctionResult("getPool", result)[0];
      if (address === ethers.constants.AddressZero) return null;
      return { protocol: "V3", address: address, poolId: address.toLowerCase(), fee: fee,
        currency0: pair.currency0, currency1: pair.currency1, tickSpacing: null };
    });
    return pools.filter(function (pool) { return pool !== null; });
  }

  /** Four factory reads per pair, cached by the monitor even if the following log scan fails. */
  async function discoverV3Pools(request, tokenA, tokenB) {
    var pair = sortPair(tokenA, tokenB);
    return decodeV3Pools(pair, await Promise.all(v3DiscoveryCalls(pair).map(function (call) {
      return request(call.method, call.params);
    })));
  }

  function decodeV3SwapLog(log) {
    if (!log || !log.topics || log.topics[0] !== V3_SWAP_TOPIC || log.topics.length !== 3 ||
      !utils.isHexString(log.data, 160)) fail("not a V3 Swap log");
    // sender/recipient are indexed. Argument 7 (tick) is DATA word 5, not word 7.
    var decoded = abi.decode(["int256", "int256", "uint160", "uint128", "int24"], log.data);
    return { poolId: utils.getAddress(log.address).toLowerCase(),
      blockNumber: BigNumber.from(log.blockNumber).toNumber(),
      logIndex: log.logIndex === undefined ? 0 : BigNumber.from(log.logIndex).toNumber(),
      tick: Number(decoded[4]), sqrtPriceX96: decoded[2], liquidity: decoded[3] };
  }

  function summariseV3Pools(discovered, logs) {
    if (!Array.isArray(logs)) fail("eth_getLogs did not return a list");
    var rows = discovered.map(function (pool) {
      return Object.assign({}, pool, { swaps: 0, tick: null, price: null, active: false, lastBlock: null, lastIndex: null });
    });
    var byId = {};
    rows.forEach(function (row) { byId[row.poolId] = row; });
    logs.forEach(function (log) {
      if (!log || log.removed || !log.address || !log.topics || log.topics[0] !== V3_SWAP_TOPIC) return;
      var row = byId[log.address.toLowerCase()];
      if (!row) return;
      var swap = decodeV3SwapLog(log);
      row.swaps += 1;
      row.active = true;
      if (row.lastBlock === null || swap.blockNumber > row.lastBlock ||
        (swap.blockNumber === row.lastBlock && swap.logIndex >= row.lastIndex)) {
        row.lastBlock = swap.blockNumber;
        row.lastIndex = swap.logIndex;
        row.tick = swap.tick;
        row.price = tickToPrice(swap.tick);
      }
    });
    return rows;
  }

  /** Standard packed V3 path: 20 + hops * 23 bytes (two hops = 66, one hop = 43). */
  function encodeV3Path(tokens, fees) {
    if (!Array.isArray(tokens) || !Array.isArray(fees) || !fees.length || tokens.length !== fees.length + 1) {
      fail("V3 path needs one more token than fees");
    }
    var types = ["address"];
    var values = [recipientAddress(tokens[0])];
    fees.forEach(function (fee, i) {
      var token = recipientAddress(tokens[i + 1]);
      if (token === values[values.length - 1]) fail("adjacent path tokens must differ");
      types.push("uint24", "address");
      values.push(v3Fee(fee), token);
    });
    return utils.solidityPack(types, values);
  }

  function buildV3Calldata(args) {
    var input = uint128(args.amountIn, "amountIn");
    var minimum = uint128(args.amountOutMinimum, "amountOutMinimum");
    if (input.isZero() || input.eq(MAX_UINT128) || minimum.isZero()) fail("V3 input and minimum output must be positive");
    var swap = v3RouterInterface.encodeFunctionData("exactInput", [{
      path: encodeV3Path(args.tokens, args.fees), recipient: recipientAddress(args.recipient),
      amountIn: input, amountOutMinimum: minimum,
    }]);
    return v3RouterInterface.encodeFunctionData("multicall", [args.deadline, [swap]]);
  }

  /** Real pool simulation via a reverting creation eth_call. No guessed quoter address or wallet. */
  async function quoteV3ExactIn(request, args) {
    var pool = args.pool;
    var sorted = sortPair(pool.currency0, pool.currency1);
    if (sorted.currency0 !== utils.getAddress(pool.currency0)) fail("V3 currencies must be sorted");
    var input = uint128(args.amountIn, "amountIn");
    if (input.isZero() || input.eq(MAX_UINT128)) fail("amountIn must be a real, non-zero amount");
    var tokenIn = args.zeroForOne ? sorted.currency0 : sorted.currency1;
    var tokenOut = args.zeroForOne ? sorted.currency1 : sorted.currency0;
    var data = V3_QUOTE_BYTECODE + abi.encode(["address", "address", "uint24", "uint128"],
      [tokenIn, tokenOut, v3Fee(pool.fee), input]).slice(2);
    try {
      await request("eth_call", [{ data: data }, "latest"]);
    } catch (error) {
      var result = extractRevertData(error);
      if (result && result.slice(0, 10).toLowerCase() === V3_QUOTE_SELECTOR && utils.hexDataLength(result) === 68) {
        var decoded = abi.decode(["uint256", "uint256"], "0x" + result.slice(10));
        if (decoded[1].isZero()) return decoded[1];
        if (!decoded[0].eq(input)) fail("V3 quote only fills part of the input; reduce the amount");
        return decoded[1];
      }
      throw new Error("V3 quote failed: " + (error.message || String(error)));
    }
    fail("V3 quote did not return its expected revert; nothing may be sent");
  }

  function quotePool(request, pool, zeroForOne, amountIn, from) {
    return protocolOf(pool) === "V3" ? quoteV3ExactIn(request, { pool: pool, zeroForOne: zeroForOne, amountIn: amountIn }) :
      quoteExactIn(request, { poolKey: pool.poolKey, zeroForOne: zeroForOne, amountIn: amountIn, from: from });
  }

  /** Mixed spreads are manual-only. Find the best atomic opportunity across both protocols. */
  function protocolAutoDecision(pools, thresholdPercent) {
    var v4 = autoDecision(pools.filter(function (pool) { return protocolOf(pool) === "V4"; }), thresholdPercent);
    var v3 = autoDecision(pools.filter(function (pool) { return protocolOf(pool) === "V3"; }), thresholdPercent);
    v3.skips.forEach(function (skip) {
      skip.reason = skip.reason.replace(/pool (\d+)\/(?:null|undefined) /, function (_, fee) {
        return "V3 pool " + formatV3Fee(fee) + " ";
      }).replace("sqrtPriceX96 = 0", "liquidity = 0");
    });
    var best = [v4.spread, v3.spread].filter(Boolean).sort(function (a, b) { return b.netPercent - a.netPercent; });
    return { spread: best[0] || null, skips: v4.skips.concat(v3.skips) };
  }

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

  /** Every pair of the given priced pools, best net first. */
  function pairSpreads(pools, threshold) {
    var spreads = [];
    for (var i = 0; i < pools.length; i++) {
      for (var j = i + 1; j < pools.length; j++) {
        var buy = pools[i].price <= pools[j].price ? pools[i] : pools[j];
        var sell = buy === pools[i] ? pools[j] : pools[i];
        var spread = spreadPercent(buy.price, sell.price);
        var feeCost = feeCostPercent(buy.fee, sell.fee);
        var net = spread - feeCost;
        spreads.push({ buy: buy, sell: sell, spreadPercent: spread, feeCostPercent: feeCost, netPercent: net,
          verdict: net > threshold ? "GREEN" : "RED" });
      }
    }
    spreads.sort(function (x, y) { return y.netPercent - x.netPercent; });
    return spreads;
  }

  function readThreshold(thresholdPercent) {
    var threshold = thresholdPercent === undefined ? 0.5 : Number(thresholdPercent);
    if (!Number.isFinite(threshold) || threshold < 0) fail("threshold must be a non-negative percent");
    return threshold;
  }

  function isPriced(pool) { return pool.active && pool.price !== null && pool.price > 0; }

  /** Rows straight from summarisePools have no status yet; the monitor always sets one. */
  function isTradeable(pool) { return isPriced(pool) && (pool.status === undefined || pool.status === STATUS_OK); }

  /**
   * Every pair of tradeable pools (active, and not STALE, EMPTY or UNKNOWN), best net first, at
   * most `limit` rows. `buy` is the pool with the lower price (currency0 is cheaper there: sell
   * currency1 into it, zeroForOne=false) and `sell` the pool with the higher price
   * (zeroForOne=true). GREEN means net% is above the threshold.
   */
  function rankSpreads(pools, thresholdPercent, limit) {
    var threshold = readThreshold(thresholdPercent);
    var max = limit === undefined ? 5 : limit;
    return pairSpreads(pools.filter(isTradeable), threshold).slice(0, max);
  }

  // ------------------------------------------------------------------ staleness and pool status

  var STATUS_OK = "OK";
  var STATUS_INACTIVE = "INACTIVE";
  var STATUS_STALE = "STALE";
  var STATUS_EMPTY = "EMPTY";
  var STATUS_UNKNOWN = "UNKNOWN";

  /** "45m", "3h 12m"; whole minutes, rounded down. */
  function formatDuration(seconds) {
    var s = Number(seconds);
    if (!Number.isFinite(s) || s < 0) fail("elapsed time must be a non-negative number of seconds");
    var minutes = Math.floor(s / 60);
    return minutes < 60 ? minutes + "m" : Math.floor(minutes / 60) + "h " + (minutes % 60) + "m";
  }

  /** "Xm ago" or "Xh Ym ago". */
  function formatElapsed(seconds) { return formatDuration(seconds) + " ago"; }

  /** Last Swap colour: green below 30 min, yellow from 30 min to 2 h, red above 2 h. */
  function stalenessColor(seconds) {
    if (seconds < STALENESS_YELLOW_SECONDS) return "green";
    return seconds > STALENESS_RED_SECONDS ? "red" : "yellow";
  }

  /** A whole number within [min, max] from a number or digit string, else null. */
  function parseWhole(value, min, max) {
    var text = String(value === undefined || value === null ? "" : value).trim();
    if (!/^\d+$/.test(text)) return null;
    var number = Number(text);
    return Number.isSafeInteger(number) && number >= min && number <= max ? number : null;
  }

  /** The window in blocks, 50 to 50000, or null when the input is not valid. */
  function parseWindowBlocks(value) { return parseWhole(value, MIN_WINDOW_BLOCKS, MAX_WINDOW_BLOCKS); }

  /** The maximum staleness in whole seconds, or null when the input is not valid. */
  function parseMaxStaleness(value) { return parseWhole(value, 0, Number.MAX_SAFE_INTEGER); }

  /** The storage slot of a pool's Slot0 in the PoolManager: keccak256(abi.encode(poolId, 6)). */
  function slot0StorageSlot(id) {
    return utils.keccak256(abi.encode(["bytes32", "uint256"], [id, POOLS_SLOT]));
  }

  /** The eth_call that reads a pool's Slot0 word from the PoolManager. */
  function encodeSlot0Call(id) {
    return { to: POOL_MANAGER, data: poolManagerInterface.encodeFunctionData("extsload", [slot0StorageSlot(id)]) };
  }

  /**
   * Slot0 packs, from the low bits: sqrtPriceX96 (160), tick (24), protocolFee (24), lpFee (24).
   * Returned in the brief's getSlot0 order. Throws on a reply that is not one 32-byte word.
   */
  function decodeSlot0(word) {
    if (typeof word !== "string" || !utils.isHexString(word, 32)) fail("slot0 reply is not a 32-byte word");
    var packed = BigNumber.from(word);
    return {
      tick: packed.shr(160).and(0xffffff).fromTwos(24).toNumber(),
      sqrtPriceX96: packed.and(MAX_UINT160),
      protocolFee: packed.shr(184).and(0xffffff).toNumber(),
      lpFee: packed.shr(208).and(0xffffff).toNumber(),
    };
  }

  /**
   * INACTIVE no swap in the window; EMPTY sqrtPriceX96 is 0; STALE elapsed above the maximum;
   * UNKNOWN the slot0 read or the swap block's timestamp failed; OK otherwise. A definite fact is
   * reported ahead of a failed read. Only OK pools reach the spreads and auto mode.
   */
  function poolStatus(pool, maxStalenessSeconds) {
    if (!pool.active) return STATUS_INACTIVE;
    if (pool.empty === true) return STATUS_EMPTY;
    if (pool.elapsedSeconds !== null && pool.elapsedSeconds !== undefined && pool.elapsedSeconds > maxStalenessSeconds) {
      return STATUS_STALE;
    }
    if (pool.empty !== false || pool.elapsedSeconds === null || pool.elapsedSeconds === undefined) return STATUS_UNKNOWN;
    return STATUS_OK;
  }

  /** Set `status` on each pool for this maximum staleness (a changed field applies at once). */
  function annotatePools(pools, maxStalenessSeconds) {
    var max = maxStalenessSeconds === undefined ? MAX_STALENESS_SECONDS : Number(maxStalenessSeconds);
    if (!Number.isFinite(max) || max < 0) fail("max staleness must be a non-negative number of seconds");
    pools.forEach(function (pool) { pool.status = poolStatus(pool, max); });
    return pools;
  }

  /** Why auto mode will not use this pool, for the activity log. */
  function autoSkipReason(pool) {
    var label = "auto skipped: pool " + pool.fee + "/" + pool.tickSpacing + " ";
    if (pool.status === STATUS_STALE) return label + "stale (" + formatDuration(pool.elapsedSeconds) + ")";
    if (pool.status === STATUS_EMPTY) return label + "empty (sqrtPriceX96 = 0)";
    return label + "unknown (" + (pool.healthError || "health read failed") + ")";
  }

  /**
   * What auto mode does with these pools. `spread` is the best GREEN spread whose two pools are
   * both tradeable, or null. `skips` has one { poolId, status, reason } for each excluded pool that
   * sits in a GREEN spread better than `spread`: the pools that kept a better trade from firing.
   */
  function autoDecision(pools, thresholdPercent) {
    var threshold = readThreshold(thresholdPercent);
    var skips = [];
    var seen = {};
    var candidates = pairSpreads(pools.filter(isPriced), threshold);
    for (var i = 0; i < candidates.length && candidates[i].verdict === "GREEN"; i++) {
      var legs = [candidates[i].buy, candidates[i].sell];
      if (legs.every(isTradeable)) return { spread: candidates[i], skips: skips };
      legs.forEach(function (pool) {
        if (isTradeable(pool) || seen[pool.poolId]) return;
        seen[pool.poolId] = true;
        skips.push({ poolId: pool.poolId, status: pool.status, reason: autoSkipReason(pool) });
      });
    }
    return { spread: null, skips: skips };
  }

  /** amount * (10000 - bps) / 10000, rounded down. */
  function applySlippage(amount, bps) {
    var basis = bps === undefined ? SLIPPAGE_BPS : Number(bps);
    if (!Number.isInteger(basis) || basis < 0 || basis > 10000) fail("slippage must be whole basis points, 0 to 10000");
    return BigNumber.from(amount).mul(10000 - basis).div(10000);
  }

  // ------------------------------------------------------------------ JSON-RPC and quotes

  function rpcError(detail) {
    var error = new Error("RPC error: " + (detail.message || "unknown"));
    error.code = detail.code;
    error.data = detail.data;
    return error;
  }

  /** Unwrap one batch entry without discarding successful sibling calls. */
  function rpcResult(result) {
    if (result && result.error) throw result.error;
    return result;
  }

  /** Minimal JSON-RPC over HTTP client. Errors carry the node's `code` and revert `data`. */
  function createRpcClient(url, fetchImpl, options) {
    options = options || {};
    var doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (typeof doFetch !== "function") fail("fetch is not available; pass a fetch implementation");
    if (typeof url !== "string" || !/^https?:\/\//.test(url)) fail("RPC url must be an http(s) URL");
    var timeoutMs = options.timeoutMs === undefined ? 20000 : options.timeoutMs;
    var batchTimeoutMs = options.batchTimeoutMs === undefined ? 30000 : options.batchTimeoutMs;
    var nextId = 0;
    var batchSupported = true;
    var sequentialTail = Promise.resolve();

    function envelope(method, params) {
      return { jsonrpc: "2.0", id: ++nextId, method: method, params: params || [] };
    }

    async function post(payload, timeout) {
      var controller = typeof AbortController === "function" ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, timeout) : null;
      try {
        var response = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined,
        });
        // A 429/outage must back off, not fan out into individual HTTP requests.
        if (!response || response.status === 429 || response.status === 503) {
          fail("RPC HTTP error " + (response ? response.status : "no response"));
        }
        var body;
        try { body = await response.json(); } catch (error) {
          if (!response.ok) fail("RPC HTTP error " + response.status);
          throw error;
        }
        return { ok: response.ok, status: response.status, body: body };
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    }

    function resultOf(body, id) {
      if (!body || Array.isArray(body) || body.jsonrpc !== "2.0" || body.id !== id) {
        fail("RPC returned an invalid response for id " + id);
      }
      if (body.error) throw rpcError(body.error);
      if (!Object.prototype.hasOwnProperty.call(body, "result")) fail("RPC response missing result for id " + id);
      return body.result;
    }

    async function request(method, params) {
      var call = envelope(method, params);
      var reply = await post(call, timeoutMs);
      if (!reply.ok) fail("RPC HTTP error " + reply.status);
      var body = reply.body;
      if (!body || typeof body !== "object") fail("RPC returned no JSON object");
      if (body.error) throw rpcError(body.error);
      return body.result;
    }

    // Serialize fallback batches, including the boundary between phases/cycles. Wait after the
    // rejected batch and between every single request, even if the preceding call failed.
    function sequential(calls) {
      var pending = sequentialTail.then(async function () {
        var results = [];
        for (var i = 0; i < calls.length; i++) {
          await new Promise(function (resolve) { setTimeout(resolve, 500); });
          try { results.push(await request(calls[i].method, calls[i].params)); }
          catch (error) { results.push({ error: error }); }
        }
        return results;
      });
      sequentialTail = pending.catch(function () {});
      return pending;
    }

    async function batchRequest(calls) {
      if (!Array.isArray(calls)) fail("batch calls must be an array");
      calls.forEach(function (call) {
        if (!call || typeof call.method !== "string" || !call.method ||
          (call.params !== undefined && !Array.isArray(call.params))) fail("invalid batch call");
      });
      if (!calls.length) return [];
      if (!batchSupported) return sequential(calls);
      var requests = calls.map(function (call) { return envelope(call.method, call.params); });
      var reply = await post(requests, batchTimeoutMs);
      var body = reply.body;
      var rejection = Array.isArray(body) && body.length === 1 && body[0] && body[0].id === null ? body[0] : body;
      if (rejection && rejection.error && (rejection.error.code === -32005 ||
        /rate.?limit|too many requests/i.test(rejection.error.message || ""))) throw rpcError(rejection.error);
      // Some nodes reject arrays with an HTTP 400 JSON-RPC error, others return one object
      // with HTTP 200. Remember the capability for this client so each poll doesn't probe again.
      if (rejection && !Array.isArray(rejection) && typeof rejection === "object" &&
        (reply.ok || (rejection.error && (rejection.error.code === -32600 ||
          /batch/i.test(rejection.error.message || ""))))) {
        batchSupported = false;
        return sequential(calls);
      }
      if (!reply.ok) fail("RPC HTTP error " + reply.status);
      if (!Array.isArray(body)) fail("RPC batch returned no JSON array");
      var byId = new Map();
      var duplicates = new Set();
      body.forEach(function (entry) {
        if (!entry || typeof entry !== "object") return;
        if (byId.has(entry.id)) duplicates.add(entry.id);
        byId.set(entry.id, entry);
      });
      return requests.map(function (call) {
        try {
          if (duplicates.has(call.id)) fail("RPC batch has duplicate response id " + call.id);
          return resultOf(byId.get(call.id), call.id);
        } catch (error) { return { error: error }; }
      });
    }

    return { request: request, batchRequest: batchRequest, url: url };
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
   * options: request(method, params), batchRequest(calls) (both required),
   *          pollIntervalMs (30000), retryIntervalMs (60000),
   *          windowBlocks (number or function, 3000, read on every poll, 50 to 50000),
   *          maxStalenessSeconds (number or function, 7200), thresholdPercent (number or function,
   *          0.5), onUpdate(state), onError(error, state), now().
   *
   * start(tokenA, tokenB) resolves after the first poll attempt and keeps polling until stop().
   * A failure of the metadata, latest block or logs requests is caught: the state records the
   * error, the next attempt is scheduled after retryIntervalMs, and polling never stops by itself.
   * A failure of one active pool's slot0 or block read marks only that pool UNKNOWN.
   */
  function createPoolMonitor(options) {
    options = options || {};
    var request = options.request;
    if (typeof request !== "function") fail("request function is required");
    var pollMs = options.pollIntervalMs === undefined ? POLL_INTERVAL_MS : options.pollIntervalMs;
    var retryMs = options.retryIntervalMs === undefined ? RPC_RETRY_MS : options.retryIntervalMs;
    var windowOption = options.windowBlocks === undefined ? LOG_WINDOW_BLOCKS : options.windowBlocks;
    var windowBlocks = typeof windowOption === "function" ? windowOption : function () { return windowOption; };
    var stalenessOption = options.maxStalenessSeconds === undefined ? MAX_STALENESS_SECONDS : options.maxStalenessSeconds;
    var maxStaleness = typeof stalenessOption === "function" ? stalenessOption : function () { return stalenessOption; };
    if (!Number.isFinite(pollMs) || pollMs < 0 || !Number.isFinite(retryMs) || retryMs < 0) fail("invalid intervals");
    function readWindow() {
      var blocks = windowBlocks();
      if (!Number.isInteger(blocks) || blocks < MIN_WINDOW_BLOCKS || blocks > MAX_WINDOW_BLOCKS) {
        fail("windowBlocks must be a whole number from " + MIN_WINDOW_BLOCKS + " to " + MAX_WINDOW_BLOCKS);
      }
      return blocks;
    }
    if (typeof windowOption !== "function") readWindow();
    var batchRequest = options.batchRequest;
    if (typeof batchRequest !== "function") fail("batchRequest function is required");
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
      return { pair: null, pools: [], spreads: [], blockNumber: null, blockTimestamp: null, fromBlock: null,
        protocol: normaliseProtocol(options.protocol || "V4"), v3Pools: null, scanHead: null,
        windowBlocks: null, lastPoll: null,
        lastError: null, retryAt: null, nextPollMs: null, polls: 0, errors: 0 };
    }

    function metadataCalls(pair) {
      return [pair.currency0, pair.currency1].reduce(function (calls, token) {
        return calls.concat(["symbol", "decimals"].map(function (name) {
          return { method: "eth_call", params: [{ to: token, data: tokenInterface.encodeFunctionData(name, []) }, "latest"] };
        }));
      }, []);
    }

    function decodePair(tokenA, tokenB, results) {
      var sorted = sortPair(tokenA, tokenB);
      var pair = { tokenA: utils.getAddress(tokenA), tokenB: utils.getAddress(tokenB),
        currency0: sorted.currency0, currency1: sorted.currency1, keys: poolKeysFor(sorted.currency0, sorted.currency1) };
      function read(i, name, token) {
        var result = rpcResult(results[i]);
        if (!result || result === "0x") fail("no " + name + "() at " + token);
        return tokenInterface.decodeFunctionResult(name, result)[0];
      }
      pair.symbol0 = String(read(0, "symbol", pair.currency0));
      pair.decimals0 = BigNumber.from(read(1, "decimals", pair.currency0)).toNumber();
      pair.symbol1 = String(read(2, "symbol", pair.currency1));
      pair.decimals1 = BigNumber.from(read(3, "decimals", pair.currency1)).toNumber();
      pair.symbolA = pair.tokenA === pair.currency0 ? pair.symbol0 : pair.symbol1;
      pair.symbolB = pair.tokenB === pair.currency0 ? pair.symbol0 : pair.symbol1;
      pair.decimalsA = pair.tokenA === pair.currency0 ? pair.decimals0 : pair.decimals1;
      pair.decimalsB = pair.tokenB === pair.currency0 ? pair.decimals0 : pair.decimals1;
      return pair;
    }

    /** Sort the pair and read symbol() and decimals() of both tokens in one batch. */
    async function loadPair(tokenA, tokenB) {
      return decodePair(tokenA, tokenB, await batchRequest(metadataCalls(sortPair(tokenA, tokenB))));
    }

    /** A block's number and timestamp from eth_getBlockByNumber. Throws on a missing or partial block. */
    function decodeBlock(result, tag) {
      var block = rpcResult(result);
      if (!block || !block.number || !block.timestamp) fail("eth_getBlockByNumber returned no block for " + tag);
      return { number: BigNumber.from(block.number).toNumber(), timestamp: BigNumber.from(block.timestamp).toNumber() };
    }

    function messageOf(error) { return error && error.message ? error.message : String(error); }

    // A numeric lower bound cannot refer to another call's result inside a JSON-RPC batch.
    // Seed it once alongside cached pair metadata and discovery, then refresh it in phase 1.
    async function initialise(current, tokenA, tokenB) {
      var pair = current.pair || sortPair(tokenA, tokenB);
      var calls = [{ method: "eth_getBlockByNumber", params: ["latest", false] }];
      var needsPair = !current.pair;
      var needsV3 = current.protocol !== "V4" && current.v3Pools === null;
      if (needsPair) calls = calls.concat(metadataCalls(pair));
      if (needsV3) calls = calls.concat(v3DiscoveryCalls(pair));
      var results = await batchRequest(calls);
      current.scanHead = decodeBlock(results[0], "latest").number;
      if (needsPair) current.pair = decodePair(tokenA, tokenB, results.slice(1, 5));
      if (needsV3) current.v3Pools = decodeV3Pools(pair, results.slice(needsPair ? 5 : 1));
    }

    /** Phase 2: all active pools' timestamp and health reads, with per-call failures. */
    async function readPoolHealth(pools, latest) {
      var active = pools.filter(function (pool) { return pool.active; });
      if (!active.length) return; // JSON-RPC forbids an empty batch.
      var calls = [];
      active.forEach(function (pool) {
        calls.push({ method: "eth_getBlockByNumber", params: [utils.hexValue(pool.lastBlock), false] });
        calls.push(protocolOf(pool) === "V3" ?
          { method: "eth_call", params: [{ to: pool.address, data: v3PoolInterface.encodeFunctionData("liquidity") },
            utils.hexValue(latest.number)] } :
          { method: "eth_call", params: [encodeSlot0Call(pool.poolId), "latest"] });
      });
      var results;
      try { results = await batchRequest(calls); }
      catch (error) { results = calls.map(function () { return { error: error }; }); }
      active.forEach(function (pool, i) {
        try {
          var block = decodeBlock(results[i * 2], utils.hexValue(pool.lastBlock));
          pool.swapTimestamp = block.timestamp;
          pool.elapsedSeconds = Math.max(0, latest.timestamp - block.timestamp);
        } catch (error) { pool.healthError = "swap block read failed: " + messageOf(error); }
        try {
          var result = rpcResult(results[i * 2 + 1]);
          if (protocolOf(pool) === "V3") {
            pool.liquidity = v3PoolInterface.decodeFunctionResult("liquidity", result)[0];
            pool.empty = pool.liquidity.isZero();
          } else pool.empty = decodeSlot0(result).sqrtPriceX96.isZero();
        } catch (error) {
          pool.healthError = (pool.healthError ? pool.healthError + "; " : "") +
            (protocolOf(pool) === "V3" ? "liquidity" : "slot0") + " read failed: " + messageOf(error);
        }
      });
    }

    /** One scan: latest block, Swap logs of the seven pools over the window, pool health, table and spreads. */
    async function pollOnce() {
      if (!tokens) fail("start(tokenA, tokenB) first");
      // A restart replaces `state` while this poll is awaiting; a stale poll only writes to its own.
      var current = state;
      var blocks = readWindow();
      if (!current.pair || current.scanHead === null || (current.protocol !== "V4" && current.v3Pools === null)) {
        await initialise(current, tokens[0], tokens[1]);
      }
      var pair = current.pair;
      var previousHead = current.scanHead;
      var scanFrom = Math.max(0, previousHead - (blocks - 1));
      var phase1 = [{ method: "eth_getBlockByNumber", params: ["latest", false] }];
      var v4Indexes = [], v3Indexes = [];
      function addLogs(address, topics, indexes) {
        // Reserve headroom for blocks mined between polls when using the 50000-block window.
        // Long windows use two disjoint filters in the SAME HTTP batch; never truncate the window.
        var tailFrom = Math.max(scanFrom, previousHead - 24999);
        if (tailFrom > scanFrom) {
          indexes.push(phase1.length);
          phase1.push({ method: "eth_getLogs", params: [{ address: address, topics: topics,
            fromBlock: utils.hexValue(scanFrom), toBlock: utils.hexValue(tailFrom - 1) }] });
        }
        indexes.push(phase1.length);
        phase1.push({ method: "eth_getLogs", params: [{ address: address, topics: topics,
          fromBlock: utils.hexValue(tailFrom), toBlock: "latest" }] });
      }
      if (current.protocol !== "V3") addLogs(POOL_MANAGER, [SWAP_TOPIC, pair.keys.map(poolId)], v4Indexes);
      // Never send address: []: some nodes interpret an empty filter as ALL addresses.
      if (current.protocol !== "V4" && current.v3Pools.length) {
        addLogs(current.v3Pools.map(function (pool) { return pool.address; }), [V3_SWAP_TOPIC], v3Indexes);
      }
      var results = await batchRequest(phase1);
      var latest = decodeBlock(results[0], "latest");
      // Even when a log read fails, keep a fresh bound so a long outage cannot wedge retries.
      current.scanHead = latest.number;
      if (latest.number < previousHead) fail("latest block moved backwards; retrying with refreshed log window");
      var fromBlock = Math.max(0, latest.number - (blocks - 1));
      function logsInWindow(indexes) {
        return indexes.reduce(function (logs, i) {
          var entries = rpcResult(results[i]);
          if (!Array.isArray(entries)) fail("eth_getLogs did not return a list");
          return logs.concat(entries.filter(function (log) {
            if (!log || log.removed) return false;
            var number = BigNumber.from(log.blockNumber).toNumber();
            return number >= fromBlock && number <= latest.number;
          }));
        }, []);
      }
      var pools = current.protocol === "V3" ? [] : summarisePools(pair.keys, logsInWindow(v4Indexes));
      pools.forEach(function (pool) { pool.protocol = "V4"; });
      if (current.protocol !== "V4") {
        pools = pools.concat(summariseV3Pools(current.v3Pools, logsInWindow(v3Indexes)));
      }
      var scale = Math.pow(10, pair.decimals0 - pair.decimals1);
      pools.forEach(function (pool) {
        pool.displayPrice = pool.price === null ? null : pool.price * scale;
        pool.swapTimestamp = null;
        pool.elapsedSeconds = null;
        pool.empty = null; // true or false once slot0 has been read
        pool.healthError = null;
      });
      await readPoolHealth(pools, latest);
      annotatePools(pools, maxStaleness());
      current.pair = pair;
      current.pools = pools;
      current.spreads = rankSpreads(pools, threshold(), current.protocol === "Both" ? Infinity : 5);
      current.blockNumber = latest.number;
      current.blockTimestamp = latest.timestamp;
      current.fromBlock = fromBlock;
      current.windowBlocks = blocks;
      current.lastPoll = now();
      current.lastError = null;
      current.retryAt = null;
      current.polls += 1;
      return current;
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

    function start(tokenA, tokenB, protocol) {
      stop();
      sortPair(tokenA, tokenB); // validate synchronously so a bad pair never starts a loop
      tokens = [tokenA, tokenB];
      state = freshState();
      if (protocol !== undefined) state.protocol = normaliseProtocol(protocol);
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

    // -------------------------------------------------------------- V3 and mixed execution
    // The V4 encoder, Permit2 APIs and prepareSwap/sendSwap above remain unchanged.
    function routeSnapshot(args) {
      if (!args || !args.buy || !args.sell) fail("select both route pools");
      function snapshot(pool) {
        var protocol = protocolOf(pool);
        if (protocol === "V4") return Object.freeze({ protocol: protocol, poolKey: Object.freeze(normalisePoolKey(pool.poolKey)),
          poolId: poolId(pool.poolKey) });
        if (protocol !== "V3") fail("unknown pool protocol");
        var sorted = sortPair(pool.currency0, pool.currency1);
        if (sorted.currency0 !== utils.getAddress(pool.currency0)) fail("V3 currencies must be sorted");
        return Object.freeze({ protocol: protocol, address: recipientAddress(pool.address),
          currency0: sorted.currency0, currency1: sorted.currency1, fee: v3Fee(pool.fee) });
      }
      var buy = snapshot(args.buy);
      var sell = snapshot(args.sell);
      var a = buy.poolKey || buy;
      var b = sell.poolKey || sell;
      if (a.currency0 !== b.currency0 || a.currency1 !== b.currency1) fail("both pools must trade the same pair");
      if (buy.protocol === sell.protocol && (buy.protocol === "V3" ? buy.fee === sell.fee || buy.address === sell.address : buy.poolId === sell.poolId)) {
        fail("buy and sell pool are the same pool");
      }
      var input = uint128(args.usdgIn, "usdgIn");
      var bridge = uint128(args.ponsAmount, "ponsAmount");
      var minimum = uint128(args.minUsdgOut, "minUsdgOut");
      if (input.isZero() || bridge.isZero() || input.eq(MAX_UINT128) || bridge.eq(MAX_UINT128)) fail("input and bridge amounts must be positive and below uint128 max");
      if ((buy.protocol === "V3" || sell.protocol === "V3") && minimum.isZero()) fail("a quoted minimum return is required for V3 routes");
      return Object.freeze({ buy: buy, sell: sell, usdgIn: input, ponsAmount: bridge, minUsdgOut: minimum,
        pair: Object.freeze(resolvePair({ currency0: a.currency0, currency1: a.currency1,
          symbol0: args.pair && args.pair.symbol0, symbol1: args.pair && args.pair.symbol1 })),
        mixed: buy.protocol !== sell.protocol, deadline: args.deadline });
    }

    function routeApprovals(route) {
      var entries = [{ protocol: route.buy.protocol, token: route.pair.currency1, amount: route.usdgIn }];
      // V3 exactInput carries the whole output between its hops inside the router.
      if (route.mixed || route.buy.protocol === "V4") entries.push({ protocol: route.sell.protocol,
        token: route.pair.currency0, amount: route.ponsAmount });
      return entries;
    }

    async function tokenAllowance(expected, token, spender) {
      var result = await request("eth_call", [{ to: token,
        data: tokenInterface.encodeFunctionData("allowance", [expected.account, spender]) }, "latest"]);
      return tokenInterface.decodeFunctionResult("allowance", result)[0];
    }

    async function checkRouteAllowances(route, deadline, expected) {
      await assertSession(expected);
      for (var entry of routeApprovals(route)) {
        var spender = entry.protocol === "V3" ? V3_ROUTER : PERMIT2;
        if ((await tokenAllowance(expected, entry.token, spender)).lt(entry.amount)) {
          fail(labelFor(entry.token, route.pair) + " ERC20 allowance to " + (entry.protocol === "V3" ? "V3 Router is too low; click APPROVE V3 ROUTER" : "Permit2 is too low"));
        }
        if (entry.protocol === "V4") {
          var permit = await readPermit2(expected.account, entry.token);
          if (permit.amount.lt(entry.amount) || BigNumber.from(permit.expiration).lt(deadline)) fail("Permit2 allowance is insufficient or expires too soon; click APPROVE PERMIT2");
        }
      }
      await assertSession(expected);
    }

    async function approveRouteV3(args) {
      var route = routeSnapshot(args);
      var expected = session;
      prepared = null;
      await assertSession(expected);
      await requireCode(V3_ROUTER);
      for (var entry of routeApprovals(route).filter(function (entry) { return entry.protocol === "V3"; })) {
        var limit = entry.amount.mul(100);
        var allowed = await tokenAllowance(expected, entry.token, V3_ROUTER);
        if (allowed.gte(limit)) { status("V3 Router allowance already sufficient; skipped"); continue; }
        await requireCode(entry.token);
        // Support tokens requiring zero before changing a nonzero allowance. Each receipt gates the next prompt.
        var amounts = allowed.isZero() ? [limit] : [BigNumber.from(0), limit];
        for (var amount of amounts) {
          var transaction = { from: expected.account, to: entry.token, value: "0x0", chainId: utils.hexValue(CHAIN_ID),
            data: v3TokenInterface.encodeFunctionData("approve", [V3_ROUTER, amount]) };
          await assertSession(expected);
          var result = await request("eth_call", [transaction, "latest"]);
          if (result !== "0x" && !abi.decode(["bool"], result)[0]) fail("Token refused V3 approval");
          await submit(transaction, expected, labelFor(entry.token, route.pair) + " V3 Router approval");
        }
        if ((await tokenAllowance(expected, entry.token, V3_ROUTER)).lt(limit)) fail("V3 Router allowance did not update after confirmation");
      }
      await assertSession(expected);
    }

    async function approveRoutePermit2(args, expiration) {
      var route = routeSnapshot(args);
      var expected = session;
      prepared = null;
      await assertSession(expected);
      var until = (await timestamp()) + 1200;
      if (BigNumber.from(expiration).lt(until)) fail("approval expiration must cover the next 20 minutes");
      for (var entry of routeApprovals(route).filter(function (entry) { return entry.protocol === "V4"; })) {
        var limit = entry.amount.mul(100);
        encodePermit2Approve(entry.token, ROUTER, limit, expiration);
        if ((await tokenAllowance(expected, entry.token, PERMIT2)).lt(entry.amount)) fail("ERC20 allowance to Permit2 is too low; approve the token to Permit2 first");
        var allowed = await readPermit2(expected.account, entry.token);
        if (allowed.amount.gte(limit) && BigNumber.from(allowed.expiration).gte(until)) {
          status("Permit2 allowance already sufficient; skipped"); continue;
        }
        await approveForSession(entry.token, ROUTER, limit, expiration, expected, route.pair);
      }
      await assertSession(expected);
    }

    function routeTransactions(route, recipient, deadline) {
      function transaction(to, data) { return Object.freeze({ from: recipient, to: to, data: data,
        value: "0x0", chainId: utils.hexValue(CHAIN_ID) }); }
      if (!route.mixed) {
        return [transaction(V3_ROUTER, buildV3Calldata({ tokens: [route.pair.currency1, route.pair.currency0, route.pair.currency1],
          fees: [route.buy.fee, route.sell.fee], recipient: recipient, deadline: deadline,
          amountIn: route.usdgIn, amountOutMinimum: route.minUsdgOut }))];
      }
      return [route.buy, route.sell].map(function (pool, index) {
        var input = index === 0 ? route.usdgIn : route.ponsAmount;
        var minimum = index === 0 ? route.ponsAmount : route.minUsdgOut;
        if (pool.protocol === "V3") return transaction(V3_ROUTER, buildV3Calldata({
          tokens: index === 0 ? [route.pair.currency1, route.pair.currency0] : [route.pair.currency0, route.pair.currency1],
          fees: [pool.fee], recipient: recipient, deadline: deadline, amountIn: input, amountOutMinimum: minimum }));
        return transaction(ROUTER, encodeExecute(COMMAND_V4_SWAP, [encodeV4Swap({ poolKey: pool.poolKey,
          zeroForOne: index === 1, amountIn: input, amountOutMinimum: minimum, recipient: recipient })], deadline));
      });
    }

    async function validateV3Pools(route) {
      for (var pool of [route.buy, route.sell].filter(function (pool) { return pool.protocol === "V3"; })) {
        var result = await request("eth_call", [{ to: V3_FACTORY,
          data: v3FactoryInterface.encodeFunctionData("getPool", [pool.currency0, pool.currency1, pool.fee]) }, "latest"]);
        if (v3FactoryInterface.decodeFunctionResult("getPool", result)[0] !== pool.address) fail("V3 pool no longer matches factory discovery; restart the monitor");
      }
    }

    async function prepareRoute(args) {
      var route = routeSnapshot(args);
      if (route.buy.protocol === "V4" && route.sell.protocol === "V4") return prepareSwap({
        usdgIn: route.usdgIn, ponsAmount: route.ponsAmount, minUsdgOut: route.minUsdgOut,
        buyPool: route.buy.poolKey, sellPool: route.sell.poolKey, pair: route.pair, deadline: route.deadline,
      });
      prepared = null;
      var expected = session;
      await assertSession(expected);
      var now = await timestamp();
      var deadline = route.deadline === undefined ? now + 1200 : BigNumber.from(route.deadline).toNumber();
      if (deadline <= now) fail("Swap deadline has expired; build and dry run again");
      await requireCode(V3_ROUTER);
      if (route.mixed) await requireCode(ROUTER);
      await validateV3Pools(route);
      await checkRouteAllowances(route, deadline, expected);
      var transactions = Object.freeze(routeTransactions(route, expected.account, deadline));
      // Mixed leg 2 is simulated only AFTER leg 1 confirms: its funds do not exist yet.
      await request("eth_call", [transactions[0], "latest"]);
      await assertSession(expected);
      prepared = Object.freeze({ route: route, transactions: transactions, transaction: transactions[0], deadline: deadline });
      status(route.mixed ? "First leg dry run succeeded; second leg will be simulated after its funds arrive" : "V3 atomic dry run succeeded");
      return prepared;
    }

    async function sendRoute(candidate) {
      if (candidate && !candidate.route) return sendSwap(candidate);
      if (!candidate || candidate !== prepared) fail("Build and dry run this swap first");
      prepared = null;
      var expected = session;
      var firstReceipt = null;
      var submittedHashes = [];
      async function submitLeg(transaction, label) {
        await assertSession(expected);
        var hash = await request("eth_sendTransaction", [transaction]);
        submittedHashes.push(hash);
        status(label + " submitted: " + hash);
        try {
          var receipt = await waitReceipt(hash, expected);
          status(label + " confirmed: " + hash);
          return receipt;
        } catch (error) {
          // A wallet/network change or RPC failure after submission leaves confirmation unknown.
          // Preserve the hash just as for a timeout; never silently restart either mixed leg.
          if (!/Transaction reverted:/.test(error.message)) error.pendingHash = hash;
          throw error;
        }
      }
      try {
        await assertSession(expected);
        if ((await timestamp()) >= candidate.deadline) fail("Swap deadline has expired; build and dry run again");
        await checkRouteAllowances(candidate.route, candidate.deadline, expected);
        var before = candidate.route.mixed ? (await readBalances([candidate.route.pair.currency0], expected.account)).tokens[0] : null;
        await request("eth_call", [candidate.transactions[0], "latest"]);
        firstReceipt = await submitLeg(candidate.transactions[0], candidate.route.mixed ? "Mixed leg 1" : "V3 atomic swap");
        if (!candidate.route.mixed) return firstReceipt;
        await assertSession(expected);
        var after = (await readBalances([candidate.route.pair.currency0], expected.account)).tokens[0];
        if (after.lt(before.add(candidate.route.ponsAmount))) fail("Bridge balance increase is below the minimum; second leg stopped");
        if ((await timestamp()) >= candidate.deadline) fail("Deadline expired after leg 1; second leg stopped");
        // Only the second leg's allowance remains necessary; the first may now be spent.
        var sell = candidate.route.sell;
        var token = candidate.route.pair.currency0;
        var spender = sell.protocol === "V3" ? V3_ROUTER : PERMIT2;
        if ((await tokenAllowance(expected, token, spender)).lt(candidate.route.ponsAmount)) fail("Second leg allowance is insufficient");
        if (sell.protocol === "V4") {
          var permit = await readPermit2(expected.account, token);
          if (permit.amount.lt(candidate.route.ponsAmount) || BigNumber.from(permit.expiration).lt(candidate.deadline)) fail("Second leg Permit2 allowance expired or is insufficient");
        }
        await request("eth_call", [candidate.transactions[1], "latest"]);
        var receipt = await submitLeg(candidate.transactions[1], "Mixed leg 2");
        return Object.assign({}, receipt, { firstLegHash: firstReceipt.transactionHash });
      } catch (error) {
        if (candidate.route.mixed && firstReceipt) {
          error.firstLegHash = firstReceipt.transactionHash;
          error.message = "Leg 1 confirmed (" + firstReceipt.transactionHash + "). Leg 2 did not confirm; check both hashes and the wallet's bridge balance before taking further action. " + error.message;
          status(error.message);
        } else if (candidate.route.mixed && submittedHashes.length && error.pendingHash) {
          error.message = "Leg 1 submitted (" + submittedHashes[0] + "), but confirmation was interrupted. Check its receipt before retrying the route. " + error.message;
          status(error.message);
        }
        throw error;
      }
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
      prepareRoute: prepareRoute, sendRoute: sendRoute, approveRouteV3: approveRouteV3, approveRoutePermit2: approveRoutePermit2,
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
    V3_FACTORY: V3_FACTORY,
    V3_ROUTER: V3_ROUTER,
    WETH: WETH,
    V3_FEE_TIERS: V3_FEE_TIERS,
    V3_SWAP_TOPIC: V3_SWAP_TOPIC,
    V3_QUOTE_SELECTOR: V3_QUOTE_SELECTOR,
    MANUAL_ADDRESS_ERROR: MANUAL_ADDRESS_ERROR,
    MANUAL_INVALID_ERROR: MANUAL_INVALID_ERROR,
    MANUAL_PAIR_ERROR: MANUAL_PAIR_ERROR,
    MANUAL_LIQUIDITY_ERROR: MANUAL_LIQUIDITY_ERROR,
    MANUAL_SAME_POOL_ERROR: MANUAL_SAME_POOL_ERROR,
    MANUAL_READS: MANUAL_READS,
    parseManualPoolAddress: parseManualPoolAddress,
    manualPoolCalls: manualPoolCalls,
    decodeManualSlot0: decodeManualSlot0,
    decodeManualPool: decodeManualPool,
    readManualPool: readManualPool,
    validateManualPools: validateManualPools,
    manualSpread: manualSpread,
    formatManualFee: formatManualFee,
    truncateAddress: truncateAddress,
    formatLastRead: formatLastRead,
    createManualMonitor: createManualMonitor,
    protocolOf: protocolOf,
    formatV3Fee: formatV3Fee,
    discoverV3Pools: discoverV3Pools,
    decodeV3SwapLog: decodeV3SwapLog,
    summariseV3Pools: summariseV3Pools,
    encodeV3Path: encodeV3Path,
    buildV3Calldata: buildV3Calldata,
    quoteV3ExactIn: quoteV3ExactIn,
    quotePool: quotePool,
    protocolAutoDecision: protocolAutoDecision,
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
    MIN_WINDOW_BLOCKS: MIN_WINDOW_BLOCKS,
    MAX_WINDOW_BLOCKS: MAX_WINDOW_BLOCKS,
    MAX_STALENESS_SECONDS: MAX_STALENESS_SECONDS,
    POOLS_SLOT: POOLS_SLOT,
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
    formatDuration: formatDuration,
    formatElapsed: formatElapsed,
    stalenessColor: stalenessColor,
    parseWindowBlocks: parseWindowBlocks,
    parseMaxStaleness: parseMaxStaleness,
    slot0StorageSlot: slot0StorageSlot,
    encodeSlot0Call: encodeSlot0Call,
    decodeSlot0: decodeSlot0,
    poolStatus: poolStatus,
    annotatePools: annotatePools,
    autoDecision: autoDecision,
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
