#!/usr/bin/env node

/**
 * H14 — Editor telemetry contract E2E smoke test.
 *
 * Validates that the analytics ingest endpoint correctly accepts, validates,
 * and sanitises all 6 editor metric event types used by OTS_Web.
 *
 * Requires: OurTextScores containers running (docker compose up -d).
 * Usage:    node scripts/smoke-editor-telemetry.cjs
 *           npm run smoke:telemetry
 */

const BACKEND_ORIGIN = process.env.SMOKE_BACKEND_ORIGIN || 'http://localhost:4000';
const INGEST_URL = `${BACKEND_ORIGIN}/api/analytics/events`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}

const editorSessionId = `smoke-h14-${Date.now()}`;
const apiRequestId = `smoke-req-${Date.now()}`;
const apiTraceId = randomHex(16);

// ---------------------------------------------------------------------------
// Valid event payloads — one per editor metric event type
// ---------------------------------------------------------------------------

const VALID_EVENTS = [
  {
    eventName: 'score_editor_runtime_loaded',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      api_request_id: apiRequestId,
      api_trace_id: apiTraceId,
    },
  },
  {
    eventName: 'score_editor_document_loaded',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      load_source: 'upload',
      input_format: 'musicxml',
      input_bytes: 12345,
      duration_ms: 450,
      progressive_paging: false,
      has_more_pages: false,
      engine_mode: 'wasm',
      api_request_id: apiRequestId,
      api_trace_id: apiTraceId,
    },
  },
  {
    eventName: 'score_editor_document_load_failed',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      load_source: 'upload',
      input_format: 'musicxml',
      input_bytes: 999,
      duration_ms: 100,
      engine_mode: 'wasm',
      error: 'Smoke test simulated load failure',
      api_request_id: apiRequestId,
      api_trace_id: apiTraceId,
    },
  },
  {
    eventName: 'score_editor_ai_request',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      channel: 'scoreops',
      provider: 'openai',
      backend: 'wasm',
      model: 'gpt-4o',
      selected_tool: 'set_key_signature',
      fallback_only: false,
      include_xml: false,
      outcome: 'success',
      duration_ms: 1200,
      api_request_id: apiRequestId,
      api_trace_id: apiTraceId,
    },
  },
  {
    eventName: 'score_editor_patch_applied',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      source: 'ai',
      input_format: 'musicxml',
      outcome: 'success',
      duration_ms: 80,
      api_request_id: apiRequestId,
      api_trace_id: apiTraceId,
    },
  },
  {
    eventName: 'score_editor_session_summary',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      duration_ms: 30000,
      documents_loaded: 1,
      document_load_failures: 1,
      ai_requests: 1,
      ai_failures: 0,
      patch_applies: 1,
      patch_apply_failures: 0,
      api_request_id: apiRequestId,
      api_trace_id: apiTraceId,
    },
  },
];

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

async function postEvents(payload) {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

/** 1. Batch ingest — all 6 valid editor events in one request. */
async function testBatchIngest() {
  const { status, body } = await postEvents({
    events: VALID_EVENTS,
    sourceApp: 'score_editor_api',
    sessionId: editorSessionId,
  });

  if (status !== 201) {
    throw new Error(`Batch ingest: expected 201, got ${status}: ${JSON.stringify(body)}`);
  }
  if (!body.ok || body.accepted !== VALID_EVENTS.length) {
    throw new Error(
      `Batch ingest: expected accepted=${VALID_EVENTS.length}, got ${JSON.stringify(body)}`,
    );
  }
  return { test: 'batch_ingest', accepted: body.accepted };
}

/** 2. Single-event ingest — one event without events[] wrapper. */
async function testSingleEventIngest() {
  const { status, body } = await postEvents({
    eventName: 'score_editor_runtime_loaded',
    sourceApp: 'score_editor_api',
    sessionId: editorSessionId,
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
    },
  });

  if (status !== 201) {
    throw new Error(`Single ingest: expected 201, got ${status}: ${JSON.stringify(body)}`);
  }
  if (!body.ok || body.accepted !== 1) {
    throw new Error(`Single ingest: expected accepted=1, got ${JSON.stringify(body)}`);
  }
  return { test: 'single_event_ingest', accepted: body.accepted };
}

