"use strict";

// Optional, read-only integration check; the offline suite never invokes this script.
// Usage: node scripts/verify-batch-live.js [--window=3000]
const assert = require("node:assert/strict");
const { ethers } = require("../js/vendor/ethers-5.7.2.umd.min.js");
const E = require("../js/v4-arb-encoder.js");

(async () => {
  const arg = process.argv.slice(2).find(value => value.startsWith("--window="));
  const windowBlocks = arg ? E.parseWindowBlocks(arg.slice(9)) : E.LOG_WINDOW_BLOCKS;
  assert.ok(windowBlocks, "window must be 50 to 50000 blocks");
  const posts = [];
  const client = E.createRpcClient(E.RPC_URL, async (url, init) => {
    const body = JSON.parse(init.body);
    assert.ok(Array.isArray(body), "polling must use JSON-RPC arrays");
    assert.ok(body.every(call => ["eth_getBlockByNumber", "eth_getLogs", "eth_call"].includes(call.method)), "read-only methods");
    const record = { requests: body, sentAt: new Date().toISOString() };
    posts.push(record);
    const response = await fetch(url, init);
    record.status = response.status;
    return { ok: response.ok, status: response.status, json: async () => {
      record.responses = await response.json();
      return record.responses;
    } };
  });
  const monitor = E.createPoolMonitor({ ...client, windowBlocks, protocol: "Both" });
  try {
    await monitor.start(E.PONS, E.USDG);
    monitor.stop(); // No timer-driven traffic while measuring the next single poll.
    assert.equal(monitor.getState().lastError, null);
    const startupPosts = posts.length;
    const state = await monitor.pollOnce();
    const cycle = posts.slice(startupPosts);
    const active = state.pools.filter(pool => pool.active);
    assert.equal(cycle.length, active.length ? 2 : 1, "HTTP POST count for one poll");
    assert.equal(cycle[0].requests[0].method, "eth_getBlockByNumber");
    assert.deepEqual(cycle[0].requests[0].params, ["latest", false]);
    for (const post of cycle) {
      assert.equal(post.status, 200);
      assert.ok(Array.isArray(post.responses), "RPC supports batch arrays");
      assert.equal(post.responses.length, post.requests.length);
      assert.equal(new Set(post.responses.map(entry => entry.id)).size, post.requests.length);
      for (const call of post.requests) {
        const response = post.responses.find(entry => entry.id === call.id);
        assert.ok(response, "response ID " + call.id);
        assert.equal(response.error, undefined, "live RPC error " + JSON.stringify(response.error));
      }
    }
    const value = (post, call) => post.responses.find(entry => entry.id === call.id).result;
    const logs = cycle[0].requests.filter(call => call.method === "eth_getLogs")
      .flatMap(call => value(cycle[0], call))
      .filter(log => !log.removed && Number(log.blockNumber) >= state.fromBlock && Number(log.blockNumber) <= state.blockNumber);
    // Cross-check table values against the raw batch responses, without extra HTTP requests.
    for (const pool of state.pools) {
      const poolLogs = logs.filter(log => pool.protocol === "V4" ? log.topics[1]?.toLowerCase() === pool.poolId.toLowerCase()
        : log.address.toLowerCase() === pool.address.toLowerCase());
      assert.equal(pool.swaps, poolLogs.length);
      if (!pool.active) { assert.equal(pool.status, "INACTIVE"); continue; }
      const last = poolLogs.sort((a, b) => Number(b.blockNumber) - Number(a.blockNumber) || Number(b.logIndex) - Number(a.logIndex))[0];
      const types = pool.protocol === "V4" ? ["int128", "int128", "uint160", "uint128", "int24", "uint24"]
        : ["int256", "int256", "uint160", "uint128", "int24"];
      const tick = Number(ethers.utils.defaultAbiCoder.decode(types, last.data)[4]);
      assert.equal(pool.tick, tick);
      assert.equal(pool.lastBlock, Number(last.blockNumber));
      assert.equal(pool.displayPrice, Math.pow(1.0001, tick) * Math.pow(10, state.pair.decimals0 - state.pair.decimals1));
      const blockCall = cycle[1].requests.find(call => call.method === "eth_getBlockByNumber" && Number(call.params[0]) === pool.lastBlock);
      const block = value(cycle[1], blockCall);
      assert.equal(pool.swapTimestamp, Number(block.timestamp));
      assert.equal(pool.elapsedSeconds, Math.max(0, state.blockTimestamp - Number(block.timestamp)));
      const healthCall = cycle[1].requests.find(call => call.method === "eth_call" && (pool.protocol === "V4"
        ? call.params[0].data === E.encodeSlot0Call(pool.poolId).data : call.params[0].to.toLowerCase() === pool.address.toLowerCase()));
      const word = ethers.BigNumber.from(value(cycle[1], healthCall));
      assert.equal(pool.empty, (pool.protocol === "V4" ? word.mask(160) : word).isZero());
      assert.notEqual(pool.status, "UNKNOWN");
    }
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), rpc: E.RPC_URL, chainId: E.CHAIN_ID,
      pair: [state.pair.symbol0, state.pair.symbol1], protocol: state.protocol,
      startupHttpPosts: startupPosts, pollHttpPosts: cycle.length,
      batches: cycle.map(post => ({ httpStatus: post.status, calls: post.requests.length,
        methods: post.requests.map(call => call.method), responseIds: post.responses.map(entry => entry.id) })),
      fromBlock: state.fromBlock, blockNumber: state.blockNumber, blockTimestamp: state.blockTimestamp, windowBlocks,
      pools: state.pools.map(pool => ({ protocol: pool.protocol, poolId: pool.poolId, address: pool.address,
        fee: pool.fee, tickSpacing: pool.tickSpacing, swaps: pool.swaps, tick: pool.tick, price: pool.displayPrice,
        lastBlock: pool.lastBlock, swapTimestamp: pool.swapTimestamp, elapsedSeconds: pool.elapsedSeconds,
        liquidity: pool.liquidity?.toString(), empty: pool.empty, status: pool.status })),
      note: "Read-only HTTP batches. Startup includes metadata/discovery plus its first poll; pollHttpPosts measures one subsequent cycle. No quotes, wallet calls, signing, deployments or transactions." }, null, 2));
  } finally { monitor.stop(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
