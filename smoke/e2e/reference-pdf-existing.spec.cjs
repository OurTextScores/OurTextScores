// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

test.describe('Reference PDF Upload (Existing Source)', () => {
  test('uploads reference PDF to an existing source', async ({ request, page }) => {
    test.setTimeout(120000);

    const imslpUrl = process.env.IMSLP_TEST_URL || 'https://imslp.org/wiki/Cello_Suite_No.1,_BWV_1007_(Bach,_Johann_Sebastian)';
    const explicitWorkId = process.env.IMSLP_TEST_WORK_ID || '';
    const localPdfPath = process.env.IMSLP_TEST_PDF_PATH || '';
    let workId = explicitWorkId || null;

    if (!workId) {
      const ensureResp = await request.post(`${PUBLIC_API}/works/save-by-url`, {
        data: { url: imslpUrl }
      });
      if (ensureResp.ok()) {
        const ensured = await ensureResp.json();
        workId = ensured.work.workId;
      }
    }

    if (!workId) {
      test.skip('No IMSLP work available for reference PDF test.');
    }

    // Create auth token
    const { createHmac } = require('crypto');
    const secret = process.env.NEXTAUTH_SECRET || 'dev-secret';
    const b64url = (buf) => buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    const makeJwt = (sub, email, sec) => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
      const now = Math.floor(Date.now() / 1000);
      const payload = b64url(Buffer.from(JSON.stringify({ sub, email, iat: now, exp: now + 3600 })));
      const data = `${header}.${payload}`;
      const sig = b64url(createHmac('sha256', sec).update(data).digest());
      return `${data}.${sig}`;
    };
    const token = makeJwt('refpdf-existing@local', 'refpdf-existing@local', secret);

    // Read the test files
    const fs = require('fs');
    const path = require('path');
    const msczPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mscz');
    const msczBuffer = fs.readFileSync(msczPath);

    let pdfBuffer = null;
    if (localPdfPath) {
      if (!fs.existsSync(localPdfPath)) {
        test.skip(`IMSLP_TEST_PDF_PATH not found: ${localPdfPath}`);
      }
      pdfBuffer = fs.readFileSync(localPdfPath);
    } else {
      const rawResp = await request.get(`${PUBLIC_API}/imslp/works/${encodeURIComponent(workId)}/raw`);
      expect(rawResp.ok()).toBeTruthy();
      const raw = await rawResp.json();
      const meta = raw?.metadata || {};
      const files = Array.isArray(meta.files) ? meta.files : [];
      const pdfFiles = files
        .filter((f) => {
          const mime = String(f.mime_type || '').toLowerCase();
          const name = String(f.name || '').toLowerCase();
          return mime === 'application/pdf' || mime.includes('pdf') || name.endsWith('.pdf');
        })
        .sort((a, b) => Number(a.size || 0) - Number(b.size || 0));
      expect(pdfFiles.length).toBeGreaterThan(0);
      const pdfMeta = pdfFiles[0];
      const downloadUrl =
        (pdfMeta.download_urls && (pdfMeta.download_urls.direct || pdfMeta.download_urls.https || pdfMeta.download_urls.original)) ||
        pdfMeta.url;
      expect(downloadUrl).toBeTruthy();

      const pdfResp = await request.get(downloadUrl, { timeout: 60000 });
      expect(pdfResp.ok()).toBeTruthy();
      pdfBuffer = await pdfResp.body();
    }

    await request.post(`${PUBLIC_API}/imslp/works/${encodeURIComponent(workId)}/refresh`).catch(() => undefined);

    // Upload source WITHOUT reference PDF
    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - reference PDF existing source',
        file: {
          name: 'test_score_no_ref.mscz',
          mimeType: 'application/vnd.musescore.mscz',
          buffer: msczBuffer
        }
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!uploadResp.ok()) {
      const body = await uploadResp.text();
      throw new Error(`Source upload failed (${uploadResp.status()}): ${body}`);
    }
    const uploadJson = await uploadResp.json();
    const sourceId = uploadJson.sourceId;
    expect(sourceId).toBeTruthy();

    // Wait for derivative processing to complete
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Upload reference PDF to existing source
    const refResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}/reference.pdf`, {
      multipart: {
        referencePdf: {
          name: 'reference.pdf',
          mimeType: 'application/pdf',
          buffer: pdfBuffer
        }
      },
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!refResp.ok()) {
      const body = await refResp.text();
      const skippable =
        body.includes('IMSLP metadata not available') ||
        body.includes('No PDF files found in IMSLP metadata') ||
        body.includes('does not match any IMSLP source');
      if (skippable) {
        test.skip(`Reference PDF upload skipped: ${body}`);
      }
      throw new Error(`Reference PDF upload failed (${refResp.status()}): ${body}`);
    }

    // Verify source has hasReferencePdf flag
    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(detailResp.ok()).toBeTruthy();
    const detail = await detailResp.json();
    const source = detail.sources.find(s => s.sourceId === sourceId);
    expect(source).toBeTruthy();
    expect(source.hasReferencePdf).toBe(true);
    expect(source.derivatives.referencePdf).toBeTruthy();

    // Quick UI sanity: ensure work page loads
    await page.goto(`${BASE_URL}/works/${encodeURIComponent(workId)}?source=${encodeURIComponent(sourceId)}`);
    await page.waitForSelector('[data-testid="source-card-body"]', { timeout: 15000 });

    // Cleanup
    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  });
});
