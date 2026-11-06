"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { MockWallet, CALLER, OTHER, permit, paramsType } = require("./mock-wallet.js");
const abi = ethers.utils.defaultAbiCoder;
const usdg = ethers.utils.parseUnits("0.01", 6);
const pons = ethers.utils.parseUnits("0.001", 18);
const args = { usdgIn: usdg, ponsAmount: pons, minUsdgOut: 0 };
const clientFor = (p, options) => E.createWalletClient(p, { pollIntervalMs: 0, ...options });

async function setup(approved = false) {
  const provider = new MockWallet();
  const client = clientFor(provider);
  await client.connect();
  if (approved) [E.USDG, E.PONS].forEach((token) => provider.setPermit(token, E.MAX_UINT160));
  return { provider, client };
}

test("Permit2 approve selector and four words match the contract ABI, not ERC20 approve", () => {
  const data = E.encodePermit2Approve(E.USDG, E.ROUTER, 10000, 1800003600);
  assert.equal(data.slice(0, 10), "0x87517c45");
  assert.equal(ethers.utils.hexDataLength(data), 132);
  assert.equal(data, permit.encodeFunctionData("approve", [E.USDG, E.ROUTER, 10000, 1800003600]));
  const result = permit.decodeFunctionData("approve", data);
  assert.equal(result.token, E.USDG);
  assert.equal(result.spender, E.ROUTER);
  assert.equal(result.amount.toString(), "10000");
  assert.equal(Number(result.expiration), 1800003600);
});

test("uint160/uint48 exact boundaries, including unlimited and zero revocation", () => {
  for (const [amount, expiration] of [[0, 0], [E.MAX_UINT160, E.MAX_UINT48]]) {
    const encoded = E.encodePermit2Approve(E.PONS, E.ROUTER, amount, expiration);
    const result = permit.decodeFunctionData("approve", encoded);
    assert.ok(result.amount.eq(amount));
    assert.ok(ethers.BigNumber.from(result.expiration).eq(expiration));
  }
});

for (const [name, amount, expiration, pattern] of [
  ["negative amount", -1, 1, /uint160/],
  ["uint256 max is not a Permit2 amount", E.MAX_UINT256, 1, /uint160/],
  ["uint160 overflow", E.MAX_UINT160.add(1), 1, /uint160/],
  ["negative expiration", 1, -1, /uint48/],
  ["uint48 overflow", 1, E.MAX_UINT48.add(1), /uint48/],
  ["fractional amount", "0.01", 1, /invalid BigNumber/],
]) test(name, () => assert.throws(() => E.encodePermit2Approve(E.USDG, E.ROUTER, amount, expiration), pattern));

test("invalid/zero token and spender rejected", () => {
  for (const bad of [ethers.constants.AddressZero, "0x1234"]) {
    assert.throws(() => E.encodePermit2Approve(bad, E.ROUTER, 1, 1));
    assert.throws(() => E.encodePermit2Approve(E.USDG, bad, 1, 1));
  }
});

