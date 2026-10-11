import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DEMO, tokenFor } from './demo.mjs';
import { CATALOGUE, entry } from './catalogue.mjs';

/**
 * Fills the demo site through the same API the site's own pages call, so every thumbnail, PDF
 * and converted format on film came out of the real pipeline.
 *
 * It can be run again at any time: each step first looks for what it would make and leaves it
 * alone if it is there. `stack.mjs reset` followed by `up` and `seed` gives a clean site.
 */
const ASSETS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../assets');

const CONTENT_TYPES = {
  '.mscz': 'application/vnd.musescore.mscz',
  '.mxl': 'application/vnd.recordare.musicxml',
  '.musicxml': 'application/xml',
  '.xml': 'application/xml',
};

export async function api(method, route, { as = null, json = undefined, form = undefined, raw = false } = {}) {
  const headers = {};
  if (as) headers.Authorization = `Bearer ${tokenFor(as)}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${DEMO.api}${route}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : form,
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  if (raw) return response;
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${route} → ${response.status}: ${text.slice(0, 400)}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function fileForm(file, fields = {}, name = null) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) if (value !== undefined && value !== null) form.append(key, String(value));
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  form.append('file', new Blob([readFileSync(file)], { type }), name ?? path.basename(file));
  return form;
}

const log = (line) => console.log(line);

/**
 * Signs a person in the way the sign-in page does: ask for a link, read it from the demo
 * Mailpit, follow it. Returns the session cookies. The site only grants the maintainer's
 * rights on a sign-in, so that account has to arrive this way before anything else uses it.
 */
export async function signInCookies(person) {
  const jar = new Map();
  const keep = (response) => {
    for (const cookie of response.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const at = pair.indexOf('=');
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
  };
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');

  const csrf = await fetch(`${DEMO.site}/api/auth/csrf`);
  keep(csrf);
  const { csrfToken } = await csrf.json();
  const asked = Date.now();
  const request = await fetch(`${DEMO.site}/api/auth/signin/email`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader() },
    body: new URLSearchParams({ csrfToken, email: person.email, callbackUrl: `${DEMO.site}/`, json: 'true' }),
  });
  keep(request);
  if (request.status >= 400) throw new Error(`sign-in request for ${person.email} failed (${request.status})`);

  let link = null;
  for (let attempt = 0; attempt < 40 && !link; attempt++) {
    const list = await (await fetch(`${DEMO.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${person.email}`)}&limit=5`)).json();
    for (const message of list.messages ?? []) {
      if (new Date(message.Created).getTime() < asked - 5000) continue;
      const body = await (await fetch(`${DEMO.mailpit}/api/v1/message/${message.ID}`)).json();
      const match = (body.Text || '').match(/(http\S+\/api\/auth\/callback\/email\S*)/);
      if (match) link = match[1];
    }
    if (!link) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!link) throw new Error(`no sign-in mail arrived for ${person.email}`);

  let url = link;
  for (let hop = 0; hop < 6; hop++) {
    const response = await fetch(url, { redirect: 'manual', headers: { Cookie: cookieHeader() } });
    keep(response);
    const next = response.headers.get('location');
    if (!next) break;
    url = new URL(next, url).toString();
  }
  if (![...jar.keys()].some((name) => name.includes('session-token'))) throw new Error(`sign-in for ${person.email} did not produce a session`);
  return [...jar].map(([name, value]) => ({ name, value, url: DEMO.site }));
}

async function people() {
  log('people');
  await signInCookies(DEMO.admin);
  for (const person of [DEMO.admin, ...Object.values(DEMO.people)]) {
    const { user: me } = await api('GET', '/users/me', { as: person });
    if (me.username !== person.username) {
      const result = await api('PATCH', '/users/me', { as: person, json: { username: person.username } });
      if (result.ok === false) throw new Error(`username ${person.username}: ${result.error}`);
    }
    const { user: after } = await api('GET', '/users/me', { as: person });
    person.id = after.id;
    log(`  ${person.username.padEnd(16)} ${(after.roles ?? []).join(',')}`);
    if (person === DEMO.admin && !(after.roles ?? []).includes('admin')) throw new Error('the maintainer account did not get its admin role');
  }
}

async function ensureWork(entry) {
  const work = await api('POST', '/works/save-by-url', { json: { url: entry.imslp } });
  const workId = work.workId ?? work.work?.workId;
  if (!workId) throw new Error(`no work id for ${entry.imslp}: ${JSON.stringify(work).slice(0, 200)}`);
  return workId;
}

