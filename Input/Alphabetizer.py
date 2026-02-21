from MapData import Nodes, Stations, Segments, Lines
import pyperclip

def FormatCoordinates(Tuple):
    return f"({Tuple[0]:.6f}, {Tuple[1]:.6f})"

Output = "Nodes = {\n"
for Key in sorted(Nodes.keys()):
    Content = Nodes[Key]
    if isinstance(Content, dict) and 'Location' in Content:
        LocationString = FormatCoordinates(Content['Location'])
        Output += f'\t"{Key}": {{\'Location\': {LocationString}}},\n'
    else:
        Output += f'\t"{Key}": {repr(Content)},\n'
Output += "}\n\n"

Output += "Stations = {\n"
for Key in sorted(Stations.keys()):
    Content = Stations[Key]
    if isinstance(Content, dict) and 'Location' in Content:
        LocationString = FormatCoordinates(Content['Location'])
        inner_parts = [f"'Location': {LocationString}"]
        for k, v in Content.items():
            if k != 'Location':
                inner_parts.append(f"{repr(k)}: {repr(v)}")
        station_content = "{ " + ", ".join(inner_parts) + " }"
        Output += f'    "{Key}": {station_content},\n'
    else:
        Output += f'    "{Key}": {repr(Content)},\n'
Output += "}\n\n"

Output += "Segments = {\n"
for Key in sorted(Segments.keys()):
    Content = Segments[Key]
    Output += f'    "{Key}": {{\n'
    if isinstance(Content, dict):
        for InnerKey, InnerList in Content.items():
            Output += f'        "{InnerKey}": {repr(InnerList)},\n'
    Output += "    },\n"
Output += "}\n\n"

Output += "Lines = {\n"
for Key in sorted(Lines.keys()):
    AgencyDict = Lines[Key]
    Output += f'    "{Key}": {{\n'
    if isinstance(AgencyDict, dict):
        for RouteKey, RouteDict in AgencyDict.items():
            Output += f'        "{RouteKey}": {{\n'
            if isinstance(RouteDict, dict):
                for SegmentKey, SegmentData in RouteDict.items():
                    Output += f'            "{SegmentKey}": {repr(SegmentData)},\n'
            Output += "        },\n"
    Output += "    },\n"
Output += "}"

pyperclip.copy(Output)