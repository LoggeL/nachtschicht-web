import { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Binoculars,
  Briefcase,
  Car,
  CheckCircle2,
  Compass,
  DraftingCompass,
  Eye,
  Gauge,
  Navigation,
  Radio,
  ShieldAlert,
  Siren,
  Timer,
  Volume2,
  VolumeX,
  Zap,
  ZapOff,
} from 'lucide-react';
import { useGameStore } from '../../state/store';
import { TARGETS } from '../../sim/data';
import { AlarmLevel, CrewId, FLOOR_LABELS } from '../../sim/types';
import { formatEur, formatTimeSec } from '../assets';
import { CharacterAvatar } from '../components/CharacterAvatar';
import { WorldCanvas } from '../../world/WorldCanvas';

const ALARM_BADGE: Record<
  AlarmLevel,
  { label: string; bg: string; dot: string }
> = {
  silent: {
    label: 'STILLER BRUCH',
    bg: 'bg-emerald-500/20 border-emerald-400/55 text-emerald-200',
    dot: 'bg-emerald-400',
  },
  suspicious: {
    label: 'VERDÄCHTIG',
    bg: 'bg-amber-500/25 border-amber-400/65 text-amber-200',
    dot: 'bg-amber-400 animate-pulse',
  },
  alarm: {
    label: 'ALARM AUSGELÖST',
    bg: 'bg-rose-600/30 border-rose-400/80 text-rose-100',
    dot: 'bg-rose-400 animate-ping',
  },
  lockdown: {
    label: 'GROSSFAHNDUNG',
    bg: 'bg-red-700/40 border-red-400 text-red-100',
    dot: 'bg-red-400 animate-ping',
  },
};

