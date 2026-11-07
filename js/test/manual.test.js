"use strict";

// Follow-up 5: Manual mode. Pure helpers, the pool reader and the manual monitor, offline.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { ManualMock, liveManualMock, pool, SELECTORS, WETH, PONS, USDG, LIVE_POOL_A, LIVE_POOL_B, LIVE_SLOT0_A, poolA, poolB } = require("./manual-mock.js");
const abi = ethers.utils.defaultAbiCoder;
const bn = ethers.BigNumber.from;
const lower = (a) => a.toLowerCase();
const OTHER_POOL = "0x0f5F5bCC08cAe61d19c9a2d2594C252f1Baddae6"; // the factory's real 0.01% WETH/PONS pool
const V4_POOL_ID = "0x" + "ab".repeat(32); // 66 characters: a V4 poolId, not a V3 pool address
const rpc = (p) => E.createRpcClient(E.RPC_URL, p.fetch).request;

function monitorFor(p, options = {}) {
  const timers = [];
  const monitor = E.createManualMonitor({ request: rpc(p), ...options });
  const realSetTimeout = global.setTimeout;
  const realClearTimeout = global.clearTimeout;
  // The monitor schedules through the global setTimeout; capture 30 s / 60 s timers instead of waiting.
  // The RPC client's 20 s abort timer stays real (and is cleared); only the poll / retry timers are captured.
  global.setTimeout = (fn, ms) => { if (ms >= 30000) { const timer = { fn, ms }; timers.push(timer); return timer; } return realSetTimeout(fn, ms); };
  global.clearTimeout = (timer) => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); else realClearTimeout(timer); };
  const restore = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; };
  return { monitor, timers, restore, fire: async () => { const due = timers.splice(0); for (const timer of due) await timer.fn(); } };
}

test("a pasted address must be exactly 0x + 40 hex digits; a 66-char V4 poolId is refused with the brief's message", () => {
  assert.equal(E.parseManualPoolAddress(LIVE_POOL_A), ethers.utils.getAddress(LIVE_POOL_A));
  assert.equal(E.parseManualPoolAddress("  " + LIVE_POOL_B.toUpperCase().replace("0X", "0x") + " "), ethers.utils.getAddress(LIVE_POOL_B));
  for (const bad of [V4_POOL_ID, LIVE_POOL_A.slice(0, 41), LIVE_POOL_A + "0", "10cc6bd38112cac182db90b6a71d8bb5939526ba", "", undefined, "0x" + "g".repeat(40), ethers.constants.AddressZero]) {
    assert.throws(() => E.parseManualPoolAddress(bad), new RegExp("^Error: " + E.MANUAL_ADDRESS_ERROR + "$"));
  }
  assert.throws(() => E.parseManualPoolAddress(V4_POOL_ID, "Pool B"), /^Error: Pool B: Enter a 42-char V3 pool address$/);
  assert.equal(E.MANUAL_ADDRESS_ERROR, "Enter a 42-char V3 pool address");
});

test("the four reads are token0, token1, fee and slot0 as plain eth_calls with the V3 selectors", () => {
  const calls = E.manualPoolCalls(LIVE_POOL_A);
  assert.equal(calls.length, 4);
  assert.deepEqual(E.MANUAL_READS, ["token0", "token1", "fee", "slot0"]);
  calls.forEach((call, i) => {
    assert.equal(call.method, "eth_call");
    assert.equal(call.params[0].to, ethers.utils.getAddress(LIVE_POOL_A));
    assert.equal(call.params[1], "latest");
    assert.equal(SELECTORS[call.params[0].data], E.MANUAL_READS[i]);
    assert.equal(call.params[0].data.length, 10);
  });
  assert.throws(() => E.manualPoolCalls(V4_POOL_ID), /42-char/);
});

test("slot0 decoding takes sqrtPriceX96 and tick from the canonical seven-word reply and from the brief's six-word layout", () => {
  const live = E.decodeManualSlot0(LIVE_SLOT0_A);
  assert.equal(live.tick, 93992);
  assert.equal(live.sqrtPriceX96.toHexString(), "0x6de19cd729279cd0d3d20effb4");
  const six = abi.encode(["uint160", "int24", "uint24", "uint24", "uint8", "bool"], [bn(2).pow(96), -887000, 0, 500, 10, true]);
  assert.deepEqual({ ...E.decodeManualSlot0(six), sqrtPriceX96: E.decodeManualSlot0(six).sqrtPriceX96.toString() }, { tick: -887000, sqrtPriceX96: bn(2).pow(96).toString() });
  assert.equal(E.decodeManualSlot0(abi.encode(["uint160", "int24"], [0, 0])).sqrtPriceX96.toString(), "0");
  assert.throws(() => E.decodeManualSlot0("0x"), /too short/);
  assert.throws(() => E.decodeManualSlot0(abi.encode(["uint256"], [1])), /too short/);
  assert.throws(() => E.decodeManualSlot0(abi.encode(["uint256", "int256"], [bn(2).pow(160), 0])), /uint160/);
  assert.throws(() => E.decodeManualSlot0(abi.encode(["uint256", "int256"], [1, 887273])), /tick out of range/);
  assert.throws(() => E.decodeManualSlot0(42), /too short/);
});

