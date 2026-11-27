var RegistryFantasy, RegistryPresent, Registry;
var NamedStations, AllNodes, Stations;
var Modes, ModesOrder;
var CurrentMapMode = 'Fantasy';
var SelectedId = null;
var StationMarkers = {};
var StationGroupLineLayer = null;
var CurrentBaseSize = 5;
var CurrentStationPopup = null;
var BasemapLayers = {};
var LMap = null;
var LineLayers = {};
var InfoPoints = {};
var InfoMarkers = {};
var SelectedInfoPoint = null;
var StationSearchIndex = {};
var SelectedStationKey = null;
var SelectedStationGroup = [];
var DisabledModes = new Set();
var Destinations = {};
var Leagues = {};
var TeamVenueIndex = {};
var TeamLeagueIndex = {};
var TeamMapMarkersByLeague = {}; // league -> array of BuildPinMarker layer objects
var ActiveSportsLeagues = new Set();
var DestinationMarkers = {};
var SelectedDestination = null;

const STROKE_WEIGHT = 2.5;
const HOVER_STROKE_WEIGHT = 5;
const STATION_POPUP_RADIUS_KM = 0.4;
const MAX_IDLE_STATION_MARKERS = 2000;
const MERGE_OVERLAP_RATIO = 0.6;
const NEUTRAL_DOT_COLOR = '#52525b';
const DOT_SIZE = 6;
const FOCUS_SCALE = 1.6;

const DOT_HIT_PADDING = 6;

var MapLoadingState = {
    initialized: false,
    dataLoaded: false,
    tilesLoaded: false
};

// Once everything has loaded the splash gets a 'ready' class and its Enter button goes live
function UpdateLoadingProgress() {
    var ready = MapLoadingState.initialized && MapLoadingState.dataLoaded && MapLoadingState.tilesLoaded;
    var splash = document.getElementById('SplashScreen');
    var button = document.getElementById('SplashEnter');
    var text = document.getElementById('SplashEnterText');
    if (splash) splash.classList.toggle('ready', ready);
    if (button) button.disabled = !ready;
    if (text) text.textContent = ready ? 'Enter the map' : 'Loading map\u2026';
}

function MarkMapInitialized() {
    MapLoadingState.initialized = true;
    UpdateLoadingProgress();
}

function MarkDataLoaded() {
    MapLoadingState.dataLoaded = true;
    UpdateLoadingProgress();
}

function MarkTilesLoaded() {
    MapLoadingState.tilesLoaded = true;
    UpdateLoadingProgress();

    setTimeout(() => {
        var skeleton = document.getElementById('MapSkeleton');
        var background = document.getElementById('LoadingBackground');
        if (skeleton) skeleton.classList.add('hidden');
        if (background) background.classList.add('hidden');
    }, 500);
}

function CloseSplash() {
    var splash = document.getElementById('SplashScreen');
    var mapBlur = document.getElementById('MapBlur');
    var skeleton = document.getElementById('MapSkeleton');
    var background = document.getElementById('LoadingBackground');
    var sidebar = document.getElementById('Sidebar');

    if (!splash.classList.contains('ready') || splash.classList.contains('hidden')) return;
    DockSplashPatch();

    splash.classList.add('hidden');
    mapBlur.classList.add('hidden');
    if (skeleton) skeleton.classList.add('hidden');
    if (background) background.classList.add('hidden');

    if (sidebar) { sidebar.classList.remove('splash-hidden'); sidebar.classList.add('splash-visible'); }
}

function CalculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    return R * c;
}

function GetActiveRegistry() {
    return CurrentMapMode === 'Fantasy' ? RegistryFantasy : RegistryPresent;
}

function HideOtherViewLines() {
    (CurrentMapMode === 'Fantasy' ? RegistryPresent : RegistryFantasy).forEach(function(L) { var Ly = LineLayers[L.Id]; if (Ly) HideLayer(Ly); });
}

// The other view's version of a line (same operator and name), or null
function CounterpartLine(line, registry) {
    if (!line) return null;
    var key = (line.Operator || '') + '|' + (line.Name || '');
    return (registry || []).find(function(e) { return (e.Operator || '') + '|' + (e.Name || '') === key; }) || null;
}

// Stations the Future map names differently ("Westminster" -> "Westminster-72nd"): detailed map only; the Present view keeps the usual name.
function ApplyViewLabels() {
    var D = DataSets.detailed, fl = D && D.FutureLabels;
    if (!fl || LineDetail !== 'detailed') return;
    var fut = CurrentMapMode === 'Fantasy';
    function set(o, k) {
        var b = k.split(' {')[0];
        if (!o || !Object.prototype.hasOwnProperty.call(fl, b)) return;
        if (o._L === undefined) o._L = o.Label;
        o.Label = fut ? fl[b] : o._L;
    }

    [NamedStations, Stations, StationSearchIndex].forEach(function(d) { Object.keys(d || {}).forEach(function(k) { set(d[k], k); }); });
    _StationGroupIndex = null; OmniIndex = null;
}

function SwitchMapMode(Mode) {
    if (CurrentMapMode === Mode) return;
    var carried = SelectedId ? LineRegistryEntry(SelectedId) : null;     // a selected line follows you to the other view, as that view's own version of it
    CurrentMapMode = Mode;
    DisabledModes.clear();
    ApplySwitchedRegistry();
    ApplyViewLabels();
    Reset();

    var btnFantasy = document.getElementById('ModeSwitchFantasy');
    var btnPresent = document.getElementById('ModeSwitchPresent');
    if (btnFantasy) btnFantasy.classList.toggle('active', Mode === 'Fantasy');
    if (btnPresent) btnPresent.classList.toggle('active', Mode === 'Present');

    UpdateProjectMarkersVisibility();
    UpdateDestinationMarkersVisibility();
    BuildByMode();
    if (GlobeDockState !== 'none') SetSplashLineMode(Mode);
    var omni = document.getElementById('SearchInput');
    if (omni && omni.value.trim()) RenderOmniResults();   // places / teams / projects depend on the view
    RenderPlacesChips();
    RefreshStationListings();   // count, preview, station window, search
    RefreshSplashTeams();
    if (Mode !== 'Fantasy') CloseProjectBrowseModal(); // projects don't exist outside the Future map
    ActiveSportsLeagues.forEach(function(lg) { AddLeagueMarkers(lg); });
    var twin = CounterpartLine(carried, Registry);
    if (twin) SelectLine(twin.Id);
}

// A click (or tap) on a line opens it; elsewhere it closes the panel or clears the selection
function HandleMapClick(e) {
    var pick = e && e.latlng && !OverMarker(e.originalEvent) ? PickLine(e.latlng) : null;
    if (pick) { ClearLineHover(); SelectLine(pick.line.Id); return; }
    if (CurrentStationPopup) CloseStationPopup();
    else Reset();
}

function StationGroupBase(SN) {
    var I = SN.indexOf(' {');
    return I === -1 ? SN : SN.substring(0, I);
}

var _StationGroupIndex = null;

function StationGroupMembers(SN) {
    if (!_StationGroupIndex) {
        _StationGroupIndex = {};
        Object.keys(Stations).forEach(function(K) {
            var base = StationGroupBase(K);
            (_StationGroupIndex[base] || (_StationGroupIndex[base] = [])).push(K);
        });
    }

    return _StationGroupIndex[StationGroupBase(SN)] || [];
}

// A multi-platform station's name: the label most platforms share, ties going to the station's own name
function StationGroupLabel(Base) {
    var counts = {};
    (StationGroupMembers(Base).length ? StationGroupMembers(Base) : [Base]).forEach(function(K) {
        var S = Stations[K], L = CleanStationName((S && S.Label) || K);
        counts[L] = (counts[L] || 0) + 1;
    });

    var own = CleanStationName(Base);
    return Object.keys(counts).sort(function(a, b) { return counts[b] - counts[a] || (b === own) - (a === own) || b.length - a.length; })[0] || own;
}

function CleanStationName(SN) {
    return SN.replace(/\s*\{[^}]*\}/g, '').replace(/\s*\[[^\]]*\]/g, '').trim();
}

function Debounce(Fn, Delay) {
    var handle;
    return function() {
        var ctx = this, args = arguments;
        clearTimeout(handle);
        handle = setTimeout(function() { Fn.apply(ctx, args); }, Delay);
    };
}

function NormalizeSearchText(s) { return s.toLowerCase().replace(/[^a-z0-9 ]/g, ''); }

// A line's registry entry, whichever view it belongs to
function LineRegistryEntry(lineId) {
    var found = null;
    [RegistryFantasy, RegistryPresent].some(function(R) {
        return (R || []).some(function(e) { if (e.Id === lineId) { found = e; return true; } return false; });
    });

    return found;
}

function LineBoundsFor(lineId, layer) {
    var b = layer.getBounds();
    if (b.isValid()) return b;
    var entry = LineRegistryEntry(lineId);
    return L.latLngBounds(entry && entry.Geometry ? [].concat.apply([], entry.Geometry.Coords) : []);
}

// Lines of the current view stopping at a station key, in Registry order (rebuilt when the registry changes)
var _linesAt = null, _linesAtRegistry = null;
function LinesAt(key) {
    if (_linesAtRegistry !== Registry) {
        _linesAt = {}; _linesAtRegistry = Registry;
        (Registry || []).forEach(function(L) { L.AllLineStations.forEach(function(k) { (_linesAt[k] || (_linesAt[k] = [])).push(L); }); });
    }

    return _linesAt[key] || [];
}

// Lines serving any of `keys`, in Registry order; lines of switched-off modes only with includeOff
function LinesServing(keys, includeOff) {
    var hit = new Set();
    keys.forEach(function(k) { LinesAt(k).forEach(function(L) { hit.add(L); }); });
    return Registry.filter(function(L) { return hit.has(L) && (includeOff || !DisabledModes.has(L.ModeId)); });
}

function ForEachVisibleLine(StyleFn) {
    Registry.forEach(function(L) {
        var Ly = LineLayers[L.Id];
        if (!Ly) return;
        if (DisabledModes.has(L.ModeId)) { HideLayer(Ly); return; }
        StyleFn(L, Ly);
    });
}

function ApplyLineEmphasis(Highlight, WeightMult) {
    ForEachVisibleLine(function(L, Ly) {
        if (Highlight(L)) {
            SetLayerStyle(Ly, {color: L.Color, weight: L.Weight * (WeightMult || 1), opacity: 1});
            if (Ly.setZIndex) Ly.setZIndex(10000);
        } else {
            SetLayerStyle(Ly, {color: '#94a3b8', weight: L.Weight, opacity: 0.15});
            if (Ly.setZIndex) Ly.setZIndex(L.ZIndex);
        }
    });

    HideOtherViewLines();
}

function ApplySwitchedRegistry() {
    var newRegistry = GetActiveRegistry();
    EnsureRegistryLayersCreated(newRegistry);
    HideOtherViewLines();
    newRegistry.forEach(L => { var Ly = LineLayers[L.Id]; if (Ly) ShowLayer(Ly, L.Color, L.Weight); });
    Registry = newRegistry;
    return newRegistry;
}

function BaseDotRadius(S) { return S && S.Major ? CurrentBaseSize * 2 : CurrentBaseSize; }

function SetMarkerEnlarged(M, S, enlarged) {
    if (M instanceof L.CircleMarker) {
        var R = S && BaseDotRadius(S);
        M.setRadius(enlarged ? R * 1.5 : R);
        M.setStyle({weight: enlarged ? HOVER_STROKE_WEIGHT : STROKE_WEIGHT, fillOpacity: 1});
        if (enlarged) M.bringToFront();
    } else {
        var el = M.getElement();
        if (el) el.classList.toggle('station-dot-active', enlarged);
        M.setZIndexOffset(enlarged ? 1000 : 0);
    }
}

function SetMarkerSelectedGlow(M, on) {
    var el = (M instanceof L.CircleMarker) ? M._path : M.getElement();
    if (el) el.classList.toggle('station-marker-selected', on);
}

// Detailed map, zoomed in: stations are their platforms (outlined tracks), not dots.
function PlatformModeOn() { return LineDetail === 'detailed' && !!LMap && LMap.getZoom() >= PLATFORM_OUTLINE_ZOOM; }

function ShowStationPopup(SN, FromMarker = false) {
    ShowStationPopupCore(SN, FromMarker);
    if (LineDetail === 'detailed') RefreshStationDots();           // the station's platforms light up as the selected ones
}

function ShowStationPopupCore(SN, FromMarker = false) {
    SetSheet('peek');                                                  // phones: the station's card needs the map area
    var S = Stations[SN];
    if (!S) return;
    var GroupKeys = StationGroupMembers(SN);

    EnsureGroupMarkersExist(GroupKeys);

    SelectedStationGroup.forEach(function(PrevKey) {
        if (GroupKeys.includes(PrevKey)) return;
        var PrevM = StationMarkers[PrevKey];
        if (PrevM) { SetMarkerEnlarged(PrevM, Stations[PrevKey], false); SetMarkerSelectedGlow(PrevM, false); }
    });

    SelectedStationKey = SN;
    SelectedStationGroup = GroupKeys;
    HideProjectPanel();
    FocusSplashOnStation(SN);

    GroupKeys.forEach(function(GK) {
        var GS = Stations[GK];
        var GM = StationMarkers[GK];
        if (GM) { SetMarkerEnlarged(GM, GS, true); SetMarkerSelectedGlow(GM, true); }
    });

    SelectedId = null;
    UpdateHeader(null);
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");

    var Overlay = document.getElementById('StationPopupOverlay');
    var ConnectedLines = LinesServing(GroupKeys, true);

    var NearbyGroupMap = {};
    FindNearbyStationKeys(S, GroupKeys).forEach(function(OtherKey) {
        var OtherStation = Stations[OtherKey];
        var OtherBase = StationGroupBase(OtherKey);
        if (!NearbyGroupMap[OtherBase]) NearbyGroupMap[OtherBase] = {Keys: [], Labels: []};
        NearbyGroupMap[OtherBase].Keys.push(OtherKey);
        var OtherLabel = CleanStationName(OtherStation.Label || OtherBase);
        if (!NearbyGroupMap[OtherBase].Labels.includes(OtherLabel)) NearbyGroupMap[OtherBase].Labels.push(OtherLabel);
    });

    var NearbyGroups = Object.values(NearbyGroupMap)
        .map(G => ({
            Label: G.Labels.reduce((Best, L) => L.length > Best.length ? L : Best),
            Keys: G.Keys,
            Lines: LinesServing(G.Keys, true),
        }))
        .filter(G => G.Lines.length > 0)
        .sort((A, B) => A.Label.localeCompare(B.Label));

    var StationLabel = CleanStationName(S.Label || SN);
    document.getElementById('PopupStationName').innerText = StationLabel;
    // Flag to the left of the name; city, subdivision (and type) underneath.
    var Region = null;
    GroupKeys.concat([SN]).some(function(K) {
        var E = StationSearchIndex[K];
        if (E && E.Region && E.Region.length) { Region = E.Region; return true; }
        return false;
    });

    SetPopupFlag(Region && Region[2]);
    var Place = Region ? [Region[0], Region[1]].filter(Boolean).join(', ') : '';
    document.getElementById('PopupStationType').innerText = [Place, IsAirport(S) ? 'Airport' : S.Type].filter(Boolean).join(' · ');
    Overlay.classList.add('StationMode');

    var ModeGroups = {};
    ConnectedLines.forEach(L => {
        if (!ModeGroups[L.ModeId]) ModeGroups[L.ModeId] = [];
        ModeGroups[L.ModeId].push(L);
    });

    // Plain concatenation, not template literals: the build's minifier strips spaces inside nested templates
    var ModeCount = Object.keys(ModeGroups).length;
    var Chevron = '<span class="PopupModeChevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>';
    var Html = '<div class="PopupSummary">' + ConnectedLines.length + (ConnectedLines.length === 1 ? ' line' : ' lines') +
        (ModeCount > 1 ? ' · ' + ModeCount + ' modes' : '') + '</div>';
    Object.keys(Modes).forEach(function(ModeId) {
        if (!ModeGroups[ModeId]) return;
        var ModeData = Modes[ModeId];
        var Lines = ModeGroups[ModeId];

        Html += '<details class="PopupMode" open><summary class="PopupModeTitle">' + Chevron +
            '<span class="PopupModeDot" style="background:' + ModeData.Color + '"></span>' +
            '<span class="PopupModeName">' + EscapeHtml(ModeData.Name) + '</span>' +
            '<span class="PopupModeCount">' + Lines.length + '</span></summary>';

        var OperatorGroups = {};
        Lines.forEach(function(L) {
            if (!OperatorGroups[L.Operator]) OperatorGroups[L.Operator] = [];
            OperatorGroups[L.Operator].push(L);
        });

        Object.keys(OperatorGroups).sort().forEach(function(Op) {
            Html += '<div class="PopupAgency"><div class="PopupAgencyName">' + EscapeHtml(Op) + '</div><div class="PopupLineChips">';
            OperatorGroups[Op].slice().sort(function(A, B) { return A.Name.localeCompare(B.Name); }).forEach(function(L) {
                Html += '<button class="PopupLineChip" onclick="SelectLine(' + EscapeHtml(OmniJs(L.Id)) + ')" title="' + EscapeHtml(L.Name + ' · ' + Op) + '">' +
                    '<span class="PopupLineChipDot" style="background:' + L.Color + '"></span>' + EscapeHtml(L.Name) + '</button>';
            });

            Html += '</div></div>';
        });

        Html += '</details>';
    });

    if (NearbyGroups.length) {
        Html += '<details class="PopupMode PopupNearby" open><summary class="PopupModeTitle">' + Chevron +
            '<span class="PopupModeName">Nearby stations</span>' +
            '<span class="PopupModeCount">' + NearbyGroups.length + '</span></summary>';
        NearbyGroups.forEach(function(G) {
            var Shown = G.Lines.slice(0, 4), More = G.Lines.length - Shown.length;
            Html += '<div class="PopupNearbyRow" onclick="ShowStationPopupFromSearch(' + EscapeHtml(OmniJs(G.Keys[0])) + ')">' +
                '<span class="PopupNearbyName">' + EscapeHtml(G.Label) + '</span><span class="StationSearchLines">' +
                Shown.map(function(L) { return '<span class="StationSearchPill" style="background:' + L.Color + '">' + EscapeHtml(L.Name) + '</span>'; }).join('') +
                (More > 0 ? '<span class="StationSearchPill more">+' + More + '</span>' : '') +
                '</span></div>';
        });

        Html += '</details>';
    }

    document.getElementById('PopupContent').innerHTML = Html;
    Overlay.style.display = 'flex';
    CurrentStationPopup = SN;
    ShowZoomToStationButton();
    RefreshStationDots();

    var ConnectedLineIds = ConnectedLines.map(L => L.Id);
    ApplyLineEmphasis(L => ConnectedLineIds.includes(L.Id), 1);
}

// The flag beside a station's name in its panel (hidden for places or stations with no country)
function SetPopupFlag(country) {
    var img = document.getElementById('PopupStationFlag');
    if (!img) return;
    if (country) {
        img.src = FLAG_IMAGE_BASE + '/' + encodeURIComponent(country) + '.webp';
        img.title = country;
        img.hidden = false;
        img.onerror = function() { img.hidden = true; };
    } else {
        img.hidden = true;
        img.removeAttribute('src');
    }
}

function CloseStationPopup() {
    CloseStationPopupCore();
    if (LineDetail === 'detailed') RefreshStationDots();
}

function CloseStationPopupCore() {
    if (CurrentStationPopup === '__destination__') { CloseDestinationPopup(); return; }
    if (SelectedStationGroup.length) {
        SelectedStationGroup.forEach(function(Key) {
            var M = StationMarkers[Key];
            if (M) { SetMarkerEnlarged(M, Stations[Key], false); SetMarkerSelectedGlow(M, false); }
        });

        SelectedStationKey = null;
        SelectedStationGroup = [];
    }

    document.getElementById('StationPopupOverlay').style.display = 'none';
    CurrentStationPopup = null;
    HideZoomToStationButton();
    ReleaseSplashStationFocus();
    if (!SelectedId) Reset();
}

function EnsureZoomToStationButton() {
    var Btn = document.getElementById('StationZoomButton');
    if (Btn) return Btn;
    var PopupHeader = document.querySelector('.PopupHeader');
    if (!PopupHeader) return null;
    Btn = document.createElement('button');
    Btn.id = 'StationZoomButton';
    Btn.className = 'StationZoomButton';
    Btn.type = 'button';
    Btn.title = 'Zoom to station';
    Btn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><span>Zoom to station</span>';
    Btn.addEventListener('click', function(e) {
        e.stopPropagation();
        ZoomToSelectedStation();
    });

    PopupHeader.appendChild(Btn);
    return Btn;
}

function ShowZoomToStationButton() {
    var Btn = EnsureZoomToStationButton();
    if (Btn) Btn.style.display = '';
}

function HideZoomToStationButton() {
    var Btn = document.getElementById('StationZoomButton');
    if (Btn) Btn.style.display = 'none';
}

function ZoomToSelectedStation() {
    if (!SelectedStationKey) return;
    var S = Stations[SelectedStationKey];
    if (!S) return;
    var GroupKeys = SelectedStationGroup.length ? SelectedStationGroup : [SelectedStationKey];
    var GroupLocations = [];
    GroupKeys.forEach(function(GK) {
        var GS = Stations[GK];
        if (GS && GS.Location) GroupLocations.push(GS.Location);
    });

    if (GroupLocations.length > 1) {
        LMap.flyToBounds(GroupLocations, {paddingTopLeft: [400, 100], paddingBottomRight: [100, 100], animate: true, duration: 0.6, maxZoom: 16});
    } else if (S.Location) {
        var CurrentZoom = LMap.getZoom();
        var TargetZoom = Math.max(CurrentZoom, 12);
        LMap.flyTo(S.Location, TargetZoom, {animate: true, duration: 0.6});
    }
}

// Phones: the sidebar is a bottom sheet, peeking (its search), half open (the map above, the list below) or full; drag its top or tap it to move it
var SheetState = 'peek';
function IsPhone() { return window.innerWidth <= 768; }
function SheetHeight(state) {
    var peek = ['SheetGrab', 'SidebarHeader', 'OmniSearch'].reduce(function(a, id) { var e = document.getElementById(id); return a + (e ? e.offsetHeight : 0); }, 0);
    return Math.round(state === 'full' ? window.innerHeight * 0.92 : state === 'half' ? window.innerHeight * 0.5 : peek);
}

function SetSheet(state, px) {
    if (!IsPhone()) return;
    SheetState = state;
    document.documentElement.style.setProperty('--sheet-visible', (px != null ? px : SheetHeight(state)) + 'px');
    document.body.dataset.sheet = state;
}

