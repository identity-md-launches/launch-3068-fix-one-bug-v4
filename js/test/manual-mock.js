"use strict";

// Manual-mode test double: V3 pool contracts that answer token0(), token1(), fee() and slot0()
// through eth_call. Built on V3Mock so the manual spread row executes through the same V3
// Router simulation as the auto-scan page. Ticks and fees are fixtures, not chain readings,
// except the two pools named by the brief, whose live replies of 2026-11-07 are reproduced
// in `liveManualMock()`.
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { V3Mock, poolA, poolB } = require("./v3-mock.js");
const abi = ethers.utils.defaultAbiCoder;
const bn = ethers.BigNumber.from;
const lower = (a) => a.toLowerCase();
const SELECTORS = { "0x0dfe1681": "token0", "0xd21220a7": "token1", "0xddca3f43": "fee", "0x3850c7bd": "slot0", "0x1a686502": "liquidity" };
const WETH = ethers.utils.getAddress(E.WETH);
const PONS = ethers.utils.getAddress(E.PONS);
const USDG = ethers.utils.getAddress(E.USDG);
// The brief's test vectors and their live replies (chain 4663, 2026-11-07).
const LIVE_POOL_A = "0x10cc6bd38112cac182db90b6a71d8bb5939526ba"; // fee() = 10000 on chain, not the brief's 100
const LIVE_POOL_B = "0xed50bdeea8adc232f159486192a4157281d722ff"; // fee() = 3000
const LIVE_SLOT0_A = "0x000000000000000000000000000000000000006de19cd729279cd0d3d20effb40000000000000000000000000000000000000000000000000000000000016f280000000000000000000000000000000000000000000000000000000000004d350000000000000000000000000000000000000000000000000000000000004e200000000000000000000000000000000000000000000000000000000000004e2000000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001";
const LIVE_SLOT0_B = "0x000000000000000000000000000000000000006e482fb88f9dc537e6be8af5190000000000000000000000000000000000000000000000000000000000016f710000000000000000000000000000000000000000000000000000000000000cfe0000000000000000000000000000000000000000000000000000000000001c200000000000000000000000000000000000000000000000000000000000001c2000000000000000000000000000000000000000000000000000000000000000660000000000000000000000000000000000000000000000000000000000000001";

/** A pool fixture. `layout` 7 is canonical V3 slot0, 6 is the brief's declared ABI. */
function pool(token0, token1, fee, tick, extra = {}) {
  return { token0, token1, fee, tick, sqrtPriceX96: extra.sqrtPriceX96 === undefined ? bn(2).pow(96) : bn(extra.sqrtPriceX96),
    layout: extra.layout || 7, revert: extra.revert || null, raw: extra.raw || null,
    liquidity: extra.liquidity === undefined ? bn("1000000000000000000") : bn(extra.liquidity) }; // follow-up 6: liquidity()
}

class ManualMock extends V3Mock {
  constructor() {
    super();
    this.manualPools = new Map();
    this.manualCalls = []; // every eth_call to a manual pool: { to, name }
    this.symbolCalls = 0;
    // The default two pools are the V3Mock pools, so the quote / router simulation matches them:
    // PONS/USDG, 0.30% at tick -292916 (cheaper) and 1.00% at tick -292000.
    this.setPool(poolA, pool(PONS, USDG, 3000, -292916));
    this.setPool(poolB, pool(PONS, USDG, 10000, -292000));
  }

  setPool(address, fixture) { this.manualPools.set(lower(address), fixture); }

  slot0Reply(fixture) {
    if (fixture.raw) return fixture.raw;
    if (fixture.layout === 6) {
      return abi.encode(["uint160", "int24", "uint24", "uint24", "uint8", "bool"], [fixture.sqrtPriceX96, fixture.tick, 0, fixture.fee, 60, true]);
    }
    return abi.encode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [fixture.sqrtPriceX96, fixture.tick, 0, 1, 1, 0, true]);
  }

  handle(method, params = []) {
    if (method === "eth_call" && params[0].to && this.manualPools.has(lower(params[0].to))) {
      const tx = params[0];
      const name = SELECTORS[tx.data.slice(0, 10)];
      if (name) {
        const fixture = this.manualPools.get(lower(tx.to));
        this.manualCalls.push({ to: lower(tx.to), name });
        if (fixture.revert === "all" || fixture.revert === name) {
          throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
        }
        if (fixture.revert === "empty") return "0x";
        if (name === "token0") return abi.encode(["address"], [fixture.token0]);
        if (name === "token1") return abi.encode(["address"], [fixture.token1]);
        if (name === "fee") return abi.encode(["uint24"], [fixture.fee]);
        if (name === "liquidity") return abi.encode(["uint128"], [fixture.liquidity]);
        return this.slot0Reply(fixture);
      }
    }
    if (method === "eth_call" && this.tokens.has(lower(params[0].to || "")) && params[0].data.slice(0, 10) === "0x95d89b41") this.symbolCalls++;
    return super.handle(method, params);
  }
}

/** The brief's two pools with their live replies; WETH is token0, PONS token1. */
function liveManualMock() {
  const provider = new ManualMock();
  provider.tokens.set(lower(WETH), ["WETH", 18]);
  provider.setPool(LIVE_POOL_A, pool(WETH, PONS, 10000, 93992, { raw: LIVE_SLOT0_A }));
  provider.setPool(LIVE_POOL_B, pool(WETH, PONS, 3000, 94065, { raw: LIVE_SLOT0_B }));
  return provider;
}

module.exports = { ManualMock, liveManualMock, pool, SELECTORS, WETH, PONS, USDG, LIVE_POOL_A, LIVE_POOL_B, LIVE_SLOT0_A, LIVE_SLOT0_B, poolA, poolB };
