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
                'https://imslp.org/w/api.php',
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


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('Usage: imslp_enrich.py <permalink|slug|pageid>\n')
        sys.exit(1)
    target = sys.argv[1]
    title = extract_title(target)

    client = ImslpClient()
    page = client._site.pages[title]
    attempts = 0
    while attempts < 3 and not page.exists:
        time.sleep(2)
        page = client._site.pages[title]
        attempts += 1

    metadata = {
        'page_title': title,
        'url': f"https://imslp.org/wiki/{urllib.parse.quote(title)}",
        'timestamp': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'exists': bool(page.exists),
        'basic_info': {},
        'categories': [],
        'files': [],
        'revision_history': []
    }

    try:
        metadata['basic_info'] = {
            'page_name': page.name,
            'page_title': page.page_title,
            'page_id': getattr(page, 'pageid', None),
            'namespace': getattr(page, 'namespace', None),
            'last_revision': getattr(page, 'revision', None)
        }
    except Exception as e:
        metadata['basic_info_error'] = str(e)

    try:
        metadata['categories'] = [cat.name for cat in list(page.categories())]
    except Exception as e:
        metadata['categories_error'] = str(e)

    try:
        imgs = []
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
            temp_files.append({
                'name': name,
                'title': use_title,
                'url': url,
                'size': info.get('size') if isinstance(info, dict) else None,
                'sha1': info.get('sha1') if isinstance(info, dict) else None,
                'mime_type': info.get('mime') if isinstance(info, dict) else None,
                'timestamp': info.get('timestamp') if isinstance(info, dict) else None,
                'user': info.get('user') if isinstance(info, dict) else None,
                'download_urls': {
                    'original': url,
                    'https': (url.replace('http:', 'https:') if url else None) if url else None,
                    'direct': (url.replace('//imslp.org/', 'https://imslp.org/') if url and url.startswith('//') else url)
                }
            })

        # Fallback: fetch imageinfo for titles via MediaWiki API to get direct URLs
        try:
            if titles:
                by_title = {}
                # Batch in chunks of 50
                for i in range(0, min(len(titles), 100), 50):
                    chunk = titles[i:i+50]
                    titles_param = '|'.join(chunk)
                    r = get_with_retry('https://imslp.org/w/api.php', params={
                        'action': 'query',
                        'format': 'json',
                        'prop': 'imageinfo',
                        'iiprop': 'url|size|sha1|mime|timestamp|user|comment',
                        'titles': titles_param
                    }, timeout=20, tries=3)
                    if r.ok:
                        data = r.json()
                        pages = data.get('query', {}).get('pages', {})
                        for p in pages.values():
                            ti = p.get('title')
                            ii = p.get('imageinfo') or []
                            if not ti or not ii:
                                continue
                            info = ii[0]
                            by_title[ti] = info

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
