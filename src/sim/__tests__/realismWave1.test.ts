import { describe, expect, it } from 'vitest';
import {
  FENCES,
  TARGETS,
  TOOLS,
  buildStarterPlan,
  createInitialCrew,
  createInitialIntel,
} from '../data';
import {
  canScoutNodeFrom,
  computeRoomLightLevels,
  findTargetPath,
  hasSolidLineOfSight,
} from '../pathfinding';
import {
  attemptCircuitWireAction,
  attemptLockpickPin,
  createMinigameForNode,
} from '../minigames';
import { resolvePlan } from '../planner';
import { simulateRehearsalAt } from '../simulator';
import {
  createInitialLiveState,
  playerInteractWithNode,
  pushNoisePulse,
  tickLiveExecution,
} from '../liveEngine';
import { createInitialCaseFile, settleHeistDebrief } from '../caseFile';
import { useGameStore } from '../../state/store';
import { HeistPlan } from '../types';

describe('Wave 1 Realism: A* Pathfinding, Wall-Occluded Scouting, Forensics, Radio Window & Minigames', () => {
  it('routes A* paths around solid walls and respects locked vs unlocked doors across all 4 targets', () => {
    const co = TARGETS.casa_oro;

    // Path from street to vault must navigate around walls (never cross solid walls!)
    const openPath = findTargetPath(
      co,
      co.getawayPos,
      0,
      { x: 6, z: -7.5 },
      0,
      { respectLockedDoors: false }
    );
    expect(openPath.found).toBe(true);
    expect(openPath.waypoints.length).toBeGreaterThan(2);

    // Every same-floor segment of the smoothed A* path must have solid-wall line of sight
    for (let i = 1; i < openPath.waypoints.length; i++) {
      const a = openPath.waypoints[i - 1];
      const b = openPath.waypoints[i];
      if (a.floor === b.floor) {
        expect(hasSolidLineOfSight(a.pos, b.pos, a.floor, co.walls)).toBe(true);
      }
    }

    // With all doors locked, path from street into interior vault cannot walk through locked doors
    const lockedPath = findTargetPath(
      co,
      co.getawayPos,
      0,
      { x: 6, z: -7.5 },
      0,
      { respectLockedDoors: true, unlockedNodeIds: [] }
    );
    expect(lockedPath.found).toBe(false);

    // Unlocking service door opens a clean corridor route into the vault!
    const unlockedPath = findTargetPath(
      co,
      co.getawayPos,
      0,
      { x: 6, z: -7.5 },
      0,
      { respectLockedDoors: true, unlockedNodeIds: ['co_entry_service'] }
    );
    expect(unlockedPath.found).toBe(true);

    // Multi-floor navigation across Perla del Mar, Villa Mirador & Dresden Schatzkammer
    const pdmCellar = findTargetPath(
      TARGETS.perla_del_mar,
      TARGETS.perla_del_mar.getawayPos,
      0,
      { x: -7, z: -6 },
      -1
    );
    expect(pdmCellar.found).toBe(true);
    expect(pdmCellar.floorTransitions).toBeGreaterThanOrEqual(1);

    const vmMaster = findTargetPath(
      TARGETS.villa_mirador,
      TARGETS.villa_mirador.getawayPos,
      0,
      { x: 6, z: -8 },
      1
    );
    expect(vmMaster.found).toBe(true);
    expect(vmMaster.floorTransitions).toBeGreaterThanOrEqual(1);

    const ddCellar = findTargetPath(
      TARGETS.schatzkammer_dresden,
      TARGETS.schatzkammer_dresden.getawayPos,
      0,
      { x: 10, z: -2 },
      -1
    );
    expect(ddCellar.found).toBe(true);
    expect(ddCellar.floorTransitions).toBeGreaterThanOrEqual(1);
  });

  it('blocks scouting interior nodes through solid brick walls while allowing glass storefront sightlines', () => {
    const co = TARGETS.casa_oro;
    const safeNode = co.nodes.find((n) => n.id === 'co_safe_main')!;
    const vitrineNode = co.nodes.find((n) => n.id === 'co_loot_vitrine')!;

    // Standing behind the solid north exterior wall cannot scan the safe!
    const blocked = canScoutNodeFrom({
      target: co,
      observerPos: { x: 6, z: -12.5 },
      observerFloor: 0,
      node: safeNode,
    });
    expect(blocked.canScout).toBe(false);
    expect(blocked.reason).toBe('wall_occluded');

    // Standing on the street outside the glass window CAN scout the storefront vitrine!
    const throughGlass = canScoutNodeFrom({
      target: co,
      observerPos: { x: -3.5, z: 9.5 },
      observerFloor: 0,
      node: vitrineNode,
    });
    expect(throughGlass.canScout).toBe(true);

    // Standing inside the vault room CAN scout the safe!
    const insideRoom = canScoutNodeFrom({
      target: co,
      observerPos: { x: 3.5, z: -6.5 },
      observerFloor: 0,
      node: safeNode,
    });
    expect(insideRoom.canScout).toBe(true);
  });

  it('produces wall-respecting A* ghost paths, room lighting blackout levels, and noise rings in rehearsal', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const intel = createInitialIntel(target);
    const plan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);
    const resolvedPlan = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
      intel,
    });

    const snapBefore = simulateRehearsalAt({
      resolvedPlan,
      target,
      intel,
      timeSec: 3,
    });
    expect(snapBefore.roomLightLevels['co_shop']).toBeGreaterThan(0.7);
    const maraGhost = snapBefore.crew.find((c) => c.crewId === 'mara')!;
    expect(maraGhost.plannedPath && maraGhost.plannedPath.length).toBeGreaterThan(3);

    const powerEnd = resolvedPlan.blocksById['co_b_jule_power'].computedEndSec!;
    const snapAfter = simulateRehearsalAt({
      resolvedPlan,
      target,
      intel,
      timeSec: powerEnd + 1,
    });
    expect(snapAfter.powerDisabled).toBe(true);
    expect(snapAfter.roomLightLevels['co_shop']).toBeLessThan(0.2);

    const lightsOff = computeRoomLightLevels(target, true);
    expect(lightsOff['co_street']).toBeGreaterThan(0.6);
    expect(lightsOff['co_vault']).toBeLessThan(0.2);
  });

  it('uses an interruptible guard radioing window extended by signal_jammer and investigates positional noise', () => {
    const crew = createInitialCrew();
    crew.mara.equippedTools = [...crew.mara.equippedTools, 'signal_jammer'];
    const target = TARGETS.casa_oro;
    const plan: HeistPlan = {
      id: 'radio_test',
      targetId: 'casa_oro',
      name: 'Radio Window Test',
      assignedCrewIds: ['mara'],
      blocks: [],
      syncBarriers: [],
      planBBranches: [],
      selectedFenceId: 'mateo_puerto',
      vehiclePaintColor: '#1e293b',
      totalDurationSec: 20,
    };
    const resolvedPlan = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });

    let live = createInitialLiveState({ target, resolvedPlan, seed: 5 });
    // Place Mara directly in front of the interior guard in lit room
    live.crew.mara.pos = { x: 6.2, z: 5.5 };
    live.crew.mara.floor = 0;

    // Tick 2.5s -> guard should reach 'radioing', NOT instant global alarm!
    for (let i = 0; i < 25; i++) {
      live = tickLiveExecution({
        live,
        dtSec: 0.1,
        target,
        resolvedPlan,
        crewById: crew,
        options: { playerSteeredExternally: true },
      });
    }

    const intGuard = live.guards.find((g) => g.guardId === 'co_guard_interior')!;
    expect(intGuard.state).toBe('radioing');
    expect(intGuard.radioDurationSec).toBeGreaterThan(5); // 3.5 + 2.5 jammer bonus!
    expect(live.alarmLevel).not.toBe('alarm');
    expect(live.stealthTelemetry.radioInterruptWindowSec).not.toBeNull();

    // Tick 6.5 more seconds so radio finishes -> escalates to full alarm!
    for (let i = 0; i < 65; i++) {
      live = tickLiveExecution({
        live,
        dtSec: 0.1,
        target,
        resolvedPlan,
        crewById: crew,
        options: { playerSteeredExternally: true },
      });
    }
    expect(live.alarmLevel).toBe('alarm');

    // Positional noise pulse causes street guard to investigate pulse location
    let noiseLive = createInitialLiveState({ target, resolvedPlan, seed: 8 });
    pushNoisePulse(noiseLive, {
      pos: { x: -4, z: 9.5 },
      floor: 0,
      noiseDb: 90,
      label: 'Glasbruch',
    });
    for (let i = 0; i < 15; i++) {
      noiseLive = tickLiveExecution({
        live: noiseLive,
        dtSec: 0.1,
        target,
        resolvedPlan,
        crewById: crew,
        options: { playerSteeredExternally: true },
      });
    }
    const streetGuard = noiseLive.guards.find((g) => g.guardId === 'co_guard_street')!;
    expect(streetGuard.state).toBe('investigating');
    expect(streetGuard.investigateReason).toBe('noise');
    expect(streetGuard.investigatePos).toEqual({ x: -4, z: 9.5 });
  });

  it('tracks forensic loadout (mask, gloves, crowbar glass break, escape paint scrape) in Die Akte', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const plan = buildStarterPlan('casa_oro', ['mara']);
    const resolvedPlan = resolvePlan({ plan, target, crewById: crew, toolsById: TOOLS });
    let live = createInitialLiveState({ target, resolvedPlan });

    // Smash vitrine with crowbar -> records brokenGlassNodes + openedContainerIds
    live = playerInteractWithNode(live, target, 'co_loot_vitrine', {
      usedTool: 'crowbar',
      brokenGlass: true,
    });
    expect(live.brokenGlassNodes).toContain('co_loot_vitrine');
    expect(live.openedContainerIds).toContain('co_loot_vitrine');
    live.pendingEvidence.push({
      type: 'camera_footage',
      title: 'CCTV Showroom',
      detail: 'Kamera zeichnete Mara auf.',
      targetId: target.id,
      severity: 16,
      relatedCrewId: 'mara',
    });

    // Unmasked vs Masked comparison + paint scrape trace
    const unmasked = settleHeistDebrief({
      target,
      live,
      escaped: true,
      escapeVehicleRecognized: false,
      escapePaintScrapeTrace: true,
      fence: FENCES.mateo_puerto,
      crewById: crew,
      assignedCrewIds: ['mara'],
      forensicLoadoutByCrew: {
        mara: { gloves: false, mask: false, darkClothing: false, entryTool: 'crowbar' },
      },
      caseFile: createInitialCaseFile(),
      day: 2,
      completedTargetIds: [],
    });

    const masked = settleHeistDebrief({
      target,
      live,
      escaped: true,
      escapeVehicleRecognized: false,
      escapePaintScrapeTrace: false,
      fence: FENCES.mateo_puerto,
      crewById: crew,
      assignedCrewIds: ['mara'],
      forensicLoadoutByCrew: {
        mara: { gloves: true, mask: true, darkClothing: true, entryTool: 'glass_cutter' },
      },
      caseFile: createInitialCaseFile(),
      day: 2,
      completedTargetIds: [],
    });

    expect(unmasked.updatedCaseFile.heat).toBeGreaterThan(masked.updatedCaseFile.heat);
    expect(
      unmasked.debrief.newEvidence.some((e) => e.title.includes('Gesicht erfasst'))
    ).toBe(true);
    expect(
      masked.debrief.newEvidence.some((e) => e.title.includes('Vermummt'))
    ).toBe(true);
    expect(
      unmasked.debrief.newEvidence.some((e) => e.title.includes('Lackspuren'))
    ).toBe(true);
    expect(
      unmasked.debrief.newEvidence.some((e) => e.title.includes('Glasbruch'))
    ).toBe(true);
  });

  it('resolves lockpick sweet-spots, Securion circuit tamper traps, and store Wave 1 actions', () => {
    const crew = createInitialCrew();
    const alarmNode = TARGETS.casa_oro.nodes.find((n) => n.id === 'co_alarm_panel')!;
    const lockNode = TARGETS.casa_oro.nodes.find((n) => n.id === 'co_entry_service')!;

    // Lockpick minigame: hitting every pin sweet-spot completes cleanly
    let lockGame = createMinigameForNode({
      node: lockNode,
      member: crew.mara,
      toolsById: TOOLS,
      startedAtSec: 10,
    });
    expect(lockGame.kind).toBe('lockpick');
    let completed = false;
    for (const pin of lockGame.pins!) {
      const r = attemptLockpickPin(lockGame, pin.sweetSpot);
      expect(r.hit).toBe(true);
      lockGame = r.game;
      completed = r.completed;
    }
    expect(completed).toBe(true);

    // Securion circuit: cutting tamper wire immediately trips alarm!
    const circuitGame = createMinigameForNode({
      node: alarmNode,
      member: crew.mara,
      toolsById: TOOLS,
      startedAtSec: 12,
    });
    expect(circuitGame.kind).toBe('securion_circuit');
    const tamperWire = circuitGame.wires!.find((w) => w.role === 'tamper_backup')!;
    const badRes = attemptCircuitWireAction(circuitGame, tamperWire.id, 'cut');
    expect(badRes.trippedTamper).toBe(true);
    expect(badRes.failed).toBe(true);

    // Store integration: forensic loadout, graphicsQuality, witness evidence & minigame auto-complete
    useGameStore.getState().startNewCampaign();
    useGameStore.getState().setGraphicsQuality('ultra');
    expect(useGameStore.getState().graphicsQuality).toBe('ultra');

    useGameStore.getState().setCrewForensicLoadout('mara', {
      mask: true,
      darkClothing: true,
      entryTool: 'glass_cutter',
    });
    expect(useGameStore.getState().crew.mara.equippedTools).toContain('mask');
    expect(useGameStore.getState().crew.mara.equippedTools).toContain('dark_clothing');

    useGameStore.getState().launchHeist('casa_oro');
    const started = useGameStore.getState().startMinigame('co_alarm_panel');
    expect(started?.kind).toBe('securion_circuit');
    useGameStore.getState().autoCompleteActiveMinigame();
    expect(useGameStore.getState().liveState?.alarmBypassed).toBe(true);
    expect(useGameStore.getState().liveState?.activeMinigame).toBeNull();

    useGameStore.getState().recordWitnessEvidence({
      type: 'witness',
      title: 'Passant an der Promenade',
      detail: 'Beobachtete vermummte Person beim Einstieg.',
      targetId: 'casa_oro',
      severity: 11,
      relatedCrewId: 'mara',
    });
    expect(
      useGameStore
        .getState()
        .liveState?.pendingEvidence.some((e) => e.title === 'Passant an der Promenade')
    ).toBe(true);
  });
});
