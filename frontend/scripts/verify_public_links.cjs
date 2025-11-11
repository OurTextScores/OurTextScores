#!/usr/bin/env node
/*
  Verifies that client bundles do not contain internal-only hosts like "backend:4000".
  This helps catch regressions where server-only API bases leak into browser-visible links.
*/
const fs = require('fs');
const path = require('path');

const BUILD_DIR = process.env.BUILD_DIR || '.next';
const ROOT = process.cwd();
const STATIC_DIR = path.join(ROOT, BUILD_DIR, 'static');

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else {
      yield full;
    }
  }
}

function main() {
  if (!fs.existsSync(STATIC_DIR)) {
    console.warn(`[verify_public_links] Skipping check: ${STATIC_DIR} not found`);
    return;
  }
  const offenders = [];
  const patterns = [/http:\/\/backend:\d+/i, /backend:4000/i];
  for (const file of walk(STATIC_DIR)) {
    // Only scan likely text assets
    if (!/(\.js|\.css|\.html|\.txt|\.json)$/i.test(file)) continue;
    try {
      const buf = fs.readFileSync(file);
      const text = buf.toString('utf8');
      for (const re of patterns) {
        if (re.test(text)) {
          offenders.push({ file: path.relative(ROOT, file), pattern: re.toString() });
          break;
        }
      }
    } catch (e) {
      // non-fatal
    }
  }
  if (offenders.length > 0) {
    console.error('\n[verify_public_links] Found internal URLs in client bundle:');
    for (const o of offenders) {
      console.error(` - ${o.file} matches ${o.pattern}`);
    }
    process.exit(1);
  } else {
    console.log('[verify_public_links] OK: no internal URLs found in client bundle.');
  }
}

main();

