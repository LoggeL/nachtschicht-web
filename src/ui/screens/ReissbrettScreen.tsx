import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Compass,
  EyeOff,
  Fingerprint,
  GitBranch,
  Layers,
  Link2,
  Moon,
  Play,
  Plus,
  Radio,
  ShieldAlert,
  Sparkles,
  Trash2,
  Volume2,
  VolumeX,
  Wrench,
} from 'lucide-react';
import { useGameStore } from '../../state/store';
import { TARGETS, TOOLS } from '../../sim/data';
import { scanRehearsalConflicts } from '../../sim/simulator';
import {
  ACTION_TYPE_LABELS,
  CrewId,
  FLOOR_LABELS,
  ForensicLoadout,
  PlanBFallbackAction,
  PlanBTrigger,
  SKILL_LABELS,
} from '../../sim/types';
import {
  NODE_KIND_LABELS,
  PLAN_B_ACTION_LABELS,
  PLAN_B_TRIGGER_LABELS,
  formatEur,
  formatShortSec,
} from '../assets';
import { BlueprintFloorplan } from '../components/BlueprintFloorplan';
import { TimelineDAW } from '../components/TimelineDAW';
import { CharacterAvatar } from '../components/CharacterAvatar';

type InspectorTab = 'inspect' | 'forensic' | 'sync' | 'planb';

const ENTRY_TOOL_OPTIONS: Array<{
  id: ForensicLoadout['entryTool'];
  label: string;
  noiseHint: string;
  speedHint: string;
  traceHint: string;
}> = [
  {
    id: 'lockpick_set',
    label: 'Dietrich',
    noiseHint: 'Leise (~5m)',
    speedHint: 'Standard',
    traceHint: 'Niedrig',
  },
  {
    id: 'glass_cutter',
    label: 'Glasschneider',
    noiseHint: 'Flüsterleise (~3.5m)',
    speedHint: 'Präzise',
    traceHint: 'Minimal',
  },
  {
    id: 'crowbar',
    label: 'Brecheisen',
    noiseHint: 'Laut (~14m!)',
    speedHint: 'Sehr schnell',
    traceHint: 'Hoch + Glasbruch',
  },
];

