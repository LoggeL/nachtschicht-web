import { useMemo } from 'react';
import {
  CrewId,
  FLOOR_LABELS,
  FloorId,
  HeistTarget,
  IntelState,
  RehearsalSnapshot,
  ResolvedPlan,
  TargetNode,
  Vec2,
} from '../../sim/types';
import { useGameStore } from '../../state/store';
import { formatEur } from '../assets';

const CREW_BADGES: Record<CrewId, string> = {
  mara: 'MA',
  jupp: 'JP',
  jule: 'JL',
  toni: 'TO',
  rico: 'RI',
};

interface BlueprintFloorplanProps {
  target: HeistTarget;
  intel: IntelState;
  resolvedPlan: ResolvedPlan;
  snapshot: RehearsalSnapshot;
  selectedFloor: FloorId;
  selectedNodeId: string | null;
  selectedBlockId: string | null;
  onSelectNode: (nodeId: string) => void;
  onQuickAddNode: (nodeId: string) => void;
}

const ROOM_FILL: Record<string, string> = {
  street: 'rgba(15, 23, 42, 0.55)',
  courtyard: 'rgba(15, 31, 48, 0.5)',
  garden: 'rgba(16, 44, 38, 0.55)',
  lobby: 'rgba(20, 38, 66, 0.65)',
  shop: 'rgba(25, 45, 76, 0.72)',
  gallery: 'rgba(34, 43, 74, 0.75)',
  office: 'rgba(22, 36, 62, 0.72)',
  corridor: 'rgba(18, 32, 56, 0.68)',
  storage: 'rgba(20, 33, 52, 0.72)',
  vault: 'rgba(66, 40, 14, 0.68)',
  roof: 'rgba(18, 28, 48, 0.6)',
  cellar: 'rgba(19, 25, 42, 0.78)',
};

function conePath(
  origin: Vec2,
  headingDeg: number,
  range: number,
  coneDeg: number
): string {
  const half = coneDeg / 2;
  const startRad = ((headingDeg - half) * Math.PI) / 180;
  const endRad = ((headingDeg + half) * Math.PI) / 180;
  const x1 = origin.x + Math.cos(startRad) * range;
  const z1 = origin.z + Math.sin(startRad) * range;
  const x2 = origin.x + Math.cos(endRad) * range;
  const z2 = origin.z + Math.sin(endRad) * range;
  const largeArc = coneDeg > 180 ? 1 : 0;
  return `M ${origin.x.toFixed(2)} ${origin.z.toFixed(2)} L ${x1.toFixed(2)} ${z1.toFixed(2)} A ${range.toFixed(2)} ${range.toFixed(2)} 0 ${largeArc} 1 ${x2.toFixed(2)} ${z2.toFixed(2)} Z`;
}

function getNodeVisual(kind: TargetNode['kind']): {
  glyph: string;
  fill: string;
  stroke: string;
} {
  switch (kind) {
    case 'entry_door':
    case 'entry_service':
    case 'entry_window':
    case 'entry_roof':
    case 'entry_cellar':
      return { glyph: 'E', fill: '#0c4a6e', stroke: '#38bdf8' };
    case 'power_box':
      return { glyph: '⚡', fill: '#164e63', stroke: '#22d3ee' };
    case 'alarm_panel':
      return { glyph: 'A', fill: '#134e4a', stroke: '#2dd4bf' };
    case 'camera':
      return { glyph: 'C', fill: '#312e81', stroke: '#818cf8' };
    case 'safe':
      return { glyph: '€', fill: '#78350f', stroke: '#fbbf24' };
    case 'loot_case':
      return { glyph: '◆', fill: '#713f12', stroke: '#fcd34d' };
    case 'lookout':
      return { glyph: '◉', fill: '#4c1d95', stroke: '#a78bfa' };
    case 'getaway_zone':
      return { glyph: 'V', fill: '#064e3b', stroke: '#34d399' };
    case 'stairs':
      return { glyph: '↕', fill: '#1e293b', stroke: '#94a3b8' };
    case 'hidden_trap':
      return { glyph: '!', fill: '#881337', stroke: '#fb7185' };
    default:
      return { glyph: '•', fill: '#1e293b', stroke: '#cbd5e1' };
  }
}

