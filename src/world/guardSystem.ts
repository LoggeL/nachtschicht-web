import * as THREE from 'three';
import {
  FloorId,
  GuardPatrol,
  HeistTarget,
  IntelState,
  LiveCameraState,
  LiveGuardState,
  TargetNode,
  Vec2,
} from '../sim/types';
import { sampleCameraHeading, sampleGuardAtTime } from '../sim/simulator';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import { DEG2RAD, dampAngleRad, headingDegToRotY } from './mathUtils';

// ============================================================================
// NACHTSCHICHT — 3D Guard Patrols, CCTV Cameras & Volumetric Vision Cones
// Drives guards & cameras from deterministic simulator in Scouting mode and
// from liveEngine.ts state in Executing mode.
// ============================================================================

interface GuardRig {
  pelvis?: THREE.Object3D;
  torso?: THREE.Object3D;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
}

interface GuardEntity {
  def: GuardPatrol;
  root: THREE.Group;
  model: THREE.Group;
  rig: GuardRig;
  coneMesh: THREE.Mesh;
  coneMat: THREE.MeshBasicMaterial;
  timedRing: THREE.Mesh;
  timedRingMat: THREE.MeshBasicMaterial;
  badgeSprite: THREE.Sprite;
  badgeCanvas: HTMLCanvasElement;
  lastBadgeKey: string;
  currentPos: Vec2;
  currentFloor: FloorId;
  currentRotY: number;
  walkPhase: number;
}

interface CameraEntity {
  node: TargetNode;
  root: THREE.Group;
  model: THREE.Group;
  headPivot: THREE.Object3D | null;
  ledMesh: THREE.Mesh | null;
  conePivot: THREE.Group;
  coneMesh: THREE.Mesh;
  coneMat: THREE.MeshBasicMaterial;
  baseMountRotY: number;
}

