import {
  ActionBlock,
  CollectedLootItem,
  CrewId,
  CrewMember,
  DeviationEvent,
  EscapeState,
  FloorId,
  HeistTarget,
  LiveCameraState,
  LiveCrewState,
  LiveExecutionState,
  LiveGuardState,
  RadioCommandType,
  ResolvedPlan,
  TargetNode,
  Vec2,
} from './types';
import { distance2D, selectPlanBBranch } from './planner';
import {
  findRoomAt,
  headingBetween,
  isPointInVisionCone,
  sampleCameraHeading,
} from './simulator';

// ============================================================================
// Pure-TS Live Execution Engine (Runs against ACTUAL World, incl. hidden traps,
// trait-driven deviations, guard vision/hearing, radio commands & Plan B)
// ============================================================================

function nextRng(state: number): { value: number; nextState: number } {
  // Deterministic Mulberry32 step
  let t = (state + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState: (state + 1) | 0 };
}

function moveTowards(
  current: Vec2,
  target: Vec2,
  maxStep: number
): { pos: Vec2; arrived: boolean; headingDeg: number } {
  const dist = distance2D(current, target);
  const headingDeg = headingBetween(current, target);
  if (dist <= maxStep || dist < 0.05) {
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

export function createInitialLiveState(params: {
  target: HeistTarget;
  resolvedPlan: ResolvedPlan;
  seed?: number;
}): LiveExecutionState {
  const { target, resolvedPlan, seed = 1337 } = params;

  const crew = {} as Record<CrewId, LiveCrewState>;
  const crewIds = resolvedPlan.plan.assignedCrewIds;
  crewIds.forEach((cid, idx) => {
    const offset = (idx - (crewIds.length - 1) / 2) * 1.1;
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
  return {
    active: true,
    elapsedSec: 0,
    speedKmh: 0,
    pursuitHeat: initialHeat,
    policeSpotted: alarmLevel === 'alarm' || alarmLevel === 'lockdown',
    clearSightTimerSec: 0,
    distanceToSafehouseM: target.safehouseEscapeDistanceM,
    carDamage: 0,
    vehicleRecognized: alarmLevel === 'lockdown',
    escaped: false,
    busted: false,
  };
}

function addEvidenceDraftOnce(
  state: LiveExecutionState,
  draft: LiveExecutionState['pendingEvidence'][number]
) {
  const exists = state.pendingEvidence.some(
    (e) => e.type === draft.type && e.relatedCrewId === draft.relatedCrewId
  );
  if (!exists) {
    state.pendingEvidence.push(draft);
  }
}

function escalateAlarm(
  state: LiveExecutionState,
  targetLevel: LiveExecutionState['alarmLevel']
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
    state.policeEtaSec = 55;
    state.compromised = true;
  }
}

/**
 * Applies a player radio command ('hold' | 'plan_b' | 'abort' | 'resume')
 * immediately to the live execution state.
 */
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
      c.activeActionLabel = 'ABBRUCH — Sprint zum Fluchtwagen';
    }
  }

  return next;
}

/**
 * Helper to execute node completion side-effects (power cut, alarm bypass, loot, etc.).
 */
function completeNodeEffect(
  state: LiveExecutionState,
  node: TargetNode,
  actorCrewId: CrewId,
  actionType: ActionBlock['type'] | 'interact'
) {
  if (!state.completedNodeIds.includes(node.id)) {
    state.completedNodeIds.push(node.id);
  }

  if (node.kind === 'power_box' || actionType === 'cut_power') {
    state.powerDisabled = true;
    for (const cam of state.cameras) {
      cam.active = false;
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
    // Check if alarm-linked without bypass!
    if (
      node.alarmLinkedNodeId &&
      !state.alarmBypassed &&
      !state.completedNodeIds.includes(node.alarmLinkedNodeId)
    ) {
      escalateAlarm(state, 'alarm');
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
      }
    }
  }
}

/**
 * Allows the player (Mara) in 3D Live mode to directly interact with a nearby node.
 */
