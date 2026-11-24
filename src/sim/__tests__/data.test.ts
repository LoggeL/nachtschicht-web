import { describe, expect, it } from 'vitest';
import {
  COUNTERMEASURES,
  FENCES,
  TARGETS,
  TARGET_ORDER,
  TOOLS,
  buildStarterPlan,
  createInitialCrew,
  createInitialIntel,
  createInitialStoryBeats,
  createInitialWorkshopUpgrades,
} from '../data';
import { resolvePlan } from '../planner';
import { CrewId } from '../types';

describe('Nachtschicht lore & target data integrity', () => {
  it('defines all 4 targets with >= 3 access points, hidden traps, valid refs, and guards', () => {
    expect(TARGET_ORDER).toEqual([
      'casa_oro',
      'perla_del_mar',
      'villa_mirador',
      'schatzkammer_dresden',
    ]);

    for (const id of TARGET_ORDER) {
      const target = TARGETS[id];
      expect(target).toBeDefined();

      const accessPoints = target.nodes.filter((n) => n.isAccessPoint);
      expect(accessPoints.length).toBeGreaterThanOrEqual(3);

      const hiddenHazards = target.nodes.filter((n) => n.isHiddenHazard);
      expect(hiddenHazards.length).toBeGreaterThanOrEqual(1);
      for (const h of hiddenHazards) {
        expect(h.visibleFromStreet).toBe(false);
      }

      const roomIds = new Set(target.rooms.map((r) => r.id));
      const nodeIds = new Set(target.nodes.map((n) => n.id));
      const floorSet = new Set(target.floors);

      for (const node of target.nodes) {
        expect(roomIds.has(node.roomId)).toBe(true);
        expect(floorSet.has(node.floor)).toBe(true);
        if (node.poweredByNodeId) {
          expect(nodeIds.has(node.poweredByNodeId)).toBe(true);
        }
        if (node.alarmLinkedNodeId) {
          expect(nodeIds.has(node.alarmLinkedNodeId)).toBe(true);
        }
      }

      expect(target.guards.length).toBeGreaterThanOrEqual(2);
      expect(target.nodes.some((n) => n.kind === 'getaway_zone')).toBe(true);
      expect(target.nodes.some((n) => n.kind === 'power_box')).toBe(true);
      expect(target.nodes.some((n) => n.kind === 'alarm_panel')).toBe(true);
    }
  });

  it('builds valid starter plans for every target that pass DAG resolution cleanly', () => {
    const crew = createInitialCrew();
    const allCrewIds = Object.keys(crew) as CrewId[];

    for (const tid of TARGET_ORDER) {
      const target = TARGETS[tid];
      const plan = buildStarterPlan(tid, allCrewIds);
      const intel = createInitialIntel(target);
      const resolved = resolvePlan({
        plan,
        target,
        crewById: crew,
        toolsById: TOOLS,
        intel,
      });

      expect(resolved.valid).toBe(true);
      expect(resolved.totalDurationSec).toBeGreaterThan(20);
      expect(plan.syncBarriers.length).toBeGreaterThanOrEqual(2);
      expect(plan.planBBranches.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('provides 5 crew members, 3 fences, 10 tools, 5 countermeasures, 4 upgrades, and 5 story beats', () => {
    const crew = createInitialCrew();
    expect(Object.keys(crew)).toEqual(['mara', 'jupp', 'jule', 'toni', 'rico']);
    expect(crew.mara.isPlayerControlled).toBe(true);
    expect(crew.jupp.skills.locks).toBeGreaterThanOrEqual(9);
    expect(crew.jule.skills.electronics).toBeGreaterThanOrEqual(9);
    expect(crew.toni.skills.driving).toBeGreaterThanOrEqual(9);
    expect(crew.rico.traits.greed).toBeGreaterThanOrEqual(70);

    expect(Object.keys(FENCES)).toHaveLength(3);
    expect(Object.keys(TOOLS)).toHaveLength(12);
    expect(TOOLS.mask).toBeDefined();
    expect(TOOLS.dark_clothing).toBeDefined();
    expect(COUNTERMEASURES.length).toBeGreaterThanOrEqual(5);
    expect(createInitialWorkshopUpgrades()).toHaveLength(4);
    expect(createInitialStoryBeats()).toHaveLength(5);
  });
});
