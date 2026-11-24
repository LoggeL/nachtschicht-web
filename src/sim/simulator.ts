import {
  ActionBlock,
  CrewId,
  FloorId,
  GuardPatrol,
  HeistTarget,
  IntelState,
  PathWaypoint,
  RehearsalCameraGhost,
  RehearsalConflict,
  RehearsalCrewGhost,
  RehearsalGuardGhost,
  RehearsalNoiseRing,
  RehearsalSnapshot,
  ResolvedPlan,
  TargetNode,
  Vec2,
  WallSegment,
} from './types';
import { distance2D } from './planner';
import {
  computeRoomLightLevels,
  findTargetPath,
  hasSolidLineOfSight,
  sampleAlongWaypoints,
  sampleLightExposureAt,
} from './pathfinding';

// ============================================================================
// Deterministic Ghost-Rehearsal Simulator (Probelauf am Reißbrett)
// Round 2: Uses real wall-respecting multi-floor A* paths, room lighting
// preview (blackout overlay), and acoustic noise radius rings — while
// strictly respecting Fog-of-War (`IntelState`).
// ============================================================================

export function normalizeAngleDeg(deg: number): number {
  let a = deg % 360;
  if (a < 0) a += 360;
  return a;
}

export function angleDiffDeg(a: number, b: number): number {
  let d = normalizeAngleDeg(a) - normalizeAngleDeg(b);
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return Math.abs(d);
}

export function headingBetween(from: Vec2, to: Vec2): number {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  if (Math.hypot(dx, dz) < 1e-4) return 0;
  return normalizeAngleDeg((Math.atan2(dz, dx) * 180) / Math.PI);
}

export function hasLineOfSight(
  from: Vec2,
  to: Vec2,
  floor: FloorId,
  walls: WallSegment[]
): boolean {
  return hasSolidLineOfSight(from, to, floor, walls);
}

export function findRoomAt(target: HeistTarget, pos: Vec2, floor: FloorId) {
  return target.rooms.find(
    (r) =>
      r.floor === floor &&
      pos.x >= r.x &&
      pos.x <= r.x + r.width &&
      pos.z >= r.z &&
      pos.z <= r.z + r.depth
  );
}

export function isPointInVisionCone(params: {
  observerPos: Vec2;
  observerFloor: FloorId;
  headingDeg: number;
  range: number;
  coneDeg: number;
  targetPos: Vec2;
  targetFloor: FloorId;
  walls: WallSegment[];
}): boolean {
  const {
    observerPos,
    observerFloor,
    headingDeg,
    range,
    coneDeg,
    targetPos,
    targetFloor,
    walls,
  } = params;
  if (observerFloor !== targetFloor) return false;
  const dist = distance2D(observerPos, targetPos);
  if (dist > range) return false;
  if (dist < 0.8) return true;
  const bearing = headingBetween(observerPos, targetPos);
  if (angleDiffDeg(bearing, headingDeg) > coneDeg / 2) return false;
  return hasLineOfSight(observerPos, targetPos, observerFloor, walls);
}

export function sampleGuardAtTime(
  guard: GuardPatrol,
  timeSec: number
): { pos: Vec2; floor: FloorId; headingDeg: number } {
  const wps = guard.waypoints;
  if (wps.length === 0) {
    return { pos: { x: 0, z: 0 }, floor: 0, headingDeg: 0 };
  }
  if (wps.length === 1) {
    return {
      pos: { ...wps[0].pos },
      floor: wps[0].floor,
      headingDeg: wps[0].lookAngleDeg ?? 0,
    };
  }

  interface Segment {
    pauseStart: number;
    walkStart: number;
    walkEnd: number;
    from: GuardPatrol['waypoints'][number];
    to: GuardPatrol['waypoints'][number];
  }

  const segments: Segment[] = [];
  let cursor = 0;
  for (let i = 0; i < wps.length; i++) {
    const from = wps[i];
    const to = wps[(i + 1) % wps.length];
    const pauseStart = cursor;
    const walkStart = pauseStart + Math.max(0, from.pauseSec);
    const dist = distance2D(from.pos, to.pos);
    const walkDur = Math.max(0.1, dist / Math.max(0.5, guard.speedMps));
    const walkEnd = walkStart + walkDur;
    segments.push({ pauseStart, walkStart, walkEnd, from, to });
    cursor = walkEnd;
  }

  const totalCycle = Math.max(0.1, cursor);
  const t = ((timeSec % totalCycle) + totalCycle) % totalCycle;

  for (const seg of segments) {
    if (t < seg.walkStart) {
      return {
        pos: { ...seg.from.pos },
        floor: seg.from.floor,
        headingDeg:
          seg.from.lookAngleDeg ?? headingBetween(seg.from.pos, seg.to.pos),
      };
    }
    if (t <= seg.walkEnd) {
      const u = (t - seg.walkStart) / Math.max(0.001, seg.walkEnd - seg.walkStart);
      return {
        pos: {
          x: seg.from.pos.x + (seg.to.pos.x - seg.from.pos.x) * u,
          z: seg.from.pos.z + (seg.to.pos.z - seg.from.pos.z) * u,
        },
        floor: seg.from.floor,
        headingDeg: headingBetween(seg.from.pos, seg.to.pos),
      };
    }
  }

  return {
    pos: { ...wps[0].pos },
    floor: wps[0].floor,
    headingDeg: wps[0].lookAngleDeg ?? 0,
  };
}

