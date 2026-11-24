import {
  ActionBlock,
  CrewId,
  FloorId,
  GuardPatrol,
  HeistTarget,
  IntelState,
  RehearsalCameraGhost,
  RehearsalConflict,
  RehearsalCrewGhost,
  RehearsalGuardGhost,
  RehearsalSnapshot,
  ResolvedPlan,
  TargetNode,
  Vec2,
  WallSegment,
} from './types';
import { distance2D } from './planner';

// ============================================================================
// Deterministic Ghost-Rehearsal Simulator (Probelauf am Reißbrett)
// Strictly respects Fog-of-War (`IntelState`): unknown guards, cameras, and
// hidden traps CANNOT be predicted by the rehearsal!
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

/** 2D segment intersection test for solid wall Line-of-Sight occlusion */
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
  const ccw = (p1x: number, p1z: number, p2x: number, p2z: number, p3x: number, p3z: number) =>
    (p3z - p1z) * (p2x - p1x) > (p2z - p1z) * (p3x - p1x);
  return (
    ccw(ax, az, cx, cz, dx, dz) !== ccw(bx, bz, cx, cz, dx, dz) &&
    ccw(ax, az, bx, bz, cx, cz) !== ccw(ax, az, bx, bz, dx, dz)
  );
}

export function hasLineOfSight(
  from: Vec2,
  to: Vec2,
  floor: FloorId,
  walls: WallSegment[]
): boolean {
  for (const w of walls) {
    if (w.floor !== floor) continue;
    // Glass and fences allow vision through them
    if (w.kind === 'glass' || w.kind === 'fence') continue;
    if (segmentsIntersect(from.x, from.z, to.x, to.z, w.x1, w.z1, w.x2, w.z2)) {
      return false;
    }
  }
  return true;
}

export function findRoomAt(
  target: HeistTarget,
  pos: Vec2,
  floor: FloorId
) {
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

/**
 * Deterministically samples a guard's position & facing angle at any timestamp `t`.
 */
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

  // Compute segment durations (pause at wp[i], then walk wp[i] -> wp[(i+1)%n])
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

/**
 * Deterministically samples a security camera's sweep heading at timestamp `t`.
 */
export function sampleCameraHeading(node: TargetNode, timeSec: number): number {
  const base = node.cameraHeadingDeg ?? 0;
  const sweep = node.cameraSweepDeg ?? 60;
  const period = Math.max(2, node.cameraSweepPeriodSec ?? 10);
  const offset = Math.sin((2 * Math.PI * timeSec) / period) * (sweep / 2);
  return normalizeAngleDeg(base + offset);
}

/**
 * Samples a single crew member's ghost position, active block, and trail at time `t`.
 */
function sampleCrewTrackAtTime(
  crewId: CrewId,
  blocks: ActionBlock[],
  startPos: Vec2,
  timeSec: number,
  nodesById: Record<string, TargetNode>
): RehearsalCrewGhost {
  let prevPos: Vec2 = { ...startPos };
  let prevFloor: FloorId = 0;
  let carryingLootEur = 0;
  const trail: Array<{ pos: Vec2; floor: FloorId; t: number }> = [
    { pos: { ...startPos }, floor: 0, t: 0 },
  ];

  let pos: Vec2 = { ...startPos };
  let floor: FloorId = 0;
  let headingDeg = 0;
  let status: RehearsalCrewGhost['status'] = 'idle';
  let activeBlockId: string | null = null;
  let activeActionLabel = 'Bereit am Fluchtwagen';
  let progress = 0;

  for (const b of blocks) {
    const bStart = b.computedStartSec ?? b.startSec;
    const bEnd = b.computedEndSec ?? bStart + b.durationSec;

    if (timeSec < bStart) {
      // Waiting at prevPos for either scheduled time or sync barrier
      pos = { ...prevPos };
      floor = prevFloor;
      headingDeg = headingBetween(prevPos, b.targetPos);
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

      // Travel occupies up to first 40% of a work block (or 100% of move/extract)
      const isPureMove = b.type === 'move' || b.type === 'extract';
      const travelFraction = isPureMove ? 1.0 : 0.35;

      if (progress <= travelFraction && distance2D(prevPos, b.targetPos) > 0.1) {
        const u = Math.min(1, progress / travelFraction);
        pos = {
          x: prevPos.x + (b.targetPos.x - prevPos.x) * u,
          z: prevPos.z + (b.targetPos.z - prevPos.z) * u,
        };
        floor = u < 0.5 ? prevFloor : b.floor;
        headingDeg = headingBetween(prevPos, b.targetPos);
        status = 'moving';
      } else {
        pos = { ...b.targetPos };
        floor = b.floor;
        headingDeg = headingBetween(prevPos, b.targetPos);
        status = isPureMove && b.type === 'extract' && progress >= 0.99 ? 'extracted' : 'working';
      }

      activeBlockId = b.id;
      activeActionLabel = b.label;
      trail.push({ pos: { ...pos }, floor, t: timeSec });
      break;
    }

    // Block completed prior to timeSec
    trail.push({ pos: { ...b.targetPos }, floor: b.floor, t: bEnd });
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
  };
}

/**
 * Generates a complete deterministic RehearsalSnapshot at timestamp `timeSec`
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

  // Determine which nodes/states have completed by `timeSec`
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

  // Sample crew ghosts
  const crew: RehearsalCrewGhost[] = resolvedPlan.plan.assignedCrewIds.map((cid) =>
    sampleCrewTrackAtTime(
      cid,
      resolvedPlan.orderedBlocksByCrew[cid] ?? [],
      target.getawayPos,
      timeSec,
      nodesById
    )
  );

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

  // Evaluate sightline conflicts at `timeSec` against known guards & cameras
  const conflicts: RehearsalConflict[] = [];
  for (const ghost of crew) {
    if (ghost.status === 'extracted') continue;
    // Skip street getaway zone detection when just starting/finished
    if (distance2D(ghost.pos, target.getawayPos) < 1.2 && ghost.status === 'idle') {
      continue;
    }

    const ghostRoom = findRoomAt(target, ghost.pos, ghost.floor);
    const activeBlock = ghost.activeBlockId
      ? resolvedPlan.blocksById[ghost.activeBlockId]
      : undefined;
    const doingOvertCrime =
      ghost.status === 'working' &&
      activeBlock?.type !== 'lookout' &&
      activeBlock?.type !== 'wait' &&
      activeBlock?.type !== 'stage_car';
    const actingInPublic =
      ghostRoom?.securityZone === 'public' &&
      !doingOvertCrime &&
      ghost.carryingLootEur === 0;

    for (const guard of guards) {
      if (actingInPublic) continue;
      const inDarkenedInterior =
        powerDisabled && ghostRoom?.securityZone !== 'public';
      const effectiveRange = inDarkenedInterior
        ? guard.visionRange * 0.48
        : guard.visionRange;
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

  // Check if any KNOWN hidden trap is crossed while still powered
  for (const n of target.nodes) {
    if (!n.isHiddenHazard) continue;
    if (!intel.discoveredNodeIds.includes(n.id)) continue; // Fog of War!
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

  // Count how many actual dangers are STILL hidden by Fog of War
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
  };
}

/**
 * Scans the entire timeline in fixed steps (e.g., 1s) to pre-compute all known
 * conflicts for timeline scrubber markers.
 */
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
