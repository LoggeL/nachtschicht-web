import {
  CaseFileLedger,
  CaseFileStatus,
  CollectedLootItem,
  CountermeasureDef,
  CrewId,
  CrewMember,
  CrewPayoutEntry,
  EvidenceDraft,
  EvidenceItem,
  FenceDef,
  HeistDebrief,
  HeistTarget,
  LiveExecutionState,
} from './types';

// ============================================================================
// Die Akte „Nachtschicht“ (Inspectora Núria Ferrer) + Hehler & Loyalty Ledger
// ============================================================================

export function computeCaseStatus(heat: number): CaseFileStatus {
  if (heat >= 80) return 'warrant_imminent';
  if (heat >= 50) return 'tightening_net';
  if (heat >= 20) return 'active_inquiry';
  return 'cold';
}

export function computeHeatFromEvidence(evidence: EvidenceItem[]): number {
  const total = evidence.reduce(
    (acc, item) => acc + (item.mitigated ? Math.round(item.severity * 0.2) : item.severity),
    0
  );
  return Math.max(0, Math.min(100, total));
}

export function buildFerrerNote(
  heat: number,
  evidence: EvidenceItem[],
  lastTargetName?: string
): string {
  const activeCount = evidence.filter((e) => !e.mitigated).length;
  if (heat >= 80) {
    return `Haftbefehl vorbereitet. ${activeCount} offene Spuren verknüpfen die Täter direkt mit Securion-Anlagen${lastTargetName ? ` und ${lastTargetName}` : ''}.`;
  }
  if (heat >= 50) {
    return `Das Muster ist unverkennbar: professionelle Taktung, Insider-Wissen über Securion-Wartungsfenster. ${activeCount} belastbare Indizien in der Akte.`;
  }
  if (heat >= 20) {
    return `Akte „Nachtschicht“ eröffnet${lastTargetName ? ` nach Vorfall bei ${lastTargetName}` : ''}. Keine Zufallstäter — die Mannschaft arbeitet nach festem Zeitplan.`;
  }
  return 'Bisher nur Gerüchte aus der Hafenmeile von Salou. Noch keine verwertbare Spur.';
}

export function createInitialCaseFile(): CaseFileLedger {
  return {
    caseNumber: 'MOSSOS-TGN-2026-NS',
    leadInvestigator: 'Inspectora Núria Ferrer',
    heat: 8,
    status: 'cold',
    evidence: [
      {
        id: 'ev_initial_securion',
        type: 'alarm_signature',
        title: 'Vermerk: Kündigung Mara Voss (Securion)',
        detail:
          'Personalakte von Securion Tarragona liegt der Polizei als Hintergrundnotiz vor. Noch kein Tatverdacht.',
        targetId: 'casa_oro',
        targetName: 'Securion Südeuropa',
        collectedOnDay: 1,
        severity: 8,
        mitigated: false,
      },
    ],
    countermeasuresUsed: 0,
    lastFerrerNote:
      'Routinemeldung von Securion eingegangen. Noch kein Bezug zu aktuellen Einbrüchen in Salou.',
  };
}

/**
 * Generates persistent EvidenceItems for Die Akte from a finished LiveExecutionState
 * and escape outcome. Clean ghost runs produce almost zero evidence; alarms,
 * camera sightings, missing gloves, recognized getaway cars, or violence spike Die Akte!
 */
