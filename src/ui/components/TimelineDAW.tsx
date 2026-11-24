import { useMemo } from 'react';
import {
  AlertTriangle,
  Car,
  Clock,
  FastForward,
  Link2,
  Pause,
  Play,
  Plus,
  Rewind,
  RotateCcw,
  Trash2,
  Zap,
  ZapOff,
} from 'lucide-react';
import {
  ActionBlock,
  CrewId,
  HeistTarget,
  RehearsalConflict,
  RehearsalSnapshot,
  ResolvedPlan,
} from '../../sim/types';
import { useGameStore } from '../../state/store';
import { ACTION_COLORS, formatEur, formatShortSec, formatTimeSec } from '../assets';
import { CharacterAvatar } from './CharacterAvatar';

interface TimelineDAWProps {
  target: HeistTarget;
  resolvedPlan: ResolvedPlan;
  snapshot: RehearsalSnapshot;
  allConflicts: RehearsalConflict[];
  selectedBlockId: string | null;
  syncSourceBlockId: string | null;
  onSelectBlock: (blockId: string | null) => void;
  onStartSyncLink: (blockId: string) => void;
  onCompleteSyncLink: (targetBlockId: string) => void;
  onCancelSyncLink: () => void;
}

const TRACK_ROW_HEIGHT = 44; // px per crew lane for crisp SVG barrier alignment

