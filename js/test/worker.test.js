"use strict";

// Follow-up 6: the JSON-RPC proxy Worker, offline. `handle` runs with a fake fetch; nothing leaves the process.
// Job 8 fix 4: every request below carries a loopback Origin; the allow-list tests at the end vary it.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Proxy = require("../../worker/rpc-proxy.js");

const ORIGIN = "http://localhost:8080";
const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
const BATCH = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_getBalance", params: ["0x0000000000000000000000000000000000000001", "latest"] }]);
const OK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" });

function post(body, origin = ORIGIN) {
  const headers = { "content-type": "application/json" };
  if (origin !== null) headers.origin = origin;
  return new Request("https://proxy.example/", { method: "POST", body, headers });
}

/** A fetch that answers per URL from a script of [status, body] entries, recording every call. */
function fakeFetch(script) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: init.body, method: init.method });
    const next = (script[url] || []).shift();
    if (!next) throw new Error("unexpected upstream " + url);
    if (next instanceof Error) throw next;
    return new Response(next[1], { status: next[0], headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("a healthy primary answers alone: the fallback is never contacted and the body is relayed unchanged", async () => {
  const { fetchImpl, calls } = fakeFetch({ [Proxy.PRIMARY_URL]: [[200, OK]] });
  const response = await Proxy.handle(post(BODY), fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), OK);
  assert.equal(response.headers.get("x-rpc-upstream"), Proxy.PRIMARY_URL);
  assert.equal(response.headers.get("x-rpc-fallback"), "0");
  assert.equal(response.headers.get("access-control-allow-origin"), ORIGIN, "CORS echoes the loopback origin, never *");
  assert.equal(response.headers.get("vary"), "origin");
  assert.deepEqual(calls.map((c) => c.url), [Proxy.PRIMARY_URL]);
  assert.equal(calls[0].body, BODY, "the request body is forwarded byte for byte");
  assert.equal(Proxy.PRIMARY_URL, "https://rpc-robinhood.blockmachine.io");
  assert.equal(Proxy.FALLBACK_URL, "https://robinhood.drpc.org");
});

test("HTTP 429 and 500 from the primary retry the same body once against dRPC and return its answer", async () => {
  for (const status of [429, 500, 502, 503]) {
    const { fetchImpl, calls } = fakeFetch({ [Proxy.PRIMARY_URL]: [[status, '{"error":"busy"}']], [Proxy.FALLBACK_URL]: [[200, OK]] });
    const response = await Proxy.handle(post(BATCH), fetchImpl);
    assert.equal(response.status, 200, "status " + status + " falls back");
    assert.equal(await response.text(), OK);
    assert.equal(response.headers.get("x-rpc-upstream"), Proxy.FALLBACK_URL);
    assert.equal(response.headers.get("x-rpc-fallback"), "1");
    assert.equal(response.headers.get("x-rpc-fallback-reason"), "primary HTTP " + status);
    assert.deepEqual(calls.map((c) => c.url), [Proxy.PRIMARY_URL, Proxy.FALLBACK_URL]);
    assert.ok(calls.every((c) => c.body === BATCH), "batch arrays are forwarded unchanged to both");
  }
});

test("a primary network failure also falls back; the fallback is tried exactly once and its failure is reported", async () => {
  const { fetchImpl, calls } = fakeFetch({ [Proxy.PRIMARY_URL]: [new Error("connect ECONNREFUSED")], [Proxy.FALLBACK_URL]: [[200, OK]] });
  const response = await Proxy.handle(post(BODY), fetchImpl);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("x-rpc-fallback-reason"), /^primary failed: connect ECONNREFUSED/);
  assert.equal(calls.length, 2);

  const both = fakeFetch({ [Proxy.PRIMARY_URL]: [[429, "{}"]], [Proxy.FALLBACK_URL]: [new Error("dns failure")] });
  const failed = await Proxy.handle(post(BODY), both.fetchImpl);
  assert.equal(failed.status, 502);
  const body = JSON.parse(await failed.text());
  assert.equal(body.error.code, -32603);
  assert.match(body.error.message, /both RPC endpoints failed: primary HTTP 429; fallback failed: dns failure/);
  assert.equal(both.calls.length, 2, "no third attempt");

  // A fallback that answers an error status is still relayed as is: the caller sees the real reply.
  const relayed = fakeFetch({ [Proxy.PRIMARY_URL]: [[500, "{}"]], [Proxy.FALLBACK_URL]: [[429, '{"limited":true}']] });
  const reply = await Proxy.handle(post(BODY), relayed.fetchImpl);
  assert.equal(reply.status, 429);
  assert.equal(await reply.text(), '{"limited":true}');
});

