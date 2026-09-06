class FileManager {
  constructor() {
    this.Data = null;
    this.OriginalData = null;
    this.Graph = null;
    this.PendingFile = null;
  }

  LoadFile(File) {
    this.PendingFile = File;
    document.getElementById('Placeholder').classList.add('Hidden');
    document.getElementById('RegionPromptDialog').classList.add('Active');
  }

  async LoadWithRegionSelect() {
    document.getElementById('RegionPromptDialog').classList.remove('Active');
    App.Canvas.SelectMode = true;
    App.SetStatus('Drag to select region on map; right click to cancel', '#f39c12');
    App.Redraw();

    const waitForSelection = () => {
      return new Promise((resolve) => {
        const checkSelection = () => {
          if (App.RegionSelected !== null) {
            resolve(App.RegionSelected);
          } else {
            requestAnimationFrame(checkSelection);
          }
        };
        checkSelection();
      });
    };

    const region = await waitForSelection();
    if (region) {
      this.ProcessFileWithRegion(this.PendingFile, region);
    } else {
      App.SetStatus('Cancelled', '#95a5a6');
      this.PendingFile = null;
      document.getElementById('Placeholder').classList.remove('Hidden');
    }
  }

  LoadEntireNetwork() {
    document.getElementById('RegionPromptDialog').classList.remove('Active');
    this.ProcessFileWithRegion(this.PendingFile, null);
  }

  ProcessFileWithRegion(File, Region) {
    App.SetStatus('⏳ Loading file...', '#f39c12');

    const Reader = new FileReader();
    Reader.onload = (E) => {
      try {
        const Data = JSON.parse(E.target.result);
        if (!Data || !Data.features || !Array.isArray(Data.features)) {
          alert('Invalid file format: Missing features array');
          App.SetStatus('Error loading file', '#e74c3c');
          document.getElementById('Placeholder').classList.remove('Hidden');
          return;
        }

        if (Region) {
          this.ProcessDataWithRegion(Data, Region);
        } else {
          this.ProcessData(Data);
        }
      } catch (err) {
        alert('Failed to load file: Invalid JSON format');
        App.SetStatus('Error loading file', '#e74c3c');
        document.getElementById('Placeholder').classList.remove('Hidden');
      }
    };
    Reader.onerror = () => {
      alert('Failed to read file');
      App.SetStatus('Error reading file', '#e74c3c');
      document.getElementById('Placeholder').classList.remove('Hidden');
    };
    Reader.readAsText(File);
    this.PendingFile = null;
  }

  async ProcessDataWithRegion(Data, Region) {
    const [MinLon, MaxLon, MinLat, MaxLat] = Region;

    App.SetStatus('⏳ Filtering region...', '#f39c12');
    await new Promise(resolve => setTimeout(resolve, 10));

    const NewFeatures = [];
    let TrackCount = 0;

    for (const Feature of Data.features) {
      if (!Feature.properties) continue;
      const PreviewType = Feature.properties.preview_type;
      if (PreviewType === 'tracks') {
        if (!Feature.geometry || !Feature.geometry.coordinates) continue;
        const Lines = Feature.geometry.type === 'MultiLineString'
          ? Feature.geometry.coordinates
          : [Feature.geometry.coordinates];
        const NewLines = [];

        for (const Line of Lines) {
          if (!Line) continue;
          const Clipped = Line.filter(C =>
            C && C[0] >= MinLon && C[0] <= MaxLon && C[1] >= MinLat && C[1] <= MaxLat
          );
          if (Clipped.length >= 2) {
            NewLines.push(Clipped);
            TrackCount++;
          }
        }

        if (NewLines.length > 0) {
          NewFeatures.push({
            type: 'Feature',
            properties: Feature.properties,
            geometry: {
              type: NewLines.length > 1 ? 'MultiLineString' : 'LineString',
              coordinates: NewLines.length > 1 ? NewLines : NewLines[0]
            }
          });
        }
      } else if (PreviewType === 'station' && Feature.geometry && Feature.geometry.type === 'Point') {
        const [Lon, Lat] = Feature.geometry.coordinates;
        if (Lon >= MinLon && Lon <= MaxLon && Lat >= MinLat && Lat <= MaxLat) {
          NewFeatures.push(Feature);
        }
      }
    }

    if (NewFeatures.length === 0 || TrackCount === 0) {
      alert('No tracks found in selected region');
      App.SetStatus('No tracks found', '#95a5a6');
      document.getElementById('Placeholder').classList.remove('Hidden');
      return;
    }

    const FilteredData = {type: 'FeatureCollection', features: NewFeatures};
    this.OriginalData = Data;
    this.ProcessData(FilteredData);
  }

  async ProcessData(Data) {
    this.Data = Data;
    if (!this.OriginalData) {
      this.OriginalData = Data;
    }

    App.SetStatus('⏳ Building graph...', '#f39c12');

    const Features = Data.features.filter(F => F.properties && F.properties.preview_type === 'tracks');
    const AllLines = [];

    for (const F of Features) {
      if (!F.geometry || !F.geometry.coordinates) continue;
      const Lines = F.geometry.type === 'MultiLineString'
        ? F.geometry.coordinates
        : [F.geometry.coordinates];
      for (const L of Lines) {
        if (L && L.length >= 2) {
          AllLines.push(L);
        }
      }
    }

    if (AllLines.length === 0) {
      alert('No valid track data found in file');
      App.SetStatus('No track data found', '#e74c3c');
      document.getElementById('Placeholder').classList.remove('Hidden');
      return;
    }

    this.Graph = new TrackGraph();
    const BatchSize = 100;

    for (let i = 0; i < AllLines.length; i += BatchSize) {
      const End = Math.min(i + BatchSize, AllLines.length);
      for (let j = i; j < End; j++) {
        this.Graph.Add(AllLines[j]);
      }

      const Progress = Math.floor((End / AllLines.length) * 100);
      App.SetStatus(`⏳ Building graph... ${Progress}%`, '#f39c12');

      if (i + BatchSize < AllLines.length) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    this.Graph.BridgeEndpoints();
    await this.FinishLoading();
  }

  async FinishLoading() {
    const NodeSet = new Set();
    for (const Node of this.Graph.Map.values()) {
      NodeSet.add(Node);
    }
    const Nodes = Array.from(NodeSet);

    if (Nodes.length === 0) {
      alert('No valid nodes found in track data');
      App.SetStatus('No valid nodes', '#e74c3c');
      document.getElementById('Placeholder').classList.remove('Hidden');
      return;
    }

    let MinLon = Infinity;
    let MaxLon = -Infinity;
    let MinLat = Infinity;
    let MaxLat = -Infinity;

    for (const N of Nodes) {
      if (N[0] < MinLon) MinLon = N[0];
      if (N[0] > MaxLon) MaxLon = N[0];
      if (N[1] < MinLat) MinLat = N[1];
      if (N[1] > MaxLat) MaxLat = N[1];
    }

    const LonRange = MaxLon - MinLon;
    const LatRange = MaxLat - MinLat;

    App.Canvas.SetBounds(
      MinLon - LonRange * 0.05,
      MaxLon + LonRange * 0.05,
      MinLat - LatRange * 0.05,
      MaxLat + LatRange * 0.05
    );

    App.SetStatus('⏳ Preparing display...', '#f39c12');
    await new Promise(resolve => setTimeout(resolve, 10));

    App.Canvas.PrepareData(this.Data);
    App.Redraw();
    App.SetStatus(`✓ Loaded ${Nodes.length} nodes`, '#2ecc71');
  }

  StartRegionSelect() {
    if (!this.Data) {
      alert('Load JSON file first');
      return;
    }
    App.Canvas.SelectMode = true;
    App.SetStatus('Drag to select region; right click to cancel', '#f39c12');
  }

  async CropToRegion(MinLon, MaxLon, MinLat, MaxLat) {
    if (!this.OriginalData) return;

    App.SetStatus('⏳ Cropping region...', '#f39c12');

    await new Promise(resolve => setTimeout(resolve, 10));

    const NewFeatures = [];
    let TrackCount = 0;

    for (const Feature of this.OriginalData.features) {
      if (!Feature.properties) continue;
      const PreviewType = Feature.properties.preview_type;
      if (PreviewType === 'tracks') {
        if (!Feature.geometry || !Feature.geometry.coordinates) continue;
        const Lines = Feature.geometry.type === 'MultiLineString'
          ? Feature.geometry.coordinates
          : [Feature.geometry.coordinates];
        const NewLines = [];

        for (const Line of Lines) {
          if (!Line) continue;
          const Clipped = Line.filter(C =>
            C && C[0] >= MinLon && C[0] <= MaxLon && C[1] >= MinLat && C[1] <= MaxLat
          );
          if (Clipped.length >= 2) {
            NewLines.push(Clipped);
            TrackCount++;
          }
        }

        if (NewLines.length > 0) {
          NewFeatures.push({
            type: 'Feature',
            properties: Feature.properties,
            geometry: {
              type: NewLines.length > 1 ? 'MultiLineString' : 'LineString',
              coordinates: NewLines.length > 1 ? NewLines : NewLines[0]
            }
          });
        }
      } else if (PreviewType === 'station' && Feature.geometry && Feature.geometry.type === 'Point') {
        const [Lon, Lat] = Feature.geometry.coordinates;
        if (Lon >= MinLon && Lon <= MaxLon && Lat >= MinLat && Lat <= MaxLat) {
          NewFeatures.push(Feature);
        }
      }
    }

    if (NewFeatures.length === 0 || TrackCount === 0) {
      alert('No tracks found in selected region');
      App.SetStatus('No tracks found', '#95a5a6');
      return;
    }

    this.Data = {type: 'FeatureCollection', features: NewFeatures};
    this.Graph = new TrackGraph();

    const TrackFeatures = NewFeatures.filter(F => F.properties && F.properties.preview_type === 'tracks');
    const AllLines = [];

    for (const F of TrackFeatures) {
      if (!F.geometry || !F.geometry.coordinates) continue;
      const Lines = F.geometry.type === 'MultiLineString'
        ? F.geometry.coordinates
        : [F.geometry.coordinates];
      for (const L of Lines) {
        if (L && L.length >= 2) {
          AllLines.push(L);
        }
      }
    }

    const BatchSize = 100;
    for (let i = 0; i < AllLines.length; i += BatchSize) {
      const End = Math.min(i + BatchSize, AllLines.length);
      for (let j = i; j < End; j++) {
        this.Graph.Add(AllLines[j]);
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    this.Graph.BridgeEndpoints();

    const NodeSet = new Set();
    for (const Node of this.Graph.Map.values()) {
      NodeSet.add(Node);
    }
    const Nodes = Array.from(NodeSet);

    if (Nodes.length === 0) {
      alert('No valid nodes');
      App.SetStatus('No valid nodes', '#e74c3c');
      return;
    }

    let MinNodeLon = Infinity;
    let MaxNodeLon = -Infinity;
    let MinNodeLat = Infinity;
    let MaxNodeLat = -Infinity;

    for (const N of Nodes) {
      if (N[0] < MinNodeLon) MinNodeLon = N[0];
      if (N[0] > MaxNodeLon) MaxNodeLon = N[0];
      if (N[1] < MinNodeLat) MinNodeLat = N[1];
      if (N[1] > MaxNodeLat) MaxNodeLat = N[1];
    }

    const LonRange = MaxNodeLon - MinNodeLon;
    const LatRange = MaxNodeLat - MinNodeLat;

    App.Canvas.Tracks = [];
    App.Canvas.Stations = [];
    App.Canvas.SpatialIndex = new Map();
    App.Canvas.TrackBounds = [];
    App.Canvas.TrackCache = new Map();
    App.Canvas.SetBounds(
      MinNodeLon - LonRange * 0.05,
      MaxNodeLon + LonRange * 0.05,
      MinNodeLat - LatRange * 0.05,
      MaxNodeLat + LatRange * 0.05
    );

    App.Canvas.PrepareData(this.Data);
    App.WaypointMgr.Waypoints = App.WaypointMgr.Waypoints.filter(W =>
      W.lon >= MinLon && W.lon <= MaxLon && W.lat >= MinLat && W.lat <= MaxLat
    );
    App.Path = null;
    App.WaypointMgr.SelectedIndex = null;
    App.WaypointMgr.UpdateList();
    App.Redraw();
    App.SetStatus(`✓ Cropped: ${TrackCount} segments, ${Nodes.length} nodes`, '#2ecc71');
  }

  ExportStations() {
    if (!this.Data) {
      alert('Load JSON file first');
      return;
    }

    const Stations = [];
    for (const F of this.Data.features) {
      if (F.properties && F.properties.preview_type === 'station' && F.geometry && F.geometry.type === 'Point') {
        const [Lon, Lat] = F.geometry.coordinates;
        Stations.push({
          ID: F.properties.id || '',
          Name: F.properties.name || '',
          Location: `(${Lat}, ${Lon})`
        });
      }
    }

    Stations.sort((a, b) => a.Name.toLowerCase().localeCompare(b.Name.toLowerCase()));

    const JSON_Data = JSON.stringify({Stations: Stations}, null, 2);
    const FileBlob = new Blob([JSON_Data], {type: 'application/json'});
    const URL = window.URL.createObjectURL(FileBlob);
    const A = document.createElement('a');
    A.href = URL;
    A.download = 'Stations.json';
    document.body.appendChild(A);
    A.click();
    document.body.removeChild(A);
    window.URL.revokeObjectURL(URL);

    App.SetStatus('✓ JSON export complete', '#2ecc71');
  }
}