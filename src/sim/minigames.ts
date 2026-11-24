import {
  ActiveMinigame,
  CircuitWire,
  CrewMember,
  LockpickPin,
  MinigameKind,
  TargetNode,
  ToolDef,
  ToolId,
} from './types';

// ============================================================================
// Tactile Heist Minigame Resolvers:
// 1) Lockpick / Safe Combination Dial (Pin/Tumbler Tension Sweet-Spots)
// 2) Securion Circuit Bypass (Mara's Ex-Securion Engineer Schematic Puzzle)
// ============================================================================

function deterministicHash(seedStr: string): number {
  let h = 2166136261;
  for (let i = 0; i < seedStr.length; i++) {
    h ^= seedStr.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function nextSeed(s: number): number {
  let t = (s + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

export function inferMinigameKind(node: TargetNode): MinigameKind | null {
  switch (node.kind) {
    case 'safe':
      return 'safe_dial';
    case 'entry_door':
    case 'entry_service':
    case 'entry_window':
    case 'entry_cellar':
    case 'lock':
    case 'loot_case':
      return 'lockpick';
    case 'power_box':
    case 'alarm_panel':
    case 'camera':
    case 'hidden_trap':
      return 'securion_circuit';
    default:
      return null;
  }
}

export function createMinigameForNode(params: {
  node: TargetNode;
  member: CrewMember;
  toolsById: Record<ToolId, ToolDef>;
  startedAtSec: number;
}): ActiveMinigame {
  const { node, member, startedAtSec } = params;
  const kind = inferMinigameKind(node) ?? 'lockpick';
  let rng = deterministicHash(`${node.id}_${member.id}_${Math.round(startedAtSec)}`);

  const randRange = (min: number, max: number) => {
    rng = nextSeed(rng);
    return min + (rng / 4294967296) * (max - min);
  };

  if (kind === 'securion_circuit') {
    const hasBypass = member.equippedTools.includes('electronic_bypass');
    const skillBonus = member.skills.electronics;
    const isPowerBox = node.kind === 'power_box';
    const modelTag =
      node.difficulty >= 8
        ? 'SECURION S5-PRO'
        : node.difficulty >= 5
          ? 'SECURION S4-BUS'
          : 'SECURION S2-STD';

    const wires: CircuitWire[] = isPowerBox
      ? [
          {
            id: 'w_phase_a',
            label: 'L1 Beleuchtung & CCTV',
            color: '#38bdf8',
            role: 'power_feed',
            actionRequired: 'cut',
            resolved: false,
            tripped: false,
          },
          {
            id: 'w_tamper',
            label: 'T1 Sabotage-Schleife (Notstrom)',
            color: '#ef4444',
            role: 'tamper_backup',
            actionRequired: 'leave',
            resolved: false,
            tripped: false,
          },
          {
            id: 'w_relay',
            label: 'S2 Relais-Brücke',
            color: '#f59e0b',
            role: 'sensor_loop',
            actionRequired: 'bridge',
            resolved: false,
            tripped: false,
          },
          {
            id: 'w_ground',
            label: 'PE Schutzleiter',
            color: '#64748b',
            role: 'decoy',
            actionRequired: 'leave',
            resolved: false,
            tripped: false,
          },
        ]
      : [
          {
            id: 'w_sensor',
            label: 'K1 Glas-/Tresor-Schleife',
            color: '#38bdf8',
            role: 'sensor_loop',
            actionRequired: 'bridge',
            resolved: false,
            tripped: false,
          },
          {
            id: 'w_silent',
            label: 'M2 Stiller Mossos-Ruf',
            color: '#f59e0b',
            role: 'power_feed',
            actionRequired: 'cut',
            resolved: false,
            tripped: false,
          },
          {
            id: 'w_tamper',
            label: 'T0 Abreißkontakt (NICHT TRENNEN)',
            color: '#ef4444',
            role: 'tamper_backup',
            actionRequired: 'leave',
            resolved: false,
            tripped: false,
          },
          {
            id: 'w_clock',
            label: 'CLK Wartungstakt',
            color: '#a78bfa',
            role: 'decoy',
            actionRequired: 'leave',
            resolved: false,
            tripped: false,
          },
        ];

    const schematicHint = hasBypass
      ? `Diagnose-Dongle aktiv (${modelTag}): Blaue/Gelbe Leitung brücken bzw. trennen — roten Sabotage-Kreis unberührt lassen!`
      : skillBonus >= 7
        ? `Maras Securion-Wissen (${modelTag}): Sensor-Schleife brücken, stillen Ruf trennen, roten Abreißkontakt niemals durchtrennen.`
        : `${modelTag}: Leitungen prüfen — roter Draht löst sofortigen Sabotage-Alarm aus.`;

    return {
      id: `mg_${node.id}_${Math.round(startedAtSec * 10)}`,
      kind,
      nodeId: node.id,
      nodeLabel: node.label,
      difficulty: node.difficulty,
      crewId: member.id,
      startedAtSec,
      wires,
      securionModel: modelTag,
      schematicHint,
      slips: 0,
      maxSlips: hasBypass ? 3 : 2,
      status: 'active',
    };
  }

  // Lockpick or Safe Dial
  const hasLockpick = member.equippedTools.includes('lockpick_set');
  const hasThermal = member.equippedTools.includes('thermal_lance');
  const pinCount = kind === 'safe_dial' ? (node.difficulty >= 8 ? 4 : 3) : node.difficulty >= 6 ? 4 : 3;
  const baseTolerance =
    14 +
    (member.skills.locks - node.difficulty) * 1.4 +
    (hasLockpick ? 4 : 0) +
    (kind === 'safe_dial' && hasThermal ? 5 : 0);
  const tolerance = Math.max(7, Math.min(22, Math.round(baseTolerance)));

  const pins: LockpickPin[] = [];
  for (let i = 0; i < pinCount; i++) {
    pins.push({
      index: i,
      sweetSpot: Math.round(randRange(16, 84)),
      tolerance,
      solved: false,
    });
  }

  return {
    id: `mg_${node.id}_${Math.round(startedAtSec * 10)}`,
    kind,
    nodeId: node.id,
    nodeLabel: node.label,
    difficulty: node.difficulty,
    crewId: member.id,
    startedAtSec,
    pins,
    activePinIndex: 0,
    tension: 50,
    slips: 0,
    maxSlips: kind === 'safe_dial' ? 3 : 3,
    status: 'active',
  };
}

export interface LockpickAttemptResult {
  game: ActiveMinigame;
  hit: boolean;
  slipped: boolean;
  noiseDelta: number;
  traceDelta: number;
  completed: boolean;
  failed: boolean;
}

export function attemptLockpickPin(
  game: ActiveMinigame,
  cursorValue: number
): LockpickAttemptResult {
  if (game.status !== 'active' || !game.pins || game.activePinIndex === undefined) {
    return {
      game,
      hit: false,
      slipped: false,
      noiseDelta: 0,
      traceDelta: 0,
      completed: game.status === 'success',
      failed: game.status === 'failed',
    };
  }

  const next: ActiveMinigame = structuredClone(game);
  const pin = next.pins![next.activePinIndex!];
  const dist = Math.abs(cursorValue - pin.sweetSpot);

  if (dist <= pin.tolerance) {
    pin.solved = true;
    const nextIdx = next.pins!.findIndex((p) => !p.solved);
    if (nextIdx === -1) {
      next.status = 'success';
      return {
        game: next,
        hit: true,
        slipped: false,
        noiseDelta: 4,
        traceDelta: 0,
        completed: true,
        failed: false,
      };
    }
    next.activePinIndex = nextIdx;
    return {
      game: next,
      hit: true,
      slipped: false,
      noiseDelta: 6,
      traceDelta: 0,
      completed: false,
      failed: false,
    };
  }

  // Slip! Creates a realistic metallic snap noise + forensic scratch trace
  next.slips += 1;
  const failed = next.slips >= next.maxSlips;
  if (failed) {
    next.status = 'failed';
  }
  return {
    game: next,
    hit: false,
    slipped: true,
    noiseDelta: game.kind === 'safe_dial' ? 28 : 22,
    traceDelta: 12,
    completed: false,
    failed,
  };
}

export interface CircuitAttemptResult {
  game: ActiveMinigame;
  correct: boolean;
  trippedTamper: boolean;
  noiseDelta: number;
  traceDelta: number;
  completed: boolean;
  failed: boolean;
}

export function attemptCircuitWireAction(
  game: ActiveMinigame,
  wireId: string,
  action: 'cut' | 'bridge'
): CircuitAttemptResult {
  if (game.status !== 'active' || !game.wires) {
    return {
      game,
      correct: false,
      trippedTamper: false,
      noiseDelta: 0,
      traceDelta: 0,
      completed: game.status === 'success',
      failed: game.status === 'failed',
    };
  }

  const next: ActiveMinigame = structuredClone(game);
  const wire = next.wires!.find((w) => w.id === wireId);
  if (!wire || wire.resolved) {
    return {
      game: next,
      correct: false,
      trippedTamper: false,
      noiseDelta: 0,
      traceDelta: 0,
      completed: false,
      failed: false,
    };
  }

  if (wire.role === 'tamper_backup') {
    wire.tripped = true;
    next.slips = next.maxSlips;
    next.status = 'failed';
    return {
      game: next,
      correct: false,
      trippedTamper: true,
      noiseDelta: 45,
      traceDelta: 22,
      completed: false,
      failed: true,
    };
  }

  if (wire.actionRequired === action) {
    wire.resolved = true;
    const remainingRequired = next.wires!.filter(
      (w) => w.actionRequired !== 'leave' && !w.resolved
    );
    const completed = remainingRequired.length === 0;
    if (completed) next.status = 'success';
    return {
      game: next,
      correct: true,
      trippedTamper: false,
      noiseDelta: 4,
      traceDelta: 0,
      completed,
      failed: false,
    };
  }

  // Wrong action (e.g. cut instead of bridge, or touched decoy)
  next.slips += 1;
  wire.tripped = true;
  const failed = next.slips >= next.maxSlips;
  if (failed) next.status = 'failed';
  return {
    game: next,
    correct: false,
    trippedTamper: failed,
    noiseDelta: 20,
    traceDelta: 10,
    completed: false,
    failed,
  };
}

export function autoCompleteMinigame(game: ActiveMinigame): ActiveMinigame {
  const next: ActiveMinigame = structuredClone(game);
  if (next.pins) {
    for (const p of next.pins) p.solved = true;
  }
  if (next.wires) {
    for (const w of next.wires) {
      if (w.actionRequired !== 'leave') w.resolved = true;
    }
  }
  next.status = 'success';
  return next;
}
