import * as THREE from 'three';
import {
  AlarmLevel,
  CrewId,
  EvidenceDraft,
  FloorId,
  HeistTarget,
  TargetId,
  Vec2,
} from '../sim/types';
import { angleDiffDeg, hasLineOfSight, headingBetween } from '../sim/simulator';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import {
  AabbCollider,
  clamp,
  dampAngleRad,
  dist2D,
  headingDegToRotY,
  normalizeAngleRad,
  rotYToHeadingDeg,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — Living Salou Night Promenade & Dresden Altstadt Pedestrians
// Ambient evening strollers who react realistically to masked intruders,
// sneaking, forced entry, shattered glass, alarms, and reckless getaway cars,
// pulling phones to call Mossos/Polizei and logging Witness Evidence into
// Inspectora Núria Ferrer's "Die Akte".
// ============================================================================

export type PedestrianState =
  | 'strolling'
  | 'pausing'
  | 'suspicious'
  | 'startled'
  | 'calling_police'
  | 'fleeing';

export interface PedestrianStimulusActor {
  id: string;
  crewId?: CrewId;
  pos: Vec2;
  floor: FloorId;
  sneaking: boolean;
  speed: number;
  wearingMask?: boolean;
  wearingDisguise?: boolean;
  carryingLoot?: boolean;
  doingOvertCrime?: boolean;
  lightExposure?: number; // 0..1 (dark shadow reduces witness spotting distance)
}

export interface PedestrianNoiseEvent {
  pos: Vec2;
  floor: FloorId;
  radiusM: number;
  intensity: number; // 0..100
  kind: 'footstep' | 'glass_break' | 'lock_slip' | 'crowbar' | 'alarm' | 'car_crash';
}

export interface PedestrianUpdateParams {
  dt: number;
  timeSec: number;
  phase: 'scouting' | 'executing' | 'escape';
  focusFloor: FloorId;
  alarmLevel: AlarmLevel;
  powerDisabled: boolean;
  actors: PedestrianStimulusActor[];
  noiseEvents?: PedestrianNoiseEvent[];
  brokenGlassPositions?: Vec2[];
  playerCarPos?: Vec2;
  playerCarSpeedKmh?: number;
  playerCarHeadlightsOn?: boolean;
  playerCarDrifting?: boolean;
  cityBoxColliders?: AabbCollider[];
}

export interface PedestrianCallout {
  pedestrianId: string;
  text: string;
  pos: Vec2;
  urgent: boolean;
}

export interface PedestrianUpdateResult {
  newWitnessEvidence: EvidenceDraft[];
  witnessAlertTriggered: boolean;
  callouts: PedestrianCallout[];
  activeWitnessCount: number;
  highestWitnessSuspicion: number;
  witnessSourcePos: Vec2 | null;
}

interface ProceduralRig {
  pelvis?: THREE.Object3D;
  torso?: THREE.Object3D;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  pelvisBaseY: number;
}

interface PedestrianEntity {
  id: string;
  label: string;
  root: THREE.Group;
  model: THREE.Group;
  isSkinned: boolean;
  mixer: THREE.AnimationMixer | null;
  clips: {
    idle?: THREE.AnimationAction;
    walk?: THREE.AnimationAction;
    startled?: THREE.AnimationAction;
  };
  activeClipName: 'idle' | 'walk' | 'startled' | null;
  rig: ProceduralRig;
  phoneMesh: THREE.Mesh;
  pipSprite: THREE.Sprite;
  pipCanvas: HTMLCanvasElement | null;
  lastPipKey: string;

  // Navigation & state
  state: PedestrianState;
  waypoints: Vec2[];
  waypointIndex: number;
  loopClosed: boolean;
  direction: 1 | -1;
  pos: Vec2;
  rotY: number;
  walkSpeedMps: number;
  pauseTimerSec: number;
  stateTimerSec: number;
  walkPhase: number;

  // Witness perception
  suspicion: number; // 0..100
  lastWitnessedPos: Vec2 | null;
  lastWitnessedActor: PedestrianStimulusActor | null;
  witnessReason:
    | 'masked_intruder'
    | 'overt_crime'
    | 'broken_glass'
    | 'alarm'
    | 'reckless_car'
    | null;
  hasReportedCrime: boolean;
  hasReportedCar: boolean;
  calloutCooldownSec: number;
  fleeTarget: Vec2 | null;
  seedPhase: number;
}

interface RouteBlueprint {
  label: string;
  waypoints: Vec2[];
  loopClosed?: boolean;
  speedMps: number;
  jacketTintHex: number;
  escapeOnly?: boolean;
}

const SALOU_JACKET_PALETTE = [
  0xc8bba8, // Mediterranean sand linen
  0x2c3e55, // Midnight navy blazer
  0x576152, // Olive cotton overshirt
  0x6e3b3f, // Catalan burgundy cardigan
  0x3c424d, // Charcoal casual jacket
  0x8e7c68, // Warm taupe linen
  0x354a54, // Deep coastal slate
  0x7c5a46, // Terracotta brown
];

const DRESDEN_JACKET_PALETTE = [
  0x2a2f3a, // Dark wool coat
  0x3f3c37, // Charcoal tweed
  0x4b3b34, // Dark camel/espresso trench
  0x263442, // Midnight navy overcoat
  0x474c54, // Slate wool
];

const CALLOUTS_SUSPICIOUS = [
  'Moment… wer ist da?',
  'Hallo? Ist dort jemand?',
  'Seltsam… um diese Uhrzeit?',
];

const CALLOUTS_CRIME = [
  'Hey! Einbruch! Ich rufe die Polizei!',
  'Was zur Hölle—?! Mossos, sofort!',
  'Da steigt jemand ein!',
];

const CALLOUTS_CAR = [
  'Verrückter! Fast überfahren!',
  'Kennzeichen gemerkt — Polizei!',
];

function extractProceduralRig(model: THREE.Group): ProceduralRig {
  const pelvis = model.getObjectByName('Pelvis');
  return {
    pelvis,
    torso: model.getObjectByName('Torso'),
    head: model.getObjectByName('Head'),
    armL: model.getObjectByName('Arm_L'),
    armR: model.getObjectByName('Arm_R'),
    legL: model.getObjectByName('Leg_L'),
    legR: model.getObjectByName('Leg_R'),
    pelvisBaseY: pelvis ? pelvis.position.y : 0.9,
  };
}

function findClipByNames(
  clips: THREE.AnimationClip[],
  candidates: string[]
): THREE.AnimationClip | undefined {
  for (const name of candidates) {
    const exact = clips.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (exact) return exact;
  }
  for (const name of candidates) {
    const partial = clips.find((c) => c.name.toLowerCase().includes(name.toLowerCase()));
    if (partial) return partial;
  }
  return undefined;
}

function drawStatusPip(
  canvas: HTMLCanvasElement,
  symbol: string,
  colorHex: string,
  progress01: number
): THREE.CanvasTexture {
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = 24;

    ctx.fillStyle = 'rgba(10, 14, 24, 0.78)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();

    // Subtle radial progress arc
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(cx, cy, r - 2, 0, Math.PI * 2);
    ctx.stroke();

    if (progress01 > 0.02) {
      ctx.strokeStyle = colorHex;
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.arc(
        cx,
        cy,
        r - 2,
        -Math.PI / 2,
        -Math.PI / 2 + clamp(progress01, 0, 1) * Math.PI * 2
      );
      ctx.stroke();
    }

    ctx.font = 'bold 26px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorHex;
    ctx.fillText(symbol, cx, cy + 1);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function getGroundYForPos(pos: Vec2): number {
  // Coastal promenade slab in levelBuilder.ts spans z = 26..42 with top at y = 0.15
  if (pos.z >= 26.0 && pos.z <= 42.0) {
    return 0.15;
  }
  return 0.02;
}

function buildRoutesForTarget(target: HeistTarget): RouteBlueprint[] {
  const isDresden = target.city === 'Dresden';
  const palette = isDresden ? DRESDEN_JACKET_PALETTE : SALOU_JACKET_PALETTE;
  const pickTint = (idx: number) => palette[idx % palette.length];

  const routes: RouteBlueprint[] = [];

  if (target.id === 'casa_oro') {
    // Bustling Carrer de Barcelona + coastal promenade strollers
    routes.push(
      {
        label: 'Passantin Carrer de Barcelona',
        waypoints: [
          { x: -24, z: 13.6 },
          { x: -7, z: 13.6 },
          { x: 11, z: 13.4 },
          { x: 24, z: 13.6 },
        ],
        speedMps: 1.25,
        jacketTintHex: pickTint(0),
      },
      {
        label: 'Nachtspaziergänger Salou',
        waypoints: [
          { x: 20, z: 12.2 },
          { x: 4, z: 12.2 },
          { x: -16, z: 12.8 },
          { x: -28, z: 13.2 },
        ],
        speedMps: 1.15,
        jacketTintHex: pickTint(1),
      },
      {
        label: 'Anwohner Seitenstraße',
        waypoints: [
          { x: -17.5, z: 9.5 },
          { x: -17.5, z: 13.8 },
          { x: -3.5, z: 13.8 },
          { x: -17.5, z: 13.8 },
        ],
        speedMps: 1.1,
        jacketTintHex: pickTint(2),
      },
      {
        label: 'Promenaden-Gast (Ost)',
        waypoints: [
          { x: -30, z: 30.2 },
          { x: 0, z: 30.8 },
          { x: 32, z: 30.2 },
        ],
        speedMps: 1.2,
        jacketTintHex: pickTint(3),
      },
      {
        label: 'Promenaden-Flaneur (West)',
        waypoints: [
          { x: 36, z: 33.4 },
          { x: 6, z: 34.0 },
          { x: -26, z: 33.2 },
        ],
        speedMps: 1.08,
        jacketTintHex: pickTint(4),
      },
      {
        label: 'Restaurant-Gast Salou',
        waypoints: [
          { x: 16, z: 10.6 },
          { x: 26, z: 11.4 },
          { x: 26, z: 14.0 },
          { x: 14, z: 13.8 },
        ],
        loopClosed: true,
        speedMps: 1.12,
        jacketTintHex: pickTint(5),
      }
    );
  } else if (target.id === 'perla_del_mar') {
    // Passeig Jaume I — livelier luxury beachfront promenade
    routes.push(
      {
        label: 'Promenaden-Flaneurin',
        waypoints: [
          { x: -28, z: 13.2 },
          { x: -6, z: 13.0 },
          { x: 10, z: 13.4 },
          { x: 28, z: 13.2 },
        ],
        speedMps: 1.22,
        jacketTintHex: pickTint(0),
      },
      {
        label: 'Urlauber Passeig Jaume I',
        waypoints: [
          { x: 26, z: 14.2 },
          { x: 4, z: 14.0 },
          { x: -18, z: 14.2 },
        ],
        speedMps: 1.15,
        jacketTintHex: pickTint(1),
      },
      {
        label: 'Schaufenster-Passant',
        waypoints: [
          { x: -16, z: 11.2 },
          { x: -4.5, z: 10.6 },
          { x: 6.5, z: 10.8 },
          { x: 11.5, z: 13.5 },
        ],
        speedMps: 1.05,
        jacketTintHex: pickTint(2),
      },
      {
        label: 'Strandpromenade Jogger',
        waypoints: [
          { x: -38, z: 29.8 },
          { x: 42, z: 29.8 },
        ],
        speedMps: 2.1,
        jacketTintHex: pickTint(3),
      },
      {
        label: 'Abendspaziergang (Paar A)',
        waypoints: [
          { x: 34, z: 33.2 },
          { x: -4, z: 33.6 },
          { x: -32, z: 33.0 },
        ],
        speedMps: 1.05,
        jacketTintHex: pickTint(4),
      },
      {
        label: 'Abendspaziergang (Paar B)',
        waypoints: [
          { x: 33, z: 34.4 },
          { x: -5, z: 34.8 },
          { x: -33, z: 34.2 },
        ],
        speedMps: 1.05,
        jacketTintHex: pickTint(5),
      },
      {
        label: 'Café-Gast Promenade',
        waypoints: [
          { x: -24, z: 31.2 },
          { x: -10, z: 31.5 },
          { x: 16, z: 31.0 },
        ],
        speedMps: 1.16,
        jacketTintHex: pickTint(6),
      }
    );
  } else if (target.id === 'villa_mirador') {
    // Quiet upscale Cap Salou cliffside overlook (outside the villa fence z > 16!)
    routes.push(
      {
        label: 'Cap-Salou Spaziergänger',
        waypoints: [
          { x: -34, z: 29.5 },
          { x: -4, z: 30.2 },
          { x: 28, z: 29.6 },
        ],
        speedMps: 1.18,
        jacketTintHex: pickTint(0),
      },
      {
        label: 'Nachtjogger Klippenweg',
        waypoints: [
          { x: 38, z: 32.5 },
          { x: -36, z: 32.5 },
        ],
        speedMps: 2.15,
        jacketTintHex: pickTint(2),
      },
      {
        label: 'Nachbar Carrer del Far',
        waypoints: [
          { x: -26, z: 24.4 },
          { x: 12, z: 24.4 },
          { x: 28, z: 24.6 },
        ],
        speedMps: 1.12,
        jacketTintHex: pickTint(4),
      },
      {
        label: 'Aussichtspunkt-Besucher',
        waypoints: [
          { x: 18, z: 35.2 },
          { x: -14, z: 35.4 },
          { x: -28, z: 34.6 },
        ],
        speedMps: 1.02,
        jacketTintHex: pickTint(6),
      }
    );
  } else {
    // Dresden Altstadt — sparse late-night winter-noir pedestrians on Schlossplatz & Elbufer
    routes.push(
      {
        label: 'Altstadt-Passant',
        waypoints: [
          { x: -28, z: 14.6 },
          { x: -4, z: 14.8 },
          { x: 24, z: 14.4 },
        ],
        speedMps: 1.24,
        jacketTintHex: pickTint(0),
      },
      {
        label: 'Nachtschwärmer Schlossplatz',
        waypoints: [
          { x: 22, z: 13.4 },
          { x: -20, z: 13.6 },
        ],
        speedMps: 1.32,
        jacketTintHex: pickTint(1),
      },
      {
        label: 'Elbufer-Spaziergänger',
        waypoints: [
          { x: -34, z: 31.2 },
          { x: 34, z: 31.2 },
        ],
        speedMps: 1.18,
        jacketTintHex: pickTint(2),
      },
      {
        label: 'Spätheimkehrer Elbterrasse',
        waypoints: [
          { x: 40, z: 34.4 },
          { x: -28, z: 34.4 },
        ],
        speedMps: 1.28,
        jacketTintHex: pickTint(3),
      }
    );
  }

  // Additional distant promenade & boulevard civilians visible during getaway escape drive
  routes.push(
    {
      label: isDresden ? 'Elbpromenade Passant' : 'Promenaden-Passant (Hafen)',
      waypoints: [
        { x: 56, z: 30.5 },
        { x: 118, z: 30.8 },
      ],
      speedMps: 1.2,
      jacketTintHex: pickTint(1),
      escapeOnly: true,
    },
    {
      label: isDresden ? 'Neustadt-Passant' : 'La-Pineda Spaziergänger',
      waypoints: [
        { x: 178, z: 32.2 },
        { x: 116, z: 32.0 },
      ],
      speedMps: 1.15,
      jacketTintHex: pickTint(3),
      escapeOnly: true,
    },
    {
      label: isDresden ? 'Passant Königstraße' : 'Passant Avinguda',
      waypoints: [
        { x: 64, z: -48.5 },
        { x: 116, z: -48.5 },
      ],
      speedMps: 1.25,
      jacketTintHex: pickTint(4),
      escapeOnly: true,
    },
    {
      label: isDresden ? 'Nachtpassant Brücke' : 'Hafenarbeiter La Pineda',
      waypoints: [
        { x: 136, z: -124.5 },
        { x: 184, z: -124.5 },
      ],
      speedMps: 1.3,
      jacketTintHex: pickTint(2),
      escapeOnly: true,
    }
  );

  return routes;
}

export class PedestrianSystem {
  public readonly root = new THREE.Group();
  private target: HeistTarget;
  private pedestrians: PedestrianEntity[] = [];
  private escapeOnlyIds = new Set<string>();
  private reportedEvidenceKeys = new Set<string>();

  constructor(target: HeistTarget) {
    this.target = target;
    this.root.name = 'PedestrianSystem';
    this.buildPedestrians();
  }

  private buildPedestrians(): void {
    const routes = buildRoutesForTarget(this.target);
    const clips = assetRegistry.getAnimationClips('character_civilian');

    routes.forEach((route, idx) => {
      const id = `ped_${this.target.id}_${idx}`;
      if (route.escapeOnly) {
        this.escapeOnlyIds.add(id);
      }

      const entityRoot = new THREE.Group();
      entityRoot.name = `Pedestrian_${id}`;

      const model = assetRegistry.instantiateModel('character_civilian', true);
      const isSkinned = Boolean(model.userData?.isSkinned);

      // Subtle Mediterranean / Dresden evening wardrobe variation on Civ_LinenBlazer (or fallback torso/arms)
      // while preserving packed photoreal skin, hair, dark shirt, chinos, and leather PBR materials!
      const tintColor = new THREE.Color(route.jacketTintHex);
      const isFallbackModel = Boolean(model.userData?.isFallback);
      model.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial) {
              const isRealBlazer = m.name === 'Civ_LinenBlazer';
              const nm = `${mesh.name}_${m.name}`.toLowerCase();
              const isFallbackCloth =
                isFallbackModel &&
                (nm.includes('torso') || nm.includes('arm')) &&
                !nm.includes('skin') &&
                !nm.includes('head');
              if (isRealBlazer) {
                m.color.lerp(tintColor, 0.52);
              } else if (isFallbackCloth) {
                m.color.lerp(tintColor, 0.55);
              }
            }
          }
        }
      });

      // Natural human height variation (0.94..1.05)
      const heightScale = 0.94 + ((idx * 37) % 12) * 0.01;
      model.scale.setScalar(heightScale);
      entityRoot.add(model);

      // Setup skeletal AnimationMixer if GLB clips exist
      let mixer: THREE.AnimationMixer | null = null;
      const clipMap: PedestrianEntity['clips'] = {};
      const modelClips =
        (Array.isArray(model.userData?.animations) && model.userData.animations.length > 0
          ? (model.userData.animations as THREE.AnimationClip[])
          : clips) ?? [];

      if (modelClips.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        const idleClip = findClipByNames(modelClips, ['Idle', 'Stand']);
        const walkClip = findClipByNames(modelClips, ['Walk', 'PatrolWalk', 'Stroll']);
        const startledClip = findClipByNames(modelClips, ['Startled', 'Panic', 'React', 'Surprised']);
        if (idleClip) clipMap.idle = mixer.clipAction(idleClip);
        if (walkClip) clipMap.walk = mixer.clipAction(walkClip);
        if (startledClip) clipMap.startled = mixer.clipAction(startledClip);
      }

      const rig = extractProceduralRig(model);

      // Subtle glowing smartphone mesh (only visible when calling police!)
      const phoneMesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.065, 0.13, 0.014),
        new THREE.MeshStandardMaterial({
          color: 0x0f172a,
          emissive: 0x60a5fa,
          emissiveIntensity: 2.2,
          roughness: 0.2,
          metalness: 0.5,
        })
      );
      phoneMesh.name = 'Witness_Phone';
      const handRBone = model.getObjectByName('Hand_R');
      if (handRBone && isSkinned) {
        phoneMesh.position.set(0.02, 0.065, 0.04);
        phoneMesh.rotation.set(0.25, -0.35, 0.15);
        handRBone.add(phoneMesh);
      } else {
        phoneMesh.position.set(-0.22, 1.48 * heightScale, 0.14);
        phoneMesh.rotation.set(0.25, -0.35, 0.15);
        entityRoot.add(phoneMesh);
      }
      phoneMesh.visible = false;

      // Minimal depth-tested witness pip (hidden unless actively suspicious/calling)
      const pipCanvas =
        typeof document !== 'undefined' ? document.createElement('canvas') : null;
      if (pipCanvas) {
        pipCanvas.width = 64;
        pipCanvas.height = 64;
      }
      const pipSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          transparent: true,
          depthTest: true,
          depthWrite: false,
          opacity: 0.92,
        })
      );
      pipSprite.position.set(0, 2.08 * heightScale, 0);
      pipSprite.scale.set(0.42, 0.42, 1);
      pipSprite.visible = false;
      entityRoot.add(pipSprite);

      // Spread initial positions organically along each route
      const startWpIdx = idx % route.waypoints.length;
      const startWp = route.waypoints[startWpIdx];
      const nextWp = route.waypoints[(startWpIdx + 1) % route.waypoints.length] ?? startWp;
      const frac = ((idx * 0.31) % 0.7) + 0.1;
      const initPos: Vec2 = {
        x: startWp.x + (nextWp.x - startWp.x) * frac,
        z: startWp.z + (nextWp.z - startWp.z) * frac,
      };
      const initHeadingDeg = headingBetween(startWp, nextWp);
      const initRotY = headingDegToRotY(initHeadingDeg);

      entityRoot.position.set(initPos.x, getGroundYForPos(initPos), initPos.z);
      entityRoot.rotation.y = initRotY;

      this.root.add(entityRoot);

      const entity: PedestrianEntity = {
        id,
        label: route.label,
        root: entityRoot,
        model,
        isSkinned,
        mixer,
        clips: clipMap,
        activeClipName: null,
        rig,
        phoneMesh,
        pipSprite,
        pipCanvas,
        lastPipKey: '',
        state: 'strolling',
        waypoints: route.waypoints,
        waypointIndex: (startWpIdx + 1) % route.waypoints.length,
        loopClosed: Boolean(route.loopClosed),
        direction: 1,
        pos: initPos,
        rotY: initRotY,
        walkSpeedMps: route.speedMps,
        pauseTimerSec: 0,
        stateTimerSec: 0,
        walkPhase: idx * 1.37,
        suspicion: 0,
        lastWitnessedPos: null,
        lastWitnessedActor: null,
        witnessReason: null,
        hasReportedCrime: false,
        hasReportedCar: false,
        calloutCooldownSec: 0,
        fleeTarget: null,
        seedPhase: idx * 2.13,
      };

      if (entity.clips.walk) {
        entity.clips.walk.play();
        entity.activeClipName = 'walk';
      }

      this.pedestrians.push(entity);
    });
  }

  public getPedestrianCount(): number {
    return this.pedestrians.length;
  }

  public getPedestrianStates(): Array<{
    id: string;
    label: string;
    pos: Vec2;
    state: PedestrianState;
    suspicion: number;
  }> {
    return this.pedestrians.map((p) => ({
      id: p.id,
      label: p.label,
      pos: { ...p.pos },
      state: p.state,
      suspicion: Math.round(p.suspicion),
    }));
  }

  private transitionClip(
    p: PedestrianEntity,
    targetClip: 'idle' | 'walk' | 'startled',
    timeScale = 1.0
  ): void {
    if (!p.mixer) return;
    const nextAction = p.clips[targetClip] ?? p.clips.idle ?? p.clips.walk;
    if (!nextAction) return;
    nextAction.timeScale = timeScale;
    if (p.activeClipName === targetClip) return;

    const prevAction = p.activeClipName ? p.clips[p.activeClipName] : undefined;
    nextAction.reset();
    nextAction.enabled = true;
    if (prevAction && prevAction !== nextAction) {
      prevAction.crossFadeTo(nextAction, 0.22, false);
    } else {
      nextAction.fadeIn(0.18);
    }
    nextAction.play();
    p.activeClipName = targetClip;
  }

  private animateProcedural(
    p: PedestrianEntity,
    dt: number,
    timeSec: number,
    speed: number
  ): void {
    const { rig } = p;
    if (p.state === 'startled') {
      if (rig.torso) rig.torso.rotation.x = -0.18;
      if (rig.armL) rig.armL.rotation.x = -1.15;
      if (rig.armR) rig.armR.rotation.x = -1.05;
      if (rig.legL) rig.legL.rotation.x *= 0.8;
      if (rig.legR) rig.legR.rotation.x *= 0.8;
      if (rig.head) rig.head.rotation.y = Math.sin(timeSec * 8 + p.seedPhase) * 0.14;
      return;
    }

    if (p.state === 'calling_police') {
      if (rig.torso) rig.torso.rotation.x = 0.04;
      // Right arm holds smartphone to ear, left arm gestures tensely
      if (rig.armR) rig.armR.rotation.x = -2.1;
      if (rig.armL) rig.armL.rotation.x = -0.35 + Math.sin(timeSec * 5 + p.seedPhase) * 0.16;
      if (rig.legL) rig.legL.rotation.x *= 0.82;
      if (rig.legR) rig.legR.rotation.x *= 0.82;
      if (rig.head) rig.head.rotation.y = Math.sin(timeSec * 2.2 + p.seedPhase) * 0.18;
      if (rig.pelvis) rig.pelvis.position.y = rig.pelvisBaseY;
      return;
    }

    if (speed > 0.12) {
      const isFleeing = p.state === 'fleeing';
      p.walkPhase += dt * (isFleeing ? 10.5 : 5.2 + speed * 1.6);
      const amp = isFleeing ? 0.65 : 0.42;
      const swing = Math.sin(p.walkPhase) * amp;
      if (rig.legL) rig.legL.rotation.x = swing;
      if (rig.legR) rig.legR.rotation.x = -swing;
      if (rig.armL) rig.armL.rotation.x = -swing * 0.68;
      if (rig.armR) rig.armR.rotation.x = swing * 0.68;
      if (rig.torso) rig.torso.rotation.x = isFleeing ? 0.18 : 0.03;
      if (rig.pelvis) {
        rig.pelvis.position.y =
          rig.pelvisBaseY + Math.abs(Math.sin(p.walkPhase)) * (isFleeing ? 0.05 : 0.025);
      }
      if (rig.head) rig.head.rotation.y *= 0.85;
    } else {
      if (rig.legL) rig.legL.rotation.x *= 0.84;
      if (rig.legR) rig.legR.rotation.x *= 0.84;
      if (rig.armL) rig.armL.rotation.x *= 0.84;
      if (rig.armR) rig.armR.rotation.x *= 0.84;
      if (rig.torso) rig.torso.rotation.x *= 0.85;
      if (rig.pelvis) {
        rig.pelvis.position.y = rig.pelvisBaseY + Math.sin(timeSec * 2.1 + p.seedPhase) * 0.012;
      }
      if (rig.head) {
        const lookAmp = p.state === 'suspicious' ? 0.12 : 0.28;
        rig.head.rotation.y = Math.sin(timeSec * 1.15 + p.seedPhase) * lookAmp;
      }
    }
  }

  private setPip(
    p: PedestrianEntity,
    visible: boolean,
    symbol: string,
    colorHex: string,
    progress01: number
  ): void {
    p.pipSprite.visible = visible;
    if (!visible || !p.pipCanvas) return;
    const quantized = Math.round(clamp(progress01, 0, 1) * 12);
    const key = `${symbol}|${colorHex}|${quantized}`;
    if (p.lastPipKey === key) return;
    p.lastPipKey = key;
    const mat = p.pipSprite.material as THREE.SpriteMaterial;
    if (mat.map) mat.map.dispose();
    mat.map = drawStatusPip(p.pipCanvas, symbol, colorHex, quantized / 12);
    mat.needsUpdate = true;
  }

  private computeFleePoint(fromPos: Vec2, threatPos: Vec2): Vec2 {
    const dx = fromPos.x - threatPos.x;
    const dz = fromPos.z - threatPos.z;
    const len = Math.max(0.1, Math.hypot(dx, dz));
    const nx = dx / len;
    const nz = dz / len;
    // Bias fleeing along the promenade / street axis so civilians don't run into walls or the sea
    const targetX = clamp(fromPos.x + nx * 24, -60, 190);
    const targetZ = clamp(
      fromPos.z >= 25 ? 31 + nz * 4 : Math.max(12.2, fromPos.z + nz * 12),
      11.8,
      37.5
    );
    return { x: targetX, z: targetZ };
  }

  private emitWitnessEvidence(
    p: PedestrianEntity,
    targetId: TargetId,
    reason: NonNullable<PedestrianEntity['witnessReason']>,
    actor: PedestrianStimulusActor | null,
    out: EvidenceDraft[]
  ): void {
    const isCar = reason === 'reckless_car';
    const evType = isCar ? 'recognized_car' : 'witness';
    const dedupeKey = `${evType}:${reason}:${actor?.crewId ?? 'anon'}`;
    if (this.reportedEvidenceKeys.has(dedupeKey)) return;
    this.reportedEvidenceKeys.add(dedupeKey);

    if (isCar) {
      out.push({
        type: 'recognized_car',
        title: `Zeugenmeldung Fluchtwagen (${this.target.subtitle.split(',')[0]})`,
        detail: `${p.label} meldete einen rasenden Fluchtwagen nahe ${this.target.name} an die Mossos.`,
        targetId,
        severity: 11,
      });
      return;
    }

    const masked = Boolean(actor?.wearingMask);
    const severity =
      reason === 'overt_crime' || reason === 'broken_glass'
        ? masked
          ? 7
          : 15
        : reason === 'masked_intruder'
          ? 8
          : 9;

    const detail =
      reason === 'broken_glass'
        ? `${p.label} hörte klirrendes Glas bei ${this.target.name} und rief die Polizei.${masked ? ' Täter trug Maske — keine Gesichtsbeschreibung.' : ''}`
        : reason === 'overt_crime'
          ? `${p.label} beobachtete einen Einbruch bei ${this.target.name}.${masked ? ' Vermummte Gestalt — nur Kleidung notiert.' : ' Genaue Personenbeschreibung in Inspectora Ferrers Akte!'}`
          : reason === 'masked_intruder'
            ? `${p.label} meldete eine vermummte verdächtige Person auf der Straße nahe ${this.target.name}.`
            : `${p.label} meldete verdächtige Fluchtbewegungen beim Alarm an ${this.target.name}.`;

    out.push({
      type: 'witness',
      title: `Passanten-Zeuge: ${p.label}`,
      detail,
      targetId,
      severity,
      relatedCrewId: masked ? undefined : actor?.crewId,
    });
  }

  public update(params: PedestrianUpdateParams): PedestrianUpdateResult {
    const {
      dt,
      timeSec,
      phase,
      focusFloor,
      alarmLevel,
      powerDisabled,
      actors,
      noiseEvents = [],
      brokenGlassPositions = [],
      playerCarPos,
      playerCarSpeedKmh = 0,
      playerCarHeadlightsOn = true,
      playerCarDrifting = false,
      cityBoxColliders = [],
    } = params;

    const newWitnessEvidence: EvidenceDraft[] = [];
    const callouts: PedestrianCallout[] = [];
    let witnessAlertTriggered = false;
    let activeWitnessCount = 0;
    let highestWitnessSuspicion = 0;
    let witnessSourcePos: Vec2 | null = null;

    // Hide ground-level pedestrians when player views cellar cutaway
    const showSurface = focusFloor >= 0 || phase === 'escape';
    this.root.visible = showSurface;
    if (!showSurface) {
      return {
        newWitnessEvidence,
        witnessAlertTriggered,
        callouts,
        activeWitnessCount,
        highestWitnessSuspicion,
        witnessSourcePos,
      };
    }

    const alarmActive = alarmLevel === 'alarm' || alarmLevel === 'lockdown';

    for (const p of this.pedestrians) {
      const isEscapeOnly = this.escapeOnlyIds.has(p.id);
      if (phase !== 'escape' && isEscapeOnly) {
        p.root.visible = false;
        continue;
      }
      p.root.visible = true;

      p.calloutCooldownSec = Math.max(0, p.calloutCooldownSec - dt);
      const facingDeg = rotYToHeadingDeg(p.rotY);

      // ------------------------------------------------------------------
      // 1) Witness Perception (Wall-occluded LoS + Sound + Getaway Car)
      // ------------------------------------------------------------------
      let sawStimulus = false;
      let stimulusRate = 0;
      let stimulusPos: Vec2 | null = null;
      let stimulusActor: PedestrianStimulusActor | null = null;
      let stimulusReason: PedestrianEntity['witnessReason'] = null;
      let immediatePanic = false;

      // 1a) Check reckless getaway car passing close by
      if (playerCarPos && (phase === 'escape' || playerCarSpeedKmh > 30)) {
        const carDist = dist2D(p.pos.x, p.pos.z, playerCarPos.x, playerCarPos.z);
        const detectDist = playerCarHeadlightsOn ? 18 : 11;
        if (carDist < detectDist && (playerCarSpeedKmh > 46 || playerCarDrifting)) {
          sawStimulus = true;
          stimulusPos = { ...playerCarPos };
          stimulusReason = 'reckless_car';
          stimulusRate = playerCarSpeedKmh > 75 || carDist < 8 ? 95 : 55;
          if (carDist < 7.5 && playerCarSpeedKmh > 40) {
            immediatePanic = true;
          }
        }
      }

      // 1b) Check crew/player actors on street floor (with wall-occluded LoS)
      if (phase !== 'escape' && !immediatePanic) {
        for (const actor of actors) {
          if (actor.floor !== 0) continue;
          const d = dist2D(p.pos.x, p.pos.z, actor.pos.x, actor.pos.z);
          const lightMult = 0.55 + 0.45 * clamp(actor.lightExposure ?? (powerDisabled ? 0.35 : 0.9), 0, 1);
          const maxSight = 14.5 * lightMult;
          if (d > maxSight) continue;

          // Determine if this actor looks suspicious to a normal evening pedestrian
          const isOvert = Boolean(actor.doingOvertCrime);
          const isMasked = Boolean(actor.wearingMask);
          const isCarryingLoot = Boolean(actor.carryingLoot);
          const isSneakingNear = actor.sneaking && d < 9.0 && !actor.wearingDisguise;
          const isSprintingAlarm = alarmActive && actor.speed > 3.2;

          if (!isOvert && !isMasked && !isCarryingLoot && !isSneakingNear && !isSprintingAlarm) {
            continue;
          }
          // Disguise calms civilians unless doing overt break-in or carrying obvious loot bags
          if (actor.wearingDisguise && !isOvert && !isCarryingLoot && !isMasked) {
            continue;
          }

          const bearing = headingBetween(p.pos, actor.pos);
          const angDiff = angleDiffDeg(bearing, facingDeg);
          // 140° total peripheral vision cone (tighter when far)
          if (d > 2.2 && angDiff > 72) continue;

          if (!hasLineOfSight(p.pos, actor.pos, 0, this.target.walls)) {
            continue;
          }

          const distFactor = clamp(1.25 - d / maxSight, 0.3, 1.2);
          const centralFactor = angDiff < 32 ? 1.15 : 0.65;
          let baseRate = 0;
          let reason: PedestrianEntity['witnessReason'] = null;

          if (isOvert) {
            baseRate = 62;
            reason = 'overt_crime';
          } else if (isCarryingLoot) {
            baseRate = 54;
            reason = 'overt_crime';
          } else if (isMasked) {
            baseRate = 38;
            reason = 'masked_intruder';
          } else if (isSprintingAlarm) {
            baseRate = 48;
            reason = 'alarm';
          } else if (isSneakingNear) {
            baseRate = 24;
            reason = 'masked_intruder';
          }

          const candidateRate = baseRate * distFactor * centralFactor;
          if (candidateRate > stimulusRate) {
            sawStimulus = true;
            stimulusRate = candidateRate;
            stimulusPos = { ...actor.pos };
            stimulusActor = actor;
            stimulusReason = reason;
          }
        }
      }

      // 1c) Broken storefront glass or loud break-in noises
      if (phase !== 'escape') {
        for (const glassPos of brokenGlassPositions) {
          const d = dist2D(p.pos.x, p.pos.z, glassPos.x, glassPos.z);
          if (d < 13 && hasLineOfSight(p.pos, glassPos, 0, this.target.walls)) {
            if (55 > stimulusRate) {
              sawStimulus = true;
              stimulusRate = 55;
              stimulusPos = { ...glassPos };
              stimulusReason = 'broken_glass';
            }
          }
        }

        for (const ev of noiseEvents) {
          if (ev.floor !== 0) continue;
          const d = dist2D(p.pos.x, p.pos.z, ev.pos.x, ev.pos.z);
          if (d <= ev.radiusM && (ev.kind === 'glass_break' || ev.kind === 'crowbar' || ev.kind === 'alarm' || ev.kind === 'car_crash')) {
            const heardRate = ev.kind === 'glass_break' ? 80 : ev.kind === 'alarm' ? 60 : 45;
            if (heardRate > stimulusRate) {
              sawStimulus = true;
              stimulusRate = heardRate;
              stimulusPos = { ...ev.pos };
              stimulusReason = ev.kind === 'glass_break' ? 'broken_glass' : ev.kind === 'car_crash' ? 'reckless_car' : 'overt_crime';
              if (ev.kind === 'glass_break' && d < 12) {
                immediatePanic = true;
              }
            }
          }
        }

        // Loud central building alarm startles nearby street pedestrians
        if (alarmActive && p.state !== 'fleeing' && p.state !== 'calling_police') {
          const dTarget = dist2D(p.pos.x, p.pos.z, 0, 8);
          if (dTarget < 24) {
            sawStimulus = true;
            stimulusRate = Math.max(stimulusRate, 42);
            stimulusPos = stimulusPos ?? { x: 0, z: 8 };
            stimulusReason = stimulusReason ?? 'alarm';
          }
        }
      }

      // ------------------------------------------------------------------
      // 2) State Transitions
      // ------------------------------------------------------------------
      if (immediatePanic && p.state !== 'fleeing') {
        p.suspicion = 100;
        p.lastWitnessedPos = stimulusPos ?? p.lastWitnessedPos;
        p.lastWitnessedActor = stimulusActor ?? p.lastWitnessedActor;
        p.witnessReason = stimulusReason ?? p.witnessReason ?? 'overt_crime';
        p.state = 'startled';
        p.stateTimerSec = 0.75;
        if (p.calloutCooldownSec <= 0) {
          p.calloutCooldownSec = 6;
          const list = p.witnessReason === 'reckless_car' ? CALLOUTS_CAR : CALLOUTS_CRIME;
          callouts.push({
            pedestrianId: p.id,
            text: list[Math.floor(p.seedPhase) % list.length],
            pos: { ...p.pos },
            urgent: true,
          });
        }
      } else if (sawStimulus && stimulusPos) {
        p.lastWitnessedPos = stimulusPos;
        if (stimulusActor) p.lastWitnessedActor = stimulusActor;
        if (stimulusReason) p.witnessReason = stimulusReason;

        if (p.state === 'strolling' || p.state === 'pausing' || p.state === 'suspicious') {
          p.suspicion = clamp(p.suspicion + stimulusRate * dt, 0, 100);
          if (p.suspicion >= 100) {
            p.state = 'startled';
            p.stateTimerSec = 0.85;
            if (p.calloutCooldownSec <= 0) {
              p.calloutCooldownSec = 7;
              const list = p.witnessReason === 'reckless_car' ? CALLOUTS_CAR : CALLOUTS_CRIME;
              callouts.push({
                pedestrianId: p.id,
                text: list[Math.floor(p.seedPhase + timeSec) % list.length],
                pos: { ...p.pos },
                urgent: true,
              });
            }
          } else if (p.suspicion >= 22) {
            if (p.state !== 'suspicious' && p.calloutCooldownSec <= 0) {
              p.calloutCooldownSec = 8;
              callouts.push({
                pedestrianId: p.id,
                text: CALLOUTS_SUSPICIOUS[Math.floor(p.seedPhase) % CALLOUTS_SUSPICIOUS.length],
                pos: { ...p.pos },
                urgent: false,
              });
            }
            p.state = 'suspicious';
            p.stateTimerSec = 2.6;
          }
        }
      } else if (p.state === 'suspicious') {
        p.suspicion = Math.max(0, p.suspicion - dt * 16);
        p.stateTimerSec -= dt;
        if (p.suspicion <= 2 || p.stateTimerSec <= 0) {
          p.state = 'strolling';
          p.suspicion = 0;
          p.lastWitnessedPos = null;
          p.witnessReason = null;
        }
      } else if (p.state === 'strolling' || p.state === 'pausing') {
        p.suspicion = Math.max(0, p.suspicion - dt * 20);
      }

      // ------------------------------------------------------------------
      // 3) Movement & State Execution
      // ------------------------------------------------------------------
      let currentSpeed = 0;

      if (p.state === 'suspicious') {
        // Stop and face the suspicious stimulus
        if (p.lastWitnessedPos) {
          const lookRot = headingDegToRotY(headingBetween(p.pos, p.lastWitnessedPos));
          p.rotY = dampAngleRad(p.rotY, lookRot, 7, dt);
        }
      } else if (p.state === 'startled') {
        if (p.lastWitnessedPos) {
          const lookRot = headingDegToRotY(headingBetween(p.pos, p.lastWitnessedPos));
          p.rotY = dampAngleRad(p.rotY, lookRot, 12, dt);
        }
        p.stateTimerSec -= dt;
        if (p.stateTimerSec <= 0) {
          const isCar = p.witnessReason === 'reckless_car';
          if (isCar) {
            // Dive/flee away from speeding car and report car sighting once safely out of the way
            if (!p.hasReportedCar && p.witnessReason) {
              p.hasReportedCar = true;
              this.emitWitnessEvidence(
                p,
                this.target.id,
                'reckless_car',
                p.lastWitnessedActor,
                newWitnessEvidence
              );
            }
            p.state = 'fleeing';
            p.fleeTarget = this.computeFleePoint(p.pos, p.lastWitnessedPos ?? { x: 0, z: 18 });
            p.stateTimerSec = 7.0;
          } else if (!p.hasReportedCrime) {
            // Pull phone and report crime to Mossos / Polizei (~3.2s window!)
            p.state = 'calling_police';
            p.stateTimerSec = 3.2;
          } else {
            p.state = 'fleeing';
            p.fleeTarget = this.computeFleePoint(p.pos, p.lastWitnessedPos ?? { x: 0, z: 8 });
            p.stateTimerSec = 8.0;
          }
        }
      } else if (p.state === 'calling_police') {
        if (p.lastWitnessedPos) {
          const lookRot = headingDegToRotY(headingBetween(p.pos, p.lastWitnessedPos));
          p.rotY = dampAngleRad(p.rotY, lookRot, 6, dt);
        }
        p.stateTimerSec -= dt;
        if (p.stateTimerSec <= 0) {
          if (!p.hasReportedCrime) {
            p.hasReportedCrime = true;
            this.emitWitnessEvidence(
              p,
              this.target.id,
              p.witnessReason ?? 'overt_crime',
              p.lastWitnessedActor,
              newWitnessEvidence
            );
            if (phase === 'executing') {
              witnessAlertTriggered = true;
            }
          }
          p.state = 'fleeing';
          p.fleeTarget = this.computeFleePoint(p.pos, p.lastWitnessedPos ?? { x: 0, z: 8 });
          p.stateTimerSec = 9.0;
        }
      } else if (p.state === 'fleeing') {
        p.stateTimerSec -= dt;
        const fleeGoal = p.fleeTarget ?? this.computeFleePoint(p.pos, { x: 0, z: 8 });
        const dGoal = dist2D(p.pos.x, p.pos.z, fleeGoal.x, fleeGoal.z);
        if (dGoal > 0.6 && p.stateTimerSec > 0) {
          const fleeSpeed = 3.25;
          const step = Math.min(dGoal, fleeSpeed * dt);
          const dx = (fleeGoal.x - p.pos.x) / dGoal;
          const dz = (fleeGoal.z - p.pos.z) / dGoal;
          p.pos.x += dx * step;
          p.pos.z += dz * step;
          currentSpeed = fleeSpeed;
          const moveRot = Math.atan2(dx, dz);
          p.rotY = dampAngleRad(p.rotY, moveRot, 11, dt);
        } else if (p.stateTimerSec <= 0 && !alarmActive) {
          // Calm down eventually after fleeing far enough
          p.state = 'strolling';
          p.suspicion = 0;
          p.fleeTarget = null;
        }
      } else if (p.state === 'pausing') {
        p.pauseTimerSec -= dt;
        if (p.pauseTimerSec <= 0) {
          p.state = 'strolling';
        }
      } else {
        // Normal evening stroll along waypoints
        const wp = p.waypoints[p.waypointIndex];
        if (wp) {
          const dWp = dist2D(p.pos.x, p.pos.z, wp.x, wp.z);
          if (dWp < 0.45) {
            // Advance waypoint
            if (p.loopClosed) {
              p.waypointIndex = (p.waypointIndex + 1) % p.waypoints.length;
            } else {
              const nextIdx = p.waypointIndex + p.direction;
              if (nextIdx >= p.waypoints.length || nextIdx < 0) {
                p.direction = p.direction === 1 ? -1 : 1;
                p.waypointIndex = clamp(p.waypointIndex + p.direction, 0, p.waypoints.length - 1);
              } else {
                p.waypointIndex = nextIdx;
              }
            }
            // Occasional natural pause to admire storefront or Mediterranean sea
            const pseudoRand = Math.abs(Math.sin(timeSec * 0.73 + p.seedPhase * 3.1));
            if (pseudoRand > 0.58) {
              p.state = 'pausing';
              p.pauseTimerSec = 2.0 + pseudoRand * 3.2;
            }
          } else {
            const step = Math.min(dWp, p.walkSpeedMps * dt);
            let dirX = (wp.x - p.pos.x) / dWp;
            let dirZ = (wp.z - p.pos.z) / dWp;

            // Gentle personal-space separation from other pedestrians
            for (const other of this.pedestrians) {
              if (other === p || !other.root.visible) continue;
              const od = dist2D(p.pos.x, p.pos.z, other.pos.x, other.pos.z);
              if (od > 0.01 && od < 1.05) {
                const push = (1.05 - od) * 0.55;
                dirX += ((p.pos.x - other.pos.x) / od) * push;
                dirZ += ((p.pos.z - other.pos.z) / od) * push;
              }
            }
            const dLen = Math.max(0.001, Math.hypot(dirX, dirZ));
            dirX /= dLen;
            dirZ /= dLen;

            const nextX = p.pos.x + dirX * step;
            const nextZ = p.pos.z + dirZ * step;

            // Respect city building AABBs so civilians never clip facades
            let blocked = false;
            for (const box of cityBoxColliders) {
              if (
                nextX >= box.minX - 0.5 &&
                nextX <= box.maxX + 0.5 &&
                nextZ >= box.minZ - 0.5 &&
                nextZ <= box.maxZ + 0.5
              ) {
                blocked = true;
                break;
              }
            }
            if (!blocked) {
              p.pos.x = nextX;
              p.pos.z = nextZ;
              currentSpeed = p.walkSpeedMps;
            }
            const moveRot = Math.atan2(dirX, dirZ);
            p.rotY = dampAngleRad(p.rotY, moveRot, 7.5, dt);
          }
        }
      }

      // ------------------------------------------------------------------
      // 4) Sync 3D Transform, Skeletal/Procedural Animation & Minimal Visuals
      // ------------------------------------------------------------------
      p.root.position.set(p.pos.x, getGroundYForPos(p.pos), p.pos.z);
      p.root.rotation.y = normalizeAngleRad(p.rotY);

      p.phoneMesh.visible = p.state === 'calling_police';

      if (p.mixer) {
        if (p.state === 'startled') {
          this.transitionClip(p, 'startled', 1.0);
        } else if (currentSpeed > 0.12) {
          this.transitionClip(p, 'walk', p.state === 'fleeing' ? 1.85 : clamp(currentSpeed / 1.25, 0.8, 1.5));
        } else {
          this.transitionClip(p, 'idle', 1.0);
        }
        p.mixer.update(dt);
      } else {
        this.animateProcedural(p, dt, timeSec, currentSpeed);
      }

      // Minimal depth-tested witness pip ONLY when actively suspicious/reacting
      if (p.state === 'calling_police') {
        const callProgress = clamp(1 - p.stateTimerSec / 3.2, 0, 1);
        this.setPip(p, true, '!', '#ef4444', callProgress);
      } else if (p.state === 'startled') {
        this.setPip(p, true, '!', '#f97316', 1);
      } else if (p.state === 'suspicious' && p.suspicion >= 20) {
        this.setPip(p, true, '?', '#fbbf24', p.suspicion / 100);
      } else {
        this.setPip(p, false, '', '#fbbf24', 0);
      }

      // Track witness stealth telemetry for HUD
      if (
        p.state === 'suspicious' ||
        p.state === 'startled' ||
        p.state === 'calling_police'
      ) {
        activeWitnessCount += 1;
        const effectiveSusp =
          p.state === 'calling_police' || p.state === 'startled' ? 100 : p.suspicion;
        if (effectiveSusp > highestWitnessSuspicion) {
          highestWitnessSuspicion = effectiveSusp;
          witnessSourcePos = { ...p.pos };
        }
      }
    }

    return {
      newWitnessEvidence,
      witnessAlertTriggered,
      callouts,
      activeWitnessCount,
      highestWitnessSuspicion: Math.round(highestWitnessSuspicion),
      witnessSourcePos,
    };
  }

  public dispose(): void {
    for (const p of this.pedestrians) {
      if (p.mixer) {
        p.mixer.stopAllAction();
      }
    }
    disposeSceneSubtree(this.root);
  }
}
