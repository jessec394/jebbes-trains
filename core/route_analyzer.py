"""
Analyses a flat list of station keys to determine route topology (linear,
loop, lollipop, out-and-back, complex), then renders an SVG diagram for the
sidebar.  Pure logic — no I/O, no Leaflet, no data imports.
"""

from __future__ import annotations
from typing import Any
from builder.types import StationKey, ModeSettings, RouteStructure, StationDict, Color


# ── Topology detection ────────────────────────────────────────────────────────

def analyze_route_structure(stations: list[StationKey]) -> RouteStructure:
    if not stations or len(stations) < 2:
        return {"Type": "Linear", "Segments": [stations]}

    first, last = stations[0], stations[-1]
    if first != last:
        return {"Type": "Linear", "Segments": [stations]}

    loop_check = _detect_loop_or_lollipop(stations)
    if loop_check:
        return loop_check

    mid:          int                  = len(stations) // 2
    forward_path: list[StationKey]     = stations[:mid + 1]
    return_path:  list[StationKey]     = list(reversed(stations[mid:]))
    sections:     list[tuple[Any, ...]] = []

    i = j = 0
    while i < len(forward_path) and j < len(return_path):
        if forward_path[i] == return_path[j]:
            shared: list[StationKey] = []
            while i < len(forward_path) and j < len(return_path) and forward_path[i] == return_path[j]:
                shared.append(forward_path[i])
                i += 1; j += 1
            if shared:
                sections.append(("Shared", shared))
        else:
            next_fwd = next_ret = -1
            for fi in range(i, len(forward_path)):
                for ri in range(j, len(return_path)):
                    if forward_path[fi] == return_path[ri]:
                        next_fwd, next_ret = fi, ri
                        break
                if next_fwd != -1:
                    break
            if next_fwd != -1:
                fwd_seg = forward_path[i:next_fwd]
                ret_seg = return_path[j:next_ret]
                i, j    = next_fwd, next_ret
            else:
                fwd_seg = forward_path[i:]
                ret_seg = return_path[j:]
                i = len(forward_path); j = len(return_path)
            if fwd_seg or ret_seg:
                sections.append(("Split", fwd_seg, ret_seg))

    if all(s[0] == "Shared" for s in sections):
        return {"Type": "OutAndBack", "Segments": [forward_path]}
    if any(s[0] == "Split" for s in sections):
        return {"Type": "Complex", "Sections": sections}
    return {"Type": "Linear", "Segments": [stations]}


