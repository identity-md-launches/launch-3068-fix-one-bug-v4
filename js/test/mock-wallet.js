"use strict";

// Deterministic EIP-1193 test double. Approvals change state only when their receipts are mined.
// This checks client sequencing and failure handling, not the deployed AMM's execution/prices.
const { EventEmitter } = require("node:events");
const { ethers } = require("../vendor/ethers-5.7.2.umd.min.js");
const E = require("../v4-arb-encoder.js");
const abi = ethers.utils.defaultAbiCoder;
const permit = new ethers.utils.Interface([
  "function approve(address token,address spender,uint160 amount,uint48 expiration)",
  "function allowance(address owner,address token,address spender) view returns (uint160,uint48,uint48)",
]);
const erc20 = new ethers.utils.Interface(["function allowance(address owner,address spender) view returns (uint256)"]);
const CALLER = "0xd064E892A3BBb758053922C80098b7f4130444c6";
const OTHER = "0xd7F5739050c65fCe574400F70Bea1Ca63B6b4Bbc"; // existing transaction fixture
const lower = (address) => address.toLowerCase();
const paramsType = "tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)";

class MockWallet extends EventEmitter {
  constructor() {
    super();
    this.account = CALLER;
    this.chain = "0x1237";
    this.now = 1800000000;
    this.calls = [];
    this.sent = [];
    this.pending = new Map();
    this.permits = new Map();
    this.tokenAllowances = new Map([[lower(E.USDG), E.MAX_UINT256], [lower(E.PONS), E.MAX_UINT256]]);
    this.pendingPolls = 1;
    this.failReceipt = 0;
    this.rejectSend = 0;
    this.routerCalls = 0;
    this.failRouterCall = 0;
    this.code = "0x60006000";
  }

  key(owner, token, spender = E.ROUTER) { return [owner, token, spender].map(lower).join(":"); }

  setPermit(token, amount, expiration = this.now + 3600, owner = this.account, spender = E.ROUTER) {
    this.permits.set(this.key(owner, token, spender), [ethers.BigNumber.from(amount), expiration, 0]);
  }

  readPermit(owner, token, spender = E.ROUTER) {
    return this.permits.get(this.key(owner, token, spender)) || [ethers.BigNumber.from(0), 0, 0];
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
      if (this.tokenAllowances.get(lower(currency)).lt(swap[2])) throw new Error("ERC20 allowance missing");
      if (index === 0 && swap[3].gt(ethers.utils.parseUnits("0.01", 18))) throw new Error("V4TooLittleReceived");
      return swap[2];
    });
    return amounts;
  }

  async request(call) {
    this.calls.push(JSON.parse(JSON.stringify(call)));
    if (this.beforeRequest) await this.beforeRequest(call);
    const { method, params = [] } = call;
    if (method === "eth_chainId") return this.chain;
    if (method === "eth_accounts" || method === "eth_requestAccounts") return this.account ? [this.account] : [];
    if (method === "eth_getCode") return this.code;
    if (method === "eth_getBlockByNumber") return { timestamp: ethers.utils.hexValue(this.now) };
    if (method === "eth_call") {
      const tx = params[0];
      if (lower(tx.to) === lower(E.PERMIT2)) {
        const [owner, token, spender] = permit.decodeFunctionData("allowance", tx.data);
        return permit.encodeFunctionResult("allowance", this.readPermit(owner, token, spender));
      }
      if ([E.USDG, E.PONS].map(lower).includes(lower(tx.to))) {
        const [, spender] = erc20.decodeFunctionData("allowance", tx.data);
        if (lower(spender) !== lower(E.PERMIT2)) throw new Error("ERC20 allowance must target Permit2");
        return erc20.encodeFunctionResult("allowance", [this.tokenAllowances.get(lower(tx.to))]);
      }
      if (lower(tx.to) === lower(E.ROUTER)) {
        this.routerCalls++;
        if (this.failRouterCall === this.routerCalls) throw new Error("execution reverted: pool unavailable");
        this.routerCall(tx);
        return "0x";
      }
      throw new Error("Unexpected eth_call destination");
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
      if (!pending.mined && succeeded) {
        const tx = pending.tx;
        if (lower(tx.to) === lower(E.PERMIT2)) {
          const [token, spender, amount, expiration] = permit.decodeFunctionData("approve", tx.data);
          this.setPermit(token, amount, Number(expiration), tx.from, spender);
        } else if (lower(tx.to) === lower(E.ROUTER)) {
          const amounts = this.routerCall(tx);
          [E.USDG, E.PONS].forEach((token, i) => {
            const [amount, expiration] = this.readPermit(tx.from, token);
            this.setPermit(token, amount.sub(amounts[i]), expiration, tx.from);
          });
        } else throw new Error("Unexpected transaction destination");
      }
      pending.mined = true;
      return { transactionHash: params[0], status: succeeded ? "0x1" : "0x0", blockNumber: "0x100" };
    }
    throw new Error("Unexpected RPC method " + method);
  }
}

module.exports = { MockWallet, CALLER, OTHER, permit, erc20, paramsType };
