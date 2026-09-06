class Application {
  constructor() {
    this.Canvas = new MapCanvas(document.getElementById('MapCanvas'));
    this.WaypointMgr = new WaypointManager();
    this.FileMgr = new FileManager();
    this.Path = null;
    this.DragIndex = null;
    this.IsDragging = false;
    this.ExportData = null;
    this.RegionSelected = null;
    this.InitEvents();
    this.InitializeBasemap();
  }

  async InitializeBasemap() {
    this.SetStatus('Loading borders...', '#f39c12');
    await this.Canvas.LoadBorders();
    this.SetStatus('Ready to load file', '#2ecc71');
    this.Redraw();
  }

  InitEvents() {
    const Canvas = document.getElementById('MapCanvas');
    Canvas.addEventListener('click', (E) => this.OnClick(E));
    Canvas.addEventListener('mousedown', (E) => this.OnMouseDown(E));
    Canvas.addEventListener('mousemove', (E) => this.OnMouseMove(E));
    Canvas.addEventListener('mouseup', (E) => this.OnMouseUp(E));
    Canvas.addEventListener('contextmenu', (E) => {
      E.preventDefault();
      this.OnRightClick(E);
    });
    Canvas.addEventListener('wheel', (E) => {
      E.preventDefault();
      this.OnWheel(E);
    });
    document.addEventListener('keydown', (E) => this.OnKeyDown(E));
    document.getElementById('EditModal').addEventListener('click', (E) => {
      if (E.target.id === 'EditModal') {
        E.target.classList.remove('Active');
      }
    });
    document.getElementById('EditInput').addEventListener('keydown', (E) => {
      if (E.key === 'Enter') {
        this.SaveEditedWaypoint();
      }
    });
    document.getElementById('SavePathDialog').addEventListener('click', (E) => {
      if (E.target.id === 'SavePathDialog') {
        E.target.classList.remove('Active');
        this.ExportData = null;
      }
    });
    document.getElementById('SaveWaypointsDialog').addEventListener('click', (E) => {
      if (E.target.id === 'SaveWaypointsDialog') {
        E.target.classList.remove('Active');
      }
    });
    document.getElementById('RegionPromptDialog').addEventListener('click', (E) => {
      if (E.target.id === 'RegionPromptDialog') {
        E.target.classList.remove('Active');
        this.FileMgr.PendingFile = null;
      }
    });
    document.getElementById('ConfirmRegionDialog').addEventListener('click', (E) => {
      if (E.target.id === 'ConfirmRegionDialog') {
        E.target.classList.remove('Active');
        this.PendingRegion = null;
        this.Canvas.SelectStart = null;
      }
    });
    const PathFilenameEl = document.getElementById('PathFilename');
    if (PathFilenameEl) PathFilenameEl.addEventListener('keydown', (E) => {
      if (E.key === 'Enter') {
        this.SavePathFile();
      } else if (E.key === 'Escape') {
        document.getElementById('SavePathDialog').classList.remove('Active');
        this.ExportData = null;
      }
    });
    const WaypointsFilenameEl = document.getElementById('WaypointsFilename');
    if (WaypointsFilenameEl) WaypointsFilenameEl.addEventListener('keydown', (E) => {
      if (E.key === 'Enter') {
        this.SaveWaypointsFile();
      } else if (E.key === 'Escape') {
        document.getElementById('SaveWaypointsDialog').classList.remove('Active');
      }
    });
  }

  OnClick(E) {
    if (this.Canvas.SelectMode || this.Canvas.IsPanning || this.IsDragging) {
        this.IsDragging = false;
        return;
    }
    const Rect = E.target.getBoundingClientRect();
    const X = E.clientX - Rect.left;
    const Y = E.clientY - Rect.top;
    for (let i = 0; i < this.WaypointMgr.Waypoints.length; i++) {
      const W = this.WaypointMgr.Waypoints[i];
      const [WX, WY] = this.Canvas.LatLonToXY(W.lon, W.lat);
      const DistSq = (X - WX) * (X - WX) + (Y - WY) * (Y - WY);
      if (DistSq <= 324) return;
    }
    // Clicking a map_data station marker selects it as the update target.
    const MapStationHit = this.Canvas.FindNearbyMapDataStation(X, Y);
    if (MapStationHit) {
      if (typeof SelectStationByKey === 'function') SelectStationByKey(MapStationHit.key);
      return;
    }
    // Clicking a loaded NIMBY-track station selects it as the coordinate
    // source for updating a map_data station — no waypoint is dropped.
    const NimbyHit = this.Canvas.FindNearbyStation(X, Y);
    if (NimbyHit) {
      if (typeof SelectNimbySource === 'function') SelectNimbySource(NimbyHit.station, NimbyHit.index);
      return;
    }
    const [Lon, Lat] = this.Canvas.XYToLatLon(X, Y);
    const Index = this.WaypointMgr.AddWaypoint(Lon, Lat);
    this.SetStatus(`Added waypoint ${Index + 1}`, '#2ecc71');
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  OnMouseDown(E) {
    const Rect = E.target.getBoundingClientRect();
    const X = E.clientX - Rect.left;
    const Y = E.clientY - Rect.top;
    if (E.button === 0) {
      if (this.Canvas.SelectMode) {
        this.Canvas.SelectStart = [X, Y];
        this.Canvas.SelectCurrent = [X, Y];
        return;
      }
      for (let i = 0; i < this.WaypointMgr.Waypoints.length; i++) {
        const W = this.WaypointMgr.Waypoints[i];
        const [WX, WY] = this.Canvas.LatLonToXY(W.lon, W.lat);
        const DistSq = (X - WX) * (X - WX) + (Y - WY) * (Y - WY);
        if (DistSq <= 324) {
          this.DragIndex = i;
          this.WaypointMgr.SelectWaypoint(i);
          this.Canvas.ForceRedraw = true;
          this.Redraw();
          return;
        }
      }
    }
    if (E.button === 2) {
      if (this.Canvas.SelectMode) {
        this.Canvas.SelectMode = false;
        this.Canvas.SelectStart = null;
        this.Canvas.SelectCurrent = null;
        this.RegionSelected = false;
        this.Canvas.ForceRedraw = true;
        this.Redraw();
        this.SetStatus('Cancelled', '#95a5a6');
        return;
      }
      this.Canvas.PanX = X;
      this.Canvas.PanY = Y;
      this.Canvas.IsPanning = true;
    }
  }

  OnMouseMove(E) {
    const Rect = E.target.getBoundingClientRect();
    const X = E.clientX - Rect.left;
    const Y = E.clientY - Rect.top;
    if (this.Canvas.SelectMode && this.Canvas.SelectStart) {
      this.Canvas.SelectCurrent = [X, Y];
      this.DrawSelectionBox();
      return;
    }
    if (this.DragIndex !== null) {
      this.IsDragging = true;
      const [Lon, Lat] = this.Canvas.XYToLatLon(X, Y);
      this.WaypointMgr.UpdateWaypoint(this.DragIndex, Lon, Lat);
      this.Canvas.ForceRedraw = true;
      this.Redraw();
      return;
    }
    if (this.Canvas.IsPanning) {
      this.Canvas.PanBy(X - this.Canvas.PanX, Y - this.Canvas.PanY);
      this.Canvas.PanX = X;
      this.Canvas.PanY = Y;
      this.Redraw();
    }
  }

  DrawSelectionBox() {
    // Handled inside Canvas.Draw() — just trigger a redraw
    this.Redraw();
  }

  OnMouseUp(E) {
    if (this.DragIndex !== null) {
      this.DragIndex = null;
      this.WaypointMgr.UpdateList();
      this.Canvas.ForceRedraw = true;
      this.Redraw();
    }
    if (this.Canvas.SelectMode && this.Canvas.SelectStart) {
      const Rect = E.target.getBoundingClientRect();
      const X = E.clientX - Rect.left;
      const Y = E.clientY - Rect.top;
      const [X1, Y1] = this.Canvas.SelectStart;
      const DeltaX = Math.abs(X - X1);
      const DeltaY = Math.abs(Y - Y1);
      if (DeltaX < 10 && DeltaY < 10) {
        this.Canvas.SelectStart = null;
        this.Canvas.SelectCurrent = null;
        return;
      }
      const [Lon1, Lat1] = this.Canvas.XYToLatLon(Math.min(X1, X), Math.max(Y1, Y));
      const [Lon2, Lat2] = this.Canvas.XYToLatLon(Math.max(X1, X), Math.min(Y1, Y));
      const MinLon = Math.min(Lon1, Lon2);
      const MaxLon = Math.max(Lon1, Lon2);
      const MinLat = Math.min(Lat1, Lat2);
      const MaxLat = Math.max(Lat1, Lat2);
      this.PendingRegion = [MinLon, MaxLon, MinLat, MaxLat];
      if (this.FileMgr.Graph) {
        if (confirm('Include only track data within selected region?')) {
          this.FileMgr.CropToRegion(MinLon, MaxLon, MinLat, MaxLat);
          this.Canvas.SelectMode = false;
          this.Canvas.SelectStart = null;
          this.Canvas.SelectCurrent = null;
          this.PendingRegion = null;
        } else {
          this.SetStatus('Cancelled', '#95a5a6');
          this.Canvas.SelectMode = false;
          this.Canvas.SelectStart = null;
          this.Canvas.SelectCurrent = null;
          this.PendingRegion = null;
          this.Canvas.ForceRedraw = true;
          this.Redraw();
        }
      } else {
        document.getElementById('ConfirmRegionDialog').classList.add('Active');
      }
      return;
    }
    if (this.Canvas.IsPanning) {
      this.Canvas.IsPanning = false;
      this._scheduleStaticRebuild();
    }
  }

  ConfirmRegion() {
    document.getElementById('ConfirmRegionDialog').classList.remove('Active');
    this.RegionSelected = this.PendingRegion;
    this.Canvas.SelectMode = false;
    this.Canvas.SelectStart = null;
    this.Canvas.SelectCurrent = null;
    this.PendingRegion = null;
  }

  CancelRegion() {
    document.getElementById('ConfirmRegionDialog').classList.remove('Active');
    this.PendingRegion = null;
    this.Canvas.SelectStart = null;
    this.Canvas.SelectCurrent = null;
    this.Canvas.SelectMode = true;
    this.Canvas.ForceRedraw = true;
    this.Redraw();
    this.SetStatus('Drag to select region on map; right click to cancel', '#f39c12');
  }

  OnRightClick(E) {
    E.preventDefault();
  }

  OnWheel(E) {
    const Rect = E.target.getBoundingClientRect();
    const X = E.clientX - Rect.left;
    const Y = E.clientY - Rect.top;
    const Factor = E.deltaY < 0 ? 1.3 : 0.77;
    this.Canvas.ZoomAt(Factor, X, Y);
    this._scheduleStaticRebuild();
    this.Redraw();
  }

  OnKeyDown(E) {
    const PanAmount = 50;
    switch(E.key) {
      case 'w': case 'W': case 'ArrowUp':
        this.Canvas.PanBy(0, PanAmount);
        this._scheduleStaticRebuild();
        this.Redraw();
        break;
      case 's': case 'S': case 'ArrowDown':
        this.Canvas.PanBy(0, -PanAmount);
        this._scheduleStaticRebuild();
        this.Redraw();
        break;
      case 'a': case 'A': case 'ArrowLeft':
        this.Canvas.PanBy(PanAmount, 0);
        this._scheduleStaticRebuild();
        this.Redraw();
        break;
      case 'd': case 'D': case 'ArrowRight':
        this.Canvas.PanBy(-PanAmount, 0);
        this._scheduleStaticRebuild();
        this.Redraw();
        break;
      case '=': case '+':
        this.Canvas.ZoomAt(1.3);
        this._scheduleStaticRebuild();
        this.Redraw();
        break;
      case '-': case '_':
        this.Canvas.ZoomAt(0.77);
        this._scheduleStaticRebuild();
        this.Redraw();
        break;
      case 'Delete':
        this.RemoveWaypoint();
        break;
    }
  }

  LoadFile() {
    const Input = document.getElementById('FileInput');
    Input.value = '';
    Input.onchange = (E) => {
      const File = E.target.files[0];
      if (File) {
        this.FileMgr.LoadFile(File);
      }
    };
    Input.click();
  }

  ResetView() {
    if (this.FileMgr.Data) {
      this.Canvas.Reset();
      this.Redraw();
    }
  }

  StartRegionSelect() {
    this.FileMgr.StartRegionSelect();
  }

  async TracePath() {
    if (!this.FileMgr.Graph) {
      alert('Load JSON file first');
      return;
    }
    if (this.WaypointMgr.Waypoints.length < 2) {
      alert('Need at least 2 waypoints');
      return;
    }
    this.SetStatus('Tracing...', '#f39c12');
    await new Promise(resolve => setTimeout(resolve, 10));
    try {
      const FullPath = [];
      for (let i = 0; i < this.WaypointMgr.Waypoints.length - 1; i++) {
        const Start = [this.WaypointMgr.Waypoints[i].lon, this.WaypointMgr.Waypoints[i].lat];
        const End = [this.WaypointMgr.Waypoints[i+1].lon, this.WaypointMgr.Waypoints[i+1].lat];
        const StartNode = this.FileMgr.Graph.Nearest(Start);
        const EndNode = this.FileMgr.Graph.Nearest(End);
        if (!StartNode || !EndNode) {
          alert('Track not found near waypoint');
          return;
        }
        const NodePath = this.FileMgr.Graph.Path(StartNode, EndNode);
        if (!NodePath) {
          alert(`No path found between waypoints ${i+1} and ${i+2}`);
          return;
        }
        const Segment = this.FileMgr.Graph.Geom(NodePath);
        if (FullPath.length === 0) {
          FullPath.push(...Segment);
        } else {
          if (Segment.length > 0 && FullPath[FullPath.length-1][0] === Segment[0][0]
              && FullPath[FullPath.length-1][1] === Segment[0][1]) {
            FullPath.push(...Segment.slice(1));
          } else {
            FullPath.push(...Segment);
          }
        }
      }
      this.Path = FullPath;
      let Distance = 0;
      for (let i = 0; i < FullPath.length - 1; i++) {
        Distance += Haversine(FullPath[i], FullPath[i+1]);
      }
      this.Canvas.ForceRedraw = true;
      this.Redraw();
      this.SetStatus(`✓ ${FullPath.length} points, ${(Distance/1000).toFixed(2)} km`, '#2ecc71');
    } catch (err) {
      alert('Failed to trace path: ' + err.message);
      this.SetStatus('Error', '#e74c3c');
    }
  }

  ClearWaypoints() {
    this.WaypointMgr.Clear();
    this.Path = null;
    this.Canvas.ForceRedraw = true;
    this.Redraw();
    this.SetStatus('✓ Cleared', '#2ecc71');
  }

  ExportPath() {
    if (!this.Path || this.Path.length === 0) {
      alert('No path to export. Trace a path first.');
      return;
    }
    this.ExportData = JSON.parse(JSON.stringify(this.Path));
    document.getElementById('PathFilename').value = 'route';
    document.getElementById('ExportFormat').value = 'geojson';
    document.getElementById('SavePathDialog').classList.add('Active');
    document.getElementById('PathFilename').focus();
    document.getElementById('PathFilename').select();
  }

  SavePathFile() {
    const Filename = document.getElementById('PathFilename').value.trim();
    const Format = document.getElementById('ExportFormat').value;
    if (!Filename) {
      alert('Please enter a filename');
      return;
    }
    if (!this.ExportData || !Array.isArray(this.ExportData) || this.ExportData.length === 0) {
      alert('No path data available');
      document.getElementById('SavePathDialog').classList.remove('Active');
      this.ExportData = null;
      return;
    }
    const CleanCoordinates = this.ExportData.filter(coord => coord !== null);
    let Content = '';
    let MimeType = '';
    let Extension = '';
    if (Format === 'geojson') {
      Content = JSON.stringify({
        "type": "FeatureCollection",
        "features": [{
          "type": "Feature",
          "properties": { "name": "Route" },
          "geometry": { "type": "LineString", "coordinates": CleanCoordinates }
        }]
      }, null, 2);
      MimeType = 'application/geo+json';
      Extension = '.geojson';
    } else if (Format === 'json') {
      Content = JSON.stringify(CleanCoordinates, null, 2);
      MimeType = 'application/json';
      Extension = '.json';
    } else if (Format === 'kml' || Format === 'kmz') {
      const CoordString = CleanCoordinates.map(c => `${c[0]},${c[1]},0`).join(' ');
      Content = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>${Filename}</name>
    <Placemark>
      <name>Route</name>
      <LineString>
        <tessellate>1</tessellate>
        <coordinates>${CoordString}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
      MimeType = Format === 'kml' ? 'application/vnd.google-earth.kml+xml' : 'application/vnd.google-earth.kmz';
      Extension = `.${Format}`;
    }
    const FileBlob = new Blob([Content], {type: MimeType});
    const URL = window.URL.createObjectURL(FileBlob);
    const A = document.createElement('a');
    A.href = URL;
    A.download = Filename.endsWith(Extension) ? Filename : Filename + Extension;
    document.body.appendChild(A);
    A.click();
    document.body.removeChild(A);
    window.URL.revokeObjectURL(URL);
    document.getElementById('SavePathDialog').classList.remove('Active');
    this.ExportData = null;
    this.SetStatus('✓ Exported', '#2ecc71');
  }

  ExportStations() {
    this.FileMgr.ExportStations();
  }

  MoveWaypointUp() {
    this.WaypointMgr.MoveUp();
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  MoveWaypointDown() {
    this.WaypointMgr.MoveDown();
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  RemoveWaypoint() {
    this.WaypointMgr.Remove();
    this.Path = null;
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  SaveWaypoints() {
    if (this.WaypointMgr.Waypoints.length === 0) {
      alert('No waypoints to save');
      return;
    }
    document.getElementById('WaypointsFilename').value = 'waypoints.json';
    document.getElementById('SaveWaypointsDialog').classList.add('Active');
    document.getElementById('WaypointsFilename').focus();
    document.getElementById('WaypointsFilename').select();
  }

  SaveWaypointsFile() {
    const Filename = document.getElementById('WaypointsFilename').value.trim();
    if (!Filename) {
      alert('Please enter a filename');
      return;
    }
    const Data = JSON.stringify({waypoints: this.WaypointMgr.Waypoints}, null, 2);
    const FileBlob = new Blob([Data], {type: 'application/json'});
    const URL = window.URL.createObjectURL(FileBlob);
    const A = document.createElement('a');
    A.href = URL;
    A.download = Filename;
    document.body.appendChild(A);
    A.click();
    document.body.removeChild(A);
    window.URL.revokeObjectURL(URL);
    document.getElementById('SaveWaypointsDialog').classList.remove('Active');
    this.SetStatus('✓ Saved waypoints', '#2ecc71');
  }

  LoadWaypoints() {
    const Input = document.createElement('input');
    Input.type = 'file';
    Input.accept = '.json';
    Input.onchange = (E) => {
      const File = E.target.files[0];
      if (File) {
        this.WaypointMgr.Load(File, () => {
          this.Path = null;
          this.ZoomToWaypoints();
          this.Canvas.ForceRedraw = true;
          this.Redraw();
        });
      }
    };
    Input.click();
  }

  ZoomToWaypoints() {
    if (this.WaypointMgr.Waypoints.length === 0) return;
    let MinLon = Infinity;
    let MaxLon = -Infinity;
    let MinLat = Infinity;
    let MaxLat = -Infinity;
    for (const W of this.WaypointMgr.Waypoints) {
      if (W.lon < MinLon) MinLon = W.lon;
      if (W.lon > MaxLon) MaxLon = W.lon;
      if (W.lat < MinLat) MinLat = W.lat;
      if (W.lat > MaxLat) MaxLat = W.lat;
    }
    let LonRange = MaxLon - MinLon;
    let LatRange = MaxLat - MinLat;
    if (LonRange === 0) LonRange = 0.01;
    if (LatRange === 0) LatRange = 0.01;
    const Padding = 0.2;
    this.Canvas.ViewBounds = [
      MinLon - LonRange * Padding,
      MaxLon + LonRange * Padding,
      MinLat - LatRange * Padding,
      MaxLat + LatRange * Padding
    ];
    this.Canvas.AdjustAspectRatio();
    this.Canvas.InvalidateCache();
  }

  SaveEditedWaypoint() {
    this.WaypointMgr.SaveEdit();
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  OnQualityChange() {
    const Slider = document.getElementById('QualitySlider');
    this.Canvas.Quality = parseFloat(Slider.value);
    this.Canvas.InvalidateCache();
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  OnStationsToggle() {
    const Checkbox = document.getElementById('StationsCheckbox');
    this.Canvas.ShowStations = Checkbox.checked;
    this.Canvas.InvalidateCache();
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  OnMapStationsToggle() {
    const Checkbox = document.getElementById('MapStationsCheckbox');
    this.Canvas.ShowMapDataStations = Checkbox.checked;
    this.Canvas.ForceRedraw = true;
    this.Redraw();
  }

  Redraw() {
    if (this._rafPending) return;
    this._rafPending = true;
    requestAnimationFrame(() => {
      this._rafPending = false;
      this.Canvas.Draw(this.WaypointMgr.Waypoints, this.Path, this.WaypointMgr.SelectedIndex);
    });
  }

  // Call after pan/zoom ends to rebuild the static layer once things settle
  _scheduleStaticRebuild() {
    clearTimeout(this._rebuildTimer);
    this._rebuildTimer = setTimeout(() => {
      this.Canvas.StaticDirty = true;
      this.Redraw();
    }, 150);
  }

  SetStatus(Text, Color) {
    const Status = document.getElementById('StatusBar');
    Status.textContent = Text;
    Status.style.color = Color;
  }
}
var App = new Application();