export function sampleCameraHeading(node: TargetNode, timeSec: number): number {
  const base = node.cameraHeadingDeg ?? 0;
  const sweep = node.cameraSweepDeg ?? 60;
  const period = Math.max(2, node.cameraSweepPeriodSec ?? 10);
  const offset = Math.sin((2 * Math.PI * timeSec) / period) * (sweep / 2);
  return normalizeAngleDeg(base + offset);
}

/**
 * Samples a single crew member's ghost along wall-respecting A* corridor paths.
 */
function sampleCrewTrackAtTime(
  crewId: CrewId,
  blocks: ActionBlock[],
  target: HeistTarget,
  timeSec: number,
  nodesById: Record<string, TargetNode>
): RehearsalCrewGhost {
  const startPos = target.getawayPos;
  let prevPos: Vec2 = { ...startPos };
  let prevFloor: FloorId = 0;
  let carryingLootEur = 0;

  const trail: Array<{ pos: Vec2; floor: FloorId; t: number }> = [
    { pos: { ...startPos }, floor: 0, t: 0 },
  ];
  const fullPlannedPath: PathWaypoint[] = [{ pos: { ...startPos }, floor: 0 }];

  // Precompute full A* route for blueprint rendering even beyond `timeSec`
  let routePrevPos: Vec2 = { ...startPos };
  let routePrevFloor: FloorId = 0;
  const blockPaths: PathWaypoint[][] = [];
  for (const b of blocks) {
    const wps =
      b.pathWaypoints && b.pathWaypoints.length >= 2
        ? b.pathWaypoints
        : findTargetPath(target, routePrevPos, routePrevFloor, b.targetPos, b.floor, {
            respectLockedDoors: false,
          }).waypoints;
    blockPaths.push(wps);
    for (let i = 1; i < wps.length; i++) {
      fullPlannedPath.push(wps[i]);
    }
    routePrevPos = { ...b.targetPos };
    routePrevFloor = b.floor;
  }

  let pos: Vec2 = { ...startPos };
  let floor: FloorId = 0;
  let headingDeg = 0;
  let status: RehearsalCrewGhost['status'] = 'idle';
  let activeBlockId: string | null = null;
  let activeActionLabel = 'Bereit am Fluchtwagen';
  let progress = 0;

  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    const wps = blockPaths[idx];
    const bStart = b.computedStartSec ?? b.startSec;
    const bEnd = b.computedEndSec ?? bStart + b.durationSec;

    if (timeSec < bStart) {
      pos = { ...prevPos };
      floor = prevFloor;
      headingDeg =
        wps.length >= 2
          ? headingBetween(wps[0].pos, wps[1].pos)
          : headingBetween(prevPos, b.targetPos);
      status = bStart > b.startSec ? 'waiting_sync' : 'idle';
      activeBlockId = null;
      activeActionLabel =
        status === 'waiting_sync'
          ? `Wartet auf Synchronpunkt (${b.label})`
          : `Nächster Schritt: ${b.label}`;
      progress = 0;
      break;
    }

    if (timeSec >= bStart && timeSec <= bEnd) {
      const elapsed = timeSec - bStart;
      const dur = Math.max(0.1, bEnd - bStart);
      progress = Math.min(1, Math.max(0, elapsed / dur));

      const isPureMove = b.type === 'move' || b.type === 'extract';
      const travelFraction = isPureMove ? 1.0 : 0.38;

      if (progress <= travelFraction && wps.length >= 2) {
        const u = Math.min(1, progress / travelFraction);
        const sampled = sampleAlongWaypoints(wps, u);
        pos = sampled.pos;
        floor = sampled.floor;
        headingDeg = sampled.headingDeg;
        status = 'moving';

        // Append intermediate A* corridor vertices reached so far to trail!
        const reachedCount = Math.max(1, Math.floor(u * (wps.length - 1)));
        for (let k = 1; k < reachedCount; k++) {
          trail.push({ pos: { ...wps[k].pos }, floor: wps[k].floor, t: bStart + elapsed * (k / wps.length) });
        }
        trail.push({ pos: { ...pos }, floor, t: timeSec });
      } else {
        for (let k = 1; k < wps.length; k++) {
          trail.push({ pos: { ...wps[k].pos }, floor: wps[k].floor, t: bStart + dur * travelFraction });
        }
        pos = { ...b.targetPos };
        floor = b.floor;
        headingDeg =
          wps.length >= 2
            ? headingBetween(wps[wps.length - 2].pos, wps[wps.length - 1].pos)
            : headingBetween(prevPos, b.targetPos);
        status =
          isPureMove && b.type === 'extract' && progress >= 0.99
            ? 'extracted'
            : 'working';
      }

      activeBlockId = b.id;
      activeActionLabel = b.label;
      break;
    }

    // Completed block — append full A* waypoints so trail follows corridors!
    for (let k = 1; k < wps.length; k++) {
      trail.push({ pos: { ...wps[k].pos }, floor: wps[k].floor, t: bEnd });
    }
    prevPos = { ...b.targetPos };
    prevFloor = b.floor;
    pos = { ...prevPos };
    floor = prevFloor;

    if (b.targetNodeId && (b.type === 'grab_loot' || b.type === 'crack_safe')) {
      const node = nodesById[b.targetNodeId];
      if (node?.lootValue) {
        carryingLootEur += node.lootValue;
      }
    }

    if (b.type === 'extract') {
      status = 'extracted';
      activeActionLabel = 'Am Fluchtwagen';
      progress = 1;
    } else {
      status = 'idle';
      activeActionLabel = `Abgeschlossen: ${b.label}`;
      progress = 1;
    }
  }

  return {
    crewId,
    pos,
    floor,
    headingDeg,
    status,
    activeBlockId,
    activeActionLabel,
    progress,
    carryingLootEur,
    spottedByGuardIds: [],
    spottedByCameraIds: [],
    trail,
    plannedPath: fullPlannedPath,
  };
}

