var RegistryDetailed, RegistryFull, RegistryPresent, RegistryPresentFull, Registry;
var StationsDetailed, AllNodes, Stations;
var Modes, ModesOrder;
var CurrentDetail = 'Full';
var CurrentMapMode = 'Fantasy';
var SelectedId = null;
var StationMarkers = {};
var StationGroupLineLayer = null;
var CurrentBaseSize = 5;
var SelectedItinerary = null;
var CurrentStationPopup = null;
var BasemapLayers = {};
var MAP_NAME;
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
var TeamMapMarkers = [];
var TeamMapLeague = null;
var DestinationMarkers = {};
var SelectedDestination = null;

const STROKE_WEIGHT = 2.5;
const HOVER_STROKE_WEIGHT = 5;
const TRANSFER_DISTANCE_KM = 1.0;
const NEARBY_STATION_KM = 0.5;
const STATION_POPUP_RADIUS_KM = 0.4;
const MAX_IDLE_STATION_MARKERS = 2000;
const MERGE_OVERLAP_RATIO = 0.6;
const NEUTRAL_DOT_COLOR = '#52525b';
const DOT_SIZE = 6;
const FOCUS_SCALE = 1.6;

const CORRIDOR_OFFSET_MIN_ZOOM = 13;
const CORRIDOR_SAMPLE_STEP_M = 8;
const CORRIDOR_GRID_CELL_M = 5;
const CORRIDOR_LANE_SPACING_PX = 4;
const CORRIDOR_MAX_SAMPLE_POINTS = 60000;
const DOT_HIT_PADDING = 6;

var MapLoadingState = {
    initialized: false,
    dataLoaded: false,
    tilesLoaded: false
};

function UpdateLoadingProgress() {
    var loadingText = document.getElementById('LoadingText');
    var splashButton = document.getElementById('SplashButton');
    var loadingIndicator = document.getElementById('LoadingIndicator');

    if (!MapLoadingState.initialized) {
        loadingText.innerText = 'Initializing map...';
    } else if (!MapLoadingState.dataLoaded) {
        loadingText.innerText = 'Loading transit data...';
    } else if (!MapLoadingState.tilesLoaded) {
        loadingText.innerText = 'Loading map tiles...';
    } else {
        loadingText.style.display = 'none';
        loadingIndicator.classList.add('hidden');
        splashButton.classList.add('ready');
        var viewSelector = document.getElementById('ViewSelector');
        if (viewSelector) viewSelector.classList.add('ready');
    }
}

function MarkMapInitialized() {
    MapLoadingState.initialized = true;
    UpdateLoadingProgress();
}

