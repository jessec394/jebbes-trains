import folium, json, os, math
from StationResolver import BuildStationSequence, BuildCoordinateSequence
from HtmlTemplates import SIDEBAR_HTML
from JavascriptGenerator import JavascriptGenerator
from RouteAnalyzer import AnalyzeRouteStructure, GenerateRouteDiagram

import Input.MapData as D1
import Input.Properties as Props

from Input.Waypoints import Waypoints

def _PointToSegmentDistanceM(Lat, Lon, ALat, ALon, BLat, BLon):
    """Minimum distance in metres from point P to segment AB, using equirectangular approximation."""
    # Convert to flat metres (good enough for 50m threshold over short distances)
    CosLat = math.cos(math.radians((ALat + BLat) / 2))
    M_PER_DEG_LAT = 111320.0
    M_PER_DEG_LON = 111320.0 * CosLat

    Px = (Lon - ALon) * M_PER_DEG_LON
    Py = (Lat - ALat) * M_PER_DEG_LAT
    Dx = (BLon - ALon) * M_PER_DEG_LON
    Dy = (BLat - ALat) * M_PER_DEG_LAT

    LenSq = Dx * Dx + Dy * Dy
    if LenSq == 0:
        return math.sqrt(Px * Px + Py * Py)

    T = max(0.0, min(1.0, (Px * Dx + Py * Dy) / LenSq))
    Rx = Px - T * Dx
    Ry = Py - T * Dy
    return math.sqrt(Rx * Rx + Ry * Ry)


def _MinDistanceToGeoJsonM(Lat, Lon, Features):
    """Return the minimum distance in metres from (Lat, Lon) to any line in Features."""
    MinDist = float('inf')
    # ~0.001 degrees ≈ 111 m — skip any segment whose bbox is further than current best
    EarlyExitM = 50.0  # once we're within the threshold we can stop entirely

    for Feature in Features:
        Geom = Feature.get('geometry', {})
        GType = Geom.get('type', '')

        if GType == 'LineString':
            Lines = [Geom['coordinates']]
        elif GType == 'MultiLineString':
            Lines = Geom['coordinates']
        else:
            continue

        for Line in Lines:
            for I in range(len(Line) - 1):
                ALon, ALat = Line[I][0], Line[I][1]
                BLon, BLat = Line[I + 1][0], Line[I + 1][1]

                # Fast bbox reject: if the segment's bounding box is further than
                # current MinDist in degrees, skip the precise calculation.
                MinSegLat = min(ALat, BLat)
                MaxSegLat = max(ALat, BLat)
                MinSegLon = min(ALon, BLon)
                MaxSegLon = max(ALon, BLon)
                BboxMarginDeg = MinDist / 111320.0
                if (Lat < MinSegLat - BboxMarginDeg or Lat > MaxSegLat + BboxMarginDeg or
                        Lon < MinSegLon - BboxMarginDeg or Lon > MaxSegLon + BboxMarginDeg):
                    continue

                D = _PointToSegmentDistanceM(Lat, Lon, ALat, ALon, BLat, BLon)
                if D < MinDist:
                    MinDist = D
                    if MinDist <= EarlyExitM:
                        return MinDist  # Can't get better than "within threshold"

    return MinDist


def _FilterStationsByProximity(StationKeys, AllStations, Features, MaxDistanceM=50):
    """Return only those station keys whose coordinates are within MaxDistanceM of the GeoJSON."""
    Filtered = []
    for Key in StationKeys:
        StationData = AllStations.get(Key)
        if not StationData or 'Location' not in StationData:
            # No coordinate data — keep it to avoid silently dropping stations
            Filtered.append(Key)
            continue
        Lat, Lon = StationData['Location'][0], StationData['Location'][1]
        Dist = _MinDistanceToGeoJsonM(Lat, Lon, Features)
        if Dist <= MaxDistanceM:
            Filtered.append(Key)
    return Filtered