export function playerInteractWithNode(
  live: LiveExecutionState,
  target: HeistTarget,
  nodeId: string
): LiveExecutionState {
  const next: LiveExecutionState = structuredClone(live);
  const node = target.nodes.find((n) => n.id === nodeId);
  if (!node) return next;

  const mara = next.crew.mara;
  if (mara) {
    mara.activeActionLabel = `Abgeschlossen: ${node.label}`;
    // Also mark any matching Mara block completed so sync barriers waiting on Mara unlock!
    for (const key of Object.keys(next.crew)) {
      const c = next.crew[key as CrewId];
      if (c.crewId === 'mara' && c.activeBlockId && !c.completedBlockIds.includes(c.activeBlockId)) {
        // Check if current block targets this node — handled in tick via completedNodeIds too
      }
    }
  }

  completeNodeEffect(next, node, 'mara', 'interact');
  next.noiseLevel = Math.max(next.noiseLevel, Math.round(node.noiseLevel * 0.8));

  if (node.kind === 'getaway_zone') {
    if (mara) {
      mara.state = 'extracted';
      mara.pos = { ...target.getawayPos };
    }
    next.readyForEscape = true;
  }

  return next;
}

export interface LiveTickOptions {
  /** If true, Mara's position is driven externally by 3D WASD controller */
  playerSteeredExternally?: boolean;
  /** Workshop radio scrambler reduces deviation probability */
  hasRadioScrambler?: boolean;
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

  const nodesById: Record<string, TargetNode> = {};
  for (const n of target.nodes) nodesById[n.id] = n;

  // Build global set of completed block IDs across all crew for SyncBarrier checks
  const allCompletedBlockIds = new Set<string>();
  for (const c of Object.values(next.crew)) {
    for (const bid of c.completedBlockIds) allCompletedBlockIds.add(bid);
  }

  // Also sync: if Mara completed a node via manual 3D interaction, mark her matching block done
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

  // Check if alarm triggered automatic Plan B for any crew member
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

