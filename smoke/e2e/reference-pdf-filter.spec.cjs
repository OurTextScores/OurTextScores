// @ts-check
const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const PUBLIC_API = process.env.PUBLIC_API || 'http://localhost:4000/api';

test.describe('Reference PDF Filter', () => {
  test('uploads source with reference PDF and verifies filter works', async ({ request, page }) => {
    test.setTimeout(120000);

    const imslpUrl = process.env.IMSLP_TEST_URL || 'https://imslp.org/wiki/Cello_Suite_No.1,_BWV_1007_(Bach,_Johann_Sebastian)';
    const explicitWorkId = process.env.IMSLP_TEST_WORK_ID || '';
    const localPdfPath = process.env.IMSLP_TEST_PDF_PATH || '';
    let work = null;
    let workId = explicitWorkId || null;
    let workTitle = 'Untitled';
    let workComposer = 'Unknown';

    if (workId) {
      const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
      if (detailResp.ok()) {
        const detail = await detailResp.json();
        work = detail;
        workTitle = detail.title || 'Untitled';
        workComposer = detail.composer || 'Unknown';
      } else if (imslpUrl) {
        const ensureResp = await request.post(`${PUBLIC_API}/works/save-by-url`, {
          data: { url: imslpUrl }
        });
        if (ensureResp.ok()) {
          const ensured = await ensureResp.json();
          work = ensured.work;
          workId = work.workId;
          workTitle = work.title || ensured.metadata?.title || 'Untitled';
          workComposer = work.composer || ensured.metadata?.composer || 'Unknown';
        }
      }
    } else {
      const ensureResp = await request.post(`${PUBLIC_API}/works/save-by-url`, {
        data: { url: imslpUrl }
      });
      if (ensureResp.ok()) {
        const ensured = await ensureResp.json();
        work = ensured.work;
        workId = work.workId;
        workTitle = work.title || ensured.metadata?.title || 'Untitled';
        workComposer = work.composer || ensured.metadata?.composer || 'Unknown';
      } else {
        const body = await ensureResp.text();
        console.warn('IMSLP save-by-url failed; attempting cached works fallback.', body);
        const worksResp = await request.get(`${PUBLIC_API}/works`);
        expect(worksResp.ok()).toBeTruthy();
        const works = (await worksResp.json()).works || [];
        for (const candidate of works) {
          const rawResp = await request.get(`${PUBLIC_API}/imslp/works/${encodeURIComponent(candidate.workId)}/raw`);
          if (!rawResp.ok()) continue;
          const raw = await rawResp.json();
          const meta = raw?.metadata || {};
          const files = Array.isArray(meta.files) ? meta.files : [];
          const hasPdf = files.some((f) => {
            const mime = String(f.mime_type || '').toLowerCase();
            const name = String(f.name || '').toLowerCase();
            return mime === 'application/pdf' || mime.includes('pdf') || name.endsWith('.pdf');
          });
          if (hasPdf) {
            work = candidate;
            workId = candidate.workId;
            workTitle = candidate.title || raw?.title || 'Untitled';
            workComposer = candidate.composer || raw?.composer || 'Unknown';
            break;
          }
        }
      }
    }

    if (!workId) {
      test.skip('No IMSLP work with cached PDF metadata available.');
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
    const token = makeJwt('refpdf-test@local', 'refpdf-test@local', secret);

    // Read the test files
    const fs = require('fs');
    const path = require('path');
    const msczPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mscz');
    const msczBuffer = fs.readFileSync(msczPath);

    let pdfBuffer = null;
    if (localPdfPath) {
      const fs = require('fs');
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

    // Upload source with reference PDF
    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - reference PDF filter',
        file: {
          name: 'test_score.mscz',
          mimeType: 'application/vnd.musescore.mscz',
          buffer: msczBuffer
        },
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

    if (!uploadResp.ok()) {
      const body = await uploadResp.text();
      const skippable =
        body.includes('IMSLP metadata not available') ||
        body.includes('No PDF files found in IMSLP metadata') ||
        body.includes('does not match any IMSLP source');
      if (skippable) {
        test.skip(`Reference PDF upload skipped: ${body}`);
      }
      throw new Error(`Reference PDF upload failed (${uploadResp.status()}): ${body}`);
    }
    const uploadJson = await uploadResp.json();
    const sourceId = uploadJson.sourceId;
    expect(sourceId).toBeTruthy();

    // Wait for derivative processing to complete
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify source has hasReferencePdf flag
    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    expect(detailResp.ok()).toBeTruthy();
    const detail = await detailResp.json();
    const source = detail.sources.find(s => s.sourceId === sourceId);
    expect(source).toBeTruthy();
    expect(source.hasReferencePdf).toBe(true);
    expect(source.derivatives.referencePdf).toBeTruthy();

    // Verify work summary has hasReferencePdf flag
    const workSummaryResp = await request.get(`${PUBLIC_API}/works`);
    expect(workSummaryResp.ok()).toBeTruthy();
    const workSummary = (await workSummaryResp.json()).works.find(w => w.workId === workId);
    expect(workSummary).toBeTruthy();
    console.log('Work summary hasReferencePdf:', workSummary.hasReferencePdf);
    expect(workSummary.hasReferencePdf).toBe(true);

    // Test main page without filter - work should appear
    await page.goto(BASE_URL);
    await page.waitForSelector('table tbody tr', { timeout: 10000 });

    // Find the work in the table by title
    console.log('Looking for work:', workTitle, 'by', workComposer);
    const workRowWithoutFilter = page.locator('table tbody tr').filter({
      hasText: workTitle
    }).filter({
      hasText: workComposer
    });
    await expect(workRowWithoutFilter).toBeVisible({ timeout: 5000 });

    // Test main page WITH filter - work should still appear
    const filterCheckbox = page.locator('input[type="checkbox"]').filter({ hasText: /Has reference PDF/i }).or(
      page.locator('label:has-text("Has reference PDF") input[type="checkbox"]')
    );

    await filterCheckbox.check();
    await page.waitForTimeout(1000); // Wait for filter to apply

    // Verify work still appears when filter is checked
    const workRowWithFilter = page.locator('table tbody tr').filter({
      hasText: workTitle
    }).filter({
      hasText: workComposer
    });
    await expect(workRowWithFilter).toBeVisible({ timeout: 5000 });

    // Verify API filter works
    const filteredResp = await request.get(`${PUBLIC_API}/works?filter=hasReferencePdf%20%3D%20true`);
    expect(filteredResp.ok()).toBeTruthy();
    const filteredWorks = (await filteredResp.json()).works;
    console.log('Filtered works count:', filteredWorks.length);
    const filteredWork = filteredWorks.find(w => w.workId === workId);
    console.log('Filtered work found:', filteredWork);
    expect(filteredWork).toBeTruthy();
    console.log('Filtered work hasReferencePdf:', filteredWork.hasReferencePdf);
    expect(filteredWork.hasReferencePdf).toBe(true);

    // Cleanup
    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  });

  test('source without reference PDF does not appear in filtered results', async ({ request, page }) => {
    // Get a work to upload to
    const worksResp = await request.get(`${PUBLIC_API}/works`);
    expect(worksResp.ok()).toBeTruthy();
    const works = (await worksResp.json()).works;
    const workId = works[0].workId;

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
    const token = makeJwt('norefpdf-test@local', 'norefpdf-test@local', secret);

    // Read test file (without reference PDF)
    const fs = require('fs');
    const path = require('path');
    const msczPath = path.join(process.cwd(), 'test_scores', 'bach_orig.mscz');
    const msczBuffer = fs.readFileSync(msczPath);

    // Upload source WITHOUT reference PDF
    const uploadResp = await request.post(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources`, {
      multipart: {
        commitMessage: 'E2E test - no reference PDF',
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

    expect(uploadResp.ok()).toBeTruthy();
    const uploadJson = await uploadResp.json();
    const sourceId = uploadJson.sourceId;

    // Wait for processing
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Verify source does NOT have reference PDF
    const detailResp = await request.get(`${PUBLIC_API}/works/${encodeURIComponent(workId)}`);
    const detail = await detailResp.json();
    const source = detail.sources.find(s => s.sourceId === sourceId);
    expect(source.hasReferencePdf).toBeFalsy();
    expect(source.derivatives.referencePdf).toBeFalsy();

    // Verify work summary does NOT have hasReferencePdf (or it's false)
    const workSummaryResp = await request.get(`${PUBLIC_API}/works`);
    const workSummary = (await workSummaryResp.json()).works.find(w => w.workId === workId);
    // Note: hasReferencePdf might be true if another source has a reference PDF
    // So we can't assert it's false here

    // Test that work DOES NOT appear in filtered results
    const filteredResp = await request.get(`${PUBLIC_API}/works?filter=hasReferencePdf%20%3D%20true`);
    expect(filteredResp.ok()).toBeTruthy();
    const filteredWorks = (await filteredResp.json()).works;

    // If the work appears in filtered results, it must be because another source has a reference PDF
    const filteredWork = filteredWorks.find(w => w.workId === workId);
    if (filteredWork) {
      // Verify at least one source in the work has a reference PDF
      const allSourcesHaveNoRef = detail.sources.every(s => !s.hasReferencePdf);
      expect(allSourcesHaveNoRef).toBe(false);
    }

    // Cleanup
    await request.delete(`${PUBLIC_API}/works/${encodeURIComponent(workId)}/sources/${encodeURIComponent(sourceId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
  });
});
