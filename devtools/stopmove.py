"""Moving a stop to another place in a pattern's stop list: a skip and an add, written together or not at all."""
from __future__ import annotations
import os
from . import stops as ST


def move_stop(path: str, op: str, line: str, cat: str, pat: str, key: str, near: str, side: str, shared: bool = False, nth: int = 0, near_nth: int = 0) -> None:
    keys = [s['key'] for s in ST.pattern_stops(path, op, line, cat, pat)['stops']]
    if key not in keys or near not in keys:
        raise ValueError('the stop list changed: reload the route')
    i = ST._nth(keys, key, nth); jo = ST._nth(keys, near, near_nth)
    if i == jo:
        raise ValueError('that is where it already is')
    want = keys[:i] + keys[i + 1:]; j = jo - (1 if i < jo else 0)
    want.insert(j + 1 if side == 'after' else j, key)
    if any(a == b for a, b in zip(want, want[1:])):
        raise ValueError('that would put a stop straight after itself')
    if len(set(keys)) < len(keys):
        # a route that stops at one platform several times: only the exact order says which visit goes where, so the route gets that list
        ST.edit_pattern_stops(path, op, line, cat, pat, {'order': want})
        return
    with open(path, 'rb') as f:
        original = f.read()
    extra = {'shared': True} if shared else {}
    def restore():
        tmp = path + '.tmp'
        with open(tmp, 'wb') as f:
            f.write(original)
        os.replace(tmp, path)
    try:
        ST._edit_pattern_stops(path, op, line, cat, pat, {'skip': key, **extra})
        ST._edit_pattern_stops(path, op, line, cat, pat, {'add': {'key': key, 'near': near, 'side': side}, **extra})
        if [s['key'] for s in ST.pattern_stops(path, op, line, cat, pat)['stops']] == want:
            return
    except Exception:
        pass
    restore()                                               # the tidy way would not give this order here: the route gets exactly the order asked for
    ST._edit_pattern_stops(path, op, line, cat, pat, {'order': want})