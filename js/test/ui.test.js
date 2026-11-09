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
  const poll = async () => {
    const due = timers.splice(0);
    assert.ok(due.length, "no poll scheduled");
    for (const t of due) t.fn();
    await until(() => timers.length > 0, "the next poll to be scheduled");
    await flush(5);
  };
  return { provider, element: document.getElementById, context, html, timers, flush, until, poll, windowListeners, storage };
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

// ------------------------------------------------------------------ Follow-up 5: Manual mode

const { ManualMock, liveManualMock, pool: manualPool, LIVE_POOL_A, LIVE_POOL_B, WETH: MANUAL_WETH, PONS: MANUAL_PONS } = require("./manual-mock.js");
const { poolA: MANUAL_POOL_A, poolB: MANUAL_POOL_B } = require("./v3-mock.js");

// Follow-up 6: Manual mode is one-shot (no poll timer), so a manual read is "done" when its status settles.
const manualSettled = (page) => !/Reading both pools…/.test(page.element("manual-status").textContent);

async function chooseMode(page, mode) {
  page.element("mode").value = mode;
  page.element("mode").change(false);
  await page.until(() => mode === "Manual" ? manualSettled(page) : page.timers.length > 0, "mode restart");
  await page.flush();
}

async function readPrices(page) {
  const before = page.provider.rpcCalls.length;
  await page.element("read-prices").click();
  await page.until(() => manualSettled(page) || /Enter a 42-char/.test(page.element("manual-status").textContent), "manual read");
  await page.flush();
  return page.provider.rpcCalls.slice(before);
}

test("Manual mode hides the pair fields, stops the log scan, reads both pools with eth_call only and shows one spread row", async () => {
  const provider = new ManualMock();
  const page = await readyPage(provider), { element, timers, poll } = page;
  assert.equal(element("mode").value, "Auto-scan");
  assert.ok(page.html.includes("READ PRICES"));
  assert.ok(provider.rpcCalls.some((c) => c.method === "eth_getLogs"), "auto-scan still scans logs by default");
  assert.equal(element("pool-a").value, LIVE_POOL_A, "the brief's pools are prefilled");
  assert.equal(element("pool-b").value, LIVE_POOL_B);
  element("pool-a").value = MANUAL_POOL_A;
  element("pool-b").value = MANUAL_POOL_B;
  const before = provider.rpcCalls.length;
  const httpBefore = provider.httpCalls.length;
  const symbolsBefore = provider.symbolCalls; // the auto-scan pair load already read two symbols
  await chooseMode(page, "Manual");
  for (const id of ["field-token-a", "field-token-b", "field-protocol", "field-window", "apply-pair", "auto-scan-view", "auto-scan-notes", "permit2-controls"]) {
    assert.equal(element(id).hidden, true, id + " hidden in manual mode");
  }
  for (const id of ["field-pool-a", "field-pool-b", "read-prices", "manual-view", "manual-notes", "v3-controls"]) {
    assert.equal(element(id).hidden, false, id + " shown in manual mode");
  }
  const since = provider.rpcCalls.slice(before);
  assert.ok(since.length >= 12, "calls since switching: " + JSON.stringify(since.map((c) => c.method + " " + (c.params[0] && c.params[0].to) + " " + (c.params[0] && c.params[0].data && c.params[0].data.slice(0, 10)))));
  assert.ok(since.every((c) => c.method === "eth_call"), "only eth_call in manual mode");
  assert.ok(provider.httpCalls.slice(httpBefore).every((c) => !Array.isArray(c.body)), "no JSON-RPC batch in manual mode");
  assert.equal(provider.manualCalls.length, 10, "token0, token1, fee, slot0 and liquidity() of both pools (follow-up 6)");
  assert.equal(provider.calls.length, 0, "no wallet call");
  assert.deepEqual(timers.map((t) => t.ms), [], "the log monitor's timer is gone and READ PRICES is one-shot: no manual poll is scheduled (follow-up 6)");
  const rows = element("manual-body").children;
  assert.equal(rows.length, 1);
  assert.match(rows[0].children[0].textContent, /^0\.30% · 0\.19030\d* \(tick -292916\) · 0x0652…BAF3$/);
  assert.match(rows[0].children[1].textContent, /^1\.00% · 0\.2085\d* \(tick -292000\) · 0x7A19…E4e1$/);
  assert.equal(rows[0].children[3].textContent, "1.300");
  assert.equal(rows[0].children[5].textContent, "GREEN");
  assert.match(element("pair-info").textContent, /^Pair PONS\/USDG · token0 = PONS \(0x39dBED3a2bd333467115dE45665cC57F813C4571, 18 decimals\) · token1 = USDG/);
  assert.match(element("manual-last-read").textContent, /^Last read: \d+s ago$/);
  assert.match(element("manual-status").textContent, /Read 2 pools with eth_call only/);
  assert.match(element("poll-status").textContent, /^Manual mode · Last read: 0s ago · 10 eth_calls per read, no eth_getLogs, no polling$/);
  assert.match(element("manual-pools").textContent, /Pool A \(buy\) 0x0652d61511f3A96B8721bE6825680F5954D9BAF3 · Pool B \(sell\) 0x7A192E71564ec66eE0763e328a3Ac274942dE4e1/);
  // Another click of READ PRICES re-reads the ten pool values and nothing else: symbols and decimals are cached.
  const beforePoll = provider.rpcCalls.length;
  await readPrices(page);
  assert.equal(provider.rpcCalls.length - beforePoll, 10);
  assert.equal(timers.length, 0, "still no timer after a second one-shot read");
  assert.equal(provider.symbolCalls - symbolsBefore, 2, "symbol() read once per token in manual mode");
  assert.ok(provider.rpcCalls.slice(before).every((c) => c.method === "eth_call"));
  // Back to Auto-scan: the manual view goes, the log scan resumes.
  const beforeAuto = provider.rpcCalls.length;
  await chooseMode(page, "Auto-scan");
  assert.equal(element("manual-view").hidden, true);
  assert.equal(element("auto-scan-view").hidden, false);
  assert.ok(provider.rpcCalls.slice(beforeAuto).some((c) => c.method === "eth_getLogs"));
  assert.equal(timers.length, 1);
  assert.match(element("activity").textContent, /Mode: Manual\.\nMode: Auto-scan\./);
});