export function TimelineDAW({
  target,
  resolvedPlan,
  snapshot,
  allConflicts,
  selectedBlockId,
  syncSourceBlockId,
  onSelectBlock,
  onStartSyncLink,
  onCompleteSyncLink,
  onCancelSyncLink,
}: TimelineDAWProps) {
  const crew = useGameStore((s) => s.crew);
  const selectedCrewId = useGameStore((s) => s.selectedCrewId);
  const rehearsalTimeSec = useGameStore((s) => s.rehearsalTimeSec);
  const rehearsalPlaying = useGameStore((s) => s.rehearsalPlaying);
  const rehearsalSpeed = useGameStore((s) => s.rehearsalSpeed);

  const setSelectedCrewId = useGameStore((s) => s.setSelectedCrewId);
  const setRehearsalTime = useGameStore((s) => s.setRehearsalTime);
  const setRehearsalPlaying = useGameStore((s) => s.setRehearsalPlaying);
  const setRehearsalSpeed = useGameStore((s) => s.setRehearsalSpeed);
  const addPlanBlock = useGameStore((s) => s.addPlanBlock);
  const clearCrewTrack = useGameStore((s) => s.clearCrewTrack);
  const toggleCrewOnPlan = useGameStore((s) => s.toggleCrewOnPlan);

  const plan = resolvedPlan.plan;
  const totalDur = Math.max(15, resolvedPlan.totalDurationSec);
  const axisMaxSec = Math.max(45, Math.ceil((totalDur + 4) / 10) * 10);

  const rulerTicks = useMemo(() => {
    const step = axisMaxSec > 90 ? 15 : 10;
    const ticks: number[] = [];
    for (let t = 0; t <= axisMaxSec; t += step) ticks.push(t);
    return ticks;
  }, [axisMaxSec]);

  const toPct = (sec: number) => Math.max(0, Math.min(100, (sec / axisMaxSec) * 100));

  const playheadPct = toPct(rehearsalTimeSec);

  const handleRulerPointer = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setRehearsalPlaying(false);
    setRehearsalTime(Math.round(ratio * axisMaxSec * 10) / 10);
  };

  // Precompute Sync Barrier coordinates across tracks (viewBox 0..1000 horizontally, px vertically)
  const syncLines = useMemo(() => {
    const laneIndexByCrew: Record<string, number> = {};
    plan.assignedCrewIds.forEach((cid, idx) => {
      laneIndexByCrew[cid] = idx;
    });

    return plan.syncBarriers
      .map((sb) => {
        const fromBlock = resolvedPlan.blocksById[sb.fromBlockId];
        const toBlock = resolvedPlan.blocksById[sb.toBlockId];
        if (!fromBlock || !toBlock) return null;

        const fromLane = laneIndexByCrew[fromBlock.crewId];
        const toLane = laneIndexByCrew[toBlock.crewId];
        if (fromLane === undefined || toLane === undefined) return null;

        const fromEndSec =
          fromBlock.computedEndSec ?? fromBlock.startSec + fromBlock.durationSec;
        const toStartSec = toBlock.computedStartSec ?? toBlock.startSec;

        const x1 = (fromEndSec / axisMaxSec) * 1000;
        const y1 = fromLane * TRACK_ROW_HEIGHT + TRACK_ROW_HEIGHT / 2;
        const x2 = (toStartSec / axisMaxSec) * 1000;
        const y2 = toLane * TRACK_ROW_HEIGHT + TRACK_ROW_HEIGHT / 2;
        const midX = (x1 + x2) / 2;

        return {
          id: sb.id,
          label: sb.label,
          x1,
          y1,
          x2,
          y2,
          path: `M ${x1.toFixed(1)} ${y1.toFixed(1)} C ${midX.toFixed(1)} ${y1.toFixed(1)}, ${midX.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }, [plan.syncBarriers, plan.assignedCrewIds, resolvedPlan.blocksById, axisMaxSec]);

  const unassignedRecruitedCrew = (Object.keys(crew) as CrewId[]).filter(
    (cid) =>
      crew[cid].recruited &&
      crew[cid].status === 'available' &&
      !plan.assignedCrewIds.includes(cid)
  );

  const svgTotalHeight = Math.max(TRACK_ROW_HEIGHT, plan.assignedCrewIds.length * TRACK_ROW_HEIGHT);

  const handleBlockClick = (block: ActionBlock) => {
    if (syncSourceBlockId) {
      if (syncSourceBlockId === block.id) {
        onCancelSyncLink();
      } else {
        onCompleteSyncLink(block.id);
      }
      return;
    }
    setSelectedCrewId(block.crewId);
    onSelectBlock(block.id);
  };

  return (
    <div className="noir-card rounded-xl flex flex-col h-full min-h-0 overflow-hidden border-slate-800">
      {/* Probelauf Video-Recorder Toolbar */}
      <div className="px-3.5 py-2 border-b border-slate-800 bg-slate-950/90 flex flex-wrap items-center justify-between gap-2 shrink-0">
        {/* Transport Controls */}
        <div className="flex items-center gap-1.5">
          <span className="font-mono-tech text-[10px] uppercase tracking-widest text-sky-300 mr-1 hidden sm:inline">
            PROBELAUF
          </span>

          <button
            type="button"
            onClick={() => {
              setRehearsalPlaying(false);
              setRehearsalTime(0);
            }}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white cursor-pointer"
            title="Zurückspulen (0:00)"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => {
              setRehearsalPlaying(false);
              setRehearsalTime(Math.max(0, rehearsalTimeSec - 2));
            }}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white cursor-pointer"
            title="-2 Sekunden"
          >
            <Rewind className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={() => {
              if (!rehearsalPlaying && rehearsalTimeSec >= totalDur - 0.1) {
                setRehearsalTime(0);
              }
              setRehearsalPlaying(!rehearsalPlaying);
            }}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-display font-bold text-xs transition-colors cursor-pointer ${
              rehearsalPlaying
                ? 'bg-sky-400 text-slate-950'
                : 'bg-amber-500 hover:bg-amber-400 text-slate-950'
            }`}
          >
            {rehearsalPlaying ? (
              <>
                <Pause className="w-3.5 h-3.5 fill-slate-950" />
                <span>Pause</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-slate-950" />
                <span>Abspielen</span>
              </>
            )}
          </button>

          <button
            type="button"
            onClick={() => {
              setRehearsalPlaying(false);
              setRehearsalTime(Math.min(axisMaxSec, rehearsalTimeSec + 2));
            }}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white cursor-pointer"
            title="+2 Sekunden"
          >
            <FastForward className="w-3.5 h-3.5" />
          </button>

          {/* Speed Selector */}
          <div className="flex items-center bg-slate-900 rounded-lg border border-slate-800 p-0.5 ml-1">
            {([1, 2, 4] as const).map((spd) => (
              <button
                key={spd}
                type="button"
                onClick={() => setRehearsalSpeed(spd)}
                className={`px-2 py-0.5 rounded font-mono-tech text-[10px] font-bold cursor-pointer ${
                  rehearsalSpeed === spd
                    ? 'bg-sky-500 text-slate-950'
                    : 'text-slate-400 hover:text-white'
                }`}
              >
                {spd}×
              </button>
            ))}
          </div>

          {/* Timecode Display */}
          <div className="ml-1.5 px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 font-mono-tech text-xs text-sky-200">
            <span className="text-white font-bold">{formatTimeSec(rehearsalTimeSec)}</span>
            <span className="text-slate-500"> / {formatTimeSec(totalDur)}</span>
          </div>
        </div>

        {/* Live Snapshot Readouts */}
        <div className="flex items-center gap-2 text-[11px] font-mono-tech">
          <span
            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded border ${
              snapshot.powerDisabled
                ? 'bg-cyan-500/15 border-cyan-400/50 text-cyan-200'
                : 'bg-slate-900 border-slate-700 text-slate-400'
            }`}
          >
            {snapshot.powerDisabled ? <ZapOff className="w-3 h-3" /> : <Zap className="w-3 h-3" />}
            {snapshot.powerDisabled ? 'BLACKOUT' : 'STROM AN'}
          </span>

          <span className="px-2 py-0.5 rounded bg-amber-500/15 border border-amber-400/40 text-amber-200">
            Beute: {formatEur(snapshot.projectedLootEur)}
          </span>

          {allConflicts.length > 0 && (
            <button
              type="button"
              onClick={() => {
                setRehearsalPlaying(false);
                setRehearsalTime(allConflicts[0].timeSec);
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-rose-500/20 border border-rose-400/50 text-rose-200 hover:bg-rose-500/30 cursor-pointer"
              title="Zum erkannten Konflikt springen"
            >
              <AlertTriangle className="w-3 h-3" />
              <span>{allConflicts.length} Konflikt(e)</span>
            </button>
          )}
        </div>

        {/* Quick-Add Track Actions */}
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              addPlanBlock({
                crewId: selectedCrewId,
                type: 'wait',
                label: 'Abwarten (5s)',
                durationSec: 5,
              })
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 cursor-pointer"
            title={`Warteblock zu ${crew[selectedCrewId]?.name} hinzufügen`}
          >
            <Clock className="w-3 h-3 text-sky-400" />
            <span>+ Warten</span>
          </button>

          <button
            type="button"
            onClick={() =>
              addPlanBlock({
                crewId: selectedCrewId,
                type: 'extract',
                label: 'Zum Fluchtwagen',
                targetPos: target.getawayPos,
                floor: 0,
              })
            }
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-400/45 text-[11px] text-emerald-200 cursor-pointer"
            title={`Fluchtwagen-Rückzug zu ${crew[selectedCrewId]?.name} hinzufügen`}
          >
            <Car className="w-3 h-3" />
            <span>+ Flucht</span>
          </button>

          <button
            type="button"
            onClick={() => clearCrewTrack(selectedCrewId)}
            className="p-1.5 rounded-lg bg-slate-900 hover:bg-rose-950/70 border border-slate-700 hover:border-rose-500/40 text-slate-400 hover:text-rose-300 cursor-pointer"
            title={`Spur von ${crew[selectedCrewId]?.name} leeren`}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Sync-Link Banner when linking two blocks */}
      {syncSourceBlockId && (
        <div className="px-4 py-1.5 bg-amber-500/20 border-b border-amber-400/50 flex items-center justify-between text-xs text-amber-100 shrink-0">
          <span className="flex items-center gap-2 font-semibold">
            <Link2 className="w-3.5 h-3.5 text-amber-300" />
            Synchronpunkt-Modus: Klicke den Ziel-Block auf einer anderen Spur, der auf „
            {resolvedPlan.blocksById[syncSourceBlockId]?.label}“ warten soll.
          </span>
          <button
            type="button"
            onClick={onCancelSyncLink}
            className="px-2 py-0.5 rounded bg-slate-950/60 hover:bg-slate-900 text-amber-200 text-[11px] cursor-pointer"
          >
            Abbrechen
          </button>
        </div>
      )}

      {/* Draggable Scrubber + Time Ruler Row */}
      <div className="flex items-center border-b border-slate-800/90 bg-slate-950/60 shrink-0">
        <div className="w-44 shrink-0 px-3 py-1.5 border-r border-slate-800 font-mono-tech text-[10px] uppercase tracking-wider text-slate-400">
          Spur · Komplize
        </div>

        <div className="flex-1 relative px-2 py-1.5">
          {/* Ruler click zone + ticks */}
          <div
            onClick={handleRulerPointer}
            className="relative h-5 cursor-ew-resize select-none"
          >
            {rulerTicks.map((t) => (
              <div
                key={t}
                className="absolute top-0 bottom-0 flex flex-col justify-between"
                style={{ left: `${toPct(t)}%` }}
              >
                <span className="font-mono-tech text-[9px] text-slate-400 -translate-x-1/2">
                  {t}s
                </span>
                <span className="w-px h-1.5 bg-slate-700" />
              </div>
            ))}

            {/* Pre-scanned conflict ticks on ruler */}
            {allConflicts.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setRehearsalPlaying(false);
                  setRehearsalTime(c.timeSec);
                }}
                title={c.message}
                className="absolute top-0.5 w-2.5 h-2.5 -translate-x-1/2 rotate-45 bg-rose-500 border border-rose-200 hover:scale-125 transition-transform cursor-pointer z-20"
                style={{ left: `${toPct(c.timeSec)}%` }}
              />
            ))}

            {/* Playhead triangle */}
            <div
              className="absolute bottom-0 -translate-x-1/2 w-0 h-0 border-l-[5px] border-r-[5px] border-t-[6px] border-l-transparent border-r-transparent border-t-sky-400 pointer-events-none z-20"
              style={{ left: `${playheadPct}%` }}
            />
          </div>

          {/* Native Accessible Range Scrubber */}
          <input
            type="range"
            min={0}
            max={axisMaxSec}
            step={0.1}
            value={Math.min(axisMaxSec, rehearsalTimeSec)}
            onChange={(e) => {
              setRehearsalPlaying(false);
              setRehearsalTime(parseFloat(e.target.value));
            }}
            aria-label="Probelauf Zeitleiste"
            className="ns-scrubber w-full h-2 block mt-0.5"
          />
        </div>
      </div>

      {/* Multi-Track Crew Lanes + SVG Sync Overlay */}
      <div className="flex-1 min-h-0 overflow-y-auto ns-scroll relative">
        <div className="flex min-h-full relative">
          {/* Left Column: Crew Track Headers */}
          <div className="w-44 shrink-0 border-r border-slate-800 bg-slate-950/50">
            {plan.assignedCrewIds.map((cid) => {
              const member = crew[cid];
              const isSelected = selectedCrewId === cid;
              const ghost = snapshot.crew.find((g) => g.crewId === cid);
              const count = (resolvedPlan.orderedBlocksByCrew[cid] ?? []).length;

              return (
                <button
                  key={cid}
                  type="button"
                  onClick={() => setSelectedCrewId(cid)}
                  style={{ height: `${TRACK_ROW_HEIGHT}px` }}
                  className={`w-full px-2.5 flex items-center gap-2 border-b border-slate-800/80 text-left transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-sky-500/15 border-l-2 border-l-sky-400'
                      : 'hover:bg-slate-900/70 border-l-2 border-l-transparent'
                  }`}
                >
                  <CharacterAvatar
                    portraitKey={member.portraitKey}
                    name={member.name}
                    accentColor={member.accentColor}
                    size="xs"
                    ring={isSelected}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-xs font-bold text-white truncate">
                        {member.name.split(' ')[0]}
                      </span>
                      <span className="font-mono-tech text-[9px] text-slate-400">
                        {count} Blk
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400 truncate">
                      {ghost?.status === 'waiting_sync'
                        ? '⏳ Wartet Sync'
                        : ghost?.status === 'extracted'
                          ? '✓ Im Wagen'
                          : member.codename}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Right Area: Track Timeline Grid + Action Blocks + Sync Barriers SVG + Playhead */}
          <div className="flex-1 relative px-2">
            <div className="relative" style={{ height: `${svgTotalHeight}px` }}>
              {/* Vertical grid lines */}
              {rulerTicks.map((t) => (
                <div
                  key={`grid_${t}`}
                  className="absolute top-0 bottom-0 w-px bg-slate-800/65 pointer-events-none"
                  style={{ left: `${toPct(t)}%` }}
                />
              ))}

              {/* Crew Lanes */}
              {plan.assignedCrewIds.map((cid, idx) => {
                const blocks = resolvedPlan.orderedBlocksByCrew[cid] ?? [];
                const isSelectedTrack = selectedCrewId === cid;
                const member = crew[cid];

                return (
                  <div
                    key={`lane_${cid}`}
                    onClick={() => setSelectedCrewId(cid)}
                    style={{
                      top: `${idx * TRACK_ROW_HEIGHT}px`,
                      height: `${TRACK_ROW_HEIGHT}px`,
                    }}
                    className={`absolute left-0 right-0 border-b border-slate-800/80 transition-colors ${
                      isSelectedTrack ? 'bg-sky-500/[0.05]' : ''
                    }`}
                  >
                    {blocks.map((block) => {
                      const bStart = block.computedStartSec ?? block.startSec;
                      const bEnd = block.computedEndSec ?? bStart + block.durationSec;
                      const leftPct = toPct(bStart);
                      const widthPct = Math.max(2.6, toPct(bEnd) - leftPct);
                      const palette = ACTION_COLORS[block.type];
                      const isSel = selectedBlockId === block.id;
                      const isSyncSource = syncSourceBlockId === block.id;
                      const waitedForSync = bStart > block.startSec + 0.1;
                      const hasSyncOut = plan.syncBarriers.some(
                        (sb) => sb.fromBlockId === block.id
                      );
                      const hasSyncIn = plan.syncBarriers.some(
                        (sb) => sb.toBlockId === block.id
                      );

                      return (
                        <div
                          key={block.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            handleBlockClick(block);
                          }}
                          style={{
                            left: `${leftPct}%`,
                            width: `${widthPct}%`,
                          }}
                          title={`${block.label} (${formatShortSec(bStart)}–${formatShortSec(bEnd)}, Lärm ${block.estimatedNoise}, Spur ${block.estimatedTraceRisk})`}
                          className={`group absolute top-1.5 bottom-1.5 rounded-md border px-1.5 flex items-center justify-between gap-1 overflow-hidden cursor-pointer transition-all z-10 ${
                            palette.bg
                          } ${palette.border} ${palette.text} ${
                            isSel
                              ? 'ring-2 ring-amber-300 shadow-lg shadow-amber-500/20 z-20'
                              : isSyncSource
                                ? 'ring-2 ring-amber-400 animate-pulse z-20'
                                : 'hover:brightness-125'
                          }`}
                        >
                          {/* Sync waiting indicator bar on left edge */}
                          {(waitedForSync || hasSyncIn) && (
                            <span className="absolute left-0 top-0 bottom-0 w-1 bg-amber-400" />
                          )}

                          <span className="text-[10px] font-semibold truncate pl-0.5 leading-none">
                            {block.label}
                          </span>

                          <div className="flex items-center gap-1 shrink-0">
                            <span className="font-mono-tech text-[9px] opacity-80 hidden sm:inline">
                              {Math.round(block.durationSec)}s
                            </span>
                            {!syncSourceBlockId && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onStartSyncLink(block.id);
                                }}
                                title="Synchronpunkt von diesem Block aus verbinden"
                                className={`p-0.5 rounded hover:bg-amber-400 hover:text-slate-950 transition-colors cursor-pointer ${
                                  hasSyncOut
                                    ? 'text-amber-300'
                                    : 'opacity-0 group-hover:opacity-100 text-slate-200'
                                }`}
                              >
                                <Link2 className="w-2.5 h-2.5" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {blocks.length === 0 && (
                      <div className="h-full flex items-center pl-3 text-[11px] font-mono-tech text-slate-600 pointer-events-none">
                        Klicke einen Knoten im Grundriss, um {member.name.split(' ')[0]} einzuteilen…
                      </div>
                    )}
                  </div>
                );
              })}

              {/* SVG Sync Barrier Connectors across Tracks */}
              <svg
                viewBox={`0 0 1000 ${svgTotalHeight}`}
                preserveAspectRatio="none"
                className="absolute inset-0 w-full h-full pointer-events-none z-20"
              >
                <defs>
                  <marker
                    id="syncArrow"
                    viewBox="0 0 10 10"
                    refX="8"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 1 L 10 5 L 0 9 z" fill="#fbbf24" />
                  </marker>
                </defs>
                {syncLines.map((ln) => (
                  <g key={ln.id}>
                    <path
                      d={ln.path}
                      fill="none"
                      stroke="#f59e0b"
                      strokeOpacity="0.35"
                      strokeWidth="5"
                      vectorEffect="non-scaling-stroke"
                    />
                    <path
                      d={ln.path}
                      fill="none"
                      stroke="#fbbf24"
                      strokeWidth="2"
                      strokeDasharray="5 3"
                      markerEnd="url(#syncArrow)"
                      vectorEffect="non-scaling-stroke"
                    />
                    <circle
                      cx={ln.x1}
                      cy={ln.y1}
                      r="3.5"
                      fill="#fbbf24"
                      stroke="#060b16"
                      strokeWidth="1"
                    />
                  </g>
                ))}
              </svg>

              {/* Glowing Cyan Playhead */}
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-sky-400 shadow-[0_0_10px_rgba(56,189,248,0.9)] pointer-events-none z-30"
                style={{ left: `${playheadPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Mini-Strip: Add extra recruited crew to plan */}
      {unassignedRecruitedCrew.length > 0 && (
        <div className="px-3.5 py-1.5 border-t border-slate-800/80 bg-slate-950/75 flex items-center gap-2 shrink-0">
          <span className="font-mono-tech text-[10px] uppercase text-slate-400">
            Weitere Komplizen:
          </span>
          {unassignedRecruitedCrew.map((cid) => (
            <button
              key={cid}
              type="button"
              onClick={() => toggleCrewOnPlan(cid)}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-900 hover:bg-slate-800 border border-slate-700 text-[11px] text-slate-200 cursor-pointer"
            >
              <Plus className="w-3 h-3 text-amber-400" />
              <span>{crew[cid].name.split(' ')[0]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
