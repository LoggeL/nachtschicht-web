import * as THREE from 'three';
import { EscapeState, HeistTarget, Vec2 } from '../sim/types';
import { assetRegistry, disposeSceneSubtree } from './assetLoader';
import { AudioEngine } from './audioEngine';
import {
  AabbCollider,
  clamp,
  dampAngleRad,
  dist2D,
  headingDegToRotY,
  resolveCircleVsAabb,
} from './mathUtils';

// ============================================================================
// NACHTSCHICHT — 3D Vehicle Controller (Getaway Coupe + Catalan Police Chase)
// Responsive arcade driving, handbrake drift, spinning/steering wheels,
// headlights/taillights, flashing police lightbars & pursuit AI.
// ============================================================================

interface CarVisual {
  root: THREE.Group;
  model: THREE.Group;
  wheelFL?: THREE.Object3D;
  wheelFR?: THREE.Object3D;
  wheelRL?: THREE.Object3D;
  wheelRR?: THREE.Object3D;
  taillightsMat?: THREE.MeshStandardMaterial;
  lightbarBlue?: THREE.Mesh;
  lightbarRed?: THREE.Mesh;
  sirenLight?: THREE.PointLight;
}

interface PoliceUnit {
  visual: CarVisual;
  pos: Vec2;
  rotY: number;
  speed: number;
  wheelSpin: number;
  steerAngle: number;
  flashPhase: number;
}

interface DriftSmokePuff {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  vx: number;
  vz: number;
  age: number;
  maxAge: number;
}

export interface EscapeTickResult {
  patch: Partial<EscapeState>;
  finished?: 'escaped' | 'busted';
}

function attachWheelsAndMaterials(model: THREE.Group): Omit<CarVisual, 'root' | 'model'> {
  const wheelFL = model.getObjectByName('Wheel_FL');
  const wheelFR = model.getObjectByName('Wheel_FR');
  const wheelRL = model.getObjectByName('Wheel_RL');
  const wheelRR = model.getObjectByName('Wheel_RR');

  for (const w of [wheelFL, wheelFR, wheelRL, wheelRR]) {
    if (w) w.rotation.order = 'YXZ';
  }

  let taillightsMat: THREE.MeshStandardMaterial | undefined;
  const tl = model.getObjectByName('Taillights') as THREE.Mesh | undefined;
  if (tl && tl.material instanceof THREE.MeshStandardMaterial) {
    taillightsMat = tl.material;
  }

  const lightbarBlue = model.getObjectByName('Lightbar_Blue') as THREE.Mesh | undefined;
  const lightbarRed = model.getObjectByName('Lightbar_Red') as THREE.Mesh | undefined;

  return {
    wheelFL,
    wheelFR,
    wheelRL,
    wheelRR,
    taillightsMat,
    lightbarBlue,
    lightbarRed,
  };
}

export class VehicleController {
  public readonly root = new THREE.Group();
  private target: HeistTarget;
  private safehousePos: Vec2;
  private getawayVisual: CarVisual;
  private headlightBeamGroup: THREE.Group;
  private headlightLight: THREE.PointLight;
  private navArrow: THREE.Group;

  private policeUnits: PoliceUnit[] = [];
  private smokePuffs: DriftSmokePuff[] = [];
  private smokeGeo = new THREE.SphereGeometry(0.32, 7, 6);
  private smokeTimer = 0;

  // Player vehicle physics state
  public carPos: Vec2;
  public carRotY: number;
  public vx = 0;
  public vz = 0;
  public speedKmh = 0;
  public steerAngle = 0;
  public wheelSpin = 0;
  public drifting = false;

  // Pursuit state
  private escapeElapsed = 0;
  private pursuitHeat = 45;
  private clearSightTimer = 0;
  private carDamage = 0;
  private vehicleRecognized = false;
  private spottedNearTimer = 0;
  private pinnedTimer = 0;
  private initialDistanceM = 280;