test("full flow: confirmed USDG approval, confirmed PONS approval, build, eth_call, send and receipt", async () => {
  const { provider, client } = await setup();
  await assert.rejects(client.prepareSwap(args), /Permit2 allowance/);
  const expiry = provider.now + 30 * 86400;
  await client.approveBothPermit2(usdg.mul(100), pons.mul(100), expiry);
  assert.equal(provider.sent.length, 2);
  for (let i = 0; i < 2; i++) {
    const tx = provider.sent[i];
    assert.equal(tx.to, E.PERMIT2);
    assert.equal(tx.from, CALLER);
    assert.equal(tx.value, "0x0");
    assert.equal(tx.chainId, "0x1237");
    const decoded = permit.decodeFunctionData("approve", tx.data);
    assert.equal(decoded.token.toLowerCase(), [E.USDG, E.PONS][i].toLowerCase());
    assert.equal(decoded.spender, E.ROUTER);
    assert.equal(Number(decoded.expiration), expiry);
    assert.ok(decoded.amount.eq([usdg, pons][i].mul(100)));
  }
  const secondSend = provider.calls.findIndex((c, i) => c.method === "eth_sendTransaction" &&
    provider.calls.slice(0, i).some((prior) => prior.method === "eth_sendTransaction"));
  assert.equal(provider.calls.slice(0, secondSend).filter((c) => c.method === "eth_getTransactionReceipt").length, 2);
  const prepared = await client.prepareSwap(args);
  assert.ok(Object.isFrozen(prepared.transaction));
  const [, inputs, deadline] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + prepared.transaction.data.slice(10));
  assert.equal(deadline.toNumber(), provider.now + 1200);
  const swaps = inputs.map((input) => {
    const [, params] = abi.decode(["bytes", "bytes[]"], input);
    const [, recipient] = abi.decode(["address", "address", "uint256"], params[2]);
    assert.equal(recipient, CALLER);
    return abi.decode([paramsType], params[0])[0];
  });
  assert.ok(swaps[0][2].eq(10000)); // 0.01 USDG, never 1e16
  assert.ok(swaps[0][3].eq(pons));
  assert.ok(swaps[1][2].eq(pons));
  assert.ok(swaps[1][3].isZero());
  assert.equal(provider.sent.length, 2); // preparing never sends
  const receipt = await client.sendSwap(prepared);
  assert.equal(receipt.status, "0x1");
  assert.equal(provider.sent.length, 3);
  assert.deepEqual(provider.sent[2], prepared.transaction);
  const simulations = provider.calls.filter((c) => c.method === "eth_call" && c.params[0].to === E.ROUTER);
  assert.equal(simulations.length, 2);
  for (const call of simulations) assert.deepEqual(call.params, [prepared.transaction, "latest"]);
  await assert.rejects(client.sendSwap(prepared), /dry run/);
});

test("four-argument browser approvePermit2 uses window.ethereum and waits for confirmation", async () => {
  const provider = new MockWallet();
  const context = { ethers, window: { ethereum: provider }, setTimeout: (f) => setTimeout(f, 0) };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve("../v4-arb-encoder.js"), "utf8"), context);
  const receipt = await context.V4ArbEncoder.approvePermit2(E.PONS, E.ROUTER, pons, provider.now + 3600);
  assert.equal(receipt.status, "0x1");
  assert.ok(provider.readPermit(CALLER, E.PONS)[0].eq(pons));
  assert.equal(provider.listenerCount("accountsChanged"), 0);
});

test("reusable approvals are skipped, a partially completed sequence resumes with PONS", async () => {
  const { provider, client } = await setup();
  provider.rejectSend = 2;
  await assert.rejects(client.approveBothPermit2(usdg, pons, provider.now + 3600), { code: 4001 });
  assert.equal(provider.sent.length, 1);
  provider.rejectSend = 0;
  await client.approveBothPermit2(usdg, pons, provider.now + 3600);
  assert.equal(provider.sent.length, 2);
  await client.approveBothPermit2(usdg, pons, provider.now + 3600);
  assert.equal(provider.sent.length, 2);
});

for (const kind of ["rejectSend", "failReceipt"]) {
  for (const index of [1, 2]) {
    test(`${kind} on approval ${index} stops the sequence without a swap`, async () => {
      const { provider, client } = await setup();
      provider[kind] = index;
      await assert.rejects(client.approveBothPermit2(usdg, pons, provider.now + 3600),
        kind === "rejectSend" ? /rejected/ : /reverted/);
      assert.equal(provider.sent.length, kind === "rejectSend" ? index - 1 : index);
      assert.equal(provider.routerCalls, 0);
      assert.ok(provider.readPermit(CALLER, E.PONS)[0].isZero());
    });
  }
}

