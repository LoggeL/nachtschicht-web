import { describe, expect, it } from 'vitest';
import {
  COUNTERMEASURES,
  FENCES,
  TARGETS,
  TOOLS,
  buildStarterPlan,
  createInitialCrew,
} from '../data';
import {
  applyCountermeasureToCaseFile,
  calculateFencePayout,
  createInitialCaseFile,
  findAct3TraitorCandidate,
  settleHeistDebrief,
} from '../caseFile';
import { resolvePlan } from '../planner';
import { createInitialLiveState } from '../liveEngine';
import { useGameStore } from '../../state/store';

describe('Die Akte (CaseFile), Hehler economy, Traitor mechanic & Store', () => {
  it('pays higher rates for preferred fence categories', () => {
    const loot = [
      {
        nodeId: 'n1',
        label: 'Gemälde',
        category: 'art_antiques' as const,
        valueEur: 100000,
        collectedBy: 'mara' as const,
      },
    ];
    const carmen = calculateFencePayout(loot, FENCES.carmen_antiques);
    const mateo = calculateFencePayout(loot, FENCES.mateo_puerto);
    expect(carmen.payoutEur).toBeGreaterThan(mateo.payoutEur);
    expect(carmen.payoutEur).toBe(84000);
  });

  it('spikes Die Akte heat on loud/violent heist and reduces heat via countermeasures', () => {
    const crew = createInitialCrew();
    // Remove gloves from Mara so fingerprints get recorded
    crew.mara.equippedTools = ['electronic_bypass'];
    const target = TARGETS.casa_oro;
    const plan = buildStarterPlan('casa_oro', ['mara', 'jupp', 'jule']);
    const resolvedPlan = resolvePlan({
      plan,
      target,
      crewById: crew,
      toolsById: TOOLS,
    });
    const live = createInitialLiveState({ target, resolvedPlan });
    live.alarmLevel = 'lockdown';
    live.violenceUsed = true;
    live.completedNodeIds = ['co_safe_main'];
    live.collectedLoot = [
      {
        nodeId: 'co_safe_main',
        label: 'Tresor',
        category: 'cash',
        valueEur: 22000,
        collectedBy: 'jupp',
      },
    ];
    live.totalLootEur = 22000;

    const initialCase = createInitialCaseFile();
    const { debrief, updatedCaseFile } = settleHeistDebrief({
      target,
      live,
      escaped: true,
      escapeVehicleRecognized: true,
      fence: FENCES.mateo_puerto,
      crewById: crew,
      assignedCrewIds: ['mara', 'jupp', 'jule'],
      caseFile: initialCase,
      day: 2,
      completedTargetIds: [],
    });

    expect(debrief.cleanGhostBonus).toBe(false);
    expect(updatedCaseFile.heat).toBeGreaterThan(initialCase.heat + 35);
    expect(updatedCaseFile.evidence.some((e) => e.type === 'recognized_car')).toBe(true);
    expect(updatedCaseFile.evidence.some((e) => e.type === 'violence_report')).toBe(true);
    expect(updatedCaseFile.evidence.some((e) => e.type === 'fingerprints')).toBe(true);

    // Apply repaint car countermeasure (with spray booth upgrade discount!)
    const repaint = COUNTERMEASURES.find((c) => c.id === 'repaint_car')!;
    const afterCm = applyCountermeasureToCaseFile(updatedCaseFile, repaint, true);
    expect(afterCm.effectiveCostEur).toBe(Math.round(repaint.costEur * 0.4));
    expect(afterCm.mitigatedCount).toBeGreaterThanOrEqual(1);
    expect(afterCm.caseFile.heat).toBeLessThan(updatedCaseFile.heat);
  });

  it('selects the lowest-loyalty recruited accomplice (excluding Mara & Jupp) as Act 3 traitor', () => {
    const crew = createInitialCrew();
    crew.toni.recruited = true;
    crew.rico.recruited = true;
    crew.jule.traits.loyalty = 80;
    crew.toni.traits.loyalty = 65;
    crew.rico.traits.loyalty = 38;

    expect(findAct3TraitorCandidate(crew)).toBe('rico');

    // If player invested in Rico so Toni is lowest instead:
    crew.rico.traits.loyalty = 90;
    expect(findAct3TraitorCandidate(crew)).toBe('toni');
  });

  it('runs a full Zustand store campaign loop cleanly', () => {
    const store = useGameStore.getState();
    store.startNewCampaign();
    expect(useGameStore.getState().phase).toBe('safehouse');
    expect(useGameStore.getState().bankrollEur).toBe(12000);

    // Recruit Toni (cost 5000)
    expect(useGameStore.getState().recruitCrew('toni')).toBe(true);
    expect(useGameStore.getState().crew.toni.recruited).toBe(true);
    expect(useGameStore.getState().bankrollEur).toBe(7000);

    // Discover a hidden node in scouting
    useGameStore.getState().discoverNode('casa_oro', 'co_hidden_sensor');
    expect(
      useGameStore.getState().intelByTarget.casa_oro.discoveredNodeIds
    ).toContain('co_hidden_sensor');

    // Prevent cyclic sync barrier via store action
    const cycleRes = useGameStore
      .getState()
      .addSyncBarrier('co_b_mara_extract', 'co_b_jule_power');
    expect(cycleRes.ok).toBe(false);

    // Launch heist, tick, start escape, finish escape -> Debrief
    useGameStore.getState().launchHeist('casa_oro');
    expect(useGameStore.getState().phase).toBe('executing');
    useGameStore.getState().tickLiveExecution(0.2);
    useGameStore.getState().issueRadioCommand('hold');
    expect(useGameStore.getState().liveState?.holdActive).toBe(true);

    useGameStore.getState().startEscape();
    expect(useGameStore.getState().phase).toBe('escape');
    useGameStore.getState().finishEscape(true);
    expect(useGameStore.getState().phase).toBe('debrief');
    expect(useGameStore.getState().lastDebrief).not.toBeNull();
  });
});
