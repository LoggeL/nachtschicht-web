import {
  AlarmLevel,
  CrewId,
  CrewMember,
  EvidenceDraft,
  FloorId,
  ForensicLoadout,
  GuardAIState,
  GuardInvestigateReason,
  GuardPatrol,
  HeistTarget,
  LiveCrewState,
  LiveExecutionState,
  LiveGuardState,
  NoisePulse,
  PathWaypoint,
  StealthTelemetry,
  TargetNode,
  Vec2,
  WallSegment,
} from './types';
import {
  computeRoomLightLevels,
  findTargetPath,
  hasSolidLineOfSight,
  sampleLightExposureAt,
} from './pathfinding';
import { angleDiffDeg, findRoomAt, headingBetween, normalizeAngleDeg } from './simulator';

// ============================================================================
// NACHTSCHICHT — Realistic Multi-State Guard Stealth AI & Wall-Clipped Optics
// Pure-TS stealth simulation (Hitman / Splinter Cell / Der Clou! realism):
// - 6 states: patrol -> suspicious -> investigating -> radioing -> pursuit -> searching
// - Continuous gradual suspicion (distance, central vs peripheral cone,
//   wall-occluded LoS, room lighting/shadow, flashlight beam, posture, mask/disguise)
// - Environmental awareness: unlocked doors, power cut (walks via A* to breaker),
//   opened safes/empty vitrines, broken glass, positional noise ripples, shout relay
// - Interruptible ~3.5s radio dispatch window (5.5s with signal_jammer)
// ============================================================================

export const BASE_RADIO_DISPATCH_SEC = 3.5;
export const JAMMER_RADIO_DISPATCH_SEC = 5.5;
export const GUARD_SHOUT_RELAY_RADIUS_M = 16;

export interface GuardTargetActor {
  crewId: CrewId;
  name: string;
  pos: Vec2;
  floor: FloorId;
  speed: number;
  sneaking: boolean;
  carryingLootEur: number;
  doingOvertCrime: boolean;
  wearingMask: boolean;
  wearingDisguise: boolean;
  darkClothing: boolean;
  extractedOrCaught?: boolean;
}

export interface GuardWorldContext {
  target: HeistTarget;
  elapsedSec: number;
  powerDisabled: boolean;
  alarmLevel: AlarmLevel;
  unlockedDoorIds: string[];
  openedContainerIds: string[];
  brokenGlassNodes: string[];
  powerCutRooms: string[];
  roomLightLevels: Record<string, number>;
  noiseEvents: NoisePulse[];
  teamHasJammer?: boolean;
  isScoutingPhase?: boolean;
}

export type GuardAIEventKind =
  | 'suspicion_raised'
  | 'anomaly_noticed'
  | 'power_outage_noticed'
  | 'noise_heard'
  | 'radio_started'
  | 'radio_interrupted'
  | 'radio_completed'
  | 'shout_relay'
  | 'pursuit_started'
  | 'search_started'
  | 'return_to_patrol'
  | 'trespass_warning';

export interface GuardAIEvent {
  kind: GuardAIEventKind;
  guardId: string;
  guardName: string;
  pos: Vec2;
  floor: FloorId;
  calloutText: string;
  urgent: boolean;
  triggersCentralAlarm?: boolean;
  evidence?: EvidenceDraft;
}

export interface GuardVisionEvaluation {
  visible: boolean;
  inCentralCone: boolean;
  inPeripheralCone: boolean;
  inFlashlightBeam: boolean;
  distanceM: number;
  effectiveRangeM: number;
  lightExposure: number;
  suspicionRatePerSec: number;
  immediateCrimeVisual: boolean;
}

export interface StepGuardsResult {
  guards: LiveGuardState[];
  events: GuardAIEvent[];
  newEvidence: EvidenceDraft[];
  triggersCentralAlarm: boolean;
  alarmEscalation: AlarmLevel | null;
  highestSuspicion: number;
  telemetry: StealthTelemetry;
}