function MarkDataLoaded() {
    MapLoadingState.dataLoaded = true;
    UpdateLoadingProgress();

    var totalRoutes = RegistryFull.length + RegistryPresentFull.length;
    var totalStations = Object.keys(StationsDetailed).length;

    var statsElement = document.getElementById('MapStats');
    if (statsElement) {
        statsElement.innerHTML = `<span class="stat-item">${totalRoutes} Routes</span><span class="stat-divider">•</span><span class="stat-item">${totalStations} Stations</span><div class="stat-counting">...and counting!</div>`;
        setTimeout(() => {
            statsElement.classList.add('visible');
        }, 100);
    }

    var mapElement = document.getElementById('map');
    if (mapElement) {
        setTimeout(() => {
            mapElement.classList.add('loaded');
        }, 100);
    }
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

function SelectSplashView(card) {
    document.querySelectorAll('.ViewOption').forEach(function(c) {
        c.classList.remove('selected');
    });
    card.classList.add('selected');
}

function CloseSplash() {
    var splash = document.getElementById('SplashScreen');
    var mapBlur = document.getElementById('MapBlur');
    var skeleton = document.getElementById('MapSkeleton');
    var background = document.getElementById('LoadingBackground');
    var sidebar = document.getElementById('Sidebar');

    var selected = document.querySelector('.ViewOption.selected');
    if (selected) {
        var view = selected.getAttribute('data-view');
        var parts = view.split('-');
        var mode = parts[0] === 'present' ? 'Present' : 'Fantasy';
        var detail = parts[1] === 'detailed' ? 'Detailed' : 'Full';
        if (CurrentMapMode !== mode) SwitchMapMode(mode);
        if (CurrentDetail !== detail) SetDetailLevel(detail);
    }

    splash.classList.add('hidden');
    mapBlur.classList.add('hidden');
    if (skeleton) skeleton.classList.add('hidden');
    if (background) background.classList.add('hidden');
    ScheduleCorridorOffsets();

    if (sidebar) {
        sidebar.classList.remove('splash-hidden');
        sidebar.classList.add('splash-visible');
    }
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
    if (CurrentMapMode === 'Fantasy') {
        return CurrentDetail === 'Detailed' ? RegistryDetailed : RegistryFull;
    }
    return CurrentDetail === 'Detailed' ? RegistryPresent : RegistryPresentFull;
}

function GetHiddenRegistries() {
    var active = GetActiveRegistry();
    return [RegistryDetailed, RegistryFull, RegistryPresent, RegistryPresentFull].filter(function(r) { return r !== active; });
}

function SetDetailLevel(Level) {
    if (CurrentDetail === Level) return;
    CurrentDetail = Level;
    DisabledModes.clear();
    ApplySwitchedRegistry();
    Stations = (Level === 'Detailed') ? StationsDetailed : AllNodes;

    var btnFull = document.getElementById('BtnFullPlan');
    var btnDetailed = document.getElementById('BtnDetailed');
    if (btnFull && btnDetailed) {
        btnFull.classList.toggle('active', Level === 'Full');
        btnDetailed.classList.toggle('active', Level === 'Detailed');
    }

    Reset();
    BuildByMode();
}

function SwitchMapMode(Mode) {
    if (CurrentMapMode === Mode) return;
    CurrentMapMode = Mode;
    DisabledModes.clear();
    ApplySwitchedRegistry();
    Stations = (CurrentDetail === 'Detailed') ? StationsDetailed : AllNodes;
    Reset();

    var control = document.getElementById('MapViewControl');
    var colFuture = document.getElementById('MapViewFutureCol');
    var colPresent = document.getElementById('MapViewPresentCol');

    if (Mode === 'Fantasy') {
        control.classList.remove('present-mode');
        if (colFuture) colFuture.classList.add('active-col');
        if (colPresent) colPresent.classList.remove('active-col');
    } else {
        control.classList.add('present-mode');
        if (colFuture) colFuture.classList.remove('active-col');
        if (colPresent) colPresent.classList.add('active-col');
    }
    UpdateProjectMarkersVisibility();
    UpdateDestinationMarkersVisibility();
    BuildByMode();
    if (TeamMapLeague) ShowTeamMarkersForLeague(TeamMapLeague);
}

function SwitchTab(Tab) {
    document.querySelectorAll('.Tab').forEach(T => T.classList.remove('active'));
    if (Tab === 'Lines') {
        document.querySelector('.Tab[onclick*="Lines"]').classList.add('active');
        document.getElementById('LinesView').style.display = 'flex';
        document.getElementById('PlannerView').style.display = 'none';
    } else {
        document.querySelector('.Tab[onclick*="Planner"]').classList.add('active');
        document.getElementById('LinesView').style.display = 'none';
        document.getElementById('PlannerView').style.display = 'flex';
    }
}

function ShowAutocomplete(InputId, MenuId, Value) {
    var Menu = document.getElementById(MenuId);
    if (!Value || Value.length < 2) {
        Menu.classList.remove('show');
        return;
    }

    var Matches = Object.keys(Stations).filter(K =>
        K.toLowerCase().includes(Value.toLowerCase()) ||
        (Stations[K].Label && Stations[K].Label.toLowerCase().includes(Value.toLowerCase()))
    ).slice(0, 8);

    if (Matches.length === 0) {
        Menu.classList.remove('show');
        return;
    }

    var Html = '';
    Matches.forEach(SN => {
        var S = Stations[SN];
        var Lines = Registry.filter(L => L.AllLineStations.includes(SN));
        var LineHtml = Lines.slice(0, 3).map(L =>
            `<span class='AutocompleteLineBadge'><span class='AutocompleteLineDot' style='background:${L.Color}'></span>${L.Name}</span>`
        ).join('');
        var DisplayName = CleanStationName(S.Label || SN);
        Html += `<div class='AutocompleteItem' onmousedown="SelectStation('${InputId}', '${SN}', '${DisplayName}')">
            <span class='AutocompleteStationName'>${DisplayName}</span>
            <div class='AutocompleteLines'>${LineHtml}</div>
        </div>`;
    });

    Menu.innerHTML = Html;
    Menu.classList.add('show');
}

function HideAutocomplete(MenuId) {
    setTimeout(() => document.getElementById(MenuId).classList.remove('show'), 200);
}

function SelectStation(InputId, StationKey, StationLabel) {
    document.getElementById(InputId).value = StationLabel;
    document.getElementById(InputId).setAttribute('data-station', StationKey);
}

function PlanTrip() {
    var OriginKey = document.getElementById('OriginInput').getAttribute('data-station');
    var DestKey = document.getElementById('DestInput').getAttribute('data-station');
    var Results = document.getElementById('PlannerResults');

    if (!OriginKey || !DestKey) {
        Results.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;">Please select both origin and destination</div>';
        return;
    }

    if (OriginKey === DestKey) {
        Results.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;">Origin and destination are the same</div>';
        return;
    }

    var Paths = FindPaths(OriginKey, DestKey);

    if (!Paths || Paths.length === 0) {
        Results.innerHTML = '<div style="padding:20px;text-align:center;color:#94a3b8;">No route found</div>';
        return;
    }

    var Html = '';
    Paths.forEach((P, I) => {
        Html += `<div class='TripResult' data-path='${JSON.stringify(P).replace(/'/g, "&apos;")}' onclick='SelectItinerary(${I}, this)'>
            <div class='ItineraryHeader'>Route ${I + 1} • ${P.Transfers} Transfer${P.Transfers === 1 ? '' : 's'}</div>`;

        P.Path.forEach((S, Idx) => {
            if (Idx === 0) {
                Html += `<div class='Step' style='--step-color:${S.Line.Color}'>
                    <div class='StepLine'>${S.Line.Operator} ${S.Line.Name}</div>
                    <div class='StepAction'>Board at ${CleanStationName(Stations[S.FromStation]?.Label || S.FromStation)}</div>
                </div>`;
            }

            if (S.Transfer) {
                Html += `<div class='Step' style='--step-color:${S.Line.Color}'>
                    <div class='StepAction'>Transfer to ${S.Line.Operator} ${S.Line.Name}<span class='TransferBadge'>Transfer</span></div>
                </div>`;
            }

            if (Idx === P.Path.length - 1) {
                Html += `<div class='Step' style='--step-color:${S.Line.Color}'>
                    <div class='StepAction'>Alight at ${CleanStationName(Stations[S.ToStation]?.Label || S.ToStation)}</div>
                </div>`;
            }
        });

        Html += '</div>';
    });

    Results.innerHTML = Html;
}

function FindPaths(Origin, Dest, MaxTransfers = 3) {
    var Queue = [{Station: Origin, Path: [], Transfers: 0, Visited: new Set([Origin])}];
    var AllPaths = [];

    while (Queue.length > 0 && AllPaths.length < 5) {
        var Current = Queue.shift();

        if (Current.Station === Dest) {
            AllPaths.push({Path: Current.Path, Transfers: Current.Transfers});
            continue;
        }

        if (Current.Transfers > MaxTransfers) continue;

        var ConnectedLines = Registry.filter(L => L.AllLineStations.includes(Current.Station));

        ConnectedLines.forEach(Line => {
            var StationIdx = Line.AllLineStations.indexOf(Current.Station);
            var Pattern = Line.Patterns[0];

            Pattern.Stations.forEach((NextStation, Idx) => {
                if (Current.Visited.has(NextStation)) return;

                var NewVisited = new Set(Current.Visited);
                NewVisited.add(NextStation);

                var NewPath = [...Current.Path];
                var IsTransfer = Current.Path.length > 0 && Current.Path[Current.Path.length - 1].Line.Id !== Line.Id;

                NewPath.push({
                    FromStation: Current.Station,
                    ToStation: NextStation,
                    LineStartStation: Pattern.Stations[0],
                    Line: {Id: Line.Id, Name: Line.Name, Operator: Line.Operator, Color: Line.Color, Weight: Line.Weight},
                    Transfer: IsTransfer,
                    SequenceInfo: `${StationIdx + 1}/${Line.AllLineStations.length}`
                });

                Queue.push({
                    Station: NextStation,
                    Path: NewPath,
                    Transfers: Current.Transfers + (IsTransfer ? 1 : 0),
                    Visited: NewVisited
                });
            });
        });
    }

    return AllPaths.sort((a, b) => a.Transfers - b.Transfers);
}

function HandleMapClick(E) {
    if (CurrentStationPopup) {
        CloseStationPopup();
    } else if (!SelectedItinerary) {
        Reset();
    }
}

function StationGroupBase(SN) {
    var I = SN.indexOf(' {');
    return I === -1 ? SN : SN.substring(0, I);
}

function StationGroupMembers(SN) {
    var Base = StationGroupBase(SN);
    return Object.keys(Stations).filter(K => StationGroupBase(K) === Base);
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
function ScoreMatch(label, q) {
    var l = NormalizeSearchText(label), qn = NormalizeSearchText(q);
    if (!qn) return 0;
    if (l === qn) return 3;
    if (l.startsWith(qn)) return 2;
    if (l.includes(qn)) return 1;
    return 0;
}

function GetLineSegments(Geo) {
    if (!Geo) return [];
    if (Geo.type === 'LineString') return [Geo.coordinates];
    if (Geo.type === 'MultiLineString') return Geo.coordinates;
    if (Geo.type === 'FeatureCollection') return [].concat.apply([], Geo.features.map(F => F.geometry ? GetLineSegments(F.geometry) : []));
    return [];
}
function FlattenLineCoords(Geo) { return [].concat.apply([], GetLineSegments(Geo)); }

function LinesServingKeys(keys) {
    return Registry.filter(function(L) {
        return !DisabledModes.has(L.ModeId) && L.AllLineStations.some(function(K) { return keys.includes(K); });
    });
}

function ForEachVisibleLine(StyleFn) {
    Registry.forEach(function(L) {
        var Ly = window[L.Id];
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
    GetHiddenRegistries().forEach(function(HR) {
        HR.forEach(function(L) { var Ly = window[L.Id]; if (Ly) HideLayer(Ly); });
    });
}

function ApplySwitchedRegistry() {
    var newRegistry = GetActiveRegistry();
    EnsureRegistryLayersCreated(newRegistry);
    GetHiddenRegistries().forEach(function(R) {
        R.forEach(L => { var Ly = window[L.Id]; if (Ly) HideLayer(Ly); });
    });
    newRegistry.forEach(L => { var Ly = window[L.Id]; if (Ly) ShowLayer(Ly, L.Color, L.Weight); });
    Registry = newRegistry;
    return newRegistry;
}

function SetMarkerEnlarged(M, S, enlarged) {
    if (M instanceof L.CircleMarker) {
        var R = S && S.Major ? CurrentBaseSize * 2 : CurrentBaseSize;
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

function ShowStationPopup(SN, FromMarker = false) {
    var S = Stations[SN];
    if (!S) return;
    var GroupKeys = StationGroupMembers(SN);

    EnsureGroupMarkersExist(GroupKeys);

    SelectedStationGroup.forEach(function(PrevKey) {
        if (GroupKeys.includes(PrevKey)) return;
        var PrevM = StationMarkers[PrevKey];
        if (PrevM) {
            SetMarkerEnlarged(PrevM, Stations[PrevKey], false);
            SetMarkerSelectedGlow(PrevM, false);
        }
    });
    SelectedStationKey = SN;
    SelectedStationGroup = GroupKeys;

    GroupKeys.forEach(function(GK) {
        var GS = Stations[GK];
        var GM = StationMarkers[GK];
        if (GM) {
            SetMarkerEnlarged(GM, GS, true);
            SetMarkerSelectedGlow(GM, true);
        }
    });

    SelectedId = null;
    UpdateHeader(null);
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");

    var Overlay = document.getElementById('StationPopupOverlay');
    var ConnectedLines = Registry.filter(L =>
        L.AllLineStations.some(StationKey => GroupKeys.includes(StationKey))
    );

    var NearbyGroupMap = {};
    FindNearbyStationKeys(S, GroupKeys).forEach(function(OtherKey) {
        var OtherStation = Stations[OtherKey];
        var OtherBase = StationGroupBase(OtherKey);
        if (!NearbyGroupMap[OtherBase]) NearbyGroupMap[OtherBase] = {Keys: [], Labels: []};
        NearbyGroupMap[OtherBase].Keys.push(OtherKey);
        var OtherLabel = CleanStationName(OtherStation.Label || OtherBase);
        if (!NearbyGroupMap[OtherBase].Labels.includes(OtherLabel)) {
            NearbyGroupMap[OtherBase].Labels.push(OtherLabel);
        }
    });
    var NearbyGroups = Object.values(NearbyGroupMap)
        .map(G => ({
            Label: G.Labels.reduce((Best, L) => L.length > Best.length ? L : Best),
            Keys: G.Keys,
            Lines: Registry.filter(L => L.AllLineStations.some(K => G.Keys.includes(K))),
        }))
        .filter(G => G.Lines.length > 0)
        .sort((A, B) => A.Label.localeCompare(B.Label));

    var StationLabel = CleanStationName(S.Label || SN);
    document.getElementById('PopupStationName').innerText = StationLabel;
    document.getElementById('PopupStationType').innerText = S.Type || '';

    var ModeGroups = {};
    ConnectedLines.forEach(L => {
        if (!ModeGroups[L.ModeId]) ModeGroups[L.ModeId] = [];
        ModeGroups[L.ModeId].push(L);
    });

    var Html = '';
    Object.keys(Modes).forEach(ModeId => {
        if (!ModeGroups[ModeId]) return;
        var ModeData = Modes[ModeId];
        var Lines = ModeGroups[ModeId];

        Html += `<details class='PopupModeGroup' open>
            <summary class='PopupModeHeader'>
                <span class='PopupModeIndicator'>▶</span>
                <span class='ModeDot' style='background:${ModeData.Color}'></span>
                ${ModeData.Name}
            </summary>
            <div class='PopupModeContent'>`;

        var OperatorGroups = {};
        Lines.forEach(L => {
            if (!OperatorGroups[L.Operator]) OperatorGroups[L.Operator] = [];
            OperatorGroups[L.Operator].push(L);
        });

        Object.keys(OperatorGroups).sort().forEach(Op => {
            Html += `<details class='PopupOperatorGroup' open>
                <summary class='PopupOperatorHeader'>
                    <span class='PopupOperatorIndicator'>▶</span>${Op}
                </summary>
                <div class='PopupOperatorContent'>`;

            OperatorGroups[Op].forEach(L => {
                Html += `<div class='PopupLineItem' onclick='SelectLine("${L.Id}")'>
                    <span class='PopupLineDot' style='background:${L.Color}'></span>
                    <div class='PopupLineText'>
                        <div class='PopupLineName'>${L.Name}</div>
                    </div>
                </div>`;
            });

            Html += '</div></details>';
        });

        Html += '</div></details>';
    });

    if (NearbyGroups.length) {
        Html += `<details class='PopupNearbySection' open>
            <summary class='PopupNearbyHeader'>
                <span class='PopupModeIndicator'>▶</span>
                Nearby Stations
            </summary>
            <div class='PopupNearbyContent'>`;
        NearbyGroups.forEach(G => {
            Html += `<div class='PopupNearbyItem' onclick='ShowStationPopup("${G.Keys[0].replace(/"/g, '&quot;')}")'>
                <div class='StationSearchName'>${G.Label}</div>
                <div class='StationSearchLines'>`;
            G.Lines.forEach(L => {
                Html += `<span class='StationSearchPill' style='background:${L.Color}'>${L.Name}</span>`;
            });
            Html += '</div></div>';
        });
        Html += '</div></details>';
    }

    document.getElementById('PopupContent').innerHTML = Html;
    Overlay.style.display = 'flex';
    CurrentStationPopup = SN;
    ShowZoomToStationButton();
    RefreshStationDots();

    var ConnectedLineIds = ConnectedLines.map(L => L.Id);
    ApplyLineEmphasis(L => ConnectedLineIds.includes(L.Id), 1);
}

function CloseStationPopup() {
    if (CurrentStationPopup === '__destination__') {
        CloseDestinationPopup();
        return;
    }
    if (SelectedStationGroup.length) {
        SelectedStationGroup.forEach(function(Key) {
            var M = StationMarkers[Key];
            if (M) {
                SetMarkerEnlarged(M, Stations[Key], false);
                SetMarkerSelectedGlow(M, false);
            }
        });
        SelectedStationKey = null;
        SelectedStationGroup = [];
    }
    document.getElementById('StationPopupOverlay').style.display = 'none';
    CurrentStationPopup = null;
    HideZoomToStationButton();
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
        window[MAP_NAME].flyToBounds(GroupLocations, {paddingTopLeft: [400, 100], paddingBottomRight: [100, 100], animate: true, duration: 0.6, maxZoom: 16});
    } else if (S.Location) {
        var CurrentZoom = window[MAP_NAME].getZoom();
        var TargetZoom = Math.max(CurrentZoom, 12);
        window[MAP_NAME].flyTo(S.Location, TargetZoom, {animate: true, duration: 0.6});
    }
}

function GetAllPointsNearStation(SL, LG) {
    let C = FlattenLineCoords(LG);
    let P = [];
    for (let I = 0; I < C.length; I++) {
        let Co = C[I], Dx = Co[1] - SL[0], Dy = Co[0] - SL[1];
        P.push({Index: I, Distance: Math.sqrt(Dx * Dx + Dy * Dy)});
    }
    return P.sort((A, B) => A.Distance - B.Distance);
}

function FindBestSegment(LG, SSL, ESL) {
    let SP = GetAllPointsNearStation(SSL, LG);
    let EP = GetAllPointsNearStation(ESL, LG);
    let BS = null, ML = Infinity;

    for (let S of SP.slice(0, 5))
        for (let E of EP.slice(0, 5))
            if (E.Index > S.Index && E.Index - S.Index < ML) {
                ML = E.Index - S.Index;
                BS = {Start: S.Index, End: E.Index};
            }
    return BS;
}

function ExtractLineSegment(LG, SI, EI) {
    let C = FlattenLineCoords(LG);
    return {type: 'Feature', geometry: {type: 'LineString', coordinates: C.slice(Math.min(SI, EI), Math.max(SI, EI) + 1)}, properties: {}};
}

function SelectItinerary(I, E) {
    let PD = JSON.parse(E.getAttribute('data-path').replace(/&quot;/g, '"'));
    document.querySelectorAll('.TripResult').forEach(El => El.classList.remove('selected'));
    E.classList.add('selected');
    SelectedItinerary = PD;
    SelectedId = null;
    ClearStationMarkers();
    ApplyLineEmphasis(() => false, 1);

    if (window.ItineraryLayers) window.ItineraryLayers.forEach(La => window[MAP_NAME].removeLayer(La));
    window.ItineraryLayers = [];

    let LS = [], CS = null;
    PD.Path.forEach(S => {
        if (!CS || CS.LineId !== S.Line.Id) {
            if (CS) LS.push(CS);
            CS = {LineId: S.Line.Id, Line: S.Line, Segments: [{FromStation: S.FromStation, ToStation: S.ToStation, LineStartStation: S.LineStartStation, SequenceInfo: S.SequenceInfo}]};
        } else CS.Segments.push({FromStation: S.FromStation, ToStation: S.ToStation, LineStartStation: S.LineStartStation, SequenceInfo: S.SequenceInfo});
    });
    if (CS) LS.push(CS);

    let AB = [], AS = new Set();
    LS.forEach(Seg => {
        let LL = window[Seg.LineId];
        if (!LL) return;
        let LGJ = LL.toGeoJSON();
        let LGeo = LGJ.type === 'FeatureCollection' ? {type: 'LineString', coordinates: FlattenLineCoords(LGJ)} : LGJ.geometry;

        Seg.Segments.forEach(Sg => {
            let SS = Stations[Sg.LineStartStation], ES = Stations[Sg.ToStation];
            if (!SS || !ES) return;
            AS.add(Sg.FromStation);
            AS.add(Sg.ToStation);

            let BSg = FindBestSegment(LGeo, SS.Location, ES.Location);
            if (!BSg) return;

            let HL = L.geoJson(ExtractLineSegment(LGeo, BSg.Start, BSg.End), {
                style: {color: Seg.Line.Color, weight: Seg.Line.Weight * 3, opacity: 1, lineJoin: 'round', lineCap: 'round'}
            }).addTo(window[MAP_NAME]);

            if (HL.setZIndex) HL.setZIndex(10000);
            window.ItineraryLayers.push(HL);
        });
    });

    AS.forEach(SN => {
        var S = Stations[SN];
        if (!S) return;
        var PC = PD.Path.filter(St => St.ToStation === SN || St.FromStation === SN).map(St => St.Line)[0]?.Color || '#cbd5e1';
        var FR = S.Major ? 12 : 6;
        MakeStationMarker(SN, S.Location, FR, PC, S.Label);
        AB.push(S.Location);
    });

    if (AB.length > 0) window[MAP_NAME].fitBounds(AB, {paddingTopLeft: [400, 100], paddingBottomRight: [100, 100], animate: true, duration: 1.2});
}

function ToggleSidebar() {
    var S = document.getElementById('Sidebar');
    var H = document.getElementById('Handle');
    H.innerHTML = S.classList.toggle('collapsed') ? '▶' : '◀';
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
        H += `<details class='GroupBox${IsOff ? ' mode-group-off' : ''}' ${IsOff ? '' : ''}><summary class='GroupTitle'><span class='Indicator'>▶</span><span class='ModeDot' style='background:${MD.Color}'></span>${MD.Name}</summary><div style='padding:0 10px 10px 15px;'>`;

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
    BuildModeToggles();
}

function SetLayerStyle(Ly, StyleObj) {
    Ly.setStyle(StyleObj);
    if (Ly.eachLayer) {
        Ly.eachLayer(function(FL) { FL.setStyle(StyleObj); });
    }
}

function Visuals(I) {
    ApplyLineEmphasis(L => L.Id === I, 3);
}

function UpdateHeader(I) {
    var H = document.getElementById('HeaderInfo');
    if (!I) {
        H.style.display = 'none';
        return;
    }
    var L = Registry.find(X => X.Id === I);
    if (!L) {
        H.style.display = 'none';
        return;
    }
    H.style.display = 'flex';
    H.innerHTML = `<div style='text-align:center;'><div style='font-size:9px;font-weight:800;color:${L.Color};text-transform:uppercase;letter-spacing:1.5px;'>${L.Operator} • ${L.ModeName}</div><div style='font-size:22px;font-weight:900;color:#1e293b;letter-spacing:-0.4px;'>${L.Name}</div></div>`;
}

function RenderDetails(I) {
    var L = Registry.find(X => X.Id === I);
    var T = document.getElementById('Details_' + I);
    if (!T || T.innerHTML !== "") {
        if (T) T.innerHTML = "";
        return;
    }
    var H = "";
    L.Patterns.forEach((P, Idx) => {
        H += `<details class='PatternBox' open><summary class='PatternTitle'><span class='Indicator'>▶</span>${P.Name}</summary><div class='PatternContent'>${P.Diagram || ''}</div></details>`;
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
    if (Ly._geojsonFiles && !Ly._geojsonLoaded) {
        EnsureLayerLoaded(Ly, function() {
            Ly.setStyle({color: Color, weight: Weight, opacity: 1.0, fillOpacity: 0.2});
        });
        return;
    }
    Ly.setStyle({color: Color, weight: Weight, opacity: 1.0, fillOpacity: 0.2});
}

var FilterList = Debounce(_DoFilterList, 100);

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
            if (OM) {
                OG.open = true;
                GM = true;
            }
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

function FindNearbyStationKeys(S, ExcludeKeys) {
    var Nearby = [];
    if (!S || !S.Location) return Nearby;
    var LatSpan = STATION_POPUP_RADIUS_KM / 111;
    var LonSpan = LatSpan / Math.max(0.01, Math.cos(S.Location[0] * Math.PI / 180));
    Object.keys(Stations).forEach(function(Key) {
        if (ExcludeKeys.includes(Key)) return;
        var Other = Stations[Key];
        if (!Other || !Other.Location) return;
        if (Math.abs(Other.Location[0] - S.Location[0]) > LatSpan) return;
        if (Math.abs(Other.Location[1] - S.Location[1]) > LonSpan) return;
        if (CalculateDistance(S.Location[0], S.Location[1], Other.Location[0], Other.Location[1]) <= STATION_POPUP_RADIUS_KM) Nearby.push(Key);
    });
    return Nearby;
}

function BuildStationTooltip(SN, SL) {
    var S = Stations[SN];
    var GroupKeys = StationGroupMembers(SN);
    var NearbyStations = GroupKeys.concat(FindNearbyStationKeys(S, GroupKeys));

    var LH = Registry.filter(L =>
        L.AllLineStations.some(StationKey => NearbyStations.includes(StationKey))
    );

    var MM = {};
    LH.forEach(L => {
        if (!MM[L.ModeId]) MM[L.ModeId] = [];
        MM[L.ModeId].push(L);
    });

    var PM = S && S.Type === "Airport" ? ` <span class="PlaneIcon">✈</span>` : '';
    var H = `<div class='StationPopup'><b>${CleanStationName(SL || SN)}${PM}</b>`;

    Object.keys(Modes).forEach(ModeId => {
        if (!MM[ModeId]) return;
        var ModeData = Modes[ModeId];
        H += `<div class='ModeHeader'>${ModeData.Name}</div>`;
        MM[ModeId].forEach(L => H += `<div class='HubLineContent'><span class='HubDot' style='background:${L.Color}'></span><span><span class='OpTag'>${L.Operator}</span><span class='Separator'>•</span>${L.Name}</span></div>`);
    });

    return H + `</div>`;
}

function SnapToGeometry(LatLon, LGeo) {
    var Segs = GetLineSegments(LGeo);
    if (Segs.length === 0) return LatLon;

    var PLat = LatLon[0], PLon = LatLon[1];
    var BestLat = PLat, BestLon = PLon, BestDist = Infinity;
    var M_PER_DEG_LAT = 111320.0;

    Segs.forEach(function(Coords) {
        for (var I = 0; I < Coords.length - 1; I++) {
            var ALon = Coords[I][0],   ALat = Coords[I][1];
            var BLon = Coords[I+1][0], BLat = Coords[I+1][1];
            var CosLat = Math.cos((ALat + BLat) / 2 * Math.PI / 180);
            var M_PER_DEG_LON = M_PER_DEG_LAT * CosLat;

            var Px = (PLon - ALon) * M_PER_DEG_LON;
            var Py = (PLat - ALat) * M_PER_DEG_LAT;
            var Dx = (BLon - ALon) * M_PER_DEG_LON;
            var Dy = (BLat - ALat) * M_PER_DEG_LAT;
            var LenSq = Dx * Dx + Dy * Dy;

            var T = LenSq > 0 ? Math.max(0, Math.min(1, (Px * Dx + Py * Dy) / LenSq)) : 0;
            var ClosestLat = ALat + T * (BLat - ALat);
            var ClosestLon = ALon + T * (BLon - ALon);

            var Rx = (PLon - ClosestLon) * M_PER_DEG_LON;
            var Ry = (PLat - ClosestLat) * M_PER_DEG_LAT;
            var Dist = Math.sqrt(Rx * Rx + Ry * Ry);

            if (Dist < BestDist) {
                BestDist = Dist;
                BestLat = ClosestLat;
                BestLon = ClosestLon;
            }
        }
    });

    return [BestLat, BestLon];
}

function GetLineGeoJson(I) {
    var Ly = window[I];
    if (!Ly || typeof Ly.toGeoJSON !== 'function') return null;
    var LGJ = Ly.toGeoJSON();
    if (LGJ.type === 'FeatureCollection') return LGJ;
    return LGJ.geometry || null;
}

function ClearStationMarkers() {
    Object.values(StationMarkers).forEach(M => window[MAP_NAME].removeLayer(M));
    StationMarkers = {};
    if (StationGroupLineLayer) { window[MAP_NAME].removeLayer(StationGroupLineLayer); StationGroupLineLayer = null; }
}

// Leaflet closes a bound tooltip the instant the mouse leaves the source marker, which makes it
// impossible to move the cursor onto the tooltip itself (e.g. to scroll a long line list). This
// wraps the marker's closeTooltip with a short grace period, cancelled if the cursor lands on
// either the marker or the tooltip element before the grace period elapses. The override MUST
// happen before bindTooltip() is called: Leaflet captures a direct reference to closeTooltip
// internally at bind time, so replacing it afterward has no effect on that internal listener.
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
    // Minor stations wait briefly before opening, so quickly moving the mouse across/past one
    // en route to a major station doesn't interrupt with its tooltip. Major stations stay instant.
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
    }).addTo(window[MAP_NAME]);
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
        var ServingLine = Registry.find(L => L.AllLineStations.includes(Key));
        var Color = ServingLine ? ServingLine.Color : '#94a3b8';
        var Radius = S.Major ? CurrentBaseSize * 2 : CurrentBaseSize;
        MakeStationMarker(Key, S.Location, Radius, Color, S.Label);
    });
}

function FocusedLine() {
    var id = SelectedId;
    return id ? Registry.find(L => L.Id === id) : null;
}

// A station's visibility and size are looked up directly from its highest-priority mode — the one
// with the lowest reveal zoom (i.e. the most important mode present). No bonuses, multipliers, or
// caps: just "this mode becomes visible at zoom N, at size P". A multi-mode station reveals as soon
// as its best mode would on its own, since hiding it would hide that mode's own presence there too.
const LINE_COUNT_FOR_MAX_SIZE = 8;

// Major stations scale smoothly between their mode's min and max size based on how many individual
// lines serve them, so a station with one route doesn't render the same as one with eight — capped
// at both ends so a single mega-hub can't run away in size and a two-line station isn't invisible.
function ScaleMajorSize(minPx, maxPx, lineCount) {
    var t = Math.min(Math.max((lineCount - 1) / (LINE_COUNT_FOR_MAX_SIZE - 1), 0), 1);
    return minPx + t * (maxPx - minPx);
}

function GetStationVisual(modesSet, isMajor, lineCount) {
    var revealZoom = Infinity, px = DOT_SIZE;
    modesSet.forEach(function(m) {
        var md = Modes[m];
        if (!md) return;
        var rz = isMajor ? md.MajorZoom : md.MinorZoom;
        if (rz < revealZoom) {
            revealZoom = rz;
            px = isMajor ? ScaleMajorSize(md.MajorPxMin, md.MajorPxMax, lineCount) : md.MinorPx;
        }
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
    var m = L.marker(location, {icon: icon, pane: 'stationDotPane', zIndexOffset: zPriority || 0}).addTo(window[MAP_NAME]);
    BindHoverableStationTooltip(m, '', {sticky: false, className: 'StationTooltip', direction: 'top', offset: [0, -10], pane: 'hoverTooltipPane'}, isMajor);
    m.on('mouseover', function() {
        if (!m._tooltipBuilt) { m.setTooltipContent(BuildStationTooltip(sn, (Stations[sn] || {}).Label)); m._tooltipBuilt = true; }
        HighlightStationMarker(sn, true);
    });
    m.on('mouseout', function() { HighlightStationMarker(sn, false); });
    m.on('click', function(e) { L.DomEvent.stopPropagation(e); ShowStationPopup(sn, true); });
    StationMarkers[sn] = m;
}

function RefreshStationGroupLines(wanted) {
    if (StationGroupLineLayer) { window[MAP_NAME].removeLayer(StationGroupLineLayer); StationGroupLineLayer = null; }

    var finalLocation = {};
    Object.keys(wanted).forEach(function(sn) {
        var w = wanted[sn];
        (w.mergedWith || [sn]).forEach(function(memberSn) { finalLocation[memberSn] = w.location; });
    });

    var byBase = {};
    Object.keys(finalLocation).forEach(function(sn) {
        var base = StationGroupBase(sn);
        if (base === sn) return;
        var loc = finalLocation[sn];
        var bucket = byBase[base] || (byBase[base] = []);
        if (!bucket.some(function(l) { return l[0] === loc[0] && l[1] === loc[1]; })) bucket.push(loc);
    });

    var paths = [];
    Object.keys(byBase).forEach(function(base) {
        var locs = byBase[base];
        if (locs.length < 2) return;
        paths.push(ShortestPathThroughPoints(locs));
    });
    if (!paths.length) return;

    StationGroupLineLayer = L.polyline(paths, {
        pane: 'stationGroupPane', color: '#475569', weight: 2.5, opacity: 0.85,
        dashArray: '1,7', lineCap: 'round', interactive: false,
    }).addTo(window[MAP_NAME]);
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

function MergeOverlappingCandidates(candidates) {
    if (candidates.length < 2) return candidates;
    var map = window[MAP_NAME];
    var order = candidates.map(function(_, i) { return i; }).sort(function(a, b) { return candidates[b].size - candidates[a].size; });
    var clusters = [];
    order.forEach(function(i) {
        var c = candidates[i];
        var p = map.latLngToContainerPoint(c.location);
        var r = c.size / 2;
        var target = null;
        for (var k = 0; k < clusters.length; k++) {
            var cl = clusters[k];
            var dist = Math.hypot(p.x - cl.point.x, p.y - cl.point.y);
            if (dist <= (cl.radius + r) * MERGE_OVERLAP_RATIO) { target = cl; break; }
        }
        if (target) target.members.push(c);
        else clusters.push({point: p, radius: r, members: [c]});
    });
    return clusters.map(function(cl) {
        if (cl.members.length === 1) return cl.members[0];
        // The merged dot's identity (which station's location/tooltip represents the cluster) should
        // be whichever member has the most lines/importance, not just whichever was processed first —
        // otherwise a smaller nearby station can arbitrarily "win" over a much busier one it's merged with.
        var anchor = cl.members.reduce(function(best, m) { return m.importance > best.importance ? m : best; }, cl.members[0]);
        return {
            sn: anchor.sn, location: anchor.location, color: anchor.color,
            size: Math.max.apply(null, cl.members.map(function(m) { return m.size; })),
            major: cl.members.some(function(m) { return m.major; }),
            importance: Math.max.apply(null, cl.members.map(function(m) { return m.importance; })),
            zPriority: Math.max.apply(null, cl.members.map(function(m) { return m.zPriority || 0; })),
            mergedWith: cl.members.map(function(m) { return m.sn; }),
        };
    });
}

var ScheduleStationDots = Debounce(RefreshStationDots, 120);

var _linesByStationCache = null;
var _linesByStationCacheRegistry = null;
var _linesByStationCacheModesKey = null;

function GetLinesByStation() {
    var modesKey = DisabledModes.size ? Array.from(DisabledModes).sort().join(',') : '';
    if (_linesByStationCache && _linesByStationCacheRegistry === Registry && _linesByStationCacheModesKey === modesKey) {
        return _linesByStationCache;
    }
    var linesByStation = {};
    Registry.forEach(function(Ln) {
        if (DisabledModes.has(Ln.ModeId)) return;
        Ln.AllLineStations.forEach(function(sn) {
            var entry = linesByStation[sn] || (linesByStation[sn] = {lines: new Set(), modes: new Set()});
            entry.lines.add(Ln.Id);
            entry.modes.add(Ln.ModeId);
        });
    });
    _linesByStationCache = linesByStation;
    _linesByStationCacheRegistry = Registry;
    _linesByStationCacheModesKey = modesKey;
    return linesByStation;
}

function RefreshStationDots() {
    if (!window[MAP_NAME] || SelectedItinerary || CurrentStationPopup === '__destination__') return;

    var Focus = FocusedLine();
    var wanted = {};

    if (CurrentStationPopup) {
        var GroupKeys = SelectedStationGroup.length ? SelectedStationGroup : [CurrentStationPopup];
        GroupKeys.forEach(function(sn) {
            var s = Stations[sn] || AllNodes[sn];
            if (s && s.Location) wanted[sn] = {
                location: s.Location,
                color: NEUTRAL_DOT_COLOR,
                size: s.Major ? CurrentBaseSize * 2 : CurrentBaseSize,
                major: !!s.Major,
                zPriority: s.Major ? 1000 : 0,
            };
        });
    } else if (Focus) {
        var LGeo = (CurrentDetail === 'Detailed') ? GetLineGeoJson(Focus.Id) : null;
        var focusModes = new Set([Focus.ModeId]);
        Focus.AllLineStations.forEach(function(sn) {
            var s = Stations[sn];
            if (s) wanted[sn] = {
                location: LGeo ? SnapToGeometry(s.Location, LGeo) : s.Location,
                color: Focus.Color,
                size: Math.round(GetStationVisual(focusModes, !!s.Major, 1).px * FOCUS_SCALE),
                major: !!s.Major,
                zPriority: s.Major ? 1000 : 0,
            };
        });
    } else if (!StationDotsHidden) {
        var bounds = window[MAP_NAME].getBounds().pad(0.25);
        var zoom = window[MAP_NAME].getZoom();
        var linesByStation = GetLinesByStation();

        var candidates = [];
        Object.keys(linesByStation).forEach(function(sn) {
            var s = Stations[sn];
            if (!s || !s.Location || !bounds.contains(s.Location)) return;
            var entry = linesByStation[sn];
            var visual = GetStationVisual(entry.modes, !!s.Major, entry.lines.size);
            if (zoom < visual.revealZoom) return;
            // z-priority is driven directly by rendered size, so the biggest dots always win hover/click over smaller ones near them
            var importance = (s.Major ? 1000000 : 0) + visual.px * 1000 + entry.lines.size;
            candidates.push({sn: sn, location: s.Location, color: NEUTRAL_DOT_COLOR, size: visual.px, importance: importance, major: !!s.Major, zPriority: visual.px * 1000 + importance});
        });

        if (candidates.length > MAX_IDLE_STATION_MARKERS) {
            candidates.sort(function(a, b) { return b.importance - a.importance || a.sn.localeCompare(b.sn); });
            candidates = candidates.slice(0, MAX_IDLE_STATION_MARKERS);
        }
        candidates = MergeOverlappingCandidates(candidates);
        candidates.forEach(function(c) {
            wanted[c.sn] = {location: c.location, color: c.color, size: c.size, major: c.major, zPriority: c.zPriority, mergedWith: c.mergedWith};
        });
    }

    Object.keys(StationMarkers).forEach(function(sn) {
        if (!wanted[sn]) { window[MAP_NAME].removeLayer(StationMarkers[sn]); delete StationMarkers[sn]; }
    });
    Object.keys(wanted).forEach(function(sn) {
        if (!StationMarkers[sn]) MakeDotMarker(sn, wanted[sn].location, wanted[sn].color, wanted[sn].size, wanted[sn].major, wanted[sn].zPriority);
        else if (StationMarkers[sn].setZIndexOffset) StationMarkers[sn].setZIndexOffset(wanted[sn].zPriority);
    });
    RefreshStationGroupLines(wanted);
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

    // Selecting a line from a station popup on the map should surface the sidebar diagram too,
    // not just render it invisibly if the sidebar happens to be collapsed at the time
    var sidebar = document.getElementById('Sidebar');
    if (sidebar && sidebar.classList.contains('collapsed')) {
        sidebar.classList.remove('collapsed');
        var handle = document.getElementById('Handle');
        if (handle) handle.innerHTML = '◀';
    }
    var detailsEl = document.getElementById('Details_' + I);
    if (detailsEl) {
        // The line list nests each line inside an operator <details> inside a
        // mode <details> -- both collapsed by default. Opening them (same
        // mechanism FilterList already uses) is required before scrollIntoView
        // can actually bring the line's diagram into view.
        var opGroup = detailsEl.closest('.OpGroupBox');
        if (opGroup) opGroup.open = true;
        var modeGroup = detailsEl.closest('.GroupBox');
        if (modeGroup) modeGroup.open = true;
        detailsEl.scrollIntoView({behavior: 'smooth', block: 'nearest'});
    }

    var Ly = window[I];
    if (Ly) window[MAP_NAME].fitBounds(Ly.getBounds(), {paddingTopLeft: [400, 100], paddingBottomRight: [100, 100], animate: true, duration: 1.2});
}

function FocusStation(SN) {
    var S = Stations[SN];
    if (S) {
        HighlightStationMarker(SN, true);
        window[MAP_NAME].setView(S.Location, 15, {animate: true});
    }
}

function IsModeVisible(ModeId) {
    return !DisabledModes.has(ModeId);
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
        if (SelLine && DisabledModes.has(SelLine.ModeId)) {
            SelectedId = null;
        }
    }

    var Btn = document.querySelector(`.ModeFilterItem[data-mode="${ModeId}"]`);
    if (Btn) {
        var IsNowOn = !DisabledModes.has(ModeId);
        Btn.classList.toggle('mode-off', !IsNowOn);
        Btn.title = (IsNowOn ? 'Hide ' : 'Show ') + Modes[ModeId].Name;
    }
    UpdateModeFilterBadge();

    Reset();
}

var ModeFilterPanelOpen = false;

function ToggleModeFilterPanel(e) {
    if (e) e.stopPropagation();
    ModeFilterPanelOpen = !ModeFilterPanelOpen;
    var panel = document.getElementById('ModeFilterPanel');
    var btn = document.getElementById('ModeFilterToggleBtn');
    if (panel) panel.classList.toggle('open', ModeFilterPanelOpen);
    if (btn) btn.classList.toggle('open', ModeFilterPanelOpen);
}

function CloseModeFilterPanel() {
    if (!ModeFilterPanelOpen) return;
    ModeFilterPanelOpen = false;
    var panel = document.getElementById('ModeFilterPanel');
    var btn = document.getElementById('ModeFilterToggleBtn');
    if (panel) panel.classList.remove('open');
    if (btn) btn.classList.remove('open');
}

function UpdateModeFilterBadge() {
    var badge = document.getElementById('ModeFilterBadge');
    if (!badge) return;
    var hiddenCount = DisabledModes.size;
    badge.textContent = hiddenCount;
    badge.style.display = hiddenCount > 0 ? 'flex' : 'none';
}

function BuildModeToggles() {
    var Row = document.getElementById('ModeFilterRow');
    var Panel = document.getElementById('ModeFilterPanel');
    if (!Row || !Panel) return;

    var ActiveModeIds = [];
    Object.keys(Modes).forEach(function(ModeId) {
        if (Registry.some(function(L) { return L.ModeId === ModeId; })) ActiveModeIds.push(ModeId);
    });

    if (ActiveModeIds.length <= 1) {
        Row.style.display = 'none';
        return;
    }
    Row.style.display = 'flex';
    Panel.innerHTML = '';

    ActiveModeIds.forEach(function(ModeId) {
        var MD = Modes[ModeId];
        var IsOn = !DisabledModes.has(ModeId);
        var Item = document.createElement('button');
        Item.className = 'ModeFilterItem' + (IsOn ? '' : ' mode-off');
        Item.dataset.mode = ModeId;
        Item.title = (IsOn ? 'Hide ' : 'Show ') + MD.Name;
        Item.innerHTML = `<span class="ModeToggleDot" style="background:${MD.Color}"></span>` +
            `<span class="ModeFilterItemLabel">${MD.Name}</span>` +
            `<span class="ModeFilterSwitch"><span class="ModeFilterSwitchKnob"></span></span>`;
        Item.addEventListener('click', function(e) { e.stopPropagation(); ToggleMode(ModeId); });
        Panel.appendChild(Item);
    });

    UpdateModeFilterBadge();
}

document.addEventListener('click', function(e) {
    var row = document.getElementById('ModeFilterRow');
    if (ModeFilterPanelOpen && row && !row.contains(e.target)) CloseModeFilterPanel();
});

function Reset() {
    SelectedId = null;
    SelectedItinerary = null;
    SelectedStationKey = null;
    SelectedStationGroup = [];
    UpdateHeader(null);
    ClearStationMarkers();
    if (window.ItineraryLayers) window.ItineraryLayers.forEach(L => window[MAP_NAME].removeLayer(L));
    window.ItineraryLayers = [];
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");
    document.querySelectorAll('.TripResult').forEach(El => El.classList.remove('selected'));

    ForEachVisibleLine(function(L, Ly) {
        SetLayerStyle(Ly, {color: L.Color, weight: L.Weight, opacity: 1.0});
        if (Ly.setZIndex) Ly.setZIndex(L.ZIndex);
    });

    GetHiddenRegistries().forEach(HR => HR.forEach(L => {
        if (window[L.Id]) HideLayer(window[L.Id]);
    }));

    RefreshStationDots();
    ScheduleCorridorOffsets();
}

function SwitchBasemap(Name) {
    if (!BasemapLayers[Name]) return;
    document.querySelectorAll('.BasemapButton').forEach(B => B.classList.remove('active'));
    var Btn = document.getElementById(Name + 'Button');
    if (Btn) Btn.classList.add('active');
    Object.keys(BasemapLayers).forEach(function(N) {
        if (N === Name) BasemapLayers[N].addTo(window[MAP_NAME]);
        else window[MAP_NAME].removeLayer(BasemapLayers[N]);
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

// Destination pins are small, fixed-range map pins (not the photo-circle style projects still use),
// so they scale gently with zoom instead of with viewport size
var DEST_PIN_MIN_PX = 28;
var DEST_PIN_MAX_PX = 44;
var DEST_PIN_MIN_ZOOM = 9;
var DEST_PIN_MAX_ZOOM = 14;

function GetDestPinSize() {
    var zoom = window[MAP_NAME] ? window[MAP_NAME].getZoom() : DEST_PIN_MAX_ZOOM;
    var t = Math.max(0, Math.min(1, (zoom - DEST_PIN_MIN_ZOOM) / (DEST_PIN_MAX_ZOOM - DEST_PIN_MIN_ZOOM)));
    return Math.round(DEST_PIN_MIN_PX + t * (DEST_PIN_MAX_PX - DEST_PIN_MIN_PX));
}

function GetMarkerMaxSize() {
    var mapEl = window[MAP_NAME] && window[MAP_NAME].getContainer ? window[MAP_NAME].getContainer() : null;
    var w = mapEl ? mapEl.clientWidth : window.innerWidth;
    var h = mapEl ? mapEl.clientHeight : window.innerHeight;
    var longest = Math.max(w, h, 1);
    return Math.round(longest * MARKER_SIZE_PERCENT / 100);
}

function GetMarkerBaseSize() {
    var maxSize = GetMarkerMaxSize();
    var zoom = window[MAP_NAME] ? window[MAP_NAME].getZoom() : MARKER_SIZE_MAX_ZOOM;
    var t = (zoom - MARKER_SIZE_MIN_ZOOM) / (MARKER_SIZE_MAX_ZOOM - MARKER_SIZE_MIN_ZOOM);
    t = Math.max(0, Math.min(1, t));
    return Math.round(MARKER_SIZE_MIN_PX + t * (maxSize - MARKER_SIZE_MIN_PX));
}

function ForEachDestinationMarker(fn) {
    Object.keys(DestinationMarkers).forEach(function(cat) {
        Object.keys(DestinationMarkers[cat]).forEach(function(name) { fn(cat, name, DestinationMarkers[cat][name]); });
    });
}

function RefreshAllMarkerSizes() {
    var pinSize = GetDestPinSize();

    ForEachDestinationMarker(function(cat, name, layers) {
        var dest = Destinations[cat][name];
        layers.marker.setIcon(MakeDestMarkerIcon(cat, name, dest, layers.selected));
        var sim = MarkerSim[layers.simId];
        if (sim) sim.radiusPx = (layers.selected ? pinSize * MARKER_SELECTED_SCALE : pinSize) / 2;
    });

    Object.keys(InfoMarkers).forEach(function(key) {
        var layers = InfoMarkers[key];
        var info = InfoPoints[key];
        layers.marker.setIcon(MakeProjectMarkerIcon(key, info, layers.selected));
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
    if (!window[MAP_NAME]) return;
    var ids = Object.keys(MarkerSim).filter(function(id) {
        return MarkerSim[id].marker && window[MAP_NAME].hasLayer(MarkerSim[id].marker);
    });
    if (!ids.length) return;

    var pts = ids.map(function(id) {
        var s = MarkerSim[id];
        var anchor = window[MAP_NAME].latLngToContainerPoint(s.trueLatLng);
        var cur = window[MAP_NAME].latLngToContainerPoint(s.dispLatLng);
        return {id: id, anchor: anchor, x: cur.x, y: cur.y, r: s.radiusPx};
    });

    var COLLISION_SIM_CAP = 150;
    if (pts.length <= 1 || pts.length > COLLISION_SIM_CAP) {
        pts.forEach(function(p) {
            var ll = window[MAP_NAME].containerPointToLatLng([p.anchor.x, p.anchor.y]);
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
        var ll = window[MAP_NAME].containerPointToLatLng([p.x, p.y]);
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
            if (!s.marker || !window[MAP_NAME].hasLayer(s.marker)) return;
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

function MakeDestMarkerIcon(cat, name, dest, selected) {
    var c = GetDestCategoryConfig(cat);
    var pinSize = GetDestPinSize();
    var S = selected ? Math.round(pinSize * MARKER_SELECTED_SCALE) : pinSize;
    var wrap = Math.round(S * 1.4142);
    var showLabel = S >= DEST_PIN_MIN_PX;
    var strokeColor = selected ? '#fbbf24' : c.border;
    var strokeWidth = selected ? 2.5 : 1.5;
    var iconBox = Math.round(S * 0.56);

    var pinHtml =
        '<div style="position:relative;width:' + wrap + 'px;height:' + wrap + 'px;filter:drop-shadow(0 1px 2px rgba(0,0,0,0.25));">' +
            '<div style="position:absolute;top:50%;left:50%;width:' + S + 'px;height:' + S + 'px;margin:-' + (S / 2) + 'px 0 0 -' + (S / 2) + 'px;background:' + c.bg + ';border:' + strokeWidth + 'px solid ' + strokeColor + ';border-radius:50% 50% 50% 0;transform:rotate(-45deg);box-sizing:border-box;">' +
                '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;transform:rotate(45deg);">' +
                    '<svg viewBox="0 0 24 24" width="' + iconBox + '" height="' + iconBox + '">' + c.icon + '</svg>' +
                '</div>' +
            '</div>' +
        '</div>';

    var labelHtml = showLabel
        ? '<div class="MarkerLabel" style="border-color:' + c.bg + '33;margin-top:2px;">' + EscapeHtml(name) + '</div>'
        : '';

    var w = Math.max(wrap, 80);
    var totalHeight = showLabel ? wrap + 24 : wrap;
    var html = '<div style="display:flex;flex-direction:column;align-items:center;cursor:pointer;">' + pinHtml + labelHtml + '</div>';

    return L.divIcon({html: html, className: 'DestMarkerIcon', iconSize: [w, totalHeight], iconAnchor: [w / 2, wrap]});
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

// Shared marker construction for destination and project (info) pins — a hoverable/clickable divIcon
// marker plus a small always-visible "true location" dot, registered with the collision-avoidance sim
// Real geographic footprint per project size code — matches a true km radius on the ground, so a
// project's visual footprint scales with the map like any other geography (bigger when zoomed in,
// shrinking away when zoomed out), rather than staying a fixed screen-pixel size regardless of scale.
var PROJECT_RADIUS_KM = {S: 0.2, M: 1.0, L: 5.0, X: 10.0};

// The marker icon itself also scales modestly by size code — the geographic circle alone isn't
// enough, since small-radius circles are imperceptible at anything but close zoom, leaving every
// project's actual dot looking identical regardless of scope.
var PROJECT_ICON_SCALE_BY_RADIUS = {S: 0.8, M: 1.0, L: 1.25, X: 1.5};

// Mirrors the station-dot reveal system: a project only exists on the map once you're zoomed in
// enough for its scope to make sense — national-scale (X) projects show at continental zoom, purely
// local ones (S) only once you're at neighborhood scale. This is the actual decluttering mechanism;
// projects are intentionally NOT run through the collision-avoidance sim (no nudging away from their
// true location) — a small local project should just not exist yet when zoomed out, not get pushed
// off to the side to make room.
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
function ApplyMarkerSelection(layers, icon, selected, baseSize) {
    layers.selected = selected;
    layers.marker.setIcon(icon);
    var sim = MarkerSim[layers.simId];
    if (sim) sim.radiusPx = (selected ? baseSize * MARKER_SELECTED_SCALE : baseSize) / 2;
    ResolveMarkerCollisions();
}

function AddMarkerLayers(layers) {
    if (layers.circle) layers.circle.addTo(window[MAP_NAME]);
    layers.dot.addTo(window[MAP_NAME]);
    layers.marker.addTo(window[MAP_NAME]);
}

function RemoveMarkerLayers(layers) {
    if (window[MAP_NAME].hasLayer(layers.marker)) window[MAP_NAME].removeLayer(layers.marker);
    if (window[MAP_NAME].hasLayer(layers.dot)) window[MAP_NAME].removeLayer(layers.dot);
    if (layers.circle && window[MAP_NAME].hasLayer(layers.circle)) window[MAP_NAME].removeLayer(layers.circle);
}

function SetDestinationSelected(cat, name, selected) {
    var layers = DestinationMarkers[cat] && DestinationMarkers[cat][name];
    if (!layers) return;
    ApplyMarkerSelection(layers, MakeDestMarkerIcon(cat, name, Destinations[cat][name], selected), selected, GetDestPinSize());
}

function RenderDestinationMarkers() {
    ClearDestinationMarkers();
    Object.keys(Destinations).forEach(function(cat) {
        Object.keys(Destinations[cat]).forEach(function(name) {
            var dest = Destinations[cat][name];
            var layers = BuildDestinationMarker(cat, name, dest);
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

function DestExists(dest, mode) {
    if (Array.isArray(dest.Exists)) return dest.Exists.includes(mode);
    return !!dest[mode];
}

var IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
var DEST_IMAGE_BASE = 'data/images/destinations';
var PROJECT_IMAGE_BASE = 'data/images/projects';
var SPORTS_IMAGE_BASE = 'data/images/sports';

function BuildImageCandidates(basePath, name) {
    return IMAGE_EXTENSIONS.map(function(ext) { return basePath + '/' + encodeURIComponent(name) + '.' + ext; });
}

// Global onerror handler: since a static site can't list a folder's contents, a bare (extension-less)
// image name is resolved by trying each supported format in turn until one actually loads, giving up
// (hiding the element) only once every candidate has failed.
function ImageFallback(img) {
    var candidates = JSON.parse(img.getAttribute('data-candidates') || '[]');
    var idx = parseInt(img.getAttribute('data-idx') || '0', 10) + 1;
    if (idx >= candidates.length) { img.removeAttribute('onerror'); img.style.display = 'none'; return; }
    img.setAttribute('data-idx', idx);
    img.src = candidates[idx];
}

// Returns {src, extra} for building an <img> tag that resolves a bare name under basePath — extra is
// the data-candidates/onerror wiring to inject into the tag. Base64 data: URIs pass through unchanged.
function ImageAttrs(basePath, name) {
    if (!name) return null;
    if (name.indexOf('data:') === 0) return {src: name, extra: ''};
    var candidates = BuildImageCandidates(basePath, name);
    var candidatesJson = JSON.stringify(candidates).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    return {src: candidates[0], extra: 'data-candidates="' + candidatesJson + '" data-idx="0" onerror="ImageFallback(this)"'};
}

function DestImageFile(dest) {
    return Array.isArray(dest.Image) ? dest.Image[0] : dest.Image;
}
function DestImageSource(dest) {
    return Array.isArray(dest.Image) ? dest.Image[1] : dest.Source;
}

function ToggleAllProjects() {
    if (CurrentMapMode !== 'Fantasy') return;
    ProjectsHidden = !ProjectsHidden;
    UpdateProjectMarkersVisibility();
}

function UpdateProjectMarkersVisibility() {
    var isApplicable = (CurrentMapMode === 'Fantasy');
    var zoom = window[MAP_NAME] ? window[MAP_NAME].getZoom() : 0;
    var globallyOn = isApplicable && !ProjectsHidden;

    Object.keys(InfoMarkers).forEach(function(key) {
        var layers = InfoMarkers[key];
        var info = InfoPoints[key];
        var minZoom = PROJECT_MIN_ZOOM_BY_RADIUS[info.Radius] || 9;
        var shouldShow = globallyOn && zoom >= minZoom;
        var isShown = window[MAP_NAME].hasLayer(layers.marker);
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
}

function ToggleAllDestinations() {
    DestinationsHidden = !DestinationsHidden;
    SyncDestinationToggleUI();
    UpdateDestinationMarkersVisibility();
}

function SyncDestinationToggleUI() {
    var isOn = !DestinationsHidden;
    var btn = document.getElementById('POIToggleButton');
    if (btn) {
        btn.classList.toggle('active', isOn);
        btn.title = isOn ? 'Hide points of interest' : 'Show points of interest';
    }
}

function ToggleStationDots() {
    StationDotsHidden = !StationDotsHidden;
    SyncStationDotsToggleUI();
    RefreshStationDots();
}

function SyncStationDotsToggleUI() {
    var isOn = !StationDotsHidden;
    var btn = document.getElementById('StationDotsToggleButton');
    if (btn) {
        btn.classList.toggle('active', isOn);
        btn.title = isOn ? 'Hide stations' : 'Show stations';
    }
}

var DEST_MARKER_MIN_ZOOM = 7;

function UpdateDestinationMarkersVisibility() {
    var isPresent = (CurrentMapMode === 'Present');
    var zoomOk = window[MAP_NAME] && window[MAP_NAME].getZoom() >= DEST_MARKER_MIN_ZOOM;
    ForEachDestinationMarker(function(cat, name, layers) {
        var dest = Destinations[cat][name];
        var modeVisible = zoomOk && !DestinationsHidden && DestExists(dest, isPresent ? 'Present' : 'Fantasy');
        var isShown = window[MAP_NAME].hasLayer(layers.marker);
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
    if (btn) {
        btn.textContent = minimized ? '⤢' : '−';
        btn.title = minimized ? 'Expand' : 'Minimize';
    }
}

var DEST_FOCUS_ZOOM = 16; // "zoomed all the way in" level used when a destination is opened from a menu

function ShowDestinationPopup(cat, name, zoomIn) {
    var dest = Destinations[cat] && Destinations[cat][name];
    if (!dest) return;
    HideZoomToStationButton();

    if (SelectedDestination) {
        SetDestinationSelected(SelectedDestination.category, SelectedDestination.name, false);
    }
    SelectedDestination = {category: cat, name: name};
    SetDestinationSelected(cat, name, true);

    document.getElementById('StationPopupOverlay').classList.add('DestPopupCentered');
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupMinimized');
    var destBackdrop = document.getElementById('DestPopupBackdrop');
    if (destBackdrop) destBackdrop.classList.add('show');
    var minBtn = document.getElementById('PopupMinimizeBtn');
    if (minBtn) { minBtn.textContent = '−'; minBtn.title = 'Minimize'; }

    // Only reposition the map when opened from a menu (search, browse, sports
    // picker) -- a marker clicked directly on the map is already exactly
    // where the person wants to look, so flying/zooming there is jarring.
    if (zoomIn) {
        window[MAP_NAME].flyTo(dest.Location, DEST_FOCUS_ZOOM, {animate: true, duration: 0.7});
    }

    var visibleKeys = ComputeVisibleStationKeys();

    var explicitKeys = new Set();
    (dest.Stations || []).forEach(function(k) {
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
            Lines: LinesServingKeys(G.Keys),
        };
    });

    var cfg = GetDestCategoryConfig(cat);

    document.getElementById('PopupStationName').innerText = name;
    document.getElementById('PopupStationType').innerText = cfg.label;

    var imgContainer = document.getElementById('DestPopupImageContainer');
    if (!imgContainer) {
        imgContainer = document.createElement('div');
        imgContainer.id = 'DestPopupImageContainer';
        var popupHeader = document.querySelector('.PopupHeader');
        if (popupHeader) popupHeader.insertAdjacentElement('afterend', imgContainer);
    }
    var imgFile = DestImageFile(dest);
    if (imgFile) {
        var imgSource = DestImageSource(dest);
        var imgAttrs = ImageAttrs(DEST_IMAGE_BASE, imgFile);
        imgContainer.innerHTML = '<img src="' + imgAttrs.src + '" ' + imgAttrs.extra + ' class="DestPopupImage" alt="' + name + '">' +
            (imgSource ? '<div class="DestPopupSource">📷 ' + imgSource + '</div>' : '');
        imgContainer.style.display = 'block';
    } else {
        imgContainer.innerHTML = '';
        imgContainer.style.display = 'none';
    }

    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var teamsHtml = '';
    (dest.Teams || []).forEach(function(team) {
        // Skip a team that's only listed here as its other-mode/shared venue --
        // e.g. a team moving to a new stadium shouldn't still show up on the
        // old one once TeamVenueForMode has handed it to the new venue.
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
        var servingLines = Registry.filter(function(L) {
            return !DisabledModes.has(L.ModeId) && L.AllLineStations.includes(sk);
        });
        var color = servingLines.length ? servingLines[0].Color : '#94a3b8';
        var radius = sd.Major ? CurrentBaseSize * 2 : CurrentBaseSize;
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
    if (SelectedDestination) {
        SetDestinationSelected(SelectedDestination.category, SelectedDestination.name, false);
        SelectedDestination = null;
    }
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupCentered');
    document.getElementById('StationPopupOverlay').classList.remove('DestPopupMinimized');
    var destBackdrop = document.getElementById('DestPopupBackdrop');
    if (destBackdrop) destBackdrop.classList.remove('show');
    CurrentStationPopup = null;
    ShowStationPopup(sk, true);
}

function CloseDestinationPopup() {
    if (SelectedDestination) {
        SetDestinationSelected(SelectedDestination.category, SelectedDestination.name, false);
        SelectedDestination = null;
    }
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

function InitDestinationSearch() {
    var anchor = document.getElementById('StationSearchRow') || document.getElementById('SearchRow');
    if (!anchor) return;

    var Wrapper = document.createElement('div');
    Wrapper.id = 'DestSearchRow';

    var InputRow = document.createElement('div');
    InputRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

    var Input = document.createElement('input');
    Input.type = 'text';
    Input.id = 'DestSearchInput';
    Input.placeholder = 'Search destinations...';
    Input.autocomplete = 'off';
    Input.style.flex = '1';

    var BrowseBtn = document.createElement('button');
    BrowseBtn.id = 'DestBrowseBtn';
    BrowseBtn.title = 'Browse all destinations';
    BrowseBtn.innerHTML = '⊞';

    InputRow.appendChild(Input);
    InputRow.appendChild(BrowseBtn);

    var Dropdown = document.createElement('div');
    Dropdown.id = 'DestSearchDropdown';
    Wrapper.appendChild(InputRow);
    Wrapper.appendChild(Dropdown);
    anchor.parentNode.insertBefore(Wrapper, anchor.nextSibling);

    var ActiveIdx = -1;
    var FlatResults = [];

    function BuildSections(query) {
        var isPresent = (CurrentMapMode === 'Present');
        var sections = [];
        Object.keys(Destinations).forEach(function(cat) {
            var matches = [];
            Object.keys(Destinations[cat]).forEach(function(name) {
                var dest = Destinations[cat][name];
                if (!DestExists(dest, isPresent ? 'Present' : 'Fantasy')) return;
                var s = ScoreMatch(name, query);
                if (s > 0) matches.push({name: name, dest: dest, category: cat, score: s});
            });
            matches.sort(function(a, b) { return b.score - a.score || a.name.localeCompare(b.name); });
            if (matches.length) sections.push({cat: cat, matches: matches});
        });
        return sections;
    }

    function Render(query) {
        Dropdown.innerHTML = ''; ActiveIdx = -1; FlatResults = [];
        var sections = BuildSections(query);
        if (!sections.length) { Dropdown.classList.remove('show'); return; }

        sections.forEach(function(section) {
            var cfg = GetDestCategoryConfig(section.cat);
            var header = document.createElement('div');
            header.className = 'DestSearchCategoryHeader';
            header.innerHTML = '<span style="margin-right:5px;">' + cfg.icon + '</span>' + section.cat;
            Dropdown.appendChild(header);
            section.matches.slice(0, 5).forEach(function(r) {
                var item = document.createElement('div');
                item.className = 'StationSearchItem';
                var nameEl = document.createElement('div');
                nameEl.className = 'StationSearchName';
                nameEl.textContent = r.name;
                item.appendChild(nameEl);
                var fi = FlatResults.length;
                FlatResults.push(r);
                item.addEventListener('mouseenter', function() { SetActive(fi); });
                item.addEventListener('click', function() { Commit(r.category, r.name); });
                Dropdown.appendChild(item);
            });
        });
        Dropdown.classList.add('show');
    }

    function SetActive(idx) {
        Dropdown.querySelectorAll('.StationSearchItem').forEach(function(el, i) { el.classList.toggle('active', i === idx); });
        ActiveIdx = idx;
    }

    function Commit(cat, name) {
        Input.value = ''; Dropdown.classList.remove('show');
        if (DestinationsHidden) ToggleAllDestinations();
        ShowDestinationPopup(cat, name, true);
    }

    BrowseBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        Dropdown.classList.remove('show');
        OpenDestBrowseModal();
    });

    var DebouncedRender = Debounce(Render, 100);
    Input.addEventListener('input', function() {
        if (!Input.value.trim()) { Dropdown.classList.remove('show'); return; }
        DebouncedRender(Input.value);
    });
    Input.addEventListener('keydown', function(e) {
        var items = Dropdown.querySelectorAll('.StationSearchItem');
        if (e.key === 'ArrowDown') { e.preventDefault(); SetActive(Math.min(ActiveIdx+1, items.length-1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); SetActive(Math.max(ActiveIdx-1, 0)); }
        else if (e.key === 'Enter' && ActiveIdx >= 0 && FlatResults[ActiveIdx]) { Commit(FlatResults[ActiveIdx].category, FlatResults[ActiveIdx].name); }
        else if (e.key === 'Escape') { Dropdown.classList.remove('show'); Input.blur(); }
    });
    document.addEventListener('click', function(e) {
        if (!Wrapper.contains(e.target)) Dropdown.classList.remove('show');
    });
}

function OpenDestBrowseModal() {
    var backdrop = document.getElementById('DestBrowseBackdrop');
    var modal = document.getElementById('DestBrowseModal');
    if (backdrop) backdrop.classList.add('show');
    if (modal) modal.classList.add('show');
    RenderDestBrowseModal('All');
}

function CloseDestBrowseModal() {
    var backdrop = document.getElementById('DestBrowseBackdrop');
    var modal = document.getElementById('DestBrowseModal');
    if (backdrop) backdrop.classList.remove('show');
    if (modal) modal.classList.remove('show');
}

function RenderDestBrowseModal(activeCat) {
    var tabsEl = document.getElementById('DestBrowseTabs');
    var gridEl = document.getElementById('DestBrowseGrid');
    if (!tabsEl || !gridEl) return;

    var isPresent = (CurrentMapMode === 'Present');
    var cats = Object.keys(Destinations).sort();

    var tabsHtml = '<button class="DestBrowseTab' + (activeCat === 'All' ? ' active' : '') + '" onclick="RenderDestBrowseModal(\'All\')">All</button>';
    cats.forEach(function(cat) {
        var cfg = GetDestCategoryConfig(cat);
        tabsHtml += '<button class="DestBrowseTab' + (activeCat === cat ? ' active' : '') + '" onclick="RenderDestBrowseModal(\'' + cat.replace(/'/g, "\\'") + '\')">' +
            '<span class="DestBrowseTabIcon">' + cfg.icon + '</span>' + cat + '</button>';
    });
    tabsEl.innerHTML = tabsHtml;

    var gridHtml = '';
    cats.forEach(function(cat) {
        if (activeCat !== 'All' && activeCat !== cat) return;
        var cfg = GetDestCategoryConfig(cat);
        var names = Object.keys(Destinations[cat]).filter(function(name) {
            return DestExists(Destinations[cat][name], isPresent ? 'Present' : 'Fantasy');
        }).sort();
        if (!names.length) return;

        gridHtml += '<div class="DestBrowseCategoryLabel"><span class="DestBrowseCategoryDot" style="background:' + cfg.bg + '"></span>' +
            cat + '<span class="DestBrowseCategoryCount">' + names.length + '</span></div>';
        gridHtml += '<div class="DestBrowseCards">';
        names.forEach(function(name) {
            var dest = Destinations[cat][name];
            var imgFile = DestImageFile(dest);
            var hasImage = !!imgFile;
            var escName = name.replace(/'/g, "\\'");
            var escCat  = cat.replace(/'/g, "\\'");
            var imgTag = hasImage
                ? (function() { var a = ImageAttrs(DEST_IMAGE_BASE, imgFile); return '<img class="DestBrowseCardImage" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy" decoding="async">'; })()
                : '';
            gridHtml += '<div class="DestBrowseCard' + (hasImage ? ' has-image' : '') + '" onclick="CommitBrowseSelection(\'' + escCat + '\',\'' + escName + '\')">' +
                imgTag +
                '<div class="DestBrowseCardIcon" style="background:' + cfg.bg + '">' + cfg.icon + '</div>' +
                '<div class="DestBrowseCardCaption"><span class="DestBrowseCardName">' + name + '</span></div>' +
                '</div>';
        });
        gridHtml += '</div>';
    });

    gridEl.innerHTML = gridHtml || '<div class="DestBrowseEmpty">No destinations in this view.</div>';
}

function CommitBrowseSelection(cat, name) {
    CloseDestBrowseModal();
    if (DestinationsHidden) ToggleAllDestinations();
    ShowDestinationPopup(cat, name, true);
}

// Maps each team name to every venue (across all destination categories) whose
// 'Teams' list includes it, so a team pick can resolve to a venue regardless
// of which category it lives in.
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

// The set of station keys actually reachable by a currently-visible line in
// the active mode/detail registry (mirrors what ShowDestinationPopup uses to
// decide whether a venue shows real transit service or "No transit service
// visible in this map view").
function ComputeVisibleStationKeys() {
    var visibleKeys = new Set();
    Registry.forEach(function(L) {
        if (!DisabledModes.has(L.ModeId)) L.AllLineStations.forEach(function(k) { visibleKeys.add(k); });
    });
    return visibleKeys;
}

function DestHasVisibleService(dest, visibleKeys) {
    var explicitKeys = new Set();
    (dest.Stations || []).forEach(function(k) {
        var GK = StationGroupMembers(k);
        (GK.length ? GK : [k]).forEach(function(gk) { explicitKeys.add(gk); });
    });
    return Array.from(explicitKeys).some(function(k) { return visibleKeys.has(k); });
}

// Resolves a team to the one venue it should open for the given Present/Fantasy
// mode, or null if none of its venues both exist in that mode AND actually have
// a visible rail connection there (e.g. a present/future arena whose assigned
// station is future-only shouldn't count as reachable on the present map).
// When a team's venues overlap across modes -- e.g. it currently shares a
// stadium that a dedicated future stadium will take over -- the venue
// exclusive to the current mode wins, since the shared one is read as the
// venue the team is moving away from/hasn't moved into yet.
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

// Team names aren't tagged with their league anywhere in map_data -- given a
// bare team name, this searches every league's roster (built from the
// data/images/sports/ folder scan) to find the one it belongs to, so a
// venue's 'Teams' list never needs a league of its own recorded alongside it.
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
    var backdrop = document.getElementById('SportsBrowseBackdrop');
    var modal = document.getElementById('SportsBrowseModal');
    if (backdrop) backdrop.classList.add('show');
    if (modal) modal.classList.add('show');
    ClearTeamMapMarkers();
    SportsBrowseCurrentLeague = null;
    RenderSportsModeToggle();
    RenderSportsLeagueGrid();
}

function CloseSportsBrowseModal() {
    var backdrop = document.getElementById('SportsBrowseBackdrop');
    var modal = document.getElementById('SportsBrowseModal');
    if (backdrop) backdrop.classList.remove('show');
    if (modal) modal.classList.remove('show');
}

// Lets the picker be switched between Present/Fantasy without leaving it, so
// a viewer can compare a league's rail access side by side. This drives the
// actual map mode (same effect as the sidebar's Present Day/Future Vision
// switch), then just re-renders whichever picker view was open.
function RenderSportsModeToggle() {
    var el = document.getElementById('SportsModeToggle');
    if (!el) return;
    el.innerHTML =
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Present' ? ' active' : '') + '" onclick="SetSportsBrowseMode(\'Present\')">Present Day</button>' +
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Fantasy' ? ' active' : '') + '" onclick="SetSportsBrowseMode(\'Fantasy\')">Future Vision</button>';
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
        '<button class="DestBrowseTab" style="margin-left:auto;" onclick="ViewLeagueTeamsOnMap(\'' + escLg + '\')">📍 View All on Map</button>';

    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var visibleKeys = ComputeVisibleStationKeys();
    var teams = (Leagues[league] || []).slice().sort();
    var gridHtml = '<div class="DestBrowseCards">';
    teams.forEach(function(team) {
        var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team);
        var escTeam = team.replace(/'/g, "\\'");
        var available = TeamAvailableInMode(team, mode, visibleKeys);
        var cardClass = 'DestBrowseCard logo-card' + (available ? '' : ' sports-unavailable');
        var onclickAttr = available ? (' onclick="SelectSportsTeam(\'' + escLg + '\',\'' + escTeam + '\')"') : '';
        gridHtml += '<div class="' + cardClass + '"' + onclickAttr + '>' +
            '<img class="DestBrowseCardImage" src="' + a.src + '" ' + a.extra + ' alt="" loading="lazy" decoding="async">' +
            '<div class="DestBrowseCardCaption"><span class="DestBrowseCardName">' + team + '</span>' +
            (available ? '' : '<span class="SportsNoRailBadge">Not accessible by rail</span>') +
            '</div></div>';
    });
    gridHtml += '</div>';
    gridEl.innerHTML = teams.length ? gridHtml : '<div class="DestBrowseEmpty">No teams found.</div>';
}

// Opens the venue for `team` on the map's current Present/Fantasy display
// setting (see TeamVenueForMode for how overlapping venues are resolved).
function SelectSportsTeam(league, team) {
    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var match = TeamVenueForMode(team, mode, ComputeVisibleStationKeys());
    if (!match) return;
    CloseSportsBrowseModal();
    if (DestinationsHidden) ToggleAllDestinations();
    ShowDestinationPopup(match.cat, match.name, true);
}

function MakeTeamMarkerIcon(logoSrc, logoExtra) {
    var S = 44;
    var html = '<div style="width:' + S + 'px;height:' + S + 'px;border-radius:50%;background:#fff;border:2.5px solid #1e293b;box-shadow:0 2px 6px rgba(0,0,0,0.35);overflow:hidden;display:flex;align-items:center;justify-content:center;cursor:pointer;">' +
        '<img src="' + logoSrc + '" ' + logoExtra + ' style="width:82%;height:82%;object-fit:contain;" alt="">' +
        '</div>';
    return L.divIcon({html: html, className: 'TeamMarkerIcon', iconSize: [S, S], iconAnchor: [S / 2, S / 2]});
}

// Drops every team in `league` that resolves to a valid venue in the current
// mode onto the map at that venue's location -- clicking one selects it
// exactly like picking it from the menu (TeamVenueForMode/SelectSportsTeam are
// the same functions the picker itself uses, so results always match).
function ShowTeamMarkersForLeague(league) {
    ClearTeamMapMarkers();
    TeamMapLeague = league;
    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var visibleKeys = ComputeVisibleStationKeys();
    var placed = 0;
    (Leagues[league] || []).forEach(function(team) {
        var match = TeamVenueForMode(team, mode, visibleKeys);
        if (!match) return;
        var a = ImageAttrs(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team);
        var marker = L.marker(match.dest.Location, {icon: MakeTeamMarkerIcon(a.src, a.extra), zIndexOffset: 650, pane: 'destMarkerPane'});
        marker.bindTooltip(team, {direction: 'top', offset: [0, -24], className: 'ProjectTooltip', sticky: false, pane: 'hoverTooltipPane'});
        marker.on('click', function(e) { L.DomEvent.stopPropagation(e); SelectSportsTeam(league, team); });
        marker.addTo(window[MAP_NAME]);
        TeamMapMarkers.push(marker);
        placed++;
    });

    var badge = document.getElementById('SportsOverlayBadge');
    var badgeText = document.getElementById('SportsOverlayBadgeText');
    if (badge && badgeText) {
        badgeText.textContent = league + ' — ' + placed + (placed === 1 ? ' team' : ' teams') + ' on map';
        badge.style.display = placed ? 'flex' : 'none';
    }
}

function ClearTeamMapMarkers() {
    TeamMapMarkers.forEach(function(m) { if (window[MAP_NAME].hasLayer(m)) window[MAP_NAME].removeLayer(m); });
    TeamMapMarkers = [];
    TeamMapLeague = null;
    var badge = document.getElementById('SportsOverlayBadge');
    if (badge) badge.style.display = 'none';
}

function ViewLeagueTeamsOnMap(league) {
    CloseSportsBrowseModal();
    ShowTeamMarkersForLeague(league);
}

function BuildAllStationGroups(filterQuery) {
    var VisibleStationKeys = new Set(Object.keys(GetLinesByStation()));

    var Groups = {};
    Object.keys(StationSearchIndex).forEach(function(Key) {
        if (!VisibleStationKeys.has(Key)) return;
        var Base = StationGroupBase(Key);
        if (!Groups[Base]) Groups[Base] = {Keys: [], Labels: []};
        Groups[Base].Keys.push(Key);
        var memberLabel = CleanStationName(StationSearchIndex[Key].Label || Key);
        if (!Groups[Base].Labels.includes(memberLabel)) Groups[Base].Labels.push(memberLabel);
    });

    var qn = filterQuery ? NormalizeSearchText(filterQuery) : '';

    return Object.values(Groups)
        .map(function(G) {
            G.Label = G.Labels.reduce(function(Best, L) { return L.length > Best.length ? L : Best; });
            return G;
        })
        .filter(function(G) { return !qn || NormalizeSearchText(G.Label).includes(qn); })
        .map(function(G) {
            return {Label: G.Label, Key: G.Keys[0], Lines: LinesServingKeys(G.Keys)};
        })
        .sort(function(a, b) { return a.Label.localeCompare(b.Label); });
}

function InitStationBrowseModal() {
    var filterInput = document.getElementById('StationBrowseFilterInput');
    if (filterInput) {
        filterInput.addEventListener('input', function() { RenderStationBrowseModal(filterInput.value); });
    }
}

function OpenStationBrowseModal() {
    var backdrop = document.getElementById('StationBrowseBackdrop');
    var modal = document.getElementById('StationBrowseModal');
    var filterInput = document.getElementById('StationBrowseFilterInput');
    if (backdrop) backdrop.classList.add('show');
    if (modal) modal.classList.add('show');
    if (filterInput) { filterInput.value = ''; setTimeout(function() { filterInput.focus(); }, 50); }
    RenderStationBrowseModal('');
}

function CloseStationBrowseModal() {
    var backdrop = document.getElementById('StationBrowseBackdrop');
    var modal = document.getElementById('StationBrowseModal');
    if (backdrop) backdrop.classList.remove('show');
    if (modal) modal.classList.remove('show');
}

function RenderStationBrowseModal(filterQuery) {
    var listEl = document.getElementById('StationBrowseList');
    if (!listEl) return;

    var groups = BuildAllStationGroups(filterQuery);
    if (!groups.length) {
        listEl.innerHTML = '<div class="DestBrowseEmpty">No stations found.</div>';
        return;
    }

    var html = '';
    var lastLetter = '';
    groups.forEach(function(g) {
        var letter = g.Label.charAt(0).toUpperCase();
        if (letter !== lastLetter) {
            html += '<div class="StationBrowseLetterHeader">' + letter + '</div>';
            lastLetter = letter;
        }
        var pillsHtml = g.Lines.map(function(line) {
            return '<span class="StationSearchPill" style="background:' + line.Color + '">' + line.Name + '</span>';
        }).join('');
        html += '<div class="StationBrowseRow" onclick="CommitStationBrowseSelection(\'' + g.Key.replace(/'/g, "\\'") + '\')">' +
            '<div class="StationBrowseRowName">' + g.Label + '</div>' +
            (pillsHtml ? '<div class="StationSearchLines">' + pillsHtml + '</div>' : '') +
            '</div>';
    });

    listEl.innerHTML = html;
}

function CommitStationBrowseSelection(key) {
    CloseStationBrowseModal();
    ShowStationPopupFromSearch(key);
}

function EnsureRegistryLayersCreated(registryArray) {
    registryArray.forEach(function(entry) {
        if (window[entry.Id]) return;
        var layer = CreateLeafletLayer(entry);
        if (!layer) return;
        window[entry.Id] = layer;
    });
}

function CreateLeafletLayer(entry) {
    var geo = entry.Geometry;
    if (!geo) return null;
    var style = {
        color: entry.Color, weight: entry.Weight, opacity: 1.0,
        lineJoin: 'round', lineCap: 'round', smoothFactor: 1.5
    };
    var layer;
    if (geo.Type === 'polyline') {
        layer = L.polyline(geo.Coords, Object.assign({}, style, {interactive: false}));
    } else if (geo.Type === 'geojson') {
        layer = L.layerGroup();
        layer._geojsonFiles = geo.Files;
        layer._geojsonStyle = Object.assign({}, style);
        layer._geojsonLoaded = false;
        layer._geojsonLoading = false;
        layer.setStyle = function(s) {
            Object.assign(layer._geojsonStyle, s);
            layer.eachLayer(function(fl) { if (fl.setStyle) fl.setStyle(s); });
        };
        layer.getBounds = function() {
            var bounds = L.latLngBounds([]);
            layer.eachLayer(function(fl) { if (fl.getBounds) bounds.extend(fl.getBounds()); });
            return bounds;
        };
    }
    if (layer) {
        layer.addTo(window[MAP_NAME]);
        if (layer.setZIndex) layer.setZIndex(entry.ZIndex);
    }
    return layer;
}

function EnsureLayerLoaded(layer, callback) {
    if (!layer._geojsonFiles) { if (callback) callback(); return; }
    if (layer._geojsonLoaded) { if (callback) callback(); return; }
    if (layer._geojsonLoading) {
        if (!layer._loadCallbacks) layer._loadCallbacks = [];
        if (callback) layer._loadCallbacks.push(callback);
        return;
    }
    layer._geojsonLoading = true;
    if (!layer._loadCallbacks) layer._loadCallbacks = [];
    if (callback) layer._loadCallbacks.push(callback);
    var files = layer._geojsonFiles;
    var remaining = files.length;
    function finishLoad() {
        layer._geojsonLoaded = true; layer._geojsonLoading = false;
        layer._loadCallbacks.forEach(function(cb) { cb(); }); layer._loadCallbacks = [];
        ScheduleCorridorOffsets();
    }
    if (remaining === 0) { finishLoad(); return; }
    files.forEach(function(path) {
        fetch(path)
            .then(function(r) { return r.json(); })
            .then(function(data) {
                L.geoJson(data, {
                    style: layer._geojsonStyle, smoothFactor: 1.5,
                    interactive: false
                }).addTo(layer);
                remaining--;
                if (remaining === 0) { layer.setStyle(layer._geojsonStyle); finishLoad(); }
            })
            .catch(function(err) {
                console.warn('Failed to load GeoJSON:', path, err);
                remaining--;
                if (remaining === 0) finishLoad();
            });
    });
}

var CorridorTouchedLayers = new Set();

function HaversineMeters(a, b) {
    var R = 6371000;
    var lat1 = a[0] * Math.PI / 180, lat2 = b[0] * Math.PI / 180;
    var dLat = (b[0] - a[0]) * Math.PI / 180, dLng = (b[1] - a[1]) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function ResamplePath(path, stepMeters) {
    if (path.length < 2) return path.slice();
    var out = [path[0]];
    var covered = 0, nextTarget = stepMeters;
    for (var i = 1; i < path.length; i++) {
        var a = path[i - 1], b = path[i];
        var segLen = HaversineMeters(a, b);
        if (segLen === 0) continue;
        while (covered + segLen >= nextTarget) {
            var t = (nextTarget - covered) / segLen;
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
            nextTarget += stepMeters;
        }
        covered += segLen;
    }
    var last = path[path.length - 1];
    var lastOut = out[out.length - 1];
    if (lastOut[0] !== last[0] || lastOut[1] !== last[1]) out.push(last);
    return out;
}

function CorridorGridKey(latlng, cellMeters) {
    var mPerDegLat = 110574;
    var mPerDegLng = 111320 * Math.cos(latlng[0] * Math.PI / 180);
    var gx = Math.round((latlng[1] * mPerDegLng) / cellMeters);
    var gy = Math.round((latlng[0] * mPerDegLat) / cellMeters);
    return gx + '_' + gy;
}

function CollectCorridorPathEntries(layer, lineId, entries) {
    if (!layer) return;
    if (layer.eachLayer) { layer.eachLayer(function(sub) { CollectCorridorPathEntries(sub, lineId, entries); }); return; }
    if (!layer.getLatLngs || !layer.setLatLngs) return;
    if (!layer._corridorOriginalLatLngs) layer._corridorOriginalLatLngs = layer.getLatLngs();
    var ll = layer._corridorOriginalLatLngs;
    if (!ll.length) return;
    if (Array.isArray(ll[0])) {
        ll.forEach(function(sub, idx) {
            entries.push({lineId: lineId, layer: layer, subIndex: idx, subCount: ll.length, path: sub.map(function(p) { return [p.lat, p.lng]; })});
        });
    } else {
        entries.push({lineId: lineId, layer: layer, subIndex: null, subCount: null, path: ll.map(function(p) { return [p.lat, p.lng]; })});
    }
}

function CorridorMetersPerLane() {
    var zoom = window[MAP_NAME].getZoom();
    var lat = window[MAP_NAME].getCenter().lat;
    var metersPerPixel = 156543.03392 * Math.cos(lat * Math.PI / 180) / Math.pow(2, zoom);
    return CORRIDOR_LANE_SPACING_PX * metersPerPixel;
}

function ComputeOffsetCellPath(cells, lineId, edgeLines, metersPerLane) {
    if (cells.length < 2) return cells.map(function(c) { return c.pt; });
    var n = cells.length;
    var edgeInfo = [];
    for (var i = 0; i < n - 1; i++) {
        var a = cells[i], b = cells[i + 1];
        var ek = a.key < b.key ? (a.key + '|' + b.key) : (b.key + '|' + a.key);
        var sharing = edgeLines[ek] || [lineId];
        var laneCount = sharing.length;
        var laneIndex = sharing.indexOf(lineId);
        if (laneIndex < 0) laneIndex = 0;
        var laneOffset = laneIndex - (laneCount - 1) / 2;

        var midLat = (a.pt[0] + b.pt[0]) / 2;
        var mPerDegLat = 110574, mPerDegLng = 111320 * Math.cos(midLat * Math.PI / 180);
        var dx = (b.pt[1] - a.pt[1]) * mPerDegLng, dy = (b.pt[0] - a.pt[0]) * mPerDegLat;
        var len = Math.hypot(dx, dy) || 1;
        edgeInfo.push({px: -dy / len, py: dx / len, laneOffset: laneOffset});
    }

    var out = [];
    for (var i = 0; i < n; i++) {
        var incoming = i > 0 ? edgeInfo[i - 1] : null;
        var outgoing = i < n - 1 ? edgeInfo[i] : null;
        var vecs = incoming && outgoing ? [incoming, outgoing] : [incoming || outgoing];
        var avgPx = 0, avgPy = 0, avgLane = 0;
        vecs.forEach(function(v) { avgPx += v.px; avgPy += v.py; avgLane += v.laneOffset; });
        avgPx /= vecs.length; avgPy /= vecs.length; avgLane /= vecs.length;
        var norm = Math.hypot(avgPx, avgPy) || 1;
        avgPx /= norm; avgPy /= norm;

        var offsetMeters = avgLane * metersPerLane;
        var pt = cells[i].pt;
        var mPerDegLat = 110574, mPerDegLng = 111320 * Math.cos(pt[0] * Math.PI / 180);
        out.push([pt[0] + (avgPy * offsetMeters) / mPerDegLat, pt[1] + (avgPx * offsetMeters) / mPerDegLng]);
    }
    return out;
}

function RestoreCorridorLayers() {
    if (!CorridorTouchedLayers.size) return;
    CorridorTouchedLayers.forEach(function(layer) {
        if (layer._corridorOriginalLatLngs) layer.setLatLngs(layer._corridorOriginalLatLngs);
    });
    CorridorTouchedLayers.clear();
}

function RefreshCorridorOffsets() {
    if (!window[MAP_NAME]) return;
    var active = (CurrentDetail === 'Detailed') && window[MAP_NAME].getZoom() >= CORRIDOR_OFFSET_MIN_ZOOM;
    if (!active) { RestoreCorridorLayers(); return; }

    var activeRegistry = GetActiveRegistry();
    var entries = [];
    activeRegistry.forEach(function(entry) {
        if (DisabledModes.has(entry.ModeId)) return;
        CollectCorridorPathEntries(window[entry.Id], entry.Id, entries);
    });
    if (!entries.length) return;

    var totalPoints = 0;
    entries.forEach(function(e) {
        var resampled = ResamplePath(e.path, CORRIDOR_SAMPLE_STEP_M);
        var cells = [];
        var lastKey = null;
        resampled.forEach(function(pt) {
            var k = CorridorGridKey(pt, CORRIDOR_GRID_CELL_M);
            if (k !== lastKey) { cells.push({key: k, pt: pt}); lastKey = k; }
        });
        e.cells = cells;
        totalPoints += cells.length;
    });
    if (totalPoints > CORRIDOR_MAX_SAMPLE_POINTS) {
        console.warn('Skipping corridor offsetting — currently visible network (' + totalPoints + ' sample points) exceeds CORRIDOR_MAX_SAMPLE_POINTS');
        RestoreCorridorLayers();
        return;
    }

    var edgeLines = {};
    entries.forEach(function(e) {
        var cells = e.cells;
        for (var i = 0; i < cells.length - 1; i++) {
            var a = cells[i].key, b = cells[i + 1].key;
            var ek = a < b ? (a + '|' + b) : (b + '|' + a);
            (edgeLines[ek] || (edgeLines[ek] = new Set())).add(e.lineId);
        }
    });
    var edgeLineArrays = {};
    Object.keys(edgeLines).forEach(function(ek) { edgeLineArrays[ek] = Array.from(edgeLines[ek]).sort(); });

    var metersPerLane = CorridorMetersPerLane();

    var byLayer = new Map();
    entries.forEach(function(e) {
        var offsetPath = ComputeOffsetCellPath(e.cells, e.lineId, edgeLineArrays, metersPerLane);
        if (e.subIndex === null) {
            e.layer.setLatLngs(offsetPath);
            CorridorTouchedLayers.add(e.layer);
        } else {
            var bucket = byLayer.get(e.layer) || byLayer.set(e.layer, new Array(e.subCount)).get(e.layer);
            bucket[e.subIndex] = offsetPath;
        }
    });
    byLayer.forEach(function(subPaths, layer) {
        layer.setLatLngs(subPaths);
        CorridorTouchedLayers.add(layer);
    });
}

var ScheduleCorridorOffsets = Debounce(RefreshCorridorOffsets, 150);

function initializeMap(mapName, registryDetailed, registryFull, registryPresent, registryPresentFull, stationsDetailed, allNodes, modes, basemapLayerNames, infoPoints, stationSearchIndex, destinations, leagues) {
    MAP_NAME = mapName;
    window[MAP_NAME].createPane('stationDotPane');
    window[MAP_NAME].getPane('stationDotPane').style.zIndex = 650;
    window[MAP_NAME].createPane('stationGroupPane');
    window[MAP_NAME].getPane('stationGroupPane').style.zIndex = 620;
    window[MAP_NAME].createPane('destMarkerPane');
    window[MAP_NAME].getPane('destMarkerPane').style.zIndex = 700;
    window[MAP_NAME].createPane('hoverTooltipPane');
    window[MAP_NAME].getPane('hoverTooltipPane').style.zIndex = 1000;
    var popupContentEl = document.getElementById('PopupContent');
    if (popupContentEl) popupContentEl.addEventListener('wheel', function(e) { e.stopPropagation(); }, {passive: true});
    RegistryDetailed = registryDetailed;
    RegistryFull = registryFull;
    RegistryPresent = registryPresent;
    RegistryPresentFull = registryPresentFull;
    Registry = RegistryFull;
    StationsDetailed = stationsDetailed;
    AllNodes = allNodes;
    Stations = AllNodes;
    Modes = modes;
    ModesOrder = Modes;
    InfoPoints = infoPoints || {};
    StationSearchIndex = stationSearchIndex || {};

    MarkMapInitialized();

    ApplySwitchedRegistry();

    BasemapLayers['Light'] = basemapLayerNames.Light;
    BasemapLayers['Dark'] = basemapLayerNames.Dark;
    BasemapLayers['Satellite'] = basemapLayerNames.Satellite;

    if (BasemapLayers['Dark']) window[MAP_NAME].removeLayer(BasemapLayers['Dark']);
    if (BasemapLayers['Satellite']) window[MAP_NAME].removeLayer(BasemapLayers['Satellite']);

    RenderInfoMarkers();
    UpdateProjectMarkersVisibility();
    var projectBadge = document.getElementById('ProjectCountBadge');
    if (projectBadge) projectBadge.textContent = Object.keys(InfoPoints).length;
    SyncStationDotsToggleUI();
    BuildByMode();
    RefreshStationDots();
    ScheduleCorridorOffsets();
    window[MAP_NAME].on('click', HandleMapClick);
    window[MAP_NAME].on('moveend zoomend', ScheduleStationDots);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var destBrowseModal = document.getElementById('DestBrowseModal');
            var stationBrowseModal = document.getElementById('StationBrowseModal');
            var sportsBrowseModal = document.getElementById('SportsBrowseModal');
            if (stationBrowseModal && stationBrowseModal.classList.contains('show')) {
                CloseStationBrowseModal();
            } else if (destBrowseModal && destBrowseModal.classList.contains('show')) {
                CloseDestBrowseModal();
            } else if (sportsBrowseModal && sportsBrowseModal.classList.contains('show')) {
                CloseSportsBrowseModal();
            } else if (CurrentStationPopup) {
                CloseStationPopup();
            } else if (SelectedId) {
                Reset();
            } else if (document.getElementById('InfoPopupOverlay').style.display === 'flex') {
                CloseInfoPopup();
            }
        }
    });

    if (window.innerWidth <= 768) {
        var sidebar = document.getElementById('Sidebar');
        var handle = document.getElementById('Handle');
        if (sidebar && !sidebar.classList.contains('collapsed')) {
            sidebar.classList.add('collapsed');
            if (handle) handle.innerHTML = '▶';
        }
    }

    Destinations = destinations || {};
    Leagues = leagues || {};
    BuildTeamVenueIndex();
    MarkDataLoaded();
    InitStationSearch();
    InitDestinationSearch();
    InitStationBrowseModal();
    SyncDestinationToggleUI();

    (function ReorderSearchRows() {
        var linesView = document.getElementById('LinesView');
        var searchLabel = document.getElementById('SearchSectionLabel');
        var routeRow = document.getElementById('SearchRow');
        var stationRow = document.getElementById('StationSearchRow');
        var destRow = document.getElementById('DestSearchRow');
        if (!linesView || !searchLabel || !routeRow || !stationRow || !destRow) return;
        linesView.insertBefore(destRow, searchLabel.nextSibling);
        linesView.insertBefore(stationRow, routeRow);
    })();

    RenderDestinationMarkers();
    var destBadge = document.getElementById('DestinationCountBadge');
    if (destBadge) {
        var destTotal = 0;
        Object.keys(Destinations).forEach(function(cat) { destTotal += Object.keys(Destinations[cat]).length; });
        destBadge.textContent = destTotal;
    }
    var sportsBadge = document.getElementById('SportsTeamCountBadge');
    if (sportsBadge) sportsBadge.textContent = Object.keys(TeamVenueIndex).length;
    window[MAP_NAME].on('zoomend', function() { UpdateDestinationMarkersVisibility(); UpdateProjectMarkersVisibility(); RefreshAllMarkerSizes(); ScheduleCorridorOffsets(); });
    window[MAP_NAME].on('moveend zoomend', function() { ResolveMarkerCollisions(); });

    window.addEventListener('resize', Debounce(RefreshAllMarkerSizes, 200));

    var tileLoadCheck = setInterval(function() {
        var tiles = document.querySelectorAll('.leaflet-tile');
        var allLoaded = true;

        tiles.forEach(function(tile) {
            if (!tile.complete) {
                allLoaded = false;
            }
        });

        if (allLoaded && tiles.length > 0) {
            clearInterval(tileLoadCheck);
            MarkTilesLoaded();
        }
    }, 100);

    setTimeout(function() {
        if (!MapLoadingState.tilesLoaded) {
            MarkTilesLoaded();
        }
    }, 3000);

    window[MAP_NAME].on('load', function() {
        setTimeout(function() {
            if (!MapLoadingState.tilesLoaded) {
                MarkTilesLoaded();
            }
        }, 500);
    });
}

function ShowStationPopupFromSearch(StationKey) {
    EnsureGroupMarkersExist(StationGroupMembers(StationKey));

    if (!Stations[StationKey] && !AllNodes[StationKey]) {
        CurrentStationPopup = null;
        ShowStationPopup(StationKey, false);
        return;
    }
    ShowStationPopup(StationKey, true);
}

function InitStationSearch() {
    var SearchRow = document.getElementById('SearchRow');
    if (!SearchRow) return;

    var Wrapper = document.createElement('div');
    Wrapper.id = 'StationSearchRow';

    var InputRow = document.createElement('div');
    InputRow.style.cssText = 'display:flex;gap:6px;align-items:center;';

    var Input = document.createElement('input');
    Input.type = 'text';
    Input.id = 'StationSearchInput';
    Input.placeholder = 'Search stations...';
    Input.autocomplete = 'off';
    Input.style.flex = '1';

    var BrowseBtn = document.createElement('button');
    BrowseBtn.id = 'StationBrowseBtn';
    BrowseBtn.title = 'Browse all stations';
    BrowseBtn.innerHTML = '⊞';

    InputRow.appendChild(Input);
    InputRow.appendChild(BrowseBtn);

    var Dropdown = document.createElement('div');
    Dropdown.id = 'StationSearchDropdown';

    Wrapper.appendChild(InputRow);
    Wrapper.appendChild(Dropdown);
    SearchRow.parentNode.insertBefore(Wrapper, SearchRow.nextSibling);

    BrowseBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        Dropdown.classList.remove('show');
        OpenStationBrowseModal();
    });

    var ActiveIdx = -1;

    function Render(Query) {
        Dropdown.innerHTML = '';
        ActiveIdx = -1;
        if (!Query.trim()) { Dropdown.classList.remove('show'); return; }

        var VisibleStationKeys = new Set(Object.keys(GetLinesByStation()));

        var Groups = {};
        Object.keys(StationSearchIndex).forEach(function(Key) {
            if (!VisibleStationKeys.has(Key)) return;
            var Base = StationGroupBase(Key);
            var CleanBase = CleanStationName(Base);
            if (!Groups[Base]) Groups[Base] = {Label: CleanBase, Keys: [], Labels: new Set([CleanBase])};
            Groups[Base].Keys.push(Key);
            var MemberLabel = StationSearchIndex[Key].Label;
            if (MemberLabel) Groups[Base].Labels.add(MemberLabel);
        });

        var Results = Object.values(Groups)
            .map(function(G) {
                var BestScore = 0;
                G.Labels.forEach(function(Lbl) { BestScore = Math.max(BestScore, ScoreMatch(Lbl, Query)); });
                return {Label: G.Label, Keys: G.Keys, S: BestScore};
            })
            .filter(function(R) { return R.S > 0; })
            .sort(function(A, B) { return B.S - A.S || A.Label.localeCompare(B.Label); })
            .slice(0, 8);

        if (!Results.length) { Dropdown.classList.remove('show'); return; }

        Results.forEach(function(R, Idx) {
            var Item = document.createElement('div');
            Item.className = 'StationSearchItem';
            Item.dataset.key = R.Keys[0];

            var Name = document.createElement('div');
            Name.className = 'StationSearchName';
            Name.textContent = R.Label;

            var Pills = document.createElement('div');
            Pills.className = 'StationSearchLines';
            var CurrentLines = LinesServingKeys(R.Keys);
            CurrentLines.forEach(function(Line) {
                var P = document.createElement('span');
                P.className = 'StationSearchPill';
                P.style.background = Line.Color;
                P.textContent = Line.Name;
                Pills.appendChild(P);
            });

            Item.appendChild(Name);
            if (CurrentLines.length) Item.appendChild(Pills);

            Item.addEventListener('mouseenter', function() { SetActive(Idx); });
            Item.addEventListener('click', function() { Commit(R.Keys[0], R.Label); });
            Dropdown.appendChild(Item);
        });

        Dropdown.classList.add('show');
    }

    function SetActive(Idx) {
        var Items = Dropdown.querySelectorAll('.StationSearchItem');
        Items.forEach(function(El, I) { El.classList.toggle('active', I === Idx); });
        ActiveIdx = Idx;
    }

    function Commit(Key, Label) {
        Input.value = '';
        Dropdown.classList.remove('show');
        ShowStationPopupFromSearch(Key);
    }

    var DebouncedRender = Debounce(Render, 100);
    Input.addEventListener('input', function() { DebouncedRender(Input.value); });
    Input.addEventListener('keydown', function(E) {
        var Items = Dropdown.querySelectorAll('.StationSearchItem');
        if (E.key === 'ArrowDown') { E.preventDefault(); SetActive(Math.min(ActiveIdx + 1, Items.length - 1)); }
        else if (E.key === 'ArrowUp') { E.preventDefault(); SetActive(Math.max(ActiveIdx - 1, 0)); }
        else if (E.key === 'Enter' && ActiveIdx >= 0) { Commit(Items[ActiveIdx].dataset.key, Items[ActiveIdx].querySelector('.StationSearchName').textContent); }
        else if (E.key === 'Escape') { Dropdown.classList.remove('show'); Input.blur(); }
    });
    document.addEventListener('click', function(E) {
        if (!Wrapper.contains(E.target)) Dropdown.classList.remove('show');
    });
}

function CollapseAll() {
    document.querySelectorAll('.GroupBox').forEach(G => {
        G.open = false;
        G.querySelectorAll('.OpGroupBox').forEach(OG => {
            OG.open = false;
        });
    });
}

function ShowInfoPopup(InfoKey) {
    var Info = InfoPoints[InfoKey];
    if (!Info) return;

    SelectedInfoPoint = InfoKey;
    SetProjectSelected(InfoKey, true);

    document.getElementById('InfoPopupTitle').innerText = InfoKey;
    document.getElementById('InfoPopupSource').innerText = Info.Source;

    var Content = '';
    if (Info.Image) {
        var imgAttrs = ImageAttrs(PROJECT_IMAGE_BASE, Info.Image);
        Content += `<img src="${imgAttrs.src}" ${imgAttrs.extra} class="InfoPopupImage" onclick="window.open('${Info.Link}', '_blank')" alt="${InfoKey}" title="Click to visit link">`;
    }
    Content += `<div class="InfoPopupDescription">${Info.Description}</div>`;

    document.getElementById('InfoPopupContent').innerHTML = Content;
    document.getElementById('InfoPopupOverlay').style.display = 'flex';
    document.getElementById('InfoPopupBackdrop').style.display = 'block';
}

function CloseInfoPopup() {
    if (SelectedInfoPoint) {
        SetProjectSelected(SelectedInfoPoint, false);
        SelectedInfoPoint = null;
    }

    document.getElementById('InfoPopupOverlay').style.display = 'none';
    document.getElementById('InfoPopupBackdrop').style.display = 'none';
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
    var layers = {marker: marker, dot: dot, selected: false};
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
    ApplyMarkerSelection(layers, MakeProjectMarkerIcon(key, info, selected), selected, GetProjectIconSize(info));
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