import { useEffect, useState } from 'react';
import { ActionType, CaseFileStatus, EvidenceType, NodeKind, PlanBFallbackAction, PlanBTrigger } from '../sim/types';

export interface AssetManifest {
  version: number;
  style: string;
  images: Record<string, string>;
  textures: Record<string, string>;
  assets: Record<
    string,
    {
      url: string;
      category: string;
      width: number;
      height: number;
      usage: string;
    }
  >;
}

const DEFAULT_IMAGES: Record<string, string> = {
  title_salou_night: '/assets/images/title_salou_night.webp',
  portrait_mara: '/assets/images/portrait_mara.webp',
  portrait_jupp: '/assets/images/portrait_jupp.webp',
  portrait_jule: '/assets/images/portrait_jule.webp',
  portrait_toni: '/assets/images/portrait_toni.webp',
  portrait_rico: '/assets/images/portrait_rico.webp',
  portrait_ferrer: '/assets/images/portrait_ferrer.webp',
  portrait_lassen: '/assets/images/portrait_lassen.webp',
  story_bar_salou: '/assets/images/story_bar_salou.webp',
  story_dresden_vault: '/assets/images/story_dresden_vault.webp',
};

const DEFAULT_TEXTURES: Record<string, string> = {
  salou_stucco: '/assets/textures/salou_stucco.webp',
  wet_asphalt: '/assets/textures/wet_asphalt.webp',
  stone_plaza: '/assets/textures/stone_plaza.webp',
  blueprint_paper: '/assets/textures/blueprint_paper.webp',
};

let cachedManifest: AssetManifest | null = null;
let manifestPromise: Promise<AssetManifest | null> | null = null;

export function loadAssetManifest(): Promise<AssetManifest | null> {
  if (cachedManifest) return Promise.resolve(cachedManifest);
  if (!manifestPromise) {
    manifestPromise = fetch('/assets/images/manifest.json')
      .then((res) => (res.ok ? (res.json() as Promise<AssetManifest>) : null))
      .then((data) => {
        if (data) cachedManifest = data;
        return data;
      })
      .catch(() => null);
  }
  return manifestPromise;
}

export function useAssetManifest(): {
  images: Record<string, string>;
  textures: Record<string, string>;
  loaded: boolean;
} {
  const [manifest, setManifest] = useState<AssetManifest | null>(cachedManifest);

  useEffect(() => {
    let active = true;
    if (!cachedManifest) {
      loadAssetManifest().then((m) => {
        if (active && m) setManifest(m);
      });
    }
    return () => {
      active = false;
    };
  }, []);

  return {
    images: manifest?.images ?? DEFAULT_IMAGES,
    textures: manifest?.textures ?? DEFAULT_TEXTURES,
    loaded: manifest !== null,
  };
}

export function getImageUrl(key: string, images?: Record<string, string>): string {
  return images?.[key] ?? DEFAULT_IMAGES[key] ?? `/assets/images/${key}.webp`;
}

// ============================================================================
// Formatting & German UI Label Helpers
// ============================================================================

