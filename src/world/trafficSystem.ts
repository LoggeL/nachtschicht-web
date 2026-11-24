import * as THREE from 'three';
import { HeistTarget, Vec2 } from '../sim/types';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import {
  AabbCollider,
  clamp,
  damp,
  dist2D,
  normalizeAngleRad,
  resolveCircleVsAabb,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — Salou / Dresden Street Grid Graph & Living Night Traffic
// Provides:
//   1) Geometrically verified Salou/Dresden road corridor graph & A* router
//      (shared with Mossos police pursuit AI in vehicleController.ts).
//   2) Exact 2D ray-vs-AABB city building Line-of-Sight occlusion checker.
//   3) Ambient right-hand European night traffic (`traffic_car.glb` with
//      authentic paint variants, headlights, dynamic brake lights, turn
//      signals, smooth intersection cornering, obstacle spacing, and
//      realistic curb-pulling/swerving when police sirens approach).
// ============================================================================

export interface RoadNode {
  id: string;
  x: number;
  z: number;
  neighbors: string[];
  isCoastal?: boolean;
  isPortal?: boolean;
}

export interface TrafficPoliceSignal {
  pos: Vec2;
  vx: number;
  vz: number;
  sirenActive: boolean;
}

export interface TrafficObstacle {
  id: string;
  pos: Vec2;
  rotY: number;
  vx: number;
  vz: number;
  halfWidth: number;
  halfLength: number;
}

/**
 * Shared city street corridor network matching levelBuilder.ts cityBlocks:
 * - Horizontal avenues: z = 18 (Coastal Promenade), z = -58 (Midtown), z = -134 (Harbor/La Pineda)
 * - Vertical cross-streets: x = -46, x = 52, x = 128, x = 196
 * - Extended west boulevard portals at x = -102 so coastal traffic flows cleanly
 *   across the entire visible Salou promenade without abrupt U-turns in view.
 */
export const CITY_ROAD_NODES: RoadNode[] = [
  // Row 0: South Coastal Promenade (z = 18)
  { id: 'w_coast', x: -102, z: 18, neighbors: ['n00'], isCoastal: true, isPortal: true },
  { id: 'n00', x: -46, z: 18, neighbors: ['w_coast', 'n10', 'n01'], isCoastal: true },
  { id: 'n10', x: 52, z: 18, neighbors: ['n00', 'n20', 'n11'], isCoastal: true },
  { id: 'n20', x: 128, z: 18, neighbors: ['n10', 'n30', 'n21'], isCoastal: true },
  { id: 'n30', x: 196, z: 18, neighbors: ['n20', 'n31'], isCoastal: true },

  // Row 1: Midtown Avenue (z = -58)
  { id: 'w_mid', x: -102, z: -58, neighbors: ['n01'], isPortal: true },
  { id: 'n01', x: -46, z: -58, neighbors: ['w_mid', 'n00', 'n11', 'n02'] },
  { id: 'n11', x: 52, z: -58, neighbors: ['n01', 'n10', 'n21', 'n12'] },
  { id: 'n21', x: 128, z: -58, neighbors: ['n11', 'n20', 'n31', 'n22'] },
  { id: 'n31', x: 196, z: -58, neighbors: ['n21', 'n30', 'n32'] },

  // Row 2: North Harbor / La Pineda Avenue (z = -134)
  { id: 'n02', x: -46, z: -134, neighbors: ['n01', 'n12'] },
  { id: 'n12', x: 52, z: -134, neighbors: ['n02', 'n11', 'n22'] },
  { id: 'n22', x: 128, z: -134, neighbors: ['n12', 'n21', 'n32'] },
  { id: 'n32', x: 196, z: -134, neighbors: ['n22', 'n31'] },
];

export const CITY_ROAD_NODE_MAP: Map<string, RoadNode> = new Map(
  CITY_ROAD_NODES.map((n) => [n.id, n])
);

/**
 * Exact 2D ray-segment vs AABB intersection test (slab method).
 * Returns true if segment (ax, az) -> (bx, bz) hits the interior of `box`.
 */
export function segmentIntersectsAabb(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  box: AabbCollider,
  padding = 0
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  let tMin = 0;
  let tMax = 1;

  const minX = box.minX - padding;
  const maxX = box.maxX + padding;
  const minZ = box.minZ - padding;
  const maxZ = box.maxZ + padding;

  if (Math.abs(dx) < 1e-6) {
    if (ax < minX || ax > maxX) return false;
  } else {
    const invD = 1 / dx;
    let t1 = (minX - ax) * invD;
    let t2 = (maxX - ax) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  if (Math.abs(dz) < 1e-6) {
    if (az < minZ || az > maxZ) return false;
  } else {
    const invD = 1 / dz;
    let t1 = (minZ - az) * invD;
    let t2 = (maxZ - az) * invD;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return tMax >= tMin && tMax >= 0 && tMin <= 1;
}

/**
 * Returns true if there is an unobstructed visual line-of-sight between `from`
 * and `to` through the Salou/Dresden city block colliders.
 */
export function hasCityLineOfSight(
  from: Vec2,
  to: Vec2,
  cityBoxColliders: AabbCollider[]
): boolean {
  for (let i = 0; i < cityBoxColliders.length; i++) {
    if (segmentIntersectsAabb(from.x, from.z, to.x, to.z, cityBoxColliders[i], -0.15)) {
      return false;
    }
  }
  return true;
}

/**
 * Finds the nearest road intersection node to an arbitrary world position.
 * Optionally prefers a node that is line-of-sight visible from `pos`.
 */
export function findNearestRoadNode(
  pos: Vec2,
  cityBoxColliders?: AabbCollider[],
  excludePortals = false
): RoadNode {
  let best: RoadNode = CITY_ROAD_NODES[1];
  let bestScore = Infinity;

  for (const node of CITY_ROAD_NODES) {
    if (excludePortals && node.isPortal) continue;
    let d = dist2D(pos.x, pos.z, node.x, node.z);
    if (cityBoxColliders && !hasCityLineOfSight(pos, node, cityBoxColliders)) {
      d += 42; // Prefer corridor-visible intersections
    }
    if (d < bestScore) {
      bestScore = d;
      best = node;
    }
  }
  return best;
}

/**
 * Fast A* road corridor pathfinder across CITY_ROAD_NODES.
 * Returns ordered world waypoints from start intersection to destination intersection.
 */
export function findCityRoadPath(
  from: Vec2,
  to: Vec2,
  cityBoxColliders?: AabbCollider[]
): Vec2[] {
  const startNode = findNearestRoadNode(from, cityBoxColliders, false);
  const goalNode = findNearestRoadNode(to, cityBoxColliders, false);

  if (startNode.id === goalNode.id) {
    return [{ x: goalNode.x, z: goalNode.z }];
  }

  const openSet = new Set<string>([startNode.id]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[startNode.id, 0]]);
  const fScore = new Map<string, number>([
    [startNode.id, dist2D(startNode.x, startNode.z, goalNode.x, goalNode.z)],
  ]);

  while (openSet.size > 0) {
    let currentId = '';
    let lowestF = Infinity;
    for (const id of openSet) {
      const f = fScore.get(id) ?? Infinity;
      if (f < lowestF) {
        lowestF = f;
        currentId = id;
      }
    }

    if (!currentId || currentId === goalNode.id) {
      const path: Vec2[] = [];
      let curr: string | undefined = goalNode.id;
      while (curr) {
        const n = CITY_ROAD_NODE_MAP.get(curr);
        if (n) path.push({ x: n.x, z: n.z });
        curr = cameFrom.get(curr);
      }
      path.reverse();
      return path;
    }

    openSet.delete(currentId);
    const current = CITY_ROAD_NODE_MAP.get(currentId)!;
    const currentG = gScore.get(currentId) ?? Infinity;

    for (const nbrId of current.neighbors) {
      const nbr = CITY_ROAD_NODE_MAP.get(nbrId);
      if (!nbr) continue;
      const tentativeG = currentG + dist2D(current.x, current.z, nbr.x, nbr.z);
      if (tentativeG < (gScore.get(nbrId) ?? Infinity)) {
        cameFrom.set(nbrId, currentId);
        gScore.set(nbrId, tentativeG);
        fScore.set(nbrId, tentativeG + dist2D(nbr.x, nbr.z, goalNode.x, goalNode.z));
        openSet.add(nbrId);
      }
    }
  }

  return [{ x: goalNode.x, z: goalNode.z }];
}

/**
 * Computes the European right-hand lane offset vector for travel from `a` to `b`.
 * In Three.js (+X East, +Z South, +Y Up): right of unit forward (dx, dz) is (-dz, dx).
 */
export function getRightHandLaneOffset(from: Vec2, to: Vec2): Vec2 {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const len = Math.hypot(dx, dz) || 1;
  const nx = dx / len;
  const nz = dz / len;

  // Coastal boulevard (z = 18) has tighter north clearance near target streetlamps/parked car
  const onCoastal = Math.abs(from.z - 18) < 2 && Math.abs(to.z - 18) < 2;
  let offset = 3.1;
  if (onCoastal) {
    // Eastbound (+X) -> south side (+Z) has ample room; Westbound (-X) -> north side (-Z) tighter
    offset = nx > 0 ? 3.05 : 2.15;
  }

  return {
    x: -nz * offset,
    z: nx * offset,
  };
}

// ----------------------------------------------------------------------------
// Realistic European Night Traffic Vehicle Paint Variants
// ----------------------------------------------------------------------------

const EUROPEAN_NIGHT_PAINTS = [
  0xcbd5e1, // Pearl Silver Metallic
  0x64748b, // Steel Slate
  0x1e293b, // Midnight Navy
  0x3f3f46, // Graphite Metallic
  0x4c1d24, // Mediterranean Burgundy
  0x1e3a2f, // Deep Alpine Green
  0x78716c, // Warm Champagne Grey
  0x18181b, // Obsidian Black
  0x94a3b8, // Ice Silver
  0x273549, // Petrol Blue
];

interface TrafficVisual {
  root: THREE.Group;
  chassisGroup: THREE.Group;
  wheelFL?: THREE.Object3D;
  wheelFR?: THREE.Object3D;
  wheelRL?: THREE.Object3D;
  wheelRR?: THREE.Object3D;
  headlightsMat?: THREE.MeshStandardMaterial;
  taillightsMat?: THREE.MeshStandardMaterial;
  brakelightsMat?: THREE.MeshStandardMaterial;
  turnLeftMat?: THREE.MeshBasicMaterial;
  turnRightMat?: THREE.MeshBasicMaterial;
  beamGroup: THREE.Group;
}

interface TrafficCarAgent {
  id: string;
  visual: TrafficVisual;
  fromNodeId: string;
  toNodeId: string;
  nextNodeId: string;
  pos: Vec2;
  rotY: number;
  speed: number;
  cruiseSpeed: number;
  steerAngle: number;
  wheelSpin: number;
  lateralYieldOffset: number; // Pulls right for police sirens / parked cars
  bodyRoll: number;
  bodyPitch: number;
  prevSpeed: number;
  braking: boolean;
  yieldingToSiren: boolean;
  turnSignal: -1 | 0 | 1; // -1 right, 0 off, +1 left
  bumpVx: number;
  bumpVz: number;
  stunTimer: number;
  coastalLoopDir?: 1 | -1; // Dedicated coastal boulevard cruisers wrap smoothly
}

function createSoftBeamTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  // Soft tapered headlight pool on wet asphalt (bright near lens, smooth radial fade)
  const grad = ctx.createRadialGradient(64, 18, 4, 64, 68, 62);
  grad.addColorStop(0, 'rgba(255, 244, 214, 0.72)');
  grad.addColorStop(0.35, 'rgba(255, 232, 180, 0.34)');
  grad.addColorStop(0.75, 'rgba(255, 218, 150, 0.08)');
  grad.addColorStop(1, 'rgba(255, 210, 140, 0.0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function tintTrafficBodyPaint(model: THREE.Group, hexColor: number): void {
  const tint = new THREE.Color(hexColor);
  model.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return;
    const mesh = obj as THREE.Mesh;
    const nameLower = mesh.name.toLowerCase();
    // Skip wheels, glass, lights, interior, plates
    if (
      nameLower.includes('wheel') ||
      nameLower.includes('glass') ||
      nameLower.includes('headlight') ||
      nameLower.includes('taillight') ||
      nameLower.includes('brakelight') ||
      nameLower.includes('interior') ||
      nameLower.includes('tire')
    ) {
      return;
    }

    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      if (!(m instanceof THREE.MeshStandardMaterial)) continue;
      const matName = (m.name || '').toLowerCase();
      // Only tint primary body paint material (avoid black trim, chrome, grille, plates, tires)
      const isPaintMat =
        matName.includes('paint') ||
        matName.includes('body') ||
        matName.includes('coat') ||
        matName.includes('carpaint') ||
        (nameLower === 'body' && matName === '');
      if (isPaintMat) {
        m.color.copy(tint);
        // Preserve packed PBR micro-flake roughnessMap/metalnessMap on photoreal traffic_car.glb
        if (!m.roughnessMap) {
          m.roughness = Math.min(m.roughness, 0.28);
        }
        if (!m.metalnessMap) {
          m.metalness = Math.max(m.metalness, 0.52);
        }
      }
    }
  });
}