test("decodeManualPool builds a V3 row; empty or undecodable replies are 'Invalid pool address'", () => {
  const results = [abi.encode(["address"], [WETH]), abi.encode(["address"], [PONS]), abi.encode(["uint24"], [10000]), LIVE_SLOT0_A];
  const row = E.decodeManualPool(LIVE_POOL_A, results);
  assert.equal(row.protocol, "V3");
  assert.equal(row.manual, true);
  assert.equal(row.address, ethers.utils.getAddress(LIVE_POOL_A));
  assert.equal(row.poolId, LIVE_POOL_A);
  assert.equal(row.currency0, WETH);
  assert.equal(row.currency1, PONS);
  assert.equal(row.fee, 10000);
  assert.equal(row.tick, 93992);
  assert.equal(row.price, Math.pow(1.0001, 93992));
  assert.equal(row.active, true);
  const invalid = new RegExp("^Error: " + E.MANUAL_INVALID_ERROR);
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, ["0x", results[1], results[2], results[3]]), invalid);
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, [results[0], results[1], results[2], "0x1234"]), invalid);
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, [results[0], results[1], "0xzz", results[3]]), invalid);
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, [{ error: new Error("execution reverted") }, results[1], results[2], results[3]]), /execution reverted/);
  // token0/token1 that are not a sorted pair cannot come from a V3 pool.
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, [results[1], results[0], results[2], results[3]]), invalid);
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, [results[0], results[0], results[2], results[3]]), invalid);
  assert.throws(() => E.decodeManualPool(LIVE_POOL_A, [results[0], results[1], abi.encode(["uint24"], [1000001]), results[3]]), invalid);
  assert.equal(E.MANUAL_INVALID_ERROR, "Invalid pool address");
});

test("readManualPool sends four sequential eth_calls; a revert is 'Invalid pool address', a transport failure is not", async () => {
  const p = liveManualMock();
  const row = await E.readManualPool(rpc(p), LIVE_POOL_B);
  assert.equal(row.fee, 3000);
  assert.equal(row.tick, 94065);
  assert.deepEqual(p.manualCalls.map((c) => c.name), ["token0", "token1", "fee", "slot0"]);
  assert.equal(p.httpCalls.length, 4);
  assert.ok(p.httpCalls.every((c) => !Array.isArray(c.body)), "never a batch");
  assert.ok(p.rpcCalls.every((c) => c.method === "eth_call"));
  // A token address, or any contract without token0(), reverts: the brief's message.
  await assert.rejects(E.readManualPool(rpc(p), E.PONS), /^Error: Invalid pool address \(0x39dBED3a2bd333467115dE45665cC57F813C4571: token0\(\) reverted\)$/);
  // An address without code: the mock answers "execution reverted" for unknown targets, as a node does with 0x for no code.
  p.setPool(OTHER_POOL, pool(WETH, PONS, 100, 93990, { revert: "empty" }));
  await assert.rejects(E.readManualPool(rpc(p), OTHER_POOL), /Invalid pool address .*token0\(\) returned no data/);
  p.setPool(OTHER_POOL, pool(WETH, PONS, 100, 93990, { revert: "slot0" }));
  await assert.rejects(E.readManualPool(rpc(p), OTHER_POOL), /Invalid pool address .*slot0\(\) reverted/);
  // Rate limits and outages are RPC errors, never blamed on the address.
  p.rpcFailures = 1;
  await assert.rejects(E.readManualPool(rpc(p), LIVE_POOL_B), (error) => !/Invalid pool/.test(error.message) && /rate limited/.test(error.message));
  p.httpFailures = 1;
  await assert.rejects(E.readManualPool(rpc(p), LIVE_POOL_B), /RPC HTTP error 429/);
  await assert.rejects(E.readManualPool(rpc(p), V4_POOL_ID), /42-char/);
  await assert.rejects(E.readManualPool(null, LIVE_POOL_B), /request function/);
});

