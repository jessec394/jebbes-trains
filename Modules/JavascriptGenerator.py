import json

class JavascriptGenerator:
    def __init__(self, RegistryDetailed, RegistryFull, StationsDetailed, AllNodes, Modes, MapName, LineMappingJsDetailed, LineMappingJsFull, BasemapLayerNames, InfoPoints):
        self.RegistryDetailed = RegistryDetailed
        self.RegistryFull = RegistryFull
        self.StationsDetailed = StationsDetailed
        self.AllNodes = AllNodes
        self.Modes = Modes
        self.MapName = MapName
        self.LineMappingJsDetailed = LineMappingJsDetailed
        self.LineMappingJsFull = LineMappingJsFull
        self.BasemapLayerNames = BasemapLayerNames
        self.InfoPoints = InfoPoints

    def Generate(self):
        return f"""<script>
window.addEventListener('load', function() {{
    initializeMap(
        {json.dumps(self.MapName)},
        {json.dumps(self.RegistryDetailed)},
        {json.dumps(self.RegistryFull)},
        {json.dumps(self.StationsDetailed)},
        {json.dumps(self.AllNodes)},
        {json.dumps(self.Modes)},
        {{
            Light: {self.BasemapLayerNames.get('Light', 'null')},
            Dark: {self.BasemapLayerNames.get('Dark', 'null')},
            Satellite: {self.BasemapLayerNames.get('Satellite', 'null')}
        }},
        `{self.LineMappingJsDetailed}`,
        `{self.LineMappingJsFull}`,
        {json.dumps(self.InfoPoints)}
    );
}});
</script>"""