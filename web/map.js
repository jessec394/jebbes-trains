var RegistryFantasy, RegistryPresent, Registry;
var NamedStations, AllNodes, Stations;
var Modes, ModesOrder;
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
var TeamMapMarkersByLeague = {}; // league -> array of BuildPinMarker layer objects
var ActiveSportsLeagues = new Set();
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

const DOT_HIT_PADDING = 6;

var MapLoadingState = {
    initialized: false,
    dataLoaded: false,
    tilesLoaded: false
};

// Once everything has loaded, the splash gets a 'ready' class and its Enter
// button switches from a loading state to live.
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
    return CurrentMapMode === 'Fantasy' ? RegistryFantasy : RegistryPresent;
}

function GetHiddenRegistries() {
    return [CurrentMapMode === 'Fantasy' ? RegistryPresent : RegistryFantasy];
}

function SwitchMapMode(Mode) {
    if (CurrentMapMode === Mode) return;
    CurrentMapMode = Mode;
    DisabledModes.clear();
    ApplySwitchedRegistry();
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
    if (LeagueFlyoutOpen) RenderLeagueFlyout();          // which teams are reachable depends on the view
    RefreshSplashTeams();
    if (Mode !== 'Fantasy') CloseProjectBrowseModal(); // projects don't exist outside the Future map
    ActiveSportsLeagues.forEach(function(lg) { AddLeagueMarkers(lg); });
}

// Network / Explore sidebar tabs. Kept deliberately simple (two panels, one
// active at a time) so a third tab is a one-line addition later: add a
// button + panel pair and extend the id map below.
var SIDEBAR_TABS = { Network: 'NetworkTab', Explore: 'ExploreTab' };