test("pending approval times out without requesting the next approval", async () => {
  const provider = new MockWallet();
  provider.neverMine = true;
  const client = clientFor(provider, { receiptTimeoutMs: 20, pollIntervalMs: 1 });
  await client.connect();
  await assert.rejects(client.approveBothPermit2(usdg, pons, provider.now + 3600), /may still be pending/);
  assert.equal(provider.sent.length, 1);
});

test("future expiration enforced; revoking with zero amount and expiration is allowed", async () => {
  const { provider, client } = await setup();
  for (const expiry of [0, provider.now - 1, provider.now]) {
    await assert.rejects(client.approvePermit2(E.USDG, E.ROUTER, usdg, expiry), /future Unix timestamp/);
  }
  assert.equal(provider.sent.length, 0);
  await client.approvePermit2(E.USDG, E.ROUTER, 0, 0);
  assert.equal(provider.sent.length, 1);
});

test("validates both limits and expiration before making any approval transaction", async () => {
  const { provider, client } = await setup();
  await assert.rejects(client.approveBothPermit2(usdg, E.MAX_UINT160.add(1), provider.now + 3600), /uint160/);
  await assert.rejects(client.approveBothPermit2(usdg, 0, provider.now + 3600), /positive/);
  await assert.rejects(client.approveBothPermit2(usdg, pons, provider.now + 10), /20 minutes/);
  assert.equal(provider.sent.length, 0);
});

test("wrong chain, disconnected account, missing wallet and missing deployed code prevent writes", async () => {
  assert.throws(() => E.createWalletClient(), /No wallet/);
  const provider = new MockWallet();
  const client = clientFor(provider);
  await assert.rejects(client.approvePermit2(E.USDG, E.ROUTER, usdg, provider.now + 3600), /connect again/);
  provider.chain = "0x1";
  await assert.rejects(client.connect(), /4663/);
  provider.chain = "0x1237";
  provider.account = null;
  await assert.rejects(client.connect(), /no accounts/);
  provider.account = CALLER;
  await client.connect();
  provider.code = "0x";
  await assert.rejects(client.approvePermit2(E.USDG, E.ROUTER, usdg, provider.now + 3600), /No contract code/);
  assert.equal(provider.sent.length, 0);
});

for (const token of [E.USDG, E.PONS]) {
  for (const kind of ["ERC20", "insufficient", "expired", "expires before deadline"]) {
    test(`${kind} allowance for ${token} prevents simulation/submission`, async () => {
      const { provider, client } = await setup(true);
      if (kind === "ERC20") provider.tokenAllowances.set(token.toLowerCase(), ethers.BigNumber.from(0));
      else provider.setPermit(token, kind === "insufficient" ? 0 : E.MAX_UINT160,
        kind === "expired" ? provider.now - 1 : kind === "expires before deadline" ? provider.now + 100 : provider.now + 3600);
      await assert.rejects(client.prepareSwap(args), /allowance/);
      assert.equal(provider.sent.length, 0);
      assert.equal(provider.routerCalls, 0);
    });
  }
}

test("approvals for a different owner or spender do not authorize the router", async () => {
  const { provider, client } = await setup();
  provider.setPermit(E.USDG, E.MAX_UINT160, provider.now + 3600, OTHER);
  provider.setPermit(E.PONS, E.MAX_UINT160, provider.now + 3600, CALLER, OTHER);
  await assert.rejects(client.prepareSwap(args), /Permit2 allowance/);
  assert.equal(provider.sent.length, 0);
});

test("failed initial dry run cannot be force-sent", async () => {
  const { provider, client } = await setup(true);
  provider.failRouterCall = 1;
  await assert.rejects(client.prepareSwap(args), /pool unavailable/);
  await assert.rejects(client.sendSwap({ transaction: {} }), /dry run/);
  assert.equal(provider.sent.length, 0);
});

test("fixed PONS minimum higher than swap 1 output fails the dry run", async () => {
  const { provider, client } = await setup(true);
  await assert.rejects(client.prepareSwap({ ...args, ponsAmount: ethers.utils.parseUnits("1", 18) }), /V4TooLittleReceived/);
  assert.equal(provider.sent.length, 0);
});