test("validation: same pair in the same order, both with sqrtPriceX96 > 0, not the same pool twice; buy is the lower price", () => {
  const results = (token0, token1, fee, tick, sqrt = bn(2).pow(96)) => [abi.encode(["address"], [token0]), abi.encode(["address"], [token1]),
    abi.encode(["uint24"], [fee]), abi.encode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [sqrt, tick, 0, 1, 1, 0, true])];
  const a = E.decodeManualPool(LIVE_POOL_A, results(WETH, PONS, 10000, 93992));
  const b = E.decodeManualPool(LIVE_POOL_B, results(WETH, PONS, 3000, 94065));
  assert.deepEqual(E.validateManualPools(a, b).map((r) => r.address), [a.address, b.address]);
  assert.deepEqual(E.validateManualPools(b, a).map((r) => r.address), [a.address, b.address], "auto-swap: the lower price buys");
  const other = E.decodeManualPool(poolA, results(PONS, USDG, 3000, -292916));
  assert.throws(() => E.validateManualPools(a, other), /^Error: Pools are different pairs$/);
  const empty = E.decodeManualPool(OTHER_POOL, results(WETH, PONS, 100, 93990, 0));
  assert.throws(() => E.validateManualPools(a, empty), /^Error: Pool has no liquidity \(Pool B 0x0f5F5bCC08cAe61d19c9a2d2594C252f1Baddae6\)$/);
  assert.throws(() => E.validateManualPools(empty, a), /Pool has no liquidity \(Pool A /);
  assert.throws(() => E.validateManualPools(a, E.decodeManualPool(LIVE_POOL_A, results(WETH, PONS, 10000, 93000))), /same pool/);
  // The pair check comes before the liquidity check, as the brief lists them.
  assert.throws(() => E.validateManualPools(empty, other), /different pairs/);
  const spread = E.manualSpread(b, a, 0.5);
  assert.equal(spread.buy.address, a.address);
  assert.equal(spread.sell.address, b.address);
  assert.ok(Math.abs(spread.spreadPercent - (Math.pow(1.0001, 73) - 1) * 100) < 1e-9);
  assert.equal(spread.feeCostPercent, 1.3);
  assert.equal(spread.verdict, "RED");
  // The factory's real 0.01% pool against the 0.30% pool: 0.73% spread - 0.31% fees = 0.42% net.
  const cheap = E.decodeManualPool(OTHER_POOL, results(WETH, PONS, 100, 93992));
  assert.equal(E.manualSpread(b, cheap, 0.5).verdict, "RED");
  assert.equal(E.manualSpread(b, cheap, 0.4).verdict, "GREEN");
  assert.equal(E.manualSpread(b, cheap, 0.4).buy.address, cheap.address);
  assert.equal(E.manualSpread(b, cheap, 0.4).feeCostPercent, 0.31);
});

test("fee and address formatting and the Last read line", () => {
  assert.deepEqual([100, 500, 3000, 10000, 250].map(E.formatManualFee), ["0.01%", "0.05%", "0.30%", "1.00%", "0.03%"]);
  const checksummed = ethers.utils.getAddress(LIVE_POOL_A);
  assert.equal(E.truncateAddress(LIVE_POOL_A), checksummed.slice(0, 6) + "…" + checksummed.slice(-4));
  assert.equal(E.truncateAddress(LIVE_POOL_A).length, 11);
  assert.throws(() => E.truncateAddress("0x12"));
  assert.equal(E.formatLastRead(0), "Last read: 0s ago");
  assert.equal(E.formatLastRead(12.9), "Last read: 12s ago");
  assert.equal(E.formatLastRead(-3), "Last read: 0s ago");
  assert.throws(() => E.formatLastRead("x"), /seconds/);
});

test("the manual monitor polls every 30 s with 8 eth_calls, reads symbol/decimals once, and never sends logs, blocks or batches", async () => {
  const p = liveManualMock();
  const updates = [];
  const { monitor, timers, fire, restore } = monitorFor(p, { onUpdate: (state) => updates.push({ ...state }) });
  try {
    await monitor.start(LIVE_POOL_A, LIVE_POOL_B);
    const state = monitor.getState();
    assert.equal(state.lastError, null);
    assert.equal(state.pair.symbol0, "WETH");
    assert.equal(state.pair.symbol1, "PONS");
    assert.equal(state.pair.decimals0, 18);
    assert.equal(state.pools.length, 2);
    assert.equal(state.pools[0].fee, 10000);
    assert.equal(state.pools[1].fee, 3000);
    assert.equal(state.pools[0].status, "OK");
    assert.ok(Math.abs(state.pools[0].displayPrice - 12090) < 20, "about 12090 PONS per WETH");
    assert.equal(state.spread.buy.address, ethers.utils.getAddress(LIVE_POOL_A));
    assert.equal(state.spread.feeCostPercent, 1.3);
    assert.equal(state.spreads.length, 1);
    assert.equal(state.polls, 1);
    assert.ok(state.lastRead > 0);
    assert.equal(updates.length, 1);
    assert.deepEqual(timers.map((t) => t.ms), [30000]);
    const methods = new Set(p.rpcCalls.map((c) => c.method));
    assert.deepEqual([...methods], ["eth_call"]);
    assert.ok(p.httpCalls.every((c) => !Array.isArray(c.body)), "no JSON-RPC batch");
    assert.equal(p.manualCalls.length, 8);
    assert.equal(p.rpcCalls.length, 12, "8 pool reads + symbol and decimals of two tokens on the first read");
    await fire();
    assert.equal(monitor.getState().polls, 2);
    assert.equal(p.manualCalls.length, 16);
    assert.equal(p.rpcCalls.length, 20, "exactly 8 eth_calls on a later poll: symbols are cached");
    assert.equal(p.symbolCalls, 2);
    assert.deepEqual(timers.map((t) => t.ms), [30000]);
    monitor.stop();
    assert.equal(monitor.isRunning(), false);
    assert.equal(timers.length, 0);
  } finally { restore(); }
});

