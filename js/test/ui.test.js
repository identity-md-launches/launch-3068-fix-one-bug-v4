"use strict";

// Execute the actual inline page script and local scripts with a minimal DOM. No browser/npm/network needed.
// These are event-handler tests; they do not claim to test browser rendering or a real wallet extension.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { MockWallet, CALLER } = require("./mock-wallet.js");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");

function loadPage(provider = new MockWallet()) {
  const root = path.resolve(__dirname, "../..");
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const elements = new Map();
  for (const match of html.matchAll(/<\w+\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    const tag = match[0];
    elements.set(match[1], {
      textContent: "",
      value: /\bvalue="([^"]*)"/.exec(tag)?.[1] || "",
      disabled: /\bdisabled\b/.test(tag),
      className: "",
      listeners: {},
      addEventListener(event, listener) { this.listeners[event] = listener; },
      async click() { if (!this.disabled) return this.listeners.click(); },
      input(value) { this.value = value; return this.listeners.input(); },
    });
  }
  const document = { getElementById: (id) => {
    assert.ok(elements.has(id), "Missing DOM element " + id);
    return elements.get(id);
  } };
  const context = vm.createContext({ document, window: { ethereum: provider, crypto: globalThis.crypto },
    // Zero-delay scheduling exercises receipt polling without real-time waits.
    setTimeout: (fn) => setTimeout(fn, 0), clearTimeout, console, atob, btoa });
  for (const script of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    const src = /\bsrc="([^"]+)"/.exec(script[1])?.[1];
    if (src) {
      assert.ok(!src.includes(":") && !src.startsWith("/"), "All page dependencies must be local");
      try {
        vm.runInContext(fs.readFileSync(path.join(root, src), "utf8"), context, { filename: src });
      } catch (error) { throw new Error(src + ": " + error.message); }
    } else vm.runInContext(script[2], context, { filename: "index.html:inline" });
  }
  return { provider, element: document.getElementById, context, html };
}

async function approvedPage() {
  const page = loadPage();
  await page.element("connect").click();
  await page.element("approve-permit2").click();
  return page;
}

test("page loads offline, makes no wallet calls on load, and sends only after approve + dry run + send clicks", async () => {
  const { provider, element, html } = loadPage();
  assert.ok(html.includes("APPROVE PERMIT2 (one-time)"));
  assert.equal(provider.calls.length, 0);
  assert.equal(element("send").disabled, true);
  assert.equal(element("approve-permit2").disabled, true);
  await element("connect").click();
  assert.equal(element("account").textContent, CALLER);
  assert.equal(element("send").disabled, true);
  await element("approve-permit2").click();
  assert.equal(provider.sent.length, 2);
  assert.match(element("status").textContent, /allowances are ready/);
  assert.equal(element("send").disabled, true);
  await element("dry-run").click();
  assert.match(element("status").textContent, /Dry run succeeded/);
  assert.equal(element("send").disabled, false);
  const data = element("calldata").textContent;
  assert.equal(data, E.buildCalldata({
    usdgIn: ethers.utils.parseUnits("0.01", 6),
    ponsAmount: ethers.utils.parseUnits("0.001", 18),
    minUsdgOut: 0,
    recipient: CALLER,
    deadline: provider.now + 1200,
  }));
  assert.equal(provider.sent.length, 2);
  await element("send").click();
  assert.equal(provider.sent.length, 3);
  assert.equal(provider.sent[2].data, data);
  assert.match(element("status").textContent, /Swap confirmed:/);
  assert.match(element("activity").textContent, /USDG Permit2 approval confirmed:/);
  assert.match(element("activity").textContent, /PONS Permit2 approval confirmed:/);
  assert.equal(element("send").disabled, true);
});

