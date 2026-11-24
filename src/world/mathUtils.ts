import { Vec2, WallSegment, FloorId } from '../sim/types';

// ============================================================================
// NACHTSCHICHT — 3D World Math, Angle Conversions & 2D Collision Helpers
// Sim convention: headingDeg 0 = +X (East), 90 = +Z (South), 180 = -X, 270 = -Z
// GLB convention: +Y up, +Z forward, +X left
// ============================================================================

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function damp(a: number, b: number, lambda: number, dt: number): number {
  return lerp(a, b, 1 - Math.exp(-lambda * dt));
}

export function normalizeAngleRad(rad: number): number {
  let a = rad % (Math.PI * 2);
  if (a > Math.PI) a -= Math.PI * 2;
  if (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function lerpAngleRad(from: number, to: number, t: number): number {
  const diff = normalizeAngleRad(to - from);
  return from + diff * t;
}

export function dampAngleRad(from: number, to: number, lambda: number, dt: number): number {
  return lerpAngleRad(from, to, 1 - Math.exp(-lambda * dt));
}

/**
 * Converts sim headingDeg (0=+X, 90=+Z) to Three.js rotation.y for +Z forward models.
 */
export function headingDegToRotY(headingDeg: number): number {
  return Math.PI / 2 - headingDeg * DEG2RAD;
}

/**
 * Converts Three.js rotation.y (+Z forward) back to sim headingDeg (0=+X, 90=+Z).
 */
export function rotYToHeadingDeg(rotY: number): number {
  let deg = (90 - rotY * RAD2DEG) % 360;
  if (deg < 0) deg += 360;
  return deg;
}

export function dist2D(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(bx - ax, bz - az);
}

export interface AabbCollider {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface SegmentCollider {
  x1: number;
  z1: number;
  x2: number;
  z2: number;
  thickness: number;
  floor: FloorId;
  passable?: boolean;
}

/**
 * Resolves a moving circle (x, z, radius) against a 2D line segment with half-thickness.
 */
export function resolveCircleVsSegment(
  pos: Vec2,
  radius: number,
  x1: number,
  z1: number,
  x2: number,
  z2: number,
  halfThick: number
): boolean {
  const dx = x2 - x1;
  const dz = z2 - z1;
  const lenSq = dx * dx + dz * dz;
  if (lenSq < 1e-6) return false;

  const t = clamp(((pos.x - x1) * dx + (pos.z - z1) * dz) / lenSq, 0, 1);
  const cx = x1 + dx * t;
  const cz = z1 + dz * t;
  const ox = pos.x - cx;
  const oz = pos.z - cz;
  const dSq = ox * ox + oz * oz;
  const minDist = radius + halfThick;

  if (dSq < minDist * minDist) {
    const d = Math.sqrt(dSq);
    if (d > 1e-5) {
      const push = minDist - d;
      pos.x += (ox / d) * push;
      pos.z += (oz / d) * push;
    } else {
      // Fallback perpendicular push
      const len = Math.sqrt(lenSq);
      pos.x += (-dz / len) * minDist;
      pos.z += (dx / len) * minDist;
    }
    return true;
  }
  return false;
}

/**
 * Resolves a circle against an AABB, returning collision normal if hit.
 */
export function resolveCircleVsAabb(
  pos: Vec2,
  radius: number,
  box: AabbCollider
): { hit: boolean; nx: number; nz: number } {
  const cx = clamp(pos.x, box.minX, box.maxX);
  const cz = clamp(pos.z, box.minZ, box.maxZ);
  const ox = pos.x - cx;
  const oz = pos.z - cz;
  const dSq = ox * ox + oz * oz;

  if (dSq >= radius * radius) {
    return { hit: false, nx: 0, nz: 0 };
  }

  if (dSq > 1e-6) {
    const d = Math.sqrt(dSq);
    const nx = ox / d;
    const nz = oz / d;
    const push = radius - d;
    pos.x += nx * push;
    pos.z += nz * push;
    return { hit: true, nx, nz };
  }

  // Center is inside the box — push out nearest edge
  const dLeft = Math.abs(pos.x - box.minX);
  const dRight = Math.abs(box.maxX - pos.x);
  const dTop = Math.abs(pos.z - box.minZ);
  const dBot = Math.abs(box.maxZ - pos.z);
  const minEdge = Math.min(dLeft, dRight, dTop, dBot);

  if (minEdge === dLeft) {
    pos.x = box.minX - radius;
    return { hit: true, nx: -1, nz: 0 };
  }
  if (minEdge === dRight) {
    pos.x = box.maxX + radius;
    return { hit: true, nx: 1, nz: 0 };
  }
  if (minEdge === dTop) {
    pos.z = box.minZ - radius;
    return { hit: true, nx: 0, nz: -1 };
  }
  pos.z = box.maxZ + radius;
  return { hit: true, nx: 0, nz: 1 };
}

export function buildWallColliders(walls: WallSegment[]): SegmentCollider[] {
  return walls.map((w) => ({
    x1: w.x1,
    z1: w.z1,
    x2: w.x2,
    z2: w.z2,
    thickness: w.thickness ?? (w.kind === 'baroque' ? 0.55 : w.kind === 'exterior' ? 0.36 : 0.24),
    floor: w.floor,
  }));
}
