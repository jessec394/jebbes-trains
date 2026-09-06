class MapCanvas {
  constructor(El) {
    this.Canvas = El;
    this.Ctx = El.getContext('2d');
    this.Tracks = [];
    this.Stations = [];
    this.Borders = [];
    this.SpatialIndex = new Map();
    this.TrackBounds = [];
    this.TrackCache = new Map();   // zoom-level -> simplified lines
    this.BorderLines = [];         // pre-simplified border geometry (rebuilt on data load)
    this.DataBounds = [null,null,null,null];
    this.ViewBounds = [-180,180,-85,85];
    this.Zoom = 1.0;
    this.Quality = 1.0;
    this.AspectRatio = 1.0;
    this.IsPanning = false;
    this.ShowStations = false;
    this.SelectedNimbyStationIndex = null;
    this.MapDataStations = [];       // [{key, label, lon, lat, section, major}]
    this.ShowMapDataStations = false;
    this.SelectedMapDataStationKey = null;
    this.SelectMode = false;
    this.SelectStart = null;
    this.SelectCurrent = null;
    this.HasData = false;
    this.ForceRedraw = true;
    this.LastViewKey = null;
    this.StaticCanvas = document.createElement('canvas'); // cached track+border layer
    this.StaticDirty = true;
    this.ResizeCanvas();
    window.addEventListener('resize', () => this.ResizeCanvas());
  }

  SetMapDataStations(List) {
    this.MapDataStations = List.map(S => ({
      key: S.Key, label: S.Label, lon: S.Location[1], lat: S.Location[0],
      section: S.Section, major: !!S.Major,
    }));
  }

  // Hit-test against the loaded-track (NIMBY file) station dots, for
  // selecting one as an update-coordinate source — no waypoint involved.
  // Gated by the same conditions the dots are actually drawn under.
  FindNearbyStation(X, Y, Threshold = 12) {
    if (!this.ShowStations || this.Zoom < 2.0 || !this.Stations.length) return null;
    const T2 = Threshold * Threshold;
    let BestIndex = null, BestDist = Infinity;
    for (let i = 0; i < this.Stations.length; i++) {
      const [x, y] = this.LatLonToXY(this.Stations[i].coords[0], this.Stations[i].coords[1]);
      const d = (x - X) * (x - X) + (y - Y) * (y - Y);
      if (d <= T2 && d < BestDist) { BestDist = d; BestIndex = i; }
    }
    return BestIndex === null ? null : { station: this.Stations[BestIndex], index: BestIndex };
  }

  // Hit-test against the rendered map_data station markers.
  FindNearbyMapDataStation(X, Y, Threshold = 12) {
    if (!this.ShowMapDataStations || !this.MapDataStations.length) return null;
    const T2 = Threshold * Threshold;
    let Best = null, BestDist = Infinity;
    for (const S of this.MapDataStations) {
      const [x, y] = this.LatLonToXY(S.lon, S.lat);
      const d = (x - X) * (x - X) + (y - Y) * (y - Y);
      if (d <= T2 && d < BestDist) { BestDist = d; Best = S; }
    }
    return Best;
  }

  ResizeCanvas() {
    const C = this.Canvas.parentElement;
    this.Canvas.width = this.StaticCanvas.width = C.clientWidth;
    this.Canvas.height = this.StaticCanvas.height = C.clientHeight - 60;
    if (this.HasData) this.AdjustAspectRatio();
    this.InvalidateCache();
  }

  LoadBorders() {
    if (typeof BORDERS_DATA === 'undefined') return;
    this.Borders = [];
    for (const F of BORDERS_DATA.features) {
      const g = F.geometry;
      if (!g) continue;
      const push = ring => { if (ring.length >= 2) this.Borders.push(ring); };
      if      (g.type === 'Polygon')      g.coordinates.forEach(push);
      else if (g.type === 'MultiPolygon') g.coordinates.forEach(p => p.forEach(push));
      else if (g.type === 'LineString')   push(g.coordinates);
      else if (g.type === 'MultiLineString') g.coordinates.forEach(push);
    }
    this._rebuildBorderLines();
    this.InvalidateCache();
  }

  // Pre-simplify borders at three fixed levels so Draw() never re-simplifies them
  _rebuildBorderLines() {
    const levels = [0.5, 0.05, 0.005]; // zoomed-out, medium, zoomed-in threshold
    this.BorderLines = levels.map(t => this.Borders.map(b => this.SimplifyLine(b, t)));
  }

  _borderLinesForZoom() {
    if (this.Zoom < 1.5)  return this.BorderLines[0];
    if (this.Zoom < 6.0)  return this.BorderLines[1];
    return this.BorderLines[2];
  }

  SetBounds(MinX, MaxX, MinY, MaxY) {
    this.DataBounds = [MinX, MaxX, MinY, MaxY];
    this.AspectRatio = 1.0 / Math.cos((MinY + MaxY) / 2 * Math.PI / 180);
    this.HasData = true;
    this.Reset();
  }

  Reset() {
    if (!this.HasData || this.DataBounds[0] === null) return;
    const [lx,rx,ly,ry] = this.DataBounds;
    const dlon = rx-lx, dlat = ry-ly;
    this.ViewBounds = [lx-dlon*.05, rx+dlon*.05, ly-dlat*.05, ry+dlat*.05];
    this.Zoom = 1.0;
    this.AdjustAspectRatio();
    this.InvalidateCache();
  }

  AdjustAspectRatio() {
    const W = this.Canvas.width, H = this.Canvas.height;
    if (W <= 1 || H <= 1) return;
    const adjLon = (this.ViewBounds[1]-this.ViewBounds[0]) / this.AspectRatio;
    const sa = W/H, latR = this.ViewBounds[3]-this.ViewBounds[2];
    if (adjLon/latR > sa) {
      const cy = (this.ViewBounds[2]+this.ViewBounds[3])/2, nl = adjLon/sa;
      this.ViewBounds[2] = cy-nl/2; this.ViewBounds[3] = cy+nl/2;
    } else {
      const cx = (this.ViewBounds[0]+this.ViewBounds[1])/2, nl = latR*sa*this.AspectRatio;
      this.ViewBounds[0] = cx-nl/2; this.ViewBounds[1] = cx+nl/2;
    }
  }

  InvalidateCache() { this.StaticDirty = true; this.ForceRedraw = true; }

  LatLonToXY(Lon, Lat) {
    const W = this.Canvas.width, H = this.Canvas.height;
    const [l,r,b,t] = this.ViewBounds;
    return [(Lon-l)/(r-l)*W, H-(Lat-b)/(t-b)*H];
  }

  XYToLatLon(X, Y) {
    const W = this.Canvas.width, H = this.Canvas.height;
    const [l,r,b,t] = this.ViewBounds;
    return [l+(X/W)*(r-l), b+((H-Y)/H)*(t-b)];
  }

  ZoomAt(Factor, CX=null, CY=null) {
    if (CX===null) CX = this.Canvas.width/2;
    if (CY===null) CY = this.Canvas.height/2;
    const [cLon,cLat] = this.XYToLatLon(CX, CY);
    const [dLon,dLat] = [this.ViewBounds[1]-this.ViewBounds[0], this.ViewBounds[3]-this.ViewBounds[2]];
    const nLon = dLon/Factor, nLat = dLat/Factor;
    const rLon = (cLon-this.ViewBounds[0])/dLon, rLat = (cLat-this.ViewBounds[2])/dLat;
    this.ViewBounds = [cLon-nLon*rLon, cLon+nLon*(1-rLon), cLat-nLat*rLat, cLat+nLat*(1-rLat)];
    this.Zoom *= Factor;
    this.AdjustAspectRatio();
    this.InvalidateCache();
  }

  PanBy(DX, DY) {
    const W = this.Canvas.width, H = this.Canvas.height;
    const dLon = -(DX/W)*(this.ViewBounds[1]-this.ViewBounds[0]);
    const dLat =  (DY/H)*(this.ViewBounds[3]-this.ViewBounds[2]);
    this.ViewBounds = [this.ViewBounds[0]+dLon, this.ViewBounds[1]+dLon,
                       this.ViewBounds[2]+dLat, this.ViewBounds[3]+dLat];
    this.InvalidateCache();
  }

  PrepareData(Data) {
    this.Tracks = []; this.Stations = [];
    this.SpatialIndex = new Map(); this.TrackBounds = [];
    this.TrackCache.clear();
    this.SelectedNimbyStationIndex = null;
    for (const F of Data.features) {
      const pt = F.properties.preview_type;
      if (pt === 'tracks') {
        const lines = F.geometry.type === 'MultiLineString' ? F.geometry.coordinates : [F.geometry.coordinates];
        for (const L of lines) {
          if (L.length < 2) continue;
          const lons = L.map(c=>c[0]), lats = L.map(c=>c[1]);
          const [mn,mx,my,mxy] = [Math.min(...lons),Math.max(...lons),Math.min(...lats),Math.max(...lats)];
          const ti = this.Tracks.length;
          this.Tracks.push(L);
          this.TrackBounds.push([mn,mx,my,mxy]);
          const gxSpan = Math.floor(mx*40) - Math.floor(mn*40) + 1;
          const gySpan = Math.floor(mxy*40) - Math.floor(my*40) + 1;
          if (gxSpan * gySpan > 2000) {
            // Long/diagonal track (e.g. a cross-country line with only a
            // few points) — its bbox rectangle is mostly empty space, so
            // indexing every cell in that rectangle wastes time inserting
            // (and later querying) cells nowhere near the actual line.
            // Rasterize along the line itself instead: walk the grid cells
            // each segment actually passes through (Bresenham), so cost
            // scales with the line's length in cells, not its bbox area --
            // and unlike sampling only the line's own vertices, this still
            // finds it if a view is scrolled to somewhere in the middle of
            // a long segment between two far-apart points.
            const seen = new Set();
            const insert = (gx, gy) => {
              const k = `${gx},${gy}`;
              if (seen.has(k)) return;
              seen.add(k);
              if (!this.SpatialIndex.has(k)) this.SpatialIndex.set(k,[]);
              this.SpatialIndex.get(k).push(ti);
            };
            for (let p = 0; p < L.length - 1; p++) {
              let gx0 = Math.floor(L[p][0]*40),   gy0 = Math.floor(L[p][1]*40);
              const gx1 = Math.floor(L[p+1][0]*40), gy1 = Math.floor(L[p+1][1]*40);
              const dx = Math.abs(gx1-gx0), dy = Math.abs(gy1-gy0);
              const sx = gx0 < gx1 ? 1 : -1, sy = gy0 < gy1 ? 1 : -1;
              let err = dx - dy;
              while (true) {
                insert(gx0, gy0);
                if (gx0 === gx1 && gy0 === gy1) break;
                const e2 = 2*err;
                if (e2 > -dy) { err -= dy; gx0 += sx; }
                if (e2 <  dx) { err += dx; gy0 += sy; }
              }
            }
          } else {
            for (let gx=Math.floor(mn*40); gx<=Math.floor(mx*40); gx++)
              for (let gy=Math.floor(my*40); gy<=Math.floor(mxy*40); gy++) {
                const k = `${gx},${gy}`;
                if (!this.SpatialIndex.has(k)) this.SpatialIndex.set(k,[]);
                this.SpatialIndex.get(k).push(ti);
              }
          }
        }
      } else if (pt === 'station' && F.geometry.type === 'Point') {
        this.Stations.push({coords: F.geometry.coordinates, name: F.properties.name||''});
      }
    }
    this.InvalidateCache();
  }

  SimplifyLine(Line, T) {
    if (Line.length <= 2) return Line;
    const R = [Line[0]]; let L = Line[0]; const T2 = T*T;
    for (let i=1; i<Line.length-1; i++) {
      const P = Line[i], dx = P[0]-L[0], dy = P[1]-L[1];
      if (dx*dx+dy*dy >= T2) { R.push(P); L=P; }
    }
    R.push(Line[Line.length-1]);
    return R;
  }

  // Discrete zoom level bucket for cache keys — prevents constant cache misses.
  // Below 10x this is a fixed table tuned for performance while zoomed out.
  // Beyond 10x there's no ceiling: each zoom-doubling gets its own bucket, so
  // the simplification cache keeps re-sharpening as you keep zooming in,
  // instead of permanently reusing whatever tolerance you first hit at 10x.
  _zoomBucket() {
    if (this.Zoom < 0.3)  return 0;
    if (this.Zoom < 0.6)  return 1;
    if (this.Zoom < 1.2)  return 2;
    if (this.Zoom < 2.5)  return 3;
    if (this.Zoom < 5.0)  return 4;
    if (this.Zoom < 10.0) return 5;
    return 6 + Math.floor(Math.log2(this.Zoom / 10));
  }

  _thresholdForBucket(b) {
    const W = this.Canvas.width, H = this.Canvas.height;
    const base = Math.max((this.ViewBounds[1]-this.ViewBounds[0])/W,
                          (this.ViewBounds[3]-this.ViewBounds[2])/H);
    const mults = [12, 8, 5, 3, 2, 1.5, 1];
    return base * (mults[b] || 1) / this.Quality;
  }

  GetVisibleTrackIndices() {
    const [l,r,b,t] = this.ViewBounds;
    const dlon = r-l, dlat = t-b;
    const gxMin = Math.floor((l-dlon*.05)*40);
    const gxMax = Math.floor((r+dlon*.05)*40);
    const gyMin = Math.floor((b-dlat*.05)*40);
    const gyMax = Math.floor((t+dlat*.05)*40);
    const cellCount = (gxMax-gxMin+1) * (gyMax-gyMin+1);

    // The spatial-index grid query costs O(cells in view), not O(tracks) --
    // fine when zoomed in tight, but at a zoomed-out view over a big network
    // the cell count can run into the millions while the grid itself is
    // almost entirely empty (each Map.get() still costs a string alloc +
    // hash lookup). Once querying the grid would touch more cells than we
    // even have tracks, it's cheaper to just bbox-test every track directly
    // -- that's O(tracks), independent of how much area the view covers.
    if (cellCount > this.TrackBounds.length * 4) {
      const result = [];
      for (let ti = 0; ti < this.TrackBounds.length; ti++) {
        const [mn,mx,my,mxy] = this.TrackBounds[ti];
        if (mx<l||mn>r||mxy<b||my>t) continue;
        result.push(ti);
      }
      return result;
    }

    const Indices = new Set();
    for (let gx=gxMin; gx<=gxMax; gx++)
      for (let gy=gyMin; gy<=gyMax; gy++) {
        const tracks = this.SpatialIndex.get(`${gx},${gy}`);
        if (tracks) for (const ti of tracks) Indices.add(ti);
      }
    const result = [];
    for (const ti of Indices) {
      const [mn,mx,my,mxy] = this.TrackBounds[ti];
      if (mx<l||mn>r||mxy<b||my>t) continue;
      result.push(ti);
    }
    return result;
  }

  _drawStaticLayer() {
    const SC = this.StaticCanvas, ctx = SC.getContext('2d');
    const W = SC.width, H = SC.height;
    ctx.clearRect(0,0,W,H);
    ctx.fillStyle = '#1e1e1e';
    ctx.fillRect(0,0,W,H);

    // Borders — batch all into one path per draw
    const borders = this._borderLinesForZoom();
    ctx.strokeStyle = '#3a4556';
    ctx.lineWidth = 0.5;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    for (const line of borders) {
      if (line.length < 2) continue;
      const [x0,y0] = this.LatLonToXY(line[0][0], line[0][1]);
      ctx.moveTo(x0,y0);
      for (let i=1; i<line.length; i++) {
        const [x,y] = this.LatLonToXY(line[i][0], line[i][1]);
        ctx.lineTo(x,y);
      }
    }
    ctx.stroke();
    ctx.globalAlpha = 1.0;

    // Tracks — one path for all visible tracks
    if (this.HasData && this.Tracks.length > 0) {
      const bucket = this._zoomBucket();
      const threshold = this._thresholdForBucket(bucket);
      const visible = this.GetVisibleTrackIndices();

      // Limit tracks at low zoom for performance
      const maxTracks = [2000,4000,8000,12000,15000,15000,15000][bucket] || 15000;
      const toRender = visible.length > maxTracks ? visible.slice(0, maxTracks) : visible;

      ctx.strokeStyle = '#d35400';
      ctx.lineWidth = 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const ti of toRender) {
        const cacheKey = `${ti}_${bucket}`;
        let line = this.TrackCache.get(cacheKey);
        if (!line) {
          line = this.SimplifyLine(this.Tracks[ti], threshold);
          if (this.TrackCache.size < 30000) this.TrackCache.set(cacheKey, line);
        }
        if (line.length < 2) continue;
        const [x0,y0] = this.LatLonToXY(line[0][0], line[0][1]);
        ctx.moveTo(x0,y0);
        for (let i=1; i<line.length; i++) {
          const [x,y] = this.LatLonToXY(line[i][0], line[i][1]);
          ctx.lineTo(x,y);
        }
      }
      ctx.stroke();
    }

    this.StaticDirty = false;
  }

  Draw(Waypoints, Path, SelectedIndex) {
    const W = this.Canvas.width, H = this.Canvas.height;
    if (W<=1||H<=1) return;

    if ((this.StaticDirty || this.ForceRedraw) && !this.IsPanning) {
      this._drawStaticLayer();
      this.ForceRedraw = false;
    }

    // Composite: static layer + dynamic overlays (path, waypoints, selection rect)
    const ctx = this.Ctx;
    ctx.clearRect(0,0,W,H);
    ctx.drawImage(this.StaticCanvas,0,0);

    // Traced path
    if (Path && Path.length > 0) {
      const bucket = this._zoomBucket();
      const simp = this.SimplifyLine(Path, this._thresholdForBucket(bucket));
      ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      const [x0,y0] = this.LatLonToXY(simp[0][0],simp[0][1]); ctx.moveTo(x0,y0);
      for (let i=1; i<simp.length; i++) { const [x,y]=this.LatLonToXY(simp[i][0],simp[i][1]); ctx.lineTo(x,y); }
      ctx.stroke();
    }

    // Waypoints
    for (let i=0; i<Waypoints.length; i++) {
      const [x,y] = this.LatLonToXY(Waypoints[i].lon, Waypoints[i].lat);
      const sel = i===SelectedIndex;
      ctx.fillStyle   = sel ? '#f39c12' : '#3498db';
      ctx.strokeStyle = sel ? '#e67e22' : '#2980b9';
      ctx.lineWidth   = sel ? 4 : 3;
      ctx.beginPath(); ctx.arc(x,y,sel?20:16,0,2*Math.PI); ctx.fill(); ctx.stroke();
      ctx.fillStyle = 'white';
      ctx.font = `bold ${sel?14:12}px Arial`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i+1),x,y);
    }

    // Loaded-track (NIMBY file) stations — only when zoomed in enough. Drawn
    // dynamically (not on the cached static layer) so selecting one for the
    // station-coordinate-source workflow can highlight it without forcing a
    // full static-layer redraw.
    if (this.HasData && this.ShowStations && this.Zoom >= 2.0 && this.Stations.length) {
      const [l,r,b,t] = this.ViewBounds;
      for (let i = 0; i < this.Stations.length; i++) {
        const [lon,lat] = this.Stations[i].coords;
        if (lon<l||lon>r||lat<b||lat>t) continue;
        const isSel = this.SelectedNimbyStationIndex === i;
        const [x,y] = this.LatLonToXY(lon,lat);
        ctx.fillStyle   = isSel ? '#f1c40f' : '#e74c3c';
        ctx.strokeStyle = isSel ? '#d4ac0d' : '#c0392b';
        ctx.lineWidth   = isSel ? 3 : 2;
        ctx.beginPath(); ctx.arc(x,y,isSel?8:5,0,2*Math.PI); ctx.fill(); ctx.stroke();
      }
    }

    // Map-data stations (from map_data.py) — diamond markers, drawn separately
    // from the loaded-track station dots above so the two are visually distinct.
    if (this.ShowMapDataStations && this.MapDataStations.length) {
      const [l,r,b,t] = this.ViewBounds;
      ctx.font = 'bold 11px Arial';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      for (const S of this.MapDataStations) {
        if (S.lon<l||S.lon>r||S.lat<b||S.lat>t) continue;
        const [x,y] = this.LatLonToXY(S.lon, S.lat);
        const isSel = this.SelectedMapDataStationKey === S.key;
        const rad = isSel ? 8 : (S.major ? 6 : 5);
        ctx.fillStyle   = isSel ? '#9b59b6' : '#1abc9c';
        ctx.strokeStyle = isSel ? '#8e44ad' : '#16a085';
        ctx.lineWidth   = isSel ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(x, y-rad); ctx.lineTo(x+rad, y); ctx.lineTo(x, y+rad); ctx.lineTo(x-rad, y);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
        if (isSel || this.Zoom >= 3.0) {
          ctx.fillStyle = '#ecf0f1';
          ctx.fillText(S.label, x+rad+4, y);
        }
      }
    }

    // Selection rectangle
    if (this.SelectMode && this.SelectStart && this.SelectCurrent) {
      const [x1,y1] = this.LatLonToXY(this.SelectStart[0],   this.SelectStart[1]);
      const [x2,y2] = this.LatLonToXY(this.SelectCurrent[0], this.SelectCurrent[1]);
      ctx.strokeStyle = '#3498db'; ctx.lineWidth = 2;
      ctx.setLineDash([5,5]);
      ctx.strokeRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1));
      ctx.fillStyle = 'rgba(52,152,219,0.1)';
      ctx.fillRect(Math.min(x1,x2),Math.min(y1,y2),Math.abs(x2-x1),Math.abs(y2-y1));
      ctx.setLineDash([]);
    }
  }
}