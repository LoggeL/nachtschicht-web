import {
  FloorId,
  HeistTarget,
  PathResult,
  PathWaypoint,
  TargetNode,
  Vec2,
  WallSegment,
} from './types';

// ============================================================================
// Multi-Floor 2D A* NavGrid Pathfinding, Wall-Occluded Scouting & Light Model
// Shared across Reißbrett ghost rehearsal, Live Execution, @npc-brain & @world
// ============================================================================

const CELL_SIZE = 0.5; // meters per grid cell
const WALL_CLEARANCE = 0.36; // actor body clearance from solid walls
const LOCKED_DOOR_FALLBACK_RADIUS = 1.3;
const PORTAL_TRANSITION_COST = 4.5;

interface DoorSeal {
  node: TargetNode;
  /** Exact wall-to-wall door leaf segment if two flanking wall endpoints exist */
  seg?: { x1: number; z1: number; x2: number; z2: number };
}

function buildDoorSeal(door: TargetNode, walls: WallSegment[]): DoorSeal {
  const endpoints: Vec2[] = [];
  for (const w of walls) {
    if (w.floor !== door.floor) continue;
    const p1 = { x: w.x1, z: w.z1 };
    const p2 = { x: w.x2, z: w.z2 };
    if (dist2D(p1, door.pos) <= 3.5) endpoints.push(p1);
    if (dist2D(p2, door.pos) <= 3.5) endpoints.push(p2);
  }
  // Find best pair of endpoints straddling door.pos (dot product < 0)
  let bestPair: [Vec2, Vec2] | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < endpoints.length; i++) {
    for (let j = i + 1; j < endpoints.length; j++) {
      const a = endpoints[i];
      const b = endpoints[j];
      const vax = a.x - door.pos.x;
      const vaz = a.z - door.pos.z;
      const vbx = b.x - door.pos.x;
      const vbz = b.z - door.pos.z;
      if (vax * vbx + vaz * vbz >= -0.05) continue;
      const span = dist2D(a, b);
      if (span < 0.8 || span > 6.5) continue;
      const score = span + pointToSegmentDistance(door.pos.x, door.pos.z, a.x, a.z, b.x, b.z) * 4;
      if (score < bestScore) {
        bestScore = score;
        bestPair = [a, b];
      }
    }
  }
  if (bestPair) {
    return {
      node: door,
      seg: {
        x1: bestPair[0].x,
        z1: bestPair[0].z,
        x2: bestPair[1].x,
        z2: bestPair[1].z,
      },
    };
  }
  return { node: door };
}

function pointHitsDoorSeal(x: number, z: number, seal: DoorSeal): boolean {
  if (seal.seg) {
    return (
      pointToSegmentDistance(
        x,
        z,
        seal.seg.x1,
        seal.seg.z1,
        seal.seg.x2,
        seal.seg.z2
      ) < WALL_CLEARANCE
    );
  }
  return Math.hypot(x - seal.node.pos.x, z - seal.node.pos.z) < LOCKED_DOOR_FALLBACK_RADIUS;
}

interface FloorGrid {
  floor: FloorId;
  cols: number;
  rows: number;
  minX: number;
  minZ: number;
  /** 1 = permanently blocked by solid wall, 0 = walkable */
  blocked: Uint8Array;
}

interface TargetNavCache {
  targetId: string;
  floors: Map<FloorId, FloorGrid>;
  doorNodes: TargetNode[];
  portalNodes: TargetNode[];
}

const navCache = new Map<string, TargetNavCache>();

function dist2D(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/** Distance from point (px, pz) to segment (x1, z1)-(x2, z2) */
export function pointToSegmentDistance(
  px: number,
  pz: number,
  x1: number,
  z1: number,
  x2: number,
  z2: number
): number {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-8) return Math.hypot(px - x1, pz - z1);
  let t = ((px - x1) * dx + (pz - z1) * dz) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const projX = x1 + t * dx;
  const projZ = z1 + t * dz;
  return Math.hypot(px - projX, pz - projZ);
}

function segmentsIntersect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number
): boolean {
  const ccw = (
    p1x: number,
    p1z: number,
    p2x: number,
    p2z: number,
    p3x: number,
    p3z: number
  ) => (p3z - p1z) * (p2x - p1x) > (p2z - p1z) * (p3x - p1x);
  return (
    ccw(ax, az, cx, cz, dx, dz) !== ccw(bx, bz, cx, cz, dx, dz) &&
    ccw(ax, az, bx, bz, cx, cz) !== ccw(ax, az, bx, bz, dx, dz)
  );
}

