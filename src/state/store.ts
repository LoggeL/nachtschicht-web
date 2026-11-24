import { create } from 'zustand';
import {
  ActionBlock,
  ActionType,
  ActiveMinigame,
  CaseFileLedger,
  CountermeasureId,
  CrewId,
  CrewMember,
  EndingChoice,
  EscapeState,
  EvidenceDraft,
  FenceId,
  FloorId,
  ForensicLoadout,
  GamePhase,
  GraphicsQuality,
  HeistDebrief,
  HeistPlan,
  HeistTarget,
  IntelState,
  InteractOutcome,
  LiveExecutionState,
  LiveGuardState,
  PlanBBranch,
  RadioCommandType,
  RehearsalSnapshot,
  ResolvedPlan,
  ScoutingHudState,
  StealthTelemetry,
  StoryBeat,
  TargetId,
  ToolId,
  Vec2,
  WorkshopUpgrade,
  WorkshopUpgradeId,
} from '../sim/types';
import {
  COUNTERMEASURES,
  FENCES,
  TARGET_ORDER,
  TARGETS,
  TOOLS,
  buildStarterPlan,
  computeIntelCompletion,
  createInitialCrew,
  createInitialIntel,
  createInitialStoryBeats,
  createInitialWorkshopUpgrades,
  getDefaultForensicLoadout,
} from '../sim/data';
import {
  calculateActionMetrics,
  createSyncBarrier,
  inferActionTypeForNode,
  resolvePlan,
  wouldSyncCreateCycle,
} from '../sim/planner';
import { simulateRehearsalAt } from '../sim/simulator';
import {
  LiveTickOptions,
  applyRadioCommand,
  computeStealthTelemetry,
  createInitialEscapeState,
  createInitialLiveState,
  playerInteractWithNode,
  pushNoisePulse,
  tickLiveExecution,
} from '../sim/liveEngine';
import {
  appendEvidenceToCaseFile,
  applyCountermeasureToCaseFile,
  createInitialCaseFile,
  settleHeistDebrief,
} from '../sim/caseFile';
import {
  attemptCircuitWireAction,
  attemptLockpickPin,
  autoCompleteMinigame,
  createMinigameForNode,
} from '../sim/minigames';
import { canScoutNodeFrom } from '../sim/pathfinding';

// ============================================================================
// NACHTSCHICHT — Root Zustand Store (Round 2 Wave 1 Realism Contract)
// ============================================================================

const STORAGE_KEY = 'nachtschicht_save_v1';

interface PersistedSave {
  version: 1;
  day: number;
  bankrollEur: number;
  activeTargetId: TargetId;
  completedTargetIds: TargetId[];
  crew: Record<CrewId, CrewMember>;
  ownedTools: ToolId[];
  workshopUpgrades: WorkshopUpgrade[];
  intelByTarget: Record<TargetId, IntelState>;
  plansByTarget: Record<TargetId, HeistPlan>;
  caseFile: CaseFileLedger;
  storyBeats: StoryBeat[];
  selectedEnding: EndingChoice | null;
  graphicsQuality?: GraphicsQuality;
}

function buildInitialIntelMap(hasBlueprintUpgrade = false): Record<TargetId, IntelState> {
  return {
    casa_oro: createInitialIntel(TARGETS.casa_oro, hasBlueprintUpgrade),
    perla_del_mar: createInitialIntel(TARGETS.perla_del_mar, hasBlueprintUpgrade),
    villa_mirador: createInitialIntel(TARGETS.villa_mirador, hasBlueprintUpgrade),
    schatzkammer_dresden: createInitialIntel(
      TARGETS.schatzkammer_dresden,
      hasBlueprintUpgrade
    ),
  };
}

function buildInitialPlansMap(crew: Record<CrewId, CrewMember>): Record<TargetId, HeistPlan> {
  const recruited = Object.values(crew)
    .filter((c) => c.recruited && c.status === 'available')
    .map((c) => c.id) as CrewId[];
  return {
    casa_oro: buildStarterPlan('casa_oro', recruited),
    perla_del_mar: buildStarterPlan('perla_del_mar', recruited),
    villa_mirador: buildStarterPlan('villa_mirador', recruited),
    schatzkammer_dresden: buildStarterPlan('schatzkammer_dresden', recruited),
  };
}

function createDefaultScoutingState(): ScoutingHudState {
  return {
    binocularsActive: false,
    nearbyNodeId: null,
    nearbyNodeLabel: null,
    scanProgress: 0,
    timingGuardId: null,
    timingGuardName: null,
    guardTimingProgress: 0,
    lastDiscoveryToast: null,
    playerPos: { x: 0, z: 10 },
    playerFloor: 0,
    blockedReason: null,
  };
}

function loadSavedState(): PersistedSave | null {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedSave;
    if (parsed && parsed.version === 1 && parsed.crew && parsed.caseFile) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function persistState(state: GameStore): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    const payload: PersistedSave = {
      version: 1,
      day: state.day,
      bankrollEur: state.bankrollEur,
      activeTargetId: state.activeTargetId,
      completedTargetIds: state.completedTargetIds,
      crew: state.crew,
      ownedTools: state.ownedTools,
      workshopUpgrades: state.workshopUpgrades,
      intelByTarget: state.intelByTarget,
      plansByTarget: state.plansByTarget,
      caseFile: state.caseFile,
      storyBeats: state.storyBeats,
      selectedEnding: state.selectedEnding,
      graphicsQuality: state.graphicsQuality,
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Ignore storage quota errors in private mode
  }
}

export interface AddBlockInput {
  crewId: CrewId;
  type?: ActionType;
  nodeId?: string;
  label?: string;
  targetPos?: Vec2;
  floor?: FloorId;
  startSec?: number;
  durationSec?: number;
  toolId?: ToolId;
}

export interface GameStore {
  // Core Campaign State
  phase: GamePhase;
  hasSavedGame: boolean;
  day: number;
  bankrollEur: number;
  activeTargetId: TargetId;
  completedTargetIds: TargetId[];
  graphicsQuality: GraphicsQuality;

  // Entities & Economy
  crew: Record<CrewId, CrewMember>;
  ownedTools: ToolId[];
  workshopUpgrades: WorkshopUpgrade[];
  intelByTarget: Record<TargetId, IntelState>;
  plansByTarget: Record<TargetId, HeistPlan>;
  caseFile: CaseFileLedger;
  storyBeats: StoryBeat[];
  activeStoryBeatId: string | null;
  selectedEnding: EndingChoice | null;

