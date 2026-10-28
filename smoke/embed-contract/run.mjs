import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, copyFile, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const frontend = join(root, 'frontend');
const fixture = join(root, 'smoke/embed-contract');
const temp = await mkdtemp(join(tmpdir(), 'ots-embed-contract-'));
let server;
const waitForExit = child => new Promise(resolve => {
  if (child.exitCode !== null || child.signalCode !== null) resolve(child.exitCode);
  else child.once('exit', resolve);
});
try {
  // Use the actual host components and vendored assets without adding a production route.
  execFileSync('rsync', ['-a', '--exclude=node_modules/', '--exclude=.next/',
    '--exclude=.env*', '--exclude=soundfonts/', `${frontend}/`, `${temp}/`], { stdio: 'inherit' });
  await symlink(join(frontend, 'node_modules'), join(temp, 'node_modules'), 'dir');
  await mkdir(join(temp, 'app/contract-harness'), { recursive: true });
  await copyFile(join(fixture, 'page.jsx'), join(temp, 'app/contract-harness/page.jsx'));
  await copyFile(join(fixture, 'layout.tsx'), join(temp, 'app/layout.tsx'));
  const port = await new Promise((resolvePort, reject) => {
    const listener = createServer();
    listener.on('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const selected = listener.address().port;
      listener.close(error => error ? reject(error) : resolvePort(selected));
    });
  });
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(frontend, 'node_modules/next/dist/bin/next'), 'dev', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: temp, env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' }, detached: true, stdio: 'inherit',
  });
  const deadline = Date.now() + 120_000;
  while (true) {
    if (server.exitCode !== null || server.signalCode !== null) throw new Error('Test host exited before becoming ready');
    try {
      const response = await fetch(`${base}/contract-harness`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) break;
    } catch { /* Server is still starting. */ }
    if (Date.now() >= deadline) throw new Error('Test host did not become ready');
    await new Promise(resolveWait => setTimeout(resolveWait, 500));
  }
  const test = spawn(process.execPath, [join(fixture, 'check.mjs')], {
    cwd: root, env: { ...process.env, EMBED_CONTRACT_BASE_URL: base }, stdio: 'inherit',
  });
  const code = await waitForExit(test);
  if (code !== 0) throw new Error(`Embed contract check failed (${code ?? 'signal'})`);
} finally {
  if (server && server.exitCode === null && server.signalCode === null) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await waitForExit(server);
  }
  await rm(temp, { recursive: true, force: true });
}
