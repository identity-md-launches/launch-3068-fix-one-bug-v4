"use strict";

// Follow-up 6 test double: several pairs of one Token A, V3 pools from a factory map keyed by
// (currency0, currency1, fee) and V4 pools whose liquidity the PoolManager answers through
// extsload at the liquidity slot (slot0 slot + 3). Prices are fixtures, not chain readings.
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { V3Mock } = require("./v3-mock.js");
const abi = ethers.utils.defaultAbiCoder;
const bn = ethers.BigNumber.from;
const lower = (a) => a.toLowerCase();
const factory = new ethers.utils.Interface(["function getPool(address,address,uint24) view returns (address)"]);
const WETH = ethers.utils.getAddress(E.WETH);
const PONS = ethers.utils.getAddress(E.PONS);
const USDG = ethers.utils.getAddress(E.USDG);
// Fixture V3 pools: PONS/USDG 0.30% and 1.00% (from V3Mock) plus WETH/PONS 0.05% and 0.30%.
const WETH_PONS_500 = "0x1111111111111111111111111111111111111111";
const WETH_PONS_3000 = "0x2222222222222222222222222222222222222222";
const WETH_USDG_500 = "0x3333333333333333333333333333333333333333";

class AllPairsMock extends V3Mock {
  constructor() {
    super();
    this.tokens.set(lower(WETH), ["WETH", 18]);
    // (currency0, currency1, fee) → pool address; the V3Mock PONS/USDG pools keep answering through v3Pools.
    this.factoryPools = new Map();
    for (const [fee, address] of this.v3Pools) this.setV3Pool(PONS, USDG, fee, address, this.v3Liquidity.get(lower(address)));
    this.setV3Pool(WETH, PONS, 500, WETH_PONS_500, bn(1000));
    this.setV3Pool(WETH, PONS, 3000, WETH_PONS_3000, bn(2000));
    this.setV3Pool(WETH, USDG, 500, WETH_USDG_500, bn(5000)); // the ETH/USD source of the gas estimate
    // WETH (18 dec) is currency0, USDG (6 dec) currency1: 1.0001^-195310 × 1e12 ≈ 3300 USDG per WETH.
    this.v3Slot0 = new Map([[lower(WETH_USDG_500), { tick: -195310, sqrtPriceX96: bn(2).pow(96) }]]);
    this.v4Liquidity = new Map(); // poolId → liquidity word, answered through extsload
    this.liquiditySlots = new Map(); // storage slot → poolId
    this.getLogsFilters = [];
  }

  setV3Pool(a, b, fee, address, liquidity) {
    const sorted = E.sortPair(a, b);
    this.factoryPools.set([lower(sorted.currency0), lower(sorted.currency1), fee].join(":"), address);
    this.v3Liquidity.set(lower(address), bn(liquidity === undefined ? 1 : liquidity));
  }

  /** A V4 pool of any pair with the given liquidity, discoverable through getLiquidity(poolId). */
  setV4Liquidity(key, liquidity) {
    const id = E.poolId(key);
    this.liquiditySlots.set(E.liquidityStorageSlot(id), id);
    this.v4Liquidity.set(id, ethers.utils.hexZeroPad(bn(liquidity).toHexString(), 32));
    return id;
  }

  poolManagerCall(tx) {
    if (tx.data.slice(0, 10) === "0x1e2eaeaf") {
      const id = this.liquiditySlots.get("0x" + tx.data.slice(10));
      if (id) return this.v4Liquidity.get(id);
    }
    return super.poolManagerCall(tx);
  }

  handle(method, params = []) {
    if (method === "eth_getLogs") {
      this.getLogsFilters.push(JSON.parse(JSON.stringify(params[0])));
      if (!Array.isArray(params[0].address) && lower(params[0].address) === lower(E.POOL_MANAGER) && params[0].topics.length === 1) {
        // The all-pairs V4 filter: topic only, every pool's swaps; the page filters by id.
        const filter = params[0];
        const from = bn(filter.fromBlock).toNumber();
        const to = filter.toBlock === "latest" ? this.block : bn(filter.toBlock).toNumber();
        return this.logs.filter((log) => { const b = bn(log.blockNumber).toNumber(); return b >= from && b <= to; });
      }
    }
    if (method === "eth_call") {
      const tx = params[0];
      if (tx.to && lower(tx.to) === lower(E.V3_FACTORY)) {
        const [a, b, fee] = factory.decodeFunctionData("getPool", tx.data);
        const address = this.factoryPools.get([lower(a), lower(b), Number(fee)].join(":"));
        return abi.encode(["address"], [address || ethers.constants.AddressZero]);
      }
      if (tx.to && this.v3Slot0.has(lower(tx.to)) && tx.data === "0x3850c7bd") {
        const s = this.v3Slot0.get(lower(tx.to));
        return abi.encode(["uint160", "int24", "uint16", "uint16", "uint16", "uint8", "bool"], [s.sqrtPriceX96, s.tick, 0, 1, 1, 0, true]);
      }
    }
    return super.handle(method, params);
  }
}

module.exports = { AllPairsMock, WETH, PONS, USDG, WETH_PONS_500, WETH_PONS_3000, WETH_USDG_500 };
