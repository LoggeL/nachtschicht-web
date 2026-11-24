import {
  ActionBlock,
  ActionType,
  CrewId,
  CrewMember,
  FloorId,
  ForensicLoadout,
  HeistPlan,
  HeistTarget,
  IntelState,
  PathWaypoint,
  PlanBBranch,
  PlanValidationIssue,
  ResolvedPlan,
  SkillKey,
  SyncBarrier,
  TargetNode,
  ToolDef,
  ToolId,
  Vec2,
} from './types';
import { findTargetPath } from './pathfinding';

// ============================================================================
// Pure-TS Heist Planner: A* Travel Time, Forensic Gear Metrics, DAG Validation
// ============================================================================

const BASE_WALK_SPEED_MPS = 2.6;
const FLOOR_TRANSITION_PENALTY_SEC = 3.2;

export function distance2D(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.hypot(dx, dz);
}

export function getEffectiveForensicLoadout(
  plan: HeistPlan | undefined,
  member: CrewMember
): ForensicLoadout {
  const custom = plan?.forensicLoadoutByCrew?.[member.id];
  if (custom) return custom;
  const entryTool: ForensicLoadout['entryTool'] =
    member.equippedTools.includes('glass_cutter')
      ? 'glass_cutter'
      : member.equippedTools.includes('crowbar')
        ? 'crowbar'
        : 'lockpick_set';
  return {
    gloves: member.equippedTools.includes('gloves'),
    mask: member.equippedTools.includes('mask'),
    darkClothing: member.equippedTools.includes('dark_clothing'),
    entryTool,
  };
}

export function inferSkillForAction(
  type: ActionType,
  node?: TargetNode
): SkillKey | undefined {
  if (node?.requiredSkill) return node.requiredSkill;
  switch (type) {
    case 'pick_lock':
    case 'crack_safe':
      return 'locks';
    case 'cut_power':
    case 'bypass_alarm':
    case 'loop_camera':
      return 'electronics';
    case 'stage_car':
      return 'driving';
    case 'enter':
      return node?.kind === 'entry_roof' ? 'climbing' : 'locks';
    case 'grab_loot':
      return 'strength';
    default:
      return undefined;
  }
}

export function findBestToolForAction(
  member: CrewMember,
  type: ActionType,
  node: TargetNode | undefined,
  toolsById: Record<ToolId, ToolDef>,
  explicitToolId?: ToolId,
  forensic?: ForensicLoadout
): ToolDef | undefined {
  // Prefer forensic entry tool selection on doors/windows/vitrines if not overridden
  if (
    !explicitToolId &&
    forensic &&
    node &&
    (node.kind === 'entry_window' ||
      node.kind === 'entry_service' ||
      node.kind === 'entry_door' ||
      node.kind === 'entry_cellar' ||
      node.kind === 'loot_case')
  ) {
    const entryDef = toolsById[forensic.entryTool];
    if (entryDef && entryDef.applicableNodeKinds.includes(node.kind)) {
      return entryDef;
    }
  }

  const candidates = explicitToolId ? [explicitToolId] : member.equippedTools;

  let best: ToolDef | undefined;
  for (const tid of candidates) {
    const def = toolsById[tid];
    if (!def) continue;
    // Passive stealth gear handled separately
    if (tid === 'gloves' || tid === 'mask' || tid === 'dark_clothing') continue;
    const skill = inferSkillForAction(type, node);
    const matchesNode = node ? def.applicableNodeKinds.includes(node.kind) : false;
    const matchesSkill = skill ? def.applicableSkills.includes(skill) : false;
    const isRecommended = node?.recommendedTool === tid;
    if (isRecommended || matchesNode || matchesSkill) {
      if (!best || def.speedMultiplier < best.speedMultiplier) {
        best = def;
      }
    }
  }
  return best;
}

export interface ActionEstimate {
  durationSec: number;
  estimatedNoise: number;
  estimatedTraceRisk: number;
  usedToolId?: ToolId;
  pathWaypoints?: PathWaypoint[];
}

/**
 * Calculates deterministic action duration, noise, forensic trace risk, and
 * wall-respecting A* corridor path from crew skill, forensic gear, and node difficulty.
 */
