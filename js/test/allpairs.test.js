"use strict";

// Follow-up 6: All-pairs monitor, the 30000/600 drained-tick filter, gas estimate, multi-tab lock,
// REVOKE ALL and the client-side RPC fallback. Offline, against the mocks.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { AllPairsMock, WETH, PONS, USDG, WETH_PONS_500, WETH_PONS_3000 } = require("./allpairs-mock.js");
const { poolA, poolB } = require("./v3-mock.js");
const { CALLER } = require("./mock-wallet.js");
const bn = ethers.BigNumber.from;
const lower = (a) => a.toLowerCase();
const rpcFor = (p) => E.createRpcClient(E.RPC_URL, p.fetch);

function monitorFor(p, options = {}) {
  return E.createAllPairsMonitor({ ...rpcFor(p), pollIntervalMs: 0, retryIntervalMs: 0, ...options });
}

const key = (c0, c1, fee, tickSpacing) => ({ currency0: c0, currency1: c1, fee, tickSpacing, hooks: E.NO_HOOKS });

test("parseTokenList: one address per line, blanks and commas tolerated, duplicates and Token A dropped, bad entries refused", () => {
  const text = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73\n0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
  assert.deepEqual(E.parseTokenList(text, E.PONS), [WETH, USDG]);
  assert.deepEqual(E.parseTokenList(" \n" + E.WETH.toLowerCase() + ",\n\n" + E.USDG + "\n" + E.WETH + "\n" + E.PONS + "\n", E.PONS), [WETH, USDG]);
  assert.throws(() => E.parseTokenList("", E.PONS), /at least one token/);
  assert.throws(() => E.parseTokenList(E.PONS, E.PONS), /at least one token/);
  assert.throws(() => E.parseTokenList("0x1234", E.PONS), /not a 42-character address/);
  assert.throws(() => E.parseTokenList(ethers.constants.AddressZero, E.PONS), /zero address/);
});

test("getLiquidity(poolId) reads the PoolManager slot three words after slot0 through extsload", () => {
  const id = E.poolId(key(PONS, USDG, 3000, 60));
  assert.equal(bn(E.liquidityStorageSlot(id)).sub(bn(E.slot0StorageSlot(id))).toNumber(), 3);
  assert.equal(E.LIQUIDITY_OFFSET, 3);
  const call = E.encodeLiquidityCall(id);
  assert.equal(call.to, E.POOL_MANAGER);
  assert.equal(call.data.slice(0, 10), "0x1e2eaeaf", "extsload(bytes32)");
  assert.equal("0x" + call.data.slice(10), E.liquidityStorageSlot(id));
  assert.equal(E.decodeLiquidityWord(ethers.utils.hexZeroPad("0x2a", 32)).toNumber(), 42);
  assert.equal(E.decodeLiquidityWord(ethers.constants.HashZero).toNumber(), 0);
  assert.throws(() => E.decodeLiquidityWord("0x12"), /32-byte word/);
});