export function BlueprintFloorplan({
  target,
  intel,
  resolvedPlan,
  snapshot,
  selectedFloor,
  selectedNodeId,
  selectedBlockId,
  onSelectNode,
  onQuickAddNode,
}: BlueprintFloorplanProps) {
  const crew = useGameStore((s) => s.crew);

  const padding = 2.6;
  const vbMinX = target.bounds.minX - padding;
  const vbMinZ = target.bounds.minZ - padding;
  const vbWidth = target.bounds.maxX - target.bounds.minX + padding * 2;
  const vbHeight = target.bounds.maxZ - target.bounds.minZ + padding * 2;

  const floorRooms = useMemo(
    () => target.rooms.filter((r) => r.floor === selectedFloor),
    [target.rooms, selectedFloor]
  );

  const floorWalls = useMemo(
    () => target.walls.filter((w) => w.floor === selectedFloor),
    [target.walls, selectedFloor]
  );

  const floorNodes = useMemo(
    () =>
      target.nodes.filter((n) => {
        if (n.floor !== selectedFloor) return false;
        // Hidden traps strictly obey Fog-of-War!
        if (n.isHiddenHazard && !intel.discoveredNodeIds.includes(n.id)) {
          return false;
        }
        return true;
      }),
    [target.nodes, selectedFloor, intel.discoveredNodeIds]
  );

  const knownGuards = useMemo(
    () =>
      target.guards.filter(
        (g) => g.visibleFromStreet || intel.timedGuardIds.includes(g.id)
      ),
    [target.guards, intel.timedGuardIds]
  );

  const selectedBlockNodeId = selectedBlockId
    ? resolvedPlan.blocksById[selectedBlockId]?.targetNodeId ?? null
    : null;

  return (
    <div className="relative w-full h-full overflow-hidden rounded-xl border border-sky-500/25 blueprint-surface select-none">
      {/* Subtle Top-Left Blueprint Title Stamp */}
      <div className="absolute top-2.5 left-3 z-10 pointer-events-none flex items-center gap-2">
        <span className="px-2 py-0.5 rounded bg-slate-950/80 border border-sky-400/35 font-mono-tech text-[10px] uppercase tracking-widest text-sky-300">
          GRUNDRISS · {FLOOR_LABELS[selectedFloor]}
        </span>
        {snapshot.powerDisabled && (
          <span className="px-2 py-0.5 rounded bg-cyan-500/20 border border-cyan-400/60 font-mono-tech text-[10px] text-cyan-200">
            ⚡ BLACKOUT AKTIV
          </span>
        )}
        {snapshot.alarmBypassed && (
          <span className="px-2 py-0.5 rounded bg-emerald-500/20 border border-emerald-400/60 font-mono-tech text-[10px] text-emerald-200">
            ✓ ALARM ÜBERBRÜCKT
          </span>
        )}
      </div>

      {/* Fog-of-War Reminder Badge */}
      {snapshot.unscoutedWarningCount > 0 && (
        <div className="absolute top-2.5 right-3 z-10 pointer-events-none px-2.5 py-1 rounded-lg bg-amber-950/85 border border-amber-400/45 font-mono-tech text-[10px] text-amber-200">
          ⚠ {snapshot.unscoutedWarningCount} unerkundete Gefahren (Nebel)
        </div>
      )}

      {/* Main Architectural SVG Canvas */}
      <svg
        viewBox={`${vbMinX} ${vbMinZ} ${vbWidth} ${vbHeight}`}
        className="w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <pattern
            id="fogHatch"
            width="1.2"
            height="1.2"
            patternTransform="rotate(45 0 0)"
            patternUnits="userSpaceOnUse"
          >
            <rect width="1.2" height="1.2" fill="rgba(4, 8, 18, 0.58)" />
            <line
              x1="0"
              y1="0"
              x2="0"
              y2="1.2"
              stroke="rgba(148, 163, 184, 0.16)"
              strokeWidth="0.22"
            />
          </pattern>

          <pattern
            id="bpMinorGrid"
            width="2"
            height="2"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M 2 0 L 0 0 0 2"
              fill="none"
              stroke="rgba(56, 189, 248, 0.09)"
              strokeWidth="0.06"
            />
          </pattern>

          <filter id="glowAmber" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="0.35" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Coordinate Grid */}
        <rect
          x={vbMinX}
          y={vbMinZ}
          width={vbWidth}
          height={vbHeight}
          fill="url(#bpMinorGrid)"
        />

        {/* 1. Room Zones & Fog-of-War Overlay */}
        {floorRooms.map((room) => {
          const isScouted = intel.scoutedRoomIds.includes(room.id);
          const fill = ROOM_FILL[room.kind] ?? 'rgba(18, 30, 52, 0.65)';
          return (
            <g key={room.id}>
              <rect
                x={room.x}
                y={room.z}
                width={room.width}
                height={room.depth}
                fill={fill}
                stroke={
                  room.securityZone === 'high_security'
                    ? 'rgba(245, 158, 11, 0.35)'
                    : 'rgba(56, 189, 248, 0.18)'
                }
                strokeWidth="0.09"
              />
              {!isScouted && (
                <rect
                  x={room.x}
                  y={room.z}
                  width={room.width}
                  height={room.depth}
                  fill="url(#fogHatch)"
                />
              )}
              <text
                x={room.x + room.width / 2}
                y={room.z + room.depth / 2 + 0.15}
                textAnchor="middle"
                fill={isScouted ? 'rgba(186, 230, 253, 0.45)' : 'rgba(148, 163, 184, 0.36)'}
                fontSize="0.88"
                fontFamily="IBM Plex Mono, monospace"
                letterSpacing="0.06"
                style={{ pointerEvents: 'none' }}
              >
                {room.name.toUpperCase()}
              </text>
              {!isScouted && (
                <text
                  x={room.x + room.width / 2}
                  y={room.z + room.depth / 2 + 1.15}
                  textAnchor="middle"
                  fill="rgba(245, 158, 11, 0.5)"
                  fontSize="0.58"
                  fontFamily="IBM Plex Mono, monospace"
                  style={{ pointerEvents: 'none' }}
                >
                  [NEBEL · UNERKUNDET]
                </text>
              )}
            </g>
          );
        })}

        {/* 2. Architectural Walls */}
        {floorWalls.map((w) => {
          let stroke = '#cbd5e1';
          let strokeWidth = 0.34;
          let dash: string | undefined;

          if (w.kind === 'interior') {
            stroke = '#64748b';
            strokeWidth = 0.22;
          } else if (w.kind === 'glass') {
            stroke = '#38bdf8';
            strokeWidth = 0.22;
            dash = '0.5 0.25';
          } else if (w.kind === 'fence') {
            stroke = '#f59e0b';
            strokeWidth = 0.16;
            dash = '0.35 0.35';
          } else if (w.kind === 'baroque') {
            stroke = '#e5cfa3';
            strokeWidth = 0.44;
          }

          return (
            <line
              key={w.id}
              x1={w.x1}
              y1={w.z1}
              x2={w.x2}
              y2={w.z2}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinecap="square"
              strokeDasharray={dash}
            />
          );
        })}

        {/* 3. Known Guard Patrol Loops (Dashed Waypoints) */}
        {knownGuards.map((g) => {
          const floorWps = g.waypoints.filter((wp) => wp.floor === selectedFloor);
          if (floorWps.length < 2) return null;
          const pts = floorWps.map((wp) => `${wp.pos.x},${wp.pos.z}`).join(' ');
          return (
            <polygon
              key={`patrol_${g.id}`}
              points={pts}
              fill="none"
              stroke="rgba(251, 113, 133, 0.42)"
              strokeWidth="0.12"
              strokeDasharray="0.45 0.35"
            />
          );
        })}

        {/* 4. Known Cameras & Sweeping Cones */}
        {snapshot.cameras
          .filter((cam) => cam.floor === selectedFloor)
          .map((cam) => (
            <g key={`cam_cone_${cam.nodeId}`} style={{ pointerEvents: 'none' }}>
              {cam.active && (
                <path
                  d={conePath(cam.pos, cam.headingDeg, cam.range, 55)}
                  fill={
                    cam.spottingCrewIds.length > 0
                      ? 'rgba(244, 63, 94, 0.36)'
                      : 'rgba(129, 140, 248, 0.18)'
                  }
                  stroke={
                    cam.spottingCrewIds.length > 0
                      ? 'rgba(244, 63, 94, 0.85)'
                      : 'rgba(129, 140, 248, 0.45)'
                  }
                  strokeWidth="0.08"
                />
              )}
            </g>
          ))}

        {/* 5. Known Guard Ghosts & Live Vision Cones */}
        {snapshot.guards
          .filter((g) => g.floor === selectedFloor)
          .map((g) => (
            <g key={`guard_${g.guardId}`} style={{ pointerEvents: 'none' }}>
              <path
                d={conePath(g.pos, g.headingDeg, g.visionRange, g.visionConeDeg)}
                fill={
                  g.alerted
                    ? 'rgba(244, 63, 94, 0.38)'
                    : 'rgba(245, 158, 11, 0.16)'
                }
                stroke={
                  g.alerted
                    ? 'rgba(244, 63, 94, 0.9)'
                    : 'rgba(245, 158, 11, 0.45)'
                }
                strokeWidth="0.08"
              />
              <circle
                cx={g.pos.x}
                cy={g.pos.z}
                r="0.62"
                fill={g.alerted ? '#e11d48' : '#b45309'}
                stroke="#fef3c7"
                strokeWidth="0.14"
              />
              <text
                x={g.pos.x}
                y={g.pos.z + 0.22}
                textAnchor="middle"
                fill="#ffffff"
                fontSize="0.58"
                fontWeight="700"
                fontFamily="IBM Plex Mono, monospace"
              >
                W
              </text>
              <text
                x={g.pos.x}
                y={g.pos.z - 0.9}
                textAnchor="middle"
                fill="#fecdd3"
                fontSize="0.55"
                fontFamily="IBM Plex Mono, monospace"
              >
                {g.name.split(' ')[0]}
              </text>
            </g>
          ))}

        {/* 6. Interactive Target Nodes */}
        {floorNodes.map((node) => {
          const discovered = intel.discoveredNodeIds.includes(node.id);
          const isSelected = node.id === selectedNodeId || node.id === selectedBlockNodeId;
          const isLooted = snapshot.lootedNodeIds.includes(node.id);
          const isOpened = snapshot.openedNodeIds.includes(node.id);
          const vis = getNodeVisual(node.kind);
          const compactLabel =
            node.label.length > 18 ? `${node.label.slice(0, 16)}…` : node.label;
          const labelPillW = Math.max(2.6, compactLabel.length * 0.27 + 0.7);
          const lootText = node.lootValue && !isLooted ? formatEur(node.lootValue) : null;
          const lootPillW = lootText ? Math.max(2.2, lootText.length * 0.28 + 0.6) : 0;

          return (
            <g
              key={node.id}
              transform={`translate(${node.pos.x}, ${node.pos.z})`}
              onClick={() => onSelectNode(node.id)}
              onDoubleClick={() => onQuickAddNode(node.id)}
              className="cursor-pointer"
              opacity={discovered ? 1 : 0.62}
            >
              {isSelected && (
                <circle
                  r="1.32"
                  fill="rgba(245, 158, 11, 0.18)"
                  stroke="#fbbf24"
                  strokeWidth="0.16"
                  strokeDasharray="0.3 0.2"
                />
              )}

              <circle
                r="0.78"
                fill={isLooted || isOpened ? '#065f46' : vis.fill}
                stroke={isSelected ? '#fde68a' : isLooted ? '#34d399' : vis.stroke}
                strokeWidth={isSelected ? 0.2 : 0.14}
                strokeDasharray={discovered ? undefined : '0.22 0.16'}
              />

              <text
                y="0.26"
                textAnchor="middle"
                fill="#f8fafc"
                fontSize="0.68"
                fontWeight="700"
                fontFamily="IBM Plex Mono, monospace"
              >
                {isLooted ? '✓' : vis.glyph}
              </text>

              {/* Compact Node Label with Dark Pill Backing */}
              <rect
                x={-labelPillW / 2}
                y="0.95"
                width={labelPillW}
                height="0.76"
                rx="0.24"
                fill={isSelected ? 'rgba(30, 20, 4, 0.92)' : 'rgba(5, 11, 24, 0.84)'}
                stroke={isSelected ? 'rgba(251, 191, 36, 0.65)' : 'rgba(148, 163, 184, 0.24)'}
                strokeWidth="0.06"
              />
              <text
                y="1.48"
                textAnchor="middle"
                fill={isSelected ? '#fde68a' : discovered ? '#f1f5f9' : '#94a3b8'}
                fontSize="0.46"
                fontWeight={isSelected ? '700' : '600'}
                fontFamily="Inter, sans-serif"
              >
                {compactLabel}
              </text>

              {/* Loot Value Pill with Dark Backing */}
              {lootText && (
                <>
                  <rect
                    x={-lootPillW / 2}
                    y="-1.56"
                    width={lootPillW}
                    height="0.68"
                    rx="0.22"
                    fill="rgba(30, 18, 4, 0.88)"
                    stroke="rgba(251, 191, 36, 0.45)"
                    strokeWidth="0.05"
                  />
                  <text
                    y="-1.08"
                    textAnchor="middle"
                    fill="#fcd34d"
                    fontSize="0.45"
                    fontWeight="700"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {lootText}
                  </text>
                </>
              )}
            </g>
          );
        })}

        {/* 7. Live Ghost Crew Trails & Avatars */}
        {snapshot.crew.map((ghost) => {
          const member = crew[ghost.crewId];
          const color = member?.accentColor ?? '#38bdf8';
          const floorTrail = ghost.trail.filter((pt) => pt.floor === selectedFloor);
          const trailPoints = floorTrail
            .map((pt) => `${pt.pos.x.toFixed(2)},${pt.pos.z.toFixed(2)}`)
            .join(' ');
          const isSpotted =
            ghost.spottedByGuardIds.length > 0 || ghost.spottedByCameraIds.length > 0;
          const onThisFloor = ghost.floor === selectedFloor;

          return (
            <g key={`ghost_${ghost.crewId}`} style={{ pointerEvents: 'none' }}>
              {floorTrail.length >= 2 && (
                <polyline
                  points={trailPoints}
                  fill="none"
                  stroke={color}
                  strokeOpacity="0.65"
                  strokeWidth="0.16"
                  strokeDasharray="0.35 0.25"
                />
              )}

              {onThisFloor && (
                <g transform={`translate(${ghost.pos.x}, ${ghost.pos.z})`}>
                  {/* Sync-waiting amber halo */}
                  {ghost.status === 'waiting_sync' && (
                    <circle
                      r="1.25"
                      fill="rgba(245, 158, 11, 0.2)"
                      stroke="#f59e0b"
                      strokeWidth="0.15"
                      strokeDasharray="0.28 0.2"
                    />
                  )}
                  {/* Working progress ring */}
                  {ghost.status === 'working' && (
                    <circle
                      r="1.15"
                      fill="none"
                      stroke={color}
                      strokeWidth="0.18"
                      strokeDasharray={`${(ghost.progress * 7.22).toFixed(2)} 7.22`}
                      transform="rotate(-90)"
                    />
                  )}
                  {/* Spotted danger pulse */}
                  {isSpotted && (
                    <circle
                      r="1.45"
                      fill="rgba(244, 63, 94, 0.25)"
                      stroke="#fb7185"
                      strokeWidth="0.2"
                    />
                  )}

                  <circle
                    r="0.72"
                    fill="#091120"
                    stroke={isSpotted ? '#fb7185' : color}
                    strokeWidth="0.22"
                    filter="url(#glowAmber)"
                  />
                  <text
                    y="0.24"
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize="0.56"
                    fontWeight="700"
                    fontFamily="IBM Plex Mono, monospace"
                  >
                    {CREW_BADGES[ghost.crewId] ?? ghost.crewId.slice(0, 2).toUpperCase()}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* 8. Active Conflict Markers */}
        {snapshot.conflicts
          .filter((c) => c.floor === selectedFloor)
          .map((c) => (
            <g
              key={c.id}
              transform={`translate(${c.pos.x}, ${c.pos.z - 1.65})`}
              style={{ pointerEvents: 'none' }}
            >
              <rect
                x="-0.75"
                y="-0.65"
                width="1.5"
                height="1.1"
                rx="0.25"
                fill="#e11d48"
                stroke="#fecdd3"
                strokeWidth="0.1"
              />
              <text
                y="0.18"
                textAnchor="middle"
                fill="#ffffff"
                fontSize="0.72"
                fontWeight="800"
                fontFamily="IBM Plex Mono, monospace"
              >
                !
              </text>
            </g>
          ))}
      </svg>

      {/* Bottom Legend Bar */}
      <div className="absolute bottom-2 left-3 right-3 z-10 pointer-events-none flex items-center justify-between gap-2 text-[10px] font-mono-tech text-slate-300">
        <div className="flex flex-wrap items-center gap-2.5 px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800/90">
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-sky-400" /> Zugang
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-cyan-400" /> Strom/Alarm
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-amber-400" /> Tresor/Beute
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-rose-400" /> Wache/Konflikt
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full bg-emerald-400" /> Fluchtwagen
          </span>
        </div>

        <span className="hidden xl:inline-block px-2.5 py-1 rounded-lg bg-slate-950/80 border border-slate-800/90 text-slate-400">
          Klick: Auswählen · Doppelklick: Auf Spur legen
        </span>
      </div>
    </div>
  );
}
