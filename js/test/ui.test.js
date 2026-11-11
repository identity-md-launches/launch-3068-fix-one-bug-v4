"use strict";

// Execute the actual inline page script and local scripts with a minimal DOM. No browser/npm/network needed.
// These are event-handler tests; they do not claim to test browser rendering or a real wallet extension.
// Timers of 5 s or more (the 30 s poll, the 60 s retry) are recorded and fired by the test; shorter
// ones (receipt polling) run immediately.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { MockWallet, CALLER, OTHER, erc20 } = require("./mock-wallet.js");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const lower = (a) => String(a).toLowerCase();
const notAlpRow = (row) => !/^ALP V4 · /.test(row.children[0] ? row.children[0].textContent : "");
const { V3Mock, v3, token, decodePath } = require("./v3-mock.js");

function node(tag, attributes = {}) {
  // textContent behaves as in the DOM: setting it replaces the children with one text run; reading it
  // concatenates that run with the children's text (job 8 fix 7 renders the quote line as coloured spans).
  let ownText = "";
  return {
    tagName: tag,
    get textContent() { return ownText + this.children.map((child) => child.textContent).join(""); },
    set textContent(value) { ownText = String(value); this.children = []; },
    value: attributes.value || "",
    disabled: attributes.disabled || false,
    checked: attributes.checked || false,
    hidden: attributes.hidden || false,
    className: "",
    children: [],
    listeners: {},
    addEventListener(event, listener) { this.listeners[event] = listener; },
    appendChild(child) { this.children.push(child); },
    replaceChildren() { this.children = []; },
    async click() { if (!this.disabled && this.listeners.click) return this.listeners.click(); },
    input(value) { this.value = value; return this.listeners.input && this.listeners.input(); },
    change(checked) { this.checked = checked; return this.listeners.change && this.listeners.change(); },
    text() { return this.children.map((c) => c.textContent).join(" | "); },
  };
}

function loadPage(provider = new MockWallet(), { noWallet = false, storage = undefined } = {}) {
  const root = path.resolve(__dirname, "../..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const elements = new Map();
  for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const created = node(/^<(\w+)/.exec(tag)[1], {
      value: /\bvalue="([^"]*)"/.exec(tag)?.[1] || "",
      disabled: /\bdisabled\b/.test(tag),
      checked: /\bchecked\b/.test(tag),
      hidden: /\bhidden\b/.test(tag),
    });
    created.textContent = (/^([^<]*)</.exec(html.slice(match.index + tag.length))?.[1] || "").trim();
    if (created.tagName === "textarea") created.value = created.textContent; // a textarea's default value is its content
    elements.set(match[1], created);
  }
  const windowListeners = {};
  const document = {
    getElementById: (id) => { assert.ok(elements.has(id), "Missing DOM element " + id); return elements.get(id); },
    createElement: (tag) => node(tag),
  };
  const timers = [];
  let nextId = 1;
  // Each Date.now() call advances the clock 10 s, so the two-minute receipt timeout needs twelve polls, not real time.
  let clock = 1762500000000;
  class FakeDate extends Date { static now() { clock += 10000; return clock; } }
  const context = vm.createContext({
    document,
    window: { ethereum: noWallet ? undefined : provider, crypto: globalThis.crypto, fetch: provider.fetch, localStorage: storage,
      addEventListener: (event, listener) => { windowListeners[event] = listener; } },
    fetch: provider.fetch,
    // Short delays run now (receipt polling); long ones (poll / retry) are fired by the test.
    setTimeout: (fn, ms) => { if (ms >= 5000) { const id = nextId++; timers.push({ id, fn, ms }); return id; } return setImmediate(fn); },
    clearTimeout: (id) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); else clearImmediate(id); },
    console, atob, btoa, Date: FakeDate, JSON, Math, Number, BigInt, RegExp, String, Object, Array, Promise, Error,
  });
  for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\bsrc="([^"]+)"/.exec(script[1])?.[1];
    if (src) {
      assert.ok(!src.includes(":") && !src.startsWith("/"), "All page dependencies must be local");
      try {
        vm.runInContext(fs.readFileSync(path.join(root, src), "utf8"), context, { filename: src });
      } catch (error) { throw new Error(src + ": " + error.message); }
    } else vm.runInContext(script[2], context, { filename: "index.html:inline" });
  }
  const flush = async (turns = 40) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve)); };
  const until = async (predicate, what = "condition") => {
    for (let i = 0; i < 400; i++) { if (predicate()) return; await new Promise((resolve) => setImmediate(resolve)); }
    throw new Error("Timed out waiting for " + what);
  };
  // Fire the pending poll timer and wait for the cycle to schedule the next one.
  // Job 9: the cross-DEX reader polls on its own 30 s timer (named crossDexPoll); monitor assertions use monitorTimers().
  const monitorTimers = () => timers.filter((t) => t.fn.name !== "crossDexPoll" && t.fn.name !== "alpPoll");
  const crossDexTimers = () => timers.filter((t) => t.fn.name === "crossDexPoll");
  const poll = async () => {
    const due = timers.splice(0);
    assert.ok(due.length, "no poll scheduled");
    for (const t of due) t.fn();
    await until(() => timers.length >= due.length, "the next poll(s) to be scheduled");
    await flush(5);
  };
  return { provider, element: document.getElementById, context, html, timers, monitorTimers, crossDexTimers, flush, until, poll, windowListeners, storage };
}