/**
 * Checks visual Line-of-Sight against solid walls (`exterior`, `interior`, `baroque`).
 * Glass storefront windows (`glass`) and perimeter fences (`fence`) allow vision through them.
 */
export function hasSolidLineOfSight(
  from: Vec2,
  to: Vec2,
  floor: FloorId,
  walls: WallSegment[]
): boolean {
  for (const w of walls) {
    if (w.floor !== floor) continue;
    if (w.kind === 'glass' || w.kind === 'fence') continue;
    if (segmentsIntersect(from.x, from.z, to.x, to.z, w.x1, w.z1, w.x2, w.z2)) {
      return false;
    }
  }
  return true;
}

/**
 * Checks whether an observer at (observerPos, observerFloor) can legitimately scout/scan
 * a target node without cheating through solid walls.
 */
export function canScoutNodeFrom(params: {
  target: HeistTarget;
  observerPos: Vec2;
  observerFloor: FloorId;
  node: TargetNode;
  binocularsActive?: boolean;
  maxRangeM?: number;
}): { canScout: boolean; reason?: 'too_far' | 'wrong_floor' | 'wall_occluded' } {
  const { target, observerPos, observerFloor, node, binocularsActive = false } = params;
  const maxRange = params.maxRangeM ?? (binocularsActive ? 28 : 14);
  const d = dist2D(observerPos, node.pos);
  if (d > maxRange) {
    return { canScout: false, reason: 'too_far' };
  }

  // Different floors: only allow street-level exterior observation of visibleFromStreet upper nodes (e.g. balcony/roof)
  if (observerFloor !== node.floor) {
    if (observerFloor === 0 && node.floor > 0 && node.visibleFromStreet) {
      return { canScout: true };
    }
    return { canScout: false, reason: 'wrong_floor' };
  }

  // Same floor: allow very close direct touch (<= 2.1m, e.g., wall-mounted box/door),
  // otherwise require true solid-wall Line-of-Sight!
  if (d <= 2.1) {
    return { canScout: true };
  }

  // Slightly nudge target point toward observer by 0.25m so wall-mounted props don't self-occlude
  const dirX = (observerPos.x - node.pos.x) / d;
  const dirZ = (observerPos.z - node.pos.z) / d;
  const probeTarget: Vec2 = {
    x: node.pos.x + dirX * 0.28,
    z: node.pos.z + dirZ * 0.28,
  };

  if (!hasSolidLineOfSight(observerPos, probeTarget, observerFloor, target.walls)) {
    return { canScout: false, reason: 'wall_occluded' };
  }

  return { canScout: true };
}

function getOrBuildNavCache(target: HeistTarget): TargetNavCache {
  const existing = navCache.get(target.id);
  if (existing) return existing;

  const minX = target.bounds.minX - 2;
  const maxX = target.bounds.maxX + 2;
  const minZ = target.bounds.minZ - 2;
  const maxZ = target.bounds.maxZ + 2;
  const cols = Math.ceil((maxX - minX) / CELL_SIZE) + 1;
  const rows = Math.ceil((maxZ - minZ) / CELL_SIZE) + 1;

  const floors = new Map<FloorId, FloorGrid>();
  for (const floor of target.floors) {
    const blocked = new Uint8Array(cols * rows);
    const floorWalls = target.walls.filter((w) => w.floor === floor);

    for (let r = 0; r < rows; r++) {
      const wz = minZ + (r + 0.5) * CELL_SIZE;
      for (let c = 0; c < cols; c++) {
        const wx = minX + (c + 0.5) * CELL_SIZE;
        for (const w of floorWalls) {
          const halfThick = Math.max(WALL_CLEARANCE, (w.thickness ?? 0.28) * 0.5 + 0.24);
          if (pointToSegmentDistance(wx, wz, w.x1, w.z1, w.x2, w.z2) < halfThick) {
            blocked[r * cols + c] = 1;
            break;
          }
        }
      }
    }

    floors.set(floor, { floor, cols, rows, minX, minZ, blocked });
  }

  const doorNodes = target.nodes.filter(
    (n) =>
      n.kind === 'entry_door' ||
      n.kind === 'entry_service' ||
      n.kind === 'entry_window' ||
      n.kind === 'lock'
  );
  const portalNodes = target.nodes.filter(
    (n) => n.connectsToFloor !== undefined && n.connectsToPos !== undefined
  );

  const built: TargetNavCache = {
    targetId: target.id,
    floors,
    doorNodes,
    portalNodes,
  };
  navCache.set(target.id, built);
  return built;
}

