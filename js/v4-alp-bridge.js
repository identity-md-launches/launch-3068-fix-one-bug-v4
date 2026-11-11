/**
 * Job 10: Uniswap V4 "ALP bridge" on Base (chain id 8453). Two things live here:
 *
 *  1. READ (eth_call only). The PoolKey, slot0 and liquidity of the two ALP pools, for the "ALP V4"
 *     rows of the cross-DEX table and the V4 pool-read display. Price = (sqrtPriceX96 / 2^96)^2.
 *     Polled every 30 s alongside the V3 reads, or once with READ PRICES.
 *  2. ENCODE (pure). Universal Router execute() calldata for a V4 exact-in path swap and for the
 *     2-hop bridge route Token -> [V3] -> ALP -> [V4 ALP pool] -> out. The data-logger page never
 *     sends it; the gauge page (separate build) does. Mirrored byte for byte by src/V4AlpBridge.sol.
 *
 * What the deployed contracts actually expose (checked with eth_call against Base, 2026-11-11):
 *  - PoolManager has no getPool(bytes32). The on-chain poolId -> PoolKey map is
 *    PositionManager.poolKeys(bytes25), keyed by the first 25 bytes of the poolId. The key is
 *    verified by hashing it back to the poolId, so tickSpacing is never guessed.
 *  - StateView has no slot0(bytes32): getSlot0(poolId) -> (sqrtPriceX96, tick, protocolFee, lpFee)
 *    and getLiquidity(poolId) -> liquidity. tickSpacing comes from the PoolKey.
 *  - V4 swaps are Universal Router command 0x10 (V4_SWAP); the multi-hop exact-in path is the V4
 *    action 0x07 (SWAP_EXACT_IN) inside it. 0x04 is SWEEP in the router's Commands.sol.
 *  - The Base router's ExactInputSingleParams has no minHopPriceX36 word (unlike Robinhood Chain's).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("./vendor/ethers-5.7.2.umd.min.js"));
  } else {
    root.V4AlpBridge = factory(root.ethers);
  }
})(typeof self !== "undefined" ? self : this, function (ethersLib) {
  "use strict";

  var ethers = ethersLib.ethers || ethersLib;
  var utils = ethers.utils;
  var BigNumber = ethers.BigNumber;
  var abi = utils.defaultAbiCoder;

  function fail(message) { throw new Error("V4AlpBridge: " + message); }

  // ---------------------------------------------------------------- Base addresses (the brief's)
  var CHAIN_ID = 8453;
  var RPC_URL = "https://mainnet.base.org"; // public Base RPC; the page lets the operator override it
  var POOL_MANAGER = "0x498581ff718922c3f8e6a244956af099b2652b2b";
  var STATE_VIEW = "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71";
  var UNIVERSAL_ROUTER = "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40";
  var POSITION_MANAGER = "0x7c5f5a4bbd8fd63184577525326123b519429bdc";
  var ALP = "0x29d95816a65425b3514f9acac7548b867343b818";
  var NATIVE = ethers.constants.AddressZero; // native ETH is currency address(0) in a V4 PoolKey
  var ALP_POOL_FEE = 1; // 0.0001%
  // currency0 of the ALP/USDG pool: the only USDG address whose key hashes to the brief's poolId.
  var USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  // The keys the brief's two pool ids hash from (verified by poolIdOf in the tests and at read time).
  var ALP_ETH_KEY = { currency0: NATIVE, currency1: ALP, fee: ALP_POOL_FEE, tickSpacing: 1, hooks: NATIVE };
  var ALP_USDG_KEY = { currency0: ALP, currency1: USDG, fee: ALP_POOL_FEE, tickSpacing: 1, hooks: NATIVE };
  var POOLS = [
    { name: "ALP/ETH", poolId: "0x71fcb8242d330883f1114bd719b0d6f852a4c26450c665effb048a094766efd0", key: ALP_ETH_KEY },
    { name: "ALP/USDG", poolId: "0xa551151cfe4ea1bd015c01c6a6b4ca11056db4ddd81aa0ddc4d465e3c25b2000", key: ALP_USDG_KEY },
  ];
  var POLL_INTERVAL_MS = 30000;
  /**
   * Where the pools can be read. "stateView" (Base, the brief): PositionManager.poolKeys + StateView
   * getSlot0/getLiquidity, 3 eth_calls per pool. "extsload" (a PoolManager without a StateView, such
   * as Robinhood Chain's, where the ALP token and both pools were found live on 2026-11-11): the
   * Pool.State words through PoolManager.extsload, 2 eth_calls per pool, PoolKey = the known key
   * verified by hashing it back to the poolId.
   */
  var CHAINS = {
    8453: { chainId: 8453, name: "Base", rpcUrl: RPC_URL, backend: "stateView", poolManager: POOL_MANAGER, stateView: STATE_VIEW, positionManager: POSITION_MANAGER },
    4663: { chainId: 4663, name: "Robinhood Chain", rpcUrl: "https://rpc-robinhood.blockmachine.io", backend: "extsload", poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951" },
  };
  var READS_PER_POOL = { stateView: 3, extsload: 2 };
  // PoolManager Pool.State: keccak256(abi.encode(poolId, POOLS_SLOT)); slot0 at +0, liquidity at +3.
  var POOLS_SLOT = 6;
  var LIQUIDITY_OFFSET = 3;

  var STATUS_OK = "OK";
  var STATUS_NOT_INITIALIZED = "not initialized";
  var STATUS_NO_KEY = "key not registered";
  var STATUS_ERROR = "error";

  // ---------------------------------------------------------------- router constants
  var EXECUTE_SELECTOR = "0x3593564c";
  var COMMAND_V3_SWAP_EXACT_IN = "00";
  var COMMAND_V4_SWAP = "10";
  var ACTION_SWAP_EXACT_IN_SINGLE = "06";
  var ACTION_SWAP_EXACT_IN = "07";
  var ACTION_SETTLE = "0b";
  var ACTION_SETTLE_ALL = "0c";
  var ACTION_TAKE = "0e";
  var ACTION_TAKE_ALL = "0f";
  var OPEN_DELTA = 0;
  var CONTRACT_BALANCE = BigNumber.from("0x8000000000000000000000000000000000000000000000000000000000000000");
  var MSG_SENDER = "0x0000000000000000000000000000000000000001";
  var ADDRESS_THIS = "0x0000000000000000000000000000000000000002";
  var V3_FEES = [100, 500, 3000, 10000];
  var MAX_UINT128 = BigNumber.from(2).pow(128).sub(1);
  var Q96 = BigNumber.from(2).pow(96);

  var POOL_KEY_TYPE = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
  var PATH_KEY_TYPE = "tuple(address intermediateCurrency,uint24 fee,int24 tickSpacing,address hooks,bytes hookData)";
  var EXACT_IN_TYPE = "tuple(address currencyIn," + PATH_KEY_TYPE + "[] path,uint128 amountIn,uint128 amountOutMinimum)";
  var EXACT_IN_SINGLE_TYPE = "tuple(" + POOL_KEY_TYPE + " poolKey,bool zeroForOne,uint128 amountIn,uint128 amountOutMinimum,bytes hookData)";

  var positionManagerInterface = new utils.Interface([
    "function poolKeys(bytes25 poolId) view returns (address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)",
  ]);
  var stateViewInterface = new utils.Interface([
    "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96,int24 tick,uint24 protocolFee,uint24 lpFee)",
    "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
  ]);
  var routerInterface = new utils.Interface(["function execute(bytes commands,bytes[] inputs,uint256 deadline) payable"]);

  // ---------------------------------------------------------------- helpers

  function checkAddress(value, label) {
    if (typeof value !== "string" || !utils.isAddress(value)) fail(label + " is not an address");
    return utils.getAddress(value);
  }

  function checkPoolId(poolId) {
    if (typeof poolId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(poolId)) fail("poolId must be 32 bytes");
    return poolId.toLowerCase();
  }

  function same(a, b) { return String(a).toLowerCase() === String(b).toLowerCase(); }

  function toUint128(value, label) {
    var amount = BigNumber.from(value);
    if (amount.lt(0) || amount.gt(MAX_UINT128)) fail(label + " must fit uint128");
    return amount;
  }

  function checkPoolKey(key) {
    if (!key || typeof key !== "object") fail("poolKey is required");
    var c0 = checkAddress(key.currency0, "currency0");
    var c1 = checkAddress(key.currency1, "currency1");
    if (BigInt(c0) >= BigInt(c1)) fail("currency0 must sort below currency1");
    var fee = Number(key.fee);
    var tickSpacing = Number(key.tickSpacing);
    if (!Number.isInteger(fee) || fee < 0 || fee > 0xffffff) fail("fee must fit uint24");
    if (!Number.isInteger(tickSpacing) || tickSpacing < -8388608 || tickSpacing > 8388607) fail("tickSpacing must fit int24");
    return { currency0: c0, currency1: c1, fee: fee, tickSpacing: tickSpacing, hooks: checkAddress(key.hooks, "hooks") };
  }

  // ---------------------------------------------------------------- pool ids and reads

  /** keccak256(abi.encode(PoolKey)): the PoolManager's PoolId. */
  function poolIdOf(key) {
    var k = checkPoolKey(key);
    return utils.keccak256(abi.encode([POOL_KEY_TYPE], [k]));
  }

  /** PositionManager.poolKeys is keyed by the first 25 bytes of the poolId. */
  function toPoolKeysId(poolId) { return checkPoolId(poolId).slice(0, 2 + 50); }

  function encodePoolKeysCall(poolId) { return positionManagerInterface.encodeFunctionData("poolKeys", [toPoolKeysId(poolId)]); }
  function encodeGetSlot0Call(poolId) { return stateViewInterface.encodeFunctionData("getSlot0", [checkPoolId(poolId)]); }
  function encodeGetLiquidityCall(poolId) { return stateViewInterface.encodeFunctionData("getLiquidity", [checkPoolId(poolId)]); }

  var poolManagerInterface = new utils.Interface(["function extsload(bytes32 slot) view returns (bytes32)"]);

  function slot0StorageSlot(poolId) { return utils.keccak256(abi.encode(["bytes32", "uint256"], [checkPoolId(poolId), POOLS_SLOT])); }
  function liquidityStorageSlot(poolId) { return utils.hexZeroPad(BigNumber.from(slot0StorageSlot(poolId)).add(LIQUIDITY_OFFSET).toHexString(), 32); }
  function encodeExtsloadCall(slot) { return poolManagerInterface.encodeFunctionData("extsload", [slot]); }

  /** Accept a candidate PoolKey for poolId only if it hashes to it (the poolId IS the key's hash). */
  function verifyPoolKey(poolId, key) {
    var actual = poolIdOf(key);
    if (!same(actual, checkPoolId(poolId))) fail("pool key hashes to " + actual + ", not " + poolId);
    return checkPoolKey(key);
  }

  /** Unpack a Slot0 word: sqrtPriceX96 (low 160 bits), tick (24), protocolFee (24), lpFee (24). */
  function decodeSlot0Word(word) {
    var w = BigNumber.from(word);
    var mask24 = 0xffffff;
    var rawTick = w.shr(160).and(mask24).toNumber();
    return {
      sqrtPriceX96: w.and(BigNumber.from(2).pow(160).sub(1)),
      tick: rawTick >= 0x800000 ? rawTick - 0x1000000 : rawTick,
      protocolFee: w.shr(184).and(mask24).toNumber(),
      lpFee: w.shr(208).and(mask24).toNumber(),
    };
  }

  function decodeLiquidityWord(word) { return BigNumber.from(word).and(MAX_UINT128); }

  /** The eth_calls of one pool for a chain config, READS_PER_POOL[backend] of them. */
  function poolReadCalls(poolId, chain) {
    var cfg = chain || CHAINS[8453];
    if (cfg.backend === "extsload") {
      return [
        { method: "eth_call", params: [{ to: cfg.poolManager, data: encodeExtsloadCall(slot0StorageSlot(poolId)) }, "latest"] },
        { method: "eth_call", params: [{ to: cfg.poolManager, data: encodeExtsloadCall(liquidityStorageSlot(poolId)) }, "latest"] },
      ];
    }
    if (cfg.backend !== "stateView") fail("unknown backend " + cfg.backend);
    return [
      { method: "eth_call", params: [{ to: cfg.positionManager || POSITION_MANAGER, data: encodePoolKeysCall(poolId) }, "latest"] },
      { method: "eth_call", params: [{ to: cfg.stateView || STATE_VIEW, data: encodeGetSlot0Call(poolId) }, "latest"] },
      { method: "eth_call", params: [{ to: cfg.stateView || STATE_VIEW, data: encodeGetLiquidityCall(poolId) }, "latest"] },
    ];
  }

  /** Decode poolKeys(bytes25); a key that does not hash back to the poolId (zero included) is rejected. */
  function decodePoolKey(poolId, returndata) {
    var decoded = positionManagerInterface.decodeFunctionResult("poolKeys", returndata);
    var key = { currency0: decoded.currency0, currency1: decoded.currency1, fee: Number(decoded.fee), tickSpacing: Number(decoded.tickSpacing), hooks: decoded.hooks };
    if (same(key.currency0, NATIVE) && same(key.currency1, NATIVE)) return null; // never registered
    var actual = poolIdOf(key);
    if (!same(actual, poolId)) fail("poolKeys returned a key for " + actual + ", not " + poolId);
    return key;
  }

  function decodeSlot0(returndata) {
    var d = stateViewInterface.decodeFunctionResult("getSlot0", returndata);
    return { sqrtPriceX96: BigNumber.from(d.sqrtPriceX96), tick: Number(d.tick), protocolFee: Number(d.protocolFee), lpFee: Number(d.lpFee) };
  }

  function decodeLiquidity(returndata) { return BigNumber.from(stateViewInterface.decodeFunctionResult("getLiquidity", returndata).liquidity); }

  /** (sqrtPriceX96 / 2^96)^2 as a JS number: currency1 per currency0 in base units. 0 when not initialized. */
  function sqrtPriceToPrice(sqrtPriceX96) {
    var sqrt = BigNumber.from(sqrtPriceX96);
    if (sqrt.isZero()) return 0;
    // 2^96 = 79228162514264337593543950336; the division is exact enough in double precision (53 bits).
    var ratio = Number(sqrt.toString()) / 79228162514264337593543950336;
    return ratio * ratio;
  }

  /** The same price scaled by 1e18 as a BigNumber, matching V4AlpBridge.priceE18 (sqrtPrice < 2^128). */
  function priceE18(sqrtPriceX96) {
    var sqrt = BigNumber.from(sqrtPriceX96);
    if (sqrt.isZero()) fail("pool not initialized");
    if (sqrt.gte(BigNumber.from(2).pow(128))) fail("price out of range");
    return sqrt.mul(sqrt).div(Q96).mul(BigNumber.from(10).pow(18)).div(Q96);
  }

  /** Spot output after the pool fee, no price impact. A display estimate, never a minimum. */
  function spotQuote(amountIn, price, fee, zeroForOne) {
    var amount = BigNumber.from(amountIn);
    var p = BigNumber.from(price);
    if (p.isZero()) fail("pool not initialized");
    var e18 = BigNumber.from(10).pow(18);
    var gross = zeroForOne ? amount.mul(p).div(e18) : amount.mul(e18).div(p);
    return gross.mul(1000000 - Number(fee)).div(1000000);
  }

  function formatFeePercent(fee) {
    var f = Number(fee);
    if (!Number.isInteger(f) || f < 0 || f > 0xffffff) fail("fee must fit uint24");
    var whole = Math.floor(f / 10000);
    var fraction = String(f % 10000).padStart(4, "0");
    while (fraction.length > 2 && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
    return whole + "." + fraction;
  }

  function totalFee(v3Fee, v4Fee) { return Number(v3Fee) + Number(v4Fee); }

  /** "Route: TOKEN → ALP (V3 0.30%) → USDG (V4 0.0001%) | Total fee: 0.3001%" */
  function describeRoute(tokenSymbol, v3Fee, outSymbol, v4Fee) {
    return "Route: " + tokenSymbol + " → ALP (V3 " + formatFeePercent(v3Fee) + "%) → " + outSymbol + " (V4 " + formatFeePercent(v4Fee) +
      "%) | Total fee: " + formatFeePercent(totalFee(v3Fee, v4Fee)) + "%";
  }

  function involvesAlp(tokenA, tokenB) { return same(tokenA, ALP) || same(tokenB, ALP); }

  /**
   * The route of a pair. With ALP on one side: the single V4 ALP hop. Otherwise, for tokenOut = the
   * ALP pool's other currency: Token -> ALP (V3, v3Fee) -> out (V4). Returns null when nothing routes.
   */
  function routeFor(tokenIn, tokenOut, alpPoolKey, v3Fee) {
    var key = checkPoolKey(alpPoolKey);
    if (!same(key.currency0, ALP) && !same(key.currency1, ALP)) fail("not an ALP pool");
    var other = same(key.currency0, ALP) ? key.currency1 : key.currency0;
    if (involvesAlp(tokenIn, tokenOut)) {
      var out = same(tokenIn, ALP) ? tokenOut : tokenIn;
      if (!same(out, other)) return null;
      return { hops: [{ protocol: "V4", from: tokenIn, to: tokenOut, fee: key.fee, poolKey: key }], totalFee: key.fee, bridge: false };
    }
    if (!same(tokenOut, other)) return null;
    return {
      hops: [{ protocol: "V3", from: tokenIn, to: ALP, fee: Number(v3Fee) }, { protocol: "V4", from: ALP, to: tokenOut, fee: key.fee, poolKey: key }],
      totalFee: totalFee(v3Fee, key.fee),
      bridge: true,
    };
  }

  // ---------------------------------------------------------------- encoders

  function pathKeyFor(poolKey, currencyIn) {
    var key = checkPoolKey(poolKey);
    var from = checkAddress(currencyIn, "currencyIn");
    var intermediate;
    if (same(from, key.currency0)) intermediate = key.currency1;
    else if (same(from, key.currency1)) intermediate = key.currency0;
    else fail("currencyIn is not in the pool");
    return { intermediateCurrency: intermediate, fee: key.fee, tickSpacing: key.tickSpacing, hooks: key.hooks, hookData: "0x" };
  }

  function encodeExactInput(params) {
    if (!params || !Array.isArray(params.path) || !params.path.length) fail("path must have at least one hop");
    var currencyIn = checkAddress(params.currencyIn, "currencyIn");
    var amountIn = toUint128(params.amountIn, "amountIn");
    if (amountIn.isZero()) fail("amountIn 0 is OPEN_DELTA");
    var current = currencyIn;
    var path = params.path.map(function (hop) {
      var next = checkAddress(hop.intermediateCurrency, "intermediateCurrency");
      if (same(next, current)) fail("path loops");
      current = next;
      return { intermediateCurrency: next, fee: Number(hop.fee), tickSpacing: Number(hop.tickSpacing), hooks: checkAddress(hop.hooks, "hooks"), hookData: hop.hookData || "0x" };
    });
    return abi.encode([EXACT_IN_TYPE], [{ currencyIn: currencyIn, path: path, amountIn: amountIn, amountOutMinimum: toUint128(params.amountOutMinimum || 0, "amountOutMinimum") }]);
  }

  function encodeExactInputSingle(params) {
    var key = checkPoolKey(params.poolKey);
    return abi.encode([EXACT_IN_SINGLE_TYPE], [{
      poolKey: key, zeroForOne: !!params.zeroForOne, amountIn: toUint128(params.amountIn, "amountIn"),
      amountOutMinimum: toUint128(params.amountOutMinimum || 0, "amountOutMinimum"), hookData: params.hookData || "0x",
    }]);
  }

  function encodeSettle(currency, amount, payerIsUser) { return abi.encode(["address", "uint256", "bool"], [checkAddress(currency, "currency"), amount, !!payerIsUser]); }
  function encodeSettleAll(currency, maxAmount) { return abi.encode(["address", "uint256"], [checkAddress(currency, "currency"), maxAmount]); }
  function encodeTake(currency, recipient, amount) {
    var to = checkAddress(recipient, "recipient");
    if (same(to, NATIVE)) fail("recipient is the zero address");
    return abi.encode(["address", "address", "uint256"], [checkAddress(currency, "currency"), to, amount]);
  }
  function encodeTakeAll(currency, minAmount) { return abi.encode(["address", "uint256"], [checkAddress(currency, "currency"), minAmount]); }

  function encodeV4SwapInput(actions, params) {
    var bytes = utils.arrayify(actions);
    if (bytes.length !== params.length) fail("actions and params differ in length");
    return abi.encode(["bytes", "bytes[]"], [actions, params]);
  }

  function encodeExecute(commands, inputs, deadline) {
    if (utils.arrayify(commands).length !== inputs.length) fail("commands and inputs differ in length");
    return routerInterface.encodeFunctionData("execute", [commands, inputs, deadline]);
  }

  function currencyOut(params) { return params.path[params.path.length - 1].intermediateCurrency; }

  /**
   * V4-only exact-in swap along a path: command 0x10 with actions 0x07 (SWAP_EXACT_IN), 0x0c
   * (SETTLE_ALL currencyIn) and 0x0e (TAKE the whole output to recipient). Returns the transaction
   * {to, data, value}: value is amountIn when currencyIn is native ETH, else 0 (paid through Permit2).
   */
  function buildV4ExactInCalldata(options) {
    var recipient = checkAddress(options.recipient, "recipient");
    if (same(recipient, NATIVE)) fail("recipient is the zero address");
    var deadline = BigNumber.from(options.deadline);
    var params = { currencyIn: options.currencyIn, path: options.path, amountIn: options.amountIn, amountOutMinimum: options.amountOutMinimum || 0 };
    var exactIn = encodeExactInput(params);
    var currencyIn = checkAddress(params.currencyIn, "currencyIn");
    var input = encodeV4SwapInput("0x" + ACTION_SWAP_EXACT_IN + ACTION_SETTLE_ALL + ACTION_TAKE, [
      exactIn, encodeSettleAll(currencyIn, params.amountIn), encodeTake(checkAddress(currencyOut(params), "currencyOut"), recipient, OPEN_DELTA),
    ]);
    var data = encodeExecute("0x" + COMMAND_V4_SWAP, [input], deadline);
    return { to: UNIVERSAL_ROUTER, data: data, value: same(currencyIn, NATIVE) ? BigNumber.from(params.amountIn) : BigNumber.from(0), chainId: CHAIN_ID };
  }

  function encodeV3Path(tokenIn, fee, tokenOut) {
    if (V3_FEES.indexOf(Number(fee)) < 0) fail("unsupported V3 fee " + fee);
    return utils.solidityPack(["address", "uint24", "address"], [checkAddress(tokenIn, "tokenIn"), Number(fee), checkAddress(tokenOut, "tokenOut")]);
  }

  function encodeV3ExactIn(recipient, amountIn, amountOutMin, path, payerIsUser) {
    if (BigNumber.from(amountIn).isZero()) fail("amountIn 0 is OPEN_DELTA");
    return abi.encode(["address", "uint256", "uint256", "bytes", "bool"], [checkAddress(recipient, "recipient"), amountIn, amountOutMin, path, !!payerIsUser]);
  }

  /**
   * Token -> [V3 pool, v3Fee] -> ALP -> [V4 ALP pool] -> out in one execute(): command 0x00 sells
   * amountIn of tokenIn for ALP into the router (ADDRESS_THIS, payer = caller through Permit2), then
   * command 0x10 SETTLEs the router's whole ALP balance (CONTRACT_BALANCE, payerIsUser false), swaps
   * it (amountIn OPEN_DELTA) on the ALP pool and TAKEs the output to recipient. amountOutMinimum
   * guards the final leg. The alpPoolKey MUST come from decodePoolKey (poolKeys on chain).
   */
  function buildBridgeRouteCalldata(options) {
    var recipient = checkAddress(options.recipient, "recipient");
    if (same(recipient, NATIVE)) fail("recipient is the zero address");
    var tokenIn = checkAddress(options.tokenIn, "tokenIn");
    if (same(tokenIn, ALP)) fail("tokenIn is ALP: use buildV4ExactInCalldata");
    var key = checkPoolKey(options.alpPoolKey);
    if (!same(key.currency0, ALP) && !same(key.currency1, ALP)) fail("not an ALP pool");
    var amountIn = toUint128(options.amountIn, "amountIn");
    if (amountIn.isZero()) fail("amountIn 0 is OPEN_DELTA");
    var minOut = toUint128(options.amountOutMinimum || 0, "amountOutMinimum");
    var zeroForOne = same(key.currency0, ALP);
    var out = zeroForOne ? key.currency1 : key.currency0;
    var v3Input = encodeV3ExactIn(ADDRESS_THIS, amountIn, 0, encodeV3Path(tokenIn, options.v3Fee, ALP), true);
    var v4Input = encodeV4SwapInput("0x" + ACTION_SETTLE + ACTION_SWAP_EXACT_IN_SINGLE + ACTION_TAKE, [
      encodeSettle(ALP, CONTRACT_BALANCE, false),
      encodeExactInputSingle({ poolKey: key, zeroForOne: zeroForOne, amountIn: OPEN_DELTA, amountOutMinimum: minOut, hookData: "0x" }),
      encodeTake(out, recipient, OPEN_DELTA),
    ]);
    var data = encodeExecute("0x" + COMMAND_V3_SWAP_EXACT_IN + COMMAND_V4_SWAP, [v3Input, v4Input], BigNumber.from(options.deadline));
    return { to: UNIVERSAL_ROUTER, data: data, value: BigNumber.from(0), chainId: CHAIN_ID, zeroForOne: zeroForOne, currencyOut: out };
  }

  // ---------------------------------------------------------------- the reader

  /**
   * createAlpV4Reader({ request, batchRequest, onUpdate, pools }). start() polls every 30 s; readOnce()
   * reads once; stop() cancels. A failing read marks its row "error" and keeps the last good values;
   * nothing throws out of a poll. One JSON-RPC batch of READS_PER_POOL * pools calls per poll.
   */
  function createAlpV4Reader(options) {
    if (!options || typeof options.batchRequest !== "function") fail("batchRequest is required");
    var chain = options.chain || CHAINS[8453];
    if (!chain || !READS_PER_POOL[chain.backend]) fail("chain config with backend stateView or extsload is required");
    var reads = READS_PER_POOL[chain.backend];
    var pools = (options.pools || POOLS).map(function (pool) {
      return { name: pool.name, poolId: checkPoolId(pool.poolId), key: pool.key ? verifyPoolKey(pool.poolId, pool.key) : null };
    });
    var onUpdate = typeof options.onUpdate === "function" ? options.onUpdate : function () {};
    var state = { chainId: chain.chainId, chainName: chain.name, backend: chain.backend, rows: pools.map(emptyRow), lastPoll: null, lastError: null, polls: 0, errors: 0, polling: false };
    var timer = null;
    var generation = 0;

    function emptyRow(pool) {
      return { name: pool.name, poolId: pool.poolId, key: pool.key, sqrtPriceX96: null, tick: null, liquidity: null, lpFee: null, protocolFee: null, price: null, status: STATUS_NO_KEY, error: null };
    }

    function getState() { return JSON.parse(JSON.stringify(state, function (k, v) { return v && v._isBigNumber ? v.toString() : v; })); }

    function applyRow(row, results, known) {
      var fresh = { error: null };
      try {
        results.forEach(function (r) { if (r && r.error) throw r.error instanceof Error ? r.error : new Error(String(r.error.message || r.error)); });
        var key, slot0, liquidity;
        if (chain.backend === "extsload") {
          // No poolKeys map on this PoolManager: the known key, verified against the poolId at construction.
          key = known;
          if (!key) { row.status = STATUS_NO_KEY; row.error = "no verified PoolKey for this pool"; return row.error; }
          slot0 = decodeSlot0Word(results[0]);
          liquidity = decodeLiquidityWord(results[1]);
        } else {
          key = decodePoolKey(row.poolId, results[0]);
          if (!key) { row.status = STATUS_NO_KEY; row.error = null; return; }
          slot0 = decodeSlot0(results[1]);
          liquidity = decodeLiquidity(results[2]);
        }
        row.key = key;
        row.sqrtPriceX96 = slot0.sqrtPriceX96.toString();
        row.tick = slot0.tick;
        row.lpFee = slot0.lpFee;
        row.protocolFee = slot0.protocolFee;
        row.liquidity = liquidity.toString();
        row.price = sqrtPriceToPrice(slot0.sqrtPriceX96);
        row.status = slot0.sqrtPriceX96.isZero() ? STATUS_NOT_INITIALIZED : STATUS_OK;
        row.error = null;
      } catch (error) {
        row.status = STATUS_ERROR;
        row.error = error.message;
        fresh.error = error.message;
      }
      return fresh.error;
    }

    async function runOnce(gen, schedule) {
      var calls = [];
      pools.forEach(function (pool) { calls.push.apply(calls, poolReadCalls(pool.poolId, chain)); });
      var results;
      try {
        results = await options.batchRequest(calls);
        if (!Array.isArray(results) || results.length !== calls.length) throw new Error("batch returned " + (results ? results.length : "no") + " results for " + calls.length + " calls");
        state.lastError = null;
      } catch (error) {
        if (gen !== generation) return;
        state.lastError = error.message;
        state.errors++;
        state.rows.forEach(function (row) { row.status = STATUS_ERROR; row.error = error.message; });
      }
      if (gen !== generation) return;
      if (results) {
        var rowErrors = 0;
        state.rows.forEach(function (row, i) { if (applyRow(row, results.slice(i * reads, (i + 1) * reads), pools[i].key)) rowErrors++; });
        if (rowErrors) state.errors++;
        state.lastPoll = Date.now();
      }
      state.polls++;
      onUpdate(getState());
      if (schedule && gen === generation) timer = setTimeout(function alpPoll() { runOnce(gen, true); }, POLL_INTERVAL_MS);
    }

    function stop() { generation++; if (timer) { clearTimeout(timer); timer = null; } state.polling = false; }

    function begin(schedule) {
      stop();
      state.polling = schedule;
      return runOnce(generation, schedule);
    }

    return {
      start: function () { return begin(true); },
      readOnce: function () { return begin(false); },
      stop: stop,
      getState: getState,
      pools: pools,
    };
  }

  return {
    CHAIN_ID: CHAIN_ID,
    RPC_URL: RPC_URL,
    POOL_MANAGER: POOL_MANAGER,
    STATE_VIEW: STATE_VIEW,
    UNIVERSAL_ROUTER: UNIVERSAL_ROUTER,
    POSITION_MANAGER: POSITION_MANAGER,
    ALP: ALP,
    USDG: USDG,
    NATIVE: NATIVE,
    ALP_POOL_FEE: ALP_POOL_FEE,
    ALP_ETH_KEY: ALP_ETH_KEY,
    ALP_USDG_KEY: ALP_USDG_KEY,
    POOLS: POOLS,
    CHAINS: CHAINS,
    POOLS_SLOT: POOLS_SLOT,
    LIQUIDITY_OFFSET: LIQUIDITY_OFFSET,
    POLL_INTERVAL_MS: POLL_INTERVAL_MS,
    READS_PER_POOL: READS_PER_POOL,
    slot0StorageSlot: slot0StorageSlot,
    liquidityStorageSlot: liquidityStorageSlot,
    encodeExtsloadCall: encodeExtsloadCall,
    verifyPoolKey: verifyPoolKey,
    decodeSlot0Word: decodeSlot0Word,
    decodeLiquidityWord: decodeLiquidityWord,
    STATUS_OK: STATUS_OK,
    STATUS_NOT_INITIALIZED: STATUS_NOT_INITIALIZED,
    STATUS_NO_KEY: STATUS_NO_KEY,
    STATUS_ERROR: STATUS_ERROR,
    EXECUTE_SELECTOR: EXECUTE_SELECTOR,
    COMMAND_V3_SWAP_EXACT_IN: COMMAND_V3_SWAP_EXACT_IN,
    COMMAND_V4_SWAP: COMMAND_V4_SWAP,
    ACTION_SWAP_EXACT_IN_SINGLE: ACTION_SWAP_EXACT_IN_SINGLE,
    ACTION_SWAP_EXACT_IN: ACTION_SWAP_EXACT_IN,
    ACTION_SETTLE: ACTION_SETTLE,
    ACTION_SETTLE_ALL: ACTION_SETTLE_ALL,
    ACTION_TAKE: ACTION_TAKE,
    ACTION_TAKE_ALL: ACTION_TAKE_ALL,
    OPEN_DELTA: OPEN_DELTA,
    CONTRACT_BALANCE: CONTRACT_BALANCE,
    MSG_SENDER: MSG_SENDER,
    ADDRESS_THIS: ADDRESS_THIS,
    V3_FEES: V3_FEES,
    POOL_KEY_TYPE: POOL_KEY_TYPE,
    PATH_KEY_TYPE: PATH_KEY_TYPE,
    EXACT_IN_TYPE: EXACT_IN_TYPE,
    EXACT_IN_SINGLE_TYPE: EXACT_IN_SINGLE_TYPE,
    poolIdOf: poolIdOf,
    toPoolKeysId: toPoolKeysId,
    encodePoolKeysCall: encodePoolKeysCall,
    encodeGetSlot0Call: encodeGetSlot0Call,
    encodeGetLiquidityCall: encodeGetLiquidityCall,
    poolReadCalls: poolReadCalls,
    decodePoolKey: decodePoolKey,
    decodeSlot0: decodeSlot0,
    decodeLiquidity: decodeLiquidity,
    sqrtPriceToPrice: sqrtPriceToPrice,
    priceE18: priceE18,
    spotQuote: spotQuote,
    formatFeePercent: formatFeePercent,
    totalFee: totalFee,
    describeRoute: describeRoute,
    involvesAlp: involvesAlp,
    routeFor: routeFor,
    pathKeyFor: pathKeyFor,
    encodeExactInput: encodeExactInput,
    encodeExactInputSingle: encodeExactInputSingle,
    encodeSettle: encodeSettle,
    encodeSettleAll: encodeSettleAll,
    encodeTake: encodeTake,
    encodeTakeAll: encodeTakeAll,
    encodeV4SwapInput: encodeV4SwapInput,
    encodeExecute: encodeExecute,
    buildV4ExactInCalldata: buildV4ExactInCalldata,
    encodeV3Path: encodeV3Path,
    encodeV3ExactIn: encodeV3ExactIn,
    buildBridgeRouteCalldata: buildBridgeRouteCalldata,
    createAlpV4Reader: createAlpV4Reader,
  };
});
