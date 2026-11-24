import * as THREE from 'three';
import { EscapeState, HeistTarget, Vec2 } from '../sim/types';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import { AudioEngine } from './audioEngine';
import {
  AabbCollider,
  clamp,
  damp,
  dist2D,
  headingDegToRotY,
  lerp,
  normalizeAngleRad,
  resolveCircleVsAabb,
} from './mathUtils';
import {
  CITY_ROAD_NODES,
  TrafficObstacle,
  TrafficPoliceSignal,
  findCityRoadPath,
  findNearestRoadNode,
  hasCityLineOfSight,
} from './trafficSystem';

// ============================================================================
// NACHTSCHICHT — Realistic 4-Wheel Vehicle Dynamics & Mossos Police Pursuit
// Features:
//   - Sub-stepped 4-wheel longitudinal traction + Pacejka-inspired wet-asphalt
//     lateral slip-angle model with RWD handbrake drifting (`Space`)
//   - 5-speed automatic transmission + realistic turbo torque/RPM curve
//   - 2nd-order spring-damper suspension (brake dive, accel squat, corner roll,
//     impact heave jolt) with Ackermann front wheels planted firmly on asphalt
//   - Functional dual SpotLight headlights + Fresnel volumetric beams, dynamic
//     brake & reverse lights, and [L] Stealth Headlight Toggle
//   - Soft textured drift smoke/wet-spray sprites, fading wet tire skid marks,
//     and wall-scrape spark bursts + Die Akte paint-scrape trace
//   - Dispatch-delayed Catalan Mossos d'Esquadra cruisers navigating street
//     corridors (A* intercept/flank), asynchronous red/blue LED strobes,
//     sweeping roof searchlights, and true building-occluded LoS search/cooldown
// ============================================================================

export type PolicePursuitStatus = 'dispatched' | 'pursuit' | 'searching' | 'evaded';

export interface VehicleEscapeTelemetry {
  gear: number; // -1 = R, 0 = N, 1..5
  rpm: number; // 850..7200
  throttle: number; // 0..1
  headlightsOn: boolean;
  isDrifting: boolean;
  skidIntensity: number; // 0..1
  policeLosCooldown: number; // 0..1
  policeStatus: PolicePursuitStatus;
  policeDispatchEtaSec: number;
  safehouseLocked: boolean;
  vehicleDamage: number; // 0..100
  paintScrapeTrace: boolean;
}

export interface EscapeTickResult {
  patch: Partial<EscapeState>;
  telemetry: VehicleEscapeTelemetry;
  finished?: 'escaped' | 'busted';
  statusHint?: string | null;
}

interface CarVisual {
  root: THREE.Group;
  model: THREE.Group;
  chassisGroup: THREE.Group;
  chassisBaseY: number;
  wheelFL?: THREE.Object3D;
  wheelFR?: THREE.Object3D;
  wheelRL?: THREE.Object3D;
  wheelRR?: THREE.Object3D;
  wheelBaseY: number;
  wheelRLOffset: Vec2;
  wheelRROffset: Vec2;
  headlightsMat?: THREE.MeshStandardMaterial;
  taillightsMat?: THREE.MeshStandardMaterial;
  brakelightsMat?: THREE.MeshStandardMaterial;
  reverselightsMat?: THREE.MeshStandardMaterial;
  lightbarBlue?: THREE.Mesh;
  lightbarRed?: THREE.Mesh;
  sirenLight?: THREE.PointLight;
  searchlightPivot?: THREE.Group;
  searchlightSpot?: THREE.SpotLight;
  searchlightBeam?: THREE.Mesh;
}

interface PoliceUnit {
  id: string;
  role: 'interceptor' | 'flanker' | 'sweeper';
  visual: CarVisual;
  pos: Vec2;
  rotY: number;
  vx: number;
  vz: number;
  speed: number;
  prevSpeed: number;
  wheelSpin: number;
  steerAngle: number;
  bodyRoll: number;
  bodyPitch: number;
  flashPhase: number;
  strobeOffset: number;
  dispatchDelaySec: number;
  dispatched: boolean;
  waypoints: Vec2[];
  waypointIdx: number;
  repathTimer: number;
  searchAngle: number;
  searchSweepDir: number;
  searchTargetNodeId: string | null;
  hasLosToPlayer: boolean;
  sirenActive: boolean;
}

interface SmokeParticle {
  sprite: THREE.Sprite;
  mat: THREE.SpriteMaterial;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
  startScale: number;
  endScale: number;
}

interface SparkParticle {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number;
  vy: number;
  vz: number;
  age: number;
  maxAge: number;
}

interface SkidMarkQuad {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  age: number;
  maxAge: number;
}

// ----------------------------------------------------------------------------
// Physical Constants (European Night Sports Coupe ~1520 kg)
// ----------------------------------------------------------------------------
const MASS_KG = 1520;
const GRAVITY = 9.81;
const WEIGHT_N = MASS_KG * GRAVITY;
const YAW_INERTIA = 2520;
const LF = 1.37; // CG to front axle (m, matches getaway_car.glb FL/FR z=+1.37)
const LR = 1.34; // CG to rear axle (m, matches getaway_car.glb RL/RR z=-1.34)
const WHEELBASE = LF + LR; // 2.71m
const TRACK_WIDTH = 1.64; // m (matches getaway_car.glb x=±0.82)
const CG_HEIGHT = 0.50; // m
const WHEEL_RADIUS = 0.345; // m (matches getaway_car.glb wheelRadius)

const FORWARD_GEAR_RATIOS = [3.55, 2.28, 1.56, 1.14, 0.86];
const REVERSE_GEAR_RATIO = -3.25;
const FINAL_DRIVE = 3.45;
const IDLE_RPM = 880;
const REDLINE_RPM = 7100;
const PEAK_ENGINE_TORQUE_NM = 575;

function engineTorqueFactor(rpm: number): number {
  const n = clamp((rpm - IDLE_RPM) / (REDLINE_RPM - IDLE_RPM), 0, 1);
  if (n < 0.25) return 0.65 + (n / 0.25) * 0.33;
  if (n < 0.82) return 0.98 + Math.sin(((n - 0.25) / 0.57) * Math.PI) * 0.06;
  return 0.98 - ((n - 0.82) / 0.18) * 0.25;
}

function pacejkaLateral(alphaRad: number, B: number, C: number, peakForce: number): number {
  return -peakForce * Math.sin(C * Math.atan(B * alphaRad));
}

// ----------------------------------------------------------------------------
// Procedural Textures & Fresnel Volumetric Light Shaders
// ----------------------------------------------------------------------------

