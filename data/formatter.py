from map_data import *
import os

directory = os.path.abspath(os.path.dirname(__file__))
file_path = os.path.join(directory, 'map_data.py')

def formatCoordinates(tuple):
    return f"({tuple[0]:.6f}, {tuple[1]:.6f})"

output = "Nodes = {\n"
for key in sorted(Nodes.keys()):
    content = Nodes[key]
    if isinstance(content, dict) and 'Location' in content:
        location_string = formatCoordinates(content['Location'])
        output += f'\t"{key}": {{\'Location\': {location_string}}},\n'
    else:
        output += f'\t"{key}": {repr(content)},\n'
output += "}\n\n"

output += "Stations = {\n"
for key in sorted(Stations.keys()):
    content = Stations[key]
    if isinstance(content, dict) and 'Location' in content:
        location_string = formatCoordinates(content['Location'])
        inner_parts = [f"'Location': {location_string}"]
        for k, v in content.items():
            if k != 'Location':
                inner_parts.append(f"{repr(k)}: {repr(v)}")
        station_content = "{" + ", ".join(inner_parts) + "}"
        output += f'    "{key}": {station_content},\n'
    else:
        output += f'    "{key}": {repr(content)},\n'
output += "}\n\n"

output += "Segments = {\n"
for key in sorted(Segments.keys()):
    content = Segments[key]
    output += f'    "{key}": {{\n'
    if isinstance(content, dict):
        for inner_key, inner_value in content.items():
            output += f'        "{inner_key}": {repr(inner_value)},\n'
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
    category_content = Destinations[category]
    for dest_name in sorted(category_content.keys()):
        details = category_content[dest_name]
        if isinstance(details, dict) and 'Location' in details:
            loc_str = formatCoordinates(details['Location'])
            sorted_stations = sorted(details.get('Stations', []))

            present = details.get('Present', True)
            fantasy = details.get('Fantasy', True)

            output += (f'        "{dest_name}": {{"Location": {loc_str}, '
                       f'"Stations": {repr(sorted_stations)}, '
                       f'\'Present\': {present}, \'Fantasy\': {fantasy}}},\n')
        else:
            output += f'        "{dest_name}": {repr(details)},\n'
    output += "    },\n"
output += "}"

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(output)