function SheetVisible() { return IsPhone() ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sheet-visible')) || 0 : 0; }

(function InitSheet() {
    var S = document.getElementById('Sidebar'); if (!S) return;
    var start = null, order = ['peek', 'half', 'full'];
    var down = function(e) {
        if (!IsPhone() || e.target.closest('button, input, a')) return;
        start = {y: e.clientY, h: SheetHeight(SheetState), t: Date.now(), moved: false}; S.classList.add('sheet-dragging');
    };

    var move = function(e) {
        if (!start) return;
        if (Math.abs(e.clientY - start.y) > 4) start.moved = true;
        document.documentElement.style.setProperty('--sheet-visible', Math.max(SheetHeight('peek'), Math.min(SheetHeight('full'), start.h + start.y - e.clientY)) + 'px');
    };

    var up = function(e) {
        if (!start) return;
        S.classList.remove('sheet-dragging');
        var dy = start.y - e.clientY, h = start.h + dy, v = dy / Math.max(1, Date.now() - start.t), next;
        if (!start.moved) next = SheetState === 'peek' ? 'half' : SheetState === 'half' ? 'full' : 'half';          // a tap opens it a step
        else if (Math.abs(v) > 0.5) next = order[Math.max(0, Math.min(2, order.indexOf(SheetState) + (v > 0 ? 1 : -1)))];          // a flick moves it one step
        else next = order.reduce(function(b, s) { return Math.abs(SheetHeight(s) - h) < Math.abs(SheetHeight(b) - h) ? s : b; }, 'peek');
        start = null; SetSheet(next);
    };

    ['SheetGrab', 'SidebarHeader'].forEach(function(id) { var el = document.getElementById(id); if (el) el.addEventListener('pointerdown', down); });
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    window.addEventListener('resize', function() { if (IsPhone()) SetSheet(SheetState); });
    var input = document.getElementById('SearchInput');
    if (input) input.addEventListener('focus', function() { if (IsPhone()) SetSheet('full'); });          // room for the results above the keyboard
})();

// The padding that keeps a framed line clear of the sidebar (desktop) or of the sheet (phones)
function LineFitPadding() { return IsPhone() ? {paddingTopLeft: [24, 70], paddingBottomRight: [24, SheetVisible() + 24]} : {paddingTopLeft: [400, 100], paddingBottomRight: [100, 100]}; }

function ToggleSidebar() {
    if (IsPhone()) { SetSheet(SheetState === 'peek' ? 'half' : 'peek'); return; }
    var S = document.getElementById('Sidebar');
    var H = document.getElementById('Handle');
    H.innerHTML = S.classList.toggle('collapsed') ? '▶' : '◀';
    PositionProjectsCard();
}

function BuildByMode() {
    var H = '', MG = {};
    Registry.forEach(L => {
        if (!MG[L.ModeId]) MG[L.ModeId] = [];
        MG[L.ModeId].push(L);
    });

    Object.keys(ModesOrder).forEach(MI => {
        var LIM = MG[MI] || [], MD = ModesOrder[MI];
        var IsOff = DisabledModes.has(MI);
        H += `<details class='GroupBox${IsOff ? ' mode-group-off' : ''}' data-mode-group='${MI}'><summary class='GroupTitle'><span class='Indicator'>▶</span><span class='ModeDot' style='background:${MD.Color}'></span><span class='GroupTitleLabel'>${MD.Name}</span><span class='GroupCount'>${LIM.length}</span><button class='ModeRowSwitch${IsOff ? '' : ' active'}' onclick="event.preventDefault(); event.stopPropagation(); ToggleMode('${MI}')" title="${IsOff ? 'Show' : 'Hide'} ${MD.Name}"><span class='ModeRowSwitchKnob'></span></button></summary><div style='padding:0 10px 10px 15px;'>`;

        if (LIM.length === 0) H += `<div style='padding:15px;text-align:center;color:#94a3b8;font-size:12px;'>No services</div>`;
        else {
            var OSG = {};
            LIM.forEach(L => {
                if (!OSG[L.Operator]) OSG[L.Operator] = [];
                OSG[L.Operator].push(L);
            });

            Object.keys(OSG).sort().forEach(ON => {
                H += `<details class='OpGroupBox'><summary class='OpGroupTitle'><span class='Indicator'>▶</span>${ON}</summary><div style='padding:5px 0 5px 5px;'>`;
                OSG[ON].forEach(L => {
                    var SearchText = (L.Name + ' ' + ON).toLowerCase();
                    H += `<div class='Item' data-lineid='${L.Id}' data-search='${EscapeHtml(SearchText)}' style='--line-color:${L.Color}' onclick="SelectLine('${L.Id}')"><div class='ItemName'>${L.Name}</div></div><div id='Details_${L.Id}'></div>`;
                });

                H += `</div></details>`;
            });
        }

        H += `</div></details>`;
    });

    document.getElementById('ListContainer').innerHTML = H;
    var routeBadge = document.getElementById('RouteCountBadge');
    if (routeBadge) routeBadge.textContent = Registry.length.toLocaleString();
    var stationBadge = document.getElementById('StationCountBadge');
    if (stationBadge) stationBadge.textContent = BuildAllStationGroups('').length.toLocaleString();
}

function SetLayerStyle(Ly, StyleObj) {
    Ly.setStyle(StyleObj);
    if (Ly.eachLayer) Ly.eachLayer(function(FL) { FL.setStyle(StyleObj); });
}

function Visuals(I) {
    ApplyLineEmphasis(L => L.Id === I, 3);
}

function UpdateHeader(I) {
    var H = document.getElementById('HeaderInfo');
    if (!I) { H.style.display = 'none'; return; }
    var L = Registry.find(X => X.Id === I);
    if (!L) { H.style.display = 'none'; return; }
    H.style.display = 'flex';
    H.innerHTML = `<div style='text-align:center;'><div style='font-size:9px;font-weight:800;color:${L.Color};text-transform:uppercase;letter-spacing:1.5px;'>${L.Operator} • ${L.ModeName}</div><div style='font-size:22px;font-weight:900;color:#1e293b;letter-spacing:-0.4px;'>${L.Name}</div></div>`;
}

// Route diagrams: the build sends each pattern's shape (core/route_analyzer.py); the strip of stops is drawn here, only when a line is opened
var DIA_ROW = 35, DIA_TOP = 20, DIA_MAIN = 30, DIA_COL = 16;
function DiaBase(k) { return k.split(' {')[0]; }

// Index pairs of the longest common subsequence of two station lists
function DiaAlign(a, b) {
    var n = a.length, m = b.length, L = [];
    for (var i = 0; i <= n; i++) L.push(new Int32Array(m + 1));
    for (var i2 = n - 1; i2 >= 0; i2--)
        for (var j2 = m - 1; j2 >= 0; j2--) L[i2][j2] = a[i2] === b[j2] ? L[i2 + 1][j2 + 1] + 1 : Math.max(L[i2 + 1][j2], L[i2][j2 + 1]);

    var pairs = [], x = 0, y = 0;
    while (x < n && y < m) {
        if (a[x] === b[y]) { pairs.push([x, y]); x++; y++; }
        else if (L[x + 1][y] >= L[x][y + 1]) x++;
        else y++;
    }

    return pairs;
}

// The stops on a pattern's main rail, top to bottom
function DiaSpine(shape) {
    if (shape.Type !== 'Branched') return shape.Stations.slice();
    var out = [];
    shape.Sections.forEach(function(s) { out.push.apply(out, s[1]); });
    return out;
}

function DiaLayout() {
    var lay = {rows: [], rails: [{col: 0}]};
    lay.rail = function(top, bottom, dashed, col, turn) {
        var r = {top: top, bottom: bottom, dashed: !!dashed, col: col == null ? null : col, turn: turn || null, rows: []};
        lay.rails.push(r); return r;
    };

    lay.row = function(key, rail, at, extra) {
        var r = Object.assign({key: key, rail: rail || lay.rails[0]}, extra || {});
        lay.rows.splice(at == null ? lay.rows.length : at, 0, r);
        if (rail) rail.rows.push(r);
        return r;
    };

    return lay;
}

// A pattern's rows and rails -> {lay, spine: its main-rail rows}
function DiaLayoutOf(shape) {
    var lay = DiaLayout();
    if (shape.Type !== 'Branched') {
        shape.Stations.forEach(function(k) { lay.row(k); });
        if (shape.Type === 'Loop' && lay.rows.length > 2) lay.rail(lay.rows[0], lay.rows[lay.rows.length - 1], false, null, 'bottom');
        return {lay: lay, spine: lay.rows.slice()};
    }

    var pending = [];                                               // forks waiting for the shared stop that closes them
    shape.Sections.forEach(function(sec, si) {
        if (sec[0] === 'Shared') {
            sec[1].forEach(function(k) { var r = lay.row(k); pending.forEach(function(f) { f.bottom = r; }); pending = []; });
        } else if (sec[0] === 'Split') {
            var fork = lay.rail(lay.rows.length ? lay.rows[lay.rows.length - 1] : null, null, true);
            sec[1].forEach(function(k) { lay.row(k, null, null, {note: '↓'}); });
            sec[2].forEach(function(k) { lay.row(k, fork, null, {note: '↑', muted: true, hollow: true}); });
            pending.push(fork);
        } else {
            var first = lay.rows.length;
            sec[1].forEach(function(k) { lay.row(k); });
            if (si === 0) pending.push(lay.rail(lay.rows[first], null, false, null, 'top'));          // a loop at the start comes back into the stop after it
            else if (lay.rows.length) lay.rail(lay.rows[first - 1], lay.rows[lay.rows.length - 1], false, null, 'bottom');     // a loop at the end comes back into the stop before it
        }
    });

    return {lay: lay, spine: lay.rows.filter(function(r) { return r.rail === lay.rails[0]; })};
}

// Another pattern of the line, off the drawn path it shares most with: its other stops branch (out of a stop, into a stop, or around a stretch)
function DiaMerge(lay, paths, shape) {
    var keys = DiaSpine(shape), best = null;
    if (!keys.length) return;
    paths.forEach(function(path) {
        var names = path.map(function(r) { return DiaBase(r.key); });
        [keys, keys.slice().reverse()].forEach(function(ks) {
            var pairs = DiaAlign(names, ks.map(DiaBase));
            if (!best || pairs.length > best.pairs.length) best = {path: path, keys: ks, pairs: pairs};
        });
    });

    var path = best.path, pairs = best.pairs; keys = best.keys;
    if (!pairs.length) {                                            // nothing in common: drawn on its own below
        var r0 = lay.rail(null, null, false, 0);
        paths.push(keys.map(function(k) { return lay.row(k, r0); }));
        return;
    }

    var branch = function(run, top, bottom, at) {
        if (!run.length) return [];
        var r = lay.rail(top, bottom);
        return run.map(function(k, i) { return lay.row(k, r, at + i); });
    };

    var i0 = pairs[0][0], j0 = pairs[0][1], il = pairs[pairs.length - 1][0], jl = pairs[pairs.length - 1][1];
    var mine = branch(keys.slice(0, j0), null, path[i0], lay.rows.indexOf(path[i0]));
    for (var p = 0; p + 1 < pairs.length; p++) {
        var i = pairs[p][0], j = pairs[p][1], i2 = pairs[p + 1][0], j2 = pairs[p + 1][1];
        mine = mine.concat([path[i]], branch(keys.slice(j + 1, j2), path[i], path[i2], lay.rows.indexOf(path[i2])));
    }

    paths.push(mine.concat([path[il]], branch(keys.slice(jl + 1), path[il], null, lay.rows.indexOf(path[il]) + 1)));
}

function DiaStyle(key) {
    var major = !!((AllNodes[key] || {}).Major);
    return {size: major ? 13 : 12, weight: major ? 900 : 600, dot: major ? 7 : 5};
}

function DiaName(key) {
    var s = AllNodes[key];
    if (!s) return key;
    var label = s.Label != null ? s.Label : key;
    if (String(s.Airport || '').trim().toLowerCase() === 'true' || s.Type === 'Airport') label += '<tspan dx="9" dy="2" rotate="-45">✈&#xFE0E;</tspan>';       // SVG turns the glyph itself; FE0E keeps it a text glyph
    return label;
}

function DiaRail(d, color, dashed) { return '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="3" stroke-linecap="round"' + (dashed ? ' stroke-dasharray="5,4"' : '') + '/>'; }

// Down column x from y0 to y1, bending out of / into the rail at xTop / xBottom; the `turn` end of a loop swings round past its last stop
function DiaSidePath(x, y0, y1, xTop, xBottom, turn) {
    var bend = DIA_ROW * (turn ? 0.8 : 0.45), e = 5, d;
    var arc = function(xa, xb, y) { var r = Math.abs(xb - xa) / 2; return 'A' + r + ',' + r + ' 0 0 1 ' + xb + ',' + y; };
    if (turn === 'top') d = 'M' + xTop + ',' + y0 + ' V' + (y0 - e) + ' ' + arc(xTop, x, y0 - e);
    else if (xTop != null) d = 'M' + xTop + ',' + y0 + ' C' + xTop + ',' + (y0 + bend) + ' ' + x + ',' + (y0 + bend * 0.4) + ' ' + x + ',' + (y0 + bend);
    else d = 'M' + x + ',' + y0;
    if (turn === 'bottom') return d + ' V' + (y1 + e) + ' ' + arc(x, xBottom, y1 + e) + ' V' + y1;
    return d + (xBottom != null ? ' V' + (y1 - bend) + ' C' + x + ',' + (y1 - bend * 0.4) + ' ' + xBottom + ',' + (y1 - bend) + ' ' + xBottom + ',' + y1 : ' V' + y1);
}

function DiaRender(lay, color) {
    if (!lay.rows.length) return '';
    var idx = new Map(lay.rows.map(function(r, i) { return [r, i]; })), ys = lay.rows.map(function(_, i) { return DIA_TOP + i * DIA_ROW; });
    var spans = [], taken = [];
    lay.rails.slice(1).forEach(function(rl) {                      // the rows each side rail covers, then the first column free there
        var ends = [rl.top, rl.bottom].concat(rl.rows).filter(function(r) { return r != null; }).map(function(r) { return idx.get(r); });
        if (ends.length) spans.push([rl, Math.min.apply(null, ends), Math.max.apply(null, ends)]);
    });

    spans.forEach(function(s) {
        var rl = s[0], a = s[1], b = s[2];
        if (rl.col == null) for (var c = 1; c < 99; c++) if (!taken.some(function(t) { return t[0] === c && a < t[2] && t[1] < b; })) { rl.col = c; break; }
        taken.push([rl.col, a, b]);
    });

    var textX = Math.max.apply(null, lay.rails.map(function(rl) { return DIA_MAIN + DIA_COL * rl.col + (rl.turn ? 10 : 0); })) + 16, body = [];
    var main = lay.rows.filter(function(r) { return r.rail === lay.rails[0]; });
    if (main.length > 1) body.push(DiaRail('M' + DIA_MAIN + ',' + ys[idx.get(main[0])] + ' V' + ys[idx.get(main[main.length - 1])], color));
    spans.forEach(function(s) {
        var rl = s[0], x = DIA_MAIN + DIA_COL * rl.col + (rl.turn ? 10 : 0);          // a loop is a little wider, so its turn reads as one
        if (rl.col === 0) { body.push(DiaRail('M' + x + ',' + ys[s[1]] + ' V' + ys[s[2]], color)); return; }
        var atX = function(r) { return r == null ? null : DIA_MAIN + DIA_COL * r.rail.col; };
        body.push(DiaRail(DiaSidePath(x, ys[s[1]], ys[s[2]], atX(rl.top), atX(rl.bottom), rl.turn), color, rl.dashed));
    });

    lay.rows.forEach(function(r) {
        var y = ys[idx.get(r)], x = DIA_MAIN + DIA_COL * r.rail.col, st = DiaStyle(r.key), rad = st.dot - (r.hollow ? 1 : 0);
        body.push('<circle class="station-dot" data-station="' + r.key + '" cx="' + x + '" cy="' + y + '" r="' + rad + '" ' + (r.hollow ? 'fill="#fff" stroke="' + color + '" stroke-width="2.5"' : 'fill="' + color + '"') + '/>');
        body.push('<text class="station-label" data-station="' + r.key + '" x="' + textX + '" y="' + (y + 5) + '" font-size="' + st.size + '" fill="' + (r.muted ? '#475569' : '#1e293b') + '" font-weight="' + st.weight + '">' +
                  DiaName(r.key) + (r.note ? '<tspan dx="6" font-size="13" font-weight="700" fill="#64748b">' + r.note + '</tspan>' : '') + '</text>');
    });

    return '<svg width="100%" height="' + Math.max(60, ys[ys.length - 1] + DIA_ROW) + '" style="margin:8px 0">' + body.join('') + '</svg>';
}

// A pattern's shape with its stops' names in place of their indexes in its list of stops (worked out once)
function PatternShape(P) {
    if (!P.Shape) return null;
    if (!P._shape) {
        var k = function(ix) { return ix.map(function(i) { return P.Stations[i]; }); }, s = P.Shape;
        P._shape = s.Type !== 'Branched' ? {Type: s.Type, Stations: k(s.Stations)} : {Type: 'Branched', Sections: s.Sections.map(function(x) { return [x[0]].concat(x.slice(1).map(k)); })};
    }

    return P._shape;
}

function PatternDiagram(shape, color) { return shape ? DiaRender(DiaLayoutOf(shape).lay, color) : ''; }

// Every pattern of a line on one diagram: the one with the most stops is the main rail, the others branch off it
function LineDiagram(shapes, color) {
    shapes = shapes.filter(Boolean);
    if (shapes.length < 2) return '';
    var order = shapes.map(function(_, i) { return i; }).sort(function(a, b) { return DiaSpine(shapes[b]).length - DiaSpine(shapes[a]).length || a - b; });
    var first = DiaLayoutOf(shapes[order[0]]), paths = [first.spine];
    order.slice(1).forEach(function(i) { DiaMerge(first.lay, paths, shapes[i]); });
    return DiaRender(first.lay, color);
}

function RenderDetails(I) {
    var L = Registry.find(X => X.Id === I);
    var T = document.getElementById('Details_' + I);
    if (!T || T.innerHTML !== "") {
        if (T) T.innerHTML = "";
        return;
    }

    // A line with several patterns opens on one diagram of all of them; each pattern's own stays a click away
    var Shapes = L.Patterns.map(PatternShape), All = LineDiagram(Shapes, L.Color);          // drawn now, when the line is opened
    var H = All ? `<details class='PatternBox' open><summary class='PatternTitle'><span class='Indicator'>▶</span>All services</summary><div class='PatternContent'>${All}</div></details>` : "";
    L.Patterns.forEach((P, Idx) => {
        H += `<details class='PatternBox'${All ? '' : ' open'}><summary class='PatternTitle'><span class='Indicator'>▶</span>${P.Name}</summary><div class='PatternContent'>${PatternDiagram(Shapes[Idx], L.Color)}</div></details>`;
    });

    T.innerHTML = H;

    document.querySelectorAll('#Details_' + I + ' [data-station]').forEach(El => {
        El.childNodes.forEach(Node => {
            if (Node.nodeType === 3) {
                var Cleaned = CleanStationName(Node.textContent);
                if (Cleaned !== Node.textContent) Node.textContent = Cleaned;
            }
        });
    });

    document.querySelectorAll('#Details_' + I + ' .station-label, #Details_' + I + ' .station-dot').forEach(El => {
        let StationKey = El.getAttribute('data-station');
        if (StationKey) {
            El.addEventListener('mouseover', () => {
                HighlightStationMarker(StationKey, true);
                document.querySelectorAll(`[data-station="${StationKey}"]`).forEach(E => E.classList.add('diagram-hover'));
            });

            El.addEventListener('mouseout', () => {
                HighlightStationMarker(StationKey, false);
                document.querySelectorAll(`[data-station="${StationKey}"]`).forEach(E => E.classList.remove('diagram-hover'));
            });

            El.addEventListener('click', () => ShowStationPopup(StationKey));
        }
    });
}

function HideLayer(Ly) {
    Ly.setStyle({opacity: 0, fillOpacity: 0});
}

function ShowLayer(Ly, Color, Weight) {
    Ly.setStyle({color: Color, weight: Weight, opacity: 1.0, fillOpacity: 0.2});
}

function _DoFilterList() {
    var Q = document.getElementById('SearchInput').value.toLowerCase().trim();
    document.querySelectorAll('.GroupBox').forEach(G => {
        var GM = false;
        G.querySelectorAll('.OpGroupBox').forEach(OG => {
            var OM = false;
            OG.querySelectorAll('.Item').forEach(El => {
                var M = Q === "" || El.dataset.search.includes(Q);
                El.style.display = M ? 'block' : 'none';
                if (M) OM = true;
            });

            OG.style.display = OM ? 'block' : 'none';
            if (OM) { OG.open = true; GM = true; }
        });

        G.style.display = Q === "" || GM ? 'block' : 'none';
        if (Q !== "" && GM) G.open = true;
    });
}

function HighlightStationMarker(SN, A) {
    var M = StationMarkers[SN];
    if (!M) return;
    SetMarkerEnlarged(M, Stations[SN], A);
    A ? M.openTooltip() : M.closeTooltip();
}

// Station keys bucketed by a 0.01 degree grid, rebuilt when the station set changes
var NEAR_CELL_DEG = 0.01, _nearGrid = null, _nearKeys = null, _nearStations = null;
function NearbyGrid() {
    if (_nearStations !== Stations) {
        _nearGrid = {}; _nearStations = Stations; _nearKeys = Object.keys(Stations);
        _nearKeys.forEach(function(k, i) {
            var S = Stations[k];
            if (!S || !S.Location) return;
            var c = Math.floor(S.Location[0] / NEAR_CELL_DEG) + ',' + Math.floor(S.Location[1] / NEAR_CELL_DEG);
            (_nearGrid[c] || (_nearGrid[c] = [])).push(i);
        });
    }

    return _nearGrid;
}

function FindNearbyStationKeys(S, ExcludeKeys) {
    var Nearby = [];
    if (!S || !S.Location) return Nearby;
    var lat = S.Location[0], lon = S.Location[1], grid = NearbyGrid(), hits = [];
    var LatSpan = STATION_POPUP_RADIUS_KM / 111;
    var LonSpan = LatSpan / Math.max(0.01, Math.cos(lat * Math.PI / 180));
    for (var i = Math.floor((lat - LatSpan) / NEAR_CELL_DEG); i <= Math.floor((lat + LatSpan) / NEAR_CELL_DEG); i++)
        for (var j = Math.floor((lon - LonSpan) / NEAR_CELL_DEG); j <= Math.floor((lon + LonSpan) / NEAR_CELL_DEG); j++) hits.push.apply(hits, grid[i + ',' + j] || []);
    hits.sort(function(a, b) { return a - b; }).forEach(function(n) {
        var Key = _nearKeys[n], Other = Stations[Key];
        if (ExcludeKeys.includes(Key)) return;
        if (Math.abs(Other.Location[0] - lat) > LatSpan || Math.abs(Other.Location[1] - lon) > LonSpan) return;
        if (CalculateDistance(lat, lon, Other.Location[0], Other.Location[1]) <= STATION_POPUP_RADIUS_KM) Nearby.push(Key);
    });

    return Nearby;
}

function BuildStationTooltip(SN, SL) {
    var S = Stations[SN];
    var GroupKeys = StationGroupMembers(SN);
    var NearbyStations = GroupKeys.concat(FindNearbyStationKeys(S, GroupKeys));

    var LH = LinesServing(NearbyStations, true);

    var MM = {};
    LH.forEach(L => {
        if (!MM[L.ModeId]) MM[L.ModeId] = [];
        MM[L.ModeId].push(L);
    });

    var PM = S && IsAirport(S) ? ` <span class="PlaneIcon"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span>` : '';
    var H = `<div class='StationPopup'><b>${CleanStationName(SL || SN)}${PM}</b>`;

    Object.keys(Modes).forEach(ModeId => {
        if (!MM[ModeId]) return;
        var ModeData = Modes[ModeId];
        H += `<div class='ModeHeader'>${ModeData.Name}</div>`;
        MM[ModeId].forEach(L => H += `<div class='HubLineContent'><span class='HubDot' style='background:${L.Color}'></span><span><span class='OpTag'>${L.Operator}</span><span class='Separator'>•</span>${L.Name}</span></div>`);
    });

    return H + `</div>`;
}

function ClearStationMarkers() {
    Object.values(StationMarkers).forEach(M => LMap.removeLayer(M));
    StationMarkers = {};
    if (StationGroupLineLayer) { LMap.removeLayer(StationGroupLineLayer); StationGroupLineLayer = null; }
}

// Keeps a tooltip open briefly after the mouse leaves so it can be reached; must wrap closeTooltip before bindTooltip
const HOVER_INTENT_DELAY_MS = 140;

function BindHoverableStationTooltip(marker, content, options, isMajor) {
    var closeTimer = null, openTimer = null;
    var originalClose = marker.closeTooltip.bind(marker);
    var originalOpen = marker.openTooltip.bind(marker);
    marker.closeTooltip = function() {
        clearTimeout(openTimer);
        clearTimeout(closeTimer);
        closeTimer = setTimeout(originalClose, 250);
        return marker;
    };

    // Minor stations open after a short delay so passing over them doesn't interrupt; major ones open at once
    marker.openTooltip = function(latlng) {
        clearTimeout(closeTimer);
        clearTimeout(openTimer);
        if (isMajor) { originalOpen(latlng); return marker; }
        openTimer = setTimeout(function() { originalOpen(latlng); }, HOVER_INTENT_DELAY_MS);
        return marker;
    };

    marker.bindTooltip(content, Object.assign({interactive: true}, options));
    marker.on('mouseover', function() { clearTimeout(closeTimer); });
    marker.on('mouseout', function() { clearTimeout(openTimer); });
    marker.on('tooltipopen', function(e) {
        var el = e.tooltip && e.tooltip.getElement();
        if (!el || el._hoverBound) return;
        el._hoverBound = true;
        el.addEventListener('mouseenter', function() { clearTimeout(closeTimer); });
        el.addEventListener('mouseleave', function() { marker.closeTooltip(); });
    });
}

function MakeStationMarker(key, location, radius, color, label) {
    var M = L.circleMarker(location, {
        radius: radius, fillColor: '#fff', color: color, weight: STROKE_WEIGHT, opacity: 1, fillOpacity: 1
    }).addTo(LMap);

    BindHoverableStationTooltip(M, BuildStationTooltip(key, label), {sticky: false, className: 'StationTooltip', direction: 'top', offset: [0, -10], pane: 'hoverTooltipPane'}, true);
    M.on('mouseover', () => HighlightStationMarker(key, true))
     .on('mouseout',  () => HighlightStationMarker(key, false))
     .on('click', (e) => { L.DomEvent.stopPropagation(e); ShowStationPopup(key, true); });
    StationMarkers[key] = M;
    return M;
}

function EnsureGroupMarkersExist(GroupKeys) {
    GroupKeys.forEach(function(Key) {
        if (StationMarkers[Key]) return;
        var S = Stations[Key] || AllNodes[Key];
        if (!S || !S.Location) return;
        if (S.Span && PlatformModeOn()) return;          // shown as platforms instead
        var ServingLine = LinesAt(Key)[0];
        var Color = ServingLine ? ServingLine.Color : '#94a3b8';
        var Radius = BaseDotRadius(S);
        MakeStationMarker(Key, S.Location, Radius, Color, S.Label);
    });
}

function FocusedLine() {
    var id = SelectedId;
    return id ? Registry.find(L => L.Id === id) : null;
}

// Visibility and size come from a station's most important mode (lowest reveal zoom)
const LINE_COUNT_FOR_MAX_SIZE = 8;

// Major stations grow from their mode's min to max size with the number of lines serving them
function ScaleMajorSize(minPx, maxPx, lineCount) {
    var t = Math.min(Math.max((lineCount - 1) / (LINE_COUNT_FOR_MAX_SIZE - 1), 0), 1);
    return minPx + t * (maxPx - minPx);
}

// On a selected line a major station stands clearly apart: its mode's largest size, and at least MAJOR_FOCUS_RATIO times a minor stop
const MAJOR_FOCUS_RATIO = 1.6;
function FocusDotPx(modeId, isMajor) {
    var md = Modes[modeId];
    if (!md) return DOT_SIZE;
    return isMajor ? Math.max(md.MajorPxMax, md.MinorPx * MAJOR_FOCUS_RATIO) : md.MinorPx;
}

function GetStationVisual(modesSet, isMajor, lineCount) {
    var revealZoom = Infinity, px = DOT_SIZE;
    modesSet.forEach(function(m) {
        var md = Modes[m];
        if (!md) return;
        var rz = isMajor ? md.MajorZoom : md.MinorZoom;
        if (rz < revealZoom) { revealZoom = rz; px = isMajor ? ScaleMajorSize(md.MajorPxMin, md.MajorPxMax, lineCount) : md.MinorPx; }
    });

    return {revealZoom: revealZoom, px: px};
}

function MakeDotMarker(sn, location, color, size, isMajor, zPriority) {
    var hitPadding = isMajor ? Math.max(DOT_HIT_PADDING, size * 0.35) : DOT_HIT_PADDING;
    var box = size + hitPadding * 2;
    var pulseClass = isMajor ? ' station-dot-major pulse-' + (sn.charCodeAt(0) % 3) : '';
    var dotHtml = '<span class="station-dot' + pulseClass + '" style="width:' + size + 'px;height:' + size + 'px;' +
                  'border-width:' + Math.max(1, size / 8) + 'px;border-color:' + color + ';color:' + color + '"></span>';
    var icon = L.divIcon({
        className: 'station-dot-wrap',
        html: dotHtml,
        iconSize: [box, box],
    });

    var m = L.marker(location, {icon: icon, pane: 'stationDotPane', zIndexOffset: zPriority || 0}).addTo(LMap);
    m._dotLook = [size, color, !!isMajor].join('|');
    BindHoverableStationTooltip(m, '', {sticky: false, className: 'StationTooltip', direction: 'top', offset: [0, -10], pane: 'hoverTooltipPane'}, isMajor);
    m.on('mouseover', function() {
        if (!m._tooltipBuilt) { m.setTooltipContent(BuildStationTooltip(sn, (Stations[sn] || {}).Label)); m._tooltipBuilt = true; }
        HighlightStationMarker(sn, true);
    });

    m.on('mouseout', function() { HighlightStationMarker(sn, false); });
    m.on('click', function(e) { L.DomEvent.stopPropagation(e); ShowStationPopup(sn, true); });
    StationMarkers[sn] = m;
}

var PLATFORM_OUTLINE_ZOOM = 16;       // from this zoom on, the platforms of the stations shown are drawn as outlined tracks (detailed map); every station switches at the same zoom

var _platLit = {};                // station group base -> its platform halos (lit up together when one of them is pointed at)

function LightPlatforms(base, on) {
    (_platLit[base] || []).forEach(function(h) { h.setStyle({opacity: on ? 0.4 : 0}); });
}

function RefreshStationGroupLines(wanted, platformStations) {
    if (StationGroupLineLayer) { LMap.removeLayer(StationGroupLineLayer); StationGroupLineLayer = null; }
    _platLit = {};

    var finalLocation = {};
    Object.keys(wanted).forEach(function(sn) {
        var w = wanted[sn];
        (w.mergedWith || [sn]).forEach(function(memberSn) { finalLocation[memberSn] = w.location; });
    });

    var parts = [];

    // A station's platforms that stay separate dots (simplified map) are tied together with a dotted line.
    var byBase = {};
    Object.keys(finalLocation).forEach(function(sn) {
        var base = StationGroupBase(sn);
        if (base === sn) return;
        var loc = finalLocation[sn];
        var bucket = byBase[base] || (byBase[base] = []);
        if (!bucket.some(function(l) { return l[0] === loc[0] && l[1] === loc[1]; })) bucket.push(loc);
    });

    var paths = [];
    Object.keys(byBase).forEach(function(base) { if (byBase[base].length >= 2) paths.push(ShortestPathThroughPoints(byBase[base])); });
    if (paths.length) parts.push(L.polyline(paths, {
        pane: 'stationGroupPane', color: '#475569', weight: 2.5, opacity: 0.85,
        dashArray: '1,7', lineCap: 'round', interactive: false,
    }));

    // Each platform as an outlined track; hovering lights up the whole station, clicking selects it
    var map = LMap, zoom = map.getZoom(), seen = {};
    Object.keys(platformStations || {}).forEach(function(sn) {
        var ps = platformStations[sn], base = StationGroupBase(sn), mine = [];
        var tip = null;
        ps.members.forEach(function(k) {
            if (seen[k]) return; seen[k] = true;
            var sp = Stations[k].Span, line = [sp[0], sp[1]];
            var mpp = 156543.03 * Math.cos(sp[0][0] * Math.PI / 180) / Math.pow(2, zoom);
            var width = Math.max(7, Math.min(26, 5 / mpp)), col = ps.color || NEUTRAL_DOT_COLOR;
            var lit = CurrentStationPopup && StationGroupBase(CurrentStationPopup) === base;
            var halo = L.polyline(line, {pane: 'stationGroupPane', color: col, weight: width + 5, opacity: lit ? 0.4 : 0, lineCap: 'round', interactive: false});
            var outer = L.polyline(line, {pane: 'stationGroupPane', color: col, weight: width, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false});
            var inner = L.polyline(line, {pane: 'stationGroupPane', color: '#fff', weight: Math.max(3, width - 5), opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false});
            var hit = L.polyline(line, {pane: 'stationGroupPane', color: '#000', weight: width + 10, opacity: 0.01, lineCap: 'round', interactive: true, className: 'platform-hit'});
            (_platLit[base] || (_platLit[base] = [])).push(halo);
            hit.on('mouseover', function() {
                LightPlatforms(base, true);
                if (!tip) tip = BuildStationTooltip(sn, (Stations[sn] || {}).Label);
                hit.bindTooltip(tip, {sticky: true, className: 'StationTooltip', direction: 'top', offset: [0, -8], pane: 'hoverTooltipPane'}).openTooltip();
            });

            hit.on('mouseout', function() { if (!(CurrentStationPopup && StationGroupBase(CurrentStationPopup) === base)) LightPlatforms(base, false); hit.closeTooltip(); });
            hit.on('click', function(e) { L.DomEvent.stopPropagation(e); ShowStationPopup(sn, true); });
            parts.push(halo, outer, inner, hit);
        });
    });

    if (parts.length) StationGroupLineLayer = L.layerGroup(parts).addTo(map);
}

function ShortestPathThroughPoints(points) {
    if (points.length <= 2) return points;
    if (points.length > 8) return NearestNeighborPath(points);

    var best = points, bestLen = PathLength(points);
    function permute(arr, l) {
        if (l === arr.length - 1) {
            var len = PathLength(arr);
            if (len < bestLen) { bestLen = len; best = arr.slice(); }
            return;
        }

        for (var i = l; i < arr.length; i++) {
            var tmp = arr[l]; arr[l] = arr[i]; arr[i] = tmp;
            permute(arr, l + 1);
            tmp = arr[l]; arr[l] = arr[i]; arr[i] = tmp;
        }
    }

    permute(points.slice(), 0);
    return best;
}

function PathLength(path) {
    var total = 0;
    for (var i = 1; i < path.length; i++) total += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
    return total;
}

function NearestNeighborPath(points) {
    var remaining = points.slice();
    var path = [remaining.shift()];
    while (remaining.length) {
        var last = path[path.length - 1];
        var bestIdx = 0, bestDist = Infinity;
        remaining.forEach(function(p, idx) {
            var d = Math.hypot(p[0] - last[0], p[1] - last[1]);
            if (d < bestDist) { bestDist = d; bestIdx = idx; }
        });

        path.push(remaining.splice(bestIdx, 1)[0]);
    }

    return path;
}

// Platforms one stop may use (a pattern's Alt list): station key -> every platform of its group
var _altGroups = null, _altGroupsRegistry = null;
function AltGroupMembers(sn) {
    if (_altGroups === null || _altGroupsRegistry !== Registry) {
        _altGroups = {}; _altGroupsRegistry = Registry; var byBase = {};
        (Registry || []).forEach(function(Ln) {
            (Ln.Patterns || []).forEach(function(P) {
                (P.Alt || []).forEach(function(g) {
                    var all = new Set(g);
                    g.forEach(function(k) { (_altGroups[k] || []).forEach(function(m) { all.add(m); }); });
                    var arr = Array.from(all);
                    arr.forEach(function(k) { _altGroups[k] = arr; });
                });
            });

            // Detailed map: all platforms a line stops at are one group, joined by the connector and merged when zoomed out
            if (LineDetail === 'detailed') {
                (Ln.AllLineStations || []).forEach(function(k) {
                    if (k.indexOf(' {') === -1) return;
                    var b = StationGroupBase(k), grp = byBase[b] || (byBase[b] = []);
                    if (grp.indexOf(k) === -1) grp.push(k);
                });
            }
        });

        Object.keys(byBase).forEach(function(b) {
            var grp = byBase[b]; if (grp.length < 2) return;
            var all = new Set(grp);
            grp.forEach(function(k) { (_altGroups[k] || []).forEach(function(m) { all.add(m); }); });
            var arr = Array.from(all);
            arr.forEach(function(k) { _altGroups[k] = arr; });
        });
    }

    return _altGroups[sn] || null;
}

// With a line selected, a stop's alternative platforms still merge into one dot where they would overlap
function MergeAltDots(wanted) {
    var done = {};
    Object.keys(wanted).forEach(function(sn) {
        var grp = AltGroupMembers(sn);
        if (!grp || done[grp[0]]) return;
        done[grp[0]] = true;
        var mem = grp.filter(function(k) { return wanted[k]; });
        if (mem.length < 2) return;
        var anchor = mem.reduce(function(best, k) { return (wanted[k].size || 0) > (wanted[best].size || 0) ? k : best; }, mem[0]), w = wanted[anchor];
        mem.forEach(function(k) { delete wanted[k]; });
        wanted[anchor] = {location: MeanLocation(mem.map(function(k) { return Stations[k].Location; })), color: w.color, size: w.size, major: w.major, zPriority: w.zPriority, mergedWith: mem};
    });
}

// A multi-platform station's dot sits in their middle, snapped onto the nearest platform when the middle is off the track (side-by-side tracks keep the middle)
var PLATFORM_SNAP_M = 20;
function SnapToPlatforms(p, keys) {
    var best = null, kx = Math.cos(p[0] * Math.PI / 180);
    keys.forEach(function(k) {
        var S = Stations[k], sp = S && S.Span;
        if (!sp) return;
        for (var i = 0; i + 1 < sp.length; i++) {
            var a = sp[i], b = sp[i + 1], ax = (a[1] - p[1]) * kx, ay = a[0] - p[0], dx = (b[1] - a[1]) * kx, dy = b[0] - a[0], L2 = dx * dx + dy * dy;
            var t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0, d = Math.hypot(ax + t * dx, ay + t * dy);
            if (!best || d < best.d) best = {d: d, p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]};
        }
    });

    return best && best.d * 111320 > PLATFORM_SNAP_M ? best.p : p;
}

// An airport is a station with 'Airport': 'True' in the map data (the older 'Type': 'Airport' still counts).
function IsAirport(S) { return !!S && (String(S.Airport).toLowerCase() === 'true' || S.Airport === true || S.Type === 'Airport'); }

function MeanLocation(locs) {
    return [locs.reduce(function(a, l) { return a + l[0]; }, 0) / locs.length, locs.reduce(function(a, l) { return a + l[1]; }, 0) / locs.length];
}

function CollapseStationGroups(candidates) {
    var byBase = {};
    candidates.forEach(function(c) { (byBase[StationGroupBase(c.sn)] || (byBase[StationGroupBase(c.sn)] = [])).push(c); });
    return CollapseByBase(byBase);
}

// Several candidate dots as one: the busiest member speaks for them, placed by place(anchor)
function MergedCandidate(ms, place) {
    var anchor = ms.reduce(function(best, m) { return m.importance > best.importance ? m : best; }, ms[0]);
    return {
        sn: anchor.sn, location: place(anchor), color: anchor.color,
        size: Math.max.apply(null, ms.map(function(m) { return m.size; })),
        major: ms.some(function(m) { return m.major; }),
        importance: Math.max.apply(null, ms.map(function(m) { return m.importance; })),
        zPriority: Math.max.apply(null, ms.map(function(m) { return m.zPriority || 0; })),
        mergedWith: ms.map(function(m) { return m.sn; }),
    };
}

function CollapseByBase(byBase) {
    return Object.keys(byBase).map(function(base) {
        var ms = byBase[base];
        if (ms.length === 1) return ms[0];
        return MergedCandidate(ms, function(anchor) {          // the platforms of one detailed station: one dot, in the middle of them
            return AltGroupMembers(anchor.sn) ? SnapToPlatforms(MeanLocation(ms.map(function(m) { return m.location; })), ms.map(function(m) { return m.sn; })) : anchor.location;
        });
    });
}

// Dots that would overlap on screen become one; biggest first, each joining the earliest cluster it overlaps (found through a screen grid)
function MergeOverlappingCandidates(candidates) {
    if (candidates.length < 2) return candidates;
    var order = candidates.map(function(_, i) { return i; }).sort(function(a, b) { return candidates[b].size - candidates[a].size; });
    var cell = Math.max(1, candidates[order[0]].size * MERGE_OVERLAP_RATIO), clusters = [], grid = {};
    order.forEach(function(i) {
        var c = candidates[i], p = LMap.latLngToContainerPoint(c.location), r = c.size / 2;
        var gx = Math.floor(p.x / cell), gy = Math.floor(p.y / cell), target = -1;
        for (var dx = -1; dx <= 1; dx++)
            for (var dy = -1; dy <= 1; dy++) (grid[(gx + dx) + ',' + (gy + dy)] || []).forEach(function(k) {
                var cl = clusters[k];
                if ((target === -1 || k < target) && Math.hypot(p.x - cl.point.x, p.y - cl.point.y) <= (cl.radius + r) * MERGE_OVERLAP_RATIO) target = k;
            });

        if (target !== -1) { clusters[target].members.push(c); return; }
        (grid[gx + ',' + gy] || (grid[gx + ',' + gy] = [])).push(clusters.length);
        clusters.push({point: p, radius: r, members: [c]});
    });

    return clusters.map(function(cl) {
        if (cl.members.length === 1) return cl.members[0];
        return MergedCandidate(cl.members, function(anchor) {          // all one stop's platforms: one dot, in the middle of them
            var g0 = AltGroupMembers(anchor.sn);
            return g0 && cl.members.every(function(m) { return g0.indexOf(m.sn) !== -1; }) ? MeanLocation(cl.members.map(function(m) { return m.location; })) : anchor.location;
        });
    });
}

var ScheduleStationDots = Debounce(RefreshStationDots, 120);

var _linesByStationCache = null;
var _linesByStationCacheRegistry = null;
var _linesByStationCacheModesKey = null;

