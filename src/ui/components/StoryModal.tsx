import { useEffect, useState } from 'react';
import { BookOpen, ChevronRight, X } from 'lucide-react';
import { useGameStore } from '../../state/store';
import { getImageUrl, useAssetManifest } from '../assets';

export function StoryModal() {
  const activeStoryBeatId = useGameStore((s) => s.activeStoryBeatId);
  const storyBeats = useGameStore((s) => s.storyBeats);
  const dismissStoryBeat = useGameStore((s) => s.dismissStoryBeat);
  const { images } = useAssetManifest();
  const [imgError, setImgError] = useState(false);

  const beat = activeStoryBeatId
    ? storyBeats.find((b) => b.id === activeStoryBeatId) ?? null
    : null;

  useEffect(() => {
    setImgError(false);
  }, [activeStoryBeatId]);

  useEffect(() => {
    if (!beat) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') {
        dismissStoryBeat();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [beat, dismissStoryBeat]);

  if (!beat) return null;

  const imageUrl = getImageUrl(beat.imageKey, images);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 backdrop-blur-md p-6"
      role="dialog"
      aria-modal="true"
      aria-label={beat.title}
    >
      <div className="noir-card relative w-full max-w-3xl max-h-[88vh] rounded-2xl overflow-hidden flex flex-col border border-amber-400/30 shadow-2xl">
        {/* Hero Art Frame with subtle Ken-Burns motion */}
        <div className="relative h-64 sm:h-72 w-full overflow-hidden bg-slate-900 shrink-0">
          {!imgError ? (
            <img
              src={imageUrl}
              alt={beat.title}
              onError={() => setImgError(true)}
              className="w-full h-full object-cover animate-ken-burns"
            />
          ) : (
            <div className="w-full h-full blueprint-surface flex items-center justify-center text-slate-500 font-mono-tech text-xs">
              [DOSSIER-PANEL: {beat.imageKey}]
            </div>
          )}
          <div className="absolute inset-0 bg-gradient-to-t from-[#080e1c] via-[#080e1c]/45 to-transparent" />
          <div className="absolute inset-0 bg-gradient-to-r from-[#080e1c]/70 via-transparent to-transparent" />

          {/* Top Bar Badges */}
          <div className="absolute top-4 left-5 right-5 flex items-center justify-between">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-400/50 text-amber-200 text-xs font-mono-tech uppercase tracking-widest">
              <BookOpen className="w-3.5 h-3.5" />
              <span>Akt {beat.act} · Einsatzbericht</span>
            </div>
            <button
              type="button"
              onClick={dismissStoryBeat}
              className="p-1.5 rounded-lg bg-slate-950/70 hover:bg-slate-800 border border-slate-700/60 text-slate-300 hover:text-white transition-colors cursor-pointer"
              aria-label="Schließen"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Title overlaid on lower gradient */}
          <div className="absolute bottom-4 left-6 right-6">
            <p className="text-xs font-mono-tech uppercase tracking-widest text-sky-300/90 mb-1">
              {beat.subtitle}
            </p>
            <h2 className="font-display text-2xl sm:text-3xl font-bold text-white tracking-tight">
              {beat.title}
            </h2>
          </div>
        </div>

        {/* Narrative Body */}
        <div className="p-6 overflow-y-auto ns-scroll space-y-3.5 bg-[#080e1c]">
          <div className="inline-flex items-center gap-2 text-xs font-mono-tech uppercase tracking-wider text-amber-300/90 border-b border-amber-400/25 pb-1">
            <span>Sprecher:</span>
            <span className="text-white font-semibold">{beat.speaker}</span>
          </div>
          {beat.paragraphs.map((p, idx) => (
            <p
              key={idx}
              className="text-sm sm:text-[15px] leading-relaxed text-slate-200/95"
            >
              {p}
            </p>
          ))}
        </div>

        {/* Footer CTA */}
        <div className="px-6 py-4 bg-slate-950/80 border-t border-slate-800/80 flex items-center justify-between shrink-0">
          <span className="text-xs font-mono-tech text-slate-400">
            ESC / ENTER zum Fortfahren
          </span>
          <button
            type="button"
            onClick={dismissStoryBeat}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm tracking-wide transition-colors cursor-pointer shadow-lg shadow-amber-500/20"
          >
            <span>Weiter ins Versteck</span>
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
