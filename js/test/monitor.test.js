"use strict";

// Offline tests of the follow-up 3 additions: pool ids, tick prices, spreads, the polling monitor,
// the quote recovered from the router's price-check revert, and whole-balance transfers.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { MockWallet, CALLER, OTHER, erc20, LIVE_PRICE_X36 } = require("./mock-wallet.js");
const abi = ethers.utils.defaultAbiCoder;
const POOL_A_ID = "0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a";
const POOL_B_ID = "0x2e7ba084e848fb5af806efaeccfc9676a1a4c459f696e852b53c1a4f650c39b6";
const LIVE_QUOTE = ethers.BigNumber.from("52358673121064015");
const key = (fee, tickSpacing) => ({ currency0: E.PONS, currency1: E.USDG, fee, tickSpacing, hooks: E.NO_HOOKS });
const rpcFor = (provider) => E.createRpcClient(E.RPC_URL, provider.fetch).request;

// ------------------------------------------------------------------ pure helpers

test("sortPair puts the lower address first and refuses identical, zero or malformed tokens", () => {
  assert.deepEqual(E.sortPair(E.USDG, E.PONS), { currency0: ethers.utils.getAddress(E.PONS), currency1: E.USDG });
  assert.deepEqual(E.sortPair(E.PONS, E.USDG), E.sortPair(E.USDG, E.PONS));
  assert.throws(() => E.sortPair(E.PONS, E.PONS), /different/);
  assert.throws(() => E.sortPair(E.PONS, ethers.constants.AddressZero), /ERC20/);
  assert.throws(() => E.sortPair("0x1234", E.USDG), /invalid address/);
  assert.throws(() => E.sortPair(undefined, E.USDG), /required/);
});

test("the seven pool keys have the brief's tiers and the cast-computed ids", () => {
  const keys = E.poolKeysFor(E.PONS, E.USDG);
  assert.deepEqual(keys.map((k) => [k.fee, k.tickSpacing]), E.FEE_TIERS);
  assert.equal(new Set(keys.map(E.poolId)).size, 7);
  assert.equal(E.poolId(E.POOL_A), POOL_A_ID);
  assert.equal(E.poolId(E.POOL_B), POOL_B_ID);
  assert.equal(E.poolId(keys[4]), POOL_A_ID);
  assert.equal(E.poolId(key(3000, 60)), ethers.utils.keccak256(abi.encode(["address", "address", "uint24", "int24", "address"],
    [E.PONS, E.USDG, 3000, 60, ethers.constants.AddressZero])));
  assert.throws(() => E.poolId({ currency0: E.USDG, currency1: E.PONS, fee: 0, tickSpacing: 1 }), /sort strictly below/);
});

test("tickToPrice is 1.0001^tick and rejects ticks outside the V4 range", () => {
  assert.equal(E.tickToPrice(0), 1);
  assert.ok(Math.abs(E.tickToPrice(1) - 1.0001) < 1e-12);
  assert.ok(Math.abs(E.tickToPrice(-292916) * 1e12 - 0.19030744) < 1e-6); // USDG per PONS on 2026-11-07
  assert.throws(() => E.tickToPrice(887273), /range/);
  assert.throws(() => E.tickToPrice(1.5), /range/);
});

test("summarisePools counts swaps, keeps the latest tick and marks pools without swaps inactive", () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, 100);
  provider.addSwap(3000, 60, -292900, 101);
  provider.addSwap(3000, 60, -292950, 101); // same block, later log index wins
  provider.addSwap(2500, 25, -292902, 90);
  const foreign = provider.addSwap(3000, 60, 5, 150, { currency0: E.PONS, currency1: OTHER });
  const rows = E.summarisePools(E.poolKeysFor(E.PONS, E.USDG), provider.logs.concat([{ topics: ["0xdead"], data: "0x" }]));
  assert.equal(rows.length, 7);
  const a = rows.find((r) => r.fee === 3000);
  assert.equal(a.swaps, 3);
  assert.equal(a.tick, -292950);
  assert.equal(a.active, true);
  assert.equal(a.lastBlock, 101);
  assert.ok(Math.abs(a.price - E.tickToPrice(-292950)) < 1e-18);
  assert.equal(rows.find((r) => r.fee === 2500).swaps, 1);
  assert.equal(rows.filter((r) => r.active).length, 2);
  assert.equal(rows.find((r) => r.fee === 0 && r.tickSpacing === 1).price, null);
  assert.notEqual(rows.find((r) => r.fee === 3000).poolId, foreign.topics[1]);
  assert.throws(() => E.decodeSwapLog({ topics: ["0x00"], data: "0x" }), /not a Swap log/);
  assert.throws(() => E.summarisePools([], null), /array/);
});

test("rankSpreads: buy is the cheaper pool, fee cost is the two LP fees, best net first, five rows at most", () => {
  const provider = new MockWallet();
  [[0, 1, -292000], [500, 10, -292500], [2500, 25, -292902], [3000, 60, -292916]].forEach(([f, s, t]) => provider.addSwap(f, s, t));
  const rows = E.summarisePools(E.poolKeysFor(E.PONS, E.USDG), provider.logs);
  const spreads = E.rankSpreads(rows, 0.5);
  assert.equal(spreads.length, 5); // 4 active pools give 6 pairs, capped at 5
  assert.equal(E.rankSpreads(rows, 0.5, 10).length, 6);
  for (const s of spreads) {
    assert.ok(s.buy.price <= s.sell.price);
    assert.ok(Math.abs(s.spreadPercent - (s.sell.price - s.buy.price) / s.buy.price * 100) < 1e-9);
    assert.equal(s.feeCostPercent, (s.buy.fee + s.sell.fee) / 10000);
    assert.ok(Math.abs(s.netPercent - (s.spreadPercent - s.feeCostPercent)) < 1e-12);
    assert.equal(s.verdict, s.netPercent > 0.5 ? "GREEN" : "RED");
  }
  for (let i = 1; i < spreads.length; i++) assert.ok(spreads[i - 1].netPercent >= spreads[i].netPercent);
  // The best pair is the cheapest pool (3000/60, lowest tick) against the dearest (0/1).
  assert.equal(spreads[0].buy.fee, 3000);
  assert.equal(spreads[0].sell.fee, 0);
  assert.equal(spreads[0].feeCostPercent, 0.3);
  // 916 ticks apart is about 9.6%; verdict follows the threshold.
  assert.ok(spreads[0].netPercent > 9 && spreads[0].netPercent < 10);
  assert.equal(E.rankSpreads(rows, 20)[0].verdict, "RED");
  assert.equal(E.feeCostPercent(3000, 30000), 3.3);
  assert.ok(Math.abs(E.spreadPercent(1, 1.01) - 1) < 1e-9);
  assert.throws(() => E.spreadPercent(0, 1), /positive/);
  assert.throws(() => E.rankSpreads(rows, -1), /threshold/);
  assert.deepEqual(E.rankSpreads(E.summarisePools(E.poolKeysFor(E.PONS, E.USDG), []), 0.5), []);
});