async function works() {
  log('works');
  const made = {};
  for (const entry of CATALOGUE) {
    if (entry.filmed) continue; // added on camera
    const workId = await ensureWork(entry);
    let detail = await api('GET', `/works/${workId}`);
    log(`  ${workId.padEnd(8)} ${detail.composer ?? '?'} — ${detail.title ?? '?'}`);
    for (const source of entry.sources) {
      let found = detail.sources.find((item) => item.label === source.label);
      if (!found) {
        const by = DEMO.people[source.by] ?? DEMO.admin;
        const result = await api('POST', `/works/${workId}/sources`, {
          as: by,
          form: fileForm(path.join(ASSETS, source.file), {
            label: source.label,
            description: source.description,
            license: 'CC0',
            licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
            licenseAttribution: source.attribution,
            rightsDeclarationAccepted: true,
            commitMessage: 'Initial upload',
          }),
        });
        detail = await api('GET', `/works/${workId}`);
        found = detail.sources.find((item) => item.sourceId === result.sourceId);
        log(`           + ${source.label}`);
      }
      if (source.verified && !found.adminVerified) {
        await api('POST', `/works/${workId}/sources/${found.sourceId}/verify`, { as: DEMO.admin, json: { note: 'Checked against the first edition.' } });
        log(`             verified`);
      }
      made[source.key ?? source.label] = { workId, sourceId: found.sourceId };
    }
  }
  return made;
}

/** The latest canonical MusicXML of a source, as text. */
async function canonicalXml(workId, sourceId) {
  const response = await api('GET', `/works/${workId}/sources/${sourceId}/canonical.xml`, { raw: true });
  if (!response.ok) throw new Error(`canonical.xml for ${sourceId}: ${response.status}`);
  return response.text();
}

/**
 * Returns `xml` with a dynamic marking at the start of a bar of the first part. Used to make a
 * revision that differs from the original in a small, visible way.
 */
export function withDynamic(xml, measure, mark, { replace = null } = {}) {
  const partStart = xml.indexOf('<part id=');
  const partEnd = xml.indexOf('</part>', partStart);
  const part = xml.slice(partStart, partEnd);
  const at = part.search(new RegExp(`<measure[^>]*number="${measure}"`));
  if (at < 0) throw new Error(`no bar ${measure}`);
  const end = part.indexOf('</measure>', at);
  let bar = part.slice(at, end);
  if (replace) {
    if (!bar.includes(`<${replace}/>`)) throw new Error(`bar ${measure} has no ${replace} to replace`);
    bar = bar.replace(`<${replace}/>`, `<${mark}/>`);
  } else {
    const note = bar.indexOf('<note');
    const direction = `<direction placement="above"><direction-type><dynamics><${mark}/></dynamics></direction-type></direction>\n      `;
    bar = bar.slice(0, note) + direction + bar.slice(note);
  }
  return xml.slice(0, partStart) + part.slice(0, at) + bar + part.slice(end) + xml.slice(partEnd);
}

function xmlForm(xml, name, fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append('file', new Blob([xml], { type: 'application/xml' }), name);
  return form;
}

export const REVIEW = {
  branch: 'editorial-dynamics',
  title: 'Editorial dynamics',
  question: 'Is this p in the first edition, or is it editorial? After the mf at the start, mp might sit better.',
  answer: 'Editorial. I have changed it to mp in the second round.',
};

/**
 * The collaboration the "Improve together" scene opens on: Felix proposes two dynamics for
 * Clara's transcription on a branch, Clara opens the change review and asks about one, Felix
 * answers and uploads a second round.
 */
