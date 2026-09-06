function Haversine(C1, C2) {
  const P1 = C1[1] * Math.PI / 180;
  const P2 = C2[1] * Math.PI / 180;
  const DP = (C2[1] - C1[1]) * Math.PI / 180;
  const DL = (C2[0] - C1[0]) * Math.PI / 180;
  const A = Math.sin(DP/2) * Math.sin(DP/2) + Math.cos(P1) * Math.cos(P2) * Math.sin(DL/2) * Math.sin(DL/2);
  return 6371000 * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1-A));
}

class TrackGraph {
  constructor(Tol = 0.75) {
    this.Nodes = new Map();
    this.Edges = new Map();
    this.Map = new Map();
    this.Grid = new Map();
    this.Tol = Tol;
    this.Size = 0.0001;
    this.Cache = null;
  }

  Cell(C) {
    return `${Math.floor(C[0]/this.Size)},${Math.floor(C[1]/this.Size)}`;
  }

  Near(C) {
    const X = Math.floor(C[0]/this.Size);
    const Y = Math.floor(C[1]/this.Size);
    const Result = [];
    for (let Dx = -1; Dx <= 1; Dx++) {
      for (let Dy = -1; Dy <= 1; Dy++) {
        Result.push(`${X+Dx},${Y+Dy}`);
      }
    }
    return Result;
  }

  Canon(C) {
    const T = `${C[0]},${C[1]}`;
    if (this.Map.has(T)) {
      return this.Map.get(T);
    }

    const CellKey = this.Cell(C);
    let Candidates = this.Grid.get(CellKey) || [];

    if (Candidates.length === 0) {
      const Parts = CellKey.split(',');
      const BaseX = parseInt(Parts[0]);
      const BaseY = parseInt(Parts[1]);
      for (let Dx = -1; Dx <= 1; Dx++) {
        for (let Dy = -1; Dy <= 1; Dy++) {
          if (Dx === 0 && Dy === 0) continue;
          const NeighborKey = `${BaseX+Dx},${BaseY+Dy}`;
          const NeighborCandidates = this.Grid.get(NeighborKey) || [];
          Candidates = Candidates.concat(NeighborCandidates);
        }
      }
    }

    if (Candidates.length > 0) {
      const TolDegrees = this.Tol / 111320;
      const TolSq = TolDegrees * TolDegrees;

      for (const N of Candidates) {
        const DX = C[0] - N[0];
        const DY = C[1] - N[1];
        const DistSq = DX*DX + DY*DY;
        if (DistSq <= TolSq) {
          this.Map.set(T, N);
          return N;
        }
      }
    }

    const NewNode = [C[0], C[1]];
    this.Map.set(T, NewNode);
    if (!this.Grid.has(CellKey)) {
      this.Grid.set(CellKey, []);
    }
    this.Grid.get(CellKey).push(NewNode);
    this.Cache = null;
    return NewNode;
  }

  Add(Cs) {
    if (Cs.length < 2) return;

    for (let i = 0; i < Cs.length - 1; i++) {
      const S = this.Canon(Cs[i]);
      const E = this.Canon(Cs[i+1]);
      if (S === E) continue;

      const SKey = `${S[0]},${S[1]}`;
      const EKey = `${E[0]},${E[1]}`;

      if (!this.Nodes.has(SKey)) this.Nodes.set(SKey, new Set());
      if (!this.Nodes.has(EKey)) this.Nodes.set(EKey, new Set());
      this.Nodes.get(SKey).add(EKey);
      this.Nodes.get(EKey).add(SKey);

      const EdgeKey = `${SKey}|${EKey}`;
      const ReverseKey = `${EKey}|${SKey}`;
      if (!this.Edges.has(EdgeKey) && !this.Edges.has(ReverseKey)) {
        this.Edges.set(EdgeKey, [Cs[i], Cs[i+1]]);
      }
    }

    if (!this._rawLines) this._rawLines = [];
    this._rawLines.push(Cs);
  }