  // Reißbrett UI & Rehearsal State
  selectedFloor: FloorId;
  selectedCrewId: CrewId;
  rehearsalTimeSec: number;
  rehearsalPlaying: boolean;
  rehearsalSpeed: 1 | 2 | 4;

  // Live 3D State (Scouting, Executing, Escape, Debrief)
  scoutingState: ScoutingHudState;
  liveState: LiveExecutionState | null;
  escapeState: EscapeState | null;
  lastDebrief: HeistDebrief | null;
  audioMuted: boolean;

  // Derived Selectors
  getActiveTarget: () => HeistTarget;
  getActiveIntel: () => IntelState;
  getActivePlan: () => HeistPlan;
  getResolvedPlan: (targetId?: TargetId) => ResolvedPlan;
  getRehearsalSnapshot: (timeSec?: number) => RehearsalSnapshot;

  // Navigation, Quality & Campaign Flow
  setPhase: (phase: GamePhase) => void;
  setGraphicsQuality: (quality: GraphicsQuality) => void;
  startNewCampaign: () => void;
  continueCampaign: () => void;
  quickPlayTarget: (
    targetId: TargetId,
    mode?: 'planning' | 'scouting' | 'executing'
  ) => void;
  selectTarget: (targetId: TargetId) => void;
  returnToSafehouse: () => void;
  resetSave: () => void;

  // Crew, Forensic Loadout, Tools & Workshop
  recruitCrew: (crewId: CrewId) => boolean;
  toggleCrewOnPlan: (crewId: CrewId) => void;
  buyTool: (toolId: ToolId) => boolean;
  equipTool: (crewId: CrewId, toolId: ToolId) => void;
  unequipTool: (crewId: CrewId, toolId: ToolId) => void;
  setCrewForensicLoadout: (
    crewId: CrewId,
    patch: Partial<ForensicLoadout>
  ) => void;
  completeLoyaltyQuest: (crewId: CrewId) => boolean;
  buyWorkshopUpgrade: (upgradeId: WorkshopUpgradeId) => boolean;

  // Scouting & Intel (Wall-Occluded Fog of War)
  setScoutingState: (patch: Partial<ScoutingHudState>) => void;
  discoverNode: (
    targetId: TargetId,
    nodeId: string,
    observerCheck?: { pos: Vec2; floor: FloorId; binocularsActive?: boolean }
  ) => boolean;
  timeGuardPatrol: (targetId: TargetId, guardId: string) => void;
  scoutRoom: (targetId: TargetId, roomId: string) => void;
  buyTargetBlueprints: (targetId: TargetId) => boolean;

  // Das Reißbrett (Planning & Rehearsal)
  setSelectedFloor: (floor: FloorId) => void;
  setSelectedCrewId: (crewId: CrewId) => void;
  loadStarterPlan: (targetId?: TargetId) => void;
  addPlanBlock: (input: AddBlockInput) => ActionBlock | null;
  updatePlanBlock: (blockId: string, patch: Partial<ActionBlock>) => void;
  removePlanBlock: (blockId: string) => void;
  clearCrewTrack: (crewId: CrewId) => void;
  addSyncBarrier: (
    fromBlockId: string,
    toBlockId: string,
    label?: string
  ) => { ok: boolean; error?: string };
  removeSyncBarrier: (barrierId: string) => void;
  setPlanBBranch: (branch: PlanBBranch) => void;
  removePlanBBranch: (branchId: string) => void;
  setPlanFence: (fenceId: FenceId) => void;
  setRehearsalTime: (timeSec: number) => void;
  setRehearsalPlaying: (playing: boolean) => void;
  setRehearsalSpeed: (speed: 1 | 2 | 4) => void;

  // Live Execution, Positional Noise, Guard Sync & Minigames
  launchHeist: (targetId?: TargetId) => void;
  tickLiveExecution: (dtSec: number, options?: LiveTickOptions) => void;
  updatePlayerLivePos: (
    pos: Vec2,
    floor: FloorId,
    headingDeg: number,
    sneaking: boolean,
    speedMps?: number
  ) => void;
  interactPlayerWithNode: (nodeId: string, outcome?: InteractOutcome) => void;
  emitNoisePulse: (
    pos: Vec2,
    floor: FloorId,
    noiseDb: number,
    label: string,
    sourceCrewId?: CrewId
  ) => void;
  syncLiveGuards: (guards: LiveGuardState[]) => void;
  syncStealthTelemetry: (patch: Partial<StealthTelemetry>) => void;
  recordWitnessEvidence: (draft: EvidenceDraft) => void;
  issueRadioCommand: (
    command: RadioCommandType,
    targetCrewId?: CrewId | 'all'
  ) => void;
  triggerAlarmExternal: (reason?: string) => void;

  // Tactile Minigames (Lockpicking / Safe Dial / Securion Circuit Bypass)
  startMinigame: (nodeId: string) => ActiveMinigame | null;
  attemptMinigameLockpick: (cursorValue: number) => {
    hit: boolean;
    slipped: boolean;
    completed: boolean;
    failed: boolean;
  };
  attemptMinigameCircuitWire: (
    wireId: string,
    action: 'cut' | 'bridge'
  ) => {
    correct: boolean;
    trippedTamper: boolean;
    completed: boolean;
    failed: boolean;
  };
  autoCompleteActiveMinigame: () => void;
  cancelMinigame: () => void;

  // Escape & Debrief
  startEscape: () => void;
  updateEscapeState: (patch: Partial<EscapeState>) => void;
  finishEscape: (escaped: boolean) => void;

  // Die Akte & Story
  applyCountermeasure: (countermeasureId: CountermeasureId) => boolean;
  openStoryBeat: (beatId: string) => void;
  dismissStoryBeat: () => void;
  chooseEnding: (ending: EndingChoice) => void;
  toggleAudioMuted: () => void;
}

const initialCrew = createInitialCrew();
const savedOnBoot = loadSavedState();

const DEFAULT_OWNED_TOOLS: ToolId[] = [
  'lockpick_set',
  'electronic_bypass',
  'camera_loop',
  'glass_cutter',
  'crowbar',
  'gloves',
  'mask',
  'dark_clothing',
];

