import {
  AlertTriangle,
  Award,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Fingerprint,
  ShieldAlert,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import { useGameStore } from '../../state/store';
import { EndingChoice } from '../../sim/types';
import { EVIDENCE_TYPE_LABELS, formatEur, formatTimeSec } from '../assets';
import { CharacterAvatar } from '../components/CharacterAvatar';

const ENDINGS: Array<{
  id: EndingChoice;
  title: string;
  subtitle: string;
  description: string;
  accent: string;
}> = [
  {
    id: 'vanish_with_loot',
    title: 'Mit der Beute verschwinden',
    subtitle: 'Ende I · Schatten über dem Mittelmeer',
    description:
      'Ihr verkauft die Juwelen über diskrete Kanäle, lasst Salou und Dresden hinter euch und verschwindet für immer von Inspectora Ferrers Radar.',
    accent: 'border-amber-400/60 bg-amber-500/12',
  },
  {
    id: 'expose_lassen_free_jupp',
    title: 'Ferrer die Beweise zuspielen & Jupp freibekommen',
    subtitle: 'Ende II · Die Akte „Securion“',
    description:
      'Mara übermittelt Henrik Lassens komplette Wartungs- und Versicherungsakten anonym an Inspectora Núria Ferrer. Lassen fällt — und Jupp Kowalke verlässt die Untersuchungshaft als freier Mann.',
    accent: 'border-sky-400/60 bg-sky-500/12',
  },
  {
    id: 'take_over_ring',
    title: 'Henrik Lassens Ring übernehmen',
    subtitle: 'Ende III · Neue Ordnung der Nachtschicht',
    description:
      'Mit den Zugangsdaten der Securion-Zentrale und dem Zollfreilager in Tarragona übernimmt Maras Mannschaft die Kontrolle über die gesamte Küste.',
    accent: 'border-rose-400/60 bg-rose-500/12',
  },
];

export function DebriefScreen() {
  const debrief = useGameStore((s) => s.lastDebrief);
  const crew = useGameStore((s) => s.crew);
  const bankrollEur = useGameStore((s) => s.bankrollEur);
  const selectedEnding = useGameStore((s) => s.selectedEnding);
  const returnToSafehouse = useGameStore((s) => s.returnToSafehouse);
  const openStoryBeat = useGameStore((s) => s.openStoryBeat);
  const chooseEnding = useGameStore((s) => s.chooseEnding);

  if (!debrief) {
    return (
      <div className="w-screen h-screen flex items-center justify-center bg-slate-950 text-slate-200">
        <button
          type="button"
          onClick={returnToSafehouse}
          className="px-5 py-2.5 rounded-xl bg-amber-500 text-slate-950 font-bold cursor-pointer"
        >
          Zurück ins Versteck
        </button>
      </div>
    );
  }

  const traitorMember = debrief.traitorRevealedId
    ? crew[debrief.traitorRevealedId]
    : null;
  const heatDelta = debrief.heatAfter - debrief.heatBefore;

  const handleContinue = (withStoryBeat: boolean) => {
    const beatId = debrief.storyBeatUnlockedId;
    returnToSafehouse();
    if (withStoryBeat && beatId) {
      openStoryBeat(beatId);
    }
  };

  return (
    <div className="w-screen h-screen overflow-hidden flex flex-col bg-[#060b16] text-slate-100 blueprint-surface p-5 lg:p-6">
      <div className="max-w-6xl w-full mx-auto flex-1 min-h-0 flex flex-col gap-4">
        {/* Top Outcome Banner */}
        <header className="noir-card rounded-2xl px-6 py-4 flex items-center justify-between gap-4 shrink-0">
          <div>
            <div className="font-mono-tech text-xs uppercase tracking-widest text-sky-300">
              Einsatzbericht · {debrief.targetName}
            </div>
            <h1 className="font-display text-2xl lg:text-3xl font-bold text-white mt-0.5">
              {debrief.success
                ? debrief.cleanGhostBonus
                  ? 'Sauberer Geisterbruch!'
                  : 'Coup erfolgreich durchgezogen'
                : 'Coup abgebrochen / gescheitert'}
            </h1>
            <div className="flex flex-wrap items-center gap-4 mt-1 font-mono-tech text-xs text-slate-400">
              <span>Einsatzzeit: {formatTimeSec(debrief.elapsedSec)}</span>
              <span>Abweichungen: {debrief.deviationsCount}</span>
              <span>Neuer Kontostand: {formatEur(bankrollEur)}</span>
            </div>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            {debrief.cleanGhostBonus && (
              <div className="px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-400/50 text-emerald-300 font-mono-tech text-xs flex items-center gap-1.5">
                <Award className="w-4 h-4" />
                <span>+12% Geister-Bonus</span>
              </div>
            )}
            <div
              className={`dossier-stamp px-4 py-1.5 rounded text-sm ${
                debrief.success
                  ? 'text-emerald-300 border-emerald-400 bg-emerald-500/10'
                  : 'text-rose-300 border-rose-400 bg-rose-500/10'
              }`}
            >
              {debrief.success ? 'ABGERÄUMT' : 'GEPLATZT'}
            </div>
          </div>
        </header>

        {/* Main Split Dossier Body */}
        <div className="flex-1 min-h-0 grid grid-cols-12 gap-4">
          {/* Left Column: Hehler & Crew Cuts */}
          <div className="col-span-7 noir-card rounded-2xl p-5 flex flex-col gap-4 min-h-0 overflow-y-auto ns-scroll">
            <div>
              <h2 className="font-display font-bold text-base text-white flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-amber-400" />
                <span>Hehler-Abrechnung ({debrief.fenceName})</span>
              </h2>
              <div className="grid grid-cols-3 gap-3 mt-3">
                <div className="p-3 rounded-xl bg-slate-900/85 border border-slate-800">
                  <div className="font-mono-tech text-[10px] uppercase text-slate-400">
                    Brutto-Beute
                  </div>
                  <div className="font-mono-tech text-lg font-bold text-slate-200 mt-0.5">
                    {formatEur(debrief.grossLootEur)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-slate-900/85 border border-slate-800">
                  <div className="font-mono-tech text-[10px] uppercase text-slate-400">
                    Hehler-Auszahlung
                  </div>
                  <div className="font-mono-tech text-lg font-bold text-sky-300 mt-0.5">
                    {formatEur(debrief.fencePayoutEur)}
                  </div>
                </div>
                <div className="p-3 rounded-xl bg-amber-500/15 border border-amber-400/50">
                  <div className="font-mono-tech text-[10px] uppercase text-amber-300">
                    Maras Netto-Gewinn
                  </div>
                  <div className="font-mono-tech text-xl font-bold text-amber-300 mt-0.5">
                    +{formatEur(debrief.maraNetEur)}
                  </div>
                </div>
              </div>
            </div>

            {/* Crew Payouts & Loyalty */}
            <div className="space-y-2">
              <h3 className="font-mono-tech text-xs uppercase tracking-wider text-slate-400">
                Komplizen-Anteile, Erfahrung &amp; Loyalität
              </h3>
              {debrief.crewCuts.length === 0 ? (
                <p className="text-xs text-slate-400 italic">
                  Solo-Einsatz — keine Anteile ausgezahlt.
                </p>
              ) : (
                <div className="space-y-2">
                  {debrief.crewCuts.map((entry) => {
                    const member = crew[entry.crewId];
                    return (
                      <div
                        key={entry.crewId}
                        className="p-3 rounded-xl bg-slate-900/80 border border-slate-800 flex items-center justify-between gap-3"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <CharacterAvatar
                            portraitKey={member.portraitKey}
                            name={member.name}
                            accentColor={member.accentColor}
                            size="sm"
                            ring
                          />
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-white truncate">
                              {entry.name}
                            </div>
                            <div className="font-mono-tech text-[10px] text-slate-400">
                              Anteil {entry.cutPercent}% · +{entry.xpGain} XP (Stufe {member.level})
                            </div>
                          </div>
                        </div>

                        <div className="flex items-center gap-3 shrink-0 font-mono-tech text-xs">
                          <span
                            className={`px-2 py-0.5 rounded ${
                              entry.loyaltyDelta >= 0
                                ? 'bg-emerald-500/15 text-emerald-300'
                                : 'bg-rose-500/20 text-rose-300'
                            }`}
                          >
                            Loyalität {entry.loyaltyDelta >= 0 ? `+${entry.loyaltyDelta}` : entry.loyaltyDelta}
                          </span>
                          <span className="font-bold text-amber-300 w-20 text-right">
                            {formatEur(entry.amountEur)}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Act 3 Traitor Reveal Alert */}
            {traitorMember && (
              <div className="p-4 rounded-xl bg-rose-500/15 border border-rose-400/50 flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-display font-bold text-sm text-rose-200">
                    Verrat in der Mannschaft — {traitorMember.name} wurde von Henrik Lassen gekauft!
                  </div>
                  <p className="text-xs text-rose-100/85 mt-1 leading-relaxed">
                    Als Komplize mit der niedrigsten Loyalität gab {traitorMember.name} euren
                    Zugriff am Hafen von Tarragona preis. Jupp deckte den Rückzug — jetzt bleibt
                    nur noch der Gegenschlag in Dresden.
                  </p>
                </div>
              </div>
            )}

            {/* Dresden Finale 3-Ending Choice */}
            {debrief.finaleEndingAvailable && (
              <div className="space-y-2.5 pt-2 border-t border-amber-400/30">
                <div className="flex items-center gap-2 text-amber-300 font-display font-bold text-sm">
                  <Sparkles className="w-4 h-4" />
                  <span>Finale Entscheidung im Dresdner Gewölbe</span>
                </div>
                <div className="grid grid-cols-1 gap-2">
                  {ENDINGS.map((end) => {
                    const picked = selectedEnding === end.id;
                    return (
                      <button
                        key={end.id}
                        type="button"
                        onClick={() => chooseEnding(end.id)}
                        className={`text-left p-3 rounded-xl border transition-all cursor-pointer ${
                          picked
                            ? `${end.accent} ring-1 ring-white/30`
                            : 'bg-slate-900/75 border-slate-800 hover:border-slate-600'
                        }`}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-display font-bold text-xs text-white">
                            {end.title}
                          </span>
                          <span className="font-mono-tech text-[10px] text-slate-300">
                            {picked ? '✓ GEWÄHLT' : end.subtitle}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-300 mt-1 leading-snug">
                          {end.description}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Right Column: Die Akte Update */}
          <div className="col-span-5 noir-card rounded-2xl p-5 flex flex-col gap-3 min-h-0 border-rose-500/25">
            <div className="flex items-center justify-between gap-3 pb-3 border-b border-slate-800 shrink-0">
              <div className="flex items-center gap-3">
                <CharacterAvatar
                  portraitKey="portrait_ferrer"
                  name="Inspectora Núria Ferrer"
                  accentColor="#f43f5e"
                  size="md"
                  ring
                />
                <div>
                  <div className="font-mono-tech text-[10px] uppercase text-rose-400">
                    Die Akte „Nachtschicht“
                  </div>
                  <h2 className="font-display font-bold text-base text-white">
                    Spurenlage nach dem Einsatz
                  </h2>
                </div>
              </div>
              <div className="text-right font-mono-tech">
                <div className="text-xs text-slate-400">Aktenstand</div>
                <div className="text-base font-bold text-rose-300">
                  {debrief.heatBefore} → {debrief.heatAfter}{' '}
                  <span className="text-xs">
                    ({heatDelta >= 0 ? `+${heatDelta}` : heatDelta})
                  </span>
                </div>
              </div>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto ns-scroll space-y-2 pr-1">
              {debrief.newEvidence.length === 0 ? (
                <div className="p-4 rounded-xl bg-emerald-500/10 border border-emerald-400/35 flex items-start gap-2.5 text-emerald-200 text-xs">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    Keine neuen Spuren gesichert! Inspectora Ferrer tappt völlig im Dunkeln.
                  </span>
                </div>
              ) : (
                debrief.newEvidence.map((ev) => (
                  <div
                    key={ev.id}
                    className="p-3 rounded-xl bg-slate-900/90 border border-rose-500/30 flex items-start justify-between gap-2.5"
                  >
                    <div className="flex items-start gap-2 min-w-0">
                      <Fingerprint className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-white">{ev.title}</div>
                        <div className="font-mono-tech text-[10px] text-rose-300">
                          {EVIDENCE_TYPE_LABELS[ev.type]}
                        </div>
                        <p className="text-[11px] text-slate-400 mt-0.5 leading-snug">
                          {ev.detail}
                        </p>
                      </div>
                    </div>
                    <span className="font-mono-tech text-xs font-bold text-rose-300 bg-rose-500/15 px-2 py-0.5 rounded shrink-0">
                      +{ev.severity}
                    </span>
                  </div>
                ))
              )}
            </div>

            <div className="pt-2 border-t border-slate-800 flex items-center gap-2 text-[11px] text-slate-400 shrink-0">
              <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                Tipp: Im Versteck unter „Die Akte“ kannst du Spuren mit Gegenmaßnahmen kühlen.
              </span>
            </div>
          </div>
        </div>

        {/* Footer CTA */}
        <footer className="flex items-center justify-end gap-3 shrink-0">
          {debrief.storyBeatUnlockedId && (
            <button
              type="button"
              onClick={() => handleContinue(true)}
              className="inline-flex items-center gap-2 px-5 py-3 rounded-xl bg-sky-500 hover:bg-sky-400 text-slate-950 font-display font-bold text-sm cursor-pointer shadow-lg shadow-sky-500/20"
            >
              <BookOpen className="w-4 h-4" />
              <span>Neues Story-Kapitel öffnen</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => handleContinue(false)}
            className="inline-flex items-center gap-2 px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm cursor-pointer shadow-lg shadow-amber-500/20"
          >
            <span>Weiter ins Versteck „La Pineda“</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </footer>
      </div>
    </div>
  );
}
