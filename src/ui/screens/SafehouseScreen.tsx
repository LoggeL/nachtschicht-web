import { useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Briefcase,
  CheckCircle2,
  Compass,
  DraftingCompass,
  FileWarning,
  Fingerprint,
  Home,
  Lock,
  MapPin,
  Play,
  ShieldAlert,
  Star,
  UserCheck,
  UserPlus,
  Users,
  Volume2,
  VolumeX,
  Wrench,
} from 'lucide-react';
import { useGameStore } from '../../state/store';
import {
  COUNTERMEASURES,
  FENCES,
  TARGET_ORDER,
  TARGETS,
  TOOLS,
} from '../../sim/data';
import {
  CrewId,
  FenceId,
  LOOT_CATEGORY_LABELS,
  SKILL_LABELS,
  SkillKey,
  TargetId,
  ToolId,
} from '../../sim/types';
import {
  CASE_STATUS_META,
  EVIDENCE_TYPE_LABELS,
  formatEur,
} from '../assets';
import { CharacterAvatar } from '../components/CharacterAvatar';

type SafehouseTab = 'map' | 'crew' | 'akte' | 'economy';

const MAP_PINS: Record<TargetId, { x: number; y: number; shortLabel: string }> = {
  casa_oro: { x: 255, y: 175, shortLabel: 'Salou Zentrum' },
  perla_del_mar: { x: 355, y: 235, shortLabel: 'Strandpromenade' },
  villa_mirador: { x: 505, y: 215, shortLabel: 'Cap Salou' },
  schatzkammer_dresden: { x: 645, y: 78, shortLabel: 'Dresden (Finale)' },
};

const SKILL_KEYS: SkillKey[] = ['locks', 'electronics', 'driving', 'strength', 'climbing'];