/** A page whose first poll has finished. */
async function readyPage(provider = new MockWallet()) {
  const page = loadPage(provider);
  await page.until(() => page.monitorTimers().length > 0 && page.crossDexTimers().length > 0, "first poll");
  await page.flush(5);
  return page;
}

/** Three active pools: 3000/60 is cheapest, 30000/600 dearest; the best spread is GREEN at 0.5%. */
function withActivePools(provider = new MockWallet()) {
  provider.addSwap(3000, 60, -292916);
  provider.addSwap(2500, 25, -292902);
  provider.addSwap(30000, 600, -292000);
  provider.quotes.set(E.poolId({ currency0: E.PONS, currency1: E.USDG, fee: 30000, tickSpacing: 600, hooks: E.NO_HOOKS }),
    ethers.BigNumber.from("5000000000000000000000000000000000000000000000000"));
  return provider;
}




// ------------------------------------------------------------------ follow-up 3.5

const id = (fee, tickSpacing) => E.poolId({ currency0: E.PONS, currency1: E.USDG, fee, tickSpacing, hooks: E.NO_HOOKS });
const FEES = { 3000: 4, 2500: 3, 30000: 6 }; // row index in the pools table
const logsFilter = (provider) => provider.rpcCalls.filter((c) => c.method === "eth_getLogs").at(-1).params[0];
const logsSpan = provider => {
  const filters = provider.httpCalls.filter(c => Array.isArray(c.body) && c.body.some(call => call.method === "eth_getLogs"))
    .at(-1).body.filter(call => call.method === "eth_getLogs").map(call => call.params[0]);
  return provider.block - Math.min(...filters.map(filter => Number(filter.fromBlock)));
};

function withV3Pools() {
  const provider = new V3Mock();
  provider.addV3Swap(3000, -292916);
  provider.addV3Swap(10000, -292000);
  return provider;
}

async function chooseProtocol(page, protocol) {
  page.element("protocol").value = protocol;
  page.element("protocol").change(false);
  await page.until(() => page.monitorTimers().length > 0, "protocol restart");
  await page.flush();
}



for (const mode of ["zero", "failed quote", "zero sell", "empty", "unknown"]) {
  test("V3 page excludes or disables execution for " + mode, async () => {
    const provider = withV3Pools();
    if (mode === "zero") provider.quoteZero = true;
    if (mode === "failed quote") provider.quoteFailure = true;
    if (mode === "empty") provider.v3Liquidity.set(provider.row().address.toLowerCase(), ethers.BigNumber.from(0));
    if (mode === "unknown") provider.liquidityFailures.add(provider.row().address.toLowerCase());
    if (mode === "zero sell") {
      const original = provider.output.bind(provider);
      provider.output = (token, amount) => token.toLowerCase() === E.PONS.toLowerCase() ? ethers.BigNumber.from(0) : original(token, amount);
    }
    const page = await readyPage(provider), { element, flush } = page;
    await chooseProtocol(page, "V3");
    await element("connect").click();
    if (["empty", "unknown"].includes(mode)) assert.equal(element("spreads-body").children.length, 0);
    else { await element("spreads-body").children[0].click(); await flush(); }
    if (mode === "zero") assert.match(element("quote-info").textContent, /Warning: no liquidity/);
    assert.equal(provider.sent.length, 0);
  });
}

function mixedPools(v3First) {
  const provider = new V3Mock();
  provider.v3Pools.delete(10000);
  provider.addV3Swap(3000, v3First ? -293000 : -292000);
  provider.addSwap(3000, 60, v3First ? -292000 : -293000);
  provider.setBalance(CALLER, E.PONS, 0);
  return provider;
}

for (const v3First of [true, false]) {
  test("mixed page warns, approves each leg's token, then sequences " + (v3First ? "V3 → V4" : "V4 → V3"), async () => {
    const page = await readyPage(mixedPools(v3First)), { provider, element, flush } = page;
    await element("spreads-body").children[0].click(); await flush();
    assert.equal(element("route-warning").hidden, false);
    assert.match(element("route-warning").textContent, /2 transactions/);
    assert.match(element("route-warning").textContent, v3First ? /V3 buy first, then V4/ : /V4 buy first, then V3/);
    await element("connect").click();
    assert.equal(provider.sent.length, 2);
    assert.match(element("status").textContent, /First leg dry run succeeded/);
    const txs = JSON.parse(element("calldata").textContent);
    assert.equal(txs.length, 2);
    assert.match(element("status").textContent, /Swap confirmed:.*First leg:/);
    assert.deepEqual(provider.sent.slice(2).map(tx => tx.to.toLowerCase()), v3First ? [E.V3_ROUTER.toLowerCase(), E.ROUTER.toLowerCase()] : [E.ROUTER.toLowerCase(), E.V3_ROUTER.toLowerCase()]);
    assert.match(element("activity").textContent, /Mixed leg 1 confirmed:.*\nMixed leg 2 submitted:/);
  });
}


