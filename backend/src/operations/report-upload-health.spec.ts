const { reportUploadHealth } = require('../../scripts/report-upload-health');

describe('independent Kuma upload reporter', () => {
  const env = {
    OPERATIONS_MONITOR_TOKEN: 'test-secret',
    OPERATIONS_HEALTH_URL: 'https://api.example.test/health',
    KUMA_UPLOAD_PUSH_URL: 'https://monitor.example.test/api/push/private-push-token'
  };
  it('reports a fresh healthy result and keeps the read-only token off the Kuma request', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: 'up', generatedAt: new Date().toISOString() })
      })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    expect((await reportUploadHealth(env, request)).status).toBe('up');
    expect(request.mock.calls[0][1].headers['x-operations-monitor-token']).toBe('test-secret');
    expect(request.mock.calls[1][0].searchParams.get('status')).toBe('up');
    expect(JSON.stringify(request.mock.calls[1][1])).not.toContain('test-secret');
  });
  it('sends down for stale data or an unavailable API, and sanitizes the message', async () => {
    const request = jest
      .fn()
      .mockRejectedValueOnce(new Error('private upstream failure'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });
    expect((await reportUploadHealth(env, request)).status).toBe('down');
    expect(String(request.mock.calls[1][0])).not.toContain('private upstream failure');
  });
  it('fails if Kuma did not accept the heartbeat', async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: false });
    await expect(reportUploadHealth(env, request)).rejects.toThrow(
      'Kuma heartbeat was not accepted'
    );
  });
});