  // Real switches/crossovers between two exported lines usually land within
  // Canon()'s tight merge tolerance (their sampled points coincide almost
  // exactly), but occasionally miss it by a meter or more -- a crossover
  // track tied tightly to one line can land a couple meters short of the
  // other. A single tolerance can't safely be widened enough to catch these
  // everywhere: real separate parallel tracks can run within a similar
  // distance of each other for long stretches, and widening the merge
  // radius broadly would start welding those together too.
  //
  // The fix is to look specifically at line ENDPOINTS. A switch is, by
  // definition, where one track segment starts or ends -- that's how these
  // networks get exported. Checking only the first/last points of each
  // line (not their full interior) finds genuine connections without the
  // flood of false positives you get from lines that simply run near each
  // other for a while without actually joining.
  BridgeEndpoints() {
    const lines = this._rawLines;
    if (!lines || lines.length === 0) return;

    const Window = 150;   // how many points from each end count as "the endpoint region"
    const Radius = 15;    // meters -- generous, since we're restricted to endpoints only
    const RadiusDeg = Radius / 111320;

    const grid = new Map(); // cellKey -> [[lineIdx, pointIdx], ...]
    const cell = (c) => `${Math.floor(c[0]/RadiusDeg)},${Math.floor(c[1]/RadiusDeg)}`;

    const candidates = [];
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const n = line.length;
      const idxSet = new Set();
      for (let k = 0; k < Math.min(Window, n); k++) idxSet.add(k);
      if (n > Window) for (let k = Math.max(0, n-Window); k < n; k++) idxSet.add(k);
      for (const pi of idxSet) {
        candidates.push([li, pi]);
        const k = cell(line[pi]);
        if (!grid.has(k)) grid.set(k, []);
        grid.get(k).push([li, pi]);
      }
    }