function createSoftSmokeTexture(): THREE.CanvasTexture | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, 128, 128);
  // Multi-lobe soft cloud alpha so tire smoke / wet spray looks organic, never round balls
  const blobs: Array<[number, number, number, number]> = [
    [64, 64, 52, 0.52],
    [48, 56, 36, 0.35],
    [78, 60, 34, 0.32],
    [62, 76, 32, 0.28],
    [56, 46, 28, 0.25],
  ];
  for (const [cx, cy, r, alpha] of blobs) {
    const g = ctx.createRadialGradient(cx, cy, 2, cx, cy, r);
    g.addColorStop(0, `rgba(220, 232, 245, ${alpha})`);
    g.addColorStop(0.5, `rgba(175, 194, 214, ${alpha * 0.45})`);
    g.addColorStop(1, 'rgba(140, 160, 185, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function createVolumetricBeamMaterial(colorHex: number, opacity: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
    uniforms: {
      uColor: { value: new THREE.Color(colorHex) },
      uOpacity: { value: opacity },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        vUv = uv;
        vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
        vViewPos = -mvPos.xyz;
        vNormalView = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * mvPos;
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec2 vUv;
      varying vec3 vNormalView;
      varying vec3 vViewPos;
      void main() {
        // vUv.y = 1 at cone tip (lens), 0 at far open mouth
        float distFade = pow(clamp(vUv.y, 0.0, 1.0), 1.65) * smoothstep(1.0, 0.88, vUv.y);
        vec3 viewDir = normalize(vViewPos);
        float fresnel = pow(abs(dot(normalize(vNormalView), viewDir)), 1.55);
        float alpha = uOpacity * distFade * fresnel;
        if (alpha < 0.002) discard;
        gl_FragColor = vec4(uColor, alpha);
      }
    `,
  });
}

function attachVehicleHierarchy(model: THREE.Group): Omit<CarVisual, 'root' | 'model'> {
  const wheelFL = model.getObjectByName('Wheel_FL');
  const wheelFR = model.getObjectByName('Wheel_FR');
  const wheelRL = model.getObjectByName('Wheel_RL');
  const wheelRR = model.getObjectByName('Wheel_RR');

  for (const w of [wheelFL, wheelFR, wheelRL, wheelRR]) {
    if (w) w.rotation.order = 'YXZ';
  }

  const wheelBaseY = wheelFL ? wheelFL.position.y : WHEEL_RADIUS;
  const wheelRLOffset: Vec2 = wheelRL
    ? { x: wheelRL.position.x, z: wheelRL.position.z }
    : { x: 0.84, z: -1.32 };
  const wheelRROffset: Vec2 = wheelRR
    ? { x: wheelRR.position.x, z: wheelRR.position.z }
    : { x: -0.84, z: -1.32 };

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
  const reverselightsMat = findMat(['Reverselights', 'Reverselight', 'ReverseLights']);

  const lightbarBlue = model.getObjectByName('Lightbar_Blue') as THREE.Mesh | undefined;
  const lightbarRed = model.getObjectByName('Lightbar_Red') as THREE.Mesh | undefined;

  // Separate non-wheel body meshes into a suspended roll-center chassis pivot
  // so wheels stay firmly planted on the wet asphalt while body pitches & rolls!
  const chassisBaseY = 0.44;
  const wheelSet = new Set<THREE.Object3D>(
    [wheelFL, wheelFR, wheelRL, wheelRR].filter(Boolean) as THREE.Object3D[]
  );
  const directWheels = model.children.filter((c) => wheelSet.has(c));

  let chassisGroup: THREE.Group;
  if (directWheels.length >= 2) {
    chassisGroup = new THREE.Group();
    chassisGroup.name = 'ChassisSuspensionPivot';
    chassisGroup.position.set(0, chassisBaseY, 0);
    const bodyChildren = model.children.filter((c) => !wheelSet.has(c));
    for (const child of bodyChildren) {
      model.remove(child);
      child.position.y -= chassisBaseY;
      chassisGroup.add(child);
    }
    model.add(chassisGroup);
  } else {
    chassisGroup = model;
  }

  return {
    chassisGroup,
    chassisBaseY: chassisGroup === model ? 0 : chassisBaseY,
    wheelFL,
    wheelFR,
    wheelRL,
    wheelRR,
    wheelBaseY,
    wheelRLOffset,
    wheelRROffset,
    headlightsMat,
    taillightsMat,
    brakelightsMat,
    reverselightsMat,
    lightbarBlue,
    lightbarRed,
  };
}

export class VehicleController {
  public readonly root = new THREE.Group();
  private target: HeistTarget;
  private safehousePos: Vec2;
  private getawayVisual: CarVisual;

  // Functional Getaway Lighting System
  private headlightBeamGroup: THREE.Group;
  private headlightSpotL: THREE.SpotLight;
  private headlightSpotR: THREE.SpotLight;
  private headlightFillLight: THREE.PointLight;
  private brakeGlowLight: THREE.PointLight;
  private reverseGlowLight: THREE.PointLight;
  private reverseLampMeshL: THREE.Mesh;
  private reverseLampMeshR: THREE.Mesh;

  // Mossos Police Units
  private policeUnits: PoliceUnit[] = [];

  // Particle & Skid Pools
  private smokeTex: THREE.CanvasTexture | null;
  private smokeParticles: SmokeParticle[] = [];
  private sparkParticles: SparkParticle[] = [];
  private skidMarks: SkidMarkQuad[] = [];
  private sparkGeo = new THREE.BoxGeometry(0.038, 0.038, 0.28);
  private skidGeo = new THREE.PlaneGeometry(0.28, 1.0);
  private smokeTimer = 0;
  private prevWheelRLWorld: Vec2 | null = null;
  private prevWheelRRWorld: Vec2 | null = null;
  private disposables: Array<{ dispose: () => void }> = [];

  // ---- Public Backward-Compatible + Extended Telemetry State ----
  public carPos: Vec2;
  public carRotY: number;
  public vx = 0;
  public vz = 0;
  public speedKmh = 0;
  public steerAngle = 0;
  public wheelSpin = 0;
  public drifting = false;

  // Extended Realistic Vehicle Dynamics State
  public headlightsOn = true;
  public gear = 0; // -1 = R, 0 = N, 1..5
  public rpm = IDLE_RPM;
  public skidIntensity = 0;

  private yawRate = 0;
  private rearWheelSpin = 0;
  private shiftCutTimer = 0;
  private shiftCooldown = 0;
  private smoothedLongAccel = 0;
  private smoothedLatAccel = 0;
  private prevVLong = 0;

  // 2nd-Order Spring-Damper Suspension State
  private bodyRoll = 0;
  private bodyRollVel = 0;
  private bodyPitch = 0;
  private bodyPitchVel = 0;
  private bodyHeave = 0;
  private bodyHeaveVel = 0;

  // Mossos Pursuit & LoS Search/Cooldown State
  private escapeElapsed = 0;
  private pursuitHeat = 45;
  private clearSightTimer = 0;
  private policeLosCooldown = 0; // 0..1
  private policeStatus: PolicePursuitStatus = 'dispatched';
  private policeDispatchEtaSec = 0;
  private lastKnownPlayerPos: Vec2;
  private carDamage = 0;
  private vehicleRecognized = false;
  private paintScrapeTrace = false;
  private spottedNearTimer = 0;
  private pinnedTimer = 0;
  private initialDistanceM = 280;
  private prevNearestPoliceDist = 999;

  constructor(target: HeistTarget, safehousePos: Vec2) {
    this.target = target;
    this.safehousePos = { ...safehousePos };
    this.root.name = 'VehicleController';

    this.carPos = { ...target.getawayPos };
    this.carRotY = headingDegToRotY(target.getawayHeadingDeg);
    this.lastKnownPlayerPos = { ...this.carPos };

    this.smokeTex = createSoftSmokeTexture();
    if (this.smokeTex) this.disposables.push(this.smokeTex);
    this.skidGeo.rotateX(-Math.PI / 2);
    this.disposables.push(this.sparkGeo, this.skidGeo);

    // 1) Build Photorealistic Getaway Coupe with Suspended Chassis Pivot
    const getawayRoot = new THREE.Group();
    getawayRoot.name = 'GetawayCar';
    const model = assetRegistry.instantiateModel('getaway_car', true);
    getawayRoot.add(model);

    const visualParts = attachVehicleHierarchy(model);
    this.getawayVisual = {
      root: getawayRoot,
      model,
      ...visualParts,
    };

    // Attach functional vehicle lighting directly to chassisGroup so beams pitch with braking/squat!
    const lightAnchor = this.getawayVisual.chassisGroup;
    const yOff = -this.getawayVisual.chassisBaseY;

    // Soft Fresnel-faded dual volumetric headlight projection cones
    const beamGroup = new THREE.Group();
    const beamGeo = new THREE.ConeGeometry(2.35, 16.0, 20, 1, true);
    beamGeo.translate(0, -8.0, 0);
    beamGeo.rotateX(-Math.PI / 2);
    const beamMat = createVolumetricBeamMaterial(0xfff1cc, 0.13);
    this.disposables.push(beamGeo, beamMat);

    const beamL = new THREE.Mesh(beamGeo, beamMat);
    beamL.position.set(0.68, 0.62 + yOff, 2.22);
    beamL.rotation.x = 0.065;
    beamL.rotation.y = 0.03;
    beamL.userData.excludeFromAO = true;
    beamGroup.add(beamL);

    const beamR = new THREE.Mesh(beamGeo, beamMat);
    beamR.position.set(-0.68, 0.62 + yOff, 2.22);
    beamR.rotation.x = 0.065;
    beamR.rotation.y = -0.03;
    beamR.userData.excludeFromAO = true;
    beamGroup.add(beamR);
    beamGroup.userData.excludeFromAO = true;
    lightAnchor.add(beamGroup);
    this.headlightBeamGroup = beamGroup;

    // Real Dual Automotive SpotLights casting genuine high-intensity cones on wet road & facades!
    const spotL = new THREE.SpotLight(0xfff0cc, 46, 62, 0.46, 0.68, 1.45);
    spotL.position.set(0.7, 0.66 + yOff, 2.18);
    const targetL = new THREE.Object3D();
    targetL.position.set(1.1, -0.25 + yOff, 26.0);
    lightAnchor.add(spotL, targetL);
    spotL.target = targetL;
    this.headlightSpotL = spotL;

    const spotR = new THREE.SpotLight(0xfff0cc, 46, 62, 0.46, 0.68, 1.45);
    spotR.position.set(-0.7, 0.66 + yOff, 2.18);
    const targetR = new THREE.Object3D();
    targetR.position.set(-1.1, -0.25 + yOff, 26.0);
    lightAnchor.add(spotR, targetR);
    spotR.target = targetR;
    this.headlightSpotR = spotR;

    // Short close-range hood bounce light so nearby curbs & bumper catch warm glow
    const fillLight = new THREE.PointLight(0xffe9b5, 11, 16, 1.6);
    fillLight.position.set(0, 0.72 + yOff, 3.6);
    lightAnchor.add(fillLight);
    this.headlightFillLight = fillLight;

    // Rear crimson brake light dynamic glow on wet asphalt & drift smoke
    const brakeLight = new THREE.PointLight(0xef4444, 1.5, 11, 1.6);
    brakeLight.position.set(0, 0.68 + yOff, -2.65);
    lightAnchor.add(brakeLight);
    this.brakeGlowLight = brakeLight;

    // Crisp white reverse lamps (visible when reversing in gear R)
    const reverseGlow = new THREE.PointLight(0xeef6ff, 0, 10, 1.6);
    reverseGlow.position.set(0, 0.64 + yOff, -2.55);
    lightAnchor.add(reverseGlow);
    this.reverseGlowLight = reverseGlow;

    const revGeo = new THREE.BoxGeometry(0.18, 0.055, 0.03);
    const revMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0xeef6ff,
      emissiveIntensity: 0,
      roughness: 0.2,
    });
    this.disposables.push(revGeo, revMat);

    this.reverseLampMeshL = new THREE.Mesh(revGeo, revMat);
    this.reverseLampMeshL.position.set(0.54, 0.68 + yOff, -2.28);
    this.reverseLampMeshL.visible = false;
    this.reverseLampMeshR = new THREE.Mesh(revGeo, revMat);
    this.reverseLampMeshR.position.set(-0.54, 0.68 + yOff, -2.28);
    this.reverseLampMeshR.visible = false;
    lightAnchor.add(this.reverseLampMeshL, this.reverseLampMeshR);

    getawayRoot.position.set(this.carPos.x, 0, this.carPos.z);
    getawayRoot.rotation.y = this.carRotY;
    this.root.add(getawayRoot);

    // 2) Build 3 Catalan Mossos d'Esquadra Patrol Cruisers (hidden until dispatched in Escape)
    const roles: Array<'interceptor' | 'flanker' | 'sweeper'> = [
      'interceptor',
      'flanker',
      'sweeper',
    ];
    const searchBeamGeo = new THREE.ConeGeometry(2.6, 22.0, 16, 1, true);
    searchBeamGeo.translate(0, -11.0, 0);
    searchBeamGeo.rotateX(-Math.PI / 2);
    const searchBeamMat = createVolumetricBeamMaterial(0xdbeafe, 0.16);
    this.disposables.push(searchBeamGeo, searchBeamMat);

    const policeHlBeamGeo = new THREE.ConeGeometry(1.9, 13.0, 14, 1, true);
    policeHlBeamGeo.translate(0, -6.5, 0);
    policeHlBeamGeo.rotateX(-Math.PI / 2);
    const policeHlBeamMat = createVolumetricBeamMaterial(0xe0f2fe, 0.1);
    this.disposables.push(policeHlBeamGeo, policeHlBeamMat);

    roles.forEach((role, idx) => {
      const pRoot = new THREE.Group();
      pRoot.name = `PoliceCar_${idx}`;
      const pModel = assetRegistry.instantiateModel('police_car', true);
      pRoot.add(pModel);

      const pParts = attachVehicleHierarchy(pModel);
      const pAnchor = pParts.chassisGroup;
      const pyOff = -pParts.chassisBaseY;

      // Dynamic alternating red/blue strobe PointLight casting reflections onto wet asphalt & walls
      const sirenLight = new THREE.PointLight(0x2563eb, 0, 32, 1.45);
      sirenLight.position.set(0, 2.25 + pyOff, 0.05);
      pAnchor.add(sirenLight);

      // Police cruiser subtle headlight cones
      const pBeamL = new THREE.Mesh(policeHlBeamGeo, policeHlBeamMat);
      pBeamL.position.set(0.66, 0.65 + pyOff, 2.38);
      pBeamL.rotation.x = 0.08;
      pBeamL.userData.excludeFromAO = true;
      const pBeamR = new THREE.Mesh(policeHlBeamGeo, policeHlBeamMat);
      pBeamR.position.set(-0.66, 0.65 + pyOff, 2.38);
      pBeamR.rotation.x = 0.08;
      pBeamR.userData.excludeFromAO = true;
      pAnchor.add(pBeamL, pBeamR);

      // Roof / A-pillar Sweeping Searchlight for LoS Search Mode
      const searchlightPivot = new THREE.Group();
      searchlightPivot.position.set(0.75, 1.52 + pyOff, 0.45);

      const searchSpot = new THREE.SpotLight(0xe0f2fe, 0, 44, 0.34, 0.55, 1.4);
      const searchTarget = new THREE.Object3D();
      searchTarget.position.set(0, -1.6, 22);
      searchlightPivot.add(searchSpot, searchTarget);
      searchSpot.target = searchTarget;

      const searchBeam = new THREE.Mesh(searchBeamGeo, searchBeamMat);
      searchBeam.rotation.x = 0.07;
      searchBeam.visible = false;
      searchBeam.userData.excludeFromAO = true;
      searchlightPivot.add(searchBeam);
      pAnchor.add(searchlightPivot);

      pRoot.visible = false;
      this.root.add(pRoot);

      this.policeUnits.push({
        id: `mossos_${idx}`,
        role,
        visual: {
          root: pRoot,
          model: pModel,
          ...pParts,
          sirenLight,
          searchlightPivot,
          searchlightSpot: searchSpot,
          searchlightBeam: searchBeam,
        },
        pos: { x: 196, z: -134 },
        rotY: Math.PI,
        vx: 0,
        vz: 0,
        speed: 0,
        prevSpeed: 0,
        wheelSpin: 0,
        steerAngle: 0,
        bodyRoll: 0,
        bodyPitch: 0,
        flashPhase: idx * 2.37,
        strobeOffset: idx * 0.41,
        dispatchDelaySec: 4 + idx * 4,
        dispatched: false,
        waypoints: [],
        waypointIdx: 0,
        repathTimer: 0,
        searchAngle: 0,
        searchSweepDir: idx % 2 === 0 ? 1 : -1,
        searchTargetNodeId: null,
        hasLosToPlayer: false,
        sirenActive: false,
      });
    });

    this.applyHeadlightVisuals(false, false, false);
  }

  public toggleHeadlights(audio?: AudioEngine): boolean {
    this.setHeadlights(!this.headlightsOn, audio);
    return this.headlightsOn;
  }

  public setHeadlights(on: boolean, audio?: AudioEngine): void {
    if (this.headlightsOn === on) return;
    this.headlightsOn = on;
    audio?.playHeadlightSwitch?.(on);
    this.applyHeadlightVisuals(false, this.gear === -1, false);
  }

  public getHeadlightsOn(): boolean {
    return this.headlightsOn;
  }

  public getPoliceUnits(): TrafficPoliceSignal[] {
    return this.policeUnits
      .filter((pu) => pu.dispatched && pu.visual.root.visible)
      .map((pu) => ({
        pos: { x: pu.pos.x, z: pu.pos.z },
        vx: pu.vx,
        vz: pu.vz,
        sirenActive: pu.sirenActive,
      }));
  }

  public getTelemetry(): VehicleEscapeTelemetry {
    const safehouseLocked = this.policeUnits.some((u) => u.hasLosToPlayer) && this.pursuitHeat > 38;
    return {
      gear: this.gear,
      rpm: Math.round(this.rpm),
      throttle: 0,
      headlightsOn: this.headlightsOn,
      isDrifting: this.drifting,
      skidIntensity: Math.round(this.skidIntensity * 100) / 100,
      policeLosCooldown: Math.round(this.policeLosCooldown * 100) / 100,
      policeStatus: this.policeStatus,
      policeDispatchEtaSec: Math.round(this.policeDispatchEtaSec * 10) / 10,
      safehouseLocked,
      vehicleDamage: Math.round(this.carDamage),
      paintScrapeTrace: this.paintScrapeTrace,
    };
  }

  public resetParked(): void {
    this.carPos = { ...this.target.getawayPos };
    this.carRotY = headingDegToRotY(this.target.getawayHeadingDeg);
    this.vx = 0;
    this.vz = 0;
    this.speedKmh = 0;
    this.steerAngle = 0;
    this.drifting = false;
    this.yawRate = 0;
    this.gear = 0;
    this.rpm = IDLE_RPM;
    this.skidIntensity = 0;
    this.headlightsOn = true;
    this.bodyRoll = 0;
    this.bodyRollVel = 0;
    this.bodyPitch = 0;
    this.bodyPitchVel = 0;
    this.bodyHeave = 0;
    this.bodyHeaveVel = 0;
    this.prevWheelRLWorld = null;
    this.prevWheelRRWorld = null;

    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.set(0, this.carRotY, 0);
    this.getawayVisual.chassisGroup.rotation.set(0, 0, 0);
    this.getawayVisual.chassisGroup.position.y = this.getawayVisual.chassisBaseY;

    this.applyHeadlightVisuals(false, false, true);

    for (const pu of this.policeUnits) {
      pu.dispatched = false;
      pu.sirenActive = false;
      pu.hasLosToPlayer = false;
      pu.visual.root.visible = false;
      if (pu.visual.sirenLight) pu.visual.sirenLight.intensity = 0;
      if (pu.visual.searchlightSpot) pu.visual.searchlightSpot.intensity = 0;
      if (pu.visual.searchlightBeam) pu.visual.searchlightBeam.visible = false;
    }
  }

  public startEscape(initialHeat: number): void {
    // Launch smoothly onto coastal boulevard facing East toward La Pineda route
    this.carPos = {
      x: this.target.getawayPos.x,
      z: Math.max(this.target.getawayPos.z, 19.6),
    };
    this.carRotY = Math.PI / 2; // East (+X) in right-hand coastal lane
    this.vx = 7.5;
    this.vz = 0;
    this.speedKmh = 27;
    this.steerAngle = 0;
    this.drifting = false;
    this.yawRate = 0;
    this.gear = 1;
    this.rpm = 2400;
    this.skidIntensity = 0;
    this.headlightsOn = true;
    this.shiftCutTimer = 0;
    this.shiftCooldown = 0;
    this.prevVLong = 7.5;
    this.smoothedLongAccel = 0;
    this.smoothedLatAccel = 0;
    this.bodyRoll = 0;
    this.bodyRollVel = 0;
    this.bodyPitch = 0;
    this.bodyPitchVel = 0;
    this.bodyHeave = 0;
    this.bodyHeaveVel = 0;
    this.prevWheelRLWorld = null;
    this.prevWheelRRWorld = null;

    this.escapeElapsed = 0;
    this.pursuitHeat = clamp(initialHeat, 18, 95);
    this.clearSightTimer = 0;
    this.policeLosCooldown = 0;
    this.carDamage = 0;
    this.vehicleRecognized = initialHeat >= 82;
    this.paintScrapeTrace = false;
    this.spottedNearTimer = 0;
    this.pinnedTimer = 0;
    this.prevNearestPoliceDist = 999;
    this.lastKnownPlayerPos = { ...this.carPos };

    this.initialDistanceM = Math.max(
      1,
      dist2D(this.carPos.x, this.carPos.z, this.safehousePos.x, this.safehousePos.z)
    );

    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.set(0, this.carRotY, 0);
    this.applyHeadlightVisuals(false, false, false);

    // Realistic Mossos Dispatch Delay & Distant Street-Corridor Spawns (no instant pop-in!)
    const highAlert = initialHeat >= 72;
    const medAlert = initialHeat >= 48;

    const dispatchDelays = highAlert
      ? [1.8, 5.2, 9.5]
      : medAlert
        ? [4.2, 8.8, 14.5]
        : [6.8, 13.5, 22.0];

    const spawnSpecs: Array<{ x: number; z: number; rotY: number }> = [
      // Unit 0 (Interceptor): enters from West Coastal / Midtown corridor
      { x: -46, z: -38, rotY: 0 },
      // Unit 1 (Flanker): enters from Central Cross-Street (x = 52, north of coastal)
      { x: 52, z: -58, rotY: 0 },
      // Unit 2 (Sweeper): patrols East Harbor Avenue near La Pineda approach
      { x: 128, z: -134, rotY: 0 },
    ];

    this.policeStatus = 'dispatched';
    this.policeDispatchEtaSec = dispatchDelays[0];

    this.policeUnits.forEach((pu, i) => {
      const sp = spawnSpecs[i % spawnSpecs.length];
      pu.pos = { x: sp.x, z: sp.z };
      pu.rotY = sp.rotY;
      pu.vx = 0;
      pu.vz = 0;
      pu.speed = 14;
      pu.prevSpeed = 14;
      pu.steerAngle = 0;
      pu.bodyRoll = 0;
      pu.bodyPitch = 0;
      pu.dispatchDelaySec = dispatchDelays[i] ?? 10;
      pu.dispatched = false;
      pu.sirenActive = false;
      pu.hasLosToPlayer = false;
      pu.waypoints = [];
      pu.waypointIdx = 0;
      pu.repathTimer = 0;
      pu.searchTargetNodeId = null;

      pu.visual.root.position.set(sp.x, 0, sp.z);
      pu.visual.root.rotation.y = sp.rotY;
      pu.visual.root.visible = false;
      if (pu.visual.sirenLight) pu.visual.sirenLight.intensity = 0;
      if (pu.visual.searchlightSpot) pu.visual.searchlightSpot.intensity = 0;
      if (pu.visual.searchlightBeam) pu.visual.searchlightBeam.visible = false;
    });
  }

  public teleportNearSafehouse(): void {
    this.carPos = { x: this.safehousePos.x - 14, z: this.safehousePos.z + 8 };
    this.carRotY = Math.atan2(
      this.safehousePos.x - this.carPos.x,
      this.safehousePos.z - this.carPos.z
    );
    this.vx = Math.sin(this.carRotY) * 12;
    this.vz = Math.cos(this.carRotY) * 12;
    this.pursuitHeat = Math.min(this.pursuitHeat, 24);
    this.clearSightTimer = Math.max(this.clearSightTimer, 8.0);
    this.policeLosCooldown = 1.0;
    this.policeStatus = 'evaded';
    for (const pu of this.policeUnits) {
      pu.hasLosToPlayer = false;
    }
    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.y = this.carRotY;
  }

  public updateIdle(timeSec: number): void {
    // Subtle parked idle headlights + warm engine shimmer
    this.headlightBeamGroup.visible = true;
    const shimmer = 1 + Math.sin(timeSec * 3.1) * 0.04;
    this.headlightSpotL.intensity = 22 * shimmer;
    this.headlightSpotR.intensity = 22 * shimmer;
    this.headlightFillLight.intensity = 7 * shimmer;
    this.brakeGlowLight.intensity = 1.2;
  }

  public updateEscape(params: {
    dt: number;
    timeSec: number;
    throttle: number; // +1 W, -1 S
    steer: number; // +1 Left (A), -1 Right (D)
    handbrake: boolean;
    cityBoxColliders: AabbCollider[];
    audio: AudioEngine;
    headlightsToggle?: boolean;
    trafficObstacles?: TrafficObstacle[];
    onTrafficCollision?: (id: string, dvx: number, dvz: number, impactSpeed: number) => void;
  }): EscapeTickResult {
    const {
      dt,
      timeSec,
      throttle,
      steer,
      handbrake,
      cityBoxColliders,
      audio,
      headlightsToggle,
      trafficObstacles = [],
      onTrafficCollision,
    } = params;

    if (headlightsToggle) {
      this.toggleHeadlights(audio);
    }

    this.escapeElapsed += dt;

    // =========================================================================
    // 1) SUB-STEPPED 4-WHEEL VEHICLE DYNAMICS + 5-SPEED TRANSMISSION
    // =========================================================================
    const subSteps = Math.max(2, Math.min(6, Math.ceil(dt / 0.008)));
    const subDt = dt / subSteps;

    let throttleCmd = clamp(throttle, 0, 1);
    let brakeCmd = clamp(-throttle, 0, 1);
    let reverseCmd = 0;

    const initFwdX = Math.sin(this.carRotY);
    const initFwdZ = Math.cos(this.carRotY);
    const initVLong = this.vx * initFwdX + this.vz * initFwdZ;

    // Smart Reverse / Brake transition (like GTA / racing sims)
    if (throttle < -0.05) {
      if (initVLong > 1.2 && this.gear !== -1) {
        brakeCmd = Math.abs(throttle);
        reverseCmd = 0;
      } else {
        brakeCmd = 0;
        reverseCmd = Math.abs(throttle);
        if (this.gear !== -1) {
          this.gear = -1;
          audio.playGearShift?.();
        }
      }
    } else if (throttle > 0.05 && this.gear <= 0) {
      if (initVLong < -1.2) {
        // Braking from reverse before shifting to 1st
        brakeCmd = throttle;
        throttleCmd = 0;
      } else {
        this.gear = 1;
        audio.playGearShift?.();
      }
    }

    // Speed-sensitive steering rack (wide lock at low speed, crisp tight lock at highway speed)
    const speedMps = Math.hypot(this.vx, this.vz);
    const maxSteerAngle = lerp(0.54, 0.21, clamp(speedMps / 40, 0, 1));
    const targetSteer = steer * maxSteerAngle;
    const isCounterSteer = Math.sign(steer) !== 0 && Math.sign(steer) !== Math.sign(this.steerAngle);
    const steerRate = isCounterSteer ? 13.5 : 8.8;
    this.steerAngle = damp(this.steerAngle, targetSteer, steerRate, dt);

    // Transmission shift timers
    if (this.shiftCutTimer > 0) this.shiftCutTimer = Math.max(0, this.shiftCutTimer - dt);
    if (this.shiftCooldown > 0) this.shiftCooldown = Math.max(0, this.shiftCooldown - dt);

    let frameLongAccel = 0;
    let frameLatAccel = 0;
    let maxRearSlip = 0;
    let finalVLong = initVLong;
    let finalVLeft = 0;

    for (let s = 0; s < subSteps; s++) {
      const fwdX = Math.sin(this.carRotY);
      const fwdZ = Math.cos(this.carRotY);
      const leftX = Math.cos(this.carRotY);
      const leftZ = -Math.sin(this.carRotY);

      const vLong = this.vx * fwdX + this.vz * fwdZ;
      const vLeft = this.vx * leftX + this.vz * leftZ;

      // Update RPM coupled to driven rear wheels (with slight clutch slip at launch / drift)
      const activeRatio =
        this.gear === -1
          ? Math.abs(REVERSE_GEAR_RATIO)
          : FORWARD_GEAR_RATIOS[clamp(this.gear - 1, 0, FORWARD_GEAR_RATIOS.length - 1)];
      const wheelRpm = (Math.abs(vLong) / (2 * Math.PI * WHEEL_RADIUS)) * 60;
      const coupledRpm = wheelRpm * activeRatio * FINAL_DRIVE;
      const throttleBlip = (throttleCmd + reverseCmd) * (handbrake ? 1850 : 950);
      const targetRpm = clamp(Math.max(IDLE_RPM + throttleBlip * 0.4, coupledRpm + throttleBlip * 0.35), IDLE_RPM, REDLINE_RPM);
      this.rpm = damp(this.rpm, targetRpm, 11.5, subDt);

      // Automatic 5-speed shifting
      if (this.gear >= 1 && this.shiftCooldown <= 0) {
        if (this.rpm >= 6420 && this.gear < 5 && throttleCmd > 0.25) {
          this.gear += 1;
          this.shiftCutTimer = 0.11;
          this.shiftCooldown = 0.42;
          this.rpm = Math.max(2900, this.rpm * 0.68);
          audio.playGearShift?.();
        } else if (this.rpm <= 2280 && this.gear > 1 && Math.abs(vLong) > 1.5) {
          this.gear -= 1;
          this.shiftCooldown = 0.38;
          this.rpm = Math.min(5900, this.rpm * 1.38);
          audio.playGearShift?.();
        }
      }

      // Dynamic Longitudinal Weight Transfer
      const loadTransfer = clamp(
        (MASS_KG * this.smoothedLongAccel * CG_HEIGHT) / WHEELBASE,
        -0.34 * WEIGHT_N,
        0.34 * WEIGHT_N
      );
      const fzFront = clamp(0.51 * WEIGHT_N - loadTransfer, 0.18 * WEIGHT_N, 0.82 * WEIGHT_N);
      const fzRear = clamp(0.49 * WEIGHT_N + loadTransfer, 0.18 * WEIGHT_N, 0.82 * WEIGHT_N);

      // Longitudinal Drive Force (RWD Coupe)
      let fxDrive = 0;
      if (this.shiftCutTimer <= 0) {
        const torque = PEAK_ENGINE_TORQUE_NM * engineTorqueFactor(this.rpm);
        if (this.gear >= 1 && throttleCmd > 0.01) {
          // Soft speed limiter around ~168 km/h (46.5 m/s) for controllable city chases
          const topLimiter = vLong > 44.5 ? clamp((47.5 - vLong) / 3.0, 0, 1) : 1;
          const wheelTorque = torque * activeRatio * FINAL_DRIVE * 0.84 * throttleCmd * topLimiter;
          fxDrive = wheelTorque / WHEEL_RADIUS;
        } else if (this.gear === -1 && reverseCmd > 0.01) {
          const revLimiter = vLong < -13.5 ? 0 : 1;
          const wheelTorque = torque * Math.abs(REVERSE_GEAR_RATIO) * FINAL_DRIVE * 0.48 * reverseCmd * revLimiter;
          fxDrive = -wheelTorque / WHEEL_RADIUS;
        }
      }

      // Cap rear drive force by wet-asphalt traction limit
      const muRearLong = handbrake ? 0.3 : 1.02;
      const maxRearDrive = fzRear * muRearLong;
      fxDrive = clamp(fxDrive, -maxRearDrive, maxRearDrive);

      // Service Brakes (65/35 F/R) + Handbrake Rear Lockup + Engine Braking + Aero Drag
      let fxBrake = 0;
      const brakeSign = Math.abs(vLong) > 0.15 ? -Math.sign(vLong) : 0;
      if (brakeCmd > 0.01 && brakeSign !== 0) {
        fxBrake += brakeSign * brakeCmd * 18500;
      }
      if (handbrake && brakeSign !== 0) {
        // Handbrake locks rear tires cleanly -> moderate deceleration + huge drift kickout
        fxBrake += brakeSign * 5600;
      }
      if (throttleCmd < 0.05 && reverseCmd < 0.05 && brakeSign !== 0) {
        // Natural engine compression braking
        fxBrake += brakeSign * 1450;
      }
      const fxDrag = -0.44 * vLong * Math.abs(vLong) - 18.0 * vLong;
      const fxTotal = fxDrive + fxBrake + fxDrag;

      // Lateral Tire Forces (4-Wheel / Bicycle Slip-Angle Model on Wet Night Asphalt)
      let fyFront = 0;
      let fyRear = 0;
      let yawTorque = 0;

      const absVLong = Math.abs(vLong);
      if (absVLong < 1.6 && Math.abs(vLeft) < 0.8 && Math.abs(this.yawRate) < 0.5) {
        // Low-speed kinematic regime (rock-solid at standstill & slow alley creeping)
        const vLatDamp = -vLeft * 11.5 * MASS_KG;
        fyFront = vLatDamp * 0.5;
        fyRear = vLatDamp * 0.5;
        const targetKinYaw = (vLong / WHEELBASE) * Math.tan(this.steerAngle);
        this.yawRate = damp(this.yawRate, targetKinYaw, 14, subDt);
      } else {
        const vLongEff = Math.max(absVLong, 2.4);
        const dirSign = vLong >= -0.15 ? 1 : -1;

        const alphaFront = Math.atan2(vLeft + this.yawRate * LF, vLongEff) - this.steerAngle * dirSign;
        const alphaRear = Math.atan2(vLeft - this.yawRate * LR, vLongEff);

        // Wet coastal night asphalt grip parameters
        const muFront = 1.04;
        // Handbrake slashes rear lateral grip; heavy WOT in turns also softens rear bite slightly
        const powerOversteerFactor =
          throttleCmd > 0.65 && Math.abs(alphaRear) > 0.2 && this.gear <= 3 ? 0.84 : 1.0;
        const muRear = handbrake ? 0.36 : 0.98 * powerOversteerFactor;

        // Friction circle coupling on rear driven axle
        const rearLongUse = clamp(Math.abs(fxDrive) / Math.max(1, fzRear * 1.05), 0, 0.92);
        const rearLatCapacity = fzRear * muRear * Math.sqrt(Math.max(0.32, 1 - 0.45 * rearLongUse * rearLongUse));
        const frontLatCapacity = fzFront * muFront;

        const bFront = 6.6;
        const cFront = 1.35;
        const bRear = handbrake ? 3.8 : 7.4;
        const cRear = handbrake ? 1.16 : 1.40;

        fyFront = pacejkaLateral(alphaFront, bFront, cFront, frontLatCapacity);
        fyRear = pacejkaLateral(alphaRear, bRear, cRear, rearLatCapacity);

        // Handbrake corner-initiation kick so tapping Space + A/D pitches the tail crisply without spinout
        const driftYawCap = handbrake ? 2.05 : 2.25;
        if (handbrake && Math.abs(this.steerAngle) > 0.08 && absVLong > 7.0 && Math.abs(this.yawRate) < 1.65) {
          yawTorque += this.steerAngle * 1950 * dirSign;
        }

        // Progressive drift stability damping (lets you hold buttery 35-50° wet-asphalt powerslides!)
        const escDamp = handbrake ? 1050 : 1220;
        yawTorque += LF * fyFront * Math.cos(this.steerAngle) - LR * fyRear - this.yawRate * escDamp;

        const angularAccel = yawTorque / YAW_INERTIA;
        this.yawRate = clamp(this.yawRate + angularAccel * subDt, -driftYawCap, driftYawCap);

        const rearSlipMag = Math.abs(alphaRear);
        if (rearSlipMag > maxRearSlip) maxRearSlip = rearSlipMag;
      }

      const aLong = fxTotal / MASS_KG + this.yawRate * vLeft;
      const aLeft = (fyFront * Math.cos(this.steerAngle) + fyRear) / MASS_KG - this.yawRate * vLong;
      // True physical centripetal lateral G-force felt by the chassis suspension (+X left = positive)
      const physLatAccel =
        absVLong < 1.6
          ? this.yawRate * vLong
          : (fyFront * Math.cos(this.steerAngle) + fyRear) / MASS_KG;

      const nextVLong = vLong + aLong * subDt;
      let nextVLeft = vLeft + aLeft * subDt;

      // Prevent brake oscillation through zero
      if (brakeCmd > 0.1 && Math.sign(nextVLong) !== Math.sign(vLong) && Math.abs(vLong) < 1.5) {
        this.vx *= 0.2;
        this.vz *= 0.2;
        this.yawRate *= 0.4;
      } else {
        if (Math.abs(nextVLong) < 0.08 && Math.abs(nextVLeft) < 0.08 && throttleCmd < 0.05 && reverseCmd < 0.05) {
          nextVLeft = 0;
        }
        this.carRotY = normalizeAngleRad(this.carRotY + this.yawRate * subDt);
        const nFwdX = Math.sin(this.carRotY);
        const nFwdZ = Math.cos(this.carRotY);
        const nLeftX = Math.cos(this.carRotY);
        const nLeftZ = -Math.sin(this.carRotY);

        this.vx = nFwdX * nextVLong + nLeftX * nextVLeft;
        this.vz = nFwdZ * nextVLong + nLeftZ * nextVLeft;
      }

      this.carPos.x += this.vx * subDt;
      this.carPos.z += this.vz * subDt;

      frameLongAccel = fxTotal / MASS_KG;
      frameLatAccel = physLatAccel;
      finalVLong = nextVLong;
      finalVLeft = nextVLeft;
    }

    // Smooth accelerations for suspension & weight transfer
    const rawLongAccel = clamp((finalVLong - this.prevVLong) / Math.max(0.001, dt), -22, 18);
    this.prevVLong = finalVLong;
    this.smoothedLongAccel = damp(this.smoothedLongAccel, rawLongAccel * 0.65 + frameLongAccel * 0.35, 11, dt);
    this.smoothedLatAccel = damp(this.smoothedLatAccel, frameLatAccel, 10, dt);

    // =========================================================================
    // 2) DUAL-CIRCLE MOMENTUM-PRESERVING COLLISIONS (WALLS, CURBS, TRAFFIC)
    // =========================================================================
    const fwdX = Math.sin(this.carRotY);
    const fwdZ = Math.cos(this.carRotY);
    const leftX = Math.cos(this.carRotY);
    const leftZ = -Math.sin(this.carRotY);

    // Outer world coastal seawall & avenue bounds
    const clampBound = (axis: 'x' | 'z', limit: number, sign: 1 | -1) => {
      const hitBound = sign === 1 ? this.carPos[axis] < limit : this.carPos[axis] > limit;
      if (!hitBound) return;
      this.carPos[axis] = limit;
      const vn = axis === 'x' ? this.vx * sign : this.vz * sign;
      if (vn < 0) {
        const impact = Math.abs(vn);
        if (axis === 'x') {
          this.vx = Math.abs(this.vx) * 0.16 * sign;
          this.vz *= 0.88;
        } else {
          this.vz = Math.abs(this.vz) * 0.16 * sign;
          this.vx *= 0.88;
        }
        if (impact > 6.5) {
          this.registerHardImpact(impact, this.carPos.x, this.carPos.z, sign === 1 && axis === 'x' ? 1 : -1, audio);
        }
      }
    };
    clampBound('x', -111, 1);
    clampBound('x', 209, -1);
    clampBound('z', -183, 1);
    clampBound('z', 24.4, -1);

    // Dual-circle chassis collision (front bumper & rear bumper) vs Salou/Dresden buildings
    const bumperOffsets = [1.18, -1.18];
    for (const box of cityBoxColliders) {
      for (const bOff of bumperOffsets) {
        const probe: Vec2 = {
          x: this.carPos.x + fwdX * bOff,
          z: this.carPos.z + fwdZ * bOff,
        };
        const hit = resolveCircleVsAabb(probe, 1.06, box);
        if (hit.hit) {
          const corrX = probe.x - (this.carPos.x + fwdX * bOff);
          const corrZ = probe.z - (this.carPos.z + fwdZ * bOff);
          this.carPos.x += corrX;
          this.carPos.z += corrZ;

          const vn = this.vx * hit.nx + this.vz * hit.nz;
          if (vn < 0) {
            const impactSpeed = Math.abs(vn);
            // Momentum-preserving inelastic slide (restitution 0.14 — slides smoothly along walls!)
            const tx = -hit.nz;
            const tz = hit.nx;
            const vt = this.vx * tx + this.vz * tz;
            const slideFriction = impactSpeed > 8 ? 0.84 : 0.93;
            const bounceOut = impactSpeed * 0.14;
            this.vx = tx * vt * slideFriction + hit.nx * bounceOut;
            this.vz = tz * vt * slideFriction + hit.nz * bounceOut;

            // Off-center bumper clip imparts realistic glancing yaw spin
            const leverCross = bOff * (fwdX * hit.nz - fwdZ * hit.nx);
            this.yawRate = clamp(this.yawRate + leverCross * impactSpeed * 0.08, -2.8, 2.8);

            // Emit wall-scrape metallic sparks at bumper contact point
            if (impactSpeed > 3.2 || Math.abs(vt) > 9.0) {
              const contactX = probe.x - hit.nx * 0.95;
              const contactZ = probe.z - hit.nz * 0.95;
              this.spawnScrapeSparks(contactX, contactZ, hit.nx, hit.nz, Math.min(8, Math.ceil(impactSpeed * 0.6)));
            }

            if (impactSpeed > 6.5) {
              this.registerHardImpact(impactSpeed, probe.x, probe.z, leverCross >= 0 ? 1 : -1, audio);
            }
          }
        }
      }
    }

    // Momentum-preserving collisions against living night traffic sedans!
    for (let i = 0; i < trafficObstacles.length; i++) {
      const tCar = trafficObstacles[i];
      const dx = this.carPos.x - tCar.pos.x;
      const dz = this.carPos.z - tCar.pos.z;
      const d = Math.hypot(dx, dz);
      const minSep = 3.1;
      if (d < minSep && d > 0.01) {
        const nx = dx / d;
        const nz = dz / d;
        const push = (minSep - d) * 0.55;
        this.carPos.x += nx * push;
        this.carPos.z += nz * push;

        const rvx = this.vx - tCar.vx;
        const rvz = this.vz - tCar.vz;
        const relVn = rvx * nx + rvz * nz;
        if (relVn < 0) {
          const impact = Math.abs(relVn);
          const impulse = impact * 0.62;
          this.vx += nx * impulse;
          this.vz += nz * impulse;
          this.vx *= 0.88;
          this.vz *= 0.88;

          onTrafficCollision?.(tCar.id, -nx * impulse * 1.15, -nz * impulse * 1.15, impact);
          this.spawnScrapeSparks(
            (this.carPos.x + tCar.pos.x) * 0.5,
            (this.carPos.z + tCar.pos.z) * 0.5,
            nx,
            nz,
            Math.min(7, Math.ceil(impact * 0.5))
          );
          if (impact > 5.5) {
            this.registerHardImpact(impact * 0.85, this.carPos.x, this.carPos.z, 1, audio);
          }
        }
      }
    }

    this.speedKmh = Math.round(Math.hypot(this.vx, this.vz) * 3.6);

    // Compute drift / tire skid intensity (0..1)
    const latSpeedMag = Math.abs(finalVLeft);
    const speedGate = clamp((this.speedKmh - 14) / 22, 0, 1);
    const rawSkid =
      speedGate *
      clamp(
        (handbrake ? 0.72 : 0) +
          clamp((maxRearSlip - 0.16) * 2.1, 0, 0.9) +
          clamp((latSpeedMag - 2.4) / 8.5, 0, 0.8),
        0,
        1
      );
    this.skidIntensity = damp(this.skidIntensity, rawSkid, 12, dt);
    this.drifting = this.skidIntensity > 0.28 || (handbrake && this.speedKmh > 18);

    // =========================================================================
    // 3) 2ND-ORDER SUSPENSION BODY ROLL/PITCH, ACKERMANN WHEELS & LIGHTS
    // =========================================================================
    // Roll leans outward into turn (+rotation.z tilts roof toward -X right during +physLatAccel left turn)
    const targetRoll = clamp(this.smoothedLatAccel * 0.0078, -0.095, 0.095);
    // Pitch: braking (longAccel < 0) dips nose (+rotation.x); accel (longAccel > 0) squats rear (-rotation.x)
    const targetPitch = clamp(-this.smoothedLongAccel * 0.0062, -0.068, 0.085);

    const kRoll = 56, cRoll = 11.2;
    this.bodyRollVel += ((targetRoll - this.bodyRoll) * kRoll - this.bodyRollVel * cRoll) * dt;
    this.bodyRoll = clamp(this.bodyRoll + this.bodyRollVel * dt, -0.12, 0.12);

    const kPitch = 62, cPitch = 12.0;
    this.bodyPitchVel += ((targetPitch - this.bodyPitch) * kPitch - this.bodyPitchVel * cPitch) * dt;
    this.bodyPitch = clamp(this.bodyPitch + this.bodyPitchVel * dt, -0.09, 0.105);

    const kHeave = 88, cHeave = 14.5;
    this.bodyHeaveVel += (-this.bodyHeave * kHeave - this.bodyHeaveVel * cHeave) * dt;
    this.bodyHeave = clamp(this.bodyHeave + this.bodyHeaveVel * dt, -0.08, 0.09);

    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.y = this.carRotY;
    this.getawayVisual.chassisGroup.rotation.z = this.bodyRoll;
    this.getawayVisual.chassisGroup.rotation.x = this.bodyPitch;
    this.getawayVisual.chassisGroup.position.y = this.getawayVisual.chassisBaseY + this.bodyHeave;

    // Speed-accurate wheel spin (front wheels always roll; rear wheels lock during handbrake!)
    this.wheelSpin += (finalVLong / WHEEL_RADIUS) * dt;
    if (!handbrake) {
      // Slight rear wheelspin slip under full 1st/2nd throttle
      const wheelspinBoost = throttleCmd > 0.8 && this.gear <= 2 && this.speedKmh < 45 ? 1.38 : 1.0;
      this.rearWheelSpin += ((finalVLong * wheelspinBoost) / WHEEL_RADIUS) * dt;
    }
    this.animateAckermannWheels(
      this.getawayVisual,
      this.wheelSpin,
      this.rearWheelSpin,
      this.steerAngle,
      this.bodyRoll,
      this.bodyPitch
    );

    const isBraking = brakeCmd > 0.1 || handbrake;
    const isReversing = this.gear === -1;
    this.applyHeadlightVisuals(isBraking, isReversing, false);

    // =========================================================================
    // 4) WET DRIFT SPRAY / SMOKE, FADING SKID MARKS & SCRAPE SPARKS
    // =========================================================================
    const rlWorld: Vec2 = {
      x: this.carPos.x + leftX * this.getawayVisual.wheelRLOffset.x + fwdX * this.getawayVisual.wheelRLOffset.z,
      z: this.carPos.z + leftZ * this.getawayVisual.wheelRLOffset.x + fwdZ * this.getawayVisual.wheelRLOffset.z,
    };
    const rrWorld: Vec2 = {
      x: this.carPos.x + leftX * this.getawayVisual.wheelRROffset.x + fwdX * this.getawayVisual.wheelRROffset.z,
      z: this.carPos.z + leftZ * this.getawayVisual.wheelRROffset.x + fwdZ * this.getawayVisual.wheelRROffset.z,
    };

    this.smokeTimer -= dt;
    if (this.skidIntensity > 0.24 && this.smokeTimer <= 0) {
      this.smokeTimer = lerp(0.065, 0.028, this.skidIntensity);
      this.spawnDriftSpray(rlWorld.x, rlWorld.z, isBraking);
      this.spawnDriftSpray(rrWorld.x, rrWorld.z, isBraking);

      if (this.prevWheelRLWorld && this.prevWheelRRWorld) {
        this.spawnSkidMark(this.prevWheelRLWorld, rlWorld, this.skidIntensity);
        this.spawnSkidMark(this.prevWheelRRWorld, rrWorld, this.skidIntensity);
      }
      // Subtle rim/asphalt micro-sparks on extreme high-speed handbrake drifts
      if (handbrake && this.speedKmh > 78 && Math.random() < 0.25) {
        this.spawnScrapeSparks(rlWorld.x, rlWorld.z, -fwdX, -fwdZ, 1);
      }
      this.prevWheelRLWorld = rlWorld;
      this.prevWheelRRWorld = rrWorld;
    } else if (this.skidIntensity <= 0.24) {
      this.prevWheelRLWorld = null;
      this.prevWheelRRWorld = null;
    }

    this.updateParticles(dt);

    // =========================================================================
    // 5) REALISTIC MOSSOS D'ESQUADRA POLICE PURSUIT, CORRIDOR AI & LoS SEARCH
    // =========================================================================
    let nearestPoliceDist = 999;
    let anyPoliceHasLos = false;
    let anyDispatched = false;
    let minPendingEta = Infinity;

    for (let idx = 0; idx < this.policeUnits.length; idx++) {
      const pu = this.policeUnits[idx];

      // Dispatch countdown before patrol cruiser rolls into Salou streets
      if (!pu.dispatched) {
        // Unit 2 stays in reserve unless pursuit heat is elevated
        if (idx === 2 && this.pursuitHeat < 42 && this.escapeElapsed < 18) {
          continue;
        }
        pu.dispatchDelaySec = Math.max(0, pu.dispatchDelaySec - dt);
        if (pu.dispatchDelaySec > 0) {
          minPendingEta = Math.min(minPendingEta, pu.dispatchDelaySec);
          continue;
        }
        // Spawn cleanly at a distant street intersection (never right on top of player!)
        this.dispatchPoliceUnit(pu, idx, cityBoxColliders);
      }

      anyDispatched = true;
      const dx = this.carPos.x - pu.pos.x;
      const dz = this.carPos.z - pu.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < nearestPoliceDist) nearestPoliceDist = dist;

      // ---- True Building-Occluded Visual Line-of-Sight Check ----
      // Cutting headlights [L] in a dark side street dramatically slashes police detection distance!
      const baseDetectRange = this.headlightsOn
        ? 58.0
        : this.speedKmh < 14
          ? 16.5
          : 23.5;

      const puFwdX = Math.sin(pu.rotY);
      const puFwdZ = Math.cos(pu.rotY);
      const toPlayerDot = dist > 0.01 ? (dx * puFwdX + dz * puFwdZ) / dist : 1;
      const inHeadlightCone = toPlayerDot > 0.84;

      // Sweeping searchlight cone check during search mode
      let inSearchlightCone = false;
      if (this.policeStatus === 'searching' && dist < 38) {
        const searchWorldYaw = pu.rotY + pu.searchAngle;
        const slDot = (dx * Math.sin(searchWorldYaw) + dz * Math.cos(searchWorldYaw)) / (dist || 1);
        inSearchlightCone = slDot > 0.93;
      }

      const effectiveDetectRange =
        baseDetectRange + (inHeadlightCone ? 10 : 0) + (inSearchlightCone ? 14 : 0);

      const hasClearSight =
        dist <= effectiveDetectRange && hasCityLineOfSight(pu.pos, this.carPos, cityBoxColliders);

      pu.hasLosToPlayer = hasClearSight;
      if (hasClearSight) {
        anyPoliceHasLos = true;
        this.lastKnownPlayerPos = { ...this.carPos };
      }

      // ---- Street-Corridor Navigation (Intercept / Flank / Search / Patrol) ----
      pu.repathTimer -= dt;
      const evaded = this.policeStatus === 'evaded';
      const searching = !anyPoliceHasLos && !evaded;
      pu.sirenActive = !evaded;

      let goalPos: Vec2 = this.lastKnownPlayerPos;
      if (evaded) {
        // Cruise calmly away along outer avenues
        if (!pu.searchTargetNodeId || dist2D(pu.pos.x, pu.pos.z, goalPos.x, goalPos.z) < 12) {
          const farNode = CITY_ROAD_NODES[(idx * 4 + Math.floor(timeSec * 0.1)) % CITY_ROAD_NODES.length];
          pu.searchTargetNodeId = farNode.id;
        }
        const n = CITY_ROAD_NODES.find((rn) => rn.id === pu.searchTargetNodeId) ?? CITY_ROAD_NODES[2];
        goalPos = { x: n.x, z: n.z };
      } else if (searching) {
        // Drive to lastKnownPlayerPos first, then fan out sweeping nearby intersections!
        const distToLast = dist2D(pu.pos.x, pu.pos.z, this.lastKnownPlayerPos.x, this.lastKnownPlayerPos.z);
        if (distToLast > 16 && idx === 0) {
          goalPos = this.lastKnownPlayerPos;
        } else {
          // Pick intersection near lastKnownPlayerPos to sweep with searchlights
          const anchorNode = findNearestRoadNode(this.lastKnownPlayerPos, cityBoxColliders, true);
          const sweepCandidates = [anchorNode.id, ...anchorNode.neighbors];
          if (
            !pu.searchTargetNodeId ||
            !sweepCandidates.includes(pu.searchTargetNodeId) ||
            dist2D(
              pu.pos.x,
              pu.pos.z,
              (CITY_ROAD_NODES.find((rn) => rn.id === pu.searchTargetNodeId)?.x ?? anchorNode.x),
              (CITY_ROAD_NODES.find((rn) => rn.id === pu.searchTargetNodeId)?.z ?? anchorNode.z)
            ) < 11
          ) {
            const pick = sweepCandidates[(idx + Math.floor(timeSec * 0.35)) % sweepCandidates.length];
            pu.searchTargetNodeId = pick;
          }
          const targetNode = CITY_ROAD_NODES.find((rn) => rn.id === pu.searchTargetNodeId) ?? anchorNode;
          goalPos = { x: targetNode.x, z: targetNode.z };
        }
      } else {
        // Active Pursuit: Interceptor chases directly, Flanker cuts off intersection ahead, Sweeper guards north!
        if (pu.role === 'flanker' && dist > 26 && speedMps > 8) {
          const leadPos: Vec2 = {
            x: clamp(this.carPos.x + this.vx * 2.2, -95, 198),
            z: clamp(this.carPos.z + this.vz * 2.2, -145, 22),
          };
          const interceptNode = findNearestRoadNode(leadPos, cityBoxColliders, true);
          goalPos = { x: interceptNode.x, z: interceptNode.z };
        } else if (pu.role === 'sweeper' && dist > 40) {
          const midPos: Vec2 = {
            x: lerp(this.carPos.x, this.safehousePos.x, 0.38),
            z: lerp(this.carPos.z, this.safehousePos.z, 0.38),
          };
          const blockNode = findNearestRoadNode(midPos, cityBoxColliders, true);
          goalPos = { x: blockNode.x, z: blockNode.z };
        } else {
          goalPos = this.carPos;
        }
      }

      // Direct corridor chase when close with unobstructed sightline; otherwise A* corridor routing!
      let steerTarget: Vec2 = goalPos;
      const directSightToGoal =
        !evaded &&
        dist < 56 &&
        pu.role !== 'flanker' &&
        hasCityLineOfSight(pu.pos, goalPos, cityBoxColliders);

      if (directSightToGoal) {
        steerTarget = goalPos;
      } else {
        if (pu.repathTimer <= 0 || pu.waypoints.length === 0) {
          pu.repathTimer = 0.55 + idx * 0.12;
          pu.waypoints = findCityRoadPath(pu.pos, goalPos, cityBoxColliders);
          pu.waypointIdx = 0;
          // Skip initial waypoint if already right on top of it
          while (
            pu.waypointIdx < pu.waypoints.length - 1 &&
            dist2D(pu.pos.x, pu.pos.z, pu.waypoints[pu.waypointIdx].x, pu.waypoints[pu.waypointIdx].z) < 9.5
          ) {
            pu.waypointIdx++;
          }
        }
        const wp = pu.waypoints[pu.waypointIdx];
        if (wp) {
          if (dist2D(pu.pos.x, pu.pos.z, wp.x, wp.z) < 10.5 && pu.waypointIdx < pu.waypoints.length - 1) {
            pu.waypointIdx++;
          }
          steerTarget = pu.waypoints[pu.waypointIdx] ?? goalPos;
        }
      }

      // Local multi-ray obstacle avoidance so cruisers stay off building corners & parked traffic
      let desiredAngle = Math.atan2(steerTarget.x - pu.pos.x, steerTarget.z - pu.pos.z);
      const probeDist = clamp(pu.speed * 0.45, 5.5, 11.5);
      const probeAhead: Vec2 = {
        x: pu.pos.x + Math.sin(pu.rotY) * probeDist,
        z: pu.pos.z + Math.cos(pu.rotY) * probeDist,
      };
      if (!hasCityLineOfSight(pu.pos, probeAhead, cityBoxColliders)) {
        const leftProbe: Vec2 = {
          x: pu.pos.x + Math.sin(pu.rotY + 0.55) * probeDist,
          z: pu.pos.z + Math.cos(pu.rotY + 0.55) * probeDist,
        };
        const leftClear = hasCityLineOfSight(pu.pos, leftProbe, cityBoxColliders);
        desiredAngle += leftClear ? 0.85 : -0.85;
      }

      // Smooth cruiser steering & corner-aware speed control
      const angleErr = normalizeAngleRad(desiredAngle - pu.rotY);
      const cornerPenalty = clamp(1 - Math.abs(angleErr) * 0.55, 0.36, 1.0);
      let desiredSpeed = evaded
        ? 11.5
        : searching
          ? 14.2
          : dist > 65
            ? 32.5
            : dist > 22
              ? 28.5
              : 23.5;
      desiredSpeed *= cornerPenalty;

      const maxTurnRate = clamp(pu.speed / 5.5, 0.4, 1.0) * 2.55;
      const yawStep = clamp(angleErr * 3.8, -maxTurnRate, maxTurnRate) * dt;
      pu.rotY = normalizeAngleRad(pu.rotY + yawStep);
      pu.steerAngle = damp(pu.steerAngle, clamp(angleErr * 0.85, -0.45, 0.45), 9.5, dt);

      pu.prevSpeed = pu.speed;
      pu.speed = damp(pu.speed, desiredSpeed, desiredSpeed < pu.speed ? 4.8 : 2.6, dt);
      pu.vx = Math.sin(pu.rotY) * pu.speed;
      pu.vz = Math.cos(pu.rotY) * pu.speed;
      pu.pos.x += pu.vx * dt;
      pu.pos.z += pu.vz * dt;

      // Building collision recovery for cruisers
      for (const box of cityBoxColliders) {
        const hit = resolveCircleVsAabb(pu.pos, 1.85, box);
        if (hit.hit) {
          pu.speed *= 0.55;
          pu.rotY = normalizeAngleRad(pu.rotY + (angleErr >= 0 ? 0.32 : -0.32));
          pu.repathTimer = 0;
        }
      }

      // Police-vs-Police separation so cruisers don't stack inside one another
      for (let j = 0; j < idx; j++) {
        const other = this.policeUnits[j];
        if (!other.dispatched) continue;
        const odx = pu.pos.x - other.pos.x;
        const odz = pu.pos.z - other.pos.z;
        const od = Math.hypot(odx, odz);
        if (od < 4.2 && od > 0.01) {
          const sep = (4.2 - od) * 0.5;
          pu.pos.x += (odx / od) * sep;
          pu.pos.z += (odz / od) * sep;
          other.pos.x -= (odx / od) * sep;
          other.pos.z -= (odz / od) * sep;
        }
      }

      // Momentum-preserving collision with player getaway car!
      const pDist = dist2D(this.carPos.x, this.carPos.z, pu.pos.x, pu.pos.z);
      if (pDist < 3.55 && pDist > 0.01) {
        const nx = (this.carPos.x - pu.pos.x) / pDist;
        const nz = (this.carPos.z - pu.pos.z) / pDist;
        const push = (3.55 - pDist) * 0.52;
        this.carPos.x += nx * push;
        this.carPos.z += nz * push;
        pu.pos.x -= nx * push;
        pu.pos.z -= nz * push;

        const rvx = this.vx - pu.vx;
        const rvz = this.vz - pu.vz;
        const relVn = rvx * nx + rvz * nz;
        if (relVn < 0) {
          const impact = Math.abs(relVn);
          this.vx += nx * Math.max(3.5, impact * 0.55);
          this.vz += nz * Math.max(3.5, impact * 0.55);
          pu.speed *= 0.65;
          this.spawnScrapeSparks(
            (this.carPos.x + pu.pos.x) * 0.5,
            (this.carPos.z + pu.pos.z) * 0.5,
            nx,
            nz,
            6
          );
          this.registerHardImpact(Math.max(7.2, impact), this.carPos.x, this.carPos.z, 1, audio);
        }
        // Ramming a cruiser immediately puts you in active LoS!
        pu.hasLosToPlayer = true;
        anyPoliceHasLos = true;
        this.lastKnownPlayerPos = { ...this.carPos };
      }

      // Cruiser suspension roll/pitch & Ackermann wheels
      const puLongAccel = (pu.speed - pu.prevSpeed) / Math.max(0.001, dt);
      const puLatAccel = pu.speed * (yawStep / Math.max(0.001, dt));
      pu.bodyRoll = damp(pu.bodyRoll, clamp(puLatAccel * 0.009, -0.075, 0.075), 9.0, dt);
      pu.bodyPitch = damp(pu.bodyPitch, clamp(-puLongAccel * 0.006, -0.055, 0.065), 10.0, dt);

      pu.wheelSpin += (pu.speed / 0.35) * dt;
      pu.visual.root.position.set(pu.pos.x, 0, pu.pos.z);
      pu.visual.root.rotation.y = pu.rotY;
      pu.visual.chassisGroup.rotation.z = pu.bodyRoll;
      pu.visual.chassisGroup.rotation.x = pu.bodyPitch;
      this.animateAckermannWheels(pu.visual, pu.wheelSpin, pu.wheelSpin, pu.steerAngle, pu.bodyRoll, pu.bodyPitch);

      // ---- Asynchronous Double-Flash Mossos Red/Blue LED Strobes ----
      pu.flashPhase += dt;
      const cycle = (pu.flashPhase * 2.4 + pu.strobeOffset) % 1.0;
      // Realistic modern LED strobe pattern: triple-pulse Blue (0.0..0.42), triple-pulse Red (0.50..0.92)
      const bluePulse =
        (cycle >= 0.0 && cycle < 0.11) ||
        (cycle >= 0.16 && cycle < 0.27) ||
        (cycle >= 0.32 && cycle < 0.41);
      const redPulse =
        (cycle >= 0.50 && cycle < 0.61) ||
        (cycle >= 0.66 && cycle < 0.77) ||
        (cycle >= 0.82 && cycle < 0.91);

      const strobesActive = !evaded;
      const blueIntensity = strobesActive ? (bluePulse ? 6.5 : 0.2) : 0.35;
      const redIntensity = strobesActive ? (redPulse ? 6.5 : 0.2) : 0.15;

      if (pu.visual.lightbarBlue?.material instanceof THREE.MeshStandardMaterial) {
        pu.visual.lightbarBlue.material.emissiveIntensity = blueIntensity;
      }
      if (pu.visual.lightbarRed?.material instanceof THREE.MeshStandardMaterial) {
        pu.visual.lightbarRed.material.emissiveIntensity = redIntensity;
      }
      if (pu.visual.sirenLight) {
        if (!strobesActive) {
          pu.visual.sirenLight.intensity = 3.5;
          pu.visual.sirenLight.color.setHex(0x2563eb);
        } else if (bluePulse) {
          pu.visual.sirenLight.color.setHex(0x2563eb);
          pu.visual.sirenLight.intensity = 38;
        } else if (redPulse) {
          pu.visual.sirenLight.color.setHex(0xef4444);
          pu.visual.sirenLight.intensity = 38;
        } else {
          pu.visual.sirenLight.intensity = 4;
        }
      }

      // ---- Sweeping Volumetric Roof Searchlight during Search Mode ----
      if (pu.visual.searchlightPivot && pu.visual.searchlightSpot && pu.visual.searchlightBeam) {
        const showSearchlight = searching && !evaded;
        pu.visual.searchlightBeam.visible = showSearchlight;
        pu.visual.searchlightSpot.intensity = showSearchlight ? 36 : 0;
        if (showSearchlight) {
          pu.searchAngle += pu.searchSweepDir * dt * 1.15;
          if (pu.searchAngle > 0.92) {
            pu.searchAngle = 0.92;
            pu.searchSweepDir = -1;
          } else if (pu.searchAngle < -0.92) {
            pu.searchAngle = -0.92;
            pu.searchSweepDir = 1;
          }
          pu.visual.searchlightPivot.rotation.y = pu.searchAngle;
        }
      }

      // Police brake lights when decelerating into corners
      if (pu.visual.brakelightsMat) {
        pu.visual.brakelightsMat.emissiveIntensity = puLongAccel < -2.0 ? 4.5 : 0.25;
      }
    }

    // =========================================================================
    // 6) PURSUIT HEAT, LoS COOLDOWN, DOPPLER AUDIO & SAFEHOUSE EXTRACTION
    // =========================================================================
    this.policeDispatchEtaSec = anyDispatched ? 0 : isFinite(minPendingEta) ? minPendingEta : 0;

    if (!anyDispatched) {
      this.policeStatus = 'dispatched';
      // Quietly cooling slightly if you started with low heat and headlights off
      if (!this.headlightsOn && this.pursuitHeat < 45) {
        this.pursuitHeat = Math.max(10, this.pursuitHeat - dt * 2.5);
      }
    } else if (anyPoliceHasLos) {
      this.policeStatus = 'pursuit';
      const heatRate = nearestPoliceDist < 22 ? 8.5 : 5.2;
      this.pursuitHeat = Math.min(100, this.pursuitHeat + dt * heatRate);
      this.clearSightTimer = Math.max(0, this.clearSightTimer - dt * 3.0);
      this.policeLosCooldown = Math.max(0, this.policeLosCooldown - dt * 0.45);

      if (nearestPoliceDist < 19) {
        this.spottedNearTimer += dt;
        if (this.spottedNearTimer > 2.8) {
          this.vehicleRecognized = true;
        }
      }
    } else {
      // Line-of-Sight Broken! Stealth [L] headlights off dramatically accelerates cooldown!
      this.clearSightTimer += dt;
      const darkBonus = !this.headlightsOn ? (this.speedKmh < 18 ? 1.75 : 1.45) : 1.0;
      const cooldownRate = (1 / 12.0) * darkBonus;
      this.policeLosCooldown = clamp(this.policeLosCooldown + dt * cooldownRate, 0, 1);
      this.pursuitHeat = Math.max(0, this.pursuitHeat - dt * 7.2 * darkBonus);

      if (this.policeLosCooldown >= 1.0 || this.pursuitHeat <= 24) {
        this.policeStatus = 'evaded';
        this.policeLosCooldown = 1.0;
      } else {
        this.policeStatus = 'searching';
      }
    }

    // Busted pinned timer (surrounded & immobilized)
    if (anyPoliceHasLos && nearestPoliceDist < 5.4 && this.speedKmh < 7) {
      this.pinnedTimer += dt;
    } else {
      this.pinnedTimer = Math.max(0, this.pinnedTimer - dt * 2.2);
    }

    // Engine & Tire Screech Telemetry Audio
    const throttleAudio = Math.max(throttleCmd, reverseCmd);
    if (typeof audio.updateEngineTelemetry === 'function') {
      audio.updateEngineTelemetry({
        speedKmh: this.speedKmh,
        rpm: this.rpm,
        gear: this.gear,
        throttle: throttleAudio,
        skidIntensity: this.skidIntensity,
        active: true,
      });
    } else {
      audio.updateEngine(this.speedKmh, this.drifting, true);
    }

    // Real Doppler Shift for Approaching / Passing Mossos Sirens!
    const sirenActiveAny = anyDispatched && this.policeStatus !== 'evaded';
    const sirenProx = sirenActiveAny ? clamp(1 - nearestPoliceDist / 92, 0, 1) : 0;
    const radialVel =
      this.prevNearestPoliceDist < 900
        ? (this.prevNearestPoliceDist - nearestPoliceDist) / Math.max(0.001, dt)
        : 0;
    this.prevNearestPoliceDist = nearestPoliceDist;
    const dopplerShift = clamp(1 + radialVel / 310, 0.89, 1.13);
    audio.updatePoliceSiren(sirenProx, sirenActiveAny, dt, dopplerShift);

    // Distance to La Pineda Safehouse
    const rawDistToSafe = dist2D(
      this.carPos.x,
      this.carPos.z,
      this.safehousePos.x,
      this.safehousePos.z
    );
    const scaledDistM = Math.max(
      0,
      Math.round((rawDistToSafe / this.initialDistanceM) * this.target.safehouseEscapeDistanceM)
    );

    const safehouseLocked = anyPoliceHasLos && this.pursuitHeat > 38;

    const telemetry: VehicleEscapeTelemetry = {
      gear: this.gear,
      rpm: Math.round(this.rpm),
      throttle: Math.round(throttleAudio * 100) / 100,
      headlightsOn: this.headlightsOn,
      isDrifting: this.drifting,
      skidIntensity: Math.round(this.skidIntensity * 100) / 100,
      policeLosCooldown: Math.round(this.policeLosCooldown * 100) / 100,
      policeStatus: this.policeStatus,
      policeDispatchEtaSec: Math.round(this.policeDispatchEtaSec * 10) / 10,
      safehouseLocked,
      vehicleDamage: Math.round(this.carDamage),
      paintScrapeTrace: this.paintScrapeTrace,
    };

    const patch: Partial<EscapeState> = {
      elapsedSec: Math.round(this.escapeElapsed * 10) / 10,
      speedKmh: this.speedKmh,
      pursuitHeat: Math.round(this.pursuitHeat),
      policeSpotted: anyPoliceHasLos,
      clearSightTimerSec: Math.round(this.clearSightTimer * 10) / 10,
      distanceToSafehouseM: rawDistToSafe < 13.5 ? 0 : scaledDistM,
      carDamage: Math.round(this.carDamage),
      vehicleRecognized: this.vehicleRecognized,
      ...telemetry,
    };

    let statusHint: string | null = null;
    if (rawDistToSafe < 13.5) {
      if (!safehouseLocked) {
        return { patch, telemetry, finished: 'escaped', statusHint: null };
      }
      statusHint = 'Polizei in Sicht — Sichtkontakt brechen & Licht aus [L] bevor du ins Versteck fährst!';
    } else if (this.policeStatus === 'searching' && this.headlightsOn) {
      statusHint = 'Mossos suchen die Kreuzungen ab — [L] Scheinwerfer ausschalten zum Abtauchen';
    }

    if (this.carDamage >= 100 || this.pinnedTimer >= 5.0) {
      return { patch, telemetry, finished: 'busted', statusHint: null };
    }

    return { patch, telemetry, statusHint };
  }

  private dispatchPoliceUnit(pu: PoliceUnit, idx: number, cityBoxColliders: AabbCollider[]): void {
    // Pick a street intersection 62..135m away from the player so cruisers roll in realistically
    const candidates = CITY_ROAD_NODES.filter((n) => {
      if (n.isPortal) return false;
      const d = dist2D(n.x, n.z, this.carPos.x, this.carPos.z);
      return d >= 56 && d <= 145;
    });
    const sorted = candidates.sort(
      (a, b) =>
        dist2D(a.x, a.z, this.carPos.x, this.carPos.z) -
        dist2D(b.x, b.z, this.carPos.x, this.carPos.z)
    );
    const chosen = sorted[Math.min(idx, Math.max(0, sorted.length - 1))] ?? CITY_ROAD_NODES[6];

    pu.pos = { x: chosen.x, z: chosen.z };
    pu.rotY = Math.atan2(this.carPos.x - chosen.x, this.carPos.z - chosen.z);
    pu.speed = 16;
    pu.dispatched = true;
    pu.sirenActive = true;
    pu.waypoints = findCityRoadPath(pu.pos, this.lastKnownPlayerPos, cityBoxColliders);
    pu.waypointIdx = 0;
    pu.repathTimer = 0.2;
    pu.visual.root.position.set(pu.pos.x, 0, pu.pos.z);
    pu.visual.root.rotation.y = pu.rotY;
    pu.visual.root.visible = true;
  }

  private registerHardImpact(
    impactSpeed: number,
    _x: number,
    _z: number,
    rollSign: number,
    audio: AudioEngine
  ): void {
    const dmg = Math.max(1, Math.round((impactSpeed - 4.2) * 1.05));
    this.carDamage = Math.min(100, this.carDamage + dmg);
    // Suspension chassis jolt!
    this.bodyHeaveVel += clamp(impactSpeed * 0.08, 0.25, 0.95);
    this.bodyRollVel += rollSign * clamp(impactSpeed * 0.04, 0.15, 0.55);
    this.bodyPitchVel += clamp(impactSpeed * 0.035, 0.12, 0.45);
    // Hard slam scrapes clearcoat paint onto Salou stonework -> Die Akte forensic trace!
    if (impactSpeed > 10.5) {
      this.paintScrapeTrace = true;
    }
    audio.playImpact(clamp(impactSpeed / 24, 0.25, 1));
  }

  private applyHeadlightVisuals(braking: boolean, reversing: boolean, parkedIdle: boolean): void {
    const hlActive = this.headlightsOn;
    this.headlightBeamGroup.visible = hlActive;

    const spotPower = hlActive ? (parkedIdle ? 22 : 48) : 0;
    this.headlightSpotL.intensity = spotPower;
    this.headlightSpotR.intensity = spotPower;
    this.headlightFillLight.intensity = hlActive ? (parkedIdle ? 7 : 12) : 0;

    if (this.getawayVisual.headlightsMat) {
      this.getawayVisual.headlightsMat.emissiveIntensity = hlActive ? 3.2 : 0.04;
    }

    // Brake lights always illuminate when pressing brakes; running taillights dim in stealth mode!
    if (this.getawayVisual.brakelightsMat) {
      this.getawayVisual.brakelightsMat.emissiveIntensity = braking ? 4.6 : hlActive ? 0.35 : 0.02;
    }
    if (this.getawayVisual.taillightsMat) {
      this.getawayVisual.taillightsMat.emissiveIntensity = braking
        ? 4.4
        : hlActive
          ? 1.55
          : 0.06;
    }
    this.brakeGlowLight.intensity = braking ? 10.5 : hlActive ? 1.8 : 0;

    // Reverse lamps
    this.reverseLampMeshL.visible = reversing;
    this.reverseLampMeshR.visible = reversing;
    if (this.reverseLampMeshL.material instanceof THREE.MeshStandardMaterial) {
      this.reverseLampMeshL.material.emissiveIntensity = reversing ? 3.4 : 0;
    }
    if (this.getawayVisual.reverselightsMat) {
      this.getawayVisual.reverselightsMat.emissiveIntensity = reversing ? 3.6 : 0;
    }
    this.reverseGlowLight.intensity = reversing ? 9.0 : 0;
  }

  private animateAckermannWheels(
    v: CarVisual,
    frontSpin: number,
    rearSpin: number,
    steer: number,
    roll: number,
    pitch: number
  ): void {
    // True Ackermann geometry: inner front wheel steers slightly sharper than outer
    let steerFL = steer;
    let steerFR = steer;
    if (Math.abs(steer) > 0.01) {
      const turnRadius = WHEELBASE / Math.tan(Math.abs(steer));
      const inner = Math.atan(WHEELBASE / Math.max(0.65, turnRadius - TRACK_WIDTH * 0.5));
      const outer = Math.atan(WHEELBASE / (turnRadius + TRACK_WIDTH * 0.5));
      if (steer > 0) {
        steerFL = inner;
        steerFR = outer;
      } else {
        steerFL = -outer;
        steerFR = -inner;
      }
    }

    // Subtle wheel vertical compression travel (tires stay planted while suspension compresses)
    const frontComp = clamp(pitch * 0.16, -0.028, 0.028);
    const sideComp = clamp(roll * 0.14, -0.025, 0.025);

    if (v.wheelFL) {
      v.wheelFL.rotation.y = steerFL;
      v.wheelFL.rotation.x = frontSpin;
      v.wheelFL.position.y = v.wheelBaseY + frontComp - sideComp;
    }
    if (v.wheelFR) {
      v.wheelFR.rotation.y = steerFR;
      v.wheelFR.rotation.x = frontSpin;
      v.wheelFR.position.y = v.wheelBaseY + frontComp + sideComp;
    }
    if (v.wheelRL) {
      v.wheelRL.rotation.x = rearSpin;
      v.wheelRL.position.y = v.wheelBaseY - frontComp - sideComp;
    }
    if (v.wheelRR) {
      v.wheelRR.rotation.x = rearSpin;
      v.wheelRR.position.y = v.wheelBaseY - frontComp + sideComp;
    }
  }

  private spawnDriftSpray(x: number, z: number, brakeTint: boolean): void {
    if (this.smokeParticles.length >= 44) return;
    const matParams: THREE.SpriteMaterialParameters = {
      color: brakeTint ? 0xd8a8b2 : 0xa9bed4,
      transparent: true,
      opacity: clamp(0.24 + this.skidIntensity * 0.22, 0.18, 0.44),
      depthWrite: false,
    };
    if (this.smokeTex) {
      matParams.map = this.smokeTex;
    }
    const mat = new THREE.SpriteMaterial(matParams);
    const sprite = new THREE.Sprite(mat);
    sprite.userData.excludeFromAO = true;
    sprite.position.set(
      x + (Math.random() - 0.5) * 0.35,
      0.24,
      z + (Math.random() - 0.5) * 0.35
    );
    const startScale = 0.55 + Math.random() * 0.25;
    sprite.scale.set(startScale, startScale, 1);
    this.root.add(sprite);

    this.smokeParticles.push({
      sprite,
      mat,
      vx: -this.vx * 0.08 + (Math.random() - 0.5) * 1.1,
      vy: 0.75 + Math.random() * 0.45,
      vz: -this.vz * 0.08 + (Math.random() - 0.5) * 1.1,
      age: 0,
      maxAge: 0.58 + Math.random() * 0.28,
      startScale,
      endScale: 2.1 + Math.random() * 0.8,
    });
  }

  private spawnScrapeSparks(x: number, z: number, nx: number, nz: number, count: number): void {
    for (let i = 0; i < count; i++) {
      if (this.sparkParticles.length >= 38) break;
      const mat = new THREE.MeshBasicMaterial({
        color: Math.random() > 0.35 ? 0xfbbf24 : 0xfff7ed,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this.sparkGeo, mat);
      mesh.userData.excludeFromAO = true;
      mesh.position.set(x, 0.36 + Math.random() * 0.25, z);
      const svx = nx * (2.5 + Math.random() * 5.0) + (Math.random() - 0.5) * 4.5 - this.vx * 0.25;
      const svz = nz * (2.5 + Math.random() * 5.0) + (Math.random() - 0.5) * 4.5 - this.vz * 0.25;
      const svy = 1.6 + Math.random() * 3.2;
      mesh.rotation.y = Math.atan2(svx, svz);
      this.root.add(mesh);
      this.sparkParticles.push({
        mesh,
        mat,
        vx: svx,
        vy: svy,
        vz: svz,
        age: 0,
        maxAge: 0.24 + Math.random() * 0.22,
      });
    }
  }

  private spawnSkidMark(from: Vec2, to: Vec2, intensity: number): void {
    const segLen = dist2D(from.x, from.z, to.x, to.z);
    if (segLen < 0.22 || segLen > 4.5) return;

    // Recycle oldest skid mark if pool full
    if (this.skidMarks.length >= 130) {
      const oldest = this.skidMarks.shift();
      if (oldest) {
        this.root.remove(oldest.mesh);
        oldest.mat.dispose();
      }
    }

    const mat = new THREE.MeshBasicMaterial({
      color: 0x090d14,
      transparent: true,
      opacity: clamp(0.18 + intensity * 0.38, 0.16, 0.54),
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.skidGeo, mat);
    mesh.userData.excludeFromAO = true;
    mesh.position.set((from.x + to.x) * 0.5, 0.026, (from.z + to.z) * 0.5);
    mesh.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
    mesh.scale.set(1, 1, segLen + 0.08);
    this.root.add(mesh);

    this.skidMarks.push({
      mesh,
      mat,
      age: 0,
      maxAge: 14.0,
    });
  }

  private updateParticles(dt: number): void {
    // Update soft wet-spray / tire smoke sprites
    for (let i = this.smokeParticles.length - 1; i >= 0; i--) {
      const p = this.smokeParticles[i];
      p.age += dt;
      if (p.age >= p.maxAge) {
        this.root.remove(p.sprite);
        p.mat.dispose();
        this.smokeParticles.splice(i, 1);
        continue;
      }
      const u = p.age / p.maxAge;
      p.sprite.position.x += p.vx * dt;
      p.sprite.position.y += p.vy * dt;
      p.sprite.position.z += p.vz * dt;
      const sc = lerp(p.startScale, p.endScale, u);
      p.sprite.scale.set(sc, sc, 1);
      p.mat.opacity = (1 - u) * (1 - u) * 0.34;
    }

    // Update ballistic scrape sparks
    for (let i = this.sparkParticles.length - 1; i >= 0; i--) {
      const sp = this.sparkParticles[i];
      sp.age += dt;
      if (sp.age >= sp.maxAge) {
        this.root.remove(sp.mesh);
        sp.mat.dispose();
        this.sparkParticles.splice(i, 1);
        continue;
      }
      sp.vy -= 14.5 * dt;
      sp.mesh.position.x += sp.vx * dt;
      sp.mesh.position.y += sp.vy * dt;
      sp.mesh.position.z += sp.vz * dt;
      if (sp.mesh.position.y < 0.04) {
        sp.mesh.position.y = 0.04;
        sp.vy = Math.abs(sp.vy) * 0.35;
        sp.vx *= 0.72;
        sp.vz *= 0.72;
      }
      sp.mat.opacity = 1 - sp.age / sp.maxAge;
    }

    // Fade wet tire skid marks over time
    for (let i = this.skidMarks.length - 1; i >= 0; i--) {
      const sk = this.skidMarks[i];
      sk.age += dt;
      if (sk.age >= sk.maxAge) {
        this.root.remove(sk.mesh);
        sk.mat.dispose();
        this.skidMarks.splice(i, 1);
        continue;
      }
      if (sk.age > sk.maxAge * 0.65) {
        const fadeU = (sk.age - sk.maxAge * 0.65) / (sk.maxAge * 0.35);
        sk.mat.opacity *= 1 - fadeU * dt * 2.4;
      }
    }
  }

  public dispose(): void {
    for (const p of this.smokeParticles) p.mat.dispose();
    this.smokeParticles = [];
    for (const sp of this.sparkParticles) sp.mat.dispose();
    this.sparkParticles = [];
    for (const sk of this.skidMarks) sk.mat.dispose();
    this.skidMarks = [];
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    disposeSceneSubtree(this.root);
  }
}