export function calculateActionMetrics(params: {
  type: ActionType;
  member: CrewMember;
  node?: TargetNode;
  target?: HeistTarget;
  fromPos?: Vec2;
  fromFloor?: FloorId;
  targetPos: Vec2;
  targetFloor: FloorId;
  toolsById: Record<ToolId, ToolDef>;
  explicitToolId?: ToolId;
  requestedDurationSec?: number;
  forensic?: ForensicLoadout;
}): ActionEstimate {
  const {
    type,
    member,
    node,
    target,
    fromPos,
    fromFloor,
    targetPos,
    targetFloor,
    toolsById,
    explicitToolId,
    requestedDurationSec,
    forensic,
  } = params;

  let travelDist = fromPos ? distance2D(fromPos, targetPos) : 0;
  let floorDiff = fromFloor !== undefined ? Math.abs(targetFloor - fromFloor) : 0;
  let pathWaypoints: PathWaypoint[] | undefined;

  if (target && fromPos && fromFloor !== undefined) {
    const pathRes = findTargetPath(
      target,
      fromPos,
      fromFloor,
      targetPos,
      targetFloor,
      { respectLockedDoors: false }
    );
    travelDist = pathRes.totalDistanceM;
    floorDiff = pathRes.floorTransitions;
    pathWaypoints = pathRes.waypoints;
  }

  const speedBonus = 1 + (member.skills.climbing - 5) * 0.03;
  const travelSec =
    travelDist / (BASE_WALK_SPEED_MPS * Math.max(0.75, speedBonus)) +
    floorDiff * FLOOR_TRANSITION_PENALTY_SEC;

  const darkNoiseDelta = forensic?.darkClothing ? -5 : 0;

  if (type === 'move' || type === 'extract') {
    const dur = Math.max(
      2.5,
      Math.round((travelSec + (type === 'extract' ? 1.5 : 0.5)) * 10) / 10
    );
    return {
      durationSec: dur,
      estimatedNoise: Math.max(4, (type === 'extract' ? 18 : 10) + darkNoiseDelta),
      estimatedTraceRisk: 4,
      pathWaypoints,
    };
  }

  if (type === 'wait' || type === 'lookout') {
    const dur = Math.max(3, requestedDurationSec ?? 10);
    return {
      durationSec: Math.round(dur * 10) / 10,
      estimatedNoise: 3,
      estimatedTraceRisk: 2,
      pathWaypoints,
    };
  }

  if (type === 'stage_car') {
    const drivingSkill = member.skills.driving;
    const workSec = Math.max(3, 10 - drivingSkill * 0.6);
    return {
      durationSec: Math.round((travelSec * 0.5 + workSec) * 10) / 10,
      estimatedNoise: Math.max(15, 38 - drivingSkill * 2),
      estimatedTraceRisk: Math.max(8, 28 - drivingSkill * 2),
      pathWaypoints,
    };
  }

  const baseWork = node?.baseDurationSec ?? 8;
  const difficulty = node?.difficulty ?? 4;
  const skillKey = inferSkillForAction(type, node);
  const skillVal = skillKey ? member.skills[skillKey] : 5;

  const skillRatio = Math.max(0.45, Math.min(2.1, 1 + (difficulty - skillVal) * 0.12));

  const tool = findBestToolForAction(
    member,
    type,
    node,
    toolsById,
    explicitToolId,
    forensic
  );
  const toolSpeed = tool ? tool.speedMultiplier : 1.0;

  const hasGloves = forensic ? forensic.gloves : member.equippedTools.includes('gloves');
  const hasMask = forensic ? forensic.mask : member.equippedTools.includes('mask');
  // Wearing gloves prevents fingerprints (-38 trace) with a realistic slight tactile speed cost (+5%)
  const glovesSpeedMod = hasGloves ? 1.05 : 1.0;
  const glovesTraceDelta = hasGloves ? (toolsById.gloves?.traceDelta ?? -38) : 14;
  const maskTraceDelta = hasMask ? -10 : 8;

  const workSec = Math.max(2.0, baseWork * skillRatio * toolSpeed * glovesSpeedMod);
  const totalSec = Math.round((travelSec + workSec) * 10) / 10;

  // Crowbar on glass display cases or windows shatters glass loudly!
  const crowbarGlassSpike =
    tool?.id === 'crowbar' &&
    (node?.kind === 'loot_case' || node?.kind === 'entry_window')
      ? 26
      : 0;

  const baseNoise = node?.noiseLevel ?? 25;
  const noiseSkillMod = (5 - skillVal) * 3;
  const estimatedNoise = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        baseNoise +
          noiseSkillMod +
          (tool?.noiseDelta ?? 0) +
          crowbarGlassSpike +
          darkNoiseDelta
      )
    )
  );

  const baseTrace = node?.traceRisk ?? 22;
  const traceSkillMod = (5 - skillVal) * 2;
  const estimatedTraceRisk = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        baseTrace +
          traceSkillMod +
          (tool?.traceDelta ?? 0) +
          glovesTraceDelta +
          maskTraceDelta
      )
    )
  );

  return {
    durationSec: totalSec,
    estimatedNoise,
    estimatedTraceRisk,
    usedToolId: tool?.id,
    pathWaypoints,
  };
}

