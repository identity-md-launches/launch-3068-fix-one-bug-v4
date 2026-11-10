"use strict";

// Deterministic EIP-1193 test double. Approvals change state only when their receipts are mined.
// This checks client sequencing and failure handling, not the deployed AMM's execution/prices.
// The same object also answers the page's direct JSON-RPC traffic through `fetch()`, so one
// state (balances, logs, allowances) backs both the wallet and the public RPC in the tests.
const { EventEmitter } = require("node:events");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const abi = ethers.utils.defaultAbiCoder;
const permit = new ethers.utils.Interface([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address owner,address token,address spender) view returns (uint160,uint48,uint48)",
]);
const erc20 = new ethers.utils.Interface([
  "function allowance(address owner,address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address to,uint256 amount) returns (bool)",
]);
const CALLER = "0xd064E892A3BBb758053922C80098b7f4130444c6";
const OTHER = "0xd7F5739050c65fCe574400F70Bea1Ca63B6b4Bbc"; // existing transaction fixture
const lower = (address) => address.toLowerCase();
const paramsType = "tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)";
// Prices observed on the live router on 2026-11-07 (amountOut * 1e36 / amountIn for 0.01 USDG → PONS).
const LIVE_PRICE_X36 = {
  "3000/60": ethers.BigNumber.from("5235867312106401500000000000000000000000000000000"),
  "2500/25": ethers.BigNumber.from("5230904955821507700000000000000000000000000000000"),
  "30000/600": ethers.BigNumber.from(0), // exists, no liquidity
};

class MockWallet extends EventEmitter {
  constructor() {
    super();
    this.account = CALLER;
    this.chain = "0x1237";
    this.now = 1800000000;
    this.block = 108394834;
    this.calls = [];
    this.rpcCalls = [];
    this.httpCalls = [];
    this.sent = [];
    this.pending = new Map();
    this.permits = new Map();
    this.tokenAllowances = new Map([[lower(E.USDG), E.MAX_UINT256], [lower(E.PONS), E.MAX_UINT256]]);
    this.spenderAllowances = new Map(); // owner:token:spender → ERC20 allowance to spenders other than Permit2
    this.tokens = new Map([[lower(E.PONS), ["PONS", 18]], [lower(E.USDG), ["USDG", 6]]]);
    this.balances = new Map([
      [this.key(CALLER, E.PONS, "bal"), ethers.utils.parseUnits("1.5", 18)],
      [this.key(CALLER, E.USDG, "bal"), ethers.utils.parseUnits("25", 6)],
    ]);
    this.ethBalances = new Map([[lower(CALLER), ethers.utils.parseEther("0.2")]]);
    this.gasPrice = ethers.BigNumber.from(20102000);
    this.gasEstimate = ethers.BigNumber.from(21000);
    this.logs = [];
    this.quotes = new Map(); // poolId -> priceX36; pools absent here are "not initialised"
    for (const [tier, price] of Object.entries(LIVE_PRICE_X36)) {
      const [fee, tickSpacing] = tier.split("/").map(Number);
      this.quotes.set(E.poolId({ currency0: E.PONS, currency1: E.USDG, fee, tickSpacing, hooks: E.NO_HOOKS }), price);
    }
    this.blockTimes = new Map(); // block number -> timestamp; other blocks are 0.1 s apart back from `now`
    this.slot0Words = new Map(); // poolId -> Slot0 word; a pool with a swap log is initialised by default
    this.slot0Slots = new Map(); // storage slot -> poolId, as extsload sees it
    this.slot0Fail = new Set(); // poolIds whose slot0 read fails
    this.blockFail = new Set(); // historic block numbers whose read fails
    this.pendingPolls = 1;
    this.failReceipt = 0;
    this.rejectSend = 0;
    this.routerCalls = 0;
    this.failRouterCall = 0;
    this.rpcFailures = 0; // the next N direct-RPC requests fail (rate limit / outage)
    this.httpFailures = 0; // the next N direct-RPC requests answer HTTP 429
    this.code = "0x60006000";
    this.fetch = this.fetch.bind(this);
  }

  key(owner, token, spender = E.ROUTER) { return [owner, token, spender].map(lower).join(":"); }

  setPermit(token, amount, expiration = this.now + 3600, owner = this.account, spender = E.ROUTER) {
    this.permits.set(this.key(owner, token, spender), [ethers.BigNumber.from(amount), expiration, 0]);
  }

  readPermit(owner, token, spender = E.ROUTER) {
    return this.permits.get(this.key(owner, token, spender)) || [ethers.BigNumber.from(0), 0, 0];
  }

  balance(owner, token) { return this.balances.get(this.key(owner, token, "bal")) || ethers.BigNumber.from(0); }
  setBalance(owner, token, amount) { this.balances.set(this.key(owner, token, "bal"), ethers.BigNumber.from(amount)); }
  ethBalance(owner) { return this.ethBalances.get(lower(owner)) || ethers.BigNumber.from(0); }

