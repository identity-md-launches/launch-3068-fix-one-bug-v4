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
const { V3Mock, v3, decodePath } = require("./v3-mock.js");

function node(tag, attributes = {}) {
  return {
    tagName: tag,
    textContent: "",
    value: attributes.value || "",
    disabled: attributes.disabled || false,
    checked: attributes.checked || false,
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

function loadPage(provider = new MockWallet(), { noWallet = false } = {}) {
  const root = path.resolve(__dirname, "../..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const elements = new Map();
  for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    const created = node(/^<(\w+)/.exec(tag)[1], {
      value: /\bvalue="([^"]*)"/.exec(tag)?.[1] || "",
      disabled: /\bdisabled\b/.test(tag),
      checked: /\bchecked\b/.test(tag),
    });
    created.textContent = (/^([^<]*)</.exec(html.slice(match.index + tag.length))?.[1] || "").trim();
    elements.set(match[1], created);
  }
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
    window: { ethereum: noWallet ? undefined : provider, crypto: globalThis.crypto, fetch: provider.fetch },
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
  const poll = async () => {
    const due = timers.splice(0);
    assert.ok(due.length, "no poll scheduled");
    for (const t of due) t.fn();
    await until(() => timers.length > 0, "the next poll to be scheduled");
    await flush(5);
  };
  return { provider, element: document.getElementById, context, html, timers, flush, until, poll };
}

/** A page whose first poll has finished. */
async function readyPage(provider = new MockWallet()) {
  const page = loadPage(provider);
  await page.until(() => page.timers.length > 0, "first poll");
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

test("page loads offline, polls the public RPC without any wallet call, and shows seven inactive pools", async () => {
  const { provider, element, html, timers } = await readyPage();
  assert.ok(html.includes("APPROVE PERMIT2 (one-time)"));
  assert.ok(html.includes("CONNECT WALLET"));
  assert.ok(html.includes("TRANSFER TO NEW WALLET"));
  assert.ok(html.includes("Sends ALL of this asset to the new address. Cannot undo."));
  assert.equal(provider.calls.length, 0);
  assert.ok(provider.rpcCalls.some((c) => c.method === "eth_getLogs"));
  assert.ok(provider.rpcCalls.every((c) => c.url === E.RPC_URL));
  assert.equal(element("pools-body").children.length, 7);
  assert.deepEqual(element("pools-body").children.map((row) => row.children[0].textContent), ["0", "0", "500", "2500", "3000", "10000", "30000"]);
  assert.ok(element("pools-body").children.every((row) => row.children[4].textContent.startsWith("no")));
  assert.equal(element("spreads-body").children.length, 0);
  assert.match(element("spreads-note").textContent, /^No tradeable spreads/);
  assert.match(element("poll-status").textContent, /Last poll .* block 108394834 .* window 3000 blocks \(108391835–108394834\)/);
  assert.match(element("pair-info").textContent, /Token A PONS · Token B USDG · currency0 = PONS/);
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  assert.equal(element("send").disabled, true);
  assert.equal(element("dry-run").disabled, true);
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("transfer-a").disabled, true);
  assert.equal(element("bal-a").textContent, "—");
});

