#!/usr/bin/env node
/*
  Prevent client components from importing getApiBase() (which may resolve to an internal host on SSR),
  and enforce getPublicApiBase() for any browser-facing URLs.
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.join(process.cwd(), 'app');

function* walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      yield* walk(full);
    } else if (/\.(tsx?|jsx?)$/i.test(e.name)) {
      yield full;
    }
  }
}

function isClientFile(text) {
  // Next.js client components must include "use client" at the top
  const firstLines = text.split(/\r?\n/, 5).join('\n');
  return /['"]use client['"];?/.test(firstLines);
}

function main() {
  if (!fs.existsSync(ROOT)) return;
  const offenders = [];
  for (const file of walk(ROOT)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!isClientFile(text)) continue;
    // If client file imports getApiBase from lib/api, flag it
    const importLine = /from\s+["']\.\/.+lib\/api["']/;
    if (importLine.test(text) && /\bgetApiBase\b/.test(text)) {
      offenders.push({ file: path.relative(process.cwd(), file), reason: 'client component imports getApiBase; use getPublicApiBase' });
      continue;
    }
    // Also flag direct usage just in case
    if (/\bgetApiBase\s*\(/.test(text)) {
      offenders.push({ file: path.relative(process.cwd(), file), reason: 'client component uses getApiBase(); use getPublicApiBase()' });
    }
  }
  if (offenders.length > 0) {
    console.error('\n[check_client_api_usage] Found client components using getApiBase():');
    for (const o of offenders) console.error(` - ${o.file}: ${o.reason}`);
    process.exit(1);
  } else {
    console.log('[check_client_api_usage] OK: no client components import or use getApiBase().');
  }
}

main();

