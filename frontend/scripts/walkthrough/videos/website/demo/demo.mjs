import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * What the demo stack is called and where it listens, plus the people in it. Used by the stack
 * script, the seed and the scenes, so they cannot disagree.
 */
export const DEMO = {
  project: 'otsdemo',
  site: process.env.WALKTHROUGH_DEMO_SITE || 'http://localhost:3200',
  api: process.env.WALKTHROUGH_DEMO_API || 'http://localhost:4200/api',
  mailpit: process.env.WALKTHROUGH_DEMO_MAILPIT || 'http://localhost:8225',
  /** The demo secret and the seed's notes live here, outside the repository. */
  dir: process.env.WALKTHROUGH_DEMO_DIR || path.join(os.homedir(), 'workspace', 'demo_data'),
  // Addresses under .example can never be delivered, and all mail stops at the demo Mailpit.
  admin: { email: 'maintainer@demo.ourtextscores.example', username: 'ots_maintainer', name: 'OurTextScores' },
  people: {
    clara: { email: 'clara@demo.ourtextscores.example', username: 'clara_demo', name: 'Clara (demo)' },
    felix: { email: 'felix@demo.ourtextscores.example', username: 'felix_demo', name: 'Felix (demo)' },
  },
};

/**
 * The secret the demo site signs sessions with. Made once and kept in the demo folder: it is
 * not the dev stack's secret, so nothing made here is valid anywhere else.
 */
export function demoSecret() {
  mkdirSync(DEMO.dir, { recursive: true });
  const file = path.join(DEMO.dir, 'secret');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('hex'), { mode: 0o600 });
  return readFileSync(file, 'utf8').trim();
}

const b64url = (value) => Buffer.from(value).toString('base64url');

/** An API token for a demo person: the same token the site itself would send for them. */
export function tokenFor(person, { hours = 6 } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(
    JSON.stringify({ sub: person.email, email: person.email, name: person.name, iat: now, exp: now + hours * 3600 }),
  )}`;
  return `${data}.${createHmac('sha256', demoSecret()).update(data).digest('base64url')}`;
}