function dist2D(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function turnHeadingTowards(currentDeg: number, targetDeg: number, maxDeltaDeg: number): number {
  let diff = normalizeAngleDeg(targetDeg) - normalizeAngleDeg(currentDeg);
  if (diff > 180) diff -= 360;
  if (diff < -180) diff += 360;
  if (Math.abs(diff) <= maxDeltaDeg) return normalizeAngleDeg(targetDeg);
  return normalizeAngleDeg(currentDeg + Math.sign(diff) * maxDeltaDeg);
}

/**
 * Ray-segment intersection in 2D XZ plane. Returns distance along ray if hit
 * within maxDist, otherwise null. Solid walls block vision; glass & fence pass.
 */
export function raycastSolidWalls(
  origin: Vec2,
  dirX: number,
  dirZ: number,
  maxDist: number,
  floor: FloorId,
  walls: WallSegment[]
): number {
  let closest = maxDist;
  for (const w of walls) {
    if (w.floor !== floor) continue;
    if (w.kind === 'glass' || w.kind === 'fence') continue;

    const sx = w.x2 - w.x1;
    const sz = w.z2 - w.z1;
    const denom = dirX * sz - dirZ * sx;
    if (Math.abs(denom) < 1e-7) continue;

    const qpx = w.x1 - origin.x;
    const qpz = w.z1 - origin.z;
    const t = (qpx * sz - qpz * sx) / denom;
    const u = (qpx * dirZ - qpz * dirX) / denom;

    if (t >= 0.05 && t < closest && u >= 0 && u <= 1) {
      closest = t;
    }
  }
  return closest;
}

/**
 * Computes a wall-clipped vision fan polygon in LOCAL guard/camera space
 * (+Z forward, +X left — matching Three.js GLB/Cone orientation) OR world space
 * so vision cones and flashlight beams NEVER pierce solid brick/interior walls!
 */
export function computeWallClippedVisionFan(params: {
  origin: Vec2;
  floor: FloorId;
  headingDeg: number;
  range: number;
  coneDeg: number;
  walls: WallSegment[];
  segments?: number;
}): Array<{ angleOffsetRad: number; dist: number; worldPos: Vec2 }> {
  const { origin, floor, headingDeg, range, coneDeg, walls, segments = 28 } = params;
  const halfRad = ((coneDeg * Math.PI) / 180) * 0.5;
  const baseHeadingRad = (headingDeg * Math.PI) / 180;
  const rays: Array<{ angleOffsetRad: number; dist: number; worldPos: Vec2 }> = [];

  for (let i = 0; i <= segments; i++) {
    const frac = i / segments;
    const offsetRad = -halfRad + frac * halfRad * 2;
    const worldAngle = baseHeadingRad + offsetRad;
    const dirX = Math.cos(worldAngle);
    const dirZ = Math.sin(worldAngle);
    const hitDist = raycastSolidWalls(origin, dirX, dirZ, range, floor, walls);
    rays.push({
      angleOffsetRad: offsetRad,
      dist: hitDist,
      worldPos: {
        x: origin.x + dirX * hitDist,
        z: origin.z + dirZ * hitDist,
      },
    });
  }

  return rays;
}

/**
 * Evaluates realistic multi-factor visual detection of one actor by one guard.
 * Guarantees solid wall occlusion, >50% visibility reduction in darkness/shadow,
 * central vs peripheral cone differentiation, flashlight illumination, posture,
 * mask public-suspicion, and disguise mitigation.
 */
export function evaluateGuardVision(params: {
  guard: LiveGuardState;
  guardDef: GuardPatrol;
  actor: GuardTargetActor;
  ctx: GuardWorldContext;
}): GuardVisionEvaluation {
  const { guard, guardDef, actor, ctx } = params;

  const empty: GuardVisionEvaluation = {
    visible: false,
    inCentralCone: false,
    inPeripheralCone: false,
    inFlashlightBeam: false,
    distanceM: Infinity,
    effectiveRangeM: guardDef.visionRange,
    lightExposure: 0,
    suspicionRatePerSec: 0,
    immediateCrimeVisual: false,
  };

  if (actor.extractedOrCaught || guard.floor !== actor.floor) {
    return empty;
  }

  const distanceM = dist2D(guard.pos, actor.pos);
  if (distanceM > guardDef.visionRange * 1.25) {
    return { ...empty, distanceM };
  }

  // Street getaway safe grace when parked calmly outside during silent stealth
  if (
    distance2DVec(actor.pos, ctx.target.getawayPos) < 2.5 &&
    guardDef.visibleFromStreet &&
    ctx.alarmLevel === 'silent' &&
    !actor.wearingMask &&
    !actor.doingOvertCrime &&
    actor.carryingLootEur === 0
  ) {
    return { ...empty, distanceM };
  }

  const actorRoom = findRoomAt(ctx.target, actor.pos, actor.floor);
  const isPublicZone = !actorRoom || actorRoom.securityZone === 'public';

  // During scouting phase: guards ignore Mara in public areas unless masked,
  // but react realistically if she trespasses inside restricted/high-security rooms!
  if (ctx.isScoutingPhase && isPublicZone && !actor.wearingMask) {
    return { ...empty, distanceM };
  }

  // During live heist: walking calmly in public without mask/loot/crime blends in
  const wearingMaskInPublic = isPublicZone && actor.wearingMask;
  const blendsInPublic =
    isPublicZone &&
    !actor.doingOvertCrime &&
    !wearingMaskInPublic &&
    actor.carryingLootEur === 0 &&
    !actor.sneaking &&
    ctx.alarmLevel !== 'alarm' &&
    ctx.alarmLevel !== 'lockdown';
  if (blendsInPublic) {
    return { ...empty, distanceM };
  }

  // Solid wall occlusion: guards NEVER see through brick/exterior/interior/baroque walls!
  if (distanceM > 0.7 && !hasSolidLineOfSight(guard.pos, actor.pos, guard.floor, ctx.target.walls)) {
    return { ...empty, distanceM };
  }

  // Bearing & vision cone geometry (central vs peripheral)
  const bearingDeg = headingBetween(guard.pos, actor.pos);
  const angDiff = distanceM < 0.85 ? 0 : angleDiffDeg(bearingDeg, guard.headingDeg);
  const centralHalfDeg = guardDef.visionConeDeg * 0.5;
  const peripheralHalfDeg = Math.min(82, guardDef.visionConeDeg * 0.82);

  // Close rear/side physical bump awareness if running upright right behind guard
  const closeBodyBump = distanceM < 1.25 && (!actor.sneaking || actor.speed > 2.2);

  const inCentralCone = angDiff <= centralHalfDeg || closeBodyBump;
  const inPeripheralCone = !inCentralCone && angDiff <= peripheralHalfDeg;
  if (!inCentralCone && !inPeripheralCone) {
    return { ...empty, distanceM };
  }

  // Target lighting / darkness exposure (0.05..1.0)
  const baseLight = sampleLightExposureAt(
    ctx.target,
    actor.pos,
    actor.floor,
    ctx.roomLightLevels,
    {
      darkClothing: actor.darkClothing,
      sneaking: actor.sneaking,
    }
  );

  // Guard's active flashlight beam locally illuminates targets directly inside narrow beam
  const inFlashlightBeam =
    Boolean(guard.flashlightOn) &&
    angDiff <= 22 &&
    distanceM <= Math.min(guardDef.visionRange * 0.95, 9.5);
  const effectiveLight = clamp(baseLight + (inFlashlightBeam ? 0.48 : 0), 0.05, 1.0);

  // Darkness cuts effective sight range by >50% when room is dark & outside flashlight!
  // Light 0.85 -> ~1.00x range; dark room ~0.10 -> ~0.39x range (61% reduction!)
  const lightRangeFactor = 0.32 + effectiveLight * 0.78;
  const postureRangeFactor = actor.sneaking
    ? 0.8
    : actor.speed >= 3.2
      ? 1.16
      : 1.0;
  const coneRangeFactor = inCentralCone ? 1.0 : 0.58;

  const effectiveRangeM = Math.max(
    1.6,
    guardDef.visionRange * lightRangeFactor * postureRangeFactor * coneRangeFactor
  );

  if (distanceM > effectiveRangeM && !closeBodyBump) {
    return {
      ...empty,
      distanceM,
      effectiveRangeM,
      lightExposure: effectiveLight,
    };
  }

  // Compute gradual suspicion gain rate (0..100 scale per second)
  const baseRate = 100 / Math.max(0.75, guardDef.alertThresholdSec);
  const distNorm = clamp(distanceM / Math.max(1, effectiveRangeM), 0, 1);
  // Closer targets fill suspicion significantly faster than silhouettes at edge of range
  const distCurve = 1.45 - distNorm * 0.85;
  const coneFactor = inCentralCone ? 1.0 : 0.42;
  const postureRateFactor = actor.sneaking ? 0.74 : actor.speed >= 3.2 ? 1.32 : 1.0;
  const lightRateFactor = 0.45 + effectiveLight * 0.75;
  const maskPublicBoost = wearingMaskInPublic ? 1.45 : 1.0;
  const disguiseFactor =
    actor.wearingDisguise && !actor.doingOvertCrime && actor.carryingLootEur === 0 && !actor.wearingMask
      ? 0.5
      : 1.0;
  const crimeBoost =
    actor.doingOvertCrime || actor.carryingLootEur > 0 ? 1.75 : 1.0;
  const alertnessBoost =
    guard.state === 'searching' || guard.state === 'pursuit' ? 1.3 : 1.0;

  const suspicionRatePerSec =
    baseRate *
    distCurve *
    coneFactor *
    postureRateFactor *
    lightRateFactor *
    maskPublicBoost *
    disguiseFactor *
    crimeBoost *
    alertnessBoost;

  const immediateCrimeVisual =
    !ctx.isScoutingPhase &&
    inCentralCone &&
    distanceM <= Math.min(6.5, effectiveRangeM * 0.78) &&
    (actor.doingOvertCrime || (actor.carryingLootEur > 0 && !isPublicZone));

  return {
    visible: true,
    inCentralCone,
    inPeripheralCone,
    inFlashlightBeam,
    distanceM,
    effectiveRangeM,
    lightExposure: effectiveLight,
    suspicionRatePerSec,
    immediateCrimeVisual,
  };
}

function distance2DVec(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.z - a.z);
}