test("active pools render prices and the top spreads; the full flow runs with the selected pools and updates balances", async () => {
  const { provider, element, poll, flush } = await readyPage(withActivePools());
  await poll();
  const rows = element("pools-body").children;
  assert.match(rows[4].children[2].textContent, /^0\.19030[0-9]* \(tick -292916\)$/);
  assert.equal(rows[4].children[3].textContent, "1");
  assert.equal(rows[4].children[4].textContent, "yes");
  assert.equal(rows[0].children[2].textContent, "—");
  const spreads = element("spreads-body").children;
  assert.equal(spreads.length, 3);
  assert.equal(spreads[0].children[0].textContent, "3000 / 60");
  assert.equal(spreads[0].children[1].textContent, "30000 / 600");
  assert.equal(spreads[0].children[3].textContent, "3.300");
  assert.equal(spreads[0].children[5].textContent, "GREEN");
  assert.equal(spreads[2].children[5].textContent, "RED");
  assert.match(element("spreads-note").textContent, /3 spread\(s\) from 3 tradeable pool\(s\)/);

  // Click the best row: the pool keys are filled and swap 1 is quoted through the public RPC.
  await spreads[0].click();
  await flush();
  const selected = JSON.parse(element("selected-pools").textContent);
  assert.equal(selected.buyPool.fee, 3000);
  assert.equal(selected.buyPool.tickSpacing, 60);
  assert.equal(selected.sellPool.fee, 30000);
  assert.equal(selected.buyPool.currency0, ethers.utils.getAddress(E.PONS));
  assert.equal(element("bridge-amount").value, "0.052096879755458694");
  assert.match(element("quote-info").textContent, /Swap 1 quote: 0\.01 USDG → 0\.052358673121064015 PONS on pool 3000 \/ 60/);
  assert.equal(provider.calls.length, 0); // still no wallet involvement
  assert.equal(element("dry-run").disabled, true); // not connected yet

  await element("connect").click();
  assert.equal(element("account").textContent, CALLER);
  assert.equal(element("bal-a").textContent, "1.5 PONS");
  assert.equal(element("bal-b").textContent, "25.0 USDG");
  assert.equal(element("bal-eth").textContent, "0.2 ETH");
  assert.match(element("transfer-balances").textContent, /1\.5 PONS · 25\.0 USDG · 0\.2 ETH/);
  assert.equal(element("dry-run").disabled, false);
  assert.match(element("approval-limits").textContent, /1\.0 USDG and 5\.2096879755458694 PONS/);
  await element("approve-permit2").click();
  assert.equal(provider.sent.length, 2);
  assert.match(element("status").textContent, /allowances are ready/);
  assert.match(element("activity").textContent, /USDG Permit2 approval confirmed:/);
  assert.match(element("activity").textContent, /PONS Permit2 approval confirmed:/);
  await element("dry-run").click();
  assert.match(element("status").textContent, /Dry run succeeded/);
  const data = element("calldata").textContent;
  assert.equal(data, E.buildCalldata({
    usdgIn: ethers.utils.parseUnits("0.01", 6),
    ponsAmount: "52096879755458694",
    minUsdgOut: 0,
    recipient: CALLER,
    deadline: provider.now + 1200,
    buyPool: { currency0: E.PONS, currency1: E.USDG, fee: 3000, tickSpacing: 60, hooks: E.NO_HOOKS },
    sellPool: { currency0: E.PONS, currency1: E.USDG, fee: 30000, tickSpacing: 600, hooks: E.NO_HOOKS },
  }));
  assert.equal(element("send").disabled, false);
  await element("send").click();
  assert.equal(provider.sent.length, 3);
  assert.equal(provider.sent[2].data, data);
  assert.match(element("status").textContent, /Swap confirmed:/);
  assert.equal(element("bal-b").textContent, "24.99 USDG"); // refreshed after the receipt
  assert.equal(element("send").disabled, true);
});

test("a buy pool without liquidity warns 'no liquidity' and keeps sending disabled", async () => {
  const provider = new MockWallet();
  provider.addSwap(30000, 600, -293500); // cheapest, but empty on the router
  provider.addSwap(3000, 60, -292916);
  const { element, poll, flush } = await readyPage(provider);
  await poll();
  await element("connect").click();
  const row = element("spreads-body").children[0];
  assert.equal(row.children[0].textContent, "30000 / 600");
  await row.click();
  await flush();
  assert.match(element("quote-info").textContent, /Warning: no liquidity/);
  assert.equal(element("quote-info").className, "error");
  assert.match(element("status").textContent, /No liquidity/);
  assert.equal(element("dry-run").disabled, true);
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("send").disabled, true);
  assert.equal(element("bridge-amount").value, "");
  assert.equal(provider.sent.length, 0);
});

test("RPC errors show the 60 s retry in the status bar and polling continues afterwards", async () => {
  const { provider, element, timers, poll } = await readyPage();
  provider.rpcFailures = 1;
  await poll();
  assert.match(element("poll-status").textContent, /^RPC error, retrying in 60s — RPC error: rate limited · last successful poll/);
  assert.equal(element("poll-status").className, "error");
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  assert.equal(element("pools-body").children.length, 7);
  provider.httpFailures = 1;
  await poll();
  assert.match(element("poll-status").textContent, /RPC error, retrying in 60s — .*HTTP error 429/);
  assert.deepEqual(timers.map((t) => t.ms), [E.RPC_RETRY_MS]);
  provider.block += 10;
  await poll();
  assert.match(element("poll-status").textContent, /Last poll .* block 108394844/);
  assert.equal(element("poll-status").className, "success");
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
});

test("auto mode executes a GREEN spread once, never double-fires while a receipt is pending, and resumes after it", async () => {
  const { provider, element, poll, flush, until } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  await element("approve-permit2").click();
  assert.equal(provider.sent.length, 2);

  // Hold the swap's receipt until released; the poll keeps firing meanwhile.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.beforeRequest = async ({ method, params }) => {
    if (method === "eth_getTransactionReceipt" && params[0] === ethers.utils.hexZeroPad("0x03", 32)) await gate;
  };
  await element("auto-mode").change(true);
  await until(() => provider.sent.length === 3, "the auto-mode swap to be submitted");
  assert.match(element("activity").textContent, /Auto mode: best spread 3000 \/ 60 → 30000 \/ 600 net 6\.\d+% is above the threshold; executing/);
  await poll();
  await poll();
  assert.equal(provider.sent.length, 3, "no second swap while the first receipt is pending");
  assert.equal(element("send").disabled, true);
  release();
  await until(() => /Swap confirmed/.test(element("status").textContent), "the swap receipt");
  assert.equal(element("auto-mode").checked, true);
  provider.beforeRequest = null;
  await poll();
  await until(() => provider.sent.length === 4, "the next auto-mode swap");
  await until(() => /Swap confirmed/.test(element("status").textContent) && element("send").disabled, "second receipt");
  assert.equal(provider.sent[3].to, E.ROUTER);

  // Off: polls no longer send.
  await element("auto-mode").change(false);
  await poll();
  await flush();
  assert.equal(provider.sent.length, 4);
});

