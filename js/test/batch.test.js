"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { MockWallet } = require("./mock-wallet.js");
const { V3Mock, poolB } = require("./v3-mock.js");
const source = fs.readFileSync(require.resolve("../v4-arb-encoder.js"), "utf8");
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const result = (call, value) => ({ jsonrpc: "2.0", id: call.id, result: value });
const failure = (call, message = "execution reverted") => ({ jsonrpc: "2.0", id: call.id,
  error: { code: 3, message, data: "0x12345678" } });
const calls = [{ method: "eth_getBlockByNumber", params: ["latest", false] },
  { method: "eth_getLogs", params: [{}] }, { method: "eth_call", params: [{}, "latest"] }];
const plain = value => JSON.parse(JSON.stringify(value));

// A separate realm for each clock keeps tests independent, including when run in parallel.
function fakeClock() {
  let clock = 0, nextId = 0;
  const timers = new Map();
  const durations = [];
  const context = vm.createContext({ ethers, AbortController,
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: clock + ms }); durations.push(ms); return id; },
    clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  const tick = async ms => {
    clock += ms;
    for (const [id, timer] of timers) if (timer.at <= clock) { timers.delete(id); timer.fn(); }
    await flush();
  };
  return { E: context.V4ArbEncoder, now: () => clock, durations, timers, flush, tick };
}

test("batchRequest posts an array with sequential IDs and matches shuffled results by ID", async () => {
  const posts = [];
  const client = E.createRpcClient(E.RPC_URL, async (url, init) => {
    assert.equal(url, E.RPC_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers["content-type"], "application/json");
    const body = JSON.parse(init.body);
    posts.push(body);
    if (!Array.isArray(body)) return reply(result(body, "single"));
    return reply([result(body[2], "0x01"), result(body[0], { number: "0x64", timestamp: "0x123" }), result(body[1], [])]);
  });
  assert.deepEqual(await client.batchRequest(calls), [{ number: "0x64", timestamp: "0x123" }, [], "0x01"]);
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0], calls.map((call, i) => ({ jsonrpc: "2.0", id: i + 1, ...call })));
  assert.equal(await client.request("eth_call", [{}, "latest"]), "single");
  assert.equal(posts[1].id, 4);
  await client.batchRequest(calls);
  assert.deepEqual(posts[2].map(call => call.id), [5, 6, 7]);
});

test("partial batch reverts retain successful results and preserve error code, message and data", async () => {
  let count = 0;
  const client = E.createRpcClient(E.RPC_URL, async (_, init) => {
    count++;
    const body = JSON.parse(init.body);
    return reply([failure(body[1]), result(body[2], null), result(body[0], "0x123")]);
  });
  const values = await client.batchRequest(calls);
  assert.equal(values[0], "0x123");
  assert.equal(values[2], null);
  assert.match(values[1].error.message, /execution reverted/);
  assert.equal(values[1].error.code, 3);
  assert.equal(values[1].error.data, "0x12345678");
  assert.equal(count, 1);
});

test("missing, duplicate, mismatched and malformed responses fail only the affected IDs", async () => {
  for (const damage of [
    body => [result(body[0], "good"), result({ id: 999 }, "wrong")],
    body => [result(body[0], "good"), result(body[1], "bad"), result(body[1], "duplicate")],
    body => [result(body[0], "good"), { jsonrpc: "2.0", id: body[1].id }],
    body => [result(body[0], "good"), result({ id: String(body[1].id) }, "wrong type"), null],
    body => [result(body[0], "good"), { jsonrpc: "1.0", id: body[1].id, result: "wrong version" }],
  ]) {
    const client = E.createRpcClient(E.RPC_URL, async (_, init) => reply(damage(JSON.parse(init.body))));
    const values = await client.batchRequest(calls);
    assert.equal(values[0], "good");
    assert.ok(values[1].error);
    assert.ok(values[2].error);
  }
});