function GetLinesByStation() {
    var modesKey = (DisabledModes.size ? Array.from(DisabledModes).sort().join(',') : '') + '|' + LineDetail;
    if (_linesByStationCache && _linesByStationCacheRegistry === Registry && _linesByStationCacheModesKey === modesKey) return _linesByStationCache;
    var linesByStation = {};
    Registry.forEach(function(Ln) {
        if (DisabledModes.has(Ln.ModeId)) return;
        Ln.AllLineStations.forEach(function(sn) {
            var entry = linesByStation[sn] || (linesByStation[sn] = {lines: new Set(), modes: new Set()});
            entry.lines.add(Ln.Id);
            entry.modes.add(Ln.ModeId);
        });
    });

    Object.keys(linesByStation).forEach(function(sn) {            // a stop's alternative platforms look the same: each counts the lines / modes of them all
        var grp = AltGroupMembers(sn); if (!grp) return;
        var lines = new Set(), modes = new Set();
        grp.forEach(function(k) { var e = linesByStation[k]; if (e) { e.lines.forEach(function(x) { lines.add(x); }); e.modes.forEach(function(x) { modes.add(x); }); } });
        linesByStation[sn] = {lines: lines, modes: modes};
    });

    _linesByStationCache = linesByStation;
    _linesByStationCacheRegistry = Registry;
    _linesByStationCacheModesKey = modesKey;
    return linesByStation;
}

// Alternative platforms of a stop look alike: major if any of them is
function StopIsMajor(sn) {
    var grp = AltGroupMembers(sn);
    return !!(Stations[sn] || {}).Major || (!!grp && grp.some(function(k) { return !!(Stations[k] || {}).Major; }));
}

function RefreshStationDots() {
    if (!LMap || CurrentStationPopup === '__destination__') return;

    var Focus = FocusedLine();
    var wanted = {};

    if (CurrentStationPopup) {
        var GroupKeys = SelectedStationGroup.length ? SelectedStationGroup : [CurrentStationPopup];
        GroupKeys.forEach(function(sn) {
            var s = Stations[sn] || AllNodes[sn];
            if (s && s.Location) wanted[sn] = {
                location: s.Location,
                color: NEUTRAL_DOT_COLOR,
                size: BaseDotRadius(s),
                major: !!s.Major,
                zPriority: s.Major ? 1000 : 0,
            };
        });
    } else if (Focus) {
        Focus.AllLineStations.forEach(function(sn) {
            var s = Stations[sn];
            var majF = StopIsMajor(sn);
            if (s) wanted[sn] = {
                location: s.Location,
                color: Focus.Color,
                size: Math.round(FocusDotPx(Focus.ModeId, majF) * FOCUS_SCALE),
                major: majF,
                zPriority: majF ? 1000 : 0,
            };
        });

        MergeAltDots(wanted);
    } else if (!StationDotsHidden) {
        var bounds = LMap.getBounds().pad(0.25);
        var zoom = LMap.getZoom();
        var linesByStation = GetLinesByStation();

        var candidates = [];
        Object.keys(linesByStation).forEach(function(sn) {
            var s = Stations[sn];
            if (!s || !s.Location || !bounds.contains(s.Location)) return;
            var entry = linesByStation[sn];
            var isMajorA = StopIsMajor(sn);
            var visual = GetStationVisual(entry.modes, isMajorA, entry.lines.size);
            if (zoom < visual.revealZoom) return;
            // z-priority is driven directly by rendered size, so the biggest dots always win hover/click over smaller ones near them
            var importance = (isMajorA ? 1000000 : 0) + visual.px * 1000 + entry.lines.size;
            candidates.push({sn: sn, location: s.Location, color: NEUTRAL_DOT_COLOR, size: visual.px, importance: importance, major: isMajorA, zPriority: visual.px * 1000 + importance});
        });

        if (candidates.length > MAX_IDLE_STATION_MARKERS) {
            candidates.sort(function(a, b) { return b.importance - a.importance || a.sn.localeCompare(b.sn); });
            candidates = candidates.slice(0, MAX_IDLE_STATION_MARKERS);
        }

        candidates = MergeOverlappingCandidates(CollapseStationGroups(candidates));
        candidates.forEach(function(c) {
            wanted[c.sn] = {location: c.location, color: c.color, size: c.size, major: c.major, zPriority: c.zPriority, mergedWith: c.mergedWith};
        });
    }

    // Detailed map zoomed in: stations with platform spans show their platforms instead of a dot
    var platformStations = {};
    if (LineDetail === 'detailed' && LMap.getZoom() >= PLATFORM_OUTLINE_ZOOM) {
        Object.keys(wanted).forEach(function(sn) {
            var w = wanted[sn], mem = (w.mergedWith || [sn]).filter(function(k) { return Stations[k] && Stations[k].Span; });
            if (!mem.length) return;
            platformStations[sn] = {members: mem, color: w.color, size: w.size};
            delete wanted[sn];
        });
    }

    Object.keys(StationMarkers).forEach(function(sn) {
        if (!wanted[sn]) { LMap.removeLayer(StationMarkers[sn]); delete StationMarkers[sn]; }
    });

    Object.keys(wanted).forEach(function(sn) {
        var w = wanted[sn], ex = StationMarkers[sn];
        if (ex && ex._dotLook !== [w.size, w.color, !!w.major].join('|')) { LMap.removeLayer(ex); delete StationMarkers[sn]; }          // a dot drawn for another view (size, colour) is drawn again

        if (!StationMarkers[sn]) MakeDotMarker(sn, w.location, w.color, w.size, w.major, w.zPriority);
        else {
            if (StationMarkers[sn].setZIndexOffset) StationMarkers[sn].setZIndexOffset(wanted[sn].zPriority);
            var cur = StationMarkers[sn].getLatLng && StationMarkers[sn].getLatLng(), wl = wanted[sn].location;
            if (cur && (Math.abs(cur.lat - wl[0]) > 1e-9 || Math.abs(cur.lng - wl[1]) > 1e-9)) StationMarkers[sn].setLatLng(wl);       // a merged dot sits between its platforms
        }
    });

    Object.keys(wanted).forEach(function(sn) { if (StationMarkers[sn]) StationMarkers[sn]._members = wanted[sn].mergedWith || [sn]; });
    RefreshStationGroupLines(wanted, platformStations);
    if (HoverLine) ShowHoverStations(HoverLine);
}

function SelectLine(I) {
    var LineEntry = Registry.find(X => X.Id === I);
    if (!LineEntry) return;
    if (DisabledModes.has(LineEntry.ModeId)) return;
    if (SelectedId === I) {
        SelectedId = null;
        Reset();
        return;
    }

    SelectedId = I;
    if (CurrentStationPopup) CloseStationPopup();
    Visuals(I);
    UpdateHeader(I);
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");
    RenderDetails(I);
    RefreshStationDots();

    // Selecting a line from the map opens the sidebar so its diagram is visible
    var sidebar = document.getElementById('Sidebar');
    if (IsPhone()) SetSheet('half');                                  // phones: the map above, the line's stops below
    else if (sidebar && sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        var handle = document.getElementById('Handle');
        if (handle) handle.innerHTML = '◀';
    }

    var detailsEl = document.getElementById('Details_' + I);
    if (detailsEl) {
        // Open the line's operator and mode groups so scrollIntoView can reach its diagram
        var opGroup = detailsEl.closest('.OpGroupBox');
        if (opGroup) opGroup.open = true;
        var modeGroup = detailsEl.closest('.GroupBox');
        if (modeGroup) modeGroup.open = true;
        detailsEl.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }

    var Ly = LineLayers[I];
    if (Ly) {
        var LyBounds = LineBoundsFor(I, Ly);
        if (LyBounds.isValid()) LMap.fitBounds(LyBounds, Object.assign(LineFitPadding(), {animate: true, duration: 1.2}));
    }
}

function ToggleMode(ModeId) {
    if (DisabledModes.has(ModeId)) {
        DisabledModes.delete(ModeId);
    } else {
        var VisibleModeIds = Object.keys(Modes).filter(M => !DisabledModes.has(M));
        if (VisibleModeIds.length <= 1) return;
        DisabledModes.add(ModeId);
    }

    if (SelectedId) {
        var SelLine = Registry.find(L => L.Id === SelectedId);
        if (SelLine && DisabledModes.has(SelLine.ModeId)) SelectedId = null;
    }

    var groupBox = document.querySelector('.GroupBox[data-mode-group="' + ModeId + '"]');
    if (groupBox) {
        var IsNowOff = DisabledModes.has(ModeId);
        groupBox.classList.toggle('mode-group-off', IsNowOff);
        var sw = groupBox.querySelector('.ModeRowSwitch');
        if (sw) { sw.classList.toggle('active', !IsNowOff); sw.title = (IsNowOff ? 'Show ' : 'Hide ') + Modes[ModeId].Name; }
    }

    Reset();
    RefreshStationListings();
    SyncLinesMasterSwitch();
}

// The sidebar's Lines switch: every mode off, or every mode back on if all are off
function ToggleAllLines() {
    var modeIds = Object.keys(Modes);
    var anyOn = modeIds.some(function(m) { return !DisabledModes.has(m); });
    modeIds.forEach(function(m) { if (anyOn) DisabledModes.add(m); else DisabledModes.delete(m); });
    if (SelectedId && anyOn) SelectedId = null;
    document.querySelectorAll('.GroupBox[data-mode-group]').forEach(function(box) {
        var m = box.getAttribute('data-mode-group');
        var off = DisabledModes.has(m);
        box.classList.toggle('mode-group-off', off);
        var sw = box.querySelector('.ModeRowSwitch');
        if (sw) { sw.classList.toggle('active', !off); sw.title = (off ? 'Show ' : 'Hide ') + Modes[m].Name; }
    });

    Reset();
    RefreshStationListings();
    SyncLinesMasterSwitch();
}

function SyncLinesMasterSwitch() {
    var btn = document.getElementById('LinesToggleButton');
    if (!btn) return;
    var anyOn = Object.keys(Modes).some(function(m) { return !DisabledModes.has(m); });
    btn.classList.toggle('active', anyOn);
    btn.title = anyOn ? 'Hide all lines' : 'Show all lines';
}

// Everything that counts or lists stations follows the mode switches.
function RefreshStationListings() {
    var stationBadge = document.getElementById('StationCountBadge');
    if (stationBadge) stationBadge.textContent = BuildAllStationGroups('').length.toLocaleString();
    RenderStationsPreview();
    var filterInput = document.getElementById('StationBrowseFilterInput');
    if (IsModalOpen('StationBrowse')) RenderStationBrowseModal(filterInput ? filterInput.value : '');
    var omni = document.getElementById('SearchInput');
    if (omni && omni.value.trim()) RenderOmniResults();
    var routeInput = document.getElementById('RouteBrowseFilterInput');
    if (IsModalOpen('RouteBrowse')) RenderRouteBrowseModal(routeInput ? routeInput.value : '');
}

function Reset() {
    SelectedId = null;
    SelectedStationKey = null;
    SelectedStationGroup = [];
    UpdateHeader(null);
    ClearStationMarkers();
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");

    ForEachVisibleLine(function(L, Ly) {
        SetLayerStyle(Ly, {color: L.Color, weight: L.Weight, opacity: 1.0});
        if (Ly.setZIndex) Ly.setZIndex(L.ZIndex);
    });

    HideOtherViewLines();

    RefreshStationDots();
}

function SwitchBasemap(Name) {
    if (!BasemapLayers[Name]) return;
    document.querySelectorAll('.BasemapButton').forEach(B => B.classList.remove('active'));
    var Btn = document.getElementById(Name + 'Button');
    if (Btn) Btn.classList.add('active');
    Object.keys(BasemapLayers).forEach(function(N) {
        if (N === Name) BasemapLayers[N].addTo(LMap);
        else LMap.removeLayer(BasemapLayers[N]);
    });
}

var DEST_CATEGORY_CONFIG = {
    "Airports": {
        icon: '<path d="M21.5 15v-1.5l-8-5V4a1.5 1.5 0 0 0-3 0v4.5l-8 5V15l8-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5L11.5 18v-5.5z" fill="white"/>',
        bg: "#0369a1", border: "#0c4a6e", label: "Airport"
    },
    "Universities": {
        icon: '<path d="M12 4 21 9 12 14 3 9Z" fill="white"/><rect x="8" y="10.3" width="8" height="5.7" rx="1" fill="white"/>',
        bg: "#7c3aed", border: "#4c1d95", label: "University"
    },
    "Venues": {
        icon: '<circle cx="12" cy="12" r="8.5" fill="white"/><path d="M12 8l3.2 2.3-1.2 3.7h-4l-1.2-3.7z" fill="#1e293b"/>',
        bg: "#b45309", border: "#78350f", label: "Venue"
    }
};

var DEST_CATEGORY_FALLBACK = {icon: '<circle cx="12" cy="12" r="3" fill="white"/>', bg: "#374151", border: "#111827"};
var DEST_CATEGORY_KEYWORDS = [
    [/airport/i, "Airports"],
    [/univer|college|campus|institute/i, "Universities"],
    [/venue|stadium|arena|park\b/i, "Venues"]
];

function GetDestCategoryConfig(cat) {
    if (DEST_CATEGORY_CONFIG[cat]) return DEST_CATEGORY_CONFIG[cat];
    var match = DEST_CATEGORY_KEYWORDS.find(function(k) { return k[0].test(cat); });
    var base = match ? DEST_CATEGORY_CONFIG[match[1]] : DEST_CATEGORY_FALLBACK;
    return Object.assign({label: cat}, base);
}

var DestinationsHidden = true;
var ProjectsHidden = true;
var StationDotsHidden = false;

var MARKER_SIZE_PERCENT = 9;
var MARKER_SIZE_MIN_PX = 28;
var MARKER_SIZE_MIN_ZOOM = 9;
var MARKER_SIZE_MAX_ZOOM = 14;
var MARKER_SELECTED_SCALE = 1.25;
var MARKER_BADGE_RATIO = 0.16;
var MARKER_LABEL_MIN_SIZE = 70;
var MARKER_BADGE_MIN_SIZE = 46;
var MARKER_IMAGE_MIN_SIZE = 64;

// Destination pins scale gently with zoom between these sizes
var DEST_PIN_MIN_PX = 28;
var DEST_PIN_MAX_PX = 44;
var DEST_PIN_MIN_ZOOM = 9;
var DEST_PIN_MAX_ZOOM = 14;

function GetDestPinSize() {
    var zoom = LMap ? LMap.getZoom() : DEST_PIN_MAX_ZOOM;
    var t = Math.max(0, Math.min(1, (zoom - DEST_PIN_MIN_ZOOM) / (DEST_PIN_MAX_ZOOM - DEST_PIN_MIN_ZOOM)));
    return Math.round(DEST_PIN_MIN_PX + t * (DEST_PIN_MAX_PX - DEST_PIN_MIN_PX));
}

function GetMarkerMaxSize() {
    var mapEl = LMap && LMap.getContainer ? LMap.getContainer() : null;
    var w = mapEl ? mapEl.clientWidth : window.innerWidth;
    var h = mapEl ? mapEl.clientHeight : window.innerHeight;
    var longest = Math.max(w, h, 1);
    return Math.round(longest * MARKER_SIZE_PERCENT / 100);
}

function GetMarkerBaseSize() {
    var maxSize = GetMarkerMaxSize();
    var zoom = LMap ? LMap.getZoom() : MARKER_SIZE_MAX_ZOOM;
    var t = (zoom - MARKER_SIZE_MIN_ZOOM) / (MARKER_SIZE_MAX_ZOOM - MARKER_SIZE_MIN_ZOOM);
    t = Math.max(0, Math.min(1, t));
    return Math.round(MARKER_SIZE_MIN_PX + t * (maxSize - MARKER_SIZE_MIN_PX));
}

function ForEachDestinationMarker(fn) {
    Object.keys(DestinationMarkers).forEach(function(cat) {
        Object.keys(DestinationMarkers[cat]).forEach(function(name) { fn(cat, name, DestinationMarkers[cat][name]); });
    });
}

// Sets a marker's icon unless it would look the same as the one it has
function SetMarkerIcon(layers, key, make) {
    if (layers.iconKey === key) return;
    layers.iconKey = key;
    layers.marker.setIcon(make());
}

function DestIconKey(selected) {
    return GetDestPinSize() + (selected || (LMap ? LMap.getZoom() : DEST_LABEL_MIN_ZOOM) >= DEST_LABEL_MIN_ZOOM ? 'L' : '') + (selected ? 'S' : '');
}

function RefreshAllMarkerSizes() {
    var pinSize = GetDestPinSize();
    ForEachDestinationMarker(function(cat, name, layers) {
        SetMarkerIcon(layers, DestIconKey(layers.selected), function() { return MakeDestMarkerIcon(cat, name, Destinations[cat][name], layers.selected); });
        var sim = MarkerSim[layers.simId];
        if (sim) sim.radiusPx = (layers.selected ? pinSize * MARKER_SELECTED_SCALE : pinSize) / 2;
    });

    Object.keys(InfoMarkers).forEach(function(key) {
        var layers = InfoMarkers[key], info = InfoPoints[key];
        SetMarkerIcon(layers, GetProjectIconSize(info) + (layers.selected ? 'S' : ''), function() { return MakeProjectMarkerIcon(key, info, layers.selected); });
    });

    ResolveMarkerCollisions();
}