test("auto mode respects the threshold, turns itself off after a failure, and stays off after a timed-out receipt", async () => {
  const { provider, element, poll, flush, until } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  await element("approve-permit2").click();
  element("threshold").input("10"); // best net is about 6.3%
  assert.equal(element("spreads-body").children[0].children[5].textContent, "RED");
  await element("auto-mode").change(true);
  await poll();
  await flush();
  assert.equal(provider.sent.length, 2);
  assert.equal(element("auto-mode").checked, true);

  element("threshold").input("abc");
  assert.match(element("auto-status").textContent, /non-negative number.*Using 0\.5%/);
  element("threshold").input("1");
  provider.failRouterCall = provider.routerCalls + 1; // the dry run fails
  await poll();
  await until(() => element("auto-mode").checked === false, "auto mode to switch off");
  assert.match(element("auto-status").textContent, /turned OFF after a failed attempt/);
  assert.match(element("activity").textContent, /pool unavailable/);
  assert.equal(provider.sent.length, 2);
  await poll();
  await flush();
  assert.equal(provider.sent.length, 2);

  // A receipt that never arrives blocks auto mode until it is switched on again.
  provider.neverMine = true;
  await element("auto-mode").change(true);
  await until(() => provider.sent.length === 3, "a swap submission");
  await until(() => /may still be pending/.test(element("status").textContent), "the receipt timeout");
  assert.equal(element("auto-mode").checked, false);
  assert.match(element("activity").textContent, /Pending transaction 0x0+3: auto mode stays off/);
  provider.neverMine = false;
  await poll();
  await flush();
  assert.equal(provider.sent.length, 3);
}, { timeout: 180000 });

test("changing the pair restarts polling for the new tokens; a bad address is reported and recoverable", async () => {
  const provider = new MockWallet();
  const third = "0x1111111111111111111111111111111111111111";
  provider.tokens.set(third, ["FOO", 8]);
  provider.addSwap(3000, 60, -1000, provider.block, { currency0: third, currency1: E.PONS });
  const { element, until, timers, flush } = await readyPage(provider);
  element("token-b").input(third);
  await element("apply-pair").click();
  await until(() => /FOO/.test(element("pair-info").textContent), "new pair");
  await flush(5);
  assert.match(element("pair-info").textContent, /Token A PONS · Token B FOO · currency0 = FOO/);
  assert.equal(element("pools-body").children[4].children[4].textContent, "yes");
  assert.equal(element("selected-pools").textContent, "No spread selected.");
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  element("token-b").input("0x1234");
  await element("apply-pair").click();
  await flush(5);
  assert.match(element("poll-status").textContent, /invalid address/);
  assert.equal(timers.length, 0);
  element("token-b").input(E.PONS);
  await element("apply-pair").click();
  await flush(5);
  assert.match(element("poll-status").textContent, /must be different/);
  element("token-b").input(E.USDG);
  await element("apply-pair").click();
  await until(() => timers.length > 0, "polling to resume");
  assert.match(element("pair-info").textContent, /Token B USDG/);
});

// ------------------------------------------------------------------ follow-up 3.5

const id = (fee, tickSpacing) => E.poolId({ currency0: E.PONS, currency1: E.USDG, fee, tickSpacing, hooks: E.NO_HOOKS });
const FEES = { 3000: 4, 2500: 3, 30000: 6 }; // row index in the pools table
const logsFilter = (provider) => provider.rpcCalls.filter((c) => c.method === "eth_getLogs").at(-1).params[0];
const logsSpan = provider => {
  const filters = provider.httpCalls.filter(c => Array.isArray(c.body) && c.body.some(call => call.method === "eth_getLogs"))
    .at(-1).body.filter(call => call.method === "eth_getLogs").map(call => call.params[0]);
  return provider.block - Math.min(...filters.map(filter => Number(filter.fromBlock)));
};

