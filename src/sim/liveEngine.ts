import {
  ActionBlock,
  CollectedLootItem,
  CrewId,
  CrewMember,
  EscapeState,
  FloorId,
  ForensicLoadout,
  HeistTarget,
  InteractOutcome,
  LiveCameraState,
  LiveCrewState,
  LiveExecutionState,
  LiveGuardState,
  NoisePulse,
  PathWaypoint,
  RadioCommandType,
  ResolvedPlan,
  StealthTelemetry,
  TargetNode,
  Vec2,
} from './types';
import {
  distance2D,
  getEffectiveForensicLoadout,
  selectPlanBBranch,
} from './planner';
import {
  findRoomAt,
  headingBetween,
  isPointInVisionCone,
  sampleCameraHeading,
} from './simulator';
import {
  computeRoomLightLevels,
  findTargetPath,
  sampleLightExposureAt,
} from './pathfinding';

// ============================================================================
// Pure-TS Live Execution Engine (Round 2 Realism Overhaul)
// - True wall-respecting multi-floor A* path following for crew & guards
// - Persistent world state: unlockedDoorIds, openedContainerIds,
//   brokenGlassNodes, powerCutRooms, roomLightLevels, positional noiseEvents
// - Continuous light-exposure stealth, carry-weight slowdown & footstep noise
// - Multi-state guard AI with interruptible radioing window (~3.5s / 6s jammer)
// - Forensic gear effects: gloves, mask, dark_clothing, disguise_kit,
//   signal_jammer, glass_cutter vs crowbar
// - Minigame InteractOutcome support
// ============================================================================

const BASE_RADIO_DISPATCH_SEC = 3.5;
const JAMMER_RADIO_BONUS_SEC = 2.5;
const NOISE_PULSE_TTL_SEC = 4.5;

function nextRng(state: number): { value: number; nextState: number } {
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState: (state + 1) | 0 };
}

function stepTowardsPoint(
  current: Vec2,
  target: Vec2,
  maxStep: number
): { pos: Vec2; arrived: boolean; headingDeg: number } {
  const dist = distance2D(current, target);
  const headingDeg = headingBetween(current, target);
  if (dist <= maxStep || dist < 0.08) {
    return { pos: { ...target }, arrived: true, headingDeg };
  }
  const ratio = maxStep / dist;
  return {
    pos: {
      x: current.x + (target.x - current.x) * ratio,
      z: current.z + (target.z - current.z) * ratio,
    },
    arrived: false,
    headingDeg,
  };
}

/**
 * Advances an actor along a multi-floor A* PathWaypoint list without phasing through walls.
 */
function advanceAlongPath(params: {
  pos: Vec2;
  floor: FloorId;
  path: PathWaypoint[];
  pathIndex: number;
  speedMps: number;
  dt: number;
}): {
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  pathIndex: number;
  arrived: boolean;
} {
  const { path, speedMps, dt } = params;
  if (path.length === 0) {
    return {
      pos: { ...params.pos },
      floor: params.floor,
      headingDeg: 0,
      pathIndex: 0,
      arrived: true,
    };
  }

  let idx = Math.max(0, Math.min(path.length - 1, params.pathIndex));
  let curPos = { ...params.pos };
  let curFloor = params.floor;
  let headingDeg = 0;
  let remainingStep = Math.max(0.01, speedMps * dt);

  while (remainingStep > 0.001 && idx < path.length) {
    const wp = path[idx];
    // Floor portal jump once reaching portal node
    if (wp.floor !== curFloor) {
      curFloor = wp.floor;
      curPos = { ...wp.pos };
      idx += 1;
      remainingStep = Math.max(0, remainingStep - 1.2);
      continue;
    }

    const dist = distance2D(curPos, wp.pos);
    headingDeg = headingBetween(curPos, wp.pos);
    if (dist <= remainingStep || dist < 0.12) {
      curPos = { ...wp.pos };
      remainingStep -= dist;
      idx += 1;
    } else {
      const ratio = remainingStep / dist;
      curPos = {
        x: curPos.x + (wp.pos.x - curPos.x) * ratio,
        z: curPos.z + (wp.pos.z - curPos.z) * ratio,
      };
      remainingStep = 0;
    }
  }

  return {
    pos: curPos,
    floor: curFloor,
    headingDeg,
    pathIndex: idx,
    arrived: idx >= path.length,
  };
}

export function computeCarryWeightPenalty(itemCount: number, lootEur: number): number {
  const byCount = itemCount * 0.09;
  const byValue = lootEur > 200000 ? 0.06 : 0;
  return Math.min(0.32, Math.round((byCount + byValue) * 100) / 100);
}

export function pushNoisePulse(
  state: LiveExecutionState,
  params: {
    pos: Vec2;
    floor: FloorId;
    noiseDb: number;
    label: string;
    sourceCrewId?: CrewId;
  }
): void {
  const db = Math.max(20, Math.min(110, Math.round(params.noiseDb)));
  const radiusM = Math.max(2.0, Math.round(((db - 22) / 88) * 18 * 10) / 10);
  const pulse: NoisePulse = {
    id: `np_${Math.round(state.elapsedSec * 100)}_${state.noiseEvents.length}`,
    pos: { ...params.pos },
    floor: params.floor,
    radiusM,
    noiseDb: db,
    emittedAtSec: state.elapsedSec,
    sourceCrewId: params.sourceCrewId,
    label: params.label,
  };
  state.noiseEvents.push(pulse);
  if (state.noiseEvents.length > 18) {
    state.noiseEvents = state.noiseEvents.slice(-18);
  }
  const normalized = Math.max(0, Math.min(100, Math.round(((db - 20) / 85) * 100)));
  state.noiseLevel = Math.max(state.noiseLevel, normalized);
}

export function createInitialStealthTelemetry(): StealthTelemetry {
  return {
    lightExposure: 0.45,
    noiseDb: 24,
    highestSuspicion: 0,
    suspicionSourceAngle: null,
    suspicionGuardId: null,
    guardState: 'patrol',
    radioInterruptWindowSec: null,
    carryWeightPenalty: 0,
  };
}

