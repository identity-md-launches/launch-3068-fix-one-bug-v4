"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { CALLER, OTHER } = require("./mock-wallet.js");
const { V3Mock, route, v4Row, factory, v3, token, poolA, poolB, decodePath } = require("./v3-mock.js");
const abi = ethers.utils.defaultAbiCoder;
const bn = ethers.BigNumber.from;
const lower = a => a.toLowerCase();
const rpc = p => E.createRpcClient(E.RPC_URL, p.fetch).request;
const discoveredCalls = p => p.rpcCalls.filter(c => c.method === "eth_call" && lower(c.params[0].to || "") === lower(E.V3_FACTORY));

function monitorFor(p, options = {}) {
  const timers = [];
  const context = vm.createContext({ console, atob, btoa,
    setTimeout: (fn, ms) => { const timer = { fn, ms }; timers.push(timer); return timer; },
    clearTimeout: timer => { const i = timers.indexOf(timer); if (i >= 0) timers.splice(i, 1); } });
  for (const file of ["../vendor/ethers-5.7.2.umd.min.js", "../v4-arb-encoder.js"]) vm.runInContext(fs.readFileSync(require.resolve(file), "utf8"), context);
  const monitor = context.V4ArbEncoder.createPoolMonitor({ ...E.createRpcClient(E.RPC_URL, p.fetch), ...options });
  return { monitor, timers, fire: async () => { const due = timers.splice(0); for (const timer of due) await timer.fn(); } };
}

async function client(p, options = {}) {
  const wallet = E.createWalletClient(p, { pollIntervalMs: 0, receiptTimeoutMs: 2000, ...options });
  await wallet.connect();
  return wallet;
}

test("V3 discovery sorts by BigInt, queries all four fees once, and excludes zero addresses", async () => {
  const p = new V3Mock();
  const pools = await E.discoverV3Pools(rpc(p), E.USDG, E.PONS);
  assert.deepEqual(pools.map(p => p.fee), [3000, 10000]);
  assert.deepEqual(pools.map(p => p.address), [poolA, poolB]);
  assert.deepEqual(discoveredCalls(p).map(c => factory.decodeFunctionData("getPool", c.params[0].data)[2]), [100, 500, 3000, 10000]);
  await assert.rejects(E.discoverV3Pools(async () => "0x", E.PONS, E.USDG));
  await assert.rejects(E.discoverV3Pools(rpc(p), E.PONS, E.PONS), /different/);
});

test("V3 swap ABI puts signed tick in data word five; same-block index and removed logs are handled", () => {
  const p = new V3Mock();
  const log = p.addV3Swap(3000, -292916, 100);
  p.addV3Swap(3000, -292000, 100);
  p.addV3Swap(3000, -293000, 99);
  p.addV3Swap(10000, 0, 110).removed = true;
  assert.equal(E.V3_SWAP_TOPIC, "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67");
  assert.equal(E.decodeV3SwapLog(log).tick, -292916);
  const rows = E.summariseV3Pools([p.row(), p.row(10000)], p.v3Logs);
  assert.equal(rows[0].tick, -292000);
  assert.equal(rows[0].swaps, 3);
  assert.equal(rows[0].price, Math.pow(1.0001, -292000));
  assert.equal(rows[1].active, false);
  assert.throws(() => E.decodeV3SwapLog({ ...log, data: log.data + "00".repeat(64) }), /not a V3/);
  assert.throws(() => E.decodeV3SwapLog({ ...log, topics: [E.SWAP_TOPIC] }), /not a V3/);
  assert.deepEqual([100, 500, 3000, 10000].map(E.formatV3Fee), ["0.01%", "0.05%", "0.30%", "1.00%"]);
});