test("the Window field defaults to 3000 within 50 to 50000, is live, and the status bar shows it", async () => {
  const { provider, element, poll, html } = await readyPage();
  assert.match(html, /<label>Window \(blocks\)<input id="window-blocks" type="number" value="3000" min="50" max="50000"/);
  assert.ok(html.indexOf('id="window-blocks"') < html.indexOf('id="pools-heading"'));
  assert.equal(element("window-status").textContent, "3000 blocks");
  assert.match(element("poll-status").textContent, /window 3000 blocks/);
  assert.equal(logsSpan(provider), 2999);
  const startCalls = provider.rpcCalls.filter((c) => c.params[0] && c.params[0].data === erc20.getSighash("symbol")).length;

  element("window-blocks").input("500");
  assert.equal(element("window-status").textContent, "500 blocks"); // shown at once
  assert.match(element("poll-status").textContent, /window 3000 blocks/); // the last poll is still the last poll
  await poll();
  assert.equal(logsSpan(provider), 499);
  assert.match(element("poll-status").textContent, /window 500 blocks/);
  assert.equal(element("swaps-heading").textContent, "Swaps (500 blocks)");
  // Not restarted: the pair's symbols were not read again.
  assert.equal(provider.rpcCalls.filter((c) => c.params[0] && c.params[0].data === erc20.getSighash("symbol")).length, startCalls);

  // Out of range or malformed: the last valid value stays and the bar says so.
  for (const bad of ["49", "50001", "", "abc"]) {
    element("window-blocks").input(bad);
    assert.match(element("window-status").textContent, /^500 blocks \(enter a whole number from 50 to 50000/);
    assert.equal(element("window-status").className, "error");
    await poll();
    assert.equal(logsSpan(provider), 499);
  }
  element("window-blocks").input("50000");
  assert.equal(element("window-status").textContent, "50000 blocks");
  assert.equal(element("window-status").className, "");
  await poll();
  assert.equal(logsSpan(provider), 49999);
  assert.ok(provider.rpcCalls.every((c) => c.method !== "eth_blockNumber"));
});

test("Last Swap shows elapsed chain time in green, yellow and red; the price stays 1.0001^tick", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block - 300, { ageSeconds: 1799 });
  provider.addSwap(2500, 25, -292902, provider.block - 200, { ageSeconds: 1800 });
  provider.addSwap(30000, 600, -292000, provider.block - 100, { ageSeconds: 11520 });
  const { element, html } = await readyPage(provider);
  assert.match(html, /<th>Active\?<\/th><th>Last Swap<\/th>/);
  assert.match(html, /\.yellow \{/);
  const rows = element("pools-body").children;
  const lastSwap = (fee) => rows[FEES[fee]].children[5];
  assert.equal(lastSwap(3000).textContent, "29m ago");
  assert.equal(lastSwap(3000).className, "green");
  assert.equal(lastSwap(2500).textContent, "30m ago");
  assert.equal(lastSwap(2500).className, "yellow");
  assert.equal(lastSwap(30000).textContent, "3h 12m ago");
  assert.equal(lastSwap(30000).className, "red");
  assert.equal(rows[0].children[5].textContent, "—");
  assert.match(rows[FEES[3000]].children[2].textContent, /\(tick -292916\)$/);
  assert.equal(rows[FEES[3000]].children.length, 7); // appended Protocol column
  assert.equal(rows[FEES[3000]].children[6].textContent, "V4");
});

test("a pool past Max staleness is marked STALE and leaves the spreads; the field applies at once and a typo keeps the last value", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block - 300, { ageSeconds: 11520 });
  provider.addSwap(30000, 600, -292000, provider.block - 100, { ageSeconds: 60 });
  const { element, html, poll } = await readyPage(provider);
  assert.match(html, /<label>Max staleness \(seconds\)<input id="max-staleness" type="number" value="7200"/);
  assert.ok(html.indexOf('id="max-staleness"') - html.indexOf('id="threshold"') < 300);
  const rows = () => element("pools-body").children;
  assert.equal(rows()[FEES[3000]].children[4].textContent, "yes · STALE");
  assert.equal(rows()[FEES[3000]].children[4].className, "red");
  assert.notEqual(rows()[FEES[3000]].children[2].textContent, "—"); // still shown in the table
  assert.equal(element("spreads-body").children.length, 0);
  assert.match(element("spreads-note").textContent, /^No tradeable spreads\. Active pools: 2, tradeable: 1\.$/);

  element("max-staleness").input("20000");
  assert.equal(rows()[FEES[3000]].children[4].textContent, "yes");
  assert.equal(element("spreads-body").children.length, 1);
  element("max-staleness").input("abc");
  assert.match(element("auto-status").textContent, /Using 20000 until fixed/);
  assert.equal(element("auto-status").className, "error");
  await poll();
  assert.equal(element("spreads-body").children.length, 1); // the typo did not change the limit
  element("max-staleness").input("100");
  assert.equal(element("spreads-body").children.length, 0);
  await poll();
  assert.equal(rows()[FEES[3000]].children[4].textContent, "yes · STALE");
});

