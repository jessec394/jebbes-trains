"""Download an OSM extract from Geofabrik (resumable)."""
from __future__ import annotations
import os, shutil, ssl, subprocess, sys, time, urllib.request, urllib.error

from . import config

BASE = 'https://download.geofabrik.de'


def url_for(region: str) -> str:
    return f"{BASE}/{region.strip('/')}-latest.osm.pbf"


def _curl(url: str, part: str, log) -> bool:
    """Fallback when Python can't verify the server's certificate chain (common with the
    Microsoft Store build of Python). curl ships with Windows 10+ and uses the system
    certificate store; `-C -` resumes a partial file."""
    exe = shutil.which('curl') or shutil.which('curl.exe')
    if not exe:
        return False
    log("Python could not verify the download server's certificate; using curl instead")
    rc = subprocess.run([exe, '-L', '--fail', '-C', '-', '-o', part, url]).returncode
    return rc in (0, 33) and os.path.exists(part)      # 33 = range not satisfiable = already complete


def _is_ssl_error(e: BaseException) -> bool:
    return isinstance(e, ssl.SSLError) or isinstance(getattr(e, 'reason', None), ssl.SSLError)


def download(region: str = 'north-america', force: bool = False, log=print) -> str:
    """-> local path. Re-running resumes a partial download; `force` re-downloads
    (use that to get fresh OSM data for `update`)."""
    os.makedirs(config.CACHE_DIR, exist_ok=True)
    dest = os.path.join(config.CACHE_DIR, region.strip('/').replace('/', '_') + '-latest.osm.pbf')
    part = dest + '.part'
    if os.path.exists(dest) and not force:
        log(f"using existing download {dest}")
        return dest
    if force and os.path.exists(part):
        os.remove(part)
    url = url_for(region)
    done = os.path.getsize(part) if os.path.exists(part) else 0
    req = urllib.request.Request(url, headers={'User-Agent': 'jebbes-trains-devtools'})
    if done:
        req.add_header('Range', f'bytes={done}-')
    log(f"downloading {url}" + (f" (resuming at {done/1e6:.0f} MB)" if done else ''))
    try:
        resp = urllib.request.urlopen(req, timeout=60)
    except urllib.error.URLError as e:
        if isinstance(e, urllib.error.HTTPError):
            raise
        if _is_ssl_error(e):
            if _curl(url, part, log):
                os.replace(part, dest); log(f"saved {dest}"); return dest
            raise SystemExit(f"Certificate check failed and curl isn't available.\n"
                             f"Download {url} in your browser, save it anywhere, then run:\n"
                             f"  python -m devtools ingest <path-to-file>")
        raise
    except urllib.error.HTTPError as e:
        if e.code == 416 and done:        # already complete
            os.replace(part, dest); return dest
        raise SystemExit(f"download failed: {e}\nCheck the region name at {BASE}/ (e.g. north-america, north-america/us/new-york)")
    total = done + int(resp.headers.get('Content-Length') or 0)
    last = 0.0
    with open(part, 'ab' if done and resp.status == 206 else 'wb') as f:
        if resp.status != 206:
            done = 0
        while True:
            chunk = resp.read(1 << 20)
            if not chunk:
                break
            f.write(chunk); done += len(chunk)
            if time.time() - last > 5:
                last = time.time()
                log(f"  {done/1e9:.2f} / {total/1e9:.2f} GB ({100*done/max(total,1):.0f}%)")
    os.replace(part, dest)
    log(f"saved {dest}")
    return dest