export function WorldOverlayHUD() {
  const phase = useGameStore((s) => s.phase);
  const activeTargetId = useGameStore((s) => s.activeTargetId);
  const crew = useGameStore((s) => s.crew);
  const intelByTarget = useGameStore((s) => s.intelByTarget);
  const plansByTarget = useGameStore((s) => s.plansByTarget);
  const scoutingState = useGameStore((s) => s.scoutingState);
  const liveState = useGameStore((s) => s.liveState);
  const escapeState = useGameStore((s) => s.escapeState);
  const audioMuted = useGameStore((s) => s.audioMuted);

  const getResolvedPlan = useGameStore((s) => s.getResolvedPlan);
  const setPhase = useGameStore((s) => s.setPhase);
  const issueRadioCommand = useGameStore((s) => s.issueRadioCommand);
  const startEscape = useGameStore((s) => s.startEscape);
  const finishEscape = useGameStore((s) => s.finishEscape);
  const toggleAudioMuted = useGameStore((s) => s.toggleAudioMuted);

  const target = TARGETS[activeTargetId];
  const intel = intelByTarget[activeTargetId];
  const plan = plansByTarget[activeTargetId];

  const resolvedPlan = useMemo(
    () => getResolvedPlan(activeTargetId),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeTargetId, plan, crew, intel]
  );

  // Discoverable intel counts for Scouting checklist
  const discoverableNodes = useMemo(
    () =>
      target.nodes.filter(
        (n) => n.kind !== 'getaway_zone' && n.kind !== 'stairs'
      ),
    [target.nodes]
  );
  const discoveredCount = discoverableNodes.filter((n) =>
    intel.discoveredNodeIds.includes(n.id)
  ).length;
  const timedGuardsCount = target.guards.filter((g) =>
    intel.timedGuardIds.includes(g.id)
  ).length;

  const totalPlanSec = Math.max(10, resolvedPlan.totalDurationSec);
  const liveProgressPct = liveState
    ? Math.min(100, (liveState.elapsedSec / totalPlanSec) * 100)
    : 0;

  const alarmMeta = liveState
    ? ALARM_BADGE[liveState.alarmLevel]
    : ALARM_BADGE.silent;

  const escapeDistancePct = escapeState
    ? Math.max(
        0,
        Math.min(
          100,
          (1 - escapeState.distanceToSafehouseM / Math.max(1, target.safehouseEscapeDistanceM)) *
            100
        )
      )
    : 0;

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 select-none">
      {/* Fullscreen Three.js 3D World Canvas underneath */}
      <div className="absolute inset-0 z-0 w-full h-full">
        <WorldCanvas />
      </div>

      {/* Non-blocking HUD Overlay Container */}
      <div className="absolute inset-0 z-20 pointer-events-none flex flex-col justify-between p-4">
        {/* ============================================================
            MODE 1: SCOUTING (AUSKUNDSCHAFTEN) HUD
        ============================================================ */}
        {phase === 'scouting' && (
          <>
            {/* Top Bar */}
            <div className="flex items-start justify-between gap-4">
              {/* Top-Left: Objective Checklist + Active Scan/Stopwatch Status */}
              <div className="noir-glass rounded-xl p-3.5 w-80 space-y-2.5 border-sky-400/35">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Compass className="w-4 h-4 text-sky-400" />
                    <span className="font-mono-tech text-[10px] uppercase tracking-widest text-sky-300">
                      AUSKUNDSCHAFTEN
                    </span>
                  </div>
                  <span className="font-mono-tech text-xs font-bold text-white">
                    {intel.completionPercent}%
                  </span>
                </div>

                <div>
                  <h2 className="font-display font-bold text-sm text-white leading-tight">
                    {target.name}
                  </h2>
                  <p className="text-[11px] text-slate-400">
                    Ebene: {FLOOR_LABELS[scoutingState.playerFloor]} · Alles Gesehene landet am Reißbrett
                  </p>
                </div>

                <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-sky-400 to-cyan-300 transition-all duration-300"
                    style={{ width: `${intel.completionPercent}%` }}
                  />
                </div>

                <div className="space-y-1 font-mono-tech text-[11px]">
                  <div className="flex items-center justify-between text-slate-200">
                    <span className="flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5 text-sky-400" />
                      Entdeckte Infos
                    </span>
                    <span className="font-bold text-sky-300">
                      {discoveredCount} / {discoverableNodes.length}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-slate-200">
                    <span className="flex items-center gap-1.5">
                      <Timer className="w-3.5 h-3.5 text-amber-400" />
                      Wachrunden gestoppt
                    </span>
                    <span className="font-bold text-amber-300">
                      {timedGuardsCount} / {target.guards.length}
                    </span>
                  </div>
                </div>

                {/* Inline Patrol Stopwatch / Nearby Target Indicator (zero overlap with 3D prompt) */}
                {scoutingState.timingGuardName && (
                  <div className="pt-2 border-t border-slate-800 space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-amber-200 font-semibold">
                      <span className="flex items-center gap-1.5 truncate">
                        <Timer className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                        Stoppuhr: {scoutingState.timingGuardName}
                      </span>
                      <span className="font-mono-tech">
                        {Math.round(scoutingState.guardTimingProgress * 100)}%
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-amber-400 transition-all"
                        style={{
                          width: `${Math.round(scoutingState.guardTimingProgress * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {!scoutingState.timingGuardName && scoutingState.nearbyNodeLabel && (
                  <div className="pt-2 border-t border-slate-800 space-y-1">
                    <div className="flex items-center justify-between text-[11px] text-sky-200 font-semibold">
                      <span className="truncate">Ziel: {scoutingState.nearbyNodeLabel}</span>
                      <span className="font-mono-tech">
                        {Math.round(scoutingState.scanProgress * 100)}%
                      </span>
                    </div>
                    <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-sky-400 transition-all"
                        style={{
                          width: `${Math.round(scoutingState.scanProgress * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Center Toast Notification */}
              <div className="flex flex-col items-center gap-2">
                {scoutingState.lastDiscoveryToast && (
                  <div className="noir-glass px-4 py-2 rounded-xl border-emerald-400/55 text-emerald-200 text-xs font-semibold flex items-center gap-2 animate-toast shadow-lg">
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>{scoutingState.lastDiscoveryToast}</span>
                  </div>
                )}
              </div>

              {/* Top-Right Action Buttons */}
              <div className="flex items-center gap-2 pointer-events-auto">
                <button
                  type="button"
                  onClick={() => setPhase('planning')}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-xs shadow-lg shadow-amber-500/25 cursor-pointer"
                >
                  <DraftingCompass className="w-4 h-4" />
                  <span>Zurück zum Reißbrett (Tab)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setPhase('safehouse')}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs cursor-pointer"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>Versteck</span>
                </button>
                <button
                  type="button"
                  onClick={toggleAudioMuted}
                  className="p-2 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
                  aria-label="Ton umschalten"
                >
                  {audioMuted ? (
                    <VolumeX className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-amber-400" />
                  )}
                </button>
              </div>
            </div>

            {/* Bottom Controls Hint Strip */}
            <div className="flex flex-col items-center">
              <div className="noir-glass px-4 py-2 rounded-xl flex flex-wrap items-center justify-center gap-4 font-mono-tech text-[11px] text-slate-300">
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-white mr-1">WASD</kbd>
                  Bewegen
                </span>
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-white mr-1">E</kbd>
                  Scannen / Stoppuhr
                </span>
                <span className="flex items-center gap-1">
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-white">F</kbd>
                  <Binoculars className="w-3.5 h-3.5 text-sky-400" />
                  Fernglas
                </span>
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 mr-1">Tab</kbd>
                  Reißbrett
                </span>
              </div>
            </div>
          </>
        )}

        {/* ============================================================
            MODE 2: LIVE EXECUTION (DURCHZIEHEN) HUD
        ============================================================ */}
        {phase === 'executing' && liveState && (
          <>
            {/* Top Row: Alarm/Noise (Left) · Timeline & Loot (Center) · Escape CTA (Right) */}
            <div className="grid grid-cols-12 items-start gap-3">
              {/* Top-Left: Alarm & Noise Meter */}
              <div className="col-span-4 noir-glass rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-lg border font-mono-tech text-[11px] font-bold ${alarmMeta.bg}`}
                  >
                    <span className={`w-2 h-2 rounded-full ${alarmMeta.dot}`} />
                    {alarmMeta.label}
                  </span>

                  {liveState.policeEtaSec !== null && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-600/35 border border-rose-400/70 font-mono-tech text-xs font-bold text-rose-100">
                      <Siren className="w-3.5 h-3.5" />
                      ETA {Math.ceil(liveState.policeEtaSec)}s
                    </span>
                  )}
                </div>

                {/* Alarm & Noise Bars */}
                <div className="grid grid-cols-2 gap-2.5 font-mono-tech text-[10px]">
                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-300">
                      <span>ALARM</span>
                      <span className="text-rose-300">{Math.round(liveState.alarmProgress)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-amber-400 to-rose-500 transition-all"
                        style={{ width: `${Math.min(100, liveState.alarmProgress)}%` }}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-300">
                      <span>LÄRM</span>
                      <span className="text-amber-300">{Math.round(liveState.noiseLevel)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-gradient-to-r from-sky-400 to-amber-400 transition-all"
                        style={{ width: `${Math.min(100, liveState.noiseLevel)}%` }}
                      />
                    </div>
                  </div>
                </div>

                {/* Facility Status Pills */}
                <div className="flex items-center gap-2 font-mono-tech text-[10px]">
                  <span
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded ${
                      liveState.powerDisabled
                        ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-400/45'
                        : 'bg-slate-800/80 text-slate-400'
                    }`}
                  >
                    {liveState.powerDisabled ? (
                      <ZapOff className="w-3 h-3" />
                    ) : (
                      <Zap className="w-3 h-3" />
                    )}
                    {liveState.powerDisabled ? 'STROM AUS' : 'STROM AN'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded ${
                      liveState.alarmBypassed
                        ? 'bg-emerald-500/20 text-emerald-200 border border-emerald-400/45'
                        : 'bg-slate-800/80 text-slate-400'
                    }`}
                  >
                    {liveState.alarmBypassed ? '✓ S-ALARM OFF' : 'S-ALARM SCHARF'}
                  </span>
                </div>
              </div>

              {/* Top-Center: Mini Timeline Progress & Loot Counter */}
              <div className="col-span-4 noir-glass rounded-xl p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-display font-bold text-xs text-white truncate">
                    {target.name}
                  </span>
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-amber-500/20 border border-amber-400/50 font-mono-tech text-xs font-bold text-amber-200">
                    <Briefcase className="w-3.5 h-3.5" />
                    {formatEur(liveState.totalLootEur)} ({liveState.collectedLoot.length})
                  </span>
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between font-mono-tech text-[10px] text-slate-300">
                    <span>ZEITPLAN-FORTSCHRITT</span>
                    <span>
                      {formatTimeSec(liveState.elapsedSec)} / {formatTimeSec(totalPlanSec)}
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-900 border border-slate-700 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-sky-400 via-cyan-300 to-amber-400 transition-all"
                      style={{ width: `${liveProgressPct}%` }}
                    />
                  </div>
                </div>
              </div>

              {/* Top-Right: Escape Trigger & Audio */}
              <div className="col-span-4 flex items-start justify-end gap-2 pointer-events-auto">
                {(liveState.readyForEscape ||
                  liveState.totalLootEur > 0 ||
                  liveState.abortActive) && (
                  <button
                    type="button"
                    onClick={startEscape}
                    className={`inline-flex items-center gap-2 px-4 py-2.5 rounded-xl font-display font-bold text-xs shadow-xl transition-all cursor-pointer ${
                      liveState.readyForEscape
                        ? 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 animate-pulse shadow-emerald-500/30'
                        : 'bg-amber-500/90 hover:bg-amber-400 text-slate-950'
                    }`}
                  >
                    <Car className="w-4 h-4" />
                    <span>
                      {liveState.readyForEscape
                        ? 'Alle im Wagen — Flucht starten!'
                        : 'Jetzt zum Fluchtwagen'}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => setPhase('planning')}
                  className="px-3 py-2 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs cursor-pointer"
                  title="Zurück zum Reißbrett"
                >
                  Reißbrett
                </button>

                <button
                  type="button"
                  onClick={toggleAudioMuted}
                  className="p-2 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
                  aria-label="Ton umschalten"
                >
                  {audioMuted ? (
                    <VolumeX className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-amber-400" />
                  )}
                </button>
              </div>
            </div>

            {/* Upper-Right (inset from right-edge floor switcher): Live Deviation & Radio Alert Feed */}
            <div className="mb-auto mt-2 flex justify-end pr-14">
              <div className="w-76 space-y-2">
                {liveState.deviations.slice(-3).map((dev) => (
                  <div
                    key={dev.id}
                    className={`noir-glass rounded-xl p-2.5 border animate-toast flex items-start gap-2 ${
                      dev.severity === 'critical'
                        ? 'border-rose-400/70 bg-rose-950/70'
                        : dev.severity === 'warning'
                          ? 'border-amber-400/65 bg-amber-950/60'
                          : 'border-sky-400/50 bg-slate-900/80'
                    }`}
                  >
                    <AlertTriangle
                      className={`w-4 h-4 shrink-0 mt-0.5 ${
                        dev.severity === 'critical'
                          ? 'text-rose-400'
                          : dev.severity === 'warning'
                            ? 'text-amber-400'
                            : 'text-sky-400'
                      }`}
                    />
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white leading-tight">
                        {dev.title}
                      </div>
                      <p className="text-[11px] text-slate-200/90 leading-snug mt-0.5">
                        {dev.detail}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Bottom Row: Live Crew Strip + Funk-Befehle Bar */}
            <div className="flex flex-col gap-2.5">
              {/* Crew Status Strip */}
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="flex flex-wrap items-center gap-2">
                  {(Object.keys(liveState.crew) as CrewId[]).map((cid) => {
                    const lc = liveState.crew[cid];
                    const member = crew[cid];
                    if (!lc || !member) return null;

                    const stateColor =
                      lc.state === 'extracted'
                        ? 'border-emerald-400/65'
                        : lc.state === 'deviating' || lc.state === 'caught'
                          ? 'border-rose-400/80'
                          : lc.state === 'waiting_sync' || lc.state === 'holding'
                            ? 'border-amber-400/65'
                            : 'border-slate-700/80';

                    return (
                      <div
                        key={cid}
                        className={`noir-glass rounded-xl p-2 w-44 xl:w-52 border ${stateColor} space-y-1.5`}
                      >
                        <div className="flex items-center gap-2">
                          <CharacterAvatar
                            portraitKey={member.portraitKey}
                            name={member.name}
                            accentColor={member.accentColor}
                            size="xs"
                            ring
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-1">
                              <span className="text-xs font-bold text-white truncate">
                                {member.name.split(' ')[0]}
                              </span>
                              {lc.carryingLootEur > 0 && (
                                <span className="font-mono-tech text-[10px] text-amber-300 font-bold">
                                  {formatEur(lc.carryingLootEur)}
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-sky-200 truncate">
                              {lc.activeActionLabel}
                            </div>
                          </div>
                        </div>

                        <div className="h-1 rounded-full bg-slate-800 overflow-hidden">
                          <div
                            className="h-full transition-all"
                            style={{
                              width: `${
                                lc.state === 'extracted'
                                  ? 100
                                  : Math.round(lc.blockProgress * 100)
                              }%`,
                              backgroundColor: member.accentColor,
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Clickable Funk-Befehle Bar */}
                <div className="noir-glass rounded-xl p-2 flex items-center gap-2 pointer-events-auto border-amber-400/35">
                  <div className="flex items-center gap-1.5 px-2 text-amber-300 font-mono-tech text-[10px] uppercase tracking-wider">
                    <Radio className="w-3.5 h-3.5" />
                    <span>FUNK</span>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      issueRadioCommand(liveState.holdActive ? 'resume' : 'hold')
                    }
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                      liveState.holdActive
                        ? 'bg-sky-400 text-slate-950 border-sky-300'
                        : 'bg-slate-900 hover:bg-slate-800 text-slate-100 border-slate-700'
                    }`}
                  >
                    <kbd className="font-mono-tech mr-1.5 opacity-75">1</kbd>
                    {liveState.holdActive ? 'Weiter' : 'Warten'}
                  </button>

                  <button
                    type="button"
                    onClick={() => issueRadioCommand('plan_b')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                      liveState.planBActive
                        ? 'bg-amber-400 text-slate-950 border-amber-300'
                        : 'bg-amber-500/20 hover:bg-amber-500/35 text-amber-200 border-amber-400/50'
                    }`}
                  >
                    <kbd className="font-mono-tech mr-1.5 opacity-80">2</kbd>
                    Plan B
                  </button>

                  <button
                    type="button"
                    onClick={() => issueRadioCommand('abort')}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-colors cursor-pointer ${
                      liveState.abortActive
                        ? 'bg-rose-500 text-white border-rose-300'
                        : 'bg-rose-500/20 hover:bg-rose-500/35 text-rose-200 border-rose-400/50'
                    }`}
                  >
                    <kbd className="font-mono-tech mr-1.5 opacity-80">3</kbd>
                    Abbruch
                  </button>
                </div>
              </div>

              {/* Slim Controls Hint */}
              <div className="flex justify-center">
                <div className="px-3.5 py-1 rounded-lg bg-slate-950/75 border border-slate-800/80 font-mono-tech text-[10px] text-slate-400 flex items-center gap-4">
                  <span>WASD Steuern (Mara)</span>
                  <span>Shift Schleichen</span>
                  <span>E Interagieren</span>
                  <span>1/2/3 Mannschaftsfunk</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ============================================================
            MODE 3: ESCAPE (FLUCHT) HUD
        ============================================================ */}
        {phase === 'escape' && escapeState && (
          <>
            {/* Top Row: Pursuit Heat · Distance to Safehouse · Car Integrity */}
            <div className="grid grid-cols-12 items-start gap-4">
              {/* Top-Left: Pursuit Heat */}
              <div className="col-span-4 noir-glass rounded-xl p-3.5 space-y-2 border-rose-500/40">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-mono-tech text-xs font-bold text-rose-300">
                    <Siren
                      className={`w-4 h-4 ${
                        escapeState.policeSpotted ? 'animate-pulse text-rose-400' : 'text-sky-400'
                      }`}
                    />
                    {escapeState.policeSpotted ? 'POLIZEI IN SICHT' : 'SICHTKONTAKT GEBROCHEN'}
                  </span>
                  <span className="font-mono-tech text-xs font-bold text-white">
                    {Math.round(escapeState.pursuitHeat)}%
                  </span>
                </div>

                <div className="h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-amber-400 via-rose-500 to-red-500 transition-all"
                    style={{ width: `${Math.min(100, escapeState.pursuitHeat)}%` }}
                  />
                </div>

                <div className="flex items-center justify-between font-mono-tech text-[10px]">
                  <span className="text-slate-300">
                    Sichtfrei: {escapeState.clearSightTimerSec.toFixed(1)}s
                  </span>
                  {escapeState.vehicleRecognized && (
                    <span className="inline-flex items-center gap-1 text-rose-300 font-bold">
                      <ShieldAlert className="w-3 h-3" />
                      WAGEN ERKANNT (AKTE)
                    </span>
                  )}
                </div>
              </div>

              {/* Top-Center: Distance to Safehouse */}
              <div className="col-span-4 noir-glass rounded-xl p-3.5 space-y-2 border-emerald-400/45">
                <div className="flex items-center justify-between">
                  <span className="inline-flex items-center gap-1.5 font-mono-tech text-[11px] uppercase tracking-wider text-emerald-300">
                    <Navigation className="w-3.5 h-3.5" />
                    {target.city === 'Dresden'
                      ? 'Fluchtroute Augustusbrücke'
                      : 'Versteck La Pineda'}
                  </span>
                  <span className="font-mono-tech text-base font-bold text-white">
                    {Math.max(0, Math.round(escapeState.distanceToSafehouseM))} m
                  </span>
                </div>

                <div className="h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-sky-400 to-emerald-400 transition-all"
                    style={{ width: `${escapeDistancePct}%` }}
                  />
                </div>
              </div>

              {/* Top-Right: Car Condition & Controls */}
              <div className="col-span-4 flex items-start justify-end gap-2 pointer-events-auto">
                <div className="noir-glass rounded-xl px-3.5 py-2.5 w-44 space-y-1">
                  <div className="flex justify-between font-mono-tech text-[10px] text-slate-300">
                    <span>WAGEN-ZUSTAND</span>
                    <span
                      className={
                        escapeState.carDamage > 65 ? 'text-rose-400' : 'text-emerald-300'
                      }
                    >
                      {Math.max(0, Math.round(100 - escapeState.carDamage))}%
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-900 overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        escapeState.carDamage > 65 ? 'bg-rose-500' : 'bg-emerald-400'
                      }`}
                      style={{
                        width: `${Math.max(0, Math.min(100, 100 - escapeState.carDamage))}%`,
                      }}
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => finishEscape(false)}
                  className="px-3 py-2.5 rounded-xl bg-slate-900/90 hover:bg-rose-950/80 border border-slate-700 hover:border-rose-500/50 text-slate-300 hover:text-rose-200 text-xs cursor-pointer"
                  title="Flucht abbrechen"
                >
                  Abbrechen
                </button>

                <button
                  type="button"
                  onClick={toggleAudioMuted}
                  className="p-2.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
                  aria-label="Ton umschalten"
                >
                  {audioMuted ? (
                    <VolumeX className="w-4 h-4 text-rose-400" />
                  ) : (
                    <Volume2 className="w-4 h-4 text-amber-400" />
                  )}
                </button>
              </div>
            </div>

            {/* Bottom Row: Controls Hint (Left) & Digital Speedometer (Right) */}
            <div className="flex items-end justify-between gap-4">
              <div className="noir-glass px-4 py-2 rounded-xl font-mono-tech text-xs text-slate-200 flex items-center gap-4">
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-white mr-1.5">WASD</kbd>
                  Fahren / Lenken
                </span>
                <span>
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 mr-1.5">Space</kbd>
                  Handbremse / Drift
                </span>
              </div>

              {/* Speedometer */}
              <div className="noir-glass rounded-2xl px-5 py-3.5 border-amber-400/45 flex items-center gap-4 min-w-48">
                <Gauge className="w-7 h-7 text-amber-400 shrink-0" />
                <div>
                  <div className="font-mono-tech text-3xl font-bold text-white leading-none">
                    {Math.round(escapeState.speedKmh)}
                  </div>
                  <div className="font-mono-tech text-[10px] uppercase tracking-widest text-amber-300 mt-1">
                    KM/H · FLUCHTWAGEN
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
