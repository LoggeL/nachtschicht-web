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
  EyeOff,
  Gauge,
  Lightbulb,
  LightbulbOff,
  Lock,
  Moon,
  Navigation,
  Radio,
  ShieldAlert,
  Siren,
  Sliders,
  Sun,
  Timer,
  Volume2,
  VolumeX,
  Zap,
  ZapOff,
} from 'lucide-react';
import { useGameStore } from '../../state/store';
import { TARGETS } from '../../sim/data';
import { AlarmLevel, CrewId, FLOOR_LABELS, GraphicsQuality } from '../../sim/types';
import { formatEur, formatTimeSec } from '../assets';
import { CharacterAvatar } from '../components/CharacterAvatar';
import { HeistMinigames } from '../components/HeistMinigames';
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

const QUALITY_OPTIONS: Array<{ id: GraphicsQuality; label: string }> = [
  { id: 'ultra', label: 'Ultra' },
  { id: 'high', label: 'Hoch' },
  { id: 'medium', label: 'Mittel' },
];

function formatGear(gear?: number): string {
  if (gear === undefined) return '1';
  if (gear < 0) return 'R';
  if (gear === 0) return 'N';
  return String(Math.min(5, gear));
}

export function WorldOverlayHUD() {
  const phase = useGameStore((s) => s.phase);
  const activeTargetId = useGameStore((s) => s.activeTargetId);
  const graphicsQuality = useGameStore((s) => s.graphicsQuality);
  const crew = useGameStore((s) => s.crew);
  const intelByTarget = useGameStore((s) => s.intelByTarget);
  const plansByTarget = useGameStore((s) => s.plansByTarget);
  const scoutingState = useGameStore((s) => s.scoutingState);
  const liveState = useGameStore((s) => s.liveState);
  const escapeState = useGameStore((s) => s.escapeState);
  const audioMuted = useGameStore((s) => s.audioMuted);

  const getResolvedPlan = useGameStore((s) => s.getResolvedPlan);
  const setPhase = useGameStore((s) => s.setPhase);
  const setGraphicsQuality = useGameStore((s) => s.setGraphicsQuality);
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

  // Stealth telemetry helpers
  const stealth = liveState?.stealthTelemetry;
  const highestSuspicion = stealth?.highestSuspicion ?? 0;
  const suspicionAngle = stealth?.suspicionSourceAngle ?? null;
  const lightExposurePct = Math.round((stealth?.lightExposure ?? 0.35) * 100);
  const noiseDb = Math.round(stealth?.noiseDb ?? 24);
  const radioWindowSec = stealth?.radioInterruptWindowSec ?? null;
  const carryPenaltyPct = Math.round((stealth?.carryWeightPenalty ?? 0) * 100);
  const radioingGuard = liveState?.guards.find((g) => g.state === 'radioing') ?? null;
  const activeCalloutGuard =
    liveState?.guards.find((g) => g.calloutText && g.state !== 'patrol') ?? null;

  // Escape telemetry helpers
  const rpm = escapeState?.rpm ?? Math.min(7000, 900 + (escapeState?.speedKmh ?? 0) * 52);
  const rpmPct = Math.max(8, Math.min(100, ((rpm - 800) / 6400) * 100));
  const headlightsOn = escapeState?.headlightsOn ?? true;
  const policeStatus =
    escapeState?.policeStatus ?? (escapeState?.policeSpotted ? 'pursuit' : 'searching');
  const losCooldownPct = Math.round((escapeState?.policeLosCooldown ?? 0) * 100);

  const handleToggleHeadlights = () => {
    // Dispatch KeyL so @world/VehicleController toggles real 3D SpotLights, audio, and store in sync
    window.dispatchEvent(
      new KeyboardEvent('keydown', { code: 'KeyL', key: 'l', bubbles: true })
    );
  };

  const renderQualityPicker = () => (
    <div
      className="flex items-center gap-0.5 bg-slate-950/85 backdrop-blur border border-slate-700/80 rounded-xl p-0.5 pointer-events-auto"
      title="3D-Grafikqualität (Post-Processing & Beleuchtung)"
    >
      <Sliders className="w-3 h-3 text-slate-400 ml-1.5 mr-1 shrink-0" />
      {QUALITY_OPTIONS.map((q) => (
        <button
          key={q.id}
          type="button"
          onClick={() => setGraphicsQuality(q.id)}
          className={`px-2 py-1 rounded-lg font-mono-tech text-[10px] font-semibold transition-colors cursor-pointer ${
            graphicsQuality === q.id
              ? 'bg-sky-400 text-slate-950'
              : 'text-slate-400 hover:text-white'
          }`}
        >
          {q.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-[#050912] select-none">
      {/* Fullscreen Three.js 3D World Canvas underneath */}
      <div className="absolute inset-0 z-0 w-full h-full">
        <WorldCanvas />
      </div>

      {/* Directional Stealth Suspicion Arc (Executing mode, non-blocking centered radar) */}
      {phase === 'executing' &&
        liveState &&
        highestSuspicion >= 6 &&
        suspicionAngle !== null && (
          <div className="absolute inset-0 z-10 pointer-events-none flex items-center justify-center">
            <div
              className="relative w-60 h-60 transition-transform duration-100"
              style={{ transform: `rotate(${Math.round(suspicionAngle + 90)}deg)` }}
            >
              <svg viewBox="0 0 200 200" className="w-full h-full">
                {/* Background faint threat arc */}
                <path
                  d="M 55 24 A 86 86 0 0 1 145 24"
                  fill="none"
                  stroke="rgba(15, 23, 42, 0.55)"
                  strokeWidth="8"
                  strokeLinecap="round"
                />
                {/* Filled suspicion progress arc (amber -> crimson) */}
                <path
                  d="M 55 24 A 86 86 0 0 1 145 24"
                  fill="none"
                  stroke={
                    highestSuspicion >= 75
                      ? '#f43f5e'
                      : highestSuspicion >= 40
                        ? '#f59e0b'
                        : '#fde68a'
                  }
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={`${Math.round((highestSuspicion / 100) * 96)} 100`}
                  style={{
                    filter:
                      highestSuspicion >= 65
                        ? 'drop-shadow(0 0 8px rgba(244,63,94,0.9))'
                        : 'drop-shadow(0 0 6px rgba(245,158,11,0.75))',
                  }}
                />
                {/* Center chevron tip */}
                <polygon
                  points="100,4 106,15 94,15"
                  fill={highestSuspicion >= 75 ? '#fb7185' : '#fbbf24'}
                />
              </svg>
            </div>
          </div>
        )}

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
                    Ebene: {FLOOR_LABELS[scoutingState.playerFloor]} · Sichtlinie über Fenster &amp; Zugänge
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

                {/* Wall Occlusion Feedback */}
                {scoutingState.blockedReason === 'wall_occluded' && (
                  <div className="pt-2 border-t border-slate-800 flex items-center gap-1.5 text-[11px] text-amber-300">
                    <EyeOff className="w-3.5 h-3.5 shrink-0" />
                    <span>Sicht durch Wand blockiert — Fenster oder Eingang suchen</span>
                  </div>
                )}

                {/* Inline Patrol Stopwatch / Nearby Target Indicator */}
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

              {/* Top-Right Action Buttons + Quality Switcher */}
              <div className="flex items-center gap-2 pointer-events-auto">
                {renderQualityPicker()}
                <button
                  type="button"
                  onClick={() => setPhase('planning')}
                  className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-xs shadow-lg shadow-amber-500/25 cursor-pointer whitespace-nowrap"
                >
                  <DraftingCompass className="w-4 h-4" />
                  <span>Reißbrett (Tab)</span>
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
            {/* Top Row: Alarm & Stealth Telemetry (Left) · Timeline & Loot (Center) · Quality & Escape (Right) */}
            <div className="grid grid-cols-12 items-start gap-3">
              {/* Top-Left: Alarm, Light Exposure & dB Noise Meter */}
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

                {/* Light Exposure & Acoustic dB Meters */}
                <div className="grid grid-cols-2 gap-2.5 font-mono-tech text-[10px]">
                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-300">
                      <span className="flex items-center gap-1">
                        {lightExposurePct <= 30 ? (
                          <Moon className="w-3 h-3 text-cyan-300" />
                        ) : (
                          <Sun className="w-3 h-3 text-amber-300" />
                        )}
                        LICHT
                      </span>
                      <span
                        className={
                          lightExposurePct <= 30
                            ? 'text-cyan-300'
                            : lightExposurePct >= 70
                              ? 'text-amber-300'
                              : 'text-slate-200'
                        }
                      >
                        {lightExposurePct <= 30 ? 'SCHATTEN' : `${lightExposurePct}%`}
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          lightExposurePct <= 30
                            ? 'bg-cyan-400'
                            : lightExposurePct >= 70
                              ? 'bg-amber-400'
                              : 'bg-sky-400'
                        }`}
                        style={{ width: `${lightExposurePct}%` }}
                      />
                    </div>
                  </div>

                  <div className="space-y-1">
                    <div className="flex justify-between text-slate-300">
                      <span>SCHALL</span>
                      <span
                        className={
                          noiseDb >= 65
                            ? 'text-rose-300 font-bold'
                            : noiseDb >= 45
                              ? 'text-amber-300'
                              : 'text-emerald-300'
                        }
                      >
                        {noiseDb} dB
                      </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          noiseDb >= 65
                            ? 'bg-rose-500'
                            : noiseDb >= 45
                              ? 'bg-amber-400'
                              : 'bg-emerald-400'
                        }`}
                        style={{
                          width: `${Math.min(100, Math.max(8, ((noiseDb - 20) / 80) * 100))}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Facility Status & Carry Weight Pills */}
                <div className="flex flex-wrap items-center gap-1.5 font-mono-tech text-[10px]">
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
                  {carryPenaltyPct > 0 && (
                    <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-200 border border-amber-400/35">
                      Last -{carryPenaltyPct}%
                    </span>
                  )}
                </div>
              </div>

              {/* Top-Center: Mini Timeline Progress, Loot & Radio-Dispatch Warning */}
              <div className="col-span-4 space-y-2">
                <div className="noir-glass rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-display font-bold text-xs text-white truncate">
                      {target.name}
                    </span>
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-lg bg-amber-500/20 border border-amber-400/50 font-mono-tech text-xs font-bold text-amber-200 shrink-0">
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

                {/* Interruptible Guard Radio Dispatch Banner */}
                {(radioingGuard || (radioWindowSec !== null && radioWindowSec > 0)) && (
                  <div className="noir-glass rounded-xl px-3.5 py-2 border-rose-500/80 bg-rose-950/80 space-y-1 animate-toast">
                    <div className="flex items-center justify-between text-xs font-bold text-rose-100">
                      <span className="flex items-center gap-1.5">
                        <Radio className="w-3.5 h-3.5 text-rose-300 animate-pulse" />
                        <span>
                          {radioingGuard?.name ?? 'Wache'} funkt Leitstelle!
                        </span>
                      </span>
                      {radioWindowSec !== null && (
                        <span className="font-mono-tech text-rose-200">
                          {radioWindowSec.toFixed(1)}s
                        </span>
                      )}
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-950 overflow-hidden">
                      <div
                        className="h-full bg-rose-400 transition-all"
                        style={{
                          width: `${Math.round((radioingGuard?.radioProgress ?? 0.5) * 100)}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {!radioingGuard && activeCalloutGuard?.calloutText && (
                  <div className="noir-glass rounded-lg px-3 py-1.5 border-amber-400/50 text-center text-[11px] font-medium text-amber-100">
                    {activeCalloutGuard.name}: „{activeCalloutGuard.calloutText}“
                  </div>
                )}
              </div>

              {/* Top-Right: Quality Switcher, Escape Trigger & Audio */}
              <div className="col-span-4 flex flex-col items-end gap-2">
                <div className="flex items-center gap-1.5 pointer-events-auto">
                  {renderQualityPicker()}
                  <button
                    type="button"
                    onClick={() => setPhase('planning')}
                    className="px-2.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs cursor-pointer"
                    title="Zurück zum Reißbrett"
                  >
                    Reißbrett
                  </button>
                  <button
                    type="button"
                    onClick={toggleAudioMuted}
                    className="p-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
                    aria-label="Ton umschalten"
                  >
                    {audioMuted ? (
                      <VolumeX className="w-4 h-4 text-rose-400" />
                    ) : (
                      <Volume2 className="w-4 h-4 text-amber-400" />
                    )}
                  </button>
                </div>

                {(liveState.readyForEscape ||
                  liveState.totalLootEur > 0 ||
                  liveState.abortActive) && (
                  <button
                    type="button"
                    onClick={startEscape}
                    className={`pointer-events-auto inline-flex items-center gap-2 px-4 py-2 rounded-xl font-display font-bold text-xs shadow-xl transition-all cursor-pointer ${
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
              </div>
            </div>

            {/* Upper-Right (inset from right-edge floor switcher): Live Deviation Feed */}
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
            <div className="flex flex-col gap-2">
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

              <div className="flex justify-center">
                <div className="px-3.5 py-1 rounded-lg bg-slate-950/75 border border-slate-800/80 font-mono-tech text-[10px] text-slate-400 flex items-center gap-4">
                  <span>WASD Steuern (Mara)</span>
                  <span>Shift Schleichen</span>
                  <span>E Interagieren / Schloss &amp; Securion</span>
                  <span>1/2/3 Mannschaftsfunk</span>
                </div>
              </div>
            </div>
          </>
        )}

        {/* ============================================================
            MODE 3: ESCAPE (FLUCHT) COCKPIT HUD
        ============================================================ */}
        {phase === 'escape' && escapeState && (
          <>
            {/* Top Row: Pursuit & LoS Cooldown · Safehouse Distance · Car Condition & Quality */}
            <div className="grid grid-cols-12 items-start gap-3">
              {/* Top-Left: Mossos Pursuit & Line-of-Sight Cooldown */}
              <div className="col-span-4 noir-glass rounded-xl p-3.5 space-y-2 border-rose-500/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-mono-tech text-xs font-bold text-rose-300">
                    <Siren
                      className={`w-4 h-4 ${
                        policeStatus === 'pursuit'
                          ? 'animate-pulse text-rose-400'
                          : policeStatus === 'evaded'
                            ? 'text-emerald-400'
                            : 'text-amber-400'
                      }`}
                    />
                    {policeStatus === 'pursuit'
                      ? 'POLIZEI IN SICHT'
                      : policeStatus === 'dispatched'
                        ? `STREIFE ANFAHRT (${Math.ceil(escapeState.policeDispatchEtaSec ?? 0)}s)`
                        : policeStatus === 'evaded'
                          ? 'VERFOLGUNG ABGESCHÜTTELT'
                          : 'SUCHFAHNDUNG — ABKÜHLEN'}
                  </span>
                  <span className="font-mono-tech text-xs font-bold text-white">
                    {Math.round(escapeState.pursuitHeat)}%
                  </span>
                </div>

                {/* Pursuit Heat Bar */}
                <div className="h-2 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-amber-400 via-rose-500 to-red-500 transition-all"
                    style={{ width: `${Math.min(100, escapeState.pursuitHeat)}%` }}
                  />
                </div>

                {/* LoS Cooldown Bar when hidden */}
                <div className="space-y-1">
                  <div className="flex items-center justify-between font-mono-tech text-[10px]">
                    <span className="text-sky-300">
                      Sichtfrei-Cooldown ({escapeState.clearSightTimerSec.toFixed(1)}s)
                    </span>
                    <span className="text-slate-300">{losCooldownPct}%</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-900 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-sky-400 to-emerald-400 transition-all"
                      style={{ width: `${losCooldownPct}%` }}
                    />
                  </div>
                </div>

                {/* Forensic Chase Warnings */}
                {(escapeState.vehicleRecognized || escapeState.paintScrapeTrace) && (
                  <div className="flex flex-wrap items-center gap-2 font-mono-tech text-[10px] pt-0.5">
                    {escapeState.vehicleRecognized && (
                      <span className="inline-flex items-center gap-1 text-rose-300 font-bold">
                        <ShieldAlert className="w-3 h-3" />
                        WAGEN ERKANNT (AKTE)
                      </span>
                    )}
                    {escapeState.paintScrapeTrace && (
                      <span className="text-amber-300 font-bold">
                        · LACKSPUR GESICHERT
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Top-Center: Distance to Safehouse + Lock Status */}
              <div className="col-span-4 noir-glass rounded-xl p-3.5 space-y-2 border-emerald-400/45">
                <div className="flex items-center justify-between gap-2">
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

                {escapeState.safehouseLocked && (
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-200">
                    <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    <span>Versteck gesperrt — Sichtkontakt erst brechen ([L] Licht aus!)</span>
                  </div>
                )}
              </div>

              {/* Top-Right: Car Condition, Quality & Controls */}
              <div className="col-span-4 flex flex-col items-end gap-2">
                <div className="flex items-center gap-1.5 pointer-events-auto">
                  {renderQualityPicker()}
                  <button
                    type="button"
                    onClick={() => finishEscape(false)}
                    className="px-2.5 py-1.5 rounded-xl bg-slate-900/90 hover:bg-rose-950/80 border border-slate-700 hover:border-rose-500/50 text-slate-300 hover:text-rose-200 text-xs cursor-pointer"
                    title="Flucht abbrechen"
                  >
                    Abbrechen
                  </button>
                  <button
                    type="button"
                    onClick={toggleAudioMuted}
                    className="p-1.5 rounded-xl bg-slate-900/90 hover:bg-slate-800 border border-slate-700 text-slate-200 cursor-pointer"
                    aria-label="Ton umschalten"
                  >
                    {audioMuted ? (
                      <VolumeX className="w-4 h-4 text-rose-400" />
                    ) : (
                      <Volume2 className="w-4 h-4 text-amber-400" />
                    )}
                  </button>
                </div>

                <div className="noir-glass rounded-xl px-3.5 py-2 w-48 space-y-1">
                  <div className="flex justify-between font-mono-tech text-[10px] text-slate-300">
                    <span>CHASSIS-ZUSTAND</span>
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
              </div>
            </div>

            {/* Bottom Row: Stealth Headlight Toggle + Controls (Left) & Cockpit Instrument Cluster (Right) */}
            <div className="flex items-end justify-between gap-4">
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleToggleHeadlights}
                  className={`pointer-events-auto inline-flex items-center gap-2 px-3.5 py-2.5 rounded-xl border font-mono-tech text-xs font-bold transition-all cursor-pointer ${
                    headlightsOn
                      ? 'noir-glass border-amber-400/55 text-amber-200 hover:bg-amber-500/15'
                      : 'bg-cyan-950/90 border-cyan-400/75 text-cyan-200 shadow-lg shadow-cyan-500/15'
                  }`}
                  title="Scheinwerfer in dunklen Seitenstraßen ausschalten verringert Polizei-Sichtweite!"
                >
                  {headlightsOn ? (
                    <Lightbulb className="w-4 h-4 text-amber-300" />
                  ) : (
                    <LightbulbOff className="w-4 h-4 text-cyan-300" />
                  )}
                  <kbd className="px-1.5 py-0.5 rounded bg-slate-900 text-[10px] text-white">L</kbd>
                  <span>{headlightsOn ? 'LICHT AN' : 'TARNFAHRT (AUS)'}</span>
                </button>

                <div className="noir-glass px-4 py-2.5 rounded-xl font-mono-tech text-xs text-slate-200 flex items-center gap-4">
                  <span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-white mr-1.5">WASD</kbd>
                    Fahren
                  </span>
                  <span>
                    <kbd className="px-1.5 py-0.5 rounded bg-slate-800 text-amber-300 mr-1.5">Space</kbd>
                    Drift
                  </span>
                </div>
              </div>

              {/* Realistic Cockpit Instrument Cluster: Gear, RPM Bar, km/h, Drift */}
              <div className="noir-glass rounded-2xl px-4 py-3 border-amber-400/40 min-w-64 space-y-2">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Gauge className="w-6 h-6 text-amber-400 shrink-0" />
                    <div>
                      <div className="font-mono-tech text-3xl font-bold text-white leading-none">
                        {Math.round(escapeState.speedKmh)}
                      </div>
                      <div className="font-mono-tech text-[10px] uppercase tracking-widest text-slate-400 mt-0.5">
                        KM/H
                      </div>
                    </div>
                  </div>

                  {/* Gear Indicator & Drift Pill */}
                  <div className="flex items-center gap-2">
                    {escapeState.isDrifting && (
                      <span className="px-2 py-0.5 rounded bg-amber-500/25 border border-amber-400/70 font-mono-tech text-[10px] font-bold text-amber-200 animate-pulse">
                        DRIFT
                      </span>
                    )}
                    <div className="w-10 h-10 rounded-xl bg-slate-950 border border-amber-400/50 flex flex-col items-center justify-center">
                      <span className="font-mono-tech text-base font-bold text-amber-300 leading-none">
                        {formatGear(escapeState.gear)}
                      </span>
                      <span className="font-mono-tech text-[8px] text-slate-500 uppercase">
                        GANG
                      </span>
                    </div>
                  </div>
                </div>

                {/* RPM Bar */}
                <div className="space-y-1">
                  <div className="flex justify-between font-mono-tech text-[9px] text-slate-400">
                    <span>RPM</span>
                    <span className={rpm >= 5800 ? 'text-rose-400 font-bold' : 'text-sky-300'}>
                      {Math.round(rpm)} U/min
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-slate-900 overflow-hidden">
                    <div
                      className={`h-full transition-all ${
                        rpm >= 5800
                          ? 'bg-gradient-to-r from-amber-400 to-rose-500'
                          : 'bg-gradient-to-r from-sky-400 to-amber-400'
                      }`}
                      style={{ width: `${rpmPct}%` }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>

      {/* Tactile Heist Minigames Overlay (Lockpicking / Safe Dial / Securion Circuit Bypass) */}
      {phase === 'executing' && <HeistMinigames />}
    </div>
  );
}
