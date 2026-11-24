import { describe, expect, it } from 'vitest';
import {
  TARGETS,
  TOOLS,
  buildStarterPlan,
  createInitialCrew,
  createInitialIntel,
} from '../data';
import { resolvePlan } from '../planner';
import {
  hasLineOfSight,
  sampleGuardAtTime,
  simulateRehearsalAt,
} from '../simulator';
import { HeistPlan } from '../types';

describe('Ghost Rehearsal Simulator (Fog-of-War & Determinism)', () => {
  it('is strictly deterministic when scrubbing forward and backward to the same timestamp', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const intel = createInitialIntel(target);
    const resolvedPlan = resolvePlan({
      plan: buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']),
      target,
      crewById: crew,
      toolsById: TOOLS,
      intel,
    });

    const snapA = simulateRehearsalAt({ resolvedPlan, target, intel, timeSec: 18.5 });
    // Scrub ahead, then scrub back
    simulateRehearsalAt({ resolvedPlan, target, intel, timeSec: 42.0 });
    const snapB = simulateRehearsalAt({ resolvedPlan, target, intel, timeSec: 18.5 });

    expect(snapA).toEqual(snapB);
  });

  it('strictly hides unscouted interior guards and hidden traps in ghost rehearsal', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    // Initial intel only knows street-visible guards & nodes
    const initialIntel = createInitialIntel(target);

    // Put Mara walking right onto the hidden vibration sensor BEFORE power is cut
    const trapNode = target.nodes.find((n) => n.id === 'co_hidden_sensor')!;
    const naivePlan: HeistPlan = {
      id: 'naive',
      targetId: 'casa_oro',
      name: 'Blind Run',
      assignedCrewIds: ['mara'],
      blocks: [
        {
          id: 'b_walk_trap',
          crewId: 'mara',
          type: 'move',
          label: 'Durch Hinterzimmer',
          targetPos: trapNode.pos,
          floor: 0,
          startSec: 0,
          durationSec: 6,
          estimatedNoise: 10,
          estimatedTraceRisk: 5,
        },
        {
          id: 'b_wait_trap',
          crewId: 'mara',
          type: 'wait',
          label: 'Warten am Sensor',
          targetPos: trapNode.pos,
          floor: 0,
          startSec: 6,
          durationSec: 8,
          estimatedNoise: 5,
          estimatedTraceRisk: 5,
        },
      ],
      syncBarriers: [],
      planBBranches: [],
      selectedFenceId: 'mateo_puerto',
      vehiclePaintColor: '#1e293b',
      totalDurationSec: 14,
    };

    const resolved = resolvePlan({
      plan: naivePlan,
      target,
      crewById: crew,
      toolsById: TOOLS,
      intel: initialIntel,
    });

    const blindSnap = simulateRehearsalAt({
      resolvedPlan: resolved,
      target,
      intel: initialIntel,
      timeSec: 10,
    });

    // Unscouted interior guard must NOT be present
    expect(blindSnap.guards.some((g) => g.guardId === 'co_guard_interior')).toBe(false);
    // Unscouted hidden trap must NOT create a rehearsal conflict
    expect(blindSnap.conflicts.some((c) => c.sourceId === 'co_hidden_sensor')).toBe(false);
    // Warning count tells player dangers remain unscouted
    expect(blindSnap.unscoutedWarningCount).toBeGreaterThan(0);

    // Now discover the hidden trap AND time the interior guard
    const scoutedIntel = {
      ...initialIntel,
      discoveredNodeIds: [...initialIntel.discoveredNodeIds, 'co_hidden_sensor'],
      timedGuardIds: [...initialIntel.timedGuardIds, 'co_guard_interior'],
    };

    const scoutedSnap = simulateRehearsalAt({
      resolvedPlan: resolved,
      target,
      intel: scoutedIntel,
      timeSec: 10,
    });

    expect(scoutedSnap.guards.some((g) => g.guardId === 'co_guard_interior')).toBe(true);
    expect(scoutedSnap.conflicts.some((c) => c.sourceId === 'co_hidden_sensor')).toBe(true);
  });

  it('disables powered cameras in rehearsal after cut_power completes', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const intel = createInitialIntel(target);
    const resolvedPlan = resolvePlan({
      plan: buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']),
      target,
      crewById: crew,
      toolsById: TOOLS,
      intel,
    });

    const powerEnd = resolvedPlan.blocksById['co_b_jule_power'].computedEndSec!;

    const beforePower = simulateRehearsalAt({
      resolvedPlan,
      target,
      intel,
      timeSec: Math.max(0, powerEnd - 2),
    });
    expect(beforePower.powerDisabled).toBe(false);
    expect(beforePower.cameras.some((c) => c.active)).toBe(true);

    const afterPower = simulateRehearsalAt({
      resolvedPlan,
      target,
      intel,
      timeSec: powerEnd + 1,
    });
    expect(afterPower.powerDisabled).toBe(true);
    expect(afterPower.cameras.every((c) => !c.active)).toBe(true);
  });

  it('blocks guard sightlines through solid walls while allowing glass', () => {
    const target = TARGETS.casa_oro;
    // Solid wall co_w7 runs along z=-2 from x=-9 to x=-2
    expect(hasLineOfSight({ x: -5, z: 1 }, { x: -5, z: -5 }, 0, target.walls)).toBe(
      false
    );
    // Glass wall co_w1 runs along z=7 from x=-9 to x=-2
    expect(hasLineOfSight({ x: -5, z: 9 }, { x: -5, z: 4 }, 0, target.walls)).toBe(
      true
    );

    const guard = target.guards[0];
    const p0 = sampleGuardAtTime(guard, 0);
    const pLater = sampleGuardAtTime(guard, 8);
    expect(p0.pos).not.toEqual(pLater.pos);
  });
});
