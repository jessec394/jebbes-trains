import json

class JavascriptGenerator:
    def __init__(self, RegistryNew, RegistryOld, StationsNew, AllNodes, Modes, MapName, LineMappingJsNew, LineMappingJsOld, BasemapLayerNames, InfoPoints):
        self.RegistryNew = RegistryNew
        self.RegistryOld = RegistryOld
        self.StationsNew = StationsNew
        self.AllNodes = AllNodes
        self.Modes = Modes
        self.MapName = MapName
        self.LineMappingJsNew = LineMappingJsNew
        self.LineMappingJsOld = LineMappingJsOld
        self.BasemapLayerNames = BasemapLayerNames
        self.InfoPoints = InfoPoints

    def Generate(self):
        return f"""<script>
window.addEventListener('load', function() {{
    initializeMap(
        {json.dumps(self.MapName)},
        {json.dumps(self.RegistryNew)},
        {json.dumps(self.RegistryOld)},
        {json.dumps(self.StationsNew)},
        {json.dumps(self.AllNodes)},
        {json.dumps(self.Modes)},
        {{
            Light: {self.BasemapLayerNames.get('Light', 'null')},
            Dark: {self.BasemapLayerNames.get('Dark', 'null')},
            Satellite: {self.BasemapLayerNames.get('Satellite', 'null')}
        }},
        `{self.LineMappingJsNew}`,
        `{self.LineMappingJsOld}`,
        {json.dumps(self.InfoPoints)}
    );
}});
</script>"""