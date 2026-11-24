import * as THREE from 'three';
import {
  AlarmLevel,
  FloorId,
  HeistTarget,
  IntelState,
  TargetNode,
  Vec2,
} from '../sim/types';
import { assetRegistry, disposeSceneSubtree, PbrTextureMaps } from './assetLoader';
import {
  createStreetlampLight,
  createVolumetricLightCone,
  createWetSurfaceMaterial,
  type VolumetricConeHandle,
  type WetSurfaceMaterialHandle,
} from './rendering';
import {
  AabbCollider,
  SegmentCollider,
  buildWallColliders,
  dist2D,
  headingDegToRotY,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — Round 2 Photorealistic 3D Level & Coastal Night City Builder
// Full multi-map PBR surfaces (albedo/normal/roughness/ao), wet puddle asphalt
// & plaza shaders, Fresnel volumetric streetlamps/sconces, hinged detailed
// doors, Mediterranean cafe terraces/curbs, diegetic fascia signage, subtle
// proximity-only world markers, and continuous light/shadow exposure sampling.
// ============================================================================

export interface NodeVisualHandle {
  node: TargetNode;
  group: THREE.Group;
  propRoot: THREE.Group;
  ringMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  labelSprite: THREE.Sprite;
  labelCanvas: HTMLCanvasElement;
  lastLabelText: string;
  lastLabelColor: string;
  openedAmount: number;
  floor: FloorId;
}

interface ActiveLightSource {
  x: number;
  z: number;
  floor: FloorId;
  radius: number;
  intensity: number;
  isTargetPowerLinked: boolean;
}

export interface BuiltLevel {
  root: THREE.Group;
  target: HeistTarget;
  floorGroups: Map<FloorId, THREE.Group>;
  nodeVisuals: Map<string, NodeVisualHandle>;
  wallColliders: SegmentCollider[];
  cityBoxColliders: AabbCollider[];
  safehousePos: Vec2;
  safehouseBeacon: THREE.Group;
  wetMaterials: WetSurfaceMaterialHandle[];
  volumetricCones: VolumetricConeHandle[];
  palmCanopies: Array<{ obj: THREE.Object3D; phase: number }>;
  targetPowerLights: Array<{ light: THREE.PointLight; baseIntensity: number }>;
  targetPowerEmissives: Array<{ mat: THREE.MeshStandardMaterial; baseIntensity: number }>;
  alarmLights: THREE.PointLight[];
  waterMesh: THREE.Mesh | null;
  setFocusFloor: (floor: FloorId) => void;
  setPowerDisabled: (disabled: boolean) => void;
  /** Samples real continuous physical light exposure (0.08 dark shadow .. 1.0 bright lamp) */
  getLightExposureAt: (pos: Vec2, floor: FloorId, powerDisabled: boolean) => number;
  /** Samples ground surface type for surface-aware footsteps */
  getSurfaceAt: (pos: Vec2, floor: FloorId) => 'asphalt' | 'stone' | 'marble' | 'metal' | 'wood';
  update: (params: {
    dt: number;
    timeSec: number;
    phase: 'scouting' | 'executing' | 'escape';
    intel: IntelState;
    completedNodeIds: string[];
    unlockedDoorIds?: string[];
    openedContainerIds?: string[];
    triggeredHazardIds: string[];
    powerDisabled: boolean;
    alarmLevel: AlarmLevel;
    highlightedNodeId: string | null;
    workingNodeIds: Set<string>;
    playerPos?: Vec2;
    binocularsActive?: boolean;
  }) => void;
  dispose: () => void;
}

function makeLabelTexture(
  canvas: HTMLCanvasElement,
  text: string,
  accentHex: string,
  subText?: string
): THREE.CanvasTexture {
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.fillStyle = 'rgba(7, 11, 22, 0.84)';
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 2.5;
    const pad = 8;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    const r = 10;
    ctx.beginPath();
    ctx.roundRect(pad, pad, w, h, r);
    ctx.fill();
    ctx.stroke();

    const maxTextW = w - 26;
    const drawFittedText = (
      str: string,
      y: number,
      baseSize: number,
      minSize: number,
      fontFamily: string,
      color: string
    ) => {
      let size = baseSize;
      ctx.font = `600 ${size}px ${fontFamily}`;
      while (size > minSize && ctx.measureText(str).width > maxTextW) {
        size -= 1;
        ctx.font = `600 ${size}px ${fontFamily}`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(str, canvas.width / 2, y, maxTextW);
    };

    drawFittedText(
      text,
      subText ? canvas.height * 0.37 : canvas.height * 0.5,
      20,
      12,
      'ui-sans-serif, system-ui, sans-serif',
      '#f1f5f9'
    );

    if (subText) {
      drawFittedText(
        subText,
        canvas.height * 0.68,
        15,
        11,
        'ui-monospace, SFMono-Regular, monospace',
        accentHex
      );
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createFasciaSignTexture(
  title: string,
  subtitle: string,
  accentHex: string,
  isDresden: boolean
): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 144;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    // Brushed architectural bronze / dark slate fascia plaque
    const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grad.addColorStop(0, isDresden ? '#211c17' : '#121927');
    grad.addColorStop(1, isDresden ? '#13100d' : '#090e18');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 4;
    ctx.strokeRect(6, 6, canvas.width - 12, canvas.height - 12);

    const drawFit = (str: string, y: number, startSize: number, font: string, color: string) => {
      let sz = startSize;
      ctx.font = `700 ${sz}px ${font}`;
      while (sz > 14 && ctx.measureText(str).width > canvas.width - 56) {
        sz -= 2;
        ctx.font = `700 ${sz}px ${font}`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(str, canvas.width / 2, y, canvas.width - 56);
    };

    drawFit(
      title.toUpperCase(),
      56,
      40,
      isDresden ? 'Georgia, serif' : 'ui-sans-serif, system-ui, sans-serif',
      '#f8fafc'
    );
    drawFit(
      subtitle,
      106,
      20,
      'ui-monospace, SFMono-Regular, monospace',
      accentHex
    );
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

function createSkylineWindowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, 256, 256);
    for (let row = 12; row < 244; row += 18) {
      for (let col = 10; col < 246; col += 16) {
        const seed = Math.sin(row * 13.7 + col * 31.3) * 43758.5453;
        const r = seed - Math.floor(seed);
        if (r > 0.72) {
          ctx.fillStyle = r > 0.9 ? 'rgba(125, 211, 252, 0.55)' : 'rgba(255, 196, 118, 0.65)';
          ctx.fillRect(col, row, 9, 10);
        } else if (r > 0.55) {
          ctx.fillStyle = 'rgba(30, 41, 59, 0.5)';
          ctx.fillRect(col, row, 9, 10);
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function updateLabelSprite(
  handle: NodeVisualHandle,
  text: string,
  accentHex: string,
  subText?: string
): void {
  const key = `${text}|${subText ?? ''}`;
  if (handle.lastLabelText === key && handle.lastLabelColor === accentHex) return;
  handle.lastLabelText = key;
  handle.lastLabelColor = accentHex;

  const mat = handle.labelSprite.material as THREE.SpriteMaterial;
  if (mat.map) mat.map.dispose();
  mat.map = makeLabelTexture(handle.labelCanvas, text, accentHex, subText);
  mat.needsUpdate = true;
}

function makePbrStandardMaterial(
  maps: PbrTextureMaps,
  options: {
    color?: THREE.ColorRepresentation;
    roughness?: number;
    metalness?: number;
    normalScale?: number;
    aoMapIntensity?: number;
    envMapIntensity?: number;
  }
): THREE.MeshStandardMaterial {
  const params: THREE.MeshStandardMaterialParameters = {
    color: options.color ?? 0xffffff,
    map: maps.map,
    roughness: options.roughness ?? 1.0,
    metalness: options.metalness ?? 0.04,
    envMapIntensity: options.envMapIntensity ?? 0.85,
  };
  if (maps.normalMap) {
    params.normalMap = maps.normalMap;
    const ns = options.normalScale ?? 0.9;
    params.normalScale = new THREE.Vector2(ns, ns);
  }
  if (maps.roughnessMap) {
    params.roughnessMap = maps.roughnessMap;
  }
  if (maps.aoMap) {
    params.aoMap = maps.aoMap;
    params.aoMapIntensity = options.aoMapIntensity ?? 0.78;
  }
  return new THREE.MeshStandardMaterial(params);
}

function createSkyDome(topHex: string, horizonHex: string): THREE.Mesh {
  const geo = new THREE.SphereGeometry(390, 28, 18);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      uTopColor: { value: new THREE.Color(topHex) },
      uHorizonColor: { value: new THREE.Color(horizonHex) },
    },
    vertexShader: `
      varying vec3 vWorldPos;
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorldPos = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      uniform vec3 uTopColor;
      uniform vec3 uHorizonColor;
      varying vec3 vWorldPos;
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }
      void main() {
        vec3 dir = normalize(vWorldPos);
        float h = clamp(dir.y * 1.5 + 0.06, 0.0, 1.0);
        vec3 col = mix(uHorizonColor, uTopColor, pow(h, 0.62));
        // Subtle coastal moon halo
        vec3 moonDir = normalize(vec3(-0.35, 0.34, 0.87));
        float moon = pow(max(dot(dir, moonDir), 0.0), 64.0);
        col += vec3(0.42, 0.58, 0.85) * moon * 0.4;
        // Subtle distant city sodium light pollution near horizon
        float cityGlow = exp(-abs(dir.y) * 9.5) * 0.14;
        col += vec3(0.75, 0.44, 0.20) * cityGlow;
        if (dir.y > 0.18) {
          vec2 grid = floor(dir.xz / max(0.1, dir.y) * 65.0);
          float star = step(0.994, hash(grid)) * smoothstep(0.18, 0.48, dir.y);
          col += vec3(0.82, 0.9, 1.0) * star * 0.42;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.excludeFromAO = true;
  return mesh;
}

function buildSafehouseBeacon(
  isDresden: boolean,
  volumetricCones: VolumetricConeHandle[]
): { group: THREE.Group; beaconRing: THREE.Mesh; beaconCone: VolumetricConeHandle } {
  const group = new THREE.Group();

  const alleyMaps = assetRegistry.getPbrMaps('brick_alley', 3, 2);
  const garageMat = makePbrStandardMaterial(alleyMaps, {
    color: isDresden ? 0x6f685e : 0x566478,
    roughness: 0.9,
    metalness: 0.12,
    normalScale: 1.0,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x131b29,
    roughness: 0.72,
    metalness: 0.42,
  });

  const backWall = new THREE.Mesh(new THREE.BoxGeometry(16, 6.2, 1.2), garageMat);
  backWall.position.set(0, 3.1, -6.5);
  backWall.castShadow = true;
  backWall.receiveShadow = true;
  group.add(backWall);

  const sideL = new THREE.Mesh(new THREE.BoxGeometry(1.2, 6.2, 14), garageMat);
  sideL.position.set(-7.5, 3.1, 0);
  sideL.castShadow = true;
  group.add(sideL);

  const sideR = new THREE.Mesh(new THREE.BoxGeometry(1.2, 6.2, 14), garageMat);
  sideR.position.set(7.5, 3.1, 0);
  sideR.castShadow = true;
  group.add(sideR);

  const roof = new THREE.Mesh(new THREE.BoxGeometry(17, 0.7, 15.5), roofMat);
  roof.position.set(0, 6.4, 0);
  group.add(roof);

  // Architectural illuminated workshop fascia
  const fasciaTex = createFasciaSignTexture(
    isDresden ? 'ELBUFER VERSTECK' : 'WERKSTATT LA PINEDA',
    'EXTRAKTION · SICHERE ZONE',
    '#2dd4bf',
    isDresden
  );
  const fascia = new THREE.Mesh(
    new THREE.BoxGeometry(11.5, 1.6, 0.24),
    new THREE.MeshStandardMaterial({
      map: fasciaTex,
      emissiveMap: fasciaTex,
      emissive: new THREE.Color(0xffffff),
      emissiveIntensity: 0.95,
      roughness: 0.35,
      metalness: 0.3,
    })
  );
  fascia.position.set(0, 5.4, 7.15);
  group.add(fascia);

  const ringGeo = new THREE.RingGeometry(5.2, 5.75, 44);
  ringGeo.rotateX(-Math.PI / 2);
  const beaconRing = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.72,
      side: THREE.DoubleSide,
    })
  );
  beaconRing.position.set(0, 0.08, 3.0);
  beaconRing.userData.excludeFromAO = true;
  group.add(beaconRing);

  const beaconCone = createVolumetricLightCone({
    preset: 'beacon',
    color: 0x2dd4bf,
    length: 44,
    topRadius: 0.9,
    bottomRadius: 4.8,
    opacity: 0.13,
  });
  beaconCone.mesh.position.set(0, 0.1, 3.0);
  group.add(beaconCone.mesh);
  volumetricCones.push(beaconCone);

  const light = new THREE.PointLight(0xffcf88, 24, 34, 1.5);
  light.position.set(0, 4.8, 2.5);
  group.add(light);

  return { group, beaconRing, beaconCone };
}

function buildArchitecturalProp(node: TargetNode): THREE.Group {
  const g = new THREE.Group();

  if (node.kind === 'safe') {
    g.add(assetRegistry.instantiateModel('safe', true));
    return g;
  }

  if (node.kind === 'loot_case') {
    g.add(assetRegistry.instantiateModel('display_case', true));
    return g;
  }

  if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
    const model = assetRegistry.instantiateModel('power_box', true);
    model.position.y = 0.85;
    if (node.kind === 'alarm_panel') {
      const led = model.getObjectByName('Status_LED') as THREE.Mesh | undefined;
      if (led && led.material instanceof THREE.MeshStandardMaterial) {
        led.material.emissive.setHex(0x38bdf8);
        led.material.color.setHex(0x38bdf8);
      }
    }
    g.add(model);
    return g;
  }

  if (node.kind === 'camera') {
    return g;
  }

  if (node.kind === 'entry_roof' || node.kind === 'entry_cellar') {
    const steelMaps = assetRegistry.getPbrMaps('brushed_steel', 1, 1);
    const frameMat = makePbrStandardMaterial(steelMaps, {
      color: 0x64748b,
      roughness: 0.65,
      metalness: 0.72,
    });
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.64, 0.16, 1.64), frameMat);
    frame.position.y = 0.08;
    frame.receiveShadow = true;
    g.add(frame);

    const hatchPivot = new THREE.Group();
    hatchPivot.name = 'Hatch_Lid';
    hatchPivot.position.set(-0.75, 0.18, 0);
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(1.44, 0.08, 1.44),
      makePbrStandardMaterial(steelMaps, {
        color: 0x475569,
        roughness: 0.55,
        metalness: 0.8,
      })
    );
    lid.position.set(0.75, 0, 0);
    lid.castShadow = true;
    hatchPivot.add(lid);
    g.add(hatchPivot);
    return g;
  }

  if (
    node.kind === 'entry_door' ||
    node.kind === 'entry_service' ||
    node.kind === 'entry_window' ||
    node.kind === 'lock'
  ) {
    const doorModel = assetRegistry.instantiateModel('door_detailed', true);
    // Subtle diegetic LED on door lock housing
    const lockLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.032, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xf59e0b,
        emissiveIntensity: 2.2,
      })
    );
    lockLed.name = 'Lock_LED';
    lockLed.position.set(0.56, 1.18, 0.13);
    doorModel.add(lockLed);
    g.add(doorModel);
    return g;
  }

  if (node.kind === 'hidden_trap') {
    const emitter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.22, 0.06, 12),
      new THREE.MeshStandardMaterial({
        color: 0x334155,
        emissive: 0xef4444,
        emissiveIntensity: 2.2,
        roughness: 0.35,
        metalness: 0.8,
      })
    );
    emitter.name = 'Trap_Emitter';
    emitter.position.y = 0.04;
    g.add(emitter);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 2.2, 8),
      new THREE.MeshBasicMaterial({
        color: 0xef4444,
        transparent: true,
        opacity: 0.72,
      })
    );
    beam.name = 'Trap_Laser';
    beam.rotation.z = Math.PI / 2;
    beam.position.y = 0.65;
    beam.userData.excludeFromAO = true;
    g.add(beam);
    return g;
  }

  if (node.kind === 'stairs') {
    const stoneMaps = assetRegistry.getPbrMaps('stone_plaza', 1, 1);
    const stepMat = makePbrStandardMaterial(stoneMaps, {
      color: 0x64748b,
      roughness: 0.75,
      metalness: 0.15,
    });
    for (let i = 0; i < 5; i++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.18, 0.3), stepMat);
      step.position.set(0, 0.09 + i * 0.2, -0.58 + i * 0.28);
      step.castShadow = true;
      step.receiveShadow = true;
      g.add(step);
    }
    return g;
  }

  if (node.kind === 'lookout') {
    // Subtle diegetic chalk vantage mark on curb instead of floating arcade diamond
    const mark = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.4, 24),
      new THREE.MeshBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.38,
        side: THREE.DoubleSide,
      })
    );
    mark.rotation.x = -Math.PI / 2;
    mark.position.y = 0.04;
    mark.userData.excludeFromAO = true;
    g.add(mark);
    return g;
  }

  if (node.kind === 'getaway_zone') {
    // Subtle painted loading-zone curb outline
    const bay = new THREE.Mesh(
      new THREE.RingGeometry(2.1, 2.22, 4),
      new THREE.MeshBasicMaterial({
        color: 0xeab308,
        transparent: true,
        opacity: 0.22,
        side: THREE.DoubleSide,
      })
    );
    bay.rotation.x = -Math.PI / 2;
    bay.rotation.z = Math.PI / 4;
    bay.position.y = 0.035;
    bay.userData.excludeFromAO = true;
    g.add(bay);
    return g;
  }

  return g;
}

export function buildLevel(target: HeistTarget): BuiltLevel {
  const root = new THREE.Group();
  root.name = `Level_${target.id}`;
  const isDresden = target.city === 'Dresden';
  const envTheme = isDresden ? 'dresden' : 'salou';

  const disposables: Array<{ dispose: () => void }> = [];
  const wetMaterials: WetSurfaceMaterialHandle[] = [];
  const volumetricCones: VolumetricConeHandle[] = [];
  const floorGroups = new Map<FloorId, THREE.Group>();
  const nodeVisuals = new Map<string, NodeVisualHandle>();
  const palmCanopies: Array<{ obj: THREE.Object3D; phase: number }> = [];
  const targetPowerLights: Array<{ light: THREE.PointLight; baseIntensity: number }> = [];
  const targetPowerEmissives: Array<{
    mat: THREE.MeshStandardMaterial;
    baseIntensity: number;
  }> = [];
  const alarmLights: THREE.PointLight[] = [];
  const cityBoxColliders: AabbCollider[] = [];
  const activeLights: ActiveLightSource[] = [];

  for (const f of target.floors) {
    const fg = new THREE.Group();
    fg.name = `Floor_${f}`;
    root.add(fg);
    floorGroups.set(f, fg);
  }
  if (!floorGroups.has(0)) {
    const fg0 = new THREE.Group();
    fg0.name = 'Floor_0';
    root.add(fg0);
    floorGroups.set(0, fg0);
  }

  // 1) Sky Dome
  const sky = createSkyDome(target.themePalette.skyTop, target.themePalette.skyHorizon);
  root.add(sky);

  // 2) Wet Coastal Night Asphalt Road Network (MeshPhysicalMaterial + Puddle Shader + 4-Map PBR!)
  const asphaltPbr = assetRegistry.getPbrMaps('wet_asphalt', 46, 40);
  const wetAsphaltHandle = createWetSurfaceMaterial({
    preset: 'wet_asphalt',
    maps: asphaltPbr,
    wetness: 0.9,
    puddleCoverage: 0.46,
    rippleStrength: 0.65,
  });
  wetMaterials.push(wetAsphaltHandle);

  const roadGround = new THREE.Mesh(
    new THREE.PlaneGeometry(460, 380),
    wetAsphaltHandle.material
  );
  roadGround.rotation.x = -Math.PI / 2;
  roadGround.position.set(60, -0.04, -55);
  roadGround.receiveShadow = true;
  root.add(roadGround);

  // 3) Coastal Mediterranean Sea / Elbe River Reflections (deep midnight sapphire at grazing angles)
  const waterGeo = new THREE.PlaneGeometry(540, 150, 28, 10);
  const waterMat = new THREE.MeshPhysicalMaterial({
    color: isDresden ? 0x07101f : 0x05152b,
    roughness: 0.24,
    metalness: 0.18,
    clearcoat: 0.45,
    clearcoatRoughness: 0.18,
    envMapIntensity: 0.32,
  });
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.set(60, -0.32, 108);
  root.add(waterMesh);

  // Raised Coastal Promenade & Sidewalks (Wet Stone Plaza PBR + Physical Curbs!)
  const plazaPbr = assetRegistry.getPbrMaps('stone_plaza', 38, 3);
  const wetPlazaHandle = createWetSurfaceMaterial({
    preset: isDresden ? 'dresden_cobble' : 'stone_plaza',
    maps: plazaPbr,
    wetness: 0.72,
    puddleCoverage: 0.28,
    rippleStrength: 0.45,
  });
  wetMaterials.push(wetPlazaHandle);

  const promenade = new THREE.Mesh(
    new THREE.BoxGeometry(440, 0.24, 16),
    wetPlazaHandle.material
  );
  promenade.position.set(60, 0.05, 34);
  promenade.receiveShadow = true;
  root.add(promenade);

  // Granite curb edging along promenade & target sidewalk
  const curbPbr = assetRegistry.getPbrMaps(isDresden ? 'dresden_sandstone' : 'stone_plaza', 40, 1);
  const curbMat = makePbrStandardMaterial(curbPbr, {
    color: 0x9aa4b2,
    roughness: 0.85,
    normalScale: 1.0,
  });
  const southCurb = new THREE.Mesh(new THREE.BoxGeometry(440, 0.28, 0.42), curbMat);
  southCurb.position.set(60, 0.08, 25.8);
  southCurb.receiveShadow = true;
  root.add(southCurb);

  const northCurb = new THREE.Mesh(new THREE.BoxGeometry(108, 0.22, 0.38), curbMat);
  northCurb.position.set(0, 0.05, 13.8);
  northCurb.receiveShadow = true;
  root.add(northCurb);

  // Weathered painted road centerlines along main avenues
  const laneMat = new THREE.MeshStandardMaterial({
    color: 0xd4a438,
    roughness: 0.48,
    metalness: 0.05,
    transparent: true,
    opacity: 0.42,
  });
  const addLaneLine = (x: number, z: number, len: number, horizontal: boolean) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(horizontal ? len : 0.24, horizontal ? 0.24 : len),
      laneMat
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.012, z);
    m.receiveShadow = true;
    root.add(m);
  };
  for (const zRoad of [19.8, -58, -134]) {
    for (let x = -110; x <= 230; x += 14) {
      addLaneLine(x, zRoad, 5.8, true);
    }
  }
  for (const xRoad of [-46, 52, 128, 196]) {
    for (let z = -175; z <= 22; z += 14) {
      addLaneLine(xRoad, z, 5.8, false);
    }
  }

  // 4) Target Floor Slabs & Multi-Map PBR Walls
  const wallPrimaryPbr = assetRegistry.getPbrMaps(
    isDresden ? 'dresden_sandstone' : 'salou_stucco',
    3,
    2
  );
  const alleyPbr = assetRegistry.getPbrMaps('brick_alley', 3, 2);
  const marblePbr = assetRegistry.getPbrMaps('interior_marble', 4, 4);
  const steelPbr = assetRegistry.getPbrMaps('brushed_steel', 3, 3);
  const roomPlazaPbr = assetRegistry.getPbrMaps('stone_plaza', 4, 4);

  const marbleFloorHandle = createWetSurfaceMaterial({
    preset: 'interior_marble',
    maps: marblePbr,
    wetness: 0.18,
    puddleCoverage: 0.0,
    rippleStrength: 0.0,
    envMapIntensity: 1.35,
  });
  wetMaterials.push(marbleFloorHandle);

  const primaryFacadeColor = new THREE.Color(target.themePalette.facadePrimary);
  const trimColor = new THREE.Color(target.themePalette.facadeTrim);

  for (const room of target.rooms) {
    const fg = floorGroups.get(room.floor) ?? floorGroups.get(0)!;
    const fy = room.floor * target.floorHeightM;

    const isStreetOrGarden =
      room.kind === 'street' || room.kind === 'courtyard' || room.kind === 'garden';

    let slabMat: THREE.Material;
    if (room.kind === 'shop' || room.kind === 'gallery' || room.kind === 'lobby') {
      slabMat = marbleFloorHandle.material;
    } else if (room.kind === 'vault') {
      slabMat = makePbrStandardMaterial(steelPbr, {
        color: 0x526175,
        roughness: 0.58,
        metalness: 0.72,
        normalScale: 0.65,
        envMapIntensity: 1.25,
      });
    } else if (isStreetOrGarden) {
      slabMat = makePbrStandardMaterial(roomPlazaPbr, {
        color: room.kind === 'garden' ? 0x263f33 : 0xaeb6c2,
        roughness: 0.72,
        normalScale: 0.95,
      });
    } else if (room.kind === 'cellar') {
      slabMat = makePbrStandardMaterial(alleyPbr, {
        color: 0x454f5e,
        roughness: 0.88,
        normalScale: 1.1,
      });
    } else {
      slabMat = makePbrStandardMaterial(roomPlazaPbr, {
        color: room.kind === 'roof' ? 0x364152 : 0x545d6d,
        roughness: 0.78,
        normalScale: 0.7,
      });
    }

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(room.width, 0.16, room.depth),
      slabMat
    );
    slab.position.set(room.x + room.width / 2, fy - 0.06, room.z + room.depth / 2);
    slab.receiveShadow = true;
    fg.add(slab);

    // Interior room architectural lighting (linked to power cut + light exposure sampling!)
    if (!isStreetOrGarden && room.kind !== 'roof') {
      const lightColor = room.lightColor
        ? new THREE.Color(room.lightColor)
        : new THREE.Color(0xffd79a);
      const baseIntensity = room.kind === 'gallery' || room.kind === 'shop' ? 14.5 : 9.5;
      const lx = room.x + room.width / 2;
      const lz = room.z + room.depth / 2;
      const roomLight = new THREE.PointLight(lightColor, baseIntensity, 22, 1.65);
      roomLight.position.set(lx, fy + target.floorHeightM - 0.65, lz);
      fg.add(roomLight);
      targetPowerLights.push({ light: roomLight, baseIntensity });
      activeLights.push({
        x: lx,
        z: lz,
        floor: room.floor,
        radius: Math.max(room.width, room.depth) * 0.75 + 2.5,
        intensity: 0.85,
        isTargetPowerLinked: true,
      });
    }
  }

  // Build PBR Walls from WallSegments
  for (const w of target.walls) {
    const fg = floorGroups.get(w.floor) ?? floorGroups.get(0)!;
    const fy = w.floor * target.floorHeightM;
    const dx = w.x2 - w.x1;
    const dz = w.z2 - w.z1;
    const length = Math.hypot(dx, dz);
    if (length < 0.05) continue;

    const height =
      w.height ??
      (w.kind === 'fence'
        ? 1.9
        : w.kind === 'interior'
          ? 2.75
          : w.kind === 'baroque'
            ? 3.85
            : 3.25);
    const thickness =
      w.thickness ??
      (w.kind === 'baroque'
        ? 0.52
        : w.kind === 'exterior'
          ? 0.36
          : w.kind === 'fence'
            ? 0.12
            : 0.24);

    let wallMat: THREE.Material;
    if (w.kind === 'glass') {
      wallMat = new THREE.MeshPhysicalMaterial({
        color: 0xa5d8ff,
        transparent: true,
        opacity: 0.24,
        roughness: 0.08,
        metalness: 0.1,
        reflectivity: 0.92,
        clearcoat: 1.0,
        clearcoatRoughness: 0.06,
        envMapIntensity: 1.8,
      });
    } else if (w.kind === 'fence') {
      wallMat = makePbrStandardMaterial(steelPbr, {
        color: 0x263344,
        roughness: 0.5,
        metalness: 0.82,
      });
    } else if (w.kind === 'baroque') {
      wallMat = makePbrStandardMaterial(wallPrimaryPbr, {
        color: primaryFacadeColor,
        roughness: 0.88,
        metalness: 0.05,
        normalScale: 1.15,
      });
    } else if (w.kind === 'exterior') {
      wallMat = makePbrStandardMaterial(
        w.floor < 0 ? alleyPbr : wallPrimaryPbr,
        {
          color: w.floor < 0 ? 0x6b7280 : primaryFacadeColor,
          roughness: 0.88,
          metalness: 0.04,
          normalScale: 0.95,
        }
      );
    } else {
      wallMat = makePbrStandardMaterial(wallPrimaryPbr, {
        color: 0x526075,
        roughness: 0.82,
        metalness: 0.08,
        normalScale: 0.65,
      });
    }

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), wallMat);
    mesh.position.set((w.x1 + w.x2) / 2, fy + height / 2, (w.z1 + w.z2) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = w.kind !== 'glass';
    mesh.receiveShadow = true;
    fg.add(mesh);

    if (w.kind === 'exterior' || w.kind === 'baroque') {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(length + 0.12, 0.24, thickness + 0.18),
        new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.58, metalness: 0.22 })
      );
      cap.position.set((w.x1 + w.x2) / 2, fy + height + 0.12, (w.z1 + w.z2) / 2);
      cap.rotation.y = -Math.atan2(dz, dx);
      fg.add(cap);
    }
  }

  // Diegetic architectural storefront fascia board (flush on facade, NEVER clips camera!)
  const frontZ =
    target.id === 'casa_oro'
      ? 7.22
      : target.id === 'perla_del_mar'
        ? 8.22
        : target.id === 'villa_mirador'
          ? 8.22
          : 9.32;
  const fasciaTex = createFasciaSignTexture(
    target.name,
    target.subtitle,
    target.themePalette.accentHex,
    isDresden
  );
  disposables.push(fasciaTex);
  const fasciaMat = new THREE.MeshStandardMaterial({
    map: fasciaTex,
    emissiveMap: fasciaTex,
    emissive: new THREE.Color(0xffffff),
    emissiveIntensity: 1.15,
    roughness: 0.35,
    metalness: 0.35,
  });
  const fasciaBoard = new THREE.Mesh(new THREE.BoxGeometry(5.6, 0.95, 0.16), fasciaMat);
  fasciaBoard.position.set(0, 3.12, frontZ);
  fasciaBoard.castShadow = true;
  floorGroups.get(0)!.add(fasciaBoard);
  targetPowerEmissives.push({ mat: fasciaMat, baseIntensity: 1.15 });

  // Alarm interior strobe light
  const alarmLight = new THREE.PointLight(0xef4444, 0, 34, 1.5);
  alarmLight.position.set(0, 4.1, -2);
  root.add(alarmLight);
  alarmLights.push(alarmLight);

  // Dresden baroque colonnade pillars + volumetric wall sconces
  if (isDresden) {
    const pillarPositions: Array<[number, number, number]> = [
      [-12, 9.6, 0],
      [-6, 9.6, 0],
      [6, 9.6, 0],
      [12, 9.6, 0],
      [-10, -2.5, 0],
      [-2, -2.5, 0],
      [-10, -10.5, Math.PI],
      [-2, -10.5, Math.PI],
      [10, -2.5, 0],
    ];
    for (const [px, pz, rotY] of pillarPositions) {
      const pillar = assetRegistry.instantiateModel('dresden_pillar', false);
      pillar.position.set(px, 0, pz);
      pillar.rotation.y = rotY;
      floorGroups.get(0)!.add(pillar);

      if (pz > 8) {
        const sconceCone = createVolumetricLightCone({
          preset: 'sconce',
          length: 2.8,
          opacity: 0.14,
        });
        sconceCone.mesh.position.set(px, 2.65, pz + 0.72);
        floorGroups.get(0)!.add(sconceCone.mesh);
        volumetricCones.push(sconceCone);
      }
    }
  }

  // 5) Build Interactive Target Nodes (diegetic props + subtle proximity-only labels!)
  for (const node of target.nodes) {
    if (node.kind === 'camera') continue;
    const fg = floorGroups.get(node.floor) ?? floorGroups.get(0)!;
    const fy = node.floor * target.floorHeightM;

    const group = new THREE.Group();
    group.name = `Node_${node.id}`;
    group.position.set(node.pos.x, fy, node.pos.z);

    const propRoot = buildArchitecturalProp(node);
    if (node.kind === 'safe') {
      propRoot.rotation.y = 0;
    } else if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
      propRoot.rotation.y = node.pos.x < 0 ? Math.PI / 2 : -Math.PI / 2;
    } else if (node.kind === 'entry_service' || node.kind === 'entry_window') {
      propRoot.rotation.y = Math.PI / 2;
    } else if (node.kind === 'getaway_zone') {
      propRoot.rotation.y = headingDegToRotY(target.getawayHeadingDeg);
    }
    group.add(propRoot);

    // Sleek minimal interaction ring (only visible on proximity / highlight / binoculars!)
    const ringGeo = new THREE.RingGeometry(0.62, 0.72, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.y = 0.05;
    ringMesh.userData.excludeFromAO = true;
    group.add(ringMesh);

    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 360;
    labelCanvas.height = 88;
    const labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeLabelTexture(labelCanvas, node.label, '#f59e0b'),
        transparent: true,
        depthTest: true,
      })
    );
    const isDoorNode =
      node.kind === 'entry_door' ||
      node.kind === 'entry_service' ||
      node.kind === 'entry_window' ||
      node.kind === 'lock';
    const labelY = isDoorNode
      ? 2.68
      : node.kind === 'safe' || node.kind === 'loot_case'
        ? 2.14
        : 1.9;
    labelSprite.position.set(0, labelY, 0);
    labelSprite.scale.set(1.55, 0.4, 1);
    labelSprite.renderOrder = 16;
    labelSprite.visible = false;
    labelSprite.userData.excludeFromAO = true;
    group.add(labelSprite);

    fg.add(group);
    nodeVisuals.set(node.id, {
      node,
      group,
      propRoot,
      ringMesh,
      ringMat,
      labelSprite,
      labelCanvas,
      lastLabelText: '',
      lastLabelColor: '',
      openedAmount: 0,
      floor: node.floor,
    });
  }

  // 6) Surrounding Mediterranean Night City Block + Volumetric Streetlamps + Cafe Terraces
  const addStreetlamp = (x: number, z: number, rotY: number, withRealLight: boolean) => {
    const lamp = assetRegistry.instantiateModel('streetlamp', false);
    lamp.position.set(x, 0, z);
    lamp.rotation.y = rotY;
    root.add(lamp);

    const lightX = x + Math.sin(rotY) * 0.8;
    const lightZ = z + Math.cos(rotY) * 0.8;

    activeLights.push({
      x: lightX,
      z: lightZ,
      floor: 0,
      radius: 13.5,
      intensity: 0.9,
      isTargetPowerLinked: false,
    });

    if (withRealLight) {
      const pl = createStreetlampLight(envTheme, {
        intensity: 20,
        distance: 28,
        decay: 1.65,
      });
      pl.position.set(lightX, 4.18, lightZ);
      root.add(pl);

      const cone = createVolumetricLightCone({
        preset: 'streetlamp',
        color: isDresden ? 0xffc675 : 0xffa64d,
        length: 4.35,
        bottomRadius: 2.75,
        opacity: 0.14,
      });
      cone.mesh.position.set(lightX, 4.18, lightZ);
      root.add(cone.mesh);
      volumetricCones.push(cone);
    }
  };

  const addPalm = (x: number, z: number, scale = 1.0, phase = 0) => {
    const palm = assetRegistry.instantiateModel('palm_tree', false);
    palm.position.set(x, 0, z);
    palm.scale.setScalar(scale);
    palm.rotation.y = phase * 1.9;
    root.add(palm);
    const canopy = palm.getObjectByName('Canopy');
    if (canopy) {
      palmCanopies.push({ obj: canopy, phase });
    }
  };

  // Flanking sodium-vapor streetlamps (clear center sightline!)
  const targetStreetLamps: Array<[number, number, number, boolean]> = [
    [-18, 13.5, Math.PI, true],
    [-9.5, 13.5, Math.PI, true],
    [9.5, 13.5, Math.PI, true],
    [18, 13.5, Math.PI, true],
    [-26, 26.2, 0, true],
    [24, 26.2, 0, true],
    [68, 26.2, 0, true],
    [112, 26.2, 0, false],
    [152, 26.2, 0, false],
    [186, 26.2, 0, false],
    [52, -32, Math.PI / 2, false],
    [128, -32, Math.PI / 2, false],
    [128, -96, Math.PI / 2, false],
    [196, -96, -Math.PI / 2, false],
    [82, -134, 0, false],
    [152, -134, 0, false],
  ];
  for (const [lx, lz, lrot, real] of targetStreetLamps) {
    addStreetlamp(lx, lz, lrot, real);
  }

  if (!isDresden) {
    for (let x = -72; x <= 216; x += 18) {
      addPalm(x, 29.2, 0.92 + ((Math.abs(x) % 5) * 0.04), x * 0.17);
    }
    addPalm(-22, 12.2, 0.95, 1.1);
    addPalm(22, 12.2, 1.02, 2.4);

    // Authentic Mediterranean sidewalk cafe terraces for lived-in Salou atmosphere!
    const terraceSpots: Array<[number, number, number]> = [
      [-28, 11.2, 0.15],
      [29, 11.2, -0.2],
      [-14, 30.2, 0],
      [14, 30.2, 0.3],
      [42, 30.2, -0.15],
    ];
    for (const [tx, tz, trot] of terraceSpots) {
      const cafe = assetRegistry.instantiateModel('cafe_terrace', false);
      cafe.position.set(tx, 0.12, tz);
      cafe.rotation.y = trot;
      root.add(cafe);
    }
  } else {
    for (let x = -48; x <= 180; x += 28) {
      const col = assetRegistry.instantiateModel('dresden_pillar', false);
      col.position.set(x, 0, 29.0);
      col.rotation.y = Math.PI;
      root.add(col);
    }
  }

  // Modular neighboring Salou townhouse blocks
  interface CityBlockDef {
    cx: number;
    cz: number;
    w: number;
    d: number;
    h: number;
    facadeCount: number;
    facadeSouth: boolean;
  }

  const cityBlocks: CityBlockDef[] = [
    { cx: -32, cz: -8, w: 16, d: 34, h: 9.2, facadeCount: 2, facadeSouth: true },
    { cx: 34, cz: -8, w: 16, d: 34, h: 10.4, facadeCount: 2, facadeSouth: true },
    { cx: 90, cz: -20, w: 50, d: 48, h: 11.5, facadeCount: 6, facadeSouth: true },
    { cx: 162, cz: -20, w: 46, d: 48, h: 10.0, facadeCount: 5, facadeSouth: true },
    { cx: -82, cz: -20, w: 48, d: 48, h: 9.8, facadeCount: 5, facadeSouth: true },
    { cx: 4, cz: -96, w: 68, d: 48, h: 12.5, facadeCount: 7, facadeSouth: true },
    { cx: 90, cz: -96, w: 50, d: 48, h: 13.8, facadeCount: 6, facadeSouth: true },
    { cx: 162, cz: -96, w: 46, d: 48, h: 11.0, facadeCount: 5, facadeSouth: true },
    { cx: -82, cz: -96, w: 48, d: 48, h: 10.5, facadeCount: 4, facadeSouth: true },
    { cx: 40, cz: -172, w: 80, d: 40, h: 14.0, facadeCount: 0, facadeSouth: false },
    { cx: 234, cz: -75, w: 38, d: 140, h: 12.0, facadeCount: 0, facadeSouth: false },
  ];

  const blockWallMat = makePbrStandardMaterial(
    isDresden ? wallPrimaryPbr : alleyPbr,
    {
      color: isDresden ? 0x5c574f : 0x5d534b,
      roughness: 0.9,
      metalness: 0.06,
      normalScale: 1.0,
    }
  );
  const blockRoofMat = new THREE.MeshStandardMaterial({
    color: 0x121926,
    roughness: 0.85,
  });

  for (const blk of cityBlocks) {
    const mass = new THREE.Mesh(
      new THREE.BoxGeometry(blk.w, blk.h, blk.d),
      [blockWallMat, blockWallMat, blockRoofMat, blockRoofMat, blockWallMat, blockWallMat]
    );
    mass.position.set(blk.cx, blk.h / 2, blk.cz);
    mass.castShadow = true;
    mass.receiveShadow = true;
    root.add(mass);

    cityBoxColliders.push({
      minX: blk.cx - blk.w / 2,
      maxX: blk.cx + blk.w / 2,
      minZ: blk.cz - blk.d / 2,
      maxZ: blk.cz + blk.d / 2,
    });

    if (blk.facadeSouth && blk.facadeCount > 0) {
      const span = Math.min(blk.w - 2, blk.facadeCount * 6.0);
      const count = Math.max(1, Math.floor(span / 6.0));
      const startX = blk.cx - ((count - 1) * 6.0) / 2;
      for (let i = 0; i < count; i++) {
        const fx = startX + i * 6.0;
        const fz = blk.cz + blk.d / 2 + 0.1;
        if (!isDresden) {
          const facade = assetRegistry.instantiateModel('salou_facade', false);
          facade.position.set(fx, 0, fz);
          root.add(facade);
        } else {
          const col = assetRegistry.instantiateModel('dresden_pillar', false);
          col.position.set(fx, 0, fz + 0.5);
          root.add(col);
        }
      }
    }
  }

  cityBoxColliders.push({
    minX: target.bounds.minX + 3,
    maxX: target.bounds.maxX - 3,
    minZ: target.bounds.minZ + 1,
    maxZ: Math.min(7.5, target.bounds.maxZ - 7),
  });

  // 7) La Pineda Safehouse Extraction Zone
  const safehousePos: Vec2 = { x: 162, z: -158 };
  const { group: safehouseBeacon, beaconRing } = buildSafehouseBeacon(
    isDresden,
    volumetricCones
  );
  safehouseBeacon.position.set(safehousePos.x, 0, safehousePos.z);
  root.add(safehouseBeacon);

  // 8) Cinematic Distant Skyline (Lit Apartment/Hotel Window Grids — NO raw sphere dots!)
  const skylineTex = createSkylineWindowTexture();
  disposables.push(skylineTex);
  const skylineMat = new THREE.MeshStandardMaterial({
    color: isDresden ? 0x161b2a : 0x0f1728,
    map: skylineTex,
    emissiveMap: skylineTex,
    emissive: new THREE.Color(0xffdfa8),
    emissiveIntensity: 0.72,
    roughness: 0.85,
  });
  const skylineGroup = new THREE.Group();
  for (let i = 0; i < 16; i++) {
    const sx = -135 + i * 25;
    const sz = -218 - (i % 3) * 16;
    const w = isDresden ? 11 : 13 + (i % 3) * 4;
    const h = isDresden ? 20 + (i % 4) * 11 : 16 + (i % 5) * 8;
    const tower = new THREE.Mesh(new THREE.BoxGeometry(w, h, 10), skylineMat);
    tower.position.set(sx, h / 2, sz);
    skylineGroup.add(tower);
  }
  root.add(skylineGroup);

  const wallColliders = buildWallColliders(target.walls);

  const setFocusFloor = (floor: FloorId) => {
    for (const [fId, fg] of floorGroups.entries()) {
      if (floor < 0) {
        fg.visible = fId === floor;
      } else {
        fg.visible = fId >= 0 && fId <= floor;
      }
    }
    roadGround.visible = floor >= 0;
  };
  setFocusFloor(0);

  let currentPowerDisabled = false;
  const setPowerDisabled = (disabled: boolean) => {
    currentPowerDisabled = disabled;
    for (const item of targetPowerLights) {
      item.light.intensity = disabled ? item.baseIntensity * 0.06 : item.baseIntensity;
    }
    for (const item of targetPowerEmissives) {
      item.mat.emissiveIntensity = disabled ? 0.04 : item.baseIntensity;
    }
  };

  const getLightExposureAt = (pos: Vec2, floor: FloorId, powerDisabled: boolean): number => {
    // Base moonlit night ambient exposure
    let exposure = floor < 0 ? 0.08 : 0.18;
    for (const src of activeLights) {
      if (src.floor !== floor) continue;
      if (src.isTargetPowerLinked && powerDisabled) continue;
      const d = dist2D(pos.x, pos.z, src.x, src.z);
      if (d < src.radius) {
        const falloff = 1 - d / src.radius;
        exposure += falloff * falloff * src.intensity;
      }
    }
    return Math.max(0.08, Math.min(1.0, exposure));
  };

  const getSurfaceAt = (
    pos: Vec2,
    floor: FloorId
  ): 'asphalt' | 'stone' | 'marble' | 'metal' | 'wood' => {
    for (const room of target.rooms) {
      if (room.floor !== floor) continue;
      if (
        pos.x >= room.x &&
        pos.x <= room.x + room.width &&
        pos.z >= room.z &&
        pos.z <= room.z + room.depth
      ) {
        if (room.kind === 'vault') return 'metal';
        if (room.kind === 'shop' || room.kind === 'gallery' || room.kind === 'lobby') {
          return 'marble';
        }
        if (room.kind === 'office') return 'wood';
        if (room.kind === 'courtyard' || room.kind === 'cellar') return 'stone';
        return 'asphalt';
      }
    }
    if (pos.z > 25.5) return 'stone';
    return 'asphalt';
  };

  return {
    root,
    target,
    floorGroups,
    nodeVisuals,
    wallColliders,
    cityBoxColliders,
    safehousePos,
    safehouseBeacon,
    wetMaterials,
    volumetricCones,
    palmCanopies,
    targetPowerLights,
    targetPowerEmissives,
    alarmLights,
    waterMesh,
    setFocusFloor,
    setPowerDisabled,
    getLightExposureAt,
    getSurfaceAt,
    update: ({
      dt,
      timeSec,
      phase,
      intel,
      completedNodeIds,
      unlockedDoorIds = [],
      openedContainerIds = [],
      triggeredHazardIds,
      powerDisabled,
      alarmLevel,
      highlightedNodeId,
      workingNodeIds,
      playerPos,
      binocularsActive = false,
    }) => {
      if (powerDisabled !== currentPowerDisabled) {
        setPowerDisabled(powerDisabled);
      }

      for (const p of palmCanopies) {
        p.obj.rotation.x = Math.sin(timeSec * 1.1 + p.phase) * 0.028;
        p.obj.rotation.z = Math.cos(timeSec * 0.85 + p.phase) * 0.024;
      }

      const alarmActive = alarmLevel === 'alarm' || alarmLevel === 'lockdown';
      for (const al of alarmLights) {
        al.intensity = alarmActive ? (Math.sin(timeSec * 9.5) * 0.5 + 0.5) * 28 : 0;
      }

      safehouseBeacon.visible = phase === 'escape';
      if (phase === 'escape') {
        const pulse = 1 + Math.sin(timeSec * 4.0) * 0.1;
        beaconRing.scale.set(pulse, pulse, 1);
      }

      const completedSet = new Set(completedNodeIds);
      const unlockedSet = new Set([...completedNodeIds, ...unlockedDoorIds]);
      const openedSet = new Set([...completedNodeIds, ...openedContainerIds]);
      const discoveredSet = new Set(intel.discoveredNodeIds);
      const triggeredSet = new Set(triggeredHazardIds);

      for (const handle of nodeVisuals.values()) {
        const { node, propRoot, ringMesh, ringMat, labelSprite } = handle;
        const isCompleted = completedSet.has(node.id);
        const isDoorOpen = unlockedSet.has(node.id);
        const isContainerOpen = openedSet.has(node.id);
        const isDiscovered = discoveredSet.has(node.id);
        const isHighlighted = highlightedNodeId === node.id;
        const isWorking = workingNodeIds.has(node.id);
        const isTriggered = triggeredSet.has(node.id);

        if (phase === 'escape') {
          ringMesh.visible = false;
          labelSprite.visible = false;
          if (node.kind === 'lookout' || node.kind === 'getaway_zone' || node.isHiddenHazard) {
            propRoot.visible = false;
          }
          continue;
        }

        if (node.isHiddenHazard) {
          const reveal = isDiscovered || isTriggered || isHighlighted;
          propRoot.visible = reveal;
          const laser = propRoot.getObjectByName('Trap_Laser');
          if (laser) {
            laser.visible = reveal && !powerDisabled && !isCompleted;
          }
          if (!reveal) {
            ringMesh.visible = false;
            labelSprite.visible = false;
            continue;
          }
        } else {
          propRoot.visible = true;
        }

        // Sleek diegetic marker visibility: ONLY show ring/label on proximity, highlight, working, or binoculars!
        const distToPlayer = playerPos
          ? dist2D(playerPos.x, playerPos.z, node.pos.x, node.pos.z)
          : 99;
        const showMarker =
          isHighlighted ||
          isWorking ||
          (binocularsActive && distToPlayer < 26) ||
          (distToPlayer < 4.8 && !isCompleted);

        ringMesh.visible = showMarker;
        labelSprite.visible =
          isHighlighted || isWorking || (binocularsActive && distToPlayer < 22);

        if (showMarker) {
          let ringHex = '#38bdf8';
          let subText = '';
          if (phase === 'scouting') {
            if (isHighlighted) {
              ringHex = '#38bdf8';
              subText = isDiscovered ? 'ERKUNDET ✓' : '[E] SCANNEN';
            } else if (isDiscovered) {
              ringHex = '#2dd4bf';
              subText = 'ERKUNDET';
            } else {
              ringHex = '#fbbf24';
              subText = 'UNERKUNDET';
            }
          } else {
            if (isCompleted) {
              ringHex = '#22c55e';
              subText = 'ERLEDIGT ✓';
            } else if (isWorking) {
              ringHex = '#38bdf8';
              subText = 'IN ARBEIT...';
            } else if (isHighlighted) {
              ringHex = '#38bdf8';
              subText =
                node.kind === 'getaway_zone' ? '[E] FLUCHT STARTEN' : '[E] INTERAGIEREN';
            } else if (node.kind === 'safe' || node.kind === 'loot_case') {
              ringHex = '#fbbf24';
              subText = node.lootValue ? `${(node.lootValue / 1000).toFixed(0)}k €` : 'BEUTE';
            } else {
              ringHex = '#94a3b8';
            }
          }

          ringMat.color.set(ringHex);
          ringMat.opacity = isHighlighted ? 0.72 : 0.34;
          const rScale = isHighlighted ? 1.12 + Math.sin(timeSec * 5.5) * 0.06 : 1.0;
          ringMesh.scale.set(rScale, rScale, 1);

          if (labelSprite.visible) {
            updateLabelSprite(handle, node.label, ringHex, subText);
          }
        }

        // Physical prop state animation (doors swing open, safes unlock, breaker levers throw)
        const targetOpen = isDoorOpen || isContainerOpen ? 1 : 0;
        handle.openedAmount += (targetOpen - handle.openedAmount) * Math.min(1, dt * 5.5);

        if (node.kind === 'safe') {
          const safeDoor = propRoot.getObjectByName('Safe_Door');
          if (safeDoor) safeDoor.rotation.y = -1.8 * handle.openedAmount;
          const safeDial = propRoot.getObjectByName('Safe_Dial');
          if (safeDial && isWorking) safeDial.rotation.z += dt * 4.5;
          const safeLoot = propRoot.getObjectByName('Safe_Loot');
          if (safeLoot) safeLoot.visible = !isContainerOpen;
          const safeLed = propRoot.getObjectByName('Safe_LED') as THREE.Mesh | undefined;
          if (safeLed && safeLed.material instanceof THREE.MeshStandardMaterial) {
            const c = isContainerOpen ? 0x22c55e : 0xef4444;
            safeLed.material.color.setHex(c);
            safeLed.material.emissive.setHex(c);
          }
        } else if (node.kind === 'loot_case') {
          const artifact = propRoot.getObjectByName('Artifact');
          if (artifact) {
            artifact.visible = !isContainerOpen;
            artifact.rotation.y = timeSec * 0.75;
          }
          const glassHood = propRoot.getObjectByName('Glass_Hood');
          if (glassHood) glassHood.position.y = handle.openedAmount * 0.45;
        } else if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
          const lever = propRoot.getObjectByName('Breaker_Lever');
          if (lever) lever.rotation.x = handle.openedAmount * 1.15;
          const led = propRoot.getObjectByName('Status_LED') as THREE.Mesh | undefined;
          if (led && led.material instanceof THREE.MeshStandardMaterial) {
            led.material.emissiveIntensity = isCompleted ? 0.05 : 2.5;
          }
        } else if (
          node.kind === 'entry_door' ||
          node.kind === 'entry_service' ||
          node.kind === 'entry_window' ||
          node.kind === 'lock'
        ) {
          const doorLeaf =
            propRoot.getObjectByName('Door_Leaf') ??
            propRoot.getObjectByName('Door_Panel') ??
            propRoot.getObjectByName('Door');
          if (doorLeaf) doorLeaf.rotation.y = -1.52 * handle.openedAmount;
          const led = propRoot.getObjectByName('Lock_LED') as THREE.Mesh | undefined;
          if (led && led.material instanceof THREE.MeshStandardMaterial) {
            const c = isDoorOpen ? 0x22c55e : 0xf59e0b;
            led.material.color.setHex(c);
            led.material.emissive.setHex(c);
          }
        } else if (node.kind === 'entry_roof' || node.kind === 'entry_cellar') {
          const lid = propRoot.getObjectByName('Hatch_Lid');
          if (lid) lid.rotation.z = 1.45 * handle.openedAmount;
        }
      }
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
      for (const w of wetMaterials) w.dispose();
      for (const c of volumetricCones) c.dispose();
      disposeSceneSubtree(root);
    },
  };
}
