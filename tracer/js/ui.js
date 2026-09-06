// Route browser + server integration
// Depends on: core.js (Application, App), waypoints.js (WaypointManager)

const STATIONS = [];
let SelectedStation = null;     // target: which map_data station gets overwritten
let SelectedNimbySource = null; // source: {name, lat, lon} picked from the loaded NIMBY file

const ROUTES = [];
let ActiveRoute = null;

async function LoadStations() {
    try {
        const data = await fetch('/api/stations').then(r => r.json());
        STATIONS.length = 0;
        data.forEach(s => STATIONS.push(s));
        RenderStationList(STATIONS);
        if (App?.Canvas) {
            App.Canvas.SetMapDataStations(STATIONS);
            App.Canvas.ForceRedraw = true;
            App.Redraw();
        }
    } catch(e) { console.error('Failed to load stations', e); }
}

function RenderStationList(stations) {
    const list = document.getElementById('StationList');
    list.innerHTML = '';
    stations.forEach(s => {
        const item = document.createElement('div');
        item.className = 'StationItem';
        item.dataset.key = s.Key;
        if (SelectedStation && SelectedStation.Key === s.Key) item.classList.add('Active');
        const keyLine = s.Label !== s.Key ? `<div class="StationItemKey">${s.Key}</div>` : '';
        item.innerHTML = `<div class="StationItemName">${s.Label}</div>
                          ${keyLine}
                          <div class="StationItemMeta">${s.Location[0]}, ${s.Location[1]}</div>`;
        item.addEventListener('click', () => SelectStation(s, item));
        list.appendChild(item);
    });
}

function FilterStations() {
    const q = document.getElementById('StationSearch').value.toLowerCase();
    RenderStationList(STATIONS.filter(s =>
        s.Label.toLowerCase().includes(q) || s.Key.toLowerCase().includes(q)
    ));
}

function _refreshUpdateStationBtn() {
    const btn = document.getElementById('UpdateStationBtn');
    if (btn) btn.disabled = !SelectedStation || !SelectedNimbySource;
}

function SelectStation(station, el) {
    document.querySelectorAll('.StationItem').forEach(i => i.classList.remove('Active'));
    if (el) el.classList.add('Active');
    SelectedStation = station;
    App.Canvas.SelectedMapDataStationKey = station.Key;

    document.getElementById('SelectedStationBanner').textContent =
        `Selected: ${station.Label}${station.Label !== station.Key ? ` (${station.Key})` : ''} — ${station.Location[0]}, ${station.Location[1]}`;
    _refreshUpdateStationBtn();

    App.Canvas.ForceRedraw = true;
    App.Redraw();
}

// Lets clicking a map_data station marker on the canvas select it here too.
function SelectStationByKey(key) {
    const station = STATIONS.find(s => s.Key === key);
    if (!station) return;
    const el = document.querySelector(`.StationItem[data-key="${CSS.escape(key)}"]`);
    SelectStation(station, el);
    if (el) el.scrollIntoView({block: 'nearest'});
}

// Called when the user clicks a loaded NIMBY-track station dot on the canvas.
// This is the coordinate *source* — picking one never drops a waypoint.
function SelectNimbySource(station, index) {
    SelectedNimbySource = { name: station.name || '(unnamed)', lon: station.coords[0], lat: station.coords[1] };
    App.Canvas.SelectedNimbyStationIndex = index;

    document.getElementById('SelectedSourceBanner').textContent =
        `Source: ${SelectedNimbySource.name} — ${SelectedNimbySource.lat}, ${SelectedNimbySource.lon}`;
    _refreshUpdateStationBtn();

    App.Canvas.ForceRedraw = true;
    App.Redraw();
}

// Overwrite the selected map_data station's coordinates with those of the
// selected NIMBY-file station.
Application.prototype.UpdateStationLocation = async function() {
    if (!SelectedStation)     { alert('Select a station from the panel first'); return; }
    if (!SelectedNimbySource) { alert('Enable "Show Stations" and click a NIMBY station on the map first — that\'s the coordinate that will be applied.'); return; }

    const btn = document.getElementById('UpdateStationBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Updating…';

    try {
        const res = await fetch('/api/update_station', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                key:     SelectedStation.Key,
                section: SelectedStation.Section,
                lat:     SelectedNimbySource.lat,
                lon:     SelectedNimbySource.lon,
            })
        });
        const result = await res.json();
        if (result.ok) {
            this.SetStatus(`✓ Updated ${SelectedStation.Label}`, '#2ecc71');
            SelectedStation.Location = [SelectedNimbySource.lat, SelectedNimbySource.lon];
            await LoadStations();
            btn.textContent = '✓ Updated!';
        } else {
            throw new Error(result.error);
        }
    } catch(e) {
        alert('Update failed: ' + e.message);
        btn.textContent = '📍 Set to Selected NIMBY Station';
        btn.disabled = false;
        return;
    }
    setTimeout(() => {
        btn.disabled = !SelectedStation || !SelectedNimbySource;
        btn.textContent = '📍 Set to Selected NIMBY Station';
    }, 1500);
};