    const seenPairs = new Set();
    let bridged = 0;
    for (const [li, pi] of candidates) {
      const pt = lines[li][pi];
      const cx = Math.floor(pt[0]/RadiusDeg), cy = Math.floor(pt[1]/RadiusDeg);
      let best = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = grid.get(`${cx+dx},${cy+dy}`);
          if (!bucket) continue;
          for (const [lj, pj] of bucket) {
            if (lj === li) continue;
            const dd = Haversine(pt, lines[lj][pj]);
            if (dd <= Radius && (!best || dd < best[0])) best = [dd, lj, pj];
          }
        }
      }
      if (!best) continue;
      const [dd, lj, pj] = best;
      const pairKey = li < lj ? `${li}|${lj}` : `${lj}|${li}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      const A = this.Canon(pt);
      const B = this.Canon(lines[lj][pj]);
      const AKey = `${A[0]},${A[1]}`, BKey = `${B[0]},${B[1]}`;
      if (AKey === BKey) continue; // already connected via normal tolerance

      if (!this.Nodes.has(AKey)) this.Nodes.set(AKey, new Set());
      if (!this.Nodes.has(BKey)) this.Nodes.set(BKey, new Set());
      this.Nodes.get(AKey).add(BKey);
      this.Nodes.get(BKey).add(AKey);
      const EdgeKey = `${AKey}|${BKey}`, ReverseKey = `${BKey}|${AKey}`;
      if (!this.Edges.has(EdgeKey) && !this.Edges.has(ReverseKey)) {
        this.Edges.set(EdgeKey, [A, B]);
        bridged++;
      }
    }
    return bridged;
  }

  Nearest(C) {
    let BestDist = Infinity;
    let BestSegKey = null;
    let BestIdx = null;

    for (const [Key, Geom] of this.Edges) {
      for (let i = 0; i < Geom.length; i++) {
        const D = Haversine(C, Geom[i]);
        if (D < BestDist) {
          BestDist = D;
          BestSegKey = Key;
          BestIdx = i;
        }
      }
    }

    if (BestSegKey && BestIdx !== null) {
      const Geom = this.Edges.get(BestSegKey);
      const [SKey, EKey] = BestSegKey.split('|');

      if (BestIdx > 0 && BestIdx < Geom.length - 1) {
        const NewNode = [Geom[BestIdx][0], Geom[BestIdx][1]];
        const NewKey = `${NewNode[0]},${NewNode[1]}`;

        if (this.Map.has(NewKey) && this.Nodes.has(this.Map.get(NewKey))) {
          return this.Map.get(NewKey);
        }

        const Seg1 = Geom.slice(0, BestIdx + 1);
        const Seg2 = Geom.slice(BestIdx);

        this.Edges.delete(BestSegKey);
        if (this.Nodes.has(SKey)) this.Nodes.get(SKey).delete(EKey);
        if (this.Nodes.has(EKey)) this.Nodes.get(EKey).delete(SKey);

        const CellKey = this.Cell(Geom[BestIdx]);
        if (!this.Grid.has(CellKey)) this.Grid.set(CellKey, []);
        if (!this.Grid.get(CellKey).some(N => N[0] === NewNode[0] && N[1] === NewNode[1])) {
          this.Grid.get(CellKey).push(NewNode);
        }
        this.Map.set(NewKey, NewNode);

        if (Seg1.length >= 2) {
          if (!this.Nodes.has(SKey)) this.Nodes.set(SKey, new Set());
          if (!this.Nodes.has(NewKey)) this.Nodes.set(NewKey, new Set());
          this.Nodes.get(SKey).add(NewKey);
          this.Nodes.get(NewKey).add(SKey);
          this.Edges.set(`${SKey}|${NewKey}`, Seg1);
        }

        if (Seg2.length >= 2) {
          if (!this.Nodes.has(NewKey)) this.Nodes.set(NewKey, new Set());
          if (!this.Nodes.has(EKey)) this.Nodes.set(EKey, new Set());
          this.Nodes.get(NewKey).add(EKey);
          this.Nodes.get(EKey).add(NewKey);
          this.Edges.set(`${NewKey}|${EKey}`, Seg2);
        }

        this.Cache = null;
        return NewNode;
      } else {
        const S = SKey.split(',').map(Number);
        const E = EKey.split(',').map(Number);
        return BestIdx === 0 ? S : E;
      }
    }

    const CandKeys = this.Near(C).flatMap(Cl => this.Grid.get(Cl) || []);
    let Cands = CandKeys;
    if (Cands.length === 0) {
      if (!this.Cache) {
        this.Cache = Array.from(new Set(Array.from(this.Map.values())));
      }
      Cands = this.Cache;
    }

    if (Cands.length > 0) {
      let MinDist = Infinity;
      let MinNode = null;
      for (const N of Cands) {
        const D = Haversine(C, N);
        if (D < MinDist) {
          MinDist = D;
          MinNode = N;
        }
      }
      return MinNode;
    }

    return null;
  }

  Path(S, E) {
    if (S[0] === E[0] && S[1] === E[1]) return [S];

    const SKey = `${S[0]},${S[1]}`;
    const EKey = `${E[0]},${E[1]}`;

    const D = new Map();
    D.set(SKey, 0);
    const P = new Map();
    const Q = [[Haversine(S, E), 0, SKey, S]];
    const V = new Set();

    // Plain distance-minimizing Dijkstra has no notion of "stay on this
    // physical track" -- at any point two tracks are connected (a real
    // switch/crossover), it's happy to hop across if that shaves off even
    // a little distance, which produces a path that cuts corners through
    // junctions instead of following one continuous curve.
    //
    // Penalizing heading changes fixes that, but the penalty has to be
    // convex in the turn angle, not linear: a smooth curve and a corner-cut
    // shortcut across it often add up to a similar TOTAL turning angle --
    // the curve just spreads it across many gentle turns while the
    // shortcut concentrates it into one or two sharp ones. A linear
    // per-degree penalty barely tells them apart. (1 - cos(angle)) grows
    // much faster for a single large turn than for the same total angle
    // split across several small ones, so it favors the gentle curve.
    //
    // The penalty scales with the local edge length so it stays effective
    // regardless of point spacing -- BUT that length must be capped. Real
    // data mixes densely-sampled curves with long, sparsely-sampled
    // straight segments (a straight stretch needs only 2 points; a curve
    // needs many), and an ordinary small-scale turn can sit right next to
    // one of those long edges. Without a cap, the penalty there scales
    // with that edge's raw length and can explode into kilometers over a
    // single ordinary junction -- enough to make the router prefer a
    // multi-kilometer detour over a few meters of legitimate turning. The
    // cap guarantees the opposite can never happen: total possible penalty
    // savings from any detour are bounded by a small constant per turn
    // avoided, so no detour's extra distance can ever be "worth it".
    const TurnPenaltyFactor = 4;     // dimensionless; higher = more reluctant to leave the current track
    const TurnPenaltyCapMeters = 40; // ceiling on the "local scale" used per turn, regardless of actual edge length

    while (Q.length > 0) {
      Q.sort((a, b) => a[0] - b[0]);
      const [_, Cd, CKey, C] = Q.shift();

      if (V.has(CKey)) continue;
      V.add(CKey);

      if (CKey === EKey) {
        const R = [];
        let Current = CKey;
        let CurrentNode = C;
        while (P.has(Current)) {
          R.push(CurrentNode);
          const Prev = P.get(Current);
          Current = Prev[0];
          CurrentNode = Prev[1];
        }
        R.reverse();
        R.unshift(S);
        return R;
      }

      const Neighbors = this.Nodes.get(CKey);
      if (!Neighbors) continue;

      const Incoming = P.get(CKey); // [PrevKey, PrevCoord], or undefined at the true start node

      for (const NKey of Neighbors) {
        if (V.has(NKey)) continue;

        const N = NKey.split(',').map(Number);
        const EdgeDist = Haversine(C, N);

        let TurnPenalty = 0;
        if (Incoming) {
          const PrevC = Incoming[1];
          const InDx = C[0] - PrevC[0], InDy = C[1] - PrevC[1];
          const OutDx = N[0] - C[0],    OutDy = N[1] - C[1];
          const InLen = Math.hypot(InDx, InDy), OutLen = Math.hypot(OutDx, OutDy);
          if (InLen > 0 && OutLen > 0) {
            const CosAngle = Math.max(-1, Math.min(1, (InDx*OutDx + InDy*OutDy) / (InLen*OutLen)));
            const InMeters = Haversine(PrevC, C);
            // Use the SHORTER of the two edges (capped) -- a legitimate
            // small-scale turn is bounded by whichever side of it is more
            // local, even if the other side happens to be a long edge.
            const LocalScale = Math.min(InMeters, EdgeDist, TurnPenaltyCapMeters);
            TurnPenalty = (1 - CosAngle) * LocalScale * TurnPenaltyFactor;
          }
        }

        const Nd = Cd + EdgeDist + TurnPenalty;

        if (!D.has(NKey) || Nd < D.get(NKey)) {
          D.set(NKey, Nd);
          P.set(NKey, [CKey, C]);
          const H = Haversine(N, E);
          Q.push([Nd + H, Nd, NKey, N]);
        }
      }
    }

    return null;
  }

  Geom(Path) {
    if (!Path || Path.length < 2) return [];

    const G = [];
    for (let i = 0; i < Path.length - 1; i++) {
      const S = Path[i];
      const E = Path[i+1];
      const SKey = `${S[0]},${S[1]}`;
      const EKey = `${E[0]},${E[1]}`;
      const EdgeKey = `${SKey}|${EKey}`;
      const ReverseKey = `${EKey}|${SKey}`;

      let Ed = this.Edges.get(EdgeKey);
      if (!Ed) {
        Ed = this.Edges.get(ReverseKey);
        if (Ed) Ed = Ed.slice().reverse();
      }
      if (!Ed) {
        Ed = [[S[0], S[1]], [E[0], E[1]]];
      }

      if (i === 0) {
        G.push(...Ed);
      } else {
        G.push(...Ed.slice(1));
      }
    }

    return G;
  }
}