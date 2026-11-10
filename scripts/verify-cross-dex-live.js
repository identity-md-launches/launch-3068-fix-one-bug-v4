"use strict";

// Job 9: optional READ-ONLY integration check of the cross-DEX reader against Robinhood Chain (4663).
// Never run by the offline test suite; sends nothing, signs nothing, needs no wallet.
// Usage: node scripts/verify-cross-dex-live.js [--rpc=URL] [--tokenA=0x…] [--tokenB=0x…] [--write=docs/cross-dex-live.json]
// Defaults: the page's primary RPC (Blockmachine), WETH / USDG (the brief's live-test pair).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { ethers } = require("../js/vendor/ethers-5.7.2.umd.min.js");
const E = require("../js/v4-arb-encoder.js");
const X = require("../js/cross-dex-reader.js");

const arg = (name, fallback) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const erc20 = new ethers.utils.Interface(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const feeFactory = new ethers.utils.Interface(["function getPool(address,address,uint24) view returns (address)"]);

(async () => {
  const client = E.createRpcClient(arg("rpc", E.RPC_URL), fetch);
  assert.equal(Number(await client.request("eth_chainId", [])), X.CHAIN_ID, "chain 4663");
  const block = await client.request("eth_blockNumber", []);
  // Pin every read to one block so prices, liquidity and the Uniswap reference agree.
  const pin = (params) => params.map((value) => (value === "latest" ? block : value));
  const request = (method, params) => client.request(method, pin(params));
  const batchRequest = (calls) => client.batchRequest(calls.map((call) => ({ method: call.method, params: pin(call.params) })));

  const tokenA = ethers.utils.getAddress(arg("tokenA", E.WETH));
  const tokenB = ethers.utils.getAddress(arg("tokenB", E.USDG));
  const pair = X.sortTokens(tokenA, tokenB);
  const meta = {};
  for (const token of [pair.token0, pair.token1]) {
    const symbol = erc20.decodeFunctionResult("symbol", await request("eth_call", [{ to: token, data: erc20.encodeFunctionData("symbol") }, "latest"]))[0];
    const decimals = erc20.decodeFunctionResult("decimals", await request("eth_call", [{ to: token, data: erc20.encodeFunctionData("decimals") }, "latest"]))[0];
    meta[token] = { symbol, decimals };
  }
  const scale = Math.pow(10, meta[pair.token0].decimals - meta[pair.token1].decimals);

  // 1. Both factories have code; the Ramses factory reverts on the fee-keyed getPool (why it is read as "cl").
  const factories = {};
  for (const dex of X.DEXES) {
    const code = await request("eth_getCode", [dex.factory, "latest"]);
    assert.ok(code.length > 2, dex.name + " factory has no code");
    factories[dex.name] = { address: dex.factory, type: dex.type, codeBytes: ethers.utils.hexDataLength(code),
      tiers: dex.type === "v3" ? dex.fees : dex.tickSpacings,
      hasFeeKeyedGetPool: code.includes("1698ee82"), hasTickSpacingKeyedGetPool: code.includes("28af8d0b") };
    let feeKeyed;
    try {
      const reply = await request("eth_call", [{ to: dex.factory, data: feeFactory.encodeFunctionData("getPool", [pair.token0, pair.token1, 500]) }, "latest"]);
      feeKeyed = "answers " + reply;
    } catch (error) { feeKeyed = "reverts: " + (error.message || String(error)); }
    factories[dex.name].feeKeyedGetPool500 = feeKeyed;
  }

  // 2. The reader itself, exactly as the page runs it (one read).
  const reader = X.createCrossDexReader({ request, batchRequest });
  await reader.readOnce(tokenA, tokenB);
  const state = reader.getState();
  assert.equal(state.lastError, null, "the read must not fail: " + state.lastError);

  // 3. The Uniswap V3 reference, read the same way (fee-keyed over the four Uniswap tiers).
  const uniReader = X.createCrossDexReader({ request, batchRequest, dexes: [{ name: "Uniswap V3", type: "v3", factory: E.V3_FACTORY, fees: E.V3_FEE_TIERS }] });
  await uniReader.readOnce(tokenA, tokenB);
  const uniRows = uniReader.getState().rows.filter((row) => row.status === X.STATUS_OK);
  const uniPools = uniRows.map((row) => ({ protocol: "V3", fee: row.fee, price: row.price, liquidity: row.liquidity, currency0: pair.token0, currency1: pair.token1, status: "OK", address: row.address }));
  const uni = X.bestUniPool(uniPools, pair);

  // 4. The table as the page shows it.
  const table = state.rows.map((row) => ({
    dex: row.dex, fee: row.tier === null ? "—" : X.formatFee(row.fee) + (row.type === "cl" ? " (ts " + row.tickSpacing + ")" : ""),
    price: row.price === null ? "—" : (row.price * scale).toPrecision(6) + " (tick " + row.tick + ")",
    liquidity: X.formatLiquidity(row.liquidity), spreadVsUni: X.formatSpread(X.spreadVsUni(row.price, uni ? uni.price : null)),
    status: row.status + (row.error ? " · " + row.error : ""),
  }));
  console.table(table);

  // 5. The brief's live test: non-zero pools found and readable on both factories.
  for (const dex of X.DEXES) {
    const ok = state.rows.filter((row) => row.dex === dex.name && row.status === X.STATUS_OK);
    assert.ok(ok.length > 0, dex.name + ": no readable pool for " + meta[pair.token0].symbol + "/" + meta[pair.token1].symbol);
    for (const row of ok) {
      assert.ok(/^0x[0-9a-fA-F]{40}$/.test(row.address) && row.address !== ethers.constants.AddressZero);
      assert.ok(Number.isInteger(row.tick) && row.price > 0 && /^\d+$/.test(row.liquidity));
    }
  }
  assert.ok(uni, "no priced Uniswap V3 pool for the reference");

  const record = {
    recordedAt: new Date().toISOString(),
    chainId: X.CHAIN_ID,
    block: Number(block),
    rpcSource: "the page's primary RPC (" + E.RPC_URL + "), every read pinned to `block`",
    readOnly: "eth_chainId, eth_blockNumber, eth_getCode, eth_call only; nothing sent or signed",
    pair: { tokenA, tokenB, token0: pair.token0, token1: pair.token1,
      symbol0: meta[pair.token0].symbol, decimals0: meta[pair.token0].decimals, symbol1: meta[pair.token1].symbol, decimals1: meta[pair.token1].decimals,
      priceUnit: meta[pair.token1].symbol + " per " + meta[pair.token0].symbol + " (1.0001^tick × 10^" + (meta[pair.token0].decimals - meta[pair.token1].decimals) + ")" },
    factories,
    rows: state.rows,
    uniswapV3: { factory: E.V3_FACTORY, rows: uniReader.getState().rows,
      reference: uni ? { fee: uni.pool.fee, address: uni.pool.address, price: uni.price, displayPrice: uni.price * scale, liquidity: uni.pool.liquidity, rule: "priced, tradeable Uni V3 pool with the greatest liquidity" } : null },
    table,
    rpcCallsMade: "3 + 7 getPool (one batch) + 2 or 3 reads per pool (one batch) for the DEXes; 4 getPool + 2 reads per pool for Uniswap; symbol/decimals of both tokens; eth_getCode per factory",
  };
  const out = arg("write", null);
  if (out) {
    fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
    console.log("written", out);
  }
  console.log(JSON.stringify({ block: record.block, pair: record.pair.symbol0 + "/" + record.pair.symbol1, rows: state.rows.length,
    ok: state.rows.filter((r) => r.status === "OK").length, uniReference: record.uniswapV3.reference && record.uniswapV3.reference.displayPrice }, null, 2));
})().catch((error) => { console.error("FAILED", error); process.exit(1); });