test("missing wallet and wrong chain show useful errors without writes", async () => {
  for (const provider of [undefined, new MockWallet()]) {
    const page = provider === undefined ? loadPage(null) : loadPage(provider);
    if (provider) provider.chain = "0x1";
    await page.element("connect").click();
    assert.match(page.element("status").textContent, /No wallet|4663/);
    assert.equal(page.element("send").disabled, true);
    assert.equal(page.element("approve-permit2").disabled, true);
    if (provider) assert.equal(provider.sent.length, 0);
  }
});

test("bad input never requests approval and changing amounts invalidates a previous dry run", async () => {
  const { provider, element } = await approvedPage();
  await element("dry-run").click();
  element("pons-amount").input("0.002");
  assert.equal(element("send").disabled, true);
  assert.equal(element("calldata").textContent, "Not built yet.");
  for (const value of ["0", "-1", "abc", "1e18", "0.0000000000000000001"]) {
    element("pons-amount").input(value);
    await element("approve-permit2").click();
    assert.equal(provider.sent.length, 2);
    assert.equal(element("send").disabled, true);
    assert.equal(element("status").className, "error");
  }
  element("pons-amount").input("0.001");
  element("min-usdg-out").input("0.0000001");
  await element("dry-run").click();
  assert.match(element("status").textContent, /6 decimals/);
  assert.equal(provider.sent.length, 2);
});

test("ERC20 prerequisite failure explains correct spender before any Permit2 approval", async () => {
  const { provider, element } = loadPage();
  provider.tokenAllowances.set(E.PONS.toLowerCase(), ethers.BigNumber.from(0));
  await element("connect").click();
  await element("approve-permit2").click();
  assert.match(element("status").textContent, /PONS ERC20 allowance to Permit2/);
  assert.ok(element("status").textContent.includes(E.PERMIT2));
  assert.equal(provider.sent.length, 0);
});

test("failed approval, failed dry run and failed final simulation never enable a bypass", async () => {
  const { provider, element } = loadPage();
  await element("connect").click();
  provider.rejectSend = 2;
  await element("approve-permit2").click();
  assert.match(element("status").textContent, /Wallet request rejected/);
  assert.equal(provider.sent.length, 1);
  assert.equal(element("send").disabled, true);
  provider.rejectSend = 0;
  await element("approve-permit2").click();
  provider.failRouterCall = 1;
  await element("dry-run").click();
  assert.equal(element("send").disabled, true);
  assert.match(element("status").textContent, /pool unavailable/);
  provider.failRouterCall = 0;
  await element("dry-run").click();
  provider.failRouterCall = 3;
  await element("send").click();
  assert.equal(provider.sent.length, 2);
  assert.equal(element("send").disabled, true);
  assert.match(element("status").textContent, /pool unavailable/);
});

test("wallet events clear send readiness and require reconnection", async () => {
  const { provider, element } = await approvedPage();
  for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
    await element("connect").click();
    await element("dry-run").click();
    assert.equal(element("send").disabled, false);
    provider.emit(event, []);
    assert.equal(element("send").disabled, true);
    assert.equal(element("dry-run").disabled, true);
    assert.match(element("account").textContent, /Connect again/);
    assert.match(element("status").textContent, /reconnect/);
  }
  assert.equal(provider.sent.length, 2);
});

test("busy UI prevents duplicate approval sequences and locks amount fields", async () => {
  const { provider, element } = loadPage();
  await element("connect").click();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  provider.beforeRequest = async ({ method }) => { if (method === "eth_getTransactionReceipt") await gate; };
  const first = element("approve-permit2").click();
  assert.equal(element("approve-permit2").disabled, true);
  assert.equal(element("pons-amount").disabled, true);
  assert.equal(element("connect").disabled, true);
  await element("approve-permit2").click();
  release();
  await first;
  assert.equal(provider.sent.length, 2);
  assert.equal(element("pons-amount").disabled, false);
});

test("provider errors are rendered as text, never interpreted as HTML", async () => {
  const { provider, element } = loadPage();
  provider.beforeRequest = async () => { throw new Error("<img src=x onerror=alert(1)>"); };
  await element("connect").click();
  assert.equal(element("status").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(element("status").innerHTML, undefined);
});