test("EMPTY and UNKNOWN pools are marked and excluded while the rest of the table keeps working", async () => {
  const provider = withActivePools();
  provider.setSlot0(id(30000, 600), ethers.constants.HashZero);
  provider.slot0Fail.add(id(2500, 25));
  const { element, poll, timers } = await readyPage(provider);
  const rows = () => element("pools-body").children;
  assert.equal(rows()[FEES[30000]].children[4].textContent, "yes · EMPTY");
  assert.equal(rows()[FEES[2500]].children[4].textContent, "yes · UNKNOWN");
  assert.equal(rows()[FEES[3000]].children[4].textContent, "yes");
  assert.equal(rows()[FEES[2500]].children[3].textContent, "1"); // other columns still display
  assert.equal(element("spreads-body").children.length, 0);
  assert.match(element("spreads-note").textContent, /^No tradeable spreads/);
  assert.equal(element("poll-status").className, "success");
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  provider.slot0Fail.clear();
  await poll();
  assert.equal(rows()[FEES[2500]].children[4].textContent, "yes");
  assert.equal(element("spreads-body").children.length, 1);
  assert.equal(element("spreads-body").children[0].children[5].textContent, "RED");
});

test("auto mode logs why it skips a stale pool, sends nothing, repeats no log line, and fires on a clean pair", async () => {
  const provider = withActivePools();
  const { element, poll, flush, until } = await readyPage(provider);
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  await element("approve-permit2").click();
  assert.equal(provider.sent.length, 2);

  // Replace the logs: 3000/60 (cheap) and 30000/600 (dear) form the only GREEN spread; 3000/60 goes stale.
  provider.logs.length = 0;
  provider.addSwap(3000, 60, -292916, provider.block - 300, { ageSeconds: 11520 });
  provider.addSwap(30000, 600, -292000, provider.block - 100, { ageSeconds: 60 });
  await poll();
  await element("auto-mode").change(true);
  await flush();
  assert.equal(provider.sent.length, 2);
  assert.match(element("activity").textContent, /auto skipped: pool 3000\/60 stale \(3h 12m\)/);
  const count = () => element("activity").textContent.split("auto skipped:").length - 1;
  assert.equal(count(), 1);
  await poll();
  await flush();
  assert.equal(count(), 1, "one line per pool until its status changes");
  assert.equal(provider.sent.length, 2);
  assert.equal(element("auto-mode").checked, true); // a skip is not a failure

  // Now the same pool is EMPTY: a new reason gets a new line. Still nothing is sent.
  provider.setSlot0(id(3000, 60), ethers.constants.HashZero);
  await poll();
  await flush();
  assert.match(element("activity").textContent, /auto skipped: pool 3000\/60 empty/);
  assert.equal(provider.sent.length, 2);

  // UNKNOWN on the other leg blocks too.
  provider.slot0Words.delete(id(3000, 60));
  provider.blockTimes.set(provider.block - 300, provider.now - 60);
  provider.slot0Fail.add(id(30000, 600));
  await poll();
  await flush();
  assert.match(element("activity").textContent, /auto skipped: pool 30000\/600 unknown \(slot0 read failed/);
  assert.equal(provider.sent.length, 2);

  // Both clean: the swap fires with those pools.
  provider.slot0Fail.clear();
  await poll();
  await until(() => provider.sent.length === 3, "the auto-mode swap");
  assert.equal(provider.sent[2].to, E.ROUTER);
  assert.match(element("activity").textContent, /Auto mode: best spread 3000 \/ 60 → 30000 \/ 600/);
  await element("auto-mode").change(false);
});

test("auto mode trades the best clean spread when a stale pool holds the better one, and logs the stale pool", async () => {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916, provider.block - 300, { ageSeconds: 60 });
  provider.addSwap(2500, 25, -292000, provider.block - 200, { ageSeconds: 60 }); // clean GREEN against 3000/60
  provider.addSwap(30000, 600, -280000, provider.block - 100, { ageSeconds: 9000 }); // far better, but stale
  const { element, flush, until, poll } = await readyPage(provider);
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  await element("approve-permit2").click();
  assert.equal(provider.sent.length, 2);
  await element("auto-mode").change(true);
  await until(() => provider.sent.length === 3, "the auto-mode swap");
  assert.match(element("activity").textContent, /auto skipped: pool 30000\/600 stale \(2h 30m\)/);
  assert.match(element("activity").textContent, /Auto mode: best spread 3000 \/ 60 → 2500 \/ 25/);
  await until(() => element("send").disabled && /Swap confirmed/.test(element("status").textContent), "the receipt");
  await element("auto-mode").change(false);
});

test("the Window field stays usable while a transaction is pending; Max staleness locks with the threshold", async () => {
  const { provider, element, poll, flush } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.beforeRequest = async ({ method }) => { if (method === "eth_getTransactionReceipt") await gate; };
  const first = element("approve-permit2").click();
  assert.equal(element("max-staleness").disabled, true);
  assert.equal(element("threshold").disabled, true);
  assert.equal(element("window-blocks").disabled, false);
  release();
  await first;
  assert.equal(element("max-staleness").disabled, false);
});