test("Manual mode executes the pasted pools through the existing V3 quote, approval, dry run and send flow", async () => {
  const provider = new ManualMock();
  const page = await readyPage(provider), { element, flush } = page;
  // Pasted in the "wrong" order: the page swaps the labels so Pool A is the cheaper 0.30% pool.
  element("pool-a").value = MANUAL_POOL_B;
  element("pool-b").value = MANUAL_POOL_A;
  await chooseMode(page, "Manual");
  assert.match(element("manual-pools").textContent, /labels swapped/);
  const row = element("manual-body").children[0];
  assert.match(row.children[0].textContent, /^0\.30%/);
  await row.click(); await flush();
  assert.equal(provider.calls.length, 0, "the quote uses the public RPC, not the wallet");
  assert.equal(element("bridge-amount").value, "0.04975");
  assert.match(element("quote-info").textContent, /on pool V3 0\.30% 0x0652…BAF3\./);
  assert.match(element("quote-info").textContent, /Return quote: 0.011 USDG/);
  assert.equal(element("route-warning").hidden, true);
  assert.equal(element("manual-body").children[0].className, "selectable selected");
  const selected = JSON.parse(element("selected-pools").textContent);
  assert.equal(selected.buyPool.address, MANUAL_POOL_A);
  assert.equal(selected.buyPool.currency0, MANUAL_PONS);
  assert.equal(selected.sellPool.address, MANUAL_POOL_B);
  await element("connect").click();
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("approve-v3-router").disabled, false);
  assert.match(element("bal-a").textContent, /PONS$/, "balances follow the pools' token0 / token1");
  assert.match(element("bal-b").textContent, /USDG$/);
  await element("approve-v3-router").click();
  assert.equal(provider.sent.length, 1);
  await element("dry-run").click();
  assert.equal(element("send").disabled, false);
  const [deadline, calls] = v3.decodeFunctionData("multicall", element("calldata").textContent);
  const [params] = v3.decodeFunctionData("exactInput", calls[0]);
  const path = decodePath(params[0]);
  assert.deepEqual(path.fees, [3000, 10000]);
  assert.deepEqual(path.tokens, [ethers.utils.getAddress(E.USDG), MANUAL_PONS, ethers.utils.getAddress(E.USDG)], "token pair comes from the pools, not the hidden fields");
  assert.equal(deadline.toNumber(), provider.now + 1200);
  await element("send").click();
  assert.match(element("status").textContent, /Swap confirmed/);
  assert.equal(provider.sent[1].to.toLowerCase(), E.V3_ROUTER.toLowerCase());
  assert.equal(element("send").disabled, true);
  assert.ok(provider.rpcCalls.every((c) => c.method !== "eth_getLogs" || c.id <= 20), "no log scan after switching to manual");
  // The transfer buttons address the pools' tokens.
  element("transfer-to").input(OTHER);
  element("transfer-ack").change(true);
  await element("transfer-a").click();
  assert.equal(provider.sent[2].to.toLowerCase(), E.PONS.toLowerCase());
});

