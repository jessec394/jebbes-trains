def AnalyzeRouteStructure(Stations):
    if not Stations or len(Stations) < 2:
        return {"Type": "Linear", "Segments": [Stations]}

    First, Last = Stations[0], Stations[-1]

    if First != Last:
        return {"Type": "Linear", "Segments": [Stations]}

    LoopCheck = DetectLoopOrLollipop(Stations)
    if LoopCheck:
        return LoopCheck

    Mid = len(Stations) // 2
    ForwardPath = Stations[:Mid+1]
    ReturnPath = list(reversed(Stations[Mid:]))

    Sections = []
    i = 0
    j = 0

    while i < len(ForwardPath) and j < len(ReturnPath):
        if ForwardPath[i] == ReturnPath[j]:
            SharedStations = []
            while i < len(ForwardPath) and j < len(ReturnPath) and ForwardPath[i] == ReturnPath[j]:
                SharedStations.append(ForwardPath[i])
                i += 1
                j += 1
            if SharedStations:
                Sections.append(("Shared", SharedStations))
        else:
            FwdSegment = []
            RetSegment = []

            FwdStart = i
            RetStart = j

            NextSharedFwd = -1
            NextSharedRet = -1

            for fi in range(i, len(ForwardPath)):
                for ri in range(j, len(ReturnPath)):
                    if ForwardPath[fi] == ReturnPath[ri]:
                        NextSharedFwd = fi
                        NextSharedRet = ri
                        break
                if NextSharedFwd != -1:
                    break

            if NextSharedFwd != -1:
                FwdSegment = ForwardPath[i:NextSharedFwd]
                RetSegment = ReturnPath[j:NextSharedRet]
                i = NextSharedFwd
                j = NextSharedRet
            else:
                FwdSegment = ForwardPath[i:]
                RetSegment = ReturnPath[j:]
                i = len(ForwardPath)
                j = len(ReturnPath)

            if FwdSegment or RetSegment:
                Sections.append(("Split", FwdSegment, RetSegment))

    IsFullyShared = all(s[0] == "Shared" for s in Sections)
    HasSplits = any(s[0] == "Split" for s in Sections)

    if IsFullyShared:
        return {"Type": "OutAndBack", "Segments": [ForwardPath]}
    elif HasSplits:
        return {"Type": "Complex", "Sections": Sections}
    else:
        return {"Type": "Linear", "Segments": [Stations]}