def _detect_loop_or_lollipop(stations: list[StationKey]) -> RouteStructure | None:
    seen_at:          dict[StationKey, int] = {}
    first_repeat_idx: int                   = -1
    first_repeat:     StationKey | None     = None

    for idx, s in enumerate(stations):
        if s in seen_at and first_repeat_idx == -1:
            first_repeat_idx = seen_at[s]
            first_repeat     = s
            break
        seen_at[s] = idx

    if first_repeat_idx == -1:
        unique = list(dict.fromkeys(stations))
        if len(unique) == len(stations) - 1 and stations[0] == stations[-1]:
            return {"Type": "Loop", "Segments": [stations]}
        return None

    if first_repeat_idx == 0 and first_repeat == stations[0]:
        second: int = next((i for i in range(1, len(stations)) if stations[i] == first_repeat), -1)
        if second == len(stations) - 1:
            unique = list(dict.fromkeys(stations[:-1]))
            if len(unique) == len(stations) - 1:
                return {"Type": "Loop", "Segments": [stations]}

    if all(stations[i] == stations[-(i + 1)] for i in range(len(stations) // 2 + 1)):
        return None

    if first_repeat_idx > 0:
        last_occ: int = next(
            (i for i in range(len(stations) - 1, first_repeat_idx, -1)
             if stations[i] == first_repeat), -1
        )
        if last_occ > first_repeat_idx:
            stem = stations[:first_repeat_idx + 1]
            loop = stations[first_repeat_idx:last_occ + 1]
            tail = stations[last_occ:]
            if len(stem) > 1 and len(tail) > 1:
                is_stem_reversed: bool = all(
                    stem[i] == tail[-(i + 1)] for i in range(min(len(stem), len(tail)))
                )
                if is_stem_reversed and len(stem) == len(tail):
                    if len(list(dict.fromkeys(loop))) > 2:
                        return {"Type": "Lollipop", "Segments": [stem, loop, tail]}
    return None


# ── Label / style helpers ─────────────────────────────────────────────────────

def _station_label(key: StationKey, station_data: StationDict) -> str:
    if key in station_data:
        s:     dict[str, Any] = station_data[key]
        label: str            = s.get("Label", key)
        if s.get("Type") == "Airport":
            label += ' <tspan style="display:inline-block;transform:rotate(45deg);transform-origin:center;">✈</tspan>'
        return label
    return key


def _station_style(key: StationKey, station_data: StationDict) -> dict[str, int]:
    if key in station_data:
        s:        dict[str, Any] = station_data[key]
        is_major: bool           = s.get("Major", False)
        return {
            "FontSize":   13 if is_major else 12,
            "FontWeight": 900 if is_major else 600,
            "DotRadius":  7   if is_major else 5,
        }
    return {"FontSize": 12, "FontWeight": 600, "DotRadius": 5}


# ── Diagram dispatch ──────────────────────────────────────────────────────────

def generate_route_diagram(
    structure:    RouteStructure,
    line_color:   Color,
    station_keys: list[StationKey],
    station_data: StationDict,
) -> str:
    t: str = structure["Type"]
    if   t == "Linear":     return _linear_diagram(structure["Segments"][0], line_color, station_data)
    elif t == "OutAndBack": return _linear_diagram(structure["Segments"][0], line_color, station_data)
    elif t == "Loop":       return _loop_diagram(structure["Segments"][0],   line_color, station_data)
    elif t == "Lollipop":   return _lollipop_diagram(structure["Segments"],  line_color, station_data)
    elif t == "Complex":    return _complex_diagram(structure["Sections"],   line_color, station_data)
    return ""


# ── Individual diagram renderers ─────────────────────────────────────────────

def _linear_diagram(stations: list[StationKey], color: Color, station_data: StationDict) -> str:
    if not stations:
        return ""
    h:   int = max(100, len(stations) * 35 + 20)
    svg: str = f'<svg width="100%" height="{h}" style="margin:8px 0">'
    for i, key in enumerate(stations):
        y:   int = 20 + i * 35
        lbl: str = _station_label(key, station_data)
        st:  dict[str, int] = _station_style(key, station_data)
        svg += f'<circle class="station-dot" data-station="{key}" cx="30" cy="{y}" r="{st["DotRadius"]}" fill="{color}"/>'
        svg += f'<text class="station-label" data-station="{key}" x="45" y="{y + 5}" font-size="{st["FontSize"]}" fill="#1e293b" font-weight="{st["FontWeight"]}">{lbl}</text>'
        if i < len(stations) - 1:
            svg += f'<line x1="30" y1="{y + 5}" x2="30" y2="{y + 30}" stroke="{color}" stroke-width="3"/>'
    return svg + '</svg>'


def _loop_diagram(stations: list[StationKey], color: Color, station_data: StationDict) -> str:
    unique: list[StationKey] = list(dict.fromkeys(stations[:-1] if stations[0] == stations[-1] else stations))
    h:      int              = max(100, len(unique) * 25 + 60)
    svg:    str              = f'<svg width="100%" height="{h}" style="margin:8px 0">'
    ll: int = 30
    lr: int = 100
    lt:     int      = 20
    lb:     int      = lt + (len(unique) - 1) * 25
    svg += f'<line x1="{ll}" y1="{lt}" x2="{lr}" y2="{lt}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{lr}" y1="{lt}" x2="{lr}" y2="{lb}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{lr}" y1="{lb}" x2="{ll}" y2="{lb}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{ll}" y1="{lb}" x2="{ll}" y2="{lt}" stroke="{color}" stroke-width="3" stroke-dasharray="4,4" opacity="0.6"/>'
    for i, key in enumerate(unique):
        y:   int = lt + i * 25
        x:   int = lr + 15
        lbl: str = _station_label(key, station_data)
        st:  dict[str, int] = _station_style(key, station_data)
        svg += f'<circle class="station-dot" data-station="{key}" cx="{x}" cy="{y}" r="{st["DotRadius"] - 1}" fill="{color}"/>'
        svg += f'<text class="station-label" data-station="{key}" x="{x + 12}" y="{y + 4}" font-size="{st["FontSize"] - 1}" fill="#1e293b" font-weight="{st["FontWeight"]}">{lbl}</text>'
    return svg + '</svg>'


def _lollipop_diagram(segments: list[list[StationKey]], color: Color, station_data: StationDict) -> str:
    if len(segments) < 2:
        return _linear_diagram(segments[0] if segments else [], color, station_data)
    stem:       list[StationKey] = segments[0]
    loop:       list[StationKey] = segments[1]
    loop_start: StationKey | None = loop[0] if loop else None
    loop_unique: list[StationKey] = [s for s in loop[1:] if s != loop_start]
    h:   int = max(150, len(stem) * 35 + len(loop_unique) * 25 + 40)
    svg: str = f'<svg width="100%" height="{h}" style="margin:8px 0">'
    for i, key in enumerate(stem):
        y:   int = 20 + i * 35
        lbl: str = _station_label(key, station_data)
        st:  dict[str, int] = _station_style(key, station_data)
        svg += f'<circle class="station-dot" data-station="{key}" cx="30" cy="{y}" r="{st["DotRadius"]}" fill="{color}"/>'
        svg += f'<text class="station-label" data-station="{key}" x="45" y="{y + 5}" font-size="{st["FontSize"]}" fill="#1e293b" font-weight="{st["FontWeight"]}">{lbl}</text>'
        if i < len(stem) - 1:
            svg += f'<line x1="30" y1="{y + 5}" x2="30" y2="{y + 30}" stroke="{color}" stroke-width="3"/>'
    loop_top: int = 20 + len(stem) * 35
    loop_h:   int = max(50, (len(loop_unique) - 1) * 25)
    ll: int = 30
    lr: int = 100
    if stem:
        svg += f'<line x1="30" y1="{loop_top - 15}" x2="30" y2="{loop_top + 10}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{ll}" y1="{loop_top + 10}" x2="{lr}" y2="{loop_top + 10}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{lr}" y1="{loop_top + 10}" x2="{lr}" y2="{loop_top + 10 + loop_h}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{lr}" y1="{loop_top + 10 + loop_h}" x2="{ll}" y2="{loop_top + 10 + loop_h}" stroke="{color}" stroke-width="3"/>'
    svg += f'<line x1="{ll}" y1="{loop_top + 10 + loop_h}" x2="{ll}" y2="{loop_top + 10}" stroke="{color}" stroke-width="3" stroke-dasharray="4,4" opacity="0.6"/>'
    for i, key in enumerate(loop_unique):
        y:   int = loop_top + 10 + i * 25
        x:   int = lr + 15
        lbl: str = _station_label(key, station_data)
        st:  dict[str, int] = _station_style(key, station_data)
        svg += f'<circle class="station-dot" data-station="{key}" cx="{x}" cy="{y}" r="{st["DotRadius"] - 1}" fill="{color}"/>'
        svg += f'<text class="station-label" data-station="{key}" x="{x + 12}" y="{y + 4}" font-size="{st["FontSize"] - 1}" fill="#475569" font-weight="{st["FontWeight"]}">{lbl}</text>'
    return svg + '</svg>'


def _complex_diagram(sections: list[tuple[Any, ...]], color: Color, station_data: StationDict) -> str:
    rows:      list[str] = []
    current_y: int       = 20

    for sec in sections:
        if sec[0] == "Shared":
            for key in sec[1]:
                y:   int = current_y
                lbl: str = _station_label(key, station_data)
                st:  dict[str, int] = _station_style(key, station_data)
                rows.append(f'<circle class="station-dot" data-station="{key}" cx="30" cy="{y}" r="{st["DotRadius"]}" fill="{color}"/>')
                rows.append(f'<text class="station-label" data-station="{key}" x="45" y="{y + 5}" font-size="{st["FontSize"]}" fill="#1e293b" font-weight="{st["FontWeight"]}">{lbl}</text>')
                rows.append(f'<line x1="30" y1="{y + 5}" x2="30" y2="{y + 25}" stroke="{color}" stroke-width="3"/>')
                current_y += 30

        elif sec[0] == "Split":
            fwd: list[StationKey] = sec[1] if len(sec) > 1 else []
            ret: list[StationKey] = sec[2] if len(sec) > 2 else []
            div_y: int = current_y
            rows.append(f'<line x1="30" y1="{div_y - 5}" x2="30" y2="{div_y + 10}" stroke="{color}" stroke-width="3"/>')
            rows.append(f'<line x1="30" y1="{div_y + 10}" x2="50" y2="{div_y + 15}" stroke="{color}" stroke-width="2.5"/>')
            rows.append(f'<line x1="30" y1="{div_y + 10}" x2="190" y2="{div_y + 15}" stroke="{color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>')
            split_y: int = div_y + 20
            max_len: int = max(len(fwd), len(ret))
            for i, key in enumerate(fwd):
                y   = split_y + i * 28
                lbl = _station_label(key, station_data)
                st  = _station_style(key, station_data)
                rows.append(f'<circle class="station-dot" data-station="{key}" cx="50" cy="{y}" r="{st["DotRadius"] - 1}" fill="{color}"/>')
                rows.append(f'<text class="station-label" data-station="{key}" x="60" y="{y + 4}" font-size="{st["FontSize"] - 1}" fill="#1e293b" font-weight="{st["FontWeight"]}">{lbl}</text>')
                if i < len(fwd) - 1:
                    rows.append(f'<line x1="50" y1="{y + 4}" x2="50" y2="{y + 24}" stroke="{color}" stroke-width="2.5"/>')
            for i, key in enumerate(ret):
                y   = split_y + i * 28
                lbl = _station_label(key, station_data)
                st  = _station_style(key, station_data)
                rows.append(f'<circle class="station-dot" data-station="{key}" cx="190" cy="{y}" r="{st["DotRadius"] - 1}" fill="{color}" opacity="0.5"/>')
                rows.append(f'<text class="station-label" data-station="{key}" x="200" y="{y + 4}" font-size="{st["FontSize"] - 1}" fill="#64748b" font-weight="{st["FontWeight"] - 100}">{lbl}</text>')
                if i < len(ret) - 1:
                    rows.append(f'<line x1="190" y1="{y + 4}" x2="190" y2="{y + 24}" stroke="{color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>')
            conv_y:  int = split_y + max_len * 28
            fwd_end: int = split_y + (len(fwd) - 1) * 28 if fwd else split_y - 5
            ret_end: int = split_y + (len(ret) - 1) * 28 if ret else split_y - 5
            if fwd: rows.append(f'<line x1="50"  y1="{fwd_end + 4}" x2="50"  y2="{conv_y + 5}" stroke="{color}" stroke-width="2.5"/>')
            if ret: rows.append(f'<line x1="190" y1="{ret_end + 4}" x2="190" y2="{conv_y + 5}" stroke="{color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>')
            rows.append(f'<line x1="50"  y1="{conv_y + 5}" x2="30" y2="{conv_y + 10}" stroke="{color}" stroke-width="2.5"/>')
            rows.append(f'<line x1="190" y1="{conv_y + 5}" x2="30" y2="{conv_y + 10}" stroke="{color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>')
            rows.append(f'<line x1="30"  y1="{conv_y + 10}" x2="30" y2="{conv_y + 15}" stroke="{color}" stroke-width="3"/>')
            current_y = conv_y + 20

    total_h: int = max(100, current_y + 20)
    return f'<svg width="100%" height="{total_h}" style="margin:8px 0">' + ''.join(rows) + '</svg>'