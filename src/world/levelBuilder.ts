import * as THREE from 'three';
import {
  AlarmLevel,
  FloorId,
  HeistTarget,
  IntelState,
  TargetNode,
  Vec2,
} from '../sim/types';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import {
  AabbCollider,
  SegmentCollider,
  buildWallColliders,
  headingDegToRotY,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — 3D Level & Mediterranean Night Noir City Builder
// Constructs the playable multi-floor heist target (Salou / Dresden),
// surrounding nocturnal city block, drivable coastal avenue loop, and
// La Pineda Safehouse extraction zone with interactive node props.
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

export interface BuiltLevel {
  root: THREE.Group;
  target: HeistTarget;
  floorGroups: Map<FloorId, THREE.Group>;
  nodeVisuals: Map<string, NodeVisualHandle>;
  wallColliders: SegmentCollider[];
  cityBoxColliders: AabbCollider[];
  safehousePos: Vec2;
  safehouseBeacon: THREE.Group;
  palmCanopies: Array<{ obj: THREE.Object3D; phase: number }>;
  targetPowerLights: Array<{ light: THREE.PointLight; baseIntensity: number }>;
  targetPowerEmissives: Array<{ mat: THREE.MeshStandardMaterial; baseIntensity: number }>;
  alarmLights: THREE.PointLight[];
  waterMesh: THREE.Mesh | null;
  setFocusFloor: (floor: FloorId) => void;
  setPowerDisabled: (disabled: boolean) => void;
  update: (params: {
    dt: number;
    timeSec: number;
    phase: 'scouting' | 'executing' | 'escape';
    intel: IntelState;
    completedNodeIds: string[];
    triggeredHazardIds: string[];
    powerDisabled: boolean;
    alarmLevel: AlarmLevel;
    highlightedNodeId: string | null;
    workingNodeIds: Set<string>;
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

    // Pill background
    ctx.fillStyle = 'rgba(7, 13, 27, 0.86)';
    ctx.strokeStyle = accentHex;
    ctx.lineWidth = 3;
    const pad = 8;
    const w = canvas.width - pad * 2;
    const h = canvas.height - pad * 2;
    const r = 14;
    ctx.beginPath();
    ctx.moveTo(pad + r, pad);
    ctx.lineTo(pad + w - r, pad);
    ctx.quadraticCurveTo(pad + w, pad, pad + w, pad + r);
    ctx.lineTo(pad + w, pad + h - r);
    ctx.quadraticCurveTo(pad + w, pad + h, pad + w - r, pad + h);
    ctx.lineTo(pad + r, pad + h);
    ctx.quadraticCurveTo(pad, pad + h, pad, pad + h - r);
    ctx.lineTo(pad, pad + r);
    ctx.quadraticCurveTo(pad, pad, pad + r, pad);
    ctx.closePath();
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
      ctx.font = `bold ${size}px ${fontFamily}`;
      while (size > minSize && ctx.measureText(str).width > maxTextW) {
        size -= 1;
        ctx.font = `bold ${size}px ${fontFamily}`;
      }
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText(str, canvas.width / 2, y, maxTextW);
    };

    // Main title (auto-fitted, never mid-word sliced)
    drawFittedText(
      text,
      subText ? canvas.height * 0.37 : canvas.height * 0.5,
      22,
      13,
      'ui-sans-serif, system-ui, sans-serif',
      '#f8fafc'
    );

    if (subText) {
      drawFittedText(
        subText,
        canvas.height * 0.68,
        16,
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

function createSkyDome(topHex: string, horizonHex: string): THREE.Mesh {
  const geo = new THREE.SphereGeometry(380, 24, 16);
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
        float h = clamp(dir.y * 1.45 + 0.08, 0.0, 1.0);
        vec3 col = mix(uHorizonColor, uTopColor, pow(h, 0.65));
        // Subtle coastal moon glow
        vec3 moonDir = normalize(vec3(-0.35, 0.34, 0.87));
        float moon = pow(max(dot(dir, moonDir), 0.0), 48.0);
        col += vec3(0.45, 0.62, 0.9) * moon * 0.45;
        // Subtle night stars above horizon
        if (dir.y > 0.14) {
          vec2 grid = floor(dir.xz / max(0.1, dir.y) * 55.0);
          float star = step(0.992, hash(grid)) * smoothstep(0.14, 0.45, dir.y);
          col += vec3(0.85, 0.92, 1.0) * star * 0.55;
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  return new THREE.Mesh(geo, mat);
}

function buildSafehouseBeacon(
  isDresden: boolean
): { group: THREE.Group; beaconRing: THREE.Mesh; beaconBeam: THREE.Mesh } {
  const group = new THREE.Group();

  // Industrial workshop / garage shell
  const garageMat = new THREE.MeshStandardMaterial({
    color: isDresden ? 0x3b3834 : 0x263244,
    roughness: 0.78,
    metalness: 0.25,
  });
  const roofMat = new THREE.MeshStandardMaterial({
    color: 0x131b29,
    roughness: 0.7,
    metalness: 0.4,
  });

  // Back & side walls leaving open front bay facing -X / +Z
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(16, 6.2, 1.2), garageMat);
  backWall.position.set(0, 3.1, -6.5);
  backWall.castShadow = true;
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

  // Neon workshop sign bar
  const neonBar = new THREE.Mesh(
    new THREE.BoxGeometry(11, 0.55, 0.3),
    new THREE.MeshStandardMaterial({
      color: 0x38bdf8,
      emissive: 0x2dd4bf,
      emissiveIntensity: 2.6,
      roughness: 0.2,
    })
  );
  neonBar.position.set(0, 5.5, 7.2);
  group.add(neonBar);

  // Glowing extraction pad ring
  const ringGeo = new THREE.RingGeometry(5.2, 6.6, 40);
  ringGeo.rotateX(-Math.PI / 2);
  const beaconRing = new THREE.Mesh(
    ringGeo,
    new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide,
    })
  );
  beaconRing.position.set(0, 0.12, 3.0);
  group.add(beaconRing);

  // Tall translucent sky beacon visible across city blocks
  const beamGeo = new THREE.CylinderGeometry(1.1, 5.6, 52, 20, 1, true);
  const beaconBeam = new THREE.Mesh(
    beamGeo,
    new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.16,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  );
  beaconBeam.position.set(0, 26, 3.0);
  group.add(beaconBeam);

  // Warm interior workshop light
  const light = new THREE.PointLight(0x38bdf8, 22, 34, 1.4);
  light.position.set(0, 4.8, 3.5);
  group.add(light);

  // Label billboard above workshop
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 420;
  labelCanvas.height = 96;
  const tex = makeLabelTexture(
    labelCanvas,
    isDresden ? 'ELBUFER VERSTECK' : 'WERKSTATT LA PINEDA',
    '#2dd4bf',
    'FLUCHTZIEL · EXTRAKTION'
  );
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })
  );
  sprite.position.set(0, 10.5, 3.0);
  sprite.scale.set(14, 3.2, 1);
  group.add(sprite);

  return { group, beaconRing, beaconBeam };
}

