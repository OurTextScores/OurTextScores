#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const API_BASE = process.env.API_BASE || 'http://localhost:4000/api';
const NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET || 'dev-secret';
const PROJECT_TITLE = process.env.PROJECT_TITLE || 'DCMLab Mozart Sonatas';
const PROJECT_DESCRIPTION =
  process.env.PROJECT_DESCRIPTION ||
  'Imported from DCMLab schema_annotation_data/data/mozart_sonatas/mscore';
const WORKDIR = process.env.WORKDIR || '/tmp/dcmlab_mozart_sonatas_import';
const SUMMARY_PATH =
  process.env.SUMMARY_PATH || path.join(WORKDIR, `summary-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const SOURCE_LICENSE = process.env.SOURCE_LICENSE || 'Public Domain';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(message, details) {
  const ts = new Date().toISOString();
  if (details === undefined) {
    console.log(`[${ts}] ${message}`);
  } else {
    console.log(`[${ts}] ${message} ${JSON.stringify(details)}`);
  }
}

function makeBearerToken(secret) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'seed-script',
      email: 'seed-script@example.com',
      name: 'Seed Script',
      exp: Math.floor(Date.now() / 1000) + 24 * 60 * 60
    })
  ).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} ${res.statusText} for ${url}`);
    err.response = body;
    throw err;
  }
  return body;
}

function normalizeImslpUrl(url) {
  if (!url) return url;
  let normalized = String(url).trim();
  if (normalized.startsWith('//')) normalized = `https:${normalized}`;
  return normalized;
}

function normalizeFileTitleForMatch(value) {
  return String(value || '')
    .replace(/^File:/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseKFromFilename(filename) {
  const m = /^K(\d+)-(\d+)\.mscx$/i.exec(filename);
  if (!m) return null;
  return { k: String(Number.parseInt(m[1], 10)), movement: Number.parseInt(m[2], 10) };
}

function parseKFromImslpUrl(url) {
  const decoded = decodeURIComponent(url);
  const m = /K\.?\s*(\d+)/i.exec(decoded);
  if (!m) return null;
  return String(Number.parseInt(m[1], 10));
}

function parseSonataNoFromImslpUrl(url) {
  const decoded = decodeURIComponent(url);
  const m = /Piano_Sonata_No\.(\d+)/i.exec(decoded);
  if (!m) return null;
  return Number.parseInt(m[1], 10);
}

function isLikelyPdf(file) {
  const name = String(file?.name || '').toLowerCase();
  const url = String(file?.url || file?.download_urls?.direct || '').toLowerCase();
  return name.endsWith('.pdf') || url.endsWith('.pdf');
}

function scoreReferenceCandidate(file, kNumber) {
  const text = `${file?.name || ''} ${file?.title || ''}`.toLowerCase();

  if (!isLikelyPdf(file)) return -10_000;

  // Hard excludes: arrangements/transcriptions/instrument parts/non-piano artifacts.
  const hardExclude = [
    'arrang',
    'transcri',
    'streichtrio',
    'for guitar',
    'guitar',
    'violin',
    'viola',
    'violoncello',
    'cello',
    'vl1',
    'vl2',
    'va',
    'vc',
    'cb',
    'duo',
    'trio',
    'accomp',
    'easiest',
    'xml',
    '.zip',
    '.mp3'
  ];
  if (hardExclude.some((token) => text.includes(token))) return -9_000;

  // Prefer non-manuscript/non-first-edition when possible.
  if (text.includes('autograph') || text.includes('manuscript')) return -5_000;

  let score = 0;

  // Strong positives.
  if (text.includes('nma')) score += 200;
  if (text.includes('barenreiter') || text.includes('bärenreiter')) score += 170;
  if (text.includes('urtext')) score += 150;
  if (text.includes('mozarteum')) score += 130;
  if (text.includes('kv')) score += 30;
  if (text.includes(`k${kNumber}`) || text.includes(`k ${kNumber}`)) score += 40;
  if (text.includes('scan')) score += 10;

  // Penalties for likely first editions or very old editions.
  if (text.includes('first edition')) score -= 120;
  if (text.includes('breitkopf')) score -= 60;
  if (text.includes('andré') || text.includes('andre')) score -= 60;
  if (text.includes('schirmer')) score -= 40;
  if (text.includes('durand')) score -= 40;

  // Tiny penalty for "vorwort" (preface) because we want score pages.
  if (text.includes('vorwort')) score -= 80;

  const size = Number(file?.size || 0);
  score += Math.min(40, Math.floor(size / 200_000)); // prefer non-trivial page scans

  return score;
}

function pickReferencePdf(files, kNumber) {
  const scored = files
    .map((f) => ({ file: f, score: scoreReferenceCandidate(f, kNumber) }))
    .filter((x) => x.score > -8_000)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    const fallback = files.find((f) => isLikelyPdf(f));
    if (!fallback) return null;
    return { file: fallback, score: -999, reason: 'fallback-first-pdf' };
  }
  return { file: scored[0].file, score: scored[0].score, reason: 'heuristic-best' };
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed download ${url}: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, buf);
  return { size: buf.length, contentType: res.headers.get('content-type') || undefined };
}