test("V3-only poll uses one address-array log request, one liquidity read per active pool and shared health rules", async () => {
  const p = new V3Mock();
  p.addV3Swap(3000, -292916, p.block - 1, 8000);
  p.addV3Swap(10000, -292000, p.block, 0);
  const { monitor, timers, fire } = monitorFor(p);
  await monitor.start(E.PONS, E.USDG, "V3");
  assert.equal(monitor.getState().pools.length, 2);
  assert.equal(monitor.getState().pools[0].status, "STALE");
  assert.equal(monitor.getState().pools[1].status, "OK");
  assert.equal(monitor.getState().spreads.length, 0);
  assert.deepEqual(timers.map(t => t.ms), [30000]);
  const logs = p.rpcCalls.filter(c => c.method === "eth_getLogs");
  assert.equal(logs.length, 1);
  assert.deepEqual(logs[0].params[0].address, [poolA, poolB]);
  assert.equal(p.rpcCalls.filter(c => c.method === "eth_call" && c.params[0].data === "0x1a686502").length, 2);
  assert.equal(p.rpcCalls.filter(c => c.method === "eth_call" && lower(c.params[0].to || "") === lower(E.POOL_MANAGER)).length, 0);
  p.v3Liquidity.set(lower(poolB), bn(0));
  await fire();
  assert.equal(monitor.getState().pools[1].status, "EMPTY");
  p.liquidityFailures.add(lower(poolB));
  await fire();
  assert.equal(monitor.getState().pools[1].status, "UNKNOWN");
  assert.deepEqual(timers.map(t => t.ms), [30000]);
  p.liquidityFailures.clear(); p.v3Liquidity.set(lower(poolB), bn(200));
  await fire();
  assert.equal(monitor.getState().pools[1].status, "OK");
  assert.equal(discoveredCalls(p).length, 4);
  monitor.stop();
});

test("Both shares one block window, includes every protocol combination, and caches discovery across retry", async () => {
  const p = new V3Mock();
  p.addV3Swap(3000, -292916); p.addV3Swap(10000, -292000);
  p.addSwap(3000, 60, -292500); p.addSwap(500, 10, -293000);
  let windowBlocks = 3000;
  const { monitor, timers, fire } = monitorFor(p, { windowBlocks: () => windowBlocks });
  await monitor.start(E.PONS, E.USDG, "Both");
  assert.equal(monitor.getState().pools.length, 9);
  assert.equal(monitor.getState().spreads.length, 6);
  const logs = p.rpcCalls.filter(c => c.method === "eth_getLogs");
  assert.equal(logs.length, 2);
  assert.equal(logs[0].params[0].fromBlock, logs[1].params[0].fromBlock);
  assert.equal(logs[0].params[0].toBlock, logs[1].params[0].toBlock);
  // One head read during initialization, one in the poll's first batch.
  assert.equal(p.rpcCalls.filter(c => c.method === "eth_getBlockByNumber" && c.params[0] === "latest").length, 2);
  assert.deepEqual(p.httpCalls.map(call => call.body.length), [9, 3, 8]);
  const good = monitor.getState().pools;
  const original = p.handle.bind(p);
  p.handle = (method, params) => { if (method === "eth_getLogs") throw new Error("log failure"); return original(method, params); };
  await fire();
  assert.equal(monitor.getState().pools, good);
  assert.deepEqual(timers.map(t => t.ms), [60000]);
  p.handle = original; windowBlocks = 50;
  await fire();
  assert.equal(monitor.getState().windowBlocks, 50);
  assert.equal(discoveredCalls(p).length, 4);
  assert.deepEqual(timers.map(t => t.ms), [30000]);
  monitor.stop();
});

test("no V3 pools never sends an empty-address log filter; inactive pools need no liquidity reads", async () => {
  const p = new V3Mock(); p.v3Pools.clear();
  const { monitor } = monitorFor(p);
  await monitor.start(E.PONS, E.USDG, "V3");
  assert.equal(monitor.getState().pools.length, 0);
  assert.equal(p.rpcCalls.filter(c => c.method === "eth_getLogs").length, 0);
  assert.equal(p.rpcCalls.filter(c => c.method === "eth_call" && c.params[0].data === "0x1a686502").length, 0);
  monitor.stop();
});