export function formatEur(amount: number): string {
  return new Intl.NumberFormat('de-DE', {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
}

export function formatTimeSec(sec: number): string {
  const clamped = Math.max(0, sec);
  const mins = Math.floor(clamped / 60);
  const rem = clamped % 60;
  const whole = Math.floor(rem);
  const tenths = Math.floor((rem - whole) * 10);
  return `${String(mins).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenths}`;
}

export function formatShortSec(sec: number): string {
  return `${Math.round(sec * 10) / 10}s`;
}

export const CASE_STATUS_META: Record<
  CaseFileStatus,
  { label: string; colorClass: string; badgeBg: string }
> = {
  cold: {
    label: 'KALT / RUHEND',
    colorClass: 'text-emerald-300',
    badgeBg: 'bg-emerald-500/15 border-emerald-400/40 text-emerald-300',
  },
  active_inquiry: {
    label: 'AKTIVE ERMITTLUNG',
    colorClass: 'text-sky-300',
    badgeBg: 'bg-sky-500/15 border-sky-400/40 text-sky-300',
  },
  tightening_net: {
    label: 'NETZ ZIEHT SICH ZU',
    colorClass: 'text-amber-300',
    badgeBg: 'bg-amber-500/15 border-amber-400/40 text-amber-300',
  },
  warrant_imminent: {
    label: 'HAFTBEFEHL DROHT',
    colorClass: 'text-rose-300',
    badgeBg: 'bg-rose-500/20 border-rose-400/50 text-rose-300',
  },
};

export const EVIDENCE_TYPE_LABELS: Record<EvidenceType, string> = {
  fingerprints: 'Fingerabdrücke',
  camera_footage: 'Kamera-Aufnahme',
  witness: 'Zeugenaussage',
  recognized_car: 'Fluchtwagen gesichtet',
  crew_chatter: 'Kneipengerüchte',
  alarm_signature: 'Securion-Protokoll',
  violence_report: 'Gewaltvorfall',
};

export const NODE_KIND_LABELS: Record<NodeKind, string> = {
  entry_door: 'Türzugang',
  entry_roof: 'Dachzugang',
  entry_cellar: 'Kellerzugang',
  entry_window: 'Fenster / Balkon',
  entry_service: 'Lieferzugang',
  lock: 'Schloss',
  power_box: 'Stromverteiler',
  alarm_panel: 'Alarmzentrale',
  camera: 'Kamera (CCTV)',
  safe: 'Stahltresor',
  loot_case: 'Beute / Vitrine',
  stairs: 'Treppe / Leiter',
  lookout: 'Spähposten',
  getaway_zone: 'Fluchtwagen',
  hidden_trap: 'Verborgener Sensor',
};

export const PLAN_B_TRIGGER_LABELS: Record<PlanBTrigger, string> = {
  on_alarm: 'Bei Alarm',
  on_guard_spotted: 'Bei Sichtung durch Wache',
  on_crew_compromised: 'Bei Komplizen-Ausfall',
  manual_radio: 'Per Funkbefehl (Taste 2)',
};

export const PLAN_B_ACTION_LABELS: Record<PlanBFallbackAction, string> = {
  abort_to_car: 'Sofort zum Fluchtwagen',
  alternate_exit_roof: 'Notausgang Dach / Balkon',
  alternate_exit_cellar: 'Notausgang Keller / Schacht',
  hold_and_cover: 'Stellung halten & absichern',
  grab_nearest_and_run: 'Nächste Beute greifen & fliehen',
};

export const ACTION_COLORS: Record<
  ActionType,
  { bg: string; border: string; text: string }
> = {
  move: { bg: 'bg-slate-700/80', border: 'border-slate-400/50', text: 'text-slate-100' },
  enter: { bg: 'bg-sky-900/80', border: 'border-sky-400/60', text: 'text-sky-100' },
  pick_lock: { bg: 'bg-sky-900/80', border: 'border-sky-300/60', text: 'text-sky-100' },
  cut_power: { bg: 'bg-cyan-900/85', border: 'border-cyan-400/75', text: 'text-cyan-100' },
  bypass_alarm: { bg: 'bg-teal-900/85', border: 'border-teal-400/75', text: 'text-teal-100' },
  loop_camera: { bg: 'bg-indigo-900/80', border: 'border-indigo-400/70', text: 'text-indigo-100' },
  crack_safe: { bg: 'bg-amber-900/85', border: 'border-amber-400/80', text: 'text-amber-100' },
  grab_loot: { bg: 'bg-amber-800/80', border: 'border-amber-300/75', text: 'text-amber-50' },
  lookout: { bg: 'bg-violet-900/80', border: 'border-violet-400/65', text: 'text-violet-100' },
  stage_car: { bg: 'bg-purple-900/80', border: 'border-purple-400/65', text: 'text-purple-100' },
  wait: { bg: 'bg-slate-800/85', border: 'border-slate-500/60', text: 'text-slate-200' },
  extract: { bg: 'bg-emerald-900/85', border: 'border-emerald-400/75', text: 'text-emerald-100' },
};