  constructor(target: HeistTarget, safehousePos: Vec2) {
    this.target = target;
    this.safehousePos = { ...safehousePos };
    this.root.name = 'VehicleController';

    this.carPos = { ...target.getawayPos };
    this.carRotY = headingDegToRotY(target.getawayHeadingDeg);

    // 1) Build Getaway Coupe
    const getawayRoot = new THREE.Group();
    getawayRoot.name = 'GetawayCar';
    const model = assetRegistry.instantiateModel('getaway_car', true);
    getawayRoot.add(model);

    // Volumetric warm headlight beams on asphalt
    const beamGroup = new THREE.Group();
    const beamGeo = new THREE.ConeGeometry(2.1, 13.5, 14, 1, true);
    beamGeo.translate(0, -6.75, 0);
    beamGeo.rotateX(-Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff3c4,
      transparent: true,
      opacity: 0.14,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const beamL = new THREE.Mesh(beamGeo, beamMat);
    beamL.position.set(0.68, 0.56, 2.2);
    beamL.rotation.x = 0.08;
    beamGroup.add(beamL);

    const beamR = new THREE.Mesh(beamGeo, beamMat);
    beamR.position.set(-0.68, 0.56, 2.2);
    beamR.rotation.x = 0.08;
    beamGroup.add(beamR);
    getawayRoot.add(beamGroup);
    this.headlightBeamGroup = beamGroup;

    // Real dynamic headlight PointLight projected ahead of hood
    const hlLight = new THREE.PointLight(0xffe9a8, 18, 28, 1.5);
    hlLight.position.set(0, 1.0, 5.2);
    getawayRoot.add(hlLight);
    this.headlightLight = hlLight;

    // Floating directional chevron guiding toward La Pineda Safehouse
    const navArrow = new THREE.Group();
    navArrow.position.set(0, 2.65, 0);
    const chevronMat = new THREE.MeshBasicMaterial({
      color: 0x2dd4bf,
      transparent: true,
      opacity: 0.88,
    });
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.15, 4), chevronMat);
    tip.rotation.x = Math.PI / 2;
    tip.position.z = 0.35;
    navArrow.add(tip);
    const shaft = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.14, 0.8), chevronMat);
    shaft.position.z = -0.35;
    navArrow.add(shaft);
    navArrow.visible = false;
    getawayRoot.add(navArrow);
    this.navArrow = navArrow;

    getawayRoot.position.set(this.carPos.x, 0, this.carPos.z);
    getawayRoot.rotation.y = this.carRotY;
    this.root.add(getawayRoot);

    this.getawayVisual = {
      root: getawayRoot,
      model,
      ...attachWheelsAndMaterials(model),
    };

    // 2) Build 3 Catalan Mossos Patrol Cruisers (hidden until Escape phase)
    const policeSpawns: Array<{ x: number; z: number; rotY: number }> = [
      { x: 52, z: 18, rotY: -Math.PI / 2 },
      { x: -46, z: 18, rotY: Math.PI / 2 },
      { x: 128, z: -58, rotY: Math.PI },
    ];

    policeSpawns.forEach((sp, idx) => {
      const pRoot = new THREE.Group();
      pRoot.name = `PoliceCar_${idx}`;
      const pModel = assetRegistry.instantiateModel('police_car', true);
      pRoot.add(pModel);

      const sirenLight = new THREE.PointLight(0x3b82f6, 26, 26, 1.45);
      sirenLight.position.set(0, 2.3, 0);
      pRoot.add(sirenLight);

      pRoot.position.set(sp.x, 0, sp.z);
      pRoot.rotation.y = sp.rotY;
      pRoot.visible = false;
      this.root.add(pRoot);

      this.policeUnits.push({
        visual: {
          root: pRoot,
          model: pModel,
          sirenLight,
          ...attachWheelsAndMaterials(pModel),
        },
        pos: { x: sp.x, z: sp.z },
        rotY: sp.rotY,
        speed: 0,
        wheelSpin: 0,
        steerAngle: 0,
        flashPhase: idx * 2.1,
      });
    });
  }

  public resetParked(): void {
    this.carPos = { ...this.target.getawayPos };
    this.carRotY = headingDegToRotY(this.target.getawayHeadingDeg);
    this.vx = 0;
    this.vz = 0;
    this.speedKmh = 0;
    this.steerAngle = 0;
    this.drifting = false;

    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.set(0, this.carRotY, 0);
    this.navArrow.visible = false;
    this.headlightLight.intensity = 10;

    for (const pu of this.policeUnits) {
      pu.visual.root.visible = false;
    }
  }

  public startEscape(initialHeat: number): void {
    // Launch smoothly from street avenue right outside target
    this.carPos = {
      x: this.target.getawayPos.x,
      z: Math.max(this.target.getawayPos.z, 15.5),
    };
    this.carRotY = Math.PI / 2; // Facing East along main avenue toward coastal route
    this.vx = 6;
    this.vz = 0;
    this.speedKmh = 22;
    this.steerAngle = 0;
    this.drifting = false;

    this.escapeElapsed = 0;
    this.pursuitHeat = clamp(initialHeat, 20, 95);
    this.clearSightTimer = 0;
    this.carDamage = 0;
    this.vehicleRecognized = initialHeat >= 80;
    this.spottedNearTimer = 0;
    this.pinnedTimer = 0;
    this.initialDistanceM = Math.max(
      1,
      dist2D(this.carPos.x, this.carPos.z, this.safehousePos.x, this.safehousePos.z)
    );

    this.navArrow.visible = true;
    this.headlightLight.intensity = 22;

    // Position Mossos cruisers dynamically around the avenue
    const spawns: Array<{ x: number; z: number; rotY: number }> = [
      { x: -38, z: 18, rotY: Math.PI / 2 },
      { x: 52, z: -48, rotY: 0 },
      { x: 128, z: -58, rotY: Math.PI },
    ];
    this.policeUnits.forEach((pu, i) => {
      const sp = spawns[i % spawns.length];
      pu.pos = { x: sp.x, z: sp.z };
      pu.rotY = sp.rotY;
      pu.speed = 11;
      pu.visual.root.position.set(sp.x, 0, sp.z);
      pu.visual.root.rotation.y = sp.rotY;
      pu.visual.root.visible = i < 2 || initialHeat >= 60;
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
    this.pursuitHeat = Math.min(this.pursuitHeat, 30);
    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.y = this.carRotY;
  }

  public updateIdle(timeSec: number): void {
    // Subtle idle engine headlight shimmer when parked
    this.headlightBeamGroup.visible = true;
    this.headlightLight.intensity = 10 + Math.sin(timeSec * 3.1) * 0.8;
  }

  public updateEscape(params: {
    dt: number;
    timeSec: number;
    throttle: number; // +1 W, -1 S
    steer: number; // +1 Left (A), -1 Right (D)
    handbrake: boolean;
    cityBoxColliders: AabbCollider[];
    audio: AudioEngine;
  }): EscapeTickResult {
    const { dt, timeSec, throttle, steer, handbrake, cityBoxColliders, audio } = params;
    this.escapeElapsed += dt;
    this.drifting = handbrake;

    // 1) Forward & Right basis vectors of getaway coupe (+Z forward)
    const fwdX = Math.sin(this.carRotY);
    const fwdZ = Math.cos(this.carRotY);
    const rightX = Math.cos(this.carRotY);
    const rightZ = -Math.sin(this.carRotY);

    let forwardSpeed = this.vx * fwdX + this.vz * fwdZ;
    let lateralSpeed = this.vx * rightX + this.vz * rightZ;

    // Arcade acceleration & braking
    const maxForward = 36.5; // ~131 km/h
    const maxReverse = -13.0;
    if (throttle > 0.05) {
      forwardSpeed += 25.5 * throttle * dt;
    } else if (throttle < -0.05) {
      if (forwardSpeed > 2) {
        forwardSpeed -= 38.0 * Math.abs(throttle) * dt;
      } else {
        forwardSpeed += 16.0 * throttle * dt;
      }
    } else {
      // Natural coasting drag
      forwardSpeed *= Math.exp(-1.15 * dt);
    }

    if (handbrake) {
      forwardSpeed *= Math.exp(-1.6 * dt);
    }

    forwardSpeed = clamp(forwardSpeed, maxReverse, maxForward);

    // Steering response
    const targetSteer = steer * 0.44;
    this.steerAngle += (targetSteer - this.steerAngle) * Math.min(1, dt * 11);

    const speedFactor = clamp(Math.abs(forwardSpeed) / 7.5, 0, 1);
    const reverseSign = forwardSpeed >= -0.2 ? 1 : -1;
    const yawRate = (handbrake ? 2.85 : 2.15) * steer * speedFactor * reverseSign;
    this.carRotY += yawRate * dt;

    // Recompute basis after turn and apply lateral grip (drifting when handbrake!)
    const nFwdX = Math.sin(this.carRotY);
    const nFwdZ = Math.cos(this.carRotY);
    const nRightX = Math.cos(this.carRotY);
    const nRightZ = -Math.sin(this.carRotY);

    const lateralGrip = handbrake ? 2.1 : 9.4;
    lateralSpeed *= Math.exp(-lateralGrip * dt);
    if (handbrake && Math.abs(steer) > 0.1 && Math.abs(forwardSpeed) > 6) {
      lateralSpeed -= steer * 5.2 * dt;
    }

    this.vx = nFwdX * forwardSpeed + nRightX * lateralSpeed;
    this.vz = nFwdZ * forwardSpeed + nRightZ * lateralSpeed;

    this.carPos.x += this.vx * dt;
    this.carPos.z += this.vz * dt;

    // World outer drivable bounds
    if (this.carPos.x < -112) {
      this.carPos.x = -112;
      this.vx = Math.abs(this.vx) * 0.35;
    } else if (this.carPos.x > 210) {
      this.carPos.x = 210;
      this.vx = -Math.abs(this.vx) * 0.35;
    }
    if (this.carPos.z < -184) {
      this.carPos.z = -184;
      this.vz = Math.abs(this.vz) * 0.35;
    } else if (this.carPos.z > 25.5) {
      this.carPos.z = 25.5;
      this.vz = -Math.abs(this.vz) * 0.35;
    }

    // Building collisions (smooth slide + soft bounce)
    for (const box of cityBoxColliders) {
      const hit = resolveCircleVsAabb(this.carPos, 1.85, box);
      if (hit.hit) {
        const vn = this.vx * hit.nx + this.vz * hit.nz;
        if (vn < 0) {
          const impactSpeed = Math.abs(vn);
          this.vx -= (1.28) * vn * hit.nx;
          this.vz -= (1.28) * vn * hit.nz;
          // Tangential friction
          this.vx *= 0.88;
          this.vz *= 0.88;
          if (impactSpeed > 7) {
            this.carDamage = Math.min(100, this.carDamage + Math.round(impactSpeed * 0.65));
            audio.playImpact(clamp(impactSpeed / 26, 0.25, 1));
          }
        }
      }
    }

    this.speedKmh = Math.round(Math.hypot(this.vx, this.vz) * 3.6);

    // Update getaway car visual transform & subtle suspension body roll
    this.getawayVisual.root.position.set(this.carPos.x, 0, this.carPos.z);
    this.getawayVisual.root.rotation.y = this.carRotY;
    const roll = clamp(lateralSpeed * 0.015 + steer * speedFactor * 0.04, -0.1, 0.1);
    const pitch = clamp(-throttle * 0.025, -0.04, 0.04);
    this.getawayVisual.model.rotation.z = roll;
    this.getawayVisual.model.rotation.x = pitch;

    // Spin & steer wheels
    this.wheelSpin += (forwardSpeed / 0.34) * dt;
    this.animateCarWheels(this.getawayVisual, this.wheelSpin, this.steerAngle);

    // Brighten brake taillights when braking/handbraking
    if (this.getawayVisual.taillightsMat) {
      const braking = throttle < -0.1 || handbrake;
      this.getawayVisual.taillightsMat.emissiveIntensity = braking ? 4.2 : 1.5;
    }

    // Point floating safehouse compass chevron toward La Pineda Safehouse
    const toSafeX = this.safehousePos.x - this.carPos.x;
    const toSafeZ = this.safehousePos.z - this.carPos.z;
    const worldAngleToSafe = Math.atan2(toSafeX, toSafeZ);
    this.navArrow.rotation.y = worldAngleToSafe - this.carRotY;
    this.navArrow.position.y = 2.65 + Math.sin(timeSec * 5) * 0.14;

    // Spawn subtle drift smoke puffs
    this.smokeTimer -= dt;
    if ((handbrake || Math.abs(lateralSpeed) > 4.5) && this.speedKmh > 25 && this.smokeTimer <= 0) {
      this.smokeTimer = 0.055;
      this.spawnDriftSmoke(
        this.carPos.x - nFwdX * 1.55,
        this.carPos.z - nFwdZ * 1.55,
        -this.vx * 0.12,
        -this.vz * 0.12
      );
    }
    this.updateDriftSmoke(dt);

    // 2) Update Pursuing Catalan Police Cruisers
    let nearestPoliceDist = 999;
    for (const pu of this.policeUnits) {
      if (!pu.visual.root.visible) continue;

      const dx = this.carPos.x - pu.pos.x;
      const dz = this.carPos.z - pu.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist < nearestPoliceDist) nearestPoliceDist = dist;

      // Steer toward getaway car with basic block avoidance
      let desiredAngle = Math.atan2(dx, dz);
      const probeX = pu.pos.x + Math.sin(pu.rotY) * 6.5;
      const probeZ = pu.pos.z + Math.cos(pu.rotY) * 6.5;
      for (const box of cityBoxColliders) {
        if (
          probeX > box.minX - 2 &&
          probeX < box.maxX + 2 &&
          probeZ > box.minZ - 2 &&
          probeZ < box.maxZ + 2
        ) {
          desiredAngle += 0.9;
          break;
        }
      }

      const prevRot = pu.rotY;
      pu.rotY = dampAngleRad(pu.rotY, desiredAngle, 3.2, dt);
      pu.steerAngle = clamp((pu.rotY - prevRot) * 14, -0.42, 0.42);

      // Catch-up rubber-banding balanced so skilled driving can shake them!
      const targetSpeed = dist > 50 ? 29.0 : dist > 14 ? 26.2 : 21.5;
      pu.speed += (targetSpeed - pu.speed) * Math.min(1, dt * 2.5);
      pu.pos.x += Math.sin(pu.rotY) * pu.speed * dt;
      pu.pos.z += Math.cos(pu.rotY) * pu.speed * dt;

      for (const box of cityBoxColliders) {
        const hit = resolveCircleVsAabb(pu.pos, 1.85, box);
        if (hit.hit) {
          pu.speed *= 0.65;
          pu.rotY += 0.35;
        }
      }

      // Soft bump with player car
      const pDist = dist2D(this.carPos.x, this.carPos.z, pu.pos.x, pu.pos.z);
      if (pDist < 3.6 && pDist > 0.01) {
        const nx = (this.carPos.x - pu.pos.x) / pDist;
        const nz = (this.carPos.z - pu.pos.z) / pDist;
        const push = (3.6 - pDist) * 0.5;
        this.carPos.x += nx * push;
        this.carPos.z += nz * push;
        pu.pos.x -= nx * push;
        pu.pos.z -= nz * push;
        this.vx += nx * 4.5;
        this.vz += nz * 4.5;
        this.carDamage = Math.min(100, this.carDamage + 2);
        audio.playImpact(0.5);
      }

      pu.wheelSpin += (pu.speed / 0.35) * dt;
      pu.visual.root.position.set(pu.pos.x, 0, pu.pos.z);
      pu.visual.root.rotation.y = pu.rotY;
      this.animateCarWheels(pu.visual, pu.wheelSpin, pu.steerAngle);

      // Alternating red/blue flashing lightbar!
      pu.flashPhase += dt * 11;
      const blueOn = Math.sin(pu.flashPhase) >= 0;
      if (
        pu.visual.lightbarBlue &&
        pu.visual.lightbarBlue.material instanceof THREE.MeshStandardMaterial
      ) {
        pu.visual.lightbarBlue.material.emissiveIntensity = blueOn ? 5.2 : 0.25;
      }
      if (
        pu.visual.lightbarRed &&
        pu.visual.lightbarRed.material instanceof THREE.MeshStandardMaterial
      ) {
        pu.visual.lightbarRed.material.emissiveIntensity = blueOn ? 0.25 : 5.2;
      }
      if (pu.visual.sirenLight) {
        pu.visual.sirenLight.color.setHex(blueOn ? 0x2563eb : 0xef4444);
        pu.visual.sirenLight.intensity = 28;
      }
    }

    // 3) Pursuit Heat, Line-of-Sight Timer & Audio
    const policeSpotted = nearestPoliceDist < 46;
    if (policeSpotted) {
      this.pursuitHeat = Math.min(100, this.pursuitHeat + dt * 4.5);
      this.clearSightTimer = Math.max(0, this.clearSightTimer - dt * 2.5);
      if (nearestPoliceDist < 17) {
        this.spottedNearTimer += dt;
        if (this.spottedNearTimer > 3.0) {
          this.vehicleRecognized = true;
        }
      }
    } else {
      this.clearSightTimer += dt;
      this.pursuitHeat = Math.max(0, this.pursuitHeat - dt * 11.0);
    }

    if (nearestPoliceDist < 5.2 && this.speedKmh < 7) {
      this.pinnedTimer += dt;
    } else {
      this.pinnedTimer = Math.max(0, this.pinnedTimer - dt * 2);
    }

    audio.updateEngine(this.speedKmh, handbrake || Math.abs(lateralSpeed) > 4.5, true);
    const sirenProx = clamp(1 - nearestPoliceDist / 85, 0, 1);
    audio.updatePoliceSiren(sirenProx, true, dt);

    // Distance to La Pineda Safehouse (scaled cleanly to target's reported escape meters)
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

    const patch: Partial<EscapeState> = {
      elapsedSec: Math.round(this.escapeElapsed * 10) / 10,
      speedKmh: this.speedKmh,
      pursuitHeat: Math.round(this.pursuitHeat),
      policeSpotted,
      clearSightTimerSec: Math.round(this.clearSightTimer * 10) / 10,
      distanceToSafehouseM: rawDistToSafe < 13 ? 0 : scaledDistM,
      carDamage: Math.round(this.carDamage),
      vehicleRecognized: this.vehicleRecognized,
    };

    // Extraction check: reached La Pineda Safehouse garage!
    if (rawDistToSafe < 13.0) {
      return { patch, finished: 'escaped' };
    }

    // Busted check
    if (this.carDamage >= 100 || this.pinnedTimer >= 5.0) {
      return { patch, finished: 'busted' };
    }

    return { patch };
  }

  private animateCarWheels(v: CarVisual, spin: number, steer: number): void {
    if (v.wheelFL) {
      v.wheelFL.rotation.y = steer;
      v.wheelFL.rotation.x = spin;
    }
    if (v.wheelFR) {
      v.wheelFR.rotation.y = steer;
      v.wheelFR.rotation.x = spin;
    }
    if (v.wheelRL) v.wheelRL.rotation.x = spin;
    if (v.wheelRR) v.wheelRR.rotation.x = spin;
  }

  private spawnDriftSmoke(x: number, z: number, vx: number, vz: number): void {
    if (this.smokePuffs.length > 28) return;
    const mat = new THREE.MeshBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.36,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(this.smokeGeo, mat);
    mesh.position.set(x + (Math.random() - 0.5) * 0.7, 0.28, z + (Math.random() - 0.5) * 0.7);
    this.root.add(mesh);
    this.smokePuffs.push({ mesh, mat, vx, vz, age: 0, maxAge: 0.55 });
  }

  private updateDriftSmoke(dt: number): void {
    for (let i = this.smokePuffs.length - 1; i >= 0; i--) {
      const p = this.smokePuffs[i];
      p.age += dt;
      if (p.age >= p.maxAge) {
        this.root.remove(p.mesh);
        p.mat.dispose();
        this.smokePuffs.splice(i, 1);
        continue;
      }
      const u = p.age / p.maxAge;
      p.mesh.position.x += p.vx * dt;
      p.mesh.position.z += p.vz * dt;
      p.mesh.position.y += dt * 0.85;
      p.mesh.scale.setScalar(1 + u * 2.1);
      p.mat.opacity = 0.36 * (1 - u);
    }
  }

  public dispose(): void {
    this.smokeGeo.dispose();
    for (const p of this.smokePuffs) {
      p.mat.dispose();
    }
    this.smokePuffs = [];
    disposeSceneSubtree(this.root);
  }
}