test("pool-level errors are reported with the brief's messages and re-read in 30 s; RPC failures back off 60 s", async () => {
  const p = liveManualMock();
  const errors = [];
  const { monitor, timers, fire, restore } = monitorFor(p, { onError: (error) => errors.push(error.message) });
  try {
    await monitor.start(LIVE_POOL_A, poolA); // WETH/PONS versus PONS/USDG
    assert.equal(monitor.getState().lastError, "Pools are different pairs");
    assert.equal(monitor.getState().errorCode, "DIFFERENT_PAIRS");
    assert.deepEqual(timers.map((t) => t.ms), [30000]);
    assert.equal(monitor.getState().pools.length, 0);
    await monitor.start(E.PONS, LIVE_POOL_B);
    assert.match(monitor.getState().lastError, /^Pool A: Invalid pool address/);
    await monitor.start(LIVE_POOL_B, E.USDG);
    assert.match(monitor.getState().lastError, /^Pool B: Invalid pool address/);
    p.setPool(OTHER_POOL, pool(WETH, PONS, 100, 93990, { sqrtPriceX96: 0 }));
    await monitor.start(LIVE_POOL_A, OTHER_POOL);
    assert.match(monitor.getState().lastError, /^Pool has no liquidity \(Pool B /);
    assert.equal(monitor.getState().errorCode, "NO_LIQUIDITY");
    await monitor.start(LIVE_POOL_A, LIVE_POOL_A);
    assert.equal(monitor.getState().lastError, "Pool A and Pool B are the same pool");
    assert.throws(() => monitor.start(V4_POOL_ID, LIVE_POOL_B), /^Error: Pool A: Enter a 42-char V3 pool address$/);
    assert.equal(monitor.isRunning(), false, "a bad address never starts a loop");
    assert.throws(() => monitor.start(LIVE_POOL_A, LIVE_POOL_B.slice(0, 40)), /^Error: Pool B: Enter a 42-char V3 pool address$/);
    // A transport failure keeps the last good table and retries in 60 s; the next success clears it.
    await monitor.start(LIVE_POOL_A, LIVE_POOL_B);
    assert.equal(monitor.getState().lastError, null);
    p.rpcFailures = 1;
    await fire();
    assert.match(monitor.getState().lastError, /rate limited/);
    assert.equal(monitor.getState().errorCode, "RPC");
    assert.equal(monitor.getState().pools.length, 2, "previous readings stay visible");
    assert.deepEqual(timers.map((t) => t.ms), [60000]);
    await fire();
    assert.equal(monitor.getState().lastError, null);
    assert.equal(monitor.getState().errors, 1);
    assert.deepEqual(timers.map((t) => t.ms), [30000]);
    assert.ok(errors.length >= 6);
    monitor.stop();
    assert.throws(() => E.createManualMonitor({}), /request function/);
    assert.throws(() => E.createManualMonitor({ request: () => {}, pollIntervalMs: -1 }), /intervals/);
  } finally { restore(); }
});

test("the manual rows carry everything the existing V3 execution path needs", async () => {
  const p = new ManualMock();
  const { monitor, restore } = monitorFor(p);
  try {
    await monitor.start(poolB, poolA); // pasted in the "wrong" order
    const state = monitor.getState();
    assert.equal(state.lastError, null);
    assert.equal(state.spread.buy.address, poolA, "the cheaper 0.30% pool buys");
    assert.equal(state.spread.sell.address, poolB);
    assert.equal(state.spread.feeCostPercent, 1.3);
    // The same quote mechanism as the auto-scan V3 rows (creation-call callback, no wallet).
    const quote = await E.quotePool(rpc(p), state.spread.buy, false, bn(10000));
    assert.equal(quote.toString(), "50000000000000000");
    assert.ok(state.pools.every((row) => row.protocol === "V3" && row.currency0 === PONS && row.currency1 === USDG && row.status === "OK" && row.active));
    const best = E.protocolAutoDecision(state.pools, 0.5);
    assert.equal(best.spread.buy.address, poolA);
  } finally { restore(); }
});