  // 1) Update each Crew Member
  for (const cid of resolvedPlan.plan.assignedCrewIds) {
    const c = next.crew[cid];
    const member = crewById[cid];
    if (!c || !member) continue;
    if (c.state === 'extracted' || c.state === 'caught') continue;

    // External WASD steering for Mara: keep Mara's pos as provided, just check getaway proximity
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

    // Stress rises under alarm or high suspicion
    if (next.alarmLevel === 'alarm' || next.alarmLevel === 'lockdown') {
      c.stress = Math.min(100, c.stress + dt * (110 - member.traits.nerves) * 0.18);
    } else if (next.alarmLevel === 'suspicious') {
      c.stress = Math.min(100, c.stress + dt * (100 - member.traits.nerves) * 0.08);
    } else {
      c.stress = Math.max(0, c.stress - dt * 5);
    }

    // Fleeing / Plan B / Abort movement back to getaway car (optionally via fallback exit)
    if (next.abortActive || c.usingPlanB || c.state === 'fleeing') {
      const sprintSpeed = 3.8 + member.skills.climbing * 0.1;
      const move = moveTowards(c.pos, target.getawayPos, sprintSpeed * dt);
      c.pos = move.pos;
      c.headingDeg = move.headingDeg;
      c.floor = 0;
      c.speed = sprintSpeed;
      if (move.arrived) {
        c.state = 'extracted';
        c.speed = 0;
        c.activeActionLabel = 'Im Fluchtwagen';
      }
      continue;
    }

    // Greed deviation: detouring to grab an unlooted extra loot_case
    if (c.extraLootTargetNodeId) {
      const extraNode = nodesById[c.extraLootTargetNodeId];
      if (!extraNode || next.completedNodeIds.includes(extraNode.id)) {
        c.extraLootTargetNodeId = null;
        c.deviationActive = null;
      } else {
        const step = moveTowards(c.pos, extraNode.pos, 2.9 * dt);
        c.pos = step.pos;
        c.headingDeg = step.headingDeg;
        c.floor = extraNode.floor;
        c.state = 'deviating';
        c.activeActionLabel = `GIER: Greift nach ${extraNode.label}!`;
        if (step.arrived) {
          c.blockProgress += dt / Math.max(3, extraNode.baseDurationSec * 0.7);
          next.noiseLevel = Math.max(next.noiseLevel, extraNode.noiseLevel + 10);
          if (c.blockProgress >= 1) {
            completeNodeEffect(next, extraNode, cid, 'grab_loot');
            c.blockProgress = 0;
            c.extraLootTargetNodeId = null;
            c.deviationActive = null;
          }
        }
        continue;
      }
    }

    // Execute planned track blocks in order
    const track = resolvedPlan.orderedBlocksByCrew[cid] ?? [];
    if (c.activeBlockIndex >= track.length) {
      c.state =
        distance2D(c.pos, target.getawayPos) < 3.0 ? 'extracted' : 'idle';
      c.activeBlockId = null;
      c.speed = 0;
      continue;
    }

    const block = track[c.activeBlockIndex];
    c.activeBlockId = block.id;

    // Check SyncBarrier prerequisites for this block
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

    // Also respect explicit start delay on the first block
    if (c.activeBlockIndex === 0 && next.elapsedSec < block.startSec) {
      c.state = 'idle';
      c.speed = 0;
      c.activeActionLabel = `Startet bei ${block.startSec.toFixed(0)}s`;
      continue;
    }

    // Move to block's targetPos first
    const walkSpeed = c.sneaking ? 1.8 : 2.7 + (member.skills.climbing - 5) * 0.08;
    const move = moveTowards(c.pos, block.targetPos, walkSpeed * dt);
    if (!move.arrived) {
      c.pos = move.pos;
      c.headingDeg = move.headingDeg;
      c.floor = block.floor;
      c.speed = walkSpeed;
      c.state = 'moving';
      c.activeActionLabel = `Unterwegs: ${block.label}`;
      continue;
    }

    // Arrived at targetPos — perform block work
    c.pos = { ...block.targetPos };
    c.floor = block.floor;
    c.speed = 0;
    c.state = 'working';
    c.activeActionLabel = block.label;

    // High-nerves improvisation bonus under pressure
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

    // Low-nerves panic noise / abort under high stress
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
          next.noiseLevel = Math.min(100, Math.max(next.noiseLevel, 82));
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

    // Work duration = ~65% of total block duration (since travel already happened)
    const workDur = Math.max(1.5, block.durationSec * 0.65);
    c.blockProgress = Math.min(1, c.blockProgress + (dt * workRateMultiplier) / workDur);
    next.noiseLevel = Math.max(next.noiseLevel, block.estimatedNoise * 0.85);

    if (c.blockProgress >= 1) {
      c.blockProgress = 0;
      c.completedBlockIds.push(block.id);
      allCompletedBlockIds.add(block.id);
      c.activeBlockIndex += 1;

      if (block.targetNodeId && nodesById[block.targetNodeId]) {
        completeNodeEffect(next, nodesById[block.targetNodeId], cid, block.type);
      }

      if (block.type === 'extract') {
        c.state = 'extracted';
        c.activeActionLabel = 'Im Fluchtwagen';
        continue;
      }

      // Greed deviation check after looting!
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

  // 2) Check Hidden Traps against ACTUAL world (unpowered traps are harmless)
  for (const node of target.nodes) {
    if (!node.isHiddenHazard) continue;
    if (next.triggeredHazardNodeIds.includes(node.id)) continue;
    if (next.completedNodeIds.includes(node.id)) continue;
    if (next.powerDisabled && node.poweredByNodeId) continue;

    for (const c of Object.values(next.crew)) {
      if (c.state === 'extracted' || c.state === 'caught') continue;
      if (c.floor === node.floor && distance2D(c.pos, node.pos) < 2.2) {
        next.triggeredHazardNodeIds.push(node.id);
        escalateAlarm(next, 'alarm');
        next.alarmProgress = 100;
        next.noiseLevel = Math.max(next.noiseLevel, 75);
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

  // 3) Update Cameras & Camera Sightlines
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
          escalateAlarm(next, 'suspicious');
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
          escalateAlarm(next, 'alarm');
        }
      }
    }
    if (!spottedAny) {
      cam.suspicion = Math.max(0, cam.suspicion - dt * 18);
    }
  }

  // 4) Update Guards (Patrol, Hearing Noise, Vision Cones)
  for (const gState of next.guards) {
    const gDef = target.guards.find((g) => g.id === gState.guardId);
    if (!gDef) continue;

    // Movement
    if (gState.state === 'investigating' && gState.investigatePos) {
      const m = moveTowards(gState.pos, gState.investigatePos, gDef.speedMps * 1.1 * dt);
      gState.pos = m.pos;
      gState.headingDeg = m.headingDeg;
      if (m.arrived) {
        gState.pauseRemainingSec -= dt;
        if (gState.pauseRemainingSec <= 0) {
          gState.state = 'patrol';
          gState.investigatePos = undefined;
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
        const m = moveTowards(gState.pos, nextWp.pos, gDef.speedMps * dt);
        gState.pos = m.pos;
        gState.floor = nextWp.floor;
        gState.headingDeg = m.headingDeg;
        if (m.arrived) {
          gState.waypointIndex = nextIdx;
          gState.pauseRemainingSec = nextWp.pauseSec;
        }
      }
    }

    // Vision & Hearing detection
    let seesCrew = false;

    for (const c of Object.values(next.crew)) {
      if (c.state === 'extracted' || c.state === 'caught') continue;
      if (distance2D(c.pos, target.getawayPos) < 2.5 && gDef.visibleFromStreet) {
        continue;
      }

      // Walking casually or acting as lookout in a public street without loot/alarm looks normal
      const crewRoom = findRoomAt(target, c.pos, c.floor);
      const activeBlock = c.activeBlockId
        ? resolvedPlan.blocksById[c.activeBlockId]
        : undefined;
      const doingOvertCrime =
        c.state === 'working' &&
        activeBlock?.type !== 'lookout' &&
        activeBlock?.type !== 'wait' &&
        activeBlock?.type !== 'stage_car';
      const isPublicPedestrian =
        crewRoom?.securityZone === 'public' &&
        !doingOvertCrime &&
        c.carryingLootEur === 0 &&
        next.alarmLevel !== 'alarm' &&
        next.alarmLevel !== 'lockdown';
      if (isPublicPedestrian) continue;

      // Cutting power plunges interior rooms into darkness, slashing visibility into them
      const inDarkenedInterior =
        next.powerDisabled && crewRoom?.securityZone !== 'public';
      const darknessFactor = inDarkenedInterior ? 0.48 : 1.0;

      const dist = distance2D(gState.pos, c.pos);
      const effectiveRange =
        (c.sneaking ? gDef.visionRange * 0.72 : gDef.visionRange) * darknessFactor;
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
        const rate = 100 / Math.max(0.6, gDef.alertThresholdSec);
        gState.suspicion = Math.min(100, gState.suspicion + dt * rate);
        next.alarmProgress = Math.min(100, next.alarmProgress + dt * rate * 0.7);
        if (gState.suspicion >= 40) {
          gState.state = 'investigating';
          gState.investigatePos = { ...c.pos };
          gState.pauseRemainingSec = 3;
          escalateAlarm(next, 'suspicious');
        }
        if (gState.suspicion >= 95) {
          gState.state = 'alerted';
          escalateAlarm(next, 'alarm');
          addEvidenceDraftOnce(next, {
            type: 'witness',
            title: `Augenzeuge: ${gDef.name}`,
            detail: `Wachmann identifizierte Gestalt von ${crewById[c.crewId]?.name ?? c.crewId}.`,
            targetId: target.id,
            severity: 15,
            relatedCrewId: c.crewId,
          });
        }
      } else if (
        next.noiseLevel >= 55 &&
        c.floor === gState.floor &&
        dist <= gDef.hearingRange * (next.noiseLevel / 70)
      ) {
        gState.suspicion = Math.min(100, gState.suspicion + dt * 28);
        if (gState.suspicion >= 35 && gState.state === 'patrol') {
          gState.state = 'investigating';
          gState.investigatePos = { ...c.pos };
          gState.pauseRemainingSec = 3.5;
          escalateAlarm(next, 'suspicious');
        }
      }
    }

    if (!seesCrew) {
      gState.suspicion = Math.max(0, gState.suspicion - dt * 14);
    }
  }

  // 5) Police ETA countdown once alarm triggered
  if (next.policeEtaSec !== null) {
    next.policeEtaSec = Math.max(0, Math.round((next.policeEtaSec - dt) * 10) / 10);
    if (next.policeEtaSec <= 0) {
      escalateAlarm(next, 'lockdown');
    }
  }

  // 6) Check if all crew have extracted -> ready for getaway driving!
  const activeCrew = Object.values(next.crew);
  const allDone =
    activeCrew.length > 0 &&
    activeCrew.every((c) => c.state === 'extracted' || c.state === 'caught');
  if (allDone) {
    next.readyForEscape = true;
  }

  return next;
}
