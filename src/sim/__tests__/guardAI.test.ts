import { describe, expect, it } from 'vitest';
import { TARGETS } from '../data';
import {
  BASE_RADIO_DISPATCH_SEC,
  GuardTargetActor,
  GuardWorldContext,
  JAMMER_RADIO_DISPATCH_SEC,
  computeRoomLightLevels,
  computeWallClippedVisionFan,
  createGuardStatesForTarget,
  evaluateGuardVision,
  interruptGuardRadio,
  raycastSolidWalls,
  stepGuardsAI,
} from '../guardAI';
import { LiveGuardState, NoisePulse } from '../types';

function makeActor(overrides: Partial<GuardTargetActor> = {}): GuardTargetActor {
  return {
    crewId: 'mara',
    name: 'Mara Voss',
    pos: { x: 4, z: 3 },
    floor: 0,
    speed: 2.2,
    sneaking: false,
    carryingLootEur: 0,
    doingOvertCrime: false,
    wearingMask: false,
    wearingDisguise: false,
    darkClothing: false,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<GuardWorldContext> = {}): GuardWorldContext {
  const target = TARGETS.casa_oro;
  const powerDisabled = overrides.powerDisabled ?? false;
  return {
    target,
    elapsedSec: 10,
    powerDisabled,
    alarmLevel: 'silent',
    unlockedDoorIds: [],
    openedContainerIds: [],
    brokenGlassNodes: [],
    powerCutRooms: [],
    roomLightLevels: computeRoomLightLevels(target, powerDisabled),
    noiseEvents: [],
    teamHasJammer: false,
    isScoutingPhase: false,
    ...overrides,
  };
}

describe('Realistic Multi-State Guard Stealth AI (src/sim/guardAI.ts)', () => {
  it('NEVER sees through solid brick/interior walls, while allowing sight through glass storefront windows', () => {
    const target = TARGETS.casa_oro;
    const guardDef = target.guards.find((g) => g.id === 'co_guard_interior')!;
    // Place interior guard in shop (x: 4, z: 1) looking North (heading 270 = -Z) toward backroom
    // Interior solid wall co_w8 runs along z = -2 from x = 1 to x = 9!
    const guard: LiveGuardState = {
      ...createGuardStatesForTarget(target).find((g) => g.guardId === 'co_guard_interior')!,
      pos: { x: 4, z: 1 },
      floor: 0,
      headingDeg: 270,
      flashlightOn: false,
    };

    // Actor behind solid wall at (4, -5) in vault — MUST BE OCCLUDED!
    const occluded = evaluateGuardVision({
      guard,
      guardDef,
      actor: makeActor({ pos: { x: 4, z: -5 } }),
      ctx: makeCtx(),
    });
    expect(occluded.visible).toBe(false);

    // Same distance, clear line in shop (x: 4, z: 5.5) with guard looking South (heading 90 = +Z)
    const clearSight = evaluateGuardVision({
      guard: { ...guard, headingDeg: 90 },
      guardDef,
      actor: makeActor({ pos: { x: 4, z: 5.5 } }),
      ctx: makeCtx(),
    });
    expect(clearSight.visible).toBe(true);
    expect(clearSight.inCentralCone).toBe(true);

    // Through glass storefront window (z = 7, co_w2 is kind: 'glass') from street guard looking North (270)
    const streetGuardDef = target.guards.find((g) => g.id === 'co_guard_street')!;
    const streetGuard: LiveGuardState = {
      ...createGuardStatesForTarget(target).find((g) => g.guardId === 'co_guard_street')!,
      pos: { x: 5, z: 9.5 },
      floor: 0,
      headingDeg: 270,
      flashlightOn: false,
    };
    const throughGlass = evaluateGuardVision({
      guard: streetGuard,
      guardDef: streetGuardDef,
      actor: makeActor({ pos: { x: 5, z: 4.5 }, doingOvertCrime: true }),
      ctx: makeCtx(),
    });
    expect(throughGlass.visible).toBe(true);
  });

  it('cuts visibility range by >50% when power is cut / target crouches in shadow with dark clothing', () => {
    const target = TARGETS.casa_oro;
    const guardDef = target.guards.find((g) => g.id === 'co_guard_interior')!; // visionRange = 7.5m
    const guard: LiveGuardState = {
      ...createGuardStatesForTarget(target).find((g) => g.guardId === 'co_guard_interior')!,
      pos: { x: -4, z: 2.5 },
      floor: 0,
      headingDeg: 0, // looking East (+X)
      flashlightOn: false,
    };

    // Target 5.2m away in bright lit shop (standing upright) -> clearly visible
    const litEval = evaluateGuardVision({
      guard,
      guardDef,
      actor: makeActor({ pos: { x: 1.2, z: 2.5 }, sneaking: false, darkClothing: false }),
      ctx: makeCtx({ powerDisabled: false }),
    });
    expect(litEval.visible).toBe(true);
    expect(litEval.effectiveRangeM).toBeGreaterThan(6.5);

    // Same 5.2m distance with power cut + sneaking + dark clothing (outside flashlight) -> hidden in shadow!
    const darkEval = evaluateGuardVision({
      guard,
      guardDef,
      actor: makeActor({ pos: { x: 1.2, z: 2.5 }, sneaking: true, darkClothing: true }),
      ctx: makeCtx({ powerDisabled: true }),
    });
    expect(darkEval.visible).toBe(false);
    // Effective range dropped by >50% compared to lit standing visibility!
    expect(darkEval.effectiveRangeM).toBeLessThan(litEval.effectiveRangeM * 0.5);
  });

  it('differentiates central vs peripheral vision cones and slow disguise suspicion', () => {
    const target = TARGETS.casa_oro;
    const guardDef = target.guards.find((g) => g.id === 'co_guard_interior')!; // visionConeDeg = 60
    const guard: LiveGuardState = {
      ...createGuardStatesForTarget(target).find((g) => g.guardId === 'co_guard_interior')!,
      pos: { x: 0, z: 2.5 },
      floor: 0,
      headingDeg: 0, // +X
      flashlightOn: false,
    };

    // Directly ahead (0 deg off axis, 3.2m away) -> central cone
    const central = evaluateGuardVision({
      guard,
      guardDef,
      actor: makeActor({ pos: { x: 3.2, z: 2.5 } }),
      ctx: makeCtx(),
    });
    // 40 degrees off axis (outside 30 deg central half-angle, inside peripheral ~49 deg)
    const rad40 = (40 * Math.PI) / 180;
    const peripheral = evaluateGuardVision({
      guard,
      guardDef,
      actor: makeActor({
        pos: { x: Math.cos(rad40) * 3.2, z: 2.5 + Math.sin(rad40) * 3.2 },
      }),
      ctx: makeCtx(),
    });
    const disguised = evaluateGuardVision({
      guard,
      guardDef,
      actor: makeActor({ pos: { x: 3.2, z: 2.5 }, wearingDisguise: true }),
      ctx: makeCtx(),
    });

    expect(central.visible).toBe(true);
    expect(central.inCentralCone).toBe(true);
    expect(peripheral.visible).toBe(true);
    expect(peripheral.inPeripheralCone).toBe(true);
    expect(peripheral.suspicionRatePerSec).toBeLessThan(central.suspicionRatePerSec * 0.55);
    expect(disguised.suspicionRatePerSec).toBeLessThan(central.suspicionRatePerSec * 0.6);
  });

  it('transitions patrol -> suspicious -> investigating -> radioing (~3.5s) -> pursuit -> searching and supports interrupting radio!', () => {
    const target = TARGETS.casa_oro;
    let guards: LiveGuardState[] = [
      {
        ...createGuardStatesForTarget(target).find((g) => g.guardId === 'co_guard_interior')!,
        pos: { x: 2, z: 2.5 },
        floor: 0,
        headingDeg: 0,
        suspicion: 0,
        state: 'patrol',
        pauseRemainingSec: 10,
      },
    ];

    const seenStates = new Set<string>();
    const actor = makeActor({ pos: { x: 5.2, z: 2.5 }, speed: 2.0 });
    let t = 0;
    let radioStartedAt: number | null = null;

    // 1) Escalate from patrol -> suspicious -> investigating -> radioing
    for (let i = 0; i < 60; i++) {
      t += 0.1;
      const res = stepGuardsAI({
        guards,
        actors: [actor],
        dtSec: 0.1,
        ctx: makeCtx({ elapsedSec: t }),
      });
      guards = res.guards;
      seenStates.add(guards[0].state);
      if (guards[0].state === 'radioing' && radioStartedAt === null) {
        radioStartedAt = t;
        expect(res.triggersCentralAlarm).toBe(false); // MUST NOT instant-alarm!
        break;
      }
    }

    expect(seenStates.has('suspicious')).toBe(true);
    expect(seenStates.has('investigating')).toBe(true);
    expect(guards[0].state).toBe('radioing');
    expect(radioStartedAt).not.toBeNull();

    // 2) Verify interrupting radio by breaking contact + moving far away before 55% progress!
    const interruptBranch = stepGuardsAI({
      guards,
      actors: [makeActor({ pos: { x: -12, z: 12 }, floor: 0 })], // escaped around corner >6.5m away
      dtSec: 0.2,
      ctx: makeCtx({ elapsedSec: t + 0.2 }),
    });
    expect(interruptBranch.guards[0].state).toBe('searching');
    expect(interruptBranch.triggersCentralAlarm).toBe(false);
    expect(interruptBranch.events.some((e) => e.kind === 'radio_interrupted')).toBe(true);

    // Also test direct interruptGuardRadio helper
    const copyRadio = structuredClone(guards[0]);
    expect(interruptGuardRadio(copyRadio, 'power_cut')).toBe(true);
    expect(copyRadio.state).toBe('searching');

    // 3) Now let the radio call finish uninterrupted (~3.5s) -> central alarm + pursuit!
    let alarmTriggered = false;
    let evidenceCount = 0;
    let elapsedRadio = 0;
    for (let i = 0; i < 45; i++) {
      t += 0.1;
      elapsedRadio += 0.1;
      const res = stepGuardsAI({
        guards,
        actors: [actor],
        dtSec: 0.1,
        ctx: makeCtx({ elapsedSec: t }),
      });
      guards = res.guards;
      evidenceCount += res.newEvidence.length;
      if (res.triggersCentralAlarm) {
        alarmTriggered = true;
        break;
      }
    }
    expect(alarmTriggered).toBe(true);
    expect(elapsedRadio).toBeGreaterThanOrEqual(BASE_RADIO_DISPATCH_SEC - 0.15);
    expect(guards[0].state).toBe('pursuit');
    expect(evidenceCount).toBeGreaterThanOrEqual(1);

    // 4) Lose target -> guard arrives at lastKnownTargetPos and shifts into 'searching'
    const hiddenActor = makeActor({ pos: { x: -12, z: 12 } });
    for (let i = 0; i < 40; i++) {
      t += 0.2;
      const res = stepGuardsAI({
        guards,
        actors: [hiddenActor],
        dtSec: 0.2,
        ctx: makeCtx({ elapsedSec: t, alarmLevel: 'alarm' }),
      });
      guards = res.guards;
      if (guards[0].state === 'searching') break;
    }
    expect(guards[0].state).toBe('searching');
  });

  it('extends radio dispatch window when crew carries signal_jammer and reduces witness ID when masked', () => {
    const target = TARGETS.casa_oro;
    let guards: LiveGuardState[] = [
      {
        ...createGuardStatesForTarget(target).find((g) => g.guardId === 'co_guard_interior')!,
        pos: { x: 2, z: 2.5 },
        floor: 0,
        headingDeg: 0,
        suspicion: 100,
        state: 'radioing',
        radioProgress: 0,
      },
    ];
    const maskedActor = makeActor({ pos: { x: 4.5, z: 2.5 }, wearingMask: true });

    // After 4.0s with jammer, radio should STILL be in progress (5.5s window!)
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 0.1;
      const res = stepGuardsAI({
        guards,
        actors: [maskedActor],
        dtSec: 0.1,
        ctx: makeCtx({ elapsedSec: t, teamHasJammer: true }),
      });
      guards = res.guards;
      expect(res.triggersCentralAlarm).toBe(false);
    }
    expect(guards[0].state).toBe('radioing');
    expect(guards[0].radioDurationSec).toBe(JAMMER_RADIO_DISPATCH_SEC);

    // Finish remaining 1.6s -> completes radio, witness evidence omits facial crewId because masked!
    let finalEv: ReturnType<typeof stepGuardsAI>['newEvidence'] = [];
    for (let i = 0; i < 20; i++) {
      t += 0.1;
      const res = stepGuardsAI({
        guards,
        actors: [maskedActor],
        dtSec: 0.1,
        ctx: makeCtx({ elapsedSec: t, teamHasJammer: true }),
      });
      guards = res.guards;
      if (res.newEvidence.length > 0) finalEv = res.newEvidence;
    }
    expect(finalEv.length).toBe(1);
    expect(finalEv[0].relatedCrewId).toBeUndefined();
    expect(finalEv[0].severity).toBeLessThanOrEqual(8);
  });

  it('notices cut power (turns on flashlight and navigates via A* to breaker box), unlocked doors, opened safes, and noise ripples', () => {
    const target = TARGETS.casa_oro;
    const baseGuard = createGuardStatesForTarget(target).find(
      (g) => g.guardId === 'co_guard_interior'
    )!;

    // A) Power Cut -> turns on flashlight & sets A* investigation path toward co_power_box!
    const powerRes = stepGuardsAI({
      guards: [{ ...baseGuard, pos: { x: 4, z: 2.5 }, flashlightOn: false }],
      actors: [],
      dtSec: 0.2,
      ctx: makeCtx({ powerDisabled: true }),
    });
    const powerGuard = powerRes.guards[0];
    expect(powerGuard.flashlightOn).toBe(true);
    expect(powerGuard.state).toBe('investigating');
    expect(powerGuard.investigateReason).toBe('power');
    expect(powerGuard.pathWaypoints && powerGuard.pathWaypoints.length).toBeGreaterThanOrEqual(2);
    expect(powerRes.events.some((e) => e.kind === 'power_outage_noticed')).toBe(true);

    // B) Unlocked Door spotted -> investigates doorway
    const doorRes = stepGuardsAI({
      guards: [
        { ...baseGuard, pos: { x: 0, z: 3 }, headingDeg: 90 }, // looking South toward co_entry_front (0, 7)
      ],
      actors: [],
      dtSec: 0.2,
      ctx: makeCtx({ unlockedDoorIds: ['co_entry_front'] }),
    });
    expect(doorRes.guards[0].state).toBe('investigating');
    expect(doorRes.guards[0].investigateReason).toBe('door');

    // C) Opened Safe / Empty Vitrine spotted -> immediate radio dispatch!
    const lootRes = stepGuardsAI({
      guards: [
        { ...baseGuard, pos: { x: 1, z: 2.5 }, headingDeg: 0 }, // looking East toward co_loot_watches (4.5, 2.5)
      ],
      actors: [],
      dtSec: 0.2,
      ctx: makeCtx({ openedContainerIds: ['co_loot_watches'] }),
    });
    expect(lootRes.guards[0].state).toBe('radioing');
    expect(lootRes.guards[0].investigateReason).toBe('loot');

    // D) Positional Noise Ripple -> investigates exact noise origin
    const pulse: NoisePulse = {
      id: 'np_1',
      pos: { x: 0, z: 3 },
      floor: 0,
      radiusM: 12,
      noiseDb: 82,
      emittedAtSec: 9.8,
      label: 'Brecheisen',
    };
    let noiseGuard: LiveGuardState[] = [
      { ...baseGuard, pos: { x: 5.5, z: 3 }, headingDeg: 0 }, // facing AWAY from noise!
    ];
    for (let i = 0; i < 8; i++) {
      const nr = stepGuardsAI({
        guards: noiseGuard,
        actors: [],
        dtSec: 0.2,
        ctx: makeCtx({ elapsedSec: 10 + i * 0.2, noiseEvents: [pulse] }),
      });
      noiseGuard = nr.guards;
    }
    expect(noiseGuard[0].state).toBe('investigating');
    expect(noiseGuard[0].investigateReason).toBe('noise');
    expect(noiseGuard[0].investigatePos).toEqual(pulse.pos);
  });

  it('clips vision fan rays cleanly on solid interior walls without piercing into adjacent rooms', () => {
    const target = TARGETS.casa_oro;
    // Standing at (4, 1) looking straight North (dirZ = -1) toward interior wall at z = -2 (3m away)
    const hit = raycastSolidWalls({ x: 4, z: 1 }, 0, -1, 10, 0, target.walls);
    expect(hit).toBeCloseTo(3.0, 2);

    const fan = computeWallClippedVisionFan({
      origin: { x: 4, z: 1 },
      floor: 0,
      headingDeg: 270, // North (-Z)
      range: 10,
      coneDeg: 50,
      walls: target.walls,
      segments: 12,
    });
    // Every ray in the central northern fan must stop at or before z = -2 (never poke through wall!)
    for (const r of fan) {
      expect(r.worldPos.z).toBeGreaterThanOrEqual(-2.05);
    }
  });

  it('relays guard shouts to nearby colleagues and detects scouting trespassers indoors without bothering street scouts', () => {
    const target = TARGETS.casa_oro;
    const allGuards = createGuardStatesForTarget(target);

    // 1) Guard-to-guard shout relay: guard A finishes radioing near guard B -> guard B enters pursuit!
    const gA: LiveGuardState = {
      ...allGuards[0],
      pos: { x: 2, z: 3 },
      floor: 0,
      headingDeg: 0,
      suspicion: 100,
      state: 'radioing',
      radioProgress: 0.99,
      lastKnownTargetPos: { x: 4, z: 3 },
    };
    const gB: LiveGuardState = {
      ...allGuards[1],
      pos: { x: 8, z: 3 }, // 6m away (< 16m shout relay radius)
      floor: 0,
      headingDeg: 90,
      suspicion: 0,
      state: 'patrol',
    };
    const relayRes = stepGuardsAI({
      guards: [gA, gB],
      actors: [makeActor({ pos: { x: 4, z: 3 } })],
      dtSec: 0.2,
      ctx: makeCtx(),
    });
    expect(relayRes.triggersCentralAlarm).toBe(true);
    expect(relayRes.guards[0].state).toBe('pursuit');
    expect(relayRes.guards[1].state).toBe('pursuit');
    expect(relayRes.events.some((e) => e.kind === 'shout_relay')).toBe(true);

    // 2) Scouting trespassing: street scout ignored, interior trespasser triggers warning!
    const streetRes = stepGuardsAI({
      guards: [{ ...allGuards[0], pos: { x: 0, z: 10 }, headingDeg: 0 }],
      actors: [makeActor({ pos: { x: 3, z: 10 } })], // public street
      dtSec: 0.5,
      ctx: makeCtx({ isScoutingPhase: true }),
    });
    expect(streetRes.guards[0].suspicion).toBe(0);

    let interiorGuards: LiveGuardState[] = [
      { ...allGuards[1], pos: { x: 2, z: 2.5 }, headingDeg: 0, suspicion: 0, state: 'patrol' },
    ];
    let warned = false;
    for (let i = 0; i < 15; i++) {
      const trespassRes = stepGuardsAI({
        guards: interiorGuards,
        actors: [makeActor({ pos: { x: 4.5, z: 2.5 } })], // restricted shop interior!
        dtSec: 0.2,
        ctx: makeCtx({ isScoutingPhase: true }),
      });
      interiorGuards = trespassRes.guards;
      if (trespassRes.events.some((e) => e.kind === 'trespass_warning')) {
        warned = true;
      }
    }
    expect(warned).toBe(true);
    expect(interiorGuards[0].suspicion).toBeGreaterThanOrEqual(25);
  });
});
