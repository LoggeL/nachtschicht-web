import { describe, expect, it } from 'vitest';
import { TARGETS, TOOLS, buildStarterPlan, createInitialCrew, createInitialIntel } from '../data';
import {
  calculateActionMetrics,
  resolvePlan,
  selectPlanBBranch,
  wouldSyncCreateCycle,
} from '../planner';
import { CrewId, HeistPlan } from '../types';

describe('Planner: duration metrics, sync barriers, DAG cycles, Plan B', () => {
  it('calculates faster durations for higher skill and specialist tools, and lower trace risk with gloves', () => {
    const crew = createInitialCrew();
    const safeNode = TARGETS.casa_oro.nodes.find((n) => n.id === 'co_safe_main')!;

    // Jupp (locks 9 + lockpick_set + gloves) vs Rico (locks 5, no lockpick, no gloves)
    const juppMetrics = calculateActionMetrics({
      type: 'crack_safe',
      member: crew.jupp,
      node: safeNode,
      fromPos: safeNode.pos,
      fromFloor: 0,
      targetPos: safeNode.pos,
      targetFloor: 0,
      toolsById: TOOLS,
    });

    const ricoNoGloves = { ...crew.rico, equippedTools: [] };
    const ricoMetrics = calculateActionMetrics({
      type: 'crack_safe',
      member: ricoNoGloves,
      node: safeNode,
      fromPos: safeNode.pos,
      fromFloor: 0,
      targetPos: safeNode.pos,
      targetFloor: 0,
      toolsById: TOOLS,
    });

    expect(juppMetrics.durationSec).toBeLessThan(ricoMetrics.durationSec);
    expect(juppMetrics.estimatedTraceRisk).toBeLessThan(ricoMetrics.estimatedTraceRisk);
    expect(juppMetrics.usedToolId).toBe('lockpick_set');
  });

  it('enforces cross-track SyncBarrier ordering so dependent blocks start after prerequisites end', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const plan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);
    const resolved = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
      intel: createInitialIntel(target),
    });

    expect(resolved.valid).toBe(true);

    // Sync barrier 1: Mara enters ONLY after Jule finishes cutting power
    const julePower = resolved.blocksById['co_b_jule_power'];
    const maraEnter = resolved.blocksById['co_b_mara_enter'];
    expect(maraEnter.computedStartSec).toBeGreaterThanOrEqual(julePower.computedEndSec!);

    // Sync barrier 2: Jupp cracks safe ONLY after Mara finishes alarm bypass
    const maraAlarm = resolved.blocksById['co_b_mara_alarm'];
    const juppSafe = resolved.blocksById['co_b_jupp_safe'];
    expect(juppSafe.computedStartSec).toBeGreaterThanOrEqual(maraAlarm.computedEndSec!);
  });

  it('detects cyclic SyncBarrier deadlocks both proactively and in resolvePlan', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const basePlan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);

    // Adding a barrier from Mara's extract back to Jule's power creates a cycle
    // (jule_power -> mara_enter -> ... -> mara_extract -> jule_power)
    expect(
      wouldSyncCreateCycle(basePlan, 'co_b_mara_extract', 'co_b_jule_power')
    ).toBe(true);

    // Non-cyclic barrier is allowed
    expect(
      wouldSyncCreateCycle(basePlan, 'co_b_jule_power', 'co_b_jupp_extract')
    ).toBe(false);

    const cyclicPlan: HeistPlan = {
      ...basePlan,
      syncBarriers: [
        ...basePlan.syncBarriers,
        {
          id: 'bad_cycle',
          label: 'Deadlock',
          fromBlockId: 'co_b_mara_extract',
          fromCrewId: 'mara',
          toBlockId: 'co_b_jule_power',
          toCrewId: 'jule',
        },
      ],
    };

    const resolved = resolvePlan({
      plan: cyclicPlan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });

    expect(resolved.valid).toBe(false);
    expect(resolved.issues.some((i) => i.code === 'CYCLE')).toBe(true);
  });

  it('warns when an alarm-linked safe is scheduled without waiting for alarm bypass', () => {
    const crew = createInitialCrew();
    const target = TARGETS.casa_oro;
    const basePlan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);

    // Remove the alarm-to-safe sync barrier and start Jupp's safe at t=0
    const riskyPlan: HeistPlan = {
      ...basePlan,
      syncBarriers: basePlan.syncBarriers.filter((s) => s.id !== 'co_sync_alarm_safe'),
      blocks: basePlan.blocks.map((b) =>
        b.id === 'co_b_jupp_safe' || b.id === 'co_b_jupp_enter'
          ? { ...b, startSec: 0 }
          : b
      ),
    };

    const resolved = resolvePlan({
      plan: riskyPlan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });

    expect(resolved.issues.some((i) => i.code === 'POWER_ORDER')).toBe(true);
  });

  it('selects matching Plan B branches per crew member and trigger', () => {
    const plan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule'] as CrewId[]);
    const juppBranch = selectPlanBBranch(plan, 'jupp', 'on_alarm');
    expect(juppBranch?.action).toBe('alternate_exit_roof');

    const maraBranch = selectPlanBBranch(plan, 'mara', 'manual_radio');
    expect(maraBranch?.action).toBe('abort_to_car');
  });
});