function worldToCell(grid: FloorGrid, pos: Vec2): { c: number; r: number } {
  const c = Math.max(
    0,
    Math.min(grid.cols - 1, Math.floor((pos.x - grid.minX) / CELL_SIZE))
  );
  const r = Math.max(
    0,
    Math.min(grid.rows - 1, Math.floor((pos.z - grid.minZ) / CELL_SIZE))
  );
  return { c, r };
}

function cellToWorld(grid: FloorGrid, c: number, r: number): Vec2 {
  return {
    x: grid.minX + (c + 0.5) * CELL_SIZE,
    z: grid.minZ + (r + 0.5) * CELL_SIZE,
  };
}

function findNearestWalkableCell(
  grid: FloorGrid,
  c0: number,
  r0: number,
  isBlocked: (c: number, r: number) => boolean,
  maxRadius = 8
): { c: number; r: number } | null {
  if (!isBlocked(c0, r0)) return { c: c0, r: r0 };
  for (let rad = 1; rad <= maxRadius; rad++) {
    let best: { c: number; r: number; d: number } | null = null;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.abs(dr) !== rad && Math.abs(dc) !== rad) continue;
        const c = c0 + dc;
        const r = r0 + dr;
        if (c < 0 || c >= grid.cols || r < 0 || r >= grid.rows) continue;
        if (!isBlocked(c, r)) {
          const d = dc * dc + dr * dr;
          if (!best || d < best.d) best = { c, r, d };
        }
      }
    }
    if (best) return { c: best.c, r: best.r };
  }
  return null;
}

/** Checks straight-line walkability (no wall or locked door within clearance) */
function isSegmentWalkable(
  a: Vec2,
  b: Vec2,
  floor: FloorId,
  walls: WallSegment[],
  lockedSeals: DoorSeal[]
): boolean {
  const len = dist2D(a, b);
  if (len < 0.05) return true;
  const steps = Math.max(2, Math.ceil(len / 0.25));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    for (const w of walls) {
      if (w.floor !== floor) continue;
      const halfThick = Math.max(WALL_CLEARANCE, (w.thickness ?? 0.28) * 0.5 + 0.22);
      if (pointToSegmentDistance(x, z, w.x1, w.z1, w.x2, w.z2) < halfThick) {
        return false;
      }
    }
    for (const seal of lockedSeals) {
      if (seal.node.floor !== floor) continue;
      if (pointHitsDoorSeal(x, z, seal)) {
        return false;
      }
    }
  }
  return true;
}

function smoothFloorWaypoints(
  pts: PathWaypoint[],
  floor: FloorId,
  walls: WallSegment[],
  lockedSeals: DoorSeal[]
): PathWaypoint[] {
  if (pts.length <= 2) return pts;
  const out: PathWaypoint[] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let furthest = i + 1;
    for (let j = pts.length - 1; j > i + 1; j--) {
      if (isSegmentWalkable(pts[i].pos, pts[j].pos, floor, walls, lockedSeals)) {
        furthest = j;
        break;
      }
    }
    out.push(pts[furthest]);
    i = furthest;
  }
  return out;
}

export interface FindPathOptions {
  /** Set or list of unlocked door/portal node IDs */
  unlockedNodeIds?: Iterable<string>;
  /**
   * When true, locked doors/portals NOT in `unlockedNodeIds` block passage
   * (except arriving directly at a locked door to pick it).
   * Default: false (planner preview assumes crew unlocks doors along route).
   */
  respectLockedDoors?: boolean;
  /** Optional explicit destination node ID (always reachable even if locked) */
  goalNodeId?: string;
}

