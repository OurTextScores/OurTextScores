#!/usr/bin/env python3
import json
import sys
import time
import urllib.parse

try:
    from imslp.client import ImslpClient
except Exception as exc:
    sys.stderr.write("Failed to import imslp client: " + str(exc) + "\n")
    sys.exit(2)

HEADERS = {'User-Agent': 'OurTextScores/1.0 (+https://ourtextscores.example)'}
IMSLP_API_URL = 'https://imslp.org/api.php'

def get_with_retry(url, params=None, timeout=15, tries=3, backoff=1.5):
    import requests
    delay = 1.0
    last = None
    for i in range(max(1, tries)):
        try:
            r = requests.get(url, params=params, headers=HEADERS, timeout=timeout)
            return r
        except Exception as e:
            last = e
            time.sleep(delay)
            delay *= backoff
    raise last if last else Exception('request failed')


def extract_title(target: str) -> str:
    if target.startswith('http://imslp.org/wiki/') or target.startswith('https://imslp.org/wiki/'):
        title = target.split('/wiki/', 1)[1]
        return urllib.parse.unquote(title)
    # Numeric pageid: first try MediaWiki API, then fall back to canonical link
    if target.isdigit():
        try:
            r = get_with_retry(
                IMSLP_API_URL,
                params={'action': 'query', 'format': 'json', 'prop': 'info', 'pageids': target, 'inprop': 'url'},
                timeout=15, tries=3
            )
            if r.ok:
                data = r.json()
                pages = data.get('query', {}).get('pages', {})
                page = next(iter(pages.values())) if pages else None
                if page and not page.get('missing') and page.get('title'):
                    return urllib.parse.unquote(page['title'])
        except Exception:
            pass
        try:
            import requests, re
            r2 = requests.get('https://imslp.org/index.php', params={'curid': target}, timeout=15)
            if r2.ok:
                txt = r2.text
                m = re.search(r'<link rel="canonical" href="https?://imslp.org/wiki/([^"]+)"', txt)
                if m:
                    slug = urllib.parse.unquote(m.group(1))
                    return slug.replace('_', ' ')
        except Exception:
            pass
    return urllib.parse.unquote(target)


def resolve_canonical_page(target: str):
    """Resolve redirects/aliases to the canonical IMSLP page title before MWClient lookup."""
    try:
        params = {
            'action': 'query',
            'format': 'json',
            'prop': 'info',
            'inprop': 'url',
            'redirects': 1,
        }
        if target.isdigit():
            params['pageids'] = target
        else:
            params['titles'] = extract_title(target)

        r = get_with_retry(IMSLP_API_URL, params=params, timeout=15, tries=3)
        if not r.ok:
            return None
        data = r.json()
        pages = data.get('query', {}).get('pages', {})
        if not pages:
            return None
        page = next(iter(pages.values()))
        if not page or page.get('missing'):
            return None
        title = page.get('title')
        if not title:
            return None
        return {
            'title': urllib.parse.unquote(title),
            'page_id': page.get('pageid'),
            'url': page.get('fullurl') or page.get('canonicalurl'),
            'redirected': bool((data.get('query') or {}).get('redirects')),
        }
    except Exception:
        return None


def fetch_imageinfo_by_titles(titles):
    by_title = {}
    if not titles:
        return by_title

    for i in range(0, min(len(titles), 100), 50):
        chunk = titles[i:i+50]
        titles_param = '|'.join(chunk)
        r = get_with_retry(IMSLP_API_URL, params={
            'action': 'query',
            'format': 'json',
            'prop': 'imageinfo',
            'iiprop': 'url|size|sha1|mime|timestamp|user|comment',
            'titles': titles_param
        }, timeout=20, tries=3)
        if not r.ok:
            continue
        data = r.json()
        pages = data.get('query', {}).get('pages', {})
        for p in pages.values():
            ti = p.get('title')
            ii = p.get('imageinfo') or []
            if not ti or not ii:
                continue
            by_title[ti] = ii[0]
    return by_title


def build_file_entry(title, info=None, name=None):
    info = info if isinstance(info, dict) else {}
    url = info.get('url')
    return {
        'name': name or title,
        'title': title,
        'url': url,
        'size': info.get('size'),
        'sha1': info.get('sha1'),
        'mime_type': info.get('mime'),
        'timestamp': info.get('timestamp'),
        'user': info.get('user'),
        'download_urls': {
            'original': url,
            'https': (url.replace('http:', 'https:') if url else None),
            'direct': (url.replace('//imslp.org/', 'https://imslp.org/') if url and isinstance(url, str) and url.startswith('//') else url)
        }
    }