// ------------------------------------------------------------------ Follow-up 5: Manual mode

const { ManualMock, liveManualMock, pool: manualPool, LIVE_POOL_A, LIVE_POOL_B, WETH: MANUAL_WETH, PONS: MANUAL_PONS } = require("./manual-mock.js");
const { poolA: MANUAL_POOL_A, poolB: MANUAL_POOL_B } = require("./v3-mock.js");

// Follow-up 6: Manual mode is one-shot (no poll timer), so a manual read is "done" when its status settles.
const manualSettled = (page) => !/Reading both pools…/.test(page.element("manual-status").textContent);

async function chooseMode(page, mode) {
  page.element("mode").value = mode;
  page.element("mode").change(false);
  await page.until(() => mode === "Manual" ? manualSettled(page) : page.monitorTimers().length > 0, "mode restart");
  await page.flush();
}

async function readPrices(page) {
  const before = page.provider.rpcCalls.length;
  await page.element("read-prices").click();
  await page.until(() => manualSettled(page) || /Enter a 42-char/.test(page.element("manual-status").textContent), "manual read");
  await page.flush();
  return page.provider.rpcCalls.slice(before);
}




// ------------------------------------------------------------------ Follow-up 6: All pairs, hardening

const { AllPairsMock, WETH: AP_WETH, PONS: AP_PONS, USDG: AP_USDG } = require("./allpairs-mock.js");

/** An All-pairs fixture: PONS against WETH and USDG with active pools in both pairs. */
function allPairsProvider() {
  const p = new AllPairsMock();
  const pu = E.sortPair(AP_PONS, AP_USDG), wp = E.sortPair(AP_WETH, AP_PONS);
  p.setV4Liquidity({ currency0: pu.currency0, currency1: pu.currency1, fee: 3000, tickSpacing: 60, hooks: E.NO_HOOKS }, 1000);
  p.setV4Liquidity({ currency0: pu.currency0, currency1: pu.currency1, fee: 30000, tickSpacing: 600, hooks: E.NO_HOOKS }, 7);
  p.addSwap(3000, 60, -292916);
  p.addSwap(30000, 600, -887272);
  p.addV3Swap(3000, -292916);
  p.addV3Swap(10000, -292000);
  p.v3Logs.push({ address: "0x1111111111111111111111111111111111111111", topics: [E.V3_SWAP_TOPIC, ethers.utils.hexZeroPad(CALLER, 32), ethers.utils.hexZeroPad(CALLER, 32)],
    data: ethers.utils.defaultAbiCoder.encode(["int256", "int256", "uint160", "uint128", "int24"], [1, -1, ethers.BigNumber.from(2).pow(96), 1, 93992]),
    blockNumber: ethers.utils.hexValue(p.block), logIndex: "0x9" });
  return p;
}




test("Manual mode marks a pool with liquidity() = 0 EMPTY and refuses to select it", async () => {
  const provider = new ManualMock();
  provider.setPool(MANUAL_POOL_B, manualPool(MANUAL_PONS, ethers.utils.getAddress(E.USDG), 10000, -292000, { liquidity: 0 }));
  const page = await readyPage(provider), { element } = page;
  element("pool-a").value = MANUAL_POOL_A;
  element("pool-b").value = MANUAL_POOL_B;
  await chooseMode(page, "Manual");
  assert.equal(provider.manualCalls.filter((c) => c.name === "liquidity").length, 2, "liquidity() read on both pools");
  const row = element("manual-body").children[0];
  assert.equal(row.children[5].textContent, "EMPTY");
  assert.match(row.children[1].textContent, /EMPTY \(liquidity 0\)$/);
  assert.equal(row.listeners.click, undefined, "not selectable");
  assert.equal(row.className, "");
  assert.match(element("manual-status").textContent, /1 pool\(s\) EMPTY: liquidity\(\) = 0, execution disabled/);
  assert.equal(page.timers.length, 0, "one-shot: no poll scheduled");
  assert.equal(provider.calls.length, 0, "an EMPTY manual row never executes");
});

// ------------------------------------------------------------------ Job 8: audit fixes, display, Permit2, UX

const PERMIT2_INLINE = /⚠️ Approve (USDG|PONS) for Permit2 in MetaMask \(Contract tab → Permit2 → increaseAllowance\) before this route will work\./;

