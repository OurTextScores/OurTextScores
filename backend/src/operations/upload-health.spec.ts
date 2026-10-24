import { classifyUpload, evaluateUploadHealth, uploadKind } from './upload-health';

describe('upload health classification', () => {
  it('recognizes real admission routes, including trailing slashes, without counting job actions', () => {
    expect(uploadKind('POST', '/api/projects/123/sources/')).toBe('project');
    expect(uploadKind('POST', '/api/works/1/sources/2/revisions')).toBe('revision');
    expect(uploadKind('POST', '/api/scanner/jobs/123/retry')).toBeNull();
    expect(uploadKind('GET', '/api/scanner/jobs')).toBeNull();
  });
  it('distinguishes admission, network uncertainty, throttling and server failure', () => {
    expect(classifyUpload(201).outcome).toBe('accepted');
    expect(classifyUpload(0).outcome).toBe('unknown');
    expect(classifyUpload(429).category).toBe('rate_limited');
    expect(classifyUpload(413).category).toBe('payload_too_large');
    expect(classifyUpload(503).category).toBe('server_failure');
  });
  it('does not turn inactivity or one blocked account into an outage', () => {
    expect(
      evaluateUploadHealth({ attempts: 0, serverFailures: 0, tooLarge: 0, blockedAccounts: 0 })
        .status
    ).toBe('up');
    expect(
      evaluateUploadHealth({ attempts: 50, serverFailures: 0, tooLarge: 0, blockedAccounts: 1 })
        .status
    ).toBe('up');
    expect(
      evaluateUploadHealth({ attempts: 4, serverFailures: 1, tooLarge: 0, blockedAccounts: 0 })
        .status
    ).toBe('up');
    expect(
      evaluateUploadHealth({ attempts: 5, serverFailures: 1, tooLarge: 0, blockedAccounts: 0 })
        .status
    ).toBe('down');
    expect(
      evaluateUploadHealth({ attempts: 5, serverFailures: 0, tooLarge: 3, blockedAccounts: 0 })
        .status
    ).toBe('down');
  });
  it('does not dilute service failures with expected rate-limit or invalid-file rejections', () => {
    expect(evaluateUploadHealth({ attempts: 100, serviceAttempts: 5, serverFailures: 1, tooLarge: 0, blockedAccounts: 0 }).status).toBe('down');
  });
});