test("discovery or malformed logs fail closed and use 60-second retry; successful discovery is retained", async () => {
  const p = new V3Mock();
  const original = p.handle.bind(p);
  p.handle = (method, params) => method === "eth_call" && lower(params[0].to || "") === lower(E.V3_FACTORY) ? "0x" : original(method, params);
  const { monitor, timers, fire } = monitorFor(p);
  await monitor.start(E.PONS, E.USDG, "V3");
  assert.ok(monitor.getState().lastError);
  assert.deepEqual(timers.map(t => t.ms), [60000]);
  p.handle = (method, params) => method === "eth_getLogs" ? null : original(method, params);
  await fire();
  assert.match(monitor.getState().lastError, /list/);
  const count = discoveredCalls(p).length;
  p.handle = original;
  await fire();
  assert.equal(monitor.getState().lastError, null);
  assert.equal(discoveredCalls(p).length, count);
  monitor.stop();
});

test("a late discovery response from a previous protocol cannot overwrite the restarted monitor", async () => {
  const p = new V3Mock();
  let release, entered;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  p.beforeRpc = async call => { if (call.params[0]?.to === E.V3_FACTORY) { entered(); await hold; } };
  const { monitor, timers } = monitorFor(p);
  const old = monitor.start(E.PONS, E.USDG, "V3");
  await enteredPromise;
  await monitor.start(E.PONS, E.USDG, "V4");
  release(); await old;
  assert.equal(monitor.getState().protocol, "V4");
  assert.equal(monitor.getState().pools.length, 7);
  assert.equal(timers.length, 1);
  monitor.stop();
});

test("V3 path and deadline calldata independently decode to 66-byte round trip and 43-byte single hop", () => {
  const tokens = [E.USDG, E.PONS, E.USDG];
  const fees = [3000, 10000];
  const path = E.encodeV3Path(tokens, fees);
  assert.equal(ethers.utils.hexDataLength(path), 66);
  assert.equal(path, E.USDG.toLowerCase() + "000bb8" + E.PONS.slice(2).toLowerCase() + "002710" + E.USDG.slice(2).toLowerCase());
  assert.deepEqual(decodePath(path), { tokens: tokens.map(ethers.utils.getAddress), fees });
  assert.equal(ethers.utils.hexDataLength(E.encodeV3Path(tokens.slice(0, 2), [3000])), 43);
  const data = E.buildV3Calldata({ tokens, fees, recipient: CALLER, deadline: 1800001200, amountIn: 10000, amountOutMinimum: 10945 });
  const [deadline, calls] = v3.decodeFunctionData("multicall", data);
  assert.equal(data.slice(0, 10), "0x5ae401dc");
  assert.equal(calls[0].slice(0, 10), "0xb858183f");
  const [params] = v3.decodeFunctionData("exactInput", calls[0]);
  assert.equal(params[0], path); assert.equal(params[1], CALLER);
  assert.equal(params[2].toString(), "10000"); assert.equal(params[3].toString(), "10945");
  assert.equal(deadline.toNumber(), 1800001200);
  assert.throws(() => E.encodeV3Path(tokens, [3000]), /more token/);
  assert.throws(() => E.encodeV3Path([E.PONS, E.PONS], [3000]), /differ/);
  assert.throws(() => E.encodeV3Path(tokens, [3000, 30000]), /fee/);
});

test("V3 quote is wallet-free; zero output, malformed success, RPC failure and partial fills are distinct", async () => {
  const p = new V3Mock();
  const args = { pool: p.row(), zeroForOne: false, amountIn: 10000 };
  assert.equal((await E.quoteV3ExactIn(rpc(p), args)).toString(), "50000000000000000");
  assert.equal(p.calls.length, 0); assert.equal(p.sent.length, 0);
  assert.equal(p.rpcCalls[0].params[0].to, undefined);
  p.quoteZero = true;
  assert.equal((await E.quoteV3ExactIn(rpc(p), args)).toString(), "0");
  p.quoteZero = false; p.quotePartial = true;
  await assert.rejects(E.quoteV3ExactIn(rpc(p), args), /part of the input/);
  p.quotePartial = false; p.badQuoteReply = true;
  await assert.rejects(E.quoteV3ExactIn(rpc(p), args), /expected revert/);
  p.badQuoteReply = false; p.quoteFailure = true;
  await assert.rejects(E.quoteV3ExactIn(rpc(p), args), /RPC unavailable/);
  await assert.rejects(E.quoteV3ExactIn(rpc(p), { ...args, amountIn: 0 }), /non-zero/);
});