function buildImageIndexMapFromWorkHtml(html) {
  const map = new Map();
  const blockRegex =
    /<div id="IMSLP(\d+)"[\s\S]*?<span class="hidden"><a [^>]*title="([^"]+)"/gi;
  let m;
  while ((m = blockRegex.exec(html)) !== null) {
    const imageIndexId = m[1];
    const hiddenTitle = m[2];
    const key = normalizeFileTitleForMatch(hiddenTitle);
    if (key && !map.has(key)) {
      map.set(key, imageIndexId);
    }
  }
  return map;
}

async function downloadImslpPdfViaImageIndex({ imageIndexId, expectedSha1, workPageUrl, outPath }) {
  const specialUrl = `https://imslp.org/wiki/Special:ImagefromIndex/${imageIndexId}`;
  const first = await fetch(specialUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (OurTextScores importer)',
      Cookie: 'redirectPassed=1; imslp_wikiLanguageSelectorLanguage=en; imslpdisclaimeraccepted=yes',
      Referer: workPageUrl
    },
    redirect: 'follow'
  });
  const firstText = await first.text();

  // Usually we land on imslp.eu/linkhandler.php HTML that contains the true file href.
  let pdfUrl = null;
  const hrefMatch = firstText.match(/href="([^"]*\/files\/imglnks\/[^"]+\.pdf[^"]*)"/i);
  if (hrefMatch) {
    pdfUrl = new URL(hrefMatch[1], first.url).toString();
  } else if (first.url.toLowerCase().includes('/files/imglnks/') && first.url.toLowerCase().endsWith('.pdf')) {
    pdfUrl = first.url;
  }

  if (!pdfUrl) {
    throw new Error(`Could not derive IMSLP file URL from Special:ImagefromIndex/${imageIndexId}`);
  }

  const second = await fetch(pdfUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (OurTextScores importer)',
      Referer: workPageUrl
    },
    redirect: 'follow'
  });
  if (!second.ok) {
    throw new Error(`Failed IMSLP file download ${pdfUrl}: ${second.status} ${second.statusText}`);
  }

  const buf = Buffer.from(await second.arrayBuffer());
  if (buf.length < 1024 || !buf.slice(0, 8).toString('utf8').includes('%PDF')) {
    throw new Error(`Downloaded payload is not a valid PDF for imageIndexId=${imageIndexId}`);
  }

  const sha1 = crypto.createHash('sha1').update(buf).digest('hex');
  if (expectedSha1 && sha1.toLowerCase() !== String(expectedSha1).toLowerCase()) {
    throw new Error(
      `SHA1 mismatch for imageIndexId=${imageIndexId}; expected ${expectedSha1}, got ${sha1}`
    );
  }

  await ensureDir(path.dirname(outPath));
  await fs.writeFile(outPath, buf);
  return { bytes: buf.length, sha1, pdfUrl };
}

async function getOrCreateProject(token) {
  const listing = await fetchJson(
    `${API_BASE}/projects?limit=200&offset=0&q=${encodeURIComponent(PROJECT_TITLE)}`
  );
  const existing = (listing?.projects || []).find((p) => p.title === PROJECT_TITLE);
  if (existing) return existing;

  const created = await fetchJson(`${API_BASE}/projects`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      title: PROJECT_TITLE,
      description: PROJECT_DESCRIPTION
    })
  });
  return created;
}

async function listProjectSources(projectId) {
  const sources = [];
  let offset = 0;
  while (true) {
    const page = await fetchJson(`${API_BASE}/projects/${projectId}/sources?limit=100&offset=${offset}`);
    const rows = page?.sources || [];
    sources.push(...rows);
    if (rows.length < 100) break;
    offset += 100;
  }
  return sources;
}