  /** Append a PoolManager Swap log for a pool of the PONS/USDG pair (or any key) at a block. */
  addSwap(fee, tickSpacing, tick, blockNumber = this.block, extra = {}) {
    const key = { currency0: extra.currency0 || E.PONS, currency1: extra.currency1 || E.USDG, fee, tickSpacing, hooks: E.NO_HOOKS };
    const data = abi.encode(["int128", "int128", "uint160", "uint128", "int24", "uint24"],
      [-1000, 1000, 0, 0, tick, fee]);
    const log = { address: lower(E.POOL_MANAGER), topics: [E.SWAP_TOPIC, E.poolId(key)], data,
      blockNumber: ethers.utils.hexValue(blockNumber), logIndex: ethers.utils.hexValue(this.logs.length) };
    this.logs.push(log);
    this.slot0Slots.set(E.slot0StorageSlot(E.poolId(key)), E.poolId(key));
    if (extra.ageSeconds !== undefined) this.blockTimes.set(blockNumber, this.now - extra.ageSeconds);
    return log;
  }

  /** Set a pool's Slot0 word, as the PoolManager's extsload would return it. */
  setSlot0(id, word) {
    this.slot0Slots.set(E.slot0StorageSlot(id), id);
    this.slot0Words.set(id, word);
  }

  /** A real block answers with number and timestamp; a block past the head answers null. */
  blockByNumber(tag) {
    if (tag === "latest") return { timestamp: ethers.utils.hexValue(this.now), number: ethers.utils.hexValue(this.block) };
    const number = ethers.BigNumber.from(tag).toNumber();
    if (this.blockFail.has(number)) throw new Error("block read failed");
    if (number > this.block) return null;
    const timestamp = this.blockTimes.has(number) ? this.blockTimes.get(number) : this.now - Math.floor((this.block - number) / 10);
    return { timestamp: ethers.utils.hexValue(timestamp), number: ethers.utils.hexValue(number) };
  }

  /** PoolManager.extsload(slot). Like the live contract it has no getSlot0(bytes32). */
  poolManagerCall(tx) {
    if (tx.data.slice(0, 10) !== "0x1e2eaeaf") throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
    const id = this.slot0Slots.get("0x" + tx.data.slice(10));
    if (id && this.slot0Fail.has(id)) throw new Error("slot0 node timeout");
    if (id && this.slot0Words.has(id)) return this.slot0Words.get(id);
    // Initialised at tick -292984 with fee 3000, the 3000/60 pool's live word on 2026-11-07.
    return id ? "0x000000000bb81f41f4fb878800000000000000000000074b56c05cb633d71d40" : ethers.constants.HashZero;
  }

