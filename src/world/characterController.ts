import * as THREE from 'three';
import {
  CrewId,
  CrewMember,
  FloorId,
  HeistTarget,
  LiveCrewState,
  Vec2,
} from '../sim/types';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import {
  SegmentCollider,
  clamp,
  dampAngleRad,
  headingDegToRotY,
  resolveCircleVsSegment,
  rotYToHeadingDeg,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — 3D Character Controller (Mara Voss + AI Crew Accomplices)
// Handles Mara's WASD + sneak + collision movement, limb walk/sneak/work
// animations, progress rings, and floating crew/deviation callouts.
// ============================================================================

interface CharRig {
  pelvis?: THREE.Object3D;
  torso?: THREE.Object3D;
  head?: THREE.Object3D;
  armL?: THREE.Object3D;
  armR?: THREE.Object3D;
  legL?: THREE.Object3D;
  legR?: THREE.Object3D;
  pelvisBaseY: number;
}

interface CrewActorVisual {
  crewId: CrewId;
  accentColor: string;
  root: THREE.Group;
  model: THREE.Group;
  rig: CharRig;
  baseRing: THREE.Mesh;
  progressRing: THREE.Mesh;
  progressMat: THREE.MeshBasicMaterial;
  badgeSprite: THREE.Sprite;
  badgeCanvas: HTMLCanvasElement;
  lastBadgeKey: string;
  pos: Vec2;
  floor: FloorId;
  rotY: number;
  walkPhase: number;
}

function createBadgeTexture(
  canvas: HTMLCanvasElement,
  name: string,
  status: string,
  accentHex: string,
  isDeviation: boolean
): THREE.CanvasTexture {
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = isDeviation ? 'rgba(127, 29, 29, 0.92)' : 'rgba(9, 15, 30, 0.85)';
    ctx.strokeStyle = isDeviation ? '#fb7185' : accentHex;
    ctx.lineWidth = isDeviation ? 4 : 3;
    ctx.beginPath();
    ctx.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 12);
    ctx.fill();
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 21px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = isDeviation ? '#fef08a' : accentHex;
    ctx.fillText(name.slice(0, 22), canvas.width / 2, 31);

    ctx.font = '600 16px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#f1f5f9';
    ctx.fillText(status.slice(0, 30), canvas.width / 2, 59);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function extractRig(model: THREE.Group): CharRig {
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

function animateRig(
  rig: CharRig,
  dt: number,
  timeSec: number,
  walkPhaseRef: { val: number },
  mode: 'idle' | 'walk' | 'sneak' | 'work' | 'hold' | 'flee',
  speed: number
): void {
  const basePelvisY = rig.pelvisBaseY;

  if (mode === 'work') {
    const workOsc = Math.sin(timeSec * 11);
    if (rig.pelvis) rig.pelvis.position.y = basePelvisY - 0.16;
    if (rig.torso) rig.torso.rotation.x = 0.34;
    if (rig.armL) rig.armL.rotation.x = -0.95 + workOsc * 0.25;
    if (rig.armR) rig.armR.rotation.x = -0.95 - workOsc * 0.25;
    if (rig.legL) rig.legL.rotation.x = -0.25;
    if (rig.legR) rig.legR.rotation.x = 0.22;
    return;
  }

  if (mode === 'walk' || mode === 'sneak' || mode === 'flee') {
    const freq = mode === 'flee' ? 11.5 : mode === 'sneak' ? 5.2 : 7.5 + speed * 0.7;
    const amp = mode === 'flee' ? 0.72 : mode === 'sneak' ? 0.38 : 0.54;
    walkPhaseRef.val += dt * freq;
    const s = Math.sin(walkPhaseRef.val) * amp;
    if (rig.legL) rig.legL.rotation.x = s;
    if (rig.legR) rig.legR.rotation.x = -s;
    if (rig.armL) rig.armL.rotation.x = -s * 0.72;
    if (rig.armR) rig.armR.rotation.x = s * 0.72;
    if (rig.torso) rig.torso.rotation.x = mode === 'sneak' ? 0.28 : mode === 'flee' ? 0.18 : 0.05;
    if (rig.pelvis) {
      const crouch = mode === 'sneak' ? -0.14 : 0;
      rig.pelvis.position.y = basePelvisY + crouch + Math.abs(Math.sin(walkPhaseRef.val)) * 0.045;
    }
    if (rig.head) rig.head.rotation.y = 0;
    return;
  }

  // Idle / Hold
  if (rig.legL) rig.legL.rotation.x *= 0.82;
  if (rig.legR) rig.legR.rotation.x *= 0.82;
  if (rig.armL) rig.armL.rotation.x *= 0.82;
  if (rig.armR) rig.armR.rotation.x *= 0.82;
  if (rig.torso) rig.torso.rotation.x *= 0.85;
  if (rig.pelvis) {
    rig.pelvis.position.y = basePelvisY + Math.sin(timeSec * 2.2) * 0.015;
  }
  if (rig.head) {
    rig.head.rotation.y = Math.sin(timeSec * (mode === 'hold' ? 2.4 : 0.9)) * 0.22;
  }
}

export class CharacterController {
  public readonly root = new THREE.Group();
  private target: HeistTarget;
  private actors = new Map<CrewId, CrewActorVisual>();

  // Mara player state
  public maraPos: Vec2;
  public maraFloor: FloorId = 0;
  public maraRotY = 0;
  public maraSneaking = false;
  public maraSpeed = 0;
  public manualExecutionControl = false;

  constructor(target: HeistTarget, crewById: Record<CrewId, CrewMember>) {
    this.target = target;
    this.root.name = 'CharacterController';
    this.maraPos = { x: 0, z: Math.min(target.bounds.maxZ - 2.2, 11.2) };
    this.maraRotY = Math.PI; // Facing North (-Z) toward target storefront

    // Spawn Mara always
    this.ensureActor('mara', crewById.mara);
  }

  private ensureActor(crewId: CrewId, member?: CrewMember): CrewActorVisual {
    const existing = this.actors.get(crewId);
    if (existing) return existing;

    const accent = member?.accentColor ?? (crewId === 'mara' ? '#38bdf8' : '#f59e0b');
    const actorRoot = new THREE.Group();
    actorRoot.name = `Crew_${crewId}`;

    const isMara = crewId === 'mara';
    const model = assetRegistry.instantiateModel(
      isMara ? 'character_mara' : 'character_crew',
      !isMara
    );

    // Subtle accent tint on AI crew hoodie/beanie so Jupp/Jule/Toni/Rico are immediately recognizable
    if (!isMara) {
      const tint = new THREE.Color(accent);
      model.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (
              m instanceof THREE.MeshStandardMaterial &&
              (m.name.includes('Hoodie') || m.name.includes('Beanie'))
            ) {
              m.color.copy(tint);
            }
          }
        }
      });
    }

    actorRoot.add(model);

    // Colored ground locator ring
    const baseRingGeo = new THREE.RingGeometry(0.42, 0.56, 28);
    baseRingGeo.rotateX(-Math.PI / 2);
    const baseRing = new THREE.Mesh(
      baseRingGeo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(accent),
        transparent: true,
        opacity: isMara ? 0.72 : 0.58,
        side: THREE.DoubleSide,
      })
    );
    baseRing.position.y = 0.05;
    actorRoot.add(baseRing);

    // Action progress ring (scales/pulses while working or scanning)
    const progGeo = new THREE.RingGeometry(0.62, 0.84, 32);
    progGeo.rotateX(-Math.PI / 2);
    const progressMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    const progressRing = new THREE.Mesh(progGeo, progressMat);
    progressRing.position.y = 0.07;
    actorRoot.add(progressRing);

    // Floating nameplate & status/deviation callout
    const badgeCanvas = document.createElement('canvas');
    badgeCanvas.width = 360;
    badgeCanvas.height = 88;
    const badgeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthTest: false })
    );
    badgeSprite.position.set(0, 2.18, 0);
    badgeSprite.scale.set(1.9, 0.47, 1);
    badgeSprite.visible = !isMara;
    actorRoot.add(badgeSprite);

    this.root.add(actorRoot);
    const actor: CrewActorVisual = {
      crewId,
      accentColor: accent,
      root: actorRoot,
      model,
      rig: extractRig(model),
      baseRing,
      progressRing,
      progressMat,
      badgeSprite,
      badgeCanvas,
      lastBadgeKey: '',
      pos: { ...this.maraPos },
      floor: 0,
      rotY: this.maraRotY,
      walkPhase: Math.random() * Math.PI * 2,
    };
    this.actors.set(crewId, actor);
    return actor;
  }

  public resetForScouting(): void {
    this.manualExecutionControl = false;
    this.maraFloor = 0;
    this.maraSneaking = false;
    this.maraSpeed = 0;
    this.maraPos = {
      x: 0,
      z: Math.min(this.target.bounds.maxZ - 1.8, 11.5),
    };
    this.maraRotY = Math.PI; // Look toward storefront (-Z)
  }

  public resetForExecuting(): void {
    this.manualExecutionControl = false;
    this.maraFloor = 0;
    this.maraSneaking = false;
    this.maraSpeed = 0;
    this.maraPos = { ...this.target.getawayPos };
    this.maraRotY = headingDegToRotY(this.target.getawayHeadingDeg);
  }

  /**
   * Moves Mara via WASD relative to camera yaw with smooth wall sliding.
   * Returns true if player pressed a movement key this frame.
   */
  public moveMaraByInput(params: {
    dt: number;
    forwardInput: number; // +1 W, -1 S
    rightInput: number; // +1 D, -1 A
    sneaking: boolean;
    cameraYawRad: number;
    wallColliders: SegmentCollider[];
    allowPassThroughDoors: boolean;
    doorPositions: Vec2[];
  }): boolean {
    const {
      dt,
      forwardInput,
      rightInput,
      sneaking,
      cameraYawRad,
      wallColliders,
      allowPassThroughDoors,
      doorPositions,
    } = params;

    this.maraSneaking = sneaking;
    const mag = Math.hypot(forwardInput, rightInput);
    if (mag < 0.05) {
      this.maraSpeed = 0;
      return false;
    }

    const nf = forwardInput / mag;
    const nr = rightInput / mag;

    // Camera forward projected onto XZ plane
    const fwdX = -Math.sin(cameraYawRad);
    const fwdZ = -Math.cos(cameraYawRad);
    const rightX = Math.cos(cameraYawRad);
    const rightZ = -Math.sin(cameraYawRad);

    const moveX = fwdX * nf + rightX * nr;
    const moveZ = fwdZ * nf + rightZ * nr;
    const speed = sneaking ? 2.5 : 4.9;
    this.maraSpeed = speed;

    this.maraPos.x += moveX * speed * dt;
    this.maraPos.z += moveZ * speed * dt;

    // Clamp to playable city block around the target
    const b = this.target.bounds;
    this.maraPos.x = clamp(this.maraPos.x, b.minX - 10, b.maxX + 10);
    this.maraPos.z = clamp(this.maraPos.z, b.minZ - 8, b.maxZ + 12);

    // Wall collision with generous doorway pass-through tolerance
    const nearDoor =
      allowPassThroughDoors &&
      doorPositions.some(
        (dp) => Math.hypot(dp.x - this.maraPos.x, dp.z - this.maraPos.z) < 1.65
      );

    if (!nearDoor) {
      for (const w of wallColliders) {
        if (w.floor !== this.maraFloor) continue;
        resolveCircleVsSegment(
          this.maraPos,
          0.38,
          w.x1,
          w.z1,
          w.x2,
          w.z2,
          w.thickness * 0.5
        );
      }
    }

    const desiredRotY = Math.atan2(moveX, moveZ);
    this.maraRotY = dampAngleRad(this.maraRotY, desiredRotY, 13, dt);
    return true;
  }

  public getMaraHeadingDeg(): number {
    return rotYToHeadingDeg(this.maraRotY);
  }

  public updateVisuals(params: {
    dt: number;
    timeSec: number;
    phase: 'scouting' | 'executing' | 'escape';
    focusFloor: FloorId;
    crewById: Record<CrewId, CrewMember>;
    liveCrew?: Record<CrewId, LiveCrewState>;
    maraScanProgress: number;
    maraInteractProgress: number;
  }): void {
    const {
      dt,
      timeSec,
      phase,
      focusFloor,
      crewById,
      liveCrew,
      maraScanProgress,
      maraInteractProgress,
    } = params;

    if (phase === 'escape') {
      this.root.visible = false;
      return;
    }
    this.root.visible = true;

    const activeIds = new Set<CrewId>(['mara']);
    if (phase === 'executing' && liveCrew) {
      for (const cid of Object.keys(liveCrew) as CrewId[]) {
        activeIds.add(cid);
      }
    }

    // Hide unassigned actors
    for (const [cid, actor] of this.actors.entries()) {
      if (!activeIds.has(cid)) {
        actor.root.visible = false;
      }
    }

    for (const cid of activeIds) {
      const member = crewById[cid];
      const actor = this.ensureActor(cid, member);

      if (cid === 'mara') {
        const maraLive = phase === 'executing' ? liveCrew?.mara : undefined;
        // If executing and player hasn't manually steered yet, mirror liveEngine's planned track for Mara
        if (phase === 'executing' && maraLive && !this.manualExecutionControl) {
          this.maraPos.x = maraLive.pos.x;
          this.maraPos.z = maraLive.pos.z;
          this.maraFloor = maraLive.floor;
          this.maraRotY = dampAngleRad(
            this.maraRotY,
            headingDegToRotY(maraLive.headingDeg),
            12,
            dt
          );
          this.maraSpeed = maraLive.speed;
          this.maraSneaking = maraLive.sneaking;
        }

        const isExtracted = phase === 'executing' && maraLive?.state === 'extracted';
        actor.root.visible = !isExtracted;
        actor.pos.x = this.maraPos.x;
        actor.pos.z = this.maraPos.z;
        actor.floor = this.maraFloor;
        actor.rotY = this.maraRotY;

        actor.root.position.set(
          actor.pos.x,
          actor.floor * this.target.floorHeightM,
          actor.pos.z
        );
        actor.root.rotation.y = actor.rotY;

        const progress = Math.max(
          maraScanProgress,
          maraInteractProgress,
          !this.manualExecutionControl && maraLive?.state === 'working'
            ? maraLive.blockProgress
            : 0
        );
        const animMode: 'idle' | 'walk' | 'sneak' | 'work' | 'hold' | 'flee' =
          progress > 0.02
            ? 'work'
            : this.maraSpeed > 0.15
              ? this.maraSneaking
                ? 'sneak'
                : 'walk'
              : 'idle';

        const phaseRef = { val: actor.walkPhase };
        animateRig(actor.rig, dt, timeSec, phaseRef, animMode, this.maraSpeed);
        actor.walkPhase = phaseRef.val;

        // Progress ring around Mara
        actor.progressMat.opacity = progress > 0.01 ? 0.88 : 0;
        actor.progressMat.color.setHex(phase === 'scouting' ? 0x2dd4bf : 0x38bdf8);
        const pScale = 0.75 + progress * 0.65;
        actor.progressRing.scale.set(pScale, pScale, 1);
        actor.progressRing.rotation.z = timeSec * 3.5;

        actor.badgeSprite.visible = false;
        continue;
      }

      // AI Crew Member (Jupp, Jule, Toni, Rico)
      const cState = liveCrew?.[cid];
      if (!cState || cState.state === 'extracted' || cState.state === 'caught') {
        actor.root.visible = false;
        continue;
      }

      const floorVisible =
        focusFloor < 0
          ? cState.floor === focusFloor
          : cState.floor >= 0 && cState.floor <= focusFloor;
      actor.root.visible = floorVisible;

      actor.pos.x = cState.pos.x;
      actor.pos.z = cState.pos.z;
      actor.floor = cState.floor;
      actor.rotY = dampAngleRad(actor.rotY, headingDegToRotY(cState.headingDeg), 10, dt);

      actor.root.position.set(
        actor.pos.x,
        actor.floor * this.target.floorHeightM,
        actor.pos.z
      );
      actor.root.rotation.y = actor.rotY;

      const animMode: 'idle' | 'walk' | 'sneak' | 'work' | 'hold' | 'flee' =
        cState.state === 'working'
          ? 'work'
          : cState.state === 'fleeing'
            ? 'flee'
            : cState.state === 'moving' || cState.state === 'deviating'
              ? cState.sneaking
                ? 'sneak'
                : 'walk'
              : cState.state === 'holding' || cState.state === 'waiting_sync'
                ? 'hold'
                : 'idle';

      const phaseRef = { val: actor.walkPhase };
      animateRig(actor.rig, dt, timeSec, phaseRef, animMode, cState.speed);
      actor.walkPhase = phaseRef.val;

      // Work / deviation progress ring
      const isWorking = cState.state === 'working' || cState.state === 'deviating';
      const isDeviation =
        cState.deviationActive !== null &&
        cState.deviationActive !== 'nerves_improvise';
      actor.progressMat.opacity = isWorking ? 0.85 : isDeviation ? 0.65 : 0;
      actor.progressMat.color.set(isDeviation ? '#fb7185' : actor.accentColor);
      const pScale = 0.78 + cState.blockProgress * 0.55;
      actor.progressRing.scale.set(pScale, pScale, 1);

      // Update nameplate / deviation callout
      actor.badgeSprite.visible = floorVisible;
      const title = isDeviation
        ? `⚡ ${member?.name.split(' ')[0].toUpperCase() ?? cid.toUpperCase()}`
        : member?.name.split(' ')[0] ?? cid;
      const sub = cState.activeActionLabel || 'Bereit';
      const key = `${title}|${sub}|${isDeviation}`;
      if (actor.lastBadgeKey !== key) {
        actor.lastBadgeKey = key;
        const mat = actor.badgeSprite.material as THREE.SpriteMaterial;
        if (mat.map) mat.map.dispose();
        mat.map = createBadgeTexture(
          actor.badgeCanvas,
          title,
          sub,
          actor.accentColor,
          isDeviation
        );
        mat.needsUpdate = true;
      }
    }
  }

  public dispose(): void {
    disposeSceneSubtree(this.root);
  }
}