async function uploadSource({ token, projectId, sourcePath, sourceName, imslpUrl, label, referencePdfPath, notes }) {
  const sourceBytes = await fs.readFile(sourcePath);
  const refBytes = await fs.readFile(referencePdfPath);
  const form = new FormData();
  form.append('file', new File([sourceBytes], sourceName, { type: 'application/xml' }));
  form.append('referencePdf', new File([refBytes], path.basename(referencePdfPath), { type: 'application/pdf' }));
  form.append('imslpUrl', imslpUrl);
  form.append('label', label);
  form.append('sourceType', 'score');
  form.append('license', SOURCE_LICENSE);
  if (notes) form.append('description', notes);

  const res = await fetch(`${API_BASE}/projects/${projectId}/sources`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'x-progress-id': crypto.randomUUID()
    },
    body: form
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Upload failed (${res.status}) for ${sourceName}`);
    err.response = body;
    throw err;
  }
  return body;
}

async function main() {
  await ensureDir(WORKDIR);
  await ensureDir(path.join(WORKDIR, 'sources'));
  await ensureDir(path.join(WORKDIR, 'refs'));

  const token = makeBearerToken(NEXTAUTH_SECRET);
  const summary = {
    startedAt: new Date().toISOString(),
    apiBase: API_BASE,
    projectTitle: PROJECT_TITLE,
    projectId: null,
    sourceLicense: SOURCE_LICENSE,
    dcmlabFiles: [],
    imslpLinks: [],
    workMap: {},
    referenceChoices: {},
    uploads: [],
    skipped: [],
    errors: []
  };

  log('Fetching DCMLab file list');
  const dcmlabList = await fetchJson(
    'https://api.github.com/repos/DCMLab/schema_annotation_data/contents/data/mozart_sonatas/mscore'
  );
  const files = dcmlabList
    .filter((x) => x.type === 'file' && x.name.toLowerCase().endsWith('.mscx'))
    .map((x) => ({
      name: x.name,
      downloadUrl: x.download_url,
      parsed: parseKFromFilename(x.name)
    }))
    .filter((x) => x.parsed)
    .sort((a, b) => {
      const ka = Number.parseInt(a.parsed.k, 10);
      const kb = Number.parseInt(b.parsed.k, 10);
      if (ka !== kb) return ka - kb;
      return a.parsed.movement - b.parsed.movement;
    });
  summary.dcmlabFiles = files.map((f) => f.name);
  log('DCMLab files loaded', { count: files.length });

  log('Fetching IMSLP sonata links from Sonata No.1 page');
  const firstPageHtml = await (await fetch(
    'https://imslp.org/wiki/Piano_Sonata_No.1_in_C_major%2C_K.279%2F189d_(Mozart%2C_Wolfgang_Amadeus)'
  )).text();
  const linkMatches = Array.from(
    firstPageHtml.matchAll(/\/wiki\/Piano_Sonata_No\.[0-9]+[^"'# ]*\(Mozart,_Wolfgang_Amadeus\)/g)
  ).map((m) => `https://imslp.org${m[0]}`);
  const uniqueLinks = Array.from(new Set(linkMatches)).sort((a, b) => {
    const na = parseSonataNoFromImslpUrl(a) ?? 999;
    const nb = parseSonataNoFromImslpUrl(b) ?? 999;
    return na - nb;
  });
  summary.imslpLinks = uniqueLinks;
  log('IMSLP links extracted', { count: uniqueLinks.length });

  const kToImslp = new Map();
  for (const link of uniqueLinks) {
    const k = parseKFromImslpUrl(link);
    if (k) kToImslp.set(k, link);
  }

  const requiredKs = Array.from(new Set(files.map((f) => f.parsed.k))).sort((a, b) => Number(a) - Number(b));
  const missingK = requiredKs.filter((k) => !kToImslp.has(k));
  if (missingK.length > 0) {
    throw new Error(`Could not map K numbers to IMSLP URLs: ${missingK.join(', ')}`);
  }

  log('Creating/finding project');
  const project = await getOrCreateProject(token);
  summary.projectId = project.projectId;
  summary.projectSlug = project.slug;
  log('Project ready', { projectId: project.projectId, slug: project.slug });

  const existingSources = await listProjectSources(project.projectId);
  const existingByFilename = new Set(existingSources.map((s) => s.originalFilename));
  log('Existing sources in project', { count: existingSources.length });

  // Prepare reference PDFs per K number.
  for (const k of requiredKs) {
    const imslpUrl = kToImslp.get(k);
    log('Ensuring IMSLP metadata', { k, imslpUrl });
    const ensured = await fetchJson(`${API_BASE}/imslp/by-url`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: imslpUrl })
    });
    const workId = ensured?.workId || ensured?.metadata?.workId;
    if (!workId) {
      throw new Error(`No workId returned for IMSLP URL: ${imslpUrl}`);
    }
    summary.workMap[k] = { imslpUrl, workId };

    const raw = await fetchJson(`${API_BASE}/imslp/works/${workId}/raw`);
    const rawFiles = raw?.metadata?.files || [];
    const picked = pickReferencePdf(rawFiles, k);
    if (!picked) {
      throw new Error(`No usable PDF reference candidate for K${k} (workId ${workId})`);
    }
    const workHtml = await (await fetch(imslpUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (OurTextScores importer)' } })).text();
    const imageIndexMap = buildImageIndexMapFromWorkHtml(workHtml);
    const pickedName = String(picked.file?.name || '').replace(/^File:/i, '');
    const pickedKey = normalizeFileTitleForMatch(pickedName);
    const imageIndexId = imageIndexMap.get(pickedKey);
    if (!imageIndexId) {
      throw new Error(`Could not resolve image index for chosen PDF ${picked.file?.name} (K${k})`);
    }

    const refPath = path.join(
      WORKDIR,
      'refs',
      `K${k}-${pickedName.replace(/[^\w.\-]+/g, '_')}`
    );
    const dl = await downloadImslpPdfViaImageIndex({
      imageIndexId,
      expectedSha1: picked.file?.sha1,
      workPageUrl: imslpUrl,
      outPath: refPath
    });

    summary.referenceChoices[k] = {
      workId,
      imslpUrl,
      pickedFileName: picked.file?.name,
      pickedFileSha1: picked.file?.sha1,
      pickedReason: picked.reason,
      pickedScore: picked.score,
      pickedImageIndexId: imageIndexId,
      pickedUrl: dl.pdfUrl,
      localPath: refPath,
      localBytes: dl.bytes,
      localSha1: dl.sha1
    };
    log('Reference PDF selected', {
      k,
      workId,
      picked: picked.file?.name,
      score: picked.score,
      bytes: dl.bytes,
      imageIndexId
    });
    await sleep(200);
  }

  for (const entry of files) {
    const { name, downloadUrl, parsed } = entry;
    if (existingByFilename.has(name)) {
      summary.skipped.push({ name, reason: 'already_exists_in_project' });
      log('Skipping existing source', { name });
      continue;
    }

    const sourcePath = path.join(WORKDIR, 'sources', name);
    await downloadToFile(downloadUrl, sourcePath);
    const work = summary.workMap[parsed.k];
    const ref = summary.referenceChoices[parsed.k];

    log('Uploading source', { name, k: parsed.k, movement: parsed.movement, projectId: project.projectId });
    try {
      const result = await uploadSource({
        token,
        projectId: project.projectId,
        sourcePath,
        sourceName: name,
        imslpUrl: work.imslpUrl,
        label: name.replace(/\.mscx$/i, ''),
        referencePdfPath: ref.localPath,
        notes: `DCMLab import (${name}) from ${downloadUrl}`
      });
      summary.uploads.push({
        name,
        k: parsed.k,
        movement: parsed.movement,
        workId: result.workId,
        sourceId: result.sourceId,
        revisionId: result.revisionId,
        imslpUrl: work.imslpUrl,
        referencePdf: ref.pickedFileName
      });
    } catch (error) {
      summary.errors.push({
        name,
        k: parsed.k,
        movement: parsed.movement,
        imslpUrl: work.imslpUrl,
        message: error?.message || String(error),
        response: error?.response
      });
      log('Upload failed', { name, error: error?.message || String(error) });
    }
    await sleep(300);
  }

  summary.completedAt = new Date().toISOString();
  summary.stats = {
    totalFiles: files.length,
    uploaded: summary.uploads.length,
    skipped: summary.skipped.length,
    errors: summary.errors.length,
    worksCovered: Object.keys(summary.workMap).length
  };

  await ensureDir(path.dirname(SUMMARY_PATH));
  await fs.writeFile(SUMMARY_PATH, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  log('Import completed', summary.stats);
  log('Summary written', { path: SUMMARY_PATH });

  if (summary.errors.length > 0) {
    process.exitCode = 2;
  }
}

main().catch(async (error) => {
  log('Fatal error', { message: error?.message || String(error), stack: error?.stack });
  process.exit(1);
});