function EscapeHtml(s) {
    return String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

var MarkerSim = {};
var MarkerSimAnimHandle = null;

function RegisterSimMarker(id, trueLatLng, radiusPx, marker) {
    var existing = MarkerSim[id];
    MarkerSim[id] = {
        trueLatLng: trueLatLng,
        dispLatLng: existing ? existing.dispLatLng : trueLatLng,
        targetLatLng: existing ? existing.targetLatLng : trueLatLng,
        radiusPx: radiusPx,
        marker: marker
    };
}

function ResolveMarkerCollisions() {
    if (!LMap) return;
    var ids = Object.keys(MarkerSim).filter(function(id) {
        return MarkerSim[id].marker && LMap.hasLayer(MarkerSim[id].marker);
    });

    if (!ids.length) return;

    var pts = ids.map(function(id) {
        var s = MarkerSim[id];
        var anchor = LMap.latLngToContainerPoint(s.trueLatLng);
        var cur = LMap.latLngToContainerPoint(s.dispLatLng);
        return {id: id, anchor: anchor, x: cur.x, y: cur.y, r: s.radiusPx};
    });

    var COLLISION_SIM_CAP = 150;
    if (pts.length <= 1 || pts.length > COLLISION_SIM_CAP) {
        pts.forEach(function(p) {
            var ll = LMap.containerPointToLatLng([p.anchor.x, p.anchor.y]);
            MarkerSim[p.id].targetLatLng = [ll.lat, ll.lng];
        });

        StartMarkerSimAnimation();
        return;
    }

    var PADDING = 10, SPRING = 0.06, ITER = 60, SETTLE_THRESHOLD = 0.02;
    for (var iter = 0; iter < ITER; iter++) {
        var maxMove = 0;
        for (var i = 0; i < pts.length; i++) {
            var moveX = (pts[i].anchor.x - pts[i].x) * SPRING;
            var moveY = (pts[i].anchor.y - pts[i].y) * SPRING;
            pts[i].x += moveX;
            pts[i].y += moveY;
            maxMove = Math.max(maxMove, Math.abs(moveX), Math.abs(moveY));
        }

        for (var a = 0; a < pts.length; a++) {
            for (var b = a + 1; b < pts.length; b++) {
                var dx = pts[b].x - pts[a].x, dy = pts[b].y - pts[a].y;
                var dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
                var minDist = pts[a].r + pts[b].r + PADDING;
                if (dist < minDist) {
                    var overlap = (minDist - dist) / 2;
                    var ux = dx / dist, uy = dy / dist;
                    pts[a].x -= ux * overlap; pts[a].y -= uy * overlap;
                    pts[b].x += ux * overlap; pts[b].y += uy * overlap;
                    maxMove = Math.max(maxMove, Math.abs(ux * overlap), Math.abs(uy * overlap));
                }
            }
        }

        if (maxMove < SETTLE_THRESHOLD) break;
    }

    pts.forEach(function(p) {
        var ll = LMap.containerPointToLatLng([p.x, p.y]);
        MarkerSim[p.id].targetLatLng = [ll.lat, ll.lng];
    });

    StartMarkerSimAnimation();
}

function StartMarkerSimAnimation() {
    if (MarkerSimAnimHandle) return;
    var EASE = 0.22;
    function Step() {
        var stillMoving = false;
        Object.keys(MarkerSim).forEach(function(id) {
            var s = MarkerSim[id];
            if (!s.marker || !LMap.hasLayer(s.marker)) return;
            var dLat = s.targetLatLng[0] - s.dispLatLng[0];
            var dLng = s.targetLatLng[1] - s.dispLatLng[1];
            if (Math.abs(dLat) < 1e-7 && Math.abs(dLng) < 1e-7) return;
            s.dispLatLng = [s.dispLatLng[0] + dLat * EASE, s.dispLatLng[1] + dLng * EASE];
            s.marker.setLatLng(s.dispLatLng);
            stillMoving = true;
        });

        MarkerSimAnimHandle = stillMoving ? requestAnimationFrame(Step) : null;
    }

    MarkerSimAnimHandle = requestAnimationFrame(Step);
}

// Destination pins are pills: category icon plus name, tip on the location; just the icon when zoomed out
var DEST_LABEL_MIN_ZOOM = 12;

function MakeDestMarkerIcon(cat, name, dest, selected) {
    var c = GetDestCategoryConfig(cat);
    var S = GetDestPinSize();
    if (selected) S = Math.round(S * MARKER_SELECTED_SCALE);
    var zoom = LMap ? LMap.getZoom() : DEST_LABEL_MIN_ZOOM;
    var showLabel = selected || zoom >= DEST_LABEL_MIN_ZOOM;
    var html =
        '<div class="DestPin' + (selected ? ' selected' : '') + (showLabel ? ' labeled' : '') + '" style="--c:' + c.bg + ';--s:' + S + 'px">' +
            '<div class="DestPinBody">' +
                '<span class="DestPinIcon"><svg viewBox="0 0 24 24">' + c.icon + '</svg></span>' +
                (showLabel ? '<span class="DestPinLabel">' + EscapeHtml(name) + '</span>' : '') +
            '</div>' +
            '<span class="DestPinTail"></span>' +
        '</div>';
    return L.divIcon({html: html, className: 'DestMarkerIcon', iconSize: [0, 0], iconAnchor: [0, 0]});
}

function BuildDestinationMarker(cat, name, dest) {
    var c = GetDestCategoryConfig(cat);
    var trueLatLng = [dest.Location[0], dest.Location[1]];
    return BuildPinMarker('dest:' + cat + '|' + name, trueLatLng, MakeDestMarkerIcon(cat, name, dest, false),
        name + ' · ' + c.label, c.bg, function() { ShowDestinationPopup(cat, name); }, GetDestPinSize());
}

// Shared final assembly step for project marker icons (still the photo-circle style)
function WrapMarkerIcon(size, photoHtml, badgeHtml, labelHtml, minWidth, labelExtra, className) {
    var w = Math.max(size, minWidth);
    var totalHeight = labelHtml ? size + labelExtra : size;
    var html =
        '<div style="position:relative;width:' + size + 'px;height:' + size + 'px;cursor:pointer;margin:0 auto;">' + photoHtml + badgeHtml + '</div>' +
        (labelHtml ? '<div style="display:flex;justify-content:center;margin-top:6px;">' + labelHtml + '</div>' : '');
    return L.divIcon({html: html, className: className, iconSize: [w, totalHeight], iconAnchor: [w / 2, size / 2]});
}

// Real ground radius (km) of a project's circle per size code
var PROJECT_RADIUS_KM = {S: 0.2, M: 1.0, L: 5.0, X: 10.0};

// Project icon scale per size code
var PROJECT_ICON_SCALE_BY_RADIUS = {S: 0.8, M: 1.0, L: 1.25, X: 1.5};

// Zoom at which each project size code appears; projects are not pushed aside by the collision sim
var PROJECT_MIN_ZOOM_BY_RADIUS = {X: 4, L: 7, M: 9, S: 12};

function GetProjectIconSize(info) {
    return GetMarkerBaseSize() * (PROJECT_ICON_SCALE_BY_RADIUS[info.Radius] || 1.0);
}

function BuildPinMarker(id, trueLatLng, icon, tooltipText, dotColor, onClick, baseSize) {
    var marker = L.marker(trueLatLng, {icon: icon, zIndexOffset: 500, pane: 'destMarkerPane'});
    marker.on('click', function(e) { L.DomEvent.stopPropagation(e); onClick(); });
    marker.bindTooltip(tooltipText, {direction: 'top', offset: [0, -baseSize / 2], className: 'ProjectTooltip', sticky: false, pane: 'hoverTooltipPane'});
    var dot = L.circleMarker(trueLatLng, {radius: 5, color: '#fff', weight: 2, fillColor: dotColor, fillOpacity: 1, className: 'MarkerTrueDot', interactive: false});
    RegisterSimMarker(id, trueLatLng, baseSize / 2, marker);
    return {marker: marker, dot: dot, simId: id, selected: false};
}

// Applies a (de)selection to a destination/project marker's icon and collision radius
function ApplyMarkerSelection(layers, icon, selected, baseSize, iconKey) {
    layers.selected = selected;
    layers.iconKey = iconKey;
    layers.marker.setIcon(icon);
    var sim = MarkerSim[layers.simId];
    if (sim) sim.radiusPx = (selected ? baseSize * MARKER_SELECTED_SCALE : baseSize) / 2;
    ResolveMarkerCollisions();
}

function AddMarkerLayers(layers) {
    if (layers.circle) layers.circle.addTo(LMap);
    layers.dot.addTo(LMap);
    layers.marker.addTo(LMap);
}

function RemoveMarkerLayers(layers) {
    if (LMap.hasLayer(layers.marker)) LMap.removeLayer(layers.marker);
    if (LMap.hasLayer(layers.dot)) LMap.removeLayer(layers.dot);
    if (layers.circle && LMap.hasLayer(layers.circle)) LMap.removeLayer(layers.circle);
}

function SetDestinationSelected(cat, name, selected) {
    var layers = DestinationMarkers[cat] && DestinationMarkers[cat][name];
    if (!layers) return;
    ApplyMarkerSelection(layers, MakeDestMarkerIcon(cat, name, Destinations[cat][name], selected), selected, GetDestPinSize(), DestIconKey(selected));
}

function RenderDestinationMarkers() {
    ClearDestinationMarkers();
    Object.keys(Destinations).forEach(function(cat) {
        Object.keys(Destinations[cat]).forEach(function(name) {
            var dest = Destinations[cat][name];
            var layers = BuildDestinationMarker(cat, name, dest);
            layers.iconKey = DestIconKey(false);
            if (!DestinationMarkers[cat]) DestinationMarkers[cat] = {};
            DestinationMarkers[cat][name] = layers;
        });
    });

    UpdateDestinationMarkersVisibility();
}

function ClearDestinationMarkers() {
    ForEachDestinationMarker(function(cat, name, layers) {
        RemoveMarkerLayers(layers);
        delete MarkerSim['dest:' + cat + '|' + name];
    });

    DestinationMarkers = {};
}

// The stations serving a destination on the map being shown (the detailed map keeps one list per map; the simplified map has just one).
function DestStationList(dest) {
    if (dest.StationsByMode) return dest.StationsByMode[CurrentMapMode] || [];
    return dest.Stations || [];
}

function DestExists(dest, mode) {
    if (Array.isArray(dest.Exists)) return dest.Exists.includes(mode);
    return !!dest[mode];
}

var IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
var DEST_IMAGE_BASE = 'data/images/destinations';
var PROJECT_IMAGE_BASE = 'data/images/projects';
var SPORTS_IMAGE_BASE = 'data/images/sports';
var FLAG_IMAGE_BASE = 'data/images/flags';

// The 23 sovereign states of North America, clockwise around the splash ring; codes name the flag files
var NORTH_AMERICA_FLAG_CODES = [
    'ATG', 'BHS', 'BLZ', 'BRB', 'CAN', 'CRI', 'CUB', 'DMA',
    'DOM', 'GRD', 'GTM', 'HND', 'HTI', 'JAM', 'KNA', 'LCA',
    'MEX', 'NIC', 'PAN', 'SLV', 'TTO', 'USA', 'VCT'
];

// Wraps each flag around the ring as rotated vertical strips, each wedge clipped to its own sector
var FlagWedges = {};      // country code -> <div class="FlagWedge">
var FLAG_POP_DISTANCE = 16;   // ring units (720 viewBox) a hovered flag moves outward

// Each wedge is its own layer so popping one out is a cheap GPU transform
function BuildFlagRing() {
    var host = document.getElementById('FlagRing');
    if (!host) return;

    var SIZE = 720;
    var cx = SIZE / 2, cy = SIZE / 2;
    var rOuter = SIZE / 2 - 4;
    var rInner = rOuter * 0.83;
    var rMid = (rOuter + rInner) / 2;
    var count = NORTH_AMERICA_FLAG_CODES.length;
    var wedgeDeg = 360 / count;
    var SLICES = 10;
    var PAD = 34;   // room around a wedge for its glow and outline
    var rad = Math.PI / 180;
    var pct = function(v) { return (v / SIZE * 100).toFixed(4) + '%'; };

    function xy(r, deg) { return [cx + r * Math.sin(deg * rad), cy - r * Math.cos(deg * rad)]; }
    function pt(r, deg) { var p = xy(r, deg); return p[0].toFixed(2) + ' ' + p[1].toFixed(2); }

    var base = ['<svg class="FlagRingBase" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" aria-hidden="true">',
        '<defs><filter id="FlagGlowBlur" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="9"></feGaussianBlur></filter></defs>',
        '<circle class="FlagWedgeArcs" cx="' + cx + '" cy="' + cy + '" r="' + rOuter + '"></circle>',
        '<circle class="FlagWedgeArcs" cx="' + cx + '" cy="' + cy + '" r="' + rInner + '"></circle>'];
    var wedges = [];
    var hits = ['<svg id="FlagRingSvg" class="FlagRingHits" viewBox="0 0 ' + SIZE + ' ' + SIZE + '" aria-hidden="true"><g id="FlagHitLayer">'];

    NORTH_AMERICA_FLAG_CODES.forEach(function(code, k) {
        var a0 = k * wedgeDeg, a1 = a0 + wedgeDeg, aMid = a0 + wedgeDeg / 2;
        var href = FLAG_IMAGE_BASE + '/' + encodeURIComponent(code) + '.webp';
        var large = wedgeDeg > 180 ? 1 : 0;
        var sector =
            'M' + pt(rOuter, a0) + ' A' + rOuter + ' ' + rOuter + ' 0 ' + large + ' 1 ' + pt(rOuter, a1) +
            ' L' + pt(rInner, a1) + ' A' + rInner + ' ' + rInner + ' 0 ' + large + ' 0 ' + pt(rInner, a0) + ' Z';
        var arcs =
            'M' + pt(rOuter, a0) + ' A' + rOuter + ' ' + rOuter + ' 0 ' + large + ' 1 ' + pt(rOuter, a1) +
            ' M' + pt(rInner, a1) + ' A' + rInner + ' ' + rInner + ' 0 ' + large + ' 0 ' + pt(rInner, a0);
        var sides = 'M' + pt(rInner, a0) + ' L' + pt(rOuter, a0) + ' M' + pt(rInner, a1) + ' L' + pt(rOuter, a1);

        base.push('<line class="FlagWedgeDivider" x1="' + pt(rInner, a0).replace(' ', '" y1="') + '" x2="' + pt(rOuter, a0).replace(' ', '" y2="') + '"></line>');
        hits.push('<path class="FlagHit" data-code="' + code + '" d="' + sector + '"></path>');

        // This wedge's bounding box (sampled along both arcs), padded.
        var xs = [], ys = [];
        for (var j = 0; j <= 8; j++) {
            var a = a0 + (a1 - a0) * j / 8;
            [rOuter, rInner].forEach(function(r) { var p = xy(r, a); xs.push(p[0]); ys.push(p[1]); });
        }

        var x0 = Math.min.apply(null, xs) - PAD, y0 = Math.min.apply(null, ys) - PAD;
        var w = Math.max.apply(null, xs) + PAD - x0, h = Math.max.apply(null, ys) + PAD - y0;
        var origin = xy(rMid, aMid);

        var vb = 'viewBox="' + x0.toFixed(2) + ' ' + y0.toFixed(2) + ' ' + w.toFixed(2) + ' ' + h.toFixed(2) + '"';
        // The glow is a separate layer so fading it in doesn't re-render the blurred flag
        var glow = '<svg class="FlagWedgeGlowLayer" ' + vb + '><path class="FlagWedgeGlow" d="' + sector + '" filter="url(#FlagGlowBlur)"></path></svg>';
        var svg = ['<svg class="FlagWedgeFlag" ' + vb + '>',
            '<clipPath id="FlagClip' + k + '"><path d="' + sector + '"></path></clipPath>',
            '<g clip-path="url(#FlagClip' + k + ')">'];
        for (var i = 0; i < SLICES; i++) {
            var s0 = a0 + (i / SLICES) * wedgeDeg;
            var s1 = a0 + ((i + 1) / SLICES) * wedgeDeg;
            var mid = (s0 + s1) / 2;
            // Chord across this slice at mid-ring, padded 12% so neighbouring slices overlap without gaps
            var chord = 2 * rMid * Math.sin(((s1 - s0) * rad) / 2) * 1.12;
            svg.push(
                '<g transform="translate(' + cx + ',' + cy + ') rotate(' + mid.toFixed(3) + ')">' +
                    '<svg x="' + (-chord / 2).toFixed(3) + '" y="' + (-rOuter).toFixed(3) +
                        '" width="' + chord.toFixed(3) + '" height="' + (rOuter - rInner).toFixed(3) +
                        '" viewBox="' + (i * 100 / SLICES).toFixed(3) + ' 0 ' + (100 / SLICES).toFixed(3) + ' 100" preserveAspectRatio="none">' +
                        '<image href="' + href + '" x="0" y="0" width="100" height="100" preserveAspectRatio="none"></image>' +
                    '</svg>' +
                '</g>'
            );
        }

        svg.push('</g>',
            '<path class="FlagWedgeArcs" d="' + arcs + '"></path>',
            '<path class="FlagWedgeSides" d="' + sides + '"></path>',
            '</svg>');

        wedges.push(
            '<div class="FlagWedge" data-code="' + code + '" style="' +
                'left:' + pct(x0) + ';top:' + pct(y0) + ';width:' + pct(w) + ';height:' + pct(h) + ';' +
                '--pop-x:' + (FLAG_POP_DISTANCE * Math.sin(aMid * rad) / SIZE).toFixed(5) + ';' +
                '--pop-y:' + (-FLAG_POP_DISTANCE * Math.cos(aMid * rad) / SIZE).toFixed(5) + ';' +
                'transform-origin:' + ((origin[0] - x0) / w * 100).toFixed(2) + '% ' + ((origin[1] - y0) / h * 100).toFixed(2) + '%">' +
                glow + svg.join('') +
            '</div>'
        );
    });

    base.push('</svg>');
    hits.push('</g></svg>');
    host.innerHTML = base.join('') + wedges.join('') + hits.join('');

    host.querySelectorAll('.FlagWedge').forEach(function(el) {
        FlagWedges[el.getAttribute('data-code')] = el;
    });
}

// Ring sheen: a CSS-animated highlight sweeping round the flag band

function BuildRingEffects() {
    var ring = document.getElementById('FlagRing');
    if (!ring) return;
    var sheen = document.createElement('div');
    sheen.id = 'FlagRingSheen';
    sheen.setAttribute('aria-hidden', 'true');
    ring.insertBefore(sheen, ring.querySelector('.FlagRingHits'));
}

// View title: the pill naming the country or subdivision being viewed, doubling as the back button

function SetViewFlag(img, code) {
    if (!img) return;
    if (code) {
        var src = FLAG_IMAGE_BASE + '/' + encodeURIComponent(code) + '.webp';
        if (img.getAttribute('src') !== src) img.setAttribute('src', src);
        img.style.display = '';
    } else {
        img.style.display = 'none';
    }
}

function UpdateSplashViewTitle() {
    var code = SplashFocusCode;
    if (!code || !SplashData) return;   // hidden with the country view; keep the last text while it fades
    var country = SplashData.Countries[code];
    var sub = SplashSubZoom && SplashSubZoom.code === code ? country.Subs[SplashSubZoom.index] : null;
    var title = document.getElementById('SplashViewTitleText');
    var subtitle = document.getElementById('SplashViewSubtitleText');
    var back = document.getElementById('SplashBack');
    if (sub) {
        title.textContent = sub.Name;
        SetViewFlag(document.getElementById('SplashViewTitleFlag'), null);
        subtitle.textContent = country.Name;
        SetViewFlag(document.getElementById('SplashViewSubtitleFlag'), code);
        back.classList.add('two-line');
        back.setAttribute('aria-label', 'Back to ' + country.Name);
    } else {
        title.textContent = country.Name;
        SetViewFlag(document.getElementById('SplashViewTitleFlag'), code);
        back.classList.remove('two-line');
        back.setAttribute('aria-label', 'Back to North America');
    }

    back.setAttribute('title', back.getAttribute('aria-label'));
}

// Splash map: countries from data/regions, pre-projected at build time; click a country to zoom into its subdivisions

var SplashData = null;
var SplashContentEl = null;              // #SplashContent: state classes (focused / settled / isolated) live here
var SplashSvg = null, SplashLand = null, SplashSubLayer = null;   // invisible pointer targets
var SplashCountryEls = {};               // code -> [path, optional island hit circle]
var SplashHits = { country: [], sub: [] };   // [{key, x, y}] for nearest-centre resolution
var SplashHoverCode = null;              // hovered country (continent view)
var SplashSubHover = null;               // hovered subdivision index (country view)
var SplashFocusCode = null;              // country currently zoomed into
var SplashFlagHover = null;              // flag under the pointer on the ring
var SplashFlagClicked = null;            // flag just clicked (not re-popped until the pointer leaves it)
var SplashSubZoom = null;                // {code, index, s, fx, fy, isolated} while zoomed onto one subdivision
var SplashStationFocus = false;          // current zoom was driven by the selected station
var SplashVenueForTeam = false;          // the place panel being opened is a team's venue (no globe dot)
var SPLASH_SUB_ZOOM_MS = 650;
var SPLASH_SUB_ZOOM_RADIUS = 330;        // station's subdivision (neighbours visible) framed to about this radius (of 500)
var SPLASH_ISOLATE_RADIUS = 410;         // a clicked subdivision, shown on its own, fills a bit more
var SplashZoomToken = 0;                 // invalidates in-flight animations
var SplashZoomFrame = null;
var SPLASH_ZOOM_MS = 900;

// Everything in the disc is drawn on one canvas; an invisible svg on top holds the pointer targets

var Scene = {
    canvas: null, ctx: null, dpr: 1,
    countries: [],                // [{code, path: Path2D}] continent view
    continentLines: null,         // line set, continent coordinates
    subs: [],                     // [{path, fine}] focused country's subdivisions
    countryLines: null,           // line set, focused country's coordinates
    land: [1, 0, 0, 1, 0, 0],     // transform of the continent layer   (canvas-style a b c d e f)
    sub:  [1, 0, 0, 1, 0, 0],     // transform of the subdivision layer (may include rotation)
    focusOutline: null,           // Path2D: focused country, continent coords (masks its lines)
    countryOutline: null,         // Path2D: all its subdivisions, country coords (masks country lines)
    selected: null,               // subdivision index with the heavy outline (station)
    isolated: null,               // subdivision index shown on its own
    dot: null,                    // [x, y] station dot, subdivision coordinates
    anim: {},                     // key -> [current, target]
    style: {},
    frame: null, last: 0
};

var SPLASH_COLORS = { land: '#ffffff', hover: '#0f172a', border: '#8a9bb3', selected: '#0f172a' };

// Eased values. A missing key starts at `initial` (default 0).
function A(key, initial) {
    var a = Scene.anim[key];
    return a ? a[0] : (initial === undefined ? 0 : initial);
}

function AnimTo(key, target, initial) {
    var a = Scene.anim[key];
    if (!a) {
        Scene.anim[key] = [initial === undefined ? target : initial, target];
    } else {
        if (a[1] === target) return;
        a[1] = target;
    }

    RequestSplashDraw();
}

function AnimSnap(key, value) {
    Scene.anim[key] = [value, value];
}

// Hover highlights ease quickly, fades a little slower.
function AnimRate(key) { return key.charAt(1) === ':' && (key.charAt(0) === 'h' || key.charAt(0) === 's') ? 55 : 110; }

function RequestSplashDraw() {
    if (Scene.frame === null && Scene.ctx) Scene.frame = requestAnimationFrame(SceneFrame);
}

function SceneFrame(now) {
    Scene.frame = null;
    if (StepScene(now)) RequestSplashDraw();
    else Scene.last = 0;
}

// Advances the eased values one frame and redraws. True while anything moves.
function StepScene(now) {
    var dt = Scene.last ? Math.min(64, now - Scene.last) : 16;
    Scene.last = now;
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var moving = false;
    Object.keys(Scene.anim).forEach(function(key) {
        var a = Scene.anim[key];
        if (a[0] === a[1]) return;
        a[0] += (a[1] - a[0]) * (reduce ? 1 : 1 - Math.exp(-dt / AnimRate(key)));
        if (Math.abs(a[1] - a[0]) < 0.004) a[0] = a[1];
        else moving = true;
    });

    DrawSplash();
    return moving;
}

function MixColor(a, b, t) {
    if (t <= 0) return a;
    if (t >= 1) return b;
    var pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    var r = Math.round(((pa >> 16) & 255) * (1 - t) + ((pb >> 16) & 255) * t);
    var g = Math.round(((pa >> 8) & 255) * (1 - t) + ((pb >> 8) & 255) * t);
    var bl = Math.round((pa & 255) * (1 - t) + (pb & 255) * t);
    return 'rgb(' + r + ',' + g + ',' + bl + ')';
}

function MatrixScale(m) { return Math.hypot(m[0], m[1]); }

// Canvas transform for a layer matrix, in canvas pixels.
function ApplyLayer(m, base) {
    Scene.ctx.setTransform(base * m[0], base * m[1], base * m[2], base * m[3], base * m[4], base * m[5]);
}

function DrawSplash() {
    var ctx = Scene.ctx;
    if (!ctx) return;
    var c = Scene.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    var base = c.width / (SplashData.Size || 1000);
    var px = Scene.dpr;   // one CSS pixel, in canvas pixels
    ctx.lineJoin = 'round';

    // Continent layer
    var cont = A('cont', 1);
    if (cont > 0.003) {
        var m = Scene.land, k = base * MatrixScale(m);
        var countryAlpha = function(code) { return code === '_' ? 1 - A('focused') : A('c:' + code, 1); };
        ApplyLayer(m, base);
        Scene.countries.forEach(function(cn) {
            var a = cont * countryAlpha(cn.code);
            if (a < 0.003) return;
            ctx.globalAlpha = a;
            ctx.fillStyle = MixColor(SPLASH_COLORS.land, SPLASH_COLORS.hover, A('h:' + cn.code));
            ctx.fill(cn.path, 'evenodd');
        });

        // '+CODE' groups are lines crossing into CODE, drawn only while it is focused so lines reach its border
        DrawLineSet(Scene.continentLines, m, cont, function(key) {
            if (key.charAt(0) === '+') return key.slice(1) === SplashFocusCode ? A('c:' + SplashFocusCode, 1) : 0;
            return countryAlpha(key);
        }, base, function(key) {
            var region = key.charAt(0) === '+' ? key.slice(1) : key;
            return region === SplashFocusCode ? Scene.focusOutline : null;
        });

        ApplyLayer(m, base);
        ctx.strokeStyle = SPLASH_COLORS.border;
        ctx.lineWidth = 1.1 * px / k;
        Scene.countries.forEach(function(cn) {
            var a = cont * countryAlpha(cn.code);
            if (a < 0.003) return;
            ctx.globalAlpha = a;
            ctx.stroke(cn.path);
        });

        // Rings around hovered island nations (their round pointer targets).
        DrawHitRings(SplashHits.country, 'h:', cont * (1 - A('focused')), base, IDENTITY);
        // Teams of leagues on the map; they fade with their country.
        DrawSplashTeams(Scene.teams && Scene.teams.continent, m, function(pt) {
            return cont * (pt.code ? A('c:' + pt.code, 1) : 1 - A('focused'));
        }, base, 6 * Scene.style.lineScale);
    }

    // Subdivision layer
    var subA = A('sub');
    if (subA > 0.003 && Scene.subs.length) {
        var n = Scene.sub, ks = base * MatrixScale(n);
        var subAlpha = function(i) { return Scene.isolated === null || Scene.isolated === +i ? 1 : A('iso'); };
        var subPath = function(i) { return (Scene.isolated === i && Scene.subs[i].fine) || Scene.subs[i].path; };
        ApplyLayer(n, base);
        Scene.subs.forEach(function(sb, i) {
            var a = subA * subAlpha(i);
            if (a < 0.003) return;
            ctx.globalAlpha = a;
            ctx.fillStyle = MixColor(SPLASH_COLORS.land, SPLASH_COLORS.hover, A('s:' + i));
            ctx.fill(subPath(i), 'evenodd');
        });

        // '+i' groups are lines crossing into subdivision i, drawn only while it is isolated
        DrawLineSet(Scene.countryLines, n, subA, function(key) {
            if (key.charAt(0) === '+') return Scene.isolated !== null && +key.slice(1) === Scene.isolated ? 1 : 0;
            return subAlpha(key);
        }, base, function(key) {
            var region = key.charAt(0) === '+' ? +key.slice(1) : +key;
            return Scene.isolated !== null && region === Scene.isolated ? subPath(Scene.isolated) : Scene.countryOutline;
        });

        ApplyLayer(n, base);
        ctx.strokeStyle = SPLASH_COLORS.border;
        ctx.lineWidth = 1.1 * px / ks;
        Scene.subs.forEach(function(sb, i) {
            var a = subA * subAlpha(i);
            if (a < 0.003) return;
            ctx.globalAlpha = a;
            ctx.stroke(subPath(i));
        });

        if (Scene.selected !== null && Scene.subs[Scene.selected]) {
            ctx.globalAlpha = subA;
            ctx.strokeStyle = SPLASH_COLORS.selected;
            ctx.lineWidth = 2.6 * px / ks;
            ctx.stroke(subPath(Scene.selected));
        }

        DrawHitRings(SplashHits.sub, 's:', subA * (1 - A('iso')), base, n);
        DrawSplashTeams(Scene.teams && Scene.teams.country, n, function(pt) {
            return subA * (Scene.isolated === null || Scene.isolated === pt.sub ? 1 : A('iso'));
        }, base, (Scene.isolated !== null ? 11 : 8.5) * Scene.style.lineScale);

        if (Scene.dot) {
            // Screen-space dot: white ring, dark core.
            var dx = base * (n[0] * Scene.dot[0] + n[2] * Scene.dot[1] + n[4]);
            var dy = base * (n[1] * Scene.dot[0] + n[3] * Scene.dot[1] + n[5]);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalAlpha = subA;
            ctx.beginPath(); ctx.arc(dx, dy, 6.5 * px, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
            ctx.beginPath(); ctx.arc(dx, dy, 4 * px, 0, Math.PI * 2); ctx.fillStyle = SPLASH_COLORS.selected; ctx.fill();
        }
    }

    ctx.globalAlpha = 1;
}

function DrawHitRings(hits, prefix, alpha, base, m) {
    if (alpha < 0.003) return;
    var ctx = Scene.ctx;
    var sc = MatrixScale(m);
    hits.forEach(function(h) {
        var a = A(prefix + h.key);
        if (a < 0.01) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = alpha * a * 0.85;
        ctx.strokeStyle = SPLASH_COLORS.selected;
        ctx.lineWidth = 1.6 * Scene.dpr;
        ctx.beginPath();
        ctx.arc(base * (m[0] * h.x + m[2] * h.y + m[4]), base * (m[1] * h.x + m[3] * h.y + m[5]), base * sc * h.r, 0, Math.PI * 2);
        ctx.stroke();
    });
}

// Lines grouped by region, each fading with its region and clipped to clipFor(key) when that gives an outline
function DrawLineSet(set, m, alpha, regionAlpha, base, clipFor) {
    if (!set) return;
    var ctx = Scene.ctx;
    var k = base * MatrixScale(m);
    ['Fantasy', 'Present'].forEach(function(category) {
        var catA = alpha * A(category);
        if (catA < 0.003 || !set[category]) return;
        var batches = [];   // [{clip, keys}]
        Object.keys(set[category]).forEach(function(key) {
            if (catA * regionAlpha(key) < 0.003) return;
            var clip = clipFor ? clipFor(key) : null;
            var batch = batches.filter(function(bt) { return bt.clip === clip; })[0];
            if (!batch) batches.push(batch = { clip: clip, keys: [] });
            batch.keys.push(key);
        });

        batches.forEach(function(batch) {
            ctx.save();
            ApplyLayer(m, base);
            if (batch.clip) ctx.clip(batch.clip, 'nonzero');
            ctx.strokeStyle = Scene.style.lineColor;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            batch.keys.forEach(function(key) {
                ctx.globalAlpha = catA * regionAlpha(key) * Scene.style.lineAlpha;
                set[category][key].forEach(function(group) {
                    // Widths are screen px, whatever the zoom.
                    ctx.lineWidth = group.w * Scene.style.lineScale * 0.8 * Scene.dpr / k;
                    for (var i = 0; i < group.paths.length; i++) ctx.stroke(group.paths[i]);
                });
            });

            ctx.restore();
        });
    });
}

// {Fantasy: {region: [{w, paths}]}, Present: ...} from the build's path strings, one Path2D per stretch
function BuildLineSet(lines) {
    var modes = SplashData.LineModes || {};
    var set = {};
    ['Fantasy', 'Present'].forEach(function(category) {
        var byRegion = lines && lines[category];
        if (!byRegion) return;
        set[category] = {};
        Object.keys(byRegion).forEach(function(key) {
            var byMode = byRegion[key];
            set[category][key] = Object.keys(modes).filter(function(m) { return byMode[m]; }).map(function(m) {
                return { w: modes[m][1], paths: byMode[m].split(/(?=M)/).map(function(d) { return new Path2D(d); }) };
            });
        });
    });

    return set;
}

// Line colour, alpha and width scale come from CSS custom properties so they stay tweakable in styles.css
function RefreshSplashStyle() {
    if (!SplashContentEl) return;
    var cs = getComputedStyle(SplashContentEl);
    Scene.style.lineColor = cs.getPropertyValue('--line-color').trim() || '#475569';
    Scene.style.lineAlpha = parseFloat(cs.getPropertyValue('--line-alpha')) || 0.22;
    Scene.style.lineScale = parseFloat(cs.getPropertyValue('--line-scale')) || 1;
    RequestSplashDraw();
}

function ResizeSplashCanvas() {
    var c = Scene.canvas;
    if (!c) return;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    var w = Math.max(1, Math.round(c.clientWidth * dpr));
    if (c.width !== w || c.height !== w) { c.width = w; c.height = w; }
    Scene.dpr = dpr;
    RefreshSplashStyle();
    DrawSplash();
}

// The splash shows the Future Vision; once docked the globe follows the map's view switch
function SetSplashLineMode(mode) {
    AnimTo('Fantasy', mode === 'Fantasy' ? 1 : 0);
    AnimTo('Present', mode === 'Present' ? 1 : 0);
    var f = document.getElementById('GlobeModeFantasy');
    var p = document.getElementById('GlobeModePresent');
    if (f) f.classList.toggle('active', mode === 'Fantasy');
    if (p) p.classList.toggle('active', mode === 'Present');
}

var IDENTITY = [1, 0, 0, 1, 0, 0];

// Moves a layer to matrix m; pointer targets follow except mid-animation
function SetSplashLayer(which, m, moveTargets) {
    Scene[which] = m;
    if (moveTargets !== false) {
        var el = which === 'land' ? SplashLand : SplashSubLayer;
        if (m.join(' ') === '1 0 0 1 0 0') el.removeAttribute('transform');
        else el.setAttribute('transform', 'matrix(' + m.join(' ') + ')');
    }

    RequestSplashDraw();
}

// State classes drive the pointer targets via CSS; drawing follows through eased values
function SetSplashState(name, on) {
    SplashContentEl.classList.toggle(name, on);
    if (name === 'focused') AnimTo('focused', on ? 1 : 0, 0);
}

function BuildSplashMap() {
    var host = document.getElementById('SplashContent');
    SplashData = (typeof SplashRegions !== 'undefined') ? SplashRegions : null;
    if (!host || !SplashData || !SplashData.Countries) return;
    SplashContentEl = host;

    var size = SplashData.Size || 1000;
    var out = [];
    out.push('<canvas id="SplashCanvas" class="SplashLayer" aria-hidden="true"></canvas>');
    out.push('<svg id="SplashMapSvg" class="SplashLayer" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="Map of North America">');
    out.push('<g id="SplashLand">');
    Object.keys(SplashData.Countries).forEach(function(code) {
        out.push('<path class="SplashCountry" data-code="' + code + '" d="' + SplashData.Countries[code].D + '"></path>');
    });

    out.push('</g>');
    // Island nations too small to point at get an invisible round target
    out.push('<g id="SplashIslandHitLayer">');
    Object.keys(SplashData.Countries).forEach(function(code) {
        var hit = SplashData.Countries[code].Hit;
        if (!hit) return;
        SplashHits.country.push({ key: code, x: hit[0], y: hit[1], r: hit[2] });
        out.push('<circle class="SplashHit" data-code="' + code + '" cx="' + hit[0] + '" cy="' + hit[1] + '" r="' + hit[2] + '"></circle>');
    });

    out.push('</g>');
    out.push('<g id="SplashSubLayer"></g>');
    out.push('</svg>');

    host.innerHTML = out.join('');
    SplashSvg = document.getElementById('SplashMapSvg');
    SplashLand = document.getElementById('SplashLand');
    SplashSubLayer = document.getElementById('SplashSubLayer');
    SplashSvg.querySelectorAll('[data-code]').forEach(function(el) {
        var code = el.getAttribute('data-code');
        (SplashCountryEls[code] = SplashCountryEls[code] || []).push(el);
    });

    Scene.canvas = document.getElementById('SplashCanvas');
    Scene.ctx = Scene.canvas.getContext('2d');
    Scene.countries = Object.keys(SplashData.Countries).map(function(code) {
        return { code: code, path: new Path2D(SplashData.Countries[code].D) };
    });

    Scene.continentLines = BuildLineSet(SplashData.Lines);
    AnimSnap('Fantasy', 1);
    AnimSnap('Present', 0);
    if (window.ResizeObserver) new ResizeObserver(ResizeSplashCanvas).observe(Scene.canvas);
    ResizeSplashCanvas();

    // Pointer moves are handled at most once per frame.
    var pending = null;
    function handle(e) {
        PositionSplashLabel(e);
        var t = ResolveSplashTarget(e);
        if (SplashFocusCode) SetSplashSubHover(t && t.kind === 'sub' ? t.key : null);
        else SetSplashHover(t && t.kind === 'country' ? t.key : null);
    }

    SplashSvg.addEventListener('pointermove', function(e) {
        if (!pending) requestAnimationFrame(function() { var ev = pending; pending = null; if (ev) handle(ev); });
        pending = e;
    });

    SplashSvg.addEventListener('pointerdown', handle);   // taps on touch screens: right away
    SplashSvg.addEventListener('pointerleave', function(e) {
        pending = null;
        // A finger "leaves" as soon as it lifts; keep a tapped name showing.
        if (e.pointerType === 'touch') return;
        SetSplashHover(null);
        SetSplashSubHover(null);
    });
}

// The country or subdivision under the pointer; overlapping round targets go to the nearest centre
function ResolveSplashTarget(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return null;
    var kind = t.hasAttribute('data-sub') ? 'sub' : (t.hasAttribute('data-code') ? 'country' : null);
    if (!kind) return null;
    var key = kind === 'sub' ? +t.getAttribute('data-sub') : t.getAttribute('data-code');
    if (!t.classList.contains('SplashHit')) return { kind: kind, key: key };

    // Subdivision targets live in the (possibly zoomed) subdivision layer.
    var ctm = (kind === 'sub' ? SplashSubLayer : SplashSvg).getScreenCTM();
    if (!ctm) return { kind: kind, key: key };
    var p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    var best = key, bestD = Infinity;
    SplashHits[kind].forEach(function(h) {
        var d = (h.x - p.x) * (h.x - p.x) + (h.y - p.y) * (h.y - p.y);
        if (d < bestD) { bestD = d; best = h.key; }
    });

    return { kind: kind, key: best };
}

// Keeps the name tooltip above the pointer, clamped inside the patch
var SplashLabelHalf = 60;
function PositionSplashLabel(e) {
    var label = document.getElementById('SplashLabel');
    var patch = document.getElementById('SplashPatch');
    if (!label || !patch) return;
    var rect = patch.getBoundingClientRect();
    var x = Math.min(Math.max(e.clientX - rect.left, SplashLabelHalf + 8), rect.width - SplashLabelHalf - 8);
    var y = Math.max(e.clientY - rect.top, 44);
    // Undo any FLIP scale on the patch so the label tracks the pointer.
    var scale = rect.width / (patch.offsetWidth || rect.width);
    label.style.transform = 'translate(' + (x / scale) + 'px,' + (y / scale) + 'px) translate(-50%, calc(-100% - 10px))';
}

function SetSplashLabel(text) {
    var label = document.getElementById('SplashLabel');
    if (!label) return;
    if (text && label.textContent !== text) {
        label.textContent = text;
        requestAnimationFrame(function() { SplashLabelHalf = label.offsetWidth / 2 || 60; });
    }

    label.classList.toggle('visible', !!text);
}

// A flag lifts while its country is hovered or zoomed into
function UpdateFlagWedges() {
    Object.keys(FlagWedges).forEach(function(code) {
        // The viewed country's flag stays put, and a just-clicked flag waits for the pointer to leave
        var on = (code === SplashHoverCode || code === SplashFlagHover) &&
                 code !== SplashFocusCode && code !== SplashFlagClicked;
        FlagWedges[code].classList.toggle('active', on);
    });
}

function SplashCountryName(code) {
    var c = code && SplashData && SplashData.Countries[code];
    return c ? c.Name : null;
}

function SetSplashHover(code) {
    if (code === SplashHoverCode) return;
    if (SplashHoverCode) AnimTo('h:' + SplashHoverCode, 0);
    SplashHoverCode = code;
    if (code) AnimTo('h:' + code, 1, 0);
    UpdateFlagWedges();
    if (!SplashFocusCode) SetSplashLabel(SplashCountryName(code));
}

function SetSplashSubHover(index) {
    if (index === SplashSubHover) return;
    if (SplashSubHover !== null) AnimTo('s:' + SplashSubHover, 0);
    SplashSubHover = index;
    if (index !== null) AnimTo('s:' + index, 1, 0);
    if (SplashFocusCode) SetSplashLabel(index !== null ? SplashData.Countries[SplashFocusCode].Subs[index].Name : null);
}

// Matrix zooming a layer by up to k around (fx, fy) and turning it by rot, at progress t (log-scaled)
function FocusMatrix(k, fx, fy, rot, t) {
    var half = (SplashData.Size || 1000) / 2;
    var s = Math.exp(Math.log(k) * t);
    var r = (rot || 0) * t * Math.PI / 180;
    var a = s * Math.cos(r), b = s * Math.sin(r);
    var px = fx + (half - fx) * t, py = fy + (half - fy) * t;
    return [a, b, -b, a, px - (a * fx - b * fy), py - (b * fx + a * fy)];
}

function AnimateFocusZoom(layer, k, fx, fy, from, to, token, duration, done, rot) {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) duration = 0;
    var start = null;
    var patch = document.getElementById('SplashPatch');

    function frame(now) {
        if (token !== SplashZoomToken) return;
        if (start === null) start = now;
        var u = duration ? Math.min(1, (now - start) / duration) : 1;
        var eased = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;   // ease-in-out cubic
        SetSplashLayer(layer, FocusMatrix(k, fx, fy, rot, from + (to - from) * eased), u >= 1);
        cancelAnimationFrame(Scene.frame);
        Scene.frame = null;
        StepScene(now);
        if (u < 1) SplashZoomFrame = requestAnimationFrame(frame);
        else {
            if (patch) patch.classList.remove('zooming');
            RequestSplashDraw();   // let any fades finish
            if (done) done();
        }
    }

    if (patch) patch.classList.add('zooming');
    cancelAnimationFrame(SplashZoomFrame);
    SplashZoomFrame = requestAnimationFrame(frame);
}

// Continent layer <-> a country's view.
function AnimateSplashZoom(code, from, to, token, done) {
    var view = SplashData.Countries[code].View;   // [k, tx, ty]: p' = k*p + t
    var half = (SplashData.Size || 1000) / 2;
    var k = view[0];
    // The country's centre in continent coordinates (it lands on the disc centre).
    AnimateFocusZoom('land', k, (half - view[1]) / k, (half - view[2]) / k, from, to, token, SPLASH_ZOOM_MS, done);
}

// A [lat, lon] in a country's view, mirroring the build's projection, landmass shift and fit
function ProjectToCountryView(code, latLon) {
    var country = SplashData.Countries[code];
    var proj = SplashData.Projection;
    if (!country || !country.Fit || !proj || !latLon) return null;
    var n = proj[0], F = proj[1], lon0 = proj[2];
    var rad = Math.PI / 180;
    var d = (((latLon[1] - lon0 + 180) % 360) + 360) % 360 - 180;
    var theta = n * d * rad;
    var lat = Math.max(Math.min(latLon[0], 89.9), -89.9);
    var r = F / Math.pow(Math.tan(Math.PI / 4 + lat * rad / 2), n);
    var x = r * Math.sin(theta), y = r * Math.cos(theta);

    if (country.Clusters) {
        var best = null, bestGap = Infinity;
        country.Clusters.forEach(function(cl) {
            var gx = Math.max(cl[0] - x, x - cl[2], 0), gy = Math.max(cl[1] - y, y - cl[3], 0);
            var gap = Math.hypot(gx, gy);
            if (gap < bestGap) { bestGap = gap; best = cl; }
        });

        if (best) { x += best[4]; y += best[5]; }
    }

    var half = (SplashData.Size || 1000) / 2;
    return [half + (x - country.Fit[0]) * country.Fit[2], half + (y - country.Fit[1]) * country.Fit[2]];
}

// The selected station's dot, in the subdivision layer's coordinates.
function DrawSplashStationDot(point) {
    Scene.dot = point || null;
    RequestSplashDraw();
}

// Zooms onto one subdivision: for a station (neighbours stay) or isolated (it fills the disc alone)
function ZoomSplashSub(index, token, done, stationPoint, isolated) {
    var target = SplashSubLayer.querySelector('.SplashSub[data-sub="' + index + '"]');
    if (!target || token !== SplashZoomToken) return;
    var sub = SplashData.Countries[SplashFocusCode].Subs[index];

    if (isolated) {
        // Small subdivisions are magnified a long way: use the finer outline.
        if (sub.DFine) target.setAttribute('d', sub.DFine);
        target.classList.add('iso');
        SetSplashState('isolated', true);
        Scene.isolated = index;
        AnimSnap('iso', 1);
        AnimTo('iso', 0);
    } else {
        Scene.selected = index;
    }

    DrawSplashStationDot(stationPoint);

    var box = target.getBBox();
    var radius = Math.max(Math.hypot(box.width, box.height) / 2, 0.5);
    var scale = isolated
        ? Math.min(Math.max(SPLASH_ISOLATE_RADIUS / radius, 1), 80)
        : Math.min(Math.max(SPLASH_SUB_ZOOM_RADIUS / radius, 1), 14);
    var fx = box.x + box.width / 2, fy = box.y + box.height / 2;
    // An isolated subdivision is also turned north-up
    var rot = isolated ? (sub.Rot || 0) : 0;
    SplashSubZoom = { code: SplashFocusCode, index: index, s: scale, fx: fx, fy: fy, rot: rot, isolated: !!isolated };
    UpdateSplashViewTitle();
    AnimateFocusZoom('sub', scale, fx, fy, 0, 1, token, SPLASH_SUB_ZOOM_MS, done, rot);
}

function UnzoomSplashSub(token, done) {
    var z = SplashSubZoom;
    if (z && z.isolated) {
        var sub = SplashData.Countries[z.code] && SplashData.Countries[z.code].Subs[z.index];
        SplashSubLayer.querySelectorAll('.SplashSub[data-sub="' + z.index + '"]').forEach(function(el) {
            el.classList.remove('iso');
            if (sub && sub.DFine) el.setAttribute('d', sub.D);
        });
    }

    SetSplashState('isolated', false);
    if (Scene.isolated !== null) AnimTo('iso', 1);   // neighbours fade back in...
    var wasIsolated = Scene.isolated;
    Scene.selected = null;
    DrawSplashStationDot(null);
    if (!z) { Scene.isolated = null; if (done) done(); return; }
    AnimateFocusZoom('sub', z.s, z.fx, z.fy, 1, 0, token, SPLASH_SUB_ZOOM_MS * 0.7, function() {
        if (Scene.isolated === wasIsolated) Scene.isolated = null;   // ...then it's an ordinary subdivision again
        SetSplashLayer('sub', IDENTITY);
        SplashSubZoom = null;
        UpdateSplashViewTitle();
        if (done) done();
    });
}

function EnterSplashCountry(code, onSettled) {
    var country = SplashData && SplashData.Countries[code];
    if (!country || SplashFocusCode) return;
    var token = ++SplashZoomToken;
    SetSplashLayer('sub', IDENTITY);
    SplashSubZoom = null;
    SetSplashState('isolated', false);
    Scene.isolated = Scene.selected = Scene.dot = null;

    SetSplashHover(null);
    SplashFocusCode = code;
    SplashSubHover = null;
    UpdateFlagWedges();

    var targets = [];
    SplashHits.sub = [];
    country._subPaths = country._subPaths || country.Subs.map(function(sub) {
        return { path: new Path2D(sub.D), fine: sub.DFine ? new Path2D(sub.DFine) : null };
    });

    country.Subs.forEach(function(sub, i) {
        targets.push('<path class="SplashSub" data-sub="' + i + '" d="' + sub.D + '"></path>');
        AnimSnap('s:' + i, 0);
    });

    country.Subs.forEach(function(sub, i) {
        if (!sub.Hit) return;
        SplashHits.sub.push({ key: i, x: sub.Hit[0], y: sub.Hit[1], r: sub.Hit[2] });
        targets.push('<circle class="SplashHit" data-sub="' + i + '" cx="' + sub.Hit[0] + '" cy="' + sub.Hit[1] + '" r="' + sub.Hit[2] + '"></circle>');
    });

    SplashSubLayer.innerHTML = targets.join('');

    // The country's own finer lines; neighbours' lines fade with their countries
    country._lineSet = country._lineSet || BuildLineSet(country.Lines);
    if (!country._outlineAll) {
        country._outlineAll = new Path2D();
        country._subPaths.forEach(function(sp) { country._outlineAll.addPath(sp.path); });
    }

    Scene.subs = country._subPaths;
    Scene.countryLines = country._lineSet;
    setTimeout(RefreshSplashTeams, 0);   // after SplashFocusCode is set below
    Scene.countryOutline = country._outlineAll;
    Scene.focusOutline = Scene.countries.filter(function(c) { return c.code === code; })[0].path;
    Object.keys(SplashData.Countries).forEach(function(c) { if (c !== code) AnimTo('c:' + c, 0, 1); });

    SetSplashState('focused', true);
    UpdateSplashViewTitle();
    document.getElementById('SplashPatch').classList.add('country-view');
    SetSplashLabel(null);

    AnimateSplashZoom(code, 0, 1, token, function() {
        // Cross-fade continent -> subdivisions.
        SetSplashState('settled', true);
        AnimTo('cont', 0, 1);
        AnimTo('sub', 1, 0);
        if (onSettled) onSettled();
    });
}

function ExitSplashCountry(onDone) {
    var code = SplashFocusCode;
    if (!code) { if (onDone) onDone(); return; }
    var token = ++SplashZoomToken;

    SetSplashSubHover(null);
    SplashFocusCode = null;
    UpdateFlagWedges();
    SetSplashLabel(null);
    document.getElementById('SplashPatch').classList.remove('country-view');

    // Back out of a subdivision, fade back to the country outline, then zoom out
    UnzoomSplashSub(token, function() {
        if (token !== SplashZoomToken) return;
        SetSplashState('settled', false);
        AnimTo('cont', 1);
        AnimTo('sub', 0);
        setTimeout(function() {
            if (token !== SplashZoomToken) return;
            SetSplashState('focused', false);
            Object.keys(SplashData.Countries).forEach(function(c) { AnimTo('c:' + c, 1); });
            AnimateSplashZoom(code, 1, 0, token, function() {
                SetSplashLayer('land', IDENTITY);
                SplashSubLayer.innerHTML = '';
                SplashHits.sub = [];
                Scene.subs = [];
                Scene.countryLines = Scene.countryOutline = Scene.focusOutline = null;
                Scene.isolated = Scene.selected = Scene.dot = null;
                RequestSplashDraw();
                if (onDone) onDone();
            });
        }, 220);
    });
}

// One level back: subdivision to country, country to continent
function StepBackSplash() {
    SplashStationFocus = false;
    if (SplashSubZoom) {
        SetSplashSubHover(null);
        UnzoomSplashSub(++SplashZoomToken);
    } else {
        ExitSplashCountry();
    }
}

// Clicking a subdivision shows it on its own.
function IsolateSplashSub(index) {
    if (SplashSubZoom && SplashSubZoom.isolated) return;
    SplashStationFocus = false;
    SetSplashSubHover(null);
    var token = ++SplashZoomToken;
    UnzoomSplashSub(token, function() { ZoomSplashSub(index, token, null, null, true); });
}

// Following the selected station: the globe zooms to its subdivision via the build's RegionIndex

function NormalizeRegionName(name) {
    return String(name).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function StationSubdivision(key) {
    var index = SplashData && SplashData.RegionIndex;
    if (!index) return null;
    var keys = [key].concat(SelectedStationGroup || []);
    for (var i = 0; i < keys.length; i++) {
        var entry = StationSearchIndex[keys[i]];
        var region = entry && entry.Region;
        if (!region || region.length < 3) continue;
        var hit = index[region[2]] && index[region[2]][NormalizeRegionName(region[1])];
        if (hit) return { code: hit[0], index: hit[1], key: keys[i], location: entry.Location };
    }

    return null;
}

function FocusSplashOnStation(key) {
    FocusSplashOnTarget(StationSubdivision(key));
}

// The country and subdivision a coordinate falls in, found geometrically; null at sea
function SplashTargetForPoint(latLon) {
    if (!SplashData || !Scene.ctx || !latLon) return null;
    var c = ProjectToContinent(latLon);
    if (!c) return null;
    var ctx = Scene.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var target = null, code = null;
    Scene.countries.some(function(cn) { if (ctx.isPointInPath(cn.path, c[0], c[1], 'evenodd')) { code = cn.code; return true; } });
    if (code) {
        var country = SplashData.Countries[code];
        country._subPaths = country._subPaths || country.Subs.map(function(sub) {
            return { path: new Path2D(sub.D), fine: sub.DFine ? new Path2D(sub.DFine) : null };
        });

        var q = ProjectToCountryView(code, latLon);
        if (q) country._subPaths.some(function(sp, i) {
            if (ctx.isPointInPath(sp.path, q[0], q[1], 'nonzero')) { target = { code: code, index: i, location: latLon }; return true; }
        });
    }

    ctx.restore();
    return target;
}

// Zooms the globe to a target's subdivision with a dot, or releases the focus when there is none
function FocusSplashOnTarget(target) {
    if (!SplashData || GlobeDockState === 'none') return;
    if (!target) { ReleaseSplashStationFocus(); return; }
    SplashStationFocus = true;

    // (No dot for a team's venue: it would sit right on the team's logo.)
    var point = target.noDot ? null : ProjectToCountryView(target.code, target.location);
    var zoomIn = function() { ZoomSplashSub(target.index, SplashZoomToken, null, point); };
    if (SplashFocusCode === target.code) {
        if (SplashSubZoom && SplashSubZoom.index === target.index && !SplashSubZoom.isolated) {
            DrawSplashStationDot(point);   // same subdivision: just move the dot
            return;
        }

        var token = ++SplashZoomToken;
        UnzoomSplashSub(token, function() { ZoomSplashSub(target.index, token, null, point); });
    } else if (SplashFocusCode) {
        ExitSplashCountry(function() { EnterSplashCountry(target.code, zoomIn); });
    } else {
        EnterSplashCountry(target.code, zoomIn);
    }
}

// Station deselected: zoom back out if the globe only zoomed in for it
function ReleaseSplashStationFocus() {
    if (!SplashStationFocus) return;
    SplashStationFocus = false;
    ExitSplashCountry();
}

function OnSplashClick(e) {
    var target = ResolveSplashTarget(e);
    if (SplashFocusCode) {
        if (target && target.kind === 'sub') IsolateSplashSub(target.key);
        else StepBackSplash();   // the ocean
        return;
    }

    SplashStationFocus = false;
    if (target && target.kind === 'country') EnterSplashCountry(target.key);
}

// Ring flags mirror their countries: hover lifts and highlights, click zooms in or back out
function OnFlagHover(code, e) {
    if (code !== SplashFlagClicked) SplashFlagClicked = null;
    SplashFlagHover = code;
    if (e) PositionSplashLabel(e);
    if (SplashFocusCode) {
        UpdateFlagWedges();
        SetSplashLabel(code && code !== SplashFocusCode ? SplashCountryName(code) : null);
    } else {
        SetSplashHover(code);
    }
}

function OnFlagClick(code) {
    if (!SplashData || !SplashData.Countries[code]) return;
    SplashFlagClicked = code;
    SplashStationFocus = false;
    if (SplashFocusCode === code) { ExitSplashCountry(); return; }
    if (SplashFocusCode) { ExitSplashCountry(function() { EnterSplashCountry(code); }); return; }
    EnterSplashCountry(code);
}

function InitFlagRingEvents() {
    var layer = document.getElementById('FlagHitLayer');
    if (!layer) return;
    var codeOf = function(e) { return e.target.getAttribute && e.target.getAttribute('data-code'); };
    layer.addEventListener('pointerover', function(e) { OnFlagHover(codeOf(e), e); });
    layer.addEventListener('pointermove', function(e) { PositionSplashLabel(e); });
    layer.addEventListener('pointerdown', function(e) { OnFlagHover(codeOf(e), e); });
    layer.addEventListener('pointerout', function(e) {
        if (e.pointerType === 'touch') return;
        if (e.relatedTarget && layer.contains(e.relatedTarget)) return;   // moving to the next flag
        OnFlagHover(null);
    });

    layer.addEventListener('click', function(e) {
        var code = codeOf(e);
        if (code) OnFlagClick(code);
    });
}

(function InitSplashEntry() {
    var content = document.getElementById('SplashContent');
    if (!content) return;
    content.addEventListener('click', OnSplashClick);
    var back = document.getElementById('SplashBack');
    if (back) back.addEventListener('click', function(e) { e.stopPropagation(); StepBackSplash(); });
    document.addEventListener('keydown', function(e) {
        var splash = document.getElementById('SplashScreen');
        var splashOpen = splash && !splash.classList.contains('hidden');
        var dockOpen = GlobeDockState === 'expanded';
        if (e.key === 'Escape') {
            if ((splashOpen || dockOpen) && SplashFocusCode) StepBackSplash();
            else if (dockOpen) CollapseGlobeDock();
        }

        // Enter from anywhere that isn't itself a control enters the map.
        if (e.key === 'Enter' && splashOpen && (document.activeElement === document.body || !document.activeElement)) CloseSplash();
    });
})();

// Globe dock: after the splash the patch shrinks into a corner widget that expands over the map

var GlobeDockState = 'none';   // 'none' (still in the splash) | 'mini' | 'expanded'
var GLOBE_DOCK_MS = 650;

// Moves the patch where mutate puts it, animating between the boxes (FLIP)
function MovePatchAnimated(mutate) {
    var patch = document.getElementById('SplashPatch');
    var first = patch.getBoundingClientRect();
    mutate();
    var last = patch.getBoundingClientRect();
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || !last.width || !first.width) return;

    patch.style.transition = 'none';
    patch.style.transformOrigin = '0 0';
    patch.style.transform = 'translate(' + (first.left - last.left) + 'px,' + (first.top - last.top) + 'px) scale(' + (first.width / last.width) + ')';
    void patch.offsetWidth;
    patch.style.transition = 'transform ' + GLOBE_DOCK_MS + 'ms cubic-bezier(0.16, 1, 0.3, 1)';
    patch.style.transform = '';
    clearTimeout(patch._flipTimer);
    patch._flipTimer = setTimeout(function() {
        patch.style.transition = '';
        patch.style.transformOrigin = '';
    }, GLOBE_DOCK_MS + 50);
}

function ClearSplashPointerState() {
    SetSplashSubHover(null);
    OnFlagHover(null);
    SetSplashHover(null);
    SetSplashLabel(null);
}

function SetGlobeDockState(state) {
    var dock = document.getElementById('GlobeDock');
    var backdrop = document.getElementById('GlobeDockBackdrop');
    GlobeDockState = state;
    document.body.classList.toggle('globe-docked', state !== 'none');
    requestAnimationFrame(RefreshSplashStyle);
    dock.classList.toggle('mini', state === 'mini');
    dock.classList.toggle('expanded', state === 'expanded');
    if (backdrop) backdrop.classList.toggle('visible', state === 'expanded');
    // While mini the dock itself is the button; expanded, the controls inside take over
    if (state === 'mini') {
        dock.setAttribute('role', 'button');
        dock.setAttribute('tabindex', '0');
    } else {
        dock.removeAttribute('role');
        dock.removeAttribute('tabindex');
    }
}

function DockSplashPatch() {
    var dock = document.getElementById('GlobeDock');
    var patch = document.getElementById('SplashPatch');
    if (!dock || !patch || patch.parentNode === dock) return;
    ClearSplashPointerState();
    // The corner widget always starts on the whole continent
    SplashStationFocus = false;
    ExitSplashCountry();
    MovePatchAnimated(function() {
        dock.insertBefore(patch, dock.firstChild);
        SetGlobeDockState('mini');
    });

    SetSplashLineMode(CurrentMapMode);
}

function ExpandGlobeDock() {
    if (GlobeDockState !== 'mini') return;
    MovePatchAnimated(function() { SetGlobeDockState('expanded'); });
}

function CollapseGlobeDock() {
    if (GlobeDockState !== 'expanded') return;
    ClearSplashPointerState();
    SplashStationFocus = false;
    ExitSplashCountry();
    MovePatchAnimated(function() { SetGlobeDockState('mini'); });
    var dock = document.getElementById('GlobeDock');
    if (dock) dock.focus({ preventScroll: true });
}

(function InitGlobeDock() {
    var dock = document.getElementById('GlobeDock');
    var backdrop = document.getElementById('GlobeDockBackdrop');
    var collapse = document.getElementById('SplashCollapse');
    if (!dock) return;
    dock.addEventListener('click', function() { if (GlobeDockState === 'mini') ExpandGlobeDock(); });
    dock.addEventListener('keydown', function(e) {
        if (GlobeDockState === 'mini' && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ExpandGlobeDock(); }
    });

    if (backdrop) backdrop.addEventListener('click', CollapseGlobeDock);
    if (collapse) collapse.addEventListener('click', function(e) { e.stopPropagation(); CollapseGlobeDock(); });
})();

BuildFlagRing();
BuildRingEffects();
BuildSplashMap();
InitFlagRingEvents();

function BuildImageCandidates(basePath, name) {
    // ImageManifest knows each image's real extension, so only one request is made
    if (typeof ImageManifest === 'object' && ImageManifest && ImageManifest.files) {
        var rel = basePath.replace(/^data\/images\//, '').split('/').map(function(p) { try { return decodeURIComponent(p); } catch (e) { return p; } }).join('/');
        var ext = ImageManifest.files[rel + '/' + name];
        if (ext) return [basePath + '/' + encodeURIComponent(name) + '.' + ext];
        if (ImageManifest.dirs && ImageManifest.dirs.indexOf(rel) !== -1) return [];   // folder scanned: image doesn't exist
    }

    return IMAGE_EXTENSIONS.map(function(ext) { return basePath + '/' + encodeURIComponent(name) + '.' + ext; });
}

// Tries each candidate image file in turn, hiding the image once all have failed
function ImageFallback(img) {
    var candidates = JSON.parse(img.getAttribute('data-candidates') || '[]');
    var idx = parseInt(img.getAttribute('data-idx') || '0', 10) + 1;
    if (idx >= candidates.length) { img.removeAttribute('onerror'); img.style.display = 'none'; return; }
    img.setAttribute('data-idx', idx);
    img.src = candidates[idx];
}

// {src, extra} for an img tag resolving a bare image name under basePath; data: URIs pass through
function ImageAttrs(basePath, name) {
    if (!name) return null;
    if (name.indexOf('data:') === 0) return {src: name, extra: ''};          // a picture downloaded from its URL: its path is known
    if (/^https?:\/\//.test(name)) return {src: name, extra: 'referrerpolicy="no-referrer" onerror="this.style.display=&quot;none&quot;"'};          // one its site would not let the build download: shown from its own address (hidden if the site refuses that too)
    var candidates = BuildImageCandidates(basePath, name);
    if (!candidates.length) return {src: 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', extra: 'style="display:none" aria-hidden="true"'};
    var candidatesJson = JSON.stringify(candidates).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return {src: candidates[0], extra: 'data-candidates="' + candidatesJson + '" data-idx="0" onerror="ImageFallback(this)"'};
}

function DestImageFile(dest) {
    return Array.isArray(dest.Image) ? dest.Image[0] : dest.Image;
}

function DestImageSource(dest) {
    return Array.isArray(dest.Image) ? dest.Image[1] : dest.Source;
}

// The page a picture comes from (pictures given by URL): its image and credit link there
function DestImageLink(dest) {
    return Array.isArray(dest.Image) && dest.Image[2] ? dest.Image[2] : null;
}

function EscAttr(s) { return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }

function ToggleAllProjects() {
    if (CurrentMapMode !== 'Fantasy') return;
    ProjectsHidden = !ProjectsHidden;
    UpdateProjectMarkersVisibility();
}

function UpdateProjectMarkersVisibility() {
    var isApplicable = (CurrentMapMode === 'Fantasy');
    var zoom = LMap ? LMap.getZoom() : 0;
    var globallyOn = isApplicable && !ProjectsHidden;

    Object.keys(InfoMarkers).forEach(function(key) {
        var layers = InfoMarkers[key];
        var info = InfoPoints[key];
        var minZoom = PROJECT_MIN_ZOOM_BY_RADIUS[info.Radius] || 9;
        var shouldShow = globallyOn && zoom >= minZoom;
        var isShown = LMap.hasLayer(layers.marker);
        if (shouldShow && !isShown) AddMarkerLayers(layers);
        else if (!shouldShow && isShown) RemoveMarkerLayers(layers);
    });

    var btn = document.getElementById('ProjectToggleButton');
    if (btn) {
        btn.classList.toggle('active', globallyOn);
        btn.classList.toggle('mode-disabled', !isApplicable);
        btn.disabled = !isApplicable;
        btn.title = !isApplicable
            ? 'Projects are only shown in the Future view'
            : (ProjectsHidden ? 'Show projects' : 'Hide projects');
    }

    SyncProjectsDock();
}

function ToggleAllDestinations() {
    DestinationsHidden = !DestinationsHidden;
    SyncDestinationToggleUI();
    UpdateDestinationMarkersVisibility();
}

function SyncDestinationToggleUI() {
    RenderPlacesChips();
}

function ToggleStationDots() {
    StationDotsHidden = !StationDotsHidden;
    SyncStationDotsToggleUI();
    RefreshStationDots();
}

function SyncStationDotsToggleUI() {
    var isOn = !StationDotsHidden;
    var btn = document.getElementById('StationDotsToggleButton');
    if (btn) { btn.classList.toggle('active', isOn); btn.title = isOn ? 'Hide stations' : 'Show stations'; }
}

var DEST_MARKER_MIN_ZOOM = 7;

function UpdateDestinationMarkersVisibility() {
    var isPresent = (CurrentMapMode === 'Present');
    var zoomOk = LMap && LMap.getZoom() >= DEST_MARKER_MIN_ZOOM;
    ForEachDestinationMarker(function(cat, name, layers) {
        var dest = Destinations[cat][name];
        var exists = DestExists(dest, isPresent ? 'Present' : 'Fantasy');
        var modeVisible = DestExplore ? exists && DestExplore.has(cat + '' + name) : zoomOk && !DestinationsHidden && !HiddenDestCategories.has(cat) && exists;          // exploring: just the places the panel lists
        var isShown = LMap.hasLayer(layers.marker);
        if (modeVisible && !isShown) AddMarkerLayers(layers);
        else if (!modeVisible && isShown) RemoveMarkerLayers(layers);
    });

    ResolveMarkerCollisions();
}

function ToggleDestPopupMinimize() {
    var overlay = document.getElementById('StationPopupOverlay');
    if (!overlay.classList.contains('DestPopupCentered')) return;
    var backdrop = document.getElementById('DestPopupBackdrop');
    var btn = document.getElementById('PopupMinimizeBtn');
    var minimized = overlay.classList.toggle('DestPopupMinimized');
    if (backdrop) backdrop.classList.toggle('show', !minimized);
    if (btn) { btn.textContent = minimized ? '⤢' : '−'; btn.title = minimized ? 'Expand' : 'Minimize'; }
}

var DEST_FOCUS_ZOOM = 16; // "zoomed all the way in" level used when a destination is opened from a menu

// Flies so latlng lands in the middle of the map area not covered by the sidebar or panel
function FlyToVisibleCenter(latlng, zoom) {
    var map = LMap;
    var w = map.getSize().x;
    var left = 0, right = 0;
    var sidebar = document.getElementById('Sidebar');
    if (sidebar && !sidebar.classList.contains('collapsed') && w > 768) {
        var r = sidebar.getBoundingClientRect();
        if (r.right > 0 && r.left < w / 2) left = r.right;
    }

    var popup = document.getElementById('StationPopupOverlay');
    if (popup && w > 768) right = 400 + 20;
    var dx = (right - left) / 2, dy = SheetVisible() / 2;          // phones: the middle of the map above the sheet
    var target = map.unproject(map.project(latlng, zoom).add([dx, dy]), zoom);
    map.flyTo(target, zoom, {animate: true, duration: 0.7});
}

function ShowDestinationPopup(cat, name, zoomIn) {
    var dest = Destinations[cat] && Destinations[cat][name];
    if (!dest) return;
    SetSheet('peek');
    HideZoomToStationButton();

    if (SelectedDestination) SetDestinationSelected(SelectedDestination.category, SelectedDestination.name, false);
    SelectedDestination = {category: cat, name: name};
    SetDestinationSelected(cat, name, true);

    document.getElementById('StationPopupOverlay').classList.add('DestPopupCentered');
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupMinimized');
    var destBackdrop = document.getElementById('DestPopupBackdrop');
    if (destBackdrop) destBackdrop.classList.add('show');
    var minBtn = document.getElementById('PopupMinimizeBtn');
    if (minBtn) { minBtn.textContent = '−'; minBtn.title = 'Minimize'; }

    // Only move the map when opened from a menu, not when the marker itself was clicked
    if (zoomIn) FlyToVisibleCenter(dest.Location, DEST_FOCUS_ZOOM);
    HideProjectPanel();
    var focusTarget = SplashTargetForPoint(dest.Location);
    if (focusTarget && SplashVenueForTeam) focusTarget.noDot = true;
    SplashVenueForTeam = false;
    FocusSplashOnTarget(focusTarget);

    var visibleKeys = ComputeVisibleStationKeys();

    var explicitKeys = new Set();
    DestStationList(dest).forEach(function(k) {
        var GK = StationGroupMembers(k);
        (GK.length ? GK : [k]).forEach(function(gk) { explicitKeys.add(gk); });
    });

    var serving = Array.from(explicitKeys).filter(function(k) { return visibleKeys.has(k); });

    var ServingGroupsMap = {};
    serving.forEach(function(sk) {
        var Base = StationGroupBase(sk);
        if (!ServingGroupsMap[Base]) ServingGroupsMap[Base] = {Keys: [], Labels: []};
        ServingGroupsMap[Base].Keys.push(sk);
        var sd = Stations[sk] || AllNodes[sk];
        var lbl = CleanStationName((sd && sd.Label) || Base);
        if (!ServingGroupsMap[Base].Labels.includes(lbl)) ServingGroupsMap[Base].Labels.push(lbl);
    });

    var ServingGroups = Object.values(ServingGroupsMap).map(function(G) {
        return {
            Label: G.Labels.reduce(function(Best, L) { return L.length > Best.length ? L : Best; }),
            Keys: G.Keys,
            Lines: LinesServing(G.Keys),
        };
    });

    var cfg = GetDestCategoryConfig(cat);

    document.getElementById('PopupStationName').innerText = name;
    document.getElementById('PopupStationType').innerText = cfg.label;
    SetPopupFlag(null);
    document.getElementById('StationPopupOverlay').classList.remove('StationMode');

    var imgContainer = document.getElementById('DestPopupImageContainer');
    if (!imgContainer) {
        imgContainer = document.createElement('div');
        imgContainer.id = 'DestPopupImageContainer';
        var popupHeader = document.querySelector('.PopupHeader');
        if (popupHeader) popupHeader.insertAdjacentElement('afterend', imgContainer);
    }

    var imgFile = DestImageFile(dest);
    if (imgFile) {
        var imgSource = DestImageSource(dest), imgLink = DestImageLink(dest);
        var imgAttrs = ImageAttrs(DEST_IMAGE_BASE, imgFile);
        var img = '<img src="' + imgAttrs.src + '" ' + imgAttrs.extra + ' class="DestPopupImage" alt="' + name + '">';
        var open = imgLink ? '<a class="DestPopupImageLink" href="' + EscAttr(imgLink) + '" target="_blank" rel="noopener" title="Open where this picture comes from">' : '';
        imgContainer.innerHTML = (imgLink ? open + img + '</a>' : img) +
            (imgSource ? (imgLink ? open.replace('DestPopupImageLink', 'DestPopupSource') + imgSource + '</a>' : '<div class="DestPopupSource">' + imgSource + '</div>') : '');
        imgContainer.style.display = 'block';
    } else {
        imgContainer.innerHTML = '';
        imgContainer.style.display = 'none';
    }

    var mode = CurrentMapMode;
    var teamsHtml = '';
    (dest.Teams || []).forEach(function(team) {
        // Skip a team listed here only as a venue it is moving away from
        var owner = TeamVenueForMode(team, mode, visibleKeys);
        if (!owner || owner.cat !== cat || owner.name !== name) return;
        var league = FindTeamLeague(team);
        var logo = league ? ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team) : null;
        teamsHtml += '<div class="DestPopupTeamChip">' +
            (logo ? '<img src="' + logo.src + '" ' + logo.extra + ' alt="">' : '') +
            '<span>' + team + '</span></div>';
    });

    var teamsContainer = document.getElementById('DestPopupTeamsContainer');
    if (!teamsContainer) {
        teamsContainer = document.createElement('div');
        teamsContainer.id = 'DestPopupTeamsContainer';
        imgContainer.insertAdjacentElement('afterend', teamsContainer);
    }

    teamsContainer.innerHTML = teamsHtml ? ('<div class="DestPopupTeamsLabel">Home Teams</div><div class="DestPopupTeamsRow">' + teamsHtml + '</div>') : '';
    teamsContainer.style.display = teamsHtml ? 'block' : 'none';

    ClearStationMarkers();
    serving.forEach(function(sk) {
        var sd = AllNodes[sk];
        if (!sd || !sd.Location) return;
        var servingLines = LinesServing([sk]);
        var color = servingLines.length ? servingLines[0].Color : '#94a3b8';
        var radius = BaseDotRadius(sd);
        MakeStationMarker(sk, sd.Location, radius, color, sd.Label);
    });

    var html = '';
    if (!ServingGroups.length) {
        html = '<div style="padding:16px;color:#94a3b8;font-size:13px;">No transit service visible in this map view.</div>';
    } else {
        ServingGroups.forEach(function(G, idx) {
            var byOperator = {};
            G.Lines.forEach(function(L) {
                var op = L.Operator || 'Other';
                if (!byOperator[op]) byOperator[op] = [];
                byOperator[op].push(L);
            });

            var bodyId = 'PopupStationBody_' + idx;
            var stationKey = G.Keys[0].replace(/'/g, "\\'");
            html += `<div class="PopupStationCard">
                <div class="PopupStationHeader" onclick="SelectStationFromDestPopup('${stationKey}')">
                    <span class="PopupStationHeaderName">${G.Label}</span>
                    <button class="PopupStationToggle" onclick="event.stopPropagation(); TogglePopupStationBody('${bodyId}', this)" title="Expand/collapse">▾</button>
                </div>
                <div class="PopupStationBody" id="${bodyId}">`;

            Object.keys(byOperator).sort().forEach(function(op) {
                html += `<div style="display:flex;flex-direction:column;gap:4px;">
                    <div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.5px;color:#94a3b8;">${op}</div>
                    <div style="display:flex;flex-wrap:wrap;gap:4px;">`;
                byOperator[op].forEach(function(L) {
                    html += `<span onclick="event.stopPropagation(); SelectLine('${L.Id}')" style="cursor:pointer;background:${L.Color};color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:99px;white-space:nowrap;">${L.Name}</span>`;
                });

                html += `</div></div>`;
            });

            html += `</div></div>`;
        });
    }

    document.getElementById('PopupContent').innerHTML = html;
    document.getElementById('StationPopupOverlay').style.display = 'flex';
    CurrentStationPopup = '__destination__';
}

function TogglePopupStationBody(id, btn) {
    var body = document.getElementById(id);
    if (!body) return;
    var collapsed = body.classList.toggle('collapsed');
    if (btn) btn.classList.toggle('collapsed', collapsed);
}

function SelectStationFromDestPopup(sk) {
    if (SelectedDestination) { SetDestinationSelected(SelectedDestination.category, SelectedDestination.name, false); SelectedDestination = null; }
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupCentered');
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupMinimized');
    var destBackdrop = document.getElementById('DestPopupBackdrop');
    if (destBackdrop) destBackdrop.classList.remove('show');
    CurrentStationPopup = null;
    ShowStationPopup(sk, true);
}

function CloseDestinationPopup() {
    ReleaseSplashStationFocus();
    if (SelectedDestination) { SetDestinationSelected(SelectedDestination.category, SelectedDestination.name, false); SelectedDestination = null; }
    ClearStationMarkers();
    var imgContainer = document.getElementById('DestPopupImageContainer');
    if (imgContainer) { imgContainer.innerHTML = ''; imgContainer.style.display = 'none'; }
    var teamsContainer = document.getElementById('DestPopupTeamsContainer');
    if (teamsContainer) { teamsContainer.innerHTML = ''; teamsContainer.style.display = 'none'; }
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupCentered');
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupMinimized');
    document.getElementById('StationPopupOverlay').style.display = 'none';
    var destBackdrop = document.getElementById('DestPopupBackdrop');
    if (destBackdrop) destBackdrop.classList.remove('show');
    CurrentStationPopup = null;
    RefreshStationDots();
}

// A browse window (#<name>Modal) and its backdrop (#<name>Backdrop)
function SetModalOpen(name, open) {
    ['Backdrop', 'Modal'].forEach(function(part) { var el = document.getElementById(name + part); if (el) el.classList.toggle('show', open); });
}

function IsModalOpen(name) {
    var m = document.getElementById(name + 'Modal');
    return !!m && m.classList.contains('show');
}

// The Present Day / Future Vision switch of a browse window; fn is the global handler to call
function ModeToggleHtml(fn) {
    return [['Present', 'Present Day'], ['Fantasy', 'Future Vision']].map(function(m) {
        return '<button class="SportsModeBtn' + (CurrentMapMode === m[0] ? ' active' : '') + '" onclick="' + fn + '(\'' + m[0] + '\')">' + m[1] + '</button>';
    }).join('');
}

function InitDestBrowseModal() {
    var filterInput = document.getElementById('DestBrowseFilterInput');
    if (filterInput) filterInput.addEventListener('input', function() { RenderDestBrowseModal(DestBrowseActiveCat); });
}

function RenderDestModeToggle() {
    var el = document.getElementById('DestModeToggle');
    if (!el) return;
    el.innerHTML = ModeToggleHtml('SetDestBrowseMode');
}

function SetDestBrowseMode(mode) {
    if (CurrentMapMode !== mode) SwitchMapMode(mode);
    RenderDestModeToggle();
    RenderDestBrowseModal(DestBrowseActiveCat);
}

var DestBrowseActiveCat = 'All';

function OpenDestBrowseModal(category) {
    var modal = document.getElementById('DestBrowseModal');
    var filterInput = document.getElementById('DestBrowseFilterInput');
    if (modal) modal.classList.remove('minimized');
    SyncDestBrowseMinBtn(false); DockDestExplore(false);
    SetModalOpen('DestBrowse', true);
    if (filterInput) { filterInput.value = ''; setTimeout(function() { filterInput.focus(); }, 50); }
    RenderDestModeToggle();
    // Opened from a category chip the window shows just that category
    var single = !!(category && Destinations[category]);
    if (modal) modal.classList.toggle('single-category', single);
    var title = document.getElementById('DestBrowseTitle');
    var icon = document.getElementById('DestBrowseTitleIcon');
    if (single) {
        var cfg = OmniPlaceCategory(category);
        var full = PlaceCategoryConfig(category);
        if (title) title.textContent = category;
        if (icon) { icon.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15">' + (full ? full.icon : '') + '</svg>'; icon.style.background = cfg.bg; icon.classList.add('category'); }
        if (filterInput) filterInput.placeholder = 'Filter ' + category.toLowerCase() + '…';
    } else {
        if (title) title.textContent = 'Points of Interest';
        if (icon) { icon.style.background = ''; icon.classList.remove('category'); }
        if (filterInput) filterInput.placeholder = 'Filter destinations…';
    }

    RenderDestBrowseModal(single ? category : 'All');
}

function CloseDestBrowseModal() {
    SetModalOpen('DestBrowse', false);
    var m = document.getElementById('DestBrowseModal'); if (m) m.classList.remove('minimized');
    SyncDestBrowseMinBtn(false); DockDestExplore(false);
    if (DestExplore || DestExploreWasHidden !== null) {
        DestExplore = null;
        if (DestExploreWasHidden !== null) { DestinationsHidden = DestExploreWasHidden; DestExploreWasHidden = null; SyncDestinationToggleUI(); }
        UpdateDestinationMarkersVisibility();
    }
}

// Explore on the map: the window shrinks to a panel beside the map, which then shows exactly the places the panel lists
var DestExplore = null;              // 'categoryname' of every listed place while minimized; null otherwise
var DestExploreWasHidden = null;     // whether places were hidden before exploring, given back on close
var DestExploreFitTimer = null;
var DestExploreSidebar = false;        // the sidebar was folded away to make room for the panel, and comes back after
function DestBrowseMinimized() { var m = document.getElementById('DestBrowseModal'); return !!m && m.classList.contains('minimized'); }

function SyncDestBrowseMinBtn(min) {
    var btn = document.getElementById('DestBrowseMinBtn');
    if (btn) { btn.textContent = min ? '⤢' : '−'; btn.title = min ? 'Back to the full window' : 'Minimize: see these places on the map'; btn.setAttribute('aria-label', min ? 'Expand' : 'Minimize'); }
}

function SetDestBrowseMinimized(min) {
    var m = document.getElementById('DestBrowseModal'), bd = document.getElementById('DestBrowseBackdrop');
    if (!m || !m.classList.contains('show')) return;
    m.classList.toggle('minimized', min);
    if (bd) bd.classList.toggle('show', !min);
    SyncDestBrowseMinBtn(min);
    DockDestExplore(min);
    if (min && DestExploreWasHidden === null) { DestExploreWasHidden = DestinationsHidden; DestinationsHidden = false; SyncDestinationToggleUI(); }
    RenderDestBrowseModal(DestBrowseActiveCat);
}

// On a computer the panel takes the sidebar's place (a place's own popup opens on the right); on a phone it is a sheet at the bottom
function DockDestExplore(min) {
    if (IsPhone()) return;
    var S = document.getElementById('Sidebar');
    if (min && S && !S.classList.contains('collapsed')) { ToggleSidebar(); DestExploreSidebar = true; }
    else if (!min && DestExploreSidebar) { DestExploreSidebar = false; if (S && S.classList.contains('collapsed')) ToggleSidebar(); }
}

// The map frames every listed place, clear of the panel
function FitDestExplore() {
    if (!DestExplore || !DestExplore.size || !LMap) return;
    var pts = [];
    DestExplore.forEach(function(k) { var i = k.indexOf(''), d = Destinations[k.slice(0, i)] && Destinations[k.slice(0, i)][k.slice(i + 1)]; if (d && d.Location) pts.push(d.Location); });
    if (!pts.length) return;
    var pad = LineFitPadding(), m = document.getElementById('DestBrowseModal');
    if (!IsPhone() && m) { pad.paddingTopLeft = [m.offsetLeft + m.offsetWidth + 40, 60]; pad.paddingBottomRight = [60, 100]; }
    else if (m) pad.paddingBottomRight = [pad.paddingBottomRight[0], m.offsetHeight + 40];
    LMap.flyToBounds(L.latLngBounds(pts), Object.assign(pad, {maxZoom: 14, duration: 0.6}));
}

function RenderDestBrowseModal(activeCat) {
    DestBrowseActiveCat = activeCat;
    var tabsEl = document.getElementById('DestBrowseTabs');
    var gridEl = document.getElementById('DestBrowseGrid');
    if (!tabsEl || !gridEl) return;

    var filterInput = document.getElementById('DestBrowseFilterInput');
    var query = filterInput ? filterInput.value.trim().toLowerCase() : '';
    var isPresent = (CurrentMapMode === 'Present');
    var cats = Object.keys(Destinations).sort();
    var visibleKeys = ComputeVisibleStationKeys();

    var tabsHtml = '<button class="DestBrowseTab' + (activeCat === 'All' ? ' active' : '') + '" onclick="RenderDestBrowseModal(\'All\')">All</button>';
    cats.forEach(function(cat) {
        var cfg = GetDestCategoryConfig(cat);
        var isActive = (activeCat === cat);
        var activeStyle = isActive ? (' style="background:' + cfg.bg + ';border-color:' + cfg.bg + ';box-shadow:0 3px 10px ' + cfg.bg + '55;"') : '';
        tabsHtml += '<button class="DestBrowseTab' + (isActive ? ' active' : '') + '"' + activeStyle + ' onclick="RenderDestBrowseModal(\'' + cat.replace(/'/g, "\\'") + '\')">' +
            '<span class="DestBrowseTabIcon">' + cfg.icon + '</span>' + cat + '</button>';
    });

    tabsEl.innerHTML = tabsHtml;

    var gridHtml = '', listed = [];
    cats.forEach(function(cat) {
        if (activeCat !== 'All' && activeCat !== cat) return;
        var cfg = GetDestCategoryConfig(cat);
        var names = Object.keys(Destinations[cat]).filter(function(name) {
            if (!DestExists(Destinations[cat][name], isPresent ? 'Present' : 'Fantasy')) return false;
            if (query && name.toLowerCase().indexOf(query) === -1) return false;
            return true;
        }).sort();

        if (!names.length) return;

        gridHtml += '<div class="DestBrowseCategoryLabel"><span class="DestBrowseCategoryDot" style="background:' + cfg.bg + '"></span>' +
            cat + '<span class="DestBrowseCategoryCount">' + names.length + '</span></div>';
        gridHtml += '<div class="DestBrowseCards">';
        names.forEach(function(name) {
            var dest = Destinations[cat][name];
            listed.push(cat + '' + name);
            var connected = DestHasVisibleService(dest, visibleKeys);
            var imgFile = DestImageFile(dest);
            var hasImage = !!imgFile;
            var escName = name.replace(/'/g, "\\'");
            var escCat  = cat.replace(/'/g, "\\'");
            var imgTag = hasImage
                ? (function() { var a = ImageAttrs(DEST_IMAGE_BASE, imgFile); return '<img class="DestBrowseCardImage" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy" decoding="async">'; })()
                : '';
            var cardClass = 'DestBrowseCard' + (hasImage ? ' has-image' : '') + (connected ? '' : ' rail-unavailable');
            var onclickAttr = connected ? (' onclick="CommitBrowseSelection(\'' + escCat + '\',\'' + escName + '\')"') : '';
            gridHtml += '<div class="' + cardClass + '"' + onclickAttr + '>' +
                imgTag +
                '<div class="DestBrowseCardIcon" style="background:' + cfg.bg + '">' + cfg.icon + '</div>' +
                '<div class="DestBrowseCardCaption"><span class="DestBrowseCardName">' + name + '</span>' +
                (connected ? '' : '<span class="NoRailBadge">No rail connection</span>') +
                '</div></div>';
        });

        gridHtml += '</div>';
    });

    gridEl.innerHTML = gridHtml || '<div class="DestBrowseEmpty">No destinations found.</div>';
    if (DestBrowseMinimized()) {
        DestExplore = new Set(listed); UpdateDestinationMarkersVisibility();
        clearTimeout(DestExploreFitTimer); DestExploreFitTimer = setTimeout(FitDestExplore, 350);          // after typing settles
    } else if (DestExplore) { DestExplore = null; UpdateDestinationMarkersVisibility(); }
}

function CommitBrowseSelection(cat, name) {
    if (!DestBrowseMinimized()) { SetDestBrowseMinimized(true); clearTimeout(DestExploreFitTimer); }          // the list stays beside the map, to carry on exploring
    ShowDestinationPopup(cat, name, true);
}

function InitProjectBrowseModal() {
    var filterInput = document.getElementById('ProjectBrowseFilterInput');
    if (filterInput) filterInput.addEventListener('input', function() { RenderProjectBrowseModal(filterInput.value); });
}

function CloseProjectBrowseModal() {
    SetModalOpen('ProjectBrowse', false);
}

function RenderProjectBrowseModal(filterQuery) {
    var gridEl = document.getElementById('ProjectBrowseGrid');
    if (!gridEl) return;

    var query = (filterQuery || '').trim().toLowerCase();
    var names = Object.keys(InfoPoints).filter(function(name) {
        return !query || name.toLowerCase().indexOf(query) !== -1;
    }).sort();

    if (!names.length) { gridEl.innerHTML = '<div class="DestBrowseEmpty">No projects found.</div>'; return; }

    var html = '<div class="DestBrowseCards">';
    names.forEach(function(name) {
        var info = InfoPoints[name];
        var escName = name.replace(/'/g, "\\'");
        var hasImage = !!info.Image;
        var imgTag = hasImage
            ? (function() { var a = ImageAttrs(PROJECT_IMAGE_BASE, info.Image); return '<img class="DestBrowseCardImage" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy" decoding="async">'; })()
            : '';
        html += '<div class="DestBrowseCard' + (hasImage ? ' has-image' : '') + '" onclick="CommitProjectBrowseSelection(\'' + escName + '\')">' +
            imgTag +
            '<div class="DestBrowseCardIcon" style="background:#3b82f6"><svg viewBox="0 0 18 18" width="55%" height="55%" fill="none" stroke="#fff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15.5S3.8 10.6 3.8 6.9a5.2 5.2 0 0 1 10.4 0C14.2 10.6 9 15.5 9 15.5Z"/><circle cx="9" cy="6.9" r="1.7"/></svg></div>' +
            '<div class="DestBrowseCardCaption"><span class="DestBrowseCardName">' + name + '</span></div>' +
            '</div>';
    });

    html += '</div>';
    gridEl.innerHTML = html;
}

function CommitProjectBrowseSelection(name) {
    CloseProjectBrowseModal();
    if (ProjectsHidden) ToggleAllProjects();
    ShowInfoPopup(name, true);
}

// Team name -> every venue listing it, across all categories
function BuildTeamVenueIndex() {
    TeamVenueIndex = {};
    Object.keys(Destinations).forEach(function(cat) {
        Object.keys(Destinations[cat]).forEach(function(name) {
            var dest = Destinations[cat][name];
            (dest.Teams || []).forEach(function(team) {
                (TeamVenueIndex[team] = TeamVenueIndex[team] || []).push({cat: cat, name: name, dest: dest});
            });
        });
    });
}

// Station keys served by a visible line in the current view, cached per registry and mode switches
var _visibleKeys = null, _visibleKeysRegistry = null, _visibleKeysSig = null;
function ComputeVisibleStationKeys() {
    var sig = Array.from(DisabledModes).sort().join(',');
    if (_visibleKeysRegistry === Registry && _visibleKeysSig === sig) return _visibleKeys;
    _visibleKeys = new Set(); _visibleKeysRegistry = Registry; _visibleKeysSig = sig;
    Registry.forEach(function(L) { if (!DisabledModes.has(L.ModeId)) L.AllLineStations.forEach(function(k) { _visibleKeys.add(k); }); });
    return _visibleKeys;
}

function DestHasVisibleService(dest, visibleKeys) {
    var explicitKeys = new Set();
    DestStationList(dest).forEach(function(k) {
        var GK = StationGroupMembers(k);
        (GK.length ? GK : [k]).forEach(function(gk) { explicitKeys.add(gk); });
    });

    return Array.from(explicitKeys).some(function(k) { return visibleKeys.has(k); });
}

// The venue a team opens in a view: one that exists and has rail service, preferring one exclusive to the view
function TeamVenueForMode(team, mode, visibleKeys) {
    var matches = (TeamVenueIndex[team] || []).filter(function(m) {
        return DestExists(m.dest, mode) && DestHasVisibleService(m.dest, visibleKeys);
    });

    if (!matches.length) return null;
    if (matches.length === 1) return matches[0];
    matches.sort(function(a, b) { return (a.dest.Exists || []).length - (b.dest.Exists || []).length; });
    return matches[0];
}

function TeamAvailableInMode(team, mode, visibleKeys) {
    return TeamVenueForMode(team, mode, visibleKeys) !== null;
}

// A team's league, found in the league rosters
function FindTeamLeague(team) {
    if (!TeamLeagueIndex[team]) {
        Object.keys(Leagues).some(function(lg) {
            if (Leagues[lg].indexOf(team) !== -1) { TeamLeagueIndex[team] = lg; return true; }
            return false;
        });
    }

    return TeamLeagueIndex[team] || null;
}

var SportsBrowseCurrentLeague = null;

function OpenSportsBrowseModal() {
    SetModalOpen('SportsBrowse', true);
    SportsBrowseCurrentLeague = null;
    RenderSportsModeToggle();
    RenderSportsLeagueGrid();
}

function CloseSportsBrowseModal() {
    SetModalOpen('SportsBrowse', false);
}

// The picker's Present / Future switch changes the whole map, then re-renders the open picker
function RenderSportsModeToggle() {
    var el = document.getElementById('SportsModeToggle');
    if (!el) return;
    el.innerHTML = ModeToggleHtml('SetSportsBrowseMode');
}

function SetSportsBrowseMode(mode) {
    if (CurrentMapMode !== mode) SwitchMapMode(mode);
    RenderSportsModeToggle();
    if (SportsBrowseCurrentLeague) RenderSportsTeamGrid(SportsBrowseCurrentLeague);
    else RenderSportsLeagueGrid();
}

function BackToSportsLeagues() {
    SportsBrowseCurrentLeague = null;
    RenderSportsLeagueGrid();
}

function RenderSportsLeagueGrid() {
    var tabsEl = document.getElementById('SportsBrowseTabs');
    var gridEl = document.getElementById('SportsBrowseGrid');
    if (!tabsEl || !gridEl) return;
    tabsEl.innerHTML = '';

    var leagues = Object.keys(Leagues).sort();
    var gridHtml = '<div class="DestBrowseCards">';
    leagues.forEach(function(lg) {
        var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(lg), '_Logo');
        var escLg = lg.replace(/'/g, "\\'");
        gridHtml += '<div class="DestBrowseCard logo-card" onclick="RenderSportsTeamGrid(\'' + escLg + '\')">' +
            '<img class="DestBrowseCardImage" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy" decoding="async">' +
            '<div class="DestBrowseCardCaption"><span class="DestBrowseCardName">' + lg + '</span></div>' +
            '</div>';
    });

    gridHtml += '</div>';
    gridEl.innerHTML = leagues.length ? gridHtml : '<div class="DestBrowseEmpty">No leagues found.</div>';
}

function RenderSportsTeamGrid(league) {
    SportsBrowseCurrentLeague = league;
    var tabsEl = document.getElementById('SportsBrowseTabs');
    var gridEl = document.getElementById('SportsBrowseGrid');
    if (!tabsEl || !gridEl) return;
    var escLg = league.replace(/'/g, "\\'");
    tabsEl.innerHTML = '<button class="DestBrowseTab" onclick="BackToSportsLeagues()">‹ All Leagues</button>' +
        '<button class="DestBrowseTab active">' + league + '</button>' +
        '<button class="DestBrowseTab LeagueMapSwitch" style="margin-left:auto;" onclick="ToggleLeagueFromBrowser(\'' + escLg + '\')" title="Show or hide all of this league\'s teams on the map">' +
            'Show all on map <span class="InlineToggleSwitch accent-green' + (ActiveSportsLeagues.has(league) ? ' active' : '') + '"><span class="InlineToggleKnob"></span></span></button>';

    var mode = CurrentMapMode;
    var visibleKeys = ComputeVisibleStationKeys();
    var teams = (Leagues[league] || []).slice().sort();
    var gridHtml = '<div class="DestBrowseCards">';
    teams.forEach(function(team) {
        var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team);
        var escTeam = team.replace(/'/g, "\\'");
        var available = TeamAvailableInMode(team, mode, visibleKeys);
        var cardClass = 'DestBrowseCard logo-card' + (available ? '' : ' rail-unavailable');
        var onclickAttr = available ? (' onclick="SelectSportsTeam(\'' + escLg + '\',\'' + escTeam + '\')"') : '';
        gridHtml += '<div class="' + cardClass + '"' + onclickAttr + '>' +
            '<img class="DestBrowseCardImage" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy" decoding="async">' +
            '<div class="DestBrowseCardCaption"><span class="DestBrowseCardName">' + team + '</span>' +
            (available ? '' : '<span class="NoRailBadge">Not accessible by rail</span>') +
            '</div></div>';
    });

    gridHtml += '</div>';
    gridEl.innerHTML = teams.length ? gridHtml : '<div class="DestBrowseEmpty">No teams found.</div>';
}

// Opens the venue for a team in the current view
function SelectSportsTeam(league, team) {
    var mode = CurrentMapMode;
    var match = TeamVenueForMode(team, mode, ComputeVisibleStationKeys());
    if (!match) return;
    CloseSportsBrowseModal();
    // Just the venue panel; no markers are switched on
    SplashVenueForTeam = true;
    ShowDestinationPopup(match.cat, match.name, true);
}

function MakeTeamMarkerIcon(logoSrc, logoExtra, available) {
    var S = 44;
    var faded = available ? '' : 'filter:grayscale(1);opacity:0.5;';
    var badge = available ? '' :
        '<div style="position:absolute;bottom:-3px;right:-3px;width:17px;height:17px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:flex;align-items:center;justify-content:center;">' +
        '<svg viewBox="0 0 18 18" width="9" height="9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5"/></svg></div>';
    // Just the logo, with a soft shadow so light logos still read
    var html = '<div style="position:relative;width:' + S + 'px;height:' + S + 'px;">' +
        '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;cursor:' + (available ? 'pointer' : 'default') + ';' + faded + '">' +
            '<img src="' + logoSrc + '" ' + logoExtra + ' style="width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 1px 1.5px rgba(15,23,42,0.45)) drop-shadow(0 0 1px rgba(255,255,255,0.9));" alt="">' +
        '</div>' + badge +
        '</div>';
    return L.divIcon({html: html, className: 'TeamMarkerIcon', iconSize: [S, S], iconAnchor: [S / 2, S / 2]});
}

// Where an unreachable team is still shown greyed out: a venue that exists in this view if possible
function TeamVenueFallback(team, mode) {
    var all = TeamVenueIndex[team] || [];
    if (!all.length) return null;
    var existsHere = all.filter(function(m) { return DestExists(m.dest, mode); });
    var pool = (existsHere.length ? existsHere : all).slice();
    pool.sort(function(a, b) { return (a.dest.Exists || []).length - (b.dest.Exists || []).length; });
    return pool[0];
}

// Puts a league's teams on the map at their venues, greyed out where unreachable
function AddLeagueMarkers(league) {
    RemoveLeagueMarkers(league);
    var mode = CurrentMapMode;
    var visibleKeys = ComputeVisibleStationKeys();
    var markers = [];
    var placedAvailable = 0, placedTotal = 0;

    (Leagues[league] || []).forEach(function(team) {
        var match = TeamVenueForMode(team, mode, visibleKeys);
        var available = !!match;
        if (!match) match = TeamVenueFallback(team, mode);
        if (!match) return;

        var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team);
        var icon = MakeTeamMarkerIcon(a.src, a.extra, available);
        var tooltip = team + (available ? '' : ' · Not accessible by rail');
        var onClick = available ? function() { SelectSportsTeam(league, team); } : function() {};
        var layers = BuildPinMarker('team:' + league + '|' + team, match.dest.Location, icon, tooltip, available ? '#1e293b' : '#94a3b8', onClick, 44);
        AddMarkerLayers(layers);
        markers.push(layers);
        placedTotal++;
        if (available) placedAvailable++;
    });

    TeamMapMarkersByLeague[league] = markers;
    ResolveMarkerCollisions();
    return {available: placedAvailable, total: placedTotal};
}

function RemoveLeagueMarkers(league) {
    var markers = TeamMapMarkersByLeague[league];
    if (!markers) return;
    markers.forEach(function(layers) {
        RemoveMarkerLayers(layers);
        delete MarkerSim[layers.simId];
    });

    delete TeamMapMarkersByLeague[league];
}

function SetLeagueMarkersVisible(league, visible) {
    if (visible) {
        ActiveSportsLeagues.add(league);
        AddLeagueMarkers(league);
    } else {
        ActiveSportsLeagues.delete(league);
        RemoveLeagueMarkers(league);
    }

    UpdateSportsSwitchUI();
    UpdateSportsOverlayBadge();
}

function ClearAllLeagueMarkers() {
    Array.from(ActiveSportsLeagues).forEach(function(lg) { RemoveLeagueMarkers(lg); });
    ActiveSportsLeagues.clear();
    UpdateSportsSwitchUI();
    UpdateSportsOverlayBadge();
}

function UpdateSportsSwitchUI() {
    SyncLeagueRack();
}

function UpdateSportsOverlayBadge() {
    var badge = document.getElementById('SportsOverlayBadge');
    var badgeText = document.getElementById('SportsOverlayBadgeText');
    if (!badge || !badgeText) return;
    var leagues = Array.from(ActiveSportsLeagues);
    if (!leagues.length) { badge.style.display = 'none'; return; }

    var totalTeams = 0;
    leagues.forEach(function(lg) { totalTeams += (TeamMapMarkersByLeague[lg] || []).length; });
    badgeText.textContent = leagues.length === 1
        ? (leagues[0] + ' — ' + totalTeams + (totalTeams === 1 ? ' team' : ' teams') + ' on map')
        : (leagues.length + ' leagues — ' + totalTeams + ' teams on map');
    badge.style.display = 'flex';
}

// The Sports Teams window's switch: flips the league on or off the map and stays open
function ToggleLeagueFromBrowser(league) {
    SetLeagueMarkersVisible(league, !ActiveSportsLeagues.has(league));
    var sw = document.querySelector('#SportsBrowseTabs .LeagueMapSwitch .InlineToggleSwitch');
    if (sw) sw.classList.toggle('active', ActiveSportsLeagues.has(league));
}

function BuildAllStationGroups(filterQuery) {
    // Station groups with the lines serving them, from the cached station -> lines index
    var linesByStation = GetLinesByStation();
    var lineById = {};
    Registry.forEach(function(L) { lineById[L.Id] = L; });

    var Groups = {};
    Object.keys(StationSearchIndex).forEach(function(Key) {
        var served = linesByStation[Key];
        if (!served) return;
        var Base = StationGroupBase(Key);
        if (!Groups[Base]) Groups[Base] = {Base: Base, Keys: [], Labels: [], LineIds: new Set(), Region: null};
        Groups[Base].Keys.push(Key);
        var memberRegion = StationSearchIndex[Key].Region;
        if (!Groups[Base].Region && memberRegion && memberRegion.length) Groups[Base].Region = memberRegion;
        var memberLabel = CleanStationName(StationSearchIndex[Key].Label || Key);
        if (!Groups[Base].Labels.includes(memberLabel)) Groups[Base].Labels.push(memberLabel);
        served.lines.forEach(function(id) { Groups[Base].LineIds.add(id); });
    });

    var qn = filterQuery ? NormalizeSearchText(filterQuery) : '';

    return Object.values(Groups)
        .map(function(G) {
            G.Label = StationGroupLabel(G.Base);
            return G;
        })
        .filter(function(G) { return !qn || NormalizeSearchText(G.Label).includes(qn); })
        .map(function(G) {
            // Only lines of switched-on modes; stations served only by hidden modes drop out
            var lines = Array.from(G.LineIds).map(function(id) { return lineById[id]; })
                .filter(function(L) { return L && !DisabledModes.has(L.ModeId); });
            return {Label: G.Label, Key: G.Keys[0], Lines: lines, Region: G.Region};
        })
        .filter(function(G) { return G.Lines.length > 0; })
        .sort(function(a, b) { return a.Label.localeCompare(b.Label); });
}

function InitStationBrowseModal() {
    var filterInput = document.getElementById('StationBrowseFilterInput');
    if (filterInput) {
        var debouncedRender = Debounce(function() { RenderStationBrowseModal(filterInput.value); }, 80);
        filterInput.addEventListener('input', debouncedRender);
    }
}

function OpenStationBrowseModal() {
    var filterInput = document.getElementById('StationBrowseFilterInput');
    SetModalOpen('StationBrowse', true);
    if (filterInput) { filterInput.value = ''; setTimeout(function() { filterInput.focus(); }, 50); }
    RenderStationBrowseModal('');
}

function CloseStationBrowseModal() {
    SetModalOpen('StationBrowse', false);
}

// Region [city, subdivision, country] as text plus a flag that hides itself if missing
function StationRegionHtml(region) {
    if (!region || !region.length) return '';
    var place = [region[0], region[1]].filter(Boolean).join(', ');
    var country = region[2];
    var img = '';
    if (country) {
        img = '<img class="StationBrowseFlag" src="' + FLAG_IMAGE_BASE + '/' + encodeURIComponent(country) + '.webp"' +
            ' alt="" title="' + EscapeHtml(country).replace(/"/g, '&quot;') + '" loading="lazy" onerror="this.style.display=\'none\'">';
    }

    // The flag slot is always emitted so the place text stays aligned
    return '<span class="StationBrowseFlagSlot">' + img + '</span>' +
        (place ? '<span class="StationBrowseAreaText" title="' + EscapeHtml(place).replace(/"/g, '&quot;') + '">' + EscapeHtml(place) + '</span>' : '');
}

var STATION_BROWSE_PILLS = 5;   // line pills per row before "+N"
var StationBrowseSort = 'name'; // 'name' (A-Z) or 'city' (busiest city first)

function RenderStationBrowseModeToggle() {
    var el = document.getElementById('StationBrowseModeToggle');
    if (!el) return;
    el.innerHTML = ModeToggleHtml('SetStationBrowseView');
}

// The station window's Present / Future switch changes the whole map
function SetStationBrowseView(mode) {
    if (CurrentMapMode !== mode) SwitchMapMode(mode);
    RenderStationBrowseModeToggle();
}

// Collapsed letter / city groups, remembered per sort
var StationBrowseCollapsed = { name: new Set(), city: new Set() };

function ToggleStationGroup(details) {
    var key = details.getAttribute('data-group');
    var set = StationBrowseCollapsed[StationBrowseSort];
    // 'toggle' fires after the change: open means it was just expanded.
    if (details.open) set.delete(key); else set.add(key);
    SyncCollapseAllLabel('StationBrowseList', 'StationCollapseAll');
}

function SetStationBrowseSort(sort) {
    StationBrowseSort = sort;
    document.querySelectorAll('.StationSortSwitch button').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-sort') === sort);
    });

    var list = document.getElementById('StationBrowseList');
    if (list) list.scrollTop = 0;
    var input = document.getElementById('StationBrowseFilterInput');
    RenderStationBrowseModal(input ? input.value : '');
}

// The window's mode chips use the same DisabledModes as the sidebar
function RenderStationModeChips() { RenderModeChips('StationModeChips'); }

function RenderModeChips(hostId) {
    var host = document.getElementById(hostId);
    if (!host) return;
    var present = {};
    Registry.forEach(function(L) { present[L.ModeId] = (present[L.ModeId] || 0) + 1; });
    host.innerHTML = Object.keys(Modes).filter(function(m) { return present[m]; }).map(function(m) {
        var on = !DisabledModes.has(m);
        return '<button class="StationModeChip' + (on ? ' on' : '') + '" style="--mode:' + Modes[m].Color + '" ' +
            'onclick="ToggleMode(' + EscapeHtml(OmniJs(m)) + ')" aria-pressed="' + on + '" title="' + (on ? 'Hide ' : 'Show ') + EscapeHtml(Modes[m].Name) + '">' +
            '<span class="StationModeDot"></span>' + EscapeHtml(Modes[m].Name) + '</button>';
    }).join('');
}

// First letter for the A-Z headers, without accents ("É" files under E).
function StationLetter(label) {
    var c = String(label).normalize('NFD').replace(/[\u0300-\u036f]/g, '').charAt(0).toUpperCase();
    return /[A-Z]/.test(c) ? c : '#';
}

function StationRowHtml(g, showArea) {
    var shown = g.Lines.slice(0, STATION_BROWSE_PILLS);
    var more = g.Lines.length - shown.length;
    var pillsHtml = shown.map(function(line) {
        return '<span class="StationSearchPill" style="background:' + line.Color + '">' + EscapeHtml(line.Name) + '</span>';
    }).join('') + (more > 0 ? '<span class="StationSearchPill more" title="' +
        EscapeHtml(g.Lines.slice(STATION_BROWSE_PILLS).map(function(l) { return l.Name; }).join(', ')) + '">+' + more + '</span>' : '');
    return '<div class="StationBrowseRow StationListRow" onclick="CommitStationBrowseSelection(' + EscapeHtml(OmniJs(g.Key)) + ')">' +
        '<div class="StationListMain">' +
            '<div class="StationBrowseRowName">' + EscapeHtml(g.Label) + '</div>' +
            (showArea ? '<div class="StationBrowseRowArea">' + StationRegionHtml(g.Region) + '</div>' : '') +
        '</div>' +
        '<div class="StationSearchLines">' + pillsHtml + '</div>' +
    '</div>';
}

function RenderStationBrowseModal(filterQuery) {
    var listEl = document.getElementById('StationBrowseList');
    if (!listEl) return;
    RenderStationModeChips();

    var groups = BuildAllStationGroups(filterQuery);
    var countEl = document.getElementById('StationBrowseCount');
    if (countEl) countEl.textContent = groups.length.toLocaleString() + (filterQuery ? ' found' : '');
    if (!groups.length) {
        listEl.innerHTML = '<div class="StationBrowseEmpty">No stations match “' + EscapeHtml(filterQuery || '') + '”</div>';
        return;
    }

    RenderStationBrowseModeToggle();
    var html = [];
    var collapsed = StationBrowseCollapsed[StationBrowseSort];
    var chevron = '<span class="StationGroupChevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>';
    function openGroup(key, headerClass, headerHtml) {
        html.push('<details class="StationGroup" data-group="' + EscapeHtml(key) + '"' + (collapsed.has(key) ? '' : ' open') +
            ' ontoggle="ToggleStationGroup(this)"><summary class="StationBrowseLetterHeader' + headerClass + '">' + chevron + headerHtml + '</summary>');
    }

    if (StationBrowseSort === 'city') {
        // Cities with the most stations first, stations alphabetical within; rows don't repeat the city
        var cities = {};
        groups.forEach(function(g) {
            var r = g.Region || [];
            var key = r[0] ? r[0] + '|' + (r[1] || '') : '';
            (cities[key] = cities[key] || { region: r, stations: [] }).stations.push(g);
        });

        Object.keys(cities).sort(function(a, b) {
            if (!a || !b) return a ? -1 : 1;   // stations with no city go last
            return cities[b].stations.length - cities[a].stations.length || a.localeCompare(b);
        }).forEach(function(key) {
            var c = cities[key];
            openGroup(key || '(none)', ' city',
                (key ? StationRegionHtml(c.region) : '<span class="StationBrowseAreaText">Elsewhere</span>') +
                '<span class="StationCityCount">' + c.stations.length + '</span>');
            c.stations.forEach(function(g) { html.push(StationRowHtml(g, false)); });
            html.push('</details>');
        });
    } else {
        var byLetter = {}, order = [];
        groups.forEach(function(g) {
            var letter = StationLetter(g.Label);
            if (!byLetter[letter]) { byLetter[letter] = []; order.push(letter); }
            byLetter[letter].push(g);
        });

        order.forEach(function(letter) {
            openGroup(letter, '', '<span class="StationLetterText">' + letter + '</span>' +
                '<span class="StationCityCount">' + byLetter[letter].length + '</span>');
            byLetter[letter].forEach(function(g) { html.push(StationRowHtml(g, true)); });
            html.push('</details>');
        });
    }

    listEl.innerHTML = html.join('');
    SyncCollapseAllLabel('StationBrowseList', 'StationCollapseAll');
}

// Collapse all / Expand all for a window's groups
function ToggleBrowseGroups(listId, collapsed, btnId) {
    var groups = document.querySelectorAll('#' + listId + ' details.StationGroup');
    var anyOpen = Array.prototype.some.call(groups, function(d) { return d.open; });
    groups.forEach(function(d) {
        var key = d.getAttribute('data-group');
        d.open = !anyOpen;
        if (anyOpen) collapsed.add(key); else collapsed.delete(key);
    });

    var btn = document.getElementById(btnId);
    if (btn) btn.textContent = anyOpen ? 'Expand all' : 'Collapse all';
}

function SyncCollapseAllLabel(listId, btnId) {
    var btn = document.getElementById(btnId);
    if (!btn) return;
    var groups = document.querySelectorAll('#' + listId + ' details.StationGroup');
    var anyOpen = !groups.length || Array.prototype.some.call(groups, function(d) { return d.open; });
    btn.textContent = anyOpen ? 'Collapse all' : 'Expand all';
}

function CommitStationBrowseSelection(key) {
    CloseStationBrowseModal();
    ShowStationPopupFromSearch(key);
}

function EnsureRegistryLayersCreated(registryArray) {
    registryArray.forEach(function(entry) {
        if (LineLayers[entry.Id]) return;
        var layer = CreateLeafletLayer(entry);
        if (!layer) return;
        LineLayers[entry.Id] = layer;
    });
}

// The simplified and detailed maps share no data; the switch swaps one dataset for the other
var LineDetail = 'simple';
var DataSets = {};
// Always opens Simplified; the choice is deliberately not remembered between visits.

function SetLineDetail(mode) {
    mode = mode === 'simple' ? 'simple' : 'detailed';
    if (mode === LineDetail || !DataSets[mode]) return;
    var map = LMap;
    Reset();
    if (CurrentStationPopup) CloseStationPopup();
    [RegistryFantasy, RegistryPresent].forEach(function(R) {
        (R || []).forEach(function(entry) {
            var layer = LineLayers[entry.Id];
            if (layer) { map.removeLayer(layer); delete LineLayers[entry.Id]; }
        });
    });

    Object.keys(StationMarkers).forEach(function(K) { map.removeLayer(StationMarkers[K]); delete StationMarkers[K]; });
    LineDetail = mode;
    var D = DataSets[mode];
    RegistryFantasy = D.Fantasy; RegistryPresent = D.Present;
    NamedStations = D.Stations; AllNodes = D.Nodes; Stations = AllNodes;
    Modes = D.Modes; ModesOrder = Modes; StationSearchIndex = D.Search || (D.Search = BuildSearchIndex(D.Stations, [D.Fantasy, D.Present]));          // the detailed map's is built when it is first shown
    DisabledModes = new Set();
    _StationGroupIndex = null; _linesByStationCache = null; OmniIndex = null; _altGroups = null;
    if (D.Destinations) {                                  // the venues are the same places; each map has its own stations serving them (and its own Present / Future)
        if (CurrentStationPopup === '__destination__') CloseDestinationPopup();
        Destinations = D.Destinations; BuildTeamVenueIndex(); RenderDestinationMarkers();
    }

    UpdateLineDetailButtons();
    ApplySwitchedRegistry();
    ApplyViewLabels();
    BuildByMode();
    RefreshStationDots();
    RefreshStationListings();      // the sidebar's station list and count belong to this map too, not the one just left
}

function UpdateLineDetailButtons() {
    var box = document.getElementById('LineDetailSwitch');
    if (!box) return;
    box.style.display = DataSets.detailed ? '' : 'none';
    var simple = document.getElementById('LineDetailSimple'), detailed = document.getElementById('LineDetailDetailed');
    if (simple) { simple.classList.toggle('active', LineDetail === 'simple'); simple.setAttribute('aria-pressed', LineDetail === 'simple'); }
    if (detailed) { detailed.classList.toggle('active', LineDetail === 'detailed'); detailed.setAttribute('aria-pressed', LineDetail === 'detailed'); }
}

function CreateLeafletLayer(entry) {
    if (!entry.Geometry || entry.Geometry.Type !== 'polyline') return null;
    var layer = L.polyline(entry.Geometry.Coords, {color: entry.Color, weight: entry.Weight, opacity: 1.0, lineJoin: 'round', lineCap: 'round', smoothFactor: 1.5, interactive: false});
    layer.addTo(LMap);
    if (layer.setZIndex) layer.setZIndex(entry.ZIndex);
    return layer;
}

// Line hover: the line under the cursor is picked by screen distance, weighed by how much its mode matters at this zoom
var HOVER_GRID_PX = 48, HOVER_PAD_PX = 4, HOVER_MIN_PX = 6, HOVER_SETTLE_ZOOMS = 3, HOVER_NEW_MODE_PX = 3, HOVER_STICKY_PX = 6, HOVER_LEAVE_MS = 140;
var _hoverSegs = null, _hoverSegsRegistry = null, _hoverGrid = null, HoverLine = null, _hoverLayer = null, _hoverTip = null, _hoverRaf = null, _hoverEvent = null;

// Every segment of the current view's lines in zoom-0 Web Mercator pixels, built once per registry
function HoverSegments() {
    if (_hoverSegsRegistry === Registry && _hoverSegs) return _hoverSegs;
    var n = 0;
    Registry.forEach(function(Ln) { (Ln.Geometry ? Ln.Geometry.Coords : []).forEach(function(pl) { n += Math.max(0, pl.length - 1); }); });
    var xy = new Float64Array(n * 4), line = new Int32Array(n), k = 0;
    var px = function(p) { return [(p[1] + 180) / 360 * 256, (1 - Math.log(Math.tan(Math.PI / 4 + p[0] * Math.PI / 360)) / Math.PI) / 2 * 256]; };
    Registry.forEach(function(Ln, li) {
        (Ln.Geometry ? Ln.Geometry.Coords : []).forEach(function(pl) {
            var prev = pl.length ? px(pl[0]) : null;
            for (var i = 1; i < pl.length; i++) {
                var cur = px(pl[i]);
                xy[k * 4] = prev[0]; xy[k * 4 + 1] = prev[1]; xy[k * 4 + 2] = cur[0]; xy[k * 4 + 3] = cur[1]; line[k] = li; k++;
                prev = cur;
            }
        });
    });

    _hoverSegs = {xy: xy, line: line, n: k}; _hoverSegsRegistry = Registry; _hoverGrid = null;
    return _hoverSegs;
}

// The segments near the view, bucketed by screen cell; rebuilt when the map stops moving
function HoverGrid() {
    if (_hoverGrid && _hoverGrid.registry === Registry && _hoverGrid.zoom === LMap.getZoom()) return _hoverGrid;
    var S = HoverSegments(), zoom = LMap.getZoom(), scale = Math.pow(2, zoom), cell = HOVER_GRID_PX / scale, b = LMap.getPixelBounds();
    var pad = (b.max.x - b.min.x) * 0.5, x0 = (b.min.x - pad) / scale, y0 = (b.min.y - pad) / scale, x1 = (b.max.x + pad) / scale, y1 = (b.max.y + pad) / scale;
    var cells = new Map();
    for (var k = 0; k < S.n; k++) {
        var ax = S.xy[k * 4], ay = S.xy[k * 4 + 1], bx = S.xy[k * 4 + 2], by = S.xy[k * 4 + 3];
        var lx = Math.max(Math.min(ax, bx), x0), hx = Math.min(Math.max(ax, bx), x1), ly = Math.max(Math.min(ay, by), y0), hy = Math.min(Math.max(ay, by), y1);
        if (lx > hx || ly > hy) continue;
        for (var i = Math.floor(lx / cell); i <= Math.floor(hx / cell); i++)
            for (var j = Math.floor(ly / cell); j <= Math.floor(hy / cell); j++) {
                var key = i + ',' + j, list = cells.get(key);
                if (list) list.push(k); else cells.set(key, [k]);
            }
    }

    _hoverGrid = {registry: Registry, zoom: zoom, cell: cell, cells: cells, box: [x0, y0, x1, y1]};
    return _hoverGrid;
}

// How far below its own scale a mode is at this zoom: null = not hoverable yet, else extra pixels it must beat
function ModeHoverPenalty(modeId, zoom) {
    var md = Modes[modeId];
    if (!md || md.MajorZoom == null) return 0;
    var past = zoom - md.MajorZoom;
    if (past < -1) return null;
    return Math.max(0, HOVER_SETTLE_ZOOMS - past) * HOVER_NEW_MODE_PX;
}

// The line a pointer at latlng means, with the other lines running the same way there: {line, others} or null
function PickLine(latlng) {
    if (!LMap || !Registry || !Registry.length) return null;
    var G = HoverGrid(), S = _hoverSegs, zoom = LMap.getZoom(), scale = Math.pow(2, zoom), p = LMap.project(latlng, 0);
    if (p.x < G.box[0] || p.x > G.box[2] || p.y < G.box[1] || p.y > G.box[3]) return null;
    var best = {}, reach = (HOVER_MIN_PX + 12) / scale;
    for (var i = Math.floor((p.x - reach) / G.cell); i <= Math.floor((p.x + reach) / G.cell); i++)
        for (var j = Math.floor((p.y - reach) / G.cell); j <= Math.floor((p.y + reach) / G.cell); j++) (G.cells.get(i + ',' + j) || []).forEach(function(k) {
            var ax = S.xy[k * 4], ay = S.xy[k * 4 + 1], dx = S.xy[k * 4 + 2] - ax, dy = S.xy[k * 4 + 3] - ay, L2 = dx * dx + dy * dy;
            var t = L2 ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L2)) : 0;
            var d = Math.hypot(p.x - ax - t * dx, p.y - ay - t * dy) * scale, li = S.line[k];
            if (best[li] === undefined || d < best[li]) best[li] = d;
        });

    var cands = [];
    Object.keys(best).forEach(function(li) {
        var Ln = Registry[li];
        if (!Ln || DisabledModes.has(Ln.ModeId)) return;
        var pen = ModeHoverPenalty(Ln.ModeId, zoom), w = SelectedId === Ln.Id ? Ln.Weight * 3 : Ln.Weight, held = HoverLine && HoverLine.Id === Ln.Id ? HOVER_STICKY_PX : 0;
        if (pen === null || best[li] > Math.max(HOVER_MIN_PX, w / 2 + HOVER_PAD_PX) + held) return;          // the line already hovered holds on a little further, so its edge does not flicker
        cands.push({line: Ln, d: best[li], score: best[li] + pen - held / 2});
    });

    if (!cands.length) return null;
    cands.sort(function(a, b) { return a.score - b.score || a.line.ZIndex - b.line.ZIndex; });
    var top = cands[0];
    return {line: top.line, others: cands.slice(1).filter(function(c) { return c.line.ModeId === top.line.ModeId && Math.abs(c.d - top.d) < 2; }).map(function(c) { return c.line; })};
}

function LineHoverHtml(pick) {
    var Ln = pick.line, md = Modes[Ln.ModeId] || {};
    var row = function(L2) { return "<div class='HubLineContent'><span class='HubDot' style='background:" + L2.Color + "'></span><span><span class='OpTag'>" + EscapeHtml(L2.Operator) + "</span><span class='Separator'>•</span>" + EscapeHtml(L2.Name) + '</span></div>'; };
    var html = "<div class='StationPopup'><b>" + EscapeHtml(Ln.Name) + "</b><div class='ModeHeader'>" + EscapeHtml(md.Name || Ln.ModeName || '') + '</div>' + row(Ln);
    if (pick.others.length) html += "<div class='ModeHeader'>Also on this track</div>" + pick.others.slice(0, 4).map(row).join('') + (pick.others.length > 4 ? "<div class='HubLineContent'>+" + (pick.others.length - 4) + ' more</div>' : '');
    return html + "<div class='LineHoverHint'>Click to open</div></div>";
}

// While a line is hovered only its own stations stay on the map (Ln null: every station again)
function ShowHoverStations(Ln) {
    var on = Ln ? new Set(Ln.AllLineStations.map(StationGroupBase)) : null;
    Object.keys(StationMarkers).forEach(function(sn) {
        var m = StationMarkers[sn], el = m && m._icon;
        if (!el) return;
        var mine = !on || (m._members || [sn]).some(function(k) { return on.has(StationGroupBase(k)); });
        el.classList.toggle('hover-off', !mine);
    });
}

var _hoverHtml = '', _hoverLeave = null;
function ClearLineHover() {
    clearTimeout(_hoverLeave); _hoverLeave = null; _hoverHtml = '';
    if (HoverLine) ShowHoverStations(null);
    if (_hoverLayer) { LMap.removeLayer(_hoverLayer); _hoverLayer = null; }
    if (_hoverTip) { LMap.closeTooltip(_hoverTip); _hoverTip = null; }
    if (HoverLine && LMap) LMap.getContainer().classList.remove('line-hover');
    HoverLine = null;
}

function ShowLineHover(pick, latlng) {
    if (!HoverLine || HoverLine.Id !== pick.line.Id) {
        ClearLineHover();
        var Ln = pick.line, w = (SelectedId === Ln.Id ? Ln.Weight * 3 : Ln.Weight) + 3;
        _hoverLayer = L.layerGroup([
            L.polyline(Ln.Geometry.Coords, {pane: 'lineHoverPane', color: '#fff', weight: w + 5, opacity: 0.9, lineCap: 'round', lineJoin: 'round', interactive: false}),
            L.polyline(Ln.Geometry.Coords, {pane: 'lineHoverPane', color: Ln.Color, weight: w, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false}),
        ]).addTo(LMap);

        _hoverTip = L.tooltip({direction: 'top', offset: [0, -14], className: 'StationTooltip LineHoverTip', pane: 'hoverTooltipPane'});
        HoverLine = Ln; LMap.getContainer().classList.add('line-hover'); ShowHoverStations(Ln);
    }

    clearTimeout(_hoverLeave); _hoverLeave = null;
    var html = LineHoverHtml(pick);
    if (html !== _hoverHtml) { _hoverTip.setContent(html); _hoverHtml = html; }          // the card is only redrawn when what it says changes
    _hoverTip.setLatLng(latlng); if (!LMap.hasLayer(_hoverTip)) LMap.openTooltip(_hoverTip);
}

// Pointer over a station dot, a pin or a panel: those have their own tooltips
function OverMarker(ev) {
    var t = ev && ev.target;
    return !!(t && t.closest && t.closest('.leaflet-marker-icon, .leaflet-tooltip, .leaflet-popup, .leaflet-control, path.leaflet-interactive'));
}

function OnLineHoverMove(e) {
    _hoverEvent = e;
    if (_hoverRaf) return;
    _hoverRaf = requestAnimationFrame(function() {
        _hoverRaf = null;
        var ev = _hoverEvent;
        if (!ev || OverMarker(ev.originalEvent)) { ClearLineHover(); return; }
        var pick = PickLine(ev.latlng);
        if (pick) ShowLineHover(pick, ev.latlng);
        else if (HoverLine && !_hoverLeave) _hoverLeave = setTimeout(ClearLineHover, HOVER_LEAVE_MS);          // a moment's slip off the line does not drop the hover
    });
}

function InitLineHover() {
    LMap.createPane('lineHoverPane');
    LMap.getPane('lineHoverPane').style.zIndex = 610;
    LMap.getPane('lineHoverPane').style.pointerEvents = 'none';
    LMap.on('mousemove', OnLineHoverMove);
    LMap.on('mouseout movestart zoomstart', function() { _hoverEvent = null; ClearLineHover(); });
    LMap.on('moveend', function() { _hoverGrid = null; });
}

// The station search: every named station with the lines that serve it (one entry per line and map), built here from what the page already has
function BuildSearchIndex(named, registries) {
    var index = {}, clean = function(k) { var cut = [' [', ' (', ' {'].map(function(s) { return k.indexOf(s); }).filter(function(i) { return i !== -1; }); return cut.length ? k.slice(0, cut[0]) : k; };
    Object.keys(named).forEach(function(key) {
        var d = named[key], e = {Label: d.Label || clean(key), Location: d.Location || [0, 0], Lines: []};
        if (d.Region) e.Region = d.Region.slice();
        index[key] = e;
    });

    registries.forEach(function(reg) {
        reg.forEach(function(L) {
            var line = {Name: L.Name || '', Operator: L.Operator || '', Color: L.Color || '#888', Id: L.Id || ''};
            (L.AllLineStations || []).forEach(function(sk) {
                var e = index[sk];
                if (e && !e.Lines.some(function(l) { return l.Id === line.Id; })) e.Lines.push(Object.assign({}, line));          // by id: a line on both maps is one entry per map
            });
        });
    });

    return index;
}

function initializeMap(mapName, registryFantasy, registryPresent, namedStations, extraNodes, modes, basemapLayerNames, infoPoints, destinations, leagues, detailed) {
    LMap = window[mapName];
    LMap.createPane('stationDotPane');
    LMap.getPane('stationDotPane').style.zIndex = 650;
    LMap.createPane('stationGroupPane');
    LMap.getPane('stationGroupPane').style.zIndex = 620;
    LMap.createPane('destMarkerPane');
    LMap.getPane('destMarkerPane').style.zIndex = 700;
    LMap.createPane('hoverTooltipPane');
    LMap.getPane('hoverTooltipPane').style.zIndex = 1000;
    InitLineHover();
    var popupContentEl = document.getElementById('PopupContent');
    if (popupContentEl) popupContentEl.addEventListener('wheel', function(e) { e.stopPropagation(); }, {passive: true});
    RegistryFantasy = registryFantasy;
    RegistryPresent = registryPresent;
    Registry = RegistryFantasy;
    NamedStations = namedStations;
    var allNodes = Object.assign({}, namedStations, extraNodes);          // the stations are sent once: the other nodes are added to them here
    AllNodes = allNodes;
    Stations = AllNodes;
    Modes = modes;
    ModesOrder = Modes;
    InfoPoints = infoPoints || {};
    StationSearchIndex = BuildSearchIndex(namedStations, [registryFantasy, registryPresent]);
    DataSets = {simple: {Fantasy: registryFantasy, Present: registryPresent, Stations: namedStations, Nodes: allNodes, Modes: modes, Search: StationSearchIndex}};
    if (detailed) DataSets.detailed = Object.assign(detailed, {Nodes: Object.assign({}, detailed.Stations, detailed.Nodes)});

    MarkMapInitialized();

    UpdateLineDetailButtons();
    ApplySwitchedRegistry();
    ApplyViewLabels();

    BasemapLayers['Light'] = basemapLayerNames.Light;
    BasemapLayers['Dark'] = basemapLayerNames.Dark;
    BasemapLayers['Satellite'] = basemapLayerNames.Satellite;

    if (BasemapLayers['Dark']) LMap.removeLayer(BasemapLayers['Dark']);
    if (BasemapLayers['Satellite']) LMap.removeLayer(BasemapLayers['Satellite']);

    RenderInfoMarkers();
    UpdateProjectMarkersVisibility();
    var projectBadge = document.getElementById('ProjectCountBadge');
    if (projectBadge) projectBadge.textContent = Object.keys(InfoPoints).length.toLocaleString();
    SyncStationDotsToggleUI();
    BuildByMode();
    RefreshStationDots();
    LMap.on('click', HandleMapClick);
    LMap.on('moveend zoomend', ScheduleStationDots);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (IsModalOpen('StationBrowse')) {
                CloseStationBrowseModal();
            } else if (IsModalOpen('DestBrowse')) {
                CloseDestBrowseModal();
            } else if (IsModalOpen('SportsBrowse')) {
                CloseSportsBrowseModal();
            } else if (IsModalOpen('ProjectBrowse')) {
                CloseProjectBrowseModal();
            } else if (CurrentStationPopup) {
                CloseStationPopup();
            } else if (SelectedId) {
                Reset();
            } else if (document.getElementById('InfoPopupOverlay').style.display === 'flex') CloseInfoPopup();
        }
    });

    SetSheet('peek');                                                  // phones start with the map, the sheet peeking

    Destinations = destinations || {};
    DataSets.simple.Destinations = Destinations;
    Leagues = leagues || {};
    BuildTeamVenueIndex();
    MarkDataLoaded();
    InitStationBrowseModal();
    InitDestBrowseModal();
    InitProjectBrowseModal();
    SyncDestinationToggleUI();

    RenderDestinationMarkers();
    InitExploreWidgets();

    LMap.on('zoomend', function() { UpdateDestinationMarkersVisibility(); UpdateProjectMarkersVisibility(); RefreshAllMarkerSizes(); });
    LMap.on('moveend zoomend', function() { ResolveMarkerCollisions(); });

    window.addEventListener('resize', Debounce(RefreshAllMarkerSizes, 200));

    var tileLoadCheck = setInterval(function() {
        var tiles = document.querySelectorAll('.leaflet-tile');
        var allLoaded = true;

        tiles.forEach(function(tile) {
            if (!tile.complete) allLoaded = false;
        });

        if (allLoaded && tiles.length > 0) { clearInterval(tileLoadCheck); MarkTilesLoaded(); }
    }, 100);

    setTimeout(function() {
        if (!MapLoadingState.tilesLoaded) MarkTilesLoaded();
    }, 3000);

    LMap.on('load', function() {
        setTimeout(function() {
            if (!MapLoadingState.tilesLoaded) MarkTilesLoaded();
        }, 500);
    });
}

function ShowStationPopupFromSearch(StationKey) {
    EnsureGroupMarkersExist(StationGroupMembers(StationKey));

    if (!Stations[StationKey] && !AllNodes[StationKey]) {
        CurrentStationPopup = null;
        ShowStationPopup(StationKey, false);
    } else {
        ShowStationPopup(StationKey, true);
    }

    CenterOnStation(StationKey);
}

// Centres a station picked from a list in the visible part of the map at the current zoom
function CenterOnStation(StationKey) {
    var keys = StationGroupMembers(StationKey);
    var pts = (keys.length ? keys : [StationKey]).map(function(k) {
        var S = Stations[k] || AllNodes[k];
        return S && S.Location;
    }).filter(Boolean);

    if (!pts.length) return;
    var lat = pts.reduce(function(a, p) { return a + p[0]; }, 0) / pts.length;
    var lon = pts.reduce(function(a, p) { return a + p[1]; }, 0) / pts.length;
    FlyToVisibleCenter([lat, lon], LMap.getZoom());
}

var PROJECT_FOCUS_ZOOM = 14;

// Zoom used when a project is opened from a menu, by size code
var PROJECT_FOCUS_ZOOM_BY_RADIUS = {X: 7, L: 8, M: 11, S: 14};

function ShowInfoPopup(InfoKey, zoomIn) {
    var Info = InfoPoints[InfoKey];
    if (!Info) return;
    SetSheet('peek');

    SelectedInfoPoint = InfoKey;
    SetProjectSelected(InfoKey, true);

    document.getElementById('InfoPopupTitle').innerText = InfoKey;
    document.getElementById('InfoPopupSource').innerText = Info.Source;

    var Content = '';
    if (Info.Image) {
        var imgAttrs = ImageAttrs(PROJECT_IMAGE_BASE, Info.Image);
        Content += `<img src="${imgAttrs.src}" ${imgAttrs.extra} class="InfoPopupImage" onclick="window.open('${Info.Link}', '_blank')" alt="${InfoKey}" title="Click to visit link">`;
        if (Info.ImageCredit) Content += Info.ImageSource ? `<a class="InfoPopupCredit" href="${EscAttr(Info.ImageSource)}" target="_blank" rel="noopener" title="Open where this picture comes from">Image: ${Info.ImageCredit}</a>` : `<div class="InfoPopupCredit">Image: ${Info.ImageCredit}</div>`;
    }

    Content += `<div class="InfoPopupDescription">${Info.Description}</div>`;

    // Swap out a station or place panel without letting the globe zoom out in between
    if (CurrentStationPopup) { SplashStationFocus = false; CloseStationPopup(); }

    document.getElementById('InfoPopupContent').innerHTML = Content;
    document.getElementById('InfoPopupOverlay').style.display = 'flex';

    // Only move the map when opened from a menu
    if (zoomIn && Info.Location) FlyToVisibleCenter(Info.Location, PROJECT_FOCUS_ZOOM_BY_RADIUS[Info.Radius] || PROJECT_FOCUS_ZOOM);
    FocusSplashOnTarget(SplashTargetForPoint(Info.Location));
}

// Closes the project panel for another panel, keeping the globe focused
function HideProjectPanel() {
    if (document.getElementById('InfoPopupOverlay').style.display !== 'flex') return;
    SplashStationFocus = false;
    CloseInfoPopup();
}

function CloseInfoPopup() {
    if (SelectedInfoPoint) { SetProjectSelected(SelectedInfoPoint, false); SelectedInfoPoint = null; }

    document.getElementById('InfoPopupOverlay').style.display = 'none';
    document.getElementById('InfoPopupBackdrop').style.display = 'none';
    ReleaseSplashStationFocus();
}

var PROJECT_PIN_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="white"><path d="M6 2v20h2v-7.1l8.5-2.15c.97-.25.97-1.62 0-1.87L8 8.73V2z"/></svg>';

function MakeProjectMarkerIcon(key, info, selected) {
    var baseSize = GetProjectIconSize(info);
    var size = selected ? Math.round(baseSize * MARKER_SELECTED_SCALE) : baseSize;
    var badgeSize = Math.round(size * MARKER_BADGE_RATIO);
    var showBadge = size >= MARKER_BADGE_MIN_SIZE;
    var showLabel = size >= MARKER_LABEL_MIN_SIZE;
    var useImage = info.Image && size >= MARKER_IMAGE_MIN_SIZE;
    var ringColor = selected ? '#fbbf24' : '#3b82f6';
    var border = selected ? 7 : Math.max(2, Math.round(size * 0.015));

    var photoHtml;
    if (useImage) {
        var imgAttrs = ImageAttrs(PROJECT_IMAGE_BASE, info.Image);
        photoHtml = '<img src="' + imgAttrs.src + '" ' + imgAttrs.extra + ' alt="" loading="lazy" decoding="async" class="ProjectPulseRing" style="display:block;width:100%;height:100%;border-radius:50%;object-fit:cover;border:' + border + 'px solid ' + ringColor + ';box-shadow:0 2px 6px rgba(0,0,0,0.18);">';
    } else {
        photoHtml = '<div class="ProjectPulseRing" style="width:100%;height:100%;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#1d4ed8);border:' + border + 'px solid ' + ringColor + ';box-shadow:0 2px 6px rgba(0,0,0,0.18);"></div>';
    }

    var badgeHtml = showBadge
        ? '<div style="position:absolute;bottom:0;right:0;width:' + badgeSize + 'px;height:' + badgeSize + 'px;border-radius:50%;background:linear-gradient(135deg,#3b82f6,#1d4ed8);border:3px solid #fff;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 3px rgba(0,0,0,0.2);">' + PROJECT_PIN_SVG + '</div>'
        : '';

    var labelHtml = showLabel
        ? '<div class="MarkerLabel project-label" style="border-color:#3b82f633;">' +
              EscapeHtml(key) +
              '<span class="MarkerLabelTag">' + EscapeHtml(info.Source || 'Proposal') + '</span>' +
          '</div>'
        : '';

    return WrapMarkerIcon(size, photoHtml, badgeHtml, labelHtml, 160, 44, 'ProjectMarkerIcon');
}

function BuildProjectMarker(key, info) {
    var trueLatLng = [info.Location[0], info.Location[1]];
    var iconSize = GetProjectIconSize(info);
    var marker = L.marker(trueLatLng, {icon: MakeProjectMarkerIcon(key, info, false), zIndexOffset: 500, pane: 'destMarkerPane'});
    marker.on('click', function(e) { L.DomEvent.stopPropagation(e); ShowInfoPopup(key); });
    marker.bindTooltip(key + ' · ' + (info.Source || 'Proposal'), {direction: 'top', offset: [0, -iconSize / 2], className: 'ProjectTooltip', sticky: false, pane: 'hoverTooltipPane'});
    var dot = L.circleMarker(trueLatLng, {radius: 5, color: '#fff', weight: 2, fillColor: '#3b82f6', fillOpacity: 1, className: 'MarkerTrueDot', interactive: false});
    var layers = {marker: marker, dot: dot, selected: false, iconKey: iconSize + ''};
    var km = PROJECT_RADIUS_KM[info.Radius];
    if (km) {
        layers.circle = L.circle(trueLatLng, {
            radius: km * 1000, pane: 'overlayPane', interactive: false,
            color: '#3b82f6', weight: 1.5, opacity: 0.55, fillColor: '#3b82f6', fillOpacity: 0.12,
        });
    }

    return layers;
}

function SetProjectSelected(key, selected) {
    var layers = InfoMarkers[key];
    if (!layers) return;
    var info = InfoPoints[key];
    ApplyMarkerSelection(layers, MakeProjectMarkerIcon(key, info, selected), selected, GetProjectIconSize(info), GetProjectIconSize(info) + (selected ? 'S' : ''));
}

function RenderInfoMarkers() {
    ClearInfoMarkers();
    Object.keys(InfoPoints).forEach(Key => {
        InfoMarkers[Key] = BuildProjectMarker(Key, InfoPoints[Key]);
    });

    UpdateProjectMarkersVisibility();
}

function ClearInfoMarkers() {
    Object.keys(InfoMarkers).forEach(function(key) {
        RemoveMarkerLayers(InfoMarkers[key]);
    });

    InfoMarkers = {};
}
// Omni-search: one box for lines, stations, places, teams and projects, accent-insensitive

var OMNI_LIMIT = 4;                       // results per group until "Show all"
var OmniExpanded = {};                    // group -> true once "Show all" is clicked
var OmniIndex = null;                     // built on first search
var OmniFirstPick = null;                 // what Enter picks

function OmniNorm(s) {
    return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function PlaceCategoryConfig(cat) {
    return DEST_CATEGORY_CONFIG[cat] || (cat === 'Campuses' ? DEST_CATEGORY_CONFIG.Universities : null);
}

function OmniPlaceCategory(cat) {
    var cfg = PlaceCategoryConfig(cat);
    return { label: (cfg && cfg.label) || cat.replace(/s$/, ''), bg: (cfg && cfg.bg) || '#475569' };
}

// A search entry's lines that exist in the current view (matched by id)
var _viewIds = null, _viewIdsRegistry = null;
function LinesInView(entry) {
    if (_viewIdsRegistry !== Registry) { _viewIds = new Set((Registry || []).map(function(L) { return L.Id; })); _viewIdsRegistry = Registry; }
    return (entry.Lines || []).filter(function(l) { return _viewIds.has(l.Id); });
}

function BuildOmniIndex() {
    var idx = { stations: [], places: [], teams: [], projects: [] };
    Object.keys(StationSearchIndex || {}).forEach(function(key) {
        var e = StationSearchIndex[key];
        var region = e.Region || [];
        idx.stations.push({ key: key, label: e.Label, norm: OmniNorm(e.Label), extra: OmniNorm(region.slice(0, 2).join(' ')), entry: e });
    });

    Object.keys(Destinations || {}).forEach(function(cat) {
        Object.keys(Destinations[cat]).forEach(function(name) {
            idx.places.push({ cat: cat, name: name, label: name, norm: OmniNorm(name) });
        });
    });

    Object.keys(Leagues || {}).forEach(function(league) {
        Leagues[league].forEach(function(team) {
            idx.teams.push({ league: league, team: team, label: team, norm: OmniNorm(team), extra: OmniNorm(league) });
        });
    });

    Object.keys(InfoPoints || {}).forEach(function(key) {
        idx.projects.push({ key: key, label: key, norm: OmniNorm(key), extra: OmniNorm(InfoPoints[key].Source) });
    });

    return idx;
}

function OmniScore(item, q) {
    if (item.norm.indexOf(q) === 0) return 0;
    if (item.norm.indexOf(' ' + q) !== -1 || item.norm.indexOf('(' + q) !== -1) return 1;
    if (item.norm.indexOf(q) !== -1) return 2;
    if (item.extra && item.extra.indexOf(q) !== -1) return 3;   // e.g. a league, or a station's city
    return -1;
}

// A station with several platforms is one result, not one per platform.
function OmniOnePerStation(items) {
    var seen = {};
    return items.filter(function(it) {
        var id = StationGroupBase(it.key) + '|' + it.label + '|' + ((it.entry.Region || [])[0] || '');
        if (seen[id]) return false;
        return (seen[id] = true);
    });
}

function OmniMatch(list, q, keep) {
    var out = [];
    list.forEach(function(item) {
        var s = OmniScore(item, q);
        if (s >= 0 && (!keep || keep(item))) out.push({ s: s, item: item });
    });

    out.sort(function(a, b) { return a.s - b.s || a.item.label.length - b.item.label.length || a.item.label.localeCompare(b.item.label); });
    return out.map(function(o) { return o.item; });
}

// Bolds the matched part of a label (accent-insensitive).
function OmniHighlight(label, q) {
    var i = OmniNorm(label).indexOf(q);
    if (i < 0 || OmniNorm(label).length !== label.length) return EscapeHtml(label);
    return EscapeHtml(label.slice(0, i)) + '<b>' + EscapeHtml(label.slice(i, i + q.length)) + '</b>' + EscapeHtml(label.slice(i + q.length));
}

var OnOmniSearch = Debounce(RenderOmniResults, 90);

function RenderOmniResults() {
    var input = document.getElementById('SearchInput');
    var box = document.getElementById('OmniResults');
    if (!input || !box) return;
    var raw = input.value.trim();
    var q = OmniNorm(raw);
    document.getElementById('OmniSearch').classList.toggle('has-query', raw.length > 0);
    _DoFilterList();

    // Lines: tell the list header when nothing matches.
    var section = document.getElementById('LinesSection');
    if (section && q) section.open = true;
    var lines = document.getElementById('LinesView');
    var anyLine = !!document.querySelector('#ListContainer .Item:not([style*="display: none"])');
    lines.classList.toggle('no-match', !!q && !anyLine);
    var firstLine = q && anyLine ? document.querySelector('#ListContainer .Item:not([style*="display: none"])') : null;

    OmniFirstPick = null;
    if (q.length < 2) { box.innerHTML = ''; box.classList.remove('has-results'); OmniExpanded = {}; return; }
    OmniIndex = OmniIndex || BuildOmniIndex();

    var mode = CurrentMapMode;
    var visible = null;
    var visibleStations = ComputeVisibleStationKeys();   // stations of switched-on modes
    var groups = [
        { id: 'stations', title: 'Stations', items: OmniOnePerStation(OmniMatch(OmniIndex.stations, q, function(st) { return visibleStations.has(st.key) && LinesInView(st.entry).length > 0; })) },
        { id: 'places', title: 'Places', items: OmniMatch(OmniIndex.places, q, function(p) {
            return DestExists(Destinations[p.cat][p.name], mode);
        }) },
        { id: 'teams', title: 'Sports teams', items: OmniMatch(OmniIndex.teams, q, function(t) {
            visible = visible || ComputeVisibleStationKeys();
            return !!TeamVenueForMode(t.team, mode, visible);   // only teams reachable by rail in this view
        }) },
        { id: 'projects', title: 'Projects', items: mode === 'Fantasy' ? OmniMatch(OmniIndex.projects, q) : [] }
    ];

    var html = [];
    groups.forEach(function(g) {
        if (!g.items.length) return;
        var shown = OmniExpanded[g.id] ? g.items : g.items.slice(0, OMNI_LIMIT);
        html.push('<div class="OmniGroup"><div class="OmniGroupTitle">' + g.title + '<span class="OmniGroupCount">' + g.items.length + '</span></div>');
        shown.forEach(function(item, i) {
            var pick = OmniPickCall(g.id, item);
            if (!OmniFirstPick) OmniFirstPick = pick;
            html.push('<button class="OmniItem" onclick="' + EscapeHtml(pick) + '">' + OmniItemHtml(g.id, item, q) + '</button>');
        });

        if (g.items.length > shown.length) {
            html.push('<button class="OmniMore" onclick="OmniExpanded[\'' + g.id + '\']=true; RenderOmniResults()">Show all ' + g.items.length + '</button>');
        }

        html.push('</div>');
    });

    if (!OmniFirstPick && firstLine) OmniFirstPick = "SelectLine('" + firstLine.getAttribute('data-lineid') + "')";
    box.innerHTML = html.join('');
    box.classList.toggle('has-results', html.length > 0);
}

function OmniJs(s) { return "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'"; }

function OmniPickCall(group, item) {
    if (group === 'stations') return 'OmniPick(function(){ ShowStationPopupFromSearch(' + OmniJs(item.key) + '); })';
    if (group === 'places')   return 'OmniPick(function(){ ShowDestinationPopup(' + OmniJs(item.cat) + ', ' + OmniJs(item.name) + ', true); })';
    if (group === 'teams')    return 'OmniPick(function(){ SelectSportsTeam(' + OmniJs(item.league) + ', ' + OmniJs(item.team) + '); })';
    return 'OmniPick(function(){ ShowInfoPopup(' + OmniJs(item.key) + ', true); })';
}

function OmniItemHtml(group, item, q) {
    var icon = '', meta = '';
    if (group === 'stations') {
        var e = item.entry, region = e.Region || [];
        var where = [region[0], region[1]].filter(Boolean).join(', ');
        var dots = LinesInView(e).slice(0, 5).map(function(l) { return '<span class="OmniDot" style="background:' + l.Color + '"></span>'; }).join('');
        // Many stations share a name; the first serving line and a count tell them apart
        var lines = LinesInView(e);
        var served = lines.length ? EscapeHtml(lines[0].Name) + (lines.length > 1 ? ' +' + (lines.length - 1) : '') : '';
        icon = '<span class="OmniIcon omni-station"></span>';
        meta = (dots ? '<span class="OmniDots">' + dots + '</span>' : '') +
               '<span class="OmniMetaText">' + [where ? EscapeHtml(where) : '', served].filter(Boolean).join(' · ') + '</span>';
    } else if (group === 'places') {
        var cat = OmniPlaceCategory(item.cat);
        icon = '<span class="OmniIcon omni-place" style="background:' + cat.bg + '"></span>';
        meta = EscapeHtml(cat.label);
    } else if (group === 'teams') {
        var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(item.league), item.team);
        icon = '<img class="OmniLogo" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy">';
        meta = EscapeHtml(item.league);
    } else {
        icon = '<span class="OmniIcon omni-project"></span>';
        meta = EscapeHtml(InfoPoints[item.key].Source || 'Project');
    }

    return icon + '<span class="OmniText"><span class="OmniName">' + OmniHighlight(item.label, q) + '</span><span class="OmniMeta">' + meta + '</span></span>';
}

function OmniPick(fn) {
    fn();
    // On phones the sidebar covers the map: get it out of the way.
    if (IsPhone()) SetSheet(SelectedId ? 'half' : 'peek');
}

function OnOmniSearchKey(e) {
    if (e.key === 'Enter') {
        RenderOmniResults();
        if (OmniFirstPick) (new Function(OmniFirstPick))();
    } else if (e.key === 'Escape') ClearOmniSearch();
}

function ClearOmniSearch() {
    var input = document.getElementById('SearchInput');
    if (!input) return;
    input.value = '';
    OmniExpanded = {};
    RenderOmniResults();
    input.focus();
}

// Layers control: basemap and overlays in one panel, closed by clicking outside or Escape

function ToggleLayersPanel(e, open) {
    if (e) e.stopPropagation();
    var ctl = document.getElementById('LayersControl');
    if (!ctl) return;
    var next = open === undefined ? !ctl.classList.contains('open') : open;
    if (next) CloseExploreOverlays('style');
    ctl.classList.toggle('open', next);
    var btn = document.getElementById('LayersToggle');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
}

document.addEventListener('click', function(e) {
    var ctl = document.getElementById('LayersControl');
    if (ctl && ctl.classList.contains('open') && !ctl.contains(e.target)) ToggleLayersPanel(null, false);
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') ToggleLayersPanel(null, false);
});

// Explore widgets: place chips, the projects drawer and the sports shelf

var HiddenDestCategories = new Set();     // categories switched off while places are on
var ProjectsStripBuilt = false;

function InitExploreWidgets() {
    RenderPlacesChips();
    RenderStationsPreview();
    RenderProjectsCard();
    BuildLeagueRack();
    SyncProjectsDock();
}

// Places

function DestCategories() { return Object.keys(Destinations || {}); }

function PlaceCategoryOn(cat) { return !DestinationsHidden && !HiddenDestCategories.has(cat); }

function ToggleDestCategory(cat) {
    var all = DestCategories();
    if (DestinationsHidden) {
        // Places were off entirely: turn on just this category.
        DestinationsHidden = false;
        HiddenDestCategories = new Set(all.filter(function(c) { return c !== cat; }));
    } else if (HiddenDestCategories.has(cat)) {
        HiddenDestCategories.delete(cat);
    } else {
        HiddenDestCategories.add(cat);
        if (HiddenDestCategories.size >= all.length) {   // last one off: places off
            DestinationsHidden = true;
            HiddenDestCategories.clear();
        }
    }

    SyncDestinationToggleUI();
    UpdateDestinationMarkersVisibility();
}

// A chip's icon switches its category on the map; its name opens the category's list
function RenderPlacesChips() {
    var host = document.getElementById('PlacesChips');
    if (!host || typeof Destinations === 'undefined') return;
    var mode = CurrentMapMode;
    var anyOn = DestCategories().some(PlaceCategoryOn);
    // A master switch first: every place marker on or off in one go.
    host.innerHTML = '<button class="PlacesMaster" onclick="ToggleAllPlaces()" aria-pressed="' + anyOn + '" title="' + (anyOn ? 'Hide' : 'Show') + ' all places on the map">' +
            '<span>Places</span><span class="InlineToggleSwitch accent-amber' + (anyOn ? ' active' : '') + '"><span class="InlineToggleKnob"></span></span>' +
        '</button>' + DestCategories().map(function(cat) {
        var cfg = OmniPlaceCategory(cat);
        var full = PlaceCategoryConfig(cat);
        var count = Object.keys(Destinations[cat]).filter(function(n) { return DestExists(Destinations[cat][n], mode); }).length;
        var on = PlaceCategoryOn(cat);
        var c = OmniJs(cat);
        return '<span class="PlaceChip' + (on ? ' on' : '') + '" style="--chip:' + cfg.bg + '">' +
            '<button class="PlaceChipIcon" onclick="ToggleDestCategory(' + c + ')" aria-pressed="' + on + '" ' +
                'title="' + (on ? 'Hide ' : 'Show ') + EscapeHtml(cat.toLowerCase()) + ' on the map">' +
                '<svg viewBox="0 0 24 24" width="15" height="15">' + (full ? full.icon : '') + '</svg></button>' +
            '<button class="PlaceChipOpen" onclick="OpenDestBrowseModal(' + c + ')" title="All ' + EscapeHtml(cat.toLowerCase()) + '">' +
                '<span class="PlaceChipLabel">' + EscapeHtml(cat) + '</span>' +
                '<span class="PlaceChipCount">' + count + '</span></button>' +
        '</span>';
    }).join('') +
        '<button class="PlacesExplore" onclick="OpenDestBrowseModal()" title="Browse every place, then minimize the window to see them on the map">' +
            '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg><span>Explore</span></button>';
}

// All place markers on (every category) or off.
function ToggleAllPlaces() {
    var anyOn = DestCategories().some(PlaceCategoryOn);
    DestinationsHidden = anyOn;
    HiddenDestCategories.clear();
    SyncDestinationToggleUI();
    UpdateDestinationMarkersVisibility();
}

// Stations preview: every station in the view, busiest first, loading more on scroll
var STATIONS_PREVIEW_PAGE = 15;   // rows added each time the list nears its end
var StationsPreviewRows = [];     // every station in the current view, busiest first
var StationsPreviewShown = 0;

function RenderStationsPreview() {
    var host = document.getElementById('StationsPreview');
    if (!host || typeof StationSearchIndex === 'undefined') return;
    // Only lines of switched-on modes in this view count
    var current = new Set(Registry.filter(function(L) { return !DisabledModes.has(L.ModeId); })
        .map(function(L) { return L.Id; }));
    var seen = {};
    var rows = [];
    Object.keys(StationSearchIndex).forEach(function(key) {
        var e = StationSearchIndex[key];
        var lines = (e.Lines || []).filter(function(l) { return current.has(l.Id); });
        if (!lines.length) return;
        var region = e.Region || [];
        var id = e.Label + '|' + (region[0] || '');           // a station split across platforms counts once
        if (seen[id] && seen[id].lines.length >= lines.length) return;
        seen[id] = { key: key, entry: e, lines: lines };
    });

    Object.keys(seen).forEach(function(id) { rows.push(seen[id]); });
    rows.sort(function(a, b) { return b.lines.length - a.lines.length || a.entry.Label.localeCompare(b.entry.Label); });
    StationsPreviewRows = rows;
    StationsPreviewShown = 0;
    host.innerHTML = '';
    host.scrollTop = 0;
    AppendStationsPreview();
    if (!host._endless) {
        host._endless = true;   // scrolling near the end loads the next page
        host.addEventListener('scroll', function() {
            if (host.scrollTop + host.clientHeight > host.scrollHeight - 60) AppendStationsPreview();
        });
    }
}

function AppendStationsPreview() {
    var host = document.getElementById('StationsPreview');
    if (!host || StationsPreviewShown >= StationsPreviewRows.length) return;
    var page = StationsPreviewRows.slice(StationsPreviewShown, StationsPreviewShown + STATIONS_PREVIEW_PAGE);
    StationsPreviewShown += page.length;
    host.insertAdjacentHTML('beforeend', page.map(function(r) {
        var region = r.entry.Region || [];
        var where = [region[0], region[1]].filter(Boolean).join(', ');
        return '<button class="StationPreviewRow" onclick="ShowStationPopupFromSearch(' + EscapeHtml(OmniJs(r.key)) + ')">' +
            '<span class="StationPreviewText"><span class="StationPreviewName">' + EscapeHtml(r.entry.Label) + '</span>' +
            (where ? '<span class="StationPreviewWhere">' + EscapeHtml(where) + '</span>' : '') + '</span>' +
            '<span class="StationPreviewLines">' + r.lines.length + (r.lines.length === 1 ? ' line' : ' lines') + '</span>' +
        '</button>';
    }).join(''));
}

// Projects

// The sidebar's Projects banner: a strip of five project photos and the count.
function RenderProjectsCard() {
    var mosaic = document.getElementById('ProjectsMosaic');
    if (!mosaic || typeof InfoPoints === 'undefined') return;
    var keys = Object.keys(InfoPoints).sort(function(a, b) { return a.localeCompare(b); });
    var withImages = keys.filter(function(k) { return InfoPoints[k].Image; });
    mosaic.innerHTML = withImages.slice(0, 5).concat(['', '', '', '', '']).slice(0, 5).map(function(k) {
        if (!k) return '<span></span>';
        var img = ImageAttrs(PROJECT_IMAGE_BASE, InfoPoints[k].Image);
        return '<span><img src="' + img.src + '" ' + img.extra + ' alt="" loading="lazy" decoding="async"></span>';
    }).join('');

    var count = document.getElementById('ProjectsCardCount');
    if (count) count.textContent = keys.length;
}

// The projects card follows the sidebar's bottom edge on desktop
function PositionProjectsCard() {
    var card = document.getElementById('ProjectsCard');
    var sidebar = document.getElementById('Sidebar');
    if (!card || !sidebar) return;
    if (window.innerWidth <= 768) { card.style.top = card.style.left = card.style.width = card.style.transform = ''; return; }
    var collapsed = sidebar.classList.contains('collapsed');
    var top = sidebar.offsetTop + sidebar.offsetHeight + 12;
    card.style.top = top + 'px';
    card.style.left = sidebar.offsetLeft + 'px';
    card.style.width = sidebar.offsetWidth + 'px';
    card.style.transform = collapsed ? 'translateX(-' + (sidebar.offsetWidth + 40) + 'px)' : '';
}

(function InitProjectsCardPosition() {
    var sidebar = document.getElementById('Sidebar');
    if (!sidebar) return;
    if (window.ResizeObserver) new ResizeObserver(PositionProjectsCard).observe(sidebar);
    window.addEventListener('resize', PositionProjectsCard);
    PositionProjectsCard();
})();

function OpenProjectsWindow() {
    ToggleProjectsDrawer(true);
    ToggleProjectsExpanded(true);
}

function SyncProjectsDock() {
    var drawer = document.getElementById('ProjectsDrawer');
    if (!drawer || typeof InfoPoints === 'undefined') return;
    var future = CurrentMapMode === 'Fantasy' && Object.keys(InfoPoints).length > 0;
    var card = document.getElementById('ProjectsCard');
    if (card) card.style.display = future ? '' : 'none';
    var cards = document.getElementById('ExploreCards');
    if (cards) cards.classList.toggle('single', !future);
    drawer.classList.toggle('unavailable', !future);
    if (!future) ToggleProjectsDrawer(false);
}

function BuildProjectsStrip() {
    var strip = document.getElementById('ProjectsStrip');
    if (!strip || ProjectsStripBuilt) return;
    ProjectsStripBuilt = true;
    var keys = Object.keys(InfoPoints).sort(function(a, b) { return a.localeCompare(b); });
    strip.innerHTML = keys.map(function(key) {
        var info = InfoPoints[key];
        var img = info.Image ? ImageAttrs(PROJECT_IMAGE_BASE, info.Image) : null;
        var search = OmniNorm([key, info.Source, info.Description].join(' '));
        return '<button class="ProjectCard" onclick="PickProject(' + EscapeHtml(OmniJs(key)) + ')" title="' + EscapeHtml(key) + '" ' +
            'data-search="' + EscapeHtml(search) + '" data-source="' + EscapeHtml(info.Source || '') + '">' +
            '<span class="ProjectCardImage">' + (img ? '<img src="' + img.src + '" ' + img.extra + ' alt="" loading="lazy" decoding="async">' : '') + '</span>' +
            '<span class="ProjectCardName">' + EscapeHtml(key) + '</span>' +
            (info.Source ? '<span class="ProjectCardSource">' + EscapeHtml(info.Source) + '</span>' : '') +
        '</button>';
    }).join('');

    // A mouse wheel scrolls the strip sideways (not in the expanded grid).
    strip.addEventListener('wheel', function(e) {
        if (ProjectsExpanded) return;
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });

    // Source filter chips (Proposal, Overhead Wire, ...), shown when expanded.
    var sources = {};
    keys.forEach(function(k) { var src = InfoPoints[k].Source; if (src) sources[src] = (sources[src] || 0) + 1; });
    var chips = document.getElementById('ProjectsSourceChips');
    if (chips) {
        // The most common sources up front; the long tail behind "+N more".
        var ordered = Object.keys(sources).sort(function(a, b) { return sources[b] - sources[a] || a.localeCompare(b); });
        var TOP = 8;
        chips.innerHTML = ordered.map(function(src, i) {
            return '<button class="ProjectSourceChip' + (i >= TOP ? ' extra' : '') + '" data-source="' + EscapeHtml(src) + '" onclick="ToggleProjectSource(' + EscapeHtml(OmniJs(src)) + ')">' +
                EscapeHtml(src) + ' <span>' + sources[src] + '</span></button>';
        }).join('') +
        (ordered.length > TOP ? '<button class="ProjectSourceChip more" onclick="this.parentNode.classList.toggle(\'show-all\'); this.textContent = this.parentNode.classList.contains(\'show-all\') ? \'Fewer\' : \'+' + (ordered.length - TOP) + ' more\'">+' + (ordered.length - TOP) + ' more</button>' : '');
    }
}

var ProjectsExpanded = false;
var ProjectSourceFilter = null;   // one source at a time, or null for all

function ToggleProjectsExpanded(open) {
    var drawer = document.getElementById('ProjectsDrawer');
    if (!drawer) return;
    var next = open === undefined ? !ProjectsExpanded : open;
    if (next && !drawer.classList.contains('open')) ToggleProjectsDrawer(true);
    ProjectsExpanded = next;
    drawer.classList.toggle('expanded', next);
    var dock = document.getElementById('ProjectsDock');
    if (dock) dock.classList.toggle('expanded', next);   // lifts it above the sidebar
    var btn = document.getElementById('ProjectsExpandBtn');
    if (btn) { btn.title = next ? 'Shrink' : 'Expand'; btn.setAttribute('aria-label', btn.title); }
    if (next) {
        var input = document.getElementById('ProjectsSearch');
        if (input) setTimeout(function() { input.focus({ preventScroll: true }); }, 50);
    }
}

function ToggleProjectSource(src) {
    ProjectSourceFilter = ProjectSourceFilter === src ? null : src;
    document.querySelectorAll('.ProjectSourceChip').forEach(function(chip) {
        chip.classList.toggle('on', chip.getAttribute('data-source') === ProjectSourceFilter);
    });

    FilterProjects();
}

function FilterProjects() {
    var input = document.getElementById('ProjectsSearch');
    var q = OmniNorm(input ? input.value.trim() : '');
    var shown = 0;
    document.querySelectorAll('#ProjectsStrip .ProjectCard').forEach(function(card) {
        var ok = (!q || card.getAttribute('data-search').indexOf(q) !== -1) &&
                 (!ProjectSourceFilter || card.getAttribute('data-source') === ProjectSourceFilter);
        card.style.display = ok ? '' : 'none';
        if (ok) shown++;
    });

    var drawer = document.getElementById('ProjectsDrawer');
    if (drawer) drawer.classList.toggle('no-results', shown === 0);
}

// From the big window, step back to the map to show the project.
function PickProject(key) {
    if (ProjectsExpanded) ToggleProjectsDrawer(false);
    ShowInfoPopup(key, true);
}

function ToggleProjectsDrawer(open) {
    var drawer = document.getElementById('ProjectsDrawer');
    if (!drawer) return;
    var next = open === undefined ? !drawer.classList.contains('open') : open;
    if (next && drawer.classList.contains('unavailable')) return;
    if (next) { CloseExploreOverlays('projects'); BuildProjectsStrip(); }
    if (!next && ProjectsExpanded) ToggleProjectsExpanded(false);
    drawer.classList.toggle('open', next);
}

// Sports

// The sidebar's sports shelf of league logos, each opening the Sports Teams window
function BuildLeagueRack() {
    var card = document.getElementById('SportsCard');
    var logos = document.getElementById('SportsCardLogos');
    var leagues = (typeof Leagues !== 'undefined') ? Object.keys(Leagues).sort() : [];
    if (card) card.style.display = leagues.length ? '' : 'none';
    var count = document.getElementById('SportsCardCount');
    if (count) count.textContent = leagues.length;
    if (logos) {
        logos.innerHTML = leagues.map(function(lg) {
            var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(lg), '_Logo');
            return '<button class="SportsCardLogo" data-league="' + EscapeHtml(lg) + '" title="' + EscapeHtml(lg) + '" ' +
                'onclick="event.stopPropagation(); OpenSportsLeague(' + EscapeHtml(OmniJs(lg)) + ')">' +
                '<img src="' + a.src + '" ' + a.extra + ' alt="' + EscapeHtml(lg) + '" draggable="false"></button>';
        }).join('');
    }

    if (logos && !logos._wheel) {
        logos._wheel = true;   // a mouse wheel scrolls the shelf sideways
        logos.addEventListener('wheel', function(e) {
            if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && logos.scrollWidth > logos.clientWidth) { logos.scrollLeft += e.deltaY; e.preventDefault(); }
        }, { passive: false });
    }

    SyncLeagueRack();
}

function OpenSportsLeague(league) {
    ToggleSportsRack(true);
    {
        SportsBrowseCurrentLeague = league;
        RenderSportsTeamGrid(league);
    }
}

// Marks the leagues currently on the map
function SyncLeagueRack() {
    var card = document.getElementById('SportsCard');
    if (card) card.classList.toggle('has-active', ActiveSportsLeagues.size > 0);
    document.querySelectorAll('#SportsCardLogos .SportsCardLogo').forEach(function(b) {
        b.classList.toggle('on-map', ActiveSportsLeagues.has(b.getAttribute('data-league')));
    });

    RefreshSplashTeams();
}

function ToggleSportsRack(open, e) {
    if (e) e.stopPropagation();
    if (open === false) return;
    CloseExploreOverlays('sports');
    OpenSportsBrowseModal();
}

// Only one explore popover is open at a time.
function CloseExploreOverlays(except) {
    if (except !== 'projects') ToggleProjectsDrawer(false);
    if (except !== 'style') ToggleLayersPanel(null, false);
}

document.addEventListener('click', function(e) {
    var drawer = document.getElementById('ProjectsDrawer');
    var banner = document.getElementById('ProjectsCard');
    if (drawer && drawer.classList.contains('open') && !drawer.contains(e.target) && !(banner && banner.contains(e.target))) ToggleProjectsDrawer(false);
});

document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    ToggleProjectsDrawer(false);
});

// Teams on the globe: venues of leagues on the map, projected like the station dot

function ProjectLatLonRaw(latLon) {
    var proj = SplashData && SplashData.Projection;
    if (!proj || !latLon) return null;
    var n = proj[0], F = proj[1], lon0 = proj[2], rad = Math.PI / 180;
    var d = (((latLon[1] - lon0 + 180) % 360) + 360) % 360 - 180;
    var theta = n * d * rad;
    var lat = Math.max(Math.min(latLon[0], 89.9), -89.9);
    var r = F / Math.pow(Math.tan(Math.PI / 4 + lat * rad / 2), n);
    return [r * Math.sin(theta), r * Math.cos(theta)];
}

function ProjectToContinent(latLon) {
    var fit = SplashData && SplashData.ContinentFit;
    var p = ProjectLatLonRaw(latLon);
    if (!fit || !p) return null;
    var half = (SplashData.Size || 1000) / 2;
    return [half + (p[0] - fit[0]) * fit[2], half + (p[1] - fit[1]) * fit[2]];
}

// One point per venue with its teams, recomputed when leagues, the view or the focused country change
function RefreshSplashTeams() {
    if (!Scene.ctx || !SplashData || typeof Leagues === 'undefined') return;
    var ctx = Scene.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var mode = CurrentMapMode;
    var visible = ActiveSportsLeagues.size ? ComputeVisibleStationKeys() : null;
    var venues = {};
    ActiveSportsLeagues.forEach(function(lg) {
        (Leagues[lg] || []).forEach(function(team) {
            // Reachable teams at their venue, the rest greyed at their fallback venue
            var v = TeamVenueForMode(team, mode, visible);
            var available = !!v;
            if (!v) v = TeamVenueFallback(team, mode);
            var dest = v && Destinations[v.cat] && Destinations[v.cat][v.name];
            if (!dest) return;
            var key = v.cat + '|' + v.name;
            (venues[key] = venues[key] || { loc: dest.Location, teams: [] }).teams.push({ league: lg, team: team, available: available });
        });
    });

    var continent = [], country = [];
    var focus = SplashFocusCode && SplashData.Countries[SplashFocusCode];
    Object.keys(venues).forEach(function(key) {
        var v = venues[key];
        var c = ProjectToContinent(v.loc);
        if (c) {
            var owner = null;
            Scene.countries.some(function(cn) { if (ctx.isPointInPath(cn.path, c[0], c[1], 'evenodd')) { owner = cn.code; return true; } });
            continent.push({ p: c, code: owner, teams: v.teams });
        }

        if (focus && focus._subPaths) {
            var q = ProjectToCountryView(SplashFocusCode, v.loc);
            if (!q) return;
            var sub = -1;
            focus._subPaths.some(function(sp, i) { if (ctx.isPointInPath(sp.path, q[0], q[1], 'nonzero')) { sub = i; return true; } });
            if (sub >= 0) country.push({ p: q, sub: sub, teams: v.teams });   // only teams inside this country
        }
    });

    ctx.restore();
    // Draw southern ones last so overlapping logos stack naturally.
    continent.sort(function(a, b) { return a.p[1] - b.p[1]; });
    country.sort(function(a, b) { return a.p[1] - b.p[1]; });
    Scene.teams = { continent: continent, country: country };
    RequestSplashDraw();
}

// Team logos for the canvas, loaded once each; null until loaded
var SplashLogoCache = {};
function SplashTeamLogo(league, team) {
    var key = league + '|' + team;
    var c = SplashLogoCache[key];
    if (c) return c.ready ? c.img : null;
    c = SplashLogoCache[key] = { img: new Image(), ready: false };
    var candidates = BuildImageCandidates(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team);
    if (!candidates.length) return null;
    var i = 0;
    c.img.onload = function() { c.ready = true; RequestSplashDraw(); };
    c.img.onerror = function() { if (++i < candidates.length) c.img.src = candidates[i]; };
    c.img.src = candidates[0];
    return null;
}

// Each venue's team logos side by side, with a dot until a logo loads
function DrawSplashTeams(points, m, alphaFor, base, radius) {
    if (!points || !points.length) return;
    var ctx = Scene.ctx;
    var r = radius * Scene.dpr;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    points.forEach(function(pt) {
        var a = alphaFor(pt);
        if (a < 0.01) return;
        var x0 = base * (m[0] * pt.p[0] + m[2] * pt.p[1] + m[4]);
        var y0 = base * (m[1] * pt.p[0] + m[3] * pt.p[1] + m[5]);
        var n = pt.teams.length;
        pt.teams.forEach(function(t, i) {
            var x = x0 + (i - (n - 1) / 2) * r * 1.5, y = y0;
            // Not reachable by rail: greyed and faded, as on the main map.
            ctx.globalAlpha = t.available ? a : a * 0.5;
            ctx.filter = t.available ? 'none' : 'grayscale(1)';
            var img = SplashTeamLogo(t.league, t.team);
            if (img && img.naturalWidth) {
                // Just the logo, with a faint shadow so light logos still read.
                ctx.shadowColor = 'rgba(15, 23, 42, 0.45)';
                ctx.shadowBlur = 2 * Scene.dpr;
                ctx.shadowOffsetY = 0.5 * Scene.dpr;
                var box = r * 2;                                            // contain-fit in the logo's square
                var k = Math.min(box / img.naturalWidth, box / img.naturalHeight);
                var w = img.naturalWidth * k, h = img.naturalHeight * k;
                ctx.drawImage(img, x - w / 2, y - h / 2, w, h);
                ctx.filter = 'none';
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
                ctx.shadowOffsetY = 0;
            } else {
                ctx.filter = 'none';
                ctx.beginPath(); ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
                ctx.fillStyle = t.available ? '#059669' : '#94a3b8'; ctx.fill();
            }
        });
    });
}

// Lines window: every line in the view, grouped by mode or agency

var RouteBrowseSort = 'mode';   // 'mode' or 'agency'
var RouteBrowseCollapsed = { mode: new Set(), agency: new Set() };

function OpenRouteBrowseModal() {
    var input = document.getElementById('RouteBrowseFilterInput');
    SetModalOpen('RouteBrowse', true);
    if (input) {
        input.value = '';
        if (!input._wired) {
            input._wired = true;
            input.addEventListener('input', Debounce(function() { RenderRouteBrowseModal(input.value); }, 80));
        }

        setTimeout(function() { input.focus(); }, 50);
    }

    RenderRouteBrowseModal('');
}

function CloseRouteBrowseModal() {
    SetModalOpen('RouteBrowse', false);
}

function SetRouteBrowseSort(sort) {
    RouteBrowseSort = sort;
    document.querySelectorAll('#RouteSortSwitch button').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-sort') === sort);
    });

    var list = document.getElementById('RouteBrowseList');
    if (list) list.scrollTop = 0;
    var input = document.getElementById('RouteBrowseFilterInput');
    RenderRouteBrowseModal(input ? input.value : '');
}