test("Manual mode shows the brief's errors: different pairs, invalid address, 42-char rule and no liquidity; auto mode stays locked out", async () => {
  const provider = liveManualMock();
  const page = await readyPage(provider), { element, timers } = page;
  await chooseMode(page, "Manual");
  // The brief's two pools: WETH/PONS, fee() 1.00% and 0.30% as the chain answers, 0.73% spread, RED.
  const row = element("manual-body").children[0];
  const short = (address) => { const a = ethers.utils.getAddress(address); return a.slice(0, 6) + "…" + a.slice(-4); };
  assert.equal(row.children[0].textContent, "1.00% · " + Math.pow(1.0001, 93992).toPrecision(6) + " (tick 93992) · " + short(LIVE_POOL_A));
  assert.equal(row.children[1].textContent, "0.30% · " + Math.pow(1.0001, 94065).toPrecision(6) + " (tick 94065) · " + short(LIVE_POOL_B));
  assert.match(row.children[0].textContent, /^1\.00% · 12073\.0 \(tick 93992\)/, "about 12073 PONS per WETH, both 18 decimals");
  assert.equal(row.children[3].textContent, "1.300");
  assert.equal(row.children[5].textContent, "RED");
  assert.match(element("pair-info").textContent, /^Pair WETH\/PONS/);
  element("auto-mode").change(true);
  assert.equal(provider.calls.length, 0, "a RED row never executes");

  element("pool-b").value = MANUAL_POOL_A; // PONS/USDG
  await readPrices(page);
  assert.match(element("manual-status").textContent, /^Pools are different pairs · click READ PRICES to read again/);
  assert.equal(element("manual-status").className, "error");
  assert.equal(element("manual-body").children.length, 0, "no row for an invalid pair");
  assert.match(element("poll-status").textContent, /Manual mode · Pools are different pairs/);

  element("pool-b").value = E.PONS; // a token, not a pool
  const calls = await readPrices(page);
  assert.match(element("manual-status").textContent, /^Pool B: Invalid pool address \(0x39dBED3a2bd333467115dE45665cC57F813C4571: token0\(\) reverted\)/);
  assert.ok(calls.every((c) => c.method === "eth_call"));

  element("pool-b").value = "0x" + "ab".repeat(32); // a 66-char V4 poolId
  const none = await readPrices(page);
  assert.equal(element("manual-status").textContent, "Pool B: Enter a 42-char V3 pool address");
  assert.equal(none.length, 0, "nothing is requested for a malformed address");
  assert.equal(timers.length, 0, "no poll is scheduled");
  assert.match(element("pair-info").textContent, /Paste two 42-character V3 pool addresses/);

  const EMPTY = "0x0f5F5bCC08cAe61d19c9a2d2594C252f1Baddae6";
  provider.setPool(EMPTY, manualPool(MANUAL_WETH, MANUAL_PONS, 100, 93990, { sqrtPriceX96: 0 }));
  element("pool-b").value = EMPTY;
  await readPrices(page);
  assert.match(element("manual-status").textContent, /^Pool has no liquidity \(Pool B 0x0f5F5bCC08cAe61d19c9a2d2594C252f1Baddae6\)/);

  // A healthy pair again, with a GREEN net above the threshold: auto mode executes nothing without a wallet.
  provider.setPool(EMPTY, manualPool(MANUAL_WETH, MANUAL_PONS, 100, 93992));
  element("pool-a").value = LIVE_POOL_B; // 0.30% at tick 94065 against 0.01% at tick 93992: 0.733% - 0.31% = 0.42% net
  await readPrices(page);
  assert.equal(element("manual-body").children[0].children[5].textContent, "RED");
  element("threshold").input("0.4");
  assert.equal(element("manual-body").children[0].children[5].textContent, "GREEN");
  assert.equal(element("manual-body").children[0].children[3].textContent, "0.310");
  assert.equal(provider.calls.length, 0);
  element("auto-mode").change(false);
  // While a read is in flight the controls lock with the rest of the page.
  await element("connect").click();
  assert.equal(element("mode").disabled, false);
  assert.equal(element("pool-a").disabled, false);
});

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

