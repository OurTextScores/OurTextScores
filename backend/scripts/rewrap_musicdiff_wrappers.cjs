#!/usr/bin/env node
// Rewrites stored musicdiff HTML wrappers in the aux bucket to use absolute
// backend-origin URLs for the embedded PDF link, so they render correctly
// when injected into the frontend page.

const { Client } = require('minio');

function parseMinioFromEnv() {
  const url = process.env.MINIO_URL || '';
  let endPoint = process.env.MINIO_ENDPOINT || '';
  let port = process.env.MINIO_PORT ? Number(process.env.MINIO_PORT) : undefined;
  let useSSL = (String(process.env.MINIO_USE_SSL || '').toLowerCase() === 'true');
  if (url) {
    try {
      const u = new URL(url);
      endPoint = u.hostname;
      port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      useSSL = u.protocol === 'https:';
    } catch {}
  }
  if (!endPoint) endPoint = 'minio';
  if (!port) port = 9000;
  return {
    endPoint,
    port,
    useSSL,
    accessKey: process.env.MINIO_ACCESS_KEY || 'minioadmin',
    secretKey: process.env.MINIO_SECRET_KEY || 'minioadmin',
    auxBucket: 'scores-aux'
  };
}

async function readAll(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

async function main() {
  const baseArgIdx = process.argv.findIndex((a) => a === '--base' || a === '--base-origin');
  const baseOrigin = (baseArgIdx >= 0 && process.argv[baseArgIdx + 1]) || process.env.PUBLIC_API_BASE || 'http://localhost:4000';
  if (!/^https?:\/\//.test(baseOrigin)) {
    console.error('Base origin must include protocol, e.g. http://localhost:4000');
    process.exit(2);
  }
  const cfg = parseMinioFromEnv();
  const client = new Client({ endPoint: cfg.endPoint, port: cfg.port, useSSL: cfg.useSSL, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  const bucket = cfg.auxBucket;
  let scanned = 0, updated = 0, skipped = 0;
  console.log(`Scanning bucket ${bucket} for musicdiff.html wrappers…`);
  const stream = client.listObjectsV2(bucket, '', true);
  const toProcess = [];
  await new Promise((resolve, reject) => {
    stream.on('data', (obj) => { if (obj && obj.name && obj.name.endsWith('musicdiff.html')) toProcess.push(obj.name); });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  for (const key of toProcess) {
    scanned += 1;
    try {
      const obj = await client.getObject(bucket, key);
      const buf = await readAll(obj);
      const text = buf.toString('utf-8');
      // Heuristic: if wrapper uses relative /api/ path for object data or href, rewrite to absolute
      if (/href=\"\/api\//.test(text) || /data=\"\/api\//.test(text)) {
        const rewritten = text
          .replace(/href=\"\/api\//g, `href=\"${baseOrigin}/api/`)
          .replace(/data=\"\/api\//g, `data=\"${baseOrigin}/api/`);
        await client.putObject(bucket, key, Buffer.from(rewritten, 'utf-8'), rewritten.length, { 'Content-Type': 'text/html' });
        updated += 1;
        console.log(`Updated ${key}`);
      } else {
        skipped += 1;
      }
    } catch (err) {
      console.warn(`Failed ${key}: ${err?.message || err}`);
    }
  }
  console.log(`Done. Scanned: ${scanned}, Updated: ${updated}, Skipped: ${skipped}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