function buildArchitecturalProp(node: TargetNode): THREE.Group {
  const g = new THREE.Group();

  if (node.kind === 'safe') {
    const model = assetRegistry.instantiateModel('safe', true);
    g.add(model);
    return g;
  }

  if (node.kind === 'loot_case') {
    const model = assetRegistry.instantiateModel('display_case', true);
    g.add(model);
    return g;
  }

  if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
    const model = assetRegistry.instantiateModel('power_box', true);
    model.position.y = 0.85;
    if (node.kind === 'alarm_panel') {
      // Tint alarm panel status LED cyan-blue so players distinguish it from main power breaker
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
    // Camera is managed by GuardSystem too; return minimal wall mount marker
    return g;
  }

  if (node.kind === 'entry_roof' || node.kind === 'entry_cellar') {
    const frame = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.16, 1.6),
      new THREE.MeshStandardMaterial({ color: 0x334155, roughness: 0.6, metalness: 0.7 })
    );
    frame.position.y = 0.08;
    g.add(frame);

    const hatchPivot = new THREE.Group();
    hatchPivot.name = 'Hatch_Lid';
    hatchPivot.position.set(-0.75, 0.18, 0);
    const lid = new THREE.Mesh(
      new THREE.BoxGeometry(1.42, 0.08, 1.42),
      new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.45,
        metalness: 0.8,
        emissive: 0x0f172a,
      })
    );
    lid.position.set(0.75, 0, 0);
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
    const frameMat = new THREE.MeshStandardMaterial({
      color: node.kind === 'entry_window' ? 0x1e293b : 0x3b2f26,
      roughness: 0.55,
      metalness: 0.5,
    });
    const postL = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.5, 0.24), frameMat);
    postL.position.set(-0.82, 1.25, 0);
    g.add(postL);

    const postR = new THREE.Mesh(new THREE.BoxGeometry(0.14, 2.5, 0.24), frameMat);
    postR.position.set(0.82, 1.25, 0);
    g.add(postR);

    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.18, 0.26), frameMat);
    lintel.position.set(0, 2.5, 0);
    g.add(lintel);

    const doorPivot = new THREE.Group();
    doorPivot.name = 'Door_Leaf';
    doorPivot.position.set(-0.74, 0, 0);
    const leaf = new THREE.Mesh(
      new THREE.BoxGeometry(1.48, 2.4, 0.09),
      new THREE.MeshStandardMaterial({
        color: node.kind === 'entry_door' ? 0x1e3a5f : 0x334155,
        roughness: 0.35,
        metalness: 0.45,
        transparent: node.kind === 'entry_door',
        opacity: node.kind === 'entry_door' ? 0.65 : 1.0,
      })
    );
    leaf.position.set(0.74, 1.2, 0);
    doorPivot.add(leaf);

    const lockLed = new THREE.Mesh(
      new THREE.SphereGeometry(0.06, 8, 8),
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b,
        emissive: 0xf59e0b,
        emissiveIntensity: 2.2,
      })
    );
    lockLed.name = 'Lock_LED';
    lockLed.position.set(1.25, 1.2, 0.09);
    doorPivot.add(lockLed);
    g.add(doorPivot);
    return g;
  }

  if (node.kind === 'hidden_trap') {
    const emitter = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.35, 0.08, 12),
      new THREE.MeshStandardMaterial({
        color: 0xef4444,
        emissive: 0xef4444,
        emissiveIntensity: 2.4,
        transparent: true,
        opacity: 0.85,
      })
    );
    emitter.name = 'Trap_Emitter';
    emitter.position.y = 0.05;
    g.add(emitter);

    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.025, 0.025, 2.2, 8),
      new THREE.MeshBasicMaterial({
        color: 0xef4444,
        transparent: true,
        opacity: 0.65,
      })
    );
    beam.name = 'Trap_Laser';
    beam.rotation.z = Math.PI / 2;
    beam.position.y = 0.65;
    g.add(beam);
    return g;
  }

  if (node.kind === 'stairs') {
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(1.5, 0.16, 1.5),
      new THREE.MeshStandardMaterial({
        color: 0x38bdf8,
        emissive: 0x0284c7,
        emissiveIntensity: 0.9,
        roughness: 0.4,
      })
    );
    base.position.y = 0.08;
    g.add(base);

    for (let i = 0; i < 4; i++) {
      const step = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 0.16, 0.3),
        new THREE.MeshStandardMaterial({ color: 0x475569, roughness: 0.6 })
      );
      step.position.set(0, 0.24 + i * 0.24, -0.45 + i * 0.3);
      g.add(step);
    }
    return g;
  }

  if (node.kind === 'lookout') {
    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.25, 0.6, 6),
      new THREE.MeshStandardMaterial({
        color: 0x2dd4bf,
        emissive: 0x14b8a6,
        emissiveIntensity: 1.4,
      })
    );
    marker.rotation.x = Math.PI;
    marker.position.y = 1.4;
    g.add(marker);
    return g;
  }

  if (node.kind === 'getaway_zone') {
    const bay = new THREE.Mesh(
      new THREE.PlaneGeometry(3.2, 5.6),
      new THREE.MeshBasicMaterial({
        color: 0x38bdf8,
        transparent: true,
        opacity: 0.14,
        side: THREE.DoubleSide,
      })
    );
    bay.rotation.x = -Math.PI / 2;
    bay.position.y = 0.05;
    g.add(bay);
    return g;
  }

  return g;
}

