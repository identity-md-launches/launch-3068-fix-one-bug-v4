/*
 * Offline test of js/v4-arb-encoder.js. Run from the repository root:
 *
 *     node js/test/encoder.test.js
 *
 * It needs no network and no install: ethers v5 is the vendored build in js/vendor, and the
 * expected bytes are the fixtures in test/Vectors.sol, which the Foundry tests also check.
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

// Resolve require("ethers") to the vendored ethers 5.7.2 build.
const vendoredEthers = path.resolve(__dirname, "../vendor/ethers-5.7.2.umd.min.js");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "ethers" ? vendoredEthers : resolve.call(this, request, ...rest);
};

const { ethers } = require("ethers");
const E = require("../v4-arb-encoder.js");

const abi = ethers.utils.defaultAbiCoder;
const vectors = {};
const source = fs.readFileSync(path.resolve(__dirname, "../../test/Vectors.sol"), "utf8");
for (const match of source.matchAll(/bytes internal constant (\w+) =\s*hex"([0-9a-f]*)";/g)) {
  vectors[match[1]] = "0x" + match[2];
}
for (const name of ["SUCCESS_TX_INPUT", "FAILED_TX_INPUT", "JS_TWO_COMMAND", "JS_ATOMIC"]) {
  assert.ok(vectors[name], "fixture " + name + " is missing from test/Vectors.sol");
}

const CALLER = "0xd064E892A3BBb758053922C80098b7f4130444c6"; // sender of the failed transaction
const PONS_BRIDGE = "51690143190364074";

function decodeExecute(data) {
  assert.strictEqual(data.slice(0, 10), E.EXECUTE_SELECTOR);
  const [commands, inputs, deadline] = abi.decode(["bytes", "bytes[]", "uint256"], "0x" + data.slice(10));
  return {
    commands,
    deadline,
    inputs: inputs.map((input) => {
      const [actions, params] = abi.decode(["bytes", "bytes[]"], input);
      return { actions, params };
    }),
  };
}
const words = (hex) => ethers.utils.hexDataLength(hex) / 32;
const word = (hex, index) => "0x" + hex.slice(2 + 64 * index, 66 + 64 * index);

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("ethers is v5", () => {
  assert.ok(ethers.version.startsWith("ethers/5."), ethers.version);
});

test("reproduces the successful transaction's input byte for byte", () => {
  const input = E.encodeV4Swap({
    poolKey: {
      currency0: ethers.constants.AddressZero, // native currency
      currency1: "0x36c2861a1f94c6f277a388338a4f8a686e0d9b30",
      fee: 0,
      tickSpacing: 60,
      hooks: E.NO_HOOKS,
    },
    zeroForOne: false,
    amountIn: "0xc6e4d2fb9176784bfab",
    amountOutMinimum: "0x1f6f6d1cb16ad98",
    recipient: "0xd7f5739050c65fce574400f70bea1ca63b6b4bbc",
  });
  assert.strictEqual(E.encodeExecute("0x10", [input], E.MAX_UINT256), vectors.SUCCESS_TX_INPUT);
});

test("the failed transaction has the three shape defects, the successful one has none", () => {
  const ok = decodeExecute(vectors.SUCCESS_TX_INPUT);
  const bad = decodeExecute(vectors.FAILED_TX_INPUT);
  assert.strictEqual(ok.commands, "0x10");
  assert.strictEqual(bad.commands, "0x1010");
  assert.strictEqual(ok.inputs[0].actions, "0x060c0e");
  assert.deepStrictEqual(ok.inputs[0].params.map(words), [12, 2, 3]);
  assert.strictEqual(ethers.BigNumber.from(word(ok.inputs[0].params[0], 0)).toNumber(), 0x20);
  for (const input of bad.inputs) {
    assert.strictEqual(input.actions, "0x060c0e");
    assert.deepStrictEqual(input.params.map(words), [10, 2, 2]);
    // The first word is currency0, where the router expects the struct's offset.
    assert.strictEqual(ethers.utils.hexStripZeros(word(input.params[0], 0)), E.PONS.toLowerCase());
  }
});

test("buildCalldata matches the fixture and has the successful transaction's shape", () => {
  const data = E.buildCalldata({ recipient: CALLER, usdgIn: 10000, ponsAmount: PONS_BRIDGE, minUsdgOut: 10000 });
  assert.strictEqual(data, vectors.JS_TWO_COMMAND);
  const decoded = decodeExecute(data);
  assert.strictEqual(decoded.commands, "0x1010");
  assert.ok(decoded.deadline.eq(E.MAX_UINT256));
  for (const input of decoded.inputs) {
    assert.strictEqual(input.actions, "0x060c0e");
    assert.deepStrictEqual(input.params.map(words), [12, 2, 3]);
    assert.strictEqual(ethers.BigNumber.from(word(input.params[0], 0)).toNumber(), 0x20);
    assert.strictEqual(ethers.BigNumber.from(word(input.params[0], 10)).toNumber(), 0x140);
  }
  const [first, second] = decoded.inputs.map((input) => input.params[0]);
  // Swap 1: zeroForOne false, amountIn 10000, min out = the bridge amount.
  assert.strictEqual(ethers.BigNumber.from(word(first, 3)).toNumber(), 3000);
  assert.strictEqual(ethers.BigNumber.from(word(first, 6)).toNumber(), 0);
  assert.strictEqual(ethers.BigNumber.from(word(first, 7)).toNumber(), 10000);
  assert.strictEqual(ethers.BigNumber.from(word(first, 8)).toString(), PONS_BRIDGE);
  // Swap 2: zeroForOne true, amountIn = the same bridge amount, never a sentinel.
  assert.strictEqual(ethers.BigNumber.from(word(second, 3)).toNumber(), 30000);
  assert.strictEqual(ethers.BigNumber.from(word(second, 6)).toNumber(), 1);
  assert.strictEqual(ethers.BigNumber.from(word(second, 7)).toString(), PONS_BRIDGE);
  assert.strictEqual(ethers.BigNumber.from(word(second, 8)).toNumber(), 10000);
});

test("buildAtomicCalldata matches the fixture and sells swap 1's output through OPEN_DELTA", () => {
  const data = E.buildAtomicCalldata({ recipient: CALLER, usdgIn: 10000, minUsdgOut: 10000 });
  assert.strictEqual(data, vectors.JS_ATOMIC);
  const decoded = decodeExecute(data);
  assert.strictEqual(decoded.commands, "0x10");
  assert.strictEqual(decoded.inputs[0].actions, "0x06060e");
  assert.deepStrictEqual(decoded.inputs[0].params.map(words), [12, 12, 3]);
  assert.ok(ethers.BigNumber.from(word(decoded.inputs[0].params[1], 7)).isZero());
});

test("optional fields are encoded: settleMax, minHopPriceX36, hookData", () => {
  const input = E.encodeV4Swap({
    poolKey: E.POOL_A,
    zeroForOne: true,
    amountIn: 5,
    amountOutMinimum: 1,
    recipient: E.MSG_SENDER,
    settleMax: 9,
    minHopPriceX36: 7,
    hookData: "0xabcdef",
  });
  const [actions, params] = abi.decode(["bytes", "bytes[]"], input);
  assert.strictEqual(actions, "0x060c0e");
  assert.strictEqual(ethers.BigNumber.from(word(params[0], 9)).toNumber(), 7);
  assert.strictEqual(ethers.BigNumber.from(word(params[0], 11)).toNumber(), 3);
  assert.strictEqual(word(params[0], 12).slice(0, 8), "0xabcdef");
  assert.strictEqual(ethers.BigNumber.from(word(params[1], 1)).toNumber(), 9);
  assert.strictEqual(ethers.BigNumber.from(word(params[2], 1)).toNumber(), 1); // MSG_SENDER
});

const swap = (overrides) =>
  Object.assign(
    { poolKey: E.POOL_B, zeroForOne: true, amountIn: 1000, amountOutMinimum: 0, recipient: CALLER },
    overrides
  );
const refusals = [
  ["amountIn 2^128-1", () => E.encodeV4Swap(swap({ amountIn: E.MAX_UINT128 })), /not OPEN_DELTA/],
  ["amountIn 0", () => E.encodeV4Swap(swap({ amountIn: 0 })), /OPEN_DELTA/],
  ["amountIn above uint128", () => E.encodeV4Swap(swap({ amountIn: E.MAX_UINT128.add(1) })), /uint128/],
  ["missing amountOutMinimum", () => E.encodeV4Swap(swap({ amountOutMinimum: undefined })), /amountOutMinimum is required/],
  ["missing recipient", () => E.encodeV4Swap(swap({ recipient: undefined })), /recipient is required/],
  ["zero recipient", () => E.encodeV4Swap(swap({ recipient: ethers.constants.AddressZero })), /zero address/],
  ["settleMax below amountIn", () => E.encodeV4Swap(swap({ settleMax: 999 })), /settleMax/],
  [
    "unsorted currencies",
    () => E.encodeV4Swap(swap({ poolKey: Object.assign({}, E.POOL_B, { currency0: E.USDG, currency1: E.PONS }) })),
    /sort strictly below/,
  ],
  [
    "buildCalldata with a 2^128-1 bridge amount",
    () => E.buildCalldata({ recipient: CALLER, usdgIn: 10000, ponsAmount: E.MAX_UINT128, minUsdgOut: 0 }),
    /not OPEN_DELTA/,
  ],
  [
    "buildCalldata without minUsdgOut",
    () => E.buildCalldata({ recipient: CALLER, usdgIn: 10000, ponsAmount: PONS_BRIDGE }),
    /minUsdgOut is required/,
  ],
  [
    "buildAtomicCalldata below break-even",
    () => E.buildAtomicCalldata({ recipient: CALLER, usdgIn: 10000, minUsdgOut: 9999 }),
    /can never settle/,
  ],
  ["encodeExecute with one input for two commands", () => E.encodeExecute("0x1010", ["0x"]), /one input is needed/],
];
for (const [name, fn, pattern] of refusals) {
  test("refuses " + name, () => assert.throws(fn, pattern));
}

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log("ok   " + name);
  } catch (error) {
    failed += 1;
    console.log("FAIL " + name + "\n     " + error.message);
  }
}
console.log(tests.length - failed + " passed, " + failed + " failed");
process.exit(failed === 0 ? 0 : 1);