test("applySlippage takes 0.5% off the live quote exactly as the Solidity test expects", () => {
  assert.equal(E.applySlippage(LIVE_QUOTE).toString(), "52096879755458694");
  assert.equal(E.applySlippage(LIVE_QUOTE, 0).toString(), LIVE_QUOTE.toString());
  assert.equal(E.applySlippage(LIVE_QUOTE, 10000).toString(), "0");
  assert.throws(() => E.applySlippage(1, 10001), /basis points/);
  assert.throws(() => E.applySlippage(1, 0.5), /basis points/);
});

test("decodeQuoteRevert and extractRevertData handle the live data and the shapes wallets use", () => {
  const data = E.QUOTE_REVERT_SELECTOR + abi.encode(["uint256", "uint256"], [ethers.constants.MaxUint256, LIVE_PRICE_X36["3000/60"]]).slice(2);
  assert.equal(E.decodeQuoteRevert(data, 10000).toString(), LIVE_QUOTE.toString());
  assert.equal(E.decodeQuoteRevert(data.toUpperCase().replace("0X", "0x"), 10000).toString(), LIVE_QUOTE.toString());
  assert.equal(E.decodeQuoteRevert("0x3b99b53d", 10000), null);
  assert.equal(E.decodeQuoteRevert(data.slice(0, -2), 10000), null);
  assert.equal(E.decodeQuoteRevert(undefined, 10000), null);
  assert.equal(E.extractRevertData({ data }), data);
  assert.equal(E.extractRevertData({ data: { originalError: { data } } }), data);
  assert.equal(E.extractRevertData({ message: "execution reverted: " + data }), data);
  assert.equal(E.extractRevertData(new Error("rate limited")), null);
  const circular = {}; circular.cause = circular;
  assert.equal(E.extractRevertData(circular), null);
});

test("encodeQuoteCalldata is one swap command with an unreachable minimum hop price", () => {
  const data = E.encodeQuoteCalldata(E.POOL_A, false, 10000);
  const [commands, inputs] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + data.slice(10));
  assert.equal(commands, "0x10");
  const [actions, params] = abi.decode(["bytes", "bytes[]"], inputs[0]);
  assert.equal(actions, "0x060c0e");
  const swap = abi.decode(["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"], params[0])[0];
  assert.ok(swap[4].eq(ethers.constants.MaxUint256));
  assert.ok(swap[2].eq(10000));
  assert.equal(swap[1], false);
});

// ------------------------------------------------------------------ JSON-RPC and quote

test("createRpcClient surfaces HTTP failures, node errors with code/data, and rejects bad URLs", async () => {
  const provider = new MockWallet();
  const request = rpcFor(provider);
  assert.equal(await request("eth_blockNumber"), ethers.utils.hexValue(provider.block));
  provider.httpFailures = 1;
  await assert.rejects(request("eth_blockNumber"), /RPC HTTP error 429/);
  provider.rpcFailures = 1;
  await assert.rejects(request("eth_blockNumber"), { code: -32005, message: /rate limited/ });
  assert.equal(await request("eth_blockNumber"), ethers.utils.hexValue(provider.block));
  assert.throws(() => E.createRpcClient("ftp://x", provider.fetch), /http/);
  assert.throws(() => E.createRpcClient(E.RPC_URL, null, {}) && E.createRpcClient(E.RPC_URL, "nope"), /fetch/);
  await assert.rejects(E.createRpcClient("https://other.example/", provider.fetch).request("eth_blockNumber"), /404/);
});

test("quoteExactIn: live price, no liquidity, uninitialised pool, RPC outage and a non-reverting router", async () => {
  const provider = new MockWallet();
  const request = rpcFor(provider);
  const quote = await E.quoteExactIn(request, { poolKey: E.POOL_A, zeroForOne: false, amountIn: 10000, from: CALLER });
  assert.equal(quote.toString(), LIVE_QUOTE.toString());
  assert.equal((await E.quoteExactIn(request, { poolKey: E.POOL_B, zeroForOne: false, amountIn: 10000 })).toString(), "0");
  assert.equal((await E.quoteExactIn(request, { poolKey: key(2500, 25), zeroForOne: false, amountIn: 20000 })).toString(),
    LIVE_PRICE_X36["2500/25"].mul(20000).div(ethers.BigNumber.from(10).pow(36)).toString());
  await assert.rejects(E.quoteExactIn(request, { poolKey: key(0, 1), zeroForOne: false, amountIn: 10000 }), /Quote failed for pool 0\/1/);
  provider.rpcFailures = 1;
  await assert.rejects(E.quoteExactIn(request, { poolKey: E.POOL_A, zeroForOne: false, amountIn: 10000 }), /rate limited/);
  await assert.rejects(E.quoteExactIn(request, { poolKey: E.POOL_A, zeroForOne: false, amountIn: 0 }), /non-zero/);
  await assert.rejects(E.quoteExactIn(request, { poolKey: E.POOL_A, zeroForOne: false, amountIn: E.MAX_UINT128 }), /non-zero/);
  await assert.rejects(E.quoteExactIn("nope", {}), /request function/);
  await assert.rejects(E.quoteExactIn(async () => "0x", { poolKey: E.POOL_A, zeroForOne: false, amountIn: 1 }), /router behaviour changed/);
  // The quote never writes and never asks the wallet.
  assert.equal(provider.sent.length, 0);
  assert.equal(provider.calls.length, 0);
});

