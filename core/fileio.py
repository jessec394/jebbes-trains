"""Small file helpers shared by the website build and the tracer: mtime-keyed caches, atomic writes, and JSON that diffs well."""
from __future__ import annotations
import atexit, copy, json, math, os, shutil, threading
from typing import Any, Callable

# Caches that refresh when the file changes on disk

def file_sig(path: str) -> tuple[int, int]:
    st = os.stat(path)
    return st.st_mtime_ns, st.st_size

class FileCache:
    """path -> loader(path), recomputed only when the file's mtime / size change."""

    def __init__(self, loader: Callable[[str], Any]):
        self.loader = loader
        self._hits: dict[str, tuple[tuple[int, int], Any]] = {}

    def get(self, path: str) -> Any:
        sig = file_sig(path)
        hit = self._hits.get(path)
        if not hit or hit[0] != sig: hit = self._hits[path] = (sig, self.loader(path))
        return hit[1]

    def forget(self, path: str) -> None:
        self._hits.pop(path, None)

# Writing

def atomic_write(path: str, text: str, newline: str | None = None) -> None:
    """Write via a temporary file, so a crash never leaves a half-written file."""
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8', newline=newline) as f:
        f.write(text)

    os.replace(tmp, path)

def write_with_backup(path: str, text: str, backup_dir: str, backup_name: str | None = None) -> str:
    """Copy the current file to backup_dir, then write the new text atomically (newlines as given). -> the backup's path."""
    os.makedirs(backup_dir, exist_ok=True)
    backup = os.path.join(backup_dir, backup_name or os.path.basename(path).replace('.py', '.backup.py'))
    shutil.copyfile(path, backup)
    atomic_write(path, text, newline='')
    return backup

# JSON that diffs well: point lists stay on one line

def _points(v) -> list[str] | None:
    """Each point of a list of [lat, lon(, z)] points as JSON text (as json.dumps writes it), or None when v is not such a list"""
    if type(v) is not list or not v: return None
    out = []
    for p in v:
        if type(p) is not list or len(p) not in (2, 3): return None
        s = []
        for x in p:
            if type(x) is float: s.append(repr(x) if math.isfinite(x) else json.dumps(x))
            elif type(x) is int: s.append(repr(x))
            else: return None

        out.append('[' + ', '.join(s) + ']')

    return out

def dumps(obj, level: int = 0) -> str:
    pad = ' ' * (level + 1)
    if isinstance(obj, dict):
        if not obj: return '{}'
        items = [f'{pad}{json.dumps(k, ensure_ascii=False)}: {dumps(v, level + 1)}' for k, v in obj.items()]
        return '{\n' + ',\n'.join(items) + '\n' + ' ' * level + '}'

    pts = _points(obj)                  # point lists are most of a geometry file: written directly, not one json.dumps per point
    if pts is not None: return '[' + ', '.join(pts) + ']' if len(pts) < 4 else '[\n' + ',\n'.join(pad + p for p in pts) + '\n' + ' ' * level + ']'

    if isinstance(obj, list):
        if not obj: return '[]'
        return '[\n' + ',\n'.join(pad + dumps(v, level + 1) for v in obj) + '\n' + ' ' * level + ']'

    return json.dumps(obj, ensure_ascii=False)

def _load_json(path: str):
    with open(path, encoding='utf-8') as f:
        return json.load(f)

_JSON = FileCache(_load_json)      # the big JSON files are parsed once per change on disk, not once per request

def read_json(path: str, default, shared: bool = False):
    """Parsed JSON file (default when it does not exist). Callers get their own copy unless `shared` (read-only use of a big document)."""
    with _SOON_LOCK: doc = _SOON.get(path)                          # a document waiting to be written is the current one
    if doc is None:
        if not os.path.exists(path): return default
        doc = _JSON.get(path)

    return doc if shared else copy.deepcopy(doc)

def write_json(path: str, obj) -> None:
    with _SOON_LOCK:
        _SOON.pop(path, None); t = _SOON_TIMER.pop(path, None)
        if t: t.cancel()

    with _WRITE_LOCK: atomic_write(path, dumps(obj) + '\n'); _JSON.forget(path)

# Writes that can wait: reads see the new document at once, the file is written in the background a moment after the last change
_SOON: dict = {}
_SOON_TIMER: dict = {}
_SOON_LOCK, _WRITE_LOCK = threading.Lock(), threading.Lock()

def write_json_soon(path: str, obj, delay: float = 0.6) -> None:
    """write_json, a moment later and off the caller's time. obj must not be changed in place afterwards (replace it instead)."""
    with _SOON_LOCK:
        _SOON[path] = obj; t = _SOON_TIMER.pop(path, None)
        if t: t.cancel()
        t = _SOON_TIMER[path] = threading.Timer(delay, flush_json, (path,)); t.daemon = True; t.start()

def flush_json(path: str | None = None) -> None:
    """Writes the waiting documents (path: only that one) now"""
    for p in ([path] if path else list(_SOON)):
        with _WRITE_LOCK:
            with _SOON_LOCK: obj = _SOON.get(p)
            if obj is None: continue
            atomic_write(p, dumps(obj) + '\n'); _JSON.forget(p)
            with _SOON_LOCK:
                if _SOON.get(p) is obj: del _SOON[p]

atexit.register(flush_json)                                             # nothing waiting is lost when the tracer stops