test("transfer buttons need a connection, an acknowledgement and a valid other address; token A and ETH transfers send everything", async () => {
  const { provider, element, flush } = await readyPage();
  element("transfer-to").input(OTHER);
  await element("transfer-ack").change(true);
  assert.equal(element("transfer-a").disabled, true); // not connected
  await element("connect").click();
  assert.equal(element("transfer-a").disabled, false);
  assert.equal(element("transfer-b").disabled, false);
  assert.equal(element("transfer-eth").disabled, false);
  element("transfer-to").input(CALLER);
  assert.equal(element("transfer-a").disabled, true); // never to the same account
  element("transfer-to").input("0x12");
  assert.equal(element("transfer-eth").disabled, true);
  element("transfer-to").input(OTHER);
  await element("transfer-ack").change(false);
  assert.equal(element("transfer-a").disabled, true);
  await element("transfer-ack").change(true);

  await element("transfer-a").click();
  await flush();
  assert.equal(provider.sent.length, 1);
  assert.equal(provider.sent[0].to, ethers.utils.getAddress(E.PONS));
  const decoded = erc20.decodeFunctionData("transfer", provider.sent[0].data);
  assert.equal(decoded.to, OTHER);
  assert.equal(ethers.utils.formatUnits(decoded.amount, 18), "1.5");
  assert.match(element("transfer-result").textContent, /Token A transfer confirmed\. Amount 1500000000000000000 base units\. Tx 0x0+1$/);
  assert.equal(element("bal-a").textContent, "0.0 PONS");
  assert.equal(element("transfer-ack").checked, false); // re-acknowledge for the next asset
  assert.equal(element("transfer-eth").disabled, true);

  await element("transfer-ack").change(true);
  await element("transfer-eth").click();
  await flush();
  assert.equal(provider.sent.length, 2);
  const reserve = provider.gasEstimate.mul(provider.gasPrice).mul(2);
  assert.ok(ethers.BigNumber.from(provider.sent[1].value).eq(ethers.utils.parseEther("0.2").sub(reserve)));
  assert.match(element("transfer-result").textContent, /ETH transfer confirmed/);
  assert.notEqual(element("bal-eth").textContent, "0.2 ETH");

  await element("transfer-ack").change(true);
  await element("transfer-b").click();
  await flush();
  assert.equal(provider.sent.length, 3);
  assert.equal(provider.sent[2].to, E.USDG);
  assert.equal(element("bal-b").textContent, "0.0 USDG");
});

test("a rejected or reverted transfer is reported as a failure, never as confirmed", async () => {
  const { provider, element, flush } = await readyPage();
  await element("connect").click();
  element("transfer-to").input(OTHER);
  await element("transfer-ack").change(true);
  provider.rejectSend = 1;
  await element("transfer-a").click();
  await flush();
  assert.match(element("transfer-result").textContent, /Token A transfer failed: Wallet request rejected/);
  assert.equal(element("transfer-result").className, "error");
  assert.equal(element("bal-a").textContent, "1.5 PONS");
  provider.rejectSend = 0;
  provider.failReceipt = 1;
  await element("transfer-eth").click();
  await flush();
  assert.match(element("transfer-result").textContent, /ETH transfer failed: .*reverted/);
  assert.equal(provider.ethBalance(OTHER).toString(), "0");
});

test("missing wallet and wrong chain show useful errors without writes", async () => {
  for (const noWallet of [true, false]) {
    const provider = new MockWallet();
    const page = loadPage(provider, { noWallet });
    if (!noWallet) provider.chain = "0x1";
    await page.element("connect").click();
    assert.match(page.element("status").textContent, noWallet ? /No wallet/ : /4663/);
    assert.equal(page.element("send").disabled, true);
    assert.equal(page.element("approve-permit2").disabled, true);
    assert.equal(provider.sent.length, 0);
    assert.equal(provider.calls.length, noWallet ? 0 : 2);
  }
});

test("changing the input amount after a quote invalidates it; bad amounts never request approval", async () => {
  const { provider, element, poll, flush } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  await element("approve-permit2").click();
  provider.sent.length = 0;
  await element("dry-run").click();
  assert.equal(element("send").disabled, false);
  element("amount-in").input("0.02");
  assert.equal(element("send").disabled, true);
  assert.equal(element("calldata").textContent, "Not built yet.");
  await element("approve-permit2").click();
  assert.match(element("status").textContent, /Select the spread again to re-quote/);
  assert.equal(provider.sent.length, 0);
  for (const value of ["0", "-1", "abc", "1e18", "0.0000001"]) {
    element("amount-in").input(value);
    await element("dry-run").click();
    assert.equal(element("status").className, "error");
    assert.equal(provider.sent.length, 0);
  }
  element("amount-in").input("0.01");
  element("min-out").input("0.0000001");
  await element("dry-run").click();
  assert.match(element("status").textContent, /6 decimals/);
  assert.equal(provider.sent.length, 0);
});