/** The coloured value span of the quote line (job 8 fix 7). */
function quoteValueSpan(page) {
  return page.element("quote-info").children.find((child) => child.className === "green" || child.className === "red");
}

test("fix 7: the quote line colours the return value itself, green when it beats the input (V3 route)", async () => {
  const page = await readyPage(withV3Pools()), { element, flush } = page;
  await chooseProtocol(page, "V3");
  await element("spreads-body").children[0].click(); await flush();
  assert.match(element("quote-info").textContent, /Return quote: 0\.011 USDG for 0\.01 USDG \(return > input\)/);
  const value = quoteValueSpan(page);
  assert.equal(value.textContent, "0.011 USDG");
  assert.equal(value.className, "green");
  assert.equal(element("quote-info").className, "", "the line itself carries no colour; the value does");
  assert.equal(element("status").className, "success");
});

/** Three V4 pools where the dearest (30000/600) sells back less than the input: a losing round trip. */
function losingPools() {
  const provider = withActivePools();
  // amountOut = amountIn × price / 1e36: selling ~0.052 PONS at this price returns ~0.0052 USDG for a 0.01 USDG input.
  provider.quotes.set(E.poolId({ currency0: E.PONS, currency1: E.USDG, fee: 30000, tickSpacing: 600, hooks: E.NO_HOOKS }), ethers.BigNumber.from("100000000000000000000000"));
  return provider;
}


function busyText(page) { return /^Quoting|Building calldata|Rechecking/.test(page.element("status").textContent); }

/** Two V4 pools; the dearer 30000/600 exists but its quote is 0 (the mock's live fixture: no liquidity). */
function zeroSellPools() {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916);
  provider.addSwap(30000, 600, -292000);
  return provider;
}




// ------------------------------------------------------------------ Job 9: cross-DEX prices, removals

const X = require("../cross-dex-reader.js");
const CROSS_SUSHI = X.DEXES[0];
const CROSS_RAMSES = X.DEXES[1];
const CROSS_POOLS = {
  sushi500: "0x9B050cb1F265094b0977160a2BD7dA8C9E529c3C",
  sushi3000: "0xC5A01C57b2851202dCF8507a0F2Bd08a8025E2C8",
  ramses50: "0x288Eb58ee0F0E9378dEC1e8Fa51c389644c24685",
};

/**
 * Registers the two cross-DEX factories and their pools on a mock provider. The fake factories answer the
 * same pools for any pair (the tests check which pair is asked). Sushi: 0.05% and 0.30%; Ramses: tick spacing 50.
 */
function withCrossDexPools(provider, { sushi = true, ramses = true, sushiRevert = false, ticks = {} } = {}) {
  const enc = ethers.utils.defaultAbiCoder;
  provider.contracts = provider.contracts || new Map();
  provider.crossDexAsked = [];
  const factoryHandler = (dex, byTier, revert) => (tx) => {
    if (revert) throw new Error("execution reverted");
    const selector = tx.data.slice(0, 10);
    if (selector !== (dex.type === "v3" ? "0x1698ee82" : "0x28af8d0b")) throw new Error("execution reverted");
    const [a, b, tier] = enc.decode(["address", "address", dex.type === "v3" ? "uint24" : "int24"], "0x" + tx.data.slice(10));
    provider.crossDexAsked.push({ dex: dex.name, token0: a, token1: b, tier: Number(tier) });
    return enc.encode(["address"], [byTier.get(Number(tier)) || ethers.constants.AddressZero]);
  };
  const addPool = (address, tick, liquidity, fee) => provider.contracts.set(address.toLowerCase(), (tx) => {
    const selector = tx.data.slice(0, 10);
    if (provider.crossDexPoolFailure === address.toLowerCase()) throw new Error("pool read failed");
    if (selector === "0x3850c7bd") return enc.encode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [ethers.BigNumber.from(2).pow(96), tick, 0, 0, 0, 0, true]);
    if (selector === "0x1a686502") return enc.encode(["uint128"], [liquidity]);
    if (selector === "0xddca3f43") return enc.encode(["uint24"], [fee]);
    throw new Error("execution reverted");
  });
  const sushiPools = new Map();
  const ramsesPools = new Map();
  if (sushi) {
    sushiPools.set(500, CROSS_POOLS.sushi500);
    addPool(CROSS_POOLS.sushi500, ticks.sushi500 === undefined ? -292900 : ticks.sushi500, 12410, 500);
    sushiPools.set(3000, CROSS_POOLS.sushi3000);
    addPool(CROSS_POOLS.sushi3000, ticks.sushi3000 === undefined ? -292930 : ticks.sushi3000, 8200, 3000);
  }
  if (ramses) {
    ramsesPools.set(50, CROSS_POOLS.ramses50);
    addPool(CROSS_POOLS.ramses50, ticks.ramses50 === undefined ? -291990 : ticks.ramses50, 777, 3000);
  }
  provider.contracts.set(CROSS_SUSHI.factory.toLowerCase(), factoryHandler(CROSS_SUSHI, sushiPools, sushiRevert));
  provider.contracts.set(CROSS_RAMSES.factory.toLowerCase(), factoryHandler(CROSS_RAMSES, ramsesPools, false));
  return provider;
}