// ------------------------------------------------------------------ monitor

/** Load the module in a context whose timers are recorded instead of run, to assert the schedule. */
function monitorWithFakeTimers(provider, options = {}) {
  const timers = [];
  let nextId = 1;
  const context = vm.createContext({
    setTimeout: (fn, ms) => { const id = nextId++; timers.push({ id, fn, ms }); return id; },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    console, atob, btoa,
  });
  // Ethers is loaded into the context from the vendored file, as the page loads it.
  vm.runInContext(fs.readFileSync(require.resolve("../vendor/ethers-5.7.2.umd.min.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(require.resolve("../v4-arb-encoder.js"), "utf8"), context);
  const updates = [];
  const errors = [];
  let now = 1700000000000;
  const monitor = context.V4ArbEncoder.createPoolMonitor({
    request: rpcFor(provider), now: () => now,
    onUpdate: (state) => updates.push(JSON.parse(JSON.stringify({ polls: state.polls, errors: state.errors, lastError: state.lastError,
      active: state.pools.filter((p) => p.active).length, spreads: state.spreads.length, block: state.blockNumber }))),
    onError: (error) => errors.push(error.message),
    ...options,
  });
  const fire = async () => { const due = timers.splice(0); for (const t of due) await t.fn(); };
  return { monitor, timers, updates, errors, fire, advance: (ms) => { now += ms; } };
}

test("monitor: first poll on start, 30 s schedule, 60 s back-off on any RPC error, recovery, stop", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916);
  provider.addSwap(2500, 25, -292902);
  const { monitor, timers, updates, errors, fire } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, E.USDG);
  let state = monitor.getState();
  assert.equal(state.pair.symbol0, "PONS");
  assert.equal(state.pair.symbol1, "USDG");
  assert.equal(state.pair.decimals0, 18);
  assert.equal(state.pair.decimals1, 6);
  assert.equal(state.pair.symbolA, "PONS");
  assert.equal(state.pools.length, 7);
  assert.equal(state.pools.filter((p) => p.active).length, 2);
  assert.equal(state.spreads.length, 1);
  assert.equal(state.spreads[0].buy.fee, 3000);
  assert.equal(state.spreads[0].verdict, "RED"); // 0.14% gap, 0.55% fees
  assert.equal(state.blockNumber, provider.block);
  assert.equal(state.fromBlock, provider.block - 2999);
  assert.equal(state.windowBlocks, 3000);
  assert.equal(state.lastError, null);
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  const logsCall = provider.rpcCalls.find((c) => c.method === "eth_getLogs");
  assert.equal(logsCall.params[0].address, E.POOL_MANAGER);
  assert.equal(logsCall.params[0].topics[0], E.SWAP_TOPIC);
  assert.equal(logsCall.params[0].topics[1].length, 7);
  assert.equal(ethers.BigNumber.from(logsCall.params[0].toBlock).sub(logsCall.params[0].fromBlock).toNumber(), 2999);
  // Symbols are read once, not on every poll.
  const symbolCalls = () => provider.rpcCalls.filter((c) => c.method === "eth_call" && c.params[0].data === erc20.getSighash("symbol")).length;
  assert.equal(symbolCalls(), 2);

  // A rate limit: status carries the error, the next attempt waits 60 s, nothing throws.
  provider.rpcFailures = 1;
  await fire();
  state = monitor.getState();
  assert.equal(state.errors, 1);
  assert.match(state.lastError, /rate limited/);
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  assert.equal(errors.length, 1);
  assert.equal(state.pools.length, 7); // last good table is kept while retrying

  // An HTTP failure and a malformed logs reply behave the same way.
  provider.httpFailures = 1;
  await fire();
  assert.match(monitor.getState().lastError, /HTTP error 429/);
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  const realHandle = provider.handle.bind(provider);
  provider.handle = (method, params) => (method === "eth_getLogs" ? "not a list" : realHandle(method, params));
  await fire();
  assert.match(monitor.getState().lastError, /did not return a list/);
  provider.handle = realHandle;

  // Recovery: back to the 30 s cadence with the error cleared and a new block.
  provider.block += 50;
  provider.addSwap(3000, 60, -292000, provider.block);
  await fire();
  state = monitor.getState();
  assert.equal(state.lastError, null);
  assert.equal(state.errors, 3);
  assert.equal(state.polls, 2);
  assert.equal(state.blockNumber, provider.block);
  assert.equal(state.pools.find((p) => p.fee === 3000).swaps, 2);
  assert.equal(state.pools.find((p) => p.fee === 3000).tick, -292000);
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  assert.equal(symbolCalls(), 2);
  assert.equal(updates.length, 5);

  // stop() cancels the schedule; a late fire of an old timer does nothing.
  const pending = timers.slice();
  monitor.stop();
  assert.equal(timers.length, 0);
  assert.equal(monitor.isRunning(), false);
  for (const t of pending) await t.fn();
  assert.equal(monitor.getState().polls, 2);
  assert.equal(timers.length, 0);
});