export function ReissbrettScreen() {
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('inspect');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [syncSourceBlockId, setSyncSourceBlockId] = useState<string | null>(null);
  const [syncFromDropdown, setSyncFromDropdown] = useState<string>('');
  const [syncToDropdown, setSyncToDropdown] = useState<string>('');
  const [showLightOverlay, setShowLightOverlay] = useState<boolean>(false);
  const [showNoiseOverlay, setShowNoiseOverlay] = useState<boolean>(true);
  const [syncFeedback, setSyncFeedback] = useState<{ ok: boolean; msg: string } | null>(
    null
  );

  const activeTargetId = useGameStore((s) => s.activeTargetId);
  const bankrollEur = useGameStore((s) => s.bankrollEur);
  const crew = useGameStore((s) => s.crew);
  const intelByTarget = useGameStore((s) => s.intelByTarget);
  const plansByTarget = useGameStore((s) => s.plansByTarget);
  const selectedFloor = useGameStore((s) => s.selectedFloor);
  const selectedCrewId = useGameStore((s) => s.selectedCrewId);
  const rehearsalTimeSec = useGameStore((s) => s.rehearsalTimeSec);
  const rehearsalPlaying = useGameStore((s) => s.rehearsalPlaying);
  const audioMuted = useGameStore((s) => s.audioMuted);

  const getResolvedPlan = useGameStore((s) => s.getResolvedPlan);
  const getRehearsalSnapshot = useGameStore((s) => s.getRehearsalSnapshot);
  const setPhase = useGameStore((s) => s.setPhase);
  const setSelectedFloor = useGameStore((s) => s.setSelectedFloor);
  const setSelectedCrewId = useGameStore((s) => s.setSelectedCrewId);
  const setCrewForensicLoadout = useGameStore((s) => s.setCrewForensicLoadout);
  const loadStarterPlan = useGameStore((s) => s.loadStarterPlan);
  const addPlanBlock = useGameStore((s) => s.addPlanBlock);
  const updatePlanBlock = useGameStore((s) => s.updatePlanBlock);
  const removePlanBlock = useGameStore((s) => s.removePlanBlock);
  const addSyncBarrier = useGameStore((s) => s.addSyncBarrier);
  const removeSyncBarrier = useGameStore((s) => s.removeSyncBarrier);
  const setPlanBBranch = useGameStore((s) => s.setPlanBBranch);
  const removePlanBBranch = useGameStore((s) => s.removePlanBBranch);
  const buyTargetBlueprints = useGameStore((s) => s.buyTargetBlueprints);
  const launchHeist = useGameStore((s) => s.launchHeist);
  const toggleAudioMuted = useGameStore((s) => s.toggleAudioMuted);

  const target = TARGETS[activeTargetId];
  const intel = intelByTarget[activeTargetId];
  const rawPlan = plansByTarget[activeTargetId];

  // Keep selectedFloor & selectedCrewId valid when switching targets or crew
  useEffect(() => {
    if (!target.floors.includes(selectedFloor)) {
      setSelectedFloor(target.floors.includes(0) ? 0 : target.floors[0]);
    }
    if (!rawPlan.assignedCrewIds.includes(selectedCrewId)) {
      setSelectedCrewId(rawPlan.assignedCrewIds[0] ?? 'mara');
    }
  }, [
    target.floors,
    selectedFloor,
    setSelectedFloor,
    rawPlan.assignedCrewIds,
    selectedCrewId,
    setSelectedCrewId,
  ]);

  // Derived deterministic plan & rehearsal snapshot
  const resolvedPlan = useMemo(
    () => getResolvedPlan(activeTargetId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTargetId, rawPlan, crew, intel]
  );

  const snapshot = useMemo(
    () => getRehearsalSnapshot(rehearsalTimeSec),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedPlan, intel, rehearsalTimeSec]
  );

  const allConflicts = useMemo(
    () =>
      scanRehearsalConflicts({
        resolvedPlan,
        target,
        intel,
        stepSec: 1.0,
      }),
    [resolvedPlan, target, intel]
  );

  // Smooth requestAnimationFrame driver for Ghost Rehearsal playback
  useEffect(() => {
    if (!rehearsalPlaying) return;
    let rafId = 0;
    let lastTs = performance.now();

    const step = (now: number) => {
      const dtSec = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      const state = useGameStore.getState();
      if (!state.rehearsalPlaying) return;
      const maxDur = Math.max(10, state.getResolvedPlan().totalDurationSec);
      const nextTime = state.rehearsalTimeSec + dtSec * state.rehearsalSpeed;
      if (nextTime >= maxDur) {
        state.setRehearsalTime(maxDur);
        state.setRehearsalPlaying(false);
        return;
      }
      state.setRehearsalTime(Math.round(nextTime * 100) / 100);
      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [rehearsalPlaying]);

  const selectedNode = selectedNodeId
    ? target.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;
  const selectedBlock = selectedBlockId
    ? resolvedPlan.blocksById[selectedBlockId] ?? null
    : null;

  const selectedMember = crew[selectedCrewId];
  const currentForensic: ForensicLoadout = useMemo(() => {
    const stored = rawPlan.forensicLoadoutByCrew?.[selectedCrewId];
    if (stored) return stored;
    const tools = selectedMember?.equippedTools ?? [];
    return {
      gloves: tools.includes('gloves'),
      mask: tools.includes('mask'),
      darkClothing: tools.includes('dark_clothing'),
      entryTool: tools.includes('crowbar')
        ? 'crowbar'
        : tools.includes('glass_cutter')
          ? 'glass_cutter'
          : 'lockpick_set',
    };
  }, [rawPlan.forensicLoadoutByCrew, selectedCrewId, selectedMember]);

  // Compute live preview noise radius for selected node/block reflecting forensic entry tool
  const previewNoiseRing = useMemo(() => {
    const toolMod =
      currentForensic.entryTool === 'crowbar'
        ? 22
        : currentForensic.entryTool === 'glass_cutter'
          ? -14
          : -8;

    if (selectedBlock) {
      const effNoise = Math.max(12, Math.min(100, selectedBlock.estimatedNoise + (selectedBlock.type === 'enter' || selectedBlock.type === 'grab_loot' ? toolMod * 0.4 : 0)));
      return {
        pos: selectedBlock.targetPos,
        floor: selectedBlock.floor,
        radiusM: Math.max(2.5, Math.min(16, (effNoise / 100) * 14 + 2)),
        label: `Lärm-Radius (${selectedBlock.label})`,
      };
    }
    if (selectedNode) {
      const effNoise = Math.max(10, Math.min(100, selectedNode.noiseLevel + toolMod));
      return {
        pos: selectedNode.pos,
        floor: selectedNode.floor,
        radiusM: Math.max(2.5, Math.min(16, (effNoise / 100) * 14 + 2)),
        label:
          currentForensic.entryTool === 'crowbar'
            ? 'Brecheisen-Lärm'
            : currentForensic.entryTool === 'glass_cutter'
              ? 'Glasschneider'
              : 'Dietrich',
      };
    }
    return null;
  }, [selectedBlock, selectedNode, currentForensic.entryTool]);

  // Live forensic summary stats for Die Akte impact preview
  const forensicPreview = useMemo(() => {
    const traceRisk =
      (currentForensic.gloves ? 0 : 35) +
      (currentForensic.mask ? 0 : 30) +
      (currentForensic.entryTool === 'crowbar' ? 20 : currentForensic.entryTool === 'glass_cutter' ? 4 : 8);
    const noiseMeters =
      currentForensic.entryTool === 'crowbar'
        ? 14
        : currentForensic.entryTool === 'glass_cutter'
          ? 3.5
          : 5.5;
    const speedDeltaPct =
      (currentForensic.entryTool === 'crowbar' ? 24 : currentForensic.entryTool === 'glass_cutter' ? 12 : 10) -
      (currentForensic.gloves ? 5 : 0);
    const lightConcealmentPct = currentForensic.darkClothing ? 25 : 0;
    return { traceRisk, noiseMeters, speedDeltaPct, lightConcealmentPct };
  }, [currentForensic]);

  const blueprintCost = 2500 * target.difficulty;

  const handleQuickAddNode = (nodeId: string) => {
    const added = addPlanBlock({ crewId: selectedCrewId, nodeId });
    if (added) {
      setSelectedBlockId(added.id);
      setSelectedNodeId(nodeId);
      setInspectorTab('inspect');
    }
  };

  const handleCompleteSyncLink = (targetBlockId: string) => {
    if (!syncSourceBlockId) return;
    const res = addSyncBarrier(syncSourceBlockId, targetBlockId);
    setSyncSourceBlockId(null);
    if (res.ok) {
      setSyncFeedback({ ok: true, msg: 'Synchronpunkt erfolgreich verknüpft!' });
    } else {
      setSyncFeedback({ ok: false, msg: res.error ?? 'Verknüpfung fehlgeschlagen.' });
    }
    setTimeout(() => setSyncFeedback(null), 3500);
  };

  const handleDropdownSyncCreate = () => {
    if (!syncFromDropdown || !syncToDropdown) return;
    const res = addSyncBarrier(syncFromDropdown, syncToDropdown);
    if (res.ok) {
      setSyncFeedback({ ok: true, msg: 'Synchronpunkt gesetzt!' });
      setSyncFromDropdown('');
      setSyncToDropdown('');
    } else {
      setSyncFeedback({ ok: false, msg: res.error ?? 'Fehler beim Verknüpfen.' });
    }
    setTimeout(() => setSyncFeedback(null), 3500);
  };

  const handleUpdatePlanB = (
    crewId: CrewId,
    trigger: PlanBTrigger,
    action: PlanBFallbackAction
  ) => {
    setPlanBBranch({
      id: `pb_${crewId}_${trigger}`,
      crewId,
      trigger,
      action,
      label: `${PLAN_B_TRIGGER_LABELS[trigger]} → ${PLAN_B_ACTION_LABELS[action]}`,
    });
  };

  const errorCount = resolvedPlan.issues.filter((i) => i.severity === 'error').length;
  const warningCount = resolvedPlan.issues.filter((i) => i.severity === 'warning').length;

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col bg-[#050912] text-slate-100">
      {/* Slim Top Reißbrett Header */}
      <header className="h-13 shrink-0 px-3.5 border-b border-slate-800/90 bg-[#070d1b] flex items-center justify-between gap-2.5">
        {/* Left: Back & Target Title */}
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={() => setPhase('safehouse')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-xs text-slate-200 cursor-pointer shrink-0"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Versteck</span>
          </button>

          <div className="min-w-0">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="font-mono-tech text-[10px] uppercase tracking-widest text-amber-400 whitespace-nowrap shrink-0">
                DAS REISSBRETT
              </span>
              <span className="text-slate-600 shrink-0">·</span>
              <h1 className="font-display font-bold text-sm text-white truncate">
                {target.name}
              </h1>
              <span className="font-mono-tech text-[10px] px-2 py-0.5 rounded bg-sky-500/15 border border-sky-400/35 text-sky-300 whitespace-nowrap shrink-0">
                Intel {intel.completionPercent}%
              </span>
            </div>
          </div>
        </div>

        {/* Center: Floor Switcher + Blueprint Realism Overlays */}
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
            <Layers className="w-3.5 h-3.5 text-slate-400 ml-1 mr-0.5" />
            {target.floors.map((fl) => {
              const active = fl === selectedFloor;
              const ghostsOnFloor = snapshot.crew.filter((g) => g.floor === fl);
              return (
                <button
                  key={fl}
                  type="button"
                  onClick={() => setSelectedFloor(fl)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-mono-tech font-semibold transition-colors cursor-pointer ${
                    active
                      ? 'bg-sky-400 text-slate-950'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <span>{FLOOR_LABELS[fl]}</span>
                  {ghostsOnFloor.length > 0 && (
                    <span className="flex items-center gap-0.5">
                      {ghostsOnFloor.map((g) => (
                        <span
                          key={g.crewId}
                          className="w-1.5 h-1.5 rounded-full"
                          style={{
                            backgroundColor: active
                              ? '#020617'
                              : crew[g.crewId]?.accentColor ?? '#38bdf8',
                          }}
                        />
                      ))}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Blackout Light/Shadow Preview Toggle */}
          <button
            type="button"
            onClick={() => setShowLightOverlay((v) => !v)}
            title="Stromausfall-Schattenzonen (Licht/Schatten) im Grundriss einblenden"
            className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
              showLightOverlay
                ? 'bg-cyan-500/25 border-cyan-400/70 text-cyan-100'
                : 'bg-slate-900 border-slate-700/80 text-slate-300 hover:text-white'
            }`}
          >
            <Moon className="w-3.5 h-3.5 text-cyan-300" />
            <span className="hidden xl:inline">Schatten</span>
          </button>

          {/* Noise Radius Rings Toggle */}
          <button
            type="button"
            onClick={() => setShowNoiseOverlay((v) => !v)}
            title="Lärm-Radien für Werkzeuge & Aktionen einblenden"
            className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-semibold transition-colors cursor-pointer whitespace-nowrap ${
              showNoiseOverlay
                ? 'bg-amber-500/20 border-amber-400/65 text-amber-100'
                : 'bg-slate-900 border-slate-700/80 text-slate-300 hover:text-white'
            }`}
          >
            <Radio className="w-3.5 h-3.5 text-amber-300" />
            <span className="hidden xl:inline">Lärm</span>
          </button>
        </div>

        {/* Right: Starter Plan + Scouting + LAUNCH HEIST CTA */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => {
              loadStarterPlan(activeTargetId);
              setSelectedBlockId(null);
              setSyncFeedback({ ok: true, msg: 'Jupps Starter-Plan geladen!' });
              setTimeout(() => setSyncFeedback(null), 2500);
            }}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-amber-400/40 text-amber-200 text-xs font-semibold cursor-pointer whitespace-nowrap"
            title="Lädt Jupps empfohlenen Mehrspur-Plan mit Synchronpunkten"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden 2xl:inline">Starter-Plan laden</span>
            <span className="2xl:hidden">Starter-Plan</span>
          </button>

          <button
            type="button"
            onClick={() => setPhase('scouting')}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400/50 text-sky-100 text-xs font-semibold cursor-pointer whitespace-nowrap"
          >
            <Compass className="w-3.5 h-3.5" />
            <span className="hidden lg:inline">Auskundschaften</span>
            <span className="lg:hidden">3D Späh</span>
          </button>

          <button
            type="button"
            disabled={!resolvedPlan.valid}
            onClick={() => launchHeist(activeTargetId)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-display font-bold text-xs tracking-wide shadow-lg shadow-amber-500/25 cursor-pointer disabled:cursor-not-allowed whitespace-nowrap"
          >
            <Play className="w-3.5 h-3.5 fill-slate-950" />
            <span>Bruch durchziehen</span>
          </button>

          <button
            type="button"
            onClick={toggleAudioMuted}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-300 cursor-pointer"
            aria-label="Ton umschalten"
          >
            {audioMuted ? (
              <VolumeX className="w-3.5 h-3.5 text-rose-400" />
            ) : (
              <Volume2 className="w-3.5 h-3.5 text-amber-400" />
            )}
          </button>
        </div>
      </header>

      {/* Main Workspace Split: Top Half (Floorplan + Inspector) / Bottom Half (DAW Timeline) */}
      <div className="flex-1 min-h-0 flex flex-col gap-2.5 p-2.5 lg:p-3 overflow-hidden">
        {/* TOP HALF (~55% height) */}
        <div className="flex-[55] min-h-0 flex gap-2.5 overflow-hidden">
          {/* Interactive Blueprint Floorplan */}
          <div className="flex-1 min-w-0 min-h-0">
            <BlueprintFloorplan
              target={target}
              intel={intel}
              resolvedPlan={resolvedPlan}
              snapshot={snapshot}
              selectedFloor={selectedFloor}
              selectedNodeId={selectedNodeId}
              selectedBlockId={selectedBlockId}
              showLightOverlay={showLightOverlay}
              showNoiseOverlay={showNoiseOverlay}
              previewNoiseRing={previewNoiseRing}
              onSelectNode={(nid) => {
                setSelectedNodeId(nid);
                setSelectedBlockId(null);
                setInspectorTab('inspect');
              }}
              onQuickAddNode={handleQuickAddNode}
            />
          </div>

          {/* Right Sidebar: Taktik-Inspektor, Forensik-Loadout, Synchronpunkte, Plan B */}
          <aside className="w-80 xl:w-88 shrink-0 noir-card rounded-xl flex flex-col min-h-0 overflow-hidden border-slate-800">
            {/* 4-Tab Sidebar Bar */}
            <div className="grid grid-cols-4 p-1 bg-slate-950/90 border-b border-slate-800 shrink-0 gap-1">
              <button
                type="button"
                onClick={() => setInspectorTab('inspect')}
                className={`py-1.5 rounded-lg text-[10px] font-semibold cursor-pointer ${
                  inspectorTab === 'inspect'
                    ? 'bg-sky-500/25 text-sky-200 border border-sky-400/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                Inspektor
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab('forensic')}
                className={`py-1.5 rounded-lg text-[10px] font-semibold cursor-pointer flex items-center justify-center gap-1 ${
                  inspectorTab === 'forensic'
                    ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-400/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Fingerprint className="w-3 h-3" />
                <span>Forensik</span>
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab('sync')}
                className={`py-1.5 rounded-lg text-[10px] font-semibold cursor-pointer flex items-center justify-center gap-1 ${
                  inspectorTab === 'sync'
                    ? 'bg-amber-500/25 text-amber-200 border border-amber-400/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <Link2 className="w-3 h-3" />
                <span>Sync ({rawPlan.syncBarriers.length})</span>
              </button>
              <button
                type="button"
                onClick={() => setInspectorTab('planb')}
                className={`py-1.5 rounded-lg text-[10px] font-semibold cursor-pointer flex items-center justify-center gap-1 ${
                  inspectorTab === 'planb'
                    ? 'bg-rose-500/20 text-rose-200 border border-rose-400/40'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                <GitBranch className="w-3 h-3" />
                <span>Plan B</span>
              </button>
            </div>

            {/* Toast Feedback */}
            {syncFeedback && (
              <div
                className={`mx-2.5 mt-2 px-2.5 py-1.5 rounded-lg text-[11px] font-medium border animate-toast ${
                  syncFeedback.ok
                    ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-200'
                    : 'bg-rose-500/20 border-rose-400/50 text-rose-200'
                }`}
              >
                {syncFeedback.msg}
              </div>
            )}

            {/* Sidebar Tab Body */}
            <div className="flex-1 min-h-0 overflow-y-auto ns-scroll p-3 space-y-3">
              {/* -------- TAB 1: INSPEKTOR (Node or Block + Validation) -------- */}
              {inspectorTab === 'inspect' && (
                <>
                  {selectedNode && !selectedBlock && (
                    <div className="p-3 rounded-xl bg-slate-900/90 border border-sky-400/35 space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="font-mono-tech text-[10px] uppercase text-sky-300">
                            {NODE_KIND_LABELS[selectedNode.kind]} · {FLOOR_LABELS[selectedNode.floor]}
                          </span>
                          <h3 className="font-display font-bold text-sm text-white leading-snug">
                            {selectedNode.label}
                          </h3>
                        </div>
                        {selectedNode.lootValue && (
                          <span className="font-mono-tech text-xs font-bold text-amber-300 shrink-0">
                            {formatEur(selectedNode.lootValue)}
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-slate-300 leading-snug">
                        {selectedNode.description}
                      </p>

                      <div className="grid grid-cols-3 gap-1.5 font-mono-tech text-[10px]">
                        <div className="p-1.5 rounded bg-slate-950/80 text-center">
                          <div className="text-slate-500">Basiszeit</div>
                          <div className="text-white font-bold">{selectedNode.baseDurationSec}s</div>
                        </div>
                        <div className="p-1.5 rounded bg-slate-950/80 text-center">
                          <div className="text-slate-500">Lärm</div>
                          <div className="text-amber-300 font-bold">{selectedNode.noiseLevel}</div>
                        </div>
                        <div className="p-1.5 rounded bg-slate-950/80 text-center">
                          <div className="text-slate-500">Spur</div>
                          <div className="text-rose-300 font-bold">{selectedNode.traceRisk}</div>
                        </div>
                      </div>

                      {selectedNode.requiredSkill && (
                        <div className="text-[11px] text-slate-400 flex items-center justify-between">
                          <span>
                            Können:{' '}
                            <strong className="text-sky-200">
                              {SKILL_LABELS[selectedNode.requiredSkill]}
                            </strong>
                          </span>
                          {selectedNode.recommendedTool && (
                            <span className="text-amber-200 truncate ml-2">
                              {TOOLS[selectedNode.recommendedTool]?.name.split(' ')[0]}
                            </span>
                          )}
                        </div>
                      )}

                      <button
                        type="button"
                        onClick={() => handleQuickAddNode(selectedNode.id)}
                        className="w-full py-2 px-3 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Auf {crew[selectedCrewId]?.name.split(' ')[0]}s Spur setzen</span>
                      </button>
                    </div>
                  )}

                  {selectedBlock && (
                    <div className="p-3 rounded-xl bg-slate-900/90 border border-amber-400/45 space-y-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <span className="font-mono-tech text-[10px] uppercase text-amber-300">
                            {crew[selectedBlock.crewId]?.name} · {ACTION_TYPE_LABELS[selectedBlock.type]}
                          </span>
                          <h3 className="font-display font-bold text-sm text-white">
                            {selectedBlock.label}
                          </h3>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            removePlanBlock(selectedBlock.id);
                            setSelectedBlockId(null);
                          }}
                          className="p-1 rounded bg-rose-500/15 hover:bg-rose-500/30 text-rose-300 cursor-pointer"
                          title="Block entfernen"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>

                      <div className="space-y-1">
                        <div className="flex items-center justify-between font-mono-tech text-[11px]">
                          <span className="text-slate-400">Wunsch-Startzeit:</span>
                          <span className="text-sky-200 font-bold">
                            {formatShortSec(selectedBlock.startSec)} (Effektiv:{' '}
                            {formatShortSec(selectedBlock.computedStartSec ?? selectedBlock.startSec)})
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={75}
                          step={1}
                          value={selectedBlock.startSec}
                          onChange={(e) =>
                            updatePlanBlock(selectedBlock.id, {
                              startSec: Number(e.target.value),
                            })
                          }
                          className="ns-scrubber w-full"
                        />
                      </div>

                      {(selectedBlock.type === 'wait' || selectedBlock.type === 'lookout') && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between font-mono-tech text-[11px]">
                            <span className="text-slate-400">Dauer:</span>
                            <span className="text-amber-300 font-bold">
                              {formatShortSec(selectedBlock.durationSec)}
                            </span>
                          </div>
                          <input
                            type="range"
                            min={3}
                            max={35}
                            step={1}
                            value={selectedBlock.durationSec}
                            onChange={(e) =>
                              updatePlanBlock(selectedBlock.id, {
                                durationSec: Number(e.target.value),
                              })
                            }
                            className="ns-scrubber w-full"
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-3 gap-1.5 font-mono-tech text-[10px]">
                        <div className="p-1.5 rounded bg-slate-950/80 text-center">
                          <div className="text-slate-500">Dauer</div>
                          <div className="text-white font-bold">{selectedBlock.durationSec}s</div>
                        </div>
                        <div className="p-1.5 rounded bg-slate-950/80 text-center">
                          <div className="text-slate-500">Lärm</div>
                          <div className="text-amber-300 font-bold">{selectedBlock.estimatedNoise}</div>
                        </div>
                        <div className="p-1.5 rounded bg-slate-950/80 text-center">
                          <div className="text-slate-500">Spur</div>
                          <div className="text-rose-300 font-bold">{selectedBlock.estimatedTraceRisk}</div>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => setSyncSourceBlockId(selectedBlock.id)}
                        className="w-full py-1.5 px-3 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 border border-amber-400/50 text-amber-200 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer"
                      >
                        <Link2 className="w-3.5 h-3.5" />
                        <span>Synchronpunkt ab hier setzen</span>
                      </button>
                    </div>
                  )}

                  {!selectedNode && !selectedBlock && (
                    <div className="p-3 rounded-xl bg-slate-900/70 border border-slate-800 text-xs text-slate-400 leading-relaxed">
                      Klicke einen <strong className="text-sky-300">Knoten im Grundriss</strong>{' '}
                      oder einen <strong className="text-amber-300">Block auf der Zeitleiste</strong>.
                      Alle Pfade folgen echten Korridoren (A*) und Türen.
                    </div>
                  )}

                  {!intel.blueprintPurchased && (
                    <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-400/30 flex items-center justify-between gap-2">
                      <div className="text-[11px] text-sky-200 leading-tight">
                        Nebel lichten? Baupläne decken alle Innenräume auf.
                      </div>
                      <button
                        type="button"
                        disabled={bankrollEur < blueprintCost}
                        onClick={() => buyTargetBlueprints(activeTargetId)}
                        className="shrink-0 px-2.5 py-1 rounded-lg bg-sky-400 hover:bg-sky-300 disabled:opacity-40 text-slate-950 font-mono-tech font-bold text-[10px] cursor-pointer disabled:cursor-not-allowed"
                      >
                        {formatEur(blueprintCost)}
                      </button>
                    </div>
                  )}

                  {/* Plan Validation & Warnings */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between font-mono-tech text-[10px] uppercase tracking-wider text-slate-400">
                      <span>Plan-Prüfung</span>
                      <span className={errorCount > 0 ? 'text-rose-400' : 'text-emerald-400'}>
                        {errorCount > 0
                          ? `${errorCount} Fehler`
                          : warningCount > 0
                            ? `${warningCount} Hinweise`
                            : 'Bereit'}
                      </span>
                    </div>

                    {resolvedPlan.issues.length === 0 ? (
                      <div className="p-2.5 rounded-lg bg-emerald-500/10 border border-emerald-400/35 text-[11px] text-emerald-200 flex items-center gap-2">
                        <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                        <span>Keine Konflikte im Ablaufplan erkannt.</span>
                      </div>
                    ) : (
                      resolvedPlan.issues.map((iss, idx) => (
                        <div
                          key={`${iss.code}_${idx}`}
                          className={`p-2 rounded-lg border text-[11px] flex items-start gap-1.5 leading-snug ${
                            iss.severity === 'error'
                              ? 'bg-rose-500/15 border-rose-400/45 text-rose-200'
                              : iss.severity === 'warning'
                                ? 'bg-amber-500/12 border-amber-400/40 text-amber-100'
                                : 'bg-sky-500/10 border-sky-400/30 text-sky-200'
                          }`}
                        >
                          {iss.severity === 'error' ? (
                            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-0.5 text-rose-400" />
                          ) : (
                            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                          )}
                          <span>{iss.message}</span>
                        </div>
                      ))
                    )}
                  </div>
                </>
              )}

              {/* -------- TAB 2: FORENSIK-AUSRÜSTUNG (Live Die-Akte Impact) -------- */}
              {inspectorTab === 'forensic' && selectedMember && (
                <div className="space-y-3">
                  {/* Crew Picker Strip */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {rawPlan.assignedCrewIds.map((cid) => {
                      const m = crew[cid];
                      const active = cid === selectedCrewId;
                      return (
                        <button
                          key={cid}
                          type="button"
                          onClick={() => setSelectedCrewId(cid)}
                          className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg border text-[11px] font-semibold cursor-pointer ${
                            active
                              ? 'bg-sky-500/20 border-sky-400/70 text-white'
                              : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-white'
                          }`}
                        >
                          <CharacterAvatar
                            portraitKey={m.portraitKey}
                            name={m.name}
                            accentColor={m.accentColor}
                            size="xs"
                          />
                          <span>{m.name.split(' ')[0]}</span>
                        </button>
                      );
                    })}
                  </div>

                  {/* Passive Forensic Gear Toggles */}
                  <div className="space-y-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setCrewForensicLoadout(selectedCrewId, {
                          gloves: !currentForensic.gloves,
                        })
                      }
                      className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        currentForensic.gloves
                          ? 'bg-emerald-500/15 border-emerald-400/55 text-emerald-100'
                          : 'bg-slate-900/80 border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          <Fingerprint className="w-3.5 h-3.5 text-emerald-300" />
                          <span>Nitril-Handschuhe</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Keine Fingerabdrücke in Die Akte (+5% Zeit)
                        </div>
                      </div>
                      <span className="font-mono-tech text-[10px] font-bold px-2 py-0.5 rounded bg-slate-950/70 shrink-0">
                        {currentForensic.gloves ? 'AN' : 'AUS'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setCrewForensicLoadout(selectedCrewId, {
                          mask: !currentForensic.mask,
                        })
                      }
                      className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        currentForensic.mask
                          ? 'bg-emerald-500/15 border-emerald-400/55 text-emerald-100'
                          : 'bg-slate-900/80 border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          <EyeOff className="w-3.5 h-3.5 text-sky-300" />
                          <span>Sturmhaube / Maske</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          Blockt CCTV-Gesichtsabgleich (auf Straße auffällig)
                        </div>
                      </div>
                      <span className="font-mono-tech text-[10px] font-bold px-2 py-0.5 rounded bg-slate-950/70 shrink-0">
                        {currentForensic.mask ? 'AN' : 'AUS'}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() =>
                        setCrewForensicLoadout(selectedCrewId, {
                          darkClothing: !currentForensic.darkClothing,
                        })
                      }
                      className={`w-full p-2.5 rounded-xl border text-left flex items-center justify-between gap-2 transition-colors cursor-pointer ${
                        currentForensic.darkClothing
                          ? 'bg-cyan-500/15 border-cyan-400/55 text-cyan-100'
                          : 'bg-slate-900/80 border-slate-800 text-slate-300'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="text-xs font-bold flex items-center gap-1.5">
                          <Moon className="w-3.5 h-3.5 text-cyan-300" />
                          <span>Mattschwarze Kleidung</span>
                        </div>
                        <div className="text-[10px] text-slate-400">
                          -25% Sichtbarkeit in abgedunkelten Räumen
                        </div>
                      </div>
                      <span className="font-mono-tech text-[10px] font-bold px-2 py-0.5 rounded bg-slate-950/70 shrink-0">
                        {currentForensic.darkClothing ? 'AN' : 'AUS'}
                      </span>
                    </button>
                  </div>

                  {/* Entry Tool Selector: Glasschneider vs Dietrich vs Brecheisen */}
                  <div className="space-y-1.5">
                    <div className="font-mono-tech text-[10px] uppercase tracking-wider text-amber-300 flex items-center gap-1.5">
                      <Wrench className="w-3 h-3" />
                      <span>Einstiegs- &amp; Vitrinenwerkzeug</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5">
                      {ENTRY_TOOL_OPTIONS.map((opt) => {
                        const active = currentForensic.entryTool === opt.id;
                        return (
                          <button
                            key={opt.id}
                            type="button"
                            onClick={() =>
                              setCrewForensicLoadout(selectedCrewId, {
                                entryTool: opt.id,
                              })
                            }
                            className={`p-2 rounded-lg border text-center transition-all cursor-pointer ${
                              active
                                ? opt.id === 'crowbar'
                                  ? 'bg-rose-500/20 border-rose-400/70 text-rose-100'
                                  : 'bg-amber-500/20 border-amber-400/70 text-amber-100'
                                : 'bg-slate-900/80 border-slate-800 text-slate-400 hover:text-white'
                            }`}
                          >
                            <div className="text-[11px] font-bold">{opt.label}</div>
                            <div className="text-[9px] opacity-80 mt-0.5 leading-tight">
                              {opt.noiseHint}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Live Die-Akte Forensik Impact Preview */}
                  <div className="p-2.5 rounded-xl bg-slate-950/90 border border-slate-800 space-y-2">
                    <div className="font-mono-tech text-[10px] uppercase tracking-wider text-slate-400">
                      Auswirkung auf Die Akte &amp; Einsatz
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 font-mono-tech text-[10px]">
                      <div className="p-1.5 rounded bg-slate-900/90">
                        <div className="text-slate-500">Akte Spur-Risiko</div>
                        <div
                          className={`font-bold ${
                            forensicPreview.traceRisk >= 40
                              ? 'text-rose-400'
                              : forensicPreview.traceRisk >= 20
                                ? 'text-amber-300'
                                : 'text-emerald-300'
                          }`}
                        >
                          {forensicPreview.traceRisk}%
                        </div>
                      </div>
                      <div className="p-1.5 rounded bg-slate-900/90">
                        <div className="text-slate-500">Lärm-Radius</div>
                        <div
                          className={`font-bold ${
                            forensicPreview.noiseMeters >= 10
                              ? 'text-rose-400'
                              : 'text-sky-300'
                          }`}
                        >
                          ~{forensicPreview.noiseMeters} m
                        </div>
                      </div>
                      <div className="p-1.5 rounded bg-slate-900/90">
                        <div className="text-slate-500">Arbeitstempo</div>
                        <div className="font-bold text-amber-200">
                          +{forensicPreview.speedDeltaPct}%
                        </div>
                      </div>
                      <div className="p-1.5 rounded bg-slate-900/90">
                        <div className="text-slate-500">Schattentarnung</div>
                        <div className="font-bold text-cyan-300">
                          +{forensicPreview.lightConcealmentPct}%
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* -------- TAB 3: SYNCHRONPUNKTE -------- */}
              {inspectorTab === 'sync' && (
                <div className="space-y-3">
                  <p className="text-[11px] text-slate-400 leading-snug">
                    Verknüpfe zwei Spuren: Block B startet erst, wenn Block A vollständig abgeschlossen ist (z. B. Strom kappen → Eindringen).
                  </p>

                  <div className="p-2.5 rounded-xl bg-slate-900/90 border border-amber-400/35 space-y-2">
                    <div className="font-mono-tech text-[10px] uppercase text-amber-300">
                      Neuer Synchronpunkt
                    </div>
                    <select
                      value={syncFromDropdown}
                      onChange={(e) => setSyncFromDropdown(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
                    >
                      <option value="">1. Erst wenn fertig (Block A)…</option>
                      {resolvedPlan.plan.blocks.map((b) => (
                        <option key={b.id} value={b.id}>
                          [{crew[b.crewId]?.name.split(' ')[0]}] {b.label}
                        </option>
                      ))}
                    </select>
                    <select
                      value={syncToDropdown}
                      onChange={(e) => setSyncToDropdown(e.target.value)}
                      className="w-full px-2 py-1.5 rounded-lg bg-slate-950 border border-slate-700 text-xs text-slate-200"
                    >
                      <option value="">2. …startet Block B</option>
                      {resolvedPlan.plan.blocks.map((b) => (
                        <option key={b.id} value={b.id}>
                          [{crew[b.crewId]?.name.split(' ')[0]}] {b.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!syncFromDropdown || !syncToDropdown}
                      onClick={handleDropdownSyncCreate}
                      className="w-full py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs cursor-pointer disabled:cursor-not-allowed"
                    >
                      Synchronpunkt setzen
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    {rawPlan.syncBarriers.length === 0 ? (
                      <p className="text-xs text-slate-500 italic">
                        Noch keine Synchronpunkte gesetzt.
                      </p>
                    ) : (
                      rawPlan.syncBarriers.map((sb) => {
                        const fromB = resolvedPlan.blocksById[sb.fromBlockId];
                        const toB = resolvedPlan.blocksById[sb.toBlockId];
                        return (
                          <div
                            key={sb.id}
                            className="p-2.5 rounded-lg bg-slate-900/90 border border-amber-400/30 flex items-start justify-between gap-2"
                          >
                            <div className="min-w-0 text-[11px]">
                              <div className="font-semibold text-amber-200 truncate">
                                {sb.label}
                              </div>
                              <div className="text-slate-400 font-mono-tech text-[10px] mt-0.5">
                                {crew[sb.fromCrewId]?.name.split(' ')[0]} ({fromB?.label ?? '?'}) →{' '}
                                {crew[sb.toCrewId]?.name.split(' ')[0]} ({toB?.label ?? '?'})
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeSyncBarrier(sb.id)}
                              className="p-1 rounded hover:bg-rose-500/20 text-slate-400 hover:text-rose-300 cursor-pointer shrink-0"
                              title="Synchronpunkt entfernen"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* -------- TAB 4: PLAN B AUSWEICHZWEIGE -------- */}
              {inspectorTab === 'planb' && (
                <div className="space-y-2.5">
                  <p className="text-[11px] text-slate-400 leading-snug">
                    Hinterlege Ausweichregeln je Komplize für Alarmfälle oder deinen Funkbefehl{' '}
                    <span className="font-mono-tech text-amber-300">[Taste 2]</span>.
                  </p>

                  {rawPlan.assignedCrewIds.map((cid) => {
                    const member = crew[cid];
                    const existing = rawPlan.planBBranches.find((b) => b.crewId === cid);
                    const currentTrigger: PlanBTrigger = existing?.trigger ?? 'on_alarm';
                    const currentAction: PlanBFallbackAction =
                      existing?.action ?? 'abort_to_car';

                    return (
                      <div
                        key={cid}
                        className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 space-y-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <CharacterAvatar
                              portraitKey={member.portraitKey}
                              name={member.name}
                              accentColor={member.accentColor}
                              size="xs"
                              ring
                            />
                            <span className="text-xs font-bold text-white">
                              {member.name.split(' ')[0]}
                            </span>
                          </div>
                          {existing && (
                            <button
                              type="button"
                              onClick={() => removePlanBBranch(existing.id)}
                              className="text-[10px] text-slate-500 hover:text-rose-300 cursor-pointer"
                            >
                              Zurücksetzen
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-1 gap-1.5">
                          <select
                            value={currentTrigger}
                            onChange={(e) =>
                              handleUpdatePlanB(
                                cid,
                                e.target.value as PlanBTrigger,
                                currentAction
                              )
                            }
                            className="w-full px-2 py-1 rounded bg-slate-950 border border-slate-700 text-[11px] text-slate-200"
                          >
                            {(Object.keys(PLAN_B_TRIGGER_LABELS) as PlanBTrigger[]).map((tr) => (
                              <option key={tr} value={tr}>
                                {PLAN_B_TRIGGER_LABELS[tr]}
                              </option>
                            ))}
                          </select>

                          <select
                            value={currentAction}
                            onChange={(e) =>
                              handleUpdatePlanB(
                                cid,
                                currentTrigger,
                                e.target.value as PlanBFallbackAction
                              )
                            }
                            className="w-full px-2 py-1 rounded bg-slate-950 border border-amber-500/35 text-[11px] text-amber-100"
                          >
                            {(Object.keys(PLAN_B_ACTION_LABELS) as PlanBFallbackAction[]).map(
                              (act) => (
                                <option key={act} value={act}>
                                  → {PLAN_B_ACTION_LABELS[act]}
                                </option>
                              )
                            )}
                          </select>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>
        </div>

        {/* BOTTOM HALF (~45% height): Multi-Track DAW Timeline */}
        <div className="flex-[45] min-h-0 overflow-hidden">
          <TimelineDAW
            target={target}
            resolvedPlan={resolvedPlan}
            snapshot={snapshot}
            allConflicts={allConflicts}
            selectedBlockId={selectedBlockId}
            syncSourceBlockId={syncSourceBlockId}
            onSelectBlock={(bid) => {
              setSelectedBlockId(bid);
              if (bid) {
                const blk = resolvedPlan.blocksById[bid];
                if (blk) {
                  setSelectedFloor(blk.floor);
                  if (blk.targetNodeId) setSelectedNodeId(blk.targetNodeId);
                }
                setInspectorTab('inspect');
              }
            }}
            onStartSyncLink={(bid) => {
              setSyncSourceBlockId(bid);
              setInspectorTab('sync');
            }}
            onCompleteSyncLink={handleCompleteSyncLink}
            onCancelSyncLink={() => setSyncSourceBlockId(null)}
          />
        </div>
      </div>
    </div>
  );
}
