// @ts-check
const { test, expect } = require('@playwright/test');

const PUBLIC_API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';

test.describe('Rate Limiting', () => {
  test('should enforce rate limits on health endpoint', async ({ request }) => {
    const endpoint = `${PUBLIC_API}/health`;

    // Health endpoint allows 200 requests per minute
    // Let's make 205 requests rapidly and verify at least some are rate-limited
    const requests = [];
    for (let i = 0; i < 205; i++) {
      requests.push(request.get(endpoint));
    }

    const responses = await Promise.all(requests);

    // Count how many got rate-limited
    const rateLimitedResponses = responses.filter(r => r.status() === 429);

    // At least 5 should be rate-limited (205 - 200 = 5)
    expect(rateLimitedResponses.length).toBeGreaterThanOrEqual(5);

    // Verify the 429 response format
    if (rateLimitedResponses.length > 0) {
      const errorBody = await rateLimitedResponses[0].json();
      expect(errorBody.statusCode).toBe(429);
      expect(errorBody.error).toBe('Too Many Requests');
      expect(errorBody.message).toContain('rate limit');
      expect(errorBody.details).toBeDefined();
      expect(errorBody.details.limit).toBeDefined();
      expect(errorBody.details.retryAfter).toBeGreaterThan(0);
      expect(errorBody.timestamp).toBeDefined();
      expect(errorBody.path).toBe('/health');
    }
  });

  test('should allow successful requests within limit', async ({ request }) => {
    const endpoint = `${PUBLIC_API}/health`;

    // Make 10 requests (well within the 200/min limit)
    const requests = [];
    for (let i = 0; i < 10; i++) {
      requests.push(request.get(endpoint));
    }

    const responses = await Promise.all(requests);

    // All should succeed
    for (const response of responses) {
      expect(response.status()).toBe(200);
      const body = await response.json();
      expect(body.status).toBe('ok');
    }
  });

  test('should provide helpful error details in 429 response', async ({ request }) => {
    const endpoint = `${PUBLIC_API}/health`;

    // Trigger rate limit by making many requests
    const requests = [];
    for (let i = 0; i < 210; i++) {
      requests.push(request.get(endpoint));
    }

    const responses = await Promise.all(requests);
    const rateLimited = responses.find(r => r.status() === 429);

    if (rateLimited) {
      const errorBody = await rateLimited.json();

      // Verify all expected fields are present
      expect(errorBody).toMatchObject({
        statusCode: 429,
        error: 'Too Many Requests',
        message: expect.stringContaining('rate limit'),
        details: {
          limit: expect.any(Number),
          retryAfter: expect.any(Number),
          retryAfterMs: expect.any(Number),
        },
        timestamp: expect.any(String),
        path: expect.any(String),
      });

      // Verify timestamp is recent (within last minute)
      const timestamp = new Date(errorBody.timestamp);
      const now = new Date();
      const diffMs = now.getTime() - timestamp.getTime();
      expect(diffMs).toBeLessThan(60000); // Within 1 minute
    }
  });
});
