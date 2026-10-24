export const UPLOAD_OPERATIONS = [
  'source',
  'revision',
  'project',
  'reference_pdf',
  'scanner'
] as const;
export type UploadKind = (typeof UPLOAD_OPERATIONS)[number];

export function uploadKind(method: string, path: string): UploadKind | null {
  if (method !== 'POST') return null;
  if (/^\/api\/projects\/[^/]+\/sources\/?$/.test(path)) return 'project';
  if (/^\/api\/works\/[^/]+\/sources\/[^/]+\/revisions\/?$/.test(path)) return 'revision';
  if (/^\/api\/works\/[^/]+\/sources\/[^/]+\/reference\.pdf\/?$/.test(path)) return 'reference_pdf';
  if (/^\/api\/works\/[^/]+\/sources\/?$/.test(path)) return 'source';
  if (/^\/api\/scanner\/jobs\/?$/.test(path)) return 'scanner';
  return null;
}

export function classifyUpload(status: number) {
  if (status === 0) return { outcome: 'unknown', category: 'network_or_timeout' };
  if (status >= 200 && status < 300) return { outcome: 'accepted', category: 'accepted' };
  if (status === 413) return { outcome: 'rejected', category: 'payload_too_large' };
  if (status === 429) return { outcome: 'rejected', category: 'rate_limited' };
  if (status === 401 || status === 403)
    return { outcome: 'rejected', category: 'authentication_or_permission' };
  if (status >= 500) return { outcome: 'failed', category: 'server_failure' };
  return { outcome: 'rejected', category: 'invalid_request' };
}

// Deliberately exclude expected quota and invalid-file responses from outage alerts.
export function evaluateUploadHealth(counts: {
  attempts: number;
  serviceAttempts?: number;
  serverFailures: number;
  tooLarge: number;
  blockedAccounts: number;
}) {
  const incidents: string[] = [];
  const serviceAttempts = counts.serviceAttempts ?? counts.attempts;
  if (serviceAttempts >= 5 && counts.serverFailures / serviceAttempts >= 0.2)
    incidents.push('Upload server failures exceed 20%');
  if (counts.tooLarge >= 3) incidents.push('Repeated oversized upload rejections');
  if (counts.blockedAccounts >= 3) incidents.push('Multiple accounts are upload-limited');
  return { status: incidents.length ? 'down' : 'up', incidents };
}