class MinHeap {
  private items: Array<{ key: number; f: number }> = [];
  get size(): number {
    return this.items.length;
  }
  push(key: number, f: number): void {
    this.items.push({ key, f });
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p].f <= this.items[i].f) break;
      const tmp = this.items[p];
      this.items[p] = this.items[i];
      this.items[i] = tmp;
      i = p;
    }
  }
  pop(): number {
    const top = this.items[0].key;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      let i = 0;
      const n = this.items.length;
      while (true) {
        let best = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < n && this.items[l].f < this.items[best].f) best = l;
        if (r < n && this.items[r].f < this.items[best].f) best = r;
        if (best === i) break;
        const tmp = this.items[i];
        this.items[i] = this.items[best];
        this.items[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}

/**
 * Multi-floor 2D A* NavGrid solver respecting solid walls, door openings,
 * locked doors (optional), and floor connectors (stairs/ladders/hatches).
 */
export function findTargetPath(
  target: HeistTarget,
  fromPos: Vec2,
  fromFloor: FloorId,
  toPos: Vec2,
  toFloor: FloorId,
  options: FindPathOptions = {}
): PathResult {
  const cache = getOrBuildNavCache(target);
  const startGrid = cache.floors.get(fromFloor);
  const goalGrid = cache.floors.get(toFloor);

  if (!startGrid || !goalGrid) {
    return {
      found: false,
      waypoints: [
        { pos: { ...fromPos }, floor: fromFloor },
        { pos: { ...toPos }, floor: toFloor },
      ],
      totalDistanceM: dist2D(fromPos, toPos),
      floorTransitions: fromFloor === toFloor ? 0 : 1,
      blockedByLockedNodeIds: [],
    };
  }

  const unlockedSet = new Set<string>(options.unlockedNodeIds ?? []);
  const respectLocked = Boolean(options.respectLockedDoors);

  // Active locked doors that block passage (never block the door we are specifically walking up to!)
  const lockedDoors: TargetNode[] = respectLocked
    ? cache.doorNodes.filter((d) => {
        if (unlockedSet.has(d.id)) return false;
        if (options.goalNodeId === d.id) return false;
        if (d.floor === toFloor && dist2D(d.pos, toPos) < 1.6) return false;
        if (d.floor === fromFloor && dist2D(d.pos, fromPos) < 1.6) return false;
        return true;
      })
    : [];
  const lockedSeals: DoorSeal[] = lockedDoors.map((d) =>
    buildDoorSeal(d, target.walls)
  );

  // Floor index mapping for compact integer node keys
  const floorList = target.floors;
  const floorIdxMap = new Map<FloorId, number>();
  floorList.forEach((f, idx) => floorIdxMap.set(f, idx));
  const cols = startGrid.cols;
  const rows = startGrid.rows;
  const floorStride = cols * rows;

  const encode = (fIdx: number, c: number, r: number) =>
    fIdx * floorStride + r * cols + c;

  // Build per-floor locked-door temporary masks when respectLocked is active
  const dynamicBlocked = new Map<FloorId, Uint8Array>();
  for (const f of floorList) {
    const fg = cache.floors.get(f)!;
    const fSeals = lockedSeals.filter((s) => s.node.floor === f);
    if (fSeals.length === 0) {
      dynamicBlocked.set(f, fg.blocked);
    } else {
      const copy = new Uint8Array(fg.blocked);
      for (const seal of fSeals) {
        const dc = worldToCell(fg, seal.node.pos);
        const radCells = Math.ceil(3.4 / CELL_SIZE);
        for (let dr = -radCells; dr <= radCells; dr++) {
          for (let dx = -radCells; dx <= radCells; dx++) {
            const c = dc.c + dx;
            const r = dc.r + dr;
            if (c < 0 || c >= cols || r < 0 || r >= rows) continue;
            const wp = cellToWorld(fg, c, r);
            if (pointHitsDoorSeal(wp.x, wp.z, seal)) {
              copy[r * cols + c] = 1;
            }
          }
        }
      }
      dynamicBlocked.set(f, copy);
    }
  }

  const isCellBlocked = (floor: FloorId, c: number, r: number): boolean => {
    const arr = dynamicBlocked.get(floor);
    if (!arr) return true;
    return arr[r * cols + c] === 1;
  };

  // Same-floor fast path when unobstructed straight line exists!
  if (
    fromFloor === toFloor &&
    isSegmentWalkable(fromPos, toPos, fromFloor, target.walls, lockedSeals)
  ) {
    return {
      found: true,
      waypoints: [
        { pos: { ...fromPos }, floor: fromFloor },
        { pos: { ...toPos }, floor: toFloor },
      ],
      totalDistanceM: Math.round(dist2D(fromPos, toPos) * 100) / 100,
      floorTransitions: 0,
      blockedByLockedNodeIds: [],
    };
  }

  const rawStart = worldToCell(startGrid, fromPos);
  const rawGoal = worldToCell(goalGrid, toPos);

  const startCell = findNearestWalkableCell(
    startGrid,
    rawStart.c,
    rawStart.r,
    (c, r) => isCellBlocked(fromFloor, c, r)
  );
  const goalCell = findNearestWalkableCell(
    goalGrid,
    rawGoal.c,
    rawGoal.r,
    (c, r) => isCellBlocked(toFloor, c, r)
  );

  if (!startCell || !goalCell) {
    return {
      found: false,
      waypoints: [
        { pos: { ...fromPos }, floor: fromFloor },
        { pos: { ...toPos }, floor: toFloor },
      ],
      totalDistanceM: dist2D(fromPos, toPos),
      floorTransitions: fromFloor === toFloor ? 0 : 1,
      blockedByLockedNodeIds: lockedDoors.map((d) => d.id),
    };
  }

  // Build bidirectional portal adjacency map on grid keys
  const portalEdges = new Map<
    number,
    Array<{ toKey: number; cost: number; nodeId: string }>
  >();

  for (const pNode of cache.portalNodes) {
    if (
      respectLocked &&
      pNode.isAccessPoint &&
      !unlockedSet.has(pNode.id) &&
      options.goalNodeId !== pNode.id
    ) {
      continue;
    }
    const fA = pNode.floor;
    const fB = pNode.connectsToFloor!;
    const gA = cache.floors.get(fA);
    const gB = cache.floors.get(fB);
    const idxA = floorIdxMap.get(fA);
    const idxB = floorIdxMap.get(fB);
    if (!gA || !gB || idxA === undefined || idxB === undefined) continue;

    const cA0 = worldToCell(gA, pNode.pos);
    const cB0 = worldToCell(gB, pNode.connectsToPos!);
    const cA = findNearestWalkableCell(gA, cA0.c, cA0.r, (c, r) =>
      isCellBlocked(fA, c, r)
    );
    const cB = findNearestWalkableCell(gB, cB0.c, cB0.r, (c, r) =>
      isCellBlocked(fB, c, r)
    );
    if (!cA || !cB) continue;

    const kA = encode(idxA, cA.c, cA.r);
    const kB = encode(idxB, cB.c, cB.r);
    if (!portalEdges.has(kA)) portalEdges.set(kA, []);
    if (!portalEdges.has(kB)) portalEdges.set(kB, []);
    portalEdges.get(kA)!.push({ toKey: kB, cost: PORTAL_TRANSITION_COST, nodeId: pNode.id });
    portalEdges.get(kB)!.push({ toKey: kA, cost: PORTAL_TRANSITION_COST, nodeId: pNode.id });
  }

  const startKey = encode(floorIdxMap.get(fromFloor)!, startCell.c, startCell.r);
  const goalKey = encode(floorIdxMap.get(toFloor)!, goalCell.c, goalCell.r);

  const totalStates = floorList.length * floorStride;
  const gScore = new Float32Array(totalStates);
  gScore.fill(Infinity);
  const cameFrom = new Int32Array(totalStates);
  cameFrom.fill(-1);
  const closed = new Uint8Array(totalStates);
  const viaPortal = new Map<number, string>();

  const heuristic = (fIdx: number, c: number, r: number): number => {
    const fg = cache.floors.get(floorList[fIdx])!;
    const wp = cellToWorld(fg, c, r);
    const floorDiff = Math.abs(floorList[fIdx] - toFloor);
    return dist2D(wp, toPos) + floorDiff * PORTAL_TRANSITION_COST;
  };

  const open = new MinHeap();
  gScore[startKey] = 0;
  open.push(startKey, heuristic(floorIdxMap.get(fromFloor)!, startCell.c, startCell.r));

  const dirs = [
    [1, 0, CELL_SIZE],
    [-1, 0, CELL_SIZE],
    [0, 1, CELL_SIZE],
    [0, -1, CELL_SIZE],
    [1, 1, CELL_SIZE * Math.SQRT2],
    [1, -1, CELL_SIZE * Math.SQRT2],
    [-1, 1, CELL_SIZE * Math.SQRT2],
    [-1, -1, CELL_SIZE * Math.SQRT2],
  ] as const;

  let reached = false;
  while (open.size > 0) {
    const cur = open.pop();
    if (cur === goalKey) {
      reached = true;
      break;
    }
    if (closed[cur]) continue;
    closed[cur] = 1;

    const fIdx = Math.floor(cur / floorStride);
    const rem = cur - fIdx * floorStride;
    const r = Math.floor(rem / cols);
    const c = rem - r * cols;
    const floor = floorList[fIdx];
    const curG = gScore[cur];

    for (const [dc, dr, stepCost] of dirs) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
      if (isCellBlocked(floor, nc, nr)) continue;
      // Prevent corner cutting across diagonal wall edges
      if (dc !== 0 && dr !== 0) {
        if (isCellBlocked(floor, c + dc, r) || isCellBlocked(floor, c, r + dr)) {
          continue;
        }
      }
      const nKey = encode(fIdx, nc, nr);
      if (closed[nKey]) continue;
      const tentG = curG + stepCost;
      if (tentG < gScore[nKey]) {
        gScore[nKey] = tentG;
        cameFrom[nKey] = cur;
        open.push(nKey, tentG + heuristic(fIdx, nc, nr));
      }
    }

    // Multi-floor portal transitions
    const portals = portalEdges.get(cur);
    if (portals) {
      for (const edge of portals) {
        if (closed[edge.toKey]) continue;
        const tentG = curG + edge.cost;
        if (tentG < gScore[edge.toKey]) {
          gScore[edge.toKey] = tentG;
          cameFrom[edge.toKey] = cur;
          viaPortal.set(edge.toKey, edge.nodeId);
          const nfIdx = Math.floor(edge.toKey / floorStride);
          const nRem = edge.toKey - nfIdx * floorStride;
          const nr = Math.floor(nRem / cols);
          const nc = nRem - nr * cols;
          open.push(edge.toKey, tentG + heuristic(nfIdx, nc, nr));
        }
      }
    }
  }

  if (!reached) {
    return {
      found: false,
      waypoints: [
        { pos: { ...fromPos }, floor: fromFloor },
        { pos: { ...toPos }, floor: toFloor },
      ],
      totalDistanceM: dist2D(fromPos, toPos),
      floorTransitions: fromFloor === toFloor ? 0 : 1,
      blockedByLockedNodeIds: lockedDoors.map((d) => d.id),
    };
  }

  // Reconstruct raw grid path
  const rawWaypoints: PathWaypoint[] = [];
  let cur = goalKey;
  while (cur !== -1) {
    const fIdx = Math.floor(cur / floorStride);
    const rem = cur - fIdx * floorStride;
    const r = Math.floor(rem / cols);
    const c = rem - r * cols;
    const floor = floorList[fIdx];
    const fg = cache.floors.get(floor)!;
    rawWaypoints.push({
      pos: cellToWorld(fg, c, r),
      floor,
      viaNodeId: viaPortal.get(cur),
    });
    if (cur === startKey) break;
    cur = cameFrom[cur];
  }
  rawWaypoints.reverse();

  // Anchor exact start and exact goal coordinates
  if (rawWaypoints.length > 0) {
    rawWaypoints[0] = { pos: { ...fromPos }, floor: fromFloor };
    rawWaypoints[rawWaypoints.length - 1] = {
      ...rawWaypoints[rawWaypoints.length - 1],
      pos: { ...toPos },
      floor: toFloor,
    };
  }

  // Smooth contiguous same-floor segments via Line-of-Sight string-pulling
  const smoothed: PathWaypoint[] = [];
  let segStart = 0;
  while (segStart < rawWaypoints.length) {
    const segFloor = rawWaypoints[segStart].floor;
    let segEnd = segStart;
    while (
      segEnd + 1 < rawWaypoints.length &&
      rawWaypoints[segEnd + 1].floor === segFloor
    ) {
      segEnd++;
    }
    const slice = rawWaypoints.slice(segStart, segEnd + 1);
    const cleanSeg = smoothFloorWaypoints(slice, segFloor, target.walls, lockedSeals);
    for (const wp of cleanSeg) {
      const prev = smoothed[smoothed.length - 1];
      if (!prev || prev.floor !== wp.floor || dist2D(prev.pos, wp.pos) > 0.05) {
        smoothed.push(wp);
      }
    }
    segStart = segEnd + 1;
  }

  let totalDistanceM = 0;
  let floorTransitions = 0;
  for (let i = 1; i < smoothed.length; i++) {
    if (smoothed[i].floor !== smoothed[i - 1].floor) {
      floorTransitions += 1;
      totalDistanceM += PORTAL_TRANSITION_COST;
    } else {
      totalDistanceM += dist2D(smoothed[i - 1].pos, smoothed[i].pos);
    }
  }

  return {
    found: true,
    waypoints: smoothed,
    totalDistanceM: Math.round(totalDistanceM * 100) / 100,
    floorTransitions,
    blockedByLockedNodeIds: [],
  };
}