/**
 * Resolves a HeistPlan into deterministic start/end times and A* corridor paths
 * for every ActionBlock, respecting per-crew sequencing and SyncBarriers.
 */
export function resolvePlan(params: {
  plan: HeistPlan;
  target: HeistTarget;
  crewById: Record<CrewId, CrewMember>;
  toolsById: Record<ToolId, ToolDef>;
  intel?: IntelState;
}): ResolvedPlan {
  const { plan, target, crewById, toolsById, intel } = params;
  const nodesById: Record<string, TargetNode> = {};
  for (const n of target.nodes) nodesById[n.id] = n;

  const issues: PlanValidationIssue[] = [];

  const orderedByCrew: Record<string, ActionBlock[]> = {};
  for (const cid of plan.assignedCrewIds) {
    orderedByCrew[cid] = [];
  }

  const rawById: Record<string, ActionBlock> = {};
  for (const b of plan.blocks) {
    if (!plan.assignedCrewIds.includes(b.crewId)) {
      issues.push({
        severity: 'error',
        code: 'UNASSIGNED_CREW',
        message: `Block „${b.label}“ gehört zu einem nicht eingeteilten Komplizen (${b.crewId}).`,
        blockId: b.id,
        crewId: b.crewId,
      });
      continue;
    }
    const copy: ActionBlock = { ...b };
    rawById[copy.id] = copy;
    if (!orderedByCrew[copy.crewId]) orderedByCrew[copy.crewId] = [];
    orderedByCrew[copy.crewId].push(copy);
  }

  for (const cid of Object.keys(orderedByCrew)) {
    orderedByCrew[cid].sort((a, b) => a.startSec - b.startSec);
  }

  // Recompute durations/noise/trace + real A* corridor paths along each crew member's route
  for (const cid of Object.keys(orderedByCrew)) {
    const member = crewById[cid as CrewId];
    if (!member) continue;
    const forensic = getEffectiveForensicLoadout(plan, member);
    let prevPos: Vec2 = { ...target.getawayPos };
    let prevFloor: FloorId = 0;

    for (const block of orderedByCrew[cid]) {
      const node = block.targetNodeId ? nodesById[block.targetNodeId] : undefined;
      const metrics = calculateActionMetrics({
        type: block.type,
        member,
        node,
        target,
        fromPos: prevPos,
        fromFloor: prevFloor,
        targetPos: block.targetPos,
        targetFloor: block.floor,
        toolsById,
        explicitToolId: block.toolId,
        requestedDurationSec: block.durationSec,
        forensic,
      });
      block.durationSec = metrics.durationSec;
      block.estimatedNoise = metrics.estimatedNoise;
      block.estimatedTraceRisk = metrics.estimatedTraceRisk;
      block.pathWaypoints = metrics.pathWaypoints;
      if (!block.toolId && metrics.usedToolId) {
        block.toolId = metrics.usedToolId;
      }
      prevPos = { ...block.targetPos };
      prevFloor = block.floor;
    }
  }

  // Build DAG edges: track sequence + cross-track SyncBarriers
  const deps: Record<string, string[]> = {};
  const dependents: Record<string, string[]> = {};
  const inDegree: Record<string, number> = {};

  for (const id of Object.keys(rawById)) {
    deps[id] = [];
    dependents[id] = [];
    inDegree[id] = 0;
  }

  const addEdge = (fromId: string, toId: string) => {
    if (!rawById[fromId] || !rawById[toId]) return;
    if (fromId === toId) {
      issues.push({
        severity: 'error',
        code: 'CYCLE',
        message: `Selbst-Synchronisation bei Block „${rawById[fromId].label}“ unzulässig.`,
        blockId: fromId,
      });
      return;
    }
    if (!dependents[fromId].includes(toId)) {
      dependents[fromId].push(toId);
      deps[toId].push(fromId);
      inDegree[toId] += 1;
    }
  };

  for (const cid of Object.keys(orderedByCrew)) {
    const track = orderedByCrew[cid];
    for (let i = 1; i < track.length; i++) {
      addEdge(track[i - 1].id, track[i].id);
    }
  }

  for (const sb of plan.syncBarriers) {
    if (!rawById[sb.fromBlockId] || !rawById[sb.toBlockId]) {
      issues.push({
        severity: 'warning',
        code: 'MISSING_SYNC_NODE',
        message: `Synchronpunkt „${sb.label}“ verweist auf fehlenden Block.`,
      });
      continue;
    }
    addEdge(sb.fromBlockId, sb.toBlockId);
  }

  // Kahn's topological sort
  const queue: string[] = [];
  for (const id of Object.keys(inDegree)) {
    if (inDegree[id] === 0) queue.push(id);
  }

  const topoOrder: string[] = [];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    topoOrder.push(cur);
    for (const next of dependents[cur]) {
      inDegree[next] -= 1;
      if (inDegree[next] === 0) {
        queue.push(next);
      }
    }
  }

  const hasCycle = topoOrder.length < Object.keys(rawById).length;
  if (hasCycle) {
    for (const id of Object.keys(rawById)) {
      if (inDegree[id] > 0) {
        issues.push({
          severity: 'error',
          code: 'CYCLE',
          message: `Zyklische Abhängigkeit (Deadlock) bei Synchronpunkt um „${rawById[id].label}“.`,
          blockId: id,
          crewId: rawById[id].crewId,
        });
      }
    }
  }

  const visited = new Set<string>(topoOrder);
  const fullOrder = [
    ...topoOrder,
    ...Object.keys(rawById).filter((id) => !visited.has(id)),
  ];

  let totalDurationSec = 0;
  for (const id of fullOrder) {
    const block = rawById[id];
    let earliest = Math.max(0, block.startSec);
    for (const depId of deps[id]) {
      const depEnd = rawById[depId]?.computedEndSec ?? 0;
      if (depEnd > earliest) {
        earliest = depEnd;
      }
    }
    block.computedStartSec = Math.round(earliest * 10) / 10;
    block.computedEndSec = Math.round((earliest + block.durationSec) * 10) / 10;
    if (block.computedEndSec > totalDurationSec) {
      totalDurationSec = block.computedEndSec;
    }
  }

  const hasLootAction = Object.values(rawById).some(
    (b) => b.type === 'grab_loot' || b.type === 'crack_safe'
  );
  if (!hasLootAction && Object.keys(rawById).length > 0) {
    issues.push({
      severity: 'warning',
      code: 'NO_LOOT',
      message: 'Im Plan ist noch keine Beute- oder Tresor-Aktion eingeplant.',
    });
  }

  const hasExtractAction = Object.values(rawById).some((b) => b.type === 'extract');
  if (!hasExtractAction && Object.keys(rawById).length > 0) {
    issues.push({
      severity: 'warning',
      code: 'NO_EXTRACT',
      message: 'Kein Rückzug zum Fluchtwagen eingeplant — Flucht erfolgt manuell.',
    });
  }

  const alarmBypassEndByNode: Record<string, number> = {};
  for (const b of Object.values(rawById)) {
    if (b.type === 'bypass_alarm' && b.targetNodeId && b.computedEndSec !== undefined) {
      alarmBypassEndByNode[b.targetNodeId] = Math.min(
        alarmBypassEndByNode[b.targetNodeId] ?? Infinity,
        b.computedEndSec
      );
    }
  }
  for (const b of Object.values(rawById)) {
    if (!b.targetNodeId) continue;
    const node = nodesById[b.targetNodeId];
    if (node?.alarmLinkedNodeId) {
      const bypassEnd = alarmBypassEndByNode[node.alarmLinkedNodeId];
      if (bypassEnd === undefined || (b.computedStartSec ?? 0) < bypassEnd) {
        issues.push({
          severity: 'warning',
          code: 'POWER_ORDER',
          message: `„${b.label}“ startet vor Überbrückung der Alarmzentrale — Synchronpunkt setzen!`,
          blockId: b.id,
          crewId: b.crewId,
        });
      }
    }
    if (b.estimatedNoise >= 65) {
      issues.push({
        severity: 'warning',
        code: 'HIGH_NOISE',
        message: `Hoher Lärmpegel (${b.estimatedNoise}) bei „${b.label}“ — Wachen in der Nähe werden aufmerksam.`,
        blockId: b.id,
        crewId: b.crewId,
      });
    }
  }

  if (intel && intel.completionPercent < 60) {
    issues.push({
      severity: 'info',
      code: 'UNSCOUTED_RISK',
      message: `Erst ${intel.completionPercent}% ausgekundschaftet — verborgene Sensoren und Wachrunden fehlen im Probelauf.`,
    });
  }

  const resolvedBlocks = Object.values(rawById);
  const resolvedPlan: HeistPlan = {
    ...plan,
    blocks: resolvedBlocks,
    totalDurationSec: Math.round(totalDurationSec * 10) / 10,
  };

  const hasError = issues.some((i) => i.severity === 'error');
  return {
    plan: resolvedPlan,
    blocksById: rawById,
    orderedBlocksByCrew: orderedByCrew,
    totalDurationSec: resolvedPlan.totalDurationSec,
    valid: !hasError,
    issues,
  };
}

