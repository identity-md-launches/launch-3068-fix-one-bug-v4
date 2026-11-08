/*
 * JSON-RPC proxy Worker for Robinhood Chain (chain id 4663) — follow-up 6.
 *
 * Forwards every POST body (single object or JSON-RPC batch array) unchanged to the primary RPC
 * (Blockmachine). When the primary answers HTTP 429 or 5xx, or the request fails, the SAME body is
 * retried ONCE against the fallback (dRPC) and whichever succeeded is returned. Nothing is cached,
 * rewritten or rate-limited here; the page keeps its own back-off and its sequential fallback.
 *
 * Deploy as a Cloudflare Worker (service-worker syntax: `addEventListener("fetch", ...)`) with
 * `wrangler deploy` from this folder (wrangler.toml beside this file), or run the same `handle`
 * function anywhere a fetch implementation exists. In Node the module exports { handle, ... } for
 * the tests in js/test/worker.test.js; no network is used there.
 *
 * To make the page use it, set RPC_URL in js/v4-arb-encoder.js to the Worker's URL (the page
 * then needs no client-side fallback, though keeping it is harmless).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.RpcProxy = factory();
    if (typeof addEventListener === "function" && typeof Response === "function") {
      addEventListener("fetch", function (event) {
        event.respondWith(root.RpcProxy.handle(event.request, fetch));
      });
    }
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var PRIMARY_URL = "https://rpc-robinhood.blockmachine.io";
  var FALLBACK_URL = "https://robinhood.drpc.org";
  var UPSTREAM_TIMEOUT_MS = 25000;
  var MAX_BODY_BYTES = 1024 * 1024; // a 50000-block batch of two log filters is well under this
  var CORS_HEADERS = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
  };

  /** HTTP statuses that mean "try the other endpoint": rate limit or a server-side failure. */
  function shouldFallBack(status) {
    return status === 429 || (status >= 500 && status <= 599);
  }

  function jsonResponse(status, body, extra) {
    var headers = Object.assign({ "content-type": "application/json" }, CORS_HEADERS, extra || {});
    return new Response(JSON.stringify(body), { status: status, headers: headers });
  }

  /** A JSON-RPC error envelope (id null: the request as a whole), as nodes answer bad input. */
  function rpcErrorResponse(status, code, message) {
    return jsonResponse(status, { jsonrpc: "2.0", id: null, error: { code: code, message: message } });
  }

  /** Every entry of a JSON-RPC request must be an object with a string `method`. */
  function validPayload(payload) {
    var entries = Array.isArray(payload) ? payload : [payload];
    if (Array.isArray(payload) && !payload.length) return false;
    return entries.every(function (entry) {
      return entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.method === "string" && entry.method.length > 0 &&
        (entry.params === undefined || Array.isArray(entry.params) || (entry.params && typeof entry.params === "object"));
    });
  }

  /** POST `body` to `url`; resolves { ok, status, text, upstream } or rejects on a network failure. */
  async function forward(fetchImpl, url, body, timeoutMs) {
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      var response = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: body,
        signal: controller ? controller.signal : undefined,
      });
      if (!response) throw new Error("no response from " + url);
      var text = await response.text();
      return { ok: !!response.ok, status: response.status, text: text, upstream: url };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Primary, then the fallback once on 429 / 5xx / network failure. Returns the reply to relay:
   * { status, text, upstream, fellBack, reason }. When both fail the fallback's answer is relayed
   * (or a 502 with both reasons when neither produced an HTTP reply).
   */
  async function relay(fetchImpl, body, options) {
    options = options || {};
    var primary = options.primaryUrl || PRIMARY_URL;
    var fallback = options.fallbackUrl || FALLBACK_URL;
    var timeoutMs = options.timeoutMs === undefined ? UPSTREAM_TIMEOUT_MS : options.timeoutMs;
    var reason = null;
    try {
      var first = await forward(fetchImpl, primary, body, timeoutMs);
      if (!shouldFallBack(first.status)) return { status: first.status, text: first.text, upstream: primary, fellBack: false, reason: null };
      reason = "primary HTTP " + first.status;
    } catch (error) {
      reason = "primary failed: " + (error && error.message ? error.message : String(error));
    }
    try {
      var second = await forward(fetchImpl, fallback, body, timeoutMs);
      return { status: second.status, text: second.text, upstream: fallback, fellBack: true, reason: reason };
    } catch (error) {
      return { status: 502, text: null, upstream: null, fellBack: true,
        reason: reason + "; fallback failed: " + (error && error.message ? error.message : String(error)) };
    }
  }

  /** The Worker entry point: CORS preflight, POST JSON-RPC only, relay with fallback. */
  async function handle(request, fetchImpl, options) {
    var doFetch = fetchImpl || (typeof fetch === "function" ? fetch : null);
    if (typeof doFetch !== "function") throw new Error("RpcProxy: a fetch implementation is required");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    if (request.method !== "POST") return rpcErrorResponse(405, -32600, "POST a JSON-RPC request");
    var body = await request.text();
    if (body.length > MAX_BODY_BYTES) return rpcErrorResponse(413, -32600, "request body too large");
    var payload;
    try { payload = JSON.parse(body); } catch (error) { return rpcErrorResponse(400, -32700, "parse error"); }
    if (!validPayload(payload)) return rpcErrorResponse(400, -32600, "invalid JSON-RPC request");
    var reply = await relay(doFetch, body, options);
    var headers = Object.assign({ "content-type": "application/json" }, CORS_HEADERS,
      { "x-rpc-upstream": reply.upstream || "none", "x-rpc-fallback": reply.fellBack ? "1" : "0" });
    if (reply.reason) headers["x-rpc-fallback-reason"] = reply.reason;
    if (reply.text === null) return jsonResponse(502, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "both RPC endpoints failed: " + reply.reason } }, headers);
    return new Response(reply.text, { status: reply.status, headers: headers });
  }

  return { PRIMARY_URL: PRIMARY_URL, FALLBACK_URL: FALLBACK_URL, UPSTREAM_TIMEOUT_MS: UPSTREAM_TIMEOUT_MS,
    shouldFallBack: shouldFallBack, validPayload: validPayload, forward: forward, relay: relay, handle: handle };
});
