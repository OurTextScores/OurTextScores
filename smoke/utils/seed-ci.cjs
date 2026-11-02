#!/usr/bin/env node
// The nightly suite runs against a new, disposable Compose database. Several
// older smoke tests require a work with a source and initial revision.
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHmac } = require('node:crypto');
const { MongoClient } = require('mongodb');

async function main() {
  if (process.env.CI !== 'true') throw new Error('This seed is only for the disposable CI stack');
  const env = Object.fromEntries(readFileSync('.env', 'utf8').split('\n').flatMap(line => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    return match ? [[match[1], match[2].trim().replace(/^["']|["']$/g, '')]] : [];
  }));
  const value = name => process.env[name] || env[name];
  const user = encodeURIComponent(value('MONGO_INITDB_ROOT_USERNAME'));
  const password = encodeURIComponent(value('MONGO_INITDB_ROOT_PASSWORD'));
  const client = new MongoClient(`mongodb://${user}:${password}@localhost:27018/ourtextscores?authSource=admin`);
  const workId = '999999999';
  try {
    await client.connect();
    const works = client.db('ourtextscores').collection('works');
    if (await works.countDocuments({}) !== 0) throw new Error('Expected an empty CI database');
    const now = new Date();
    await works.insertOne({ workId, title: 'Smoke test score', composer: 'CI fixture', sourceCount: 0,
      availableFormats: [], hasReferencePdf: false, hasVerifiedSources: false, hasFlaggedSources: false,
      createdAt: now, updatedAt: now });
  } finally {
    await client.close();
  }

  const email = 'ci-seed@example.test';
  const encode = object => Buffer.from(JSON.stringify(object)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: email, email, iat: now, exp: now + 3600 })}`;
  const token = `${unsigned}.${createHmac('sha256', value('NEXTAUTH_SECRET')).update(unsigned).digest('base64url')}`;
  const form = new FormData();
  form.append('commitMessage', 'Create CI smoke fixture');
  form.append('file', new Blob([readFileSync(join('test_scores', 'bach_orig.mxl'))], { type: 'application/vnd.recordare.musicxml' }), 'bach_orig.mxl');
  const response = await fetch(`http://localhost:4000/api/works/${workId}/sources`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form
  });
  if (!response.ok) throw new Error(`Fixture upload failed (${response.status}): ${await response.text()}`);
  const detailResponse = await fetch(`http://localhost:4000/api/works/${workId}`);
  if (!detailResponse.ok) throw new Error(`Fixture lookup failed (${detailResponse.status})`);
  const detail = await detailResponse.json();
  if (!detail.sources?.some(source => source.revisions?.length)) throw new Error('Fixture has no source with a revision');
  console.log('Seeded a smoke-test work with a score and revision.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