test("empty batch makes no HTTP request and invalid calls are rejected before posting", async () => {
  const client = E.createRpcClient(E.RPC_URL, () => { throw new Error("must not fetch"); });
  assert.deepEqual(await client.batchRequest([]), []);
  for (const bad of [null, {}, [null], [{}], [{ method: "" }], [{ method: "eth_call", params: "bad" }]]) {
    await assert.rejects(client.batchRequest(bad), /batch/);
  }
});

test("unsupported batches fall back with 500ms gaps, retain partial errors, and remember capability", async () => {
  for (const unsupported of [
    () => reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batching not supported" } }),
    () => reply({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } }, 400),
    body => reply(result(body[0], "only one result")),
    () => reply([{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch disabled" } }]),
  ]) {
    const clock = fakeClock(), posts = [];
    const client = clock.E.createRpcClient(E.RPC_URL, async (_, init) => {
      const body = JSON.parse(init.body);
      posts.push({ body, at: clock.now() });
      if (Array.isArray(body)) return unsupported(body);
      return reply(body.method === "eth_call" ? failure(body) : result(body, body.method));
    });
    const pending = client.batchRequest(calls);
    await clock.flush();
    assert.equal(posts.length, 1);
    await clock.tick(499);
    assert.equal(posts.length, 1, "fallback cannot start before 500ms");
    await clock.tick(1);
    assert.equal(posts.length, 2);
    await clock.tick(500);
    await clock.tick(500);
    const values = await pending;
    assert.equal(values[0], "eth_getBlockByNumber");
    assert.equal(values[1], "eth_getLogs");
    assert.equal(values[2].error.code, 3);
    assert.deepEqual(posts.map(post => post.at), [0, 500, 1000, 1500]);
    // Concurrent phases/polls must share the sequential queue instead of causing bursts.
    const next = client.batchRequest([calls[0]]), concurrent = client.batchRequest([calls[1]]);
    await clock.flush();
    await clock.tick(500);
    assert.deepEqual(plain(await next), ["eth_getBlockByNumber"]);
    await clock.tick(500);
    assert.deepEqual(plain(await concurrent), ["eth_getLogs"]);
    assert.equal(posts.filter(post => Array.isArray(post.body)).length, 1);
    assert.deepEqual(posts.slice(1).map(post => post.at), [500, 1000, 1500, 2000, 2500]);
    assert.equal(new Set(posts.flatMap(post => Array.isArray(post.body) ? post.body.map(call => call.id) : [post.body.id])).size, 8);
    assert.equal(clock.timers.size, 0);
  }
});

test("HTTP throttling, outages, malformed JSON and transport failures do not trigger fallback fan-out", async () => {
  for (const response of [
    () => reply({}, 429), () => reply({}, 503), () => reply({ error: { message: "internal error" } }, 500),
    () => reply({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "rate limited" } }),
    () => reply("not an array"),
    () => ({ ok: true, status: 200, json: async () => { throw new Error("invalid JSON"); } }),
    () => { throw new Error("network failure"); },
  ]) {
    let posts = 0;
    const client = E.createRpcClient(E.RPC_URL, async (_, init) => {
      posts++;
      if (posts === 1) return response();
      return reply(JSON.parse(init.body).map(call => result(call, "recovered")));
    });
    await assert.rejects(client.batchRequest(calls));
    assert.equal(posts, 1);
    assert.deepEqual(await client.batchRequest(calls), ["recovered", "recovered", "recovered"]);
    assert.equal(posts, 2, "a transient failure must not permanently disable batching");
  }
});

test("batch timeout is 30 seconds, aborts, clears its timer and never fans out; singles keep 20 seconds", async () => {
  const clock = fakeClock();
  let posts = 0, signal;
  const client = clock.E.createRpcClient(E.RPC_URL, (_, init) => {
    posts++; signal = init.signal;
    return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  });
  const pending = assert.rejects(client.batchRequest(calls), /aborted/);
  assert.equal(clock.durations.at(-1), 30000);
  await clock.tick(29999);
  assert.equal(signal.aborted, false);
  await clock.tick(1);
  await pending;
  assert.equal(signal.aborted, true);
  assert.equal(posts, 1);
  assert.equal(clock.timers.size, 0);
  const single = assert.rejects(client.request("eth_call", []), /aborted/);
  assert.equal(clock.durations.at(-1), 20000);
  await clock.tick(20000);
  await single;
  assert.equal(clock.timers.size, 0);
});

async function started(t, provider, options = {}) {
  const clock = fakeClock();
  const client = E.createRpcClient(E.RPC_URL, provider.fetch);
  const monitor = clock.E.createPoolMonitor({ ...client, protocol: "Both", ...options });
  t.after(() => monitor.stop());
  await monitor.start(E.PONS, E.USDG);
  assert.equal(monitor.getState().lastError, null);
  return { monitor, clock };
}

test("Both: seven active V4 and two V3 pools use two HTTP POSTs with correct timestamps and health", async t => {
  const p = new V3Mock();
  E.FEE_TIERS.forEach(([fee, spacing], i) => p.addSwap(fee, spacing, -292916 + i, p.block - 10 - i, { ageSeconds: 100 + i }));
  p.addV3Swap(3000, -292900, p.block - 30, 200);
  p.addV3Swap(10000, -292000, p.block - 40, 300);
  const { monitor } = await started(t, p);
  // Setup is one separate batch (metadata + discovery + seed header), only on start/restart.
  assert.deepEqual(p.httpCalls.map(post => post.body.length), [9, 3, 18]);
  const before = p.httpCalls.length;
  const state = await monitor.pollOnce();
  const posts = p.httpCalls.slice(before);
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body.map(call => call.method), ["eth_getBlockByNumber", "eth_getLogs", "eth_getLogs"]);
  assert.equal(posts[1].body.length, 18);
  assert.equal(state.pools.length, 9);
  assert.ok(state.pools.every(pool => pool.status === "OK"));
  assert.deepEqual(Array.from(state.pools, pool => pool.elapsedSeconds), [100, 101, 102, 103, 104, 105, 106, 200, 300]);
  assert.equal(state.pools.find(pool => pool.protocol === "V3" && pool.fee === 3000).liquidity.toString(),
    p.v3Liquidity.get(state.pools[7].address.toLowerCase()).toString());
  assert.equal(state.spreads.length, 36);
  assert.equal(p.sent.length, 0);
  assert.equal(p.calls.length, 0);
});

