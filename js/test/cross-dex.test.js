"use strict";

// Job 9: the cross-DEX price + LP depth reader, offline against a fake chain. Nothing leaves the process.
const { test, mock } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const X = require("../cross-dex-reader.js");
const abi = ethers.utils.defaultAbiCoder;
const lower = (a) => a.toLowerCase();

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const SUSHI = X.DEXES[0];
const RAMSES = X.DEXES[1];
const GET_POOL_FEE = "0x1698ee82";
const GET_POOL_TS = "0x28af8d0b";
const SLOT0 = "0x3850c7bd";
const LIQUIDITY = "0x1a686502";
const FEE = "0xddca3f43";

// Live replies of 2026-11-10 (block 0x69da8ae): the SushiSwap 0.05% WETH/USDG pool.
const LIVE_SUSHI_500 = "0x9B050cb1F265094b0977160a2BD7dA8C9E529c3C";
const LIVE_SLOT0 = "0x00000000000000000000000000000000000000000002f0b22559d9a5e0000000" +
  "fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffcf1c8" +
  "000000000000000000000000000000000000000000000000000000000000001a" +
  "0000000000000000000000000000000000000000000000000000000000000040" +
  "0000000000000000000000000000000000000000000000000000000000000040" +
  "0000000000000000000000000000000000000000000000000000000000000044" +
  "0000000000000000000000000000000000000000000000000000000000000001";
const LIVE_LIQUIDITY = "0x00000000000000000000000000000000000000000000000001e58d3c397a1133";

/** A fake chain: factories keyed by fee or tick spacing, pools answering slot0/liquidity/fee. */
class FakeChain {
  constructor() {
    this.factories = new Map(); // lower(factory) → { type, pools: Map(tier → address) , revert: bool }
    this.pools = new Map(); // lower(address) → { sqrtPriceX96, tick, liquidity, fee, fail: Set }
    this.calls = [];
    this.transportFailures = 0;
    this.request = this.request.bind(this);
    this.batchRequest = this.batchRequest.bind(this);
  }
  factory(dex, revert = false) { this.factories.set(lower(dex.factory), { type: dex.type, pools: new Map(), revert }); return this; }
  pool(dex, tier, address, { tick = -200248, sqrtPriceX96 = null, liquidity = 1000, fee = null } = {}) {
    this.factories.get(lower(dex.factory)).pools.set(tier, address);
    const sqrt = sqrtPriceX96 === null ? ethers.BigNumber.from(Math.round(Math.sqrt(Math.pow(1.0001, tick)) * 1e9)).mul(ethers.BigNumber.from(2).pow(96)).div(1e9) : ethers.BigNumber.from(sqrtPriceX96);
    this.pools.set(lower(address), { sqrtPriceX96: sqrt, tick, liquidity: ethers.BigNumber.from(liquidity), fee: fee === null ? (dex.type === "v3" ? tier : 500) : fee, fail: new Set() });
    return this;
  }
  handle(method, params) {
    this.calls.push({ method, params });
    if (method !== "eth_call") throw new Error("unsupported method " + method);
    const { to, data } = params[0];
    const selector = data.slice(0, 10);
    const factory = this.factories.get(lower(to));
    if (factory) {
      if (factory.revert) throw new Error("execution reverted");
      const expected = factory.type === "v3" ? GET_POOL_FEE : GET_POOL_TS;
      if (selector !== expected) throw new Error("execution reverted"); // the other key is not in the runtime
      const [a, b, tier] = abi.decode(["address", "address", factory.type === "v3" ? "uint24" : "int24"], "0x" + data.slice(10));
      assert.ok(BigInt(a) < BigInt(b), "getPool is asked with sorted tokens");
      this.lastPair = [a, b];
      return abi.encode(["address"], [factory.pools.get(Number(tier)) || ethers.constants.AddressZero]);
    }
    const pool = this.pools.get(lower(to));
    if (!pool) throw new Error("execution reverted");
    if (selector === SLOT0) {
      if (pool.fail.has("slot0")) throw new Error("slot0 unavailable");
      return abi.encode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [pool.sqrtPriceX96, pool.tick, 1, 1, 1, 0, true]);
    }
    if (selector === LIQUIDITY) {
      if (pool.fail.has("liquidity")) throw new Error("liquidity unavailable");
      return abi.encode(["uint128"], [pool.liquidity]);
    }
    if (selector === FEE) return abi.encode(["uint24"], [pool.fee]);
    throw new Error("execution reverted");
  }
  async request(method, params) {
    if (this.transportFailures > 0) { this.transportFailures--; throw new Error("RPC HTTP error 503"); }
    return this.handle(method, params);
  }
  async batchRequest(calls) {
    this.batches = (this.batches || 0) + 1;
    if (this.transportFailures > 0) { this.transportFailures--; throw new Error("RPC HTTP error 503"); }
    return calls.map((call) => { try { return this.handle(call.method, call.params); } catch (error) { return { error }; } });
  }
}