export const useGameStore = create<GameStore>((set, get) => ({
  phase: 'title',
  hasSavedGame: savedOnBoot !== null,
  day: 1,
  bankrollEur: 12000,
  activeTargetId: 'casa_oro',
  completedTargetIds: [],
  graphicsQuality: savedOnBoot?.graphicsQuality ?? 'high',

  crew: initialCrew,
  ownedTools: [...DEFAULT_OWNED_TOOLS],
  workshopUpgrades: createInitialWorkshopUpgrades(),
  intelByTarget: buildInitialIntelMap(false),
  plansByTarget: buildInitialPlansMap(initialCrew),
  caseFile: createInitialCaseFile(),
  storyBeats: createInitialStoryBeats(),
  activeStoryBeatId: null,
  selectedEnding: null,

  selectedFloor: 0,
  selectedCrewId: 'mara',
  rehearsalTimeSec: 0,
  rehearsalPlaying: false,
  rehearsalSpeed: 1,

  scoutingState: createDefaultScoutingState(),
  liveState: null,
  escapeState: null,
  lastDebrief: null,
  audioMuted: false,

  // ---- Derived Selectors ----
  getActiveTarget: () => TARGETS[get().activeTargetId],
  getActiveIntel: () => get().intelByTarget[get().activeTargetId],
  getActivePlan: () => get().plansByTarget[get().activeTargetId],

  getResolvedPlan: (targetId) => {
    const s = get();
    const tid = targetId ?? s.activeTargetId;
    return resolvePlan({
      plan: s.plansByTarget[tid],
      target: TARGETS[tid],
      crewById: s.crew,
      toolsById: TOOLS,
      intel: s.intelByTarget[tid],
    });
  },

  getRehearsalSnapshot: (timeSec) => {
    const s = get();
    const resolvedPlan = s.getResolvedPlan();
    return simulateRehearsalAt({
      resolvedPlan,
      target: TARGETS[s.activeTargetId],
      intel: s.intelByTarget[s.activeTargetId],
      timeSec: timeSec ?? s.rehearsalTimeSec,
    });
  },

  // ---- Navigation & Campaign Flow ----
  setPhase: (phase) => {
    if (phase === 'executing' && !get().liveState) {
      get().launchHeist();
      return;
    }
    if (phase === 'escape' && !get().escapeState) {
      get().startEscape();
      return;
    }
    if (phase === 'scouting') {
      set({
        phase: 'scouting',
        rehearsalPlaying: false,
        scoutingState: createDefaultScoutingState(),
      });
      return;
    }
    set({ phase, rehearsalPlaying: false });
  },

  setGraphicsQuality: (graphicsQuality) => {
    set({ graphicsQuality });
    persistState(get());
  },

  startNewCampaign: () => {
    const freshCrew = createInitialCrew();
    const freshIntel = buildInitialIntelMap(false);
    const freshPlans = buildInitialPlansMap(freshCrew);
    const freshBeats = createInitialStoryBeats();
    set({
      phase: 'safehouse',
      hasSavedGame: true,
      day: 1,
      bankrollEur: 12000,
      activeTargetId: 'casa_oro',
      completedTargetIds: [],
      crew: freshCrew,
      ownedTools: [...DEFAULT_OWNED_TOOLS],
      workshopUpgrades: createInitialWorkshopUpgrades(),
      intelByTarget: freshIntel,
      plansByTarget: freshPlans,
      caseFile: createInitialCaseFile(),
      storyBeats: freshBeats,
      activeStoryBeatId: 'beat_act1_intro',
      selectedEnding: null,
      selectedFloor: 0,
      selectedCrewId: 'mara',
      rehearsalTimeSec: 0,
      rehearsalPlaying: false,
      scoutingState: createDefaultScoutingState(),
      liveState: null,
      escapeState: null,
      lastDebrief: null,
    });
    persistState(get());
  },

  continueCampaign: () => {
    const saved = loadSavedState();
    if (!saved) {
      get().startNewCampaign();
      return;
    }
    set({
      phase: 'safehouse',
      hasSavedGame: true,
      day: saved.day,
      bankrollEur: saved.bankrollEur,
      activeTargetId: saved.activeTargetId,
      completedTargetIds: saved.completedTargetIds,
      crew: saved.crew,
      ownedTools: saved.ownedTools,
      workshopUpgrades: saved.workshopUpgrades,
      intelByTarget: saved.intelByTarget,
      plansByTarget: saved.plansByTarget,
      caseFile: saved.caseFile,
      storyBeats: saved.storyBeats,
      activeStoryBeatId: null,
      selectedEnding: saved.selectedEnding,
      graphicsQuality: saved.graphicsQuality ?? 'high',
      selectedFloor: 0,
      rehearsalTimeSec: 0,
      rehearsalPlaying: false,
      liveState: null,
      escapeState: null,
    });
  },

  quickPlayTarget: (targetId, mode = 'planning') => {
    const s = get();
    const target = TARGETS[targetId];
    const updatedCrew = { ...s.crew };
    if (targetId === 'villa_mirador' || targetId === 'schatzkammer_dresden') {
      updatedCrew.toni = { ...updatedCrew.toni, recruited: true };
      updatedCrew.rico = { ...updatedCrew.rico, recruited: true };
    }
    const availableIds = Object.values(updatedCrew)
      .filter((c) => c.recruited && c.status === 'available')
      .map((c) => c.id);
    const starterPlan = buildStarterPlan(targetId, availableIds);
    const existingIntel = s.intelByTarget[targetId] ?? createInitialIntel(target);

    set({
      activeTargetId: targetId,
      crew: updatedCrew,
      plansByTarget: { ...s.plansByTarget, [targetId]: starterPlan },
      intelByTarget: { ...s.intelByTarget, [targetId]: existingIntel },
      selectedFloor: 0,
      selectedCrewId: 'mara',
      rehearsalTimeSec: 0,
      rehearsalPlaying: false,
      activeStoryBeatId: null,
      liveState: null,
      escapeState: null,
    });

    if (mode === 'executing') {
      get().launchHeist(targetId);
    } else if (mode === 'scouting') {
      set({ phase: 'scouting', scoutingState: createDefaultScoutingState() });
    } else {
      set({ phase: 'planning' });
    }
  },

  selectTarget: (targetId) => {
    const target = TARGETS[targetId];
    const defaultFloor = target.floors.includes(0) ? 0 : target.floors[0];
    set({
      activeTargetId: targetId,
      selectedFloor: defaultFloor,
      rehearsalTimeSec: 0,
      rehearsalPlaying: false,
    });
    persistState(get());
  },

  returnToSafehouse: () => {
    set({
      phase: 'safehouse',
      rehearsalPlaying: false,
      liveState: null,
      escapeState: null,
    });
    persistState(get());
  },

  resetSave: () => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // ignore
    }
    const freshCrew = createInitialCrew();
    set({
      phase: 'title',
      hasSavedGame: false,
      day: 1,
      bankrollEur: 12000,
      activeTargetId: 'casa_oro',
      completedTargetIds: [],
      crew: freshCrew,
      ownedTools: [...DEFAULT_OWNED_TOOLS],
      workshopUpgrades: createInitialWorkshopUpgrades(),
      intelByTarget: buildInitialIntelMap(false),
      plansByTarget: buildInitialPlansMap(freshCrew),
      caseFile: createInitialCaseFile(),
      storyBeats: createInitialStoryBeats(),
      activeStoryBeatId: null,
      selectedEnding: null,
      liveState: null,
      escapeState: null,
      lastDebrief: null,
    });
  },

  // ---- Crew, Forensic Loadout, Tools & Workshop ----
  recruitCrew: (crewId) => {
    const s = get();
    const member = s.crew[crewId];
    if (!member || member.recruited || s.bankrollEur < member.recruitCostEur) {
      return false;
    }
    set({
      bankrollEur: s.bankrollEur - member.recruitCostEur,
      crew: {
        ...s.crew,
        [crewId]: { ...member, recruited: true },
      },
    });
    persistState(get());
    return true;
  },

  toggleCrewOnPlan: (crewId) => {
    const s = get();
    if (crewId === 'mara') return;
    const member = s.crew[crewId];
    if (!member || !member.recruited || member.status !== 'available') return;

    const plan = s.plansByTarget[s.activeTargetId];
    const isAssigned = plan.assignedCrewIds.includes(crewId);
    const assignedCrewIds = isAssigned
      ? plan.assignedCrewIds.filter((id) => id !== crewId)
      : [...plan.assignedCrewIds, crewId];

    const blocks = isAssigned
      ? plan.blocks.filter((b) => b.crewId !== crewId)
      : plan.blocks;
    const syncBarriers = isAssigned
      ? plan.syncBarriers.filter(
          (sb) => sb.fromCrewId !== crewId && sb.toCrewId !== crewId
        )
      : plan.syncBarriers;

    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          assignedCrewIds,
          blocks,
          syncBarriers,
        },
      },
    });
    persistState(get());
  },

  buyTool: (toolId) => {
    const s = get();
    const def = TOOLS[toolId];
    if (!def || s.ownedTools.includes(toolId) || s.bankrollEur < def.costEur) {
      return false;
    }
    set({
      bankrollEur: s.bankrollEur - def.costEur,
      ownedTools: [...s.ownedTools, toolId],
    });
    persistState(get());
    return true;
  },

  equipTool: (crewId, toolId) => {
    const s = get();
    const member = s.crew[crewId];
    if (!member || !s.ownedTools.includes(toolId)) return;
    if (member.equippedTools.includes(toolId)) return;
    set({
      crew: {
        ...s.crew,
        [crewId]: {
          ...member,
          equippedTools: [...member.equippedTools, toolId],
        },
      },
    });
    persistState(get());
  },

  unequipTool: (crewId, toolId) => {
    const s = get();
    const member = s.crew[crewId];
    if (!member) return;
    set({
      crew: {
        ...s.crew,
        [crewId]: {
          ...member,
          equippedTools: member.equippedTools.filter((t) => t !== toolId),
        },
      },
    });
    persistState(get());
  },

  setCrewForensicLoadout: (crewId, patch) => {
    const s = get();
    const member = s.crew[crewId];
    if (!member) return;
    const plan = s.plansByTarget[s.activeTargetId];
    const current =
      plan.forensicLoadoutByCrew?.[crewId] ?? getDefaultForensicLoadout(member);
    const updated: ForensicLoadout = { ...current, ...patch };

    // Sync passive gear into member's equippedTools cleanly
    let nextTools = [...member.equippedTools];
    const syncFlag = (tid: ToolId, enabled: boolean) => {
      if (enabled && !nextTools.includes(tid)) nextTools.push(tid);
      if (!enabled) nextTools = nextTools.filter((t) => t !== tid);
    };
    syncFlag('gloves', updated.gloves);
    syncFlag('mask', updated.mask);
    syncFlag('dark_clothing', updated.darkClothing);
    if (!nextTools.includes(updated.entryTool)) {
      nextTools.push(updated.entryTool);
    }

    set({
      crew: {
        ...s.crew,
        [crewId]: { ...member, equippedTools: nextTools },
      },
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          forensicLoadoutByCrew: {
            ...(plan.forensicLoadoutByCrew ?? {}),
            [crewId]: updated,
          },
        },
      },
    });
    persistState(get());
  },

  completeLoyaltyQuest: (crewId) => {
    const s = get();
    const member = s.crew[crewId];
    const q = member?.loyaltyQuest;
    if (!member || !q || q.completed || s.bankrollEur < q.costEur) return false;
    set({
      bankrollEur: s.bankrollEur - q.costEur,
      crew: {
        ...s.crew,
        [crewId]: {
          ...member,
          traits: {
            ...member.traits,
            loyalty: Math.min(100, member.traits.loyalty + q.loyaltyGain),
          },
          loyaltyQuest: { ...q, completed: true },
        },
      },
    });
    persistState(get());
    return true;
  },

  buyWorkshopUpgrade: (upgradeId) => {
    const s = get();
    const upg = s.workshopUpgrades.find((u) => u.id === upgradeId);
    if (!upg || upg.purchased || s.bankrollEur < upg.costEur) return false;
    const nextUpgrades = s.workshopUpgrades.map((u) =>
      u.id === upgradeId ? { ...u, purchased: true } : u
    );
    set({
      bankrollEur: s.bankrollEur - upg.costEur,
      workshopUpgrades: nextUpgrades,
    });
    persistState(get());
    return true;
  },

  // ---- Scouting & Intel (Wall-Occluded) ----
  setScoutingState: (patch) => {
    set((s) => ({ scoutingState: { ...s.scoutingState, ...patch } }));
  },

  discoverNode: (targetId, nodeId, observerCheck) => {
    const s = get();
    const target = TARGETS[targetId];
    const intel = s.intelByTarget[targetId];
    if (!target || !intel || intel.discoveredNodeIds.includes(nodeId)) return false;

    const node = target.nodes.find((n) => n.id === nodeId);
    if (!node) return false;

    // Optional strict solid-wall Line-of-Sight verification when called from 3D scouting
    if (observerCheck) {
      const check = canScoutNodeFrom({
        target,
        observerPos: observerCheck.pos,
        observerFloor: observerCheck.floor,
        node,
        binocularsActive: observerCheck.binocularsActive,
      });
      if (!check.canScout) {
        set((st) => ({
          scoutingState: {
            ...st.scoutingState,
            blockedReason: check.reason ?? 'wall_occluded',
          },
        }));
        return false;
      }
    }

    const discoveredNodeIds = [...intel.discoveredNodeIds, nodeId];
    const scoutedRoomIds = !intel.scoutedRoomIds.includes(node.roomId)
      ? [...intel.scoutedRoomIds, node.roomId]
      : intel.scoutedRoomIds;

    const completionPercent = computeIntelCompletion(
      target,
      discoveredNodeIds,
      intel.timedGuardIds
    );

    set({
      intelByTarget: {
        ...s.intelByTarget,
        [targetId]: {
          ...intel,
          discoveredNodeIds,
          scoutedRoomIds,
          completionPercent,
        },
      },
      scoutingState: {
        ...s.scoutingState,
        blockedReason: null,
        lastDiscoveryToast: `Entdeckt: ${node.label}`,
      },
    });
    persistState(get());
    return true;
  },

  timeGuardPatrol: (targetId, guardId) => {
    const s = get();
    const target = TARGETS[targetId];
    const intel = s.intelByTarget[targetId];
    if (!target || !intel || intel.timedGuardIds.includes(guardId)) return;

    const guard = target.guards.find((g) => g.id === guardId);
    const timedGuardIds = [...intel.timedGuardIds, guardId];
    const completionPercent = computeIntelCompletion(
      target,
      intel.discoveredNodeIds,
      timedGuardIds
    );

    set({
      intelByTarget: {
        ...s.intelByTarget,
        [targetId]: {
          ...intel,
          timedGuardIds,
          completionPercent,
        },
      },
      scoutingState: {
        ...s.scoutingState,
        lastDiscoveryToast: guard
          ? `Wachrunde gestoppt: ${guard.name}`
          : null,
      },
    });
    persistState(get());
  },

  scoutRoom: (targetId, roomId) => {
    const s = get();
    const intel = s.intelByTarget[targetId];
    if (!intel || intel.scoutedRoomIds.includes(roomId)) return;
    set({
      intelByTarget: {
        ...s.intelByTarget,
        [targetId]: {
          ...intel,
          scoutedRoomIds: [...intel.scoutedRoomIds, roomId],
        },
      },
    });
  },

  buyTargetBlueprints: (targetId) => {
    const s = get();
    const target = TARGETS[targetId];
    const intel = s.intelByTarget[targetId];
    const cost = 2500 * target.difficulty;
    if (!intel || intel.blueprintPurchased || s.bankrollEur < cost) return false;

    const discoveredNodeIds = Array.from(
      new Set([
        ...intel.discoveredNodeIds,
        ...target.nodes.filter((n) => !n.isHiddenHazard).map((n) => n.id),
      ])
    );
    const scoutedRoomIds = target.rooms.map((r) => r.id);
    const completionPercent = computeIntelCompletion(
      target,
      discoveredNodeIds,
      intel.timedGuardIds
    );

    set({
      bankrollEur: s.bankrollEur - cost,
      intelByTarget: {
        ...s.intelByTarget,
        [targetId]: {
          ...intel,
          discoveredNodeIds,
          scoutedRoomIds,
          completionPercent,
          blueprintPurchased: true,
        },
      },
    });
    persistState(get());
    return true;
  },

  // ---- Das Reißbrett ----
  setSelectedFloor: (floor) => set({ selectedFloor: floor }),
  setSelectedCrewId: (crewId) => set({ selectedCrewId: crewId }),

  loadStarterPlan: (targetId) => {
    const s = get();
    const tid = targetId ?? s.activeTargetId;
    const available = Object.values(s.crew)
      .filter((c) => c.recruited && c.status === 'available')
      .map((c) => c.id);
    const starter = buildStarterPlan(tid, available);
    set({
      plansByTarget: { ...s.plansByTarget, [tid]: starter },
      rehearsalTimeSec: 0,
      rehearsalPlaying: false,
    });
    persistState(get());
  },

  addPlanBlock: (input) => {
    const s = get();
    const target = TARGETS[s.activeTargetId];
    const plan = s.plansByTarget[s.activeTargetId];
    const member = s.crew[input.crewId];
    if (!member) return null;

    const node = input.nodeId
      ? target.nodes.find((n) => n.id === input.nodeId)
      : undefined;
    const type: ActionType =
      input.type ?? (node ? inferActionTypeForNode(node) : 'move');
    const targetPos = input.targetPos ?? node?.pos ?? target.getawayPos;
    const floor = input.floor ?? node?.floor ?? s.selectedFloor;

    const crewBlocks = plan.blocks
      .filter((b) => b.crewId === input.crewId)
      .sort((a, b) => a.startSec - b.startSec);
    const lastBlock = crewBlocks[crewBlocks.length - 1];
    const defaultStart = lastBlock
      ? Math.round(
          ((lastBlock.computedEndSec ?? lastBlock.startSec + lastBlock.durationSec) + 1) *
            10
        ) / 10
      : 0;

    const metrics = calculateActionMetrics({
      type,
      member,
      node,
      target,
      fromPos: lastBlock?.targetPos ?? target.getawayPos,
      fromFloor: lastBlock?.floor ?? 0,
      targetPos,
      targetFloor: floor,
      toolsById: TOOLS,
      explicitToolId: input.toolId,
      requestedDurationSec: input.durationSec,
      forensic: plan.forensicLoadoutByCrew?.[input.crewId],
    });

    const newBlock: ActionBlock = {
      id: `blk_${input.crewId}_${Date.now().toString(36)}_${Math.floor(Math.random() * 999)}`,
      crewId: input.crewId,
      type,
      label: input.label ?? node?.label ?? type,
      targetNodeId: node?.id,
      targetPos: { ...targetPos },
      floor,
      startSec: input.startSec ?? defaultStart,
      durationSec: metrics.durationSec,
      estimatedNoise: metrics.estimatedNoise,
      estimatedTraceRisk: metrics.estimatedTraceRisk,
      toolId: input.toolId ?? metrics.usedToolId,
      pathWaypoints: metrics.pathWaypoints,
    };

    const assignedCrewIds = plan.assignedCrewIds.includes(input.crewId)
      ? plan.assignedCrewIds
      : [...plan.assignedCrewIds, input.crewId];

    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          assignedCrewIds,
          blocks: [...plan.blocks, newBlock],
        },
      },
    });
    persistState(get());
    return newBlock;
  },

  updatePlanBlock: (blockId, patch) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    const blocks = plan.blocks.map((b) =>
      b.id === blockId ? { ...b, ...patch } : b
    );
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: { ...plan, blocks },
      },
    });
    persistState(get());
  },

  removePlanBlock: (blockId) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          blocks: plan.blocks.filter((b) => b.id !== blockId),
          syncBarriers: plan.syncBarriers.filter(
            (sb) => sb.fromBlockId !== blockId && sb.toBlockId !== blockId
          ),
        },
      },
    });
    persistState(get());
  },

  clearCrewTrack: (crewId) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    const removedIds = new Set(
      plan.blocks.filter((b) => b.crewId === crewId).map((b) => b.id)
    );
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          blocks: plan.blocks.filter((b) => b.crewId !== crewId),
          syncBarriers: plan.syncBarriers.filter(
            (sb) =>
              !removedIds.has(sb.fromBlockId) && !removedIds.has(sb.toBlockId)
          ),
        },
      },
    });
    persistState(get());
  },

  addSyncBarrier: (fromBlockId, toBlockId, label) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    const fromBlock = plan.blocks.find((b) => b.id === fromBlockId);
    const toBlock = plan.blocks.find((b) => b.id === toBlockId);
    if (!fromBlock || !toBlock) {
      return { ok: false, error: 'Block nicht gefunden.' };
    }
    if (
      plan.syncBarriers.some(
        (sb) => sb.fromBlockId === fromBlockId && sb.toBlockId === toBlockId
      )
    ) {
      return { ok: false, error: 'Synchronpunkt existiert bereits.' };
    }
    if (wouldSyncCreateCycle(plan, fromBlockId, toBlockId)) {
      return {
        ok: false,
        error: 'Deadlock verhindert: Zyklische Abhängigkeit zwischen Spuren!',
      };
    }
    const barrier = createSyncBarrier(fromBlock, toBlock, label);
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          syncBarriers: [...plan.syncBarriers, barrier],
        },
      },
    });
    persistState(get());
    return { ok: true };
  },

  removeSyncBarrier: (barrierId) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          syncBarriers: plan.syncBarriers.filter((sb) => sb.id !== barrierId),
        },
      },
    });
    persistState(get());
  },

  setPlanBBranch: (branch) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    const filtered = plan.planBBranches.filter(
      (b) => !(b.crewId === branch.crewId && b.trigger === branch.trigger)
    );
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          planBBranches: [...filtered, branch],
        },
      },
    });
    persistState(get());
  },

  removePlanBBranch: (branchId) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: {
          ...plan,
          planBBranches: plan.planBBranches.filter((b) => b.id !== branchId),
        },
      },
    });
    persistState(get());
  },

  setPlanFence: (fenceId) => {
    const s = get();
    const plan = s.plansByTarget[s.activeTargetId];
    set({
      plansByTarget: {
        ...s.plansByTarget,
        [s.activeTargetId]: { ...plan, selectedFenceId: fenceId },
      },
    });
    persistState(get());
  },

  setRehearsalTime: (timeSec) => set({ rehearsalTimeSec: Math.max(0, timeSec) }),
  setRehearsalPlaying: (playing) => set({ rehearsalPlaying: playing }),
  setRehearsalSpeed: (speed) => set({ rehearsalSpeed: speed }),

  // ---- Live Execution, Noise, Guards & Minigames ----
  launchHeist: (targetId) => {
    const s = get();
    const tid = targetId ?? s.activeTargetId;
    const resolved = s.getResolvedPlan(tid);
    const live = createInitialLiveState({
      target: TARGETS[tid],
      resolvedPlan: resolved,
      seed: s.day * 97 + tid.length * 31,
    });
    set({
      activeTargetId: tid,
      phase: 'executing',
      rehearsalPlaying: false,
      liveState: live,
      escapeState: null,
      lastDebrief: null,
    });
  },

  tickLiveExecution: (dtSec, options) => {
    const s = get();
    if (!s.liveState || s.phase !== 'executing') return;
    const resolved = s.getResolvedPlan(s.liveState.targetId);
    const hasRadioScrambler = s.workshopUpgrades.some(
      (u) => u.id === 'radio_scrambler' && u.purchased
    );
    const nextLive = tickLiveExecution({
      live: s.liveState,
      dtSec,
      target: TARGETS[s.liveState.targetId],
      resolvedPlan: resolved,
      crewById: s.crew,
      options: { ...options, hasRadioScrambler },
    });
    set({ liveState: nextLive });
  },

  updatePlayerLivePos: (pos, floor, headingDeg, sneaking, speedMps) => {
    const s = get();
    if (!s.liveState || !s.liveState.crew.mara) return;
    const mara = s.liveState.crew.mara;
    const nextLive = {
      ...s.liveState,
      crew: {
        ...s.liveState.crew,
        mara: {
          ...mara,
          pos: { ...pos },
          floor,
          headingDeg,
          sneaking,
          speed: speedMps ?? mara.speed,
        },
      },
    };

    // Emit realistic positional footstep noise if running or carrying heavy loot
    const effectiveSpeed = speedMps ?? 0;
    if (effectiveSpeed >= 3.2 && !sneaking) {
      const bagNoise = mara.carryingLootItems.length * 7;
      const lastPulse = nextLive.noiseEvents[nextLive.noiseEvents.length - 1];
      if (!lastPulse || nextLive.elapsedSec - lastPulse.emittedAtSec >= 0.45) {
        nextLive.noiseEvents = [...nextLive.noiseEvents];
        pushNoisePulse(nextLive, {
          pos,
          floor,
          noiseDb: 48 + Math.min(20, effectiveSpeed * 3) + bagNoise,
          sourceCrewId: 'mara',
          label: 'Schnelle Schritte (Mara)',
        });
      }
    }

    nextLive.stealthTelemetry = computeStealthTelemetry(
      nextLive,
      TARGETS[nextLive.targetId],
      s.crew,
      s.plansByTarget[nextLive.targetId]?.forensicLoadoutByCrew
    );

    set({ liveState: nextLive });
  },

  interactPlayerWithNode: (nodeId, outcome) => {
    const s = get();
    if (!s.liveState) return;
    const nextLive = playerInteractWithNode(
      s.liveState,
      TARGETS[s.liveState.targetId],
      nodeId,
      outcome
    );
    set({ liveState: nextLive });
  },

  emitNoisePulse: (pos, floor, noiseDb, label, sourceCrewId) => {
    const s = get();
    if (!s.liveState) return;
    const next = structuredClone(s.liveState);
    pushNoisePulse(next, { pos, floor, noiseDb, label, sourceCrewId });
    set({ liveState: next });
  },

  syncLiveGuards: (guards) => {
    const s = get();
    if (!s.liveState) return;
    const next = {
      ...s.liveState,
      guards,
    };
    next.stealthTelemetry = computeStealthTelemetry(
      next,
      TARGETS[next.targetId],
      s.crew,
      s.plansByTarget[next.targetId]?.forensicLoadoutByCrew
    );
    set({ liveState: next });
  },

  syncStealthTelemetry: (patch) => {
    const s = get();
    if (!s.liveState) return;
    set({
      liveState: {
        ...s.liveState,
        stealthTelemetry: { ...s.liveState.stealthTelemetry, ...patch },
      },
    });
  },

  recordWitnessEvidence: (draft) => {
    const s = get();
    if (s.liveState && s.phase === 'executing') {
      const exists = s.liveState.pendingEvidence.some(
        (e) => e.type === draft.type && e.title === draft.title
      );
      if (exists) return;
      set({
        liveState: {
          ...s.liveState,
          pendingEvidence: [...s.liveState.pendingEvidence, draft],
        },
      });
      return;
    }

    // Outside active heist (scouting / escape): record directly into Die Akte
    const target = TARGETS[draft.targetId] ?? TARGETS[s.activeTargetId];
    const item = {
      id: `ev_wit_${s.day}_${Date.now().toString(36)}`,
      type: draft.type,
      title: draft.title,
      detail: draft.detail,
      targetId: target.id,
      targetName: target.name,
      collectedOnDay: s.day,
      severity: draft.severity,
      mitigated: false,
      relatedCrewId: draft.relatedCrewId,
    };
    set({
      caseFile: appendEvidenceToCaseFile(s.caseFile, [item], target.name),
    });
    persistState(get());
  },

  issueRadioCommand: (command, targetCrewId = 'all') => {
    const s = get();
    if (!s.liveState) return;
    const resolved = s.getResolvedPlan(s.liveState.targetId);
    const nextLive = applyRadioCommand(
      s.liveState,
      command,
      resolved,
      targetCrewId
    );
    set({ liveState: nextLive });
  },

  triggerAlarmExternal: (reason) => {
    const s = get();
    if (!s.liveState) return;
    const next = structuredClone(s.liveState);
    next.alarmLevel = 'alarm';
    next.alarmProgress = 100;
    next.compromised = true;
    if (next.policeEtaSec === null) next.policeEtaSec = 50;
    if (reason) {
      next.pendingEvidence.push({
        type: 'witness',
        title: 'Alarmmeldung',
        detail: reason,
        targetId: next.targetId,
        severity: 12,
      });
    }
    set({ liveState: next });
  },

  // ---- Tactile Minigames ----
  startMinigame: (nodeId) => {
    const s = get();
    if (!s.liveState) return null;
    const target = TARGETS[s.liveState.targetId];
    const node = target.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const mg = createMinigameForNode({
      node,
      member: s.crew.mara,
      toolsById: TOOLS,
      startedAtSec: s.liveState.elapsedSec,
    });
    set({
      liveState: {
        ...s.liveState,
        activeMinigame: mg,
      },
    });
    return mg;
  },

  attemptMinigameLockpick: (cursorValue) => {
    const s = get();
    const mg = s.liveState?.activeMinigame;
    if (!s.liveState || !mg) {
      return { hit: false, slipped: false, completed: false, failed: false };
    }
    const res = attemptLockpickPin(mg, cursorValue);
    let nextLive = {
      ...s.liveState,
      activeMinigame: res.completed || res.failed ? null : res.game,
    };

    if (res.slipped) {
      const target = TARGETS[nextLive.targetId];
      const node = target.nodes.find((n) => n.id === mg.nodeId);
      if (node) {
        const cloned = structuredClone(nextLive);
        pushNoisePulse(cloned, {
          pos: node.pos,
          floor: node.floor,
          noiseDb: 68 + res.noiseDelta,
          sourceCrewId: 'mara',
          label: `Dietrich abgerutscht (${node.label})`,
        });
        nextLive = cloned;
      }
    }

    if (res.completed) {
      nextLive = playerInteractWithNode(
        nextLive,
        TARGETS[nextLive.targetId],
        mg.nodeId,
        {
          clean: res.game.slips === 0,
          noiseDelta: res.noiseDelta,
          traceDelta: res.game.slips * 6,
        }
      );
      nextLive.activeMinigame = null;
    } else if (res.failed) {
      nextLive = playerInteractWithNode(
        nextLive,
        TARGETS[nextLive.targetId],
        mg.nodeId,
        {
          clean: false,
          noiseDelta: 35,
          traceDelta: 15,
          trippedAlarm: false,
          brokenGlass: mg.kind === 'lockpick',
        }
      );
      nextLive.activeMinigame = null;
    }

    set({ liveState: nextLive });
    return {
      hit: res.hit,
      slipped: res.slipped,
      completed: res.completed,
      failed: res.failed,
    };
  },

  attemptMinigameCircuitWire: (wireId, action) => {
    const s = get();
    const mg = s.liveState?.activeMinigame;
    if (!s.liveState || !mg) {
      return {
        correct: false,
        trippedTamper: false,
        completed: false,
        failed: false,
      };
    }
    const res = attemptCircuitWireAction(mg, wireId, action);
    let nextLive = {
      ...s.liveState,
      activeMinigame: res.completed || res.failed ? null : res.game,
    };

    if (res.completed) {
      nextLive = playerInteractWithNode(
        nextLive,
        TARGETS[nextLive.targetId],
        mg.nodeId,
        { clean: true, noiseDelta: 0 }
      );
      nextLive.activeMinigame = null;
    } else if (res.trippedTamper || res.failed) {
      nextLive = playerInteractWithNode(
        nextLive,
        TARGETS[nextLive.targetId],
        mg.nodeId,
        { trippedAlarm: true, noiseDelta: res.noiseDelta, traceDelta: res.traceDelta }
      );
      nextLive.activeMinigame = null;
    }

    set({ liveState: nextLive });
    return {
      correct: res.correct,
      trippedTamper: res.trippedTamper,
      completed: res.completed,
      failed: res.failed,
    };
  },

  autoCompleteActiveMinigame: () => {
    const s = get();
    const mg = s.liveState?.activeMinigame;
    if (!s.liveState || !mg) return;
    autoCompleteMinigame(mg);
    const nextLive = playerInteractWithNode(
      s.liveState,
      TARGETS[s.liveState.targetId],
      mg.nodeId,
      { clean: true, noiseDelta: 8 }
    );
    nextLive.activeMinigame = null;
    set({ liveState: nextLive });
  },

  cancelMinigame: () => {
    const s = get();
    if (!s.liveState) return;
    set({
      liveState: {
        ...s.liveState,
        activeMinigame: null,
      },
    });
  },

  // ---- Escape & Debrief ----
  startEscape: () => {
    const s = get();
    const target = TARGETS[s.activeTargetId];
    const alarmLevel = s.liveState?.alarmLevel ?? 'suspicious';
    const esc = createInitialEscapeState(target, alarmLevel);
    set({
      phase: 'escape',
      escapeState: esc,
    });
  },

  updateEscapeState: (patch) => {
    set((s) => {
      if (!s.escapeState) return { escapeState: null };
      const merged: EscapeState = { ...s.escapeState, ...patch };
      // Keep carDamage and vehicleDamage cleanly mirrored
      if (patch.vehicleDamage !== undefined && patch.carDamage === undefined) {
        merged.carDamage = patch.vehicleDamage;
      } else if (patch.carDamage !== undefined && patch.vehicleDamage === undefined) {
        merged.vehicleDamage = patch.carDamage;
      }
      return { escapeState: merged };
    });
  },

  finishEscape: (escaped) => {
    const s = get();
    const target = TARGETS[s.activeTargetId];
    const plan = s.plansByTarget[s.activeTargetId];
    const live =
      s.liveState ??
      createInitialLiveState({
        target,
        resolvedPlan: s.getResolvedPlan(target.id),
      });
    const fence = FENCES[plan.selectedFenceId] ?? FENCES.mateo_puerto;

    const { debrief, updatedCaseFile, updatedCrew } = settleHeistDebrief({
      target,
      live,
      escaped,
      escapeVehicleRecognized: s.escapeState?.vehicleRecognized ?? false,
      escapePaintScrapeTrace: s.escapeState?.paintScrapeTrace ?? false,
      fence,
      crewById: s.crew,
      assignedCrewIds: plan.assignedCrewIds,
      forensicLoadoutByCrew: plan.forensicLoadoutByCrew,
      caseFile: s.caseFile,
      day: s.day,
      completedTargetIds: s.completedTargetIds,
    });

    const completedTargetIds =
      debrief.success && !s.completedTargetIds.includes(target.id)
        ? [...s.completedTargetIds, target.id]
        : s.completedTargetIds;

    let storyBeats = s.storyBeats;
    if (debrief.storyBeatUnlockedId) {
      storyBeats = s.storyBeats.map((b) =>
        b.id === debrief.storyBeatUnlockedId ? { ...b, unlocked: true } : b
      );
    }

    const nextIdx = TARGET_ORDER.indexOf(target.id) + 1;
    const nextActiveTargetId =
      debrief.success && nextIdx < TARGET_ORDER.length
        ? TARGET_ORDER[nextIdx]
        : target.id;

    set({
      phase: 'debrief',
      day: s.day + 1,
      bankrollEur: s.bankrollEur + debrief.maraNetEur,
      completedTargetIds,
      crew: updatedCrew,
      caseFile: updatedCaseFile,
      storyBeats,
      lastDebrief: debrief,
      activeTargetId: nextActiveTargetId,
      escapeState: s.escapeState
        ? { ...s.escapeState, active: false, escaped, busted: !escaped }
        : null,
    });
    persistState(get());
  },

  // ---- Die Akte & Story ----
  applyCountermeasure: (countermeasureId) => {
    const s = get();
    const cm = COUNTERMEASURES.find((c) => c.id === countermeasureId);
    if (!cm) return false;
    const hasSprayBooth = s.workshopUpgrades.some(
      (u) => u.id === 'spray_booth' && u.purchased
    );
    const { caseFile, effectiveCostEur } = applyCountermeasureToCaseFile(
      s.caseFile,
      cm,
      hasSprayBooth
    );
    if (s.bankrollEur < effectiveCostEur) return false;

    set({
      bankrollEur: s.bankrollEur - effectiveCostEur,
      day: s.day + cm.daysCost,
      caseFile,
    });
    persistState(get());
    return true;
  },

  openStoryBeat: (beatId) => set({ activeStoryBeatId: beatId }),

  dismissStoryBeat: () => {
    const s = get();
    if (!s.activeStoryBeatId) return;
    const updated = s.storyBeats.map((b) =>
      b.id === s.activeStoryBeatId ? { ...b, seen: true } : b
    );
    set({ storyBeats: updated, activeStoryBeatId: null });
    persistState(get());
  },

  chooseEnding: (ending) => {
    set({ selectedEnding: ending });
    persistState(get());
  },

  toggleAudioMuted: () => set((s) => ({ audioMuted: !s.audioMuted })),
}));
