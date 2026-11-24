import {
  ActionBlock,
  ActionType,
  CrewId,
  CrewMember,
  HeistPlan,
  HeistTarget,
  IntelState,
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

// ============================================================================
// Pure-TS Heist Planner: Duration Calculation, DAG Validation, Sync Barriers
// ============================================================================

const BASE_WALK_SPEED_MPS = 2.6;
const FLOOR_TRANSITION_PENALTY_SEC = 4.0;

export function distance2D(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  return Math.hypot(dx, dz);
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
  explicitToolId?: ToolId
): ToolDef | undefined {
  const candidates = explicitToolId
    ? [explicitToolId]
    : member.equippedTools;

  let best: ToolDef | undefined;
  for (const tid of candidates) {
    const def = toolsById[tid];
    if (!def) continue;
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
}

/**
 * Calculates deterministic action duration, noise, and forensic trace risk
 * from crew skill, equipped tool, node difficulty, and travel distance.
 */
export function calculateActionMetrics(params: {
  type: ActionType;
  member: CrewMember;
  node?: TargetNode;
  fromPos?: Vec2;
  fromFloor?: number;
  targetPos: Vec2;
  targetFloor: number;
  toolsById: Record<ToolId, ToolDef>;
  explicitToolId?: ToolId;
  requestedDurationSec?: number;
}): ActionEstimate {
  const {
    type,
    member,
    node,
    fromPos,
    fromFloor,
    targetPos,
    targetFloor,
    toolsById,
    explicitToolId,
    requestedDurationSec,
  } = params;

  const travelDist = fromPos ? distance2D(fromPos, targetPos) : 0;
  const floorDiff =
    fromFloor !== undefined ? Math.abs(targetFloor - fromFloor) : 0;
  const speedBonus = 1 + (member.skills.climbing - 5) * 0.03;
  const travelSec =
    travelDist / (BASE_WALK_SPEED_MPS * Math.max(0.75, speedBonus)) +
    floorDiff * FLOOR_TRANSITION_PENALTY_SEC;

  if (type === 'move' || type === 'extract') {
    const dur = Math.max(2.5, Math.round((travelSec + (type === 'extract' ? 1.5 : 0.5)) * 10) / 10);
    return {
      durationSec: dur,
      estimatedNoise: type === 'extract' ? 18 : 10,
      estimatedTraceRisk: 4,
    };
  }

  if (type === 'wait' || type === 'lookout') {
    const dur = Math.max(3, requestedDurationSec ?? 10);
    return {
      durationSec: Math.round(dur * 10) / 10,
      estimatedNoise: 3,
      estimatedTraceRisk: 2,
    };
  }

  if (type === 'stage_car') {
    const drivingSkill = member.skills.driving;
    const workSec = Math.max(3, 10 - drivingSkill * 0.6);
    return {
      durationSec: Math.round((travelSec * 0.5 + workSec) * 10) / 10,
      estimatedNoise: Math.max(15, 38 - drivingSkill * 2),
      estimatedTraceRisk: Math.max(8, 28 - drivingSkill * 2),
    };
  }

  const baseWork = node?.baseDurationSec ?? 8;
  const difficulty = node?.difficulty ?? 4;
  const skillKey = inferSkillForAction(type, node);
  const skillVal = skillKey ? member.skills[skillKey] : 5;

  // Higher skill reduces duration; difficult nodes take longer for low skill
  const skillRatio = Math.max(0.45, Math.min(2.1, 1 + (difficulty - skillVal) * 0.12));

  const tool = findBestToolForAction(member, type, node, toolsById, explicitToolId);
  const toolSpeed = tool ? tool.speedMultiplier : 1.0;

  // Gloves always reduce forensic trace risk if carried
  const hasGloves = member.equippedTools.includes('gloves');
  const glovesTraceDelta = hasGloves ? (toolsById.gloves?.traceDelta ?? -35) : 0;

  const workSec = Math.max(2.0, baseWork * skillRatio * toolSpeed);
  const totalSec = Math.round((travelSec + workSec) * 10) / 10;

  const baseNoise = node?.noiseLevel ?? 25;
  const noiseSkillMod = (5 - skillVal) * 3;
  const estimatedNoise = Math.max(
    0,
    Math.min(100, Math.round(baseNoise + noiseSkillMod + (tool?.noiseDelta ?? 0)))
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
          (tool?.id === 'gloves' ? 0 : glovesTraceDelta)
      )
    )
  );

  return {
    durationSec: totalSec,
    estimatedNoise,
    estimatedTraceRisk,
    usedToolId: tool?.id,
  };
}

/**
 * Resolves a HeistPlan into deterministic start/end times for every ActionBlock,
 * respecting per-crew track sequencing and cross-track SyncBarriers.
 * Detects cycles (DAG validation) and surfaces tactical warnings.
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

  // Group blocks by crew sorted by requested startSec (stable order)
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

  // Recompute durations/noise/trace along each crew member's actual path
  for (const cid of Object.keys(orderedByCrew)) {
    const member = crewById[cid as CrewId];
    if (!member) continue;
    let prevPos: Vec2 = { ...target.getawayPos };
    let prevFloor: number = 0;

    for (const block of orderedByCrew[cid]) {
      const node = block.targetNodeId ? nodesById[block.targetNodeId] : undefined;
      const metrics = calculateActionMetrics({
        type: block.type,
        member,
        node,
        fromPos: prevPos,
        fromFloor: prevFloor,
        targetPos: block.targetPos,
        targetFloor: block.floor,
        toolsById,
        explicitToolId: block.toolId,
        requestedDurationSec: block.durationSec,
      });
      block.durationSec = metrics.durationSec;
      block.estimatedNoise = metrics.estimatedNoise;
      block.estimatedTraceRisk = metrics.estimatedTraceRisk;
      if (!block.toolId && metrics.usedToolId) {
        block.toolId = metrics.usedToolId;
      }
      prevPos = { ...block.targetPos };
      prevFloor = block.floor;
    }
  }

  // Build DAG edges:
  // 1) Sequential track edges: block[i-1] -> block[i] for same crew member
  // 2) SyncBarrier edges: fromBlockId -> toBlockId
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

  // Kahn's topological sort for DAG scheduling & cycle detection
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

  // Compute start/end times in topological order (fallback to requested for cycle nodes)
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

  // Tactical checks (warnings / info — non-blocking)
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

  // Check if alarm-linked safe is opened before alarm bypass completes
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
        message: `Hoher Lärmpegel (${b.estimatedNoise}) bei „${b.label}“ — Wachen in der Nähe könnten aufmerksam werden.`,
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

/**
 * Checks whether adding a sync barrier from -> to would introduce a cycle.
 */
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

  // BFS from toBlockId to see if we can reach fromBlockId
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

/**
 * Selects the matching Plan B fallback branch for a crew member given a trigger.
 */
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

/**
 * Helper to create a well-formed default ActionBlock when clicking a node on the Reißbrett.
 */
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