function createVisionConeGeometry(range: number, coneDeg: number): THREE.BufferGeometry {
  const segments = 24;
  const halfAngle = (coneDeg * DEG2RAD) / 2;
  const positions: number[] = [0, 0, 0];
  const uvs: number[] = [0.5, 0];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const angle = -halfAngle + t * halfAngle * 2;
    const x = Math.sin(angle) * range;
    const z = Math.cos(angle) * range;
    positions.push(x, 0, z);
    uvs.push(t, 1);
    if (i < segments) {
      indices.push(0, i + 1, i + 2);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

let sharedConeGradTex: THREE.CanvasTexture | null = null;
function getConeGradientTexture(): THREE.CanvasTexture {
  if (sharedConeGradTex) return sharedConeGradTex;
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createLinearGradient(0, 0, 0, 128);
    grad.addColorStop(0, 'rgba(255,255,255,0.92)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.45)');
    grad.addColorStop(0.92, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0.0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 128);
  }
  sharedConeGradTex = new THREE.CanvasTexture(canvas);
  sharedConeGradTex.userData.sharedAsset = true;
  sharedConeGradTex.needsUpdate = true;
  return sharedConeGradTex;
}

function drawGuardBadge(
  canvas: HTMLCanvasElement,
  text: string,
  colorHex: string
): THREE.CanvasTexture {
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(10, 15, 28, 0.88)';
    ctx.strokeStyle = colorHex;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, 14);
    ctx.fill();
    ctx.stroke();

    ctx.font = 'bold 28px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colorHex;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class GuardSystem {
  public readonly root = new THREE.Group();
  private target: HeistTarget;
  private guards: GuardEntity[] = [];
  private cameras: CameraEntity[] = [];

  constructor(target: HeistTarget) {
    this.target = target;
    this.root.name = 'GuardSystem';
    this.buildGuards();
    this.buildCameras();
  }

  private buildGuards(): void {
    const gradTex = getConeGradientTexture();

    for (const gDef of this.target.guards) {
      const entityRoot = new THREE.Group();
      entityRoot.name = `Guard_${gDef.id}`;

      const model = assetRegistry.instantiateModel('character_guard', false);
      entityRoot.add(model);

      const rig: GuardRig = {
        pelvis: model.getObjectByName('Pelvis'),
        torso: model.getObjectByName('Torso'),
        head: model.getObjectByName('Head'),
        armL: model.getObjectByName('Arm_L'),
        armR: model.getObjectByName('Arm_R'),
        legL: model.getObjectByName('Leg_L'),
        legR: model.getObjectByName('Leg_R'),
      };

      // Volumetric ground vision cone
      const coneGeo = createVisionConeGeometry(gDef.visionRange, gDef.visionConeDeg);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xfde68a,
        map: gradTex,
        transparent: true,
        opacity: 0.28,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coneMesh = new THREE.Mesh(coneGeo, coneMat);
      coneMesh.position.y = 0.09;
      entityRoot.add(coneMesh);

      // Subtle flashlight air beam
      const beamGeo = new THREE.ConeGeometry(0.95, 4.6, 12, 1, true);
      beamGeo.translate(0, -2.3, 0);
      beamGeo.rotateX(-Math.PI / 2);
      const beamMat = new THREE.MeshBasicMaterial({
        color: 0xfff3c4,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const beam = new THREE.Mesh(beamGeo, beamMat);
      beam.position.set(-0.24, 1.05, 0.22);
      entityRoot.add(beam);

      // Timed / target ring under guard feet
      const ringGeo = new THREE.RingGeometry(0.58, 0.78, 24);
      ringGeo.rotateX(-Math.PI / 2);
      const timedRingMat = new THREE.MeshBasicMaterial({
        color: 0x2dd4bf,
        transparent: true,
        opacity: 0.0,
        side: THREE.DoubleSide,
      });
      const timedRing = new THREE.Mesh(ringGeo, timedRingMat);
      timedRing.position.y = 0.06;
      entityRoot.add(timedRing);

      // Status badge (?, !, TIMED)
      const badgeCanvas = document.createElement('canvas');
      badgeCanvas.width = 256;
      badgeCanvas.height = 68;
      const badgeSprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ transparent: true, depthTest: false })
      );
      badgeSprite.position.set(0, 2.15, 0);
      badgeSprite.scale.set(1.45, 0.4, 1);
      badgeSprite.visible = false;
      entityRoot.add(badgeSprite);

      const wp0 = gDef.waypoints[0] ?? { pos: { x: 0, z: 0 }, floor: 0, lookAngleDeg: 0 };
      const rotY = headingDegToRotY(wp0.lookAngleDeg ?? 0);
      entityRoot.position.set(wp0.pos.x, wp0.floor * this.target.floorHeightM, wp0.pos.z);
      entityRoot.rotation.y = rotY;

      this.root.add(entityRoot);
      this.guards.push({
        def: gDef,
        root: entityRoot,
        model,
        rig,
        coneMesh,
        coneMat,
        timedRing,
        timedRingMat,
        badgeSprite,
        badgeCanvas,
        lastBadgeKey: '',
        currentPos: { ...wp0.pos },
        currentFloor: wp0.floor,
        currentRotY: rotY,
        walkPhase: Math.random() * Math.PI * 2,
      });
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

      // Ground vision sweep cone for CCTV
      const conePivot = new THREE.Group();
      conePivot.position.y = 0.08;
      conePivot.rotation.y = baseMountRotY;

      const coneGeo = createVisionConeGeometry(node.cameraRange ?? 10, 55);
      const coneMat = new THREE.MeshBasicMaterial({
        color: 0xfb7185,
        map: gradTex,
        transparent: true,
        opacity: 0.24,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coneMesh = new THREE.Mesh(coneGeo, coneMat);
      conePivot.add(coneMesh);
      entityRoot.add(conePivot);

      this.root.add(entityRoot);
      this.cameras.push({
        node,
        root: entityRoot,
        model,
        headPivot,
        ledMesh,
        conePivot,
        coneMesh,
        coneMat,
        baseMountRotY,
      });
    }
  }

  public getGuardWorldInfo(): Array<{
    guardId: string;
    name: string;
    pos: Vec2;
    floor: FloorId;
  }> {
    return this.guards.map((g) => ({
      guardId: g.def.id,
      name: g.def.name,
      pos: { ...g.currentPos },
      floor: g.currentFloor,
    }));
  }

  public update(params: {
    dt: number;
    timeSec: number;
    phase: 'scouting' | 'executing' | 'escape';
    focusFloor: FloorId;
    intel: IntelState;
    liveGuards?: LiveGuardState[];
    liveCameras?: LiveCameraState[];
    powerDisabled: boolean;
    timingGuardId: string | null;
  }): void {
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
    } = params;

    if (phase === 'escape') {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    // 1) Update Guards
    for (const g of this.guards) {
      let targetPos: Vec2;
      let targetFloor: FloorId;
      let targetHeadingDeg: number;
      let guardState: LiveGuardState['state'] = 'patrol';
      let suspicion = 0;

      if (phase === 'executing' && liveGuards) {
        const lg = liveGuards.find((s) => s.guardId === g.def.id);
        if (lg) {
          targetPos = lg.pos;
          targetFloor = lg.floor;
          targetHeadingDeg = lg.headingDeg;
          guardState = lg.state;
          suspicion = lg.suspicion;
        } else {
          const s = sampleGuardAtTime(g.def, timeSec);
          targetPos = s.pos;
          targetFloor = s.floor;
          targetHeadingDeg = s.headingDeg;
        }
      } else {
        const s = sampleGuardAtTime(g.def, timeSec);
        targetPos = s.pos;
        targetFloor = s.floor;
        targetHeadingDeg = s.headingDeg;
      }

      // Visibility based on floor cutaway
      g.root.visible =
        focusFloor < 0 ? targetFloor === focusFloor : targetFloor >= 0 && targetFloor <= focusFloor;

      const moveDist = Math.hypot(
        targetPos.x - g.currentPos.x,
        targetPos.z - g.currentPos.z
      );
      const speed = dt > 0.001 ? moveDist / dt : 0;

      g.currentPos.x = targetPos.x;
      g.currentPos.z = targetPos.z;
      g.currentFloor = targetFloor;
      const desiredRotY = headingDegToRotY(targetHeadingDeg);
      g.currentRotY = dampAngleRad(g.currentRotY, desiredRotY, 10, dt);

      g.root.position.set(
        g.currentPos.x,
        g.currentFloor * this.target.floorHeightM,
        g.currentPos.z
      );
      g.root.rotation.y = g.currentRotY;

      // Animate walk limbs
      if (speed > 0.15) {
        g.walkPhase += dt * Math.min(10, 4.5 + speed * 2.1);
        const swing = Math.sin(g.walkPhase) * 0.48;
        if (g.rig.legL) g.rig.legL.rotation.x = swing;
        if (g.rig.legR) g.rig.legR.rotation.x = -swing;
        if (g.rig.armL) g.rig.armL.rotation.x = -swing * 0.65;
        // Arm_R holds flashlight forward steadily
        if (g.rig.armR) g.rig.armR.rotation.x = -0.58 + swing * 0.12;
        if (g.rig.pelvis) g.rig.pelvis.position.y = 0.92 + Math.abs(Math.sin(g.walkPhase)) * 0.04;
      } else {
        if (g.rig.legL) g.rig.legL.rotation.x *= 0.85;
        if (g.rig.legR) g.rig.legR.rotation.x *= 0.85;
        if (g.rig.armL) g.rig.armL.rotation.x *= 0.85;
        if (g.rig.armR) g.rig.armR.rotation.x = -0.52;
        if (g.rig.head) g.rig.head.rotation.y = Math.sin(timeSec * 1.2) * 0.25;
      }

      // Vision cone color & badges
      if (phase === 'executing') {
        if (guardState === 'alerted' || guardState === 'chasing' || suspicion >= 80) {
          g.coneMat.color.setHex(0xef4444);
          g.coneMat.opacity = 0.42 + Math.sin(timeSec * 12) * 0.12;
          this.setGuardBadge(g, '! ALARM', '#ef4444');
        } else if (guardState === 'investigating' || suspicion >= 25) {
          g.coneMat.color.setHex(0xf59e0b);
          g.coneMat.opacity = 0.38;
          this.setGuardBadge(g, `? ${Math.round(suspicion)}%`, '#f59e0b');
        } else {
          g.coneMat.color.setHex(0xfde68a);
          g.coneMat.opacity = 0.25;
          g.badgeSprite.visible = false;
        }
        g.timedRingMat.opacity = 0;
      } else {
        // Scouting phase
        g.coneMat.color.setHex(0xfde68a);
        g.coneMat.opacity = 0.26;
        const isTimed = intel.timedGuardIds.includes(g.def.id);
        const isTimingNow = timingGuardId === g.def.id;
        if (isTimingNow) {
          g.timedRingMat.color.setHex(0x38bdf8);
          g.timedRingMat.opacity = 0.9;
          this.setGuardBadge(g, 'STOPPT ROUTE...', '#38bdf8');
        } else if (isTimed) {
          g.timedRingMat.color.setHex(0x2dd4bf);
          g.timedRingMat.opacity = 0.65;
          this.setGuardBadge(g, '✓ GETIMET', '#2dd4bf');
        } else {
          g.timedRingMat.color.setHex(0xfbbf24);
          g.timedRingMat.opacity = 0.45;
          this.setGuardBadge(g, 'WACHE [E]', '#fbbf24');
        }
      }
    }

    // 2) Update CCTV Cameras
    for (const c of this.cameras) {
      const lc = liveCameras?.find((s) => s.nodeId === c.node.id);
      const isActive =
        phase === 'executing'
          ? (lc ? lc.active : !powerDisabled)
          : !powerDisabled;
      const headingDeg =
        phase === 'executing' && lc
          ? lc.headingDeg
          : sampleCameraHeading(c.node, timeSec);
      const suspicion = lc?.suspicion ?? 0;

      c.root.visible =
        focusFloor < 0
          ? c.node.floor === focusFloor
          : c.node.floor >= 0 && c.node.floor <= focusFloor;

      const worldRotY = headingDegToRotY(headingDeg);
      c.conePivot.rotation.y = worldRotY;

      if (c.headPivot) {
        // Local sweep delta relative to wall mount orientation
        c.headPivot.rotation.y = worldRotY - c.baseMountRotY;
      }

      c.coneMesh.visible = isActive;
      if (isActive) {
        if (suspicion > 35) {
          c.coneMat.color.setHex(0xef4444);
          c.coneMat.opacity = 0.45;
        } else {
          c.coneMat.color.setHex(0xfb7185);
          c.coneMat.opacity = 0.24;
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
  }

  private setGuardBadge(g: GuardEntity, text: string, colorHex: string): void {
    const key = `${text}|${colorHex}`;
    g.badgeSprite.visible = true;
    if (g.lastBadgeKey === key) return;
    g.lastBadgeKey = key;
    const mat = g.badgeSprite.material as THREE.SpriteMaterial;
    if (mat.map) mat.map.dispose();
    mat.map = drawGuardBadge(g.badgeCanvas, text, colorHex);
    mat.needsUpdate = true;
  }

  public dispose(): void {
    disposeSceneSubtree(this.root);
  }
}