def DetectLoopOrLollipop(Stations):
    SeenAt = {}
    FirstRepeatIdx = -1
    FirstRepeatStation = None

    for Idx, S in enumerate(Stations):
        if S in SeenAt and FirstRepeatIdx == -1:
            FirstRepeatIdx = SeenAt[S]
            FirstRepeatStation = S
            break
        SeenAt[S] = Idx

    if FirstRepeatIdx == -1:
        Unique = []
        for S in Stations:
            if S not in Unique:
                Unique.append(S)

        if len(Unique) == len(Stations) - 1 and Stations[0] == Stations[-1]:
            return {"Type": "Loop", "Segments": [Stations]}
        return None

    if FirstRepeatIdx == 0 and FirstRepeatStation == Stations[0]:
        SecondOccurrence = -1
        for Idx in range(1, len(Stations)):
            if Stations[Idx] == FirstRepeatStation:
                SecondOccurrence = Idx
                break

        if SecondOccurrence == len(Stations) - 1:
            Unique = []
            for S in Stations[:-1]:
                if S not in Unique:
                    Unique.append(S)

            if len(Unique) == len(Stations) - 1:
                return {"Type": "Loop", "Segments": [Stations]}

    Mid = len(Stations) // 2
    IsSymmetric = all(Stations[i] == Stations[-(i+1)] for i in range(len(Stations) // 2 + 1))
    if IsSymmetric:
        return None

    if FirstRepeatIdx > 0:
        LastOccurrence = -1
        for Idx in range(len(Stations) - 1, FirstRepeatIdx, -1):
            if Stations[Idx] == FirstRepeatStation:
                LastOccurrence = Idx
                break

        if LastOccurrence > FirstRepeatIdx:
            Stem = Stations[:FirstRepeatIdx + 1]
            Loop = Stations[FirstRepeatIdx:LastOccurrence + 1]
            Tail = Stations[LastOccurrence:]

            if len(Stem) > 1 and len(Tail) > 1:
                IsStemReversed = all(
                    Stem[i] == Tail[-(i+1)]
                    for i in range(min(len(Stem), len(Tail)))
                )

                if IsStemReversed and len(Stem) == len(Tail):
                    LoopUnique = []
                    for S in Loop:
                        if S not in LoopUnique:
                            LoopUnique.append(S)

                    if len(LoopUnique) > 2:
                        return {"Type": "Lollipop", "Segments": [Stem, Loop, Tail]}

    return None

def GetStationLabel(StationKey, StationData):
    if StationKey in StationData:
        Station = StationData[StationKey]
        Label = Station.get("Label", StationKey)
        if Station.get("Type") == "Airport":
            Label += ' <tspan style="display:inline-block;transform:rotate(45deg);transform-origin:center;">✈</tspan>'
        return Label
    return StationKey

def GetStationStyle(StationKey, StationData):
    if StationKey in StationData:
        Station = StationData[StationKey]
        IsMajor = Station.get("Major", False)
        return {
            "FontSize": 13 if IsMajor else 12,
            "FontWeight": 900 if IsMajor else 600,
            "DotRadius": 7 if IsMajor else 5
        }
    return {"FontSize": 12, "FontWeight": 600, "DotRadius": 5}

def GenerateRouteDiagram(Structure, LineColor, StationKeys, StationData):
    Type = Structure["Type"]

    if Type == "Linear":
        return GenerateLinearDiagram(Structure["Segments"][0], LineColor, StationKeys, StationData)
    elif Type == "OutAndBack":
        return GenerateOutAndBackDiagram(Structure["Segments"], LineColor, StationKeys, StationData)
    elif Type == "Loop":
        return GenerateLoopDiagram(Structure["Segments"][0], LineColor, StationKeys, StationData)
    elif Type == "Lollipop":
        return GenerateLollipopDiagram(Structure["Segments"], LineColor, StationKeys, StationData)
    elif Type == "Complex":
        return GenerateComplexDiagram(Structure["Sections"], LineColor, StationKeys, StationData)

    return ""

def GenerateComplexDiagram(Sections, Color, StationKeys, StationData):
    if not Sections:
        return ""

    TotalHeight = 40
    for Sec in Sections:
        if Sec[0] == "Shared":
            TotalHeight += len(Sec[1]) * 30
        elif Sec[0] == "Split":
            FwdLen = len(Sec[1]) if Sec[1] else 0
            RetLen = len(Sec[2]) if Sec[2] else 0
            TotalHeight += max(FwdLen, RetLen) * 28 + 40

    SVG = f'<svg width="340" height="{TotalHeight}" style="margin:8px 0;overflow:visible;">'

    CurrentY = 20

    for Sec in Sections:
        if Sec[0] == "Shared":
            SharedStations = Sec[1]
            for i, StationKey in enumerate(SharedStations):
                Y = CurrentY + i * 30
                Label = GetStationLabel(StationKey, StationData)
                Style = GetStationStyle(StationKey, StationData)
                SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="30" cy="{Y}" r="{Style["DotRadius"]}" fill="{Color}"/>'
                SVG += f'<text class="station-label" data-station="{StationKey}" x="45" y="{Y + 5}" font-size="{Style["FontSize"]}" fill="#1e293b" font-weight="{Style["FontWeight"]}">{Label}</text>'
                if i < len(SharedStations) - 1:
                    SVG += f'<line x1="30" y1="{Y + 5}" x2="30" y2="{Y + 25}" stroke="{Color}" stroke-width="3"/>'
            CurrentY += len(SharedStations) * 30

        elif Sec[0] == "Split":
            ForwardStations = Sec[1] if len(Sec) > 1 else []
            ReturnStations = Sec[2] if len(Sec) > 2 else []

            DivergenceY = CurrentY
            SVG += f'<line x1="30" y1="{DivergenceY - 5}" x2="30" y2="{DivergenceY + 10}" stroke="{Color}" stroke-width="3"/>'
            SVG += f'<line x1="30" y1="{DivergenceY + 10}" x2="50" y2="{DivergenceY + 15}" stroke="{Color}" stroke-width="2.5"/>'
            SVG += f'<line x1="30" y1="{DivergenceY + 10}" x2="190" y2="{DivergenceY + 15}" stroke="{Color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>'

            SplitStartY = DivergenceY + 20
            MaxLen = max(len(ForwardStations), len(ReturnStations))

            for i, StationKey in enumerate(ForwardStations):
                Y = SplitStartY + i * 28
                Label = GetStationLabel(StationKey, StationData)
                Style = GetStationStyle(StationKey, StationData)
                SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="50" cy="{Y}" r="{Style["DotRadius"] - 1}" fill="{Color}"/>'
                SVG += f'<text class="station-label" data-station="{StationKey}" x="60" y="{Y + 4}" font-size="{Style["FontSize"] - 1}" fill="#1e293b" font-weight="{Style["FontWeight"]}">{Label}</text>'
                if i < len(ForwardStations) - 1:
                    SVG += f'<line x1="50" y1="{Y + 4}" x2="50" y2="{Y + 24}" stroke="{Color}" stroke-width="2.5"/>'

            for i, StationKey in enumerate(ReturnStations):
                Y = SplitStartY + i * 28
                Label = GetStationLabel(StationKey, StationData)
                Style = GetStationStyle(StationKey, StationData)
                SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="190" cy="{Y}" r="{Style["DotRadius"] - 1}" fill="{Color}" opacity="0.5"/>'
                SVG += f'<text class="station-label" data-station="{StationKey}" x="200" y="{Y + 4}" font-size="{Style["FontSize"] - 1}" fill="#64748b" font-weight="{Style["FontWeight"] - 100}">{Label}</text>'
                if i < len(ReturnStations) - 1:
                    SVG += f'<line x1="190" y1="{Y + 4}" x2="190" y2="{Y + 24}" stroke="{Color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>'

            ConvergenceY = SplitStartY + MaxLen * 28
            FwdEndY = SplitStartY + (len(ForwardStations) - 1) * 28 if ForwardStations else SplitStartY - 5
            RetEndY = SplitStartY + (len(ReturnStations) - 1) * 28 if ReturnStations else SplitStartY - 5

            if ForwardStations:
                SVG += f'<line x1="50" y1="{FwdEndY + 4}" x2="50" y2="{ConvergenceY + 5}" stroke="{Color}" stroke-width="2.5"/>'
            if ReturnStations:
                SVG += f'<line x1="190" y1="{RetEndY + 4}" x2="190" y2="{ConvergenceY + 5}" stroke="{Color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>'

            SVG += f'<line x1="50" y1="{ConvergenceY + 5}" x2="30" y2="{ConvergenceY + 10}" stroke="{Color}" stroke-width="2.5"/>'
            SVG += f'<line x1="190" y1="{ConvergenceY + 5}" x2="30" y2="{ConvergenceY + 10}" stroke="{Color}" stroke-width="2.5" stroke-dasharray="3,3" opacity="0.5"/>'
            SVG += f'<line x1="30" y1="{ConvergenceY + 10}" x2="30" y2="{ConvergenceY + 15}" stroke="{Color}" stroke-width="3"/>'

            CurrentY = ConvergenceY + 20

    SVG += '</svg>'
    return SVG

def GenerateLinearDiagram(Stations, Color, StationKeys, StationData):
    if not Stations:
        return ""

    Height = max(100, len(Stations) * 35 + 20)
    SVG = f'<svg width="100%" height="{Height}" style="margin:8px 0">'

    for i, StationKey in enumerate(Stations):
        Y = 20 + i * 35
        Label = GetStationLabel(StationKey, StationData)
        Style = GetStationStyle(StationKey, StationData)
        SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="30" cy="{Y}" r="{Style["DotRadius"]}" fill="{Color}"/>'
        SVG += f'<text class="station-label" data-station="{StationKey}" x="45" y="{Y + 5}" font-size="{Style["FontSize"]}" fill="#1e293b" font-weight="{Style["FontWeight"]}">{Label}</text>'
        if i < len(Stations) - 1:
            SVG += f'<line x1="30" y1="{Y + 5}" x2="30" y2="{Y + 30}" stroke="{Color}" stroke-width="3"/>'

    SVG += '</svg>'
    return SVG

def GenerateOutAndBackDiagram(Segments, Color, StationKeys, StationData):
    if not Segments or not Segments[0]:
        return ""

    ForwardStations = Segments[0]
    Height = max(100, len(ForwardStations) * 35 + 20)
    SVG = f'<svg width="100%" height="{Height}" style="margin:8px 0">'

    for i, StationKey in enumerate(ForwardStations):
        Y = 20 + i * 35
        Label = GetStationLabel(StationKey, StationData)
        Style = GetStationStyle(StationKey, StationData)
        SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="30" cy="{Y}" r="{Style["DotRadius"]}" fill="{Color}"/>'
        SVG += f'<text class="station-label" data-station="{StationKey}" x="45" y="{Y + 5}" font-size="{Style["FontSize"]}" fill="#1e293b" font-weight="{Style["FontWeight"]}">{Label}</text>'
        if i < len(ForwardStations) - 1:
            SVG += f'<line x1="30" y1="{Y + 5}" x2="30" y2="{Y + 30}" stroke="{Color}" stroke-width="3"/>'

    SVG += '</svg>'
    return SVG

def GenerateLoopDiagram(Stations, Color, StationKeys, StationData):
    if not Stations:
        return ""

    UniqueStations = []
    for S in Stations[:-1] if Stations[0] == Stations[-1] else Stations:
        if S not in UniqueStations:
            UniqueStations.append(S)

    Height = max(100, len(UniqueStations) * 25 + 60)
    SVG = f'<svg width="100%" height="{Height}" style="margin:8px 0">'

    LoopWidth = 70
    LoopLeft = 30
    LoopRight = LoopLeft + LoopWidth
    LoopTop = 20
    LoopBottom = LoopTop + (len(UniqueStations) - 1) * 25

    SVG += f'<line x1="{LoopLeft}" y1="{LoopTop}" x2="{LoopRight}" y2="{LoopTop}" stroke="{Color}" stroke-width="3"/>'
    SVG += f'<line x1="{LoopRight}" y1="{LoopTop}" x2="{LoopRight}" y2="{LoopBottom}" stroke="{Color}" stroke-width="3"/>'
    SVG += f'<line x1="{LoopRight}" y1="{LoopBottom}" x2="{LoopLeft}" y2="{LoopBottom}" stroke="{Color}" stroke-width="3"/>'
    SVG += f'<line x1="{LoopLeft}" y1="{LoopBottom}" x2="{LoopLeft}" y2="{LoopTop}" stroke="{Color}" stroke-width="3" stroke-dasharray="4,4" opacity="0.6"/>'

    for i, StationKey in enumerate(UniqueStations):
        Y = LoopTop + i * 25
        X = LoopRight + 15
        Label = GetStationLabel(StationKey, StationData)
        Style = GetStationStyle(StationKey, StationData)
        SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="{X}" cy="{Y}" r="{Style["DotRadius"] - 1}" fill="{Color}"/>'
        SVG += f'<text class="station-label" data-station="{StationKey}" x="{X + 12}" y="{Y + 4}" font-size="{Style["FontSize"] - 1}" fill="#1e293b" font-weight="{Style["FontWeight"]}">{Label}</text>'

    SVG += '</svg>'
    return SVG

def GenerateLollipopDiagram(Segments, Color, StationKeys, StationData):
    if len(Segments) < 2:
        return GenerateLinearDiagram(Segments[0] if Segments else [], Color, StationKeys, StationData)

    Stem = Segments[0]
    Loop = Segments[1]

    LoopUnique = []
    LoopStart = Loop[0] if Loop else None

    for S in Loop[1:]:
        if S not in LoopUnique and S != LoopStart:
            LoopUnique.append(S)

    Height = max(150, len(Stem) * 35 + len(LoopUnique) * 25 + 40)
    SVG = f'<svg width="100%" height="{Height}" style="margin:8px 0">'

    for i, StationKey in enumerate(Stem):
        Y = 20 + i * 35
        Label = GetStationLabel(StationKey, StationData)
        Style = GetStationStyle(StationKey, StationData)
        SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="30" cy="{Y}" r="{Style["DotRadius"]}" fill="{Color}"/>'
        SVG += f'<text class="station-label" data-station="{StationKey}" x="45" y="{Y + 5}" font-size="{Style["FontSize"]}" fill="#1e293b" font-weight="{Style["FontWeight"]}">{Label}</text>'
        if i < len(Stem) - 1:
            SVG += f'<line x1="30" y1="{Y + 5}" x2="30" y2="{Y + 30}" stroke="{Color}" stroke-width="3"/>'

    LoopStartY = 20 + len(Stem) * 35
    if Stem:
        SVG += f'<line x1="30" y1="{LoopStartY - 15}" x2="30" y2="{LoopStartY + 10}" stroke="{Color}" stroke-width="3"/>'

    LoopWidth = 70
    LoopHeight = max(50, (len(LoopUnique) - 1) * 25)
    LoopLeft = 30
    LoopRight = LoopLeft + LoopWidth

    SVG += f'<line x1="{LoopLeft}" y1="{LoopStartY + 10}" x2="{LoopRight}" y2="{LoopStartY + 10}" stroke="{Color}" stroke-width="3"/>'
    SVG += f'<line x1="{LoopRight}" y1="{LoopStartY + 10}" x2="{LoopRight}" y2="{LoopStartY + 10 + LoopHeight}" stroke="{Color}" stroke-width="3"/>'
    SVG += f'<line x1="{LoopRight}" y1="{LoopStartY + 10 + LoopHeight}" x2="{LoopLeft}" y2="{LoopStartY + 10 + LoopHeight}" stroke="{Color}" stroke-width="3"/>'
    SVG += f'<line x1="{LoopLeft}" y1="{LoopStartY + 10 + LoopHeight}" x2="{LoopLeft}" y2="{LoopStartY + 10}" stroke="{Color}" stroke-width="3" stroke-dasharray="4,4" opacity="0.6"/>'

    for i, StationKey in enumerate(LoopUnique):
        Y = LoopStartY + 10 + i * 25
        X = LoopRight + 15
        Label = GetStationLabel(StationKey, StationData)
        Style = GetStationStyle(StationKey, StationData)
        SVG += f'<circle class="station-dot" data-station="{StationKey}" cx="{X}" cy="{Y}" r="{Style["DotRadius"] - 1}" fill="{Color}"/>'
        SVG += f'<text class="station-label" data-station="{StationKey}" x="{X + 12}" y="{Y + 4}" font-size="{Style["FontSize"] - 1}" fill="#475569" font-weight="{Style["FontWeight"]}">{Label}</text>'

    SVG += '</svg>'
    return SVG