const crossRows = (element) => element("cross-dex-body").children.filter(notAlpRow).map((row) => row.children.map((c) => c.textContent));
const crossSettled = (page) => !/Reading /.test(page.element("cross-dex-note").textContent);

test("job 9: Cross-DEX Prices lists one row per pool with fee, 1.0001^tick price, raw liquidity, the spread against the deepest Uni V3 pool and OK; both factories are asked for the sorted pair on every poll", async () => {
  const provider = withCrossDexPools(withV3Pools());
  const page = await readyPage(provider), { element, poll, html } = page;
  await chooseProtocol(page, "V3");
  await page.until(() => crossSettled(page) && crossRows(element).length === 3, "cross-DEX rows");
  // The heading and table sit below the spreads tables and before the threshold fields.
  assert.ok(html.indexOf('id="cross-dex-heading"') > html.indexOf('id="allpairs-note"'));
  assert.ok(html.indexOf('id="cross-dex-heading"') < html.indexOf('id="threshold"'));
  assert.match(html, /<h3 id="cross-dex-heading">Cross-DEX Prices<\/h3>/);
  assert.match(html, /<th>DEX<\/th><th>Fee<\/th><th>Price<\/th><th>Liquidity<\/th><th>Spread vs Uni<\/th><th>Status<\/th>/);
  // Uni reference: the V3 1.00% pool (liquidity 200 > 100), tick -292000; prices shown as USDG per PONS (10^(18-6)).
  const uni = E.tickToPrice(-292000);
  const price = (tick) => (X.tickToPrice(tick) * 1e12).toPrecision(6) + " (tick " + tick + ")";
  const spread = (tick) => X.formatSpread(X.spreadVsUni(X.tickToPrice(tick), uni));
  assert.deepEqual(crossRows(element), [
    ["SushiSwap V3", "0.05%", price(-292900), "12,410", spread(-292900), "OK"],
    ["SushiSwap V3", "0.30%", price(-292930), "8,200", spread(-292930), "OK"],
    ["Ramses V3", "0.30% (ts 50)", price(-291990), "777", spread(-291990), "OK"],
  ]);
  assert.match(spread(-292900), /^-8\.\d\d%$/, "900 ticks below the reference");
  assert.match(spread(-291990), /^\+0\.10%$/, "10 ticks above it");
  assert.ok(element("cross-dex-body").children.filter(notAlpRow).every((row) => row.children[5].className === "green"));
  assert.match(element("cross-dex-note").textContent, /^3 pool\(s\) on SushiSwap V3 and Ramses V3 for 0x39dB…4571 \/ 0x5fc5…d168 · last read .* UTC · Uni reference: V3 1\.00% pool at /);
  assert.match(element("cross-dex-note").textContent, /· next read in 30s$/);
  // Both factories were asked with the sorted pair (PONS < USDG), Sushi for 100/500/3000, Ramses for its seven tick spacings.
  const asked = provider.crossDexAsked;
  assert.ok(asked.every((q) => lower(q.token0) === lower(E.PONS) && lower(q.token1) === lower(E.USDG)), "sorted pair");
  assert.deepEqual(asked.filter((q) => q.dex === "SushiSwap V3").map((q) => q.tier).slice(0, 3), [100, 500, 3000]);
  assert.deepEqual(asked.filter((q) => q.dex === "Ramses V3").map((q) => q.tier).slice(0, 7), [1, 5, 10, 50, 100, 200, 500]);
  assert.equal(provider.calls.length, 0, "the wallet is never asked");
  assert.equal(provider.sent.length, 0, "nothing is sent");
  // Every poll re-reads; the price follows the pool.
  const before = asked.length;
  provider.contracts.set(CROSS_POOLS.ramses50.toLowerCase(), (tx) => {
    const selector = tx.data.slice(0, 10);
    if (selector === "0x3850c7bd") return ethers.utils.defaultAbiCoder.encode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [1, -292000, 0, 0, 0, 0, true]);
    if (selector === "0x1a686502") return ethers.utils.defaultAbiCoder.encode(["uint128"], [1000]);
    return ethers.utils.defaultAbiCoder.encode(["uint24"], [1000]);
  });
  await poll();
  await page.until(() => crossRows(element)[2][4] === "0.00%", "the re-read");
  assert.ok(asked.length >= before + 10, "getPool again on the next poll");
  assert.deepEqual(crossRows(element)[2], ["Ramses V3", "0.10% (ts 50)", price(-292000), "1,000", "0.00%", "OK"]);
  assert.equal(element("cross-dex-body").children.filter(notAlpRow).every((row) => !row.listeners.click), true, "rows are display only");
});

