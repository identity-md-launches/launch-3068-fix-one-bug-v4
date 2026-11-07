"use strict";

// Deterministic protocol simulator. Prices below are artificial test fixtures, not chain quotes.
const assert = require("node:assert/strict");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const { MockWallet, CALLER, OTHER, erc20 } = require("./mock-wallet.js");
const abi = ethers.utils.defaultAbiCoder;
const bn = ethers.BigNumber.from;
const lower = (a) => a.toLowerCase();
const factory = new ethers.utils.Interface(["function getPool(address,address,uint24) view returns (address)"]);
const v3 = new ethers.utils.Interface([
  "function exactInput(tuple(bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum)) returns (uint256)",
  "function multicall(uint256,bytes[]) returns (bytes[])",
]);
const token = new ethers.utils.Interface(["function approve(address,uint256) returns (bool)"]);
const poolA = "0x0652d61511f3A96B8721bE6825680F5954D9BAF3";
const poolB = "0x7A192E71564ec66eE0763e328a3Ac274942dE4e1";

function decodePath(path) {
  const bytes = path.slice(2);
  assert.ok((bytes.length - 40) % 46 === 0, "packed V3 path length");
  const tokens = [ethers.utils.getAddress("0x" + bytes.slice(0, 40))];
  const fees = [];
  for (let i = 40; i < bytes.length; i += 46) {
    fees.push(parseInt(bytes.slice(i, i + 6), 16));
    tokens.push(ethers.utils.getAddress("0x" + bytes.slice(i + 6, i + 46)));
  }
  return { tokens, fees };
}

class V3Mock extends MockWallet {
  constructor() {
    super();
    this.v3Pools = new Map([[3000, poolA], [10000, poolB]]);
    this.v3Allowances = new Map();
    this.v3Liquidity = new Map([[lower(poolA), bn(100)], [lower(poolB), bn(200)]]);
    this.liquidityFailures = new Set();
    this.v3Logs = [];
    this.quoteZero = false;
    this.quoteFailure = false;
    this.quotePartial = false;
    this.badQuoteReply = false;
    this.failSimulation = false;
    this.approveFalse = false;
    this.skipBridgeCredit = false;
  }

  row(fee = 3000) {
    return { protocol: "V3", address: this.v3Pools.get(fee), poolId: lower(this.v3Pools.get(fee)),
      fee, currency0: ethers.utils.getAddress(E.PONS), currency1: E.USDG, active: true, status: "OK",
      price: E.tickToPrice(fee === 3000 ? -292916 : -292000), empty: false, elapsedSeconds: 0 };
  }

  addV3Swap(fee, tick, block = this.block, ageSeconds = 0) {
    const log = { address: this.v3Pools.get(fee), topics: [E.V3_SWAP_TOPIC,
      ethers.utils.hexZeroPad(CALLER, 32), ethers.utils.hexZeroPad(OTHER, 32)],
    data: abi.encode(["int256", "int256", "uint160", "uint128", "int24"], [100, -200, bn(2).pow(96), 1, tick]),
    blockNumber: ethers.utils.hexValue(block), logIndex: ethers.utils.hexValue(this.v3Logs.length) };
    this.v3Logs.push(log);
    this.blockTimes.set(block, this.now - ageSeconds);
    return log;
  }

  allowance(tokenAddress, owner = CALLER) { return this.v3Allowances.get(this.key(owner, tokenAddress, E.V3_ROUTER)) || bn(0); }
  setAllowance(tokenAddress, amount, owner = CALLER) { this.v3Allowances.set(this.key(owner, tokenAddress, E.V3_ROUTER), bn(amount)); }

  // 1 USDG -> 5 PONS, then 1 PONS -> .22 USDG: a deterministic profitable route.
  output(tokenIn, amount) { return lower(tokenIn) === lower(E.USDG) ? bn(amount).mul("5000000000000") : bn(amount).mul(22).div("100000000000000"); }