async function LoadRoutes() {
    try {
        const data = await fetch('/api/routes').then(r => r.json());
        ROUTES.length = 0;
        data.forEach(r => ROUTES.push(r));
        RenderRouteList(ROUTES);
    } catch(e) { console.error('Failed to load routes', e); }
}

function RenderRouteList(routes) {
    const list = document.getElementById('RouteList');
    const groups = {};
    routes.forEach(r => { (groups[r.Operator] = groups[r.Operator] || []).push(r); });

    list.innerHTML = '';
    Object.keys(groups).sort().forEach(op => {
        const grp = document.createElement('div');
        grp.className = 'RouteGroup';
        const hdr = document.createElement('div');
        hdr.className = 'RouteGroupHeader';
        hdr.textContent = op;
        grp.appendChild(hdr);

        groups[op].forEach(r => {
            const item = document.createElement('div');
            item.className = 'RouteItem';
            item.dataset.file = r.File;
            item.innerHTML = `<div class="RouteItemName">${r.Line}</div>
                              <div class="RouteItemMeta">${r.Pattern} · ${r.Mode}</div>`;

            fetch(`/api/waypoints?file=${encodeURIComponent(r.File)}`)
                .then(res => res.json())
                .then(data => {
                    if (data.exists) {
                        const badge = document.createElement('div');
                        badge.className = 'RouteItemSaved';
                        badge.textContent = `✓ ${data.count} waypoints saved`;
                        item.appendChild(badge);
                    }
                });

            item.addEventListener('click', () => SelectRoute(r, item));
            grp.appendChild(item);
        });
        list.appendChild(grp);
    });
}

function FilterRoutes() {
    const q = document.getElementById('RouteSearch').value.toLowerCase();
    RenderRouteList(ROUTES.filter(r =>
        r.Line.toLowerCase().includes(q) ||
        r.Operator.toLowerCase().includes(q) ||
        r.Pattern.toLowerCase().includes(q)
    ));
}

async function SelectRoute(route, el) {
    document.querySelectorAll('.RouteItem').forEach(i => i.classList.remove('Active'));
    el.classList.add('Active');
    ActiveRoute = route;

    document.getElementById('ActiveRouteBanner').style.display = 'block';
    document.getElementById('ActiveRouteBanner').textContent =
        `Active: ${route.Operator} — ${route.Line} (${route.Pattern})`;
    document.getElementById('SaveRouteBtn').style.display = 'block';

    try {
        const data = await fetch(`/api/waypoints?file=${encodeURIComponent(route.File)}`).then(r => r.json());
        if (data.exists && data.waypoints?.length) {
            App.WaypointMgr.Waypoints = data.waypoints;
            App.WaypointMgr.SelectedIndex = null;
            App.WaypointMgr.UpdateList();
            App.Path = null;
            App.ZoomToWaypoints();
            App.Canvas.ForceRedraw = true;
            App.Redraw();
            App.SetStatus(`Loaded ${data.waypoints.length} waypoints for ${route.Line}`, '#2ecc71');
        } else {
            App.SetStatus(`No saved waypoints for ${route.Line} — place them on the map`, '#f39c12');
        }
    } catch(e) { App.SetStatus('Could not load waypoints', '#e74c3c'); }
}