test("job 9: without a priced Uni V3 pool the Spread column shows —; a reverting factory gives its DEX one error row; no pools at all is an empty table without error", async () => {
  // V4-only fixture: the Uniswap V3 factory answers 0x0 for every tier, so there is no reference.
  const noUni = await readyPage(withCrossDexPools(withActivePools()));
  await noUni.until(() => crossSettled(noUni) && crossRows(noUni.element).length === 3, "rows without a reference");
  assert.deepEqual(crossRows(noUni.element).map((row) => row[4]), ["—", "—", "—"]);
  assert.match(noUni.element("cross-dex-note").textContent, /Uni reference: none \(no priced Uni V3 pool, Spread shows —\)/);
  assert.ok(crossRows(noUni.element).every((row) => row[5] === "OK"));

  // The brief's literal Ramses configuration would behave like this: the factory reverts on getPool.
  const reverting = await readyPage(withCrossDexPools(withActivePools(), { sushiRevert: true }));
  await reverting.until(() => crossSettled(reverting) && crossRows(reverting.element).length === 2, "one error row and one pool");
  assert.deepEqual(crossRows(reverting.element).map((row) => [row[0], row[1], row[2], row[3], row[5].split(" · ")[0]]),
    [["SushiSwap V3", "—", "—", "—", "error"], ["Ramses V3", "0.30% (ts 50)", (X.tickToPrice(-291990) * 1e12).toPrecision(6) + " (tick -291990)", "777", "OK"]]);
  assert.match(crossRows(reverting.element)[0][5], /^error · .*execution reverted/);
  assert.equal(reverting.element("cross-dex-body").children.filter(notAlpRow)[0].children[5].className, "red");
  assert.equal(reverting.element("cross-dex-note").className, "muted", "a DEX error is not a poll error");

  // No pools on either DEX: empty table, no error.
  const empty = await readyPage(withCrossDexPools(withActivePools(), { sushi: false, ramses: false }));
  await empty.until(() => crossSettled(empty), "the empty read");
  assert.equal(crossRows(empty.element).length, 0);
  assert.match(empty.element("cross-dex-note").textContent, /^0 pool\(s\) on SushiSwap V3 and Ramses V3 .* · no pools on either DEX · Uni reference: none/);
  assert.equal(empty.element("cross-dex-note").className, "muted");

  // Factories not deployed at all (the plain mock reverts every unknown address): both DEXes show error rows, nothing else breaks.
  const bare = await readyPage(withActivePools());
  await bare.until(() => crossSettled(bare) && crossRows(bare.element).length === 2, "two error rows");
  assert.deepEqual(crossRows(bare.element).map((row) => [row[0], row[5].split(" · ")[0]]), [["SushiSwap V3", "error"], ["Ramses V3", "error"]]);
  assert.equal(bare.element("spreads-body").children.length > 0, true, "the Uniswap tables keep working");
});

test("job 9: an RPC failure marks the rows error and keeps the last good values; the next poll recovers; the pair change restarts the table", async () => {
  const provider = withCrossDexPools(withV3Pools());
  const page = await readyPage(provider), { element, poll } = page;
  await chooseProtocol(page, "V3");
  await page.until(() => crossSettled(page) && crossRows(element).length === 3, "cross-DEX rows");
  const good = crossRows(element);
  // Every HTTP post carrying a cross-DEX factory read fails: a transport error for the reader.
  provider.beforeRpc = (call) => {
    const to = call.params && call.params[0] && call.params[0].to;
    if (to && [CROSS_SUSHI.factory, CROSS_RAMSES.factory].map((a) => a.toLowerCase()).includes(to.toLowerCase())) throw new Error("socket hang up");
  };
  await poll();
  await page.until(() => crossRows(element).length === 3 && crossRows(element).every((row) => row[5].startsWith("error")), "error rows");
  const errored = crossRows(element);
  assert.deepEqual(errored.map((row) => row.slice(0, 5)), good.map((row) => row.slice(0, 5)), "price, liquidity and spread kept");
  assert.ok(errored.every((row) => row[5].startsWith("error · ")));
  assert.match(element("cross-dex-note").textContent, /RPC error: .* · last good data kept/);
  assert.equal(element("cross-dex-note").className, "error");
  provider.beforeRpc = null;
  await poll();
  await page.until(() => crossRows(element).every((row) => row[5] === "OK"), "recovery");
  assert.deepEqual(crossRows(element), good);
  assert.equal(element("cross-dex-note").className, "muted");
  // One pool failing: only its row is error, with its last values.
  provider.crossDexPoolFailure = CROSS_POOLS.sushi3000.toLowerCase();
  await poll();
  await page.until(() => crossRows(element)[1][5].startsWith("error"), "one error row");
  assert.deepEqual(crossRows(element)[1].slice(0, 5), good[1].slice(0, 5));
  assert.equal(crossRows(element)[0][5], "OK");
  assert.equal(crossRows(element)[2][5], "OK");
  provider.crossDexPoolFailure = null;
  // A new pair restarts from an empty table and asks the factories for the new sorted pair.
  const third = "0x1111111111111111111111111111111111111111";
  provider.tokens.set(third.toLowerCase(), ["THIRD", 18]);
  element("token-b").value = third;
  provider.crossDexAsked.length = 0;
  await element("apply-pair").click();
  await page.until(() => provider.crossDexAsked.length >= 10 && crossSettled(page), "the new pair read");
  assert.ok(provider.crossDexAsked.every((q) => lower(q.token0) === third && lower(q.token1) === lower(E.PONS)), "sorted: 0x1111… < PONS");
  assert.match(element("cross-dex-note").textContent, /for 0x1111…1111 \/ 0x39dB…4571/);
});