test("V3 approval checks only the input token to SwapRouter02, caps at 100x, and skips sufficient allowance", async () => {
  const p = new V3Mock(), wallet = await client(p), args = route(p);
  await wallet.approveRouteV3(args);
  assert.equal(p.sent.length, 1);
  assert.equal(lower(p.sent[0].to), lower(E.USDG));
  const [spender, amount] = token.decodeFunctionData("approve", p.sent[0].data);
  assert.equal(lower(spender), lower(E.V3_ROUTER)); assert.equal(amount.toString(), "1000000");
  await wallet.approveRouteV3(args);
  assert.equal(p.sent.length, 1);
  assert.ok(!p.calls.some(c => c.params?.[0]?.to === E.PERMIT2));
  wallet.destroy();
});

test("V3 allowance changes reset insufficient nonzero approvals and wait for each confirmed receipt", async () => {
  const p = new V3Mock(), wallet = await client(p);
  p.setAllowance(E.USDG, 1);
  p.beforeRequest = call => {
    if (call.method === "eth_sendTransaction" && p.sent.length === 1) assert.equal(p.allowance(E.USDG).toString(), "0");
  };
  await wallet.approveRouteV3(route(p));
  assert.deepEqual(p.sent.map(tx => token.decodeFunctionData("approve", tx.data)[1].toString()), ["0", "1000000"]);
  wallet.destroy();
});

for (const failure of ["reject", "revert", "timeout", "false", "account", "chain"]) {
  test("V3 approval fails safely on " + failure, async () => {
    const p = new V3Mock(), wallet = await client(p, failure === "timeout" ? { receiptTimeoutMs: 50 } : {});
    p.setAllowance(E.USDG, 1);
    if (failure === "reject") p.rejectSend = 1;
    if (failure === "revert") p.failReceipt = 1;
    if (failure === "timeout") p.neverMine = true;
    if (failure === "false") p.approveFalse = true;
    if (failure === "account" || failure === "chain") p.beforeRequest = call => {
      if (call.method === "eth_getTransactionReceipt") {
        if (failure === "account") p.account = OTHER; else p.chain = "0x1";
      }
    };
    await assert.rejects(wallet.approveRouteV3(route(p)));
    assert.ok(p.sent.length <= 1); // never prompts for the next approval or a swap
    wallet.destroy();
  });
}

test("V3 atomic route builds one transaction, snapshots amounts, simulates again, and cannot be replayed", async () => {
  const p = new V3Mock(), wallet = await client(p), args = route(p);
  p.setAllowance(E.USDG, 1000000);
  const preparing = wallet.prepareRoute(args);
  args.usdgIn = bn(999999); args.buy.fee = 100;
  const prepared = await preparing;
  assert.equal(prepared.transactions.length, 1);
  assert.equal(prepared.deadline, p.now + 1200);
  assert.equal(prepared.route.usdgIn.toString(), "10000");
  assert.equal(prepared.route.buy.fee, 3000);
  const receipt = await wallet.sendRoute(prepared);
  assert.equal(receipt.status, "0x1");
  assert.equal(p.sent.length, 1); assert.equal(lower(p.sent[0].to), lower(E.V3_ROUTER));
  assert.equal(p.calls.filter(c => c.method === "eth_call" && lower(c.params[0].to || "") === lower(E.V3_ROUTER)).length, 2);
  await assert.rejects(wallet.sendRoute(prepared), /dry run/);
  wallet.destroy();
});