/** Both DEXes with the live WETH/USDG pools: Sushi 0.05% and 0.30%; Ramses ts 1, 5, 10 (empty) and 50. */
function liveLikeChain() {
  const chain = new FakeChain().factory(SUSHI).factory(RAMSES);
  chain.pool(SUSHI, 500, LIVE_SUSHI_500, { tick: -200248, liquidity: "136685678349013299" });
  chain.pool(SUSHI, 3000, "0xC5A01C57b2851202dCF8507a0F2Bd08a8025E2C8", { tick: -200238, liquidity: "116246907180892" });
  chain.pool(RAMSES, 1, "0xFAE65eAa11943f45E83D5B45DC7A7C801C51bfB0", { tick: -200224, liquidity: "10967690613222303", fee: 1000 });
  chain.pool(RAMSES, 5, "0x584Eb229d4130f68D8d323E8E1E787BE47260D70", { tick: -199811, liquidity: "26457004467", fee: 500 });
  chain.pool(RAMSES, 10, "0x028779cA5D91C7F016ACB98E0AfA5102F4e436e4", { tick: -197681, liquidity: 0, fee: 500 });
  chain.pool(RAMSES, 50, "0x288Eb58ee0F0E9378dEC1e8Fa51c389644c24685", { tick: -199927, liquidity: "78583258289", fee: 3000 });
  return chain;
}

const uniPool = (fee, tick, liquidity, extra = {}) => ({ protocol: "V3", fee, tick, price: Math.pow(1.0001, tick), liquidity: ethers.BigNumber.from(liquidity),
  currency0: WETH, currency1: USDG, status: "OK", ...extra });

// ------------------------------------------------------------------ configuration and pure helpers

test("DEXES is the brief's array: SushiSwap V3 fee-keyed over 100/500/3000; Ramses read as a CL factory over its enabled tick spacings", () => {
  assert.equal(X.DEXES.length, 2);
  assert.deepEqual(SUSHI, { name: "SushiSwap V3", type: "v3", factory: "0xE51960f1B45f1C9FB6D166E6a884F866fC70433B", fees: [100, 500, 3000] });
  assert.equal(RAMSES.name, "Ramses V3");
  assert.equal(RAMSES.factory, "0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8");
  assert.equal(RAMSES.type, "cl", "the deployed factory is tick-spacing keyed; fee-keyed getPool reverts (live, docs/cross-dex-live.json)");
  assert.deepEqual(RAMSES.tickSpacings, [1, 5, 10, 50, 100, 200, 500]);
  assert.equal(X.POLL_INTERVAL_MS, 30000, "same cadence as the existing monitor");
  assert.equal(X.CHAIN_ID, 4663);
  assert.deepEqual([X.STATUS_OK, X.STATUS_NO_POOL, X.STATUS_ERROR], ["OK", "no pool", "error"]);
});

test("sortTokens orders by BigInt and rejects zero, equal and malformed addresses", () => {
  assert.deepEqual(X.sortTokens(WETH, USDG), { token0: WETH, token1: USDG });
  assert.deepEqual(X.sortTokens(USDG, WETH), { token0: WETH, token1: USDG });
  assert.deepEqual(X.sortTokens(" " + lower(PONS) + " ", USDG), { token0: PONS, token1: USDG }, "trimmed and checksummed");
  assert.throws(() => X.sortTokens(WETH, WETH), /must be different/);
  assert.throws(() => X.sortTokens(WETH, ethers.constants.AddressZero), /enter ERC20 token addresses/);
  assert.throws(() => X.sortTokens("", USDG), /both token addresses are required/);
  assert.throws(() => X.sortTokens("0x1234", USDG), /invalid address/);
});

