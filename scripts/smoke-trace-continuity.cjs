#!/usr/bin/env node

const { execSync } = require('node:child_process');

const FRONTEND_ORIGIN = process.env.SMOKE_FRONTEND_ORIGIN || 'http://localhost:3000';
const COMPOSE_CMD = process.env.SMOKE_COMPOSE_CMD || 'docker compose';
const MINIMAL_SCORE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Music</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <note>
        <pitch><step>C</step><octave>4</octave></pitch>
        <duration>4</duration>
        <type>whole</type>
      </note>
    </measure>
  </part>
</score-partwise>`;

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function parseJsonLines(raw) {
  return raw
    .split('\n')
    .map((line) => {
      const jsonStart = line.indexOf('{');
      if (jsonStart < 0) {
        return null;
      }
      const candidate = line.slice(jsonStart);
      try {
        return JSON.parse(candidate);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readComposeLogs(service, since) {
  const cmd = `${COMPOSE_CMD} logs --since "${since}" ${service}`;
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  const startedAtIso = new Date().toISOString();
  const now = Date.now();
  const requestId = `trace-smoke-${now}`;
  const traceId = randomHex(16);
  const traceparent = `00-${traceId}-${randomHex(8)}-01`;
  const sessionId = `trace-smoke-session-${now}`;

  const response = await fetch(`${FRONTEND_ORIGIN}/api/score-editor/music/scoreops/session/open`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-request-id': requestId,
      traceparent,
      'x-trace-id': traceId,
      'x-client-session-id': sessionId,
      'x-session-id': sessionId,
      'x-ots-trace-smoke': '1',
    },
    body: JSON.stringify({
      action: 'open',
      content: MINIMAL_SCORE_XML,
      score_meta: {
        source: 'trace-smoke',
      },
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(
      `Smoke request failed (${response.status}): ${JSON.stringify(body, null, 2)}`,
    );
  }

  const returnedRequestId = response.headers.get('x-request-id');
  const returnedTraceId = response.headers.get('x-trace-id');
  if (returnedRequestId !== requestId) {
    throw new Error(
      `Request id mismatch: expected ${requestId}, got ${returnedRequestId || '<missing>'}`,
    );
  }
  if (returnedTraceId !== traceId) {
    throw new Error(
      `Trace id mismatch: expected ${traceId}, got ${returnedTraceId || '<missing>'}`,
    );
  }

  await new Promise((resolve) => setTimeout(resolve, 1200));

  const frontendLogs = parseJsonLines(readComposeLogs('frontend', startedAtIso));
  const editorLogs = parseJsonLines(readComposeLogs('score_editor_api', startedAtIso));

  const frontendTraceLog = frontendLogs.find((entry) => (
    entry.event === 'frontend.score_editor_proxy.trace'
    && entry.requestId === requestId
    && entry.traceId === traceId
  ));

  const editorTraceLog = editorLogs.find((entry) => (
    entry.event === 'scoreops.session.open.summary'
    && entry.requestId === requestId
    && entry.traceId === traceId
  ));

  if (!frontendTraceLog || !editorTraceLog) {
    throw new Error(`Trace continuity assertion failed.
Expected requestId=${requestId}, traceId=${traceId}
frontend log found: ${frontendTraceLog ? 'yes' : 'no'}
score_editor_api log found: ${editorTraceLog ? 'yes' : 'no'}`);
  }

  console.log(JSON.stringify({
    ok: true,
    requestId,
    traceId,
    frontendEvent: frontendTraceLog.event,
    scoreEditorEvent: editorTraceLog.event,
    scoreSessionId: body.scoreSessionId || null,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