// ------------------------------------------------------------------ job 10: data logger reframe + ALP V4 rows + emergency transfer
const A = require("../v4-alp-bridge.js");

test("job 10: the page is a data logger: I/O TERMINAL label, no approve / dry run / send / revoke controls, quotes stay read-only", async () => {
  const html = fs.readFileSync(path.join(__dirname, "../../index.html"), "utf8");
  assert.match(html, /id="io-terminal-label"[^>]*><strong>I\/O TERMINAL<\/strong>/);
  for (const gone of ["approve-permit2", "approve-v3-router", 'id="dry-run"', 'id="send"', "revoke-all", 'id="transfer-a"', 'id="transfer-b"', 'id="transfer-eth"', 'id="min-out"', 'id="calldata"']) {
    assert.equal(html.includes(gone), false, gone + " must be gone");
  }
  for (const kept of ['id="read-prices"', 'id="cross-dex-body"', 'id="selected-pools"', 'id="quote-info"', 'id="spreads-body"', 'id="alp-reads-body"', 'id="transfer-send"', 'id="transfer-token"']) {
    assert.ok(html.includes(kept), kept + " must stay");
  }
  const script = /<script>([\s\S]*)<\/script>/.exec(html)[1];
  for (const call of ["prepareRoute", "sendRoute", "approvePermit2", "approveRoutePermit2", "approveRouteV3", "revokeAll", "maybeAutoExecute"]) {
    assert.equal(script.includes(call), false, "no execution path through " + call);
  }
  // The only wallet writes left are the two transfer functions.
  assert.ok(script.includes("wallet.transferAllToken(") && script.includes("wallet.transferAllEth("));
  // A quote still runs and shows what the swap WOULD return, with a wallet never asked to sign.
  const page = await readyPage(withActivePools());
  await page.element("spreads-body").children[0].click();
  await page.flush();
  assert.match(page.element("quote-info").textContent, /Swap 1 quote: .* → /);
  assert.match(page.element("status").textContent, /read-only|Read-only/i);
  assert.equal(page.provider.sent.length, 0);
});

test("job 10: the emergency transfer is one button for the selected asset; it needs a connection, an acknowledgement and a valid other address", async () => {
  const { provider, element, flush } = await readyPage();
  element("transfer-to").input(OTHER);
  await element("transfer-ack").change(true);
  assert.equal(element("transfer-send").disabled, true); // not connected
  await element("connect").click();
  assert.equal(element("transfer-send").disabled, false);
  element("transfer-to").input(CALLER);
  assert.equal(element("transfer-send").disabled, true); // never to the same account
  element("transfer-to").input("0x12");
  assert.equal(element("transfer-send").disabled, true);
  element("transfer-to").input(OTHER);
  await element("transfer-ack").change(false);
  assert.equal(element("transfer-send").disabled, true);
  await element("transfer-ack").change(true);

  element("transfer-token").value = "a";
  await element("transfer-send").click();
  await flush();
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].to, ethers.utils.getAddress(E.PONS));
  const decoded = erc20.decodeFunctionData("transfer", provider.sent[0].data);
  assert.equal(decoded.to, OTHER);
  assert.equal(ethers.utils.formatUnits(decoded.amount, 18), "1.5");
  assert.match(element("transfer-result").textContent, /Token A transfer confirmed\. Amount 1500000000000000000 base units\. Tx 0x0+1$/);
  assert.equal(element("bal-a").textContent, "0.0 PONS");
  assert.equal(element("transfer-ack").checked, false); // re-acknowledge for the next asset
  assert.equal(element("transfer-send").disabled, true);

  await element("transfer-ack").change(true);
  element("transfer-token").value = "eth";
  await element("transfer-send").click();
  await flush();
  assert.equal(provider.sent.length, 2);
  const reserve = provider.gasEstimate.mul(provider.gasPrice).mul(2);
  assert.ok(ethers.BigNumber.from(provider.sent[1].value).eq(ethers.utils.parseEther("0.2").sub(reserve)));
  assert.match(element("transfer-result").textContent, /ETH transfer confirmed/);

  await element("transfer-ack").change(true);
  element("transfer-token").value = "b";
  await element("transfer-send").click();
  await flush();
  assert.equal(provider.sent.length, 3);
  assert.equal(provider.sent[2].to, E.USDG);
  assert.equal(element("bal-b").textContent, "0.0 USDG");
});