test("tickToPrice is 1.0001^tick, the same math as the V3 reads, within the tick range", () => {
  assert.equal(X.tickToPrice(0), 1);
  assert.equal(X.tickToPrice(1), 1.0001);
  assert.ok(Math.abs(X.tickToPrice(-200248) * 1e12 - 2012.68) < 0.01, "2012.68 USDG per WETH after 18-6 decimals");
  assert.equal(X.tickToPrice(X.MIN_TICK), Math.pow(1.0001, -887272));
  assert.throws(() => X.tickToPrice(887273), /tick out of range/);
  assert.throws(() => X.tickToPrice(1.5), /tick out of range/);
  assert.throws(() => X.tickToPrice("x"), /tick out of range/);
});

test("formatting: fee as a percentage, liquidity with separators, spread signed to two decimals or a dash", () => {
  assert.equal(X.formatFee(100), "0.01%");
  assert.equal(X.formatFee(500), "0.05%");
  assert.equal(X.formatFee(3000), "0.30%");
  assert.equal(X.formatFee(1000), "0.10%");
  assert.equal(X.formatFee(null), "—");
  assert.throws(() => X.formatFee(-1), /invalid fee/);
  assert.equal(X.formatLiquidity(12410), "12,410");
  assert.equal(X.formatLiquidity("8200"), "8,200");
  assert.equal(X.formatLiquidity(0), "0");
  assert.equal(X.formatLiquidity(ethers.BigNumber.from("136685678349013299")), "136,685,678,349,013,299");
  assert.equal(X.formatLiquidity(null), "—");
  assert.equal(X.formatSpread(0.05), "+0.05%");
  assert.equal(X.formatSpread(-0.1099), "-0.11%");
  assert.equal(X.formatSpread(0), "0.00%");
  assert.equal(X.formatSpread(-0.001), "0.00%", "no negative zero");
  assert.equal(X.formatSpread(null), "—");
  assert.equal(X.formatSpread(NaN), "—");
});

test("spreadVsUni is (DEX − Uni) / Uni × 100 and null without a reference or a price", () => {
  assert.equal(X.spreadVsUni(0.1542, 0.1542), 0);
  assert.ok(Math.abs(X.spreadVsUni(0.1542, 0.15412) - 0.0519) < 0.001);
  assert.equal(X.spreadVsUni(2, 1), 100);
  assert.equal(X.spreadVsUni(1, 2), -50);
  assert.equal(X.spreadVsUni(1, null), null, "no Uni pool: the column shows —");
  assert.equal(X.spreadVsUni(null, 1), null, "no DEX price");
  assert.equal(X.spreadVsUni(1, 0), null);
  assert.equal(X.spreadVsUni(1, undefined), null);
});

test("bestUniPool is the deepest priced, tradeable Uniswap V3 pool of the pair; V4, EMPTY, unpriced and other pairs are ignored", () => {
  const pools = [
    uniPool(100, -200235, "0x453851b6c173986"),
    uniPool(500, -200237, "0x47c91b14a554962"),
    uniPool(3000, -200264, "0xd4bf29c4b96d7b"),
    uniPool(10000, -200191, "0x10978a73bd9357"),
    { protocol: "V4", fee: 3000, tickSpacing: 60, price: 5, liquidity: ethers.BigNumber.from(10).pow(30), currency0: WETH, currency1: USDG, status: "OK" },
    uniPool(500, -1, "0xffffffffffffffffffff", { currency1: PONS }), // another pair
    uniPool(500, -2, "0xffffffffffffffffffff", { status: "STALE" }),
    uniPool(500, -3, 0), // EMPTY
    { protocol: "V3", fee: 500, price: null, liquidity: ethers.BigNumber.from(1), currency0: WETH, currency1: USDG, status: "OK" },
  ];
  const pair = { token0: WETH, token1: USDG };
  const best = X.bestUniPool(pools, pair);
  assert.equal(best.pool.fee, 500, "the 0.05% pool holds the most liquidity");
  assert.equal(best.price, Math.pow(1.0001, -200237));
  assert.equal(X.bestUniPrice(pools, pair), best.price);
  assert.equal(X.bestUniPool(pools, { token0: PONS, token1: USDG }), null, "no pool of that pair");
  assert.equal(X.bestUniPool([], pair), null);
  assert.equal(X.bestUniPool(null, pair), null);
  assert.equal(X.bestUniPool(pools.slice(4), pair), null, "V4, other pair, STALE, EMPTY and unpriced never qualify");
  // Without liquidity figures (status undefined too) the first priced pool is the reference.
  const bare = [{ protocol: "V3", fee: 3000, price: 3, currency0: WETH, currency1: USDG }, { protocol: "V3", fee: 500, price: 2, currency0: WETH, currency1: USDG }];
  assert.equal(X.bestUniPool(bare, pair).pool.fee, 3000);
  assert.equal(X.bestUniPool(bare, null).pool.fee, 3000, "without a pair every V3 pool counts");
});

