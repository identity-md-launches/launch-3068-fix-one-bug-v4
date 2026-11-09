"use strict";

// Job 8 (audit fixes): the pure rules behind the page's guards, and the wallet client's Permit2
// layer-1 messages. Offline, against the mocks; nothing leaves the process.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { V3Mock, v4Row } = require("./v3-mock.js");
const { CALLER } = require("./mock-wallet.js");
const bn = ethers.BigNumber.from;
const lower = (a) => a.toLowerCase();
// The wallet client prefixes every error with "V4ArbEncoder: " (house style); the instruction itself is exact.
const PERMIT2_MESSAGE = /(^|V4ArbEncoder: )⚠️ Approve (USDG|PONS) for Permit2 in MetaMask \(Contract tab → Permit2 → increaseAllowance\) before this route will work\.$/;

test("fix 1: autoSendAllowed is true only when the quoted return is STRICTLY above the input", () => {
  assert.equal(E.autoSendAllowed(bn(10000), bn(10001)), true);
  assert.equal(E.autoSendAllowed(bn(10000), bn(10000)), false, "equal is not a profit");
  assert.equal(E.autoSendAllowed(bn(10000), bn(9999)), false);
  assert.equal(E.autoSendAllowed(bn(10000), bn(0)), false);
  assert.equal(E.autoSendAllowed(bn(0), bn(1)), false, "a zero input never trades");
  assert.equal(E.autoSendAllowed(bn(10000), null), false, "no quote, no send");
  assert.equal(E.autoSendAllowed(bn(10000), undefined), false);
  assert.equal(E.autoSendAllowed(null, bn(1)), false);
  assert.equal(E.autoSendAllowed("10000", "10001"), true, "strings and BigNumbers alike");
  assert.equal(E.autoSendAllowed(E.MAX_UINT128, E.MAX_UINT128.add(1)), true);
  assert.equal(E.AUTO_ABORT_MESSAGE, "ABORTED: return ≤ input");
});

test("fix 7: returnColor is green above the input and red at or below it", () => {
  assert.equal(E.returnColor(bn(10000), bn(10001)), "green");
  assert.equal(E.returnColor(bn(10000), bn(10000)), "red");
  assert.equal(E.returnColor(bn(10000), bn(1)), "red");
  assert.equal(E.returnColor(bn(10000), null), "red");
});

test("fix 2: sellQuoteValid rejects a zero or missing sell quote", () => {
  assert.equal(E.sellQuoteValid(bn(1)), true);
  assert.equal(E.sellQuoteValid("0x01"), true);
  assert.equal(E.sellQuoteValid(bn(0)), false);
  assert.equal(E.sellQuoteValid(null), false);
  assert.equal(E.sellQuoteValid(undefined), false);
  assert.match(E.SELL_QUOTE_ZERO_MESSAGE, /^Sell leg quotes 0: no liquidity in the tick range\. Route invalid \(RED\)/);
});

test("fix 5: threeLegLive is true only when both pools exist and are tradeable", () => {
  const ok = { active: true, price: 1, status: "OK" };
  assert.equal(E.threeLegLive(ok, { ...ok }), true);
  assert.equal(E.threeLegLive(ok, { ...ok, status: "EMPTY" }), false);
  assert.equal(E.threeLegLive(ok, { ...ok, status: "STALE" }), false);
  assert.equal(E.threeLegLive(ok, { ...ok, active: false }), false);
  assert.equal(E.threeLegLive(ok, { ...ok, price: 0 }), false);
  assert.equal(E.threeLegLive(ok, null), false);
  assert.equal(E.threeLegLive(undefined, ok), false);
});

test("fix 5: allPairsSpreads tags cross-pair rows 3-LEG with a live flag and no GREEN/RED verdict, after every executable row", () => {
  const pairA = { tokenA: E.PONS, tokenB: E.USDG, currency0: E.PONS, currency1: E.USDG, symbolB: "USDG" };
  const pairB = { tokenA: E.PONS, tokenB: E.WETH, currency0: E.WETH, currency1: E.PONS, symbolB: "WETH" };
  const pool = (pairKey, pair, fee, displayPrice, extra = {}) => ({ protocol: "V3", pairKey, pair, fee, poolId: pairKey + fee, address: "0x" + fee,
    active: true, status: "OK", price: displayPrice, displayPrice, ...extra });
  const pools = [pool("A", pairA, 500, 0.19), pool("A", pairA, 3000, 0.20), pool("B", pairB, 500, 5)];
  const spreads = E.allPairsSpreads(pools, 0.5);
  const same = spreads.filter((s) => !s.crossPair), cross = spreads.filter((s) => s.crossPair);
  assert.equal(same.length, 1);
  assert.equal(cross.length, 2);
  assert.deepEqual(spreads.map((s) => s.crossPair), [false, true, true], "executable rows first");
  assert.ok(cross.every((s) => s.verdict === "3-LEG" && s.live === true), "a binary indicator, not a verdict");
  assert.ok(["GREEN", "RED"].includes(same[0].verdict));
  // A cross-pair row never reaches auto mode, whatever its arithmetic says.
  const decision = E.allPairsAutoDecision(pools, 0);
  assert.ok(decision.spread === null || decision.spread.buy.pairKey === decision.spread.sell.pairKey);
});