test("empty logs/all inactive pools use only phase 1 and never post an empty batch", async t => {
  for (const protocol of ["V4", "V3", "Both"]) {
    const p = new V3Mock();
    const { monitor } = await started(t, p, { protocol });
    const before = p.httpCalls.length;
    const state = await monitor.pollOnce();
    assert.equal(p.httpCalls.length - before, 1);
    assert.ok(state.pools.every(pool => pool.status === "INACTIVE" && pool.elapsedSeconds === null));
    assert.equal(state.spreads.length, 0);
    assert.ok(p.httpCalls.every(post => Array.isArray(post.body) && post.body.length > 0));
  }
  const p = new V3Mock(); p.v3Pools.clear();
  const { monitor } = await started(t, p, { protocol: "V3" });
  await monitor.pollOnce();
  assert.deepEqual(p.httpCalls.at(-1).body.map(call => call.method), ["eth_getBlockByNumber"]);
  assert.equal(monitor.getState().pools.length, 0);
});

test("phase 2 partial errors mark affected pools UNKNOWN, retain siblings, and recover at 30s", async t => {
  const p = new V3Mock();
  p.addSwap(3000, 60, -292916, p.block - 10);
  p.addSwap(2500, 25, -292902, p.block - 20);
  p.addV3Swap(3000, -292900, p.block - 30);
  p.addV3Swap(10000, -292000, p.block - 40);
  const { monitor, clock } = await started(t, p);
  p.blockFail.add(p.block - 10);
  p.liquidityFailures.add(poolB.toLowerCase());
  await clock.tick(30000);
  const state = monitor.getState();
  assert.equal(state.lastError, null);
  assert.equal(state.errors, 0);
  assert.equal(state.pools.filter(pool => pool.status === "UNKNOWN").length, 2);
  assert.equal(state.pools.filter(pool => pool.status === "OK").length, 2);
  assert.equal(state.spreads.length, 1);
  assert.equal(state.nextPollMs, 30000);
  p.blockFail.clear(); p.liquidityFailures.clear();
  await clock.tick(30000);
  assert.equal(state.pools.filter(pool => pool.status === "OK").length, 4);
});