test("monitor: a pair whose token has no symbol() keeps retrying, a bad pair never starts, restart resets", async () => {
  const provider = new MockWallet();
  const { monitor, timers, errors, fire } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, OTHER); // OTHER has no code in the mock
  assert.match(monitor.getState().lastError, /Quote|reverted|symbol/);
  assert.equal(monitor.getState().pair, null);
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  provider.tokens.set(OTHER.toLowerCase(), ["FOO", 8]);
  await fire();
  assert.equal(monitor.getState().lastError, null);
  assert.equal(monitor.getState().pair.symbolB, "FOO");
  assert.equal(monitor.getState().pair.decimalsB, 8);
  assert.equal(monitor.getState().pair.currency0, ethers.utils.getAddress(E.PONS));
  assert.equal(errors.length, 1);
  assert.throws(() => monitor.start(E.PONS, E.PONS), /different/);
  assert.equal(monitor.isRunning(), false);
  assert.equal(timers.length, 0);
  await monitor.start(E.USDG, E.PONS);
  assert.equal(monitor.getState().pair.symbolA, "USDG");
  assert.equal(monitor.getState().polls, 1);
  monitor.stop();
  await assert.rejects(E.createPoolMonitor({ request: rpcFor(provider) }).pollOnce(), /start\(/);
  assert.throws(() => E.createPoolMonitor({}), /request function/);
  assert.throws(() => E.createPoolMonitor({ request: () => {}, windowBlocks: 0 }), /windowBlocks/);
});

test("monitor: a threshold function is consulted on every poll", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916);
  provider.addSwap(0, 1, -292000);
  let threshold = 0.5;
  const { monitor, fire } = monitorWithFakeTimers(provider, { thresholdPercent: () => threshold });
  await monitor.start(E.PONS, E.USDG);
  assert.equal(monitor.getState().spreads[0].verdict, "GREEN");
  threshold = 50;
  await fire();
  assert.equal(monitor.getState().spreads[0].verdict, "RED");
  monitor.stop();
});

test("monitor with real short intervals keeps polling until stopped", async () => {
  const provider = new MockWallet();
  const monitor = E.createPoolMonitor({ request: rpcFor(provider), pollIntervalMs: 2, retryIntervalMs: 4 });
  await monitor.start(E.PONS, E.USDG);
  provider.rpcFailures = 1;
  await new Promise((resolve) => setTimeout(resolve, 80));
  monitor.stop();
  const state = monitor.getState();
  assert.ok(state.polls >= 3, "polls " + state.polls);
  assert.equal(state.errors, 1);
  assert.equal(state.lastError, null);
  const polls = state.polls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(monitor.getState().polls, polls);
});

// ------------------------------------------------------------------ follow-up 3.5: window, staleness, slot0

// The 3000/60 pool's Slot0 word read through extsload on 2026-11-07.
const LIVE_SLOT0 = "0x000000000bb81f41f4fb878800000000000000000000074b56c05cb633d71d40";
const idOf = (fee, tickSpacing) => E.poolId(key(fee, tickSpacing));
const poolOf = (state, fee) => state.pools.find((p) => p.fee === fee);
const pollCalls = (provider, from) => provider.rpcCalls.slice(from);

test("defaults: window 3000 within 50 to 50000, staleness 7200; parsers refuse anything else", () => {
  assert.equal(E.LOG_WINDOW_BLOCKS, 3000);
  assert.equal(E.MIN_WINDOW_BLOCKS, 50);
  assert.equal(E.MAX_WINDOW_BLOCKS, 50000);
  assert.equal(E.MAX_STALENESS_SECONDS, 7200);
  assert.equal(E.POLL_INTERVAL_MS, 30000);
  assert.equal(E.RPC_RETRY_MS, 60000);
  assert.equal(E.parseWindowBlocks("50"), 50);
  assert.equal(E.parseWindowBlocks(" 50000 "), 50000);
  for (const bad of ["49", "50001", "", "abc", "1e3", "100.5", "-100", null, undefined]) assert.equal(E.parseWindowBlocks(bad), null, String(bad));
  assert.equal(E.parseMaxStaleness("0"), 0);
  assert.equal(E.parseMaxStaleness(7200), 7200);
  for (const bad of ["", "abc", "-1", "1.5", "99999999999999999999"]) assert.equal(E.parseMaxStaleness(bad), null, bad);
});

test("elapsed time formats as Xm ago or Xh Ym ago, and colours switch at exactly 30 min and 2 h", () => {
  assert.equal(E.formatElapsed(0), "0m ago");
  assert.equal(E.formatElapsed(59), "0m ago");
  assert.equal(E.formatElapsed(3599), "59m ago");
  assert.equal(E.formatElapsed(3600), "1h 0m ago");
  assert.equal(E.formatElapsed(11520), "3h 12m ago");
  assert.equal(E.formatDuration(11520), "3h 12m");
  assert.throws(() => E.formatElapsed(-1), /non-negative/);
  assert.equal(E.stalenessColor(0), "green");
  assert.equal(E.stalenessColor(1799), "green");
  assert.equal(E.stalenessColor(1800), "yellow");
  assert.equal(E.stalenessColor(7200), "yellow");
  assert.equal(E.stalenessColor(7201), "red");
});

test("decodeSlot0 unpacks the live word; the read goes to the PoolManager's extsload at the pool's slot", () => {
  const slot0 = E.decodeSlot0(LIVE_SLOT0);
  assert.equal(slot0.tick, -292984);
  assert.equal(slot0.lpFee, 3000);
  assert.equal(slot0.protocolFee, 0x1f41f4);
  assert.equal(slot0.sqrtPriceX96.toString(), ethers.BigNumber.from("0x074b56c05cb633d71d40").toString());
  assert.ok(E.decodeSlot0(ethers.constants.HashZero).sqrtPriceX96.isZero());
  assert.equal(E.decodeSlot0("0x0000000027103e83e80d89e7fffd8963efd1fc6a506488495d951d5263988d25").tick, 887271); // live 10000/200 word
  assert.equal(E.decodeSlot0("0x0000000027103e83e80d89e7fffd8963efd1fc6a506488495d951d5263988d25").lpFee, 10000);
  for (const bad of ["0x", "0x1234", null, undefined, 7]) assert.throws(() => E.decodeSlot0(bad), /32-byte word/);
  const call = E.encodeSlot0Call(POOL_A_ID);
  assert.equal(call.to, E.POOL_MANAGER);
  assert.equal(call.data, "0x1e2eaeaf" + ethers.utils.keccak256(abi.encode(["bytes32", "uint256"], [POOL_A_ID, 6])).slice(2));
});