export function wouldSyncCreateCycle(
  plan: HeistPlan,
  fromBlockId: string,
  toBlockId: string
): boolean {
  if (fromBlockId === toBlockId) return true;
  const blocksByCrew: Record<string, ActionBlock[]> = {};
  for (const b of plan.blocks) {
    if (!blocksByCrew[b.crewId]) blocksByCrew[b.crewId] = [];
    blocksByCrew[b.crewId].push(b);
  }
  const adj: Record<string, string[]> = {};
  const pushEdge = (u: string, v: string) => {
    if (!adj[u]) adj[u] = [];
    adj[u].push(v);
  };
  for (const list of Object.values(blocksByCrew)) {
    const sorted = [...list].sort((a, b) => a.startSec - b.startSec);
    for (let i = 1; i < sorted.length; i++) {
      pushEdge(sorted[i - 1].id, sorted[i].id);
    }
  }
  for (const sb of plan.syncBarriers) {
    pushEdge(sb.fromBlockId, sb.toBlockId);
  }
  pushEdge(fromBlockId, toBlockId);

  const seen = new Set<string>([toBlockId]);
  const stack = [toBlockId];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const nxt of adj[cur] ?? []) {
      if (nxt === fromBlockId) return true;
      if (!seen.has(nxt)) {
        seen.add(nxt);
        stack.push(nxt);
      }
    }
  }
  return false;
}