// ------------------------------------------------------------------ payloads and decoding

test("discoveryCalls: fee-keyed getPool for v3, tick-spacing-keyed for cl, sorted tokens, configuration order; the exact live calldata", () => {
  const pair = X.sortTokens(USDG, WETH);
  const sushi = X.discoveryCalls(SUSHI, pair);
  assert.deepEqual(sushi.map((c) => [c.dex, c.type, c.tier, c.fee, c.tickSpacing, c.method, c.params[1]]),
    [["SushiSwap V3", "v3", 100, 100, null, "eth_call", "latest"], ["SushiSwap V3", "v3", 500, 500, null, "eth_call", "latest"], ["SushiSwap V3", "v3", 3000, 3000, null, "eth_call", "latest"]]);
  assert.ok(sushi.every((c) => c.params[0].to === SUSHI.factory));
  assert.equal(sushi[1].params[0].data, GET_POOL_FEE + "0000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73" +
    "0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168" + "00000000000000000000000000000000000000000000000000000000000001f4",
    "the bytes sent live to the SushiSwap factory");
  const ramses = X.discoveryCalls(RAMSES, pair);
  assert.deepEqual(ramses.map((c) => c.tickSpacing), [1, 5, 10, 50, 100, 200, 500]);
  assert.ok(ramses.every((c) => c.fee === null && c.type === "cl" && c.params[0].to === RAMSES.factory && c.params[0].data.startsWith(GET_POOL_TS)));
  assert.equal(abi.decode(["address", "address", "int24"], "0x" + ramses[0].params[0].data.slice(10))[2], 1);
  assert.throws(() => X.discoveryCalls({ name: "x", type: "v2", factory: SUSHI.factory, fees: [1] }, pair), /type must be v3 or cl/);
  assert.throws(() => X.discoveryCalls({ name: "x", type: "v3", factory: SUSHI.factory, fees: [] }, pair), /fees must be a non-empty array/);
  assert.throws(() => X.discoveryCalls({ name: "x", type: "cl", factory: SUSHI.factory }, pair), /tickSpacings must be a non-empty array/);
  assert.throws(() => X.discoveryCalls({ name: "x", type: "v3", factory: "0x12", fees: [500] }, pair), /invalid address/);
});

test("decodePoolAddress returns null for the zero address and the pool otherwise; short replies throw", () => {
  assert.equal(X.decodePoolAddress(abi.encode(["address"], [ethers.constants.AddressZero])), null);
  assert.equal(X.decodePoolAddress("0x0000000000000000000000009b050cb1f265094b0977160a2bd7da8c9e529c3c"), LIVE_SUSHI_500);
  assert.throws(() => X.decodePoolAddress("0x"), /not a 32-byte word/);
  assert.throws(() => X.decodePoolAddress("0x1234"), /not a 32-byte word/);
  assert.throws(() => X.decodePoolAddress(null), /not a 32-byte word/);
});

