"""Small file helpers shared by the website build and the tracer: mtime-keyed caches, atomic writes, and JSON that diffs well."""
from __future__ import annotations
import copy, json, os, shutil
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

def _is_points(v) -> bool:
    return (isinstance(v, list) and v and all(
        isinstance(p, list) and len(p) in (2, 3) and all(isinstance(x, (int, float)) for x in p) for p in v))

def dumps(obj, level: int = 0) -> str:
    pad = ' ' * (level + 1)
    if isinstance(obj, dict):
        if not obj: return '{}'
        items = [f'{pad}{json.dumps(k, ensure_ascii=False)}: {dumps(v, level + 1)}' for k, v in obj.items()]
        return '{\n' + ',\n'.join(items) + '\n' + ' ' * level + '}'

    if _is_points(obj):
        return '[' + ', '.join(json.dumps(p) for p in obj) + ']' if len(obj) < 4 else \
            '[\n' + ',\n'.join(pad + json.dumps(p) for p in obj) + '\n' + ' ' * level + ']'

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
    if not os.path.exists(path): return default
    doc = _JSON.get(path)
    return doc if shared else copy.deepcopy(doc)

def write_json(path: str, obj) -> None:
    atomic_write(path, dumps(obj) + '\n')
    _JSON.forget(path)