export function generateEvidenceFromHeist(params: {
  target: HeistTarget;
  live: LiveExecutionState;
  escapeVehicleRecognized: boolean;
  escaped: boolean;
  day: number;
  fence: FenceDef;
  crewById: Record<CrewId, CrewMember>;
  assignedCrewIds: CrewId[];
}): EvidenceItem[] {
  const {
    target,
    live,
    escapeVehicleRecognized,
    escaped,
    day,
    fence,
    crewById,
    assignedCrewIds,
  } = params;

  const drafts: EvidenceDraft[] = [...live.pendingEvidence];
  const seenTypes = new Set(drafts.map((d) => `${d.type}:${d.relatedCrewId ?? ''}`));

  const addDraft = (draft: EvidenceDraft) => {
    const key = `${draft.type}:${draft.relatedCrewId ?? ''}`;
    if (seenTypes.has(key)) return;
    seenTypes.add(key);
    drafts.push(draft);
  };

  // Alarm signature
  if (live.alarmLevel === 'alarm' || live.alarmLevel === 'lockdown') {
    addDraft({
      type: 'alarm_signature',
      title: `Alarmprotokoll ${target.name}`,
      detail:
        'Zeitstempel der Securion-Anlage belegen gezielte Manipulation kurz vor Auslösung.',
      targetId: target.id,
      severity: live.alarmLevel === 'lockdown' ? 18 : 12,
    });
  }

  // Recognized getaway car
  if (escapeVehicleRecognized || live.alarmLevel === 'lockdown') {
    addDraft({
      type: 'recognized_car',
      title: 'Fluchtfahrzeug gesichtet',
      detail: `Streifenwagen notierten Farbe und Silhouette des Fluchtwagens nahe ${target.city}.`,
      targetId: target.id,
      severity: 15,
    });
  }

  // Missing gloves -> fingerprints on high-trace nodes
  for (const cid of assignedCrewIds) {
    const member = crewById[cid];
    if (!member) continue;
    if (!member.equippedTools.includes('gloves') && live.completedNodeIds.length > 0) {
      addDraft({
        type: 'fingerprints',
        title: `Teil-Fingerabdrücke (${member.codename})`,
        detail: `${member.name} arbeitete ohne Handschuhe an Schlössern oder Vitrinen in ${target.name}.`,
        targetId: target.id,
        severity: 10,
        relatedCrewId: cid,
      });
    }
    // Low-loyalty chatter
    if (member.traits.loyalty < 45 && !member.isPlayerControlled) {
      addDraft({
        type: 'crew_chatter',
        title: `Kneipengerüchte (${member.codename})`,
        detail: `${member.name} prahlte in einer Bar in Salou über den Coup — Informanten meldeten es Ferrer.`,
        targetId: target.id,
        severity: 12,
        relatedCrewId: cid,
      });
    }
  }

  // Violence dramatically spikes Die Akte (per concept: "Gewalt ist möglich, aber teuer")
  if (live.violenceUsed) {
    addDraft({
      type: 'violence_report',
      title: 'Körperverletzung / Waffeneinsatz',
      detail:
        'Sonderkommission wird eingeschaltet. Inspectora Ferrer erhält zusätzliche Ermittler.',
      targetId: target.id,
      severity: 28,
    });
  }

  // Fence heat
  if (fence.heatGenerated > 0 && live.totalLootEur > 0) {
    addDraft({
      type: 'witness',
      title: `Hehler-Spur (${fence.name})`,
      detail: `Beutestücke aus ${target.name} tauchten über ${fence.location} im Umlauf auf.`,
      targetId: target.id,
      severity: fence.heatGenerated,
    });
  }

  // Failed escape -> major witness/arrest trace
  if (!escaped) {
    addDraft({
      type: 'witness',
      title: 'Polizeikontakt bei der Flucht',
      detail: 'Fluchtfahrzeug musste aufgegeben werden — direkte Fahndungsspuren gesichert.',
      targetId: target.id,
      severity: 20,
    });
  }

  return drafts.map((d, idx) => ({
    id: `ev_${target.id}_${day}_${idx}_${d.type}`,
    type: d.type,
    title: d.title,
    detail: d.detail,
    targetId: target.id,
    targetName: target.name,
    collectedOnDay: day,
    severity: d.severity,
    mitigated: false,
    relatedCrewId: d.relatedCrewId,
  }));
}

export function appendEvidenceToCaseFile(
  caseFile: CaseFileLedger,
  newItems: EvidenceItem[],
  lastTargetName?: string
): CaseFileLedger {
  const merged = [...newItems, ...caseFile.evidence];
  const heat = computeHeatFromEvidence(merged);
  return {
    ...caseFile,
    evidence: merged,
    heat,
    status: computeCaseStatus(heat),
    lastFerrerNote: buildFerrerNote(heat, merged, lastTargetName),
  };
}

