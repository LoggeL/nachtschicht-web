import * as THREE from 'three';
import {
  CrewId,
  CrewMember,
  FloorId,
  HeistTarget,
  LiveCrewState,
  Vec2,
} from '../sim/types';
import { assetRegistry, disposeSceneSubtree, ModelKey } from './assetLoader';
import {
  SegmentCollider,
  clamp,
  damp,
  dampAngleRad,
  dist2D,
  headingDegToRotY,
  resolveCircleVsSegment,
  rotYToHeadingDeg,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — Round 2 Photorealistic 3D Character Controller
// Drives skeletal glTF AnimationMixer clips (`Idle`, `Walk`, `Sneak`, `Run`,
// `Interact`, `Work`, `CarryLoot`, `Panic`) with smooth cross-fading on
// `character_mara.glb`, `character_jupp.glb`, and `character_crew.glb`,
// enforces physically solid locked doors, and removes arcade visual clutter.
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

type ClipIntent =
  | 'idle'
  | 'walk'
  | 'sneak'
  | 'run'
  | 'work'
  | 'carry'
  | 'panic'
  | 'hold';

interface CrewActorVisual {
  crewId: CrewId;
  accentColor: string;
  root: THREE.Group;
  model: THREE.Group;
  rig: CharRig;
  mixer: THREE.AnimationMixer | null;
  actions: Map<string, THREE.AnimationAction>;
  activeClipName: string | null;
  progressRing: THREE.Mesh;
  progressMat: THREE.MeshBasicMaterial;
  badgeSprite: THREE.Sprite;
  badgeCanvas: HTMLCanvasElement;
  lastBadgeKey: string;
  pos: Vec2;
  visualPos: Vec2;
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
    ctx.fillStyle = isDeviation ? 'rgba(127, 29, 29, 0.90)' : 'rgba(7, 11, 22, 0.82)';
    ctx.strokeStyle = isDeviation ? '#fb7185' : accentHex;
    ctx.lineWidth = isDeviation ? 3.5 : 2;
    ctx.beginPath();
    ctx.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 10);
    ctx.fill();
    ctx.stroke();

    const maxW = canvas.width - 28;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 20px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = isDeviation ? '#fef08a' : accentHex;
    ctx.fillText(name, canvas.width / 2, 29, maxW);

    ctx.font = '600 15px ui-sans-serif, system-ui, sans-serif';
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(status, canvas.width / 2, 57, maxW);
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

function resolveBestClip(
  actions: Map<string, THREE.AnimationAction>,
  intent: ClipIntent
): string | null {
  if (actions.size === 0) return null;

  const preferences: Record<ClipIntent, string[]> = {
    idle: ['Idle', 'idle'],
    walk: ['Walk', 'PatrolWalk', 'walk'],
    sneak: ['Sneak', 'sneak', 'Walk'],
    run: ['Run', 'Sprint', 'run', 'Walk'],
    work: ['Work', 'Interact', 'work', 'interact', 'Idle'],
    carry: ['CarryLoot', 'Walk', 'Idle'],
    panic: ['Panic', 'Run', 'Sprint', 'Idle'],
    hold: ['Idle', 'Sneak'],
  };

  for (const name of preferences[intent]) {
    if (actions.has(name)) return name;
  }
  // Case-insensitive substring fallback
  const lowerPrefs = preferences[intent].map((p) => p.toLowerCase());
  for (const key of actions.keys()) {
    const lk = key.toLowerCase();
    if (lowerPrefs.some((p) => lk.includes(p))) return key;
  }
  return actions.keys().next().value ?? null;
}

function animateProceduralRig(
  rig: CharRig,
  dt: number,
  timeSec: number,
  walkPhaseRef: { val: number },
  intent: ClipIntent,
  speed: number
): void {
  const basePelvisY = rig.pelvisBaseY;

  if (intent === 'work') {
    const workOsc = Math.sin(timeSec * 11);
    if (rig.pelvis) rig.pelvis.position.y = basePelvisY - 0.16;
    if (rig.torso) rig.torso.rotation.x = 0.34;
    if (rig.armL) rig.armL.rotation.x = -0.95 + workOsc * 0.25;
    if (rig.armR) rig.armR.rotation.x = -0.95 - workOsc * 0.25;
    if (rig.legL) rig.legL.rotation.x = -0.25;
    if (rig.legR) rig.legR.rotation.x = 0.22;
    return;
  }

  if (intent === 'walk' || intent === 'sneak' || intent === 'run' || intent === 'carry') {
    const freq =
      intent === 'run'
        ? 11.2
        : intent === 'sneak'
          ? 5.2
          : intent === 'carry'
            ? 6.4
            : 7.4 + speed * 0.65;
    const amp = intent === 'run' ? 0.68 : intent === 'sneak' ? 0.38 : 0.5;
    walkPhaseRef.val += dt * freq;
    const s = Math.sin(walkPhaseRef.val) * amp;
    if (rig.legL) rig.legL.rotation.x = s;
    if (rig.legR) rig.legR.rotation.x = -s;
    if (rig.armL) rig.armL.rotation.x = -s * (intent === 'carry' ? 0.35 : 0.72);
    if (rig.armR) rig.armR.rotation.x = s * (intent === 'carry' ? 0.35 : 0.72);
    if (rig.torso) {
      rig.torso.rotation.x =
        intent === 'sneak' ? 0.28 : intent === 'run' ? 0.18 : intent === 'carry' ? 0.14 : 0.04;
    }
    if (rig.pelvis) {
      const crouch = intent === 'sneak' ? -0.14 : 0;
      rig.pelvis.position.y = basePelvisY + crouch + Math.abs(Math.sin(walkPhaseRef.val)) * 0.042;
    }
    if (rig.head) rig.head.rotation.y = 0;
    return;
  }

  // Idle / Hold / Panic
  if (rig.legL) rig.legL.rotation.x *= 0.82;
  if (rig.legR) rig.legR.rotation.x *= 0.82;
  if (rig.armL) rig.armL.rotation.x *= 0.82;
  if (rig.armR) rig.armR.rotation.x *= 0.82;
  if (rig.torso) rig.torso.rotation.x *= 0.85;
  if (rig.pelvis) {
    rig.pelvis.position.y = basePelvisY + Math.sin(timeSec * 2.2) * 0.015;
  }
  if (rig.head) {
    rig.head.rotation.y = Math.sin(timeSec * (intent === 'panic' ? 4.8 : intent === 'hold' ? 2.2 : 0.85)) * 0.22;
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
  public maraSprinting = false;
  public maraSpeed = 0;
  public manualExecutionControl = false;

  constructor(target: HeistTarget, crewById: Record<CrewId, CrewMember>) {
    this.target = target;
    this.root.name = 'CharacterController';
    this.maraPos = { x: 0, z: Math.min(target.bounds.maxZ - 2.2, 11.2) };
    this.maraRotY = Math.PI;
    this.ensureActor('mara', crewById.mara);
  }

  private getModelKeyForCrew(crewId: CrewId): ModelKey {
    if (crewId === 'mara') return 'character_mara';
    if (crewId === 'jupp') return 'character_jupp';
    return 'character_crew';
  }

  private ensureActor(crewId: CrewId, member?: CrewMember): CrewActorVisual {
    const existing = this.actors.get(crewId);
    if (existing) return existing;

    const accent = member?.accentColor ?? (crewId === 'mara' ? '#38bdf8' : '#f59e0b');
    const actorRoot = new THREE.Group();
    actorRoot.name = `Crew_${crewId}`;

    const isMara = crewId === 'mara';
    const modelKey = this.getModelKeyForCrew(crewId);
    const needsTint = crewId === 'jule' || crewId === 'toni' || crewId === 'rico';
    const model = assetRegistry.instantiateModel(modelKey, needsTint);

    // Subtle accent tint on generic crew trim/headset LED so Jule/Toni/Rico stay distinct
    // while preserving packed PBR ripstop/skin/hair maps!
    if (needsTint) {
      const tint = new THREE.Color(accent);
      model.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh;
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            if (!(m instanceof THREE.MeshStandardMaterial)) continue;
            if (
              m.name === 'Crew_HoodieTrim_Accent' ||
              m.name.includes('Hoodie') ||
              m.name.includes('Beanie') ||
              m.name.includes('Accent')
            ) {
              m.color.copy(tint);
            } else if (m.name === 'Crew_Headset_LED' || m.name.includes('LED')) {
              m.color.copy(tint);
              m.emissive.copy(tint);
              m.emissiveIntensity = 2.6;
            }
          }
        }
      });
    }

    actorRoot.add(model);

    // Skeletal glTF AnimationMixer setup when clips exist
    const clips = assetRegistry.getAnimationClips(modelKey);
    let mixer: THREE.AnimationMixer | null = null;
    const actions = new Map<string, THREE.AnimationAction>();
    if (clips.length > 0) {
      mixer = new THREE.AnimationMixer(model);
      for (const clip of clips) {
        const action = mixer.clipAction(clip);
        action.enabled = true;
        actions.set(clip.name, action);
      }
    }

    // Subtle diegetic action progress ring (invisible unless actively working/scanning!)
    const progGeo = new THREE.RingGeometry(0.55, 0.66, 32);
    progGeo.rotateX(-Math.PI / 2);
    const progressMat = new THREE.MeshBasicMaterial({
      color: 0x38bdf8,
      transparent: true,
      opacity: 0.0,
      side: THREE.DoubleSide,
    });
    const progressRing = new THREE.Mesh(progGeo, progressMat);
    progressRing.position.y = 0.05;
    progressRing.userData.excludeFromAO = true;
    actorRoot.add(progressRing);

    // Sleek compact nameplate/callout (hidden by default; shown on deviation, sync-wait, or binoculars!)
    const badgeCanvas = document.createElement('canvas');
    badgeCanvas.width = 340;
    badgeCanvas.height = 84;
    const badgeSprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ transparent: true, depthTest: true })
    );
    badgeSprite.position.set(0, 2.24, 0);
    badgeSprite.scale.set(1.55, 0.39, 1);
    badgeSprite.renderOrder = 16;
    badgeSprite.visible = false;
    badgeSprite.userData.excludeFromAO = true;
    actorRoot.add(badgeSprite);

    this.root.add(actorRoot);
    const actor: CrewActorVisual = {
      crewId,
      accentColor: accent,
      root: actorRoot,
      model,
      rig: extractRig(model),
      mixer,
      actions,
      activeClipName: null,
      progressRing,
      progressMat,
      badgeSprite,
      badgeCanvas,
      lastBadgeKey: '',
      pos: { ...this.maraPos },
      visualPos: { ...this.maraPos },
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
    this.maraSprinting = false;
    this.maraSpeed = 0;
    this.maraPos = {
      x: 0,
      z: Math.min(this.target.bounds.maxZ - 1.8, 11.5),
    };
    this.maraRotY = Math.PI;
    const mara = this.actors.get('mara');
    if (mara) {
      mara.visualPos = { ...this.maraPos };
    }
  }

  public resetForExecuting(): void {
    this.manualExecutionControl = false;
    this.maraFloor = 0;
    this.maraSneaking = false;
    this.maraSprinting = false;
    this.maraSpeed = 0;
    this.maraPos = { ...this.target.getawayPos };
    this.maraRotY = headingDegToRotY(this.target.getawayHeadingDeg);
    const mara = this.actors.get('mara');
    if (mara) {
      mara.visualPos = { ...this.maraPos };
    }
  }

  /**
   * Moves Mara via WASD relative to camera yaw with physically solid wall &
   * locked-door collision! Only unlocked doors allow passage through doorways.
   */
  public moveMaraByInput(params: {
    dt: number;
    forwardInput: number;
    rightInput: number;
    sneaking: boolean;
    sprinting?: boolean;
    carryingWeight?: number; // 0..1 slows movement slightly
    cameraYawRad: number;
    wallColliders: SegmentCollider[];
    unlockedDoorPositions: Vec2[];
    lockedDoorPositions: Vec2[];
  }): boolean {
    const {
      dt,
      forwardInput,
      rightInput,
      sneaking,
      sprinting = false,
      carryingWeight = 0,
      cameraYawRad,
      wallColliders,
      unlockedDoorPositions,
      lockedDoorPositions,
    } = params;

    this.maraSneaking = sneaking;
    this.maraSprinting = sprinting && !sneaking;
    const mag = Math.hypot(forwardInput, rightInput);
    if (mag < 0.05) {
      this.maraSpeed = 0;
      return false;
    }

    const nf = forwardInput / mag;
    const nr = rightInput / mag;

    const fwdX = -Math.sin(cameraYawRad);
    const fwdZ = -Math.cos(cameraYawRad);
    const rightX = Math.cos(cameraYawRad);
    const rightZ = -Math.sin(cameraYawRad);

    const moveX = fwdX * nf + rightX * nr;
    const moveZ = fwdZ * nf + rightZ * nr;
    const weightPenalty = 1 - clamp(carryingWeight, 0, 1) * 0.25;
    const baseSpeed = sneaking ? 2.25 : this.maraSprinting ? 5.8 : 4.2;
    const speed = baseSpeed * weightPenalty;
    this.maraSpeed = speed;

    this.maraPos.x += moveX * speed * dt;
    this.maraPos.z += moveZ * speed * dt;

    // Clamp to playable city block around the target
    const b = this.target.bounds;
    this.maraPos.x = clamp(this.maraPos.x, b.minX - 10, b.maxX + 10);
    this.maraPos.z = clamp(this.maraPos.z, b.minZ - 8, b.maxZ + 12);

    // Physically solid walls — ONLY pass doorway gaps if door is actually UNLOCKED!
    const nearUnlockedDoor = unlockedDoorPositions.some(
      (dp) => dist2D(dp.x, dp.z, this.maraPos.x, this.maraPos.z) < 1.35
    );
    if (!nearUnlockedDoor) {
      for (const w of wallColliders) {
        if (w.floor !== this.maraFloor) continue;
        resolveCircleVsSegment(
          this.maraPos,
          0.36,
          w.x1,
          w.z1,
          w.x2,
          w.z2,
          w.thickness * 0.5
        );
      }
    }

    // Closed / locked doors are solid physical blockers across doorway openings!
    for (const ld of lockedDoorPositions) {
      const dx = this.maraPos.x - ld.x;
      const dz = this.maraPos.z - ld.z;
      const d = Math.hypot(dx, dz);
      const minDist = 1.05;
      if (d < minDist) {
        if (d > 1e-4) {
          this.maraPos.x = ld.x + (dx / d) * minDist;
          this.maraPos.z = ld.z + (dz / d) * minDist;
        } else {
          this.maraPos.z += minDist;
        }
      }
    }

    const desiredRotY = Math.atan2(moveX, moveZ);
    this.maraRotY = dampAngleRad(this.maraRotY, desiredRotY, 13, dt);
    return true;
  }

  public getMaraHeadingDeg(): number {
    return rotYToHeadingDeg(this.maraRotY);
  }

  private driveActorAnimation(
    actor: CrewActorVisual,
    intent: ClipIntent,
    dt: number,
    timeSec: number,
    speed: number
  ): void {
    if (actor.mixer && actor.actions.size > 0) {
      const desiredName = resolveBestClip(actor.actions, intent);
      if (desiredName && desiredName !== actor.activeClipName) {
        const nextAction = actor.actions.get(desiredName)!;
        nextAction.reset();
        nextAction.setEffectiveWeight(1);
        nextAction.play();
        if (actor.activeClipName) {
          const prevAction = actor.actions.get(actor.activeClipName);
          if (prevAction && prevAction !== nextAction) {
            prevAction.crossFadeTo(nextAction, 0.22, false);
          }
        }
        actor.activeClipName = desiredName;
      }
      // Match playback speed naturally to stride velocity
      const activeAction = actor.activeClipName
        ? actor.actions.get(actor.activeClipName)
        : undefined;
      if (activeAction) {
        if (intent === 'walk' || intent === 'carry') {
          activeAction.setEffectiveTimeScale(clamp(speed / 2.6, 0.7, 1.4));
        } else if (intent === 'run') {
          activeAction.setEffectiveTimeScale(clamp(speed / 3.8, 0.9, 1.5));
        } else {
          activeAction.setEffectiveTimeScale(1.0);
        }
      }
      actor.mixer.update(dt);
    } else {
      const phaseRef = { val: actor.walkPhase };
      animateProceduralRig(actor.rig, dt, timeSec, phaseRef, intent, speed);
      actor.walkPhase = phaseRef.val;
    }
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
    binocularsActive?: boolean;
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
      binocularsActive = false,
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
        actor.visualPos.x = damp(actor.visualPos.x, actor.pos.x, 18, dt);
        actor.visualPos.z = damp(actor.visualPos.z, actor.pos.z, 18, dt);
        actor.floor = this.maraFloor;
        actor.rotY = this.maraRotY;

        actor.root.position.set(
          actor.visualPos.x,
          actor.floor * this.target.floorHeightM,
          actor.visualPos.z
        );
        actor.root.rotation.y = actor.rotY;

        const progress = Math.max(
          maraScanProgress,
          maraInteractProgress,
          !this.manualExecutionControl && maraLive?.state === 'working'
            ? maraLive.blockProgress
            : 0
        );
        const intent: ClipIntent =
          progress > 0.02
            ? 'work'
            : this.maraSpeed > 0.15
              ? this.maraSneaking
                ? 'sneak'
                : this.maraSprinting || this.maraSpeed > 4.8
                  ? 'run'
                  : 'walk'
              : 'idle';

        this.driveActorAnimation(actor, intent, dt, timeSec, this.maraSpeed);

        actor.progressMat.opacity = progress > 0.01 ? 0.78 : 0;
        actor.progressMat.color.setHex(phase === 'scouting' ? 0x2dd4bf : 0x38bdf8);
        const pScale = 0.78 + progress * 0.45;
        actor.progressRing.scale.set(pScale, pScale, 1);
        actor.progressRing.rotation.z = timeSec * 3.0;
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

      const jumpDist = dist2D(actor.visualPos.x, actor.visualPos.z, cState.pos.x, cState.pos.z);
      if (jumpDist > 4.5 || actor.floor !== cState.floor) {
        actor.visualPos.x = cState.pos.x;
        actor.visualPos.z = cState.pos.z;
      } else {
        actor.visualPos.x = damp(actor.visualPos.x, cState.pos.x, 12, dt);
        actor.visualPos.z = damp(actor.visualPos.z, cState.pos.z, 12, dt);
      }
      actor.pos.x = cState.pos.x;
      actor.pos.z = cState.pos.z;
      actor.floor = cState.floor;
      actor.rotY = dampAngleRad(actor.rotY, headingDegToRotY(cState.headingDeg), 10, dt);

      actor.root.position.set(
        actor.visualPos.x,
        actor.floor * this.target.floorHeightM,
        actor.visualPos.z
      );
      actor.root.rotation.y = actor.rotY;

      const isCarrying = cState.carryingLootEur > 0;
      const isDeviation =
        cState.deviationActive !== null && cState.deviationActive !== 'nerves_improvise';
      const isPanicking =
        cState.deviationActive === 'panic_noise' || cState.deviationActive === 'panic_abort';

      const intent: ClipIntent =
        cState.state === 'working'
          ? 'work'
          : isPanicking
            ? 'panic'
            : cState.state === 'fleeing'
              ? 'run'
              : cState.state === 'moving' || cState.state === 'deviating'
                ? cState.sneaking
                  ? 'sneak'
                  : isCarrying
                    ? 'carry'
                    : 'walk'
                : cState.state === 'holding' || cState.state === 'waiting_sync'
                  ? 'hold'
                  : 'idle';

      this.driveActorAnimation(actor, intent, dt, timeSec, cState.speed);

      const isWorking = cState.state === 'working' || cState.state === 'deviating';
      actor.progressMat.opacity = isWorking ? 0.68 : isDeviation ? 0.55 : 0;
      actor.progressMat.color.set(isDeviation ? '#fb7185' : actor.accentColor);
      const pScale = 0.8 + cState.blockProgress * 0.42;
      actor.progressRing.scale.set(pScale, pScale, 1);

      // Show sleek crew badge ONLY when deviating, waiting for sync, working nearby, or binoculars
      const distToMara = dist2D(this.maraPos.x, this.maraPos.z, actor.pos.x, actor.pos.z);
      const showBadge =
        floorVisible &&
        (isDeviation ||
          cState.state === 'waiting_sync' ||
          binocularsActive ||
          (isWorking && distToMara < 9.0));
      actor.badgeSprite.visible = showBadge;
      if (showBadge) {
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
  }

  public dispose(): void {
    for (const actor of this.actors.values()) {
      actor.mixer?.stopAllAction();
    }
    this.actors.clear();
    disposeSceneSubtree(this.root);
  }
}
