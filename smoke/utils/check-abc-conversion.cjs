#!/usr/bin/env node
// Check the actual conversion path: GET /api/music/convert only proves that
// the Next.js route exists, not that its converter scripts are installed.
const { readFileSync } = require('node:fs');

async function main() {
  const response = await fetch('http://localhost:4010/api/music/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      inputFormat: 'abc', outputFormat: 'musicxml',
      content: readFileSync('smoke/fixtures/simple_scale.abc', 'utf8'),
      validate: true, deepValidate: false, includeContent: true
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ABC conversion failed (${response.status}): ${text}`);
  const result = JSON.parse(text);
  if (typeof result.content !== 'string' || !result.content.includes('<score-partwise')) {
    throw new Error('ABC conversion did not return a MusicXML score');
  }
  console.log('ABC conversion produced MusicXML.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