test("non-fallback statuses (400, 404) are relayed from the primary without a retry", async () => {
  const { fetchImpl, calls } = fakeFetch({ [Proxy.PRIMARY_URL]: [[400, '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"bad"}}']] });
  const response = await Proxy.handle(post(BODY), fetchImpl);
  assert.equal(response.status, 400);
  assert.equal(calls.length, 1);
  assert.deepEqual([400, 404, 200, 301].map(Proxy.shouldFallBack), [false, false, false, false]);
  assert.deepEqual([429, 500, 502, 503, 504, 599].map(Proxy.shouldFallBack), [true, true, true, true, true, true]);
});

test("the proxy refuses what is not a JSON-RPC POST before touching any upstream", async () => {
  const { fetchImpl, calls } = fakeFetch({});
  const preflight = await Proxy.handle(new Request("https://proxy.example/", { method: "OPTIONS", headers: { origin: ORIGIN } }), fetchImpl);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  assert.equal(preflight.headers.get("access-control-allow-origin"), ORIGIN);
  const get = await Proxy.handle(new Request("https://proxy.example/", { method: "GET", headers: { origin: ORIGIN } }), fetchImpl);
  assert.equal(get.status, 405);
  const parse = await Proxy.handle(post("{not json"), fetchImpl);
  assert.equal(parse.status, 400);
  assert.equal(JSON.parse(await parse.text()).error.code, -32700);
  for (const bad of ["[]", "42", '{"jsonrpc":"2.0","id":1}', '[{"method":""}]', '{"method":"eth_call","params":"x"}']) {
    const response = await Proxy.handle(post(bad), fetchImpl);
    assert.equal(response.status, 400, bad);
    assert.equal(JSON.parse(await response.text()).error.code, -32600);
  }
  const huge = await Proxy.handle(post("[" + "1,".repeat(600000) + "1]"), fetchImpl);
  assert.equal(huge.status, 413);
  assert.equal(calls.length, 0, "nothing forwarded");
  assert.ok(Proxy.validPayload({ method: "eth_call", params: [{}] }));
  assert.ok(Proxy.validPayload({ method: "eth_call", params: { to: "0x" } }), "by-name params are JSON-RPC too");
  await assert.rejects(Proxy.handle(post(BODY), "not a function"), /fetch implementation/);
});

// ------------------------------------------------------------------ job 8 fix 4: origin + method allow-lists

test("origin allow-list: only loopback origins pass; remote, null, missing and look-alike origins are 403 before any upstream call", async () => {
  const { fetchImpl, calls } = fakeFetch({ [Proxy.PRIMARY_URL]: [[200, OK], [200, OK], [200, OK], [200, OK], [200, OK], [200, OK]] });
  for (const origin of ["http://localhost", "http://localhost:3000", "https://localhost:8443", "http://127.0.0.1", "http://127.0.0.1:8000", "http://[::1]:5173"]) {
    const response = await Proxy.handle(post(BODY, origin), fetchImpl);
    assert.equal(response.status, 200, origin + " is loopback");
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.ok(Proxy.isLoopbackOrigin(origin));
  }
  assert.equal(calls.length, 6);
  const refused = ["https://evil.example", "http://localhost.evil.example", "http://127.0.0.1.evil.example:80", "http://localhost@evil.example",
    "http://localhost/", "http://localhost:99999", "ftp://localhost", "null", "", "http://10.0.0.5", "http://192.168.1.2:8080", "http://[::2]"];
  for (const origin of refused) {
    const response = await Proxy.handle(post(BODY, origin), fetchImpl);
    assert.equal(response.status, 403, JSON.stringify(origin) + " is not loopback");
    const body = JSON.parse(await response.text());
    assert.equal(body.error.code, -32600);
    assert.match(body.error.message, /forbidden origin/);
    assert.equal(response.headers.get("access-control-allow-origin"), null, "no CORS grant for a refused origin");
    assert.equal(Proxy.isLoopbackOrigin(origin), false);
  }
  // A request without an Origin header (curl, a server) is refused too: the Worker serves the local page only.
  const missing = await Proxy.handle(post(BODY, null), fetchImpl);
  assert.equal(missing.status, 403);
  // The preflight of a remote origin is refused as well.
  const preflight = await Proxy.handle(new Request("https://proxy.example/", { method: "OPTIONS", headers: { origin: "https://evil.example" } }), fetchImpl);
  assert.equal(preflight.status, 403);
  assert.equal(calls.length, 6, "nothing more was forwarded");
});