function extractCarSubParts(model: THREE.Group): {
  chassisGroup: THREE.Group;
  wheelFL?: THREE.Object3D;
  wheelFR?: THREE.Object3D;
  wheelRL?: THREE.Object3D;
  wheelRR?: THREE.Object3D;
  headlightsMat?: THREE.MeshStandardMaterial;
  taillightsMat?: THREE.MeshStandardMaterial;
  brakelightsMat?: THREE.MeshStandardMaterial;
} {
  const wheelFL = model.getObjectByName('Wheel_FL');
  const wheelFR = model.getObjectByName('Wheel_FR');
  const wheelRL = model.getObjectByName('Wheel_RL');
  const wheelRR = model.getObjectByName('Wheel_RR');
  for (const w of [wheelFL, wheelFR, wheelRL, wheelRR]) {
    if (w) w.rotation.order = 'YXZ';
  }

  const findMat = (names: string[]): THREE.MeshStandardMaterial | undefined => {
    for (const n of names) {
      const obj = model.getObjectByName(n) as THREE.Mesh | undefined;
      if (obj && obj.isMesh) {
        const m = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (m instanceof THREE.MeshStandardMaterial) return m;
      }
    }
    return undefined;
  };

  const headlightsMat = findMat(['Headlights', 'Headlight']);
  const taillightsMat = findMat(['Taillights', 'Taillight']);
  const brakelightsMat = findMat(['Brakelights', 'Brakelight', 'BrakeLights']);

  // Separate non-wheel chassis meshes into a roll-center pivot group so wheels stay planted!
  const chassisGroup = new THREE.Group();
  chassisGroup.name = 'TrafficChassisPivot';
  const wheelSet = new Set<THREE.Object3D>(
    [wheelFL, wheelFR, wheelRL, wheelRR].filter(Boolean) as THREE.Object3D[]
  );

  // Check if wheels are direct children of model (matching Blender GLB & fallback convention)
  const directWheelChildren = model.children.filter((c) => wheelSet.has(c));
  if (directWheelChildren.length >= 2) {
    const bodyChildren = model.children.filter((c) => !wheelSet.has(c));
    chassisGroup.position.set(0, 0.42, 0);
    for (const child of bodyChildren) {
      model.remove(child);
      child.position.y -= 0.42;
      chassisGroup.add(child);
    }
    model.add(chassisGroup);
  } else {
    // Nested glTF scene root fallback: tilt model itself gently
    return {
      chassisGroup: model,
      wheelFL,
      wheelFR,
      wheelRL,
      wheelRR,
      headlightsMat,
      taillightsMat,
      brakelightsMat,
    };
  }

  return {
    chassisGroup,
    wheelFL,
    wheelFR,
    wheelRL,
    wheelRR,
    headlightsMat,
    taillightsMat,
    brakelightsMat,
  };
}