export function SafehouseScreen() {
  const [tab, setTab] = useState<SafehouseTab>('map');
  const [selectedCrewForGear, setSelectedCrewForGear] = useState<CrewId>('mara');
  const [storyArchiveOpen, setStoryArchiveOpen] = useState(false);

  const day = useGameStore((s) => s.day);
  const bankrollEur = useGameStore((s) => s.bankrollEur);
  const activeTargetId = useGameStore((s) => s.activeTargetId);
  const completedTargetIds = useGameStore((s) => s.completedTargetIds);
  const crew = useGameStore((s) => s.crew);
  const ownedTools = useGameStore((s) => s.ownedTools);
  const workshopUpgrades = useGameStore((s) => s.workshopUpgrades);
  const intelByTarget = useGameStore((s) => s.intelByTarget);
  const plansByTarget = useGameStore((s) => s.plansByTarget);
  const caseFile = useGameStore((s) => s.caseFile);
  const storyBeats = useGameStore((s) => s.storyBeats);
  const audioMuted = useGameStore((s) => s.audioMuted);

  const setPhase = useGameStore((s) => s.setPhase);
  const selectTarget = useGameStore((s) => s.selectTarget);
  const recruitCrew = useGameStore((s) => s.recruitCrew);
  const toggleCrewOnPlan = useGameStore((s) => s.toggleCrewOnPlan);
  const buyTool = useGameStore((s) => s.buyTool);
  const equipTool = useGameStore((s) => s.equipTool);
  const unequipTool = useGameStore((s) => s.unequipTool);
  const completeLoyaltyQuest = useGameStore((s) => s.completeLoyaltyQuest);
  const buyWorkshopUpgrade = useGameStore((s) => s.buyWorkshopUpgrade);
  const buyTargetBlueprints = useGameStore((s) => s.buyTargetBlueprints);
  const setPlanFence = useGameStore((s) => s.setPlanFence);
  const applyCountermeasure = useGameStore((s) => s.applyCountermeasure);
  const openStoryBeat = useGameStore((s) => s.openStoryBeat);
  const launchHeist = useGameStore((s) => s.launchHeist);
  const toggleAudioMuted = useGameStore((s) => s.toggleAudioMuted);

  const activeTarget = TARGETS[activeTargetId];
  const activeIntel = intelByTarget[activeTargetId];
  const activePlan = plansByTarget[activeTargetId];
  const statusMeta = CASE_STATUS_META[caseFile.status];
  const hasSprayBooth = workshopUpgrades.some(
    (u) => u.id === 'spray_booth' && u.purchased
  );
  const blueprintCost = 2500 * activeTarget.difficulty;

  const unlockedBeats = storyBeats.filter((b) => b.unlocked);
  const openEvidenceCount = caseFile.evidence.filter((e) => !e.mitigated).length;

  // Identify lowest-loyalty non-player accomplice for subtle warning
  const vulnerableAccomplice = Object.values(crew)
    .filter((c) => !c.isPlayerControlled && c.id !== 'jupp' && c.recruited && c.status === 'available')
    .sort((a, b) => a.traits.loyalty - b.traits.loyalty)[0];

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col bg-[#060b16] text-slate-100 blueprint-surface">
      {/* Slim Top Navigation Bar */}
      <header className="h-14 shrink-0 px-5 border-b border-slate-800/90 bg-[#070e1d]/95 backdrop-blur flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => setPhase('title')}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-400 hover:text-white transition-colors cursor-pointer"
            title="Zum Titelbildschirm"
          >
            <Home className="w-4 h-4" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-base tracking-wider text-white">
                WERKSTATT <span className="text-amber-400">LA PINEDA</span>
              </span>
              <span className="hidden xl:inline-block font-mono-tech text-[11px] px-2 py-0.5 rounded bg-slate-800 text-sky-300 border border-slate-700">
                TAG {day}
              </span>
            </div>
          </div>
        </div>

        {/* Center Tabs */}
        <nav className="flex items-center gap-1 bg-slate-900/90 p-1 rounded-xl border border-slate-800">
          {(
            [
              { id: 'map', label: 'Einsatzkarte', icon: MapPin },
              { id: 'crew', label: 'Mannschaft', icon: Users },
              { id: 'akte', label: 'Die Akte', icon: FileWarning, badge: caseFile.heat },
              { id: 'economy', label: 'Hehler & Werkstatt', icon: Briefcase },
            ] as const
          ).map((item) => {
            const Icon = item.icon;
            const active = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setTab(item.id)}
                className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                  active
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{item.label}</span>
                {'badge' in item && (
                  <span
                    className={`font-mono-tech text-[10px] px-1.5 py-0.5 rounded ${
                      active
                        ? 'bg-slate-950/25 text-slate-950 font-bold'
                        : caseFile.heat >= 50
                          ? 'bg-rose-500/25 text-rose-300'
                          : 'bg-slate-800 text-slate-300'
                    }`}
                  >
                    {item.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Right Status Pills */}
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="px-3 py-1 rounded-lg bg-slate-900/90 border border-amber-400/35 flex items-center gap-2">
            <span className="text-[10px] font-mono-tech uppercase text-slate-400">Kasse</span>
            <span className="font-mono-tech text-sm font-bold text-amber-300">
              {formatEur(bankrollEur)}
            </span>
          </div>

          <button
            type="button"
            onClick={() => setStoryArchiveOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-xs text-sky-200 transition-colors cursor-pointer"
            title="Story-Briefings ansehen"
          >
            <BookOpen className="w-3.5 h-3.5 text-amber-400" />
            <span className="hidden lg:inline">Chronik ({unlockedBeats.length}/{storyBeats.length})</span>
          </button>

          <button
            type="button"
            onClick={toggleAudioMuted}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/70 text-slate-300 cursor-pointer"
            aria-label="Ton umschalten"
          >
            {audioMuted ? (
              <VolumeX className="w-4 h-4 text-rose-400" />
            ) : (
              <Volume2 className="w-4 h-4 text-amber-400" />
            )}
          </button>
        </div>
      </header>

      {/* Story Archive Quick Drawer */}
      {storyArchiveOpen && (
        <div className="shrink-0 bg-slate-950/95 border-b border-amber-500/30 px-6 py-3 flex items-center gap-3 overflow-x-auto ns-scroll">
          <span className="font-mono-tech text-xs uppercase text-amber-300 shrink-0">
            Akt 1–3 Dossiers:
          </span>
          {storyBeats.map((b) => (
            <button
              key={b.id}
              type="button"
              disabled={!b.unlocked}
              onClick={() => {
                openStoryBeat(b.id);
                setStoryArchiveOpen(false);
              }}
              className={`shrink-0 px-3 py-1.5 rounded-lg border text-xs flex items-center gap-2 transition-colors ${
                b.unlocked
                  ? 'bg-slate-900 hover:bg-slate-800 border-sky-400/40 text-slate-100 cursor-pointer'
                  : 'bg-slate-950/60 border-slate-800 text-slate-600 cursor-not-allowed'
              }`}
            >
              {!b.unlocked && <Lock className="w-3 h-3" />}
              <span className="font-mono-tech text-[10px] text-amber-400">Akt {b.act}</span>
              <span>{b.title}</span>
            </button>
          ))}
        </div>
      )}

      {/* Main Content Area */}
      <main className="flex-1 min-h-0 overflow-hidden p-4 lg:p-5">
        {/* ======================== TAB 1: EINSATZKARTE ======================== */}
        {tab === 'map' && (
          <div className="h-full grid grid-cols-12 gap-4 min-h-0">
            {/* Left: Stylized Coastal Map + Target Selector List */}
            <div className="col-span-7 flex flex-col gap-3 min-h-0">
              {/* Interactive SVG Costa Daurada + Dresden Flight Map */}
              <div className="noir-card rounded-2xl p-4 flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <div>
                    <h2 className="font-display font-bold text-sm uppercase tracking-widest text-sky-300">
                      Einsatzgebiet — Costa Daurada &amp; Dresden
                    </h2>
                    <p className="text-xs text-slate-400">
                      Wähle ein Einbruchsziel für Aufklärung und Reißbrett-Planung
                    </p>
                  </div>
                  <span className="font-mono-tech text-xs text-slate-400">
                    Abgeschlossen: {completedTargetIds.length} / {TARGET_ORDER.length}
                  </span>
                </div>

                <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden bg-[#060f1e] border border-sky-500/20">
                  <svg
                    viewBox="0 0 760 330"
                    className="w-full h-full"
                    preserveAspectRatio="xMidYMid meet"
                  >
                    <defs>
                      <linearGradient id="seaGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#071a33" />
                        <stop offset="100%" stopColor="#030b18" />
                      </linearGradient>
                      <pattern id="mapGrid" width="32" height="32" patternUnits="userSpaceOnUse">
                        <path
                          d="M 32 0 L 0 0 0 32"
                          fill="none"
                          stroke="rgba(56,189,248,0.08)"
                          strokeWidth="1"
                        />
                      </pattern>
                    </defs>

                    {/* Sea & Grid */}
                    <rect width="760" height="330" fill="url(#seaGrad)" />
                    <rect width="760" height="330" fill="url(#mapGrid)" />

                    {/* Stylized Costa Daurada Coastline Landmass */}
                    <path
                      d="M 0,0 L 575,0 L 560,120 L 595,180 L 555,245 L 485,255 L 420,255 L 330,262 L 220,248 L 125,260 L 0,250 Z"
                      fill="#0e1b30"
                      stroke="#38bdf8"
                      strokeOpacity="0.32"
                      strokeWidth="1.5"
                    />

                    {/* Main coastal highways */}
                    <path
                      d="M 45,205 Q 190,190 255,175 T 355,235 Q 445,235 505,215"
                      fill="none"
                      stroke="#f59e0b"
                      strokeOpacity="0.35"
                      strokeWidth="2"
                      strokeDasharray="6 4"
                    />
                    <path
                      d="M 110,130 Q 200,150 255,175"
                      fill="none"
                      stroke="#38bdf8"
                      strokeOpacity="0.35"
                      strokeWidth="1.5"
                    />

                    {/* Flight Route to Dresden Finale */}
                    <path
                      d="M 505,215 Q 595,155 645,78"
                      fill="none"
                      stroke="#f59e0b"
                      strokeOpacity="0.55"
                      strokeWidth="1.5"
                      strokeDasharray="4 4"
                    />

                    {/* Dresden Inset Box */}
                    <rect
                      x="582"
                      y="22"
                      width="156"
                      height="102"
                      rx="10"
                      fill="#0b1528"
                      stroke="#f59e0b"
                      strokeOpacity="0.45"
                      strokeWidth="1.2"
                    />
                    <text
                      x="594"
                      y="40"
                      fill="#fbbf24"
                      fontSize="9"
                      fontFamily="IBM Plex Mono, monospace"
                      letterSpacing="1.5"
                    >
                      FINALE · ELBUFER
                    </text>

                    {/* District Labels */}
                    <text x="26" y="300" fill="#38bdf8" fillOpacity="0.45" fontSize="11" fontFamily="IBM Plex Mono, monospace" letterSpacing="3">
                      MITTELMEER · COSTA DAURADA
                    </text>
                    <text x="86" y="114" fill="#94a3b8" fontSize="10" fontFamily="IBM Plex Mono, monospace">
                      LA PINEDA
                    </text>
                    <text x="86" y="128" fill="#34d399" fontSize="9" fontFamily="IBM Plex Mono, monospace">
                      ● VERSTECK (WERKSTATT)
                    </text>
                    <circle cx="76" cy="124" r="4.5" fill="#10b981" />

                    <text x="35" y="218" fill="#64748b" fontSize="9" fontFamily="IBM Plex Mono, monospace">
                      CAMBRILS
                    </text>
                    <text x="405" y="92" fill="#64748b" fontSize="9" fontFamily="IBM Plex Mono, monospace">
                      TARRAGONA · ZOLLFREILAGER
                    </text>
                    <circle cx="400" cy="89" r="3" fill="#64748b" />

                    {/* Target Pins */}
                    {TARGET_ORDER.map((tid, idx) => {
                      const t = TARGETS[tid];
                      const pin = MAP_PINS[tid];
                      const isSelected = tid === activeTargetId;
                      const isDone = completedTargetIds.includes(tid);
                      const intelPct = intelByTarget[tid]?.completionPercent ?? 0;

                      return (
                        <g
                          key={tid}
                          onClick={() => selectTarget(tid)}
                          className="cursor-pointer"
                        >
                          {isSelected && (
                            <circle
                              cx={pin.x}
                              cy={pin.y}
                              r="22"
                              fill="rgba(245, 158, 11, 0.14)"
                              stroke="#f59e0b"
                              strokeWidth="1.5"
                              strokeDasharray="4 3"
                            />
                          )}
                          <circle
                            cx={pin.x}
                            cy={pin.y}
                            r={isSelected ? 12 : 9.5}
                            fill={
                              isDone
                                ? '#065f46'
                                : isSelected
                                  ? '#f59e0b'
                                  : '#1e293b'
                            }
                            stroke={
                              isDone
                                ? '#34d399'
                                : isSelected
                                  ? '#fef3c7'
                                  : '#38bdf8'
                            }
                            strokeWidth="2"
                          />
                          <text
                            x={pin.x}
                            y={pin.y + 4}
                            textAnchor="middle"
                            fill={isSelected && !isDone ? '#020617' : '#f8fafc'}
                            fontSize="10"
                            fontWeight="700"
                            fontFamily="IBM Plex Mono, monospace"
                          >
                            {idx + 1}
                          </text>
                          <text
                            x={pin.x}
                            y={pin.y + 27}
                            textAnchor="middle"
                            fill={isSelected ? '#fde68a' : '#cbd5e1'}
                            fontSize="10.5"
                            fontWeight="600"
                            fontFamily="Space Grotesk, sans-serif"
                          >
                            {t.name.replace(/Pfandhaus |Juwelier |Villa |Kurfürstliche /g, '')}
                          </text>
                          <text
                            x={pin.x}
                            y={pin.y + 39}
                            textAnchor="middle"
                            fill="#38bdf8"
                            fontSize="9"
                            fontFamily="IBM Plex Mono, monospace"
                          >
                            Intel {intelPct}%
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>

              {/* Target Cards Strip */}
              <div className="grid grid-cols-4 gap-2.5 shrink-0">
                {TARGET_ORDER.map((tid) => {
                  const t = TARGETS[tid];
                  const selected = tid === activeTargetId;
                  const done = completedTargetIds.includes(tid);
                  const intelPct = intelByTarget[tid]?.completionPercent ?? 0;
                  return (
                    <button
                      key={tid}
                      type="button"
                      onClick={() => selectTarget(tid)}
                      className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                        selected
                          ? 'bg-amber-500/15 border-amber-400/80 shadow-lg shadow-amber-500/10'
                          : 'bg-slate-900/80 border-slate-800 hover:border-slate-600'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1 mb-1">
                        <span className="font-mono-tech text-[10px] uppercase text-sky-300">
                          Akt {t.act}
                        </span>
                        {done ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                        ) : (
                          <span className="font-mono-tech text-[10px] text-amber-300">
                            {formatEur(t.estimatedLootEur)}
                          </span>
                        )}
                      </div>
                      <div className="font-display font-bold text-xs text-white truncate">
                        {t.name}
                      </div>
                      <div className="mt-1.5 h-1 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-sky-400"
                          style={{ width: `${intelPct}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Right: Selected Target Dossier + Launch Controls */}
            <div className="col-span-5 noir-card rounded-2xl p-5 flex flex-col justify-between gap-3 min-h-0 overflow-y-auto ns-scroll">
              <div className="space-y-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-mono-tech text-[11px] uppercase px-2 py-0.5 rounded bg-sky-500/15 border border-sky-400/35 text-sky-300">
                        Akt {activeTarget.act} · {activeTarget.city}
                      </span>
                      <div className="flex items-center gap-0.5 text-amber-400">
                        {Array.from({ length: 5 }).map((_, i) => (
                          <Star
                            key={i}
                            className={`w-3.5 h-3.5 ${
                              i < activeTarget.difficulty
                                ? 'fill-amber-400 text-amber-400'
                                : 'text-slate-700'
                            }`}
                          />
                        ))}
                      </div>
                    </div>
                    <h2 className="font-display text-xl lg:text-2xl font-bold text-white leading-tight">
                      {activeTarget.name}
                    </h2>
                    <p className="text-xs text-slate-400">{activeTarget.subtitle}</p>
                  </div>

                  <div className="text-right shrink-0">
                    <div className="text-[10px] font-mono-tech uppercase text-slate-400">
                      Geschätzte Beute
                    </div>
                    <div className="font-mono-tech text-lg font-bold text-amber-300">
                      {formatEur(activeTarget.estimatedLootEur)}
                    </div>
                  </div>
                </div>

                <p className="text-xs lg:text-sm text-slate-200/90 leading-relaxed">
                  {activeTarget.briefing}
                </p>

                {/* Jupp's handwritten pencil note */}
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-400/30 flex items-start gap-3">
                  <CharacterAvatar
                    portraitKey="portrait_jupp"
                    name="Jupp Kowalke"
                    accentColor="#f59e0b"
                    size="sm"
                  />
                  <div className="min-w-0">
                    <div className="font-mono-tech text-[10px] uppercase tracking-wider text-amber-300 mb-0.5">
                      Jupps Bleistiftnotiz
                    </div>
                    <p className="text-xs text-amber-100/90 italic leading-snug">
                      {activeTarget.juppTip}
                    </p>
                  </div>
                </div>

                {/* Intel Progress + Buy Blueprints */}
                <div className="p-3 rounded-xl bg-slate-900/85 border border-slate-800 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-mono-tech uppercase text-sky-300">
                      Aufklärung (Fog of War)
                    </span>
                    <span className="font-mono-tech font-bold text-white">
                      {activeIntel.completionPercent}%
                    </span>
                  </div>
                  <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-sky-500 to-cyan-300 transition-all"
                      style={{ width: `${activeIntel.completionPercent}%` }}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <span className="text-[11px] text-slate-400">
                      Knoten: {activeIntel.discoveredNodeIds.length} · Wachen gestoppt:{' '}
                      {activeIntel.timedGuardIds.length}/{activeTarget.guards.length}
                    </span>
                    {!activeIntel.blueprintPurchased ? (
                      <button
                        type="button"
                        disabled={bankrollEur < blueprintCost}
                        onClick={() => buyTargetBlueprints(activeTargetId)}
                        className="px-2.5 py-1 rounded-lg bg-sky-500/20 hover:bg-sky-500/35 disabled:opacity-40 border border-sky-400/40 text-sky-200 text-[11px] font-mono-tech transition-colors cursor-pointer disabled:cursor-not-allowed"
                      >
                        Baupläne ({formatEur(blueprintCost)})
                      </button>
                    ) : (
                      <span className="text-[11px] font-mono-tech text-emerald-400">
                        ✓ Baupläne vorhanden
                      </span>
                    )}
                  </div>
                </div>

                {/* Assigned Crew Preview */}
                <div className="flex items-center justify-between text-xs px-1">
                  <span className="text-slate-400">
                    Eingeteilte Mannschaft ({activePlan.assignedCrewIds.length}):
                  </span>
                  <div className="flex items-center gap-1.5">
                    {activePlan.assignedCrewIds.map((cid) => (
                      <CharacterAvatar
                        key={cid}
                        portraitKey={crew[cid].portraitKey}
                        name={crew[cid].name}
                        accentColor={crew[cid].accentColor}
                        size="xs"
                        ring
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="space-y-2 pt-2 border-t border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setPhase('planning')}
                  className="w-full py-3 px-4 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm tracking-wide flex items-center justify-center gap-2 shadow-lg shadow-amber-500/20 transition-colors cursor-pointer"
                >
                  <DraftingCompass className="w-4 h-4" />
                  <span>Am Reißbrett planen</span>
                </button>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setPhase('scouting')}
                    className="py-2.5 px-3 rounded-xl bg-sky-500/20 hover:bg-sky-500/30 border border-sky-400/45 text-sky-100 font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Compass className="w-4 h-4" />
                    <span>3D Auskundschaften</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => launchHeist(activeTargetId)}
                    className="py-2.5 px-3 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-400/45 text-emerald-100 font-semibold text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Play className="w-4 h-4" />
                    <span>Bruch durchziehen</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ======================== TAB 2: MANNSCHAFT & WERKZEUG ======================== */}
        {tab === 'crew' && (
          <div className="h-full grid grid-cols-12 gap-4 min-h-0">
            {/* Crew Roster List */}
            <div className="col-span-8 flex flex-col gap-3 min-h-0 overflow-y-auto ns-scroll pr-1">
              <div className="flex items-center justify-between shrink-0">
                <div>
                  <h2 className="font-display font-bold text-base text-white">
                    Komplizen &amp; Rollenverteilung
                  </h2>
                  <p className="text-xs text-slate-400">
                    Wähle Komplizen für „{activeTarget.name}“ und achte auf Loyalität, Gier &amp; Nerven.
                  </p>
                </div>
                {vulnerableAccomplice && (
                  <div className="px-3 py-1.5 rounded-lg bg-rose-500/15 border border-rose-400/35 text-rose-200 text-[11px] font-mono-tech flex items-center gap-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                    <span>
                      Niedrigste Loyalität: {vulnerableAccomplice.name.split(' ')[0]} ({vulnerableAccomplice.traits.loyalty}%)
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                {(Object.keys(crew) as CrewId[]).map((cid) => {
                  const m = crew[cid];
                  const isAssigned = activePlan.assignedCrewIds.includes(cid);
                  const isGearSelected = selectedCrewForGear === cid;

                  return (
                    <div
                      key={cid}
                      onClick={() => m.recruited && setSelectedCrewForGear(cid)}
                      className={`noir-card rounded-xl p-4 space-y-3 border transition-all ${
                        isGearSelected
                          ? 'border-sky-400/70 ring-1 ring-sky-400/25'
                          : 'border-slate-800 hover:border-slate-700'
                      } ${m.recruited ? 'cursor-pointer' : ''}`}
                    >
                      <div className="flex items-start gap-3">
                        <CharacterAvatar
                          portraitKey={m.portraitKey}
                          name={m.name}
                          accentColor={m.accentColor}
                          size="lg"
                          ring={isAssigned}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <h3 className="font-display font-bold text-sm text-white truncate">
                              {m.name}
                            </h3>
                            <span className="font-mono-tech text-[11px] px-2 py-0.5 rounded bg-slate-800 text-amber-300 shrink-0">
                              {m.isPlayerControlled ? 'Anführerin' : `${m.cutPercent}% Anteil`}
                            </span>
                          </div>
                          <p className="text-[11px] text-sky-300 font-medium truncate">
                            „{m.codename}“ · {m.role}
                          </p>
                          <p className="text-[11px] text-slate-400 line-clamp-2 mt-1 leading-snug">
                            {m.bio}
                          </p>
                        </div>
                      </div>

                      {/* 5 Skills Bars */}
                      <div className="grid grid-cols-5 gap-1.5">
                        {SKILL_KEYS.map((sk) => (
                          <div key={sk} className="bg-slate-900/80 rounded-lg p-1.5 text-center">
                            <div className="text-[9px] text-slate-400 truncate">
                              {SKILL_LABELS[sk]}
                            </div>
                            <div className="font-mono-tech text-xs font-bold text-white">
                              {m.skills[sk]}
                            </div>
                            <div className="mt-1 h-1 rounded-full bg-slate-800 overflow-hidden">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${m.skills[sk] * 10}%`,
                                  backgroundColor: m.accentColor,
                                }}
                              />
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* Traits: Loyalty / Greed / Nerves */}
                      <div className="grid grid-cols-3 gap-2 text-[11px]">
                        <div className="space-y-0.5">
                          <div className="flex justify-between font-mono-tech text-[10px]">
                            <span className="text-slate-400">Loyalität</span>
                            <span className={m.traits.loyalty < 60 ? 'text-rose-400' : 'text-emerald-300'}>
                              {m.traits.loyalty}%
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className={`h-full ${m.traits.loyalty < 60 ? 'bg-rose-500' : 'bg-emerald-400'}`}
                              style={{ width: `${m.traits.loyalty}%` }}
                            />
                          </div>
                        </div>

                        <div className="space-y-0.5">
                          <div className="flex justify-between font-mono-tech text-[10px]">
                            <span className="text-slate-400">Gier</span>
                            <span className={m.traits.greed >= 70 ? 'text-amber-300' : 'text-slate-300'}>
                              {m.traits.greed}%
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className="h-full bg-amber-400"
                              style={{ width: `${m.traits.greed}%` }}
                            />
                          </div>
                        </div>

                        <div className="space-y-0.5">
                          <div className="flex justify-between font-mono-tech text-[10px]">
                            <span className="text-slate-400">Nerven</span>
                            <span className={m.traits.nerves <= 55 ? 'text-rose-300' : 'text-sky-300'}>
                              {m.traits.nerves}%
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                            <div
                              className="h-full bg-sky-400"
                              style={{ width: `${m.traits.nerves}%` }}
                            />
                          </div>
                        </div>
                      </div>

                      {/* Equipped Tools Pills & Actions */}
                      <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-800/80">
                        <div className="flex flex-wrap gap-1">
                          {m.equippedTools.map((tid) => (
                            <span
                              key={tid}
                              className="px-2 py-0.5 rounded bg-slate-800/90 border border-slate-700 text-[10px] text-sky-200 font-mono-tech"
                            >
                              {TOOLS[tid]?.name.split(' ')[0]}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center gap-1.5">
                          {!m.recruited ? (
                            <button
                              type="button"
                              disabled={bankrollEur < m.recruitCostEur}
                              onClick={(e) => {
                                e.stopPropagation();
                                recruitCrew(cid);
                              }}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs cursor-pointer disabled:cursor-not-allowed"
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                              <span>Anwerben ({formatEur(m.recruitCostEur)})</span>
                            </button>
                          ) : m.status === 'traitor' ? (
                            <span className="px-2.5 py-1 rounded bg-rose-500/20 border border-rose-400/50 text-rose-300 font-mono-tech text-[11px]">
                              VERRÄTER (LASSEN)
                            </span>
                          ) : (
                            <>
                              {m.loyaltyQuest && !m.loyaltyQuest.completed && (
                                <button
                                  type="button"
                                  disabled={bankrollEur < m.loyaltyQuest.costEur}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    completeLoyaltyQuest(cid);
                                  }}
                                  title={`${m.loyaltyQuest.title}: ${m.loyaltyQuest.description}`}
                                  className="px-2.5 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/30 disabled:opacity-40 border border-emerald-400/40 text-emerald-200 text-[11px] font-semibold cursor-pointer disabled:cursor-not-allowed"
                                >
                                  +{m.loyaltyQuest.loyaltyGain} Loyalität ({formatEur(m.loyaltyQuest.costEur)})
                                </button>
                              )}
                              {!m.isPlayerControlled && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleCrewOnPlan(cid);
                                  }}
                                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11px] font-semibold border transition-colors cursor-pointer ${
                                    isAssigned
                                      ? 'bg-sky-500/20 border-sky-400/60 text-sky-200'
                                      : 'bg-slate-800 border-slate-700 text-slate-300 hover:text-white'
                                  }`}
                                >
                                  <UserCheck className="w-3.5 h-3.5" />
                                  <span>{isAssigned ? 'Im Plan' : 'Zuteilen'}</span>
                                </button>
                              )}
                            </>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Tool Locker & Equipment Assignment */}
            <div className="col-span-4 noir-card rounded-2xl p-4 flex flex-col min-h-0">
              <div className="flex items-center justify-between pb-3 border-b border-slate-800 shrink-0">
                <div>
                  <h3 className="font-display font-bold text-sm text-white flex items-center gap-2">
                    <Wrench className="w-4 h-4 text-amber-400" />
                    <span>Werkzeugkiste</span>
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    Ausrüstung für{' '}
                    <span className="text-sky-300 font-semibold">
                      {crew[selectedCrewForGear]?.name}
                    </span>
                  </p>
                </div>
                <CharacterAvatar
                  portraitKey={crew[selectedCrewForGear].portraitKey}
                  name={crew[selectedCrewForGear].name}
                  accentColor={crew[selectedCrewForGear].accentColor}
                  size="sm"
                  ring
                />
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto ns-scroll space-y-2 py-3 pr-1">
                {(Object.keys(TOOLS) as ToolId[]).map((tid) => {
                  const tool = TOOLS[tid];
                  const owned = ownedTools.includes(tid);
                  const equipped = crew[selectedCrewForGear].equippedTools.includes(tid);

                  return (
                    <div
                      key={tid}
                      className={`p-3 rounded-xl border transition-colors ${
                        equipped
                          ? 'bg-sky-500/12 border-sky-400/50'
                          : 'bg-slate-900/75 border-slate-800'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-semibold text-xs text-white truncate">
                            {tool.name}
                          </div>
                          <p className="text-[11px] text-slate-400 leading-snug mt-0.5">
                            {tool.description}
                          </p>
                        </div>
                        {owned ? (
                          <button
                            type="button"
                            onClick={() =>
                              equipped
                                ? unequipTool(selectedCrewForGear, tid)
                                : equipTool(selectedCrewForGear, tid)
                            }
                            className={`shrink-0 px-2.5 py-1 rounded-lg text-[11px] font-semibold border cursor-pointer ${
                              equipped
                                ? 'bg-sky-400 text-slate-950 border-sky-300'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600'
                            }`}
                          >
                            {equipped ? 'Ausgerüstet' : 'Anlegen'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={bankrollEur < tool.costEur}
                            onClick={() => buyTool(tid)}
                            className="shrink-0 px-2.5 py-1 rounded-lg bg-amber-500/20 hover:bg-amber-500/35 disabled:opacity-40 border border-amber-400/50 text-amber-200 text-[11px] font-mono-tech cursor-pointer disabled:cursor-not-allowed"
                          >
                            {formatEur(tool.costEur)}
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-3 mt-1.5 font-mono-tech text-[10px] text-slate-400">
                        <span className="text-sky-300">
                          Tempo ×{tool.speedMultiplier}
                        </span>
                        <span className={tool.noiseDelta > 0 ? 'text-rose-300' : 'text-emerald-300'}>
                          Lärm {tool.noiseDelta >= 0 ? `+${tool.noiseDelta}` : tool.noiseDelta}
                        </span>
                        <span className={tool.traceDelta > 0 ? 'text-rose-300' : 'text-emerald-300'}>
                          Spur {tool.traceDelta >= 0 ? `+${tool.traceDelta}` : tool.traceDelta}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                type="button"
                onClick={() => setPhase('planning')}
                className="mt-2 shrink-0 w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 cursor-pointer"
              >
                <DraftingCompass className="w-4 h-4" />
                <span>Weiter zum Reißbrett</span>
              </button>
            </div>
          </div>
        )}

        {/* ======================== TAB 3: DIE AKTE „NACHTSCHICHT“ ======================== */}
        {tab === 'akte' && (
          <div className="h-full grid grid-cols-12 gap-4 min-h-0">
            {/* Left: Inspectora Ferrer Dossier & Collected Evidence */}
            <div className="col-span-7 noir-card rounded-2xl p-5 flex flex-col gap-4 min-h-0 border-rose-500/25">
              {/* Case Header */}
              <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-800 shrink-0">
                <div className="flex items-center gap-4">
                  <CharacterAvatar
                    portraitKey="portrait_ferrer"
                    name="Inspectora Núria Ferrer"
                    accentColor="#f43f5e"
                    size="xl"
                    ring
                  />
                  <div>
                    <div className="font-mono-tech text-[11px] uppercase tracking-widest text-rose-400">
                      MOSSOS D’ESQUADRA · {caseFile.caseNumber}
                    </div>
                    <h2 className="font-display text-2xl font-bold text-white">
                      Die Akte „Nachtschicht“
                    </h2>
                    <p className="text-xs text-slate-300 mt-0.5">
                      Leitung: <span className="font-semibold text-white">{caseFile.leadInvestigator}</span>
                    </p>
                  </div>
                </div>

                <div
                  className={`dossier-stamp px-3 py-1.5 rounded text-xs shrink-0 ${statusMeta.badgeBg}`}
                >
                  {statusMeta.label}
                </div>
              </div>

              {/* Heat Meter & Ferrer Note */}
              <div className="p-4 rounded-xl bg-slate-950/80 border border-slate-800 space-y-2.5 shrink-0">
                <div className="flex items-center justify-between">
                  <span className="font-mono-tech text-xs uppercase tracking-wider text-slate-300 flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 text-rose-400" />
                    Ermittlungsdruck (Aktenstand)
                  </span>
                  <span className={`font-mono-tech text-lg font-bold ${statusMeta.colorClass}`}>
                    {caseFile.heat} / 100
                  </span>
                </div>
                <div className="h-3 rounded-full bg-slate-900 overflow-hidden border border-slate-800">
                  <div
                    className={`h-full transition-all duration-500 ${
                      caseFile.heat >= 80
                        ? 'bg-gradient-to-r from-rose-600 to-red-400'
                        : caseFile.heat >= 50
                          ? 'bg-gradient-to-r from-amber-500 to-rose-500'
                          : 'bg-gradient-to-r from-emerald-500 via-sky-400 to-amber-400'
                    }`}
                    style={{ width: `${caseFile.heat}%` }}
                  />
                </div>
                <p className="text-xs text-slate-300 italic leading-relaxed">
                  „{caseFile.lastFerrerNote}“
                </p>
              </div>

              {/* Evidence List */}
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="flex items-center justify-between mb-2 shrink-0">
                  <h3 className="font-mono-tech text-xs uppercase tracking-wider text-slate-400">
                    Gesammelte Spuren ({openEvidenceCount} aktiv / {caseFile.evidence.length} gesamt)
                  </h3>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto ns-scroll space-y-2 pr-1">
                  {caseFile.evidence.map((ev) => (
                    <div
                      key={ev.id}
                      className={`p-3 rounded-xl border flex items-start justify-between gap-3 ${
                        ev.mitigated
                          ? 'bg-slate-900/40 border-slate-800/70 opacity-60'
                          : 'bg-slate-900/90 border-rose-500/25'
                      }`}
                    >
                      <div className="flex items-start gap-2.5 min-w-0">
                        <Fingerprint
                          className={`w-4 h-4 mt-0.5 shrink-0 ${
                            ev.mitigated ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`text-xs font-semibold ${
                                ev.mitigated ? 'line-through text-slate-400' : 'text-white'
                              }`}
                            >
                              {ev.title}
                            </span>
                            <span className="font-mono-tech text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                              {EVIDENCE_TYPE_LABELS[ev.type]}
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                            {ev.detail}
                          </p>
                          {ev.mitigated && ev.mitigationLabel && (
                            <p className="text-[10px] font-mono-tech text-emerald-400 mt-1">
                              ✓ Entschärft durch: {ev.mitigationLabel}
                            </p>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0">
                        <span
                          className={`font-mono-tech text-xs font-bold px-2 py-0.5 rounded ${
                            ev.mitigated
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : 'bg-rose-500/20 text-rose-300'
                          }`}
                        >
                          +{ev.mitigated ? Math.round(ev.severity * 0.2) : ev.severity}
                        </span>
                        <div className="font-mono-tech text-[10px] text-slate-500 mt-1">
                          Tag {ev.collectedOnDay}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Playable Countermeasures */}
            <div className="col-span-5 noir-card rounded-2xl p-5 flex flex-col min-h-0">
              <div className="pb-3 border-b border-slate-800 shrink-0">
                <h3 className="font-display font-bold text-base text-white">
                  Gegenmaßnahmen (Spuren kühlen)
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Akute Verfolgung klingt ab — die Akte nicht. Nur gezielte Maßnahmen drücken Ferrers Ermittlungen.
                </p>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto ns-scroll space-y-2.5 py-3 pr-1">
                {COUNTERMEASURES.map((cm) => {
                  const effectiveCost =
                    cm.id === 'repaint_car' && hasSprayBooth
                      ? Math.round(cm.costEur * 0.4)
                      : cm.costEur;
                  const matchingOpen = caseFile.evidence.filter(
                    (e) => !e.mitigated && cm.mitigatesTypes.includes(e.type)
                  ).length;
                  const canAfford = bankrollEur >= effectiveCost;

                  return (
                    <div
                      key={cm.id}
                      className="p-3.5 rounded-xl bg-slate-900/85 border border-slate-800 hover:border-amber-400/35 transition-colors space-y-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="font-semibold text-xs text-white">
                            {cm.name}
                          </div>
                          <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                            {cm.description}
                          </p>
                        </div>
                        <span className="shrink-0 font-mono-tech text-xs text-emerald-300 bg-emerald-500/15 border border-emerald-400/30 px-2 py-0.5 rounded">
                          -{cm.heatReduction} Hitze
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 pt-1">
                        <div className="flex items-center gap-2 font-mono-tech text-[10px] text-slate-400">
                          <span>Dauer: +{cm.daysCost} Tag(e)</span>
                          {matchingOpen > 0 && (
                            <span className="text-amber-300">
                              · tilgt {matchingOpen} Spur(en)
                            </span>
                          )}
                        </div>
                        <button
                          type="button"
                          disabled={!canAfford || caseFile.heat === 0}
                          onClick={() => applyCountermeasure(cm.id)}
                          className="px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs cursor-pointer disabled:cursor-not-allowed"
                        >
                          Ausführen ({formatEur(effectiveCost)})
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ======================== TAB 4: HEHLER & WERKSTATT ======================== */}
        {tab === 'economy' && (
          <div className="h-full grid grid-cols-12 gap-4 min-h-0">
            {/* Left: 3 Fences */}
            <div className="col-span-6 noir-card rounded-2xl p-5 flex flex-col min-h-0">
              <div className="pb-3 border-b border-slate-800 shrink-0">
                <h2 className="font-display font-bold text-base text-white">
                  Hehler-Kontakte (Abnehmer für „{activeTarget.name}“)
                </h2>
                <p className="text-xs text-slate-400">
                  Jeder Hehler zahlt Spitzenkurse für seine bevorzugten Warengruppen — erzeugt aber unterschiedlich viel Hitze.
                </p>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto ns-scroll space-y-3 py-3 pr-1">
                {(Object.keys(FENCES) as FenceId[]).map((fid) => {
                  const fence = FENCES[fid];
                  const selected = activePlan.selectedFenceId === fid;
                  const locked =
                    (fence.minCompletedHeists ?? 0) > completedTargetIds.length;

                  return (
                    <div
                      key={fid}
                      onClick={() => !locked && setPlanFence(fid)}
                      className={`p-4 rounded-xl border transition-all ${
                        locked
                          ? 'bg-slate-950/60 border-slate-800 opacity-55 cursor-not-allowed'
                          : selected
                            ? 'bg-amber-500/12 border-amber-400/75 cursor-pointer'
                            : 'bg-slate-900/80 border-slate-800 hover:border-slate-600 cursor-pointer'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2">
                            <h3 className="font-display font-bold text-sm text-white">
                              {fence.name}
                            </h3>
                            {selected && (
                              <span className="font-mono-tech text-[10px] px-2 py-0.5 rounded bg-amber-500 text-slate-950 font-bold">
                                AKTIV
                              </span>
                            )}
                            {locked && (
                              <span className="font-mono-tech text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-400">
                                Ab {fence.minCompletedHeists} Coup
                              </span>
                            )}
                          </div>
                          <p className="font-mono-tech text-[11px] text-sky-300 mt-0.5">
                            {fence.location}
                          </p>
                        </div>
                        <div className="text-right font-mono-tech">
                          <div className="text-sm font-bold text-emerald-300">
                            {Math.round(fence.preferredRate * 100)}% Kurs
                          </div>
                          <div className="text-[10px] text-slate-400">
                            Basis {Math.round(fence.baseRate * 100)}% · +{fence.heatGenerated} Akte
                          </div>
                        </div>
                      </div>

                      <p className="text-xs text-slate-300 mt-2 leading-snug">
                        {fence.description}
                      </p>

                      <div className="flex flex-wrap gap-1.5 mt-2.5">
                        {fence.preferredCategories.map((cat) => (
                          <span
                            key={cat}
                            className="px-2 py-0.5 rounded bg-slate-800 border border-amber-400/30 text-[10px] font-mono-tech text-amber-200"
                          >
                            ★ {LOOT_CATEGORY_LABELS[cat]}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: Workshop Upgrades */}
            <div className="col-span-6 noir-card rounded-2xl p-5 flex flex-col min-h-0">
              <div className="pb-3 border-b border-slate-800 shrink-0">
                <h2 className="font-display font-bold text-base text-white">
                  Werkstatt-Ausbau (La Pineda)
                </h2>
                <p className="text-xs text-slate-400">
                  Dauerhafte Verbesserungen für Aufklärung, Reißbrett, Lackierung und Mannschaftsfunk.
                </p>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto ns-scroll space-y-3 py-3 pr-1">
                {workshopUpgrades.map((upg) => (
                  <div
                    key={upg.id}
                    className={`p-4 rounded-xl border ${
                      upg.purchased
                        ? 'bg-emerald-500/10 border-emerald-400/40'
                        : 'bg-slate-900/80 border-slate-800'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="font-display font-bold text-sm text-white">
                          {upg.name}
                        </h3>
                        <p className="text-xs text-slate-300 mt-1 leading-snug">
                          {upg.description}
                        </p>
                        <div className="inline-block mt-2 px-2 py-0.5 rounded bg-sky-500/15 border border-sky-400/30 font-mono-tech text-[11px] text-sky-200">
                          {upg.effectSummary}
                        </div>
                      </div>

                      {upg.purchased ? (
                        <span className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 font-mono-tech text-xs">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          Installiert
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={bankrollEur < upg.costEur}
                          onClick={() => buyWorkshopUpgrade(upg.id)}
                          className="shrink-0 px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs cursor-pointer disabled:cursor-not-allowed"
                        >
                          {formatEur(upg.costEur)}
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              <div className="pt-2 border-t border-slate-800 shrink-0 flex justify-end">
                <button
                  type="button"
                  onClick={() => setPhase('planning')}
                  className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-xs uppercase tracking-wider cursor-pointer"
                >
                  <DraftingCompass className="w-4 h-4" />
                  <span>Zum Reißbrett ({activeTarget.name})</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
