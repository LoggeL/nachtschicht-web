import { describe, expect, it } from 'vitest';
import { TARGETS, TOOLS, buildStarterPlan, createInitialCrew } from '../data';
import { resolvePlan } from '../planner';
import {
  applyRadioCommand,
  createInitialLiveState,
  tickLiveExecution,
} from '../liveEngine';
import { HeistPlan } from '../types';

describe('Live Execution Engine (Sync Barriers, Hidden Traps, Deviations, Radio & Plan B)', () => {
  it('executes Casa Oro starter plan honoring sync barriers, power cut, loot, and extraction', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const plan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);
    const resolvedPlan = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });

    let live = createInitialLiveState({ target, resolvedPlan, seed: 42 });

    // Step through up to 90 simulated seconds
    for (let i = 0; i < 450 && !live.readyForEscape; i++) {
      live = tickLiveExecution({
        live,
        dtSec: 0.2,
        target,
        resolvedPlan,
        crewById: crew,
      });
    }

    expect(live.powerDisabled).toBe(true);
    expect(live.alarmBypassed).toBe(true);
    expect(live.cameras.every((c) => !c.active)).toBe(true);
    expect(live.totalLootEur).toBeGreaterThanOrEqual(36000);
    expect(live.readyForEscape).toBe(true);
  });

  it('triggers unscouted hidden trap in live execution when power is still ON (unlike blind rehearsal)', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const trapNode = target.nodes.find((n) => n.id === 'co_hidden_sensor')!;

    const plan: HeistPlan = {
      id: 'trap_test',
      targetId: 'casa_oro',
      name: 'Walk Into Trap',
      assignedCrewIds: ['mara'],
      blocks: [
        {
          id: 'b_go_trap',
          crewId: 'mara',
          type: 'move',
          label: 'Zum Hinterzimmer',
          targetPos: trapNode.pos,
          floor: 0,
          startSec: 0,
          durationSec: 5,
          estimatedNoise: 10,
          estimatedTraceRisk: 5,
        },
      ],
      syncBarriers: [],
      planBBranches: [],
      selectedFenceId: 'mateo_puerto',
      vehiclePaintColor: '#1e293b',
      totalDurationSec: 5,
    };

    const resolvedPlan = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });

    let live = createInitialLiveState({ target, resolvedPlan, seed: 7 });
    for (let i = 0; i < 120; i++) {
      live = tickLiveExecution({
        live,
        dtSec: 0.2,
        target,
        resolvedPlan,
        crewById: crew,
      });
    }

    expect(live.triggeredHazardNodeIds).toContain('co_hidden_sensor');
    expect(live.alarmLevel).not.toBe('silent');
    expect(live.deviations.some((d) => d.kind === 'hidden_trap_triggered')).toBe(true);
  });

  it('triggers greed deviation for high-greed crew (Rico) grabbing extra nearby loot', () => {
    const crew = createInitialCrew();
    crew.rico.recruited = true;
    const target = TARGETS.casa_oro;
    const vitrine = target.nodes.find((n) => n.id === 'co_loot_vitrine')!;

    const plan: HeistPlan = {
      id: 'greed_test',
      targetId: 'casa_oro',
      name: 'Rico Solo Loot',
      assignedCrewIds: ['rico'],
      blocks: [
        {
          id: 'b_rico_vitrine',
          crewId: 'rico',
          type: 'grab_loot',
          label: 'Goldvitrine',
          targetNodeId: vitrine.id,
          targetPos: vitrine.pos,
          floor: 0,
          startSec: 0,
          durationSec: 6,
          estimatedNoise: 18,
          estimatedTraceRisk: 14,
        },
        {
          id: 'b_rico_extract',
          crewId: 'rico',
          type: 'extract',
          label: 'Raus',
          targetNodeId: 'co_getaway',
          targetPos: target.getawayPos,
          floor: 0,
          startSec: 12,
          durationSec: 6,
          estimatedNoise: 16,
          estimatedTraceRisk: 6,
        },
      ],
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

    let live = createInitialLiveState({ target, resolvedPlan, seed: 99 });
    // Disable power so cameras don't interfere with greed test
    live.powerDisabled = true;

    for (let i = 0; i < 200; i++) {
      live = tickLiveExecution({
        live,
        dtSec: 0.2,
        target,
        resolvedPlan,
        crewById: crew,
      });
    }

    expect(live.deviations.some((d) => d.kind === 'greed_extra_loot')).toBe(true);
    // Rico should have grabbed BOTH vitrines (14k + 12k = 26k)
    expect(live.totalLootEur).toBeGreaterThanOrEqual(26000);
  });

  it('triggers high-nerves improvisation and radio commands (hold, resume, plan_b, abort)', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const plan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);
    const resolvedPlan = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });

    let live = createInitialLiveState({ target, resolvedPlan, seed: 11 });

    // Issue HOLD command
    live = applyRadioCommand(live, 'hold', resolvedPlan);
    expect(live.holdActive).toBe(true);
    expect(live.crew.jule.state).toBe('holding');

    const heldPos = { ...live.crew.jule.pos };
    live = tickLiveExecution({
      live,
      dtSec: 0.5,
      target,
      resolvedPlan,
      crewById: crew,
    });
    expect(live.crew.jule.pos).toEqual(heldPos);

    // Issue RESUME command
    live = applyRadioCommand(live, 'resume', resolvedPlan);
    expect(live.holdActive).toBe(false);
    expect(live.crew.jule.state).not.toBe('holding');

    // Issue PLAN B command
    live = applyRadioCommand(live, 'plan_b', resolvedPlan);
    expect(live.planBActive).toBe(true);
    expect(live.crew.jupp.usingPlanB).toBe(true);
    expect(live.deviations.some((d) => d.kind === 'plan_b_engaged')).toBe(true);

    // Issue ABORT command and verify everyone extracts to getaway car
    live = applyRadioCommand(live, 'abort', resolvedPlan);
    expect(live.abortActive).toBe(true);
    for (let i = 0; i < 60; i++) {
      live = tickLiveExecution({
        live,
        dtSec: 0.25,
        target,
        resolvedPlan,
        crewById: crew,
      });
    }
    expect(live.readyForEscape).toBe(true);
  });
});
