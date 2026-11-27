"""Images given by URL: the page shows each one straight from its own address, credited to its site's domain, which a click on it opens; nothing is downloaded"""
import re, urllib.parse
ASSET_SUBDOMAINS = {'www', 'cdn', 'img', 'imgs', 'image', 'images', 'i', 'static', 'media', 'assets', 'uploads', 'files', 'content', 'photos', 'pics', 's', 'res', 'live'}
def is_url(v) -> bool:
    return isinstance(v, str) and v.startswith(('http://', 'https://'))

def _wikimedia_file(u: urllib.parse.ParseResult) -> tuple[str, str] | None:
    """(project, file name) of an upload.wikimedia.org address, original or thumbnail"""
    parts = [urllib.parse.unquote(p) for p in u.path.split('/') if p]
    if u.hostname != 'upload.wikimedia.org' or len(parts) < 4 or parts[0] != 'wikipedia': return None
    return parts[1], parts[parts.index('thumb') + 3] if 'thumb' in parts else parts[-1]

def _pretty_domain(host: str) -> str:
    labels = [l for l in host.split('.') if l not in ASSET_SUBDOMAINS]
    return '.'.join(labels[-2:]) if len(labels) >= 2 else host

def _owner_host(u: urllib.parse.ParseResult) -> str:
    """The site a file belongs to: a storage bucket named after a domain (storage.googleapis.com/cdn.example.com/...) speaks for that site, not for the storage service"""
    host = (u.hostname or '').lower(); first = (u.path.lstrip('/').split('/') or [''])[0].lower()
    for suffix in ('.storage.googleapis.com', '.s3.amazonaws.com', '.blob.core.windows.net', '.digitaloceanspaces.com'):
        if host.endswith(suffix) and '.' in host[:-len(suffix)]: return host[:-len(suffix)]

    if (host == 'storage.googleapis.com' or re.match(r's3[.-]([a-z0-9-]+\.)?amazonaws\.com$', host)) and re.match(r'^[a-z0-9-]+(\.[a-z0-9-]+)+$', first): return first
    return host

def credit_of(url: str) -> tuple[str, str]:
    """(credit, page) of a picture, worked out from its address alone: the domain of its site, and where a click on it goes"""
    u = urllib.parse.urlparse(url); host = (u.hostname or '').lower(); dom = _pretty_domain(_owner_host(u))
    wf = _wikimedia_file(u)
    if wf: return dom, ('https://commons.wikimedia.org' if wf[0] == 'commons' else f'https://{wf[0]}.wikipedia.org') + '/wiki/File:' + urllib.parse.quote(wf[1].replace(' ', '_'))
    m = re.match(r'/(?:vi|vi_webp)/([\w-]{11})/', u.path) if host.endswith('ytimg.com') else None
    if m: return 'youtube.com', 'https://www.youtube.com/watch?v=' + m.group(1)
    return dom, f'https://{dom}/'

def resolve(destinations: dict, projects: dict) -> tuple[dict, dict]:
    """Copies of Destinations and Projects with each image URL given its credit and source page; images still named the old way (files in data/images) are left as they are"""
    n = 0
    def one(image):                                  # -> (address, credit, page) or None; image is 'url', ['url', 'Credit'] or ['url', 'Credit', 'source page']
        nonlocal n
        url, given, page = (list(image) + [None, None])[:3] if isinstance(image, (list, tuple)) and image else (image, None, None)
        if not is_url(url): return None
        n += 1; credit, home = credit_of(url)
        return url, given or credit, page or home

    dests = {}
    for cat, items in destinations.items():
        dests[cat] = {}
        for name, d in items.items():
            r = one(d.get('Image')) if d.get('Image') else None
            dests[cat][name] = {**d, 'Image': list(r)} if r else d

    projs = {}
    for name, p in projects.items():
        r = one(p.get('Image')) if p.get('Image') else None
        projs[name] = {**p, 'Image': r[0], 'ImageCredit': r[1], 'ImageSource': r[2]} if r else p

    if n: print(f'[images] {n} image(s) shown from their URLs')
    return dests, projs