export function buildLevel(target: HeistTarget): BuiltLevel {
  const root = new THREE.Group();
  root.name = `Level_${target.id}`;
  const isDresden = target.city === 'Dresden';

  const disposables: Array<{ dispose: () => void }> = [];
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

  // 2) City Ground Plane (Wet Night Asphalt covering the whole drivable coastal grid)
  const asphaltTex = assetRegistry.getTexture('wet_asphalt', 46, 40);
  disposables.push(asphaltTex);
  const roadGround = new THREE.Mesh(
    new THREE.PlaneGeometry(460, 380),
    new THREE.MeshStandardMaterial({
      map: asphaltTex,
      color: isDresden ? 0x8d97a8 : 0x99a8bd,
      roughness: 0.36,
      metalness: 0.14,
    })
  );
  roadGround.rotation.x = -Math.PI / 2;
  roadGround.position.set(60, -0.04, -55);
  roadGround.receiveShadow = true;
  root.add(roadGround);

  // 3) Mediterranean Sea (South of Salou Promenade) or Elbe River (Dresden)
  const waterGeo = new THREE.PlaneGeometry(520, 140, 24, 8);
  const waterMat = new THREE.MeshStandardMaterial({
    color: isDresden ? 0x0b1729 : 0x091c36,
    roughness: 0.18,
    metalness: 0.72,
    emissive: isDresden ? 0x060f1e : 0x081d38,
    emissiveIntensity: 0.45,
  });
  const waterMesh = new THREE.Mesh(waterGeo, waterMat);
  waterMesh.rotation.x = -Math.PI / 2;
  waterMesh.position.set(60, -0.35, 108);
  root.add(waterMesh);

  // Coastal sea wall / promenade curb at z = 36
  const plazaTex = assetRegistry.getTexture('stone_plaza', 38, 3);
  disposables.push(plazaTex);
  const promenade = new THREE.Mesh(
    new THREE.BoxGeometry(440, 0.22, 16),
    new THREE.MeshStandardMaterial({
      map: plazaTex,
      color: isDresden ? 0xa39786 : 0xb5a898,
      roughness: 0.65,
      metalness: 0.08,
    })
  );
  promenade.position.set(60, 0.04, 34);
  promenade.receiveShadow = true;
  root.add(promenade);

  // Subtle dashed road centerlines along main avenues (horizontal z = 18, -58, -134; vertical x = 52, 128, 198, -42)
  const laneMat = new THREE.MeshBasicMaterial({
    color: 0xeab308,
    transparent: true,
    opacity: 0.34,
  });
  const addLaneLine = (x: number, z: number, len: number, horizontal: boolean) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(horizontal ? len : 0.28, horizontal ? 0.28 : len),
      laneMat
    );
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, 0.015, z);
    root.add(m);
  };
  for (const zRoad of [18, -58, -134]) {
    for (let x = -110; x <= 230; x += 14) {
      addLaneLine(x, zRoad, 6, true);
    }
  }
  for (const xRoad of [-46, 52, 128, 196]) {
    for (let z = -175; z <= 22; z += 14) {
      addLaneLine(xRoad, z, 6, false);
    }
  }

  // 4) Target Floor Slabs & Walls
  const stuccoTex = assetRegistry.getTexture('salou_stucco', 3, 2);
  disposables.push(stuccoTex);
  const roomPlazaTex = assetRegistry.getTexture('stone_plaza', 3, 3);
  disposables.push(roomPlazaTex);

  const primaryFacadeColor = new THREE.Color(target.themePalette.facadePrimary);
  const trimColor = new THREE.Color(target.themePalette.facadeTrim);

  for (const room of target.rooms) {
    const fg = floorGroups.get(room.floor) ?? floorGroups.get(0)!;
    const fy = room.floor * target.floorHeightM;

    const isStreetOrGarden =
      room.kind === 'street' || room.kind === 'courtyard' || room.kind === 'garden';
    const slabColor =
      room.kind === 'vault'
        ? 0x263245
        : room.kind === 'shop' || room.kind === 'gallery'
          ? isDresden
            ? 0x5c4f3d
            : 0x3b4456
          : room.kind === 'office' || room.kind === 'lobby'
            ? 0x313847
            : room.kind === 'garden'
              ? 0x162b22
              : room.kind === 'cellar'
                ? 0x232a36
                : room.kind === 'roof'
                  ? 0x252e3d
                  : 0x283242;

    const slabMatParams: THREE.MeshStandardMaterialParameters = {
      color: slabColor,
      roughness: room.kind === 'shop' || room.kind === 'gallery' ? 0.35 : 0.72,
      metalness: room.kind === 'vault' ? 0.45 : 0.12,
    };
    if (isStreetOrGarden) {
      slabMatParams.map = roomPlazaTex;
    }

    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(room.width, 0.16, room.depth),
      new THREE.MeshStandardMaterial(slabMatParams)
    );
    slab.position.set(room.x + room.width / 2, fy - 0.06, room.z + room.depth / 2);
    slab.receiveShadow = true;
    fg.add(slab);

    // Interior room ambient light (linked to power cut!)
    if (!isStreetOrGarden && room.kind !== 'roof') {
      const lightColor = room.lightColor ? new THREE.Color(room.lightColor) : new THREE.Color(0xffd79a);
      const baseIntensity = room.kind === 'gallery' || room.kind === 'shop' ? 14 : 9.5;
      const roomLight = new THREE.PointLight(lightColor, baseIntensity, 24, 1.5);
      roomLight.position.set(
        room.x + room.width / 2,
        fy + target.floorHeightM - 0.65,
        room.z + room.depth / 2
      );
      fg.add(roomLight);
      targetPowerLights.push({ light: roomLight, baseIntensity });
    }
  }

  // Build Walls from WallSegments
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
          ? 2.65
          : w.kind === 'baroque'
            ? 3.85
            : 3.15);
    const thickness =
      w.thickness ??
      (w.kind === 'baroque'
        ? 0.52
        : w.kind === 'exterior'
          ? 0.34
          : w.kind === 'fence'
            ? 0.12
            : 0.22);

    let wallMat: THREE.Material;
    if (w.kind === 'glass') {
      wallMat = new THREE.MeshPhysicalMaterial({
        color: 0x93c5fd,
        transparent: true,
        opacity: 0.26,
        roughness: 0.12,
        metalness: 0.2,
      });
    } else if (w.kind === 'fence') {
      wallMat = new THREE.MeshStandardMaterial({
        color: 0x1e293b,
        roughness: 0.5,
        metalness: 0.78,
        transparent: true,
        opacity: 0.72,
      });
    } else if (w.kind === 'baroque') {
      wallMat = new THREE.MeshStandardMaterial({
        map: stuccoTex,
        color: primaryFacadeColor,
        roughness: 0.72,
        metalness: 0.12,
      });
    } else if (w.kind === 'exterior') {
      wallMat = new THREE.MeshStandardMaterial({
        map: stuccoTex,
        color: primaryFacadeColor,
        roughness: 0.78,
        metalness: 0.08,
      });
    } else {
      wallMat = new THREE.MeshStandardMaterial({
        color: 0x3b475c,
        roughness: 0.75,
        metalness: 0.12,
      });
    }

    const mesh = new THREE.Mesh(new THREE.BoxGeometry(length, height, thickness), wallMat);
    mesh.position.set((w.x1 + w.x2) / 2, fy + height / 2, (w.z1 + w.z2) / 2);
    mesh.rotation.y = -Math.atan2(dz, dx);
    mesh.castShadow = w.kind !== 'glass';
    mesh.receiveShadow = true;
    fg.add(mesh);

    // Top cornice trim on exterior / baroque walls
    if (w.kind === 'exterior' || w.kind === 'baroque') {
      const cap = new THREE.Mesh(
        new THREE.BoxGeometry(length + 0.1, 0.22, thickness + 0.16),
        new THREE.MeshStandardMaterial({ color: trimColor, roughness: 0.55, metalness: 0.25 })
      );
      cap.position.set((w.x1 + w.x2) / 2, fy + height + 0.1, (w.z1 + w.z2) / 2);
      cap.rotation.y = -Math.atan2(dz, dx);
      fg.add(cap);
    }
  }

  // Target storefront glowing neon sign facing street
  const signGroup = new THREE.Group();
  const frontZ = target.id === 'casa_oro' ? 7.25 : target.id === 'perla_del_mar' ? 8.25 : target.id === 'villa_mirador' ? 8.25 : 9.35;
  const signBarMat = new THREE.MeshStandardMaterial({
    color: new THREE.Color(target.themePalette.accentHex),
    emissive: new THREE.Color(target.themePalette.accentHex),
    emissiveIntensity: 2.2,
    roughness: 0.2,
  });
  const signBar = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.34, 0.18), signBarMat);
  signBar.position.set(0, 3.38, frontZ);
  signGroup.add(signBar);
  targetPowerEmissives.push({ mat: signBarMat, baseIntensity: 2.2 });

  const signCanvas = document.createElement('canvas');
  signCanvas.width = 540;
  signCanvas.height = 104;
  const signTex = makeLabelTexture(
    signCanvas,
    target.name.toUpperCase(),
    target.themePalette.accentHex,
    target.subtitle
  );
  const signSprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: signTex, transparent: true })
  );
  signSprite.position.set(0, 3.92, frontZ);
  signSprite.scale.set(4.4, 0.92, 1);
  signGroup.add(signSprite);
  floorGroups.get(0)!.add(signGroup);

  // Alarm interior strobe light
  const alarmLight = new THREE.PointLight(0xef4444, 0, 36, 1.4);
  alarmLight.position.set(0, 4.2, -2);
  root.add(alarmLight);
  alarmLights.push(alarmLight);

  // Dresden baroque colonnade pillars inside & along the Schlossplatz facade!
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
    }
  }

  // 5) Build Interactive Target Nodes
  for (const node of target.nodes) {
    if (node.kind === 'camera') continue; // GuardSystem handles camera models + cones
    const fg = floorGroups.get(node.floor) ?? floorGroups.get(0)!;
    const fy = node.floor * target.floorHeightM;

    const group = new THREE.Group();
    group.name = `Node_${node.id}`;
    group.position.set(node.pos.x, fy, node.pos.z);

    const propRoot = buildArchitecturalProp(node);
    // Orient wall-mounted props nicely toward interior/street
    if (node.kind === 'safe') {
      propRoot.rotation.y = 0; // faces +Z toward room
    } else if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
      propRoot.rotation.y = node.pos.x < 0 ? Math.PI / 2 : -Math.PI / 2;
    } else if (node.kind === 'entry_service' || node.kind === 'entry_window') {
      propRoot.rotation.y = Math.PI / 2;
    } else if (node.kind === 'getaway_zone') {
      propRoot.rotation.y = headingDegToRotY(target.getawayHeadingDeg);
    }
    group.add(propRoot);

    // Interactive ground highlight ring
    const ringGeo = new THREE.RingGeometry(0.72, 0.94, 28);
    ringGeo.rotateX(-Math.PI / 2);
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
    });
    const ringMesh = new THREE.Mesh(ringGeo, ringMat);
    ringMesh.position.y = 0.06;
    group.add(ringMesh);

    // Floating label sprite
    const labelCanvas = document.createElement('canvas');
    labelCanvas.width = 360;
    labelCanvas.height = 92;
    const labelSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: makeLabelTexture(labelCanvas, node.label, '#f59e0b'),
        transparent: true,
        depthTest: false,
      })
    );
    labelSprite.position.set(0, node.kind === 'safe' || node.kind === 'loot_case' ? 2.08 : 1.85, 0);
    labelSprite.scale.set(1.85, 0.48, 1);
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

  // 6) Surrounding Mediterranean Night City Block + Drivable Coastal Grid
  // Keep road corridors completely clear around z = 18, z = -58, z = -134
  // and x = -46, x = 52, x = 128, x = 196!
  const addStreetlamp = (x: number, z: number, rotY: number, withRealLight: boolean) => {
    const lamp = assetRegistry.instantiateModel('streetlamp', false);
    lamp.position.set(x, 0, z);
    lamp.rotation.y = rotY;
    root.add(lamp);

    if (withRealLight) {
      const pl = new THREE.PointLight(
        new THREE.Color(target.themePalette.streetlampHex),
        19,
        28,
        1.55
      );
      pl.position.set(x + Math.sin(rotY) * 0.8, 4.15, z + Math.cos(rotY) * 0.8);
      root.add(pl);
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

  // Streetlamps & Palms framing the active target street + Salou promenade (center sightline clear!)
  const targetStreetLamps: Array<[number, number, number, boolean]> = [
    [-18, 13.5, Math.PI, true],
    [-9.5, 13.5, Math.PI, true],
    [9.5, 13.5, Math.PI, true],
    [18, 13.5, Math.PI, true],
    [-26, 25.5, 0, true],
    [24, 25.5, 0, true],
    [68, 25.5, 0, false],
    [112, 25.5, 0, false],
    [152, 25.5, 0, false],
    [186, 25.5, 0, false],
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
    // Salou Mediterranean palms along the coastal promenade & avenue
    for (let x = -72; x <= 216; x += 18) {
      addPalm(x, 28.5, 0.92 + ((Math.abs(x) % 5) * 0.04), x * 0.17);
    }
    addPalm(-22, 12.5, 0.95, 1.1);
    addPalm(22, 12.5, 1.02, 2.4);
  } else {
    // Dresden historic sandstone colonnade along the plaza edge
    for (let x = -48; x <= 180; x += 28) {
      const col = assetRegistry.instantiateModel('dresden_pillar', false);
      col.position.set(x, 0, 28.5);
      col.rotation.y = Math.PI;
      root.add(col);
    }
  }

  // Modular neighboring Salou townhouse blocks (giving crisp Mediterranean skyline + GTA driving alleys!)
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
    // Immediate neighbors flanking target street
    { cx: -32, cz: -8, w: 16, d: 34, h: 9.2, facadeCount: 2, facadeSouth: true },
    { cx: 34, cz: -8, w: 16, d: 34, h: 10.4, facadeCount: 2, facadeSouth: true },
    // Mid-town Salou blocks along escape route
    { cx: 90, cz: -20, w: 50, d: 48, h: 11.5, facadeCount: 6, facadeSouth: true },
    { cx: 162, cz: -20, w: 46, d: 48, h: 10.0, facadeCount: 5, facadeSouth: true },
    { cx: -82, cz: -20, w: 48, d: 48, h: 9.8, facadeCount: 5, facadeSouth: true },
    // Northern blocks (between z=-58 and z=-134 avenues)
    { cx: 4, cz: -96, w: 68, d: 48, h: 12.5, facadeCount: 7, facadeSouth: true },
    { cx: 90, cz: -96, w: 50, d: 48, h: 13.8, facadeCount: 6, facadeSouth: true },
    { cx: 162, cz: -96, w: 46, d: 48, h: 11.0, facadeCount: 5, facadeSouth: true },
    { cx: -82, cz: -96, w: 48, d: 48, h: 10.5, facadeCount: 4, facadeSouth: true },
    // Industrial harbor silhouette north of La Pineda
    { cx: 40, cz: -172, w: 80, d: 40, h: 14.0, facadeCount: 0, facadeSouth: false },
    { cx: 234, cz: -75, w: 38, d: 140, h: 12.0, facadeCount: 0, facadeSouth: false },
  ];

  const blockWallMat = new THREE.MeshStandardMaterial({
    map: stuccoTex,
    color: isDresden ? 0x57524b : 0x5c4f46,
    roughness: 0.85,
    metalness: 0.08,
  });
  const blockRoofMat = new THREE.MeshStandardMaterial({
    color: 0x151e2e,
    roughness: 0.8,
  });

  for (const blk of cityBlocks) {
    // Solid backing volume
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

    // Attach stylized salou_facade.glb modules along south street front (or Dresden pillars!)
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

  // Also add an AABB collider for the target building footprint during escape car driving
  cityBoxColliders.push({
    minX: target.bounds.minX + 3,
    maxX: target.bounds.maxX - 3,
    minZ: target.bounds.minZ + 1,
    maxZ: Math.min(7.5, target.bounds.maxZ - 7),
  });

  // 7) La Pineda Safehouse Extraction Zone (reachable drivable destination!)
  const safehousePos: Vec2 = { x: 162, z: -158 };
  const {
    group: safehouseBeacon,
    beaconRing,
    beaconBeam,
  } = buildSafehouseBeacon(isDresden);
  safehouseBeacon.position.set(safehousePos.x, 0, safehousePos.z);
  root.add(safehouseBeacon);

  // 8) Distant Atmospheric Skyline (La Pineda Refinery Light-Sea / Dresden Baroque Spires)
  const skylineGroup = new THREE.Group();
  const spireMat = new THREE.MeshBasicMaterial({
    color: isDresden ? 0x161b2c : 0x10182a,
  });
  const warmGlowMat = new THREE.MeshBasicMaterial({ color: 0xffb347 });
  const cyanGlowMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  for (let i = 0; i < 16; i++) {
    const sx = -130 + i * 24;
    const sz = -215 - (i % 3) * 18;
    const h = isDresden ? 18 + (i % 4) * 10 : 14 + (i % 5) * 7;
    const tower = new THREE.Mesh(
      new THREE.BoxGeometry(isDresden ? 8 : 11, h, 8),
      spireMat
    );
    tower.position.set(sx, h / 2, sz);
    skylineGroup.add(tower);

    // Subtle distant glowing harbor / dome beacon dots
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.65, 6, 6),
      i % 3 === 0 ? cyanGlowMat : warmGlowMat
    );
    dot.position.set(sx, h + 0.8, sz + 3);
    skylineGroup.add(dot);
  }
  root.add(skylineGroup);

  // Wall colliders for foot movement inside/around the target
  const wallColliders = buildWallColliders(target.walls);

  // Focus floor visibility manager (clean architectural cutaway for cellar/upper floors)
  const setFocusFloor = (floor: FloorId) => {
    for (const [fId, fg] of floorGroups.entries()) {
      if (floor < 0) {
        fg.visible = fId === floor;
      } else {
        // Show current floor and floor 0 below it; hide upper floors above active floor
        fg.visible = fId >= 0 && fId <= floor;
      }
    }
    // Dim road ground slightly when inside Keller so cellar floor is cleanly unobstructed
    roadGround.visible = floor >= 0;
  };
  setFocusFloor(0);

  let currentPowerDisabled = false;
  const setPowerDisabled = (disabled: boolean) => {
    currentPowerDisabled = disabled;
    for (const item of targetPowerLights) {
      item.light.intensity = disabled ? item.baseIntensity * 0.12 : item.baseIntensity;
    }
    for (const item of targetPowerEmissives) {
      item.mat.emissiveIntensity = disabled ? 0.08 : item.baseIntensity;
    }
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
    palmCanopies,
    targetPowerLights,
    targetPowerEmissives,
    alarmLights,
    waterMesh,
    setFocusFloor,
    setPowerDisabled,
    update: ({
      dt,
      timeSec,
      phase,
      intel,
      completedNodeIds,
      triggeredHazardIds,
      powerDisabled,
      alarmLevel,
      highlightedNodeId,
      workingNodeIds,
    }) => {
      if (powerDisabled !== currentPowerDisabled) {
        setPowerDisabled(powerDisabled);
      }

      // Gentle coastal palm breeze sway
      for (const p of palmCanopies) {
        p.obj.rotation.x = Math.sin(timeSec * 1.1 + p.phase) * 0.028;
        p.obj.rotation.z = Math.cos(timeSec * 0.85 + p.phase) * 0.024;
      }

      // Subtle alarm strobe inside target
      const alarmActive = alarmLevel === 'alarm' || alarmLevel === 'lockdown';
      for (const al of alarmLights) {
        al.intensity = alarmActive ? (Math.sin(timeSec * 9.5) * 0.5 + 0.5) * 28 : 0;
      }

      // Pulse safehouse extraction beacon (prominent in escape mode)
      safehouseBeacon.visible = phase === 'escape';
      if (phase === 'escape') {
        const pulse = 1 + Math.sin(timeSec * 4.2) * 0.12;
        beaconRing.scale.set(pulse, pulse, 1);
        beaconBeam.rotation.y = timeSec * 0.5;
      }

      // Animate & style every interactive node prop
      const completedSet = new Set(completedNodeIds);
      const discoveredSet = new Set(intel.discoveredNodeIds);
      const triggeredSet = new Set(triggeredHazardIds);

      for (const handle of nodeVisuals.values()) {
        const { node, propRoot, ringMesh, ringMat, labelSprite } = handle;
        const isCompleted = completedSet.has(node.id);
        const isDiscovered = discoveredSet.has(node.id) || node.visibleFromStreet;
        const isHighlighted = highlightedNodeId === node.id;
        const isWorking = workingNodeIds.has(node.id);
        const isTriggered = triggeredSet.has(node.id);

        // Hide markers & gameplay-only sidewalk markers in Escape driving mode
        if (phase === 'escape') {
          ringMesh.visible = false;
          labelSprite.visible = false;
          if (
            node.kind === 'lookout' ||
            node.kind === 'getaway_zone' ||
            node.isHiddenHazard
          ) {
            propRoot.visible = false;
          }
          continue;
        }

        // Hidden hazards stay stealthy until discovered or triggered
        if (node.isHiddenHazard) {
          const reveal = isDiscovered || isTriggered || isHighlighted;
          propRoot.visible = reveal;
          ringMesh.visible = reveal;
          labelSprite.visible = reveal;
          const laser = propRoot.getObjectByName('Trap_Laser');
          if (laser) {
            laser.visible = reveal && !powerDisabled && !isCompleted;
          }
          if (!reveal) continue;
        } else {
          propRoot.visible = true;
          ringMesh.visible = true;
          labelSprite.visible = isHighlighted || isDiscovered || phase === 'scouting';
        }

        // Ring color & subtle pulse
        let ringHex = '#f59e0b';
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
          // Executing phase
          if (isCompleted) {
            ringHex = '#22c55e';
            subText = 'ERLEDIGT ✓';
          } else if (isWorking) {
            ringHex = '#38bdf8';
            subText = 'IN ARBEIT...';
          } else if (isHighlighted) {
            ringHex = '#38bdf8';
            subText = node.kind === 'getaway_zone' ? '[E] FLUCHT STARTEN' : '[E] INTERAGIEREN';
          } else if (node.kind === 'safe' || node.kind === 'loot_case') {
            ringHex = '#fbbf24';
            subText = node.lootValue ? `${(node.lootValue / 1000).toFixed(0)}k €` : 'BEUTE';
          } else if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
            ringHex = '#38bdf8';
            subText = node.kind === 'power_box' ? 'STROM' : 'ALARM';
          } else {
            ringHex = '#94a3b8';
            subText = '';
          }
        }

        ringMat.color.set(ringHex);
        ringMat.opacity = isHighlighted ? 0.92 : isCompleted ? 0.32 : 0.56;
        const rScale = isHighlighted ? 1.18 + Math.sin(timeSec * 6) * 0.08 : 1.0;
        ringMesh.scale.set(rScale, rScale, 1);

        updateLabelSprite(handle, node.label, ringHex, subText);

        // Animate prop mechanics!
        const targetOpen = isCompleted ? 1 : 0;
        handle.openedAmount += (targetOpen - handle.openedAmount) * Math.min(1, dt * 5);

        if (node.kind === 'safe') {
          const safeDoor = propRoot.getObjectByName('Safe_Door');
          if (safeDoor) {
            safeDoor.rotation.y = -1.8 * handle.openedAmount;
          }
          const safeDial = propRoot.getObjectByName('Safe_Dial');
          if (safeDial && isWorking) {
            safeDial.rotation.z += dt * 4.5;
          }
          const safeLoot = propRoot.getObjectByName('Safe_Loot');
          if (safeLoot) {
            safeLoot.visible = !isCompleted;
          }
          const safeLed = propRoot.getObjectByName('Safe_LED') as THREE.Mesh | undefined;
          if (safeLed && safeLed.material instanceof THREE.MeshStandardMaterial) {
            const c = isCompleted ? 0x22c55e : 0xef4444;
            safeLed.material.color.setHex(c);
            safeLed.material.emissive.setHex(c);
          }
        } else if (node.kind === 'loot_case') {
          const artifact = propRoot.getObjectByName('Artifact');
          if (artifact) {
            artifact.visible = !isCompleted;
            artifact.rotation.y = timeSec * 0.9;
          }
          const glassHood = propRoot.getObjectByName('Glass_Hood');
          if (glassHood) {
            glassHood.position.y = handle.openedAmount * 0.45;
          }
        } else if (node.kind === 'power_box' || node.kind === 'alarm_panel') {
          const lever = propRoot.getObjectByName('Breaker_Lever');
          if (lever) {
            lever.rotation.x = handle.openedAmount * 1.15;
          }
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
          const doorLeaf = propRoot.getObjectByName('Door_Leaf');
          if (doorLeaf) {
            doorLeaf.rotation.y = -1.5 * handle.openedAmount;
          }
          const led = propRoot.getObjectByName('Lock_LED') as THREE.Mesh | undefined;
          if (led && led.material instanceof THREE.MeshStandardMaterial) {
            const c = isCompleted ? 0x22c55e : 0xf59e0b;
            led.material.color.setHex(c);
            led.material.emissive.setHex(c);
          }
        } else if (node.kind === 'entry_roof' || node.kind === 'entry_cellar') {
          const lid = propRoot.getObjectByName('Hatch_Lid');
          if (lid) {
            lid.rotation.z = 1.45 * handle.openedAmount;
          }
        }
      }
    },
    dispose: () => {
      for (const d of disposables) d.dispose();
      disposeSceneSubtree(root);
    },
  };
}