function SwitchSidebarTab(tab) {
    Object.keys(SIDEBAR_TABS).forEach(function(t) {
        var btn = document.getElementById('TabBtn' + t);
        var panel = document.getElementById(SIDEBAR_TABS[t]);
        if (btn) btn.classList.toggle('active', t === tab);
        if (panel) panel.classList.toggle('active', t === tab);
    });
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
    HideProjectPanel();
    FocusSplashOnStation(SN);

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
    // Flag to the left of the name; city, subdivision (and type) underneath.
    var Region = null;
    GroupKeys.concat([SN]).some(function(K) {
        var E = StationSearchIndex[K];
        if (E && E.Region && E.Region.length) { Region = E.Region; return true; }
        return false;
    });
    SetPopupFlag(Region && Region[2]);
    var Place = Region ? [Region[0], Region[1]].filter(Boolean).join(', ') : '';
    document.getElementById('PopupStationType').innerText = [Place, S.Type].filter(Boolean).join(' · ');
    Overlay.classList.add('StationMode');

    var ModeGroups = {};
    ConnectedLines.forEach(L => {
        if (!ModeGroups[L.ModeId]) ModeGroups[L.ModeId] = [];
        ModeGroups[L.ModeId].push(L);
    });

    // (Plain string concatenation, not template literals: the build's
    // minifier strips spaces inside nested template strings.)
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

// The flag beside a station's name in its panel (hidden for places, or when
// the station has no country).
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
    if (typeof PositionProjectsCard === 'function') PositionProjectsCard();
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

    var PM = S && S.Type === "Airport" ? ` <span class="PlaneIcon"><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></span>` : '';
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
        var focusModes = new Set([Focus.ModeId]);
        Focus.AllLineStations.forEach(function(sn) {
            var s = Stations[sn];
            if (s) wanted[sn] = {
                location: s.Location,
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

    var groupBox = document.querySelector('.GroupBox[data-mode-group="' + ModeId + '"]');
    if (groupBox) {
        var IsNowOff = DisabledModes.has(ModeId);
        groupBox.classList.toggle('mode-group-off', IsNowOff);
        var sw = groupBox.querySelector('.ModeRowSwitch');
        if (sw) {
            sw.classList.toggle('active', !IsNowOff);
            sw.title = (IsNowOff ? 'Show ' : 'Hide ') + Modes[ModeId].Name;
        }
    }

    Reset();
    RefreshStationListings();
    SyncLinesMasterSwitch();
}

// The sidebar's Lines switch: every mode off, or (if all are off) every mode
// back on. (Unlike a single mode's switch, this may hide everything.)
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
    if (typeof RenderStationsPreview === 'function') RenderStationsPreview();
    var modal = document.getElementById('StationBrowseModal');
    var filterInput = document.getElementById('StationBrowseFilterInput');
    if (modal && modal.classList.contains('show')) RenderStationBrowseModal(filterInput ? filterInput.value : '');
    var omni = document.getElementById('SearchInput');
    if (omni && omni.value.trim() && typeof RenderOmniResults === 'function') RenderOmniResults();
    var routes = document.getElementById('RouteBrowseModal');
    var routeInput = document.getElementById('RouteBrowseFilterInput');
    if (routes && routes.classList.contains('show')) RenderRouteBrowseModal(routeInput ? routeInput.value : '');
}

document.addEventListener('click', function(e) {
    var panel = document.getElementById('SportsFilterPanel');
    var btn = document.getElementById('SportsLeagueSwitchBtn');
    if (!SportsFilterPanelOpen) return;
    var inPanel = panel && panel.contains(e.target);
    var onBtn = btn && btn.contains(e.target);
    if (!inPanel && !onBtn) CloseSportsFilterPanel();
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

// A small live dot on the "Explore" tab button, so switching away from it
// doesn't make it look like nothing is happening back there. Called from
// each layer's own UI-sync function whenever its state changes.
function UpdateExploreTabBadge() {
    var badge = document.getElementById('ExploreTabBadge');
    if (!badge) return;
    var projectsOn = (CurrentMapMode === 'Fantasy') && !ProjectsHidden;
    var poiOn = !DestinationsHidden;
    var sportsOn = ActiveSportsLeagues.size > 0;
    badge.style.display = (projectsOn || poiOn || sportsOn) ? 'block' : 'none';
}

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

// Destination markers are compact pills: a category-coloured icon disc plus
// the name, with a small pointer whose tip is exactly on the location.
// Zoomed out (below DEST_LABEL_MIN_ZOOM) it's just the icon; selected, the
// pill fills with the category colour. The divIcon is zero-sized and the
// pill is positioned from its tip by CSS (.DestPin), so it can be as wide as
// its name without guessing a width up front.
var DEST_LABEL_MIN_ZOOM = 12;

function MakeDestMarkerIcon(cat, name, dest, selected) {
    var c = GetDestCategoryConfig(cat);
    var S = GetDestPinSize();
    if (selected) S = Math.round(S * MARKER_SELECTED_SCALE);
    var zoom = window[MAP_NAME] ? window[MAP_NAME].getZoom() : DEST_LABEL_MIN_ZOOM;
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
var FLAG_IMAGE_BASE = 'data/images/flags';

// The 23 sovereign states of North America, in the order they appear around
// the splash-screen ring (clockwise from 12 o'clock). Codes double as the
// filenames in data/images/flags/ (<CODE>.webp). Add or remove a code here
// and the ring re-divides itself evenly.
var NORTH_AMERICA_FLAG_CODES = [
    'ATG', 'BHS', 'BLZ', 'BRB', 'CAN', 'CRI', 'CUB', 'DMA',
    'DOM', 'GRD', 'GTM', 'HND', 'HTI', 'JAM', 'KNA', 'LCA',
    'MEX', 'NIC', 'PAN', 'SLV', 'TTO', 'USA', 'VCT'
];

// Wraps each flag around the ring like the flag band on a mission patch.
//
// A rectangular image can't be bent with CSS alone, so each flag is cut into
// thin vertical strips. Strip i shows the i-th slice of the flag (via a nested
// <svg> viewBox, which crops and stretches it), and is rotated to sit at its
// own angle on the ring. The flag's width therefore runs around the ring and
// its height runs from the outer rim (flag top) to the inner rim (flag bottom),
// so stripes and emblems follow the arc. Every flag is stretched to fill its
// wedge (the source aspect ratio is ignored), the same as on a real patch.
//
// Each flag is its own <g class="FlagWedge"> that draws its own outline and is
// clipped to its exact annular sector, so a single wedge can pop out of the
// ring (see SetSplashHover) without dragging seams or neighbours with it.
var FlagWedges = {};      // country code -> <div class="FlagWedge">
var FLAG_POP_DISTANCE = 16;   // ring units (720 viewBox) a hovered flag moves outward

// Performance: every flag is its own small, absolutely-positioned layer (an
// HTML div holding an svg cropped to just that wedge), so popping one out is
// a GPU transform of a cached bitmap instead of re-rendering the whole ring.
// A static base layer underneath draws the ring outline, and a separate
// static hit layer on top catches the pointer.
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
        // The glow is its own layer underneath, so fading it in is a GPU
        // opacity change rather than a re-render of the blurred flag.
        var glow = '<svg class="FlagWedgeGlowLayer" ' + vb + '><path class="FlagWedgeGlow" d="' + sector + '" filter="url(#FlagGlowBlur)"></path></svg>';
        var svg = ['<svg class="FlagWedgeFlag" ' + vb + '>',
            '<clipPath id="FlagClip' + k + '"><path d="' + sector + '"></path></clipPath>',
            '<g clip-path="url(#FlagClip' + k + ')">'];
        for (var i = 0; i < SLICES; i++) {
            var s0 = a0 + (i / SLICES) * wedgeDeg;
            var s1 = a0 + ((i + 1) / SLICES) * wedgeDeg;
            var mid = (s0 + s1) / 2;
            // Chord across this slice at mid-ring, padded 12% so neighbours
            // overlap slightly instead of leaving hairline gaps. The wedge's
            // clip path trims the overhang at the rims and seams.
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

// ── Ring sheen ───────────────────────────────────────────────────────────────
//
// A soft sheen sweeps slowly round the flag band (pure CSS transform
// animation on a cached layer -- nothing is re-rendered per frame).

function BuildRingEffects() {
    var ring = document.getElementById('FlagRing');
    if (!ring) return;
    var sheen = document.createElement('div');
    sheen.id = 'FlagRingSheen';
    sheen.setAttribute('aria-hidden', 'true');
    ring.insertBefore(sheen, ring.querySelector('.FlagRingHits'));
}

// ── View title ───────────────────────────────────────────────────────────────
//
// The pill at the top of the circle names what's being viewed and doubles as
// the back button:
//   country view      ‹  [flag] Canada
//   one subdivision   ‹  Ontario
//                        [flag] Canada
// (A subdivision is "being viewed" when shown on its own or zoomed to for the
// selected station.)

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

// ── Splash map ────────────────────────────────────────────────────────────────
//
// The disc inside the flag ring shows every country in data/regions/. All the
// heavy lifting (projection, framing, dropping Hawaii/Guam, simplifying) is
// done at build time by builder/region_outlines.py, which hands over
// ready-made SVG path strings in SplashRegions.
//
// Two views share the disc:
//   continent -- hover a country to lift its flag; click it to zoom in.
//                Clicking the ocean enters the map (once loaded).
//   country   -- that country's first-level subdivisions; hovering one shows
//                its name. Back button, Escape, or clicking the ocean returns.
// Both views use the same projection, so the zoom between them is a single
// scale + translate of the continent layer, cross-faded into the
// subdivision layer at the end.

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

// ── Rendering ────────────────────────────────────────────────────────────────
//
// Everything visible in the disc is drawn on one <canvas>: land fills, rail
// lines, borders, the selected outline and the station dot, in that order (so
// lines never cover a border). An invisible svg on top holds the same shapes
// purely as pointer targets.
//
// Why: as SVG, every zoom frame re-rasterised thousands of vector paths and
// every hover repainted them. On the canvas a full redraw is a couple of
// milliseconds, and nothing is redrawn while nothing changes.
//
// Rail lines are stroked one stretch at a time at a low alpha, so where they
// cluster (city networks, junctions) they stack up darker. The build groups
// them by country (continent view) and by subdivision (country view), so a
// focused country or isolated subdivision just draws its own group -- no
// per-frame clipping against complex outlines. Fades and hover highlights
// are eased values (Scene.anim) rather than CSS transitions.

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

    // ── Continent layer ──
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
        // '+CODE' groups are border extras: the stretches of lines that
        // cross into CODE from a neighbour, drawn only while CODE is the
        // focus (masked to it), so its lines run right up to the border.
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

    // ── Subdivision layer ──
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
        // '+i' groups are border extras for subdivision i: drawn only when
        // it's shown on its own (masked to it), so lines reach its border.
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

// Lines grouped by region key; each group fades with its region and is
// masked to clipFor(key) if that returns an outline (Path2D), so lines stop
// at the border of whatever is being viewed. Groups sharing an outline are
// drawn under a single clip.
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

// {Fantasy: {regionKey: [{w, paths: [Path2D...]}]}, Present: {...}} from the
// build's path strings (one Path2D per stretch, so strokes can stack).
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

// Line colour, per-stroke alpha and width scale come from CSS custom
// properties (--line-color, --line-alpha on #SplashContent; --line-scale on
// the dock), so they stay tweakable in styles.css.
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

// Which network the globe shows. The splash always shows the Future Vision;
// once docked it follows the map's own Future / Present switch.
function SetSplashLineMode(mode) {
    AnimTo('Fantasy', mode === 'Fantasy' ? 1 : 0);
    AnimTo('Present', mode === 'Present' ? 1 : 0);
    var f = document.getElementById('GlobeModeFantasy');
    var p = document.getElementById('GlobeModePresent');
    if (f) f.classList.toggle('active', mode === 'Fantasy');
    if (p) p.classList.toggle('active', mode === 'Present');
}

var IDENTITY = [1, 0, 0, 1, 0, 0];

// Moves the continent ('land') or subdivision ('sub') layer to matrix m
// ([a b c d e f]). The invisible pointer targets follow too, except mid-
// animation (moveTargets false) -- nobody can point at a moving target, and
// skipping it keeps animation frames to the canvas alone.
function SetSplashLayer(which, m, moveTargets) {
    Scene[which] = m;
    if (moveTargets !== false) {
        var el = which === 'land' ? SplashLand : SplashSubLayer;
        if (m.join(' ') === '1 0 0 1 0 0') el.removeAttribute('transform');
        else el.setAttribute('transform', 'matrix(' + m.join(' ') + ')');
    }
    RequestSplashDraw();
}

// State classes drive the pointer targets (and cursors) via CSS; the
// drawing follows the same states through eased values.
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
    // (and a ring drawn around them while hovered).
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

// Which country (continent view) or subdivision (country view) is under the
// pointer. Overlapping round targets resolve to whichever centre is closest.
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

// Keeps the name tooltip just above the pointer, clamped inside the patch.
// Positioned with a transform (no layout), using a cached half-width.
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

// A flag is lifted while its country is hovered or zoomed into. (Its layer's
// z-index puts it above its neighbours; nothing is re-ordered or re-drawn.)
function UpdateFlagWedges() {
    Object.keys(FlagWedges).forEach(function(code) {
        // The viewed country's flag stays in the ring; and a flag that was
        // just clicked doesn't re-pop until the pointer has left it.
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
    if (SplashFocusCode) {
        SetSplashLabel(index !== null ? SplashData.Countries[SplashFocusCode].Subs[index].Name : null);
    }
}

// Zooms a layer ('land' or 'sub') by up to `k` around focal point (fx, fy)
// in its own coordinates, optionally turning it by `rot` degrees: at t = 0
// it's untransformed, at t = 1 it's scaled by k (and turned) with the focal
// point at the centre of the disc. Scale is interpolated logarithmically --
// a linear ramp from 1x to 300x (Grenada) would spend nearly the whole
// animation fully zoomed in -- and the focal point glides in a straight line
// to the centre. The canvas is redrawn in the same frame. The ring's idle
// effects pause meanwhile, so the zoom has the GPU to itself.
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

// Places a [lat, lon] in a country's view, mirroring the build: Lambert
// conformal projection (region_outlines._LambertConformal), then the shift
// applied to the landmass it's on (_shift), then that country's fit.
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

// Within a country's view, zoom onto one subdivision. Two flavours:
//   station  (isolated = false) -- neighbours stay, the subdivision gets a
//            heavy outline and the station a dot;
//   isolated (isolated = true)  -- clicked by the user: everything else fades
//            away and the subdivision fills the disc on its own.
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
    // Shown on its own, a subdivision is also turned north-up (the build
    // records how far its part of the conic map is tilted).
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

    // The country's own (finer) lines. Meanwhile the continent's lines fade
    // with their countries, so neighbours' lines don't float over empty sea.
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

    // Back out of a subdivision first, then let the subdivisions fade back
    // into the country outline, then zoom out to the continent.
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

// One level back: an isolated or station subdivision -> its country;
// a country -> the continent.
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

// ── Following the selected station ───────────────────────────────────────────
//
// When a station with a Region ([city, subdivision, country]) is selected,
// the globe zooms to that subdivision -- in the corner widget too. The build
// resolved every Region name to a subdivision (RegionIndex), keyed by the
// same accent/case-insensitive normalisation as below.

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

// Which country and subdivision a coordinate falls in on the globe, found
// geometrically (for places and projects, which have no Region field):
// the country from the continent outlines, then the subdivision from that
// country's view. Null if it lands in the sea (e.g. just off a simplified
// coast).
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

// Zooms the globe to target's subdivision with a dot at its location (or,
// with no target, lets go of any previous focus). Used by station, place and
// project panels alike; closing the panel releases it.
function FocusSplashOnTarget(target) {
    if (!SplashData || GlobeDockState === 'none') return;
    if (!target) {
        ReleaseSplashStationFocus();
        return;
    }
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

// Station deselected: if the globe was only zoomed in because of it, go back
// to the continent.
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

// Flags on the ring mirror their countries: hovering one lifts it and
// highlights the country on the map; clicking one zooms in, exactly as
// clicking the country does. Clicking the current country's flag zooms back
// out; clicking another country's flag hops straight across.
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

// ── Globe dock ────────────────────────────────────────────────────────────────
//
// Entering the map doesn't throw the flag ring away: the whole patch glides
// into the bottom-right corner as a small widget. Clicking it expands it back
// to full size over the map (fully interactive -- hover, zoom into countries,
// flags); the ×, the backdrop, or Escape shrinks it again, zooming back out
// to the whole continent on the way.

var GlobeDockState = 'none';   // 'none' (still in the splash) | 'mini' | 'expanded'
var GLOBE_DOCK_MS = 650;

// Moves the patch to wherever `mutate` puts it, animating from its old box to
// the new one (FLIP: measure, move, invert with a transform, then release).
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
    // While mini, the dock itself is the (single) button; expanded, the
    // controls inside the patch take over.
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
    // Whatever country was being looked at on the splash, the corner widget
    // starts out on the whole continent.
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
    SyncProjectsDock();
    var card = document.getElementById('ProjectLayerCard');
    if (card) {
        card.classList.toggle('mode-disabled', !isApplicable);
        card.title = isApplicable ? '' : 'Projects are only shown in the Future view';
    }
    UpdateExploreTabBadge();
}

function ToggleAllDestinations() {
    DestinationsHidden = !DestinationsHidden;
    SyncDestinationToggleUI();
    UpdateDestinationMarkersVisibility();
}

function SyncDestinationToggleUI() {
    RenderPlacesChips();
    var isOn = !DestinationsHidden;
    var btn = document.getElementById('POIToggleButton');
    if (btn) {
        btn.classList.toggle('active', isOn);
        btn.title = isOn ? 'Hide points of interest' : 'Show points of interest';
    }
    UpdateExploreTabBadge();
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
        var modeVisible = zoomOk && !DestinationsHidden && !HiddenDestCategories.has(cat) && DestExists(dest, isPresent ? 'Present' : 'Fantasy');
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

// Flies so latlng lands in the middle of the map area left uncovered by the
// sidebar (left) and the docked popup (right), not behind either.
function FlyToVisibleCenter(latlng, zoom) {
    var map = window[MAP_NAME];
    var w = map.getSize().x;
    var left = 0, right = 0;
    var sidebar = document.getElementById('Sidebar');
    if (sidebar && !sidebar.classList.contains('collapsed') && w > 768) {
        var r = sidebar.getBoundingClientRect();
        if (r.right > 0 && r.left < w / 2) left = r.right;
    }
    var popup = document.getElementById('StationPopupOverlay');
    if (popup && w > 768) right = 400 + 20;
    var dx = (right - left) / 2;
    var target = map.unproject(map.project(latlng, zoom).add([dx, 0]), zoom);
    map.flyTo(target, zoom, {animate: true, duration: 0.7});
}

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
    if (zoomIn) FlyToVisibleCenter(dest.Location, DEST_FOCUS_ZOOM);
    HideProjectPanel();
    var focusTarget = SplashTargetForPoint(dest.Location);
    if (focusTarget && SplashVenueForTeam) focusTarget.noDot = true;
    SplashVenueForTeam = false;
    FocusSplashOnTarget(focusTarget);

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
        var imgSource = DestImageSource(dest);
        var imgAttrs = ImageAttrs(DEST_IMAGE_BASE, imgFile);
        imgContainer.innerHTML = '<img src="' + imgAttrs.src + '" ' + imgAttrs.extra + ' class="DestPopupImage" alt="' + name + '">' +
            (imgSource ? '<div class="DestPopupSource">' + imgSource + '</div>' : '');
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
    ReleaseSplashStationFocus();
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

function InitDestBrowseModal() {
    var filterInput = document.getElementById('DestBrowseFilterInput');
    if (filterInput) {
        filterInput.addEventListener('input', function() { RenderDestBrowseModal(DestBrowseActiveCat); });
    }
}

function RenderDestModeToggle() {
    var el = document.getElementById('DestModeToggle');
    if (!el) return;
    el.innerHTML =
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Present' ? ' active' : '') + '" onclick="SetDestBrowseMode(\'Present\')">Present Day</button>' +
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Fantasy' ? ' active' : '') + '" onclick="SetDestBrowseMode(\'Fantasy\')">Future Vision</button>';
}

function SetDestBrowseMode(mode) {
    if (CurrentMapMode !== mode) SwitchMapMode(mode);
    RenderDestModeToggle();
    RenderDestBrowseModal(DestBrowseActiveCat);
}

var DestBrowseActiveCat = 'All';

function OpenDestBrowseModal(category) {
    var backdrop = document.getElementById('DestBrowseBackdrop');
    var modal = document.getElementById('DestBrowseModal');
    var filterInput = document.getElementById('DestBrowseFilterInput');
    if (backdrop) backdrop.classList.add('show');
    if (modal) modal.classList.add('show');
    if (filterInput) { filterInput.value = ''; setTimeout(function() { filterInput.focus(); }, 50); }
    RenderDestModeToggle();
    // Opened from a category chip, the window is just that category: its own
    // title and icon, no category tabs. (Without one it lists everything.)
    var single = !!(category && Destinations[category]);
    if (modal) modal.classList.toggle('single-category', single);
    var title = document.getElementById('DestBrowseTitle');
    var icon = document.getElementById('DestBrowseTitleIcon');
    if (single) {
        var cfg = OmniPlaceCategory(category);
        var full = DEST_CATEGORY_CONFIG[category] || (category === 'Campuses' ? DEST_CATEGORY_CONFIG.Universities : null);
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
    var backdrop = document.getElementById('DestBrowseBackdrop');
    var modal = document.getElementById('DestBrowseModal');
    if (backdrop) backdrop.classList.remove('show');
    if (modal) modal.classList.remove('show');
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

    var gridHtml = '';
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
}

function CommitBrowseSelection(cat, name) {
    CloseDestBrowseModal();
    if (DestinationsHidden) ToggleAllDestinations();
    ShowDestinationPopup(cat, name, true);
}

function InitProjectBrowseModal() {
    var filterInput = document.getElementById('ProjectBrowseFilterInput');
    if (filterInput) {
        filterInput.addEventListener('input', function() { RenderProjectBrowseModal(filterInput.value); });
    }
}

function OpenProjectBrowseModal() {
    if (CurrentMapMode !== 'Fantasy') return; // projects only exist on the Future map
    var backdrop = document.getElementById('ProjectBrowseBackdrop');
    var modal = document.getElementById('ProjectBrowseModal');
    var filterInput = document.getElementById('ProjectBrowseFilterInput');
    if (backdrop) backdrop.classList.add('show');
    if (modal) modal.classList.add('show');
    if (filterInput) { filterInput.value = ''; setTimeout(function() { filterInput.focus(); }, 50); }
    RenderProjectBrowseModal('');
}

function CloseProjectBrowseModal() {
    var backdrop = document.getElementById('ProjectBrowseBackdrop');
    var modal = document.getElementById('ProjectBrowseModal');
    if (backdrop) backdrop.classList.remove('show');
    if (modal) modal.classList.remove('show');
}

function RenderProjectBrowseModal(filterQuery) {
    var gridEl = document.getElementById('ProjectBrowseGrid');
    if (!gridEl) return;

    var query = (filterQuery || '').trim().toLowerCase();
    var names = Object.keys(InfoPoints).filter(function(name) {
        return !query || name.toLowerCase().indexOf(query) !== -1;
    }).sort();

    if (!names.length) {
        gridEl.innerHTML = '<div class="DestBrowseEmpty">No projects found.</div>';
        return;
    }

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
        '<button class="DestBrowseTab LeagueMapSwitch" style="margin-left:auto;" onclick="ToggleLeagueFromBrowser(\'' + escLg + '\')" title="Show or hide all of this league\'s teams on the map">' +
            'Show all on map <span class="InlineToggleSwitch accent-green' + (ActiveSportsLeagues.has(league) ? ' active' : '') + '"><span class="InlineToggleKnob"></span></span></button>';

    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
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

// Opens the venue for `team` on the map's current Present/Fantasy display
// setting (see TeamVenueForMode for how overlapping venues are resolved).
function SelectSportsTeam(league, team) {
    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var match = TeamVenueForMode(team, mode, ComputeVisibleStationKeys());
    if (!match) return;
    CloseSportsBrowseModal();
    // Just the team's venue panel: no markers are switched on (venues stay as
    // the Places bar has them; a whole league only via its switch).
    SplashVenueForTeam = true;
    ShowDestinationPopup(match.cat, match.name, true);
}

function MakeTeamMarkerIcon(logoSrc, logoExtra, available) {
    var S = 44;
    var faded = available ? '' : 'filter:grayscale(1);opacity:0.5;';
    var badge = available ? '' :
        '<div style="position:absolute;bottom:-3px;right:-3px;width:17px;height:17px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:flex;align-items:center;justify-content:center;">' +
        '<svg viewBox="0 0 18 18" width="9" height="9" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"><path d="M4.5 4.5L13.5 13.5M13.5 4.5L4.5 13.5"/></svg></div>';
    // Just the logo (no disc behind it), with a soft shadow so light logos
    // still read against the map.
    var html = '<div style="position:relative;width:' + S + 'px;height:' + S + 'px;">' +
        '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;cursor:' + (available ? 'pointer' : 'default') + ';' + faded + '">' +
            '<img src="' + logoSrc + '" ' + logoExtra + ' style="width:100%;height:100%;object-fit:contain;filter:drop-shadow(0 1px 1.5px rgba(15,23,42,0.45)) drop-shadow(0 0 1px rgba(255,255,255,0.9));" alt="">' +
        '</div>' + badge +
        '</div>';
    return L.divIcon({html: html, className: 'TeamMarkerIcon', iconSize: [S, S], iconAnchor: [S / 2, S / 2]});
}

// When a team has no venue valid for the current mode (TeamVenueForMode
// returns null), it should still appear on the map -- just greyed out -- at
// whichever of its venues is the most relevant, rather than silently
// disappearing. Prefers a venue that at least Exists in this mode (it's just
// unreachable by rail) over one that doesn't exist here at all, and otherwise
// mirrors TeamVenueForMode's specificity tie-break.
function TeamVenueFallback(team, mode) {
    var all = TeamVenueIndex[team] || [];
    if (!all.length) return null;
    var existsHere = all.filter(function(m) { return DestExists(m.dest, mode); });
    var pool = (existsHere.length ? existsHere : all).slice();
    pool.sort(function(a, b) { return (a.dest.Exists || []).length - (b.dest.Exists || []).length; });
    return pool[0];
}

// Drops every team in `league` onto the map at its venue's location -- lit up
// and clickable (same TeamVenueForMode/SelectSportsTeam the menu itself uses)
// when it's actually reachable in the current mode, greyed out and inert
// otherwise. Markers are registered with the same collision-avoidance sim
// destinations/projects already use, so teams sharing a stadium or just
// sitting close together spread apart automatically instead of stacking.
// Adds/refreshes just `league`'s markers without disturbing any other
// league's -- multiple leagues can be shown on the map at once now, each
// independently toggled via the Sports Teams switch panel.
function AddLeagueMarkers(league) {
    RemoveLeagueMarkers(league);
    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
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
    var panel = document.getElementById('SportsFilterPanel');
    if (panel && panel.classList.contains('open')) BuildSportsFilterPanel();
}

function ToggleLeagueMarkers(league) {
    SetLeagueMarkersVisible(league, !ActiveSportsLeagues.has(league));
}

function ClearAllLeagueMarkers() {
    Array.from(ActiveSportsLeagues).forEach(function(lg) { RemoveLeagueMarkers(lg); });
    ActiveSportsLeagues.clear();
    UpdateSportsSwitchUI();
    UpdateSportsOverlayBadge();
    var panel = document.getElementById('SportsFilterPanel');
    if (panel && panel.classList.contains('open')) BuildSportsFilterPanel();
}

function UpdateSportsSwitchUI() {
    SyncLeagueRack();
    var btn = document.getElementById('SportsLeagueSwitchBtn');
    if (btn) btn.classList.toggle('active', ActiveSportsLeagues.size > 0);
    UpdateExploreTabBadge();
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

// The Sports Teams card's switch opens this inline panel (a checklist of
// every league) rather than flipping a single boolean, since "on" here means
// a set of independently-toggleable leagues, not one shared state.
var SportsFilterPanelOpen = false;

function ToggleSportsFilterPanel(e) {
    if (e) e.stopPropagation();
    SportsFilterPanelOpen = !SportsFilterPanelOpen;
    var panel = document.getElementById('SportsFilterPanel');
    var btn = document.getElementById('SportsLeagueSwitchBtn');
    if (panel) {
        panel.classList.toggle('open', SportsFilterPanelOpen);
        if (SportsFilterPanelOpen) BuildSportsFilterPanel();
    }
    if (btn) btn.classList.toggle('open', SportsFilterPanelOpen);
}

function CloseSportsFilterPanel() {
    if (!SportsFilterPanelOpen) return;
    SportsFilterPanelOpen = false;
    var panel = document.getElementById('SportsFilterPanel');
    var btn = document.getElementById('SportsLeagueSwitchBtn');
    if (panel) panel.classList.remove('open');
    if (btn) btn.classList.remove('open');
}

function BuildSportsFilterPanel() {
    var panel = document.getElementById('SportsFilterPanel');
    if (!panel) return;
    var leagues = Object.keys(Leagues).sort();
    var html = '<button class="LeagueBrowseLink" onclick="event.stopPropagation(); CloseSportsFilterPanel(); OpenSportsBrowseModal();">' +
        '<svg viewBox="0 0 18 18" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="5.5"/><line x1="12" y1="12" x2="15.5" y2="15.5"/></svg>' +
        'Browse all teams</button>';
    if (!leagues.length) {
        html += '<div class="LeagueFilterItem" style="color:rgba(255,255,255,0.35); cursor:default;">No leagues found.</div>';
        panel.innerHTML = html;
        return;
    }
    leagues.forEach(function(lg) {
        var isOn = ActiveSportsLeagues.has(lg);
        var escLg = lg.replace(/'/g, "\\'");
        html += '<button class="LeagueFilterItem' + (isOn ? ' league-on' : '') + '" onclick="event.stopPropagation(); ToggleLeagueMarkers(\'' + escLg + '\')">' +
            '<span class="LeagueFilterItemLabel">' + lg + '</span>' +
            '<span class="LeagueFilterSwitch"><span class="LeagueFilterSwitchKnob"></span></span>' +
        '</button>';
    });
    panel.innerHTML = html;
}

function ViewLeagueTeamsOnMap(league) {
    CloseSportsBrowseModal();
    SetLeagueMarkersVisible(league, true);
}

// The Sports Teams window's switch: flips the league on / off the map and
// stays open, so it's as easy to turn off as on.
function ToggleLeagueFromBrowser(league) {
    SetLeagueMarkersVisible(league, !ActiveSportsLeagues.has(league));
    var sw = document.querySelector('#SportsBrowseTabs .LeagueMapSwitch .InlineToggleSwitch');
    if (sw) sw.classList.toggle('active', ActiveSportsLeagues.has(league));
}


function BuildAllStationGroups(filterQuery) {
    // Was calling LinesServingKeys (a full Registry scan) once per station
    // group -- O(groups x registry size) and the actual source of the lag
    // when this modal opens. GetLinesByStation() already builds a cached
    // station -> line-id index in one pass; reuse that instead so each group
    // just unions a handful of Set lookups.
    var linesByStation = GetLinesByStation();
    var lineById = {};
    Registry.forEach(function(L) { lineById[L.Id] = L; });

    var Groups = {};
    Object.keys(StationSearchIndex).forEach(function(Key) {
        var served = linesByStation[Key];
        if (!served) return;
        var Base = StationGroupBase(Key);
        if (!Groups[Base]) Groups[Base] = {Keys: [], Labels: [], LineIds: new Set(), Region: null};
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
            G.Label = G.Labels.reduce(function(Best, L) { return L.length > Best.length ? L : Best; });
            return G;
        })
        .filter(function(G) { return !qn || NormalizeSearchText(G.Label).includes(qn); })
        .map(function(G) {
            // Only lines whose mode is switched on: a station served only by a
            // hidden mode (say, streetcar) drops out of the list and the count.
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

// Region is [city, first-level subdivision, country code]. City + subdivision
// render as text; the country code is looked up as a flag image at
// data/images/flags/<code>.webp. A missing flag file just hides itself (the
// text still shows), and a missing Region leaves the slot empty.
function StationRegionHtml(region) {
    if (!region || !region.length) return '';
    var place = [region[0], region[1]].filter(Boolean).join(', ');
    var country = region[2];
    var img = '';
    if (country) {
        img = '<img class="StationBrowseFlag" src="' + FLAG_IMAGE_BASE + '/' + encodeURIComponent(country) + '.webp"' +
            ' alt="" title="' + EscapeHtml(country).replace(/"/g, '&quot;') + '" loading="lazy" onerror="this.style.display=\'none\'">';
    }
    // The slot is always emitted (even with no flag) so the place text stays
    // aligned with every other row's.
    return '<span class="StationBrowseFlagSlot">' + img + '</span>' +
        (place ? '<span class="StationBrowseAreaText" title="' + EscapeHtml(place).replace(/"/g, '&quot;') + '">' + EscapeHtml(place) + '</span>' : '');
}

var STATION_BROWSE_PILLS = 5;   // line pills per row before "+N"
var StationBrowseSort = 'name'; // 'name' (A-Z) or 'city' (busiest city first)

function RenderStationBrowseModeToggle() {
    var el = document.getElementById('StationBrowseModeToggle');
    if (!el) return;
    el.innerHTML =
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Present' ? ' active' : '') + '" onclick="SetStationBrowseView(\'Present\')">Present Day</button>' +
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Fantasy' ? ' active' : '') + '" onclick="SetStationBrowseView(\'Fantasy\')">Future Vision</button>';
}

// Future / Present from the station window: switches the whole map, and the
// list follows (SwitchMapMode -> RefreshStationListings).
function SetStationBrowseView(mode) {
    if (CurrentMapMode !== mode) SwitchMapMode(mode);
    RenderStationBrowseModeToggle();
}

// Collapsed letter / city groups, remembered per sort so a mode switch or a
// new search doesn't reopen them.
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

// The window's mode switches: the same DisabledModes as the sidebar's rows
// (ToggleMode refreshes this window through RefreshStationListings).
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
        // Cities with the most stations first (ties alphabetical); stations
        // within a city stay alphabetical. The city header carries the place,
        // so rows don't repeat it.
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

// "Collapse all" / "Expand all" for a window's groups: if any group is open,
// fold them all; otherwise open them all. `collapsed` is that window's
// remembered set for its current sort.
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
        if (window[entry.Id]) return;
        var layer = CreateLeafletLayer(entry);
        if (!layer) return;
        window[entry.Id] = layer;
    });
}

function CreateLeafletLayer(entry) {
    var geo = entry.Geometry;
    if (!geo || geo.Type !== 'polyline') return null;
    var style = {
        color: entry.Color, weight: entry.Weight, opacity: 1.0,
        lineJoin: 'round', lineCap: 'round', smoothFactor: 1.5
    };
    var layer = L.polyline(geo.Coords, Object.assign({}, style, {interactive: false}));
    layer.addTo(window[MAP_NAME]);
    if (layer.setZIndex) layer.setZIndex(entry.ZIndex);
    return layer;
}

function initializeMap(mapName, registryFantasy, registryPresent, namedStations, allNodes, modes, basemapLayerNames, infoPoints, stationSearchIndex, destinations, leagues) {
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
    RegistryFantasy = registryFantasy;
    RegistryPresent = registryPresent;
    Registry = RegistryFantasy;
    NamedStations = namedStations;
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
    if (projectBadge) projectBadge.textContent = Object.keys(InfoPoints).length.toLocaleString();
    SyncStationDotsToggleUI();
    BuildByMode();
    RefreshStationDots();
    window[MAP_NAME].on('click', HandleMapClick);
    window[MAP_NAME].on('moveend zoomend', ScheduleStationDots);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            var destBrowseModal = document.getElementById('DestBrowseModal');
            var stationBrowseModal = document.getElementById('StationBrowseModal');
            var sportsBrowseModal = document.getElementById('SportsBrowseModal');
            var projectBrowseModal = document.getElementById('ProjectBrowseModal');
            if (stationBrowseModal && stationBrowseModal.classList.contains('show')) {
                CloseStationBrowseModal();
            } else if (destBrowseModal && destBrowseModal.classList.contains('show')) {
                CloseDestBrowseModal();
            } else if (sportsBrowseModal && sportsBrowseModal.classList.contains('show')) {
                CloseSportsBrowseModal();
            } else if (projectBrowseModal && projectBrowseModal.classList.contains('show')) {
                CloseProjectBrowseModal();
            } else if (SportsFilterPanelOpen) {
                CloseSportsFilterPanel();
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
    InitStationBrowseModal();
    InitDestBrowseModal();
    InitProjectBrowseModal();
    SyncDestinationToggleUI();

    RenderDestinationMarkers();
    var destBadge = document.getElementById('DestinationCountBadge');
    var destTotal = 0;
    Object.keys(Destinations).forEach(function(cat) { destTotal += Object.keys(Destinations[cat]).length; });
    if (destBadge) destBadge.textContent = destTotal.toLocaleString();

    var sportsBadge = document.getElementById('SportsTeamCountBadge');
    if (sportsBadge) sportsBadge.textContent = Object.keys(TeamVenueIndex).length.toLocaleString();
    var leagueRow = document.getElementById('SportsExploreRow');
    if (leagueRow) leagueRow.style.display = Object.keys(Leagues).length ? 'flex' : 'none';
    InitExploreWidgets();

    window[MAP_NAME].on('zoomend', function() { UpdateDestinationMarkersVisibility(); UpdateProjectMarkersVisibility(); RefreshAllMarkerSizes(); });
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
    } else {
        ShowStationPopup(StationKey, true);
    }
    CenterOnStation(StationKey);
}

// Selecting a station from a list (search, the sidebar preview, the station
// window, a panel's nearby stations) centres it in the visible part of the
// map -- between the sidebar and the panel -- at the current zoom. (A marker
// clicked on the map is already in view, so that doesn't move it.)
function CenterOnStation(StationKey) {
    var keys = StationGroupMembers(StationKey);
    var pts = (keys.length ? keys : [StationKey]).map(function(k) {
        var S = Stations[k] || AllNodes[k];
        return S && S.Location;
    }).filter(Boolean);
    if (!pts.length) return;
    var lat = pts.reduce(function(a, p) { return a + p[0]; }, 0) / pts.length;
    var lon = pts.reduce(function(a, p) { return a + p[1]; }, 0) / pts.length;
    FlyToVisibleCenter([lat, lon], window[MAP_NAME].getZoom());
}

function CollapseAll() {
    document.querySelectorAll('.GroupBox').forEach(G => {
        G.open = false;
        G.querySelectorAll('.OpGroupBox').forEach(OG => {
            OG.open = false;
        });
    });
}

var PROJECT_FOCUS_ZOOM = 14;

// Opening a project from a menu zooms by its size code, so a corridor (X)
// shows all or most of its length (3C+D's ~400 km fits at 7) while a single
// station (S) gets the close-up. Whole zoom levels: the map snaps to them.
var PROJECT_FOCUS_ZOOM_BY_RADIUS = {X: 7, L: 8, M: 11, S: 14};

function ShowInfoPopup(InfoKey, zoomIn) {
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

    // A station or place panel would sit in the same spot: swap it out
    // without letting the globe zoom back out in between.
    if (CurrentStationPopup) {
        SplashStationFocus = false;
        CloseStationPopup();
    }

    document.getElementById('InfoPopupContent').innerHTML = Content;
    document.getElementById('InfoPopupOverlay').style.display = 'flex';

    // Same convention as ShowDestinationPopup: only reposition the map when
    // opened from a menu, never when the marker itself was clicked directly.
    if (zoomIn && Info.Location) FlyToVisibleCenter(Info.Location, PROJECT_FOCUS_ZOOM_BY_RADIUS[Info.Radius] || PROJECT_FOCUS_ZOOM);
    FocusSplashOnTarget(SplashTargetForPoint(Info.Location));
}

// Closes the project panel because another panel is taking its place: the
// globe stays focused for the newcomer to move on from.
function HideProjectPanel() {
    if (document.getElementById('InfoPopupOverlay').style.display !== 'flex') return;
    SplashStationFocus = false;
    CloseInfoPopup();
}

function CloseInfoPopup() {
    if (SelectedInfoPoint) {
        SetProjectSelected(SelectedInfoPoint, false);
        SelectedInfoPoint = null;
    }

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
// ── Omni-search ──────────────────────────────────────────────────────────────
//
// One box in the sidebar searches everything. Lines are filtered in place in
// the list below (the existing _DoFilterList); stations, places, teams and
// projects appear as grouped results above it. Picking a result opens it the
// same way its map marker or browse card would. Matching ignores case and
// accents ("quebec" finds "Québec"); prefixes rank above word starts, which
// rank above anywhere-in-the-name.

var OMNI_LIMIT = 4;                       // results per group until "Show all"
var OmniExpanded = {};                    // group -> true once "Show all" is clicked
var OmniIndex = null;                     // built on first search
var OmniFirstPick = null;                 // what Enter picks

function OmniNorm(s) {
    return String(s || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function OmniPlaceCategory(cat) {
    var cfg = DEST_CATEGORY_CONFIG[cat] || (cat === 'Campuses' ? DEST_CATEGORY_CONFIG.Universities : null);
    return { label: (cfg && cfg.label) || cat.replace(/s$/, ''), bg: (cfg && cfg.bg) || '#475569' };
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

    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var visible = null;
    var visibleStations = ComputeVisibleStationKeys();   // stations of switched-on modes
    var groups = [
        { id: 'stations', title: 'Stations', items: OmniMatch(OmniIndex.stations, q, function(st) { return visibleStations.has(st.key); }) },
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
        var dots = (e.Lines || []).slice(0, 5).map(function(l) { return '<span class="OmniDot" style="background:' + l.Color + '"></span>'; }).join('');
        // Many stations share a name ("Chicago" on four L lines): the first
        // serving line, plus how many more, tells them apart.
        var lines = e.Lines || [];
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
    if (window.innerWidth <= 768 && typeof ToggleSidebar === 'function') {
        var sidebar = document.getElementById('Sidebar');
        if (sidebar && !sidebar.classList.contains('collapsed')) ToggleSidebar();
    }
}

function OnOmniSearchKey(e) {
    if (e.key === 'Enter') {
        RenderOmniResults();
        if (OmniFirstPick) (new Function(OmniFirstPick))();
    } else if (e.key === 'Escape') {
        ClearOmniSearch();
    }
}

function ClearOmniSearch() {
    var input = document.getElementById('SearchInput');
    if (!input) return;
    input.value = '';
    OmniExpanded = {};
    RenderOmniResults();
    input.focus();
}

// ── Layers control ───────────────────────────────────────────────────────────
//
// Basemap + overlays, as one panel off a button on the map (top-right).
// Clicking outside it or pressing Escape closes it.

function ToggleLayersPanel(e, open) {
    if (e) e.stopPropagation();
    var ctl = document.getElementById('LayersControl');
    if (!ctl) return;
    var next = open === undefined ? !ctl.classList.contains('open') : open;
    if (next && typeof CloseExploreOverlays === 'function') CloseExploreOverlays('style');
    ctl.classList.toggle('open', next);
    var btn = document.getElementById('LayersToggle');
    if (btn) btn.setAttribute('aria-expanded', next ? 'true' : 'false');
    if (!next && typeof CloseSportsFilterPanel === 'function') CloseSportsFilterPanel();
}

document.addEventListener('click', function(e) {
    var ctl = document.getElementById('LayersControl');
    if (ctl && ctl.classList.contains('open') && !ctl.contains(e.target)) ToggleLayersPanel(null, false);
});
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') ToggleLayersPanel(null, false);
});

// ── Explore widgets ──────────────────────────────────────────────────────────
//
// Each exploratory feature is its own widget with its own way of working,
// rather than rows in one list:
//   Places   -- category chips at the bottom of the map; each category
//               (airports, campuses, venues) switches on and off by itself.
//   Projects -- a gallery drawer at the bottom (Future view only): image
//               cards; a card flies to its project.
//   Sports   -- a rack of league logos on the right edge; a league opens a
//               flyout of its team logos. Picking a team shows its league on
//               the map and opens the team's venue.
// (Stations belong to the network and live in the sidebar.)

var HiddenDestCategories = new Set();     // categories switched off while places are on
var LeagueFlyoutOpen = null;              // league whose flyout is open
var ProjectsStripBuilt = false;

function InitExploreWidgets() {
    RenderPlacesChips();
    RenderStationsPreview();
    RenderProjectsCard();
    BuildLeagueRack();
    SyncProjectsDock();
}

// ── Places ──

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

function EnsureDestCategoryVisible(cat) {
    if (PlaceCategoryOn(cat)) return;
    ToggleDestCategory(cat);
}

// Each chip has two parts: its coloured icon switches the category on or off
// on the map; its name (and count) opens the list of every place in it.
function RenderPlacesChips() {
    var host = document.getElementById('PlacesChips');
    if (!host || typeof Destinations === 'undefined') return;
    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var anyOn = DestCategories().some(PlaceCategoryOn);
    // A master switch first: every place marker on or off in one go.
    host.innerHTML = '<button class="PlacesMaster" onclick="ToggleAllPlaces()" aria-pressed="' + anyOn + '" title="' + (anyOn ? 'Hide' : 'Show') + ' all places on the map">' +
            '<span>Places</span><span class="InlineToggleSwitch accent-amber' + (anyOn ? ' active' : '') + '"><span class="InlineToggleKnob"></span></span>' +
        '</button>' + DestCategories().map(function(cat) {
        var cfg = OmniPlaceCategory(cat);
        var full = DEST_CATEGORY_CONFIG[cat] || (cat === 'Campuses' ? DEST_CATEGORY_CONFIG.Universities : null);
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
    }).join('');
}

// All place markers on (every category) or off.
function ToggleAllPlaces() {
    var anyOn = DestCategories().some(PlaceCategoryOn);
    DestinationsHidden = anyOn;
    HiddenDestCategories.clear();
    SyncDestinationToggleUI();
    UpdateDestinationMarkersVisibility();
}

// ── Stations preview (sidebar) ──
//
// Every station in the current view, busiest first (most lines serving it),
// three rows tall and loading more as you scroll; the section's expand
// button opens the full station browser.
var STATIONS_PREVIEW_PAGE = 15;   // rows added each time the list nears its end
var StationsPreviewRows = [];     // every station in the current view, busiest first
var StationsPreviewShown = 0;

function RenderStationsPreview() {
    var host = document.getElementById('StationsPreview');
    if (!host || typeof StationSearchIndex === 'undefined') return;
    // Matched by operator + name: the search index lists a line once even
    // when it runs in both views (under its Future id). Lines of switched-off
    // modes don't count, so stations served only by them drop out.
    var current = new Set(Registry.filter(function(L) { return !DisabledModes.has(L.ModeId); })
        .map(function(L) { return L.Operator + '|' + L.Name; }));
    var seen = {};
    var rows = [];
    Object.keys(StationSearchIndex).forEach(function(key) {
        var e = StationSearchIndex[key];
        var lines = (e.Lines || []).filter(function(l) { return current.has(l.Operator + '|' + l.Name); });
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

// ── Projects ──

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

// The projects card sits directly under the sidebar (desktop): same width,
// following its bottom edge as it grows or shrinks, and tucking away with it.
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
    var pill = document.getElementById('ProjectsPill');
    if (pill) pill.classList.toggle('pins-on', future && !ProjectsHidden);
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
    var pill = document.getElementById('ProjectsPill');
    if (pill) pill.setAttribute('aria-expanded', next ? 'true' : 'false');
}

// ── Sports ──
//
// A button on the right of the map opens the Sports Teams browser (league
// logos -> team logos, with each league's "show on the map"). While any
// league is on the map the button shows a small dot. (The names below are
// kept from the earlier inline panel because other code calls them.)

var SportsPanelOpen = false;

// The sidebar's Sports shelf: a scrolling row of league logos. A logo opens
// the Sports Teams window at that league; "Browse" opens it at the top.
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
    if (typeof RenderSportsTeamGrid === 'function') {
        SportsBrowseCurrentLeague = league;
        RenderSportsTeamGrid(league);
    }
}

// Called whenever leagues go on / off the map (via UpdateSportsSwitchUI):
// a dot on the card, a ring on each league that's on the map.
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

function OpenLeagueFlyout() { ToggleSportsRack(true); }
function CloseLeagueFlyout() {}
function RenderLeagueFlyout() {}

document.addEventListener('click', function(e) {
    var drawer = document.getElementById('ProjectsDrawer');
    var banner = document.getElementById('ProjectsCard');
    if (drawer && drawer.classList.contains('open') && !drawer.contains(e.target) && !(banner && banner.contains(e.target))) ToggleProjectsDrawer(false);
});
document.addEventListener('keydown', function(e) {
    if (e.key !== 'Escape') return;
    ToggleProjectsDrawer(false);
});

// ── Teams on the globe ───────────────────────────────────────────────────────
//
// When a league is on the map, its teams' venues also show on the globe:
// green dots on the continent, and inside the country / state / province
// being viewed. Positions come from the build's projection (Projection,
// ContinentFit, each country's Fit) -- the same maths as the station dot.

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

// Recomputed when leagues go on / off the map, the view changes, or a
// country is entered. One point per venue, carrying its teams; continent
// points remember their country (to fade with it), country points their
// subdivision (for isolation).
function RefreshSplashTeams() {
    if (!Scene.ctx || !SplashData || typeof Leagues === 'undefined') return;
    var ctx = Scene.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    var mode = (CurrentMapMode === 'Present') ? 'Present' : 'Fantasy';
    var visible = ActiveSportsLeagues.size ? ComputeVisibleStationKeys() : null;
    var venues = {};
    ActiveSportsLeagues.forEach(function(lg) {
        (Leagues[lg] || []).forEach(function(team) {
            // Same placement as the main map: reachable teams at their venue,
            // the rest (greyed) at their venue fallback.
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

// Team logos for the canvas, loaded once each. Tries the same file-extension
// candidates as the <img> helper (ImageAttrs); null until loaded.
var SplashLogoCache = {};
function SplashTeamLogo(league, team) {
    var key = league + '|' + team;
    var c = SplashLogoCache[key];
    if (c) return c.ready ? c.img : null;
    c = SplashLogoCache[key] = { img: new Image(), ready: false };
    var candidates = BuildImageCandidates(SPORTS_IMAGE_BASE + '/' + encodeURIComponent(league), team);
    var i = 0;
    c.img.onload = function() { c.ready = true; RequestSplashDraw(); };
    c.img.onerror = function() { if (++i < candidates.length) c.img.src = candidates[i]; };
    c.img.src = candidates[0];
    return null;
}

// Each venue's team logos (side by side when a venue hosts several teams);
// a green dot stands in until a logo has loaded.
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


// ── Lines window ─────────────────────────────────────────────────────────────
//
// Every line in the current view (Future / Present), like the Stations
// window: search, group by mode or by agency (both collapsible, with
// Collapse all), and the mode chips. Clicking a line selects it on the map.

var RouteBrowseSort = 'mode';   // 'mode' or 'agency'
var RouteBrowseCollapsed = { mode: new Set(), agency: new Set() };

function OpenRouteBrowseModal() {
    var backdrop = document.getElementById('RouteBrowseBackdrop');
    var modal = document.getElementById('RouteBrowseModal');
    var input = document.getElementById('RouteBrowseFilterInput');
    if (backdrop) backdrop.classList.add('show');
    if (modal) modal.classList.add('show');
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
    var backdrop = document.getElementById('RouteBrowseBackdrop');
    var modal = document.getElementById('RouteBrowseModal');
    if (backdrop) backdrop.classList.remove('show');
    if (modal) modal.classList.remove('show');
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
    el.innerHTML =
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Present' ? ' active' : '') + '" onclick="SetRouteBrowseView(\'Present\')">Present Day</button>' +
        '<button class="SportsModeBtn' + (CurrentMapMode === 'Fantasy' ? ' active' : '') + '" onclick="SetRouteBrowseView(\'Fantasy\')">Future Vision</button>';
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
    var routes = document.getElementById('RouteBrowseModal');
    if (routes && routes.classList.contains('show')) CloseRouteBrowseModal();
});