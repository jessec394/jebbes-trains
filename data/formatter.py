from map_data import *
import os

directory = os.path.abspath(os.path.dirname(__file__))
file_path = os.path.join(directory, 'map_data.py')

def formatCoordinates(tuple_val):
    return f"({tuple_val[0]:.5f}, {tuple_val[1]:.5f})"

def formatDict(d):
    """Formats a station dict on one line, applying formatCoordinates to 'Location'."""
    return "{" + formatItems(d) + "}"

def formatItems(d):
    inner_parts = []
    if 'Location' in d:
        inner_parts.append(f"'Location': {formatCoordinates(d['Location'])}")
    for k in sorted(v for v in d.keys() if v not in ('Location', 'Platforms')):
        inner_parts.append(f"{repr(k)}: {repr(d[k])}")
    return ", ".join(inner_parts)

def formatStation(key, d):
    """One line, or for a station with platforms a block with one line per platform (a platform is always a dict with its Location)."""
    if not d.get('Platforms'):
        return f'    "{key}": {formatDict(d)},\n'
    out = f'    "{key}": {{\n        {formatItems(d)},\n        \'Platforms\': {{\n'
    for name in sorted(d['Platforms']):
        p = d['Platforms'][name]
        p = {k: v for k, v in p.items() if k != 'Label'} if isinstance(p, dict) else {'Location': p}      # a platform uses its station's label
        out += f"            {repr(name)}: {formatDict(p)},\n"
    return out + "        },\n    },\n"

output = ""

output += "Modes = {\n"
for key in Modes.keys():
    content = Modes[key]
    inner_parts = [f"{repr(k)}: {repr(content[k])}" for k in content.keys()]
    output += f'    "{key}": {{{", ".join(inner_parts)}}},\n'
output += "}\n\n"

output += "Nodes = {\n"
for key in sorted(Nodes.keys()):
    content = Nodes[key]
    if isinstance(content, dict) and 'Location' in content:
        location_string = formatCoordinates(content['Location'])
        output += f'    "{key}": {{\'Location\': {location_string}}},\n'
    else:
        output += f'    "{key}": {repr(content)},\n'
output += "}\n\n"

output += "Stations = {\n"
for key in sorted(Stations.keys()):
    content = Stations[key]
    if isinstance(content, dict) and 'Location' in content:
        output += formatStation(key, content)
    else:
        output += f'    "{key}": {repr(content)},\n'
output += "}\n\n"

output += "Segments = {\n"
for key in sorted(Segments.keys()):
    content = Segments[key]
    output += f'    "{key}": {{\n'
    if isinstance(content, dict):
        for inner_key in sorted(content.keys()):
            output += f'        "{inner_key}": {repr(content[inner_key])},\n'
    output += "    },\n"
output += "}\n\n"

output += "Lines = {\n"
for operator_key in sorted(Lines.keys()):
    operator_dict = Lines[operator_key]
    output += f'    "{operator_key}": {{\n'
    if isinstance(operator_dict, dict):
        for line_key in sorted(operator_dict.keys()):
            line_dict = operator_dict[line_key]
            output += f'        "{line_key}": {{\n'
            if isinstance(line_dict, dict):
                for category in ["Fantasy", "Present"]:
                    if category not in line_dict: continue
                    patterns = line_dict[category]
                    output += f'            "{category}": {{\n'
                    if isinstance(patterns, dict):
                        for pattern_key in sorted(patterns.keys()):
                            output += f'                "{pattern_key}": {repr(patterns[pattern_key])},\n'
                    output += "            },\n"
            output += "        },\n"
    output += "    },\n"
output += "}\n\n"

output += "Destinations = {\n"
for category in sorted(Destinations.keys()):
    output += f'    "{category}": {{\n'
    for dest_name in sorted(Destinations[category].keys()):
        details = Destinations[category][dest_name]
        if isinstance(details, dict) and 'Location' in details:
            loc_str = formatCoordinates(details['Location'])
            inner = f'"Location": {loc_str}'
            inner += f', "Stations": {repr(sorted(details.get("Stations", [])))}'
            for k in sorted(v for v in details.keys() if v not in ('Location', 'Stations')):
                inner += f', {repr(k)}: {repr(details[k])}'
            output += f'        "{dest_name}": {{{inner}}},\n'
        else:
            output += f'        "{dest_name}": {repr(details)},\n'
    output += "    },\n"
output += "}\n\n"

output += "Projects = {\n"
for key in sorted(Projects.keys()):
    content = Projects[key]
    loc_str = formatCoordinates(content['Location'])
    inner = f'"Source": {repr(content["Source"])}'
    inner += f', "Location": {loc_str}'
    inner += f', "Radius": {repr(content["Radius"])}'
    for k in sorted(v for v in content.keys() if v not in ('Source', 'Location', 'Radius')):
        inner += f', {repr(k)}: {repr(content[k])}'
    output += f'    "{key}": {{{inner}}},\n'
output += "}"

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(output)