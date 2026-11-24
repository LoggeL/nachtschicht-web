// ============================================================================
// NACHTSCHICHT — Core Shared Simulation & Game Types
// Coordinate convention: Meters, right-handed Y-up (x = East, z = South on 2D
// blueprint; 3D world position = (x, floor * floorHeightM, z)).
// ============================================================================

export type GamePhase =
  | 'title'
  | 'safehouse'
  | 'scouting'
  | 'planning'
  | 'executing'
  | 'escape'
  | 'debrief';

export type FloorId = -1 | 0 | 1 | 2;

export const FLOOR_LABELS: Record<FloorId, string> = {
  [-1]: 'Keller',
  0: 'EG',
  1: 'OG',
  2: 'Dach',
};

export interface Vec2 {
  x: number;
  z: number;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Bounds2D {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

// ----------------------------------------------------------------------------
// Targets, Floorplan Geometry, Interactables, Guards
// ----------------------------------------------------------------------------

export type TargetId =
  | 'casa_oro'
  | 'perla_del_mar'
  | 'villa_mirador'
  | 'schatzkammer_dresden';

export type TargetDistrict =
  | 'salou_center'
  | 'salou_promenade'
  | 'cap_salou'
  | 'dresden_altstadt';

export type WallKind = 'exterior' | 'interior' | 'glass' | 'fence' | 'baroque';

export interface WallSegment {
  id: string;
  floor: FloorId;
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  thickness?: number;
  height?: number;
  kind: WallKind;
  hasDoorGap?: boolean;
}

export type RoomKind =
  | 'street'
  | 'lobby'
  | 'shop'
  | 'office'
  | 'vault'
  | 'corridor'
  | 'storage'
  | 'courtyard'
  | 'roof'
  | 'cellar'
  | 'gallery'
  | 'garden';

export interface RoomZone {
  id: string;
  name: string;
  floor: FloorId;
  x: number;
  z: number;
  width: number;
  depth: number;
  kind: RoomKind;
  lightColor?: string;
  initiallyScouted?: boolean;
  securityZone?: 'public' | 'restricted' | 'high_security';
}

export type NodeKind =
  | 'entry_door'
  | 'entry_roof'
  | 'entry_cellar'
  | 'entry_window'
  | 'entry_service'
  | 'lock'
  | 'power_box'
  | 'alarm_panel'
  | 'camera'
  | 'safe'
  | 'loot_case'
  | 'stairs'
  | 'lookout'
  | 'getaway_zone'
  | 'hidden_trap';

export type LootCategory =
  | 'gold_jewelry'
  | 'watches_luxury'
  | 'art_antiques'
  | 'bearer_bonds'
  | 'royal_jewels'
  | 'cash';

export const LOOT_CATEGORY_LABELS: Record<LootCategory, string> = {
  gold_jewelry: 'Gold & Schmuck',
  watches_luxury: 'Luxusuhren',
  art_antiques: 'Kunst & Antiquitäten',
  bearer_bonds: 'Wertpapiere & Bargeld',
  royal_jewels: 'Historische Juwelen',
  cash: 'Bargeld',
};

export type SkillKey = 'locks' | 'electronics' | 'driving' | 'strength' | 'climbing';

export const SKILL_LABELS: Record<SkillKey, string> = {
  locks: 'Schlösser',
  electronics: 'Elektronik',
  driving: 'Fahren',
  strength: 'Kraft',
  climbing: 'Klettern',
};

export type ToolId =
  | 'lockpick_set'
  | 'electronic_bypass'
  | 'glass_cutter'
  | 'thermal_lance'
  | 'climbing_rig'
  | 'signal_jammer'
  | 'crowbar'
  | 'camera_loop'
  | 'disguise_kit'
  | 'gloves';

export type PropModelHint =
  | 'safe'
  | 'display_case'
  | 'power_box'
  | 'security_camera'
  | 'door'
  | 'hatch'
  | 'van_zone';

export interface TargetNode {
  id: string;
  label: string;
  kind: NodeKind;
  floor: FloorId;
  pos: Vec2;
  roomId: string;
  visibleFromStreet: boolean;
  isHiddenHazard?: boolean;
  isAccessPoint?: boolean;
  requiredSkill?: SkillKey;
  difficulty: number; // 1..10
  recommendedTool?: ToolId;
  baseDurationSec: number;
  noiseLevel: number; // 0..100
  traceRisk: number; // 0..100
  lootValue?: number;
  lootCategory?: LootCategory;
  lootLabel?: string;
  cameraHeadingDeg?: number;
  cameraSweepDeg?: number;
  cameraRange?: number;
  cameraSweepPeriodSec?: number;
  poweredByNodeId?: string;
  alarmLinkedNodeId?: string;
  connectsToFloor?: FloorId;
  connectsToPos?: Vec2;
  description: string;
  propModel?: PropModelHint;
}

export interface GuardWaypoint {
  pos: Vec2;
  floor: FloorId;
  pauseSec: number;
  lookAngleDeg?: number;
}

export interface GuardPatrol {
  id: string;
  name: string;
  role: 'guard' | 'nightwatch' | 'securion_elite' | 'patrol_cop';
  waypoints: GuardWaypoint[];
  speedMps: number;
  visionRange: number;
  visionConeDeg: number;
  hearingRange: number;
  visibleFromStreet: boolean;
  alertThresholdSec: number;
}

export interface TargetThemePalette {
  skyTop: string;
  skyHorizon: string;
  fogColor: string;
  accentHex: string;
  streetlampHex: string;
  facadePrimary: string;
  facadeTrim: string;
}

export interface HeistTarget {
  id: TargetId;
  name: string;
  subtitle: string;
  district: TargetDistrict;
  city: 'Salou' | 'Dresden';
  act: StoryAct;
  difficulty: 1 | 2 | 3 | 4 | 5;
  estimatedLootEur: number;
  recommendedCrewCount: number;
  unlockRequirement?: { completedTargetIds: TargetId[] };
  briefing: string;
  juppTip: string;
  securionClue: string;
  themePalette: TargetThemePalette;
  bounds: Bounds2D;
  floors: FloorId[];
  floorHeightM: number;
  rooms: RoomZone[];
  walls: WallSegment[];
  nodes: TargetNode[];
  guards: GuardPatrol[];
  getawayPos: Vec2;
  getawayHeadingDeg: number;
  safehouseEscapeDistanceM: number;
  storyBeatOnComplete?: string;
}

// ----------------------------------------------------------------------------
// Crew, Tools, Fences (Hehler), Workshop Upgrades
// ----------------------------------------------------------------------------

export type CrewId = 'mara' | 'jupp' | 'jule' | 'toni' | 'rico';

export interface CrewSkills {
  locks: number;
  electronics: number;
  driving: number;
  strength: number;
  climbing: number;
}

export interface CrewTraits {
  /** 0..100 — low loyalty risks betrayal (Lassen's mole in Act 3) or talking */
  loyalty: number;
  /** 0..100 — high greed risks grabbing extra loot and breaking timeline */
  greed: number;
  /** 0..100 — high nerves = calm improvisation; low nerves = panic/noise */
  nerves: number;
}

export interface LoyaltyQuest {
  id: string;
  title: string;
  description: string;
  costEur: number;
  loyaltyGain: number;
  completed: boolean;
}

export interface CrewMember {
  id: CrewId;
  name: string;
  codename: string;
  role: string;
  bio: string;
  portraitKey: string;
  accentColor: string;
  isPlayerControlled?: boolean;
  recruited: boolean;
  recruitCostEur: number;
  cutPercent: number;
  skills: CrewSkills;
  traits: CrewTraits;
  xp: number;
  level: number;
  heistsCompleted: number;
  equippedTools: ToolId[];
  status: 'available' | 'arrested' | 'traitor' | 'injured';
  loyaltyQuest?: LoyaltyQuest;
}

export interface ToolDef {
  id: ToolId;
  name: string;
  category: 'entry' | 'electronics' | 'vault' | 'stealth' | 'mobility';
  costEur: number;
  description: string;
  speedMultiplier: number; // < 1.0 speeds up action
  noiseDelta: number; // negative reduces noise
  traceDelta: number; // negative reduces trace risk
  applicableNodeKinds: NodeKind[];
  applicableSkills: SkillKey[];
}

export type FenceId = 'mateo_puerto' | 'carmen_antiques' | 'viktor_freilager';

export interface FenceDef {
  id: FenceId;
  name: string;
  location: string;
  description: string;
  preferredCategories: LootCategory[];
  preferredRate: number;
  baseRate: number;
  heatGenerated: number;
  minCompletedHeists?: number;
}

export type WorkshopUpgradeId =
  | 'blueprint_table'
  | 'scanner_rig'
  | 'spray_booth'
  | 'radio_scrambler';

export interface WorkshopUpgrade {
  id: WorkshopUpgradeId;
  name: string;
  description: string;
  costEur: number;
  purchased: boolean;
  effectSummary: string;
}

// ----------------------------------------------------------------------------
// Intel / Fog of War
// ----------------------------------------------------------------------------

export interface IntelState {
  targetId: TargetId;
  discoveredNodeIds: string[];
  timedGuardIds: string[];
  scoutedRoomIds: string[];
  completionPercent: number;
  blueprintPurchased: boolean;
}

export interface ScoutingHudState {
  binocularsActive: boolean;
  nearbyNodeId: string | null;
  nearbyNodeLabel: string | null;
  scanProgress: number; // 0..1
  timingGuardId: string | null;
  timingGuardName: string | null;
  guardTimingProgress: number; // 0..1
  lastDiscoveryToast: string | null;
  playerPos: Vec2;
  playerFloor: FloorId;
}

// ----------------------------------------------------------------------------
// Das Reißbrett (Heist Plan, Action Blocks, Sync Barriers, Plan B)
// ----------------------------------------------------------------------------

export type ActionType =
  | 'move'
  | 'enter'
  | 'pick_lock'
  | 'cut_power'
  | 'bypass_alarm'
  | 'loop_camera'
  | 'crack_safe'
  | 'grab_loot'
  | 'lookout'
  | 'stage_car'
  | 'wait'
  | 'extract';

export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  move: 'Bewegen',
  enter: 'Eindringen',
  pick_lock: 'Schloss knacken',
  cut_power: 'Strom kappen',
  bypass_alarm: 'Alarm überbrücken',
  loop_camera: 'Kamera schleifen',
  crack_safe: 'Tresor knacken',
  grab_loot: 'Beute sichern',
  lookout: 'Schmiere stehen',
  stage_car: 'Fluchtwagen vorfahren',
  wait: 'Abwarten',
  extract: 'Zum Fluchtwagen',
};

export type PlanBTrigger =
  | 'on_alarm'
  | 'on_guard_spotted'
  | 'on_crew_compromised'
  | 'manual_radio';

export type PlanBFallbackAction =
  | 'abort_to_car'
  | 'alternate_exit_roof'
  | 'alternate_exit_cellar'
  | 'hold_and_cover'
  | 'grab_nearest_and_run';

export interface ActionBlock {
  id: string;
  crewId: CrewId;
  type: ActionType;
  label: string;
  targetNodeId?: string;
  targetPos: Vec2;
  floor: FloorId;
  /** Requested start time on the track (seconds) */
  startSec: number;
  /** Calculated duration (seconds) */
  durationSec: number;
  /** Resolved start after sequential & sync-barrier resolution */
  computedStartSec?: number;
  /** Resolved end after sequential & sync-barrier resolution */
  computedEndSec?: number;
  estimatedNoise: number;
  estimatedTraceRisk: number;
  toolId?: ToolId;
}

export interface SyncBarrier {
  id: string;
  label: string;
  /** Prerequisite block that must finish first */
  fromBlockId: string;
  fromCrewId: CrewId;
  /** Dependent block that waits for fromBlockId */
  toBlockId: string;
  toCrewId: CrewId;
}

export interface PlanBBranch {
  id: string;
  crewId: CrewId;
  trigger: PlanBTrigger;
  action: PlanBFallbackAction;
  fallbackNodeId?: string;
  label: string;
}

export interface HeistPlan {
  id: string;
  targetId: TargetId;
  name: string;
  assignedCrewIds: CrewId[];
  blocks: ActionBlock[];
  syncBarriers: SyncBarrier[];
  planBBranches: PlanBBranch[];
  selectedFenceId: FenceId;
  vehiclePaintColor: string;
  totalDurationSec: number;
}

export type PlanIssueCode =
  | 'CYCLE'
  | 'MISSING_SYNC_NODE'
  | 'UNASSIGNED_CREW'
  | 'NO_LOOT'
  | 'NO_EXTRACT'
  | 'POWER_ORDER'
  | 'HIGH_NOISE'
  | 'UNSCOUTED_RISK';

export interface PlanValidationIssue {
  severity: 'error' | 'warning' | 'info';
  code: PlanIssueCode;
  message: string;
  blockId?: string;
  crewId?: CrewId;
}

export interface ResolvedPlan {
  plan: HeistPlan;
  blocksById: Record<string, ActionBlock>;
  orderedBlocksByCrew: Record<string, ActionBlock[]>;
  totalDurationSec: number;
  valid: boolean;
  issues: PlanValidationIssue[];
}

// ----------------------------------------------------------------------------
// Ghost Rehearsal (Probelauf) Snapshots
// ----------------------------------------------------------------------------

export interface RehearsalCrewGhost {
  crewId: CrewId;
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  status: 'idle' | 'moving' | 'working' | 'waiting_sync' | 'extracted';
  activeBlockId: string | null;
  activeActionLabel: string;
  progress: number;
  carryingLootEur: number;
  spottedByGuardIds: string[];
  spottedByCameraIds: string[];
  trail: Array<{ pos: Vec2; floor: FloorId; t: number }>;
}

export interface RehearsalGuardGhost {
  guardId: string;
  name: string;
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  visionRange: number;
  visionConeDeg: number;
  known: boolean;
  alerted: boolean;
}

export interface RehearsalCameraGhost {
  nodeId: string;
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  range: number;
  active: boolean;
  known: boolean;
  spottingCrewIds: CrewId[];
}

export interface RehearsalConflict {
  id: string;
  timeSec: number;
  severity: 'warning' | 'critical';
  crewId: CrewId;
  sourceId: string;
  message: string;
  pos: Vec2;
  floor: FloorId;
}

export interface RehearsalSnapshot {
  timeSec: number;
  totalDurationSec: number;
  powerDisabled: boolean;
  alarmBypassed: boolean;
  openedNodeIds: string[];
  lootedNodeIds: string[];
  projectedLootEur: number;
  crew: RehearsalCrewGhost[];
  guards: RehearsalGuardGhost[];
  cameras: RehearsalCameraGhost[];
  conflicts: RehearsalConflict[];
  unscoutedWarningCount: number;
}

// ----------------------------------------------------------------------------
// Live Execution & Escape
// ----------------------------------------------------------------------------

export type RadioCommandType = 'hold' | 'plan_b' | 'abort' | 'resume';

export interface RadioCommand {
  id: string;
  command: RadioCommandType;
  targetCrewId?: CrewId | 'all';
  issuedAtSec: number;
  label: string;
}

export type DeviationKind =
  | 'greed_extra_loot'
  | 'panic_noise'
  | 'panic_abort'
  | 'nerves_improvise'
  | 'hidden_trap_triggered'
  | 'plan_b_engaged'
  | 'betrayal_tipoff';

export interface DeviationEvent {
  id: string;
  timeSec: number;
  crewId: CrewId;
  kind: DeviationKind;
  title: string;
  detail: string;
  severity: 'info' | 'warning' | 'critical';
  pos: Vec2;
  floor: FloorId;
}

export interface CollectedLootItem {
  nodeId: string;
  label: string;
  category: LootCategory;
  valueEur: number;
  collectedBy: CrewId;
}

export interface LiveCrewState {
  crewId: CrewId;
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  speed: number;
  sneaking: boolean;
  state:
    | 'idle'
    | 'moving'
    | 'working'
    | 'waiting_sync'
    | 'holding'
    | 'deviating'
    | 'fleeing'
    | 'extracted'
    | 'caught';
  activeBlockIndex: number;
  activeBlockId: string | null;
  activeActionLabel: string;
  blockProgress: number;
  completedBlockIds: string[];
  carryingLootEur: number;
  carryingLootItems: CollectedLootItem[];
  stress: number;
  usingPlanB: boolean;
  deviationActive: DeviationKind | null;
  extraLootTargetNodeId: string | null;
}

export interface LiveGuardState {
  guardId: string;
  name: string;
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  visionRange: number;
  visionConeDeg: number;
  suspicion: number; // 0..100
  state: 'patrol' | 'investigating' | 'alerted' | 'chasing';
  investigatePos?: Vec2;
  waypointIndex: number;
  pauseRemainingSec: number;
}

export interface LiveCameraState {
  nodeId: string;
  pos: Vec2;
  floor: FloorId;
  headingDeg: number;
  range: number;
  active: boolean;
  looped: boolean;
  suspicion: number; // 0..100
}

export type AlarmLevel = 'silent' | 'suspicious' | 'alarm' | 'lockdown';

export type EvidenceType =
  | 'fingerprints'
  | 'camera_footage'
  | 'witness'
  | 'recognized_car'
  | 'crew_chatter'
  | 'alarm_signature'
  | 'violence_report';

export interface EvidenceDraft {
  type: EvidenceType;
  title: string;
  detail: string;
  targetId: TargetId;
  severity: number;
  relatedCrewId?: CrewId;
}

export interface LiveExecutionState {
  targetId: TargetId;
  elapsedSec: number;
  paused: boolean;
  alarmLevel: AlarmLevel;
  alarmProgress: number; // 0..100
  noiseLevel: number; // 0..100
  policeEtaSec: number | null;
  powerDisabled: boolean;
  alarmBypassed: boolean;
  planBActive: boolean;
  abortActive: boolean;
  holdActive: boolean;
  completedNodeIds: string[];
  triggeredHazardNodeIds: string[];
  collectedLoot: CollectedLootItem[];
  totalLootEur: number;
  crew: Record<CrewId, LiveCrewState>;
  guards: LiveGuardState[];
  cameras: LiveCameraState[];
  deviations: DeviationEvent[];
  radioLog: RadioCommand[];
  pendingEvidence: EvidenceDraft[];
  readyForEscape: boolean;
  compromised: boolean;
  violenceUsed: boolean;
  /** Seeded deterministic RNG state for repeatable live simulation */
  rngState: number;
}

export interface EscapeState {
  active: boolean;
  elapsedSec: number;
  speedKmh: number;
  pursuitHeat: number; // 0..100
  policeSpotted: boolean;
  clearSightTimerSec: number;
  distanceToSafehouseM: number;
  carDamage: number; // 0..100
  vehicleRecognized: boolean;
  escaped: boolean;
  busted: boolean;
}

// ----------------------------------------------------------------------------
// Die Akte (Inspectora Núria Ferrer's Case File)
// ----------------------------------------------------------------------------

export interface EvidenceItem {
  id: string;
  type: EvidenceType;
  title: string;
  detail: string;
  targetId: TargetId;
  targetName: string;
  collectedOnDay: number;
  severity: number;
  mitigated: boolean;
  mitigationLabel?: string;
  relatedCrewId?: CrewId;
}

export type CountermeasureId =
  | 'repaint_car'
  | 'lay_low'
  | 'dump_hot_loot'
  | 'bribe_witness'
  | 'wipe_cctv_backup';

export interface CountermeasureDef {
  id: CountermeasureId;
  name: string;
  description: string;
  costEur: number;
  daysCost: number;
  heatReduction: number;
  mitigatesTypes: EvidenceType[];
}

export type CaseFileStatus =
  | 'cold'
  | 'active_inquiry'
  | 'tightening_net'
  | 'warrant_imminent';

export interface CaseFileLedger {
  caseNumber: string;
  leadInvestigator: string;
  heat: number; // 0..100
  status: CaseFileStatus;
  evidence: EvidenceItem[];
  countermeasuresUsed: number;
  lastFerrerNote: string;
}

// ----------------------------------------------------------------------------
// Story, Endings & Debrief
// ----------------------------------------------------------------------------

export type StoryAct = 1 | 2 | 3;

export type EndingChoice =
  | 'vanish_with_loot'
  | 'expose_lassen_free_jupp'
  | 'take_over_ring';

export interface StoryBeat {
  id: string;
  act: StoryAct;
  title: string;
  subtitle: string;
  imageKey: string;
  speaker: string;
  paragraphs: string[];
  unlocked: boolean;
  seen: boolean;
  triggerHint?: string;
}

export interface CrewPayoutEntry {
  crewId: CrewId;
  name: string;
  cutPercent: number;
  amountEur: number;
  loyaltyDelta: number;
  xpGain: number;
}

export interface HeistDebrief {
  targetId: TargetId;
  targetName: string;
  success: boolean;
  cleanGhostBonus: boolean;
  grossLootEur: number;
  fenceId: FenceId;
  fenceName: string;
  fencePayoutEur: number;
  crewCuts: CrewPayoutEntry[];
  maraNetEur: number;
  newEvidence: EvidenceItem[];
  heatBefore: number;
  heatAfter: number;
  deviationsCount: number;
  elapsedSec: number;
  storyBeatUnlockedId?: string;
  traitorRevealedId?: CrewId;
  finaleEndingAvailable?: boolean;
}