test("failed approval, failed dry run and failed final simulation never enable a bypass", async () => {
  const { provider, element, poll, flush } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  provider.rejectSend = 2;
  await element("approve-permit2").click();
  assert.match(element("status").textContent, /Wallet request rejected/);
  assert.equal(provider.sent.length, 1);
  assert.equal(element("send").disabled, true);
  provider.rejectSend = 0;
  await element("approve-permit2").click();
  provider.failRouterCall = provider.routerCalls + 1;
  await element("dry-run").click();
  assert.equal(element("send").disabled, true);
  assert.match(element("status").textContent, /pool unavailable/);
  await element("dry-run").click();
  provider.failRouterCall = provider.routerCalls + 1; // the re-simulation inside send
  await element("send").click();
  assert.equal(provider.sent.length, 2);
  assert.equal(element("send").disabled, true);
  assert.match(element("status").textContent, /pool unavailable/);
});

test("wallet events clear send readiness and balances and require reconnection", async () => {
  const { provider, element, poll, flush } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  await element("approve-permit2").click();
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
    await element("connect").click();
    await element("dry-run").click();
    assert.equal(element("send").disabled, false);
    assert.equal(element("bal-a").textContent, "1.5 PONS");
    provider.emit(event, []);
    assert.equal(element("send").disabled, true);
    assert.equal(element("dry-run").disabled, true);
    assert.equal(element("transfer-a").disabled, true);
    assert.equal(element("bal-a").textContent, "—");
    assert.match(element("account").textContent, /Connect again/);
    assert.match(element("status").textContent, /reconnect/);
  }
  assert.equal(provider.sent.length, 2);
});

test("busy UI prevents duplicate approval sequences and locks fields", async () => {
  const { provider, element, poll, flush } = await readyPage(withActivePools());
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click();
  await flush();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.beforeRequest = async ({ method }) => { if (method === "eth_getTransactionReceipt") await gate; };
  const first = element("approve-permit2").click();
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("amount-in").disabled, true);
  assert.equal(element("connect").disabled, true);
  assert.equal(element("apply-pair").disabled, true);
  assert.equal(element("token-a").disabled, true);
  await element("approve-permit2").click();
  release();
  await first;
  assert.equal(provider.sent.length, 2);
  assert.equal(element("amount-in").disabled, false);
});

