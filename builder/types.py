"""
Shared type aliases for the Interactive Map project.

Defining them here once means every module can import a single name instead of
repeating a verbose annotation.  All aliases are plain `TypeAlias` assignments
so they work as both runtime values and static-analysis hints.
"""

from __future__ import annotations
from typing import Any, Literal, TypeAlias


# ── Primitive aliases ─────────────────────────────────────────────────────────

LineId:     TypeAlias = str   # e.g. "LineDetailed_Amtrak_Acela"
ModeId:     TypeAlias = str   # e.g. "HSR", "HeavyRail"
Operator:   TypeAlias = str   # e.g. "Amtrak"
LineName:   TypeAlias = str   # e.g. "Acela"
StationKey: TypeAlias = str   # e.g. "BOS", "New_York_Penn"
SegmentKey: TypeAlias = str   # e.g. "NEC_North"
Color:      TypeAlias = str   # CSS hex string, e.g. "#e63946"
Url:        TypeAlias = str
FilePath:   TypeAlias = str

# ── Coordinate types ──────────────────────────────────────────────────────────

LatLon:         TypeAlias = tuple[float, float]          # (lat, lon)
CoordSequence:  TypeAlias = list[LatLon]                 # ordered path
MultiCoords:    TypeAlias = list[list[list[float]]]      # folium PolyLine input

# ── Data-file dict shapes ─────────────────────────────────────────────────────

StationData: TypeAlias = dict[str, Any]
# {
#   "Label":    str,
#   "Location": LatLon,
#   "Major":    bool,          (optional)
#   "Type":     str,           (optional, e.g. "Airport")
# }

StationDict: TypeAlias = dict[StationKey, StationData]
# Covers both Stations and Nodes — nodes omit Label/Major/Type

SegmentData: TypeAlias = dict[str, Any]
# {
#   "F":    list[str],         (optional) forward component items
#   "L":    list[str],         (optional) loop component items
#   "R":    list[str],         (optional) return component items
#   "Keep": list[str],         (optional)
#   "Skip": list[str],         (optional)
#   "Drop": list[str],         (optional)
#   "Swap": list[tuple[str,str]], (optional)
# }

SegmentDict: TypeAlias = dict[SegmentKey, SegmentData]

PatternData: TypeAlias = dict[str, Any]
# {
#   "Mode":     ModeId,
#   "Stations": SegmentKey,
#   "File":     str,           (optional — GeoJSON filename stem)
# }

ModeSettings: TypeAlias = dict[str, Any]
# {
#   "Name":           str,
#   "Color":          Color,
#   "Weight":         int | float,
#   "BaseSize":       int | float,  # mode's own starting station-dot size in px (idle-view, non-major)
#   "SizeMultiplier": float,        # scales BaseSize further; largest BaseSize*SizeMultiplier among a station's serving modes wins (both values taken together)
#   "zOrder":         int,
# }

ModeDict: TypeAlias = dict[ModeId, ModeSettings]

LineCategories: TypeAlias = dict[str, dict[str, PatternData]]
# { "Fantasy": {pattern_name: PatternData}, "Present": {pattern_name: PatternData} }

OperatorLines: TypeAlias = dict[LineName, LineCategories]
LinesDict:     TypeAlias = dict[Operator, OperatorLines]

ProjectRadius: TypeAlias = Literal['S', 'M', 'L', 'X']
# Marker/circle size code for a project on the map — small / medium / large / extra-large.
# Stored directly as one of these letters; no numeric km value or named constant involved.

ProjectData: TypeAlias = dict[str, Any]
# {
#   "Source":      str,
#   "Location":    LatLon,
#   "Radius":      ProjectRadius,
#   "Description": str,
#   "Image":       str,   (optional)
#   "Link":        str,   (optional)
# }

ProjectsDict: TypeAlias = dict[str, ProjectData]

# ── Registry / frontend payload types ────────────────────────────────────────

PatternPayload: TypeAlias = dict[str, Any]
# { "Name": str, "Stations": list[StationKey], "Diagram": str }

RegistryEntry: TypeAlias = dict[str, Any]
# {
#   "Id":              LineId,
#   "Color":           Color,
#   "Weight":          int | float,
#   "Name":            LineName,
#   "Operator":        Operator,
#   "ModeId":          ModeId,
#   "ModeName":        str,
#   "ZIndex":          int,
#   "Patterns":        list[PatternPayload],
#   "AllLineStations": list[StationKey],
# }

Registry:        TypeAlias = list[RegistryEntry]
LineMappingJs:   TypeAlias = str    # raw JS fragment wiring folium layer names → window globals
BasemapNames:    TypeAlias = dict[str, Any]   # {"Light": folium_layer, "Dark": ..., "Satellite": ...}

# ── Route structure (output of route_analyzer) ────────────────────────────────

RouteStructure: TypeAlias = dict[str, Any]
# {
#   "Type":     "Linear" | "OutAndBack" | "Loop" | "Lollipop" | "Complex",
#   "Segments": list[list[StationKey]],   (Linear / OutAndBack / Loop / Lollipop)
#   "Sections": list[tuple],              (Complex only)
# }