test("All pairs mode shows pools from several Token Bs, tags cross-pair spreads 3-LEG without execution, and quotes a same-pair row with a gas line", async () => {
  const provider = allPairsProvider();
  const page = await readyPage(provider), { element, timers, flush } = page;
  assert.equal(element("token-b-list").value, "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73\n0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", "the brief's default list");
  await chooseMode(page, "All pairs");
  for (const id of ["field-token-a", "field-token-b-list", "field-protocol", "field-window", "apply-pair", "allpairs-view", "allpairs-notes"]) {
    assert.equal(element(id).hidden, false, id + " shown in All pairs");
  }
  for (const id of ["field-token-b", "auto-scan-view", "manual-view", "field-pool-a"]) assert.equal(element(id).hidden, true, id + " hidden in All pairs");
  assert.equal(element("apply-pair").textContent, "WATCH");
  assert.deepEqual(timers.map((t) => t.ms), [E.POLL_INTERVAL_MS]);
  const rows = element("allpairs-pools-body").children;
  const tokenBs = new Set(rows.map((row) => row.children[0].textContent.split(" ")[0]));
  assert.deepEqual([...tokenBs].sort(), ["USDG", "WETH"], "pools of both Token Bs in one table");
  assert.equal(rows.length, 6, "2 V4 + 2 V3 PONS/USDG, 2 V3 WETH/PONS");
  const drained = rows.find((row) => row.children[1].textContent === "30000 / 600");
  assert.equal(drained.children[4].textContent, "yes · EMPTY", "tick -887272 is EMPTY");
  assert.match(drained.children[2].textContent, /tick -887272/);
  assert.match(element("pair-info").textContent, /Token A .* against WETH, USDG · 4 V3 pool\(s\) and 2 V4 pool\(s\) with liquidity discovered/);
  assert.match(element("poll-status").textContent, /^All pairs · last poll .* 1 eth_getLogs per protocol/);
  // ONE V3 filter over all pools and ONE V4 filter on the PoolManager per poll.
  const filters = provider.getLogsFilters.slice(-2);
  assert.ok(filters.some((f) => Array.isArray(f.address) && f.address.length === 4));
  assert.ok(filters.some((f) => !Array.isArray(f.address) && f.topics.length === 1));
  const spreads = element("allpairs-spreads-body").children;
  const cross = spreads.filter((row) => row.children[5].textContent.startsWith("3-LEG"));
  const same = spreads.filter((row) => row.children[5].textContent.startsWith("2-LEG"));
  assert.equal(cross.length, 3, "3 OK pools in PONS/USDG × 1 OK pool in WETH/PONS");
  assert.equal(same.length, 3, "3 pairwise combos of the PONS/USDG OK pools");
  assert.ok(cross.every((row) => !row.listeners.click && row.className === ""), "3-LEG rows cannot be clicked");
  assert.ok(cross.every((row) => /\(WETH\)/.test(row.children[0].textContent) && /\(USDG\)/.test(row.children[0].textContent)), "Path names both Token Bs");
  assert.ok(same.every((row) => row.listeners.click), "same-pair rows are selectable");
  assert.match(element("allpairs-note").textContent, /6 spread\(s\) from 4 tradeable pool\(s\) across 2 pair\(s\): 3 executable same-pair, 3 cross-pair 3-LEG/);
  // Click a same-pair row: quote, then the gas estimate line.
  const v4v4 = same.find((row) => /^V4 3000\/60 \(USDG\) → V3 1\.00% \(USDG\)$|^V3 0\.30% \(USDG\) → V3 1\.00% \(USDG\)$/.test(row.children[0].textContent)) || same[0];
  await v4v4.click(); await flush();
  await page.until(() => element("status").className === "error" || (!/^Quoting/.test(element("quote-info").textContent) && !/Estimating gas/.test(element("gas-info").textContent)), "quote and gas line");
  assert.notEqual(element("status").className, "error", element("status").textContent);
  await flush();
  assert.match(element("quote-info").textContent, /^Swap 1 quote: 0\.01 USDG → /, element("status").textContent);
  assert.match(element("gas-info").textContent, /^Gas: ~\$[\d.]+ \((250K gas V3|400K gas V4|250K gas V3 \+ 400K gas V4) × eth_gasPrice 0\.020102 gwei\)\./);
  assert.match(element("gas-info").textContent, /Net after gas: -?\$[\d.]+/);
  assert.equal(provider.calls.length, 0, "quotes and gas use the public RPC");
  const label = v4v4.children[0].textContent;
  assert.equal(element("allpairs-spreads-body").children.find((row) => row.children[0].textContent === label).className, "selectable selected", "the re-rendered row keeps the selection");
  await element("connect").click();
  assert.equal(element("dry-run").disabled, false);
  assert.match(element("bal-a").textContent, /PONS$/);
  assert.match(element("bal-b").textContent, /USDG$/, "Token B balance follows the selected pair");
  assert.equal(element("revoke-controls").hidden, false, "REVOKE ALL appears once connected");
  assert.equal(element("revoke-all").disabled, false);
});

