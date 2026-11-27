"""Type aliases shared across the project"""

from __future__ import annotations
from typing import Any, Literal, TypeAlias

# Primitive aliases

LineId:     TypeAlias = str   # e.g. "LineFantasy_Amtrak_Acela"
ModeId:     TypeAlias = str   # e.g. "HSR", "HeavyRail"
Operator:   TypeAlias = str   # e.g. "Amtrak"
LineName:   TypeAlias = str   # e.g. "Acela"
StationKey: TypeAlias = str   # e.g. "BOS", "New_York_Penn"
SegmentKey: TypeAlias = str   # e.g. "NEC_North"
Color:      TypeAlias = str   # CSS hex string, e.g. "#e63946"
Url:        TypeAlias = str
FilePath:   TypeAlias = str

# Coordinate types

LatLon:         TypeAlias = tuple[float, float]          # (lat, lon)
CoordSequence:  TypeAlias = list[LatLon]                 # ordered path
MultiCoords:    TypeAlias = list[list[list[float]]]      # folium PolyLine input

# Data-file dict shapes

StationData: TypeAlias = dict[str, Any]
# {'Label': str, 'Location': LatLon, 'Major'?: bool, 'Airport'?: 'True'}

StationDict: TypeAlias = dict[StationKey, StationData]
# Covers both Stations and Nodes — nodes omit Label/Major/Type

SegmentData: TypeAlias = dict[str, Any]
# {'F' / 'L' / 'R': forward, loop, return items, 'Keep' / 'Skip' / 'Drop': list[str], 'Swap': list[tuple[str, str]]}, all optional

SegmentDict: TypeAlias = dict[SegmentKey, SegmentData]

PatternData: TypeAlias = dict[str, Any]
# {'Mode': ModeId, 'Stations': SegmentKey, 'File'?: str}

ModeSettings: TypeAlias = dict[str, Any]
# {'Name': str, 'Color': Color, 'Weight': number, 'BaseSize': number, 'SizeMultiplier': float, 'zOrder': int}

ModeDict: TypeAlias = dict[ModeId, ModeSettings]

LineCategories: TypeAlias = dict[str, dict[str, PatternData]]
# { "Fantasy": {pattern_name: PatternData}, "Present": {pattern_name: PatternData} }

OperatorLines: TypeAlias = dict[LineName, LineCategories]
LinesDict:     TypeAlias = dict[Operator, OperatorLines]

ProjectRadius: TypeAlias = Literal['S', 'M', 'L', 'X']
# A project's size code: small, medium, large or extra-large

ProjectData: TypeAlias = dict[str, Any]
# {'Source': str, 'Location': LatLon, 'Radius': ProjectRadius, 'Description': str, 'Image'?: str (an image URL, or [URL, 'Credit']), 'Link'?: str}

ProjectsDict: TypeAlias = dict[str, ProjectData]

# Registry / frontend payload types

PatternPayload: TypeAlias = dict[str, Any]
# { "Name": str, "Stations": list[StationKey], "Shape": RouteStructure with each stop as its index in Stations, "Alt"?: [[StationKey]] }

RegistryEntry: TypeAlias = dict[str, Any]
# {'Id', 'Color', 'Weight', 'Name', 'Operator', 'ModeId', 'ModeName', 'ZIndex', 'Patterns', 'AllLineStations', 'Geometry'}

Registry:        TypeAlias = list[RegistryEntry]
BasemapNames:    TypeAlias = dict[str, Any]   # {"Light": folium_layer, "Dark": ..., "Satellite": ...}

# Route structure (output of route_analyzer)

RouteStructure: TypeAlias = dict[str, Any]
# {'Type': 'Linear' | 'Loop', 'Stations': list[StationKey]} or {'Type': 'Branched', 'Sections': [('Shared', keys) | ('Split', out_keys, back_keys) | ('Loop', keys)]}