test("fix 3: REVOKE_SPENDERS names the V3 Router, the V4 PoolManager and Permit2, in that order", () => {
  assert.deepEqual(E.REVOKE_SPENDERS.map((entry) => lower(entry[0])), [E.V3_ROUTER, E.POOL_MANAGER, E.PERMIT2].map(lower));
  assert.deepEqual(E.REVOKE_SPENDERS.map((entry) => entry[1]), ["V3 Router", "PoolManager", "Permit2"]);
});

test("fix 3: revokeAll zeroes a token's allowance to every spender, skips the ones already at 0, and never touches the other token", async () => {
  const p = new V3Mock();
  p.setAllowance(E.PONS, 1000); // PONS → V3 Router
  p.spenderAllowances.set(p.key(CALLER, E.PONS, E.POOL_MANAGER), bn(3)); // PONS → PoolManager
  p.tokenAllowances.set(lower(E.PONS), bn(0)); // PONS → Permit2 already 0
  const usdgBefore = p.tokenAllowances.get(lower(E.USDG)).toString();
  const wallet = E.createWalletClient(p, { onStatus: () => {}, pollIntervalMs: 0 });
  await wallet.connect();
  const done = await wallet.revokeAll(E.PONS, "PONS");
  assert.deepEqual(done.map((d) => lower(d.spender)), [lower(E.V3_ROUTER), lower(E.POOL_MANAGER)]);
  assert.equal(p.sent.length, 2);
  assert.ok(p.sent.every((tx) => lower(tx.to) === lower(E.PONS)));
  assert.equal(p.allowance(E.PONS).toString(), "0");
  assert.equal(p.spenderAllowances.get(p.key(CALLER, E.PONS, E.POOL_MANAGER)).toString(), "0");
  assert.equal(p.tokenAllowances.get(lower(E.USDG)).toString(), usdgBefore, "USDG untouched by a PONS revocation");
  assert.deepEqual(await wallet.revokeAll(E.PONS, "PONS"), [], "nothing left to revoke");
  assert.equal(p.sent.length, 2);
});

test("fix 8: permit2LayerOneMessage is the exact inline instruction; permit2LayerOneTokens lists each V4 leg's input token", () => {
  assert.equal(E.permit2LayerOneMessage("USDG"), "⚠️ Approve USDG for Permit2 in MetaMask (Contract tab → Permit2 → increaseAllowance) before this route will work.");
  assert.match(E.permit2LayerOneMessage("PONS"), PERMIT2_MESSAGE);
  const pair = { currency0: E.PONS, currency1: E.USDG, symbol0: "PONS", symbol1: "USDG" };
  const v3 = { protocol: "V3" }, v4 = { protocol: "V4" };
  assert.deepEqual(E.permit2LayerOneTokens(v4, v3, pair), [{ token: E.USDG, symbol: "USDG" }], "V4 buy sells currency1");
  assert.deepEqual(E.permit2LayerOneTokens(v3, v4, pair), [{ token: E.PONS, symbol: "PONS" }], "V4 sell sells currency0");
  assert.deepEqual(E.permit2LayerOneTokens(v4, v4, pair).map((e) => e.symbol), ["USDG", "PONS"]);
  assert.deepEqual(E.permit2LayerOneTokens(v3, v3, pair), [], "V3 never uses Permit2");
});

test("fix 8: readErc20Allowance reads allowance(owner, spender) through any request function", async () => {
  const p = new V3Mock();
  p.tokenAllowances.set(lower(E.USDG), bn(123));
  const rpc = E.createRpcClient(E.RPC_URL, p.fetch);
  assert.equal((await E.readErc20Allowance(rpc.request, E.USDG, CALLER, E.PERMIT2)).toString(), "123");
  assert.equal((await E.readErc20Allowance(rpc.request, E.PONS, CALLER, E.POOL_MANAGER)).toString(), "0");
  await assert.rejects(E.readErc20Allowance(rpc.request, "0x1234", CALLER, E.PERMIT2), /invalid address/);
});

