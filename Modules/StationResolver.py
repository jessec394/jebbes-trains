def ResolvePath(Item, Segments, FilterNonStops=False):
    IsReverse = Item.startswith("[R] ")
    LookupKey = Item[4:] if IsReverse else Item

    if LookupKey in Segments:
        SegmentData = Segments[LookupKey]
        Path = []

        CombinedParts = SegmentData.get("F", []) + SegmentData.get("L", []) + SegmentData.get("R", [])

        for SubItem in CombinedParts:
            SubPath = ResolvePath(SubItem, Segments, FilterNonStops)
            for Station in SubPath:
                if not Path or Path[-1] != Station:
                    Path.append(Station)

        if IsReverse: Path.reverse()

        if FilterNonStops:
            Path = [S[4:] if S.startswith("[X] ") else S for S in Path]
            Path = [S for S in Path if not S.startswith("[X] ")]

        return Path

    if FilterNonStops and LookupKey.startswith("[X] "):
        return []

    return [LookupKey[4:] if FilterNonStops and LookupKey.startswith("[X] ") else LookupKey]

def _GetSegmentFinalSequence(SegmentKey, Segments, _Visited=None):
    if _Visited is None:  _Visited = set()

    if SegmentKey in _Visited or SegmentKey not in Segments:
        return []

    _Visited.add(SegmentKey)
    SegmentData = Segments[SegmentKey]

    GlobalSkips = set()

    def ExpandComponent(Item):
        IsReverse = Item.startswith("[R] ")
        BaseKey = Item[4:] if IsReverse else Item

        if BaseKey.startswith("[X] "): GlobalSkips.add(BaseKey[4:])

        CleanKey = BaseKey[4:] if BaseKey.startswith("[X] ") else BaseKey

        if CleanKey in Segments:
            SubPath = _GetSegmentFinalSequence(CleanKey, Segments, _Visited.copy())
            if IsReverse: SubPath = list(reversed(SubPath))
            return SubPath

        return [CleanKey]

    def GetRawPathFromComponent(Key):
        ComponentItems = SegmentData.get(Key, [])
        Path = []
        for Item in ComponentItems:
            SubPath = ExpandComponent(Item)
            for Station in SubPath:
                if not Path or Path[-1] != Station:
                    Path.append(Station)
        return Path

    FPath = GetRawPathFromComponent("F")
    LPath = GetRawPathFromComponent("L")
    RPath = GetRawPathFromComponent("R")

    BaseSequence = []

    if FPath and LPath and RPath: BaseSequence = FPath + LPath + RPath
    elif FPath and RPath:         BaseSequence = FPath + RPath
    elif FPath and LPath:         BaseSequence = FPath + LPath + list(reversed(FPath))
    elif FPath:                   BaseSequence = FPath
    elif LPath:
        BaseSequence = LPath
        if BaseSequence and BaseSequence[0] != BaseSequence[-1]:
            BaseSequence.append(BaseSequence[0])

    if "Keep" in SegmentData:
        CleanedSequence = _ApplyStopsFilter(SegmentData["Keep"], Segments, BaseSequence)
    else:
        CleanedSequence = []
        for S in BaseSequence:
            if not CleanedSequence or CleanedSequence[-1] != S:
                CleanedSequence.append(S)

    if "Skip" in SegmentData:
        for Skip in SegmentData["Skip"]:
            GlobalSkips.add(Skip[4:] if Skip.startswith("[X] ") or Skip.startswith("[R] ") else Skip)

    CleanedSequence = [S for S in CleanedSequence if S not in GlobalSkips]

    return CleanedSequence

def _ApplyStopsFilter(StopsArray, Segments, BaseSequence):
    AllowedStations = []
    for Item in StopsArray:
        IsReverse = Item.startswith("[R] ")
        BaseKey = Item[4:] if IsReverse else Item
        CleanKey = BaseKey[4:] if BaseKey.startswith("[X] ") else BaseKey

        if CleanKey in Segments:
            SubSequence = _GetSegmentFinalSequence(CleanKey, Segments)
            AllowedStations.extend(reversed(SubSequence) if IsReverse else SubSequence)
        else:
            AllowedStations.append(CleanKey)

    AllowedSet = set(AllowedStations)
    Filtered = [S for S in BaseSequence if S in AllowedSet]

    Final = []
    for S in Filtered:
        if not Final or Final[-1] != S: Final.append(S)

    return Final

def BuildStationSequence(PatternData, Segments, FilterNonStops=False):
    SegmentKey = PatternData.get("Stations")
    if not SegmentKey or SegmentKey not in Segments:
        return []

    return _GetSegmentFinalSequence(SegmentKey, Segments)

def BuildCoordinateSequence(PatternData, Segments, Nodes, Stations=None):
    if Stations is None: Stations = {}

    SegmentKey = PatternData.get("Stations")
    if not SegmentKey or SegmentKey not in Segments:
        return []

    def ResolveCoordinates(Item, Depth=0):
        IsReverse = Item.startswith("[R] ")
        LookupKey = Item[4:] if IsReverse else Item

        if LookupKey.startswith("[X] "):
            LookupKey = LookupKey[4:]

        if LookupKey in Segments:
            SegmentData = Segments[LookupKey]
            Coords = []

            CombinedParts = SegmentData.get("F", []) + SegmentData.get("L", []) + SegmentData.get("R", [])

            for SubItem in CombinedParts:
                SubCoords = ResolveCoordinates(SubItem, Depth + 1)
                for Coord in SubCoords:
                    if not Coords or Coords[-1] != Coord: Coords.append(Coord)

            if IsReverse: Coords.reverse()

            return Coords

        if LookupKey in Stations:
            Loc = Stations[LookupKey]['Location']
            return [Loc]

        if LookupKey in Nodes:
            Loc = Nodes[LookupKey]['Location']
            return [Loc]

        return []

    SegmentData = Segments[SegmentKey]

    def GetCoordsFromComponent(Key):
        ComponentItems = SegmentData.get(Key, [])
        Coords = []
        for Item in ComponentItems:
            SubCoords = ResolveCoordinates(Item)
            for Coord in SubCoords:
                if not Coords or Coords[-1] != Coord:
                    Coords.append(Coord)

        return Coords

    FCoords = GetCoordsFromComponent("F") if "F" in SegmentData else []
    LCoords = GetCoordsFromComponent("L") if "L" in SegmentData else []
    RCoords = GetCoordsFromComponent("R") if "R" in SegmentData else []

    FinalCoords = []

    if FCoords and LCoords and RCoords: FinalCoords = FCoords + LCoords + RCoords
    elif FCoords and RCoords:           FinalCoords = FCoords + RCoords
    elif FCoords and LCoords:           FinalCoords = FCoords + LCoords + list(reversed(FCoords))
    elif FCoords:                       FinalCoords = FCoords + list(reversed(FCoords))
    elif LCoords:
        FinalCoords = LCoords
        if FinalCoords and FinalCoords[0] != FinalCoords[-1]:
            FinalCoords.append(FinalCoords[0])

    CleanedCoords = []
    for C in FinalCoords:
        if not CleanedCoords or CleanedCoords[-1] != C:
            CleanedCoords.append(C)

    return CleanedCoords