export function selectPlanBBranch(
  plan: HeistPlan,
  crewId: CrewId,
  trigger: PlanBBranch['trigger']
): PlanBBranch | undefined {
  return (
    plan.planBBranches.find((b) => b.crewId === crewId && b.trigger === trigger) ??
    plan.planBBranches.find(
      (b) => b.crewId === crewId && b.trigger === 'manual_radio'
    ) ??
    plan.planBBranches.find((b) => b.crewId === crewId)
  );
}

export function inferActionTypeForNode(node: TargetNode): ActionType {
  switch (node.kind) {
    case 'entry_door':
    case 'entry_roof':
    case 'entry_cellar':
    case 'entry_window':
    case 'entry_service':
      return 'enter';
    case 'lock':
      return 'pick_lock';
    case 'power_box':
      return 'cut_power';
    case 'alarm_panel':
      return 'bypass_alarm';
    case 'camera':
      return 'loop_camera';
    case 'safe':
      return 'crack_safe';
    case 'loot_case':
      return 'grab_loot';
    case 'lookout':
      return 'lookout';
    case 'getaway_zone':
      return 'extract';
    default:
      return 'move';
  }
}

export function createSyncBarrier(
  fromBlock: ActionBlock,
  toBlock: ActionBlock,
  label?: string
): SyncBarrier {
  return {
    id: `sync_${fromBlock.id}_${toBlock.id}`,
    label: label ?? `Warte auf ${fromBlock.label}`,
    fromBlockId: fromBlock.id,
    fromCrewId: fromBlock.crewId,
    toBlockId: toBlock.id,
    toCrewId: toBlock.crewId,
  };
}
