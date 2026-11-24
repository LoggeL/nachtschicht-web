import * as THREE from 'three';
import {
  AlarmLevel,
  CrewId,
  CrewMember,
  EvidenceDraft,
  FloorId,
  ForensicLoadout,
  GuardAIState,
  GuardPatrol,
  HeistTarget,
  IntelState,
  LiveCameraState,
  LiveExecutionState,
  LiveGuardState,
  StealthTelemetry,
  TargetNode,
  Vec2,
} from '../sim/types';
import { headingBetween, sampleCameraHeading } from '../sim/simulator';
import {
  GuardAIEvent,
  GuardTargetActor,
  buildGuardTargetActors,
  computeRoomLightLevels,
  computeWallClippedVisionFan,
  createGuardStatesForTarget,
  raycastSolidWalls,
  stepGuardsAI,
} from '../sim/guardAI';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import { AudioEngine } from './audioEngine';
import {
  VolumetricConeHandle,
  createVolumetricLightCone,
} from './rendering/volumetrics';
import {
  DEG2RAD,
  clamp,
  damp,
  dampAngleRad,
  headingDegToRotY,
  normalizeAngleRad,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — 3D Realistic Guard Stealth AI, Skeletal Animation,
// Wall-Clipped Vision Optics, Volumetric Flashlight & CCTV Camera System
// ============================================================================

type GuardClipName =
  | 'Idle'
  | 'PatrolWalk'
  | 'SuspiciousLook'
  | 'FlashlightSweep'
  | 'RadioCall'
  | 'Sprint';

interface GuardRig {
  pelvis?: THREE.Object3D;
  torso?: THREE.Object3D;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  pelvisBaseY: number;
}

interface GuardEntity {
  def: GuardPatrol;
  root: THREE.Group;
  model: THREE.Group;
  rig: GuardRig;
  mixer: THREE.AnimationMixer | null;
  actions: Partial<Record<GuardClipName, THREE.AnimationAction>>;
  activeClip: GuardClipName | null;

  // Wall-clipped dynamic ground awareness fan (never pierces solid walls!)
  coneMesh: THREE.Mesh;
  coneGeo: THREE.BufferGeometry;
  coneMat: THREE.MeshBasicMaterial;
  coneSegments: number;

  // Volumetric Fresnel flashlight + real dynamic SpotLight
  flashlightPivot: THREE.Group;
  flashlightAttachedToBone: boolean;
  flashlightCone: VolumetricConeHandle;
  flashlightSpot: THREE.SpotLight;
  flashlightTarget: THREE.Object3D;
  shoulderRadioLed: THREE.Mesh;
  radioLedMat: THREE.MeshStandardMaterial | null;
  flashlightLensMat: THREE.MeshStandardMaterial | null;

  // Minimal diegetic indicators (hidden by default; depth-tested!)
  timedRing: THREE.Mesh;
  timedRingMat: THREE.MeshBasicMaterial;
  badgeSprite: THREE.Sprite;
  badgeCanvas: HTMLCanvasElement | null;
  lastBadgeKey: string;

  // Smooth runtime kinematics
  currentPos: Vec2;
  currentFloor: FloorId;
  currentRotY: number;
  currentSpeed: number;
  walkPhase: number;
  flashlightYawLocal: number;
  flashlightLenSmooth: number;
  prevState: GuardAIState;
}

interface CameraEntity {
  node: TargetNode;
  root: THREE.Group;
  model: THREE.Group;
  headPivot: THREE.Object3D | null;
  ledMesh: THREE.Mesh | null;
  coneMesh: THREE.Mesh;
  coneGeo: THREE.BufferGeometry;
  coneMat: THREE.MeshBasicMaterial;
  coneSegments: number;
  baseMountRotY: number;
}

export interface GuardSystemUpdateParams {
  dt: number;
  timeSec: number;
  phase: 'scouting' | 'executing' | 'escape';
  focusFloor: FloorId;
  intel: IntelState;
  liveGuards?: LiveGuardState[];
  liveCameras?: LiveCameraState[];
  powerDisabled: boolean;
  timingGuardId: string | null;

  // Round 2 AAA Stealth AI & Optics Integration Hooks (all optional for backward compat)
  liveState?: LiveExecutionState;
  crewById?: Record<CrewId, CrewMember>;
  forensicLoadoutByCrew?: Partial<Record<CrewId, ForensicLoadout>>;
  activeBlockTypesByCrew?: Partial<Record<CrewId, string | undefined>>;
  /** When true in 'executing' phase, GuardSystem runs `stepGuardsAI` directly & returns updated guards */
  runInternalAI?: boolean;
  playerPos?: Vec2;
  playerFloor?: FloorId;
  playerSneaking?: boolean;
  playerSpeed?: number;
  playerWearingMask?: boolean;
  playerDarkClothing?: boolean;
  binocularsActive?: boolean;
  audio?: AudioEngine;
}

export interface GuardSystemUpdateResult {
  guards: LiveGuardState[];
  events: GuardAIEvent[];
  newEvidence: EvidenceDraft[];
  triggersCentralAlarm: boolean;
  alarmEscalation: AlarmLevel | null;
  stealthTelemetry: StealthTelemetry;
}

const FAN_SEGMENTS = 26;

function createDynamicFanGeometry(segments: number): THREE.BufferGeometry {
  const vertexCount = segments + 2; // center + (segments + 1) perimeter rays
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const indices: number[] = [];

  uvs[0] = 0.5;
  uvs[1] = 0;
  for (let i = 0; i <= segments; i++) {
    const vIdx = i + 1;
    uvs[vIdx * 2 + 0] = i / segments;
    uvs[vIdx * 2 + 1] = 1;
    if (i < segments) {
      indices.push(0, i + 1, i + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}

/**
 * Updates a ground vision fan's vertices in WORLD-aligned local coordinates (where
 * the fan mesh stays unrotated on root, or transformed into entity local space)
 * so every ray terminates cleanly on solid walls!
 */
function updateWallClippedFanGeometry(params: {
  geo: THREE.BufferGeometry;
  segments: number;
  origin: Vec2;
  floor: FloorId;
  headingDeg: number;
  entityRotY: number;
  range: number;
  coneDeg: number;
  walls: HeistTarget['walls'];
}): void {
  const { geo, segments, origin, floor, headingDeg, entityRotY, range, coneDeg, walls } =
    params;

  const rays = computeWallClippedVisionFan({
    origin,
    floor,
    headingDeg,
    range,
    coneDeg,
    walls,
    segments,
  });

  const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
  posAttr.setXYZ(0, 0, 0, 0);

  // Inverse of Three.js Y-rotation matrix R_y(entityRotY):
  // world = (lx*cos + lz*sin, -lx*sin + lz*cos) => local = (wx*cos - wz*sin, wx*sin + wz*cos)
  const cosR = Math.cos(entityRotY);
  const sinR = Math.sin(entityRotY);

  for (let i = 0; i <= segments; i++) {
    const r = rays[i];
    const wx = r.worldPos.x - origin.x;
    const wz = r.worldPos.z - origin.z;
    const lx = wx * cosR - wz * sinR;
    const lz = wx * sinR + wz * cosR;
    posAttr.setXYZ(i + 1, lx, 0, lz);
  }

  posAttr.needsUpdate = true;
  geo.computeBoundingSphere();
}

let sharedConeGradTex: THREE.CanvasTexture | null = null;
function getConeGradientTexture(): THREE.CanvasTexture {
  if (sharedConeGradTex) return sharedConeGradTex;
  if (typeof document === 'undefined') {
    const data = new Uint8Array([255, 255, 255, 128]);
    sharedConeGradTex = new THREE.DataTexture(data, 1, 1) as unknown as THREE.CanvasTexture;
    sharedConeGradTex.userData.sharedAsset = true;
    return sharedConeGradTex;
  }
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Soft radial/longitudinal falloff so ground awareness never looks like a harsh arcade triangle
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0.0, 'rgba(255,255,255,0.65)');
    grad.addColorStop(0.35, 'rgba(255,255,255,0.38)');
    grad.addColorStop(0.78, 'rgba(255,255,255,0.14)');
    grad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 128);

    // Feather lateral cone edges gently
    ctx.globalCompositeOperation = 'destination-in';
    const edgeGrad = ctx.createLinearGradient(0, 0, 64, 0);
    edgeGrad.addColorStop(0.0, 'rgba(255,255,255,0.0)');
    edgeGrad.addColorStop(0.14, 'rgba(255,255,255,1.0)');
    edgeGrad.addColorStop(0.86, 'rgba(255,255,255,1.0)');
    edgeGrad.addColorStop(1.0, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = edgeGrad;
    ctx.fillRect(0, 0, 64, 128);
  }
  sharedConeGradTex = new THREE.CanvasTexture(canvas);
  sharedConeGradTex.userData.sharedAsset = true;
  sharedConeGradTex.needsUpdate = true;
  return sharedConeGradTex;
}

function drawSleekGuardIndicator(
  canvas: HTMLCanvasElement,
  symbol: string,
  subLabel: string,
  colorHex: string,
  progress01: number
): THREE.CanvasTexture {
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Compact dark frosted pill with thin accent line + optional radial gauge
    const padX = 12;
    const padY = 10;
    const w = canvas.width - padX * 2;
    const h = canvas.height - padY * 2;

    ctx.fillStyle = 'rgba(8, 12, 22, 0.84)';
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.roundRect(padX, padY, w, h, 14);
    ctx.fill();
    ctx.stroke();

    // Progress bar underline
    if (progress01 > 0.01) {
      const barW = (w - 20) * clamp(progress01, 0, 1);
      ctx.fillStyle = colorHex;
      ctx.fillRect(padX + 10, padY + h - 7, barW, 4);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (subLabel) {
      ctx.font = 'bold 21px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = colorHex;
      ctx.fillText(`${symbol} ${subLabel}`.trim(), canvas.width / 2, canvas.height / 2 - 2);
    } else {
      ctx.font = 'bold 28px ui-sans-serif, system-ui, sans-serif';
      ctx.fillStyle = colorHex;
      ctx.fillText(symbol, canvas.width / 2, canvas.height / 2 - 1);
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function findClip(
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

export class GuardSystem {
  public readonly root = new THREE.Group();
  private target: HeistTarget;
  private guards: GuardEntity[] = [];
  private cameras: CameraEntity[] = [];

  // Persistent guard AI states (used directly during scouting trespassing & standalone execution)
  private scoutingGuardStates: LiveGuardState[];
  private latestGuardStates: LiveGuardState[];
  private latestTelemetry: StealthTelemetry = {
    lightExposure: 0.5,
    noiseDb: 24,
    highestSuspicion: 0,
    suspicionSourceAngle: null,
    suspicionGuardId: null,
    guardState: null,
    radioInterruptWindowSec: null,
    carryWeightPenalty: 0,
  };

  constructor(target: HeistTarget) {
    this.target = target;
    this.root.name = 'GuardSystem';
    this.scoutingGuardStates = createGuardStatesForTarget(target);
    this.latestGuardStates = structuredClone(this.scoutingGuardStates);
    this.buildGuards();
    this.buildCameras();
  }

  private buildGuards(): void {
    const gradTex = getConeGradientTexture();
    const sharedClips = assetRegistry.getAnimationClips('character_guard');

    for (const gDef of this.target.guards) {
      const entityRoot = new THREE.Group();
      entityRoot.name = `Guard_${gDef.id}`;

      const model = assetRegistry.instantiateModel('character_guard', true);
      entityRoot.add(model);

      // Grab sculpted GLB emissive materials so each guard pulses radio LED & flashlight lens independently
      let radioLedMat: THREE.MeshStandardMaterial | null = null;
      let flashlightLensMat: THREE.MeshStandardMaterial | null = null;
      model.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (m instanceof THREE.MeshStandardMaterial) {
              if (m.name === 'Guard_RadioLED') radioLedMat = m;
              else if (m.name === 'Guard_FlashlightLens') flashlightLensMat = m;
            }
          }
        }
      });

      const pelvis = model.getObjectByName('Pelvis');
      const rig: GuardRig = {
        pelvis,
        torso: model.getObjectByName('Torso'),
        head: model.getObjectByName('Head'),
        armL: model.getObjectByName('Arm_L'),
        armR: model.getObjectByName('Arm_R'),
        legL: model.getObjectByName('Leg_L'),
        legR: model.getObjectByName('Leg_R'),
        pelvisBaseY: pelvis ? pelvis.position.y : 0.9,
      };

      // Setup skeletal AnimationMixer for character_guard.glb clips
      const modelClips =
        (Array.isArray(model.userData?.animations) && model.userData.animations.length > 0
          ? (model.userData.animations as THREE.AnimationClip[])
          : sharedClips) ?? [];

      let mixer: THREE.AnimationMixer | null = null;
      const actions: Partial<Record<GuardClipName, THREE.AnimationAction>> = {};
      if (modelClips.length > 0) {
        mixer = new THREE.AnimationMixer(model);
        const mappings: Array<[GuardClipName, string[]]> = [
          ['Idle', ['Idle', 'Stand']],
          ['PatrolWalk', ['PatrolWalk', 'Walk']],
          ['SuspiciousLook', ['SuspiciousLook', 'Suspicious', 'Alert']],
          ['FlashlightSweep', ['FlashlightSweep', 'Sweep', 'Search']],
          ['RadioCall', ['RadioCall', 'Radio', 'Interact']],
          ['Sprint', ['Sprint', 'Run', 'Chase']],
        ];
        for (const [key, names] of mappings) {
          const clip = findClip(modelClips, names);
          if (clip) {
            actions[key] = mixer.clipAction(clip);
          }
        }
      }

      // 1) Wall-clipped subtle ground awareness fan (dynamically raycasted against solid walls!)
      const coneGeo = createDynamicFanGeometry(FAN_SEGMENTS);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xfde68a,
        map: gradTex,
        transparent: true,
        opacity: 0.11,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coneMesh = new THREE.Mesh(coneGeo, coneMat);
      coneMesh.position.y = 0.05;
      coneMesh.renderOrder = 8;
      coneMesh.userData.excludeFromAO = true;
      entityRoot.add(coneMesh);

      // 2) Realistic Volumetric Flashlight Beam (Fresnel shader + real SpotLight!)
      // Parent directly to the rigged `Flashlight` bone (+Z out of lens) when present on character_guard.glb!
      const flashlightBone = model.getObjectByName('Flashlight');
      const flashlightAttachedToBone = Boolean(flashlightBone);
      const flashlightPivot = new THREE.Group();
      flashlightPivot.name = `GuardFlashlight_${gDef.id}`;
      if (flashlightBone) {
        flashlightPivot.position.set(0, 0, 0.12);
      } else {
        flashlightPivot.position.set(-0.22, 1.26, 0.24);
      }
      flashlightPivot.userData.excludeFromAO = true;

      const flashlightCone = createVolumetricLightCone({
        preset: 'flashlight',
        color: 0xfef3c7,
        length: 7.4,
        topRadius: 0.055,
        bottomRadius: 1.28,
        opacity: 0.18,
        fresnelPower: 2.5,
        attenuation: 1.85,
        axis: '+z',
      });
      flashlightPivot.add(flashlightCone.mesh);

      const flashlightSpot = new THREE.SpotLight(
        0xfff2d6,
        14,
        13.5,
        Math.PI * 0.21,
        0.65,
        1.55
      );
      flashlightSpot.castShadow = false;
      flashlightSpot.position.set(0, 0, 0.05);
      const flashlightTarget = new THREE.Object3D();
      flashlightTarget.position.set(0, flashlightAttachedToBone ? -0.25 : -0.55, 6.5);
      flashlightPivot.add(flashlightTarget);
      flashlightSpot.target = flashlightTarget;
      flashlightPivot.add(flashlightSpot);

      if (flashlightBone) {
        flashlightBone.add(flashlightPivot);
      } else {
        entityRoot.add(flashlightPivot);
      }

      // Subtle glowing shoulder lapel radio LED fallback (hidden when GLB has sculpted Guard_RadioLED!)
      const shoulderRadioLed = new THREE.Mesh(
        new THREE.SphereGeometry(0.032, 8, 8),
        new THREE.MeshStandardMaterial({
          color: 0xef4444,
          emissive: 0xef4444,
          emissiveIntensity: 3.2,
          roughness: 0.2,
        })
      );
      shoulderRadioLed.position.set(0.18, 1.44, 0.14);
      shoulderRadioLed.visible = false;
      entityRoot.add(shoulderRadioLed);

      // Minimal ground ring ONLY visible when actively timing this guard in scouting
      const ringGeo = new THREE.RingGeometry(0.56, 0.7, 28);
      ringGeo.rotateX(-Math.PI / 2);
      const timedRingMat = new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.0,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const timedRing = new THREE.Mesh(ringGeo, timedRingMat);
      timedRing.position.y = 0.04;
      timedRing.userData.excludeFromAO = true;
      entityRoot.add(timedRing);

      // Depth-tested sleek status indicator (NEVER bleeds through walls; hidden during calm patrol!)
      const badgeCanvas =
        typeof document !== 'undefined' ? document.createElement('canvas') : null;
      if (badgeCanvas) {
        badgeCanvas.width = 256;
        badgeCanvas.height = 68;
      }
      const badgeSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          transparent: true,
          depthTest: true,
          depthWrite: false,
        })
      );
      badgeSprite.position.set(0, 2.18, 0);
      badgeSprite.scale.set(1.22, 0.34, 1);
      badgeSprite.visible = false;
      entityRoot.add(badgeSprite);

      const wp0 = gDef.waypoints[0] ?? { pos: { x: 0, z: 0 }, floor: 0 as FloorId, lookAngleDeg: 0 };
      const rotY = headingDegToRotY(wp0.lookAngleDeg ?? 0);
      entityRoot.position.set(wp0.pos.x, wp0.floor * this.target.floorHeightM, wp0.pos.z);
      entityRoot.rotation.y = rotY;

      this.root.add(entityRoot);

      const entity: GuardEntity = {
        def: gDef,
        root: entityRoot,
        model,
        rig,
        mixer,
        actions,
        activeClip: null,
        coneMesh,
        coneGeo,
        coneMat,
        coneSegments: FAN_SEGMENTS,
        flashlightPivot,
        flashlightAttachedToBone,
        flashlightCone,
        flashlightSpot,
        flashlightTarget,
        shoulderRadioLed,
        radioLedMat,
        flashlightLensMat,
        timedRing,
        timedRingMat,
        badgeSprite,
        badgeCanvas,
        lastBadgeKey: '',
        currentPos: { ...wp0.pos },
        currentFloor: wp0.floor,
        currentRotY: rotY,
        currentSpeed: 0,
        walkPhase: Math.random() * Math.PI * 2,
        flashlightYawLocal: 0,
        flashlightLenSmooth: 7.4,
        prevState: 'patrol',
      };

      if (entity.actions.Idle) {
        entity.actions.Idle.play();
        entity.activeClip = 'Idle';
      }

      this.guards.push(entity);
    }
  }

  private buildCameras(): void {
    const gradTex = getConeGradientTexture();
    const camNodes = this.target.nodes.filter((n) => n.kind === 'camera');

    for (const node of camNodes) {
      const entityRoot = new THREE.Group();
      entityRoot.name = `Camera_${node.id}`;
      const fy = node.floor * this.target.floorHeightM;
      entityRoot.position.set(node.pos.x, fy, node.pos.z);

      const baseMountRotY = headingDegToRotY(node.cameraHeadingDeg ?? 0);

      // Wall-mounted security camera model at ceiling height
      const model = assetRegistry.instantiateModel('security_camera', true);
      model.position.set(0, 2.72, 0);
      model.rotation.y = baseMountRotY;
      entityRoot.add(model);

      const headPivot = model.getObjectByName('Camera_Head') ?? null;
      const ledMesh = (model.getObjectByName('Camera_LED') as THREE.Mesh) ?? null;

      // Wall-clipped dynamic CCTV ground awareness fan (NEVER pierces walls!)
      const coneGeo = createDynamicFanGeometry(FAN_SEGMENTS);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xfb7185,
        map: gradTex,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coneMesh = new THREE.Mesh(coneGeo, coneMat);
      coneMesh.position.y = 0.05;
      coneMesh.renderOrder = 8;
      coneMesh.userData.excludeFromAO = true;
      entityRoot.add(coneMesh);

      this.root.add(entityRoot);
      this.cameras.push({
        node,
        root: entityRoot,
        model,
        headPivot,
        ledMesh,
        coneMesh,
        coneGeo,
        coneMat,
        coneSegments: FAN_SEGMENTS,
        baseMountRotY,
      });
    }
  }

  public getGuardWorldInfo(): Array<{
    guardId: string;
    name: string;
    pos: Vec2;
    floor: FloorId;
    headingDeg: number;
    state: GuardAIState;
    suspicion: number;
    calloutText?: string;
    radioProgress?: number;
  }> {
    return this.guards.map((g) => {
      const st = this.latestGuardStates.find((s) => s.guardId === g.def.id);
      return {
        guardId: g.def.id,
        name: g.def.name,
        pos: { ...g.currentPos },
        floor: g.currentFloor,
        headingDeg: st?.headingDeg ?? 0,
        state: st?.state ?? 'patrol',
        suspicion: Math.round(st?.suspicion ?? 0),
        calloutText: st?.calloutText,
        radioProgress: st?.radioProgress,
      };
    });
  }

  public getGuardSnapshots(): LiveGuardState[] {
    return structuredClone(this.latestGuardStates);
  }

  public getStealthTelemetry(playerPos?: Vec2, playerFloor?: FloorId): StealthTelemetry {
    if (!playerPos) return { ...this.latestTelemetry };

    let highestSuspicion = 0;
    let suspicionSourceAngle: number | null = null;
    let suspicionGuardId: string | null = null;
    let guardState: GuardAIState | null = null;
    let radioInterruptWindowSec: number | null = null;

    for (const st of this.latestGuardStates) {
      if (st.state === 'radioing') {
        const dur = st.radioDurationSec ?? 3.5;
        const rem = Math.max(0, (1 - (st.radioProgress ?? 0)) * dur);
        if (radioInterruptWindowSec === null || rem < radioInterruptWindowSec) {
          radioInterruptWindowSec = Math.round(rem * 10) / 10;
        }
      }
      const eff =
        st.state === 'radioing' || st.state === 'pursuit'
          ? Math.max(st.suspicion, 95)
          : st.suspicion;
      if (eff > highestSuspicion) {
        highestSuspicion = eff;
        suspicionGuardId = st.guardId;
        guardState = st.state;
        if (playerFloor === undefined || st.floor === playerFloor) {
          suspicionSourceAngle = headingBetween(playerPos, st.pos);
        }
      }
    }

    return {
      ...this.latestTelemetry,
      highestSuspicion: Math.round(highestSuspicion),
      suspicionSourceAngle: highestSuspicion >= 8 ? suspicionSourceAngle : null,
      suspicionGuardId: highestSuspicion >= 8 ? suspicionGuardId : null,
      guardState: highestSuspicion >= 8 ? guardState : null,
      radioInterruptWindowSec,
    };
  }

  private transitionGuardClip(
    g: GuardEntity,
    clipName: GuardClipName,
    timeScale = 1.0
  ): void {
    if (!g.mixer) return;
    const action =
      g.actions[clipName] ??
      (clipName === 'Sprint' ? g.actions.PatrolWalk : undefined) ??
      (clipName === 'FlashlightSweep' ? g.actions.SuspiciousLook : undefined) ??
      g.actions.Idle ??
      g.actions.PatrolWalk;
    if (!action) return;

    action.timeScale = timeScale;
    if (g.activeClip === clipName) return;

    const prev = g.activeClip ? g.actions[g.activeClip] : undefined;
    action.reset();
    action.enabled = true;
    if (prev && prev !== action) {
      prev.crossFadeTo(action, 0.22, false);
    } else {
      action.fadeIn(0.18);
    }
    action.play();
    g.activeClip = clipName;
  }

  private animateProceduralFallback(
    g: GuardEntity,
    state: GuardAIState,
    speed: number,
    dt: number,
    timeSec: number,
    sweepAngleRad: number
  ): void {
    const { rig } = g;

    if (state === 'radioing') {
      // Left hand reaches up to shoulder lapel mic; right hand keeps tactical flashlight aimed forward!
      if (rig.legL) rig.legL.rotation.x *= 0.82;
      if (rig.legR) rig.legR.rotation.x *= 0.82;
      if (rig.armL) rig.armL.rotation.x = -2.15;
      if (rig.armR) rig.armR.rotation.x = -0.82;
      if (rig.torso) rig.torso.rotation.x = 0.08;
      if (rig.head) rig.head.rotation.y = 0.16;
      if (rig.pelvis) rig.pelvis.position.y = rig.pelvisBaseY;
      return;
    }

    if (speed > 0.15) {
      const isSprint = state === 'pursuit' || state === 'chasing' || speed > 2.4;
      g.walkPhase += dt * clamp(isSprint ? 10.5 : 4.6 + speed * 2.1, 4, 12);
      const amp = isSprint ? 0.68 : 0.45;
      const swing = Math.sin(g.walkPhase) * amp;
      if (rig.legL) rig.legL.rotation.x = swing;
      if (rig.legR) rig.legR.rotation.x = -swing;
      if (rig.armL) rig.armL.rotation.x = -swing * (isSprint ? 0.85 : 0.6);
      // Right arm holds tactical flashlight forward steadily
      if (rig.armR) rig.armR.rotation.x = (isSprint ? -0.78 : -0.62) + swing * 0.14;
      if (rig.torso) rig.torso.rotation.x = isSprint ? 0.16 : 0.04;
      if (rig.pelvis) {
        rig.pelvis.position.y =
          rig.pelvisBaseY + Math.abs(Math.sin(g.walkPhase)) * (isSprint ? 0.055 : 0.032);
      }
      if (rig.head) rig.head.rotation.y = sweepAngleRad * 0.55;
    } else {
      const isAlertSearch =
        state === 'suspicious' || state === 'investigating' || state === 'searching';
      if (rig.legL) rig.legL.rotation.x *= 0.84;
      if (rig.legR) rig.legR.rotation.x *= 0.84;
      if (rig.armL) rig.armL.rotation.x *= 0.84;
      if (rig.armR) rig.armR.rotation.x = isAlertSearch ? -0.88 : -0.52;
      if (rig.torso) rig.torso.rotation.x = isAlertSearch ? 0.12 : 0.0;
      if (rig.pelvis) {
        rig.pelvis.position.y = rig.pelvisBaseY + Math.sin(timeSec * 2.0) * 0.012;
      }
      if (rig.head) {
        rig.head.rotation.y = isAlertSearch
          ? sweepAngleRad * 0.85
          : Math.sin(timeSec * 1.15) * 0.22;
      }
    }
  }

  public update(params: GuardSystemUpdateParams): GuardSystemUpdateResult {
    const {
      dt,
      timeSec,
      phase,
      focusFloor,
      intel,
      liveGuards,
      liveCameras,
      powerDisabled,
      timingGuardId,
      liveState,
      crewById,
      forensicLoadoutByCrew,
      activeBlockTypesByCrew,
      runInternalAI = false,
      playerPos,
      playerFloor = 0,
      playerSneaking = false,
      playerSpeed = 0,
      playerWearingMask = false,
      playerDarkClothing = false,
      binocularsActive = false,
      audio,
    } = params;

    const emptyResult: GuardSystemUpdateResult = {
      guards: this.latestGuardStates,
      events: [],
      newEvidence: [],
      triggersCentralAlarm: false,
      alarmEscalation: null,
      stealthTelemetry: this.latestTelemetry,
    };

    if (phase === 'escape') {
      this.root.visible = false;
      return emptyResult;
    }
    this.root.visible = true;

    let stepEvents: GuardAIEvent[] = [];
    let stepEvidence: EvidenceDraft[] = [];
    let triggersCentralAlarm = false;
    let alarmEscalation: AlarmLevel | null = null;
    let activeStates: LiveGuardState[] = this.latestGuardStates;

    // ------------------------------------------------------------------------
    // 1) Resolve Authoritative Guard AI States (Scouting & Live Execution)
    // ------------------------------------------------------------------------
    if (phase === 'executing' && liveState && runInternalAI && crewById) {
      const actors = buildGuardTargetActors({
        live: liveState,
        crewById,
        forensicLoadoutByCrew,
        activeBlockTypesByCrew,
      });
      const teamHasJammer = Object.values(crewById).some(
        (m) => liveState.crew[m.id] && m.equippedTools.includes('signal_jammer')
      );
      const res = stepGuardsAI({
        guards: liveState.guards,
        actors,
        dtSec: dt,
        ctx: {
          target: this.target,
          elapsedSec: liveState.elapsedSec,
          powerDisabled: liveState.powerDisabled,
          alarmLevel: liveState.alarmLevel,
          unlockedDoorIds: liveState.unlockedDoorIds,
          openedContainerIds: liveState.openedContainerIds,
          brokenGlassNodes: liveState.brokenGlassNodes,
          powerCutRooms: liveState.powerCutRooms,
          roomLightLevels: liveState.roomLightLevels,
          noiseEvents: liveState.noiseEvents,
          teamHasJammer,
          isScoutingPhase: false,
        },
      });
      activeStates = res.guards;
      stepEvents = res.events;
      stepEvidence = res.newEvidence;
      triggersCentralAlarm = res.triggersCentralAlarm;
      alarmEscalation = res.alarmEscalation;
      this.latestTelemetry = res.telemetry;
    } else if (phase === 'executing' && liveGuards && liveGuards.length > 0) {
      activeStates = liveGuards;
      if (liveState?.stealthTelemetry) {
        this.latestTelemetry = liveState.stealthTelemetry;
      }
    } else if (phase === 'scouting') {
      // Run lightweight scouting AI so guards follow A* patrol paths AND react if Mara trespasses indoors!
      const scoutingActors: GuardTargetActor[] = playerPos
        ? [
            {
              crewId: 'mara',
              name: 'Mara Voss',
              pos: { ...playerPos },
              floor: playerFloor,
              speed: playerSpeed,
              sneaking: playerSneaking,
              carryingLootEur: 0,
              doingOvertCrime: false,
              wearingMask: playerWearingMask,
              wearingDisguise: false,
              darkClothing: playerDarkClothing,
            },
          ]
        : [];
      const roomLightLevels = computeRoomLightLevels(this.target, powerDisabled);
      const res = stepGuardsAI({
        guards: this.scoutingGuardStates,
        actors: scoutingActors,
        dtSec: dt,
        ctx: {
          target: this.target,
          elapsedSec: timeSec,
          powerDisabled,
          alarmLevel: 'silent',
          unlockedDoorIds: [],
          openedContainerIds: [],
          brokenGlassNodes: [],
          powerCutRooms: [],
          roomLightLevels,
          noiseEvents: [],
          isScoutingPhase: true,
        },
      });
      this.scoutingGuardStates = res.guards;
      activeStates = res.guards;
      stepEvents = res.events;
      this.latestTelemetry = res.telemetry;
    }

    this.latestGuardStates = activeStates;

    // ------------------------------------------------------------------------
    // 2) Update 3D Guard Meshes, Skeletal Animations, Flashlights & Wall-Clipped Fans
    // ------------------------------------------------------------------------
    for (const g of this.guards) {
      const st = activeStates.find((s) => s.guardId === g.def.id);
      if (!st) continue;

      const guardState: GuardAIState = st.state;
      const suspicion = st.suspicion;
      const targetPos = st.pos;
      const targetFloor = st.floor;
      const targetHeadingDeg = st.headingDeg;

      // Audio cue on entering interruptible radio dispatch!
      if (guardState === 'radioing' && g.prevState !== 'radioing') {
        audio?.playGuardRadioCall?.();
      }
      g.prevState = guardState;

      // Visibility based on floor cutaway
      const floorVisible =
        focusFloor < 0
          ? targetFloor === focusFloor
          : targetFloor >= 0 && targetFloor <= focusFloor;
      g.root.visible = floorVisible;

      // Smooth 3D position interpolation so transitions never stutter
      const rawDx = targetPos.x - g.currentPos.x;
      const rawDz = targetPos.z - g.currentPos.z;
      const stepDist = Math.hypot(rawDx, rawDz);
      const instantSpeed = dt > 0.001 ? stepDist / dt : 0;
      g.currentSpeed = damp(g.currentSpeed, instantSpeed, 10, dt);

      if (targetFloor !== g.currentFloor || stepDist > 4.0) {
        g.currentPos.x = targetPos.x;
        g.currentPos.z = targetPos.z;
      } else {
        g.currentPos.x = damp(g.currentPos.x, targetPos.x, 16, dt);
        g.currentPos.z = damp(g.currentPos.z, targetPos.z, 16, dt);
      }
      g.currentFloor = targetFloor;

      const desiredRotY = headingDegToRotY(targetHeadingDeg);
      g.currentRotY = dampAngleRad(g.currentRotY, desiredRotY, 10, dt);

      g.root.position.set(
        g.currentPos.x,
        g.currentFloor * this.target.floorHeightM,
        g.currentPos.z
      );
      g.root.rotation.y = normalizeAngleRad(g.currentRotY);

      // Realistic left-right head/flashlight sweep when investigating / searching / suspicious
      const isSweeping =
        (guardState === 'investigating' ||
          guardState === 'searching' ||
          guardState === 'suspicious') &&
        g.currentSpeed < 0.35;
      const desiredSweep = isSweeping
        ? Math.sin(timeSec * (guardState === 'searching' ? 2.4 : 1.75)) * 0.42
        : 0;
      g.flashlightYawLocal = damp(g.flashlightYawLocal, desiredSweep, 8, dt);

      // Skeletal AnimationMixer state blending OR procedural fallback
      if (g.mixer) {
        let clip: GuardClipName = 'Idle';
        let timeScale = 1.0;
        if (guardState === 'radioing') {
          clip = 'RadioCall';
        } else if ((guardState === 'pursuit' || guardState === 'chasing' || guardState === 'alerted') && g.currentSpeed > 0.35) {
          clip = 'Sprint';
          timeScale = clamp(g.currentSpeed / 2.8, 0.9, 1.45);
        } else if (g.currentSpeed > 0.18) {
          clip = 'PatrolWalk';
          timeScale = clamp(g.currentSpeed / Math.max(1.2, g.def.speedMps), 0.75, 1.35);
        } else if (guardState === 'searching' || guardState === 'investigating') {
          clip = 'FlashlightSweep';
        } else if (guardState === 'suspicious') {
          clip = 'SuspiciousLook';
        } else {
          clip = 'Idle';
        }
        this.transitionGuardClip(g, clip, timeScale);
        g.mixer.update(dt);
      } else {
        this.animateProceduralFallback(
          g,
          guardState,
          g.currentSpeed,
          dt,
          timeSec,
          g.flashlightYawLocal
        );
      }

      // Shoulder lapel radio blink during interruptible radio call!
      const radioBlinkOn = guardState === 'radioing' && Math.sin(timeSec * 16) > -0.2;
      if (g.radioLedMat) {
        g.shoulderRadioLed.visible = false;
        if (guardState === 'radioing') {
          g.radioLedMat.emissive.setHex(0xef4444);
          g.radioLedMat.emissiveIntensity = radioBlinkOn ? 4.2 : 0.4;
        } else {
          g.radioLedMat.emissive.setHex(0x22c55e);
          g.radioLedMat.emissiveIntensity = 0.85;
        }
      } else {
        g.shoulderRadioLed.visible = radioBlinkOn;
      }

      // Volumetric Flashlight Beam + real SpotLight (wall-clipped beam length!)
      const flashlightActive = Boolean(
        st.flashlightOn || powerDisabled || guardState !== 'patrol'
      );
      if (g.flashlightLensMat) {
        g.flashlightLensMat.emissive.setHex(0xfff1c4);
        g.flashlightLensMat.emissiveIntensity = flashlightActive ? 3.2 : 0.06;
      }
      g.flashlightPivot.visible = floorVisible && flashlightActive;
      if (flashlightActive && floorVisible) {
        // When attached to the rigged Flashlight bone, skeletal animation drives sweep naturally!
        g.flashlightPivot.rotation.y = g.flashlightAttachedToBone ? 0 : g.flashlightYawLocal;
        const beamWorldHeadingRad =
          (targetHeadingDeg * DEG2RAD) - (g.flashlightAttachedToBone ? 0 : g.flashlightYawLocal);
        const wallDist = raycastSolidWalls(
          g.currentPos,
          Math.cos(beamWorldHeadingRad),
          Math.sin(beamWorldHeadingRad),
          7.4,
          g.currentFloor,
          this.target.walls
        );
        g.flashlightLenSmooth = damp(g.flashlightLenSmooth, Math.max(0.8, wallDist), 14, dt);
        const lenScale = g.flashlightLenSmooth / 7.4;
        g.flashlightCone.mesh.scale.set(1, 1, lenScale);
        g.flashlightCone.update(timeSec);

        // Tint flashlight subtly warmer in dark power-cut rooms, red-tinted on full pursuit
        if (guardState === 'radioing' || guardState === 'pursuit' || guardState === 'alerted') {
          g.flashlightCone.setColor(0xffd4c4);
          g.flashlightCone.setIntensity(1.15);
          g.flashlightSpot.intensity = powerDisabled ? 22 : 15;
        } else if (guardState === 'investigating' || guardState === 'searching') {
          g.flashlightCone.setColor(0xfff1c4);
          g.flashlightCone.setIntensity(1.05);
          g.flashlightSpot.intensity = powerDisabled ? 20 : 13;
        } else {
          g.flashlightCone.setColor(0xeef4ff);
          g.flashlightCone.setIntensity(powerDisabled ? 1.0 : 0.72);
          g.flashlightSpot.intensity = powerDisabled ? 18 : 9;
        }
      }

      // Wall-clipped subtle ground awareness fan
      if (floorVisible) {
        const displayRange =
          powerDisabled && !flashlightActive
            ? g.def.visionRange * 0.48
            : powerDisabled
              ? g.def.visionRange * 0.72
              : g.def.visionRange;

        updateWallClippedFanGeometry({
          geo: g.coneGeo,
          segments: g.coneSegments,
          origin: g.currentPos,
          floor: g.currentFloor,
          headingDeg: targetHeadingDeg,
          entityRotY: g.currentRotY,
          range: displayRange,
          coneDeg: g.def.visionConeDeg,
          walls: this.target.walls,
        });

        if (guardState === 'radioing') {
          g.coneMat.color.setHex(0xef4444);
          g.coneMat.opacity = 0.24 + Math.sin(timeSec * 14) * 0.08;
        } else if (guardState === 'pursuit' || guardState === 'alerted' || guardState === 'chasing') {
          g.coneMat.color.setHex(0xef4444);
          g.coneMat.opacity = 0.22 + Math.sin(timeSec * 9) * 0.06;
        } else if (
          guardState === 'investigating' ||
          guardState === 'searching' ||
          guardState === 'suspicious' ||
          suspicion >= 20
        ) {
          g.coneMat.color.setHex(0xf59e0b);
          g.coneMat.opacity = 0.18;
        } else {
          g.coneMat.color.setHex(0xfde68a);
          g.coneMat.opacity = phase === 'scouting' && !binocularsActive ? 0.09 : 0.12;
        }
      }

      // Minimal diegetic status indicators (zero permanent arcade clutter!)
      if (phase === 'executing') {
        g.timedRingMat.opacity = 0;
        if (guardState === 'radioing') {
          const prog = st.radioProgress ?? 0;
          const rem = Math.max(0, (1 - prog) * (st.radioDurationSec ?? 3.5));
          this.setGuardIndicator(g, '!', `FUNK ${rem.toFixed(1)}s`, '#ef4444', prog);
        } else if (guardState === 'pursuit' || guardState === 'alerted' || guardState === 'chasing') {
          this.setGuardIndicator(g, '!', 'VERFOLGT', '#ef4444', 1);
        } else if (guardState === 'searching') {
          this.setGuardIndicator(g, '?', 'SUCHT', '#f97316', 0.75);
        } else if (guardState === 'investigating') {
          const reasonTag =
            st.investigateReason === 'power'
              ? 'STROM?'
              : st.investigateReason === 'door'
                ? 'TÜR?'
                : st.investigateReason === 'noise'
                  ? 'LÄRM?'
                  : 'PRÜFT';
          this.setGuardIndicator(g, '?', reasonTag, '#f59e0b', clamp(suspicion / 100, 0.3, 1));
        } else if (guardState === 'suspicious' || suspicion >= 18) {
          this.setGuardIndicator(g, '?', `${Math.round(suspicion)}%`, '#fbbf24', suspicion / 100);
        } else {
          g.badgeSprite.visible = false;
        }
      } else {
        // Scouting phase: hide all arcade rings/pills UNLESS actively timing, trespassing, or using binoculars!
        const isTimed = intel.timedGuardIds.includes(g.def.id);
        const isTimingNow = timingGuardId === g.def.id;
        const nearPlayer =
          playerPos !== undefined &&
          Math.hypot(playerPos.x - g.currentPos.x, playerPos.z - g.currentPos.z) < 7.5;

        if (suspicion >= 22 || guardState === 'investigating' || guardState === 'suspicious') {
          g.timedRingMat.opacity = 0;
          this.setGuardIndicator(g, '!', 'ZUTRITT VERBOTEN', '#f59e0b', suspicion / 100);
        } else if (isTimingNow) {
          g.timedRingMat.color.setHex(0x38bdf8);
          g.timedRingMat.opacity = 0.65;
          this.setGuardIndicator(g, '●', 'STOPPT ROUTE…', '#38bdf8', 0.65);
        } else if (binocularsActive || nearPlayer) {
          g.timedRingMat.opacity = 0;
          if (isTimed) {
            this.setGuardIndicator(g, '✓', 'GETIMET', '#2dd4bf', 1);
          } else {
            this.setGuardIndicator(g, '◉', 'WACHE [E]', '#fbbf24', 0);
          }
        } else {
          g.timedRingMat.opacity = 0;
          g.badgeSprite.visible = false;
        }
      }
    }

    // ------------------------------------------------------------------------
    // 3) Update CCTV Cameras (with Wall-Clipped Dynamic Sweeping Cones!)
    // ------------------------------------------------------------------------
    for (const c of this.cameras) {
      const lc = liveCameras?.find((s) => s.nodeId === c.node.id);
      const isActive =
        phase === 'executing' ? (lc ? lc.active : !powerDisabled) : !powerDisabled;
      const headingDeg =
        phase === 'executing' && lc
          ? lc.headingDeg
          : sampleCameraHeading(c.node, timeSec);
      const suspicion = lc?.suspicion ?? 0;

      const floorVisible =
        focusFloor < 0
          ? c.node.floor === focusFloor
          : c.node.floor >= 0 && c.node.floor <= focusFloor;
      c.root.visible = floorVisible;

      const worldRotY = headingDegToRotY(headingDeg);
      if (c.headPivot) {
        c.headPivot.rotation.y = worldRotY - c.baseMountRotY;
      }

      c.coneMesh.visible = floorVisible && isActive;
      if (floorVisible && isActive) {
        updateWallClippedFanGeometry({
          geo: c.coneGeo,
          segments: c.coneSegments,
          origin: c.node.pos,
          floor: c.node.floor,
          headingDeg,
          entityRotY: 0,
          range: c.node.cameraRange ?? 10,
          coneDeg: 55,
          walls: this.target.walls,
        });

        if (suspicion > 35) {
          c.coneMat.color.setHex(0xef4444);
          c.coneMat.opacity = 0.28 + Math.sin(timeSec * 12) * 0.06;
        } else {
          c.coneMat.color.setHex(0xfb7185);
          c.coneMat.opacity = 0.13;
        }
      }

      if (c.ledMesh && c.ledMesh.material instanceof THREE.MeshStandardMaterial) {
        if (!isActive) {
          c.ledMesh.material.emissiveIntensity = 0;
        } else {
          c.ledMesh.material.emissiveIntensity = 1.6 + Math.sin(timeSec * 6) * 1.2;
        }
      }
    }

    return {
      guards: activeStates,
      events: stepEvents,
      newEvidence: stepEvidence,
      triggersCentralAlarm,
      alarmEscalation,
      stealthTelemetry: this.getStealthTelemetry(playerPos, playerFloor),
    };
  }

  private setGuardIndicator(
    g: GuardEntity,
    symbol: string,
    subLabel: string,
    colorHex: string,
    progress01: number
  ): void {
    g.badgeSprite.visible = true;
    if (!g.badgeCanvas) return;
    const quantized = Math.round(clamp(progress01, 0, 1) * 16);
    const key = `${symbol}|${subLabel}|${colorHex}|${quantized}`;
    if (g.lastBadgeKey === key) return;
    g.lastBadgeKey = key;
    const mat = g.badgeSprite.material as THREE.SpriteMaterial;
    if (mat.map) mat.map.dispose();
    mat.map = drawSleekGuardIndicator(
      g.badgeCanvas,
      symbol,
      subLabel,
      colorHex,
      quantized / 16
    );
    mat.needsUpdate = true;
  }

  public dispose(): void {
    for (const g of this.guards) {
      if (g.mixer) {
        g.mixer.stopAllAction();
      }
      g.flashlightCone.dispose();
    }
    disposeSceneSubtree(this.root);
  }
}