test("provider errors are rendered as text, never interpreted as HTML", async () => {
  const { provider, element } = await readyPage();
  provider.beforeRequest = async () => { throw new Error("<img src=x onerror=alert(1)>"); };
  await element("connect").click();
  assert.equal(element("status").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(element("status").innerHTML, undefined);
});

function withV3Pools() {
  const provider = new V3Mock();
  provider.addV3Swap(3000, -292916);
  provider.addV3Swap(10000, -292000);
  return provider;
}

async function chooseProtocol(page, protocol) {
  page.element("protocol").value = protocol;
  page.element("protocol").change(false);
  await page.until(() => page.timers.length > 0, "protocol restart");
  await page.flush();
}

test("Protocol defaults to Both, tags both tables, shows every combination, and restarts on each change", async () => {
  const provider = withV3Pools();
  provider.addSwap(3000, 60, -292500);
  provider.addSwap(500, 10, -293000);
  const page = await readyPage(provider), { element } = page;
  assert.equal(element("protocol").value, "Both");
  assert.equal(element("pools-body").children.length, 9);
  assert.equal(element("spreads-body").children.length, 6);
  assert.equal(element("permit2-controls").hidden, false);
  assert.equal(element("v3-controls").hidden, false);
  const v3Rows = element("pools-body").children.filter(row => row.children[6].textContent === "V3");
  assert.deepEqual(v3Rows.map(row => row.children[0].textContent), ["0.30%", "1.00%"]);
  assert.ok(element("spreads-body").children.some(row => /V3 → V4|V4 → V3/.test(row.children[6].textContent)));
  await element("spreads-body").children[0].click(); await page.flush();
  assert.notEqual(element("selected-pools").textContent, "No spread selected.");
  await chooseProtocol(page, "V3");
  assert.equal(element("pools-body").children.length, 2);
  assert.equal(element("spreads-body").children.length, 1);
  assert.equal(element("selected-pools").textContent, "No spread selected.");
  assert.equal(element("permit2-controls").hidden, true);
  assert.equal(element("v3-controls").hidden, false);
  assert.equal(element("send").disabled, true);
  await chooseProtocol(page, "V4");
  assert.equal(element("pools-body").children.length, 7);
  assert.equal(element("permit2-controls").hidden, false);
  assert.equal(element("v3-controls").hidden, true);
  assert.equal(page.timers.length, 1);
});

test("V3 page quotes both legs without a wallet, approves one token, and sends a protected atomic round trip", async () => {
  const page = await readyPage(withV3Pools()), { provider, element, flush } = page;
  await chooseProtocol(page, "V3");
  await element("spreads-body").children[0].click(); await flush();
  assert.equal(provider.calls.length, 0);
  assert.equal(element("bridge-amount").value, "0.04975");
  assert.match(element("quote-info").textContent, /Return quote: 0.011 USDG/);
  assert.equal(element("route-warning").hidden, true);
  await element("connect").click();
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("approve-v3-router").disabled, false);
  await element("approve-v3-router").click();
  assert.equal(provider.sent.length, 1);
  await element("approve-v3-router").click();
  assert.equal(provider.sent.length, 1);
  await element("dry-run").click();
  assert.equal(element("send").disabled, false);
  const [deadline, calls] = v3.decodeFunctionData("multicall", element("calldata").textContent);
  const [params] = v3.decodeFunctionData("exactInput", calls[0]);
  assert.deepEqual(decodePath(params[0]).fees, [3000, 10000]);
  assert.equal(params[3].toString(), "10945"); // UI minimum 0 cannot remove the quote's floor
  assert.equal(deadline.toNumber(), provider.now + 1200);
  await element("send").click();
  assert.match(element("status").textContent, /Swap confirmed/);
  assert.equal(provider.sent.length, 2);
  assert.equal(provider.sent[1].to.toLowerCase(), E.V3_ROUTER.toLowerCase());
  assert.equal(element("send").disabled, true);
  assert.ok(provider.sent.every(tx => tx.to !== E.PERMIT2));
});

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
    assert.equal(element("approve-v3-router").disabled, true);
    assert.equal(element("dry-run").disabled, true);
    assert.equal(element("send").disabled, true);
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
    assert.match(element("route-warning").textContent, /2 transactions required/);
    assert.match(element("route-warning").textContent, v3First ? /V3 buy first, then V4/ : /V4 buy first, then V3/);
    await element("connect").click();
    await element("approve-v3-router").click();
    await element("approve-permit2").click();
    assert.equal(provider.sent.length, 2);
    await element("dry-run").click();
    assert.match(element("status").textContent, /First leg dry run succeeded/);
    assert.equal(element("send").disabled, false);
    const txs = JSON.parse(element("calldata").textContent);
    assert.equal(txs.length, 2);
    await element("send").click();
    assert.match(element("status").textContent, /Swap confirmed:.*First leg:/);
    assert.deepEqual(provider.sent.slice(2).map(tx => tx.to.toLowerCase()), v3First ? [E.V3_ROUTER.toLowerCase(), E.ROUTER.toLowerCase()] : [E.ROUTER.toLowerCase(), E.V3_ROUTER.toLowerCase()]);
    assert.match(element("activity").textContent, /Mixed leg 1 confirmed:.*\nMixed leg 2 submitted:/);
  });
}

test("mixed second-leg rejection leaves bridge funds visible and never repeats the first leg", async () => {
  const page = await readyPage(mixedPools(true)), { provider, element, flush } = page;
  await element("spreads-body").children[0].click(); await flush();
  await element("connect").click();
  await element("approve-v3-router").click(); await element("approve-permit2").click();
  await element("dry-run").click();
  provider.rejectSend = provider.sent.length + 2;
  await element("send").click();
  assert.match(element("status").textContent, /Leg 1 confirmed.*Leg 2 did not confirm/);
  assert.equal(element("bal-a").textContent, "0.05 PONS");
  assert.equal(element("send").disabled, true);
  const count = provider.sent.length;
  await element("send").click();
  assert.equal(provider.sent.length, count);
});

test("mixed-only spreads are manual-only even when they are GREEN and auto mode is enabled", async () => {
  const page = await readyPage(mixedPools(true)), { provider, element, poll, flush } = page;
  await element("connect").click();
  element("auto-mode").change(true);
  await flush(); await poll(); await flush();
  assert.equal(element("auto-mode").checked, true);
  assert.equal(provider.sent.length, 0);
  assert.equal(provider.rpcCalls.filter(c => c.method === "eth_call" && !c.params[0].to).length, 0);
});

test("V3 auto mode executes only one atomic route while the receipt is pending, with protocol selection locked", async () => {
  const provider = withV3Pools(); provider.setAllowance(E.USDG, 1000000);
  const page = await readyPage(provider), { element, until, poll, flush } = page;
  await chooseProtocol(page, "V3");
  await element("connect").click();
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  provider.beforeRequest = async call => { if (call.method === "eth_getTransactionReceipt") await hold; };
  element("auto-mode").change(true);
  await until(() => provider.sent.length === 1, "V3 automatic submission");
  assert.equal(element("protocol").disabled, true);
  assert.equal(element("approve-v3-router").disabled, true);
  await poll(); await flush();
  assert.equal(provider.sent.length, 1);
  release();
  await until(() => !element("protocol").disabled, "V3 receipt");
  assert.match(element("status").textContent, /Swap confirmed/);
  element("auto-mode").change(false);
});
