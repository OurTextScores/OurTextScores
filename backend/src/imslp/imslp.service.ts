import { Injectable, InternalServerErrorException, Logger, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Model } from 'mongoose';
import { EnsureWorkResult, ImslpWorkDto } from './dto/imslp-work.dto';
import { ImslpWork, ImslpWorkDocument } from './schemas/imslp-work.schema';

const execFileAsync = promisify(execFile);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Injectable()
export class ImslpService {
  private readonly logger = new Logger(ImslpService.name);

  constructor(
    @InjectModel(ImslpWork.name)
    private readonly imslpModel: Model<ImslpWorkDocument>
  ) {}

  async search(query: string, limit = 10): Promise<ImslpWorkDto[]> {
    const trimmed = query?.trim();
    if (!trimmed) {
      return [];
    }

    const regex = new RegExp(escapeRegex(trimmed), 'i');
    const docs = await this.imslpModel
      .find({
        $or: [
          { workId: regex },
          { title: regex },
          { composer: regex },
          { permalink: regex },
          { 'musical_metadata.composer': regex },
          { 'basic_info.page_title': regex },
          { 'metadata.intvals.worktitle': regex },
          { 'metadata.intvals.composer': regex }
        ]
      })
      .limit(Math.max(1, Math.min(limit, 25)))
      .lean()
      .exec();

    return docs.map((doc) => this.toDto(doc));
  }

  async ensureByWorkId(workId: string): Promise<EnsureWorkResult> {
    const doc = (await this.imslpModel.findOne({ workId }).lean().exec()) as
      | (ImslpWork & { metadata?: Record<string, unknown> })
      | null;

    if (!doc) {
      throw new NotFoundException(`IMSLP metadata not found for work ${workId}`);
    }

    return {
      workId,
      metadata: this.toDto(doc)
    };
  }

  async ensureByPermalink(permalink: string): Promise<EnsureWorkResult> {
    const normalized = this.normalizePermalink(permalink);

    // Try a lightweight MediaWiki API scrape first to obtain numeric page_id and persist it
    let direct = await this.fetchFromMediaWiki(normalized).catch(() => null);

    // If direct fetch failed, check if we already have a record by permalink
    let doc = (await this.imslpModel
      .findOne({ permalink: normalized })
      .lean()
      .exec()) as (ImslpWork & { metadata?: Record<string, unknown> }) | null;

    // If we didn't have a doc, try MWClient enrichment (may be richer but slower)
    if (!direct) {
      const enriched = await this.fetchViaMwClient(normalized).catch(() => null);
      if (enriched) {
        doc = enriched;
      }
    } else {
      // We have numeric direct data persisted; prefer that as our baseline doc
      doc = direct;
    }

    // If we still don't have a stored doc, attempt one more lightweight fallback
    if (!doc) {
      doc = await this.fetchAndStoreFromExternal(normalized);
    }

    if (!doc) {
      throw new NotFoundException(`Unable to resolve IMSLP permalink ${normalized}`);
    }

    // If the stored doc uses a non-numeric workId, attempt to canonicalize it using the permalink's numeric page id
    const hasNumericId = /^\d+$/.test(String(doc.workId));
    if (!hasNumericId) {
      const pageId = await this.resolvePageIdFromUrl(normalized).catch(() => null);
      if (pageId && /^\d+$/.test(pageId)) {
        await this.imslpModel
          .updateOne({ permalink: normalized }, { $set: { workId: pageId } }, { upsert: false })
          .exec()
          .catch(() => undefined);
        doc = (await this.imslpModel.findOne({ workId: pageId }).lean().exec()) as
          | (ImslpWork & { metadata?: Record<string, unknown> })
          | null;
      }
    }

    if (!doc) {
      throw new NotFoundException(`Unable to resolve IMSLP permalink ${normalized}`);
    }

    // Ensure we have basic_info in stored metadata; if missing, try to enrich via MWClient then API
    const meta = (doc.metadata as Record<string, unknown>) ?? {};
    if (!('basic_info' in meta)) {
      const enriched =
        (await this.fetchViaMwClient(normalized).catch(() => null)) ||
        (await this.enrichViaMediaWikiApi(doc.workId).catch(() => null));
      if (enriched) {
        doc = enriched;
      }
    }

    // If files are missing, try MWClient enrichment once more to populate them
    try {
      const curMeta = (doc.metadata as Record<string, unknown>) ?? {};
      const files = (curMeta['files'] as unknown) as Array<unknown> | undefined;
      if (!Array.isArray(files) || files.length === 0) {
        const enriched = await this.fetchViaMwClient(normalized).catch(() => null);
        if (enriched) {
          doc = enriched;
        }
      }
    } catch {
      // ignore
    }

    return {
      workId: doc.workId,
      metadata: this.toDto(doc)
    };
  }

