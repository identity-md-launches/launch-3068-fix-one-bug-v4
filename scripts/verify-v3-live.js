"use strict";

// Optional READ-ONLY integration check. Never run by the offline test suite; never sends transactions.
// Usage: node scripts/verify-v3-live.js [additionalTokenAddressForWethPair] [--window=50000]
const assert = require("node:assert/strict");
const { ethers } = require("../js/vendor/ethers-5.7.2.umd.min.js");
const E = require("../js/v4-arb-encoder.js");

(async () => {
  const rpc = E.createRpcClient(E.RPC_URL, fetch).request;
  assert.equal(Number(await rpc("eth_chainId", [])), E.CHAIN_ID);
  const block = await rpc("eth_blockNumber", []);
  // Pin every read and quote to the same block, including the monitor's 'latest' health calls.
  const request = (method, params) => {
    assert.ok(["eth_call", "eth_getCode", "eth_getBlockByNumber", "eth_getLogs"].includes(method));
    return rpc(method, params.map(value => value === "latest" ? block : value));
  };
  const contracts = {};
  for (const [name, address] of [["factory", E.V3_FACTORY], ["router", E.V3_ROUTER]]) {
    const code = await request("eth_getCode", [address, "latest"]);
    assert.ok(code.length > 2);
    contracts[name] = { address, codeBytes: ethers.utils.hexDataLength(code) };
    if (name === "router") {
      contracts[name].selectors = {};
      for (const signature of ["multiswap(bytes,address,uint256,uint256,uint256)",
        "exactInput((bytes,address,uint256,uint256))", "multicall(uint256,bytes[])"]) {
        const selector = ethers.utils.id(signature).slice(0, 10);
        contracts[name].selectors[signature] = { selector, presentInRuntime: code.includes(selector.slice(2)) };
      }
      const factory = ethers.utils.defaultAbiCoder.decode(["address"], await request("eth_call", [{
        to: address, data: ethers.utils.id("factory()").slice(0, 10),
      }, "latest"]))[0];
      assert.equal(factory.toLowerCase(), E.V3_FACTORY.toLowerCase());
      contracts[name].factory = factory;
    }
  }
  const pairs = [[E.PONS, E.WETH], [E.WETH, E.USDG], [E.PONS, E.USDG]];
  const extraToken = process.argv.slice(2).find(arg => !arg.startsWith("--"));
  if (extraToken) pairs.push([ethers.utils.getAddress(extraToken), E.WETH]);
  const windowArg = process.argv.slice(2).find(arg => arg.startsWith("--window="));
  const windowBlocks = windowArg ? E.parseWindowBlocks(windowArg.slice(9)) : E.LOG_WINDOW_BLOCKS;
  assert.ok(windowBlocks, "window must be from 50 to 50000 blocks");
  const observations = [];
  for (const tokens of pairs) {
    const monitor = E.createPoolMonitor({ request, windowBlocks });
    try {
      await monitor.start(tokens[0], tokens[1], "Both");
      const state = monitor.getState();
      if (state.lastError) throw new Error(state.lastError);
      const pools = state.pools.filter(pool => pool.protocol === "V3" || pool.active);
      const record = { tokens, symbols: [state.pair.symbol0, state.pair.symbol1],
        currency0: state.pair.currency0, currency1: state.pair.currency1,
        fromBlock: state.fromBlock, toBlock: state.blockNumber, windowBlocks: state.windowBlocks,
        pools: pools.map(pool => ({ protocol: pool.protocol, address: pool.address, poolId: pool.poolId,
          fee: pool.fee, swaps: pool.swaps, status: pool.status, price: pool.displayPrice,
          liquidity: pool.liquidity && pool.liquidity.toString() })), quotes: [] };
      // Include discovered inactive V3 pools: no recent swaps does not imply no liquidity.
      for (const pool of pools.filter(pool => pool.protocol === "V3")) {
        const amountIn = ethers.utils.parseUnits("0.01", state.pair.decimals1);
        const amountOut = await E.quoteV3ExactIn(request, { pool, zeroForOne: false, amountIn });
        record.quotes.push({ pool: pool.address, amountIn: amountIn.toString(), amountOut: amountOut.toString() });
      }
      const v3Spreads = E.rankSpreads(state.pools.filter(pool => pool.protocol === "V3"), 0, Infinity);
      record.v3Spreads = v3Spreads.map(spread => ({ buyFee: spread.buy.fee, sellFee: spread.sell.fee,
        spreadPercent: spread.spreadPercent, feeCostPercent: spread.feeCostPercent, netPercent: spread.netPercent }));
      observations.push(record);
    } finally { monitor.stop(); }
  }
  console.log(JSON.stringify({ chainId: E.CHAIN_ID, rpc: E.RPC_URL, block, contracts, observations,
    note: "Public RPC reads and reverting quote simulations only. No wallet, approval, deployment or transaction was sent." }, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