test("poolStatus: inactive, OK, the staleness boundary, EMPTY, and UNKNOWN for a failed read", () => {
  const base = { active: true, empty: false, elapsedSeconds: 7200 };
  assert.equal(E.poolStatus({ ...base, active: false }, 7200), "INACTIVE");
  assert.equal(E.poolStatus(base, 7200), "OK"); // exactly at the limit is not stale
  assert.equal(E.poolStatus({ ...base, elapsedSeconds: 7201 }, 7200), "STALE");
  assert.equal(E.poolStatus({ ...base, empty: true }, 7200), "EMPTY");
  assert.equal(E.poolStatus({ ...base, empty: null }, 7200), "UNKNOWN");
  assert.equal(E.poolStatus({ ...base, elapsedSeconds: null }, 7200), "UNKNOWN");
  assert.equal(E.poolStatus({ ...base, empty: null, elapsedSeconds: 9000 }, 7200), "STALE");
  assert.throws(() => E.annotatePools([], -1), /max staleness/);
});

const health = (fee, tickSpacing, price, fields = {}) => ({ fee, tickSpacing, price, poolId: "0x" + fee, active: true, empty: false, elapsedSeconds: 60, status: "OK", ...fields });

test("rankSpreads leaves out STALE, EMPTY, UNKNOWN and inactive pools; fewer than two tradeable gives nothing", () => {
  const ok1 = health(3000, 60, 1);
  const ok2 = health(2500, 25, 1.2);
  assert.equal(E.rankSpreads([ok1, ok2], 0.5).length, 1);
  for (const status of ["STALE", "EMPTY", "UNKNOWN", "INACTIVE"]) {
    assert.deepEqual(E.rankSpreads([ok1, ok2, health(500, 10, 9, { status })], 0.5).map((s) => s.sell.fee), [2500]);
    assert.deepEqual(E.rankSpreads([ok1, health(500, 10, 9, { status })], 0.5), []);
  }
});

test("autoDecision fires only on two tradeable pools and names the pool that blocked a better trade", () => {
  const stale = health(3000, 60, 1, { status: "STALE", elapsedSeconds: 11520 });
  const empty = health(500, 10, 1.5, { status: "EMPTY", empty: true });
  const unknown = health(2500, 25, 1.4, { status: "UNKNOWN", empty: null, healthError: "slot0 read failed: timeout" });
  const fresh = health(0, 1, 1.3);
  const fresh2 = health(0, 10, 1.31);

  let decision = E.autoDecision([stale, fresh], 0.5);
  assert.equal(decision.spread, null);
  assert.deepEqual(decision.skips.map((s) => s.reason), ["auto skipped: pool 3000/60 stale (3h 12m)"]);
  assert.match(E.autoDecision([empty, fresh], 0.5).skips[0].reason, /^auto skipped: pool 500\/10 empty/);
  assert.equal(E.autoDecision([unknown, fresh], 0.5).skips[0].reason, "auto skipped: pool 2500/25 unknown (slot0 read failed: timeout)");

  // A worse but clean spread still fires, and the stale pool's better spreads are reported once.
  decision = E.autoDecision([stale, fresh, health(0, 10, 1.02)], 0.5);
  assert.equal(decision.spread.sell.fee, 0);
  assert.equal(decision.spread.sell.tickSpacing, 1);
  assert.equal(decision.skips.length, 1);
  assert.equal(decision.skips[0].status, "STALE");

  // A clean best spread reports nothing; a RED spread with a bad pool is no skip: it would not fire.
  const clean = E.autoDecision([health(0, 1, 1), health(0, 10, 1.3), stale], 90);
  assert.equal(clean.spread, null);
  assert.deepEqual(clean.skips, []);
  assert.equal(E.autoDecision([fresh, fresh2], 90).spread, null);
  assert.equal(E.autoDecision([health(0, 1, 1), health(0, 10, 1.3)], 0.5).spread.verdict, "GREEN");
});

test("a poll reads the latest block once, never eth_blockNumber, then one block and one slot0 per active pool", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block - 2000, { ageSeconds: 600 });
  provider.addSwap(3000, 60, -292900, provider.block - 1000, { ageSeconds: 300 }); // the later swap is the one timed
  provider.addSwap(2500, 25, -292902, provider.block - 500, { ageSeconds: 100 });
  const { monitor } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, E.USDG);
  const before = provider.rpcCalls.length;
  await monitor.pollOnce();
  const calls = pollCalls(provider, before);
  assert.equal(calls.filter((c) => c.method === "eth_blockNumber").length, 0);
  assert.deepEqual(calls[0].params, ["latest", false]);
  assert.equal(calls[1].method, "eth_getLogs");
  const blocks = calls.filter((c) => c.method === "eth_getBlockByNumber" && c.params[0] !== "latest");
  assert.deepEqual(blocks.map((c) => Number(c.params[0])).sort(), [provider.block - 1000, provider.block - 500].sort());
  assert.ok(blocks.every((c) => c.params[1] === false));
  const slot0 = calls.filter((c) => c.method === "eth_call");
  assert.equal(slot0.length, 2);
  assert.ok(slot0.every((c) => c.params[0].to === E.POOL_MANAGER && c.params[0].data.startsWith("0x1e2eaeaf")));
  assert.equal(calls.length, 2 + 2 + 2);
  assert.ok(calls.every((c) => c.url === E.RPC_URL));
  const state = monitor.getState();
  assert.equal(state.blockTimestamp, provider.now);
  assert.equal(poolOf(state, 3000).elapsedSeconds, 300);
  assert.equal(poolOf(state, 2500).elapsedSeconds, 100);
  assert.equal(poolOf(state, 2500).status, "OK");
  assert.equal(poolOf(state, 500).status, "INACTIVE");
  assert.equal(poolOf(state, 500).elapsedSeconds, null);
  assert.equal(state.spreads.length, 1);
  // The displayed price still comes from the Swap log's tick, not slot0's -292984.
  assert.equal(poolOf(state, 3000).tick, -292900);
  monitor.stop();
});