function SetRouteBrowseView(mode) {
    if (CurrentMapMode !== mode) SwitchMapMode(mode);   // refreshes this window via RefreshStationListings
    RenderRouteBrowseModeToggle();
}

function RenderRouteBrowseModeToggle() {
    var el = document.getElementById('RouteBrowseModeToggle');
    if (!el) return;
    el.innerHTML = ModeToggleHtml('SetRouteBrowseView');
}

function ToggleRouteGroup(details) {
    var key = details.getAttribute('data-group');
    var set = RouteBrowseCollapsed[RouteBrowseSort];
    if (details.open) set.delete(key); else set.add(key);
    SyncCollapseAllLabel('RouteBrowseList', 'RouteCollapseAll');
}

function RenderRouteBrowseModal(filterQuery) {
    var listEl = document.getElementById('RouteBrowseList');
    if (!listEl) return;
    RenderRouteBrowseModeToggle();
    RenderModeChips('RouteModeChips');

    var q = OmniNorm((filterQuery || '').trim());
    var lines = Registry.filter(function(L) {
        if (DisabledModes.has(L.ModeId)) return false;
        return !q || OmniNorm(L.Name + ' ' + L.Operator + ' ' + (L.ModeName || '')).indexOf(q) !== -1;
    });

    var countEl = document.getElementById('RouteBrowseCount');
    if (countEl) countEl.textContent = lines.length.toLocaleString() + (q ? ' found' : '');
    if (!lines.length) {
        listEl.innerHTML = '<div class="StationBrowseEmpty">No lines match “' + EscapeHtml(filterQuery || '') + '”</div>';
        SyncCollapseAllLabel('RouteBrowseList', 'RouteCollapseAll');
        return;
    }

    var byMode = RouteBrowseSort === 'mode';
    var groups = {}, order = [];
    lines.forEach(function(L) {
        var key = byMode ? L.ModeId : L.Operator;
        if (!groups[key]) { groups[key] = []; order.push(key); }
        groups[key].push(L);
    });

    if (byMode) {
        var modeOrder = Object.keys(Modes);
        order.sort(function(a, b) { return modeOrder.indexOf(a) - modeOrder.indexOf(b); });
    } else {
        order.sort(function(a, b) { return a.localeCompare(b); });
    }

    var collapsed = RouteBrowseCollapsed[RouteBrowseSort];
    var chevron = '<span class="StationGroupChevron" aria-hidden="true"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></span>';
    var html = [];
    order.forEach(function(key) {
        var items = groups[key].slice().sort(function(a, b) {
            return byMode ? (a.Operator.localeCompare(b.Operator) || a.Name.localeCompare(b.Name)) : a.Name.localeCompare(b.Name);
        });

        var label = byMode
            ? '<span class="RouteModeDot" style="background:' + ((Modes[key] && Modes[key].Color) || '#888') + '"></span><span class="StationLetterText">' + EscapeHtml((Modes[key] && Modes[key].Name) || key) + '</span>'
            : '<span class="StationLetterText">' + EscapeHtml(key) + '</span>';
        html.push('<details class="StationGroup" data-group="' + EscapeHtml(key) + '"' + (collapsed.has(key) ? '' : ' open') +
            ' ontoggle="ToggleRouteGroup(this)"><summary class="StationBrowseLetterHeader city">' + chevron + label +
            '<span class="StationCityCount">' + items.length + '</span></summary>');
        items.forEach(function(L) {
            var n = (L.AllLineStations || []).length;
            // Grouped by mode, a row names its agency; grouped by agency, its mode.
            var meta = byMode ? L.Operator : (L.ModeName || (Modes[L.ModeId] && Modes[L.ModeId].Name) || '');
            html.push('<div class="StationBrowseRow StationListRow RouteListRow" onclick="CommitRouteBrowseSelection(' + EscapeHtml(OmniJs(L.Id)) + ')">' +
                '<span class="RouteSwatch" style="background:' + L.Color + '"></span>' +
                '<div class="StationListMain"><div class="StationBrowseRowName">' + EscapeHtml(L.Name) + '</div>' +
                '<div class="StationBrowseRowArea"><span class="StationBrowseAreaText">' + EscapeHtml(meta) + '</span></div></div>' +
                '<span class="RouteStationCount">' + n + (n === 1 ? ' station' : ' stations') + '</span>' +
            '</div>');
        });

        html.push('</details>');
    });

    listEl.innerHTML = html.join('');
    SyncCollapseAllLabel('RouteBrowseList', 'RouteCollapseAll');
}

function CommitRouteBrowseSelection(id) {
    CloseRouteBrowseModal();
    if (SelectedId !== id) SelectLine(id);   // SelectLine toggles: don't deselect a line already selected
}

document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    if (IsModalOpen('RouteBrowse')) CloseRouteBrowseModal();
});