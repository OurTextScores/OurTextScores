#!/usr/bin/env node
'use strict';

// Run independently of the API (for example, from a host systemd timer).
// Do not log the environment or request URLs: the Kuma URL contains a secret.
async function reportUploadHealth(env = process.env, request = fetch) {
  const healthUrl = new URL(
    env.OPERATIONS_HEALTH_URL || 'https://api.ourtextscores.com/api/operations/upload-health/check'
  );
  const push = new URL(env.KUMA_UPLOAD_PUSH_URL || '');
  if (!env.OPERATIONS_MONITOR_TOKEN || !/\/api\/push\/[^/]+$/.test(push.pathname))
    throw new Error('Monitor configuration is incomplete');
  for (const url of [healthUrl, push]) {
    if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      throw new Error('Monitoring endpoints must use HTTPS');
  }
  let status = 'down';
  let message = 'Upload health check unavailable; inspect API and telemetry';
  try {
    const response = await request(healthUrl, {
      headers: { 'x-operations-monitor-token': env.OPERATIONS_MONITOR_TOKEN },
      redirect: 'error',
      signal: AbortSignal.timeout(15000)
    });
    if (response.ok) {
      const report = await response.json();
      const age = Date.now() - Date.parse(report.generatedAt);
      if (
        !['up', 'down'].includes(report.status) ||
        !Number.isFinite(age) ||
        age < -60000 ||
        age > 180000
      )
        throw new Error('Invalid or stale health report');
      status = report.status;
      // Never relay arbitrary upstream error text or incident labels to email.
      message =
        status === 'up'
          ? 'Upload health OK; see Admin Analytics for request outcomes'
          : 'Upload incident or maintenance override; see Admin Analytics';
    }
  } catch {
    /* Failure is represented by a down heartbeat below. */
  }
  push.searchParams.set('status', status);
  push.searchParams.set('msg', message);
  const sent = await request(push, { redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!sent.ok || !(await sent.json()).ok) throw new Error('Kuma heartbeat was not accepted');
  return { status, message };
}

module.exports = { reportUploadHealth };
if (require.main === module) {
  reportUploadHealth()
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(() => {
      process.stderr.write(
        'Upload monitor failed; check endpoint availability and protected configuration\n'
      );
      process.exitCode = 1;
    });
}