test("a window function is read on every poll and needs no restart; an out-of-range one is an RPC-style retry", async () => {
  const provider = new MockWallet();
  let blocks = 3000;
  const { monitor, timers, fire } = monitorWithFakeTimers(provider, { windowBlocks: () => blocks });
  await monitor.start(E.PONS, E.USDG);
  const span = () => { const f = provider.rpcCalls.filter((c) => c.method === "eth_getLogs").at(-1).params[0]; return Number(f.toBlock) - Number(f.fromBlock) + 1; };
  assert.equal(span(), 3000);
  blocks = 50;
  await fire();
  assert.equal(span(), 50);
  assert.equal(monitor.getState().windowBlocks, 50);
  blocks = 50000;
  await fire();
  assert.equal(span(), 50000);
  assert.equal(monitor.getState().polls, 3);
  blocks = 49;
  await fire();
  assert.match(monitor.getState().lastError, /windowBlocks/);
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  monitor.stop();
  for (const windowBlocks of [49, 50001, 1.5]) assert.throws(() => E.createPoolMonitor({ request: () => {}, windowBlocks }), /windowBlocks/);
  // A swap older than the window makes its pool inactive rather than stale.
  provider.addSwap(3000, 60, -292916, provider.block - 4000, { ageSeconds: 500 });
  const short = monitorWithFakeTimers(provider).monitor;
  await short.start(E.PONS, E.USDG);
  assert.equal(poolOf(short.getState(), 3000).status, "INACTIVE");
  short.stop();
});

test("staleness: above the maximum is STALE and leaves the spreads; a staleness function applies on the next poll", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block - 2000, { ageSeconds: 7201 });
  provider.addSwap(2500, 25, -292902, provider.block - 1000, { ageSeconds: 7200 });
  provider.addSwap(30000, 600, -292000, provider.block - 500, { ageSeconds: 60 });
  let max = 7200;
  const { monitor, fire } = monitorWithFakeTimers(provider, { maxStalenessSeconds: () => max });
  await monitor.start(E.PONS, E.USDG);
  let state = monitor.getState();
  assert.equal(poolOf(state, 3000).status, "STALE");
  assert.equal(poolOf(state, 2500).status, "OK");
  assert.equal(state.spreads.length, 1);
  assert.equal(state.spreads[0].buy.fee, 2500);
  max = 100;
  await fire();
  state = monitor.getState();
  assert.equal(poolOf(state, 2500).status, "STALE");
  assert.equal(state.spreads.length, 0);
  max = 8000;
  await fire();
  assert.equal(monitor.getState().spreads.length, 3);
  monitor.stop();
});

test("slot0: zero sqrtPriceX96 is EMPTY; a failed or malformed read is UNKNOWN for that pool only", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916);
  provider.addSwap(2500, 25, -292902);
  provider.addSwap(30000, 600, -292000);
  provider.setSlot0(idOf(30000, 600), ethers.constants.HashZero);
  provider.slot0Fail.add(idOf(2500, 25));
  const { monitor, timers, errors, fire } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, E.USDG);
  let state = monitor.getState();
  assert.equal(poolOf(state, 30000).status, "EMPTY");
  assert.equal(poolOf(state, 2500).status, "UNKNOWN");
  assert.match(poolOf(state, 2500).healthError, /slot0 read failed.*timeout/);
  assert.notEqual(poolOf(state, 2500).displayPrice, null); // still displayed
  assert.equal(poolOf(state, 3000).status, "OK");
  assert.equal(state.spreads.length, 0);
  assert.equal(state.lastError, null);
  assert.equal(errors.length, 0);
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]); // no 60 s back-off

  // Recovery on the next poll, and a malformed reply counts as a failed read.
  provider.slot0Fail.clear();
  provider.setSlot0(idOf(30000, 600), "0x");
  await fire();
  state = monitor.getState();
  assert.equal(poolOf(state, 2500).status, "OK");
  assert.equal(poolOf(state, 30000).status, "UNKNOWN");
  assert.match(poolOf(state, 30000).healthError, /32-byte word/);
  assert.equal(state.spreads.length, 1);
  monitor.stop();
});

test("the swap block's read failing or returning null marks that pool UNKNOWN; the latest block failing is the 60 s retry", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block - 10);
  provider.addSwap(2500, 25, -292902, provider.block - 20);
  provider.blockFail.add(provider.block - 10);
  const { monitor, timers, fire } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, E.USDG);
  let state = monitor.getState();
  assert.equal(poolOf(state, 3000).status, "UNKNOWN");
  assert.match(poolOf(state, 3000).healthError, /swap block read failed/);
  assert.equal(poolOf(state, 3000).elapsedSeconds, null);
  assert.equal(poolOf(state, 2500).status, "OK");
  assert.equal(state.lastError, null);
  provider.blockFail.clear();

  const realHandle = provider.handle.bind(provider);
  provider.handle = (method, params) => (method === "eth_getBlockByNumber" && params[0] !== "latest" ? null : realHandle(method, params));
  await fire();
  state = monitor.getState();
  assert.equal(poolOf(state, 2500).status, "UNKNOWN");
  assert.match(poolOf(state, 2500).healthError, /no block/);
  assert.equal(state.lastError, null);

  provider.handle = (method, params) => (method === "eth_getBlockByNumber" ? null : realHandle(method, params));
  await fire();
  assert.match(monitor.getState().lastError, /no block for latest/);
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  provider.handle = realHandle;
  await fire();
  assert.equal(monitor.getState().lastError, null);
  assert.equal(poolOf(monitor.getState(), 3000).status, "OK");
  monitor.stop();
});