async function review() {
  log('change review');
  const { clara, felix } = DEMO.people;
  const work = await api('GET', `/works/${await ensureWork(entry('dichterliebe'))}`);
  const source = work.sources.find((item) => item.label === 'Die Rose, die Lilie');
  if (!source) throw new Error('seed the works first');
  const { workId } = work;
  const { sourceId } = source;
  const base = `/works/${workId}/sources/${sourceId}`;

  const { branches = [] } = await api('GET', `${base}/branches`);
  if (!branches.some((branch) => branch.name === REVIEW.branch)) {
    await api('POST', `${base}/branches`, { as: felix, json: { name: REVIEW.branch, policy: 'public', baseRevisionId: source.latestRevisionId } });
    log(`  branch ${REVIEW.branch}`);
  }

  const revisionsOnBranch = async () =>
    (await api('GET', `/works/${workId}`, { as: felix })).sources
      .find((item) => item.sourceId === sourceId)
      .revisions.filter((revision) => revision.fossilBranch === REVIEW.branch);
  const upload = (xml, message) =>
    api('POST', `${base}/revisions`, {
      as: felix,
      form: xmlForm(xml, 'die-rose-die-lilie.musicxml', {
        branchName: REVIEW.branch,
        commitMessage: message,
        license: 'CC0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
        rightsDeclarationAccepted: true,
      }),
    });

  const original = await canonicalXml(workId, sourceId);
  const first = withDynamic(withDynamic(original, 5, 'p'), 13, 'f');
  if ((await revisionsOnBranch()).length === 0) {
    await upload(first, 'Add editorial dynamics in bars 5 and 13');
    log('  round 1 uploaded');
  }

  const list = await api('GET', `/change-reviews?limit=50`, { as: clara });
  const all = [...(list.needsResponse ?? []), ...(list.open ?? []), ...(list.items ?? []), ...(list.reviews ?? [])];
  let detail = all.find((item) => item.sourceId === sourceId && item.branchName === REVIEW.branch);
  if (!detail) {
    detail = await api('POST', `${base}/branches/${REVIEW.branch}/change-review`, { as: clara, json: { title: REVIEW.title } });
    log(`  review opened by ${clara.username}`);
  }
  const reviewId = detail.reviewId ?? detail.review?.reviewId;

  const diff = await api('GET', `/change-reviews/${reviewId}/diff`, { as: clara });
  if ((diff.threads ?? []).length === 0) {
    const region = diff.scoreRegions.find((item) => item.headMeasureNumber === '5' && item.commentable);
    if (!region) throw new Error('the review has no commentable change in bar 5');
    const made = await api('POST', `/change-reviews/${reviewId}/threads`, { as: clara, json: { anchorId: region.anchorId, content: REVIEW.question } });
    const threadId = made.threadId ?? made.thread?.threadId ?? made.threads?.at(-1)?.threadId;
    if (!threadId) throw new Error(`no thread id in ${JSON.stringify(made).slice(0, 300)}`);
    await api('POST', `/change-reviews/${reviewId}/threads/${threadId}/comments`, { as: felix, json: { content: REVIEW.answer } });
    log('  question and answer on bar 5');
  }
  if ((await revisionsOnBranch()).length < 2) {
    await upload(withDynamic(first, 5, 'mp', { replace: 'p' }), 'Bar 5: mp instead of p, after review');
    log('  round 2 uploaded');
  }
  return { workId, sourceId, reviewId };
}

export const PROJECT = {
  title: 'Dichterliebe, complete',
  description: 'All sixteen songs of Schumann’s Dichterliebe as editable scores, each checked against the first edition.',
};

/** A project that gathers the Dichterliebe sources. */
async function project() {
  log('project');
  const { clara, felix } = DEMO.people;
  const ids = {};
  for (const person of [DEMO.admin, clara, felix]) ids[person.username] = (await api('GET', '/users/me', { as: person })).user.id;

  const listed = await api('GET', '/projects?limit=50', { as: DEMO.admin });
  const existing = (listed.projects ?? listed.items ?? []).find((item) => item.title === PROJECT.title);
  const made =
    existing ??
    (await api('POST', '/projects', {
      as: DEMO.admin,
      json: { title: PROJECT.title, description: PROJECT.description, visibility: 'public', memberUserIds: [ids[clara.username], ids[felix.username]] },
    }));
  const projectId = made.projectId ?? made.project?.projectId;
  if (!projectId) throw new Error(`no project id in ${JSON.stringify(made).slice(0, 300)}`);
  if (!existing) log(`  ${PROJECT.title}`);

  const work = await api('GET', `/works/${await ensureWork(entry('dichterliebe'))}`);
  const linked = await api('GET', `/projects/${projectId}/sources?limit=50`, { as: DEMO.admin });
  const linkedIds = new Set((linked.sources ?? linked.items ?? []).map((item) => item.sourceId));
  for (const source of work.sources) {
    if (linkedIds.has(source.sourceId)) continue;
    await api('POST', `/projects/${projectId}/sources/link`, { as: DEMO.admin, json: { sourceId: source.sourceId, workId: work.workId } });
    log(`  linked ${source.label}`);
  }

  // Rows (candidate scores) are not shown on the project page, so the demo has none; remove
  // any left by an earlier version of this seed.
  const rows = await api('GET', `/projects/${projectId}/rows?limit=50`, { as: DEMO.admin });
  for (const row of rows.rows ?? rows.items ?? []) {
    await api('DELETE', `/projects/${projectId}/rows/${row.rowId}`, { as: DEMO.admin });
    log(`  removed row ${row.notes ?? row.rowId}`);
  }
  return { projectId };
}

const STEPS = { people, works, review, project };

export async function seed({ only = [] } = {}) {
  const names = only.length ? only : Object.keys(STEPS);
  for (const name of names) {
    if (!STEPS[name]) throw new Error(`no seed step "${name}". Steps: ${Object.keys(STEPS).join(', ')}`);
    await STEPS[name]();
  }
  log('seeded');
}