  /** A quote-style router call (one command, minHopPriceX36 = max) reverts with the pool's price. */
  quoteCall(tx) {
    const [commands, inputs] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + tx.data.slice(10));
    if (commands !== "0x10") return false;
    const [, params] = abi.decode(["bytes", "bytes[]"], inputs[0]);
    const swap = abi.decode([paramsType], params[0])[0];
    if (!swap[4].eq(ethers.constants.MaxUint256)) return false;
    const id = E.poolId({ currency0: swap[0][0], currency1: swap[0][1], fee: swap[0][2], tickSpacing: swap[0][3], hooks: swap[0][4] });
    if (!this.quotes.has(id)) {
      throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x486aa307" }); // PoolNotInitialized()
    }
    const data = E.QUOTE_REVERT_SELECTOR + abi.encode(["uint256", "uint256"], [ethers.constants.MaxUint256, this.quotes.get(id)]).slice(2);
    throw Object.assign(new Error("execution reverted"), { code: 3, data });
  }

  routerCall(tx) {
    const [commands, inputs, deadline] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + tx.data.slice(10));
    if (tx.data.slice(0, 10) !== "0x3593564c" || commands !== "0x1010" || deadline.lt(this.now)) {
      throw new Error("Bad execute calldata or expired deadline");
    }
    const amounts = inputs.map((input, index) => {
      const [actions, params] = abi.decode(["bytes", "bytes[]"], input);
      if (actions !== "0x060c0e") throw new Error("Wrong swap actions");
      const swap = abi.decode([paramsType], params[0])[0];
      const [currency, max] = abi.decode(["address", "uint256"], params[1]);
      const [, recipient] = abi.decode(["address", "address", "uint256"], params[2]);
      if (lower(recipient) !== lower(tx.from) || max.lt(swap[2])) throw new Error("Wrong recipient/settlement");
      const [amount, expiration] = this.readPermit(tx.from, currency);
      if (amount.lt(swap[2]) || expiration < this.now) throw new Error("Permit2 allowance missing or expired");
      if ((this.tokenAllowances.get(lower(currency)) || ethers.BigNumber.from(0)).lt(swap[2])) throw new Error("ERC20 allowance missing");
      if (index === 0 && swap[3].gt(ethers.utils.parseUnits("0.1", 18))) throw new Error("V4TooLittleReceived");
      return { amount: swap[2], currency };
    });
    return amounts;
  }

  /** Shared JSON-RPC semantics for the wallet provider and the direct RPC. */
  handle(method, params = []) {
    if (method === "eth_chainId") return this.chain;
    if (method === "eth_accounts" || method === "eth_requestAccounts") return this.account ? [this.account] : [];
    if (method === "eth_getCode") return this.code;
    if (method === "eth_getBlockByNumber") return this.blockByNumber(params[0]);
    if (method === "eth_blockNumber") return ethers.utils.hexValue(this.block);
    if (method === "eth_gasPrice") return this.gasPrice.toHexString();
    if (method === "eth_estimateGas") return this.gasEstimate.toHexString();
    if (method === "eth_getBalance") return this.ethBalance(params[0]).toHexString();
    if (method === "eth_getLogs") {
      const filter = params[0];
      const from = ethers.BigNumber.from(filter.fromBlock).toNumber();
      const to = filter.toBlock === "latest" ? this.block : ethers.BigNumber.from(filter.toBlock).toNumber();
      if (to - from + 1 > 50000) throw new Error("block range too large");
      const [topic0, topic1] = filter.topics;
      return this.logs.filter((log) => {
        const block = ethers.BigNumber.from(log.blockNumber).toNumber();
        if (lower(log.address) !== lower(filter.address) || block < from || block > to) return false;
        if (topic0 && log.topics[0] !== topic0) return false;
        if (topic1) return (Array.isArray(topic1) ? topic1 : [topic1]).map(lower).includes(lower(log.topics[1]));
        return true;
      });
    }
    if (method === "eth_call") {
      const tx = params[0];
      // The page now defaults to Both. Legacy V4 fixtures have no V3 pools.
      if (tx.to && lower(tx.to) === lower(E.V3_FACTORY)) return abi.encode(["address"], [ethers.constants.AddressZero]);
      if (lower(tx.to) === lower(E.POOL_MANAGER)) return this.poolManagerCall(tx);
      if (lower(tx.to) === lower(E.PERMIT2)) {
        const [owner, token, spender] = permit.decodeFunctionData("allowance", tx.data);
        return permit.encodeFunctionResult("allowance", this.readPermit(owner, token, spender));
      }
      if (this.tokens.has(lower(tx.to))) {
        const selector = tx.data.slice(0, 10);
        if (selector === erc20.getSighash("symbol")) return erc20.encodeFunctionResult("symbol", [this.tokens.get(lower(tx.to))[0]]);
        if (selector === erc20.getSighash("decimals")) return erc20.encodeFunctionResult("decimals", [this.tokens.get(lower(tx.to))[1]]);
        if (selector === erc20.getSighash("balanceOf")) {
          const [owner] = erc20.decodeFunctionData("balanceOf", tx.data);
          return erc20.encodeFunctionResult("balanceOf", [this.balance(owner, tx.to)]);
        }
        if (selector === erc20.getSighash("transfer")) {
          const [, amount] = erc20.decodeFunctionData("transfer", tx.data);
          if (this.balance(tx.from, tx.to).lt(amount)) throw new Error("execution reverted: ERC20: transfer amount exceeds balance");
          return erc20.encodeFunctionResult("transfer", [true]);
        }
        const [owner, spender] = erc20.decodeFunctionData("allowance", tx.data);
        // Layer 1 (token → Permit2) is `tokenAllowances`; any other spender (job 8 REVOKE ALL reads the V4
        // PoolManager too) answers from `spenderAllowances`, 0 unless a test sets it.
        if (lower(spender) !== lower(E.PERMIT2)) {
          return erc20.encodeFunctionResult("allowance", [this.spenderAllowances.get(this.key(owner, tx.to, spender)) || ethers.BigNumber.from(0)]);
        }
        return erc20.encodeFunctionResult("allowance", [this.tokenAllowances.get(lower(tx.to)) || ethers.BigNumber.from(0)]);
      }
      if (lower(tx.to) === lower(E.ROUTER)) {
        if (this.quoteCall(tx)) return "0x";
        this.routerCalls++;
        if (this.failRouterCall === this.routerCalls) throw new Error("execution reverted: pool unavailable");
        this.routerCall(tx);
        return "0x";
      }
      // Job 9: tests register extra contracts (the cross-DEX factories and pools) by address.
      if (this.contracts && this.contracts.has(lower(tx.to))) return this.contracts.get(lower(tx.to))(tx);
      throw new Error("execution reverted"); // no code / not a token
    }
    if (method === "eth_sendTransaction") {
      const index = this.sent.length + 1;
      if (this.rejectSend === index) throw Object.assign(new Error("User rejected request"), { code: 4001 });
      const hash = ethers.utils.hexZeroPad(ethers.utils.hexlify(index), 32);
      const tx = JSON.parse(JSON.stringify(params[0]));
      this.sent.push(tx);
      this.pending.set(hash, { tx, index, polls: this.pendingPolls, mined: false });
      return hash;
    }
    if (method === "eth_getTransactionReceipt") {
      if (this.neverMine) return null;
      const pending = this.pending.get(params[0]);
      if (!pending || pending.polls-- > 0) return null;
      const succeeded = this.failReceipt !== pending.index;
      if (!pending.mined && succeeded) this.mine(pending.tx);
      pending.mined = true;
      return { transactionHash: params[0], status: succeeded ? "0x1" : "0x0", blockNumber: ethers.utils.hexValue(this.block) };
    }
    throw new Error("Unexpected RPC method " + method);
  }

  /** State transition of a mined transaction. */
  mine(tx) {
    if (lower(tx.to) === lower(E.PERMIT2)) {
      const [token, spender, amount, expiration] = permit.decodeFunctionData("approve", tx.data);
      this.setPermit(token, amount, Number(expiration), tx.from, spender);
    } else if (lower(tx.to) === lower(E.ROUTER)) {
      const amounts = this.routerCall(tx);
      for (const { amount, currency } of amounts) {
        const [allowed, expiration] = this.readPermit(tx.from, currency);
        this.setPermit(currency, allowed.sub(amount), expiration, tx.from);
      }
      this.setBalance(tx.from, amounts[0].currency, this.balance(tx.from, amounts[0].currency).sub(amounts[0].amount));
    } else if (this.tokens.has(lower(tx.to))) {
      const [to, amount] = erc20.decodeFunctionData("transfer", tx.data);
      if (this.balance(tx.from, tx.to).lt(amount)) throw new Error("ERC20 transfer exceeds balance");
      this.setBalance(tx.from, tx.to, this.balance(tx.from, tx.to).sub(amount));
      this.setBalance(to, tx.to, this.balance(to, tx.to).add(amount));
    } else if (tx.value && !ethers.BigNumber.from(tx.value).isZero()) {
      const value = ethers.BigNumber.from(tx.value);
      const fee = ethers.BigNumber.from(tx.gas || this.gasEstimate).mul(ethers.BigNumber.from(tx.gasPrice || this.gasPrice));
      if (this.ethBalance(tx.from).lt(value.add(fee))) throw new Error("insufficient funds for value + gas");
      this.ethBalances.set(lower(tx.from), this.ethBalance(tx.from).sub(value).sub(fee));
      this.ethBalances.set(lower(tx.to), this.ethBalance(tx.to).add(value));
    } else throw new Error("Unexpected transaction destination");
  }

  /** The EIP-1193 provider surface. */
  async request(call) {
    this.calls.push(JSON.parse(JSON.stringify(call)));
    if (this.beforeRequest) await this.beforeRequest(call);
    return this.handle(call.method, call.params || []);
  }

  /** The direct JSON-RPC surface the page's `fetch` uses. Only POST JSON-RPC to the RPC URL is answered. */
  async fetch(url, init) {
    const body = JSON.parse(init.body);
    this.httpCalls.push({ url, body });
    const calls = Array.isArray(body) ? body : [body];
    this.rpcCalls.push(...calls.map(call => ({ url, ...call })));
    if (url !== E.RPC_URL) return { ok: false, status: 404, json: async () => ({}) };
    if (this.httpFailures > 0) { this.httpFailures--; return { ok: false, status: 429, json: async () => ({}) }; }
    const fail = this.rpcFailures > 0;
    if (fail) this.rpcFailures--;
    const replies = await Promise.all(calls.map(async call => {
      if (this.beforeRpc) await this.beforeRpc(call);
      const reply = payload => ({ jsonrpc: "2.0", id: call.id, ...payload });
      if (fail) return reply({ error: { code: -32005, message: "rate limited" } });
      try { return reply({ result: this.handle(call.method, call.params || []) }); }
      catch (error) {
        return reply({ error: { code: error.code === undefined ? -32000 : error.code, message: error.message, data: error.data } });
      }
    }));
    // The protocol allows responses in any order. Exercise id matching in every monitor/UI test.
    return { ok: true, status: 200, json: async () => Array.isArray(body) ? replies.reverse() : replies[0] };
  }
}

module.exports = { MockWallet, CALLER, OTHER, permit, erc20, paramsType, LIVE_PRICE_X36 };
