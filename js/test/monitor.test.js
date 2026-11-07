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
  assert.equal(state.fromBlock, provider.block - 99);
  assert.equal(state.lastError, null);
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  const logsCall = provider.rpcCalls.find((c) => c.method === "eth_getLogs");
  assert.equal(logsCall.params[0].address, E.POOL_MANAGER);
  assert.equal(logsCall.params[0].topics[0], E.SWAP_TOPIC);
  assert.equal(logsCall.params[0].topics[1].length, 7);
  assert.equal(ethers.BigNumber.from(logsCall.params[0].toBlock).sub(logsCall.params[0].fromBlock).toNumber(), 99);
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