class MapBuilder:
    def __init__(self, LinesPath):
        self.Lines = D1.Lines
        self.Stations = D1.Stations
        self.Nodes = D1.Nodes
        self.Segments = D1.Segments
        self.Modes = Props.Modes
        self.LinesPath = LinesPath
        self.Map = None
        self.RegistryDetailed = []
        self.RegistryFull = []
        self.LineMappingJsDetailed = ""
        self.LineMappingJsFull = ""
        self.BasemapLayerNames = {}
        self.InfoPoints = Waypoints

    def BuildMap(self):
        self.Map = folium.Map(location=[40, -100], zoom_start=5, tiles=None, zoom_control=False, prefer_canvas=True)
        self._AddTileLayers()
        self._ProcessDetailedData()
        self._ProcessFullData()
        self._AddUIElements()

    def _AddTileLayers(self):
        Tiles = [
            ("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", "Light"),
            ("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", "Dark"),
            ("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", "Satellite")
        ]

        LightLayer = folium.TileLayer(
            tiles=Tiles[0][0],
            name="Light",
            attr="&copy; CartoDB",
            overlay=False,
            control=False
        )
        LightLayer.add_to(self.Map)

        DarkLayer = folium.TileLayer(
            tiles=Tiles[1][0],
            name="Dark",
            attr="&copy; CartoDB",
            overlay=False,
            control=False
        )

        SatelliteLayer = folium.TileLayer(
            tiles=Tiles[2][0],
            name="Satellite",
            attr="&copy; Esri",
            overlay=False,
            control=False
        )

        self.BasemapLayerNames = {
            'Light': LightLayer.get_name(),
            'Dark': DarkLayer.get_name(),
            'Satellite': SatelliteLayer.get_name()
        }

        DarkLayer.add_to(self.Map)
        SatelliteLayer.add_to(self.Map)

    def _ProcessDetailedData(self):
        # "Current Progress" map: only lines/patterns from D1 that have a "File" key.
        # Geometry comes from the GeoJSON file(s); station list comes from the Stations segment.
        ModeZOrder = {Mode: self.Modes[Mode].get('zOrder', 0) for Mode in self.Modes.keys()}
        AllStations = {**self.Stations, **self.Nodes}

        LayersToAdd = []

        for Operator, OperatorLines in self.Lines.items():
            for LineName, ServicePatterns in OperatorLines.items():
                FirstPattern = list(ServicePatterns.values())[0]
                ModeId = FirstPattern["Mode"]
                ModeSettings = self.Modes.get(ModeId)
                CombinedFeatures, PatternsPayload, AllLineStations = [], [], []

                for PatternName, PatternData in ServicePatterns.items():
                    # Skip patterns that have no File — they don't exist yet
                    if 'File' not in PatternData:
                        continue

                    # Station sequence from Data1 segments (no coordinate drawing between them)
                    FullPatternStations = BuildStationSequence(PatternData, self.Segments, FilterNonStops=True)

                    # Load GeoJSON geometry from file(s)
                    PatternFiles = PatternData['File'] if isinstance(PatternData['File'], list) else [PatternData['File']]
                    PatternFeatures = []
                    for FileName in PatternFiles:
                        FilePath = os.path.join(self.LinesPath, f"{FileName}.geojson")
                        if os.path.exists(FilePath):
                            with open(FilePath, 'r') as F:
                                GeoData = json.load(F)
                                PatternFeatures.extend(GeoData["features"] if "features" in GeoData else [GeoData])

                    # Drop stations that are more than 50 m from the actual track geometry
                    FullPatternStations = _FilterStationsByProximity(
                        FullPatternStations, AllStations, PatternFeatures, MaxDistanceM=50
                    )

                    for S in FullPatternStations:
                        if S not in AllLineStations:
                            AllLineStations.append(S)

                    Structure = AnalyzeRouteStructure(FullPatternStations)
                    Diagram = GenerateRouteDiagram(Structure, ModeSettings['Color'], FullPatternStations, AllStations)

                    CombinedFeatures.extend(PatternFeatures)

                    PatternsPayload.append({"Name": PatternName, "Stations": FullPatternStations, "Diagram": Diagram})

                if CombinedFeatures:
                    LayersToAdd.append({
                        'Operator': Operator,
                        'LineName': LineName,
                        'ModeId': ModeId,
                        'ModeSettings': ModeSettings,
                        'CombinedFeatures': CombinedFeatures,
                        'PatternsPayload': PatternsPayload,
                        'AllLineStations': AllLineStations,
                        'ZOrder': ModeZOrder.get(ModeId, 0)
                    })

        LayersToAdd.sort(key=lambda x: x['ZOrder'])

        for LayerData in LayersToAdd:
            self._AddDetailedLineLayer(
                LayerData['Operator'], LayerData['LineName'], LayerData['ModeId'],
                LayerData['ModeSettings'], ModeZOrder, LayerData['CombinedFeatures'],
                LayerData['PatternsPayload'], LayerData['AllLineStations']
            )

    def _ProcessFullData(self):
        # "Full Plan" map: all lines from D1, geometry drawn by connecting station coordinates.
        # File keys are intentionally ignored here.
        ModeZOrder = {Mode: self.Modes[Mode].get('zOrder', 0) for Mode in self.Modes.keys()}

        LayersToAdd = []

        for Operator, OperatorLines in self.Lines.items():
            for LineName, ServicePatterns in OperatorLines.items():
                FirstPattern = list(ServicePatterns.values())[0]
                ModeId = FirstPattern["Mode"]
                ModeSettings = self.Modes.get(ModeId)
                PatternsPayload, AllLineStations = [], []
                MultiPatternCoordinates = []

                for PatternName, PatternData in ServicePatterns.items():
                    FullPatternStations = BuildStationSequence(PatternData, self.Segments, FilterNonStops=True)
                    for S in FullPatternStations:
                        if S not in AllLineStations:
                            AllLineStations.append(S)

                    Structure = AnalyzeRouteStructure(FullPatternStations)
                    AllStations = {**self.Stations, **self.Nodes}
                    Diagram = GenerateRouteDiagram(Structure, ModeSettings['Color'], FullPatternStations, AllStations)
                    PatternsPayload.append({"Name": PatternName, "Stations": FullPatternStations, "Diagram": Diagram})

                    PatternCoords = BuildCoordinateSequence(PatternData, self.Segments, self.Nodes, self.Stations)
                    if len(PatternCoords) >= 2:
                        MultiPatternCoordinates.append([[Lat, Lon] for Lat, Lon in PatternCoords])

                if MultiPatternCoordinates:
                    LayersToAdd.append({
                        'Operator': Operator,
                        'LineName': LineName,
                        'ModeId': ModeId,
                        'ModeSettings': ModeSettings,
                        'MultiPatternCoordinates': MultiPatternCoordinates,
                        'PatternsPayload': PatternsPayload,
                        'AllLineStations': AllLineStations,
                        'ZOrder': ModeZOrder.get(ModeId, 0)
                    })

        LayersToAdd.sort(key=lambda x: x['ZOrder'])

        for LayerData in LayersToAdd:
            self._AddFullLineLayer(
                LayerData['Operator'], LayerData['LineName'], LayerData['ModeId'],
                LayerData['ModeSettings'], ModeZOrder, LayerData['MultiPatternCoordinates'],
                LayerData['PatternsPayload'], LayerData['AllLineStations']
            )

    def _AddDetailedLineLayer(self, Operator, LineName, ModeId, ModeSettings, ModeZOrder, CombinedFeatures, PatternsPayload, AllLineStations):
        LineId = f"LineDetailed_{Operator}_{LineName}".replace(" ", "_").replace("'", "")
        ZIndex = ModeZOrder.get(ModeId, 0) * 100

        self.RegistryDetailed.append({
            'Id': LineId, 'Color': ModeSettings['Color'], 'Weight': ModeSettings['Weight'],
            'Name': LineName, 'Operator': Operator,
            'ModeId': ModeId, 'ModeName': ModeSettings['Name'], 'ZIndex': ZIndex,
            'Patterns': PatternsPayload, 'AllLineStations': AllLineStations
        })

        GeoJsonLayer = folium.GeoJson(
            {"type": "FeatureCollection", "features": CombinedFeatures},
            style_function=lambda x, Ms=ModeSettings: {
                'color': Ms['Color'], 'weight': Ms['Weight'], 'opacity': 0.8,
                'lineJoin': 'round', 'lineCap': 'round', 'smoothFactor': 1.5
            },
            smooth_factor=1.5,
            interactive=True
        ).add_to(self.Map)

        LayerName = GeoJsonLayer.get_name()
        self.LineMappingJsDetailed += f"window['{LineId}']={LayerName};{LayerName}.setZIndex({ZIndex});{LayerName}.on('mouseover',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;if(HR.find(X=>X.Id==='{LineId}'))return;HoverLine('{LineId}');}}).on('mouseout',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;if(HR.find(X=>X.Id==='{LineId}'))return;UnhoverLine();}}).on('click',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;if(HR.find(X=>X.Id==='{LineId}'))return;SelectLineFromMap('{LineId}');L.DomEvent.stopPropagation(e);}});"

    def _AddFullLineLayer(self, Operator, LineName, ModeId, ModeSettings, ModeZOrder, MultiPatternCoordinates, PatternsPayload, AllLineStations):
        LineId = f"LineFull_{Operator}_{LineName}".replace(" ", "_").replace("'", "")
        ZIndex = ModeZOrder.get(ModeId, 0) * 100

        self.RegistryFull.append({
            'Id': LineId, 'Color': ModeSettings['Color'], 'Weight': ModeSettings['Weight'],
            'Name': LineName, 'Operator': Operator,
            'ModeId': ModeId, 'ModeName': ModeSettings['Name'], 'ZIndex': ZIndex,
            'Patterns': PatternsPayload, 'AllLineStations': AllLineStations
        })

        PolylineLayer = folium.PolyLine(
            MultiPatternCoordinates,
            color=ModeSettings['Color'],
            weight=ModeSettings['Weight'],
            opacity=0.8,
            smooth_factor=1.5
        ).add_to(self.Map)

        LayerName = PolylineLayer.get_name()
        self.LineMappingJsFull += f"window['{LineId}']={LayerName};if({LayerName}.setZIndex){{{LayerName}.setZIndex({ZIndex});}}else{{{LayerName}.options.pane='overlayPane';}}{LayerName}.on('mouseover',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;if(HR.find(X=>X.Id==='{LineId}'))return;HoverLine('{LineId}');}}).on('mouseout',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;if(HR.find(X=>X.Id==='{LineId}'))return;UnhoverLine();}}).on('click',e=>{{var HR=CurrentView==='Detailed'?RegistryFull:RegistryDetailed;if(HR.find(X=>X.Id==='{LineId}'))return;SelectLineFromMap('{LineId}');L.DomEvent.stopPropagation(e);}});"

    def _AddUIElements(self):
        AllNodes = {**self.Stations, **self.Nodes}

        JsGen = JavascriptGenerator(
            self.RegistryDetailed, self.RegistryFull,
            self.Stations, AllNodes,
            self.Modes,
            self.Map.get_name(),
            self.LineMappingJsDetailed, self.LineMappingJsFull,
            self.BasemapLayerNames,
            self.InfoPoints
        )
        Javascript = JsGen.Generate()

        self.Map.get_root().html.add_child(folium.Element(SIDEBAR_HTML + Javascript))

    def Save(self, Path):
        self.Map.save(Path)