function mixedRoute(p, v4First) {
  const v3 = p.row(3000);
  const v4 = v4Row(3000, 60);
  return { buy: v4First ? v4 : v3, sell: v4First ? v3 : v4, usdgIn: bn(10000), ponsAmount: bn("49750000000000000"), minUsdgOut: bn(10890),
    pair: { currency0: E.PONS, currency1: E.USDG, symbol0: "PONS", symbol1: "USDG" } };
}

test("fix 8 preferred path: a zero layer-1 allowance stops the dry run, the send and the Permit2 approval with the clear message; nothing is sent", async () => {
  const p = new V3Mock();
  p.tokenAllowances.set(lower(E.USDG), bn(0)); // USDG → Permit2 missing; the V4 buy leg sells USDG
  p.setPermit(E.USDG, E.MAX_UINT160, p.now + 3600);
  p.setAllowance(E.PONS, bn("4975000000000000000")); // the V3 sell leg is fine
  const wallet = E.createWalletClient(p, { onStatus: () => {} });
  await wallet.connect();
  await assert.rejects(wallet.prepareRoute(mixedRoute(p, true)), PERMIT2_MESSAGE);
  await assert.rejects(wallet.approveRoutePermit2(mixedRoute(p, true), p.now + 30 * 24 * 3600), PERMIT2_MESSAGE);
  assert.equal(p.sent.length, 0);
  assert.equal(p.routerCalls, 0, "the router was never simulated");
  // A V4 SELL leg with PONS unapproved names PONS.
  p.tokenAllowances.set(lower(E.USDG), E.MAX_UINT256);
  p.tokenAllowances.set(lower(E.PONS), bn(0));
  p.setAllowance(E.USDG, bn(1000000));
  p.setPermit(E.PONS, E.MAX_UINT160, p.now + 3600);
  await assert.rejects(wallet.prepareRoute(mixedRoute(p, false)), /⚠️ Approve PONS for Permit2/);
  // A nonzero but insufficient allowance keeps the follow-up 4 wording: the instruction is for the missing case.
  p.tokenAllowances.set(lower(E.PONS), bn(1));
  await assert.rejects(wallet.prepareRoute(mixedRoute(p, false)), /ERC20 allowance to Permit2 is too low/);
  // V4/V4 (prepareSwap) gets the same instruction through checkTokenAllowances.
  p.tokenAllowances.set(lower(E.PONS), bn(0));
  await assert.rejects(wallet.prepareSwap({ usdgIn: 10000, ponsAmount: "49750000000000000", minUsdgOut: 0 }), /⚠️ Approve PONS for Permit2/);
  assert.equal(p.sent.length, 0);
});

test("fix 8 fallback: a V4 leg that reverts after the pre-check is explained by the Permit2 message when the allowance is 0, and left alone otherwise", async () => {
  const p = new V3Mock();
  p.setPermit(E.USDG, E.MAX_UINT160, p.now + 3600);
  p.setAllowance(E.PONS, bn("4975000000000000000"));
  const wallet = E.createWalletClient(p, { onStatus: () => {} });
  await wallet.connect();
  // The allowance disappears between the pre-check and the simulation (another tab revoked it): the revert is opaque.
  p.beforeRequest = async ({ method, params }) => {
    if (method === "eth_call" && params[0].to && lower(params[0].to) === lower(E.ROUTER)) {
      p.tokenAllowances.set(lower(E.USDG), bn(0));
      p.failSimulation = true;
    }
  };
  await assert.rejects(wallet.prepareRoute(mixedRoute(p, true)), PERMIT2_MESSAGE);
  assert.equal(p.sent.length, 0);
  // The same revert with the allowance intact is reported as it is.
  p.beforeRequest = null;
  p.tokenAllowances.set(lower(E.USDG), E.MAX_UINT256);
  p.failSimulation = true;
  await assert.rejects(wallet.prepareRoute(mixedRoute(p, true)), /V4 simulation failed/);
  p.failSimulation = false;
  // Dry run passes; the send's own eth_call reverts after the allowance vanished: the clear message again, nothing sent.
  const prepared = await wallet.prepareRoute(mixedRoute(p, true));
  p.beforeRequest = async ({ method, params }) => {
    if (method === "eth_call" && params[0].to && lower(params[0].to) === lower(E.ROUTER)) {
      p.tokenAllowances.set(lower(E.USDG), bn(0));
      p.failSimulation = true;
    }
  };
  await assert.rejects(wallet.sendRoute(prepared), PERMIT2_MESSAGE);
  assert.equal(p.sent.length, 0);
});