// Save GeoJSON + waypoints to server
Application.prototype.SaveRoute = async function() {
    if (!ActiveRoute) { alert('Select a route from the panel first'); return; }
    if (!this.Path?.length) { alert('Trace the path first (🧭 Trace)'); return; }

    const btn = document.getElementById('SaveRouteBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Saving…';

    try {
        const res = await fetch('/api/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                file:      ActiveRoute.File,
                geojson:   { type: 'FeatureCollection', features: [{
                    type: 'Feature',
                    properties: { name: ActiveRoute.Line },
                    geometry:   { type: 'LineString', coordinates: this.Path }
                }]},
                waypoints: this.WaypointMgr.Waypoints,
            })
        });
        const result = await res.json();
        if (result.ok) {
            btn.textContent = '✓ Saved!';
            this.SetStatus(`Saved ${ActiveRoute.File}.geojson + waypoints`, '#2ecc71');
            LoadRoutes();
            setTimeout(() => { btn.disabled = false; btn.textContent = '💾 Save GeoJSON + Waypoints'; }, 2000);
        } else {
            throw new Error(result.error);
        }
    } catch(e) {
        alert('Save failed: ' + e.message);
        btn.disabled = false;
        btn.textContent = '💾 Save GeoJSON + Waypoints';
    }
};

// Download the current traced path (+ waypoints) as a JSON file the browser
// saves locally. Works whether or not a Fantasy Route is selected in the
// panel — unlike SaveRoute(), which requires an ActiveRoute and writes to
// the server's routes_fantasy folder. Use this for a quick local export, or
// for traces that aren't tied to one of the predefined fantasy routes.
Application.prototype.ExportPath = function() {
    if (!this.Path?.length) { alert('Trace the path first (🧭 Trace)'); return; }

    const defaultName = ActiveRoute ? ActiveRoute.File : 'traced_route';
    const name = prompt('Filename for export (no extension):', defaultName);
    if (!name) return;

    const payload = {
        geojson: {
            type: 'FeatureCollection',
            features: [{
                type: 'Feature',
                properties: { name: ActiveRoute ? ActiveRoute.Line : name },
                geometry:   { type: 'LineString', coordinates: this.Path }
            }]
        },
        waypoints: this.WaypointMgr.Waypoints
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: 'application/json'});
    const url  = window.URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${name}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);

    this.SetStatus(`✓ Exported ${name}.json`, '#2ecc71');
};

// Override LoadFile — always auto-load the full NIMBY track file from server
Application.prototype.LoadFile = function() {
    document.getElementById('Placeholder').classList.add('Hidden');
    this.FileMgr.PendingServerLoad = true;
    this.FileMgr.LoadEntireNetwork();
};

// Patch FileManager for server-side track loading
const _origWithRegion  = FileManager.prototype.LoadWithRegionSelect;
const _origEntireNet   = FileManager.prototype.LoadEntireNetwork;

FileManager.prototype.LoadWithRegionSelect = async function() {
    document.getElementById('RegionPromptDialog').classList.remove('Active');
    if (!this.PendingServerLoad) return _origWithRegion.call(this);
    this.PendingServerLoad = false;
    App.Canvas.SelectMode = true;
    App.SetStatus('Drag to select region; right-click to cancel', '#f39c12');
    App.Redraw();
    const region = await new Promise(resolve => {
        const check = () => App.RegionSelected !== null ? resolve(App.RegionSelected) : requestAnimationFrame(check);
        check();
    });
    if (region) { App.SetStatus('⏳ Loading…', '#f39c12'); await this.LoadFromServer(region); }
    else { App.SetStatus('Cancelled', '#95a5a6'); document.getElementById('Placeholder').classList.remove('Hidden'); }
};

FileManager.prototype.LoadEntireNetwork = async function() {
    if (!this.PendingServerLoad) return _origEntireNet.call(this);
    this.PendingServerLoad = false;
    document.getElementById('RegionPromptDialog').classList.remove('Active');
    App.SetStatus('⏳ Loading…', '#f39c12');
    await this.LoadFromServer(null);
};

FileManager.prototype.LoadFromServer = async function(region) {
    try {
        const url = region
            ? `/api/trackdata?minlon=${region[0]}&maxlon=${region[1]}&minlat=${region[2]}&maxlat=${region[3]}`
            : '/api/trackdata';
        const data = await fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
        await (region ? this.ProcessDataWithRegion(data, region) : this.ProcessData(data));
    } catch(e) {
        alert('Failed to load track file: ' + e.message);
        App.SetStatus('Error loading track file', '#e74c3c');
        document.getElementById('Placeholder').classList.remove('Hidden');
    }
};

// Auto-load the full NIMBY track file on page load
window.addEventListener('load', () => {
    setTimeout(() => {
        if (typeof App === 'undefined') return;
        document.getElementById('Placeholder').classList.add('Hidden');
        App.SetStatus('⏳ Loading track data from server…', '#f39c12');
        App.FileMgr.LoadFromServer(null);
    }, 300);
});

LoadRoutes();
LoadStations();