export class TrafficSystem {
  public readonly root = new THREE.Group();
  private agents: TrafficCarAgent[] = [];
  private beamTex: THREE.CanvasTexture | null;
  private beamGeo: THREE.PlaneGeometry;
  private indicatorGeo: THREE.BoxGeometry;
  private disposables: Array<{ dispose: () => void }> = [];
  private rngSeed: number;

  constructor(target: HeistTarget) {
    this.root.name = `TrafficSystem_${target.id}`;
    this.rngSeed = target.id.length * 1337 + 42;

    this.beamTex = createSoftBeamTexture();
    if (this.beamTex) this.disposables.push(this.beamTex);

    this.beamGeo = new THREE.PlaneGeometry(3.4, 11.5);
    this.beamGeo.rotateX(-Math.PI / 2);
    this.disposables.push(this.beamGeo);

    this.indicatorGeo = new THREE.BoxGeometry(0.14, 0.1, 0.14);
    this.disposables.push(this.indicatorGeo);

    this.spawnInitialTraffic(target);
  }

  private rand(): number {
    this.rngSeed = (this.rngSeed * 1664525 + 1013904223) >>> 0;
    return this.rngSeed / 4294967296;
  }

  private createTrafficVisual(paintHex: number): TrafficVisual {
    const carRoot = new THREE.Group();
    const model = assetRegistry.instantiateModel('traffic_car', true);
    tintTrafficBodyPaint(model, paintHex);
    carRoot.add(model);

    const parts = extractCarSubParts(model);

    // Ensure warm glowing headlights & crisp red taillights
    if (parts.headlightsMat) {
      parts.headlightsMat.emissive.setHex(0xffe6b3);
      parts.headlightsMat.emissiveIntensity = 2.6;
    }
    if (parts.taillightsMat) {
      parts.taillightsMat.emissive.setHex(0xdc2626);
      parts.taillightsMat.emissiveIntensity = 1.6;
    }
    if (parts.brakelightsMat) {
      parts.brakelightsMat.emissive.setHex(0xef4444);
      parts.brakelightsMat.emissiveIntensity = 0.25;
    }

    // Subtle soft ground-projected warm headlight pool (lightweight, realistic on wet asphalt!)
    const beamGroup = new THREE.Group();
    const beamMatParams: THREE.MeshBasicMaterialParameters = {
      color: 0xffebc2,
      transparent: true,
      opacity: this.beamTex ? 0.42 : 0.12,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    };
    if (this.beamTex) {
      beamMatParams.map = this.beamTex;
    }
    const beamMat = new THREE.MeshBasicMaterial(beamMatParams);
    this.disposables.push(beamMat);

    const beamMesh = new THREE.Mesh(this.beamGeo, beamMat);
    beamMesh.position.set(0, 0.04, 7.6);
    beamMesh.userData.excludeFromAO = true;
    beamGroup.add(beamMesh);
    beamGroup.userData.excludeFromAO = true;
    carRoot.add(beamGroup);

    // Subtle amber turn-signal indicators on front/rear corners
    const turnLeftMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
    });
    const turnRightMat = new THREE.MeshBasicMaterial({
      color: 0xf59e0b,
      transparent: true,
      opacity: 0,
    });
    this.disposables.push(turnLeftMat, turnRightMat);

    const tlFront = new THREE.Mesh(this.indicatorGeo, turnLeftMat);
    tlFront.position.set(0.82, 0.56, 2.08);
    tlFront.userData.excludeFromAO = true;
    const tlRear = new THREE.Mesh(this.indicatorGeo, turnLeftMat);
    tlRear.position.set(0.82, 0.62, -2.08);
    tlRear.userData.excludeFromAO = true;

    const trFront = new THREE.Mesh(this.indicatorGeo, turnRightMat);
    trFront.position.set(-0.82, 0.56, 2.08);
    trFront.userData.excludeFromAO = true;
    const trRear = new THREE.Mesh(this.indicatorGeo, turnRightMat);
    trRear.position.set(-0.82, 0.62, -2.08);
    trRear.userData.excludeFromAO = true;

    carRoot.add(tlFront, tlRear, trFront, trRear);

    return {
      root: carRoot,
      ...parts,
      turnLeftMat,
      turnRightMat,
      beamGroup,
    };
  }

  private pickNextNode(prevId: string, currentId: string, coastalDir?: 1 | -1): string {
    const curr = CITY_ROAD_NODE_MAP.get(currentId);
    if (!curr || curr.neighbors.length === 0) return currentId;

    // Dedicated coastal cruisers travel cleanly along z=18
    if (coastalDir !== undefined) {
      const coastalChain = ['w_coast', 'n00', 'n10', 'n20', 'n30'];
      const idx = coastalChain.indexOf(currentId);
      if (idx !== -1) {
        const nextIdx = idx + coastalDir;
        if (nextIdx >= 0 && nextIdx < coastalChain.length) {
          return coastalChain[nextIdx];
        }
      }
    }

    // Filter out U-turns and west dead-end portals unless no choice
    const forwardChoices = curr.neighbors.filter((nid) => {
      if (nid === prevId) return false;
      const n = CITY_ROAD_NODE_MAP.get(nid);
      if (n?.isPortal) return false;
      return true;
    });

    if (forwardChoices.length === 0) {
      const nonPortals = curr.neighbors.filter((nid) => !CITY_ROAD_NODE_MAP.get(nid)?.isPortal);
      return nonPortals[0] ?? curr.neighbors[0];
    }

    // Prefer continuing straight ~55% of the time for natural avenue flow
    const prev = CITY_ROAD_NODE_MAP.get(prevId);
    if (prev) {
      const inDx = curr.x - prev.x;
      const inDz = curr.z - prev.z;
      const inLen = Math.hypot(inDx, inDz) || 1;
      for (const cid of forwardChoices) {
        const cn = CITY_ROAD_NODE_MAP.get(cid)!;
        const outDx = cn.x - curr.x;
        const outDz = cn.z - curr.z;
        const outLen = Math.hypot(outDx, outDz) || 1;
        const dot = (inDx * outDx + inDz * outDz) / (inLen * outLen);
        if (dot > 0.85 && this.rand() < 0.58) {
          return cid;
        }
      }
    }

    const pickIdx = Math.floor(this.rand() * forwardChoices.length);
    return forwardChoices[pickIdx];
  }

  private spawnInitialTraffic(target: HeistTarget): void {
    // 14 well-spaced European night sedans:
    // 6 on Salou's main coastal boulevard (visible during scouting, heist, and escape!)
    // 8 circulating across midtown, harbor, and N-S cross-streets
    const initialRoutes: Array<{
      from: string;
      to: string;
      t: number;
      cruise: number;
      coastalLoopDir?: 1 | -1;
    }> = [
      // Coastal boulevard eastbound (+X, south right-hand lane z ≈ 21.05)
      { from: 'w_coast', to: 'n00', t: 0.45, cruise: 13.8, coastalLoopDir: 1 },
      { from: 'n00', to: 'n10', t: 0.25, cruise: 13.2, coastalLoopDir: 1 },
      { from: 'n10', to: 'n20', t: 0.58, cruise: 14.5, coastalLoopDir: 1 },
      // Coastal boulevard westbound (-X, north right-hand lane z ≈ 15.85)
      { from: 'n30', to: 'n20', t: 0.35, cruise: 13.4, coastalLoopDir: -1 },
      { from: 'n20', to: 'n10', t: 0.65, cruise: 12.6, coastalLoopDir: -1 },
      { from: 'n10', to: 'n00', t: 0.78, cruise: 12.2, coastalLoopDir: -1 },

      // Midtown & Harbor avenues + N-S cross-streets
      { from: 'n01', to: 'n11', t: 0.35, cruise: 12.5 },
      { from: 'n21', to: 'n11', t: 0.48, cruise: 13.0 },
      { from: 'n11', to: 'n12', t: 0.42, cruise: 12.2 },
      { from: 'n22', to: 'n21', t: 0.52, cruise: 13.5 },
      { from: 'n12', to: 'n22', t: 0.30, cruise: 12.8 },
      { from: 'n31', to: 'n30', t: 0.44, cruise: 14.0 },
      { from: 'n02', to: 'n01', t: 0.55, cruise: 11.8 },
      { from: 'n20', to: 'n21', t: 0.62, cruise: 13.1 },
    ];

    initialRoutes.forEach((spec, idx) => {
      const fromNode = CITY_ROAD_NODE_MAP.get(spec.from);
      const toNode = CITY_ROAD_NODE_MAP.get(spec.to);
      if (!fromNode || !toNode) return;

      const laneOff = getRightHandLaneOffset(fromNode, toNode);
      const px = fromNode.x + (toNode.x - fromNode.x) * spec.t + laneOff.x;
      const pz = fromNode.z + (toNode.z - fromNode.z) * spec.t + laneOff.z;

      // Avoid spawning right on top of the target's getaway car
      if (dist2D(px, pz, target.getawayPos.x, target.getawayPos.z) < 11) {
        return;
      }

      const rotY = Math.atan2(toNode.x - fromNode.x, toNode.z - fromNode.z);
      const paint = EUROPEAN_NIGHT_PAINTS[idx % EUROPEAN_NIGHT_PAINTS.length];
      const visual = this.createTrafficVisual(paint);
      visual.root.name = `TrafficCar_${idx}`;
      visual.root.position.set(px, 0, pz);
      visual.root.rotation.y = rotY;
      this.root.add(visual.root);

      const nextNodeId = this.pickNextNode(spec.from, spec.to, spec.coastalLoopDir);

      this.agents.push({
        id: `traffic_${idx}`,
        visual,
        fromNodeId: spec.from,
        toNodeId: spec.to,
        nextNodeId,
        pos: { x: px, z: pz },
        rotY,
        speed: spec.cruise * 0.85,
        cruiseSpeed: spec.cruise,
        steerAngle: 0,
        wheelSpin: this.rand() * Math.PI * 2,
        lateralYieldOffset: 0,
        bodyRoll: 0,
        bodyPitch: 0,
        prevSpeed: spec.cruise * 0.85,
        braking: false,
        yieldingToSiren: false,
        turnSignal: 0,
        bumpVx: 0,
        bumpVz: 0,
        stunTimer: 0,
        coastalLoopDir: spec.coastalLoopDir,
      });
    });
  }

  public getObstacles(): TrafficObstacle[] {
    return this.agents.map((a) => ({
      id: a.id,
      pos: { x: a.pos.x, z: a.pos.z },
      rotY: a.rotY,
      vx: Math.sin(a.rotY) * a.speed + a.bumpVx,
      vz: Math.cos(a.rotY) * a.speed + a.bumpVz,
      halfWidth: 1.0,
      halfLength: 2.2,
    }));
  }

  /**
   * Called by VehicleController when player or police clips a civilian car.
   */
  public applyCollisionImpulse(
    trafficId: string,
    impulseVx: number,
    impulseVz: number,
    impactSpeed: number
  ): void {
    const agent = this.agents.find((a) => a.id === trafficId);
    if (!agent) return;
    agent.bumpVx = clamp(agent.bumpVx + impulseVx, -16, 16);
    agent.bumpVz = clamp(agent.bumpVz + impulseVz, -16, 16);
    agent.speed *= 0.35;
    agent.stunTimer = Math.max(agent.stunTimer, clamp(0.8 + impactSpeed * 0.08, 0.9, 2.2));
    agent.braking = true;
  }

  public update(params: {
    dt: number;
    timeSec: number;
    phase: 'scouting' | 'executing' | 'escape';
    playerCarPos?: Vec2;
    playerCarVel?: Vec2;
    policeUnits?: TrafficPoliceSignal[];
    cityBoxColliders?: AabbCollider[];
  }): void {
    const {
      dt,
      timeSec,
      phase,
      playerCarPos,
      playerCarVel,
      policeUnits = [],
      cityBoxColliders = [],
    } = params;

    const blinkOn = Math.sin(timeSec * 8.5) > 0;

    for (let i = 0; i < this.agents.length; i++) {
      const car = this.agents[i];
      const fromNode = CITY_ROAD_NODE_MAP.get(car.fromNodeId);
      const toNode = CITY_ROAD_NODE_MAP.get(car.toNodeId);
      if (!fromNode || !toNode) continue;

      // Decay any collision bump velocity smoothly
      if (car.stunTimer > 0) {
        car.stunTimer = Math.max(0, car.stunTimer - dt);
      }
      car.bumpVx *= Math.exp(-4.5 * dt);
      car.bumpVz *= Math.exp(-4.5 * dt);

      const segDx = toNode.x - fromNode.x;
      const segDz = toNode.z - fromNode.z;
      const segLen = Math.hypot(segDx, segDz) || 1;
      const dirX = segDx / segLen;
      const dirZ = segDz / segLen;
      const rightX = -dirZ;
      const rightZ = dirX;

      const laneOff = getRightHandLaneOffset(fromNode, toNode);
      const laneEndX = toNode.x + laneOff.x;
      const laneEndZ = toNode.z + laneOff.z;

      // Progress along current edge
      const relX = car.pos.x - (fromNode.x + laneOff.x);
      const relZ = car.pos.z - (fromNode.z + laneOff.z);
      const along = relX * dirX + relZ * dirZ;
      const distToEnd = segLen - along;

      // Wrap dedicated coastal boulevard cruisers cleanly off-screen at road ends
      if (car.coastalLoopDir !== undefined && distToEnd < 7.5) {
        if (car.coastalLoopDir === 1 && car.toNodeId === 'n30') {
          // Wrap from Far East back to West Portal (only if player isn't right at West Portal)
          if (!playerCarPos || dist2D(playerCarPos.x, playerCarPos.z, -100, 21) > 25) {
            car.fromNodeId = 'w_coast';
            car.toNodeId = 'n00';
            car.nextNodeId = 'n10';
            car.pos.x = -102;
            car.pos.z = 21.05;
            car.rotY = Math.PI / 2;
            continue;
          }
        } else if (car.coastalLoopDir === -1 && car.toNodeId === 'w_coast') {
          if (!playerCarPos || dist2D(playerCarPos.x, playerCarPos.z, 196, 15.8) > 25) {
            car.fromNodeId = 'n30';
            car.toNodeId = 'n20';
            car.nextNodeId = 'n10';
            car.pos.x = 196;
            car.pos.z = 15.85;
            car.rotY = -Math.PI / 2;
            continue;
          }
        }
      }

      // Compute turn geometry toward nextNodeId for smooth cornering + turn signals
      const nextNode = CITY_ROAD_NODE_MAP.get(car.nextNodeId);
      let isTurning = false;
      let turnDir: -1 | 0 | 1 = 0;
      let lookTargetX = laneEndX;
      let lookTargetZ = laneEndZ;

      if (nextNode && nextNode.id !== toNode.id) {
        const nextDx = nextNode.x - toNode.x;
        const nextDz = nextNode.z - toNode.z;
        const nextLen = Math.hypot(nextDx, nextDz) || 1;
        const nDirX = nextDx / nextLen;
        const nDirZ = nextDz / nextLen;
        const dot = dirX * nDirX + dirZ * nDirZ;
        // Cross product Y in XZ plane: dirX * nDirZ - dirZ * nDirX
        // If going East (+1,0) and turning North (0,-1): cross = -1 -> LEFT turn!
        const cross = dirX * nDirZ - dirZ * nDirX;
        if (dot < 0.75) {
          isTurning = true;
          turnDir = cross < 0 ? 1 : -1;
        }

        // Smooth pure-pursuit corner blending when approaching the intersection
        const nextLaneOff = getRightHandLaneOffset(toNode, nextNode);
        if (distToEnd < 13.5) {
          const blend = clamp(1 - distToEnd / 13.5, 0, 1);
          const cornerEntryX = toNode.x + nextLaneOff.x + nDirX * 10.5;
          const cornerEntryZ = toNode.z + nextLaneOff.z + nDirZ * 10.5;
          lookTargetX = laneEndX * (1 - blend) + cornerEntryX * blend;
          lookTargetZ = laneEndZ * (1 - blend) + cornerEntryZ * blend;
        } else {
          // Pure-pursuit carrot 11m ahead along our lane
          const carrotAlong = Math.min(segLen, along + 11.5);
          lookTargetX = fromNode.x + laneOff.x + dirX * carrotAlong;
          lookTargetZ = fromNode.z + laneOff.z + dirZ * carrotAlong;
        }

        // Advance edge once we clear the intersection center
        if (distToEnd < 4.5) {
          car.fromNodeId = car.toNodeId;
          car.toNodeId = car.nextNodeId;
          car.nextNodeId = this.pickNextNode(car.fromNodeId, car.toNodeId, car.coastalLoopDir);
        }
      } else {
        car.nextNodeId = this.pickNextNode(car.fromNodeId, car.toNodeId, car.coastalLoopDir);
      }

      car.turnSignal = isTurning && distToEnd < 24 ? turnDir : 0;

      // ---- 1) Siren & High-Speed Emergency Yielding ----
      let desiredYieldOffset = 0;
      let sirenSlowdown = 1.0;
      car.yieldingToSiren = false;

      for (let p = 0; p < policeUnits.length; p++) {
        const pu = policeUnits[p];
        if (!pu.sirenActive) continue;
        const dPolice = dist2D(car.pos.x, car.pos.z, pu.pos.x, pu.pos.z);
        if (dPolice < 34) {
          car.yieldingToSiren = true;
          // Pull cleanly toward right-hand curb and yield!
          desiredYieldOffset = 1.65;
          sirenSlowdown = Math.min(sirenSlowdown, dPolice < 16 ? 0.14 : 0.38);
        }
      }

      // Also yield/swerve slightly if player getaway coupe approaches fast or is parked near lane
      if (playerCarPos) {
        const pdx = playerCarPos.x - car.pos.x;
        const pdz = playerCarPos.z - car.pos.z;
        const pDist = Math.hypot(pdx, pdz);
        const carFwdX = Math.sin(car.rotY);
        const carFwdZ = Math.cos(car.rotY);
        const fwdDot = (pdx * carFwdX + pdz * carFwdZ) / (pDist || 1);
        const latProj = Math.abs(pdx * -carFwdZ + pdz * carFwdX);

        if (phase !== 'escape') {
          // Parked getaway car near sidewalk: steer gently around it if close
          if (pDist < 16 && fwdDot > -0.2 && latProj < 3.6) {
            // Shift gently left toward centerline (away from parked sidewalk car)
            desiredYieldOffset = -1.25;
            sirenSlowdown = Math.min(sirenSlowdown, 0.72);
          }
        } else if (playerCarVel) {
          const pSpeed = Math.hypot(playerCarVel.x, playerCarVel.z);
          if (pDist < 24 && pSpeed > 20) {
            // Swerve right to give the speeding getaway car thrilling room to thread the needle!
            desiredYieldOffset = Math.max(desiredYieldOffset, 1.55);
            sirenSlowdown = Math.min(sirenSlowdown, 0.45);
          }
        }
      }

      car.lateralYieldOffset = damp(car.lateralYieldOffset, desiredYieldOffset, 3.8, dt);

      // Apply right-hand yield offset to steering target
      lookTargetX += rightX * car.lateralYieldOffset;
      lookTargetZ += rightZ * car.lateralYieldOffset;

      // ---- 2) Forward Radar Spacing (Traffic Ahead, Player, Police, Intersections) ----
      let targetSpeed = car.cruiseSpeed * sirenSlowdown;
      if (isTurning && distToEnd < 18) {
        targetSpeed = Math.min(targetSpeed, 7.6);
      }
      if (car.stunTimer > 0) {
        targetSpeed = 0;
      }

      const fwdX = Math.sin(car.rotY);
      const fwdZ = Math.cos(car.rotY);
      const carRightX = -fwdZ;
      const carRightZ = fwdX;

      const checkObstacleAhead = (ox: number, oz: number, ovx: number, ovz: number, pad = 0) => {
        const dx = ox - car.pos.x;
        const dz = oz - car.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.01 || d > 23 + pad) return;
        const alongFwd = dx * fwdX + dz * fwdZ;
        if (alongFwd < 1.2) return;
        const lat = Math.abs(dx * carRightX + dz * carRightZ);
        if (lat < 2.35 + pad * 0.35) {
          const gap = alongFwd - 5.2;
          if (gap <= 1.2) {
            targetSpeed = 0;
          } else {
            const leadFwdSpeed = Math.max(0, ovx * fwdX + ovz * fwdZ);
            const safeSpeed = leadFwdSpeed + (gap - 1.2) * 0.85;
            targetSpeed = Math.min(targetSpeed, Math.max(0, safeSpeed));
          }
        }
      };

      // Check other traffic cars
      for (let j = 0; j < this.agents.length; j++) {
        if (i === j) continue;
        const other = this.agents[j];
        const ovx = Math.sin(other.rotY) * other.speed;
        const ovz = Math.cos(other.rotY) * other.speed;
        checkObstacleAhead(other.pos.x, other.pos.z, ovx, ovz);

        // Simple intersection cross-traffic courtesy yield
        if (distToEnd < 11.5 && distToEnd > 3.5) {
          const otherDistToNode = dist2D(other.pos.x, other.pos.z, toNode.x, toNode.z);
          if (otherDistToNode < 7.5 && other.speed > 2.0 && other.toNodeId !== car.toNodeId) {
            targetSpeed = Math.min(targetSpeed, 2.2);
          }
        }
      }

      // Check player car in escape mode
      if (phase === 'escape' && playerCarPos) {
        checkObstacleAhead(
          playerCarPos.x,
          playerCarPos.z,
          playerCarVel?.x ?? 0,
          playerCarVel?.z ?? 0,
          1.2
        );
      }

      // Check police cars
      for (let p = 0; p < policeUnits.length; p++) {
        const pu = policeUnits[p];
        checkObstacleAhead(pu.pos.x, pu.pos.z, pu.vx, pu.vz, 1.0);
      }

      // ---- 3) Smooth Longitudinal & Steering Integration ----
      const accelRate = targetSpeed < car.speed ? 13.5 : 4.8;
      car.prevSpeed = car.speed;
      car.speed = damp(car.speed, targetSpeed, accelRate * 0.45, dt);
      if (targetSpeed < 0.3 && car.speed < 0.35) car.speed = 0;

      const longAccel = (car.speed - car.prevSpeed) / Math.max(0.001, dt);
      car.braking = longAccel < -1.1 || (car.speed < 0.8 && targetSpeed < 0.5) || car.stunTimer > 0;

      const desiredAngle = Math.atan2(lookTargetX - car.pos.x, lookTargetZ - car.pos.z);
      const angleDiff = normalizeAngleRad(desiredAngle - car.rotY);
      const speedTurnFactor = clamp(car.speed / 4.2, 0.12, 1.0);
      const maxYawRate = 2.35 * speedTurnFactor;
      const yawDelta = clamp(angleDiff * 3.6, -maxYawRate, maxYawRate) * dt;
      car.rotY = normalizeAngleRad(car.rotY + yawDelta);

      const targetSteer = clamp(angleDiff * 0.85, -0.44, 0.44);
      car.steerAngle = damp(car.steerAngle, targetSteer, 9.5, dt);

      car.pos.x += (Math.sin(car.rotY) * car.speed + car.bumpVx) * dt;
      car.pos.z += (Math.cos(car.rotY) * car.speed + car.bumpVz) * dt;

      // Never clip city blocks even if bumped sideways
      for (let b = 0; b < cityBoxColliders.length; b++) {
        const hit = resolveCircleVsAabb(car.pos, 1.75, cityBoxColliders[b]);
        if (hit.hit) {
          car.bumpVx *= 0.3;
          car.bumpVz *= 0.3;
          car.speed *= 0.5;
        }
      }

      // ---- 4) Suspension Body Roll/Pitch, Ackermann Wheels & Lights ----
      const latAccel = car.speed * (yawDelta / Math.max(0.001, dt));
      const targetRoll = clamp(latAccel * 0.009, -0.065, 0.065);
      const targetPitch = clamp(-longAccel * 0.0065, -0.045, 0.055);
      car.bodyRoll = damp(car.bodyRoll, targetRoll, 9.0, dt);
      car.bodyPitch = damp(car.bodyPitch, targetPitch, 10.0, dt);

      car.visual.root.position.set(car.pos.x, 0, car.pos.z);
      car.visual.root.rotation.y = car.rotY;
      car.visual.chassisGroup.rotation.z = car.bodyRoll;
      car.visual.chassisGroup.rotation.x = car.bodyPitch;

      car.wheelSpin += (car.speed / 0.33) * dt;
      this.animateAckermannWheels(car.visual, car.wheelSpin, car.steerAngle);

      // Dynamic brake & taillight intensity
      if (car.visual.brakelightsMat) {
        car.visual.brakelightsMat.emissiveIntensity = car.braking ? 4.8 : 0.25;
      }
      if (car.visual.taillightsMat) {
        car.visual.taillightsMat.emissiveIntensity = car.braking ? 4.2 : 1.55;
      }

      // Turn signals (or hazard flashers if yielding to sirens / bumped!)
      const hazard = car.yieldingToSiren || car.stunTimer > 0;
      if (car.visual.turnLeftMat) {
        car.visual.turnLeftMat.opacity =
          blinkOn && (hazard || car.turnSignal === 1) ? 0.95 : 0;
      }
      if (car.visual.turnRightMat) {
        car.visual.turnRightMat.opacity =
          blinkOn && (hazard || car.turnSignal === -1) ? 0.95 : 0;
      }
    }
  }

  private animateAckermannWheels(v: TrafficVisual, spin: number, steer: number): void {
    // True Ackermann geometry: inner front wheel turns slightly sharper than outer
    let steerFL = steer;
    let steerFR = steer;
    if (Math.abs(steer) > 0.01) {
      const wheelbase = 2.6;
      const track = 1.58;
      const radius = wheelbase / Math.tan(Math.abs(steer));
      const inner = Math.atan(wheelbase / Math.max(0.6, radius - track * 0.5));
      const outer = Math.atan(wheelbase / (radius + track * 0.5));
      if (steer > 0) {
        // Left turn: FL is inner, FR is outer
        steerFL = inner;
        steerFR = outer;
      } else {
        // Right turn: FR is inner, FL is outer
        steerFL = -outer;
        steerFR = -inner;
      }
    }

    if (v.wheelFL) {
      v.wheelFL.rotation.y = steerFL;
      v.wheelFL.rotation.x = spin;
    }
    if (v.wheelFR) {
      v.wheelFR.rotation.y = steerFR;
      v.wheelFR.rotation.x = spin;
    }
    if (v.wheelRL) v.wheelRL.rotation.x = spin;
    if (v.wheelRR) v.wheelRR.rotation.x = spin;
  }

  public dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    disposeSceneSubtree(this.root);
    this.agents = [];
  }
}