test("a clock mismatch between RPC nodes never gives a negative elapsed time", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block, { ageSeconds: -5 });
  const { monitor } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, E.USDG);
  assert.equal(poolOf(monitor.getState(), 3000).elapsedSeconds, 0);
  monitor.stop();
});

test("a poll still in flight when the pair changes never writes the old pair's pools into the new state", async () => {
  const provider = new MockWallet();
  const third = "0x1111111111111111111111111111111111111111";
  provider.tokens.set(third, ["FOO", 8]);
  provider.addSwap(3000, 60, -292916);
  const { monitor } = monitorWithFakeTimers(provider);
  await monitor.start(E.PONS, E.USDG);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.beforeRpc = async (body) => { if (body.method === "eth_getLogs") { provider.beforeRpc = null; await gate; } };
  const old = monitor.pollOnce();
  await new Promise((resolve) => setImmediate(resolve));
  await monitor.start(E.PONS, third);
  assert.equal(monitor.getState().pair.symbolB, "FOO");
  const polls = monitor.getState().polls;
  release();
  await old;
  assert.equal(monitor.getState().pair.symbolB, "FOO");
  assert.equal(monitor.getState().polls, polls);
  assert.equal(monitor.getState().pools.filter((p) => p.active).length, 0);
  monitor.stop();
});

// ------------------------------------------------------------------ wallet client: pairs, balances, transfers

const client = (provider) => E.createWalletClient(provider, { pollIntervalMs: 0 });

test("prepareSwap takes the selected pools and the pair's symbols; refuses the same pool twice or mixed pairs", async () => {
  const provider = new MockWallet();
  const wallet = client(provider);
  await wallet.connect();
  const pair = { currency0: E.PONS, currency1: E.USDG, symbol0: "PONS", symbol1: "USDG" };
  await assert.rejects(wallet.prepareSwap({ usdgIn: 10000, ponsAmount: 1, minUsdgOut: 0, buyPool: key(3000, 60), sellPool: key(2500, 25), pair }),
    /USDG Permit2 allowance/);
  await wallet.approveBothPermit2(1e6, ethers.utils.parseUnits("1", 18), provider.now + 86400, pair);
  assert.equal(provider.sent.length, 2);
  const buyPool = key(3000, 60);
  const sellPool = key(2500, 25);
  const prepared = await wallet.prepareSwap({ usdgIn: 10000, ponsAmount: "52096879755458694", minUsdgOut: 0, buyPool, sellPool, pair });
  assert.equal(prepared.transaction.data, E.buildCalldata({ recipient: CALLER, usdgIn: 10000, ponsAmount: "52096879755458694", minUsdgOut: 0,
    buyPool, sellPool, deadline: prepared.deadline }));
  assert.equal(prepared.buyPool.fee, 3000);
  assert.equal(prepared.sellPool.fee, 2500);
  assert.equal(prepared.pair.symbol1, "USDG");
  await assert.rejects(wallet.prepareSwap({ usdgIn: 10000, ponsAmount: 1, minUsdgOut: 0, buyPool, sellPool: buyPool }), /same pool/);
  await assert.rejects(wallet.prepareSwap({ usdgIn: 10000, ponsAmount: 1, minUsdgOut: 0, buyPool,
    sellPool: { currency0: E.PONS, currency1: OTHER, fee: 3000, tickSpacing: 60 } }), /same pair/);
  // Default pools are still POOL_A / POOL_B, as before.
  const legacy = await wallet.prepareSwap({ usdgIn: 10000, ponsAmount: "52096879755458694", minUsdgOut: 0 });
  assert.equal(legacy.transaction.data, E.buildCalldata({ recipient: CALLER, usdgIn: 10000, ponsAmount: "52096879755458694", minUsdgOut: 0,
    deadline: legacy.deadline }));
  const receipt = await wallet.sendSwap(legacy);
  assert.equal(receipt.status, "0x1");
});

test("approveBothPermit2 for another pair approves currency1 then currency0 with the pair's symbols", async () => {
  const provider = new MockWallet();
  provider.tokens.set(OTHER.toLowerCase(), ["FOO", 8]);
  provider.tokenAllowances.set(OTHER.toLowerCase(), E.MAX_UINT256);
  const messages = [];
  const wallet = E.createWalletClient(provider, { pollIntervalMs: 0, onStatus: (m) => messages.push(m) });
  await wallet.connect();
  const sorted = E.sortPair(E.PONS, OTHER);
  const pair = { ...sorted, symbol0: sorted.currency0 === ethers.utils.getAddress(E.PONS) ? "PONS" : "FOO",
    symbol1: sorted.currency1 === ethers.utils.getAddress(E.PONS) ? "PONS" : "FOO" };
  await wallet.approveBothPermit2(100, 200, provider.now + 86400, pair);
  assert.equal(provider.sent.length, 2);
  const first = require("./mock-wallet.js").permit.decodeFunctionData("approve", provider.sent[0].data);
  assert.equal(first.token, pair.currency1);
  assert.ok(first.amount.eq(100));
  assert.match(messages[0], new RegExp(pair.symbol1 + " Permit2 approval submitted"));
  assert.match(messages[3], new RegExp(pair.symbol0 + " Permit2 approval confirmed"));
  await assert.rejects(wallet.approveBothPermit2(1, 1, provider.now + 86400, { currency0: E.USDG, currency1: E.PONS }), /sort below/);
  await wallet.checkAllowances(100, 200, provider.now + 1200, pair);
  await assert.rejects(wallet.checkAllowances(101, 200, provider.now + 1200, pair), new RegExp(pair.symbol1 + " Permit2 allowance"));
});

