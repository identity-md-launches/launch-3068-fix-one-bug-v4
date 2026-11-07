"use strict";

// Run `forge build` first. No network or packages; the deployment remains the same two files.
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const artifact = JSON.parse(fs.readFileSync(path.join(root, "out/V3Quote.sol/V3Quote.json"), "utf8"));
const file = path.join(root, "js/v4-arb-encoder.js");
const source = fs.readFileSync(file, "utf8");
const next = source.replace(/var V3_QUOTE_BYTECODE = "0x[0-9a-f]*";/,
  'var V3_QUOTE_BYTECODE = "' + artifact.bytecode.object + '";');
if (process.argv.includes("--check")) {
  if (source !== next) throw new Error("V3 quote bytecode differs from the pinned Foundry build; run this script without --check");
  console.log("V3 quote bytecode matches the Foundry artifact.");
} else {
  fs.writeFileSync(file, next);
  console.log("Embedded V3 creation-call quote bytecode.");
}