  quoteCall(tx) {
    const [commands, inputs] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + tx.data.slice(10));
    if (commands !== "0x10") return false;
    const [, params] = abi.decode(["bytes", "bytes[]"], inputs[0]);
    const [swap] = abi.decode(["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"], params[0]);
    if (!swap[4].eq(E.MAX_UINT256)) return false;
    const input = swap[1] ? swap[0][0] : swap[0][1];
    const price = this.output(input, swap[2]).mul(bn(10).pow(36)).div(swap[2]);
    throw Object.assign(new Error("execution reverted"), { code: 3,
      data: E.QUOTE_REVERT_SELECTOR + abi.encode(["uint256", "uint256"], [E.MAX_UINT256, price]).slice(2) });
  }

  decodeV3(tx) {
    const [deadline, calls] = v3.decodeFunctionData("multicall", tx.data);
    assert.equal(calls.length, 1);
    if (deadline.lt(this.now)) throw new Error("deadline expired");
    const [params] = v3.decodeFunctionData("exactInput", calls[0]);
    const path = decodePath(params.path);
    assert.equal(lower(params.recipient), lower(tx.from));
    if (this.allowance(path.tokens[0], tx.from).lt(params.amountIn)) throw new Error("V3 allowance missing");
    if (this.balance(tx.from, path.tokens[0]).lt(params.amountIn)) throw new Error("V3 balance too low");
    let output = params.amountIn;
    path.fees.forEach((fee, i) => { assert.ok(this.v3Pools.has(fee)); output = this.output(path.tokens[i], output); });
    if (output.lt(params.amountOutMinimum)) throw new Error("Too little received");
    return { tokenIn: path.tokens[0], tokenOut: path.tokens.at(-1), input: params.amountIn, output };
  }

  decodeV4Single(tx) {
    const [commands, inputs, deadline] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + tx.data.slice(10));
    if (commands !== "0x10") return null;
    const [actions, params] = abi.decode(["bytes", "bytes[]"], inputs[0]);
    assert.equal(actions, "0x060c0e");
    const [swap] = abi.decode(["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)"], params[0]);
    if (swap[4].eq(E.MAX_UINT256)) return null; // existing V4 quote
    const tokenIn = swap[1] ? swap[0][0] : swap[0][1];
    const tokenOut = swap[1] ? swap[0][1] : swap[0][0];
    const [, recipient] = abi.decode(["address", "address", "uint256"], params[2]);
    assert.equal(lower(recipient), lower(tx.from));
    const [allowed, expiry] = this.readPermit(tx.from, tokenIn);
    if (allowed.lt(swap[2]) || expiry < deadline.toNumber() || deadline.lt(this.now)) throw new Error("Permit2 allowance missing or expired");
    if (this.balance(tx.from, tokenIn).lt(swap[2])) throw new Error("V4 balance too low");
    const output = this.output(tokenIn, swap[2]);
    if (output.lt(swap[3])) throw new Error("V4 minimum output not met");
    return { tokenIn, tokenOut, input: swap[2], output };
  }

  handle(method, params = []) {
    if (method === "eth_getLogs" && Array.isArray(params[0].address)) {
      const filter = params[0];
      assert.equal(filter.topics[0], E.V3_SWAP_TOPIC);
      assert.ok(filter.address.length > 0);
      return this.v3Logs.filter(l => filter.address.map(lower).includes(lower(l.address)) &&
        bn(l.blockNumber).gte(filter.fromBlock) && bn(l.blockNumber).lte(filter.toBlock));
    }
    if (method === "eth_call") {
      const tx = params[0];
      if (!tx.to) {
        if (this.quoteFailure) throw new Error("quote RPC unavailable");
        if (this.badQuoteReply) return "0x";
        const [inputToken, , , amount] = abi.decode(["address", "address", "uint24", "uint128"], "0x" + tx.data.slice(-256));
        const used = this.quotePartial ? amount.div(2) : amount;
        const output = this.quoteZero ? bn(0) : this.output(inputToken, amount);
        throw Object.assign(new Error("execution reverted"), { code: 3,
          data: ethers.utils.id("V3QuoteResult(uint256,uint256)").slice(0, 10) + abi.encode(["uint256", "uint256"], [used, output]).slice(2) });
      }
      if (lower(tx.to) === lower(E.V3_FACTORY)) {
        const [a, b, fee] = factory.decodeFunctionData("getPool", tx.data);
        assert.ok(BigInt(a) < BigInt(b));
        const samePair = lower(a) === lower(E.PONS) && lower(b) === lower(E.USDG);
        return abi.encode(["address"], [samePair && this.v3Pools.get(fee) || ethers.constants.AddressZero]);
      }
      if (this.v3Liquidity.has(lower(tx.to))) {
        if (this.liquidityFailures.has(lower(tx.to))) throw new Error("liquidity RPC failed");
        assert.equal(tx.data, "0x1a686502");
        return abi.encode(["uint128"], [this.v3Liquidity.get(lower(tx.to))]);
      }
      if (lower(tx.to) === lower(E.V3_ROUTER)) {
        if (this.failSimulation) throw new Error("V3 simulation failed");
        return v3.encodeFunctionResult("multicall", [[abi.encode(["uint256"], [this.decodeV3(tx).output])]]);
      }
      if (this.tokens.has(lower(tx.to))) {
        if (tx.data.slice(0, 10) === token.getSighash("approve")) {
          const [spender] = token.decodeFunctionData("approve", tx.data);
          assert.equal(lower(spender), lower(E.V3_ROUTER));
          return token.encodeFunctionResult("approve", [!this.approveFalse]);
        }
        if (tx.data.slice(0, 10) === erc20.getSighash("allowance")) {
          const [owner, spender] = erc20.decodeFunctionData("allowance", tx.data);
          if (lower(spender) === lower(E.V3_ROUTER)) return erc20.encodeFunctionResult("allowance", [this.allowance(tx.to, owner)]);
        }
      }
      if (lower(tx.to) === lower(E.ROUTER) && this.decodeV4Single(tx)) {
        if (this.failSimulation) throw new Error("V4 simulation failed");
        return "0x";
      }
    }
    return super.handle(method, params);
  }

  mine(tx) {
    if (this.tokens.has(lower(tx.to)) && tx.data.slice(0, 10) === token.getSighash("approve")) {
      const [, amount] = token.decodeFunctionData("approve", tx.data);
      this.setAllowance(tx.to, amount, tx.from);
      return;
    }
    const v3Swap = lower(tx.to) === lower(E.V3_ROUTER);
    const swap = v3Swap ? this.decodeV3(tx) : lower(tx.to) === lower(E.ROUTER) ? this.decodeV4Single(tx) : null;
    if (!swap) return super.mine(tx);
    this.setBalance(tx.from, swap.tokenIn, this.balance(tx.from, swap.tokenIn).sub(swap.input));
    if (!this.skipBridgeCredit) this.setBalance(tx.from, swap.tokenOut, this.balance(tx.from, swap.tokenOut).add(swap.output));
    if (v3Swap) this.setAllowance(swap.tokenIn, this.allowance(swap.tokenIn, tx.from).sub(swap.input), tx.from);
    else {
      const [amount, expiry] = this.readPermit(tx.from, swap.tokenIn);
      this.setPermit(swap.tokenIn, amount.sub(swap.input), expiry, tx.from);
    }
    if (this.afterSwap) this.afterSwap(tx);
  }
}

function route(provider, buy = provider.row(3000), sell = provider.row(10000)) {
  return { buy, sell, buyPool: buy.poolKey, sellPool: sell.poolKey, usdgIn: bn(10000),
    ponsAmount: bn("49750000000000000"), minUsdgOut: bn(10890),
    pair: { currency0: E.PONS, currency1: E.USDG, symbol0: "PONS", symbol1: "USDG" } };
}

function v4Row(fee = 3000, tickSpacing = 60) {
  const poolKey = { currency0: E.PONS, currency1: E.USDG, fee, tickSpacing, hooks: E.NO_HOOKS };
  return { protocol: "V4", poolKey, poolId: E.poolId(poolKey), fee, tickSpacing };
}

module.exports = { V3Mock, route, v4Row, factory, v3, token, poolA, poolB, decodePath };