for (const failure of ["allowance", "deadline", "simulation", "account", "chain", "factory", "rejected signature", "receipt"]) {
  test("V3 send blocks or reports " + failure + " without a retry", async () => {
    const p = new V3Mock(), wallet = await client(p);
    p.setAllowance(E.USDG, 1000000);
    if (failure === "factory") {
      const args = route(p); args.buy.address = OTHER;
      await assert.rejects(wallet.prepareRoute(args), /factory/); wallet.destroy(); return;
    }
    const prepared = await wallet.prepareRoute(route(p));
    if (failure === "allowance") p.setAllowance(E.USDG, 0);
    if (failure === "deadline") p.now += 1200;
    if (failure === "simulation") p.failSimulation = true;
    if (failure === "account") p.account = OTHER;
    if (failure === "chain") p.chain = "0x1";
    if (failure === "rejected signature") p.rejectSend = 1;
    if (failure === "receipt") p.failReceipt = 1;
    await assert.rejects(wallet.sendRoute(prepared));
    assert.equal(p.sent.length, failure === "receipt" ? 1 : 0);
    await assert.rejects(wallet.sendRoute(prepared), /dry run/);
    wallet.destroy();
  });
}

for (const v3First of [true, false]) {
  test("mixed route buys then sells with " + (v3First ? "V3" : "V4") + " first; leg 2 waits for receipt and spends only bridge amount", async () => {
    const p = new V3Mock(), wallet = await client(p);
    const args = route(p, v3First ? p.row() : v4Row(), v3First ? v4Row() : p.row());
    p.setBalance(CALLER, E.PONS, 0);
    p.setAllowance(v3First ? E.USDG : E.PONS, v3First ? 10000 : args.ponsAmount);
    p.setPermit(v3First ? E.PONS : E.USDG, v3First ? args.ponsAmount : 10000);
    const prepared = await wallet.prepareRoute(args);
    assert.equal(prepared.transactions.length, 2);
    assert.equal(p.calls.filter(c => c.method === "eth_call" && c.params[0].data === prepared.transactions[1].data).length, 0);
    p.beforeRequest = call => {
      if (call.method === "eth_sendTransaction" && p.sent.length === 1) {
        assert.ok([...p.pending.values()][0].mined, "leg 1 must be mined first");
        assert.ok(p.balance(CALLER, E.PONS).gte(args.ponsAmount));
      }
    };
    const receipt = await wallet.sendRoute(prepared);
    assert.ok(receipt.firstLegHash);
    assert.deepEqual(p.sent.map(tx => lower(tx.to)), v3First ? [lower(E.V3_ROUTER), lower(E.ROUTER)] : [lower(E.ROUTER), lower(E.V3_ROUTER)]);
    assert.equal(p.balance(CALLER, E.PONS).toString(), "250000000000000"); // extra 0.5% remains in wallet
    wallet.destroy();
  });
}

for (const failure of ["first revert", "first timeout", "second rejection", "second revert", "second simulation", "balance", "deadline", "account", "allowance"]) {
  test("mixed route stops safely on " + failure + " and identifies a confirmed first leg", async () => {
    const p = new V3Mock(), wallet = await client(p, failure === "first timeout" ? { receiptTimeoutMs: 50 } : {}), args = route(p, p.row(), v4Row());
    p.setAllowance(E.USDG, 10000); p.setPermit(E.PONS, args.ponsAmount);
    const prepared = await wallet.prepareRoute(args);
    if (failure === "first revert") p.failReceipt = 1;
    if (failure === "first timeout") p.neverMine = true;
    if (failure === "second rejection") p.rejectSend = 2;
    if (failure === "second revert") p.failReceipt = 2;
    if (failure === "balance") p.skipBridgeCredit = true;
    p.afterSwap = () => {
      if (failure === "second simulation") p.failSimulation = true;
      if (failure === "deadline") p.now += 1200;
      if (failure === "account") p.account = OTHER;
      if (failure === "allowance") p.setPermit(E.PONS, 0);
    };
    let error;
    try { await wallet.sendRoute(prepared); } catch (caught) { error = caught; }
    assert.ok(error, "must fail");
    if (!failure.startsWith("first") && failure !== "account") {
      assert.ok(error.firstLegHash); assert.match(error.message, /Leg 1 confirmed/);
    }
    assert.equal(p.sent.length, failure === "second revert" ? 2 : 1);
    wallet.destroy();
  });
}

