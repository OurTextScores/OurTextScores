#!/usr/bin/env node
const http = require('http');

function waitFor(url, timeoutMs = 60000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        if (res.statusCode && res.statusCode < 500) {
          res.resume();
          return resolve();
        }
        res.resume();
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for ${url}`));
        setTimeout(attempt, 1000);
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) return reject(new Error(`Timeout waiting for ${url}`));
        setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

(async () => {
  const targets = [
    'http://localhost:3000',
    'http://localhost:3000/api/diagnostics/email',
    'http://localhost:4000/api/works',
    // score_editor_api is the slowest to come up: it runs a Next dev build and
    // extracts a MuseScore AppImage. Specs that convert ABC go through it, so
    // without this they raced the service and failed with an opaque upload
    // error. A 405 here means the route exists and Next has compiled it.
    'http://localhost:4010/api/music/convert'
  ];
  for (const t of targets) {
    process.stdout.write(`Waiting for ${t} ...\n`);
    await waitFor(t, 120000);
  }
  console.log('All services are healthy.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});