test("poolReadCalls: slot0 and liquidity for every pool, plus fee() for CL pools; the live replies decode", () => {
  const v3 = X.poolReadCalls(SUSHI, lower(LIVE_SUSHI_500));
  assert.deepEqual(v3.map((c) => [c.name, c.params[0].to, c.params[0].data, c.params[1]]),
    [["slot0", LIVE_SUSHI_500, SLOT0, "latest"], ["liquidity", LIVE_SUSHI_500, LIQUIDITY, "latest"]]);
  const cl = X.poolReadCalls(RAMSES, "0xFAE65eAa11943f45E83D5B45DC7A7C801C51bfB0");
  assert.deepEqual(cl.map((c) => c.name), ["slot0", "liquidity", "fee"]);
  assert.equal(cl[2].params[0].data, FEE);
  const slot0 = X.decodeSlot0(LIVE_SLOT0);
  assert.equal(slot0.tick, -200248);
  assert.equal(slot0.sqrtPriceX96.toString(), "3554505806984652282396672");
  assert.equal(X.decodeLiquidity(LIVE_LIQUIDITY).toString(), ethers.BigNumber.from("0x01e58d3c397a1133").toString());
  assert.equal(X.decodeSlot0(abi.encode(["uint160", "int24", "uint24", "uint24", "uint8", "bool"], [1, -5, 0, 0, 0, true])).tick, -5, "six-word layout");
  assert.equal(X.decodeFee(abi.encode(["uint24"], [1000])), 1000);
  assert.throws(() => X.decodeSlot0(abi.encode(["uint256"], [1])), /too short/);
  assert.throws(() => X.decodeLiquidity("0x"), /not a 32-byte word/);
  assert.throws(() => X.decodeLiquidity(abi.encode(["uint256"], [ethers.BigNumber.from(2).pow(128)])), /does not fit uint128/);
  assert.throws(() => X.decodeFee("0xdeadbeef"), /not a 32-byte word/);
});

// ------------------------------------------------------------------ the reader

test("one read of the live-like pair: one row per pool, DEX then tier order, OK status, 1.0001^tick, raw liquidity, CL fee from the pool; nothing else requested", async () => {
  const chain = liveLikeChain();
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await reader.readOnce(USDG, WETH);
  const state = reader.getState();
  assert.deepEqual(state.pair, { token0: WETH, token1: USDG });
  assert.equal(state.lastError, null);
  assert.equal(state.errors, 0);
  assert.equal(state.polls, 1);
  assert.ok(state.lastPoll > 0);
  assert.deepEqual(state.rows.map((r) => [r.dex, r.tier, r.fee, r.status]), [
    ["SushiSwap V3", 500, 500, "OK"], ["SushiSwap V3", 3000, 3000, "OK"],
    ["Ramses V3", 1, 1000, "OK"], ["Ramses V3", 5, 500, "OK"], ["Ramses V3", 10, 500, "OK"], ["Ramses V3", 50, 3000, "OK"]]);
  const sushi = state.rows[0];
  assert.equal(sushi.address, LIVE_SUSHI_500);
  assert.equal(sushi.tick, -200248);
  assert.equal(sushi.price, Math.pow(1.0001, -200248));
  assert.equal(sushi.liquidity, "136685678349013299", "raw liquidity(), no $ conversion");
  assert.equal(sushi.tickSpacing, null);
  assert.equal(X.formatLiquidity(sushi.liquidity), "136,685,678,349,013,299");
  const ramses1 = state.rows[2];
  assert.equal(ramses1.fee, 1000, "the pool's current fee(), not the initial one");
  assert.equal(ramses1.tickSpacing, 1);
  assert.equal(state.rows[4].liquidity, "0", "an empty pool is still priced and shown with liquidity 0");
  assert.equal(state.rows[4].status, "OK");
  // 3 + 7 getPool calls in one batch, then 2 × 2 + 4 × 3 pool reads in a second batch.
  assert.equal(chain.batches, 2);
  assert.equal(chain.calls.length, 10 + 16);
  assert.ok(chain.calls.every((c) => c.method === "eth_call"), "eth_call only: nothing sent, nothing signed");
  assert.deepEqual(chain.lastPair, [WETH, USDG], "always asked with the sorted pair");
});

test("both DEXes without pools: an empty table, no error", async () => {
  const chain = new FakeChain().factory(SUSHI).factory(RAMSES);
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await reader.readOnce(PONS, USDG);
  const state = reader.getState();
  assert.deepEqual(state.rows, []);
  assert.equal(state.lastError, null);
  assert.equal(state.errors, 0);
  assert.equal(state.polls, 1);
  assert.equal(chain.calls.length, 10, "no pool reads follow");
});

test("a factory that reverts (fee-keyed getPool on the Ramses CL factory) gives that DEX one visible error row; the other DEX is unaffected", async () => {
  const chain = liveLikeChain();
  // The brief's literal configuration for Ramses: type v3 with fees. The deployed factory reverts on it.
  const dexes = [SUSHI, { name: "Ramses V3", type: "v3", factory: RAMSES.factory, fees: [100, 500, 3000] }];
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest, dexes });
  await reader.readOnce(WETH, USDG);
  const state = reader.getState();
  assert.deepEqual(state.rows.map((r) => [r.dex, r.tier, r.status]), [["SushiSwap V3", 500, "OK"], ["SushiSwap V3", 3000, "OK"], ["Ramses V3", null, "error"]]);
  assert.match(state.rows[2].error, /execution reverted/);
  assert.equal(state.rows[2].price, null);
  assert.equal(state.lastError, null, "a DEX-level error is shown in its row, not as a poll error");
  assert.equal(state.errors, 1);
});

