import { useState } from 'react';
import {
  Compass,
  DraftingCompass,
  Play,
  RotateCcw,
  ShieldAlert,
  Sliders,
  Sparkles,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { useGameStore } from '../../state/store';
import { TARGET_ORDER, TARGETS } from '../../sim/data';
import { GraphicsQuality } from '../../sim/types';
import { formatEur, getImageUrl, useAssetManifest } from '../assets';

const QUALITY_OPTIONS: Array<{ id: GraphicsQuality; label: string }> = [
  { id: 'ultra', label: 'Ultra' },
  { id: 'high', label: 'Hoch' },
  { id: 'medium', label: 'Mittel' },
];

export function TitleScreen() {
  const hasSavedGame = useGameStore((s) => s.hasSavedGame);
  const day = useGameStore((s) => s.day);
  const bankrollEur = useGameStore((s) => s.bankrollEur);
  const completedTargetIds = useGameStore((s) => s.completedTargetIds);
  const graphicsQuality = useGameStore((s) => s.graphicsQuality);
  const audioMuted = useGameStore((s) => s.audioMuted);
  const startNewCampaign = useGameStore((s) => s.startNewCampaign);
  const continueCampaign = useGameStore((s) => s.continueCampaign);
  const quickPlayTarget = useGameStore((s) => s.quickPlayTarget);
  const setGraphicsQuality = useGameStore((s) => s.setGraphicsQuality);
  const resetSave = useGameStore((s) => s.resetSave);
  const toggleAudioMuted = useGameStore((s) => s.toggleAudioMuted);

  const { images } = useAssetManifest();
  const [heroError, setHeroError] = useState(false);

  const heroUrl = getImageUrl('title_salou_night', images);

  return (
    <div className="relative w-screen h-screen overflow-hidden bg-slate-950 text-slate-100 select-none">
      {/* Fullscreen 35mm Cinema Hero Backdrop */}
      <div className="absolute inset-0 overflow-hidden cinema-vignette">
        {!heroError ? (
          <img
            src={heroUrl}
            alt="Salou bei Nacht — Nachtschicht"
            onError={() => setHeroError(true)}
            className="w-full h-full object-cover animate-ken-burns opacity-95 contrast-[1.04]"
          />
        ) : (
          <div className="w-full h-full blueprint-surface" />
        )}
        <div className="absolute inset-0 cinema-scanlines pointer-events-none" />
        {/* Prestige Night-Thriller directional vignettes preserving coastal cinematography */}
        <div className="absolute inset-0 bg-gradient-to-r from-[#040812]/95 via-[#050b18]/68 to-[#050b18]/18" />
        <div className="absolute inset-0 bg-gradient-to-t from-[#040812] via-transparent to-[#040812]/50" />
      </div>

      {/* Content Layer */}
      <div className="relative z-10 h-full w-full flex flex-col justify-between px-8 py-6 lg:px-12 lg:py-8">
        {/* Top Metadata Strip */}
        <header className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-slate-950/75 border border-sky-400/35 text-sky-200 font-mono-tech text-xs tracking-widest uppercase backdrop-blur">
              <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
              COSTA DAURADA · SALOU / DRESDEN
            </span>
            <span className="hidden sm:inline-block font-mono-tech text-xs text-slate-400 tracking-wider">
              AKTE MOSSOS-TGN-2026-NS
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Graphics Quality Switcher */}
            <div
              className="flex items-center gap-0.5 bg-slate-950/80 backdrop-blur border border-slate-700/75 rounded-lg p-0.5"
              title="3D-Grafikqualität"
            >
              <Sliders className="w-3.5 h-3.5 text-slate-400 ml-1.5 mr-1" />
              {QUALITY_OPTIONS.map((q) => (
                <button
                  key={q.id}
                  type="button"
                  onClick={() => setGraphicsQuality(q.id)}
                  className={`px-2 py-1 rounded font-mono-tech text-[11px] font-semibold transition-colors cursor-pointer ${
                    graphicsQuality === q.id
                      ? 'bg-sky-400 text-slate-950'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {q.label}
                </button>
              ))}
            </div>

            {hasSavedGame && (
              <button
                type="button"
                onClick={resetSave}
                title="Spielstand zurücksetzen"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/75 hover:bg-rose-950/70 border border-slate-700/70 hover:border-rose-500/50 text-slate-300 hover:text-rose-200 text-xs font-mono-tech transition-colors cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Spielstand löschen</span>
              </button>
            )}
            <button
              type="button"
              onClick={toggleAudioMuted}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-900/75 hover:bg-slate-800 border border-slate-700/70 text-slate-200 text-xs font-mono-tech transition-colors cursor-pointer"
              aria-label={audioMuted ? 'Ton einschalten' : 'Ton stummschalten'}
            >
              {audioMuted ? (
                <VolumeX className="w-4 h-4 text-rose-400" />
              ) : (
                <Volume2 className="w-4 h-4 text-amber-400" />
              )}
              <span>{audioMuted ? 'Ton aus' : 'Ton an'}</span>
            </button>
          </div>
        </header>

        {/* Center Hero Branding & Primary Campaign CTAs */}
        <main className="my-auto max-w-xl space-y-5">
          <div className="space-y-2.5">
            <div className="inline-flex items-center gap-2 text-amber-400 font-mono-tech text-xs uppercase tracking-[0.26em]">
              <DraftingCompass className="w-4 h-4" />
              <span>Auskundschaften · Planen · Durchziehen</span>
            </div>
            <h1 className="font-display text-5xl lg:text-7xl font-bold tracking-[0.06em] text-white leading-none drop-shadow-[0_6px_28px_rgba(0,0,0,0.75)]">
              NACHT<span className="text-amber-400">SCHICHT</span>
            </h1>
            <p className="text-sm lg:text-base text-slate-200/90 leading-relaxed max-w-lg">
              Mara Voss kennt jede Securion-Alarmanlage an der Costa Daurada. Mit Tresorknacker
              Jupp Kowalke und deiner Mannschaft zeichnest du den perfekten Bruch am Reißbrett —
              und ziehst ihn live durch Salou bis in die Dresdner Schatzkammer durch.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            {hasSavedGame && (
              <button
                type="button"
                onClick={continueCampaign}
                className="group inline-flex items-center gap-3 px-6 py-3.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-base tracking-wide shadow-xl shadow-amber-500/25 transition-all cursor-pointer"
              >
                <Play className="w-5 h-5 fill-slate-950" />
                <span>Kampagne fortsetzen</span>
                <span className="ml-1 px-2 py-0.5 rounded bg-slate-950/20 font-mono-tech text-xs">
                  Tag {day} · {completedTargetIds.length}/4
                </span>
              </button>
            )}

            <button
              type="button"
              onClick={startNewCampaign}
              className={`inline-flex items-center gap-2.5 px-6 py-3.5 rounded-xl font-display font-bold text-base tracking-wide transition-all cursor-pointer ${
                hasSavedGame
                  ? 'bg-slate-900/85 hover:bg-slate-800 text-white border border-slate-600/70'
                  : 'bg-amber-500 hover:bg-amber-400 text-slate-950 shadow-xl shadow-amber-500/25'
              }`}
            >
              <Sparkles className="w-5 h-5" />
              <span>{hasSavedGame ? 'Neue Kampagne' : 'Kampagne starten'}</span>
            </button>
          </div>

          {hasSavedGame && (
            <p className="font-mono-tech text-xs text-slate-400">
              Gespeicherter Stand: Werkstatt La Pineda · Kasse {formatEur(bankrollEur)}
            </p>
          )}
        </main>

        {/* Bottom Quick-Play Heist Selector */}
        <section className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-mono-tech uppercase tracking-[0.2em] text-sky-300">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Schnellstart — Direkt zum Objekt (Starter-Plan geladen)</span>
            </div>
            <span className="hidden md:inline-flex items-center gap-1.5 text-xs text-slate-400 font-mono-tech">
              <ShieldAlert className="w-3.5 h-3.5 text-rose-400" />
              Inspectora Núria Ferrer führt die Akte „Nachtschicht“
            </span>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {TARGET_ORDER.map((tid) => {
              const t = TARGETS[tid];
              const isFinale = tid === 'schatzkammer_dresden';
              return (
                <div
                  key={tid}
                  className={`noir-glass rounded-xl p-3.5 flex flex-col justify-between gap-2.5 border transition-all hover:border-amber-400/55 ${
                    isFinale
                      ? 'border-amber-400/35 bg-gradient-to-br from-amber-950/35 to-slate-950/85'
                      : 'border-slate-700/60'
                  }`}
                >
                  <div className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono-tech text-[10px] uppercase tracking-widest px-1.5 py-0.5 rounded bg-slate-800/90 text-sky-300">
                        Akt {t.act} · {t.city}
                      </span>
                      <span className="font-mono-tech text-xs font-semibold text-amber-300">
                        {formatEur(t.estimatedLootEur)}
                      </span>
                    </div>
                    <h3 className="font-display font-bold text-sm text-white leading-tight truncate">
                      {t.name}
                    </h3>
                    <p className="text-[11px] text-slate-400 truncate">{t.subtitle}</p>
                  </div>

                  <div className="grid grid-cols-3 gap-1.5 pt-0.5">
                    <button
                      type="button"
                      onClick={() => quickPlayTarget(tid, 'planning')}
                      className="px-2 py-1.5 rounded-lg bg-sky-500/20 hover:bg-sky-500/35 border border-sky-400/40 text-sky-100 text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      title="Direkt am Reißbrett planen & Probelauf testen"
                    >
                      <DraftingCompass className="w-3 h-3 shrink-0" />
                      <span>Plan</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => quickPlayTarget(tid, 'scouting')}
                      className="px-2 py-1.5 rounded-lg bg-slate-800/85 hover:bg-slate-700 border border-slate-600/60 text-slate-100 text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      title="3D Auskundschaften"
                    >
                      <Compass className="w-3 h-3 shrink-0" />
                      <span>3D Späh</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => quickPlayTarget(tid, 'executing')}
                      className="px-2 py-1.5 rounded-lg bg-amber-500/25 hover:bg-amber-500/40 border border-amber-400/55 text-amber-200 text-[11px] font-semibold flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      title="Direkt 3D Live-Bruch durchziehen"
                    >
                      <Play className="w-3 h-3 shrink-0" />
                      <span>Bruch</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}