  private toDto(doc: Partial<ImslpWork>): ImslpWorkDto {
    const metadata = (doc.metadata as Record<string, unknown>) ?? {};
    const basic = (metadata['basic_info'] as Record<string, unknown>) ?? {};
    const workIdRaw = String(doc.workId ?? basic['page_id'] ?? metadata['workId'] ?? '');
    const workId = /^\d+$/.test(workIdRaw) ? workIdRaw : String(basic['page_id'] ?? '');

    let title = doc.title as string | undefined;
    if (!title) {
      title = (metadata['title'] as string) ?? (metadata['page_title'] as string) ?? undefined;
    }

    let composer = doc.composer as string | undefined;
    if (!composer) {
      composer = metadata['composer'] as string;
      if (!composer) {
        const basicInfo = metadata['basic_info'] as Record<string, unknown> | undefined;
        if (basicInfo) {
          composer = basicInfo['composer'] as string;
        }
      }
    }

    const permalink =
      doc.permalink ??
      (metadata['permalink'] as string) ??
      (metadata['url'] as string) ??
      '';

    // Ensure basic_info is present at minimum so the UI can render useful fields
    const mergedMeta: Record<string, unknown> = { ...metadata };
    if (!mergedMeta['basic_info']) {
      const pageIdValue = workId ? Number.parseInt(workId, 10) : undefined;
      mergedMeta['basic_info'] = {
        page_id: Number.isFinite(pageIdValue as number) ? (pageIdValue as number) : workId || undefined,
        page_title: title != null ? title : workId || undefined,
        composer
      };
    }

    return {
      workId,
      title: title ?? workId,
      composer,
      permalink,
      metadata: mergedMeta
    };
  }

  private normalizePermalink(permalink: string): string {
    const trimmed = permalink.trim();
    if (!trimmed) {
      throw new NotFoundException('Empty IMSLP permalink');
    }

    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      return trimmed;
    }
    if (trimmed.startsWith('www.')) {
      return `https://${trimmed}`;
    }
    if (trimmed.startsWith('/')) {
      return `https://imslp.org${trimmed}`;
    }
    if (trimmed.startsWith('imslp.org')) {
      return `https://${trimmed}`;
    }