def fetch_files_via_pageid(page_id):
    if page_id in (None, ''):
        return []
    r = get_with_retry(IMSLP_API_URL, params={
        'action': 'query',
        'format': 'json',
        'prop': 'images',
        'pageids': str(page_id),
        'imlimit': 100
    }, timeout=20, tries=3)
    if not r.ok:
        return []
    data = r.json()
    pages = data.get('query', {}).get('pages', {})
    page = next(iter(pages.values())) if pages else None
    if not page or page.get('missing'):
        return []
    titles = []
    for img in page.get('images') or []:
        t = img.get('title')
        if t:
            titles.append(t)
    by_title = fetch_imageinfo_by_titles(titles)
    files = []
    for ti in titles:
        files.append(build_file_entry(ti, by_title.get(ti), name=ti))
    return files


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('Usage: imslp_enrich.py <permalink|slug|pageid>\n')
        sys.exit(1)
    target = sys.argv[1]
    resolved = resolve_canonical_page(target) or {}
    title = resolved.get('title') or extract_title(target)
    resolved_page_id = resolved.get('page_id')
    resolved_url = resolved.get('url')

    client = ImslpClient()
    page = client._site.pages[title]
    attempts = 0
    while attempts < 3 and not page.exists:
        time.sleep(2)
        page = client._site.pages[title]
        attempts += 1
    try:
        mwclient_page_id = getattr(page, 'pageid', None)
    except Exception:
        mwclient_page_id = None
    pageid_mismatch = bool(
        resolved_page_id not in (None, '')
        and mwclient_page_id not in (None, '')
        and str(resolved_page_id) != str(mwclient_page_id)
    )

    metadata = {
        'page_title': title,
        'url': resolved_url or f"https://imslp.org/wiki/{urllib.parse.quote(title)}",
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'exists': bool(page.exists),
        'requested_target': target,
        'basic_info': {},
        'categories': [],
        'files': [],
        'revision_history': []
    }

    try:
        metadata['basic_info'] = {
            'page_name': page.name,
            'page_title': (title if pageid_mismatch else getattr(page, 'page_title', None)) or title,
            'page_id': resolved_page_id or mwclient_page_id,
            'namespace': getattr(page, 'namespace', None),
            'last_revision': getattr(page, 'revision', None)
        }
        if pageid_mismatch:
            metadata['basic_info']['mwclient_page_id'] = mwclient_page_id
            metadata['basic_info']['canonical_page_id'] = resolved_page_id
            metadata['basic_info']['page_id_mismatch'] = True
    except Exception as e:
        metadata['basic_info_error'] = str(e)

    try:
        metadata['categories'] = [cat.name for cat in list(page.categories())]
    except Exception as e:
        metadata['categories_error'] = str(e)

    try:
        imgs = []
        if not pageid_mismatch:
            try:
                imgs = list(page.images())[:100]
            except Exception:
                imgs = []

        # Build initial file list from mwclient if available
        temp_files = []
        titles = []
        for img in imgs:
            info = getattr(img, 'imageinfo', {})
            url = info.get('url') if isinstance(info, dict) else None
            title = getattr(img, 'page_title', None)
            name = getattr(img, 'name', None)
            use_title = name or title
            if use_title:
                titles.append(use_title)
            temp_files.append(build_file_entry(use_title, info, name=name))

        # Fallback: fetch imageinfo for titles via MediaWiki API to get direct URLs
        try:
            if titles:
                by_title = fetch_imageinfo_by_titles(titles)

                # Merge API info into temp_files
                for f in temp_files:
                    ti = f.get('title')
                    info = by_title.get(ti)
                    if not info:
                        continue
                    url = info.get('url')
                    f['url'] = url or f.get('url')
                    f['size'] = info.get('size') if info.get('size') is not None else f.get('size')
                    f['sha1'] = info.get('sha1') or f.get('sha1')
                    f['mime_type'] = info.get('mime') or f.get('mime_type')
                    f['timestamp'] = info.get('timestamp') or f.get('timestamp')
                    f['user'] = info.get('user') or f.get('user')
                    f['download_urls'] = {
                        'original': url,
                        'https': (url.replace('http:', 'https:') if url else None),
                        'direct': url
                    }
        except Exception:
            pass

        # If MWClient landed on the wrong page variant (or returned no images), fetch files via canonical pageid.
        if (pageid_mismatch or not temp_files) and (resolved_page_id or mwclient_page_id):
            api_page_id = resolved_page_id or mwclient_page_id
            api_files = fetch_files_via_pageid(api_page_id)
            if api_files:
                temp_files = api_files
                metadata['files_source'] = 'mediawiki_api_pageid'
            elif pageid_mismatch:
                metadata['files_source'] = 'mediawiki_api_pageid_empty'
        elif temp_files:
            metadata['files_source'] = 'mwclient'

        metadata['files'] = temp_files
    except Exception as e:
        metadata['files_error'] = str(e)

    try:
        revs = list(page.revisions())
        for rev in revs[:5]:
            metadata['revision_history'].append({
                'revid': rev.get('revid'),
                'user': rev.get('user'),
                'timestamp': rev.get('timestamp'),
                'comment': rev.get('comment')
            })
    except Exception as e:
        metadata['revision_history_error'] = str(e)

    print(json.dumps(metadata))


if __name__ == '__main__':
    main()