test("auto mode skips higher mixed spreads and selects the best eligible atomic route", () => {
  const p = new V3Mock();
  const a = { ...p.row(), price: 1 }, b = { ...p.row(10000), price: 1.1 };
  const c = { ...v4Row(), active: true, status: "OK", price: 2 };
  assert.equal(E.rankSpreads([a, b, c], 0, Infinity)[0].sell, c);
  const decision = E.protocolAutoDecision([a, b, c], 0);
  assert.equal(decision.spread.buy, a); assert.equal(decision.spread.sell, b);
  assert.equal(E.protocolAutoDecision([a, c], 0).spread, null);
  b.status = "EMPTY";
  assert.equal(E.protocolAutoDecision([a, b, c], 0).spread, null);
});

test("initial V3 preparation refuses missing allowances, code, zero minimum, and mismatched pairs", async () => {
  const p = new V3Mock(), wallet = await client(p);
  await assert.rejects(wallet.prepareRoute(route(p)), /allowance/);
  p.setAllowance(E.USDG, 1000000); p.code = "0x";
  await assert.rejects(wallet.prepareRoute(route(p)), /No contract code/);
  p.code = "0x6000";
  await assert.rejects(wallet.prepareRoute({ ...route(p), minUsdgOut: 0 }), /minimum return/);
  const args = route(p); args.sell.currency1 = OTHER;
  await assert.rejects(wallet.prepareRoute(args), /same pair/);
  assert.equal(p.sent.length, 0);
  await assert.rejects(wallet.sendRoute({}), /dry run/);
  wallet.destroy();
});

test("mixed approval requests only the V4 input token's Permit2 limit and the V3 input token's direct limit", async () => {
  const p = new V3Mock(), wallet = await client(p);
  const args = route(p, v4Row(), p.row());
  await wallet.approveRouteV3(args);
  assert.equal(lower(p.sent[0].to), lower(E.PONS));
  assert.equal(p.allowance(E.PONS).toString(), args.ponsAmount.mul(100).toString());
  await wallet.approveRoutePermit2(args, p.now + 30 * 86400);
  assert.equal(p.sent.length, 2);
  assert.equal(lower(p.sent[1].to), lower(E.PERMIT2));
  assert.equal(p.readPermit(CALLER, E.USDG)[0].toString(), "1000000");
  assert.equal(p.readPermit(CALLER, E.PONS)[0].toString(), "0");
  await wallet.approveRoutePermit2(args, p.now + 30 * 86400);
  assert.equal(p.sent.length, 2);
  wallet.destroy();
});

test("mixed session interruption after submission retains the unknown first-leg hash and stops", async () => {
  const p = new V3Mock(), wallet = await client(p), args = route(p, p.row(), v4Row());
  p.setAllowance(E.USDG, 10000); p.setPermit(E.PONS, args.ponsAmount);
  const prepared = await wallet.prepareRoute(args);
  p.beforeRequest = call => { if (call.method === "eth_getTransactionReceipt") p.emit("accountsChanged", [OTHER]); };
  let error;
  try { await wallet.sendRoute(prepared); } catch (caught) { error = caught; }
  assert.ok(error.pendingHash);
  assert.match(error.message, /Leg 1 submitted.*confirmation was interrupted/);
  assert.equal(p.sent.length, 1);
  wallet.destroy();
});

test("mixed second-leg receipt timeout retains both the confirmed first hash and pending second hash", async () => {
  const p = new V3Mock(), wallet = await client(p, { receiptTimeoutMs: 50 }), args = route(p, p.row(), v4Row());
  p.pendingPolls = 0;
  p.setAllowance(E.USDG, 10000); p.setPermit(E.PONS, args.ponsAmount);
  const prepared = await wallet.prepareRoute(args);
  p.beforeRequest = call => { if (call.method === "eth_sendTransaction" && p.sent.length === 1) p.neverMine = true; };
  let error;
  try { await wallet.sendRoute(prepared); } catch (caught) { error = caught; }
  assert.ok(error.firstLegHash); assert.ok(error.pendingHash);
  assert.notEqual(error.firstLegHash, error.pendingHash);
  assert.equal(p.sent.length, 2);
  assert.match(error.message, /Leg 1 confirmed.*Leg 2 did not confirm/);
  wallet.destroy();
});