/**
 * Applies a playable countermeasure (Wagen umlackieren, Untertauchen, etc.)
 * to mitigate matching evidence items and reduce Inspectora Ferrer's heat.
 */
export function applyCountermeasureToCaseFile(
  caseFile: CaseFileLedger,
  cm: CountermeasureDef,
  hasSprayBoothUpgrade: boolean
): {
  caseFile: CaseFileLedger;
  effectiveCostEur: number;
  mitigatedCount: number;
} {
  const effectiveCostEur =
    cm.id === 'repaint_car' && hasSprayBoothUpgrade
      ? Math.round(cm.costEur * 0.4)
      : cm.costEur;

  let mitigatedCount = 0;
  const updatedEvidence = caseFile.evidence.map((item) => {
    if (!item.mitigated && cm.mitigatesTypes.includes(item.type)) {
      mitigatedCount += 1;
      return {
        ...item,
        mitigated: true,
        mitigationLabel: cm.name,
      };
    }
    return item;
  });

  const evidenceHeat = computeHeatFromEvidence(updatedEvidence);
  const directReducedHeat = Math.max(0, caseFile.heat - cm.heatReduction);
  const heat = Math.min(evidenceHeat, directReducedHeat);

  return {
    effectiveCostEur,
    mitigatedCount,
    caseFile: {
      ...caseFile,
      evidence: updatedEvidence,
      heat,
      status: computeCaseStatus(heat),
      countermeasuresUsed: caseFile.countermeasuresUsed + 1,
      lastFerrerNote: buildFerrerNote(heat, updatedEvidence),
    },
  };
}

/**
 * Computes fence payout based on preferred loot categories vs base rate.
 */
export function calculateFencePayout(
  loot: CollectedLootItem[],
  fence: FenceDef
): { grossEur: number; payoutEur: number } {
  let grossEur = 0;
  let payoutEur = 0;
  for (const item of loot) {
    grossEur += item.valueEur;
    const rate = fence.preferredCategories.includes(item.category)
      ? fence.preferredRate
      : fence.baseRate;
    payoutEur += Math.round(item.valueEur * rate);
  }
  return { grossEur, payoutEur };
}

/**
 * Determines which non-player accomplice has the lowest loyalty for the Act 3
 * traitor reveal (Lars's concept: "der Komplize mit der niedrigsten Loyalität").
 */
export function findAct3TraitorCandidate(
  crew: Record<CrewId, CrewMember>
): CrewId | undefined {
  const candidates = Object.values(crew).filter(
    (c) =>
      !c.isPlayerControlled &&
      c.id !== 'jupp' && // Jupp gets arrested in Act 3; one of the other recruited accomplices is bought by Lassen
      c.recruited &&
      c.status === 'available'
  );
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => a.traits.loyalty - b.traits.loyalty);
  return candidates[0].id;
}

/**
 * Builds the full HeistDebrief payload and computes crew cuts, XP, and loyalty changes.
 */
