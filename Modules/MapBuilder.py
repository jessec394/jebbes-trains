import folium, json, os
from StationResolver import BuildStationSequence, BuildCoordinateSequence
from HtmlTemplates import SIDEBAR_HTML
from JavascriptGenerator import JavascriptGenerator
from RouteAnalyzer import AnalyzeRouteStructure, GenerateRouteDiagram

import Input.Data1 as D1
import Input.Data2 as D2
import Input.Properties as Props

from Input.Waypoints import Waypoints

class MapBuilder:
    def __init__(self, LinesPath):
        self.LinesNew = D2.Lines
        self.StationsNew = D2.Stations
        self.Modes = Props.Modes
        self.SegmentsNew = D2.Segments
        self.LinesOld = D1.Lines
        self.NodesOld = D1.Nodes
        self.StationsOld = D1.Stations
        self.SegmentsOld = D1.Segments
        self.LinesPath = LinesPath
        self.Map = None
        self.RegistryNew = []
        self.RegistryOld = []
        self.LineMappingJsNew = ""
        self.LineMappingJsOld = ""
        self.BasemapLayerNames = {}
        self.InfoPoints = Waypoints

    def BuildMap(self):
        self.Map = folium.Map(location=[40, -100], zoom_start=5, tiles=None, zoom_control=False, prefer_canvas=True)
        self._AddTileLayers()
        self._ProcessDataNew()
        self._ProcessDataOld()
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

    def _ProcessDataNew(self):
        ModeZOrder = {Mode: self.Modes[Mode].get('zOrder', 0) for Mode in self.Modes.keys()}

        # Collect all layer data first
        LayersToAdd = []

        for Operator, OperatorLines in self.LinesNew.items():
            for LineName, ServicePatterns in OperatorLines.items():
                FirstPattern = list(ServicePatterns.values())[0]
                ModeId = FirstPattern["Mode"]
                ModeSettings = self.Modes.get(ModeId)
                CombinedFeatures, PatternsPayload, AllLineStations = [], [], []

                for PatternName, PatternData in ServicePatterns.items():
                    FullPatternStations = BuildStationSequence(PatternData, self.SegmentsNew)
                    for S in FullPatternStations:
                        if S not in AllLineStations:
                            AllLineStations.append(S)

                    Structure = AnalyzeRouteStructure(FullPatternStations)
                    Diagram = GenerateRouteDiagram(Structure, ModeSettings['Color'], FullPatternStations, self.StationsNew)

                    PatternFiles = PatternData['File'] if isinstance(PatternData['File'], list) else [PatternData['File']]
                    for FileName in PatternFiles:
                        Path = os.path.join(self.LinesPath, f"{FileName}.geojson")
                        if os.path.exists(Path):
                            with open(Path, 'r') as F:
                                GeoData = json.load(F)
                                CombinedFeatures.extend(GeoData["features"] if "features" in GeoData else [GeoData])

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

        # Sort by ZOrder and add to map
        LayersToAdd.sort(key=lambda x: x['ZOrder'])

        for LayerData in LayersToAdd:
            self._AddLineLayerNew(
                LayerData['Operator'], LayerData['LineName'], LayerData['ModeId'],
                LayerData['ModeSettings'], ModeZOrder, LayerData['CombinedFeatures'],
                LayerData['PatternsPayload'], LayerData['AllLineStations']
            )

    def _ProcessDataOld(self):
        ModeZOrder = {Mode: self.Modes[Mode].get('zOrder', 0) for Mode in self.Modes.keys()}

        # Collect all layer data first
        LayersToAdd = []

        for Operator, OperatorLines in self.LinesOld.items():
            for LineName, ServicePatterns in OperatorLines.items():
                FirstPattern = list(ServicePatterns.values())[0]
                ModeId = FirstPattern["Mode"]
                ModeSettings = self.Modes.get(ModeId)
                PatternsPayload, AllLineStations = [], []
                MultiPatternCoordinates = []

                for PatternName, PatternData in ServicePatterns.items():
                    FullPatternStations = BuildStationSequence(PatternData, self.SegmentsOld, FilterNonStops=True)
                    for S in FullPatternStations:
                        if S not in AllLineStations:
                            AllLineStations.append(S)

                    Structure = AnalyzeRouteStructure(FullPatternStations)
                    AllStations = {**self.StationsOld, **self.NodesOld}
                    Diagram = GenerateRouteDiagram(Structure, ModeSettings['Color'], FullPatternStations, AllStations)
                    PatternsPayload.append({"Name": PatternName, "Stations": FullPatternStations, "Diagram": Diagram})

                    PatternCoords = BuildCoordinateSequence(PatternData, self.SegmentsOld, self.NodesOld, self.StationsOld)
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

        # Sort by ZOrder and add to map
        LayersToAdd.sort(key=lambda x: x['ZOrder'])

        for LayerData in LayersToAdd:
            self._AddLineLayerOld(
                LayerData['Operator'], LayerData['LineName'], LayerData['ModeId'],
                LayerData['ModeSettings'], ModeZOrder, LayerData['MultiPatternCoordinates'],
                LayerData['PatternsPayload'], LayerData['AllLineStations']
            )

    def _AddLineLayerNew(self, Operator, LineName, ModeId, ModeSettings, ModeZOrder, CombinedFeatures, PatternsPayload, AllLineStations):
        LineId = f"LineNew_{Operator}_{LineName}".replace(" ", "_").replace("'", "")
        ZIndex = ModeZOrder.get(ModeId, 0) * 100

        self.RegistryNew.append({
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
        self.LineMappingJsNew += f"window['{LineId}']={LayerName};{LayerName}.setZIndex({ZIndex});{LayerName}.on('mouseover',e=>{{var HR=CurrentView==='New'?RegistryOld:RegistryNew;if(HR.find(X=>X.Id==='{LineId}'))return;HoverLine('{LineId}');}}).on('mouseout',e=>{{var HR=CurrentView==='New'?RegistryOld:RegistryNew;if(HR.find(X=>X.Id==='{LineId}'))return;UnhoverLine();}}).on('click',e=>{{var HR=CurrentView==='New'?RegistryOld:RegistryNew;if(HR.find(X=>X.Id==='{LineId}'))return;SelectLineFromMap('{LineId}');L.DomEvent.stopPropagation(e);}});"

    def _AddLineLayerOld(self, Operator, LineName, ModeId, ModeSettings, ModeZOrder, MultiPatternCoordinates, PatternsPayload, AllLineStations):
        LineId = f"LineOld_{Operator}_{LineName}".replace(" ", "_").replace("'", "")
        ZIndex = ModeZOrder.get(ModeId, 0) * 100

        self.RegistryOld.append({
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
        self.LineMappingJsOld += f"window['{LineId}']={LayerName};if({LayerName}.setZIndex){{{LayerName}.setZIndex({ZIndex});}}else{{{LayerName}.options.pane='overlayPane';}}{LayerName}.on('mouseover',e=>{{var HR=CurrentView==='New'?RegistryOld:RegistryNew;if(HR.find(X=>X.Id==='{LineId}'))return;HoverLine('{LineId}');}}).on('mouseout',e=>{{var HR=CurrentView==='New'?RegistryOld:RegistryNew;if(HR.find(X=>X.Id==='{LineId}'))return;UnhoverLine();}}).on('click',e=>{{var HR=CurrentView==='New'?RegistryOld:RegistryNew;if(HR.find(X=>X.Id==='{LineId}'))return;SelectLineFromMap('{LineId}');L.DomEvent.stopPropagation(e);}});"

    def _AddUIElements(self):
        AllNodesForOld = {**self.StationsOld, **self.NodesOld}

        JsGen = JavascriptGenerator(
            self.RegistryNew, self.RegistryOld,
            self.StationsNew, AllNodesForOld,
            self.Modes,
            self.Map.get_name(),
            self.LineMappingJsNew, self.LineMappingJsOld,
            self.BasemapLayerNames,
            self.InfoPoints
        )
        Javascript = JsGen.Generate()

        self.Map.get_root().html.add_child(folium.Element(SIDEBAR_HTML + Javascript))

    def Save(self, Path):
        self.Map.save(Path)