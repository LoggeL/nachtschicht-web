import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  KeyRound,
  Lock,
  Scissors,
  Sparkles,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import { useGameStore } from '../../state/store';

// Lightweight WebAudio acoustic cues for tactile lockpick/safe/circuit feedback
function playTactileTone(
  kind: 'click' | 'hit' | 'slip' | 'wire_ok' | 'wire_bad',
  muted: boolean
) {
  if (muted || typeof window === 'undefined') return;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;
    if (kind === 'click') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(1450, now);
      osc.frequency.exponentialRampToValueAtTime(620, now + 0.03);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.035);
      osc.start(now);
      osc.stop(now + 0.04);
    } else if (kind === 'hit' || kind === 'wire_ok') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(kind === 'hit' ? 760 : 520, now);
      osc.frequency.exponentialRampToValueAtTime(kind === 'hit' ? 1140 : 880, now + 0.09);
      gain.gain.setValueAtTime(0.11, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.14);
      osc.start(now);
      osc.stop(now + 0.15);
    } else {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.exponentialRampToValueAtTime(95, now + 0.16);
      gain.gain.setValueAtTime(0.14, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.21);
    }
    setTimeout(() => void ctx.close(), 300);
  } catch {
    // Ignore audio context blocks
  }
}

export function HeistMinigames() {
  const activeMinigame = useGameStore((s) => s.liveState?.activeMinigame ?? null);
  const audioMuted = useGameStore((s) => s.audioMuted);
  const attemptMinigameLockpick = useGameStore((s) => s.attemptMinigameLockpick);
  const attemptMinigameCircuitWire = useGameStore((s) => s.attemptMinigameCircuitWire);
  const autoCompleteActiveMinigame = useGameStore((s) => s.autoCompleteActiveMinigame);
  const cancelMinigame = useGameStore((s) => s.cancelMinigame);

  const [cursorVal, setCursorVal] = useState(50);
  const [feedback, setFeedback] = useState<{
    tone: 'ok' | 'warn' | 'err';
    text: string;
  } | null>(null);

  const cursorRef = useRef(50);
  const dirRef = useRef(1);
  const lastSweetClickRef = useRef(false);

  // Smooth tension/dial oscillation for lockpick & safe_dial
  useEffect(() => {
    if (!activeMinigame || activeMinigame.kind === 'securion_circuit') return;
    cursorRef.current = 18;
    dirRef.current = 1;
    lastSweetClickRef.current = false;
    setCursorVal(18);
    setFeedback(null);

    let rafId = 0;
    let lastTs = performance.now();
    // Difficulty gently adjusts sweep cadence while remaining fair & responsive
    const speedPerSec =
      activeMinigame.kind === 'safe_dial'
        ? 44 + activeMinigame.difficulty * 3.5
        : 52 + activeMinigame.difficulty * 4.2;

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - lastTs) / 1000);
      lastTs = now;
      let next = cursorRef.current + dirRef.current * speedPerSec * dt;
      if (next >= 96) {
        next = 96;
        dirRef.current = -1;
      } else if (next <= 4) {
        next = 4;
        dirRef.current = 1;
      }
      cursorRef.current = next;
      setCursorVal(next);

      // Subtle tactile acoustic click when passing into the active pin's sweet spot
      const pin = activeMinigame.pins?.[activeMinigame.activePinIndex ?? 0];
      if (pin) {
        const inZone = Math.abs(next - pin.sweetSpot) <= pin.tolerance;
        if (inZone && !lastSweetClickRef.current) {
          playTactileTone('click', useGameStore.getState().audioMuted);
        }
        lastSweetClickRef.current = inZone;
      }

      rafId = requestAnimationFrame(tick);
    };

    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [activeMinigame?.id, activeMinigame?.activePinIndex, activeMinigame?.kind, activeMinigame?.difficulty]);

  const handleLockpickStrike = useCallback(() => {
    if (!activeMinigame || activeMinigame.kind === 'securion_circuit') return;
    const res = attemptMinigameLockpick(cursorRef.current);
    if (res.hit) {
      playTactileTone('hit', audioMuted);
      setFeedback({
        tone: 'ok',
        text: res.completed
          ? 'Sauber geöffnet!'
          : 'Klick — Stift eingerastet!',
      });
    } else if (res.slipped) {
      playTactileTone('slip', audioMuted);
      setFeedback({
        tone: res.failed ? 'err' : 'warn',
        text: res.failed
          ? 'Abgerutscht! Lautes Aufbrechen — Wachen alarmiert!'
          : 'Dietrich abgerutscht! Lärmspitze & Kratzspur!',
      });
    }
  }, [activeMinigame, attemptMinigameLockpick, audioMuted]);

  const handleWireAction = (wireId: string, action: 'cut' | 'bridge') => {
    const res = attemptMinigameCircuitWire(wireId, action);
    if (res.correct) {
      playTactileTone('wire_ok', audioMuted);
      setFeedback({
        tone: 'ok',
        text: res.completed
          ? 'Securion-Kreis sauber überbrückt!'
          : action === 'cut'
            ? 'Leitung sauber getrennt.'
            : 'Schleife erfolgreich gebrückt.',
      });
    } else {
      playTactileTone('wire_bad', audioMuted);
      setFeedback({
        tone: 'err',
        text: res.trippedTamper
          ? 'Sabotage-Schleife ausgelöst — ALARM!'
          : 'Falsche Leitung! Kurzschluss-Spur erzeugt!',
      });
    }
  };

  // Keyboard bindings while minigame overlay is open
  useEffect(() => {
    if (!activeMinigame) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cancelMinigame();
        return;
      }
      if (
        activeMinigame.kind !== 'securion_circuit' &&
        (e.code === 'Space' || e.key === 'Enter')
      ) {
        e.preventDefault();
        e.stopPropagation();
        handleLockpickStrike();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [activeMinigame, cancelMinigame, handleLockpickStrike]);

  if (!activeMinigame) return null;

  const isCircuit = activeMinigame.kind === 'securion_circuit';
  const isSafeDial = activeMinigame.kind === 'safe_dial';
  const activePin = activeMinigame.pins?.[activeMinigame.activePinIndex ?? 0];
  const inSweetZone =
    activePin ? Math.abs(cursorVal - activePin.sweetSpot) <= activePin.tolerance : false;

  // Safe dial angle mapping (0..100 -> -150..+150 deg)
  const dialAngleDeg = ((cursorVal - 50) / 50) * 145;
  const sweetAngleDeg = activePin ? ((activePin.sweetSpot - 50) / 50) * 145 : 0;

  return (
    <div
      className="fixed inset-0 z-40 pointer-events-auto flex items-center justify-center bg-slate-950/75 backdrop-blur-md p-4"
      role="dialog"
      aria-modal="true"
      aria-label={activeMinigame.nodeLabel}
    >
      <div className="noir-card w-full max-w-xl rounded-2xl overflow-hidden border border-amber-400/35 shadow-[0_24px_70px_rgba(2,6,23,0.92)]">
        {/* Header */}
        <div className="px-5 py-3.5 bg-slate-950/90 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`p-2 rounded-lg border ${
                isCircuit
                  ? 'bg-cyan-500/15 border-cyan-400/45 text-cyan-300'
                  : 'bg-amber-500/15 border-amber-400/45 text-amber-300'
              }`}
            >
              {isCircuit ? (
                <Cpu className="w-4 h-4" />
              ) : isSafeDial ? (
                <Lock className="w-4 h-4" />
              ) : (
                <KeyRound className="w-4 h-4" />
              )}
            </div>
            <div className="min-w-0">
              <div className="font-mono-tech text-[10px] uppercase tracking-[0.2em] text-sky-300">
                {isCircuit
                  ? `${activeMinigame.securionModel ?? 'SECURION'} · SCHALTKREIS-BYPASS`
                  : isSafeDial
                    ? 'TRESOR-ZAHLENKOMBINATION'
                    : 'SCHLIESSZYLINDER · SPANNWERKZEUG'}
              </div>
              <h3 className="font-display font-bold text-base text-white truncate">
                {activeMinigame.nodeLabel}
              </h3>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span
              className={`font-mono-tech text-[11px] px-2 py-0.5 rounded border ${
                activeMinigame.slips > 0
                  ? 'bg-rose-500/20 border-rose-400/50 text-rose-200'
                  : 'bg-slate-900 border-slate-700 text-slate-300'
              }`}
            >
              Patzer: {activeMinigame.slips}/{activeMinigame.maxSlips}
            </span>
            <button
              type="button"
              onClick={cancelMinigame}
              className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-white cursor-pointer"
              aria-label="Abbrechen"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 bg-[#070d1b]">
          {/* Feedback Strip */}
          {feedback && (
            <div
              className={`px-3.5 py-2 rounded-lg border text-xs font-semibold flex items-center gap-2 animate-toast ${
                feedback.tone === 'ok'
                  ? 'bg-emerald-500/15 border-emerald-400/50 text-emerald-200'
                  : feedback.tone === 'warn'
                    ? 'bg-amber-500/15 border-amber-400/50 text-amber-200'
                    : 'bg-rose-500/20 border-rose-400/60 text-rose-200'
              }`}
            >
              {feedback.tone === 'ok' ? (
                <CheckCircle2 className="w-4 h-4 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              )}
              <span>{feedback.text}</span>
            </div>
          )}

          {/* ======================== MODE A: LOCKPICK / SAFE DIAL ======================== */}
          {!isCircuit && activeMinigame.pins && (
            <div className="space-y-4">
              {/* Tumbler Progress Pills */}
              <div className="flex items-center justify-center gap-2.5">
                {activeMinigame.pins.map((pin, idx) => {
                  const isCurrent = idx === activeMinigame.activePinIndex;
                  return (
                    <div
                      key={pin.index}
                      className={`px-3 py-1.5 rounded-lg border font-mono-tech text-xs flex items-center gap-1.5 transition-all ${
                        pin.solved
                          ? 'bg-emerald-500/20 border-emerald-400/60 text-emerald-200'
                          : isCurrent
                            ? 'bg-amber-500/20 border-amber-400 text-amber-200 ring-1 ring-amber-400/40'
                            : 'bg-slate-900/80 border-slate-800 text-slate-500'
                      }`}
                    >
                      <span>{isSafeDial ? `Rast ${idx + 1}` : `Stift ${idx + 1}`}</span>
                      {pin.solved && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />}
                    </div>
                  );
                })}
              </div>

              {/* Safe Dial Rotary SVG OR Lockpick Pin Chamber SVG */}
              {isSafeDial ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="relative w-48 h-48">
                    <svg viewBox="0 0 200 200" className="w-full h-full">
                      {/* Brushed Steel Outer Bezel */}
                      <circle
                        cx="100"
                        cy="100"
                        r="92"
                        fill="#0b1322"
                        stroke="#475569"
                        strokeWidth="4"
                      />
                      <circle
                        cx="100"
                        cy="100"
                        r="78"
                        fill="#111c30"
                        stroke={inSweetZone ? '#fbbf24' : '#334155'}
                        strokeWidth="2.5"
                      />
                      {/* Sweet spot arc highlight */}
                      {activePin && (
                        <g transform={`rotate(${sweetAngleDeg} 100 100)`}>
                          <line
                            x1="100"
                            y1="14"
                            x2="100"
                            y2="30"
                            stroke="#34d399"
                            strokeWidth="6"
                            strokeLinecap="round"
                            opacity="0.75"
                          />
                        </g>
                      )}
                      {/* Tick marks */}
                      {Array.from({ length: 24 }).map((_, i) => (
                        <line
                          key={i}
                          x1="100"
                          y1="22"
                          x2="100"
                          y2={i % 3 === 0 ? '32' : '27'}
                          stroke="#64748b"
                          strokeWidth={i % 3 === 0 ? '2' : '1'}
                          transform={`rotate(${i * 15} 100 100)`}
                        />
                      ))}
                      {/* Rotating Combination Pointer */}
                      <g transform={`rotate(${dialAngleDeg} 100 100)`}>
                        <circle
                          cx="100"
                          cy="100"
                          r="48"
                          fill="#1e293b"
                          stroke="#94a3b8"
                          strokeWidth="2"
                        />
                        <line
                          x1="100"
                          y1="52"
                          x2="100"
                          y2="18"
                          stroke={inSweetZone ? '#fbbf24' : '#38bdf8'}
                          strokeWidth="4.5"
                          strokeLinecap="round"
                        />
                        <circle cx="100" cy="100" r="14" fill="#0f172a" stroke="#f59e0b" strokeWidth="2" />
                      </g>
                    </svg>
                    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                      <span className="font-mono-tech text-xs font-bold text-amber-200 mt-20 bg-slate-950/90 px-2 py-0.5 rounded border border-slate-700">
                        {Math.round(cursorVal)}
                      </span>
                    </div>
                  </div>
                </div>
              ) : (
                /* Linear Precision Lockpick Tension Bar */
                <div className="p-4 rounded-xl bg-slate-950/90 border border-slate-800 space-y-3">
                  <div className="flex items-center justify-between font-mono-tech text-[11px] text-slate-400">
                    <span>SCHERLINIE · SPANNUNG</span>
                    <span className={inSweetZone ? 'text-emerald-300 font-bold' : 'text-slate-400'}>
                      {inSweetZone ? '● KLICKPUNKT ERKANNT' : 'Suchen…'}
                    </span>
                  </div>

                  <div className="relative h-12 rounded-lg bg-slate-900 border border-slate-700 overflow-hidden">
                    {/* Sweet Spot Resonance Band */}
                    {activePin && (
                      <div
                        className={`absolute top-0 bottom-0 transition-colors ${
                          inSweetZone
                            ? 'bg-emerald-400/35 border-x-2 border-emerald-300'
                            : 'bg-sky-400/18 border-x border-sky-400/50'
                        }`}
                        style={{
                          left: `${Math.max(0, activePin.sweetSpot - activePin.tolerance)}%`,
                          width: `${Math.min(100, activePin.tolerance * 2)}%`,
                        }}
                      />
                    )}

                    {/* Center hairline */}
                    <div className="absolute left-0 right-0 top-1/2 h-px bg-slate-700/60" />

                    {/* Moving Tension Pick Needle */}
                    <div
                      className={`absolute top-1 bottom-1 w-2 -translate-x-1/2 rounded-full transition-colors ${
                        inSweetZone
                          ? 'bg-emerald-300 shadow-[0_0_16px_rgba(52,211,153,0.95)]'
                          : 'bg-amber-400 shadow-[0_0_12px_rgba(245,158,11,0.8)]'
                      }`}
                      style={{ left: `${cursorVal}%` }}
                    />
                  </div>
                </div>
              )}

              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={handleLockpickStrike}
                  className="px-6 py-3 rounded-xl bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm tracking-wide shadow-lg shadow-amber-500/25 cursor-pointer flex items-center gap-2"
                >
                  <Sparkles className="w-4 h-4" />
                  <span>
                    {isSafeDial ? 'Rastpunkt einrasten [Leertaste]' : 'Stift setzen [Leertaste]'}
                  </span>
                </button>
              </div>
            </div>
          )}

          {/* ======================== MODE B: SECURION CIRCUIT BYPASS ======================== */}
          {isCircuit && activeMinigame.wires && (
            <div className="space-y-3">
              {/* Mara's Diagnostic Schematic Hint */}
              {activeMinigame.schematicHint && (
                <div className="p-3 rounded-xl bg-sky-500/10 border border-sky-400/35 text-xs text-sky-100 leading-relaxed flex items-start gap-2.5">
                  <Wrench className="w-4 h-4 text-sky-300 shrink-0 mt-0.5" />
                  <span>{activeMinigame.schematicHint}</span>
                </div>
              )}

              {/* Circuit Terminal Wire Rows */}
              <div className="space-y-2">
                {activeMinigame.wires.map((wire) => {
                  const isTamper = wire.role === 'tamper_backup';
                  return (
                    <div
                      key={wire.id}
                      className={`p-3 rounded-xl border flex items-center justify-between gap-3 transition-all ${
                        wire.resolved
                          ? 'bg-emerald-500/10 border-emerald-400/45'
                          : wire.tripped
                            ? 'bg-rose-500/15 border-rose-500/60'
                            : 'bg-slate-900/90 border-slate-800'
                      }`}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        {/* Colored Wire Visual */}
                        <div className="w-12 shrink-0 flex items-center">
                          <span
                            className="h-1.5 w-full rounded-full"
                            style={{
                              backgroundColor: wire.color,
                              opacity: wire.resolved ? 0.35 : 1,
                              boxShadow: wire.resolved
                                ? undefined
                                : `0 0 8px ${wire.color}80`,
                            }}
                          />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-white truncate flex items-center gap-2">
                            <span>{wire.label}</span>
                            {isTamper && (
                              <span className="font-mono-tech text-[9px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300 border border-rose-500/40">
                                SABOTAGE
                              </span>
                            )}
                          </div>
                          <div className="font-mono-tech text-[10px] text-slate-400">
                            {wire.resolved
                              ? wire.actionRequired === 'cut'
                                ? '✓ LEITUNG GETRENNT'
                                : '✓ SCHLEIFE GEBRÜCKT'
                              : wire.role === 'sensor_loop'
                                ? 'Aktiver Sensorkreis (Brücken)'
                                : wire.role === 'power_feed'
                                  ? 'Strom-/Meldeleitung (Trennen)'
                                  : isTamper
                                    ? 'Notstrom-Abreißkreis — NICHT BERÜHREN'
                                    : 'Referenz-/Taktleitung'}
                          </div>
                        </div>
                      </div>

                      {!wire.resolved ? (
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => handleWireAction(wire.id, 'cut')}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-rose-500/25 border border-slate-600 hover:border-rose-400/60 text-[11px] font-semibold text-slate-100 cursor-pointer"
                          >
                            <Scissors className="w-3 h-3 text-rose-300" />
                            <span>Trennen</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleWireAction(wire.id, 'bridge')}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-sky-500/25 border border-slate-600 hover:border-sky-400/60 text-[11px] font-semibold text-slate-100 cursor-pointer"
                          >
                            <Zap className="w-3 h-3 text-sky-300" />
                            <span>Brücken</span>
                          </button>
                        </div>
                      ) : (
                        <span className="font-mono-tech text-[11px] text-emerald-300 flex items-center gap-1 shrink-0">
                          <CheckCircle2 className="w-4 h-4" />
                          OK
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/* Footer: Instant Auto-Complete fallback + Abort */}
        <div className="px-5 py-3 bg-slate-950/95 border-t border-slate-800 flex items-center justify-between gap-3">
          <span className="font-mono-tech text-[10px] text-slate-400">
            Patzer erzeugen Lärm &amp; Spuren in Die Akte · ESC Abbruch
          </span>
          <button
            type="button"
            onClick={() => {
              playTactileTone('hit', audioMuted);
              autoCompleteActiveMinigame();
            }}
            className="px-3.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-600 text-xs font-semibold text-sky-200 transition-colors cursor-pointer"
          >
            Komplize / Auto-Knacken
          </button>
        </div>
      </div>
    </div>
  );
}