export function settleHeistDebrief(params: {
  target: HeistTarget;
  live: LiveExecutionState;
  escaped: boolean;
  escapeVehicleRecognized: boolean;
  fence: FenceDef;
  crewById: Record<CrewId, CrewMember>;
  assignedCrewIds: CrewId[];
  caseFile: CaseFileLedger;
  day: number;
  completedTargetIds: HeistTarget['id'][];
}): {
  debrief: HeistDebrief;
  updatedCaseFile: CaseFileLedger;
  updatedCrew: Record<CrewId, CrewMember>;
} {
  const {
    target,
    live,
    escaped,
    escapeVehicleRecognized,
    fence,
    crewById,
    assignedCrewIds,
    caseFile,
    day,
    completedTargetIds,
  } = params;

  const success = escaped && live.totalLootEur > 0;
  const cleanGhostBonus =
    success && live.alarmLevel === 'silent' && !live.violenceUsed;

  const { grossEur, payoutEur: basePayout } = calculateFencePayout(
    success ? live.collectedLoot : [],
    fence
  );
  // Clean ghost run earns a 12% clean-merchandise premium from the fence
  const fencePayoutEur = cleanGhostBonus
    ? Math.round(basePayout * 1.12)
    : basePayout;

  const crewCuts: CrewPayoutEntry[] = [];
  let totalCrewCutsEur = 0;

  const updatedCrew: Record<CrewId, CrewMember> = { ...crewById };

  for (const cid of assignedCrewIds) {
    const member = crewById[cid];
    if (!member) continue;
    const liveMember = live.crew[cid];

    const amountEur =
      !member.isPlayerControlled && success
        ? Math.round((fencePayoutEur * member.cutPercent) / 100)
        : 0;
    totalCrewCutsEur += amountEur;

    let loyaltyDelta = 0;
    if (!member.isPlayerControlled) {
      if (success && cleanGhostBonus) loyaltyDelta = +10;
      else if (success) loyaltyDelta = +5;
      else loyaltyDelta = -12;
      if (liveMember?.state === 'caught') loyaltyDelta -= 18;
    }

    const xpGain = success ? (cleanGhostBonus ? 140 : 100) : 35;

    const newXp = member.xp + xpGain;
    const newLevel = 1 + Math.floor(newXp / 200);
    const leveledUp = newLevel > member.level;

    // Slight skill growth on level up
    const newSkills = { ...member.skills };
    if (leveledUp) {
      const topSkill = (Object.keys(newSkills) as Array<keyof typeof newSkills>).sort(
        (a, b) => newSkills[b] - newSkills[a]
      )[0];
      newSkills[topSkill] = Math.min(10, newSkills[topSkill] + 1);
    }

    updatedCrew[cid] = {
      ...member,
      xp: newXp,
      level: newLevel,
      heistsCompleted: success ? member.heistsCompleted + 1 : member.heistsCompleted,
      skills: newSkills,
      traits: {
        ...member.traits,
        loyalty: Math.max(
          0,
          Math.min(100, member.traits.loyalty + loyaltyDelta)
        ),
      },
    };

    if (!member.isPlayerControlled) {
      crewCuts.push({
        crewId: cid,
        name: member.name,
        cutPercent: member.cutPercent,
        amountEur,
        loyaltyDelta,
        xpGain,
      });
    }
  }

  const maraNetEur = Math.max(0, fencePayoutEur - totalCrewCutsEur);

  const newEvidence = generateEvidenceFromHeist({
    target,
    live,
    escapeVehicleRecognized,
    escaped,
    day,
    fence,
    crewById: updatedCrew,
    assignedCrewIds,
  });

  const updatedCaseFile = appendEvidenceToCaseFile(
    caseFile,
    newEvidence,
    target.name
  );

  // Act 3 traitor reveal happens upon completing Villa Mirador (target 3)
  let traitorRevealedId: CrewId | undefined;
  if (
    success &&
    target.id === 'villa_mirador' &&
    !completedTargetIds.includes('villa_mirador')
  ) {
    traitorRevealedId = findAct3TraitorCandidate(updatedCrew);
    if (traitorRevealedId) {
      updatedCrew[traitorRevealedId] = {
        ...updatedCrew[traitorRevealedId],
        status: 'traitor',
      };
    }
  }

  const debrief: HeistDebrief = {
    targetId: target.id,
    targetName: target.name,
    success,
    cleanGhostBonus,
    grossLootEur: grossEur,
    fenceId: fence.id,
    fenceName: fence.name,
    fencePayoutEur,
    crewCuts,
    maraNetEur,
    newEvidence,
    heatBefore: caseFile.heat,
    heatAfter: updatedCaseFile.heat,
    deviationsCount: live.deviations.length,
    elapsedSec: Math.round(live.elapsedSec),
    storyBeatUnlockedId: success ? target.storyBeatOnComplete : undefined,
    traitorRevealedId,
    finaleEndingAvailable: success && target.id === 'schatzkammer_dresden',
  };

  return { debrief, updatedCaseFile, updatedCrew };
}
