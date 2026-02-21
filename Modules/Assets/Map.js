var RegistryNew, RegistryOld, Registry;
var StationsNew, AllNodes, Stations;
var Modes, ModesOrder;
var CurrentView = 'Old';
var SelectedId = null;
var StationMarkers = {};
var CurrentBaseSize = 5;
var SelectedItinerary = null;
var CurrentStationPopup = null;
var BasemapLayers = {};
var MAP_NAME;
var InfoPoints = {};
var InfoMarkers = {};
var SelectedInfoPoint = null;

const STROKE_WEIGHT = 2.5;
const HOVER_STROKE_WEIGHT = 5;
const TRANSFER_DISTANCE_KM = 1.0;
const NEARBY_STATION_KM = 0.5;
const STATION_POPUP_RADIUS_KM = 0.4;

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
    }
}

function MarkMapInitialized() {
    MapLoadingState.initialized = true;
    UpdateLoadingProgress();
}

function MarkDataLoaded() {
    MapLoadingState.dataLoaded = true;
    UpdateLoadingProgress();

    // Display statistics - only count from current view (RegistryOld/AllNodes which is Data1.py)
    // Don't count RegistryNew/StationsNew which is Data2.py
    var totalRoutes = RegistryOld.length;
    var totalStations = Object.keys(AllNodes).length;

    var statsElement = document.getElementById('MapStats');
    if (statsElement) {
        statsElement.innerHTML = `<span class="stat-item">${totalRoutes} Routes</span><span class="stat-divider">•</span><span class="stat-item">${totalStations} Stations</span>`;
        setTimeout(() => {
            statsElement.classList.add('visible');
        }, 100);
    }

    // Start fading in the map behind the skeleton
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

    // Hide the skeleton after a brief delay
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

    splash.classList.add('hidden');
    mapBlur.classList.add('hidden');

    // Ensure skeleton and background are also hidden
    if (skeleton) skeleton.classList.add('hidden');
    if (background) background.classList.add('hidden');
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

function ToggleDataView() {
    if (CurrentView === 'New') {
        CurrentView = 'Old';
        Registry = RegistryOld;
        Stations = AllNodes;
        RegistryNew.forEach(L => {
            var Ly = window[L.Id];
            if (Ly) HideLayer(Ly);
        });
        RegistryOld.forEach(L => {
            var Ly = window[L.Id];
            if (Ly) ShowLayer(Ly, L.Color, L.Weight);
        });
        document.getElementById('ToggleButton').innerText = 'View Detailed Map';
    } else {
        CurrentView = 'New';
        Registry = RegistryNew;
        Stations = StationsNew;
        RegistryOld.forEach(L => {
            var Ly = window[L.Id];
            if (Ly) HideLayer(Ly);
        });
        RegistryNew.forEach(L => {
            var Ly = window[L.Id];
            if (Ly) ShowLayer(Ly, L.Color, L.Weight);
        });
        document.getElementById('ToggleButton').innerText = 'View Full Plan';
    }
    Reset();
    BuildByMode();
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
        Html += `<div class='AutocompleteItem' onmousedown="SelectStation('${InputId}', '${SN}', '${S.Label || SN}')">
            <span class='AutocompleteStationName'>${S.Label || SN}</span>
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
                    <div class='StepAction'>Board at ${Stations[S.FromStation]?.Label || S.FromStation}</div>
                </div>`;
            }

            if (S.Transfer) {
                Html += `<div class='Step' style='--step-color:${S.Line.Color}'>
                    <div class='StepAction'>Transfer to ${S.Line.Operator} ${S.Line.Name}<span class='TransferBadge'>Transfer</span></div>
                </div>`;
            }

            if (Idx === P.Path.length - 1) {
                Html += `<div class='Step' style='--step-color:${S.Line.Color}'>
                    <div class='StepAction'>Alight at ${Stations[S.ToStation]?.Label || S.ToStation}</div>
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

function ShowStationPopup(SN, FromMarker = false) {
    var S = Stations[SN];
    if (!S) return;

    SelectedId = null;
    ClearStationMarkers();
    UpdateHeader(null);
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");

    var NearbyStations = [SN];
    Object.keys(Stations).forEach(StationKey => {
        if (StationKey !== SN) {
            var OtherStation = Stations[StationKey];
            if (OtherStation && OtherStation.Location) {
                var Distance = CalculateDistance(
                    S.Location[0], S.Location[1],
                    OtherStation.Location[0], OtherStation.Location[1]
                );
                if (Distance <= STATION_POPUP_RADIUS_KM) {
                    NearbyStations.push(StationKey);
                }
            }
        }
    });

    var Overlay = document.getElementById('StationPopupOverlay');
    var ConnectedLines = Registry.filter(L =>
        L.AllLineStations.some(StationKey => NearbyStations.includes(StationKey))
    );

    var StationLabel = S.Label || SN;
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

    document.getElementById('PopupContent').innerHTML = Html;
    Overlay.style.display = 'flex';
    CurrentStationPopup = SN;

    var HiddenRegistry = CurrentView === 'New' ? RegistryOld : RegistryNew;
    var ConnectedLineIds = ConnectedLines.map(L => L.Id);
    Registry.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) {
            if (ConnectedLineIds.includes(L.Id)) {
                Ly.setStyle({color: L.Color, weight: L.Weight, opacity: 1});
                if (Ly.setZIndex) Ly.setZIndex(10000);
            } else {
                Ly.setStyle({color: '#94a3b8', weight: L.Weight, opacity: 0.15});
                if (Ly.setZIndex) Ly.setZIndex(L.ZIndex);
            }
        }
    });
    HiddenRegistry.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) HideLayer(Ly);
    });
}

function CloseStationPopup() {
    document.getElementById('StationPopupOverlay').style.display = 'none';
    CurrentStationPopup = null;
    if (!SelectedId) Reset();
}

function GetAllPointsNearStation(SL, LG) {
    let P = [], C = [];
    if (LG.type === 'LineString') C = LG.coordinates;
    else if (LG.type === 'MultiLineString') LG.coordinates.forEach(LC => C = C.concat(LC));

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
    let C = [];
    if (LG.type === 'LineString') C = LG.coordinates;
    else if (LG.type === 'MultiLineString') LG.coordinates.forEach(LC => C = C.concat(LC));
    return {type: 'Feature', geometry: {type: 'LineString', coordinates: C.slice(Math.min(SI, EI), Math.max(SI, EI) + 1)}, properties: {}};
}

function SelectItinerary(I, E) {
    let PD = JSON.parse(E.getAttribute('data-path').replace(/&quot;/g, '"'));
    document.querySelectorAll('.TripResult').forEach(El => El.classList.remove('selected'));
    E.classList.add('selected');
    SelectedItinerary = PD;
    SelectedId = null;
    ClearStationMarkers();

    Registry.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) {
            Ly.setStyle({color: '#94a3b8', weight: L.Weight, opacity: 0.15});
            if (Ly.setZIndex) Ly.setZIndex(L.ZIndex);
        }
    });

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
        let LGJ = LL.toGeoJSON(), LGeo;

        if (LGJ.type === 'FeatureCollection') {
            let AC = [];
            LGJ.features.forEach(F => {
                if (F.geometry.type === 'LineString') AC = AC.concat(F.geometry.coordinates);
                else if (F.geometry.type === 'MultiLineString') F.geometry.coordinates.forEach(LC => AC = AC.concat(LC));
            });
            LGeo = {type: 'LineString', coordinates: AC};
        } else LGeo = LGJ.geometry;

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
        let PC = PD.Path.filter(St => St.ToStation === SN || St.FromStation === SN).map(St => St.Line)[0]?.Color || '#cbd5e1';
        let FR = S.Major ? 12 : 6;
        var M = L.circleMarker(S.Location, {radius: FR, fillColor: '#fff', color: PC, weight: STROKE_WEIGHT, opacity: 1, fillOpacity: 1}).addTo(window[MAP_NAME]);
        M.bindTooltip(BuildStationTooltip(SN, S.Label), {sticky: false, className: 'StationTooltip', direction: 'top', offset: [0, -10]});
        M.on('mouseover', () => HighlightStationMarker(SN, true)).on('mouseout', () => HighlightStationMarker(SN, false)).on('click', () => ShowStationPopup(SN));
        StationMarkers[SN] = M;
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
        H += `<details class='GroupBox'><summary class='GroupTitle'><span class='Indicator'>▶</span><span class='ModeDot' style='background:${MD.Color}'></span>${MD.Name}</summary><div style='padding:0 10px 10px 15px;'>`;

        if (LIM.length === 0) H += `<div style='padding:15px;text-align:center;color:#94a3b8;font-size:12px;'>No services</div>`;
        else {
            var OSG = {};
            LIM.forEach(L => {
                if (!OSG[L.Operator]) OSG[L.Operator] = [];
                OSG[L.Operator].push(L);
            });

            Object.keys(OSG).sort().forEach(ON => {
                H += `<details class='OpGroupBox'><summary class='OpGroupTitle'><span class='Indicator'>▶</span>${ON}</summary><div style='padding:5px 0 5px 5px;'>`;
                OSG[ON].forEach(L => H += `<div class='Item' data-lineid='${L.Id}' style='--line-color:${L.Color}' onmouseover="HoverLine('${L.Id}')" onmouseout="UnhoverLine()" onclick="SelectLine('${L.Id}')"><div class='ItemName'>${L.Name}</div></div><div id='Details_${L.Id}'></div>`);
                H += `</div></details>`;
            });
        }
        H += `</div></details>`;
    });

    document.getElementById('ListContainer').innerHTML = H;
}

function Visuals(I) {
    var HiddenRegistry = CurrentView === 'New' ? RegistryOld : RegistryNew;
    Registry.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) {
            if (L.Id === I) {
                Ly.setStyle({color: L.Color, weight: L.Weight * 3, opacity: 1});
                if (Ly.setZIndex) Ly.setZIndex(10000);
            } else {
                Ly.setStyle({color: '#94a3b8', weight: L.Weight, opacity: 0.15});
                if (Ly.setZIndex) Ly.setZIndex(L.ZIndex);
            }
        }
    });
    HiddenRegistry.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) HideLayer(Ly);
    });
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
    Ly.setStyle({opacity: 0});
    var El = Ly.getElement ? Ly.getElement() : null;
    if (!El && Ly._path) El = Ly._path;
    if (!El && Ly._container) El = Ly._container;
    if (El) El.style.pointerEvents = 'none';
    // GeoJSON layers: iterate each feature layer
    if (Ly.eachLayer) Ly.eachLayer(function(FL) {
        var FEl = FL._path || (FL.getElement && FL.getElement()) || null;
        if (FEl) FEl.style.pointerEvents = 'none';
    });
}

function ShowLayer(Ly, Color, Weight) {
    Ly.setStyle({color: Color, weight: Weight, opacity: 1.0});
    var El = Ly.getElement ? Ly.getElement() : null;
    if (!El && Ly._path) El = Ly._path;
    if (!El && Ly._container) El = Ly._container;
    if (El) El.style.pointerEvents = '';
    if (Ly.eachLayer) Ly.eachLayer(function(FL) {
        var FEl = FL._path || (FL.getElement && FL.getElement()) || null;
        if (FEl) FEl.style.pointerEvents = '';
    });
}

function HoverLine(I) {
    if (SelectedId || CurrentStationPopup) return;
    var HiddenRegistry = CurrentView === 'New' ? RegistryOld : RegistryNew;
    var IsHidden = HiddenRegistry.find(X => X.Id === I);
    if (IsHidden) return;
    if (Registry.find(X => X.Id === I)) {
        Visuals(I);
        UpdateHeader(I);
    }
}

function UnhoverLine() {
    if (!SelectedId && !CurrentStationPopup) Reset();
}

function FilterList() {
    var Q = document.getElementById('SearchInput').value.toLowerCase();
    document.querySelectorAll('.GroupBox').forEach(G => {
        var GM = false;
        G.querySelectorAll('.OpGroupBox').forEach(OG => {
            var OM = false;
            OG.querySelectorAll('.Item').forEach(El => {
                var M = El.innerText.toLowerCase().includes(Q);
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
    let S = Stations[SN], R = S.Major ? CurrentBaseSize * 2 : CurrentBaseSize;
    if (A) {
        M.setRadius(R * 1.5);
        M.setStyle({weight: HOVER_STROKE_WEIGHT, fillOpacity: 1});
        M.openTooltip();
        M.bringToFront();
    } else {
        M.setRadius(R);
        M.setStyle({weight: STROKE_WEIGHT, fillOpacity: 1});
        M.closeTooltip();
    }
}

function BuildStationTooltip(SN, SL) {
    var S = Stations[SN];

    // Collect nearby stations using the same radius as the click popup
    var NearbyStations = [SN];
    if (S && S.Location) {
        Object.keys(Stations).forEach(StationKey => {
            if (StationKey !== SN) {
                var OtherStation = Stations[StationKey];
                if (OtherStation && OtherStation.Location) {
                    var Distance = CalculateDistance(
                        S.Location[0], S.Location[1],
                        OtherStation.Location[0], OtherStation.Location[1]
                    );
                    if (Distance <= STATION_POPUP_RADIUS_KM) {
                        NearbyStations.push(StationKey);
                    }
                }
            }
        });
    }

    // Filter lines serving any nearby station
    var LH = Registry.filter(L =>
        L.AllLineStations.some(StationKey => NearbyStations.includes(StationKey))
    );

    // Group by mode, preserving Modes order
    var MM = {};
    LH.forEach(L => {
        if (!MM[L.ModeId]) MM[L.ModeId] = [];
        MM[L.ModeId].push(L);
    });

    var PM = S && S.Type === "Airport" ? ` <span class="PlaneIcon">✈</span>` : '';
    var H = `<div class='StationPopup'><b>${SL || SN}${PM}</b>`;

    Object.keys(Modes).forEach(ModeId => {
        if (!MM[ModeId]) return;
        var ModeData = Modes[ModeId];
        H += `<div class='ModeHeader'>${ModeData.Name}</div>`;
        MM[ModeId].forEach(L => H += `<div class='HubLineContent'><span class='HubDot' style='background:${L.Color}'></span><span><span class='OpTag'>${L.Operator}</span><span class='Separator'>•</span>${L.Name}</span></div>`);
    });

    return H + `</div>`;
}

function RenderStationMarkers(I) {
    ClearStationMarkers();
    var LD = Registry.find(X => X.Id === I);
    if (!LD) return;
    CurrentBaseSize = 5;

    LD.AllLineStations.forEach(SN => {
        var S = Stations[SN];
        if (!S) return;
        let FR = S.Major ? CurrentBaseSize * 2 : CurrentBaseSize;
        var M = L.circleMarker(S.Location, {radius: FR, fillColor: '#fff', color: LD.Color, weight: STROKE_WEIGHT, opacity: 1, fillOpacity: 1}).addTo(window[MAP_NAME]);
        M.bindTooltip(BuildStationTooltip(SN, S.Label), {sticky: false, className: 'StationTooltip', direction: 'top', offset: [0, -10]});
        M.on('mouseover', () => HighlightStationMarker(SN, true)).on('mouseout', () => HighlightStationMarker(SN, false)).on('click', (e) => {
            L.DomEvent.stopPropagation(e);
            ShowStationPopup(SN, true);
        });
        StationMarkers[SN] = M;
    });
}

function ClearStationMarkers() {
    Object.values(StationMarkers).forEach(M => window[MAP_NAME].removeLayer(M));
    StationMarkers = {};
}

function SelectLine(I) {
    if (!Registry.find(X => X.Id === I)) return;
    if (SelectedId === I) {
        SelectedId = null;
        Reset();
        return;
    }
    SelectedId = I;
    Visuals(I);
    UpdateHeader(I);
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");
    RenderDetails(I);
    RenderStationMarkers(I);
    var Ly = window[I];
    if (Ly) window[MAP_NAME].fitBounds(Ly.getBounds(), {paddingTopLeft: [400, 100], paddingBottomRight: [100, 100], animate: true, duration: 1.2});
}

function SelectLineFromMap(I) {
    if (!Registry.find(X => X.Id === I)) return;
    var El = document.querySelector(`[data-lineid='${I}']`);
    if (El) {
        El.closest('.OpGroupBox').open = true;
        El.closest('.GroupBox').open = true;
        El.scrollIntoView({behavior: 'smooth', block: 'center'});
    }
    SelectLine(I);
}

function FocusStation(SN) {
    var S = Stations[SN];
    if (S) {
        HighlightStationMarker(SN, true);
        window[MAP_NAME].setView(S.Location, 15, {animate: true});
    }
}

function Reset() {
    SelectedId = null;
    SelectedItinerary = null;
    UpdateHeader(null);
    ClearStationMarkers();
    if (window.ItineraryLayers) window.ItineraryLayers.forEach(L => window[MAP_NAME].removeLayer(L));
    window.ItineraryLayers = [];
    document.querySelectorAll('[id^="Details_"]').forEach(D => D.innerHTML = "");
    document.querySelectorAll('.TripResult').forEach(El => El.classList.remove('selected'));

    Registry.forEach(L => {
        if (window[L.Id]) {
            window[L.Id].setStyle({color: L.Color, weight: L.Weight, opacity: 1.0});
            if (window[L.Id].setZIndex) window[L.Id].setZIndex(L.ZIndex);
        }
    });

    var HiddenRegistry = CurrentView === 'New' ? RegistryOld : RegistryNew;
    HiddenRegistry.forEach(L => {
        if (window[L.Id]) HideLayer(window[L.Id]);
    });
}

function SwitchBasemap(Name) {
    document.querySelectorAll('.BasemapButton').forEach(B => B.classList.remove('active'));
    if (Name === 'Light') {
        document.getElementById('LightButton').classList.add('active');
        BasemapLayers['Light'].addTo(window[MAP_NAME]);
        if (BasemapLayers['Dark']) window[MAP_NAME].removeLayer(BasemapLayers['Dark']);
        if (BasemapLayers['Satellite']) window[MAP_NAME].removeLayer(BasemapLayers['Satellite']);
    } else if (Name === 'Dark') {
        document.getElementById('DarkButton').classList.add('active');
        BasemapLayers['Dark'].addTo(window[MAP_NAME]);
        if (BasemapLayers['Light']) window[MAP_NAME].removeLayer(BasemapLayers['Light']);
        if (BasemapLayers['Satellite']) window[MAP_NAME].removeLayer(BasemapLayers['Satellite']);
    } else if (Name === 'Satellite') {
        document.getElementById('SatelliteButton').classList.add('active');
        BasemapLayers['Satellite'].addTo(window[MAP_NAME]);
        if (BasemapLayers['Light']) window[MAP_NAME].removeLayer(BasemapLayers['Light']);
        if (BasemapLayers['Dark']) window[MAP_NAME].removeLayer(BasemapLayers['Dark']);
    }
}

function initializeMap(mapName, registryNew, registryOld, stationsNew, allNodes, modes, basemapLayerNames, lineMappingJsNew, lineMappingJsOld, infoPoints) {
    MAP_NAME = mapName;
    RegistryNew = registryNew;
    RegistryOld = registryOld;
    Registry = RegistryOld;
    StationsNew = stationsNew;
    AllNodes = allNodes;
    Stations = AllNodes;
    Modes = modes;
    ModesOrder = Modes;
    InfoPoints = infoPoints || {};

    // Mark map as initialized
    MarkMapInitialized();

    eval(lineMappingJsNew);
    eval(lineMappingJsOld);

    // Immediately set line opacities after eval
    RegistryNew.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) HideLayer(Ly);
    });

    RegistryOld.forEach(L => {
        var Ly = window[L.Id];
        if (Ly) ShowLayer(Ly, L.Color, L.Weight);
    });

    // Also set after a short delay to catch any delayed line rendering
    setTimeout(function() {
        RegistryOld.forEach(L => {
            var Ly = window[L.Id];
            if (Ly) ShowLayer(Ly, L.Color, L.Weight);
        });
        RegistryNew.forEach(L => {
            var Ly = window[L.Id];
            if (Ly) HideLayer(Ly);
        });
    }, 100);

    BasemapLayers['Light'] = basemapLayerNames.Light;
    BasemapLayers['Dark'] = basemapLayerNames.Dark;
    BasemapLayers['Satellite'] = basemapLayerNames.Satellite;

    if (BasemapLayers['Dark']) window[MAP_NAME].removeLayer(BasemapLayers['Dark']);
    if (BasemapLayers['Satellite']) window[MAP_NAME].removeLayer(BasemapLayers['Satellite']);

    RenderInfoMarkers();
    BuildByMode();
    window[MAP_NAME].on('click', HandleMapClick);

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            if (CurrentStationPopup) {
                CloseStationPopup();
            } else if (SelectedId) {
                Reset();
            } else if (document.getElementById('InfoPopupOverlay').style.display === 'flex') {
                CloseInfoPopup();
            }
        }
    });

    // Collapse sidebar on mobile by default
    if (window.innerWidth <= 768) {
        var sidebar = document.getElementById('Sidebar');
        var handle = document.getElementById('Handle');
        if (sidebar && !sidebar.classList.contains('collapsed')) {
            sidebar.classList.add('collapsed');
            if (handle) handle.innerHTML = '▶';
        }
    }

    // Mark data as loaded (lines, stations, etc.)
    MarkDataLoaded();

    // Listen for tile loading completion
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

    // Fallback: mark tiles as loaded after 3 seconds regardless
    setTimeout(function() {
        if (!MapLoadingState.tilesLoaded) {
            MarkTilesLoaded();
        }
    }, 3000);

    // Also listen to Leaflet's load event
    window[MAP_NAME].on('load', function() {
        setTimeout(function() {
            if (!MapLoadingState.tilesLoaded) {
                MarkTilesLoaded();
            }
        }, 500);
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
    var Markers = InfoMarkers[InfoKey];

    if (Markers) {
        Markers.main.setStyle({
            fillColor: '#1d4ed8'
        });
        Markers.outer.setStyle({
            fillOpacity: 0.35
        });
        Markers.inner.setStyle({
            fillColor: '#bfdbfe'
        });
    }

    document.getElementById('InfoPopupTitle').innerText = InfoKey;
    document.getElementById('InfoPopupSource').innerText = Info.Source;

    var Content = '';
    if (Info.Image) {
        var imageSrc = Info.Image;
        if (!imageSrc.startsWith('data:')) {
            var encodedImage = encodeURIComponent(Info.Image).replace(/%2F/g, '/');
            imageSrc = `Input/Images/${encodedImage}`;
        }
        Content += `<img src="${imageSrc}" class="InfoPopupImage" onclick="window.open('${Info.Link}', '_blank')" alt="${InfoKey}" title="Click to visit link">`;
    }
    Content += `<div class="InfoPopupDescription">${Info.Description}</div>`;

    document.getElementById('InfoPopupContent').innerHTML = Content;
    document.getElementById('InfoPopupOverlay').style.display = 'flex';
    document.getElementById('InfoPopupBackdrop').style.display = 'block';
}

function CloseInfoPopup() {
    if (SelectedInfoPoint) {
        var Markers = InfoMarkers[SelectedInfoPoint];

        if (Markers) {
            Markers.main.setStyle({
                fillColor: '#3b82f6'
            });
            Markers.outer.setStyle({
                fillOpacity: 0.15
            });
            Markers.inner.setStyle({
                fillColor: '#60a5fa'
            });
        }
        SelectedInfoPoint = null;
    }

    document.getElementById('InfoPopupOverlay').style.display = 'none';
    document.getElementById('InfoPopupBackdrop').style.display = 'none';
}

function RenderInfoMarkers() {
    ClearInfoMarkers();

    Object.keys(InfoPoints).forEach(Key => {
        var Info = InfoPoints[Key];
        var RadiusMeters = (Info.Radius || 0.2) * 1000;

        // Create outer glow circle
        var OuterCircle = L.circle(Info.Location, {
            radius: RadiusMeters * 1.3,
            fillColor: '#3b82f6',
            color: '#3b82f6',
            weight: 0,
            opacity: 0,
            fillOpacity: 0.15,
            className: 'InfoMarkerGlow',
            interactive: false
        }).addTo(window[MAP_NAME]);

        // Create main circle
        var Circle = L.circle(Info.Location, {
            radius: RadiusMeters,
            fillColor: '#3b82f6',
            color: '#3b82f6',
            weight: 0,
            opacity: 0,
            fillOpacity: 1.0,
            className: 'InfoMarkerCircle'
        }).addTo(window[MAP_NAME]);

        // Create inner bright center
        var InnerCircle = L.circle(Info.Location, {
            radius: RadiusMeters * 0.4,
            fillColor: '#60a5fa',
            color: '#60a5fa',
            weight: 0,
            opacity: 0,
            fillOpacity: 1.0,
            className: 'InfoMarkerInner',
            interactive: false
        }).addTo(window[MAP_NAME]);

        Circle.on('click', () => ShowInfoPopup(Key));
        Circle.on('mouseover', function() {
            if (SelectedInfoPoint !== Key) {
                this.setStyle({
                    fillColor: '#2563eb'
                });
                OuterCircle.setStyle({
                    fillOpacity: 0.25
                });
                InnerCircle.setStyle({
                    fillColor: '#93c5fd'
                });
            }
        });
        Circle.on('mouseout', function() {
            if (SelectedInfoPoint !== Key) {
                this.setStyle({
                    fillColor: '#3b82f6'
                });
                OuterCircle.setStyle({
                    fillOpacity: 0.15
                });
                InnerCircle.setStyle({
                    fillColor: '#60a5fa'
                });
            }
        });

        InfoMarkers[Key] = {
            main: Circle,
            outer: OuterCircle,
            inner: InnerCircle
        };
    });
}

function ClearInfoMarkers() {
    Object.values(InfoMarkers).forEach(M => {
        if (M.main) {
            window[MAP_NAME].removeLayer(M.main);
            window[MAP_NAME].removeLayer(M.outer);
            window[MAP_NAME].removeLayer(M.inner);
        }
    });
    InfoMarkers = {};
}