test("phase 1 failure preserves the last table, makes one POST, then retries in 60s", async t => {
  const p = new V3Mock(); p.addSwap(3000, 60, -292916);
  const { monitor, clock } = await started(t, p);
  const good = monitor.getState().pools, before = p.httpCalls.length;
  const handle = p.handle.bind(p);
  p.handle = (method, params) => {
    if (method === "eth_getLogs" && Array.isArray(params[0].address)) throw new Error("V3 log failure");
    return handle(method, params);
  };
  await clock.tick(30000);
  assert.match(monitor.getState().lastError, /V3 log failure/);
  assert.equal(monitor.getState().pools, good);
  assert.equal(p.httpCalls.length - before, 1);
  assert.equal(monitor.getState().nextPollMs, 60000);
  p.handle = handle;
  await clock.tick(59999);
  assert.equal(p.httpCalls.length - before, 1);
  await clock.tick(1);
  assert.equal(monitor.getState().lastError, null);
  assert.equal(monitor.getState().nextPollMs, 30000);
});

test("a phase 2 HTTP failure marks active pools UNKNOWN without retaining old good health", async t => {
  const p = new V3Mock(); p.addSwap(3000, 60, -292916); p.addV3Swap(3000, -292900);
  const fetch = p.fetch;
  let failHealth = false;
  p.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    if (failHealth && body[0].method === "eth_getBlockByNumber" && body[0].params[0] !== "latest") p.httpFailures = 1;
    return fetch(url, init);
  };
  const { monitor } = await started(t, p);
  failHealth = true;
  const before = p.httpCalls.length;
  const state = await monitor.pollOnce();
  assert.equal(p.httpCalls.length - before, 2);
  assert.equal(state.lastError, null);
  assert.ok(state.pools.filter(pool => pool.active).every(pool => pool.status === "UNKNOWN"));
  assert.equal(state.spreads.length, 0);
});

test("advancing heads trim both protocols to the exact live window, including its boundaries", async t => {
  const p = new V3Mock();
  const { monitor } = await started(t, p, { windowBlocks: 50 });
  const prior = p.block;
  p.block += 20;
  for (const block of [prior - 49, p.block - 50, p.block - 49, p.block, p.block + 1]) {
    p.addSwap(3000, 60, -292916 + block - prior, block);
    p.addV3Swap(3000, -292900 + block - prior, block);
  }
  // Model logs completing at a slightly later head than the header, including a future log.
  const handle = p.handle.bind(p);
  p.handle = (method, params) => {
    if (method === "eth_getLogs") {
      const head = p.block; p.block++;
      try { return handle(method, params); } finally { p.block = head; }
    }
    return handle(method, params);
  };
  const before = p.httpCalls.length;
  const state = await monitor.pollOnce();
  assert.equal(p.httpCalls.length - before, 2);
  assert.equal(state.fromBlock, p.block - 49);
  for (const pool of state.pools.filter(pool => pool.active)) {
    assert.equal(pool.swaps, 2);
    assert.equal(pool.lastBlock, p.block);
  }
});

test("a 50000-block window survives head advances with disjoint log filters in the same POST", async t => {
  const p = new MockWallet();
  const { monitor } = await started(t, p, { protocol: "V4", windowBlocks: 50000 });
  p.block += 300;
  [p.block - 50000, p.block - 49999, p.block - 25000, p.block].forEach(block => p.addSwap(3000, 60, -292916, block));
  const before = p.httpCalls.length;
  const state = await monitor.pollOnce();
  assert.equal(state.lastError, null);
  assert.equal(state.pools.find(pool => pool.fee === 3000).swaps, 3);
  assert.equal(p.httpCalls.length - before, 2);
  const filters = p.httpCalls[before].body.slice(1).map(call => call.params[0]);
  assert.equal(filters.length, 2);
  assert.equal(Number(filters[0].toBlock) + 1, Number(filters[1].fromBlock));
  assert.equal(filters[1].toBlock, "latest");
});