/**
 * Interpolates a position, floor, and heading along a PathWaypoint sequence at
 * normalized progress `u` in [0, 1].
 */
export function sampleAlongWaypoints(
  waypoints: PathWaypoint[],
  u: number
): { pos: Vec2; floor: FloorId; headingDeg: number } {
  if (waypoints.length === 0) {
    return { pos: { x: 0, z: 0 }, floor: 0, headingDeg: 0 };
  }
  if (waypoints.length === 1) {
    return { pos: { ...waypoints[0].pos }, floor: waypoints[0].floor, headingDeg: 0 };
  }

  const clamped = Math.max(0, Math.min(1, u));
  const segLens: number[] = [];
  let total = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const len =
      waypoints[i].floor !== waypoints[i - 1].floor
        ? PORTAL_TRANSITION_COST
        : Math.max(0.01, dist2D(waypoints[i - 1].pos, waypoints[i].pos));
    segLens.push(len);
    total += len;
  }

  if (total < 1e-4) {
    const last = waypoints[waypoints.length - 1];
    return { pos: { ...last.pos }, floor: last.floor, headingDeg: 0 };
  }

  let targetDist = clamped * total;
  for (let i = 0; i < segLens.length; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const len = segLens[i];
    if (targetDist <= len || i === segLens.length - 1) {
      const frac = Math.max(0, Math.min(1, targetDist / len));
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      let heading = Math.hypot(dx, dz) > 1e-4 ? (Math.atan2(dz, dx) * 180) / Math.PI : 0;
      if (heading < 0) heading += 360;
      return {
        pos: {
          x: a.pos.x + dx * frac,
          z: a.pos.z + dz * frac,
        },
        floor: frac < 0.5 ? a.floor : b.floor,
        headingDeg: heading,
      };
    }
    targetDist -= len;
  }

  const last = waypoints[waypoints.length - 1];
  return { pos: { ...last.pos }, floor: last.floor, headingDeg: 0 };
}