test("job 10: a rejected emergency transfer is reported as a failure, never as confirmed; nothing else is sent", async () => {
  const { provider, element, flush } = await readyPage();
  await element("connect").click();
  element("transfer-to").input(OTHER);
  await element("transfer-ack").change(true);
  provider.rejectSend = 1;
  await element("transfer-send").click();
  await flush();
  assert.match(element("transfer-result").textContent, /Token A transfer failed: Wallet request rejected/);
  assert.equal(element("bal-a").textContent, "1.5 PONS");
  assert.doesNotMatch(element("transfer-result").textContent, /confirmed/);
});

test("job 10: ALP V4 rows join the Cross-DEX table and the slot0 table; an unreachable V4 RPC marks them error without breaking the page", async () => {
  const page = await readyPage(withActivePools());
    const alpRows = page.element("cross-dex-body").children.filter((row) => /^ALP V4 · ALP\//.test(row.children[0].textContent));
  assert.equal(alpRows.length, 2, "ALP/ETH and ALP/USDG rows");
  assert.equal(alpRows[0].children[0].textContent, "ALP V4 · ALP/ETH (Base)");
  assert.equal(alpRows[0].children[1].textContent, "0.0001%");
  assert.equal(alpRows[0].children[4].textContent, "—"); // no Uniswap reference of the same pair
  assert.match(alpRows[0].children[5].textContent, /^error · /); // the mock answers only the Robinhood RPC URL
  assert.equal(page.element("alp-reads-body").children.length, 2);
  assert.match(page.element("alp-note").textContent, /Base \(8453\) · stateView reads · 0 of 2 pool\(s\) OK · RPC error/);
  // The Base reads went to the Base RPC as one JSON-RPC batch of 3 eth_calls per pool, never to the wallet.
  const base = page.provider.httpCalls.filter((call) => call.url === A.RPC_URL);
  assert.ok(base.length >= 1);
  assert.equal(base[0].body.length, 6);
  assert.ok(base[0].body.every((call) => call.method === "eth_call"));
  assert.equal(base[0].body[0].params[0].to, A.POSITION_MANAGER);
  assert.equal(base[0].body[1].params[0].to, A.STATE_VIEW);
  assert.equal(page.provider.sent.length, 0);
  // The Uniswap rows and the cross-DEX machinery still render.
  assert.ok(page.element("pools-body").children.length > 0);
});

test("job 10: switching the ALP V4 chain to Robinhood reads the PoolManager through extsload with the verified PoolKey", async () => {
  const page = await readyPage(withActivePools());
  page.element("alp-chain").value = "4663";
  await page.element("alp-chain").change();
  await page.flush();
  assert.equal(page.element("alp-rpc").value, A.CHAINS[4663].rpcUrl);
  const batch = page.provider.httpCalls.filter((call) => Array.isArray(call.body) && call.body.length === 4 &&
    call.body.every((c) => c.method === "eth_call" && lower(c.params[0].to) === lower(A.CHAINS[4663].poolManager))).at(-1);
  assert.ok(batch, "one batch of 2 extsload calls per pool");
  assert.equal(batch.body[0].params[0].data, A.encodeExtsloadCall(A.slot0StorageSlot(A.POOLS[0].poolId)));
  assert.equal(batch.body[1].params[0].data, A.encodeExtsloadCall(A.liquidityStorageSlot(A.POOLS[0].poolId)));
  const rows = page.element("alp-reads-body").children;
  assert.equal(rows.length, 2);
  // The key column shows the verified key (ETH / ALP / 1 / 1 / no hook) whatever the mock's storage says.
  assert.match(rows[0].children[1].textContent, /^0x0000000000000000000000000000000000000000 \/ 0x29D95816a65425B3514f9AcaC7548b867343B818 \/ 1 \/ 1 \//);
  assert.match(page.element("alp-note").textContent, /Robinhood Chain \(4663\) · extsload reads/);
  assert.match(page.element("activity").textContent, /ALP V4 chain: Robinhood Chain\./);
});

test("job 10: the route line names the ALP bridge for a USDG pair with the V3 fee, the V4 fee and the total fee", async () => {
  const page = await readyPage(withActivePools());
  const line = page.element("alp-route").textContent;
  assert.match(line, /^Route: PONS → ALP \(V3 0\.\d+%\) → USDG \(V4 0\.0001%\) \| Total fee: 0\.\d+%/);
  assert.match(line, /V4 leg quote unavailable/); // the ALP/USDG pool was not readable in this test
  assert.equal(A.describeRoute("TOKEN", 3000, "USDG", 1), "Route: TOKEN → ALP (V3 0.30%) → USDG (V4 0.0001%) | Total fee: 0.3001%");
});
