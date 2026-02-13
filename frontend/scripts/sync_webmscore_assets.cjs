#!/usr/bin/env node

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const srcDir = path.join(repoRoot, "node_modules", "webmscore");
const destDir = path.join(repoRoot, "public");

const required = [
  "webmscore.lib.js",
  "webmscore.lib.wasm",
  "webmscore.lib.data",
  "webmscore.lib.mem.wasm",
];

const optional = ["webmscore.lib.symbols"];

function copyAsset(name, requiredAsset = true) {
  const src = path.join(srcDir, name);
  const dest = path.join(destDir, name);

  if (!fs.existsSync(src)) {
    if (requiredAsset) {
      throw new Error(`Missing webmscore asset: ${src}`);
    }
    return;
  }

  fs.copyFileSync(src, dest);
}

function main() {
  if (!fs.existsSync(srcDir)) {
    throw new Error(
      "webmscore is not installed. Run `npm install` in frontend/ first."
    );
  }

  fs.mkdirSync(destDir, { recursive: true });
  required.forEach((name) => copyAsset(name, true));
  optional.forEach((name) => copyAsset(name, false));
}

main();