test("failed fresh dry run, revoked allowance and expired deadline all prevent submission", async () => {
  for (const change of ["call", "allowance", "deadline"]) {
    const { provider, client } = await setup(true);
    const prepared = await client.prepareSwap(args);
    if (change === "call") provider.failRouterCall = 2;
    if (change === "allowance") provider.setPermit(E.PONS, 0);
    if (change === "deadline") provider.now = prepared.deadline;
    await assert.rejects(client.sendSwap(prepared), /pool unavailable|allowance|deadline/);
    assert.equal(provider.sent.length, 0);
  }
});

test("swap wallet rejection and failed receipt are not reported as success or automatically retried", async () => {
  for (const kind of ["rejectSend", "failReceipt"]) {
    const { provider, client } = await setup(true);
    const prepared = await client.prepareSwap(args);
    provider[kind] = 1;
    await assert.rejects(client.sendSwap(prepared), /rejected|reverted/);
    await assert.rejects(client.sendSwap(prepared), /dry run/);
  }
});

for (const event of ["accountsChanged", "chainChanged", "disconnect"]) {
  test(`${event} while waiting for USDG receipt aborts before PONS`, async () => {
    const { provider, client } = await setup();
    provider.beforeRequest = async ({ method }) => {
      if (method === "eth_getTransactionReceipt") provider.emit(event, []);
    };
    await assert.rejects(client.approveBothPermit2(usdg, pons, provider.now + 3600), /connect again/);
    assert.equal(provider.sent.length, 1);
  });

  test(`${event} invalidates previously simulated calldata`, async () => {
    const { provider, client } = await setup(true);
    const prepared = await client.prepareSwap(args);
    provider.emit(event, []);
    await assert.rejects(client.sendSwap(prepared), /dry run/);
    assert.equal(provider.sent.length, 0);
  });
}

test("account or network changes without events are detected before submission", async () => {
  for (const change of ["account", "chain"]) {
    const { provider, client } = await setup(true);
    const prepared = await client.prepareSwap(args);
    provider[change] = change === "account" ? OTHER : "0x1";
    await assert.rejects(client.sendSwap(prepared), /account changed|4663/);
    assert.equal(provider.sent.length, 0);
  }
});

test("recipient always follows the connected wallet, not the reference address", async () => {
  const { provider, client } = await setup();
  provider.account = OTHER;
  await client.connect();
  await client.approveBothPermit2(usdg, pons, provider.now + 3600);
  const prepared = await client.prepareSwap(args);
  assert.equal(prepared.transaction.from, OTHER);
  assert.equal(prepared.transaction.data, E.buildCalldata({ ...args, recipient: OTHER, deadline: prepared.deadline }));
});

test("reconnecting during an in-flight allowance read cannot redirect an approval to another account", async () => {
  const { provider, client } = await setup();
  let switched = false;
  provider.beforeRequest = async ({ method, params }) => {
    if (!switched && method === "eth_call" && params[0].to === E.PERMIT2) {
      switched = true;
      provider.account = OTHER;
      provider.emit("accountsChanged", [OTHER]);
      await client.connect();
    }
  };
  await assert.rejects(client.approveBothPermit2(usdg, pons, provider.now + 3600), /connect again/);
  assert.equal(provider.sent.length, 0);
});

test("prepareSwap snapshots input amounts before any asynchronous wallet requests", async () => {
  const { provider, client } = await setup(true);
  const mutable = { ...args };
  const preparing = client.prepareSwap(mutable);
  mutable.usdgIn = 1;
  mutable.ponsAmount = 1;
  mutable.minUsdgOut = E.MAX_UINT128;
  const prepared = await preparing;
  assert.ok(prepared.usdgIn.eq(usdg));
  assert.ok(prepared.ponsAmount.eq(pons));
  assert.equal(prepared.transaction.data, E.buildCalldata({ ...args, recipient: CALLER, deadline: prepared.deadline }));
});