/**
 * Helper to move a guard along an A* PathWaypoint array smoothly, updating
 * floor transitions and heading without clipping through solid walls.
 */
function advanceGuardPath(params: {
  guard: LiveGuardState;
  speedMps: number;
  dt: number;
}): { arrived: boolean; movedDist: number } {
  const { guard, speedMps, dt } = params;
  const path = guard.pathWaypoints;
  if (!path || path.length === 0) {
    return { arrived: true, movedDist: 0 };
  }

  let idx = guard.pathIndex ?? 1;
  if (idx >= path.length) {
    return { arrived: true, movedDist: 0 };
  }

  let remaining = speedMps * dt;
  let movedDist = 0;

  while (remaining > 0.001 && idx < path.length) {
    const wp = path[idx];
    if (wp.floor !== guard.floor) {
      // Stair / portal floor transition
      guard.floor = wp.floor;
      guard.pos = { ...wp.pos };
      idx += 1;
      remaining = Math.max(0, remaining - 0.8);
      continue;
    }

    const d = dist2D(guard.pos, wp.pos);
    if (d <= remaining || d < 0.08) {
      if (d > 0.05) {
        guard.headingDeg = headingBetween(guard.pos, wp.pos);
      }
      guard.pos = { ...wp.pos };
      movedDist += d;
      remaining -= d;
      idx += 1;
    } else {
      const ratio = remaining / d;
      guard.headingDeg = headingBetween(guard.pos, wp.pos);
      guard.pos = {
        x: guard.pos.x + (wp.pos.x - guard.pos.x) * ratio,
        z: guard.pos.z + (wp.pos.z - guard.pos.z) * ratio,
      };
      movedDist += remaining;
      remaining = 0;
    }
  }

  guard.pathIndex = idx;
  return { arrived: idx >= path.length, movedDist };
}

function assignAStarPath(
  guard: LiveGuardState,
  target: HeistTarget,
  goalPos: Vec2,
  goalFloor: FloorId,
  unlockedDoorIds: string[],
  goalNodeId?: string
): void {
  const res = findTargetPath(target, guard.pos, guard.floor, goalPos, goalFloor, {
    unlockedNodeIds: unlockedDoorIds,
    // Guards have master keys for target doors, so they navigate through doorways
    // cleanly without phasing through solid walls!
    respectLockedDoors: false,
    goalNodeId,
  });
  guard.pathWaypoints = res.waypoints;
  guard.pathIndex = 1;
}

/**
 * Checks whether a guard's ongoing radio call can be interrupted by the player
 * (e.g. player cut power mid-call, or broke sight and retreated before confirmation).
 */
export function interruptGuardRadio(
  guard: LiveGuardState,
  reason: 'power_cut' | 'lost_contact' | 'jammer'
): boolean {
  if (guard.state !== 'radioing') return false;
  guard.state = 'searching';
  guard.radioProgress = 0;
  guard.searchRemainingSec = 8.5;
  guard.suspicion = Math.min(guard.suspicion, 72);
  guard.pathWaypoints = undefined;
  guard.calloutText =
    reason === 'power_cut'
      ? 'Licht aus! Sichtkontakt verloren — ich suche ab!'
      : reason === 'jammer'
        ? 'Funk gestört?! Ich geh der Sache nach!'
        : 'Verdammt, abgetaucht — suche Umgebung ab!';
  return true;
}

/**
 * Builds normalized GuardTargetActor entries from LiveExecutionState + CrewMembers.
 */
export function buildGuardTargetActors(params: {
  live: LiveExecutionState;
  crewById: Record<CrewId, CrewMember>;
  forensicLoadoutByCrew?: Partial<Record<CrewId, ForensicLoadout>>;
  activeBlockTypesByCrew?: Partial<Record<CrewId, string | undefined>>;
}): GuardTargetActor[] {
  const { live, crewById, forensicLoadoutByCrew, activeBlockTypesByCrew } = params;
  const result: GuardTargetActor[] = [];

  for (const c of Object.values(live.crew)) {
    const member = crewById[c.crewId];
    const forensic = forensicLoadoutByCrew?.[c.crewId];
    const blockType = activeBlockTypesByCrew?.[c.crewId];
    const doingOvertCrime =
      c.state === 'working' &&
      blockType !== 'lookout' &&
      blockType !== 'wait' &&
      blockType !== 'stage_car';

    result.push({
      crewId: c.crewId,
      name: member?.name ?? c.crewId,
      pos: { ...c.pos },
      floor: c.floor,
      speed: c.speed,
      sneaking: c.sneaking,
      carryingLootEur: c.carryingLootEur,
      doingOvertCrime,
      wearingMask: Boolean(forensic?.mask ?? member?.equippedTools.includes('mask')),
      wearingDisguise: Boolean(member?.equippedTools.includes('disguise_kit')),
      darkClothing: Boolean(
        forensic?.darkClothing ?? member?.equippedTools.includes('dark_clothing')
      ),
      extractedOrCaught: c.state === 'extracted' || c.state === 'caught',
    });
  }
  return result;
}