test("the multi-tab lock disables execution when another tab sent less than 5 minutes ago, is written on send and cleared on unload", async () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  // Another tab wrote the lock "just now" (the fake clock starts at 1762500000000 and advances 10 s per read).
  store.set("ponsarb_lock", "1762500000000");
  let page = loadPage(withActivePools(), { storage });
  await page.until(() => page.timers.length > 0, "first poll");
  await page.poll();
  assert.equal(page.element("lock-banner").hidden, false, "banner shown");
  assert.match(page.element("activity").textContent, /Another tab active/);
  await page.element("spreads-body").children[0].click(); await page.flush();
  await page.element("connect").click();
  assert.equal(page.element("dry-run").disabled, true, "execute disabled while locked");
  assert.equal(page.element("send").disabled, true);
  assert.equal(page.element("auto-mode").disabled, true);
  assert.equal(page.element("approve-permit2").disabled, false, "approvals are not execution");
  // A lock older than 5 minutes does not block; a send writes a fresh one; beforeunload clears it.
  store.set("ponsarb_lock", String(1762500000000 - 6 * 60 * 1000));
  page = loadPage(withActivePools(), { storage });
  await page.until(() => page.timers.length > 0, "first poll");
  await page.poll();
  assert.equal(page.element("lock-banner").hidden, true);
  await page.element("spreads-body").children[0].click(); await page.flush();
  await page.element("connect").click();
  await page.element("approve-permit2").click();
  await page.element("dry-run").click();
  assert.equal(page.element("send").disabled, false);
  await page.element("send").click();
  assert.match(page.element("status").textContent, /Swap confirmed/);
  const written = Number(store.get("ponsarb_lock"));
  assert.ok(written > 1762500000000, "the lock is this tab's send timestamp");
  assert.ok(typeof page.windowListeners.beforeunload === "function");
  page.windowListeners.beforeunload();
  assert.equal(store.has("ponsarb_lock"), false, "cleared on unload");
});