    return `https://imslp.org/wiki/${trimmed}`;
  }

  private async fetchAndStoreFromExternal(
    permalink: string
  ): Promise<(ImslpWork & { metadata?: Record<string, unknown> }) | null> {
    // Downloader strategy: prefer MediaWiki client/scraping; avoid list_works scan entirely
    const downloaderDoc = await this.fetchViaMwClient(permalink).catch((err) => {
      this.logger.warn(`MWClient fetch failed: ${err}`);
      return null;
    });
    if (downloaderDoc) {
      return downloaderDoc;
    }

    // Fallback: lightweight MediaWiki API + HTML existence check
    const direct = await this.fetchFromMediaWiki(permalink).catch((err) => {
      this.logger.warn(`Direct MediaWiki lookup failed: ${err}`);
      return null;
    });
    return direct;
  }

  private extractSlug(permalink: string): string {
    return permalink.split('/wiki/').pop() ?? permalink;
  }

  private async fetchFromMediaWiki(
    permalink: string
  ): Promise<(ImslpWork & { metadata?: Record<string, unknown> }) | null> {
    const slug = this.extractSlug(permalink);
    const script = `
import json
import sys
from urllib.parse import quote, unquote
import requests
headers = {'User-Agent': 'OurTextScores/1.0 (+https://ourtextscores.example)'}
headers = {'User-Agent': 'OurTextScores/1.0 (+https://ourtextscores.example)'}

slug = unquote(sys.argv[1])

url = (
    "https://imslp.org/w/api.php"
    "?action=query&format=json&prop=info&inprop=url&titles=" + quote(slug)
)
r = requests.get(url, headers=headers)
ok = False
pageid = None
title = None
if r.ok:
    try:
        data = r.json()
        pages = data.get('query', {}).get('pages', {})
        if pages:
            page = next(iter(pages.values()))
            if not page.get('missing'):
                ok = True
                pageid = page.get('pageid')
                title = page.get('title')
    except Exception:
        ok = False

if not ok:
    # Fallback: check that the page exists via direct fetch
    page_url = 'https://imslp.org/wiki/' + quote(slug)
    r2 = requests.get(page_url, headers=headers)
    if r2.ok:
        ok = True
        title = slug.replace('_', ' ')
        # Try to extract numeric pageid from HTML (wgArticleId)
        try:
            import re
            m = re.search(r'"wgArticleId"\s*:\s*(\d+)', r2.text)
            if m:
                pageid = int(m.group(1))
        except Exception:
            pageid = None

if not ok:
    sys.exit(1)

payload = {
    'permlink': 'https://imslp.org/wiki/' + slug,
    'id': pageid,
    'title': title,
    'intvals': {
        'worktitle': title,
        'pageid': pageid,
    }
}
print(json.dumps(payload))
`;

    try {
      const { stdout } = await execFileAsync('python3', ['-c', script, slug], {
        maxBuffer: 2 * 1024 * 1024,
        timeout: 15_000
      });

      const payload = JSON.parse(stdout) as Record<string, unknown>;
      const intvals = (payload['intvals'] as Record<string, unknown>) ?? {};
      const idCandidate = String(intvals['pageid'] ?? payload['id'] ?? '');
      if (!/^\d+$/.test(idCandidate)) {
        return null;
      }
      const workId = idCandidate;

      const title = (payload['title'] as string) ?? (intvals['worktitle'] as string) ?? workId;
      const composer = (payload['composer'] as string) ?? undefined;

      const updated = await this.imslpModel
        .findOneAndUpdate(
          { workId },
          {
            workId,
            title,
            composer,
            permalink: `https://imslp.org/wiki/${slug}`,
            metadata: payload
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        )
        .lean()
        .exec();

      return updated ?? null;
    } catch (error) {
      return null;
    }
  }

  async enrichByWorkId(workId: string): Promise<(ImslpWork & { metadata?: Record<string, unknown> }) | null> {
    const existing = (await this.imslpModel.findOne({ workId }).lean().exec()) as
      | (ImslpWork & { metadata?: Record<string, unknown> })
      | null;
    const target = existing?.permalink
      ? (existing.permalink as string)
      : /^\d+$/.test(workId)
        ? workId
        : `https://imslp.org/wiki/${workId}`;
    this.logger.log(`[IMSLP] Enrich start workId=${workId} target=${target}`);
    return this.fetchViaMwClient(target);
  }

  async getRawByWorkId(
    workId: string
  ): Promise<(ImslpWork & { metadata?: Record<string, unknown> }) | null> {
    let doc = (await this.imslpModel.findOne({ workId }).lean().exec()) as
      | (ImslpWork & { metadata?: Record<string, unknown> })
      | null;
    if (!doc) return null;

    const meta = (doc.metadata as Record<string, unknown>) ?? {};
    const hasRich = !!(meta['basic_info'] || meta['files'] || meta['enhanced_metadata']);
    const enhanced = (meta['enhanced_metadata'] as unknown) as Array<Record<string, unknown>> | undefined;
    const hasDownloadCounts = Array.isArray(enhanced) && enhanced.some((e) => e && typeof e === 'object' && 'download_count' in e);

    if (!hasRich || !hasDownloadCounts) {
      const target = doc.permalink
        ? (doc.permalink as string)
        : /^\d+$/.test(workId)
          ? workId
          : `https://imslp.org/wiki/${workId}`;
      const viaMw = await this.fetchViaMwClient(target).catch(() => null);
      if (!viaMw) {
        await this.enrichViaMediaWikiApi(target).catch(() => null);
      }
      doc = (await this.imslpModel.findOne({ workId }).lean().exec()) as
        | (ImslpWork & { metadata?: Record<string, unknown> })
        | null;
    }
    return doc;
  }

  private async enrichViaMediaWikiApi(
    permalinkOrSlugOrId: string
  ): Promise<(ImslpWork & { metadata?: Record<string, unknown> }) | null> {
    const script = `
import json
import sys
import requests
from urllib.parse import quote, unquote
headers = {'User-Agent': 'OurTextScores/1.0 (+https://ourtextscores.example)'}

target = sys.argv[1]
is_numeric = target.isdigit()
slug = target
if target.startswith('http://') or target.startswith('https://'):
    if '/wiki/' in target:
        slug = target.split('/wiki/', 1)[1]
slug = unquote(slug)

def build_meta_from_page(page):
    meta = {
        'basic_info': {
            'page_id': page.get('pageid'),
            'page_title': page.get('title'),
            'url': page.get('fullurl') or page.get('canonicalurl')
        },
        'categories': [],
        'files': [],
        'revision_history': []
    }
    cats = page.get('categories') or []
    for c in cats:
        t = c.get('title')
        if t:
            meta['categories'].append(t)
    revs = page.get('revisions') or []
    for r in revs:
        meta['revision_history'].append({
            'revid': r.get('revid'),
            'user': r.get('user'),
            'timestamp': r.get('timestamp'),
            'comment': r.get('comment')
        })
    return meta

def fetch_imageinfo(titles):
    if not titles:
        return []
    # Limit to 50 to avoid oversized queries
    titles = titles[:50]
    titles_param = '|'.join(titles)
    r = requests.get('https://imslp.org/w/api.php', params={
        'action': 'query',
        'format': 'json',
        'prop': 'imageinfo',
        'iiprop': 'url|size|sha1|mime|timestamp|user|comment',
        'titles': titles_param
    }, headers=headers, timeout=20)
    files = []
    if r.ok:
        data = r.json()
        pages = data.get('query', {}).get('pages', {})
        for p in pages.values():
            ti = p.get('title')
            ii = p.get('imageinfo') or []
            if not ii:
                continue
            info = ii[0]
            files.append({
                'name': ti,
                'title': ti,
                'url': info.get('url'),
                'size': info.get('size'),
                'sha1': info.get('sha1'),
                'mime_type': info.get('mime'),
                'timestamp': info.get('timestamp'),
                'user': info.get('user'),
                'comment': info.get('comment'),
                'download_urls': {
                    'original': info.get('url'),
                    'https': (info.get('url').replace('http:', 'https:') if info.get('url') else None),
                    'direct': info.get('url')
                }
            })
    return files

# Build initial query
params = {
    'action': 'query',
    'format': 'json',
    'prop': 'info|categories|images|revisions',
    'inprop': 'url',
    'rvprop': 'ids|timestamp|user|comment',
    'rvlimit': 5
}
if is_numeric:
    params['pageids'] = target
else:
    params['titles'] = slug

r = requests.get('https://imslp.org/w/api.php', params=params, headers=headers, timeout=20)
if not r.ok:
    sys.exit(1)

data = r.json()
pages = data.get('query', {}).get('pages', {})
page = next(iter(pages.values())) if pages else None
if not page or page.get('missing'):
    sys.exit(1)

meta = build_meta_from_page(page)
images = page.get('images') or []
titles = []
for img in images:
    t = img.get('title')
    if t:
        titles.append(t)
files = fetch_imageinfo(titles)
meta['files'] = files

print(json.dumps(meta))
`;

    try {
      const target = permalinkOrSlugOrId;
      const { stdout } = await execFileAsync('python3', ['-c', script, target], {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000
      });
      const meta = JSON.parse(stdout) as Record<string, unknown>;
      const basic = (meta['basic_info'] as Record<string, unknown>) ?? {};
      const pageId = String(basic['page_id'] ?? '');
      if (!/^\d+$/.test(pageId)) {
        return null;
      }
      const title = String(basic['page_title'] ?? pageId);
      const permalink = String(basic['url'] ?? '');
      await this.imslpModel.updateOne(
        { workId: pageId },
        {
          $set: {
            workId: pageId,
            title,
            permalink,
            metadata: meta
          },
          $currentDate: { updatedAt: true }
        },
        { upsert: true }
      ).exec();
      const updated = (await this.imslpModel.findOne({ workId: pageId }).lean().exec()) as
        | (ImslpWork & { metadata?: Record<string, unknown> })
        | null;
      return updated ?? null;
    } catch (e) {
      return null;
    }
  }

  private async fetchViaMwClient(
    permalink: string
  ): Promise<(ImslpWork & { metadata?: Record<string, unknown> }) | null> {
    try {
      const urlOrSlug = permalink;
      const { stdout, stderr } = await execFileAsync('python3', ['/app/python/imslp_enrich.py', urlOrSlug], {
        maxBuffer: 16 * 1024 * 1024,
        timeout: 90_000
      });
      this.logger.log(`[IMSLP] MWClient script done (stdout=${stdout.length} bytes, stderr=${(stderr||'').length} bytes)`);
      const meta = JSON.parse(stdout) as Record<string, unknown>;
      const basicInfo = (meta['basic_info'] as Record<string, unknown>) ?? {};

      const slug = this.extractSlug(permalink);
      let workId = String(basicInfo['page_id'] ?? '');
      if (!/^\d+$/.test(workId)) {
        const canonicalPermalink = `https://imslp.org/wiki/${encodeURIComponent(String(meta['page_title'] ?? slug)).replace(/%20/g, '_')}`;
        const resolved = await this.resolvePageIdFromUrl(canonicalPermalink).catch(() => null);
        if (!resolved || !/^\d+$/.test(resolved)) {
          return null;
        }
        workId = resolved;
      }
      const title = String(basicInfo['page_title'] ?? slug);
      const canonicalPermalink = `https://imslp.org/wiki/${encodeURIComponent(String(meta['page_title'] ?? slug)).replace(/%20/g, '_')}`;

      await this.imslpModel.updateOne(
        { $or: [ { workId }, { permalink: canonicalPermalink } ] },
        {
          $set: {
            workId,
            title,
            permalink: canonicalPermalink,
            metadata: meta
          },
          $currentDate: { updatedAt: true }
        },
        { upsert: true }
      ).exec();

      const updated = (await this.imslpModel.findOne({ workId }).lean().exec()) as
        | (ImslpWork & { metadata?: Record<string, unknown> })
        | null;
      this.logger.log(`[IMSLP] Enrich upserted workId=${workId} title=${title}`);
      return updated ?? null;
    } catch (error) {
      const execError = error as {
        code?: number | null;
        killed?: boolean;
        signal?: string | null;
        message?: string;
      };
      this.logger.error(`[IMSLP] MWClient fetch error: ${execError?.message}`);
      const code = execError.code ?? undefined;
      if (code === 1) {
        return null;
      }
      if ((execError as any).killed && (execError as any).signal === 'SIGTERM') {
        this.logger.error('IMSLP MWClient metadata fetch timed out');
        throw new InternalServerErrorException('IMSLP metadata fetch timed out');
      }
      this.logger.error(`Failed MWClient metadata fetch: ${error}`);
      return null;
    }
  }

  async resolvePageIdFromUrl(permalinkOrSlug: string): Promise<string | null> {
    const script = `
import sys, re
from urllib.parse import unquote, quote
import requests
headers = {'User-Agent': 'OurTextScores/1.0 (+https://ourtextscores.example)'}

target = sys.argv[1]
slug = target
if target.startswith('http://') or target.startswith('https://'):
    if '/wiki/' in target:
        slug = target.split('/wiki/', 1)[1]
    else:
        slug = target
slug = unquote(slug)
url = 'https://imslp.org/wiki/' + quote(slug)
try:
    r = requests.get(url, timeout=15, headers=headers)
    if not r.ok:
        sys.exit(1)
    m = re.search(r'"wgArticleId"\s*:\s*(\d+)', r.text)
    if not m:
        sys.exit(1)
    print(m.group(1))
except Exception:
    sys.exit(1)
`;

    try {
      const { stdout } = await execFileAsync('python3', ['-c', script, permalinkOrSlug], {
        maxBuffer: 256 * 1024,
        timeout: 20_000
      });
      const pageId = stdout.trim();
      if (!pageId) return null;
      return pageId;
    } catch {
      // Fallback: perform a simple HTTPS fetch and regex scrape in Node
      try {
        const buildUrl = (target: string): string => {
          let slug = target;
          if (target.startsWith('http://') || target.startsWith('https://')) {
            const idx = target.indexOf('/wiki/');
            slug = idx >= 0 ? target.substring(idx + 6) : target;
          }
          try {
            slug = decodeURIComponent(slug);
          } catch {}
          const encoded = encodeURIComponent(slug).replace(/%20/g, '_');
          return `https://imslp.org/wiki/${encoded}`;
        };
        const url = buildUrl(permalinkOrSlug);
        const html: string = await new Promise((resolve, reject) => {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const https = require('node:https');
          const req = https.get(url, (res: any) => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => (data += chunk));
            res.on('end', () => resolve(data));
          });
          req.setTimeout(15000, () => req.destroy(new Error('timeout')));
          req.on('error', reject);
        });
        const m = /"wgArticleId"\s*:\s*(\d+)/.exec(html);
        return m ? m[1] : null;
      } catch {
        return null;
      }
    }
  }
}