/**
 * Generates a deterministic RehearsalSnapshot at timestamp `timeSec`
 * using ONLY what the player has scouted in `IntelState`.
 */
export function simulateRehearsalAt(params: {
  resolvedPlan: ResolvedPlan;
  target: HeistTarget;
  intel: IntelState;
  timeSec: number;
}): RehearsalSnapshot {
  const { resolvedPlan, target, intel } = params;
  const totalDurationSec = Math.max(10, resolvedPlan.totalDurationSec);
  const timeSec = Math.max(0, Math.min(totalDurationSec, params.timeSec));

  const nodesById: Record<string, TargetNode> = {};
  for (const n of target.nodes) nodesById[n.id] = n;

  let powerDisabled = false;
  let alarmBypassed = false;
  const disabledPowerIds = new Set<string>();
  const loopedCameraIds = new Set<string>();
  const openedNodeIds: string[] = [];
  const lootedNodeIds: string[] = [];
  let projectedLootEur = 0;

  for (const b of resolvedPlan.plan.blocks) {
    const bEnd = b.computedEndSec ?? b.startSec + b.durationSec;
    if (bEnd <= timeSec && b.targetNodeId) {
      const node = nodesById[b.targetNodeId];
      if (!node) continue;
      if (b.type === 'cut_power') {
        powerDisabled = true;
        disabledPowerIds.add(node.id);
      } else if (b.type === 'bypass_alarm') {
        alarmBypassed = true;
      } else if (b.type === 'loop_camera') {
        loopedCameraIds.add(node.id);
      } else if (b.type === 'enter' || b.type === 'pick_lock') {
        if (!openedNodeIds.includes(node.id)) openedNodeIds.push(node.id);
      } else if (b.type === 'grab_loot' || b.type === 'crack_safe') {
        if (!lootedNodeIds.includes(node.id)) {
          lootedNodeIds.push(node.id);
          projectedLootEur += node.lootValue ?? 0;
        }
      }
    }
  }

  const roomLightLevels = computeRoomLightLevels(target, powerDisabled);

  const crew: RehearsalCrewGhost[] = resolvedPlan.plan.assignedCrewIds.map((cid) =>
    sampleCrewTrackAtTime(
      cid,
      resolvedPlan.orderedBlocksByCrew[cid] ?? [],
      target,
      timeSec,
      nodesById
    )
  );

  // Active noise radius rings for crew currently working on noisy actions
  const noiseRings: RehearsalNoiseRing[] = [];
  for (const ghost of crew) {
    if (ghost.status === 'working' && ghost.activeBlockId) {
      const blk = resolvedPlan.blocksById[ghost.activeBlockId];
      if (blk && blk.estimatedNoise >= 18) {
        const radiusM = Math.round((2.2 + (blk.estimatedNoise / 100) * 11.5) * 10) / 10;
        noiseRings.push({
          pos: { ...ghost.pos },
          floor: ghost.floor,
          radiusM,
          noiseLevel: blk.estimatedNoise,
          crewId: ghost.crewId,
          label: blk.label,
        });
      }
    }
  }

  // Sample ONLY known guards (Fog of War!)
  const guards: RehearsalGuardGhost[] = [];
  for (const g of target.guards) {
    const known = g.visibleFromStreet || intel.timedGuardIds.includes(g.id);
    if (!known) continue;
    const sampled = sampleGuardAtTime(g, timeSec);
    guards.push({
      guardId: g.id,
      name: g.name,
      pos: sampled.pos,
      floor: sampled.floor,
      headingDeg: sampled.headingDeg,
      visionRange: g.visionRange,
      visionConeDeg: g.visionConeDeg,
      known: true,
      alerted: false,
    });
  }

  // Sample ONLY known cameras
  const cameras: RehearsalCameraGhost[] = [];
  for (const n of target.nodes) {
    if (n.kind !== 'camera') continue;
    const known = n.visibleFromStreet || intel.discoveredNodeIds.includes(n.id);
    if (!known) continue;
    const poweredOff =
      (n.poweredByNodeId ? disabledPowerIds.has(n.poweredByNodeId) : false) ||
      powerDisabled;
    const active = !poweredOff && !loopedCameraIds.has(n.id);
    cameras.push({
      nodeId: n.id,
      pos: { ...n.pos },
      floor: n.floor,
      headingDeg: sampleCameraHeading(n, timeSec),
      range: n.cameraRange ?? 10,
      active,
      known: true,
      spottingCrewIds: [],
    });
  }

  const conflicts: RehearsalConflict[] = [];
  for (const ghost of crew) {
    if (ghost.status === 'extracted') continue;
    if (distance2D(ghost.pos, target.getawayPos) < 1.2 && ghost.status === 'idle') {
      continue;
    }

    const ghostRoom = findRoomAt(target, ghost.pos, ghost.floor);
    const activeBlock = ghost.activeBlockId
      ? resolvedPlan.blocksById[ghost.activeBlockId]
      : undefined;
    const forensic = resolvedPlan.plan.forensicLoadoutByCrew?.[ghost.crewId];
    const doingOvertCrime =
      ghost.status === 'working' &&
      activeBlock?.type !== 'lookout' &&
      activeBlock?.type !== 'wait' &&
      activeBlock?.type !== 'stage_car';
    const wearingMaskInPublic =
      ghostRoom?.securityZone === 'public' && Boolean(forensic?.mask);
    const actingInPublic =
      ghostRoom?.securityZone === 'public' &&
      !doingOvertCrime &&
      !wearingMaskInPublic &&
      ghost.carryingLootEur === 0;

    const lightExp = sampleLightExposureAt(
      target,
      ghost.pos,
      ghost.floor,
      roomLightLevels,
      { darkClothing: Boolean(forensic?.darkClothing) }
    );
    const lightRangeFactor = 0.42 + lightExp * 0.68;

    for (const guard of guards) {
      if (actingInPublic) continue;
      const effectiveRange = guard.visionRange * lightRangeFactor;
      if (
        isPointInVisionCone({
          observerPos: guard.pos,
          observerFloor: guard.floor,
          headingDeg: guard.headingDeg,
          range: effectiveRange,
          coneDeg: guard.visionConeDeg,
          targetPos: ghost.pos,
          targetFloor: ghost.floor,
          walls: target.walls,
        })
      ) {
        guard.alerted = true;
        ghost.spottedByGuardIds.push(guard.guardId);
        conflicts.push({
          id: `conf_g_${guard.guardId}_${ghost.crewId}`,
          timeSec,
          severity: 'critical',
          crewId: ghost.crewId,
          sourceId: guard.guardId,
          message: `${guard.name} sieht ${ghost.crewId.toUpperCase()} bei t=${timeSec.toFixed(1)}s!`,
          pos: { ...ghost.pos },
          floor: ghost.floor,
        });
      }
    }

    for (const cam of cameras) {
      if (!cam.active) continue;
      if (
        isPointInVisionCone({
          observerPos: cam.pos,
          observerFloor: cam.floor,
          headingDeg: cam.headingDeg,
          range: cam.range,
          coneDeg: 55,
          targetPos: ghost.pos,
          targetFloor: ghost.floor,
          walls: target.walls,
        })
      ) {
        cam.spottingCrewIds.push(ghost.crewId);
        ghost.spottedByCameraIds.push(cam.nodeId);
        conflicts.push({
          id: `conf_c_${cam.nodeId}_${ghost.crewId}`,
          timeSec,
          severity: 'warning',
          crewId: ghost.crewId,
          sourceId: cam.nodeId,
          message: `Kamera erfasst ${ghost.crewId.toUpperCase()} — erst Strom kappen oder schleifen!`,
          pos: { ...ghost.pos },
          floor: ghost.floor,
        });
      }
    }
  }

  // Known hidden traps (Fog of War enforced)
  for (const n of target.nodes) {
    if (!n.isHiddenHazard) continue;
    if (!intel.discoveredNodeIds.includes(n.id)) continue;
    const disarmedByPower =
      (n.poweredByNodeId ? disabledPowerIds.has(n.poweredByNodeId) : false) ||
      powerDisabled;
    if (disarmedByPower) continue;
    for (const ghost of crew) {
      if (ghost.floor === n.floor && distance2D(ghost.pos, n.pos) < 2.2) {
        conflicts.push({
          id: `conf_trap_${n.id}_${ghost.crewId}`,
          timeSec,
          severity: 'critical',
          crewId: ghost.crewId,
          sourceId: n.id,
          message: `Bekannter Sensor „${n.label}“ aktiv — Strom vorher abschalten!`,
          pos: { ...n.pos },
          floor: n.floor,
        });
      }
    }
  }

  const unscoutedGuards = target.guards.filter(
    (g) => !g.visibleFromStreet && !intel.timedGuardIds.includes(g.id)
  ).length;
  const unscoutedHazards = target.nodes.filter(
    (n) =>
      (n.isHiddenHazard || n.kind === 'camera') &&
      !n.visibleFromStreet &&
      !intel.discoveredNodeIds.includes(n.id)
  ).length;

  return {
    timeSec,
    totalDurationSec,
    powerDisabled,
    alarmBypassed,
    openedNodeIds,
    lootedNodeIds,
    projectedLootEur,
    crew,
    guards,
    cameras,
    conflicts,
    unscoutedWarningCount: unscoutedGuards + unscoutedHazards,
    roomLightLevels,
    noiseRings,
  };
}

export function scanRehearsalConflicts(params: {
  resolvedPlan: ResolvedPlan;
  target: HeistTarget;
  intel: IntelState;
  stepSec?: number;
}): RehearsalConflict[] {
  const { resolvedPlan, target, intel, stepSec = 1.0 } = params;
  const total = Math.max(5, resolvedPlan.totalDurationSec);
  const found: RehearsalConflict[] = [];
  const seenKey = new Set<string>();

  for (let t = 0; t <= total; t += stepSec) {
    const snap = simulateRehearsalAt({ resolvedPlan, target, intel, timeSec: t });
    for (const c of snap.conflicts) {
      const key = `${c.crewId}:${c.sourceId}`;
      if (!seenKey.has(key)) {
        seenKey.add(key);
        found.push(c);
      }
    }
  }
  return found;
}