/**
 * Main pure-TS simulation step for all guards on a HeistTarget.
 * Returns updated immutable copies of `LiveGuardState[]`, crisp German callout events,
 * Die Akte evidence drafts, alarm trigger flags, and directional StealthTelemetry.
 */
export function stepGuardsAI(params: {
  guards: LiveGuardState[];
  actors: GuardTargetActor[];
  ctx: GuardWorldContext;
  dtSec: number;
  playerActorId?: CrewId;
}): StepGuardsResult {
  const { actors, ctx, playerActorId = 'mara' } = params;
  const dt = clamp(params.dtSec, 0.005, 0.5);
  const nextGuards: LiveGuardState[] = structuredClone(params.guards);
  const events: GuardAIEvent[] = [];
  const newEvidence: EvidenceDraft[] = [];
  let triggersCentralAlarm = false;
  let alarmEscalation: AlarmLevel | null = null;

  const nodesById = new Map<string, TargetNode>();
  for (const n of ctx.target.nodes) {
    nodesById.set(n.id, n);
  }
  const guardDefsById = new Map<string, GuardPatrol>();
  for (const g of ctx.target.guards) {
    guardDefsById.set(g.id, g);
  }

  const radioDurationSec = ctx.teamHasJammer
    ? JAMMER_RADIO_DISPATCH_SEC
    : BASE_RADIO_DISPATCH_SEC;

  // Locate primary breaker box for power-cut investigation
  const powerBoxes = ctx.target.nodes.filter((n) => n.kind === 'power_box');

  // Track guards who shout during this tick so peers can hear and react
  const shoutEvents: Array<{ sourceGuardId: string; pos: Vec2; floor: FloorId; threatPos: Vec2 }> =
    [];

  // Per-guard tracking of whether the power outage was JUST noticed this tick
  const promoteAlarm = (level: AlarmLevel) => {
    const rank: Record<AlarmLevel, number> = {
      silent: 0,
      suspicious: 1,
      alarm: 2,
      lockdown: 3,
    };
    if (!alarmEscalation || rank[level] > rank[alarmEscalation]) {
      alarmEscalation = level;
    }
  };

  for (const g of nextGuards) {
    const gDef = guardDefsById.get(g.guardId);
    if (!gDef) continue;

    if (!g.noticedAnomalyIds) g.noticedAnomalyIds = [];
    g.radioDurationSec = radioDurationSec;

    // Normalize legacy state labels cleanly
    if (g.state === 'alerted') g.state = 'pursuit';
    if (g.state === 'chasing') g.state = 'pursuit';

    // Determine ambient light at guard's position to auto-toggle tactical flashlight
    const guardRoom = findRoomAt(ctx.target, g.pos, g.floor);
    const guardRoomLight = guardRoom ? (ctx.roomLightLevels[guardRoom.id] ?? 0.5) : 0.45;
    const darkEnvironment = ctx.powerDisabled || guardRoomLight <= 0.35;
    g.flashlightOn =
      darkEnvironment ||
      g.state === 'investigating' ||
      g.state === 'searching' ||
      g.state === 'pursuit' ||
      g.state === 'radioing' ||
      gDef.role === 'nightwatch';

    // ------------------------------------------------------------------------
    // 1) Visual Detection against all active Crew / Mara Actors
    // ------------------------------------------------------------------------
    let bestSeenActor: GuardTargetActor | null = null;
    let bestVision: GuardVisionEvaluation | null = null;

    for (const actor of actors) {
      const vis = evaluateGuardVision({ guard: g, guardDef: gDef, actor, ctx });
      if (vis.visible) {
        if (!bestVision || vis.suspicionRatePerSec > bestVision.suspicionRatePerSec) {
          bestVision = vis;
          bestSeenActor = actor;
        }
      }
    }

    const seesTarget = Boolean(bestVision && bestSeenActor);

    // ------------------------------------------------------------------------
    // 2) Environmental Anomaly Awareness (Power Cut, Unlocked Doors, Safes, Glass)
    // ------------------------------------------------------------------------
    let noticedPowerOutageNow = false;
    if (
      !ctx.isScoutingPhase &&
      ctx.powerDisabled &&
      !g.noticedAnomalyIds.includes('__power_cut__')
    ) {
      // Guard notices power outage if indoors OR looking toward darkened building
      const isIndoors = guardRoom && guardRoom.kind !== 'street';
      const nearBuilding = dist2D(g.pos, { x: 0, z: 0 }) < 24;
      if (isIndoors || nearBuilding) {
        g.noticedAnomalyIds.push('__power_cut__');
        g.flashlightOn = true;
        noticedPowerOutageNow = true;

        // If guard is currently calm (patrol/suspicious), walk via A* to check the breaker box!
        if (g.state === 'patrol' || g.state === 'suspicious') {
          // Pick closest reachable power box (prefer same floor, else any)
          const sameFloorBox = powerBoxes.find((pb) => pb.floor === g.floor) ?? powerBoxes[0];
          if (sameFloorBox) {
            g.state = 'investigating';
            g.investigatePos = { ...sameFloorBox.pos };
            g.investigateReason = 'power';
            g.pauseRemainingSec = 4.5;
            g.suspicion = Math.max(g.suspicion, 42);
            g.calloutText = 'Stromausfall! Prüfe den Verteiler…';
            assignAStarPath(
              g,
              ctx.target,
              sameFloorBox.pos,
              sameFloorBox.floor,
              ctx.unlockedDoorIds,
              sameFloorBox.id
            );
            promoteAlarm('suspicious');
            events.push({
              kind: 'power_outage_noticed',
              guardId: g.guardId,
              guardName: gDef.name,
              pos: { ...g.pos },
              floor: g.floor,
              calloutText: g.calloutText,
              urgent: false,
            });
          }
        }
      }
    }

    // Check physical world anomalies within sightline (broken glass, opened safes/cases, unlocked doors)
    if (!ctx.isScoutingPhase && g.state !== 'radioing' && g.state !== 'pursuit') {
      const checkAnomalyList = (
        ids: string[],
        reason: GuardInvestigateReason,
        severeCrime: boolean
      ) => {
        for (const nodeId of ids) {
          if (g.noticedAnomalyIds!.includes(nodeId)) continue;
          const node = nodesById.get(nodeId);
          if (!node || node.floor !== g.floor) continue;
          const d = dist2D(g.pos, node.pos);
          const anomalyRange = gDef.visionRange * (g.flashlightOn ? 0.9 : 0.72);
          if (d > anomalyRange) continue;
          const bearing = headingBetween(g.pos, node.pos);
          if (d > 1.8 && angleDiffDeg(bearing, g.headingDeg) > gDef.visionConeDeg * 0.6) {
            continue;
          }
          if (!hasSolidLineOfSight(g.pos, node.pos, g.floor, ctx.target.walls)) {
            continue;
          }

          g.noticedAnomalyIds!.push(nodeId);
          g.investigatePos = { ...node.pos };
          g.investigateReason = reason;
          g.lastKnownTargetPos = { ...node.pos };

          if (severeCrime) {
            // Opened safe / empty vitrine / broken glass -> immediate radio callout (interruptible 3.5s!)
            g.suspicion = 100;
            g.state = 'radioing';
            g.radioProgress = 0;
            g.pathWaypoints = undefined;
            g.calloutText =
              reason === 'glass'
                ? `Glas eingeschlagen (${node.label})! Zentrale!`
                : `Aufgebrochen (${node.label})! Zentrale, Einbruch!`;
            promoteAlarm('suspicious');
            events.push({
              kind: 'radio_started',
              guardId: g.guardId,
              guardName: gDef.name,
              pos: { ...g.pos },
              floor: g.floor,
              calloutText: g.calloutText,
              urgent: true,
            });
            return true;
          } else {
            // Unlocked/opened door -> walk via A* to investigate
            g.suspicion = Math.max(g.suspicion, 44);
            g.state = 'investigating';
            g.pauseRemainingSec = 4.2;
            g.calloutText = `Tür steht offen (${node.label})…`;
            assignAStarPath(g, ctx.target, node.pos, node.floor, ctx.unlockedDoorIds, node.id);
            promoteAlarm('suspicious');
            events.push({
              kind: 'anomaly_noticed',
              guardId: g.guardId,
              guardName: gDef.name,
              pos: { ...g.pos },
              floor: g.floor,
              calloutText: g.calloutText,
              urgent: false,
            });
            return true;
          }
        }
        return false;
      };

      const triggeredSevere =
        checkAnomalyList(ctx.brokenGlassNodes, 'glass', true) ||
        checkAnomalyList(ctx.openedContainerIds, 'loot', true);
      if (!triggeredSevere) {
        checkAnomalyList(ctx.unlockedDoorIds, 'door', false);
      }
    }

    // ------------------------------------------------------------------------
    // 3) Positional Noise Ripple Hearing (with solid-wall acoustic dampening)
    // ------------------------------------------------------------------------
    if (!seesTarget && g.state !== 'radioing' && g.state !== 'pursuit') {
      let loudestPulse: NoisePulse | null = null;
      let loudestScore = 0;

      for (const pulse of ctx.noiseEvents) {
        const sameFloor = pulse.floor === g.floor;
        if (!sameFloor && pulse.noiseDb < 76) continue;
        const d = dist2D(g.pos, pulse.pos);
        const wallMuffled =
          sameFloor && !hasSolidLineOfSight(g.pos, pulse.pos, g.floor, ctx.target.walls)
            ? 0.72
            : 1.0;
        const floorAtten = sameFloor ? 1.0 : 0.45;
        const effectiveHearing = Math.min(gDef.hearingRange * 1.55, pulse.radiusM) * wallMuffled * floorAtten;
        if (d <= effectiveHearing) {
          const score = pulse.noiseDb * (1 - d / Math.max(1, effectiveHearing + 2));
          if (score > loudestScore) {
            loudestScore = score;
            loudestPulse = pulse;
          }
        }
      }

      if (loudestPulse) {
        const gain = clamp((loudestPulse.noiseDb - 30) * 0.65, 14, 52);
        g.suspicion = clamp(g.suspicion + gain * dt, 0, 88);
        g.lastKnownTargetPos = { ...loudestPulse.pos };

        const alreadyHeadingThere =
          g.state === 'investigating' &&
          g.investigatePos &&
          dist2D(g.investigatePos, loudestPulse.pos) < 1.5;

        if (!alreadyHeadingThere && g.suspicion >= 28) {
          g.state = 'investigating';
          g.investigatePos = { ...loudestPulse.pos };
          g.investigateReason = 'noise';
          g.pauseRemainingSec = 4.2;
          g.calloutText = `Geräusch gehört (${loudestPulse.label})…`;
          assignAStarPath(
            g,
            ctx.target,
            loudestPulse.pos,
            loudestPulse.floor,
            ctx.unlockedDoorIds
          );
          promoteAlarm('suspicious');
          events.push({
            kind: 'noise_heard',
            guardId: g.guardId,
            guardName: gDef.name,
            pos: { ...g.pos },
            floor: g.floor,
            calloutText: g.calloutText,
            urgent: false,
          });
        } else if (g.state === 'patrol' && g.suspicion >= 16) {
          g.state = 'suspicious';
          g.calloutText = 'Was war das?';
        }
      }
    }

    // ------------------------------------------------------------------------
    // 4) State Machine Execution & Transitions
    // ------------------------------------------------------------------------

    // 4a) RADIOING — ~3.5s (5.5s with jammer) interruptible dispatch!
    if (g.state === 'radioing') {
      if (bestSeenActor) {
        g.lastKnownTargetPos = { ...bestSeenActor.pos };
        g.headingDeg = turnHeadingTowards(
          g.headingDeg,
          headingBetween(g.pos, bestSeenActor.pos),
          220 * dt
        );
      }

      // Check realistic interruption conditions BEFORE radio finishes!
      const progBefore = g.radioProgress ?? 0;
      const canInterruptByStealth =
        !seesTarget &&
        g.investigateReason !== 'loot' &&
        g.investigateReason !== 'glass' &&
        (noticedPowerOutageNow ||
          (progBefore < 0.55 &&
            g.lastKnownTargetPos !== undefined &&
            actors.every(
              (a) =>
                a.extractedOrCaught ||
                a.floor !== g.floor ||
                dist2D(a.pos, g.pos) > 6.5
            )));

      if (canInterruptByStealth) {
        interruptGuardRadio(g, noticedPowerOutageNow ? 'power_cut' : 'lost_contact');
        if (g.lastKnownTargetPos) {
          g.investigatePos = { ...g.lastKnownTargetPos };
          assignAStarPath(g, ctx.target, g.lastKnownTargetPos, g.floor, ctx.unlockedDoorIds);
        }
        events.push({
          kind: 'radio_interrupted',
          guardId: g.guardId,
          guardName: gDef.name,
          pos: { ...g.pos },
          floor: g.floor,
          calloutText: g.calloutText ?? 'Sichtkontakt verloren!',
          urgent: false,
        });
        continue;
      }

      // Advance radio dispatch progress
      g.radioProgress = clamp(progBefore + dt / radioDurationSec, 0, 1);
      if (g.radioProgress >= 1) {
        g.state = 'pursuit';
        g.radioProgress = 1;
        g.searchRemainingSec = 10;
        g.calloutText = 'Alarm raus — Verstärkung unterwegs!';
        triggersCentralAlarm = true;
        promoteAlarm('alarm');

        const witnessTarget = bestSeenActor ?? actors[0] ?? null;
        const masked = Boolean(witnessTarget?.wearingMask);
        const ev: EvidenceDraft = {
          type: 'witness',
          title: `Wachmann-Meldung: ${gDef.name}`,
          detail: masked
            ? `${gDef.name} meldete einen vermummten Eindringling über Funk (keine Gesichts-ID).`
            : `${gDef.name} identifizierte ${witnessTarget?.name ?? 'einen Eindringling'} und funkte die Leitstelle an.`,
          targetId: ctx.target.id,
          severity: masked ? 8 : 15,
          relatedCrewId: masked ? undefined : witnessTarget?.crewId,
        };
        newEvidence.push(ev);

        events.push({
          kind: 'radio_completed',
          guardId: g.guardId,
          guardName: gDef.name,
          pos: { ...g.pos },
          floor: g.floor,
          calloutText: g.calloutText,
          urgent: true,
          triggersCentralAlarm: true,
          evidence: ev,
        });

        // Relay shout to nearby guards!
        shoutEvents.push({
          sourceGuardId: g.guardId,
          pos: { ...g.pos },
          floor: g.floor,
          threatPos: g.lastKnownTargetPos ?? { ...g.pos },
        });

        if (g.lastKnownTargetPos) {
          g.investigatePos = { ...g.lastKnownTargetPos };
          assignAStarPath(g, ctx.target, g.lastKnownTargetPos, g.floor, ctx.unlockedDoorIds);
        }
      }
      continue;
    }

    // 4b) Apply Visual Suspicion Updates (when NOT radioing)
    if (seesTarget && bestVision && bestSeenActor) {
      const prevSusp = g.suspicion;
      g.suspicion = clamp(g.suspicion + bestVision.suspicionRatePerSec * dt, 0, 100);
      g.lastKnownTargetPos = { ...bestSeenActor.pos };

      if (ctx.isScoutingPhase) {
        // Realistic scouting trespassing response (never instant fail, crisp warning!)
        if (g.suspicion >= 25 && g.state === 'patrol') {
          g.state = 'suspicious';
          g.calloutText = 'Hey! Zutritt verboten — raus hier!';
          events.push({
            kind: 'trespass_warning',
            guardId: g.guardId,
            guardName: gDef.name,
            pos: { ...g.pos },
            floor: g.floor,
            calloutText: g.calloutText,
            urgent: false,
          });
        }
        if (g.suspicion >= 65) {
          g.state = 'investigating';
          g.investigatePos = { ...bestSeenActor.pos };
          g.investigateReason = 'sight';
          g.pauseRemainingSec = 3.0;
          g.calloutText = 'Privatgelände! Verlassen Sie sofort das Gebäude!';
          assignAStarPath(g, ctx.target, bestSeenActor.pos, bestSeenActor.floor, ctx.unlockedDoorIds);
        }
      } else {
        // Live heist escalation ladder
        if (
          (g.suspicion >= 98 || bestVision.immediateCrimeVisual) &&
          g.state !== 'pursuit'
        ) {
          g.suspicion = 100;
          if (ctx.alarmLevel === 'alarm' || ctx.alarmLevel === 'lockdown') {
            // Alarm already active -> jump straight into pursuit!
            g.state = 'pursuit';
            g.investigatePos = { ...bestSeenActor.pos };
            g.calloutText = 'Da ist er! Stehen bleiben!';
            assignAStarPath(
              g,
              ctx.target,
              bestSeenActor.pos,
              bestSeenActor.floor,
              ctx.unlockedDoorIds
            );
            events.push({
              kind: 'pursuit_started',
              guardId: g.guardId,
              guardName: gDef.name,
              pos: { ...g.pos },
              floor: g.floor,
              calloutText: g.calloutText,
              urgent: true,
            });
          } else {
            // Enter interruptible ~3.5s radio dispatch!
            g.state = 'radioing';
            g.radioProgress = 0;
            g.investigateReason = 'sight';
            g.pathWaypoints = undefined;
            g.calloutText = 'Zentrale, Eindringling gesichtet!';
            promoteAlarm('suspicious');
            events.push({
              kind: 'radio_started',
              guardId: g.guardId,
              guardName: gDef.name,
              pos: { ...g.pos },
              floor: g.floor,
              calloutText: g.calloutText,
              urgent: true,
            });
            continue;
          }
        } else if (g.suspicion >= 52 && g.state !== 'pursuit' && g.state !== 'investigating') {
          g.state = 'investigating';
          g.investigatePos = { ...bestSeenActor.pos };
          g.investigateReason = 'sight';
          g.pauseRemainingSec = 4.0;
          g.calloutText = 'Wer schleicht da herum?';
          assignAStarPath(g, ctx.target, bestSeenActor.pos, bestSeenActor.floor, ctx.unlockedDoorIds);
          promoteAlarm('suspicious');
          events.push({
            kind: 'suspicion_raised',
            guardId: g.guardId,
            guardName: gDef.name,
            pos: { ...g.pos },
            floor: g.floor,
            calloutText: g.calloutText,
            urgent: false,
          });
        } else if (g.suspicion >= 20 && prevSusp < 20 && g.state === 'patrol') {
          g.state = 'suspicious';
          g.calloutText = 'Moment… wer ist da?';
          events.push({
            kind: 'suspicion_raised',
            guardId: g.guardId,
            guardName: gDef.name,
            pos: { ...g.pos },
            floor: g.floor,
            calloutText: g.calloutText,
            urgent: false,
          });
        } else if (g.state === 'pursuit' || g.state === 'investigating' || g.state === 'searching') {
          // Refresh pursuit/investigate destination while maintaining sightline
          if (
            !g.investigatePos ||
            dist2D(g.investigatePos, bestSeenActor.pos) > 1.6
          ) {
            g.investigatePos = { ...bestSeenActor.pos };
            assignAStarPath(
              g,
              ctx.target,
              bestSeenActor.pos,
              bestSeenActor.floor,
              ctx.unlockedDoorIds
            );
          }
          if (g.state === 'searching') {
            g.state = 'pursuit';
            g.calloutText = 'Wieder im Blick! Stehen bleiben!';
          }
        }
      }
    } else {
      // Gradual suspicion cool-down when target is out of sight
      const coolRate = g.state === 'searching' ? 5.5 : g.state === 'investigating' ? 7.5 : 15;
      g.suspicion = Math.max(0, g.suspicion - coolRate * dt);
    }

    // 4c) Movement & Sweeping Behavior per Active State
    if (g.state === 'suspicious') {
      // Pause and track suspected bearing smoothly
      if (g.lastKnownTargetPos) {
        const desiredHeading = headingBetween(g.pos, g.lastKnownTargetPos);
        g.headingDeg = turnHeadingTowards(g.headingDeg, desiredHeading, 150 * dt);
      }
      if (!seesTarget && g.suspicion < 10) {
        g.state = 'patrol';
        g.calloutText = undefined;
        g.pathWaypoints = undefined;
        events.push({
          kind: 'return_to_patrol',
          guardId: g.guardId,
          guardName: gDef.name,
          pos: { ...g.pos },
          floor: g.floor,
          calloutText: 'Wohl nichts gewesen…',
          urgent: false,
        });
      }
    } else if (g.state === 'pursuit') {
      const pursuitSpd = gDef.speedMps * 1.5;
      if (g.investigatePos) {
        if (!g.pathWaypoints || g.pathWaypoints.length === 0) {
          assignAStarPath(g, ctx.target, g.investigatePos, g.floor, ctx.unlockedDoorIds);
        }
        const adv = advanceGuardPath({ guard: g, speedMps: pursuitSpd, dt });
        if (adv.arrived && !seesTarget) {
          // Lost target at last known spot -> transition to active area search!
          g.state = 'searching';
          g.searchRemainingSec = 9.0;
          g.pathWaypoints = undefined;
          g.calloutText = 'Wo sind die hin? Alles absuchen!';
          events.push({
            kind: 'search_started',
            guardId: g.guardId,
            guardName: gDef.name,
            pos: { ...g.pos },
            floor: g.floor,
            calloutText: g.calloutText,
            urgent: false,
          });
        }
      } else {
        g.state = 'searching';
        g.searchRemainingSec = 8.0;
      }
    } else if (g.state === 'investigating') {
      const invSpd = gDef.speedMps * 1.12;
      if (g.investigatePos) {
        if (!g.pathWaypoints || g.pathWaypoints.length === 0) {
          assignAStarPath(g, ctx.target, g.investigatePos, g.floor, ctx.unlockedDoorIds);
        }
        const adv = advanceGuardPath({ guard: g, speedMps: invSpd, dt });
        if (adv.arrived) {
          g.pauseRemainingSec = Math.max(0, g.pauseRemainingSec - dt);
          // Realistic left-right head/flashlight sweep while checking the spot!
          const sweepSpeed = 1.95;
          const sweepOffset = Math.sin(ctx.elapsedSec * sweepSpeed) * 58 * dt;
          g.headingDeg = normalizeAngleDeg(g.headingDeg + sweepOffset);

          if (g.pauseRemainingSec <= 0) {
            if (g.investigateReason === 'power' || g.investigateReason === 'door') {
              // Stay vigilant with brief search after inspecting tampered breaker/door
              g.state = 'searching';
              g.searchRemainingSec = 5.5;
              g.calloutText =
                g.investigateReason === 'power'
                  ? 'Verteiler manipuliert — ich suche die Räume ab!'
                  : 'Tür war offen — bleibe wachsam!';
              g.pathWaypoints = undefined;
            } else {
              g.state = 'patrol';
              g.investigatePos = undefined;
              g.investigateReason = undefined;
              g.pathWaypoints = undefined;
              g.calloutText = undefined;
              events.push({
                kind: 'return_to_patrol',
                guardId: g.guardId,
                guardName: gDef.name,
                pos: { ...g.pos },
                floor: g.floor,
                calloutText: 'Alles ruhig. Weiter auf Runde.',
                urgent: false,
              });
            }
          }
        }
      } else {
        g.state = 'patrol';
      }
    } else if (g.state === 'searching') {
      g.searchRemainingSec = Math.max(0, (g.searchRemainingSec ?? 6.0) - dt);
      // If still walking to lastKnownTargetPos, finish A* approach; otherwise sweep room
      if (g.pathWaypoints && (g.pathIndex ?? 1) < g.pathWaypoints.length) {
        advanceGuardPath({ guard: g, speedMps: gDef.speedMps * 1.05, dt });
      } else {
        // Deliberate wide flashlight sweep left <-> right
        const sweepDelta = Math.sin(ctx.elapsedSec * 2.2) * 72 * dt;
        g.headingDeg = normalizeAngleDeg(g.headingDeg + sweepDelta);
      }

      if ((g.searchRemainingSec ?? 0) <= 0 && !seesTarget) {
        g.state = 'patrol';
        g.investigatePos = undefined;
        g.investigateReason = undefined;
        g.pathWaypoints = undefined;
        g.calloutText = undefined;
        events.push({
          kind: 'return_to_patrol',
          guardId: g.guardId,
          guardName: gDef.name,
          pos: { ...g.pos },
          floor: g.floor,
          calloutText: 'Nichts gefunden. Zurück zur Runde.',
          urgent: false,
        });
      }
    } else {
      // PATROL state — walk waypoints cleanly via A* (no wall clipping!)
      if (gDef.waypoints.length > 0) {
        const curWp = gDef.waypoints[g.waypointIndex % gDef.waypoints.length];
        const nextIdx = (g.waypointIndex + 1) % gDef.waypoints.length;
        const nextWp = gDef.waypoints[nextIdx];

        if (g.pauseRemainingSec > 0) {
          g.pauseRemainingSec = Math.max(0, g.pauseRemainingSec - dt);
          const baseLook = curWp.lookAngleDeg ?? headingBetween(g.pos, nextWp.pos);
          // Subtle realistic lookout scan while paused on patrol
          const lookScan = normalizeAngleDeg(baseLook + Math.sin(ctx.elapsedSec * 1.05) * 18);
          g.headingDeg = turnHeadingTowards(g.headingDeg, lookScan, 95 * dt);
        } else {
          if (!g.pathWaypoints || g.pathWaypoints.length === 0) {
            assignAStarPath(g, ctx.target, nextWp.pos, nextWp.floor, ctx.unlockedDoorIds);
          }
          const adv = advanceGuardPath({ guard: g, speedMps: gDef.speedMps, dt });
          if (adv.arrived) {
            g.waypointIndex = nextIdx;
            g.pauseRemainingSec = nextWp.pauseSec;
            g.pathWaypoints = undefined;
          }
        }
      }
    }
  }

  // 5) Guard-to-Guard Shout Relay (nearby guards react when a colleague triggers radio/alarm!)
  for (const shout of shoutEvents) {
    for (const peer of nextGuards) {
      if (peer.guardId === shout.sourceGuardId) continue;
      if (peer.state === 'pursuit' || peer.state === 'radioing') continue;
      if (peer.floor !== shout.floor) continue;
      if (dist2D(peer.pos, shout.pos) <= GUARD_SHOUT_RELAY_RADIUS_M) {
        const peerDef = guardDefsById.get(peer.guardId);
        peer.state = 'pursuit';
        peer.suspicion = Math.max(peer.suspicion, 85);
        peer.investigatePos = { ...shout.threatPos };
        peer.lastKnownTargetPos = { ...shout.threatPos };
        peer.calloutText = 'Verstanden — komme zur Verstärkung!';
        peer.flashlightOn = true;
        assignAStarPath(peer, ctx.target, shout.threatPos, shout.floor, ctx.unlockedDoorIds);
        events.push({
          kind: 'shout_relay',
          guardId: peer.guardId,
          guardName: peerDef?.name ?? peer.name,
          pos: { ...peer.pos },
          floor: peer.floor,
          calloutText: peer.calloutText,
          urgent: true,
        });
      }
    }
  }

  // 6) Compute Directional Stealth Telemetry for Mara / HUD Threat Arc
  const playerActor = actors.find((a) => a.crewId === playerActorId) ?? actors[0];
  let highestSuspicion = 0;
  let suspicionSourceAngle: number | null = null;
  let suspicionGuardId: string | null = null;
  let guardState: GuardAIState | null = null;
  let radioInterruptWindowSec: number | null = null;

  for (const g of nextGuards) {
    if (g.state === 'radioing') {
      const dur = g.radioDurationSec ?? radioDurationSec;
      const rem = Math.max(0, (1 - (g.radioProgress ?? 0)) * dur);
      if (radioInterruptWindowSec === null || rem < radioInterruptWindowSec) {
        radioInterruptWindowSec = Math.round(rem * 10) / 10;
      }
    }
    const effectiveSusp =
      g.state === 'radioing' || g.state === 'pursuit' ? Math.max(g.suspicion, 95) : g.suspicion;
    if (effectiveSusp > highestSuspicion) {
      highestSuspicion = effectiveSusp;
      suspicionGuardId = g.guardId;
      guardState = g.state;
      if (playerActor) {
        suspicionSourceAngle = headingBetween(playerActor.pos, g.pos);
      }
    }
  }

  const lightExposure = playerActor
    ? sampleLightExposureAt(
        ctx.target,
        playerActor.pos,
        playerActor.floor,
        ctx.roomLightLevels,
        {
          darkClothing: playerActor.darkClothing,
          sneaking: playerActor.sneaking,
        }
      )
    : 0.45;

  const peakNoiseDb = ctx.noiseEvents.reduce(
    (max, p) => Math.max(max, p.noiseDb),
    24
  );

  const telemetry: StealthTelemetry = {
    lightExposure,
    noiseDb: Math.round(peakNoiseDb),
    highestSuspicion: Math.round(highestSuspicion),
    suspicionSourceAngle: highestSuspicion >= 8 ? suspicionSourceAngle : null,
    suspicionGuardId: highestSuspicion >= 8 ? suspicionGuardId : null,
    guardState: highestSuspicion >= 8 ? guardState : null,
    radioInterruptWindowSec,
    carryWeightPenalty: 0,
  };

  return {
    guards: nextGuards,
    events,
    newEvidence,
    triggersCentralAlarm,
    alarmEscalation,
    highestSuspicion: Math.round(highestSuspicion),
    telemetry,
  };
}

/**
 * Convenience helper to initialize fresh LiveGuardState[] for a target (e.g. for scouting
 * or standalone GuardSystem simulation when LiveExecutionState isn't active yet).
 */
export function createGuardStatesForTarget(target: HeistTarget): LiveGuardState[] {
  return target.guards.map((g) => {
    const wp0 = g.waypoints[0] ?? { pos: { x: 0, z: 0 }, floor: 0 as FloorId, pauseSec: 2 };
    const wp1 = g.waypoints[1] ?? wp0;
    return {
      guardId: g.id,
      name: g.name,
      pos: { ...wp0.pos },
      floor: wp0.floor,
      headingDeg: wp0.lookAngleDeg ?? headingBetween(wp0.pos, wp1.pos),
      visionRange: g.visionRange,
      visionConeDeg: g.visionConeDeg,
      suspicion: 0,
      state: 'patrol',
      waypointIndex: 0,
      pauseRemainingSec: wp0.pauseSec,
      radioProgress: 0,
      radioDurationSec: BASE_RADIO_DISPATCH_SEC,
      flashlightOn: g.role === 'nightwatch',
      noticedAnomalyIds: [],
    };
  });
}

export { computeRoomLightLevels };