test("REVOKE ALL (job 8 fix 3) loops Token A then Token B over the V3 Router, the PoolManager and Permit2, with a status per token", async () => {
  const provider = new V3Mock();
  provider.setAllowance(E.USDG, 12345); // USDG → V3 Router
  provider.spenderAllowances.set(provider.key(CALLER, E.USDG, E.POOL_MANAGER), ethers.BigNumber.from(77)); // USDG → PoolManager
  provider.tokenAllowances.set(E.PONS.toLowerCase(), ethers.BigNumber.from(0)); // PONS has nothing to revoke
  const page = await readyPage(provider), { element } = page;
  assert.equal(element("revoke-controls").hidden, true, "hidden until connected");
  await element("connect").click();
  assert.equal(element("revoke-controls").hidden, false);
  await element("revoke-all").click();
  await page.flush();
  assert.equal(provider.sent.length, 3, element("revoke-status").textContent + " | " + element("status").textContent);
  assert.ok(provider.sent.every((tx) => tx.to.toLowerCase() === E.USDG.toLowerCase()), "only USDG had allowances");
  const spenders = provider.sent.map((tx) => token.decodeFunctionData("approve", tx.data)[0].toLowerCase());
  assert.deepEqual(spenders, [E.V3_ROUTER, E.POOL_MANAGER, E.PERMIT2].map((a) => a.toLowerCase()), "V3 Router, PoolManager, Permit2 in order");
  assert.equal(provider.allowance(E.USDG).toString(), "0");
  assert.equal(provider.spenderAllowances.get(provider.key(CALLER, E.USDG, E.POOL_MANAGER)).toString(), "0");
  assert.equal(provider.tokenAllowances.get(E.USDG.toLowerCase()).toString(), "0");
  assert.match(element("revoke-status").textContent, /^PONS: nothing to revoke · USDG: ✓ revoked \(V3 Router 0x[0-9a-f]+, PoolManager 0x[0-9a-f]+, Permit2 0x[0-9a-f]+\)$/);
  assert.equal(element("revoke-status").className, "success");
  assert.match(element("activity").textContent, /USDG revoke V3 Router allowance confirmed:/);
  assert.match(element("activity").textContent, /USDG revoke PoolManager allowance confirmed:/);
  assert.match(element("activity").textContent, /USDG revoke Permit2 allowance confirmed:/);
  assert.match(element("activity").textContent, /PONS allowance to Permit2 is already 0; skipped/);
  assert.match(element("status").textContent, /REVOKE ALL finished for PONS and USDG/);
  await element("revoke-all").click();
  assert.equal(provider.sent.length, 3, "already zero: nothing sent");
  assert.equal(element("revoke-status").textContent, "PONS: nothing to revoke · USDG: nothing to revoke");
  // Both tokens with allowances: Token A (PONS) is revoked first; a refused signature on Token B leaves its line marked ✗.
  provider.tokenAllowances.set(E.PONS.toLowerCase(), ethers.BigNumber.from(5));
  provider.setAllowance(E.USDG, 9);
  provider.rejectSend = provider.sent.length + 2;
  await element("revoke-all").click();
  await page.flush();
  assert.equal(provider.sent.length, 4, "PONS → Permit2 revoked, USDG → V3 Router refused");
  assert.equal(provider.sent[3].to.toLowerCase(), E.PONS.toLowerCase());
  assert.match(element("revoke-status").textContent, /^PONS: ✓ revoked \(Permit2 0x[0-9a-f]+\) · USDG: ✗ not revoked \(Wallet request rejected\. |^PONS: ✓ revoked \(Permit2 0x[0-9a-f]+\) · USDG: ✗ not revoked \(/);
  assert.equal(element("revoke-status").className, "error");
  assert.equal(provider.allowance(E.USDG).toString(), "9", "the refused revocation changed nothing");
});

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
  element("auto-mode").change(true);
  assert.equal(provider.calls.length, 0, "auto mode never executes an EMPTY manual row");
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

test("fix 7 + fix 2: a V4/V4 route now quotes its sell leg too; a return at or below the input is red, with min return still 0", async () => {
  const page = await readyPage(losingPools()), { element, poll, flush } = page;
  await poll();
  await element("spreads-body").children[0].click(); await flush();
  assert.match(element("quote-info").textContent, /^Swap 1 quote: 0\.01 USDG → 0\.052358673121064015 PONS on pool 3000 \/ 60\. Bridge amount after 0\.5% slippage: 0\.052096879755458694 PONS, sold on pool 30000 \/ 600\. Return quote: 0\.005209 USDG for 0\.01 USDG \(return ≤ input: a loss before gas\)\./);
  assert.match(element("quote-info").textContent, /V4\/V4: the minimum return stays at the field's value \(default 0\)/);
  const value = quoteValueSpan(page);
  assert.equal(value.textContent, "0.005209 USDG");
  assert.equal(value.className, "red");
  assert.equal(element("min-out").value, "0", "default minimum return is 0");
  assert.match(element("status").textContent, /return is at or below the input\. Auto mode would abort this route/);
  assert.equal(element("status").className, "error");
  assert.notEqual(element("bridge-amount").value, "", "a manual dry run is still possible: the guard is auto mode's");
  assert.match(element("gas-info").textContent, /Expected return 0\.005209 USDG for 0\.01 USDG \(-0\.004791 USDG\)/, "the gas line reuses the sell quote");
});

test("fix 1 (HIGH): auto mode quotes, finds return ≤ input, shows the red ABORTED line and sends nothing; it resumes when the return beats the input", async () => {
  const page = await readyPage(losingPools()), { provider, element, poll, flush, until } = page;
  await poll();
  await element("connect").click();
  await element("spreads-body").children[0].click(); await flush();
  await element("approve-permit2").click();
  assert.equal(provider.sent.length, 2, "two Permit2 approvals only");
  await element("auto-mode").change(true);
  await until(() => /^ABORTED: return ≤ input/.test(element("status").textContent), "the ABORTED line");
  assert.equal(element("status").textContent, "ABORTED: return ≤ input (0.005209 ≤ 0.01 USDG). Nothing sent.");
  assert.equal(element("status").className, "error", "red");
  assert.equal(provider.sent.length, 2, "no swap was sent");
  assert.equal(element("auto-mode").checked, true, "an abort is a guard, not a failure: auto mode stays on");
  assert.match(element("activity").textContent, /Auto mode: ABORTED: return ≤ input \(0\.005209 ≤ 0\.01 USDG\) for 3000 \/ 60 → 30000 \/ 600; nothing sent\./);
  await poll(); await flush();
  await until(() => !busyText(page), "the second auto attempt");
  assert.equal(provider.sent.length, 2, "still nothing after another poll");
  assert.equal((element("activity").textContent.match(/ABORTED/g) || []).length, 1, "the abort is logged once per route");
  assert.equal(element("calldata").textContent, "Not built yet.", "no dry run was built");
  // Liquidity returns: the sell leg now pays more than the input and the next poll sends.
  provider.quotes.set(E.poolId({ currency0: E.PONS, currency1: E.USDG, fee: 30000, tickSpacing: 600, hooks: E.NO_HOOKS }),
    ethers.BigNumber.from("5000000000000000000000000000000000000000000000000"));
  await poll();
  await until(() => provider.sent.length === 3, "the auto-mode swap once the return beats the input");
  await until(() => /Swap confirmed/.test(element("status").textContent), "its receipt");
  assert.equal(provider.sent[2].to, E.ROUTER);
  await element("auto-mode").change(false);
});

function busyText(page) { return /^Quoting|Building calldata|Rechecking/.test(page.element("status").textContent); }

/** Two V4 pools; the dearer 30000/600 exists but its quote is 0 (the mock's live fixture: no liquidity). */
function zeroSellPools() {
  const provider = new MockWallet();
  provider.addSwap(3000, 60, -292916);
  provider.addSwap(30000, 600, -292000);
  return provider;
}

test("fix 2: a V4/V4 sell leg quoting 0 marks the route RED, disables execution, and auto mode never sends it", async () => {
  const page = await readyPage(zeroSellPools()), { provider, element, poll, flush, until } = page;
  await poll();
  const row = element("spreads-body").children[0];
  assert.equal(row.children[1].textContent, "30000 / 600", "the empty pool is the sell leg");
  assert.equal(row.children[5].textContent, "GREEN", "tick arithmetic alone calls it GREEN");
  await row.click(); await flush();
  assert.match(element("quote-info").textContent, /^Warning: Sell leg quotes 0: no liquidity in the tick range\. Route invalid \(RED\); nothing will be sent\. Sell pool 30000 \/ 600 returned 0 USDG for 0\.052096879755458694 PONS\. Sending is disabled\.$/);
  assert.equal(element("quote-info").className, "error");
  assert.match(element("status").textContent, /^Sell leg quotes 0/);
  assert.equal(element("bridge-amount").value, "");
  await element("connect").click();
  assert.equal(element("dry-run").disabled, true);
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("send").disabled, true);
  const rerendered = element("spreads-body").children[0];
  assert.equal(rerendered.children[5].textContent, "RED · sell quote 0", "the row is RED now");
  assert.equal(rerendered.children[5].className, "red");
  // Auto mode skips the marked route without quoting it again, logs the skip once, and stays on.
  const rpcBefore = provider.rpcCalls.length;
  await element("auto-mode").change(true);
  await flush();
  await poll(); await flush();
  assert.equal(provider.sent.length, 0);
  assert.equal(element("auto-mode").checked, true);
  assert.equal((element("activity").textContent.match(/skipped: Sell leg quotes 0/g) || []).length, 1);
  assert.equal(provider.rpcCalls.slice(rpcBefore).filter((c) => c.method === "eth_call" && c.params[0].to && c.params[0].to.toLowerCase() === E.ROUTER.toLowerCase()).length, 0, "no router quote or simulation");
  await element("auto-mode").change(false);
});

test("fix 2: auto mode that discovers the zero sell quote itself aborts in red, sends nothing and stays on", async () => {
  const page = await readyPage(zeroSellPools()), { provider, element, poll, flush, until } = page;
  await poll();
  await element("connect").click();
  await element("auto-mode").change(true);
  await until(() => /^ABORTED: return ≤ input · Sell leg quotes 0/.test(element("status").textContent), "the abort");
  assert.equal(element("status").className, "error");
  assert.equal(provider.sent.length, 0);
  assert.equal(element("auto-mode").checked, true);
  assert.match(element("activity").textContent, /Auto mode: ABORTED: return ≤ input \(sell leg quoted 0\); nothing sent\./);
  await flush();
  assert.equal(element("spreads-body").children[0].children[5].textContent, "RED · sell quote 0");
  await poll(); await flush();
  assert.equal(provider.sent.length, 0);
  assert.equal((element("activity").textContent.match(/sell leg quoted 0/g) || []).length, 1, "the abort is logged once");
  assert.doesNotMatch(element("activity").textContent, /skipped: Sell leg quotes 0/, "the later skip of the same route is not logged again");
  // Changing the pair clears the mark (a new watch re-quotes from scratch).
  await element("auto-mode").change(false);
  await element("apply-pair").click();
  await until(() => page.timers.length > 0, "restart"); await flush();
  await poll();
  assert.equal(element("spreads-body").children[0].children[5].textContent, "GREEN");
});

test("fix 5: 3-LEG rows show no percentage at all, only a green live dot and the 3-LEG tag", async () => {
  const page = await readyPage(allPairsProvider()), { element } = page;
  await chooseMode(page, "All pairs");
  const spreads = element("allpairs-spreads-body").children;
  const cross = spreads.filter((row) => row.children[5].textContent.startsWith("3-LEG"));
  const same = spreads.filter((row) => row.children[5].textContent.startsWith("2-LEG"));
  assert.equal(cross.length, 3);
  for (const row of cross) {
    assert.deepEqual([row.children[1].textContent, row.children[2].textContent, row.children[3].textContent], ["", "", ""], "no Spread%, Fee% or Net%");
    assert.equal(row.children[4].textContent, "● 3-LEG");
    assert.equal(row.children[4].className, "green", "both pools exist: live");
    assert.equal(row.children[5].textContent, "3-LEG · watch-only");
    assert.equal(row.listeners.click, undefined);
  }
  assert.ok(same.every((row) => /^-?\d+\.\d{3}$/.test(row.children[3].textContent) && ["GREEN", "RED"].includes(row.children[4].textContent)), "executable rows keep their numbers");
  assert.equal(spreads.findIndex((row) => row.children[5].textContent.startsWith("3-LEG")), same.length, "3-LEG rows come after the executable rows");
});

test("fix 6: the Token B list never wraps an address: pre + horizontal scroll on the textarea", async () => {
  const { html } = loadPage();
  assert.match(html, /#token-b-list\s*\{[^}]*white-space:\s*pre;[^}]*overflow-x:\s*auto;/);
  assert.doesNotMatch(html, /#token-b-list\s*\{[^}]*white-space:\s*nowrap/, "nowrap would collapse the one-address-per-line breaks");
});

test("fix 9: the Auto checkbox is a standalone input with a plain span; no <label> wraps it", async () => {
  const { html, element } = await readyPage();
  assert.doesNotMatch(html, /<label>\s*<input id="auto-mode"/, "no label wrapper");
  assert.match(html, /<input id="auto-mode" type="checkbox" aria-labelledby="auto-mode-text">\s*<span id="auto-mode-text">Auto mode: execute when Net% is above the threshold<\/span>/);
  assert.equal(element("auto-mode").tagName, "input");
  assert.equal(element("auto-mode-text").tagName, "span");
  assert.equal(element("auto-mode-text").listeners.click, undefined, "the text toggles nothing");
  // The checkbox itself still drives auto mode.
  await element("auto-mode").change(true);
  assert.match(element("auto-status").textContent, /^Auto mode ON/);
  await element("auto-mode").change(false);
  assert.match(element("auto-status").textContent, /^Auto mode OFF/);
});

test("fix 8: a mixed route whose V4 token lacks the layer-1 Permit2 allowance shows the exact instruction inline and sends nothing", async () => {
  const provider = mixedPools(false); // V4 buy (sells USDG) → V3 sell
  provider.tokenAllowances.set(E.USDG.toLowerCase(), ethers.BigNumber.from(0));
  const page = await readyPage(provider), { element, flush } = page;
  await element("connect").click();
  await element("spreads-body").children[0].click(); await flush();
  assert.match(element("route-warning").textContent, /2 transactions required/);
  assert.match(element("route-warning").textContent, /⚠️ Approve USDG for Permit2 in MetaMask \(Contract tab → Permit2 → increaseAllowance\) before this route will work\.$/, "appended to the mixed-route notice");
  assert.equal(element("route-warning").hidden, false);
  assert.match(element("status").textContent, PERMIT2_INLINE);
  assert.equal(element("status").className, "error");
  assert.match(element("activity").textContent, PERMIT2_INLINE);
  // The approval and the dry run stop with the same message; nothing reaches the wallet's send.
  await element("approve-permit2").click();
  assert.match(element("status").textContent, PERMIT2_INLINE);
  await element("dry-run").click();
  assert.match(element("status").textContent, PERMIT2_INLINE);
  assert.equal(element("send").disabled, true);
  assert.equal(provider.sent.length, 0);
  // Once the token is approved to Permit2 the same clicks go through.
  provider.tokenAllowances.set(E.USDG.toLowerCase(), E.MAX_UINT256);
  await element("approve-v3-router").click();
  await element("approve-permit2").click();
  assert.match(element("status").textContent, /V4 leg Permit2 allowance is ready/);
  await element("dry-run").click();
  assert.match(element("status").textContent, /First leg dry run succeeded/);
});

test("fix 8: a spread quoted before connecting is checked when the wallet connects; a V3/V3 route is never warned", async () => {
  const provider = mixedPools(true); // V3 buy → V4 sell (sells PONS)
  provider.tokenAllowances.set(E.PONS.toLowerCase(), ethers.BigNumber.from(0));
  const page = await readyPage(provider), { element, flush } = page;
  await element("spreads-body").children[0].click(); await flush();
  assert.doesNotMatch(element("route-warning").textContent, /⚠️/, "no account yet: nothing to check");
  await element("connect").click();
  assert.match(element("route-warning").textContent, /⚠️ Approve PONS for Permit2/);
  assert.match(element("status").textContent, /⚠️ Approve PONS for Permit2/);
  const v3 = await readyPage(withV3Pools());
  v3.provider.tokenAllowances.set(E.USDG.toLowerCase(), ethers.BigNumber.from(0));
  await chooseProtocol(v3, "V3");
  await v3.element("connect").click();
  await v3.element("spreads-body").children[0].click(); await v3.flush();
  assert.equal(v3.element("route-warning").hidden, true);
  assert.doesNotMatch(v3.element("status").textContent, /Permit2/);
});