test("a failed pool read marks only that row 'error' and keeps its last good price and liquidity; it recovers on the next read", async () => {
  const chain = liveLikeChain();
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await reader.readOnce(WETH, USDG);
  chain.pools.get(lower(LIVE_SUSHI_500)).fail.add("slot0");
  await reader.poll();
  let state = reader.getState();
  assert.equal(state.rows[0].status, "error");
  assert.match(state.rows[0].error, /slot0 unavailable/);
  assert.equal(state.rows[0].price, Math.pow(1.0001, -200248), "last good price kept");
  assert.equal(state.rows[0].liquidity, "136685678349013299", "last good liquidity kept");
  assert.equal(state.rows[1].status, "OK", "the sibling row is untouched");
  assert.equal(state.rows.length, 6);
  assert.equal(state.errors, 1);
  assert.equal(state.polls, 2);
  // A read that fails before any good data shows error with empty values.
  chain.pools.get("0x288eb58ee0f0e9378dec1e8fa51c389644c24685").fail.add("liquidity");
  const fresh = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await fresh.readOnce(WETH, USDG);
  const row = fresh.getState().rows[5];
  assert.equal(row.status, "error");
  assert.equal(row.price, null);
  assert.equal(row.liquidity, null);
  // Recovery.
  chain.pools.get(lower(LIVE_SUSHI_500)).fail.clear();
  chain.pools.get(lower(LIVE_SUSHI_500)).tick = -200200;
  await reader.poll();
  state = reader.getState();
  assert.equal(state.rows[0].status, "OK");
  assert.equal(state.rows[0].error, null);
  assert.equal(state.rows[0].tick, -200200);
});

test("a transport failure keeps every row with its data, marks them 'error' and sets lastError; the next good read clears it", async () => {
  const chain = liveLikeChain();
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await reader.readOnce(WETH, USDG);
  chain.transportFailures = 1;
  await reader.poll();
  let state = reader.getState();
  assert.equal(state.rows.length, 6, "nothing dropped");
  assert.ok(state.rows.every((r) => r.status === "error" && r.price !== null));
  assert.match(state.lastError, /RPC HTTP error 503/);
  assert.equal(state.errors, 1);
  assert.equal(state.polls, 2);
  // A transport failure on the pool reads (second batch) behaves the same for the rows found.
  chain.transportFailures = 0;
  await reader.poll();
  state = reader.getState();
  assert.equal(state.lastError, null);
  assert.ok(state.rows.every((r) => r.status === "OK"));
  // Before any data: a transport failure shows one error row per DEX so the failure is visible.
  const cold = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  chain.transportFailures = 1;
  await cold.readOnce(WETH, USDG);
  assert.deepEqual(cold.getState().rows.map((r) => [r.dex, r.tier, r.status]), [["SushiSwap V3", null, "error"], ["Ramses V3", null, "error"]]);
  assert.match(cold.getState().lastError, /503/);
});

test("an uninitialised pool (sqrtPriceX96 = 0) shows 'no pool' without a price; a pool that vanishes keeps its row as 'no pool'", async () => {
  const chain = new FakeChain().factory(SUSHI).factory(RAMSES);
  chain.pool(SUSHI, 100, "0x1111111111111111111111111111111111111111", { sqrtPriceX96: 0, liquidity: 0 });
  chain.pool(SUSHI, 500, LIVE_SUSHI_500, { tick: -200248, liquidity: 5 });
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await reader.readOnce(WETH, USDG);
  let rows = reader.getState().rows;
  assert.deepEqual(rows.map((r) => [r.tier, r.status, r.price, r.liquidity]), [[100, "no pool", null, "0"], [500, "OK", Math.pow(1.0001, -200248), "5"]]);
  chain.factories.get(lower(SUSHI.factory)).pools.delete(500);
  await reader.poll();
  rows = reader.getState().rows;
  assert.deepEqual(rows.map((r) => [r.tier, r.status]), [[100, "no pool"], [500, "no pool"]]);
  assert.equal(rows[1].price, Math.pow(1.0001, -200248), "the last price stays visible for the record");
  assert.equal(reader.getState().lastError, null);
});

