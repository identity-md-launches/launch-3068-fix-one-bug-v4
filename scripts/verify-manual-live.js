"use strict";

// Optional READ-ONLY check of Manual mode against the live RPC. Never run by the offline test
// suite; sends nothing. Reads the two pools exactly as the page does (token0, token1, fee, slot0,
// one eth_call at a time, no batch, no eth_getLogs) and prints the row the page would show.
// Usage: node scripts/verify-manual-live.js [poolA] [poolB]
const assert = require("node:assert/strict");
const E = require("../js/v4-arb-encoder.js");

(async () => {
  const poolA = process.argv[2] || "0x10cc6bd38112cac182db90b6a71d8bb5939526ba";
  const poolB = process.argv[3] || "0xed50bdeea8adc232f159486192a4157281d722ff";
  const methods = [];
  const client = E.createRpcClient(E.RPC_URL, (url, init) => { methods.push(JSON.parse(init.body)); return fetch(url, init); });
  assert.equal(Number(await client.request("eth_chainId", [])), E.CHAIN_ID);
  const states = [];
  const monitor = E.createManualMonitor({ request: client.request, pollIntervalMs: 0, onUpdate: (state) => states.push(state) });
  await monitor.start(poolA, poolB);
  monitor.stop();
  const state = states[0];
  assert.ok(methods.every((call) => !Array.isArray(call)), "no JSON-RPC batch");
  const used = methods.map((call) => call.method);
  assert.ok(used.every((method) => method === "eth_call" || method === "eth_chainId"), "eth_call only");
  console.log(JSON.stringify({
    rpcCalls: used.filter((method) => method === "eth_call").length, // 8 pool reads + 2 symbol + 2 decimals
    error: state.lastError,
    pair: state.pair && { token0: state.pair.currency0, symbol0: state.pair.symbol0, token1: state.pair.currency1, symbol1: state.pair.symbol1 },
    pools: state.pools.map((pool) => ({ label: pool.label, address: pool.address, fee: E.formatManualFee(pool.fee), tick: pool.tick,
      sqrtPriceX96: pool.sqrtPriceX96.toString(), price: pool.displayPrice })),
    spread: state.spread && { buy: state.spread.buy.address, sell: state.spread.sell.address, spreadPercent: state.spread.spreadPercent,
      feeCostPercent: state.spread.feeCostPercent, netPercent: state.spread.netPercent, verdict: state.spread.verdict },
  }, null, 2));
})().catch((error) => { console.error(error.message); process.exit(1); });
