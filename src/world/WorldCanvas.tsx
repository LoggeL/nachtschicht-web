import { useEffect, useRef, useState } from 'react';
import { FLOOR_LABELS, FloorId } from '../sim/types';
import { SceneManager, WorldOverlayFeedback } from './sceneManager';

// ============================================================================
// NACHTSCHICHT — React 3D WebGL Canvas Mount Component
// Exported as both named `WorldCanvas` and default export with zero required
// props so `@ui` can mount `<WorldCanvas />` seamlessly beneath HUD overlays.
// ============================================================================

export interface WorldCanvasProps {
  className?: string;
}

const INITIAL_FEEDBACK: WorldOverlayFeedback = {
  promptText: null,
  promptSubtext: null,
  promptProgress: 0,
  binocularsActive: false,
  webglError: null,
  activeFloor: 0,
  availableFloors: [0],
  showFloorSwitcher: false,
};

export function WorldCanvas({ className }: WorldCanvasProps = {}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const managerRef = useRef<SceneManager | null>(null);
  const [feedback, setFeedback] = useState<WorldOverlayFeedback>(INITIAL_FEEDBACK);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const manager = new SceneManager(el, (nextFb) => {
      setFeedback(nextFb);
    });
    managerRef.current = manager;

    return () => {
      manager.dispose();
      if (managerRef.current === manager) {
        managerRef.current = null;
      }
    };
  }, []);

  const handleFloorStep = (delta: number) => {
    managerRef.current?.switchFloor(delta);
  };

  return (
    <div
      className={`relative w-full h-full overflow-hidden select-none bg-[#070d1d] ${className ?? ''}`}
    >
      {/* Three.js WebGL Mount Target */}
      <div ref={containerRef} className="w-full h-full cursor-grab active:cursor-grabbing" />

      {/* Binocular Night-Optics Lens Overlay (Scouting Mode only, pointer-events-none) */}
      {feedback.binocularsActive && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center"
          style={{
            background:
              'radial-gradient(circle at center, transparent 34%, rgba(4, 12, 24, 0.72) 68%, rgba(2, 6, 15, 0.94) 100%)',
          }}
        >
          <div className="relative w-72 h-72 rounded-full border border-cyan-400/50 shadow-[0_0_40px_rgba(56,189,248,0.22)]">
            <div className="absolute left-1/2 top-0 bottom-0 w-px -translate-x-1/2 bg-cyan-400/25" />
            <div className="absolute top-1/2 left-0 right-0 h-px -translate-y-1/2 bg-cyan-400/25" />
            <div className="absolute left-1/2 top-1/2 w-5 h-5 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-300/80" />
            <div className="absolute -bottom-8 left-1/2 -translate-x-1/2 whitespace-nowrap font-mono text-[11px] tracking-widest uppercase text-cyan-300/90 bg-slate-950/75 px-2.5 py-0.5 rounded border border-cyan-500/30">
              OPTIK 2.5× · [E] SCANNEN · [F] BEENDEN
            </div>
          </div>
        </div>
      )}

      {/* Subtle Multi-Floor Indicator / Switcher when target has multiple floors */}
      {feedback.showFloorSwitcher && !feedback.webglError && (
        <div className="pointer-events-auto absolute right-4 top-1/2 -translate-y-1/2 flex flex-col items-center gap-1 bg-slate-950/80 backdrop-blur-sm border border-slate-700/70 rounded-lg px-2 py-1.5 text-xs text-slate-200 shadow-lg">
          <button
            type="button"
            onClick={() => handleFloorStep(1)}
            className="px-1.5 py-0.5 rounded hover:bg-slate-800 text-amber-300 font-mono"
            title="Etage hoch (])"
          >
            ▲
          </button>
          <span className="font-mono text-[11px] font-semibold text-cyan-300">
            {FLOOR_LABELS[feedback.activeFloor as FloorId] ?? 'EG'}
          </span>
          <button
            type="button"
            onClick={() => handleFloorStep(-1)}
            className="px-1.5 py-0.5 rounded hover:bg-slate-800 text-amber-300 font-mono"
            title="Etage runter ([)"
          >
            ▼
          </button>
        </div>
      )}

      {/* Contextual 3D Interaction / Scan Progress Prompt */}
      {feedback.promptText && !feedback.webglError && (
        <div className="pointer-events-none absolute bottom-36 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-950/85 backdrop-blur-md border border-cyan-400/50 shadow-xl">
          <div className="text-sm font-semibold tracking-wide text-slate-100">
            {feedback.promptText}
          </div>
          {feedback.promptProgress > 0.01 && (
            <div className="w-52 h-1.5 rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-cyan-400 to-amber-400 transition-[width] duration-75"
                style={{ width: `${Math.round(feedback.promptProgress * 100)}%` }}
              />
            </div>
          )}
          {feedback.promptSubtext && (
            <div className="text-[11px] font-mono text-cyan-300/90">
              {feedback.promptSubtext}
            </div>
          )}
        </div>
      )}

      {/* Graceful WebGL Fallback Notice */}
      {feedback.webglError && (
        <div className="absolute inset-0 flex items-center justify-center bg-slate-950/95 p-6">
          <div className="max-w-md rounded-xl border border-amber-500/40 bg-slate-900/90 p-5 text-center shadow-2xl">
            <div className="text-amber-400 font-mono text-xs uppercase tracking-widest mb-2">
              3D-Ansicht Fallback
            </div>
            <p className="text-sm text-slate-200 mb-2">{feedback.webglError}</p>
            <p className="text-xs text-slate-400">
              Alle Planungs-, Reißbrett- und Simulationsfunktionen bleiben vollständig bedienbar.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

export default WorldCanvas;