/** 3. Invalid event name — should be accepted request but 0 events ingested. */
async function testInvalidEventName() {
  const { status, body } = await postEvents({
    events: [{ eventName: 'completely_bogus_event', properties: {} }],
    sourceApp: 'score_editor_api',
  });

  // Backend may return 201 with accepted=0 or 400 depending on validation strategy.
  // Either is acceptable — the key assertion is the invalid event is NOT accepted=1.
  if (status === 201 && body.accepted === 0) {
    return { test: 'invalid_event_name', status, accepted: 0, strategy: 'silent_drop' };
  }
  if (status >= 400 && status < 500) {
    return { test: 'invalid_event_name', status, strategy: 'rejection' };
  }
  throw new Error(
    `Invalid event name: unexpected response ${status}: ${JSON.stringify(body)}`,
  );
}

/** 4. Oversized properties — should be accepted (sanitised/truncated, not rejected). */
async function testOversizedProperties() {
  const { status, body } = await postEvents({
    eventName: 'score_editor_ai_request',
    sourceApp: 'score_editor_api',
    properties: {
      editor_surface: 'embedded',
      editor_session_id: editorSessionId,
      // Deliberately oversized string fields — should be truncated by sanitiser
      channel: 'x'.repeat(200),
      model: 'y'.repeat(300),
      outcome: 'success',
    },
  });

  if (status !== 201) {
    throw new Error(`Oversized props: expected 201, got ${status}: ${JSON.stringify(body)}`);
  }
  if (!body.ok || body.accepted !== 1) {
    throw new Error(`Oversized props: expected accepted=1, got ${JSON.stringify(body)}`);
  }
  return { test: 'oversized_properties', accepted: body.accepted, note: 'truncated_not_rejected' };
}

/** 5. Empty properties — should succeed (all optional). */
async function testEmptyProperties() {
  const { status, body } = await postEvents({
    eventName: 'score_editor_session_summary',
    sourceApp: 'score_editor_api',
    properties: {},
  });

  if (status !== 201) {
    throw new Error(`Empty props: expected 201, got ${status}: ${JSON.stringify(body)}`);
  }
  if (!body.ok || body.accepted !== 1) {
    throw new Error(`Empty props: expected accepted=1, got ${JSON.stringify(body)}`);
  }
  return { test: 'empty_properties', accepted: body.accepted };
}

/** 6. Each editor event type individually — verifies each schema path. */
async function testEachEventType() {
  const results = [];
  for (const event of VALID_EVENTS) {
    const { status, body } = await postEvents({
      ...event,
      sourceApp: 'score_editor_api',
      sessionId: editorSessionId,
    });
    if (status !== 201 || !body.ok || body.accepted !== 1) {
      throw new Error(
        `Individual ${event.eventName}: expected 201/accepted=1, got ${status}: ${JSON.stringify(body)}`,
      );
    }
    results.push({ eventName: event.eventName, accepted: 1 });
  }
  return { test: 'individual_event_types', results };
}

/** 7. Malformed payload — should return 400. */
async function testMalformedPayload() {
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '"not an object"',
  });

  if (res.status < 400 || res.status >= 500) {
    throw new Error(`Malformed payload: expected 4xx, got ${res.status}`);
  }
  return { test: 'malformed_payload', status: res.status };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log(`H14 Editor Telemetry Contract Smoke Test`);
  console.log(`Backend: ${BACKEND_ORIGIN}`);
  console.log(`Session: ${editorSessionId}\n`);

  const tests = [
    testBatchIngest,
    testSingleEventIngest,
    testInvalidEventName,
    testOversizedProperties,
    testEmptyProperties,
    testEachEventType,
    testMalformedPayload,
  ];

  const results = [];
  let failures = 0;

  for (const test of tests) {
    try {
      const result = await test();
      results.push(result);
      console.log(`  PASS  ${result.test}`);
    } catch (err) {
      failures++;
      const name = test.name.replace(/^test/, '');
      console.error(`  FAIL  ${name}: ${err.message}`);
      results.push({ test: name, error: err.message });
    }
  }

  console.log('');

  if (failures > 0) {
    console.error(`${failures} test(s) failed.`);
    process.exit(1);
  }

  console.log(JSON.stringify({ ok: true, editorSessionId, testsRun: results.length, results }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