test("method allow-list: exactly the brief's eight methods pass; anything else, alone or inside a batch, is 403 and nothing is forwarded", async () => {
  assert.deepEqual(Proxy.ALLOWED_METHODS, ["eth_call", "eth_blockNumber", "eth_getBalance", "eth_estimateGas", "eth_getTransactionReceipt",
    "eth_getTransactionByHash", "eth_chainId", "net_version"]);
  const allowed = Proxy.ALLOWED_METHODS.map((method) => [200, OK]);
  const { fetchImpl, calls } = fakeFetch({ [Proxy.PRIMARY_URL]: allowed.concat([[200, OK]]) });
  for (const method of Proxy.ALLOWED_METHODS) {
    const response = await Proxy.handle(post(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] })), fetchImpl);
    assert.equal(response.status, 200, method + " is allowed");
    assert.ok(Proxy.isAllowedMethod(method));
  }
  const batch = JSON.stringify(Proxy.ALLOWED_METHODS.map((method, id) => ({ jsonrpc: "2.0", id, method, params: [] })));
  assert.equal((await Proxy.handle(post(batch), fetchImpl)).status, 200, "a batch of allowed methods passes whole");
  assert.equal(calls.length, Proxy.ALLOWED_METHODS.length + 1);
  const refused = ["eth_sendTransaction", "eth_sendRawTransaction", "eth_sign", "personal_sign", "eth_getLogs", "eth_newFilter", "eth_getBlockByNumber",
    "eth_gasPrice", "eth_getCode", "debug_traceTransaction", "admin_addPeer", "ETH_CALL", "eth_call ", " eth_call", ""];
  for (const method of refused) {
    const response = await Proxy.handle(post(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] })), fetchImpl);
    assert.equal(response.status, method === "" ? 400 : 403, JSON.stringify(method) + " is refused");
    if (method !== "") {
      const body = JSON.parse(await response.text());
      assert.equal(body.error.code, -32601);
      assert.equal(body.error.message, "method not allowed: " + method);
    }
    assert.equal(Proxy.isAllowedMethod(method), false);
  }
  // One bad entry poisons the whole batch: nothing of it reaches the upstream.
  const mixed = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_chainId" }, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0x00"] }]);
  const poisoned = await Proxy.handle(post(mixed), fetchImpl);
  assert.equal(poisoned.status, 403);
  assert.equal(JSON.parse(await poisoned.text()).error.message, "method not allowed: eth_sendRawTransaction");
  assert.equal(Proxy.firstDisallowedMethod(JSON.parse(mixed)), "eth_sendRawTransaction");
  assert.equal(Proxy.firstDisallowedMethod(JSON.parse(batch)), null);
  assert.equal(calls.length, Proxy.ALLOWED_METHODS.length + 1, "refused requests never reach an upstream");
  // Origin is checked before the method: a remote origin asking for an allowed method is still 403 for its origin.
  const remote = await Proxy.handle(post(BODY, "https://evil.example"), fetchImpl);
  assert.match(JSON.parse(await remote.text()).error.message, /forbidden origin/);
});
