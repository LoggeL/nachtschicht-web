// ============================================================================
// NACHTSCHICHT — Procedural Web Audio Sound Engine
// Mediterranean Night Noir ambience, stealth footsteps, lockpicks, power-cut
// hum drop, alarm siren, radio squelch, car engine pitch & police wail.
// Unlocks cleanly on first user gesture and respects mute toggle.
// ============================================================================

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private ambienceGain: GainNode | null = null;
  private engineOsc: OscillatorNode | null = null;
  private engineSubOsc: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private driftGain: GainNode | null = null;
  private sirenOsc: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenPhase = 0;

  private muted = false;
  private unlocked = false;
  private disposed = false;
  private lastFootstepMs = 0;
  private lastAlarmMs = 0;
  private lastScanTickMs = 0;
  private lastLockClickMs = 0;

  private unlockHandler: () => void;

  constructor(initialMuted = false) {
    this.muted = initialMuted;
    this.unlockHandler = () => {
      this.unlock();
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerdown', this.unlockHandler, { passive: true });
      window.addEventListener('keydown', this.unlockHandler, { passive: true });
    }
  }

  public unlock(): void {
    if (this.disposed) return;
    if (this.unlocked && this.ctx) {
      if (this.ctx.state === 'suspended') {
        void this.ctx.resume().catch(() => {});
      }
      return;
    }

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;

      const ctx = new AudioCtx();
      this.ctx = ctx;

      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : 0.42;
      master.connect(ctx.destination);
      this.masterGain = master;

      this.setupAmbience(ctx, master);
      this.setupVehicleNodes(ctx, master);
      this.setupSirenNodes(ctx, master);

      this.unlocked = true;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
    } catch {
      // Headless or restricted audio environments fail silently
    }
  }

  private createNoiseBuffer(ctx: AudioContext, durationSec = 2): AudioBuffer {
    const sampleRate = ctx.sampleRate;
    const length = Math.floor(sampleRate * durationSec);
    const buffer = ctx.createBuffer(1, length, sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      data[i] = last * 3.0;
    }
    return buffer;
  }

  private setupAmbience(ctx: AudioContext, master: GainNode): void {
    const ambGain = ctx.createGain();
    ambGain.gain.value = 0.14;
    ambGain.connect(master);
    this.ambienceGain = ambGain;

    // Soft coastal night breeze / city rumble
    const noise = ctx.createBufferSource();
    noise.buffer = this.createNoiseBuffer(ctx, 3);
    noise.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 260;

    noise.connect(filter);
    filter.connect(ambGain);
    noise.start();

    // Subtle deep midnight noir drone (D1 / A1 fifth)
    const drone1 = ctx.createOscillator();
    drone1.type = 'sine';
    drone1.frequency.value = 55;
    const droneGain = ctx.createGain();
    droneGain.gain.value = 0.08;
    drone1.connect(droneGain);
    droneGain.connect(ambGain);
    drone1.start();
  }

  private setupVehicleNodes(ctx: AudioContext, master: GainNode): void {
    const engGain = ctx.createGain();
    engGain.gain.value = 0;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 340;
    engGain.connect(filter);
    filter.connect(master);

    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = 58;
    osc.connect(engGain);
    osc.start();

    const sub = ctx.createOscillator();
    sub.type = 'triangle';
    sub.frequency.value = 29;
    const subGain = ctx.createGain();
    subGain.gain.value = 0.65;
    sub.connect(subGain);
    subGain.connect(engGain);
    sub.start();

    // Tire drift noise
    const driftNoise = ctx.createBufferSource();
    driftNoise.buffer = this.createNoiseBuffer(ctx, 2);
    driftNoise.loop = true;
    const bandpass = ctx.createBiquadFilter();
    bandpass.type = 'bandpass';
    bandpass.frequency.value = 1350;
    bandpass.Q.value = 2.6;
    const driftG = ctx.createGain();
    driftG.gain.value = 0;
    driftNoise.connect(bandpass);
    bandpass.connect(driftG);
    driftG.connect(master);
    driftNoise.start();

    this.engineOsc = osc;
    this.engineSubOsc = sub;
    this.engineGain = engGain;
    this.driftGain = driftG;
  }

  private setupSirenNodes(ctx: AudioContext, master: GainNode): void {
    const sGain = ctx.createGain();
    sGain.gain.value = 0;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 780;
    filter.Q.value = 1.4;
    sGain.connect(filter);
    filter.connect(master);

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 660;
    osc.connect(sGain);
    osc.start();

    this.sirenOsc = osc;
    this.sirenGain = sGain;
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.ctx) {
      this.masterGain.gain.setTargetAtTime(muted ? 0 : 0.42, this.ctx.currentTime, 0.04);
    }
  }

  public setAmbienceLevel(level: number): void {
    if (this.ambienceGain && this.ctx) {
      this.ambienceGain.gain.setTargetAtTime(
        Math.max(0, Math.min(0.25, level)),
        this.ctx.currentTime,
        0.15
      );
    }
  }

  public playFootstep(sneaking: boolean): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const nowMs = performance.now();
    const minInterval = sneaking ? 470 : 320;
    if (nowMs - this.lastFootstepMs < minInterval) return;
    this.lastFootstepMs = nowMs;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(sneaking ? 95 : 135 + Math.random() * 25, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.06);

    gain.gain.setValueAtTime(sneaking ? 0.05 : 0.11, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.07);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.08);
  }

  public playScanTick(progress: number): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastScanTickMs < 140) return;
    this.lastScanTickMs = nowMs;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(420 + progress * 480, t);
    gain.gain.setValueAtTime(0.07, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  public playDiscovery(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    const notes = [523.25, 659.25, 783.99];
    notes.forEach((freq, idx) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      const start = t + idx * 0.06;
      osc.frequency.setValueAtTime(freq, start);
      gain.gain.setValueAtTime(0.11, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + 0.28);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(start);
      osc.stop(start + 0.3);
    });
  }

  public playLockpickClick(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastLockClickMs < 240) return;
    this.lastLockClickMs = nowMs;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(1400 + Math.random() * 600, t);
    osc.frequency.exponentialRampToValueAtTime(380, t + 0.03);
    gain.gain.setValueAtTime(0.06, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.04);

    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.045);
  }

  public playPowerCut(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;

    // Descending transformer hum drop
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.85);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(600, t);
    lp.frequency.exponentialRampToValueAtTime(90, t + 0.85);

    gain.gain.setValueAtTime(0.24, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.9);

    osc.connect(lp);
    lp.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.95);
  }

  public playLootPickup(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    const freqs = [698.46, 880, 1046.5];
    freqs.forEach((f, i) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'triangle';
      const s = t + i * 0.055;
      osc.frequency.setValueAtTime(f, s);
      gain.gain.setValueAtTime(0.13, s);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.24);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(s);
      osc.stop(s + 0.25);
    });
  }

  public playRadioBeep(urgent = false): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    const freqs = urgent ? [960, 740, 960] : [880, 1120];
    freqs.forEach((f, i) => {
      if (!this.ctx || !this.masterGain) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'square';
      const s = t + i * 0.065;
      osc.frequency.setValueAtTime(f, s);
      gain.gain.setValueAtTime(0.075, s);
      gain.gain.exponentialRampToValueAtTime(0.001, s + 0.055);
      osc.connect(gain);
      gain.connect(this.masterGain);
      osc.start(s);
      osc.stop(s + 0.06);
    });
  }

  public playAlarmPulse(): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const nowMs = performance.now();
    if (nowMs - this.lastAlarmMs < 1100) return;
    this.lastAlarmMs = nowMs;

    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(640, t);
    osc.frequency.setValueAtTime(840, t + 0.28);

    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 1400;

    gain.gain.setValueAtTime(0.11, t);
    gain.gain.setValueAtTime(0.11, t + 0.5);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.62);

    osc.connect(lp);
    lp.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.64);
  }

  public playImpact(intensity = 0.6): void {
    if (!this.ctx || !this.masterGain || this.muted) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(115, t);
    osc.frequency.exponentialRampToValueAtTime(28, t + 0.16);
    gain.gain.setValueAtTime(Math.min(0.28, 0.12 + intensity * 0.18), t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain);
    gain.connect(this.masterGain);
    osc.start(t);
    osc.stop(t + 0.19);
  }

  public updateEngine(speedKmh: number, drifting: boolean, active: boolean): void {
    if (!this.ctx || !this.engineOsc || !this.engineSubOsc || !this.engineGain || !this.driftGain) {
      return;
    }
    const t = this.ctx.currentTime;
    if (!active || this.muted) {
      this.engineGain.gain.setTargetAtTime(0, t, 0.08);
      this.driftGain.gain.setTargetAtTime(0, t, 0.08);
      return;
    }

    const normSpeed = Math.min(1.3, Math.abs(speedKmh) / 110);
    const freq = 56 + normSpeed * 125;
    this.engineOsc.frequency.setTargetAtTime(freq, t, 0.05);
    this.engineSubOsc.frequency.setTargetAtTime(freq * 0.5, t, 0.05);
    this.engineGain.gain.setTargetAtTime(0.08 + normSpeed * 0.08, t, 0.06);

    const driftVol = drifting && Math.abs(speedKmh) > 25 ? 0.09 : 0;
    this.driftGain.gain.setTargetAtTime(driftVol, t, 0.05);
  }

  public updatePoliceSiren(proximity01: number, active: boolean, dt: number): void {
    if (!this.ctx || !this.sirenOsc || !this.sirenGain) return;
    const t = this.ctx.currentTime;
    if (!active || proximity01 <= 0.02 || this.muted) {
      this.sirenGain.gain.setTargetAtTime(0, t, 0.08);
      return;
    }
    this.sirenPhase += dt * 3.8;
    // European hi-lo police siren
    const hi = Math.sin(this.sirenPhase) > 0;
    this.sirenOsc.frequency.setTargetAtTime(hi ? 820 : 620, t, 0.025);
    this.sirenGain.gain.setTargetAtTime(proximity01 * 0.11, t, 0.06);
  }

  public dispose(): void {
    this.disposed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pointerdown', this.unlockHandler);
      window.removeEventListener('keydown', this.unlockHandler);
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