test("a backwards head fails closed and refreshes the range for the next scheduled retry", async t => {
  const p = new MockWallet();
  const { monitor, clock } = await started(t, p, { protocol: "V4", windowBlocks: 50 });
  p.block -= 100;
  p.addSwap(3000, 60, -292916, p.block - 49);
  await clock.tick(30000);
  assert.match(monitor.getState().lastError, /moved backwards/);
  assert.equal(monitor.getState().scanHead, p.block);
  await clock.tick(60000);
  assert.equal(monitor.getState().lastError, null);
  assert.equal(monitor.getState().pools.find(pool => pool.fee === 3000).swaps, 1);
});

test("the full monitor works on a non-batching RPC with 500ms gaps across initialization and both phases", async t => {
  const clock = fakeClock(), p = new V3Mock(), posts = [];
  p.addSwap(3000, 60, -292916, p.block - 10);
  p.addV3Swap(3000, -292900, p.block - 20);
  const client = clock.E.createRpcClient(E.RPC_URL, async (url, init) => {
    const body = JSON.parse(init.body);
    posts.push({ at: clock.now(), body });
    if (Array.isArray(body)) return reply({ jsonrpc: "2.0", id: null,
      error: { code: -32600, message: "batching not supported" } });
    return p.fetch(url, init);
  });
  const monitor = clock.E.createPoolMonitor({ ...client, protocol: "Both" });
  t.after(() => monitor.stop());
  const complete = async pending => {
    let settled = false;
    pending.then(() => { settled = true; });
    await clock.flush();
    for (let i = 0; i < 30 && !settled; i++) await clock.tick(500);
    assert.equal(settled, true, "fallback cycle completes in the bounded virtual time");
    await pending;
  };
  await complete(monitor.start(E.PONS, E.USDG));
  assert.equal(monitor.getState().lastError, null);
  assert.equal(monitor.getState().pools.filter(pool => pool.status === "OK").length, 2);
  assert.equal(posts.length, 17); // one rejected batch + 9 setup + 3 phase 1 + 4 phase 2
  const before = posts.length;
  p.blockFail.add(p.block - 10);
  await complete(monitor.pollOnce());
  assert.equal(posts.length - before, 7);
  assert.equal(monitor.getState().pools.filter(pool => pool.status === "OK").length, 1);
  assert.equal(monitor.getState().pools.filter(pool => pool.status === "UNKNOWN").length, 1);
  assert.ok(posts.slice(1).every((post, i) => !Array.isArray(post.body) && post.at - posts[i].at >= 500));
  assert.equal(p.sent.length, 0);
});

test("missing batch replies cause phase 1 retry or phase 2 UNKNOWN, never false success", async t => {
  const p = new V3Mock(); p.addSwap(3000, 60, -292916); p.addV3Swap(3000, -292900);
  const fetch = p.fetch;
  let drop = null;
  p.fetch = async (url, init) => {
    const calls = JSON.parse(init.body);
    const response = await fetch(url, init);
    const body = await response.json();
    const missing = calls.find(call => drop && drop(call));
    return reply(missing ? body.filter(entry => entry.id !== missing.id) : body);
  };
  const { monitor, clock } = await started(t, p);
  drop = call => call.method === "eth_call" && call.params[0].to === E.POOL_MANAGER;
  await clock.tick(30000);
  assert.equal(monitor.getState().pools.filter(pool => pool.status === "UNKNOWN").length, 1);
  assert.equal(monitor.getState().pools.filter(pool => pool.status === "OK").length, 1);
  assert.equal(monitor.getState().nextPollMs, 30000);
  drop = call => call.method === "eth_getLogs";
  await clock.tick(30000);
  assert.match(monitor.getState().lastError, /invalid response/);
  assert.equal(monitor.getState().nextPollMs, 60000);
});
