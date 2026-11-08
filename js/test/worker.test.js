"use strict";

// Follow-up 6: the JSON-RPC proxy Worker, offline. `handle` runs with a fake fetch; nothing leaves the process.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Proxy = require("../../worker/rpc-proxy.js");

const BODY = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
const BATCH = JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }, { jsonrpc: "2.0", id: 2, method: "eth_gasPrice" }]);
const OK = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1237" });

function post(body) { return new Request("https://proxy.example/", { method: "POST", body, headers: { "content-type": "application/json" } }); }

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
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
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
  const preflight = await Proxy.handle(new Request("https://proxy.example/", { method: "OPTIONS" }), fetchImpl);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST, OPTIONS");
  const get = await Proxy.handle(new Request("https://proxy.example/", { method: "GET" }), fetchImpl);
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