test("start polls every 30 s with the configured timer, readOnce never schedules, stop cancels and discards a read in flight", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const chain = liveLikeChain();
    const updates = [];
    const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest, onUpdate: (s) => updates.push(s.polls) });
    await reader.start(WETH, USDG);
    assert.equal(reader.getState().polls, 1);
    assert.deepEqual(updates, [1]);
    mock.timers.tick(29999);
    await new Promise((r) => setImmediate(r));
    assert.equal(reader.getState().polls, 1);
    mock.timers.tick(1);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(reader.getState().polls, 2, "polled again after 30 s");
    assert.deepEqual(updates, [1, 2]);
    reader.stop();
    mock.timers.tick(60000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(reader.getState().polls, 2, "stopped");
    // readOnce: no timer.
    const once = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest, pollIntervalMs: 1000 });
    await once.readOnce(WETH, USDG);
    mock.timers.tick(5000);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    assert.equal(once.getState().polls, 1);
    // A read in flight when stop() is called never lands.
    let release;
    const gate = new Promise((r) => { release = r; });
    const slow = X.createCrossDexReader({ batchRequest: async (calls) => { await gate; return chain.batchRequest(calls); } });
    const pending = slow.start(WETH, USDG);
    slow.stop();
    release();
    await pending;
    assert.deepEqual(slow.getState().rows, []);
    assert.equal(slow.getState().polls, 0);
    assert.equal(slow.getState().polling, false);
  } finally {
    mock.timers.reset();
  }
});

test("without batchRequest the reader uses one request per call; a bad address throws synchronously before anything is requested", async () => {
  const chain = liveLikeChain();
  const reader = X.createCrossDexReader({ request: chain.request });
  await reader.readOnce(WETH, USDG);
  assert.equal(reader.getState().rows.length, 6);
  assert.equal(chain.batches, undefined);
  assert.equal(chain.calls.length, 26);
  const before = chain.calls.length;
  assert.throws(() => reader.start(WETH, WETH), /must be different/);
  assert.throws(() => reader.readOnce("0xnope", USDG), /invalid address/);
  assert.equal(chain.calls.length, before);
  assert.throws(() => X.createCrossDexReader({}), /request function is required/);
  assert.throws(() => X.createCrossDexReader({ request: chain.request, pollIntervalMs: 0 }), /pollIntervalMs must be positive/);
  assert.throws(() => X.createCrossDexReader({ request: chain.request, dexes: [{ name: "", type: "v3", factory: SUSHI.factory, fees: [1] }] }), /DEX needs a name/);
  const idle = X.createCrossDexReader({ request: chain.request });
  assert.throws(() => idle.poll(), /no pair/);
});

test("changing the pair restarts from an empty table and reads the new pair; getState returns copies", async () => {
  const chain = liveLikeChain();
  chain.pool(SUSHI, 100, "0x2222222222222222222222222222222222222222", { tick: 100, liquidity: 9 });
  const reader = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest });
  await reader.readOnce(WETH, USDG);
  const snapshot = reader.getState();
  snapshot.rows[0].status = "tampered";
  assert.equal(reader.getState().rows[0].status, "OK");
  assert.equal(reader.getState().rows.length, 7);
  // The fake factory answers the same pools for any pair; what matters is that the new pair is asked
  // and the table is rebuilt from that answer (the first update of a new pair starts from no rows).
  let firstRows = null;
  const watched = X.createCrossDexReader({ request: chain.request, batchRequest: chain.batchRequest, onUpdate: (s) => { if (firstRows === null) firstRows = s.rows.length; } });
  await watched.readOnce(WETH, USDG);
  assert.equal(firstRows, 7);
  chain.factories.get(lower(RAMSES.factory)).pools.clear();
  await reader.readOnce(PONS, USDG);
  assert.deepEqual(reader.getState().rows.map((r) => [r.dex, r.tier]), [["SushiSwap V3", 100], ["SushiSwap V3", 500], ["SushiSwap V3", 3000]]);
  assert.deepEqual(reader.getState().pair, { token0: PONS, token1: USDG });
  assert.deepEqual(chain.lastPair, [PONS, USDG]);
});