/**
 * Computes realistic room illumination levels (0..1) given power state.
 * Cutting power plunges indoor rooms into deep shadow (0.10–0.14) while streetlamps stay lit.
 */
export function computeRoomLightLevels(
  target: HeistTarget,
  powerDisabled: boolean,
  extraDarkRooms?: Iterable<string>
): Record<string, number> {
  const darkSet = new Set<string>(extraDarkRooms ?? []);
  const levels: Record<string, number> = {};

  for (const room of target.rooms) {
    const isCut =
      darkSet.has(room.id) ||
      (powerDisabled && room.kind !== 'street' && room.kind !== 'roof');

    if (room.kind === 'street') {
      levels[room.id] = 0.72;
    } else if (room.kind === 'roof') {
      levels[room.id] = 0.24;
    } else if (room.kind === 'courtyard' || room.kind === 'garden') {
      levels[room.id] = isCut ? 0.16 : 0.42;
    } else if (room.kind === 'cellar') {
      levels[room.id] = isCut ? 0.08 : 0.45;
    } else if (room.kind === 'shop' || room.kind === 'gallery' || room.kind === 'lobby') {
      levels[room.id] = isCut ? 0.12 : 0.85;
    } else {
      // office, vault, corridor, storage
      levels[room.id] = isCut ? 0.1 : 0.62;
    }
  }
  return levels;
}

/**
 * Samples stealth light exposure (0..1) for a character at (pos, floor).
 */
export function sampleLightExposureAt(
  target: HeistTarget,
  pos: Vec2,
  floor: FloorId,
  roomLightLevels: Record<string, number>,
  options: { darkClothing?: boolean; sneaking?: boolean } = {}
): number {
  const room = target.rooms.find(
    (r) =>
      r.floor === floor &&
      pos.x >= r.x &&
      pos.x <= r.x + r.width &&
      pos.z >= r.z &&
      pos.z <= r.z + r.depth
  );
  let base = room ? (roomLightLevels[room.id] ?? 0.5) : 0.45;
  if (options.darkClothing) base *= 0.75;
  if (options.sneaking) base *= 0.85;
  return Math.max(0.05, Math.min(1, Math.round(base * 100) / 100));
}
