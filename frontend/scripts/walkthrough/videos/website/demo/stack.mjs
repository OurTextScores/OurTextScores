#!/usr/bin/env node
/**
 * Starts, stops and seeds the demo copy of the site that the website walkthrough is filmed on.
 *
 *   node scripts/walkthrough/videos/website/demo/stack.mjs up [--scanner] [--no-build]
 *   node scripts/walkthrough/videos/website/demo/stack.mjs seed
 *   node scripts/walkthrough/videos/website/demo/stack.mjs status | logs [service] | down | reset
 *
 * See docker-compose.walkthrough-demo.yml for what the stack is and why it is separate.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEMO, demoSecret } from './demo.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const [command = 'status', ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith('--')));
const words = rest.filter((arg) => !arg.startsWith('--'));

function compose(args, { profile = false } = {}) {
  const result = spawnSync(
    'docker',
    ['compose', '-p', DEMO.project, '-f', 'docker-compose.walkthrough-demo.yml', ...(profile ? ['--profile', 'scanner'] : []), ...args],
    { cwd: REPO, stdio: 'inherit', env: { ...process.env, WALKTHROUGH_DEMO_SECRET: demoSecret(), WALKTHROUGH_DEMO_ADMIN: DEMO.admin.email } },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}

async function waitFor(url, label, seconds = 240) {
  process.stdout.write(`waiting for ${label} `);
  for (let i = 0; i < seconds; i++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
      if (response.status < 500) return void console.log('ok');
    } catch {}
    if (i % 5 === 0) process.stdout.write('.');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  console.log('timed out');
  process.exit(1);
}

switch (command) {
  case 'up': {
    const scanner = flags.has('--scanner');
    compose(['up', '-d', ...(flags.has('--no-build') ? [] : ['--build'])], { profile: scanner });
    await waitFor(`${DEMO.api}/works`, 'the API');
    await waitFor(`${DEMO.site}/welcome`, 'the site');
    await waitFor(`${DEMO.mailpit}/api/v1/messages?limit=1`, 'Mailpit');
    console.log(`\nsite ${DEMO.site}   API ${DEMO.api}   mail ${DEMO.mailpit}`);
    break;
  }
  case 'seed': {
    const { seed } = await import('./seed.mjs');
    await seed({ only: words });
    break;
  }
  case 'status':
    compose(['ps'], { profile: true });
    break;
  case 'logs':
    compose(['logs', '--tail', '200', ...words], { profile: true });
    break;
  case 'down':
    compose(['down'], { profile: true });
    break;
  case 'reset':
    // Deletes the demo's own volumes. The dev stack has a different project name and is not touched.
    compose(['down', '-v'], { profile: true });
    break;
  default:
    console.error(`unknown command "${command}". Use up, seed, status, logs, down or reset.`);
    process.exit(2);
}