test("All pairs discovers V3 and V4 pools of several Token Bs in one batch, polls with ONE eth_getLogs per protocol and shows pools from both", async () => {
  const p = new AllPairsMock();
  // V4: PONS/USDG 3000/60 and 30000/600 have liquidity; WETH/PONS 500/10 too; the other tiers answer 0 and are dropped.
  const sorted = E.sortPair(PONS, USDG);
  const wethPons = E.sortPair(WETH, PONS);
  p.setV4Liquidity(key(sorted.currency0, sorted.currency1, 3000, 60), 1000);
  p.setV4Liquidity(key(sorted.currency0, sorted.currency1, 30000, 600), 7);
  p.setV4Liquidity(key(wethPons.currency0, wethPons.currency1, 500, 10), 99);
  p.addSwap(3000, 60, -292916);
  p.addSwap(30000, 600, -887272); // drained to the floor: EMPTY by the 30000/600 filter
  p.addSwap(500, 10, 93990, p.block, { currency0: wethPons.currency0, currency1: wethPons.currency1 });
  p.addV3Swap(3000, -292916); // PONS/USDG 0.30% V3
  p.v3Logs.push({ address: WETH_PONS_500, topics: [E.V3_SWAP_TOPIC, ethers.utils.hexZeroPad(CALLER, 32), ethers.utils.hexZeroPad(CALLER, 32)],
    data: ethers.utils.defaultAbiCoder.encode(["int256", "int256", "uint160", "uint128", "int24"], [1, -1, bn(2).pow(96), 1, 93992]),
    blockNumber: ethers.utils.hexValue(p.block), logIndex: "0x9" }); // WETH/PONS 0.05% V3
  const updates = [];
  const monitor = monitorFor(p, { onUpdate: (state) => updates.push(state.pools.length) });
  const httpBefore = p.httpCalls.length;
  await monitor.start(PONS, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73\n0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "Both");
  monitor.stop();
  const state = monitor.getState();
  assert.equal(state.lastError, null);
  assert.equal(state.pairs.length, 2);
  assert.deepEqual(state.pairs.map((e) => e.pair.symbolB), ["WETH", "USDG"]);
  assert.deepEqual(state.discovered, { v3: 4, v4: 3 }, "2 WETH/PONS + 2 PONS/USDG V3 pools; 3 V4 pools with liquidity");
  // Discovery is one POST; the poll is one phase-1 POST (latest + 2 eth_getLogs) and one health POST.
  const posts = p.httpCalls.slice(httpBefore);
  assert.equal(posts.length, 3);
  const phase1 = posts[1].body;
  assert.deepEqual(phase1.map((c) => c.method), ["eth_getBlockByNumber", "eth_getLogs", "eth_getLogs"]);
  const v4Filter = phase1[1].params[0], v3Filter = phase1[2].params[0];
  assert.equal(lower(v4Filter.address), lower(E.POOL_MANAGER));
  assert.deepEqual(v4Filter.topics, [E.SWAP_TOPIC], "V4: PoolManager + Swap topic only; pool ids are filtered client-side");
  assert.deepEqual(v3Filter.topics, [E.V3_SWAP_TOPIC]);
  assert.deepEqual(v3Filter.address.map(lower).sort(), [WETH_PONS_500, WETH_PONS_3000, poolA, poolB].map(lower).sort(), "V3: every discovered pool in ONE filter");
  assert.equal(E.V3_SWAP_TOPIC, "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67");
  assert.equal(E.SWAP_TOPIC, "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
  // Pools from BOTH Token Bs are in the table, with their pair attached.
  assert.equal(state.pools.length, 7);
  const byLabel = Object.fromEntries(state.pools.map((pool) => [E.describeLeg(pool), pool]));
  assert.deepEqual(Object.keys(byLabel).sort(), ["V3 0.05% (WETH)", "V3 0.30% (USDG)", "V3 0.30% (WETH)", "V3 1.00% (USDG)", "V4 3000/60 (USDG)", "V4 30000/600 (USDG)", "V4 500/10 (WETH)"]);
  assert.equal(byLabel["V4 3000/60 (USDG)"].status, "OK");
  assert.equal(byLabel["V4 3000/60 (USDG)"].swaps, 1);
  assert.ok(Math.abs(byLabel["V4 3000/60 (USDG)"].displayPrice - 0.19030) < 1e-4, "price = 1.0001^tick after decimals");
  assert.equal(byLabel["V4 30000/600 (USDG)"].status, "EMPTY", "tick -887272 ≤ -887000 is EMPTY");
  assert.equal(byLabel["V4 30000/600 (USDG)"].tick, -887272);
  assert.equal(byLabel["V4 500/10 (WETH)"].status, "OK");
  assert.equal(byLabel["V3 0.05% (WETH)"].status, "OK");
  assert.equal(byLabel["V3 0.05% (WETH)"].liquidity.toNumber(), 1000, "V3 active pools read liquidity() via eth_call");
  assert.equal(byLabel["V3 0.30% (WETH)"].status, "INACTIVE");
  assert.equal(byLabel["V3 1.00% (USDG)"].status, "INACTIVE");
  assert.equal(byLabel["V3 0.30% (USDG)"].elapsedSeconds, 0, "staleness as in the pair monitor");
  // Spreads: same-pair executable rows and cross-pair 3-LEG rows; the EMPTY pool is in none of them.
  const spreads = E.allPairsSpreads(state.pools, 0.5);
  assert.ok(spreads.every((s) => s.buy.status === "OK" && s.sell.status === "OK"));
  assert.ok(spreads.every((s) => s.buy.poolId !== byLabel["V4 30000/600 (USDG)"].poolId && s.sell.poolId !== byLabel["V4 30000/600 (USDG)"].poolId));
  const same = spreads.filter((s) => !s.crossPair), cross = spreads.filter((s) => s.crossPair);
  assert.equal(same.length, 2, "PONS/USDG V4 3000/60 vs V3 0.30% and WETH/PONS V4 500/10 vs V3 0.05%");
  assert.equal(cross.length, 4, "2 x 2 pools across the two pairs");
  assert.ok(cross.every((s) => s.buy.pairKey !== s.sell.pairKey));
  assert.ok(same.every((s) => s.buy.pairKey === s.sell.pairKey));
  assert.match(same.find((s) => s.buy.pair.symbolB === "WETH").path, /^V(3|4) .* \(WETH\) → V(3|4) .* \(WETH\)$/);
  assert.ok(cross[0].path.includes("(WETH)") && cross[0].path.includes("(USDG)"), cross[0].path);
  assert.equal(spreads.map((s) => s.netPercent).join(), spreads.map((s) => s.netPercent).sort((a, b) => b - a).join(), "best net first");
  // Same-pair rows carry what the existing execution path needs; cross-pair rows never reach auto mode.
  const usdgSpread = same.find((s) => s.buy.pair.symbolB === "USDG");
  assert.equal(usdgSpread.buy.pair.currency1, USDG);
  assert.ok(usdgSpread.buy.poolKey || usdgSpread.buy.address);
  const decision = E.allPairsAutoDecision(state.pools, 0);
  assert.ok(decision.spread === null || decision.spread.buy.pairKey === decision.spread.sell.pairKey);
  assert.equal(E.tokenAPrice(byLabel["V4 3000/60 (USDG)"]), byLabel["V4 3000/60 (USDG)"].displayPrice, "PONS is currency0 of PONS/USDG");
  assert.ok(Math.abs(E.tokenAPrice(byLabel["V3 0.05% (WETH)"]) - 1 / byLabel["V3 0.05% (WETH)"].displayPrice) < 1e-12, "PONS is currency1 of WETH/PONS: inverted");
  assert.deepEqual(updates, [7]);
});

test("All pairs: list validation is synchronous, V3-only and V4-only skip the other protocol's filter, RPC errors back off without stopping", async () => {
  const p = new AllPairsMock();
  const monitor = monitorFor(p);
  assert.throws(() => monitor.start(PONS, "", "Both"), /at least one token/);
  assert.throws(() => monitor.start(PONS, "0x12", "Both"), /42-character/);
  assert.throws(() => monitor.start(PONS, WETH, "V5"), /Protocol must be/);
  assert.equal(monitor.isRunning(), false);
  await assert.rejects(monitor.pollOnce(), /start\(/);
  await monitor.start(PONS, [WETH, USDG], "V3");
  let filters = p.getLogsFilters.splice(0);
  assert.equal(filters.length, 1);
  assert.deepEqual(filters[0].topics, [E.V3_SWAP_TOPIC]);
  assert.ok(monitor.getState().pools.every((pool) => pool.protocol === "V3"));
  assert.equal(monitor.getState().discovered.v4, 0);
  p.setV4Liquidity(key(E.sortPair(PONS, USDG).currency0, E.sortPair(PONS, USDG).currency1, 3000, 60), 5);
  await monitor.start(PONS, [USDG], "V4");
  filters = p.getLogsFilters.splice(0);
  assert.equal(filters.length, 1);
  assert.equal(lower(filters[0].address), lower(E.POOL_MANAGER));
  assert.deepEqual(monitor.getState().pools.map((pool) => pool.protocol), ["V4"]);
  // No V4 pool with liquidity and no V3 pool: no eth_getLogs at all (never an empty address list).
  p.tokens.set("0x000000000000000000000000000000000000dead", ["DEAD", 18]);
  await monitor.start(WETH, ["0x000000000000000000000000000000000000dEaD"], "Both");
  assert.equal(p.getLogsFilters.length, 0);
  assert.equal(monitor.getState().lastError, null);
  assert.equal(monitor.getState().pools.length, 0);
  // Transport failure: error recorded, previous discovery kept, polling continues.
  monitor.stop();
  const errors = [];
  // Short HTTP abort timers so only the monitor's 30 s / 60 s schedule is captured below.
  const retrying = E.createAllPairsMonitor({ ...E.createRpcClient(E.RPC_URL, p.fetch, { timeoutMs: 1000, batchTimeoutMs: 1000 }),
    onError: (error) => errors.push(error.message), retryIntervalMs: 60000, pollIntervalMs: 30000 });
  const realSetTimeout = global.setTimeout;
  const timers = [];
  global.setTimeout = (fn, ms) => { if (ms >= 30000) { timers.push({ fn, ms }); return { fn }; } return realSetTimeout(fn, ms); };
  try {
    await retrying.start(PONS, [WETH, USDG], "Both");
    assert.deepEqual(timers.map((t) => t.ms), [30000]);
    p.httpFailures = 1;
    await timers.splice(0)[0].fn();
    assert.match(retrying.getState().lastError, /HTTP error 429/);
    assert.deepEqual(timers.map((t) => t.ms), [60000]);
    assert.equal(retrying.getState().pairs.length, 2, "discovery survives the failed poll");
    await timers.splice(0)[0].fn();
    assert.equal(retrying.getState().lastError, null);
    assert.equal(errors.length, 1);
  } finally { global.setTimeout = realSetTimeout; retrying.stop(); }
  assert.throws(() => E.createAllPairsMonitor({ request: () => {} }), /batchRequest/);
  assert.throws(() => E.createAllPairsMonitor({}), /request function/);
});

test("30000/600 filter: a V4 pool at tick -887272 is EMPTY and excluded from spreads and auto mode; V3 and healthy V4 ticks are not", () => {
  const drained = { protocol: "V4", poolId: "0x01", fee: 30000, tickSpacing: 600, active: true, tick: -887272, price: E.tickToPrice(-887272), empty: false, elapsedSeconds: 10 };
  const edge = { ...drained, poolId: "0x02", tick: -887000 };
  const healthy = { ...drained, poolId: "0x03", fee: 3000, tickSpacing: 60, tick: -292916, price: E.tickToPrice(-292916) };
  const other = { ...healthy, poolId: "0x04", fee: 2500, tickSpacing: 25, tick: -292000, price: E.tickToPrice(-292000) };
  const v3 = { ...drained, protocol: "V3", poolId: "0x05", fee: 100, address: poolA };
  assert.equal(E.DRAINED_TICK, -887000);
  assert.equal(E.isDrained(drained), true);
  assert.equal(E.isDrained(edge), true, "≤ -887000");
  assert.equal(E.isDrained({ ...drained, tick: -886999 }), false);
  assert.equal(E.isDrained(healthy), false);
  assert.equal(E.isDrained(v3), false, "the filter is for V4 pools");
  assert.equal(E.poolStatus(drained, 7200), "EMPTY");
  assert.equal(E.poolStatus(healthy, 7200), "OK");
  assert.equal(E.poolStatus({ ...drained, tick: null }, 7200), "OK", "no tick, no verdict from the filter");
  const pools = E.annotatePools([drained, healthy, other], 7200);
  assert.deepEqual(pools.map((pool) => pool.status), ["EMPTY", "OK", "OK"]);
  const spreads = E.rankSpreads(pools, 0.5, Infinity);
  assert.equal(spreads.length, 1);
  assert.ok(spreads.every((s) => s.buy.poolId !== "0x01" && s.sell.poolId !== "0x01"));
  const decision = E.autoDecision(pools, 0);
  assert.equal(decision.spread.buy.poolId, "0x03");
  assert.ok(decision.skips.some((skip) => skip.poolId === "0x01" && /empty \(tick -887272 is at the price floor\)/.test(skip.reason)), JSON.stringify(decision.skips));
});

test("gas estimate: 250K V3 / 400K V4 (650K mixed) × eth_gasPrice, dollars through USDG or the WETH price, net after gas", async () => {
  const v3 = { protocol: "V3" }, v4 = { protocol: "V4" };
  assert.deepEqual(E.GAS_UNITS, { V3: 250000, V4: 400000 });
  assert.equal(E.gasUnitsFor(v3, v3), 250000);
  assert.equal(E.gasUnitsFor(v4, v4), 400000);
  assert.equal(E.gasUnitsFor(v3, v4), 650000);
  assert.throws(() => E.gasUnitsFor({ protocol: "V2" }, v3), /protocol/);
  const gwei = ethers.utils.parseUnits("2", "gwei");
  const estimate = E.estimateGasCost(v4, v4, gwei, 3000);
  assert.equal(estimate.costWei.toString(), gwei.mul(400000).toString());
  assert.equal(estimate.costEth, 0.0008);
  assert.equal(estimate.costUsd, 2.4);
  assert.equal(E.estimateGasCost(v3, v3, gwei, null).costUsd, null);
  assert.equal(E.estimateGasCost(v3, v3, gwei, 0).costUsd, null);
  assert.throws(() => E.estimateGasCost(v3, v3, -1), /negative/);
  assert.equal(E.formatUsd(2.4), "$2.400");
  assert.equal(E.formatUsd(123.456), "$123.46");
  assert.equal(E.formatUsd(-0.01234), "-$0.0123");
  assert.throws(() => E.formatUsd(NaN));
  assert.equal(E.usdPerToken(USDG), 1);
  assert.equal(E.usdPerToken(WETH, 3000), 3000);
  assert.equal(E.usdPerToken(WETH, null), null);
  assert.equal(E.usdPerToken(PONS, 3000), null, "no dollar price for other tokens");
  // 0.01 USDG in, 0.0135 USDG back: +0.0035 USDG, minus $0.0024 gas at 2 gwei V4/V4 with ETH at $3.
  const cheap = E.estimateGasCost(v4, v4, gwei, 3);
  const net = E.netAfterGas(ethers.utils.parseUnits("0.01", 6), ethers.utils.parseUnits("0.0135", 6), 6, USDG, cheap, 3);
  assert.ok(Math.abs(net.profitToken - 0.0035) < 1e-12);
  assert.ok(Math.abs(net.profitUsd - 0.0035) < 1e-12);
  assert.ok(Math.abs(net.netUsd - (0.0035 - 0.0024)) < 1e-12);
  assert.equal(E.netAfterGas(1000, 1100, 18, PONS, cheap, 3).netUsd, null, "unknown dollar price → null, never a guess");
  assert.equal(E.netAfterGas(1000, 900, 6, USDG, E.estimateGasCost(v4, v4, gwei, null), null).netUsd, null, "no ETH price → no dollar gas");
  // fetchEthUsd: the first WETH/USDG V3 pool with liquidity, tick → USDG per WETH.
  const p = new AllPairsMock();
  const price = await E.fetchEthUsd(rpcFor(p).request);
  assert.ok(Math.abs(price - Math.pow(1.0001, -195310) * 1e12) < 1e-6, String(price));
  assert.ok(price > 3000 && price < 3700, "about $3300 in the fixture");
  p.v3Liquidity.set(lower("0x3333333333333333333333333333333333333333"), bn(0));
  assert.equal(await E.fetchEthUsd(rpcFor(p).request), null, "no pool with liquidity → null");
  p.rpcFailures = 1;
  assert.equal(await E.fetchEthUsd(rpcFor(p).request), null, "a failed read → null, never an exception into the quote flow");
  await assert.rejects(E.fetchEthUsd(null), /request function/);
});

test("multi-tab lock: a timestamp younger than 5 minutes written by another tab blocks; own lock, stale lock and clearing do not", () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  let now = 1_700_000_000_000;
  const tabA = E.createTabLock(storage, () => now);
  const tabB = E.createTabLock(storage, () => now);
  assert.equal(E.LOCK_KEY, "ponsarb_lock");
  assert.equal(E.LOCK_TTL_MS, 300000);
  assert.equal(tabA.heldElsewhere(), false, "no lock yet");
  assert.equal(tabA.acquire(), now);
  assert.equal(store.get("ponsarb_lock"), String(now));
  assert.equal(tabA.heldElsewhere(), false, "my own lock never blocks me");
  assert.equal(tabB.heldElsewhere(), true, "another tab sees a fresh lock");
  assert.throws(() => tabB.acquire(), /Another tab active/);
  assert.equal(tabB.release(), false, "another tab must not clear it");
  assert.equal(store.has("ponsarb_lock"), true);
  now += 5 * 60 * 1000 - 1;
  assert.equal(tabB.heldElsewhere(), true, "4:59.999 old is still active");
  now += 1;
  assert.equal(tabB.heldElsewhere(), false, "5 minutes old has expired");
  now -= 1;
  assert.equal(tabA.release(), true, "beforeunload clears my own lock");
  assert.equal(store.has("ponsarb_lock"), false);
  assert.equal(tabB.heldElsewhere(), false);
  store.set("ponsarb_lock", "garbage");
  assert.equal(tabB.heldElsewhere(), false, "a malformed value is not a lock");
  assert.equal(E.createTabLock(null).heldElsewhere(), false, "no storage: never locked, acquire is a no-op");
  assert.ok(E.createTabLock(null).acquire() > 0);
});

test("the client retries once against the fallback RPC on HTTP 429 / 5xx and reports both failures when neither answers", async () => {
  const log = [];
  const fetchFor = (script) => async (url, init) => {
    log.push({ url, body: JSON.parse(init.body) });
    const next = script[url].shift();
    return { ok: next.status === 200, status: next.status, json: async () => next.body };
  };
  const primary = E.RPC_URL, fallback = E.RPC_FALLBACK_URL;
  assert.equal(primary, "https://rpc-robinhood.blockmachine.io");
  assert.equal(fallback, "https://robinhood.drpc.org");
  const ok = (id) => ({ jsonrpc: "2.0", id, result: "0x1237" });
  let client = E.createRpcClient(primary, fetchFor({ [primary]: [{ status: 429, body: {} }], [fallback]: [{ status: 200, body: ok(1) }] }), { fallbackUrl: fallback });
  assert.equal(await client.request("eth_chainId", []), "0x1237");
  assert.deepEqual(log.map((c) => c.url), [primary, fallback]);
  assert.deepEqual(log[0].body, log[1].body, "the same payload is retried");
  log.length = 0;
  client = E.createRpcClient(primary, fetchFor({ [primary]: [{ status: 500, body: {} }], [fallback]: [{ status: 200, body: [ok(1), ok(2)] }] }), { fallbackUrl: fallback });
  const results = await client.batchRequest([{ method: "eth_chainId", params: [] }, { method: "eth_chainId", params: [] }]);
  assert.deepEqual(results, ["0x1237", "0x1237"]);
  assert.deepEqual(log.map((c) => c.url), [primary, fallback]);
  log.length = 0;
  client = E.createRpcClient(primary, fetchFor({ [primary]: [{ status: 429, body: {} }], [fallback]: [{ status: 503, body: {} }] }), { fallbackUrl: fallback });
  await assert.rejects(client.request("eth_chainId", []), /RPC HTTP error 429 \(fallback https:\/\/robinhood\.drpc\.org: RPC HTTP error 503\)/);
  assert.equal(log.length, 2, "exactly one retry");
  log.length = 0;
  client = E.createRpcClient(primary, fetchFor({ [primary]: [{ status: 200, body: ok(1) }] }), { fallbackUrl: fallback });
  assert.equal(await client.request("eth_chainId", []), "0x1237");
  assert.equal(log.length, 1, "a healthy primary never touches the fallback");
  log.length = 0;
  client = E.createRpcClient(primary, fetchFor({ [primary]: [{ status: 429, body: {} }] }));
  await assert.rejects(client.request("eth_chainId", []), /RPC HTTP error 429$/);
  assert.equal(log.length, 1, "without the option the behaviour is unchanged");
  assert.throws(() => E.createRpcClient(primary, async () => {}, { fallbackUrl: "ftp://x" }), /fallback RPC url/);
});

test("REVOKE ALL: approve(SwapRouter02, 0) then approve(Permit2, 0) for the input token, each confirmed; zero allowances are skipped", async () => {
  const p = new AllPairsMock();
  p.setAllowance(E.USDG, 1000); // V3 Router allowance
  p.tokenAllowances.set(lower(E.USDG), bn(5000)); // ERC20 allowance to Permit2
  const wallet = E.createWalletClient(p, { onStatus: () => {} });
  await wallet.connect();
  const done = await wallet.revokeAll(E.USDG, "USDG");
  assert.equal(done.length, 2);
  assert.deepEqual(done.map((d) => lower(d.spender)), [lower(E.V3_ROUTER), lower(E.PERMIT2)]);
  assert.equal(p.sent.length, 2);
  const token = new ethers.utils.Interface(["function approve(address,uint256) returns (bool)"]);
  const [spender0, amount0] = token.decodeFunctionData("approve", p.sent[0].data);
  const [spender1, amount1] = token.decodeFunctionData("approve", p.sent[1].data);
  assert.equal(lower(spender0), lower(E.V3_ROUTER));
  assert.equal(lower(spender1), lower(E.PERMIT2));
  assert.equal(amount0.toString(), "0");
  assert.equal(amount1.toString(), "0");
  assert.ok(p.sent.every((tx) => lower(tx.to) === lower(E.USDG) && lower(tx.from) === lower(CALLER)));
  assert.equal(p.allowance(E.USDG).toString(), "0", "V3 Router allowance is zero");
  assert.equal(p.tokenAllowances.get(lower(E.USDG)).toString(), "0", "Permit2 allowance is zero");
  // Already zero: nothing is sent.
  assert.deepEqual(await wallet.revokeAll(E.USDG, "USDG"), []);
  assert.equal(p.sent.length, 2);
  // A rejected signature stops the sequence: the Permit2 revocation is not requested after a refused V3 one.
  p.setAllowance(E.PONS, 7);
  p.tokenAllowances.set(lower(E.PONS), bn(9));
  p.rejectSend = 3;
  await assert.rejects(wallet.revokeAll(E.PONS, "PONS"), /User rejected/);
  assert.equal(p.sent.length, 2, "nothing more was sent");
  assert.equal(p.allowance(E.PONS).toString(), "7");
  assert.equal(p.tokenAllowances.get(lower(E.PONS)).toString(), "9");
  p.rejectSend = 0;
  p.approveFalse = true;
  await assert.rejects(wallet.revokeAll(E.PONS, "PONS"), /refused the V3 Router revocation/);
  assert.equal(p.sent.length, 2);
});