test("readBalances returns ETH and token balances for the connected or a named account", async () => {
  const provider = new MockWallet();
  const wallet = client(provider);
  await assert.rejects(wallet.readBalances([E.PONS]), /connect again/);
  await wallet.connect();
  const balances = await wallet.readBalances([E.PONS, E.USDG]);
  assert.equal(balances.account, CALLER);
  assert.equal(ethers.utils.formatEther(balances.eth), "0.2");
  assert.equal(ethers.utils.formatUnits(balances.tokens[0], 18), "1.5");
  assert.equal(ethers.utils.formatUnits(balances.tokens[1], 6), "25.0");
  assert.equal((await wallet.readBalances([E.PONS], OTHER)).tokens[0].toString(), "0");
  await assert.rejects(wallet.readBalances([OTHER]), /reverted|balanceOf/);
  assert.equal(provider.sent.length, 0);
});

test("transferAllToken sends the whole balance to the new wallet and confirms with the hash", async () => {
  const provider = new MockWallet();
  const wallet = client(provider);
  await wallet.connect();
  const result = await wallet.transferAllToken(E.PONS, OTHER);
  assert.equal(provider.sent.length, 1);
  const tx = provider.sent[0];
  assert.equal(tx.to, ethers.utils.getAddress(E.PONS));
  assert.equal(tx.from, CALLER);
  assert.equal(tx.value, "0x0");
  const decoded = erc20.decodeFunctionData("transfer", tx.data);
  assert.equal(decoded.to, OTHER);
  assert.equal(ethers.utils.formatUnits(decoded.amount, 18), "1.5");
  assert.equal(result.hash, ethers.utils.hexZeroPad("0x01", 32));
  assert.equal(result.amount.toString(), ethers.utils.parseUnits("1.5", 18).toString());
  assert.equal(provider.balance(CALLER, E.PONS).toString(), "0");
  assert.equal(provider.balance(OTHER, E.PONS).toString(), ethers.utils.parseUnits("1.5", 18).toString());
  // Works for whatever token is given, not only PONS/USDG.
  const third = "0x1111111111111111111111111111111111111111";
  provider.tokens.set(third, ["THIRD", 0]);
  provider.setBalance(CALLER, third, 7);
  await wallet.transferAllToken(third, OTHER);
  assert.equal(provider.balance(OTHER, third).toString(), "7");
  // Nothing left: no transaction is requested.
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), /Nothing to transfer/);
  assert.equal(provider.sent.length, 2);
});

test("transferAllToken refuses self, zero, malformed and codeless targets; reports rejection and reverts", async () => {
  const provider = new MockWallet();
  const wallet = client(provider);
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), /connect again/);
  await wallet.connect();
  await assert.rejects(wallet.transferAllToken(E.PONS, CALLER), /differ from the connected account/);
  await assert.rejects(wallet.transferAllToken(E.PONS, ethers.constants.AddressZero), /zero address/);
  await assert.rejects(wallet.transferAllToken(E.PONS, "0xabc"), /invalid address/);
  await assert.rejects(wallet.transferAllToken(OTHER, "0x2222222222222222222222222222222222222222"), /reverted|balanceOf/);
  provider.code = "0x";
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), /No contract code/);
  provider.code = "0x60006000";
  assert.equal(provider.sent.length, 0);
  provider.rejectSend = 1;
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), { code: 4001 });
  provider.rejectSend = 0;
  provider.failReceipt = 1;
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), /reverted/);
  assert.equal(provider.balance(CALLER, E.PONS).toString(), ethers.utils.parseUnits("1.5", 18).toString());
  provider.failReceipt = 0;
  provider.chain = "0x1";
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), /4663/);
});

test("transferAllEth sends the balance minus a gas reserve with explicit gas settings", async () => {
  const provider = new MockWallet();
  const wallet = client(provider);
  await wallet.connect();
  const before = provider.ethBalance(CALLER);
  const reserve = provider.gasEstimate.mul(provider.gasPrice).mul(2);
  const result = await wallet.transferAllEth(OTHER);
  const tx = provider.sent[0];
  assert.equal(tx.to, OTHER);
  assert.ok(ethers.BigNumber.from(tx.value).eq(before.sub(reserve)));
  assert.ok(ethers.BigNumber.from(tx.gas).eq(provider.gasEstimate));
  assert.ok(ethers.BigNumber.from(tx.gasPrice).eq(provider.gasPrice));
  assert.equal(tx.data, undefined);
  assert.ok(result.amount.eq(before.sub(reserve)));
  assert.ok(result.reserve.eq(reserve));
  assert.ok(provider.ethBalance(OTHER).eq(before.sub(reserve)));
  assert.ok(provider.ethBalance(CALLER).eq(reserve.div(2))); // the unspent half of the reserve is dust
  await assert.rejects(wallet.transferAllEth(OTHER), /does not cover the gas reserve/);
  provider.gasPrice = ethers.BigNumber.from(0);
  provider.ethBalances.set(CALLER.toLowerCase(), ethers.utils.parseEther("1"));
  await assert.rejects(wallet.transferAllEth(OTHER), /zero/);
  await assert.rejects(wallet.transferAllEth(CALLER), /differ/);
  assert.equal(provider.sent.length, 1);
});

test("a receipt that never arrives rejects with the pending hash so the page can block auto mode", async () => {
  const provider = new MockWallet();
  provider.neverMine = true;
  const wallet = E.createWalletClient(provider, { pollIntervalMs: 1, receiptTimeoutMs: 10 });
  await wallet.connect();
  await assert.rejects(wallet.transferAllToken(E.PONS, OTHER), (error) => {
    assert.match(error.message, /may still be pending/);
    assert.equal(error.pendingHash, ethers.utils.hexZeroPad("0x01", 32));
    return true;
  });
});