export function createInitialLiveState(params: {
  target: HeistTarget;
  resolvedPlan: ResolvedPlan;
  seed?: number;
}): LiveExecutionState {
  const { target, resolvedPlan, seed = 1337 } = params;

  const crew = {} as Record<CrewId, LiveCrewState>;
  const crewIds = resolvedPlan.plan.assignedCrewIds;
  crewIds.forEach((cid, idx) => {
    const offset = (idx - (crewIds.length - 1) / 2) * 0.9;
    crew[cid] = {
      crewId: cid,
      pos: { x: target.getawayPos.x + offset, z: target.getawayPos.z },
      floor: 0,
      headingDeg: target.getawayHeadingDeg,
      speed: 0,
      sneaking: false,
      state: 'idle',
      activeBlockIndex: 0,
      activeBlockId: null,
      activeActionLabel: 'Bereit am Fluchtwagen',
      blockProgress: 0,
      completedBlockIds: [],
      carryingLootEur: 0,
      carryingLootItems: [],
      stress: 0,
      usingPlanB: false,
      deviationActive: null,
      extraLootTargetNodeId: null,
      carryWeightPenalty: 0,
    };
  });

  const guards: LiveGuardState[] = target.guards.map((g) => {
    const wp0 = g.waypoints[0] ?? { pos: { x: 0, z: 0 }, floor: 0, pauseSec: 2 };
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

  const cameras: LiveCameraState[] = target.nodes
    .filter((n) => n.kind === 'camera')
    .map((n) => ({
      nodeId: n.id,
      pos: { ...n.pos },
      floor: n.floor,
      headingDeg: n.cameraHeadingDeg ?? 0,
      range: n.cameraRange ?? 10,
      active: true,
      looped: false,
      suspicion: 0,
    }));

  return {
    targetId: target.id,
    elapsedSec: 0,
    paused: false,
    alarmLevel: 'silent',
    alarmProgress: 0,
    noiseLevel: 0,
    policeEtaSec: null,
    powerDisabled: false,
    alarmBypassed: false,
    planBActive: false,
    abortActive: false,
    holdActive: false,
    completedNodeIds: [],
    triggeredHazardNodeIds: [],
    unlockedDoorIds: [],
    openedContainerIds: [],
    brokenGlassNodes: [],
    powerCutRooms: [],
    roomLightLevels: computeRoomLightLevels(target, false),
    noiseEvents: [],
    stealthTelemetry: createInitialStealthTelemetry(),
    activeMinigame: null,
    collectedLoot: [],
    totalLootEur: 0,
    crew,
    guards,
    cameras,
    deviations: [],
    radioLog: [],
    pendingEvidence: [],
    readyForEscape: false,
    compromised: false,
    violenceUsed: false,
    rngState: seed,
  };
}

export function createInitialEscapeState(
  target: HeistTarget,
  alarmLevel: LiveExecutionState['alarmLevel']
): EscapeState {
  const initialHeat =
    alarmLevel === 'lockdown'
      ? 85
      : alarmLevel === 'alarm'
        ? 65
        : alarmLevel === 'suspicious'
          ? 35
          : 15;
  const dispatched = alarmLevel === 'alarm' || alarmLevel === 'lockdown';
  return {
    active: true,
    elapsedSec: 0,
    speedKmh: 0,
    pursuitHeat: initialHeat,
    policeSpotted: dispatched,
    clearSightTimerSec: 0,
    distanceToSafehouseM: target.safehouseEscapeDistanceM,
    carDamage: 0,
    vehicleDamage: 0,
    vehicleRecognized: alarmLevel === 'lockdown',
    escaped: false,
    busted: false,
    gear: 1,
    rpm: 900,
    throttle: 0,
    headlightsOn: true,
    isDrifting: false,
    skidIntensity: 0,
    policeLosCooldown: 0,
    policeStatus: dispatched ? 'pursuit' : 'evaded',
    policeDispatchEtaSec: dispatched ? 0 : undefined,
    safehouseLocked: dispatched,
    paintScrapeTrace: false,
  };
}

function addEvidenceDraftOnce(
  state: LiveExecutionState,
  draft: LiveExecutionState['pendingEvidence'][number]
) {
  const exists = state.pendingEvidence.some(
    (e) =>
      e.type === draft.type &&
      e.relatedCrewId === draft.relatedCrewId &&
      e.title === draft.title
  );
  if (!exists) {
    state.pendingEvidence.push(draft);
  }
}

function escalateAlarm(
  state: LiveExecutionState,
  targetLevel: LiveExecutionState['alarmLevel'],
  hasJammer = false
) {
  const order: LiveExecutionState['alarmLevel'][] = [
    'silent',
    'suspicious',
    'alarm',
    'lockdown',
  ];
  if (order.indexOf(targetLevel) > order.indexOf(state.alarmLevel)) {
    state.alarmLevel = targetLevel;
  }
  if (
    (state.alarmLevel === 'alarm' || state.alarmLevel === 'lockdown') &&
    state.policeEtaSec === null
  ) {
    state.policeEtaSec = hasJammer ? 80 : 55;
    state.compromised = true;
  }
}

export function applyRadioCommand(
  live: LiveExecutionState,
  command: RadioCommandType,
  resolvedPlan: ResolvedPlan,
  targetCrewId: CrewId | 'all' = 'all'
): LiveExecutionState {
  const next: LiveExecutionState = structuredClone(live);
  const labels: Record<RadioCommandType, string> = {
    hold: 'FUNK: Alle Position halten!',
    resume: 'FUNK: Weiter nach Plan!',
    plan_b: 'FUNK: PLAN B auslösen!',
    abort: 'FUNK: ABBRUCH — Alle zum Fluchtwagen!',
  };

  next.radioLog.unshift({
    id: `rad_${next.radioLog.length + 1}_${Math.round(next.elapsedSec * 10)}`,
    command,
    targetCrewId,
    issuedAtSec: next.elapsedSec,
    label: labels[command],
  });

  if (command === 'hold') {
    next.holdActive = true;
    for (const c of Object.values(next.crew)) {
      if (targetCrewId !== 'all' && c.crewId !== targetCrewId) continue;
      if (c.state !== 'extracted' && c.state !== 'caught') {
        c.state = 'holding';
        c.activeActionLabel = 'Hält Position (Funkbefehl)';
      }
    }
  } else if (command === 'resume') {
    next.holdActive = false;
    for (const c of Object.values(next.crew)) {
      if (targetCrewId !== 'all' && c.crewId !== targetCrewId) continue;
      if (c.state === 'holding') {
        c.state = 'idle';
        c.activeActionLabel = 'Setzt Plan fort';
      }
    }
  } else if (command === 'plan_b') {
    next.holdActive = false;
    next.planBActive = true;
    for (const c of Object.values(next.crew)) {
      if (targetCrewId !== 'all' && c.crewId !== targetCrewId) continue;
      if (c.state === 'extracted' || c.state === 'caught') continue;
      c.usingPlanB = true;
      c.extraLootTargetNodeId = null;
      c.activePath = undefined;
      c.activePathGoalKey = undefined;
      const branch = selectPlanBBranch(resolvedPlan.plan, c.crewId, 'manual_radio');
      c.state = 'fleeing';
      c.activeActionLabel = branch
        ? `Plan B: ${branch.label}`
        : 'Plan B: Rückzug zum Wagen';
      next.deviations.push({
        id: `dev_pb_${c.crewId}_${next.deviations.length}`,
        timeSec: next.elapsedSec,
        crewId: c.crewId,
        kind: 'plan_b_engaged',
        title: `${c.crewId.toUpperCase()} schwenkt auf Plan B`,
        detail: branch?.label ?? 'Direkter Rückzug zum Fluchtwagen.',
        severity: 'info',
        pos: { ...c.pos },
        floor: c.floor,
      });
    }
  } else if (command === 'abort') {
    next.holdActive = false;
    next.abortActive = true;
    for (const c of Object.values(next.crew)) {
      if (c.state === 'extracted' || c.state === 'caught') continue;
      c.state = 'fleeing';
      c.extraLootTargetNodeId = null;
      c.activePath = undefined;
      c.activePathGoalKey = undefined;
      c.activeActionLabel = 'ABBRUCH — Sprint zum Fluchtwagen';
    }
  }

  return next;
}

function completeNodeEffect(
  state: LiveExecutionState,
  target: HeistTarget,
  node: TargetNode,
  actorCrewId: CrewId,
  actionType: ActionBlock['type'] | 'interact',
  options?: {
    usedTool?: string;
    hasJammer?: boolean;
    outcome?: InteractOutcome;
  }
) {
  if (!state.completedNodeIds.includes(node.id)) {
    state.completedNodeIds.push(node.id);
  }

  const usedCrowbar =
    options?.usedTool === 'crowbar' || options?.outcome?.usedTool === 'crowbar';
  const brokeGlass =
    Boolean(options?.outcome?.brokenGlass) ||
    (usedCrowbar && (node.kind === 'loot_case' || node.kind === 'entry_window'));

  if (brokeGlass && !state.brokenGlassNodes.includes(node.id)) {
    state.brokenGlassNodes.push(node.id);
    pushNoisePulse(state, {
      pos: node.pos,
      floor: node.floor,
      noiseDb: 94,
      sourceCrewId: actorCrewId,
      label: `Glasbruch (${node.label})`,
    });
  }

  // Unlocking doors/windows/hatches updates persistent world state for 3D doors & guards!
  if (
    node.isAccessPoint ||
    node.kind === 'lock' ||
    actionType === 'enter' ||
    actionType === 'pick_lock'
  ) {
    if (!state.unlockedDoorIds.includes(node.id)) {
      state.unlockedDoorIds.push(node.id);
    }
  }

  if (node.kind === 'power_box' || actionType === 'cut_power') {
    state.powerDisabled = true;
    state.powerCutRooms = target.rooms
      .filter((r) => r.kind !== 'street' && r.kind !== 'roof')
      .map((r) => r.id);
    state.roomLightLevels = computeRoomLightLevels(
      target,
      true,
      state.powerCutRooms
    );
    for (const cam of state.cameras) {
      cam.active = false;
    }
    for (const g of state.guards) {
      g.flashlightOn = true;
    }
  } else if (node.kind === 'alarm_panel' || actionType === 'bypass_alarm') {
    state.alarmBypassed = true;
  } else if (node.kind === 'camera' || actionType === 'loop_camera') {
    const cam = state.cameras.find((c) => c.nodeId === node.id);
    if (cam) {
      cam.looped = true;
      cam.active = false;
    }
  } else if (node.kind === 'safe' || node.kind === 'loot_case') {
    if (!state.openedContainerIds.includes(node.id)) {
      state.openedContainerIds.push(node.id);
    }

    if (
      node.alarmLinkedNodeId &&
      !state.alarmBypassed &&
      !state.completedNodeIds.includes(node.alarmLinkedNodeId)
    ) {
      escalateAlarm(state, 'alarm', options?.hasJammer);
      state.alarmProgress = Math.max(state.alarmProgress, 100);
      addEvidenceDraftOnce(state, {
        type: 'alarm_signature',
        title: `Tresoralarm ausgelöst (${node.label})`,
        detail: 'Alarm-gekoppeltes Objekt wurde ohne vorherige Überbrückung geöffnet.',
        targetId: state.targetId,
        severity: 16,
        relatedCrewId: actorCrewId,
      });
    }

    const alreadyCollected = state.collectedLoot.some((l) => l.nodeId === node.id);
    if (!alreadyCollected && node.lootValue && node.lootCategory) {
      const item: CollectedLootItem = {
        nodeId: node.id,
        label: node.lootLabel ?? node.label,
        category: node.lootCategory,
        valueEur: node.lootValue,
        collectedBy: actorCrewId,
      };
      state.collectedLoot.push(item);
      state.totalLootEur += item.valueEur;
      const actor = state.crew[actorCrewId];
      if (actor) {
        actor.carryingLootEur += item.valueEur;
        actor.carryingLootItems.push(item);
        actor.carryWeightPenalty = computeCarryWeightPenalty(
          actor.carryingLootItems.length,
          actor.carryingLootEur
        );
      }
    }
  }
}

/**
 * Resolves a live player (Mara) interaction with a node, accepting optional
 * minigame InteractOutcome (clean success, noisy slip, tamper trip, crowbar glass break).
 */
export function playerInteractWithNode(
  live: LiveExecutionState,
  target: HeistTarget,
  nodeId: string,
  outcome?: InteractOutcome
): LiveExecutionState {
  const next: LiveExecutionState = structuredClone(live);
  const node = target.nodes.find((n) => n.id === nodeId);
  if (!node) return next;

  const mara = next.crew.mara;
  if (outcome?.trippedAlarm) {
    escalateAlarm(next, 'alarm');
    next.alarmProgress = 100;
    pushNoisePulse(next, {
      pos: node.pos,
      floor: node.floor,
      noiseDb: 96,
      sourceCrewId: 'mara',
      label: `Sabotage-Alarm (${node.label})`,
    });
    addEvidenceDraftOnce(next, {
      type: 'alarm_signature',
      title: `Sabotage-Kontakt ausgelöst (${node.label})`,
      detail: 'Fehlgeschlagene Überbrückung der Securion-Schaltung meldete sofortigen Eingriff.',
      targetId: target.id,
      severity: 18,
      relatedCrewId: 'mara',
    });
    if (mara) {
      mara.activeActionLabel = `Fehlgeschlagen: ${node.label}`;
    }
    return next;
  }

  if (mara) {
    mara.activeActionLabel = `Abgeschlossen: ${node.label}`;
  }

  completeNodeEffect(next, target, node, 'mara', 'interact', { outcome });

  const baseNoiseDb = 30 + node.noiseLevel * 0.65 + (outcome?.noiseDelta ?? 0);
  pushNoisePulse(next, {
    pos: node.pos,
    floor: node.floor,
    noiseDb: baseNoiseDb,
    sourceCrewId: 'mara',
    label: node.label,
  });

  if (outcome?.traceDelta && outcome.traceDelta >= 10) {
    addEvidenceDraftOnce(next, {
      type: 'fingerprints',
      title: `Werkzeugspuren (${node.label})`,
      detail: 'Abgerutschtes Werkzeug hinterließ deutliche Kratzer am Schließzylinder.',
      targetId: target.id,
      severity: 9,
      relatedCrewId: 'mara',
    });
  }

  if (node.kind === 'getaway_zone') {
    if (mara) {
      mara.state = 'extracted';
      mara.pos = { ...target.getawayPos };
    }
    next.readyForEscape = true;
  }

  return next;
}

export function computeStealthTelemetry(
  live: LiveExecutionState,
  target: HeistTarget,
  crewById: Record<CrewId, CrewMember>,
  forensicByCrew?: Partial<Record<CrewId, ForensicLoadout>>
): StealthTelemetry {
  const mara = live.crew.mara;
  const maraMember = crewById.mara;
  const maraForensic =
    maraMember ? getEffectiveForensicLoadout({ forensicLoadoutByCrew: forensicByCrew } as ResolvedPlan['plan'], maraMember) : undefined;

  const lightExposure = mara
    ? sampleLightExposureAt(target, mara.pos, mara.floor, live.roomLightLevels, {
        darkClothing: Boolean(maraForensic?.darkClothing),
        sneaking: mara.sneaking,
      })
    : 0.45;

  const peakPulseDb = live.noiseEvents.reduce(
    (max, p) => (live.elapsedSec - p.emittedAtSec <= 2.2 ? Math.max(max, p.noiseDb) : max),
    24
  );
  const noiseDb = Math.max(peakPulseDb, Math.round(22 + live.noiseLevel * 0.78));

  let highestSuspicion = 0;
  let suspicionGuardId: string | null = null;
  let suspicionSourceAngle: number | null = null;
  let guardState: StealthTelemetry['guardState'] = 'patrol';
  let radioInterruptWindowSec: number | null = null;

  for (const g of live.guards) {
    if (g.state === 'radioing' && g.radioDurationSec) {
      const rem = Math.max(0, g.radioDurationSec * (1 - (g.radioProgress ?? 0)));
      if (radioInterruptWindowSec === null || rem < radioInterruptWindowSec) {
        radioInterruptWindowSec = Math.round(rem * 10) / 10;
      }
    }
    if (g.suspicion > highestSuspicion) {
      highestSuspicion = Math.round(g.suspicion);
      suspicionGuardId = g.guardId;
      guardState = g.state;
      if (mara) {
        suspicionSourceAngle = Math.round(headingBetween(mara.pos, g.pos));
      }
    }
  }

  for (const cam of live.cameras) {
    if (cam.active && cam.suspicion > highestSuspicion) {
      highestSuspicion = Math.round(cam.suspicion);
      suspicionGuardId = cam.nodeId;
      if (mara) {
        suspicionSourceAngle = Math.round(headingBetween(mara.pos, cam.pos));
      }
    }
  }

  return {
    lightExposure,
    noiseDb,
    highestSuspicion,
    suspicionSourceAngle,
    suspicionGuardId,
    guardState,
    radioInterruptWindowSec,
    carryWeightPenalty: mara?.carryWeightPenalty ?? 0,
  };
}

export interface LiveTickOptions {
  /** If true, Mara's position is driven externally by 3D WASD controller */
  playerSteeredExternally?: boolean;
  /** Workshop radio scrambler reduces deviation probability */
  hasRadioScrambler?: boolean;
  /** If true, @npc-brain's 3D GuardSystem drives guards and syncs via syncLiveGuards */
  skipGuardTick?: boolean;
}

/**
 * Advances live heist execution by `dtSec` seconds against the REAL `HeistTarget`.
 */
export function tickLiveExecution(params: {
  live: LiveExecutionState;
  dtSec: number;
  target: HeistTarget;
  resolvedPlan: ResolvedPlan;
  crewById: Record<CrewId, CrewMember>;
  options?: LiveTickOptions;
}): LiveExecutionState {
  const { live, target, resolvedPlan, crewById, options = {} } = params;
  if (live.paused) return live;

  const dt = Math.max(0.01, Math.min(0.5, params.dtSec));
  const next: LiveExecutionState = structuredClone(live);
  next.elapsedSec = Math.round((next.elapsedSec + dt) * 100) / 100;
  next.noiseLevel = Math.max(0, next.noiseLevel - dt * 18);

  // Expire old positional noise pulses
  next.noiseEvents = next.noiseEvents.filter(
    (p) => next.elapsedSec - p.emittedAtSec <= NOISE_PULSE_TTL_SEC
  );

  // Refresh continuous room lighting
  next.roomLightLevels = computeRoomLightLevels(
    target,
    next.powerDisabled,
    next.powerCutRooms
  );

  const nodesById: Record<string, TargetNode> = {};
  for (const n of target.nodes) nodesById[n.id] = n;

  // Check if any assigned crew member carries a signal_jammer!
  const teamHasJammer = resolvedPlan.plan.assignedCrewIds.some((cid) =>
    crewById[cid]?.equippedTools.includes('signal_jammer')
  );

  // Completed blocks across crew for SyncBarrier unlocking
  const allCompletedBlockIds = new Set<string>();
  for (const c of Object.values(next.crew)) {
    for (const bid of c.completedBlockIds) allCompletedBlockIds.add(bid);
  }

  const maraBlocks = resolvedPlan.orderedBlocksByCrew.mara ?? [];
  if (next.crew.mara) {
    for (const b of maraBlocks) {
      if (
        b.targetNodeId &&
        next.completedNodeIds.includes(b.targetNodeId) &&
        !next.crew.mara.completedBlockIds.includes(b.id)
      ) {
        next.crew.mara.completedBlockIds.push(b.id);
        allCompletedBlockIds.add(b.id);
      }
    }
  }

  // Auto Plan B trigger on full alarm
  if (
    (next.alarmLevel === 'alarm' || next.alarmLevel === 'lockdown') &&
    !next.planBActive &&
    !next.abortActive
  ) {
    for (const c of Object.values(next.crew)) {
      if (c.crewId === 'mara' && options.playerSteeredExternally) continue;
      if (c.usingPlanB || c.state === 'extracted' || c.state === 'caught') continue;
      const branch = selectPlanBBranch(resolvedPlan.plan, c.crewId, 'on_alarm');
      if (branch) {
        c.usingPlanB = true;
        c.state = 'fleeing';
        c.activePath = undefined;
        c.activePathGoalKey = undefined;
        c.activeActionLabel = `Plan B: ${branch.label}`;
        next.deviations.push({
          id: `dev_auto_pb_${c.crewId}_${next.deviations.length}`,
          timeSec: next.elapsedSec,
          crewId: c.crewId,
          kind: 'plan_b_engaged',
          title: `${crewById[c.crewId]?.name ?? c.crewId}: Plan B aktiv`,
          detail: branch.label,
          severity: 'warning',
          pos: { ...c.pos },
          floor: c.floor,
        });
      }
    }
  }

  // Helper: move crew member along cached wall-respecting A* path to (goalPos, goalFloor)
  const moveCrewWithPath = (
    c: LiveCrewState,
    goalPos: Vec2,
    goalFloor: FloorId,
    goalKey: string,
    speedMps: number,
    goalNodeId?: string
  ): boolean => {
    const carryPenalty = c.carryWeightPenalty ?? 0;
    const effectiveSpeed = Math.max(1.2, speedMps * (1 - carryPenalty));
    if (!c.activePath || c.activePathGoalKey !== goalKey) {
      const res = findTargetPath(target, c.pos, c.floor, goalPos, goalFloor, {
        unlockedNodeIds: next.unlockedDoorIds,
        respectLockedDoors: false,
        goalNodeId,
      });
      c.activePath = res.waypoints;
      c.activePathIndex = 1;
      c.activePathGoalKey = goalKey;
    }

    const adv = advanceAlongPath({
      pos: c.pos,
      floor: c.floor,
      path: c.activePath,
      pathIndex: c.activePathIndex ?? 1,
      speedMps: effectiveSpeed,
      dt,
    });
    c.pos = adv.pos;
    c.floor = adv.floor;
    c.headingDeg = adv.headingDeg;
    c.activePathIndex = adv.pathIndex;
    c.speed = adv.arrived ? 0 : effectiveSpeed;
    if (adv.arrived) {
      c.activePath = undefined;
      c.activePathGoalKey = undefined;
    }
    return adv.arrived;
  };

  // 1) Update each Crew Member
  for (const cid of resolvedPlan.plan.assignedCrewIds) {
    const c = next.crew[cid];
    const member = crewById[cid];
    if (!c || !member) continue;
    if (c.state === 'extracted' || c.state === 'caught') continue;

    c.carryWeightPenalty = computeCarryWeightPenalty(
      c.carryingLootItems.length,
      c.carryingLootEur
    );

    if (cid === 'mara' && options.playerSteeredExternally) {
      if (
        next.collectedLoot.length > 0 &&
        c.floor === 0 &&
        distance2D(c.pos, target.getawayPos) < 3.2
      ) {
        next.readyForEscape = true;
      }
      continue;
    }

    if (next.holdActive || c.state === 'holding') {
      c.speed = 0;
      c.state = 'holding';
      continue;
    }

    if (next.alarmLevel === 'alarm' || next.alarmLevel === 'lockdown') {
      c.stress = Math.min(100, c.stress + dt * (110 - member.traits.nerves) * 0.18);
    } else if (next.alarmLevel === 'suspicious') {
      c.stress = Math.min(100, c.stress + dt * (100 - member.traits.nerves) * 0.08);
    } else {
      c.stress = Math.max(0, c.stress - dt * 5);
    }

    // Fleeing / Plan B / Abort along real A* escape path
    if (next.abortActive || c.usingPlanB || c.state === 'fleeing') {
      const sprintSpeed = 3.8 + member.skills.climbing * 0.1;
      const arrived = moveCrewWithPath(
        c,
        target.getawayPos,
        0,
        `flee_${cid}`,
        sprintSpeed
      );
      if (arrived) {
        c.state = 'extracted';
        c.speed = 0;
        c.activeActionLabel = 'Im Fluchtwagen';
      }
      continue;
    }

    // Greed extra loot detour via A*
    if (c.extraLootTargetNodeId) {
      const extraNode = nodesById[c.extraLootTargetNodeId];
      if (!extraNode || next.completedNodeIds.includes(extraNode.id)) {
        c.extraLootTargetNodeId = null;
        c.deviationActive = null;
      } else {
        const arrived = moveCrewWithPath(
          c,
          extraNode.pos,
          extraNode.floor,
          `greed_${extraNode.id}`,
          2.9,
          extraNode.id
        );
        c.state = 'deviating';
        c.activeActionLabel = `GIER: Greift nach ${extraNode.label}!`;
        if (arrived) {
          c.blockProgress += dt / Math.max(3, extraNode.baseDurationSec * 0.7);
          const forensic = getEffectiveForensicLoadout(resolvedPlan.plan, member);
          if (c.blockProgress >= 1) {
            completeNodeEffect(next, target, extraNode, cid, 'grab_loot', {
              usedTool: forensic.entryTool,
              hasJammer: teamHasJammer,
            });
            pushNoisePulse(next, {
              pos: extraNode.pos,
              floor: extraNode.floor,
              noiseDb: 45 + extraNode.noiseLevel * 0.5,
              sourceCrewId: cid,
              label: `Gier-Beute (${extraNode.label})`,
            });
            c.blockProgress = 0;
            c.extraLootTargetNodeId = null;
            c.deviationActive = null;
          }
        }
        continue;
      }
    }

    const track = resolvedPlan.orderedBlocksByCrew[cid] ?? [];
    if (c.activeBlockIndex >= track.length) {
      c.state = distance2D(c.pos, target.getawayPos) < 3.0 ? 'extracted' : 'idle';
      c.activeBlockId = null;
      c.speed = 0;
      continue;
    }

    const block = track[c.activeBlockIndex];
    c.activeBlockId = block.id;

    // Check SyncBarrier dependencies
    const requiredSyncs = resolvedPlan.plan.syncBarriers.filter(
      (sb) => sb.toBlockId === block.id
    );
    const waitingSync = requiredSyncs.find(
      (sb) => !allCompletedBlockIds.has(sb.fromBlockId)
    );
    if (waitingSync) {
      c.state = 'waiting_sync';
      c.speed = 0;
      c.activeActionLabel = `Wartet: ${waitingSync.label}`;
      continue;
    }

    if (c.activeBlockIndex === 0 && next.elapsedSec < block.startSec) {
      c.state = 'idle';
      c.speed = 0;
      c.activeActionLabel = `Startet bei ${block.startSec.toFixed(0)}s`;
      continue;
    }

    // Move along A* corridor path to block destination
    const walkSpeed = c.sneaking ? 1.8 : 2.75 + (member.skills.climbing - 5) * 0.08;
    const arrived = moveCrewWithPath(
      c,
      block.targetPos,
      block.floor,
      `blk_${block.id}`,
      walkSpeed,
      block.targetNodeId
    );
    if (!arrived) {
      c.state = 'moving';
      c.activeActionLabel = `Unterwegs: ${block.label}`;
      // Carrying heavy loot increases footstep noise
      if (c.carryingLootItems.length >= 2 && !c.sneaking) {
        pushNoisePulse(next, {
          pos: c.pos,
          floor: c.floor,
          noiseDb: 38 + c.carryingLootItems.length * 8,
          sourceCrewId: cid,
          label: 'Schwere Schritte (Beute)',
        });
      }
      continue;
    }

    // Arrived — execute work block
    c.pos = { ...block.targetPos };
    c.floor = block.floor;
    c.speed = 0;
    c.state = 'working';
    c.activeActionLabel = block.label;

    let workRateMultiplier = 1.0;
    if (
      member.traits.nerves >= 80 &&
      next.alarmLevel !== 'silent' &&
      c.deviationActive !== 'nerves_improvise'
    ) {
      workRateMultiplier = 1.25;
      c.deviationActive = 'nerves_improvise';
      next.deviations.push({
        id: `dev_imp_${cid}_${next.deviations.length}`,
        timeSec: next.elapsedSec,
        crewId: cid,
        kind: 'nerves_improvise',
        title: `${member.name} bleibt eiskalt`,
        detail: 'Hohe Nervenstärke: improvisiert schneller und ruhiger trotz Druck.',
        severity: 'info',
        pos: { ...c.pos },
        floor: c.floor,
      });
    }

    const scramblerFactor = options.hasRadioScrambler ? 0.65 : 1.0;
    if (
      member.traits.nerves <= 55 &&
      c.stress >= 42 &&
      c.deviationActive !== 'panic_noise' &&
      c.deviationActive !== 'panic_abort'
    ) {
      const r = nextRng(next.rngState);
      next.rngState = r.nextState;
      if (r.value < 0.35 * scramblerFactor) {
        if (c.stress >= 72) {
          c.deviationActive = 'panic_abort';
          c.state = 'fleeing';
          c.activePath = undefined;
          c.activePathGoalKey = undefined;
          c.activeActionLabel = 'PANIK: Bricht ab & flieht!';
          next.deviations.push({
            id: `dev_pan_ab_${cid}_${next.deviations.length}`,
            timeSec: next.elapsedSec,
            crewId: cid,
            kind: 'panic_abort',
            title: `${member.name} verliert die Nerven!`,
            detail: 'Bricht die Aktion ab und rennt unkontrolliert zum Fluchtwagen.',
            severity: 'critical',
            pos: { ...c.pos },
            floor: c.floor,
          });
          continue;
        } else {
          c.deviationActive = 'panic_noise';
          pushNoisePulse(next, {
            pos: c.pos,
            floor: c.floor,
            noiseDb: 88,
            sourceCrewId: cid,
            label: `Lärm-Patzer (${member.name})`,
          });
          next.deviations.push({
            id: `dev_pan_n_${cid}_${next.deviations.length}`,
            timeSec: next.elapsedSec,
            crewId: cid,
            kind: 'panic_noise',
            title: `${member.name} macht Lärm!`,
            detail: 'Hektischer Werkzeug-Patzer — Wachen in der Nähe werden aufmerksam!',
            severity: 'warning',
            pos: { ...c.pos },
            floor: c.floor,
          });
        }
      }
    }

    const workDur = Math.max(1.5, block.durationSec * 0.62);
    c.blockProgress = Math.min(1, c.blockProgress + (dt * workRateMultiplier) / workDur);

    if (block.estimatedNoise >= 35) {
      pushNoisePulse(next, {
        pos: c.pos,
        floor: c.floor,
        noiseDb: 26 + block.estimatedNoise * 0.72,
        sourceCrewId: cid,
        label: block.label,
      });
    }

    if (c.blockProgress >= 1) {
      c.blockProgress = 0;
      c.completedBlockIds.push(block.id);
      allCompletedBlockIds.add(block.id);
      c.activeBlockIndex += 1;

      if (block.targetNodeId && nodesById[block.targetNodeId]) {
        const forensic = getEffectiveForensicLoadout(resolvedPlan.plan, member);
        completeNodeEffect(next, target, nodesById[block.targetNodeId], cid, block.type, {
          usedTool: block.toolId ?? forensic.entryTool,
          hasJammer: teamHasJammer,
        });
      }

      if (block.type === 'extract') {
        c.state = 'extracted';
        c.activeActionLabel = 'Im Fluchtwagen';
        continue;
      }

      if (
        (block.type === 'grab_loot' || block.type === 'crack_safe') &&
        member.traits.greed >= 70 &&
        next.alarmLevel !== 'lockdown' &&
        c.deviationActive !== 'greed_extra_loot' &&
        c.deviationActive !== 'panic_abort'
      ) {
        const extraLoot = target.nodes.find(
          (n) =>
            n.kind === 'loot_case' &&
            n.floor === c.floor &&
            !next.completedNodeIds.includes(n.id) &&
            distance2D(c.pos, n.pos) <= 15
        );
        if (extraLoot) {
          c.extraLootTargetNodeId = extraLoot.id;
          c.deviationActive = 'greed_extra_loot';
          next.deviations.push({
            id: `dev_greed_${cid}_${next.deviations.length}`,
            timeSec: next.elapsedSec,
            crewId: cid,
            kind: 'greed_extra_loot',
            title: `${member.name} greift nach Extra-Beute!`,
            detail: `Gier (${member.traits.greed}): weicht vom Zeitplan ab für „${extraLoot.label}“.`,
            severity: 'warning',
            pos: { ...c.pos },
            floor: c.floor,
          });
        }
      }
    }
  }

  // 2) Hidden Traps against ACTUAL world
  for (const node of target.nodes) {
    if (!node.isHiddenHazard) continue;
    if (next.triggeredHazardNodeIds.includes(node.id)) continue;
    if (next.completedNodeIds.includes(node.id)) continue;
    if (next.powerDisabled && node.poweredByNodeId) continue;

    for (const c of Object.values(next.crew)) {
      if (c.state === 'extracted' || c.state === 'caught') continue;
      if (c.floor === node.floor && distance2D(c.pos, node.pos) < 2.2) {
        next.triggeredHazardNodeIds.push(node.id);
        escalateAlarm(next, 'alarm', teamHasJammer);
        next.alarmProgress = 100;
        pushNoisePulse(next, {
          pos: node.pos,
          floor: node.floor,
          noiseDb: 92,
          sourceCrewId: c.crewId,
          label: `Sensor ausgelöst (${node.label})`,
        });
        next.deviations.push({
          id: `dev_trap_${node.id}`,
          timeSec: next.elapsedSec,
          crewId: c.crewId,
          kind: 'hidden_trap_triggered',
          title: `Verborgene Falle ausgelöst: ${node.label}!`,
          detail: `${crewById[c.crewId]?.name ?? c.crewId} tappte in einen nicht ausgekundschafteten Sensor.`,
          severity: 'critical',
          pos: { ...node.pos },
          floor: node.floor,
        });
        addEvidenceDraftOnce(next, {
          type: 'alarm_signature',
          title: `Sensor-Auslösung (${node.label})`,
          detail: 'Unentdeckter Bewegungskontakt meldete sofortigen Einbruch.',
          targetId: target.id,
          severity: 14,
          relatedCrewId: c.crewId,
        });
      }
    }
  }

  // 3) Cameras & CCTV Sightlines (Wall-Occluded)
  for (const cam of next.cameras) {
    const node = nodesById[cam.nodeId];
    if (!node) continue;
    cam.active = !next.powerDisabled && !cam.looped;
    if (!cam.active) {
      cam.suspicion = Math.max(0, cam.suspicion - dt * 30);
      continue;
    }
    cam.headingDeg = sampleCameraHeading(node, next.elapsedSec);

    let spottedAny = false;
    for (const c of Object.values(next.crew)) {
      if (c.state === 'extracted' || c.state === 'caught') continue;
      if (distance2D(c.pos, target.getawayPos) < 2.5) continue;
      if (
        isPointInVisionCone({
          observerPos: cam.pos,
          observerFloor: cam.floor,
          headingDeg: cam.headingDeg,
          range: cam.range,
          coneDeg: 55,
          targetPos: c.pos,
          targetFloor: c.floor,
          walls: target.walls,
        })
      ) {
        spottedAny = true;
        cam.suspicion = Math.min(100, cam.suspicion + dt * 62);
        next.alarmProgress = Math.min(100, next.alarmProgress + dt * 35);
        if (cam.suspicion >= 45) {
          escalateAlarm(next, 'suspicious', teamHasJammer);
          addEvidenceDraftOnce(next, {
            type: 'camera_footage',
            title: `Überwachungskamera (${node.label})`,
            detail: `Aktive Kamera zeichnete ${crewById[c.crewId]?.name ?? c.crewId} auf.`,
            targetId: target.id,
            severity: 16,
            relatedCrewId: c.crewId,
          });
        }
        if (cam.suspicion >= 95) {
          escalateAlarm(next, 'alarm', teamHasJammer);
        }
      }
    }
    if (!spottedAny) {
      cam.suspicion = Math.max(0, cam.suspicion - dt * 18);
    }
  }

  // 4) Multi-State Guards (skipped if @npc-brain's GuardSystem owns live 3D guard tick)
  if (!options.skipGuardTick) {
    const radioDur = BASE_RADIO_DISPATCH_SEC + (teamHasJammer ? JAMMER_RADIO_BONUS_SEC : 0);

    for (const gState of next.guards) {
      const gDef = target.guards.find((g) => g.id === gState.guardId);
      if (!gDef) continue;
      gState.radioDurationSec = radioDur;
      if (!gState.noticedAnomalyIds) gState.noticedAnomalyIds = [];

      // Radioing state: interruptible ~3.5s (or 6s with jammer) dispatch window!
      if (gState.state === 'radioing') {
        gState.radioProgress = Math.min(
          1,
          (gState.radioProgress ?? 0) + dt / radioDur
        );
        gState.calloutText = 'Funkt Leitstelle an!';
        if (gState.radioProgress >= 1) {
          gState.state = 'pursuit';
          gState.calloutText = 'Alarm ausgelöst — Verstärkung unterwegs!';
          escalateAlarm(next, 'alarm', teamHasJammer);
        }
        continue;
      }

      // Movement along A* path for investigating/searching/pursuit, or patrol loop
      if (
        (gState.state === 'investigating' ||
          gState.state === 'pursuit' ||
          gState.state === 'searching') &&
        gState.investigatePos
      ) {
        const moveSpd =
          gState.state === 'pursuit' ? gDef.speedMps * 1.45 : gDef.speedMps * 1.1;
        if (!gState.pathWaypoints || gState.pathWaypoints.length === 0) {
          gState.pathWaypoints = findTargetPath(
            target,
            gState.pos,
            gState.floor,
            gState.investigatePos,
            gState.floor,
            { respectLockedDoors: false }
          ).waypoints;
          gState.pathIndex = 1;
        }
        const adv = advanceAlongPath({
          pos: gState.pos,
          floor: gState.floor,
          path: gState.pathWaypoints,
          pathIndex: gState.pathIndex ?? 1,
          speedMps: moveSpd,
          dt,
        });
        gState.pos = adv.pos;
        gState.headingDeg = adv.headingDeg;
        gState.pathIndex = adv.pathIndex;
        if (adv.arrived) {
          gState.pathWaypoints = undefined;
          gState.pauseRemainingSec -= dt;
          // Sweep head/flashlight left & right while searching
          gState.headingDeg =
            (gState.headingDeg + Math.sin(next.elapsedSec * 2.4) * 50 * dt + 360) %
            360;
          if (gState.pauseRemainingSec <= 0) {
            gState.state = 'patrol';
            gState.investigatePos = undefined;
            gState.calloutText = undefined;
          }
        }
      } else if (gDef.waypoints.length > 0) {
        const curWp = gDef.waypoints[gState.waypointIndex % gDef.waypoints.length];
        const nextIdx = (gState.waypointIndex + 1) % gDef.waypoints.length;
        const nextWp = gDef.waypoints[nextIdx];

        if (gState.pauseRemainingSec > 0) {
          gState.pauseRemainingSec = Math.max(0, gState.pauseRemainingSec - dt);
          gState.headingDeg =
            curWp.lookAngleDeg ?? headingBetween(gState.pos, nextWp.pos);
        } else {
          const m = stepTowardsPoint(gState.pos, nextWp.pos, gDef.speedMps * dt);
          gState.pos = m.pos;
          gState.floor = nextWp.floor;
          gState.headingDeg = m.headingDeg;
          if (m.arrived) {
            gState.waypointIndex = nextIdx;
            gState.pauseRemainingSec = nextWp.pauseSec;
          }
        }
      }

      // Environmental anomaly awareness: broken glass / opened containers / cut power
      for (const anomalyId of [...next.brokenGlassNodes, ...next.openedContainerIds]) {
        if (gState.noticedAnomalyIds.includes(anomalyId)) continue;
        const aNode = nodesById[anomalyId];
        if (!aNode || aNode.floor !== gState.floor) continue;
        if (
          isPointInVisionCone({
            observerPos: gState.pos,
            observerFloor: gState.floor,
            headingDeg: gState.headingDeg,
            range: gDef.visionRange * 0.75,
            coneDeg: gDef.visionConeDeg,
            targetPos: aNode.pos,
            targetFloor: aNode.floor,
            walls: target.walls,
          })
        ) {
          gState.noticedAnomalyIds.push(anomalyId);
          gState.state = 'investigating';
          gState.investigatePos = { ...aNode.pos };
          gState.investigateReason = next.brokenGlassNodes.includes(anomalyId)
            ? 'glass'
            : 'loot';
          gState.pathWaypoints = undefined;
          gState.pauseRemainingSec = 4;
          gState.suspicion = Math.max(gState.suspicion, 55);
          gState.calloutText = `Anomalie entdeckt: ${aNode.label}!`;
          escalateAlarm(next, 'suspicious', teamHasJammer);
        }
      }

      // Vision detection with continuous light exposure + forensic gear
      let seesCrew = false;
      for (const c of Object.values(next.crew)) {
        if (c.state === 'extracted' || c.state === 'caught') continue;
        if (distance2D(c.pos, target.getawayPos) < 2.5 && gDef.visibleFromStreet) {
          continue;
        }

        const member = crewById[c.crewId];
        const forensic = member
          ? getEffectiveForensicLoadout(resolvedPlan.plan, member)
          : undefined;
        const crewRoom = findRoomAt(target, c.pos, c.floor);
        const activeBlock = c.activeBlockId
          ? resolvedPlan.blocksById[c.activeBlockId]
          : undefined;
        const doingOvertCrime =
          c.state === 'working' &&
          activeBlock?.type !== 'lookout' &&
          activeBlock?.type !== 'wait' &&
          activeBlock?.type !== 'stage_car';
        const wearingMaskInPublic =
          crewRoom?.securityZone === 'public' && Boolean(forensic?.mask);
        const isPublicPedestrian =
          crewRoom?.securityZone === 'public' &&
          !doingOvertCrime &&
          !wearingMaskInPublic &&
          c.carryingLootEur === 0 &&
          next.alarmLevel !== 'alarm' &&
          next.alarmLevel !== 'lockdown';
        if (isPublicPedestrian) continue;

        const lightExp = sampleLightExposureAt(
          target,
          c.pos,
          c.floor,
          next.roomLightLevels,
          {
            darkClothing: Boolean(forensic?.darkClothing),
            sneaking: c.sneaking,
          }
        );
        const effectiveRange = gDef.visionRange * (0.42 + lightExp * 0.68);
        const hasDisguise = Boolean(member?.equippedTools.includes('disguise_kit'));
        const disguiseSlowdown =
          hasDisguise && !doingOvertCrime && c.carryingLootEur === 0 ? 0.6 : 1.0;

        if (
          isPointInVisionCone({
            observerPos: gState.pos,
            observerFloor: gState.floor,
            headingDeg: gState.headingDeg,
            range: effectiveRange,
            coneDeg: gDef.visionConeDeg,
            targetPos: c.pos,
            targetFloor: c.floor,
            walls: target.walls,
          })
        ) {
          seesCrew = true;
          const baseRate = 100 / Math.max(0.6, gDef.alertThresholdSec);
          const maskPublicBoost = wearingMaskInPublic ? 1.35 : 1.0;
          const rate = baseRate * disguiseSlowdown * maskPublicBoost;
          gState.suspicion = Math.min(100, gState.suspicion + dt * rate);
          gState.lastKnownTargetPos = { ...c.pos };
          next.alarmProgress = Math.min(100, next.alarmProgress + dt * rate * 0.55);

          if (gState.suspicion >= 25 && gState.state === 'patrol') {
            gState.state = 'suspicious';
            gState.calloutText = 'Wer ist da?';
          }
          if (gState.suspicion >= 48 && gState.state !== 'pursuit') {
            gState.state = 'investigating';
            gState.investigatePos = { ...c.pos };
            gState.investigateReason = 'sight';
            gState.pathWaypoints = undefined;
            gState.pauseRemainingSec = 3.5;
            escalateAlarm(next, 'suspicious', teamHasJammer);
          }
          if (gState.suspicion >= 95) {
            gState.state = 'radioing';
            gState.radioProgress = 0;
            gState.calloutText = 'Zentrale, Eindringling gesichtet!';
            addEvidenceDraftOnce(next, {
              type: 'witness',
              title: `Augenzeuge: ${gDef.name}`,
              detail: `Wachmann identifizierte Gestalt von ${member?.name ?? c.crewId}.`,
              targetId: target.id,
              severity: 15,
              relatedCrewId: c.crewId,
            });
          }
        }
      }

      // Positional Noise Hearing: guard investigates the ACTUAL noise source coordinates!
      if (!seesCrew) {
        let heardNoise = false;
        for (const pulse of next.noiseEvents) {
          if (pulse.floor !== gState.floor) continue;
          const d = distance2D(gState.pos, pulse.pos);
          if (d <= Math.min(gDef.hearingRange * 1.45, pulse.radiusM)) {
            heardNoise = true;
            const loudnessGain = pulse.noiseDb >= 80 ? 55 : 32;
            gState.suspicion = Math.min(85, gState.suspicion + dt * loudnessGain);
            if (gState.suspicion >= 30 && (gState.state === 'patrol' || gState.state === 'suspicious')) {
              gState.state = 'investigating';
              gState.investigatePos = { ...pulse.pos };
              gState.investigateReason = 'noise';
              gState.pathWaypoints = undefined;
              gState.pauseRemainingSec = 4;
              gState.calloutText = `Geräusch gehört: ${pulse.label}`;
              escalateAlarm(next, 'suspicious', teamHasJammer);
            }
            break;
          }
        }
        if (!heardNoise) {
          gState.suspicion = Math.max(0, gState.suspicion - dt * 14);
          if (gState.suspicion < 15 && gState.state === 'suspicious') {
            gState.state = 'patrol';
            gState.calloutText = undefined;
          }
        }
      }
    }
  }

  // 5) Police ETA countdown once alarm triggered
  if (next.policeEtaSec !== null) {
    next.policeEtaSec = Math.max(0, Math.round((next.policeEtaSec - dt) * 10) / 10);
    if (next.policeEtaSec <= 0) {
      escalateAlarm(next, 'lockdown', teamHasJammer);
    }
  }

  // 6) Update live stealth telemetry
  next.stealthTelemetry = computeStealthTelemetry(
    next,
    target,
    crewById,
    resolvedPlan.plan.forensicLoadoutByCrew
  );

  // 7) Check if all crew extracted
  const activeCrew = Object.values(next.crew);
  const allDone =
    activeCrew.length > 0 &&
    activeCrew.every((c) => c.state === 'extracted' || c.state === 'caught');
  if (allDone) {
    next.readyForEscape = true;
  }

  return next;
}
