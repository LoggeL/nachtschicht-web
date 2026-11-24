"""Photorealistic Showroom-Grade European Night Vehicle Generator for Nachtschicht (Blender 5.2).

Builds & exports three high-detail, Subdivision-refined, PBR-textured GLB vehicles:
  1. public/assets/models/getaway_car.glb  (~4.58m dark metallic European fastback sports coupe)
  2. public/assets/models/police_car.glb   (~4.78m Catalan Mossos d'Esquadra 4-door patrol sedan)
  3. public/assets/models/traffic_car.glb  (~4.35m European compact sportback, tintable neutral metallic)

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_vehicles.py
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_vehicles.py -- --qa-out /abs/path/vehicles_qa.png

Conventions:
  - Blender modeling space: Front = -Y, Rear = +Y, Left (LHD driver) = +X, Up = +Z
  - glTF 2.0 exported space: Y-up (+Y), Forward = +Z, Left = +X, grounded strictly at y = 0.0000
  - All interactive light meshes (Headlights, Taillights, Brakelights, Lightbar_Blue, Lightbar_Red)
    use a single emissive material so Three.js `mesh.material.emissiveIntensity` animates directly.
  - All 4 wheels (Wheel_FL, Wheel_FR, Wheel_RL, Wheel_RR) are centered strictly at their axle hubs
    with X-axis spin and Y-axis steering.
"""

from __future__ import annotations

import json
import math
import os
import sys
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
MODELS_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "models")

# Scratch directory holding our Codex CLI gpt-image-2 photorealistic automotive PBR textures
DEFAULT_TEX_DIR = (
    "/Users/logge/.gemini/antigravity-cli/brain/"
    "261edaac-088a-45d8-8cf3-30794718c942/scratch/vehicle_textures"
)


# ---------------------------------------------------------------------------
# Math & Spline Helpers
# ---------------------------------------------------------------------------

def clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = clamp((x - edge0) / max(1e-6, edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def catmull_rom_eval(points: Sequence[Tuple[float, float]], x: float) -> float:
    """Smooth piecewise cubic interpolation over sorted (x, y) control knots."""
    if x <= points[0][0]:
        return points[0][1]
    if x >= points[-1][0]:
        return points[-1][1]
    n = len(points)
    for i in range(n - 1):
        x0, y0 = points[i]
        x1, y1 = points[i + 1]
        if x0 <= x <= x1:
            dx = max(1e-6, x1 - x0)
            t = (x - x0) / dx
            if i > 0:
                xp, yp = points[i - 1]
                m0 = 0.5 * ((y1 - y0) / dx + (y0 - yp) / max(1e-6, x0 - xp))
            else:
                m0 = (y1 - y0) / dx
            if i + 2 < n:
                xn, yn = points[i + 2]
                m1 = 0.5 * ((yn - y1) / max(1e-6, xn - x1) + (y1 - y0) / dx)
            else:
                m1 = (y1 - y0) / dx
            t2 = t * t
            t3 = t2 * t
            return (
                (2 * t3 - 3 * t2 + 1) * y0
                + (t3 - 2 * t2 + t) * dx * m0
                + (-2 * t3 + 3 * t2) * y1
                + (t3 - t2) * dx * m1
            )
    return points[-1][1]


def srgb_to_linear(c: float) -> float:
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(hex_str: str, alpha: float = 1.0) -> Tuple[float, float, float, float]:
    s = hex_str.lstrip("#")
    return (
        srgb_to_linear(int(s[0:2], 16) / 255.0),
        srgb_to_linear(int(s[2:4], 16) / 255.0),
        srgb_to_linear(int(s[4:6], 16) / 255.0),
        alpha,
    )


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if bpy.context.scene.world is None:
        bpy.context.scene.world = bpy.data.worlds.new("World")


# ---------------------------------------------------------------------------
# Packed PBR Material System (with Codex gpt-image-2 Maps)
# ---------------------------------------------------------------------------

class PBRMaterials:
    def __init__(self, tex_dir: str = DEFAULT_TEX_DIR) -> None:
        self.tex_dir = tex_dir
        self._img_cache: Dict[str, bpy.types.Image] = {}

    def _load_img(self, filename: str, colorspace: str = "sRGB") -> Optional[bpy.types.Image]:
        key = f"{filename}:{colorspace}"
        if key in self._img_cache:
            return self._img_cache[key]
        path = os.path.join(self.tex_dir, filename)
        if not os.path.exists(path):
            return None
        img = bpy.data.images.load(path, check_existing=True)
        img.colorspace_settings.name = colorspace
        try:
            img.pack()
        except Exception:
            pass
        self._img_cache[key] = img
        return img

    def make(
        self,
        name: str,
        color: str = "#808080",
        metallic: float = 0.0,
        roughness: float = 0.4,
        coat: float = 0.0,
        coat_roughness: float = 0.04,
        ior: float = 1.5,
        alpha: float = 1.0,
        emission: Optional[str] = None,
        emission_strength: float = 0.0,
        double_sided: bool = False,
        albedo_map: Optional[str] = None,
        normal_map: Optional[str] = None,
        normal_strength: float = 0.65,
        roughness_map: Optional[str] = None,
        roughness_range: Optional[Tuple[float, float]] = None,
        uv_scale: Tuple[float, float] = (1.0, 1.0),
    ) -> bpy.types.Material:
        if name in bpy.data.materials:
            return bpy.data.materials[name]

        mat = bpy.data.materials.new(name=name)
        if mat.node_tree is None:
            mat.use_nodes = True
        nt = mat.node_tree
        nt.nodes.clear()

        out = nt.nodes.new("ShaderNodeOutputMaterial")
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

        bsdf.inputs["Base Color"].default_value = hex_rgba(color, 1.0)
        bsdf.inputs["Metallic"].default_value = float(metallic)
        bsdf.inputs["Roughness"].default_value = float(roughness)
        bsdf.inputs["Alpha"].default_value = float(alpha)
        if "IOR" in bsdf.inputs:
            bsdf.inputs["IOR"].default_value = float(ior)
        if coat > 0.0 and "Coat Weight" in bsdf.inputs:
            bsdf.inputs["Coat Weight"].default_value = float(coat)
            bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)
        if emission is not None and emission_strength > 0.0:
            bsdf.inputs["Emission Color"].default_value = hex_rgba(emission, 1.0)
            bsdf.inputs["Emission Strength"].default_value = float(emission_strength)

        mapping_out = None
        if any([albedo_map, normal_map, roughness_map]) and (uv_scale[0] != 1.0 or uv_scale[1] != 1.0):
            tc = nt.nodes.new("ShaderNodeTexCoord")
            mp = nt.nodes.new("ShaderNodeMapping")
            mp.inputs["Scale"].default_value = (uv_scale[0], uv_scale[1], 1.0)
            nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
            mapping_out = mp.outputs["Vector"]

        if albedo_map:
            img = self._load_img(albedo_map, "sRGB")
            if img is not None:
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                if mapping_out:
                    nt.links.new(mapping_out, tex.inputs["Vector"])
                nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

        if roughness_map:
            img = self._load_img(roughness_map, "Non-Color")
            if img is not None:
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                if mapping_out:
                    nt.links.new(mapping_out, tex.inputs["Vector"])
                if roughness_range is not None:
                    mr = nt.nodes.new("ShaderNodeMapRange")
                    mr.inputs["From Min"].default_value = 0.0
                    mr.inputs["From Max"].default_value = 1.0
                    mr.inputs["To Min"].default_value = float(roughness_range[0])
                    mr.inputs["To Max"].default_value = float(roughness_range[1])
                    nt.links.new(tex.outputs["Color"], mr.inputs["Value"])
                    nt.links.new(mr.outputs["Result"], bsdf.inputs["Roughness"])
                else:
                    nt.links.new(tex.outputs["Color"], bsdf.inputs["Roughness"])

        if normal_map:
            img = self._load_img(normal_map, "Non-Color")
            if img is not None:
                tex = nt.nodes.new("ShaderNodeTexImage")
                tex.image = img
                if mapping_out:
                    nt.links.new(mapping_out, tex.inputs["Vector"])
                nrm = nt.nodes.new("ShaderNodeNormalMap")
                nrm.inputs["Strength"].default_value = float(normal_strength)
                nt.links.new(tex.outputs["Color"], nrm.inputs["Color"])
                nt.links.new(nrm.outputs["Normal"], bsdf.inputs["Normal"])

        if alpha < 0.999:
            mat.blend_method = "BLEND"
            mat.use_backface_culling = False
        else:
            mat.blend_method = "OPAQUE"
            mat.use_backface_culling = not double_sided

        return mat


# ---------------------------------------------------------------------------
# High-Craft BMesh Automotive Builder
# ---------------------------------------------------------------------------

def _xform(center: Sequence[float], rot: Sequence[float] = (0.0, 0.0, 0.0)) -> Matrix:
    return Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()


class AutoMesh:
    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.materials: List[bpy.types.Material] = []
        self._mat_idx: Dict[str, int] = {}
        self.uv_layer = self.bm.loops.layers.uv.verify()
        self.crease_layer = self.bm.edges.layers.float.new("crease_edge")

    def mat_idx(self, mat: bpy.types.Material) -> int:
        if mat.name not in self._mat_idx:
            self._mat_idx[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self._mat_idx[mat.name]

    def _tag(self, faces: Sequence[bmesh.types.BMFace], mat: bpy.types.Material, smooth: bool = True) -> None:
        idx = self.mat_idx(mat)
        for f in faces:
            f.material_index = idx
            f.smooth = smooth

    def add_grid(
        self,
        grid: List[List[Tuple[float, float, float]]],
        mat: bpy.types.Material,
        smooth: bool = True,
        uv_grid: Optional[List[List[Tuple[float, float]]]] = None,
        flip: bool = False,
        row_creases: Optional[Dict[int, float]] = None,
        col_creases: Optional[Dict[int, float]] = None,
    ) -> List[List[bmesh.types.BMVert]]:
        rows = len(grid)
        cols = len(grid[0])
        vgrid = [[self.bm.verts.new(pt) for pt in row] for row in grid]
        idx = self.mat_idx(mat)
        for r in range(rows - 1):
            for c in range(cols - 1):
                v00, v01 = vgrid[r][c], vgrid[r][c + 1]
                v11, v10 = vgrid[r + 1][c + 1], vgrid[r + 1][c]
                quad = [v00, v10, v11, v01] if flip else [v00, v01, v11, v10]
                if len(set(quad)) < 4:
                    continue
                try:
                    f = self.bm.faces.new(quad)
                    f.material_index = idx
                    f.smooth = smooth
                    if uv_grid is not None:
                        uvs = (
                            [uv_grid[r][c], uv_grid[r + 1][c], uv_grid[r + 1][c + 1], uv_grid[r][c + 1]]
                            if flip
                            else [uv_grid[r][c], uv_grid[r][c + 1], uv_grid[r + 1][c + 1], uv_grid[r + 1][c]]
                        )
                        for lp, uv in zip(f.loops, uvs):
                            lp[self.uv_layer].uv = uv
                except ValueError:
                    pass

        if row_creases:
            for r, cr in row_creases.items():
                if 0 <= r < rows:
                    for c in range(cols - 1):
                        e = self.bm.edges.get((vgrid[r][c], vgrid[r][c + 1]))
                        if e:
                            e[self.crease_layer] = max(e[self.crease_layer], float(cr))
        if col_creases:
            for c, cr in col_creases.items():
                if 0 <= c < cols:
                    for r in range(rows - 1):
                        e = self.bm.edges.get((vgrid[r][c], vgrid[r + 1][c]))
                        if e:
                            e[self.crease_layer] = max(e[self.crease_layer], float(cr))
        return vgrid

    def add_box(
        self,
        center: Sequence[float],
        size: Sequence[float],
        mat: bpy.types.Material,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        bevel: float = 0.0,
        bevel_segments: int = 2,
        smooth: bool = True,
        taper_top: Tuple[float, float] = (1.0, 1.0),
        taper_bottom: Tuple[float, float] = (1.0, 1.0),
    ) -> List[bmesh.types.BMFace]:
        sx, sy, sz = float(size[0]), float(size[1]), float(size[2])
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        tbx, tby = taper_bottom
        ttx, tty = taper_top
        coords = [
            (-hx * tbx, -hy * tby, -hz),
            (hx * tbx, -hy * tby, -hz),
            (hx * tbx, hy * tby, -hz),
            (-hx * tbx, hy * tby, -hz),
            (-hx * ttx, -hy * tty, hz),
            (hx * ttx, -hy * tty, hz),
            (hx * ttx, hy * tty, hz),
            (-hx * ttx, hy * tty, hz),
        ]
        verts = [self.bm.verts.new(c) for c in coords]
        fdefs = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
        faces = [self.bm.faces.new([verts[i] for i in fd]) for fd in fdefs]
        if bevel > 0.0:
            b_amt = min(float(bevel), min(sx, sy, sz) * 0.42)
            edges = list({e for f in faces for e in f.edges})
            res = bmesh.ops.bevel(
                self.bm,
                geom=edges,
                offset=b_amt,
                offset_type="OFFSET",
                segments=bevel_segments,
                profile=0.5,
                affect="EDGES",
                clamp_overlap=True,
            )
            all_verts = list({v for f in faces if f.is_valid for v in f.verts} | set(res.get("verts", [])))
            all_faces = [f for f in faces if f.is_valid] + list(res.get("faces", []))
        else:
            all_verts, all_faces = verts, faces
        bmesh.ops.transform(self.bm, matrix=_xform(center, rot), verts=all_verts)
        self._tag(all_faces, mat, smooth)
        return all_faces

    def add_cylinder(
        self,
        center: Sequence[float],
        r1: float,
        r2: float,
        height: float,
        mat: bpy.types.Material,
        segments: int = 20,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        cap: bool = True,
    ) -> List[bmesh.types.BMFace]:
        existing = set(self.bm.faces)
        bmesh.ops.create_cone(
            self.bm,
            cap_ends=cap,
            cap_tris=False,
            segments=segments,
            radius1=float(r1),
            radius2=float(r2),
            depth=float(height),
            matrix=_xform(center, rot),
        )
        new_faces = [f for f in self.bm.faces if f not in existing]
        self._tag(new_faces, mat, smooth)
        return new_faces

    def add_loft(
        self,
        rings: Sequence[Sequence[Sequence[float]]],
        mat: bpy.types.Material,
        cap_start: bool = False,
        cap_end: bool = False,
        smooth: bool = True,
        closed_u: bool = True,
        flip: bool = False,
        uv_fn: Optional[Callable[[int, int, int, int], Tuple[float, float]]] = None,
    ) -> List[bmesh.types.BMFace]:
        if len(rings) < 2:
            return []
        n = len(rings[0])
        m = len(rings)
        v_rings = [[self.bm.verts.new(tuple(pt)) for pt in ring] for ring in rings]
        idx = self.mat_idx(mat)
        new_faces: List[bmesh.types.BMFace] = []
        for r_i in range(m - 1):
            r0, r1 = v_rings[r_i], v_rings[r_i + 1]
            count = n if closed_u else (n - 1)
            for j in range(count):
                jn = (j + 1) % n
                quad = [r0[j], r1[j], r1[jn], r0[jn]] if flip else [r0[j], r0[jn], r1[jn], r1[j]]
                if len(set(quad)) == 4:
                    try:
                        f = self.bm.faces.new(quad)
                        f.material_index = idx
                        f.smooth = smooth
                        if uv_fn is not None:
                            if flip:
                                f.loops[0][self.uv_layer].uv = uv_fn(r_i, j, m, n)
                                f.loops[1][self.uv_layer].uv = uv_fn(r_i + 1, j, m, n)
                                f.loops[2][self.uv_layer].uv = uv_fn(r_i + 1, j + 1, m, n)
                                f.loops[3][self.uv_layer].uv = uv_fn(r_i, j + 1, m, n)
                            else:
                                f.loops[0][self.uv_layer].uv = uv_fn(r_i, j, m, n)
                                f.loops[1][self.uv_layer].uv = uv_fn(r_i, j + 1, m, n)
                                f.loops[2][self.uv_layer].uv = uv_fn(r_i + 1, j + 1, m, n)
                                f.loops[3][self.uv_layer].uv = uv_fn(r_i + 1, j, m, n)
                        new_faces.append(f)
                    except ValueError:
                        pass
        if cap_start and closed_u and n >= 3:
            try:
                f = self.bm.faces.new(list(v_rings[0]) if flip else list(reversed(v_rings[0])))
                f.material_index = idx
                f.smooth = False
                new_faces.append(f)
            except ValueError:
                pass
        if cap_end and closed_u and n >= 3:
            try:
                f = self.bm.faces.new(list(reversed(v_rings[-1])) if flip else list(v_rings[-1]))
                f.material_index = idx
                f.smooth = False
                new_faces.append(f)
            except ValueError:
                pass
        return new_faces

    def add_tube(
        self,
        points: Sequence[Sequence[float]],
        radii: float | Sequence[float],
        mat: bpy.types.Material,
        segments: int = 10,
        smooth: bool = True,
        cap: bool = True,
        oval_ratio: float = 1.0,
    ) -> List[bmesh.types.BMFace]:
        pts = [Vector(p) for p in points]
        if len(pts) < 2:
            return []
        rad_list = [float(radii)] * len(pts) if isinstance(radii, (int, float)) else [float(r) for r in radii]
        rings = []
        prev_n: Optional[Vector] = None
        for i, p in enumerate(pts):
            if i == 0:
                tangent = (pts[1] - pts[0]).normalized()
            elif i == len(pts) - 1:
                tangent = (pts[-1] - pts[-2]).normalized()
            else:
                t1 = (pts[i] - pts[i - 1]).normalized()
                t2 = (pts[i + 1] - pts[i]).normalized()
                tangent = t1 + t2
                tangent = t2 if tangent.length < 1e-5 else tangent.normalized()
            if prev_n is None:
                up = Vector((0.0, 0.0, 1.0)) if abs(tangent.z) < 0.92 else Vector((1.0, 0.0, 0.0))
                nrm = tangent.cross(up).normalized()
            else:
                nrm = prev_n - tangent * prev_n.dot(tangent)
                if nrm.length < 1e-5:
                    up = Vector((1.0, 0.0, 0.0)) if abs(tangent.x) < 0.9 else Vector((0.0, 1.0, 0.0))
                    nrm = tangent.cross(up).normalized()
                else:
                    nrm.normalize()
            binrm = tangent.cross(nrm).normalized()
            prev_n = nrm
            r = rad_list[i]
            ring = [
                tuple(
                    p
                    + (
                        nrm * math.cos(2.0 * math.pi * s / segments)
                        + binrm * (math.sin(2.0 * math.pi * s / segments) * oval_ratio)
                    )
                    * r
                )
                for s in range(segments)
            ]
            rings.append(ring)
        return self.add_loft(rings, mat, cap_start=cap, cap_end=cap, smooth=smooth, closed_u=True)

    def add_torus(
        self,
        center: Sequence[float],
        major_r: float,
        minor_r: float,
        mat: bpy.types.Material,
        major_segs: int = 24,
        minor_segs: int = 8,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
    ) -> List[bmesh.types.BMFace]:
        mat4 = _xform(center, rot)
        rings = []
        for i in range(major_segs + 1):
            a = 2.0 * math.pi * (i % major_segs) / major_segs
            ca, sa = math.cos(a), math.sin(a)
            ring = []
            for j in range(minor_segs):
                b = 2.0 * math.pi * j / minor_segs
                cb, sb = math.cos(b), math.sin(b)
                r_cur = major_r + minor_r * cb
                pt = mat4 @ Vector((r_cur * ca, r_cur * sa, minor_r * sb))
                ring.append(tuple(pt))
            rings.append(ring)
        return self.add_loft(rings, mat, cap_start=False, cap_end=False, smooth=True, closed_u=True)

    def add_plate_quad(
        self,
        center: Sequence[float],
        width: float,
        height: float,
        mat: bpy.types.Material,
        facing_front: bool = True,
        tilt_x: float = 0.0,
    ) -> None:
        cx, cy, cz = center
        hw, hh = width * 0.5, height * 0.5
        rot = Matrix.Rotation(tilt_x, 4, "X")

        def xpt(dx: float, dz: float) -> Tuple[float, float, float]:
            v = rot @ Vector((dx, 0.0, dz))
            return (cx + v.x, cy + v.y, cz + v.z)

        if facing_front:
            pts = [xpt(-hw, -hh), xpt(hw, -hh), xpt(hw, hh), xpt(-hw, hh)]
            uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
        else:
            pts = [xpt(hw, -hh), xpt(-hw, -hh), xpt(-hw, hh), xpt(hw, hh)]
            uvs = [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 1.0)]

        verts = [self.bm.verts.new(p) for p in pts]
        f = self.bm.faces.new(verts)
        f.material_index = self.mat_idx(mat)
        f.smooth = False
        for lp, uv in zip(f.loops, uvs):
            lp[self.uv_layer].uv = uv

    def assign_box_uvs_where_missing(self, uv_scale: float = 0.65) -> None:
        for f in self.bm.faces:
            has_uv = any(abs(lp[self.uv_layer].uv[0]) > 1e-5 or abs(lp[self.uv_layer].uv[1]) > 1e-5 for lp in f.loops)
            if has_uv:
                continue
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for lp in f.loops:
                co = lp.vert.co
                if az >= ax and az >= ay:
                    lp[self.uv_layer].uv = (co.x * uv_scale + 0.5, co.y * uv_scale + 0.5)
                elif ax >= ay and ax >= az:
                    lp[self.uv_layer].uv = (co.y * uv_scale + 0.5, co.z * uv_scale + 0.5)
                else:
                    lp[self.uv_layer].uv = (co.x * uv_scale + 0.5, co.z * uv_scale + 0.5)

    def finalize(
        self,
        name: str,
        location: Sequence[float] = (0.0, 0.0, 0.0),
        subsurf_levels: int = 0,
        weighted_normals: bool = True,
        sharp_angle_deg: float = 48.0,
        box_uv_scale: float = 0.65,
        merge_dist: float = 0.0005,
        recalc_normals: bool = True,
    ) -> bpy.types.Object:
        if merge_dist > 0.0 and len(self.bm.verts) > 0:
            bmesh.ops.remove_doubles(self.bm, verts=list(self.bm.verts), dist=merge_dist)

        self.bm.normal_update()
        if recalc_normals and len(self.bm.faces) > 0:
            bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))

        self.assign_box_uvs_where_missing(box_uv_scale)

        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()

        for m in self.materials:
            mesh.materials.append(m)

        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.location = Vector(location)

        if subsurf_levels > 0:
            mod = obj.modifiers.new("Subsurf", "SUBSURF")
            mod.levels = subsurf_levels
            mod.render_levels = subsurf_levels
            mod.use_creases = True

        if weighted_normals and len(mesh.polygons) > 0:
            sharp_rad = math.radians(sharp_angle_deg)
            bm_tmp = bmesh.new()
            bm_tmp.from_mesh(mesh)
            bm_tmp.normal_update()
            for e in bm_tmp.edges:
                if len(e.link_faces) == 2 and e.calc_face_angle(0.0) >= sharp_rad:
                    e.smooth = False
            bm_tmp.to_mesh(mesh)
            bm_tmp.free()

            wn = obj.modifiers.new("WeightedNormal", "WEIGHTED_NORMAL")
            wn.mode = "FACE_AREA_WITH_ANGLE"
            wn.weight = 60
            wn.keep_sharp = True

        return obj


def join_objects(objs: List[bpy.types.Object], final_name: str) -> bpy.types.Object:
    bpy.ops.object.select_all(action="DESELECT")
    valid = [o for o in objs if o is not None and o.type == "MESH"]
    for o in valid:
        bpy.context.view_layer.objects.active = o
        o.select_set(True)
        for mod in list(o.modifiers):
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                pass
        o.select_set(False)

    if len(valid) == 1:
        valid[0].name = final_name
        valid[0].data.name = final_name
        return valid[0]

    for o in valid:
        o.select_set(True)
    bpy.context.view_layer.objects.active = valid[0]
    bpy.ops.object.join()
    joined = bpy.context.active_object
    joined.name = final_name
    joined.data.name = final_name
    bpy.ops.object.select_all(action="DESELECT")
    return joined


# ---------------------------------------------------------------------------
# Parametric Class-A Automotive Surface Engine (Zero Pinch, Flush Optics!)
# ---------------------------------------------------------------------------

@dataclass
class CarProfile:
    name: str
    y_front: float
    y_rear: float
    y_wf: float
    y_wr: float
    wheel_r: float
    arch_r_f: float
    arch_r_r: float
    track_x: float
    tire_w_f: float
    tire_w_r: float
    y_cowl: float
    y_roof_f: float
    y_b_pillar: float
    y_roof_r: float
    y_deck: float
    hw_knots: List[Tuple[float, float]]
    z_sill_knots: List[Tuple[float, float]]
    z_belt_knots: List[Tuple[float, float]]
    z_center_knots: List[Tuple[float, float]]
    hw_roof_f: float
    hw_roof_mid: float
    hw_roof_r: float
    z_roof_f: float
    z_roof_mid: float
    z_roof_r: float
    fender_flare_f: float = 0.032
    fender_flare_r: float = 0.048
    door_cove_depth: float = 0.024
    hood_power_dome: float = 0.018
    ducktail_lift: float = 0.030
    windshield_bow: float = 0.105
    rear_glass_bow: float = 0.085
    nose_plan_pull: float = 0.24
    tail_plan_pull: float = 0.21
    is_coupe: bool = False
    is_hatchback: bool = False
    is_police: bool = False


def _arch_theta_span(p: CarProfile, y_w: float, r_a: float) -> Tuple[float, float]:
    """Compute exact start/end angles where the circular wheel arch meets z_sill cleanly (ZERO step cliff!)."""
    z_s = catmull_rom_eval(p.z_sill_knots, y_w)
    sin_lo = clamp((z_s - p.wheel_r) / r_a, -0.82, 0.0)
    th_lo = math.asin(sin_lo)  # negative angle below axle center!
    return th_lo, math.pi - th_lo


def build_longitudinal_stations(p: CarProfile) -> Tuple[List[float], int, int]:
    """Generate smooth monotonically ordered Y stations with full-arc sill-matched wheel cutouts."""
    pts: List[float] = []
    y_n0 = p.y_front + p.nose_plan_pull
    y_t1 = p.y_rear - p.tail_plan_pull

    th_f0, th_f1 = _arch_theta_span(p, p.y_wf, p.arch_r_f)
    th_r0, th_r1 = _arch_theta_span(p, p.y_wr, p.arch_r_r)
    y_af0 = p.y_wf - p.arch_r_f * math.cos(th_f0)
    y_af1 = p.y_wf - p.arch_r_f * math.cos(th_f1)
    y_ar0 = p.y_wr - p.arch_r_r * math.cos(th_r0)
    y_ar1 = p.y_wr - p.arch_r_r * math.cos(th_r1)

    # Front overhang stations
    for k in range(5):
        pts.append(lerp(y_n0, y_af0 - 0.04, k / 4.0))

    # Front wheel arch (15 exact circular stations meeting z_sill smoothly!)
    arch_n = 15
    for k in range(arch_n):
        th = lerp(th_f0, th_f1, k / (arch_n - 1))
        pts.append(p.y_wf - p.arch_r_f * math.cos(th))

    # Mid-body / doors between arches (including exact y_cowl & y_b_pillar!)
    mid_targets = [
        y_af1 + 0.05,
        lerp(y_af1 + 0.05, p.y_cowl, 0.5),
        p.y_cowl,
        lerp(p.y_cowl, p.y_b_pillar, 0.35),
        lerp(p.y_cowl, p.y_b_pillar, 0.70),
        p.y_b_pillar,
        lerp(p.y_b_pillar, y_ar0 - 0.05, 0.38),
        lerp(p.y_b_pillar, y_ar0 - 0.05, 0.74),
        y_ar0 - 0.05,
    ]
    pts.extend(mid_targets)

    # Rear wheel arch (15 exact circular stations meeting z_sill smoothly!)
    for k in range(arch_n):
        th = lerp(th_r0, th_r1, k / (arch_n - 1))
        pts.append(p.y_wr - p.arch_r_r * math.cos(th))

    # Rear overhang & deck
    pts.extend([
        y_ar1 + 0.05,
        p.y_deck,
        lerp(p.y_deck, y_t1, 0.45),
        y_t1,
    ])

    pts_sorted = sorted(pts)
    clean: List[float] = []
    for y in pts_sorted:
        if not clean or abs(y - clean[-1]) > 0.012:
            clean.append(y)

    i_cowl = min(range(len(clean)), key=lambda idx: abs(clean[idx] - p.y_cowl))
    i_deck = min(range(len(clean)), key=lambda idx: abs(clean[idx] - p.y_deck))
    return clean, i_cowl, i_deck


def eval_body_station(p: CarProfile, y: float) -> dict:
    hw_base = catmull_rom_eval(p.hw_knots, y)
    z_sill = catmull_rom_eval(p.z_sill_knots, y)
    z_belt = catmull_rom_eval(p.z_belt_knots, y)
    z_ctr = catmull_rom_eval(p.z_center_knots, y)

    # Muscular smooth fender haunches
    df = (y - p.y_wf) / (p.arch_r_f * 1.42)
    dr = (y - p.y_wr) / (p.arch_r_r * 1.52)
    flare_f = p.fender_flare_f * math.exp(-df * df * 1.7)
    flare_r = p.fender_flare_r * math.exp(-dr * dr * 1.5)
    hw = hw_base + flare_f + flare_r

    in_door = smoothstep(p.y_wf + p.arch_r_f * 0.95, p.y_wf + p.arch_r_f * 1.55, y) * (
        1.0 - smoothstep(p.y_wr - p.arch_r_r * 1.55, p.y_wr - p.arch_r_r * 0.95, y)
    )
    door_scoop = p.door_cove_depth * in_door

    # Smooth full-arc semicircular cutout meeting z_sill with ZERO vertical cliff!
    z_cut = z_sill
    in_arch = 0.0
    arch_brow = 0.012
    for y_w, r_a in ((p.y_wf, p.arch_r_f), (p.y_wr, p.arch_r_r)):
        th0, _ = _arch_theta_span(p, y_w, r_a)
        half_span = r_a * math.cos(th0)  # exact Y half-width where circle hits z_sill!
        dy = abs(y - y_w)
        if dy < half_span:
            h_arc = math.sqrt(max(0.0, r_a * r_a - dy * dy))
            z_a = p.wheel_r + h_arc
            if z_a > z_cut:
                # Smooth blend right near the sill corner to eliminate any vertical cliff/pinch!
                t_edge = 1.0 - smoothstep(half_span * 0.88, half_span, dy)
                z_cut = lerp(z_sill, z_a, t_edge)
                in_arch = t_edge
                arch_brow = lerp(0.012, 0.024, t_edge)

    return {
        "y": y,
        "hw": hw,
        "z_sill": z_sill,
        "z_cut": z_cut,
        "z_belt": z_belt,
        "z_ctr": z_ctr,
        "door_scoop": door_scoop,
        "in_arch": in_arch,
        "arch_brow": arch_brow,
    }


def _side_ring_points(st: dict, p: CarProfile, side_sign: float) -> List[Tuple[float, float, float]]:
    y = st["y"]
    hw = st["hw"]
    zc = st["z_cut"]
    zb = st["z_belt"]
    scoop = st["door_scoop"]
    brow = st["arch_brow"]
    s = side_sign

    h_avail = max(0.11, zb - zc)
    z_brow = zc + min(0.044, h_avail * 0.24)
    z_low = lerp(z_brow, zb, 0.25)
    z_mid = lerp(z_brow, zb, 0.54)
    z_swage = lerp(z_brow, zb, 0.77)
    z_roll = lerp(z_brow, zb, 0.92)

    x_lip = hw - 0.020
    x_brow = hw + brow * (0.85 if st["in_arch"] > 0.4 else 0.40)
    x_low = hw - 0.010 - scoop
    x_mid = hw + 0.005
    x_swage = hw * 0.992
    x_roll = hw * 0.946
    x_belt = hw * 0.888

    x_inner = max(0.10, x_lip - (0.062 if st["in_arch"] > 0.4 else 0.075))
    z_inner = zc - (0.006 if st["in_arch"] > 0.4 else 0.014)

    return [
        (s * x_inner, y, z_inner),  # 0: inner lip
        (s * x_lip,   y, zc),       # 1: outer lip
        (s * x_brow,  y, z_brow),   # 2: arch brow / rocker crease
        (s * x_low,   y, z_low),    # 3: lower door cove
        (s * x_mid,   y, z_mid),    # 4: mid-body widest crown
        (s * x_swage, y, z_swage),  # 5: crisp shoulder swage line
        (s * x_roll,  y, z_roll),   # 6: upper fender roll-in
        (s * x_belt,  y, zb),       # 7: beltline top shoulder
    ]


def _deck_points_to_center(
    st: dict, p: CarProfile, side_sign: float, cols: int = 6, is_hood: bool = True
) -> List[Tuple[float, float, float]]:
    y = st["y"]
    x_belt = st["hw"] * 0.888
    zb = st["z_belt"]
    zc = st["z_ctr"]
    pts: List[Tuple[float, float, float]] = []
    for k in range(cols):
        t = k / (cols - 1)
        x = x_belt * (1.0 - t)
        arch_t = math.sin(t * math.pi * 0.5)
        z = lerp(zb, zc, arch_t)
        if is_hood and p.hood_power_dome > 0.0:
            y_fade = smoothstep(p.y_front + 0.22, p.y_front + 0.62, y) * (
                1.0 - smoothstep(p.y_cowl - 0.18, p.y_cowl, y)
            )
            dome = math.exp(-((abs(x) - x_belt * 0.42) / 0.14) ** 2)
            center_dip = -0.32 * math.exp(-(x / 0.15) ** 2)
            z += p.hood_power_dome * y_fade * (dome + center_dip)
        if not is_hood and p.ducktail_lift > 0.0:
            y_kick = smoothstep(p.y_rear - 0.54, p.y_rear - 0.18, y)
            z += p.ducktail_lift * y_kick * (0.45 + 0.55 * arch_t)
        pts.append((side_sign * x, y, z))
    return pts


def _nose_surface_pt(p: CarProfile, st0: dict, u_x: float, z_norm: float) -> Tuple[float, float, float]:
    """Analytical parametric point on the sleek aerodynamic curved front nose fascia!
    u_x in [-1, 1] (0 = centerline, ±1 = corner), z_norm in [0, 1] (0 = chin, 1 = hood nose edge).
    """
    ax = abs(u_x)
    x_corner = st0["hw"] * lerp(0.97, 0.888, z_norm)
    x = u_x * x_corner
    # Smooth aerodynamic plan-view nose sweep (curved European shark-nose!)
    arch_fwd = math.cos(ax * math.pi * 0.5) ** 0.85
    # Aerodynamic side-view rake: hood leading edge rakes back slightly, nose peak at bumper bar (z_norm ~ 0.45)
    rake_y = 0.065 * (z_norm ** 1.6) - 0.032 * math.sin(z_norm * math.pi)
    y = lerp(st0["y"], p.y_front + rake_y, arch_fwd)
    z_bot = st0["z_sill"] + 0.015 * arch_fwd
    z_top = lerp(st0["z_belt"], st0["z_ctr"] - 0.065, arch_fwd)
    z = lerp(z_bot, z_top, z_norm)
    return (x, y, z)


def _tail_surface_pt(p: CarProfile, stN: dict, u_x: float, z_norm: float) -> Tuple[float, float, float]:
    """Analytical parametric point on the sculpted wrap-around rear tail fascia!"""
    ax = abs(u_x)
    x_corner = stN["hw"] * lerp(0.96, 0.888, z_norm)
    x = u_x * x_corner
    arch_aft = math.cos(ax * math.pi * 0.5) ** 0.85
    # Sculpted rear bumper step: lower diffuser tucks slightly inward, mid-bumper projects cleanly, trunk edge rakes!
    step_y = -0.055 * ((1.0 - z_norm) ** 2.0) + 0.025 * math.sin(z_norm * math.pi) - 0.030 * (z_norm ** 2.2)
    y = lerp(stN["y"], p.y_rear + step_y, arch_aft)
    z_bot = stN["z_sill"]
    z_top = lerp(stN["z_belt"], stN["z_ctr"] + p.ducktail_lift * 0.85, arch_aft)
    z = lerp(z_bot, z_top, z_norm)
    return (x, y, z)


def _police_livery_uv(co: Tuple[float, float, float], normal: Vector, p: CarProfile) -> Tuple[float, float]:
    """Compute exact 4-region non-mirrored Mossos d'Esquadra atlas UV."""
    x, y, z = co
    u_len = clamp((y - p.y_front) / (p.y_rear - p.y_front), 0.002, 0.998)
    # Rear fascia faces (+Y normal near rear bumper) -> Band 3!
    if normal.y > 0.62 and y > p.y_rear - 0.25:
        u_r = 0.74 + ((0.95 - clamp(x, -0.95, 0.95)) / 1.90) * 0.25
        v_r = 0.68 + clamp(z / 1.10, 0.0, 1.0) * 0.30
        return (u_r, v_r)
    if abs(normal.x) > 0.48:
        v_z = clamp(z / 1.56, 0.0, 1.0) * 0.31
        if x >= 0.0:
            return (u_len, 0.01 + v_z)
        return (1.0 - u_len, 0.34 + v_z)
    # Top / Hood / Roof / Trunk deck -> Band 2 (u in [0, 0.71])
    v_x = clamp(abs(x) / 1.00, 0.0, 1.0) * 0.30
    return (u_len * 0.71, 0.68 + v_x)


def build_sculpted_body_shell(
    p: CarProfile,
    mat_paint: bpy.types.Material,
    mat_dark_trim: bpy.types.Material,
    mat_grille: bpy.types.Material,
    mat_carbon: bpy.types.Material,
    mat_chrome: bpy.types.Material,
    mat_clear_lens: bpy.types.Material,
    mat_plate: bpy.types.Material,
) -> Tuple[bpy.types.Object, dict]:
    """Build smooth Class-A Subdivision body shell with zero arch pinch, aerodynamic raked nose/tail,
    recessed honeycomb grille cavity, and flush conformal optical housings!
    """
    ys, i_cowl, i_deck = build_longitudinal_stations(p)
    stations = [eval_body_station(p, y) for y in ys]
    st0 = stations[0]
    stN = stations[-1]

    # 1) Main Painted Class-A Sculpted Outer Skin (Subsurf Level 1!)
    shell = AutoMesh()

    for side_sign in (1.0, -1.0):
        flip = side_sign < 0.0

        # 1a. Side fenders, smooth full-arc wheel cutouts, doors, rear quarters
        side_grid = [_side_ring_points(st, p, side_sign) for st in stations]
        shell.add_grid(
            side_grid,
            mat_paint,
            smooth=True,
            flip=flip,
            col_creases={1: 0.55, 2: 0.35, 5: 0.42, 7: 0.28},
        )

        # 1b. Cabin beltline inner return ledge
        cabin_lip = []
        for i in range(i_cowl, i_deck + 1):
            st = stations[i]
            x_belt = st["hw"] * 0.888
            zb = st["z_belt"]
            cabin_lip.append([
                (side_sign * x_belt, st["y"], zb),
                (side_sign * (x_belt - 0.055), st["y"], zb - 0.008),
                (side_sign * (x_belt - 0.065), st["y"], zb - 0.075),
            ])
        shell.add_grid(cabin_lip, mat_dark_trim, smooth=True, flip=flip)

        # 1c. Sculpted Hood (stations 0 .. i_cowl)
        hood_grid = [_deck_points_to_center(stations[i], p, side_sign, cols=6, is_hood=True) for i in range(i_cowl + 1)]
        shell.add_grid(
            hood_grid,
            mat_paint,
            smooth=True,
            flip=flip,
            col_creases={0: 0.28},
            row_creases={i_cowl: 0.40},
        )
        # Cowl plenum drop
        cowl_top = _deck_points_to_center(stations[i_cowl], p, side_sign, cols=6, is_hood=True)
        cowl_bot = [(pt[0], pt[1] + 0.07, pt[2] - 0.045) for pt in cowl_top]
        shell.add_grid([cowl_top, cowl_bot], mat_dark_trim, smooth=True, flip=flip)

        # 1d. Sculpted Rear Trunk Deck (stations i_deck .. end)
        deck_grid = [_deck_points_to_center(stations[i], p, side_sign, cols=6, is_hood=False) for i in range(i_deck, len(stations))]
        shell.add_grid(
            deck_grid,
            mat_paint,
            smooth=True,
            flip=flip,
            col_creases={0: 0.28},
            row_creases={0: 0.32},
        )

        # 1e. Aerodynamic Curved Front Nose Fascia with RECESSED Grille Cavity!
        ring0 = _side_ring_points(st0, p, side_sign)
        hood0 = _deck_points_to_center(st0, p, side_sign, cols=6, is_hood=True)
        nose_cols = 6
        z_norms = [0.0, 0.04, 0.14, 0.34, 0.56, 0.76, 0.90, 1.0]
        nose_grid: List[List[Tuple[float, float, float]]] = []
        for r in range(8):
            row_pts: List[Tuple[float, float, float]] = []
            for k in range(nose_cols):
                if k == 0:
                    row_pts.append(ring0[r])
                else:
                    t = k / (nose_cols - 1)  # 0 at corner -> 1 at x=0
                    u_x = side_sign * (1.0 - t)
                    pt = _nose_surface_pt(p, st0, u_x, z_norms[r])
                    # Inset central grille zone (k >= 2, r in 2..5) backward +0.065m so honeycomb grille is recessed cleanly!
                    if k >= 2 and r in (2, 3, 4):
                        pt = (pt[0], pt[1] + 0.065, pt[2])
                    if r == 7:
                        # Blend smoothly down from hood leading edge!
                        x_h, y_h, z_h = hood0[k]
                        arch = math.sin(t * math.pi * 0.5)
                        pt = (x_h, lerp(y_h, p.y_front + 0.055, arch * 0.85), z_h - 0.048 * arch)
                    row_pts.append(pt)
            nose_grid.append(row_pts)
        # Smooth nose-hood transition strip
        shell.add_grid([hood0, nose_grid[7]], mat_paint, smooth=True, flip=flip)
        nose_grid_T = [[nose_grid[r][k] for r in range(8)] for k in range(nose_cols)]
        shell.add_grid(
            nose_grid_T,
            mat_paint,
            smooth=True,
            flip=(not flip),
            col_creases={1: 0.45, 5: 0.35, 7: 0.32},
        )

        # 1f. Aerodynamic Curved Rear Tail Fascia (stitched onto stN + trunk trailing edge!)
        ringN = _side_ring_points(stN, p, side_sign)
        deckN = _deck_points_to_center(stN, p, side_sign, cols=6, is_hood=False)
        tail_cols = 6
        tail_grid: List[List[Tuple[float, float, float]]] = []
        for r in range(8):
            row_pts = []
            for k in range(tail_cols):
                if k == 0:
                    row_pts.append(ringN[r])
                else:
                    t = k / (tail_cols - 1)
                    u_x = side_sign * (1.0 - t)
                    pt = _tail_surface_pt(p, stN, u_x, z_norms[r])
                    if r == 7:
                        x_d, y_d, z_d = deckN[k]
                        arch = math.sin(t * math.pi * 0.5)
                        pt = (x_d, lerp(y_d, p.y_rear - 0.025, arch * 0.85), z_d - 0.015 * arch)
                    row_pts.append(pt)
            tail_grid.append(row_pts)
        shell.add_grid([deckN, tail_grid[7]], mat_paint, smooth=True, flip=(not flip))
        tail_grid_T = [[tail_grid[r][k] for r in range(8)] for k in range(tail_cols)]
        shell.add_grid(
            tail_grid_T,
            mat_paint,
            smooth=True,
            flip=flip,
            col_creases={1: 0.45, 5: 0.42, 7: 0.40},
        )

    if p.is_police:
        shell.bm.normal_update()
        bmesh.ops.recalc_face_normals(shell.bm, faces=list(shell.bm.faces))
        for f in shell.bm.faces:
            n = f.normal
            for lp in f.loops:
                lp[shell.uv_layer].uv = _police_livery_uv(tuple(lp.vert.co), n, p)

    shell_obj = shell.finalize(
        f"{p.name}_Shell",
        subsurf_levels=1,
        weighted_normals=True,
        sharp_angle_deg=55.0,
        box_uv_scale=0.55,
        merge_dist=0.0025,
    )

    # 2) Exterior Hardware, Wheelhouse Liners, Recessed Grille, Conformal Light Housings, Mirrors, Exhausts
    trim = AutoMesh()

    # 2a. Deep Recessed Wheelhouse Liners (all 4 wheel arches)
    for y_w, r_a in ((p.y_wf, p.arch_r_f), (p.y_wr, p.arch_r_r)):
        st_w = eval_body_station(p, y_w)
        x_outer = st_w["hw"] - 0.032
        x_inner = max(0.32, x_outer - 0.40)
        th0, th1 = _arch_theta_span(p, y_w, r_a)
        liner_segs = 18
        r_liner = r_a + 0.016
        for side_sign in (1.0, -1.0):
            outer_ring = []
            inner_ring = []
            for k in range(liner_segs):
                th = lerp(th0 - 0.06, th1 + 0.06, k / (liner_segs - 1))
                ly = y_w - r_liner * math.cos(th)
                lz = max(p.wheel_r * 0.45, p.wheel_r + r_liner * math.sin(th))
                outer_ring.append((side_sign * x_outer, ly, lz))
                inner_ring.append((side_sign * x_inner, ly, lz))
            trim.add_loft([outer_ring, inner_ring], mat_dark_trim, smooth=True, closed_u=False)
            trim.add_box(
                (side_sign * (x_inner - 0.015), y_w, p.wheel_r + r_a * 0.42),
                (0.03, r_a * 1.92, r_a * 1.05),
                mat_dark_trim,
                smooth=False,
            )

    # 2b. Solid Underbody Floorpan + Aerodynamic Side Skirts
    floor_len = (p.y_rear - p.y_front) - 0.48
    floor_w = (p.track_x - 0.16) * 2.0
    z_floor = min(k[1] for k in p.z_sill_knots) + 0.02
    trim.add_box((0.0, (p.y_front + p.y_rear) * 0.5, z_floor), (floor_w, floor_len, 0.055), mat_dark_trim, bevel=0.015, smooth=False)

    th_f0, th_f1 = _arch_theta_span(p, p.y_wf, p.arch_r_f)
    th_r0, _ = _arch_theta_span(p, p.y_wr, p.arch_r_r)
    skirt_y0 = p.y_wf - p.arch_r_f * math.cos(th_f1) + 0.02
    skirt_y1 = p.y_wr - p.arch_r_r * math.cos(th_r0) - 0.02
    skirt_yc = 0.5 * (skirt_y0 + skirt_y1)
    st_mid = eval_body_station(p, skirt_yc)
    skirt_mat = mat_carbon if p.is_coupe else mat_dark_trim
    for side_sign in (1.0, -1.0):
        trim.add_box(
            (side_sign * (st_mid["hw"] - 0.032), skirt_yc, st_mid["z_sill"] + 0.020),
            (0.082, skirt_y1 - skirt_y0, 0.044),
            skirt_mat,
            bevel=0.012,
            smooth=True,
        )

    # 2c. Curved Flush Honeycomb Front Intake Grille (sits cleanly IN FRONT of the +0.065m recessed cavity!)
    g_u_max = 0.58 if p.is_coupe else (0.55 if p.is_police else 0.52)
    g_zn0, g_zn1 = (0.14, 0.62) if p.is_coupe else (0.18, 0.64)
    g_cols, g_rows = 14, 5
    grille_grid: List[List[Tuple[float, float, float]]] = []
    grille_uvs: List[List[Tuple[float, float]]] = []
    for r in range(g_rows):
        vr = r / (g_rows - 1)
        zn = lerp(g_zn0, g_zn1, vr)
        row_p, row_u = [], []
        for c in range(g_cols):
            uc = c / (g_cols - 1)
            ux = lerp(-g_u_max, g_u_max, uc)
            pt = _nose_surface_pt(p, st0, ux, zn)
            # Sit cleanly recessed -0.008m from nominal bumper line (still 0.055m AHEAD of the inset painted cavity!)
            row_p.append((pt[0], pt[1] + 0.010, pt[2]))
            row_u.append((uc * 3.4, vr * 1.15))
        grille_grid.append(row_p)
        grille_uvs.append(row_u)
    trim.add_grid(grille_grid, mat_grille, smooth=True, uv_grid=grille_uvs, flip=True)

    # Sculpted Curved Grille Perimeter Frame hugging exact nose contour!
    frame_ring = []
    for c in range(g_cols):
        ux = lerp(-g_u_max, g_u_max, c / (g_cols - 1))
        pt = _nose_surface_pt(p, st0, ux, g_zn0)
        frame_ring.append((pt[0], pt[1] - 0.006, pt[2]))
    for r in range(1, g_rows):
        zn = lerp(g_zn0, g_zn1, r / (g_rows - 1))
        pt = _nose_surface_pt(p, st0, g_u_max, zn)
        frame_ring.append((pt[0], pt[1] - 0.006, pt[2]))
    for c in range(g_cols - 2, -1, -1):
        ux = lerp(-g_u_max, g_u_max, c / (g_cols - 1))
        pt = _nose_surface_pt(p, st0, ux, g_zn1)
        frame_ring.append((pt[0], pt[1] - 0.006, pt[2]))
    for r in range(g_rows - 2, -1, -1):
        zn = lerp(g_zn0, g_zn1, r / (g_rows - 1))
        pt = _nose_surface_pt(p, st0, -g_u_max, zn)
        frame_ring.append((pt[0], pt[1] - 0.006, pt[2]))
    trim.add_tube(frame_ring, 0.014, mat_chrome if not p.is_coupe else mat_dark_trim, segments=8, smooth=True, cap=False)

    # Central horizontal grille trim bar + metallic roundel badge on upper nose
    bar_pts = [_nose_surface_pt(p, st0, lerp(-g_u_max * 0.92, g_u_max * 0.92, k / 8.0), lerp(g_zn0, g_zn1, 0.58)) for k in range(9)]
    bar_pts = [(pt[0], pt[1] - 0.008, pt[2]) for pt in bar_pts]
    trim.add_tube(bar_pts, 0.011, mat_chrome, segments=8, smooth=True)
    badge_pt = _nose_surface_pt(p, st0, 0.0, 0.78)
    trim.add_cylinder((badge_pt[0], badge_pt[1] - 0.010, badge_pt[2]), 0.036, 0.034, 0.012, mat_chrome, segments=18, rot=(math.radians(74), 0.0, 0.0))

    # Conformal Corner Brake-Cooling Air Intakes (curved flush patches along lower cheeks — ZERO protruding boxes!)
    for side_sign in (1.0, -1.0):
        ci_grid = []
        ci_uvs = []
        for r in range(3):
            zn = lerp(0.14, 0.42, r / 2.0)
            rp, ru = [], []
            for c in range(5):
                ux = side_sign * lerp(0.64, 0.91, c / 4.0)
                pt = _nose_surface_pt(p, st0, ux, zn)
                # Slightly proud by 0.005m with dark bezel rim
                out_x = side_sign * 0.004 * (c / 4.0)
                rp.append((pt[0] + out_x, pt[1] - 0.005, pt[2]))
                ru.append((c / 4.0 * 1.4, r / 2.0 * 0.7))
            ci_grid.append(rp)
            ci_uvs.append(ru)
        trim.add_grid(ci_grid, mat_grille, smooth=True, uv_grid=ci_uvs, flip=(side_sign > 0.0))
        # Crisp aero winglet strake conforming cleanly across corner intake!
        w_pts = []
        for c in range(5):
            ux = side_sign * lerp(0.65, 0.90, c / 4.0)
            pt = _nose_surface_pt(p, st0, ux, 0.28)
            w_pts.append((pt[0] + side_sign * 0.006, pt[1] - 0.012, pt[2]))
        trim.add_tube(w_pts, 0.010, skirt_mat, segments=8, smooth=True, oval_ratio=0.45)

    # Curved Aerodynamic Front Chin Splitter Lip following exact nose lower edge
    split_pts = []
    for k in range(13):
        ux = lerp(-0.96, 0.96, k / 12.0)
        pt = _nose_surface_pt(p, st0, ux, 0.02)
        split_pts.append((pt[0], pt[1] - 0.018, pt[2] + 0.004))
    trim.add_tube(split_pts, 0.020, skirt_mat, segments=8, smooth=True, oval_ratio=0.48)

    # 2d. Conformal Swept-Back Headlight Optical Housings (ZERO protruding boxes!)
    # Sweeps gracefully from u_x = 0.56 (beside grille) around the rounded corner to u_x = 0.95 (fender cheek)!
    hl_u0, hl_u1 = (0.54, 0.95) if p.is_coupe else (0.56, 0.94)
    hl_z0, hl_z1 = (0.64, 0.84) if p.is_coupe else (0.65, 0.85)
    for side_sign in (1.0, -1.0):
        # Dark glossy curved inner housing backplate strictly conformal to nose contour!
        hb_grid = []
        lens_grid = []
        for r in range(4):
            vr = r / 3.0
            row_hb, row_ln = [], []
            for c in range(7):
                uc = c / 6.0
                # Tapered sleek European headlamp silhouette (slimmer near grille, wider outer brow!)
                taper = 0.72 + 0.28 * math.sin(uc * math.pi * 0.75)
                zn_mid = lerp(hl_z0, hl_z1, 0.5) + 0.045 * uc  # sweeps dynamically upward toward fender!
                zn_half = 0.5 * (hl_z1 - hl_z0) * taper
                zn = zn_mid + (vr - 0.5) * 2.0 * zn_half
                ux = side_sign * lerp(hl_u0, hl_u1, uc)
                pt = _nose_surface_pt(p, st0, ux, zn)
                # Outward normal direction on rounded corner
                nx = side_sign * (0.20 + 0.65 * uc * uc)
                ny = -(1.0 - 0.45 * uc * uc)
                nlen = math.hypot(nx, ny)
                nx /= nlen
                ny /= nlen
                row_hb.append((pt[0] + nx * 0.006, pt[1] + ny * 0.006, pt[2]))
                row_ln.append((pt[0] + nx * 0.022, pt[1] + ny * 0.022, pt[2]))
            hb_grid.append(row_hb)
            lens_grid.append(row_ln)
        trim.add_grid(hb_grid, mat_dark_trim, smooth=True, flip=(side_sign > 0.0))
        trim.add_grid(lens_grid, mat_clear_lens, smooth=True, flip=(side_sign > 0.0))
        # Subtle dark chrome perimeter bezel framing the swept headlamp
        bezel_top = [hb_grid[3][c] for c in range(7)]
        bezel_bot = [hb_grid[0][c] for c in range(7)]
        trim.add_tube(bezel_top, 0.007, mat_dark_trim, segments=6, smooth=True)
        trim.add_tube(bezel_bot, 0.007, mat_dark_trim, segments=6, smooth=True)

        # Twin brushed-metallic projector shrouds sitting cleanly in front of dark backplate
        for uc_p in (0.32, 0.64):
            ux = side_sign * lerp(hl_u0, hl_u1, uc_p)
            zn = lerp(hl_z0, hl_z1, 0.52) + 0.045 * uc_p
            pt = _nose_surface_pt(p, st0, ux, zn)
            yaw = -side_sign * (0.18 + 0.35 * uc_p)
            trim.add_cylinder(
                (pt[0] + side_sign * 0.006, pt[1] - 0.010, pt[2]),
                0.032,
                0.028,
                0.020,
                mat_chrome,
                segments=16,
                rot=(math.pi * 0.5, 0.0, yaw),
            )

    # 2e. Conformal Swept Rear Taillight Smoked Housing Channel (ZERO protruding boxes!)
    tl_z0, tl_z1 = (0.66, 0.84) if p.is_coupe else (0.68, 0.86)
    if p.is_coupe:
        # Full-width sleek smoked optical tail channel sweeping seamlessly corner-to-corner!
        tb_grid = []
        for r in range(3):
            zn = lerp(tl_z0, tl_z1, r / 2.0)
            row_tb = []
            for c in range(15):
                ux = lerp(-0.92, 0.92, c / 14.0)
                pt = _tail_surface_pt(p, stN, ux, zn)
                nx = (0.55 * ux * abs(ux))
                ny = 1.0 - 0.35 * ux * ux
                nl = math.hypot(nx, ny)
                row_tb.append((pt[0] + (nx / nl) * 0.007, pt[1] + (ny / nl) * 0.007, pt[2]))
            tb_grid.append(row_tb)
        trim.add_grid(tb_grid, mat_dark_trim, smooth=True, flip=False)
    else:
        for side_sign in (1.0, -1.0):
            tb_grid = []
            for r in range(3):
                zn = lerp(tl_z0, tl_z1, r / 2.0)
                row_tb = []
                for c in range(7):
                    uc = c / 6.0
                    ux = side_sign * lerp(0.42, 0.93, uc)
                    pt = _tail_surface_pt(p, stN, ux, zn)
                    nx = side_sign * (0.15 + 0.65 * uc * uc)
                    ny = 1.0 - 0.42 * uc * uc
                    nl = math.hypot(nx, ny)
                    row_tb.append((pt[0] + (nx / nl) * 0.007, pt[1] + (ny / nl) * 0.007, pt[2]))
                tb_grid.append(row_tb)
            trim.add_grid(tb_grid, mat_dark_trim, smooth=True, flip=(side_sign < 0.0))

    # 2f. Sculpted Rear Diffuser + Vertical Strakes + Beveled Exhaust Tips + Coupe Ducktail Lip
    diff_pts_top = [_tail_surface_pt(p, stN, lerp(-0.82, 0.82, k / 10.0), 0.24) for k in range(11)]
    diff_pts_bot = [_tail_surface_pt(p, stN, lerp(-0.82, 0.82, k / 10.0), 0.02) for k in range(11)]
    diff_grid = [
        [(pt[0], pt[1] + 0.012, pt[2]) for pt in diff_pts_bot],
        [(pt[0], pt[1] + 0.010, pt[2]) for pt in diff_pts_top],
    ]
    trim.add_grid(diff_grid, skirt_mat, smooth=True, flip=False)
    diff_z = stN["z_sill"] + 0.068
    if p.is_coupe:
        for fx in (-0.30, -0.11, 0.11, 0.30):
            pt_f = _tail_surface_pt(p, stN, fx / stN["hw"], 0.12)
            trim.add_box((fx, pt_f[1] + 0.022, pt_f[2]), (0.016, 0.10, 0.10), mat_carbon, bevel=0.004)
        for ex in (-0.54, -0.42, 0.42, 0.54):
            pt_e = _tail_surface_pt(p, stN, ex / stN["hw"], 0.10)
            trim.add_cylinder((ex, pt_e[1] + 0.032, pt_e[2]), 0.044, 0.041, 0.11, mat_chrome, segments=18, rot=(math.pi * 0.5, 0.0, 0.0))
            trim.add_cylinder((ex, pt_e[1] + 0.052, pt_e[2]), 0.032, 0.032, 0.08, mat_dark_trim, segments=14, rot=(math.pi * 0.5, 0.0, 0.0))
        # Sleek carbon trunk ducktail lip spoiler
        sp_pts = []
        for k in range(11):
            ux = lerp(-0.82, 0.82, k / 10.0)
            pt = _tail_surface_pt(p, stN, ux, 0.98)
            sp_pts.append((pt[0], pt[1] + 0.012, pt[2] + 0.012))
        trim.add_tube(sp_pts, 0.018, mat_carbon, segments=8, smooth=True, oval_ratio=0.42)
    else:
        for ex in (-0.50, 0.50):
            pt_e = _tail_surface_pt(p, stN, ex / stN["hw"], 0.10)
            trim.add_cylinder((ex, pt_e[1] + 0.022, pt_e[2]), 0.040, 0.038, 0.10, mat_chrome, segments=16, rot=(math.pi * 0.5, 0.0, 0.0))
            trim.add_cylinder((ex, pt_e[1] + 0.040, pt_e[2]), 0.029, 0.029, 0.08, mat_dark_trim, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))

    # 2g. Sculpted Aerodynamic Wing Mirrors
    st_mir = eval_body_station(p, p.y_cowl + 0.24)
    mir_mat = mat_carbon if p.is_coupe else (mat_dark_trim if p.is_police else mat_paint)
    for side_sign in (1.0, -1.0):
        mx0 = side_sign * (st_mir["hw"] * 0.88)
        mz0 = st_mir["z_belt"] + 0.008
        my0 = p.y_cowl + 0.24
        trim.add_tube(
            [
                (mx0, my0, mz0),
                (side_sign * (abs(mx0) + 0.068), my0 + 0.028, mz0 + 0.042),
                (side_sign * (abs(mx0) + 0.125), my0 + 0.052, mz0 + 0.068),
            ],
            [0.020, 0.017, 0.015],
            mat_dark_trim,
            segments=8,
            smooth=True,
        )
        trim.add_box(
            (side_sign * (abs(mx0) + 0.158), my0 + 0.050, mz0 + 0.078),
            (0.168, 0.108, 0.088),
            mir_mat,
            rot=(0.0, side_sign * 0.08, -side_sign * 0.18),
            bevel=0.034,
            bevel_segments=3,
            smooth=True,
            taper_top=(0.86, 0.82),
        )
        trim.add_box(
            (side_sign * (abs(mx0) + 0.160), my0 + 0.098, mz0 + 0.078),
            (0.138, 0.012, 0.068),
            mat_chrome,
            rot=(0.0, 0.0, -side_sign * 0.18),
            bevel=0.004,
            smooth=False,
        )

    # 2h. Flush Door Handles (2 on coupe, 4 on sedan/sportback)
    handle_ys = [p.y_b_pillar - 0.18] if p.is_coupe else [p.y_b_pillar - 0.22, p.y_b_pillar + 0.65]
    for hy in handle_ys:
        sth = eval_body_station(p, hy)
        for side_sign in (1.0, -1.0):
            hx = side_sign * (sth["hw"] * 0.994)
            hz = lerp(sth["z_sill"], sth["z_belt"], 0.77)
            trim.add_box(
                (hx, hy, hz),
                (0.024, 0.150, 0.030),
                mat_chrome if p.is_coupe else mat_dark_trim,
                bevel=0.008,
                smooth=True,
            )

    # 2i. Police-Specific Sleek European Tubular Interceptor Push-Bar & TETRA Antennas
    if p.is_police:
        pb_pt_mid = _nose_surface_pt(p, st0, 0.0, 0.42)
        pb_y = pb_pt_mid[1] - 0.062
        for side_sign in (1.0, -1.0):
            up_pts = [
                (side_sign * 0.34, pb_y + 0.055, 0.25),
                (side_sign * 0.34, pb_y - 0.015, 0.42),
                (side_sign * 0.33, pb_y + 0.010, 0.60),
                (side_sign * 0.33, pb_y + 0.095, 0.66),
            ]
            trim.add_tube(up_pts, 0.022, mat_dark_trim, segments=10, smooth=True)
        for bz, by_off in ((0.39, -0.020), (0.56, 0.002)):
            bar_pts = [
                (-0.44, pb_y + 0.038 + by_off, bz),
                (-0.20, pb_y - 0.010 + by_off, bz),
                (0.0,   pb_y - 0.022 + by_off, bz),
                (0.20,  pb_y - 0.010 + by_off, bz),
                (0.44,  pb_y + 0.038 + by_off, bz),
            ]
            trim.add_tube(bar_pts, 0.018, mat_dark_trim, segments=10, smooth=True)
        # Dual European TETRA police radio whip antennas
        for ax, ay, ah in ((0.0, p.y_roof_r - 0.20, 0.28), (0.46, p.y_rear - 0.34, 0.44)):
            az_base = p.z_roof_r + 0.02 if ay < p.y_deck else (eval_body_station(p, ay)["z_ctr"] + 0.01)
            trim.add_cylinder((ax, ay, az_base + 0.012), 0.018, 0.012, 0.026, mat_dark_trim, segments=10)
            trim.add_cylinder((ax, ay, az_base + ah * 0.5 + 0.018), 0.006, 0.003, ah, mat_dark_trim, segments=8)
    else:
        trim.add_box(
            (0.0, p.y_roof_r - 0.22, p.z_roof_r + 0.036),
            (0.032, 0.140, 0.052),
            mat_dark_trim,
            rot=(0.18, 0.0, 0.0),
            bevel=0.011,
            taper_top=(0.35, 0.45),
            smooth=True,
        )

    # 2j. Crisp Embossed Front & Rear EU License Plates seated cleanly proud of backing!
    fp_pt = _nose_surface_pt(p, st0, 0.0, 0.21)
    fp_y = fp_pt[1] - 0.024
    trim.add_box((0.0, fp_y + 0.010, fp_pt[2]), (0.49, 0.012, 0.114), mat_dark_trim, bevel=0.003, smooth=False)
    trim.add_plate_quad((0.0, fp_y, fp_pt[2]), 0.47, 0.104, mat_plate, facing_front=True)

    rp_pt = _tail_surface_pt(p, stN, 0.0, 0.45)
    rp_y = rp_pt[1] + 0.020
    trim.add_box((0.0, rp_y - 0.010, rp_pt[2]), (0.49, 0.012, 0.114), mat_dark_trim, bevel=0.003, smooth=False)
    trim.add_plate_quad((0.0, rp_y, rp_pt[2]), 0.47, 0.104, mat_plate, facing_front=False)

    trim_obj = trim.finalize(
        f"{p.name}_Trim",
        subsurf_levels=0,
        weighted_normals=True,
        sharp_angle_deg=45.0,
        box_uv_scale=1.1,
        merge_dist=0.0005,
    )

    info = {
        "st0": st0,
        "stN": stN,
        "hl_u0": hl_u0,
        "hl_u1": hl_u1,
        "hl_z0": hl_z0,
        "hl_z1": hl_z1,
        "tl_z0": tl_z0,
        "tl_z1": tl_z1,
    }
    return join_objects([shell_obj, trim_obj], f"{p.name}_LowerBody"), info


# ---------------------------------------------------------------------------
# Continuous Seamless Double-Curved Greenhouse & Flush Glass (Zero Roof Gaps!)
# ---------------------------------------------------------------------------

def build_greenhouse_and_glass(
    p: CarProfile,
    mat_roof_paint: bpy.types.Material,
    mat_pillar_paint: bpy.types.Material,
    mat_black_gloss: bpy.types.Material,
    mat_chrome: bpy.types.Material,
    mat_glass: bpy.types.Material,
) -> Tuple[bpy.types.Object, bpy.types.Object]:
    st_cowl = eval_body_station(p, p.y_cowl)
    st_deck = eval_body_station(p, p.y_deck)

    def belt_hw(y: float) -> float:
        return eval_body_station(p, y)["hw"] * 0.882

    def belt_z(y: float) -> float:
        return eval_body_station(p, y)["z_belt"]

    def roof_hw(y: float) -> float:
        t = clamp((y - p.y_roof_f) / max(1e-4, p.y_roof_r - p.y_roof_f), 0.0, 1.0)
        if t < 0.5:
            return lerp(p.hw_roof_f, p.hw_roof_mid, smoothstep(0.0, 0.5, t))
        return lerp(p.hw_roof_mid, p.hw_roof_r, smoothstep(0.5, 1.0, t))

    def roof_edge_z(y: float) -> float:
        t = clamp((y - p.y_roof_f) / max(1e-4, p.y_roof_r - p.y_roof_f), 0.0, 1.0)
        if t < 0.5:
            return lerp(p.z_roof_f, p.z_roof_mid, smoothstep(0.0, 0.5, t))
        return lerp(p.z_roof_mid, p.z_roof_r, smoothstep(0.5, 1.0, t))

    def roof_center_z(y: float) -> float:
        return roof_edge_z(y) + 0.044

    def glass_side_pt(y_b: float, y_t: float, side_sign: float, v: float, inset: float = 0.0) -> Tuple[float, float, float]:
        """Curved barrel-tumblehome side greenhouse point extending cleanly into beltline & cantrail."""
        vc = clamp(v, -0.02, 1.02)
        y = lerp(y_b, y_t, vc)
        x0 = belt_hw(y_b)
        z0 = belt_z(y_b) - 0.012
        x1 = roof_hw(y_t)
        z1 = roof_edge_z(y_t) + 0.004
        sin_v = math.sin(clamp(vc, 0.0, 1.0) * math.pi)
        bulge_x = 0.036 * sin_v
        bulge_z = 0.014 * sin_v
        x = lerp(x0, x1, clamp(vc, 0.0, 1.0) ** 1.04) + bulge_x - inset
        z = lerp(z0, z1, clamp(vc, 0.0, 1.0) ** 0.94) + bulge_z
        return (side_sign * x, y, z)

    def windshield_pt(u: float, v: float, inset: float = 0.0) -> Tuple[float, float, float]:
        vc = clamp(v, 0.0, 1.0)
        x_bot = u * (st_cowl["hw"] * 0.875)
        x_top = u * p.hw_roof_f
        x = lerp(x_bot, x_top, vc ** 1.04)
        bow_y = -p.windshield_bow * (1.0 - u * u) * (1.0 - 0.14 * vc)
        y = lerp(p.y_cowl, p.y_roof_f, v) + bow_y + inset
        z_bot = st_cowl["z_belt"] + 0.036 * (1.0 - u * u) - 0.016
        z_top = p.z_roof_f + 0.044 * (1.0 - u * u) + 0.004
        z = lerp(z_bot, z_top, v) + 0.020 * math.sin(vc * math.pi) - inset * 0.35
        return (x, y, z)

    def rearglass_pt(u: float, v: float, inset: float = 0.0) -> Tuple[float, float, float]:
        vc = clamp(v, 0.0, 1.0)
        x_top = u * p.hw_roof_r
        x_bot = u * (st_deck["hw"] * 0.870)
        x = lerp(x_top, x_bot, vc ** 0.96)
        bow_y = p.rear_glass_bow * (1.0 - u * u) * (0.86 + 0.14 * vc)
        y = lerp(p.y_roof_r, p.y_deck, v) + bow_y - inset
        z_top = p.z_roof_r + 0.044 * (1.0 - u * u) + 0.004
        z_bot = st_deck["z_belt"] + 0.032 * (1.0 - u * u) - 0.012
        z = lerp(z_top, z_bot, v) + (0.026 if p.is_coupe else 0.016) * math.sin(vc * math.pi) - inset * 0.35
        return (x, y, z)

    # A. Painted Roof Shell + Muscular Sculpted A/B/C Pillars + Window Surround
    gh = AutoMesh()

    roof_u_steps, roof_v_steps = 12, 11
    roof_outer, roof_inner = [], []
    for iv in range(roof_v_steps):
        tv = iv / (roof_v_steps - 1)
        y_base = lerp(p.y_roof_f, p.y_roof_r, tv)
        hw_r = roof_hw(y_base) + 0.008
        ze = roof_edge_z(y_base)
        zc = roof_center_z(y_base)
        row_o, row_i = [], []
        for iu in range(roof_u_steps):
            u = -1.0 + 2.0 * iu / (roof_u_steps - 1)
            bow = lerp(-p.windshield_bow * 0.86, p.rear_glass_bow * 0.86, tv) * (1.0 - u * u)
            x = u * hw_r
            z = lerp(ze, zc, math.cos(u * math.pi * 0.5) ** 0.85)
            row_o.append((x, y_base + bow, z + 0.005))
            row_i.append((x * 0.95, y_base + bow, z - 0.024))
        roof_outer.append(row_o)
        roof_inner.append(row_i)

    gh.add_grid(roof_outer, mat_roof_paint, smooth=True, flip=False)
    gh.add_grid(roof_inner, mat_black_gloss, smooth=True, flip=True)
    for r_edge in (0, roof_v_steps - 1):
        gh.add_grid([roof_outer[r_edge], roof_inner[r_edge]], mat_black_gloss, smooth=True, flip=(r_edge == 0))
    for c_edge in (0, roof_u_steps - 1):
        col_o = [roof_outer[iv][c_edge] for iv in range(roof_v_steps)]
        col_i = [roof_inner[iv][c_edge] for iv in range(roof_v_steps)]
        gh.add_grid([col_o, col_i], mat_roof_paint, smooth=True, flip=(c_edge == roof_u_steps - 1))

    # Muscular continuous A-pillar -> Cantrail -> C-pillar arch (single unbroken sculpted frame!)
    for side_sign in (1.0, -1.0):
        arch_pts: List[Tuple[float, float, float]] = []
        arch_rads: List[float] = []
        # A-pillar climbing from fender cowl to roof front header
        for iv in range(7):
            tv = iv / 6.0
            pt = windshield_pt(side_sign * 0.99, tv, inset=-0.008)
            arch_pts.append((pt[0], pt[1], pt[2] + 0.006))
            arch_rads.append(lerp(0.048, 0.042, tv))
        # Roof cantrail sweeping smoothly along roof edge
        for iv in range(1, 7):
            tv = iv / 6.0
            y_c = lerp(p.y_roof_f, p.y_roof_r, tv)
            arch_pts.append((side_sign * (roof_hw(y_c) + 0.004), y_c, roof_edge_z(y_c) + 0.004))
            arch_rads.append(0.042)
        # Sweeping muscular C-pillar descending cleanly into rear haunch
        c_max = 0.068 if p.is_coupe else (0.054 if p.is_hatchback else 0.058)
        for iv in range(1, 8):
            tv = iv / 7.0
            pt = rearglass_pt(side_sign * 0.99, tv, inset=-0.006)
            arch_pts.append((pt[0], pt[1] + 0.008, pt[2] + 0.002 - 0.016 * (tv ** 2)))
            arch_rads.append(lerp(0.042, c_max, math.sin(tv * math.pi * 0.72)))
        gh.add_tube(arch_pts, arch_rads, mat_pillar_paint, segments=12, smooth=True, oval_ratio=0.72)

        # Piano-black flush B-pillar dividing front & rear side windows
        b_pts = [glass_side_pt(p.y_b_pillar, p.y_b_pillar + 0.03, side_sign, iv / 6.0, inset=0.002) for iv in range(7)]
        gh.add_tube(b_pts, 0.030, mat_black_gloss, segments=8, smooth=True, oval_ratio=0.42)

        # Chrome / dark-gloss window beltline trim molding
        belt_pts = [
            (side_sign * (belt_hw(lerp(p.y_cowl + 0.02, p.y_deck - 0.02, iv / 12.0)) + 0.004),
             lerp(p.y_cowl + 0.02, p.y_deck - 0.02, iv / 12.0),
             belt_z(lerp(p.y_cowl + 0.02, p.y_deck - 0.02, iv / 12.0)) + 0.003)
            for iv in range(13)
        ]
        gh.add_tube(belt_pts, 0.011, mat_chrome if not p.is_police else mat_black_gloss, segments=8, smooth=True, oval_ratio=0.65)

        if p.is_hatchback and side_sign > 0:
            sp_pts = [rearglass_pt(-0.92 + 1.84 * k / 10.0, 0.03, inset=-0.035) for k in range(11)]
            gh.add_tube(sp_pts, 0.028, mat_roof_paint, segments=8, smooth=True, oval_ratio=0.48)

    if p.is_police:
        gh.bm.normal_update()
        bmesh.ops.recalc_face_normals(gh.bm, faces=list(gh.bm.faces))
        for f in gh.bm.faces:
            m_name = gh.materials[f.material_index].name
            if "Livery" in m_name:
                n = f.normal
                for lp in f.loops:
                    lp[gh.uv_layer].uv = _police_livery_uv(tuple(lp.vert.co), n, p)

    gh_obj = gh.finalize(
        f"{p.name}_Greenhouse",
        subsurf_levels=1,
        weighted_normals=True,
        sharp_angle_deg=55.0,
        box_uv_scale=0.65,
        merge_dist=0.001,
    )

    # B. Flush Double-Curved Smoked Glass tucked cleanly INSIDE pillars & roof cantrails (ZERO GAPS!)
    gl = AutoMesh()
    ws_grid = [[windshield_pt(-0.985 + 1.97 * iu / 12.0, -0.02 + 1.04 * iv / 8.0, inset=0.010) for iu in range(13)] for iv in range(9)]
    gl.add_grid(ws_grid, mat_glass, smooth=True, flip=True)

    rw_grid = [[rearglass_pt(-0.98 + 1.96 * iu / 12.0, -0.02 + 1.04 * iv / 8.0, inset=0.010) for iu in range(13)] for iv in range(9)]
    gl.add_grid(rw_grid, mat_glass, smooth=True, flip=True)

    for side_sign in (1.0, -1.0):
        side_g = []
        for iu in range(13):
            tu = iu / 12.0
            yb = lerp(p.y_cowl + 0.02, p.y_deck - 0.03, tu)
            yt = lerp(p.y_roof_f, p.y_roof_r, tu)
            row = [glass_side_pt(yb, yt, side_sign, -0.02 + 1.04 * iv / 6.0, inset=0.010) for iv in range(7)]
            side_g.append(row)
        gl.add_grid(side_g, mat_glass, smooth=True, flip=(side_sign < 0.0))

    glass_obj = gl.finalize("Glass", subsurf_levels=1, weighted_normals=False, box_uv_scale=0.5, merge_dist=0.001)
    return gh_obj, glass_obj


# ---------------------------------------------------------------------------
# Detailed Interior (Visible Through Tinted Glass)
# ---------------------------------------------------------------------------

def build_interior(
    p: CarProfile,
    mat_leather: bpy.types.Material,
    mat_dash: bpy.types.Material,
    mat_trim: bpy.types.Material,
    mat_screen_glow: bpy.types.Material,
) -> bpy.types.Object:
    intr = AutoMesh()
    hw_cab = eval_body_station(p, p.y_b_pillar)["hw"] * 0.78
    z_floor = min(k[1] for k in p.z_sill_knots) + 0.08
    z_belt = eval_body_station(p, p.y_cowl)["z_belt"]

    intr.add_box((0.0, 0.5 * (p.y_cowl + p.y_deck), z_floor + 0.05), (hw_cab * 1.92, p.y_deck - p.y_cowl, 0.12), mat_trim, smooth=False)
    intr.add_box((0.0, p.y_cowl + 0.02, z_belt - 0.30), (hw_cab * 1.82, 0.12, 0.44), mat_trim, smooth=False)
    intr.add_box((0.0, p.y_deck - 0.14, z_belt - 0.30), (hw_cab * 1.76, 0.12, 0.44), mat_trim, smooth=False)
    for sx in (-1.0, 1.0):
        intr.add_box((sx * (hw_cab * 0.92), 0.5 * (p.y_cowl + p.y_deck), z_belt - 0.26), (0.08, (p.y_deck - p.y_cowl) * 0.90, 0.40), mat_dash, bevel=0.015, smooth=True)

    dash_y = p.y_cowl + 0.22
    intr.add_box((0.0, dash_y, z_belt - 0.06), (hw_cab * 1.82, 0.42, 0.22), mat_dash, bevel=0.045, bevel_segments=2, smooth=True)
    intr.add_box((0.36, dash_y + 0.04, z_belt + 0.055), (0.38, 0.26, 0.12), mat_dash, bevel=0.03, smooth=True)
    intr.add_box((0.36, dash_y + 0.16, z_belt + 0.03), (0.28, 0.015, 0.075), mat_screen_glow, rot=(-0.18, 0.0, 0.0), smooth=False)
    intr.add_box((0.0, dash_y + 0.15, z_belt + 0.04), (0.26, 0.022, 0.14), mat_dash, rot=(-0.15, 0.0, 0.0), bevel=0.008)
    intr.add_box((0.0, dash_y + 0.162, z_belt + 0.04), (0.23, 0.008, 0.115), mat_screen_glow, rot=(-0.15, 0.0, 0.0), smooth=False)

    intr.add_box((0.0, p.y_b_pillar - 0.12, z_floor + 0.28), (0.26, 1.15, 0.34), mat_dash, bevel=0.035, smooth=True)
    intr.add_cylinder((0.0, p.y_cowl + 0.62, z_floor + 0.50), 0.022, 0.026, 0.14, mat_trim, segments=10, rot=(-0.18, 0.0, 0.0))

    # 3-spoke LHD steering wheel (+X)
    sw_c = (0.36, dash_y + 0.30, z_belt + 0.02)
    sw_tilt = math.radians(66.0)
    intr.add_torus(sw_c, 0.165, 0.018, mat_leather, major_segs=24, minor_segs=8, rot=(sw_tilt, 0.0, 0.0))
    intr.add_cylinder(sw_c, 0.056, 0.050, 0.040, mat_dash, segments=14, rot=(sw_tilt, 0.0, 0.0))
    intr.add_cylinder((0.36, dash_y + 0.20, z_belt - 0.02), 0.035, 0.038, 0.22, mat_trim, segments=10, rot=(sw_tilt, 0.0, 0.0))
    rot_m = Euler((sw_tilt, 0.0, 0.0), "XYZ").to_matrix()
    for ang_deg in (180.0, 0.0, -90.0):
        ang = math.radians(ang_deg)
        v_dir = rot_m @ Vector((math.cos(ang), math.sin(ang), 0.0))
        sp_pos = Vector(sw_c) + v_dir * 0.088
        intr.add_box(tuple(sp_pos), (0.13 if abs(math.cos(ang)) > 0.5 else 0.030, 0.024, 0.020 if abs(math.cos(ang)) > 0.5 else 0.13), mat_trim, rot=(sw_tilt, 0.0, 0.0), bevel=0.004)

    intr.add_box((0.0, p.y_roof_f + 0.08, p.z_roof_f - 0.085), (0.21, 0.042, 0.058), mat_trim, bevel=0.010, smooth=True)

    seat_y = p.y_b_pillar - 0.08
    for sx in (-0.36, 0.36):
        intr.add_box((sx, seat_y - 0.14, z_floor + 0.24), (0.44, 0.48, 0.14), mat_leather, bevel=0.04, smooth=True)
        for bx in (-0.19, 0.19):
            intr.add_box((sx + bx, seat_y - 0.12, z_floor + 0.30), (0.09, 0.44, 0.12), mat_leather, bevel=0.028, smooth=True)
        intr.add_box((sx, seat_y + 0.12, z_floor + 0.55), (0.42, 0.14, 0.54), mat_leather, rot=(0.22, 0.0, 0.0), bevel=0.04, smooth=True)
        for bx in (-0.18, 0.18):
            intr.add_box((sx + bx, seat_y + 0.08, z_floor + 0.53), (0.09, 0.14, 0.46), mat_leather, rot=(0.22, 0.0, 0.0), bevel=0.028, smooth=True)
        for px in (-0.055, 0.055):
            intr.add_cylinder((sx + px, seat_y + 0.19, z_floor + 0.83), 0.008, 0.008, 0.10, mat_trim, segments=8, rot=(0.18, 0.0, 0.0))
        intr.add_box((sx, seat_y + 0.20, z_floor + 0.91), (0.23, 0.10, 0.17), mat_leather, rot=(0.15, 0.0, 0.0), bevel=0.036, smooth=True)

    rear_y = p.y_deck - 0.48
    intr.add_box((0.0, rear_y - 0.12, z_floor + 0.26), (hw_cab * 1.66, 0.44, 0.16), mat_leather, bevel=0.04, smooth=True)
    intr.add_box((0.0, rear_y + 0.14, z_floor + 0.52), (hw_cab * 1.64, 0.15, 0.46), mat_leather, rot=(0.24, 0.0, 0.0), bevel=0.04, smooth=True)
    for rx in (-0.38, 0.38):
        intr.add_box((rx, rear_y + 0.20, z_floor + 0.79), (0.22, 0.10, 0.14), mat_leather, rot=(0.18, 0.0, 0.0), bevel=0.032, smooth=True)
    intr.add_box((0.0, p.y_deck - 0.14, z_belt - 0.04), (hw_cab * 1.62, 0.36, 0.06), mat_dash, bevel=0.015, smooth=True)

    if p.is_police:
        intr.add_box((0.0, p.y_b_pillar + 0.24, z_floor + 0.68), (hw_cab * 1.68, 0.03, 0.50), mat_trim, bevel=0.006, smooth=False)
        intr.add_box((0.05, dash_y + 0.36, z_belt + 0.04), (0.24, 0.025, 0.17), mat_screen_glow, rot=(-0.22, 0.0, -0.25), smooth=False)

    return intr.finalize("Interior", subsurf_levels=0, weighted_normals=True, sharp_angle_deg=50.0, box_uv_scale=1.6)


# ---------------------------------------------------------------------------
# Conformal Glowing Multi-Layer LED Headlights, Taillights & Brakelights
# ---------------------------------------------------------------------------

def build_lights(
    p: CarProfile,
    info: dict,
    mat_hl: bpy.types.Material,
    mat_tl: bpy.types.Material,
    mat_bl: bpy.types.Material,
) -> Tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    """Build razor-sharp conformal LED Headlights, Taillights, and Brakelights sitting cleanly
    VISIBLE IN FRONT OF the dark optical housings (single emissive material per named mesh!).
    """
    st0 = info["st0"]
    stN = info["stN"]
    hl_u0, hl_u1 = info["hl_u0"], info["hl_u1"]
    hl_z0, hl_z1 = info["hl_z0"], info["hl_z1"]
    tl_z0, tl_z1 = info["tl_z0"], info["tl_z1"]

    def hl_pt(side_sign: float, uc: float, vr: float, offset: float = 0.015) -> Tuple[float, float, float]:
        taper = 0.72 + 0.28 * math.sin(uc * math.pi * 0.75)
        zn_mid = lerp(hl_z0, hl_z1, 0.5) + 0.045 * uc
        zn_half = 0.5 * (hl_z1 - hl_z0) * taper
        zn = zn_mid + (vr - 0.5) * 2.0 * zn_half
        ux = side_sign * lerp(hl_u0, hl_u1, uc)
        pt = _nose_surface_pt(p, st0, ux, zn)
        nx = side_sign * (0.20 + 0.65 * uc * uc)
        ny = -(1.0 - 0.45 * uc * uc)
        nl = math.hypot(nx, ny)
        return (pt[0] + (nx / nl) * offset, pt[1] + (ny / nl) * offset, pt[2])

    def tl_pt(ux: float, zn: float, offset: float = 0.016) -> Tuple[float, float, float]:
        pt = _tail_surface_pt(p, stN, ux, zn)
        nx = 0.55 * ux * abs(ux)
        ny = 1.0 - 0.35 * ux * ux
        nl = math.hypot(nx, ny)
        return (pt[0] + (nx / nl) * offset, pt[1] + (ny / nl) * offset, pt[2])

    # 1. Headlights (glowing bi-LED projector cores + razor-sharp angular European LED DRL blades!)
    hl = AutoMesh()
    for side_sign in (1.0, -1.0):
        # Twin glowing circular projector cores sitting proud of dark reflector backing!
        for uc_p in (0.32, 0.64):
            pt = hl_pt(side_sign, uc_p, 0.52, offset=0.014)
            yaw = -side_sign * (0.18 + 0.35 * uc_p)
            hl.add_cylinder(pt, 0.025, 0.022, 0.018, mat_hl, segments=16, rot=(math.pi * 0.5, 0.0, yaw))
        # Iconic sweeping lower + outer angular European LED DRL signature blade!
        drl_pts = [
            hl_pt(side_sign, 0.04, 0.16, offset=0.016),
            hl_pt(side_sign, 0.32, 0.14, offset=0.016),
            hl_pt(side_sign, 0.66, 0.18, offset=0.016),
            hl_pt(side_sign, 0.94, 0.36, offset=0.016),
            hl_pt(side_sign, 0.96, 0.78, offset=0.016),
        ]
        hl.add_tube(drl_pts, 0.011, mat_hl, segments=8, smooth=True)
        # Upper sleek LED laser-brow accent
        brow_pts = [
            hl_pt(side_sign, 0.06, 0.84, offset=0.015),
            hl_pt(side_sign, 0.48, 0.86, offset=0.015),
            hl_pt(side_sign, 0.88, 0.88, offset=0.015),
        ]
        hl.add_tube(brow_pts, 0.0085 if p.is_coupe else 0.007, mat_hl, segments=8, smooth=True)
    hl_obj = hl.finalize("Headlights", subsurf_levels=0, weighted_normals=False)

    # 2. Taillights (vivid sculpted red OLED light-bar + wraparound blades proud of smoked tail housing!)
    tl = AutoMesh()
    zn_mid = 0.5 * (tl_z0 + tl_z1)
    if p.is_coupe:
        # Full-width dramatic curved OLED light-blade sweeping across entire tail!
        bar_pts = [tl_pt(lerp(-0.90, 0.90, k / 16.0), zn_mid + 0.032, offset=0.016) for k in range(17)]
        tl.add_tube(bar_pts, 0.012, mat_tl, segments=8, smooth=True, oval_ratio=0.60)
        # Sculpted lower & outer wraparound OLED wings!
        for side_sign in (1.0, -1.0):
            wing_pts = [
                tl_pt(side_sign * 0.44, tl_z0 + 0.025, offset=0.016),
                tl_pt(side_sign * 0.72, tl_z0 + 0.025, offset=0.016),
                tl_pt(side_sign * 0.91, zn_mid, offset=0.016),
                tl_pt(side_sign * 0.88, tl_z1 - 0.020, offset=0.016),
            ]
            tl.add_tube(wing_pts, 0.013, mat_tl, segments=8, smooth=True)
    else:
        # Modern European wraparound C-blade LED taillights (police sedan & compact sportback)
        for side_sign in (1.0, -1.0):
            c_pts = [
                tl_pt(side_sign * 0.44, tl_z1 - 0.025, offset=0.016),
                tl_pt(side_sign * 0.74, tl_z1 - 0.025, offset=0.016),
                tl_pt(side_sign * 0.91, zn_mid, offset=0.016),
                tl_pt(side_sign * 0.74, tl_z0 + 0.025, offset=0.016),
                tl_pt(side_sign * 0.46, tl_z0 + 0.025, offset=0.016),
            ]
            tl.add_tube(c_pts, 0.013, mat_tl, segments=8, smooth=True)
    tl_obj = tl.finalize("Taillights", subsurf_levels=0, weighted_normals=False)

    # 3. Brakelights (distinct segmented scarlet brake matrix clusters + sleek upper rear-window CHMSL!)
    bl = AutoMesh()
    for side_sign in (1.0, -1.0):
        for k in range(3):
            ux = side_sign * (0.52 + k * 0.11)
            pt = tl_pt(ux, zn_mid - 0.008, offset=0.015)
            bl.add_box(pt, (0.068, 0.020, 0.036), mat_bl, rot=(0.0, 0.0, side_sign * (0.14 + k * 0.08)), bevel=0.005, smooth=True)
    # Center High-Mount Stop Lamp (CHMSL) tucked cleanly at top of rear glass!
    chmsl_y = lerp(p.y_roof_r, p.y_deck, 0.07) + p.rear_glass_bow * 0.84
    chmsl_z = p.z_roof_r + 0.028
    bl.add_box((0.0, chmsl_y, chmsl_z), (0.36, 0.024, 0.018), mat_bl, bevel=0.005, smooth=True)
    bl_obj = bl.finalize("Brakelights", subsurf_levels=0, weighted_normals=False)

    return hl_obj, tl_obj, bl_obj


# ---------------------------------------------------------------------------
# Police Aerodynamic Roof LED Lightbar
# ---------------------------------------------------------------------------

def build_police_lightbar(
    p: CarProfile,
    mat_dark_trim: bpy.types.Material,
    mat_chrome: bpy.types.Material,
    mat_blue_led: bpy.types.Material,
    mat_red_led: bpy.types.Material,
) -> Tuple[bpy.types.Object, bpy.types.Object, bpy.types.Object]:
    lb_y = p.y_b_pillar + 0.05
    z_roof = p.z_roof_mid + 0.044

    base = AutoMesh()
    for sx in (-0.54, 0.54):
        base.add_box((sx, lb_y, z_roof + 0.012), (0.11, 0.22, 0.046), mat_dark_trim, rot=(0.0, sx * 0.12, 0.0), bevel=0.010, smooth=True)
    base.add_box((0.0, lb_y, z_roof + 0.042), (1.16, 0.23, 0.024), mat_dark_trim, bevel=0.008, smooth=True)
    base.add_box((0.0, lb_y, z_roof + 0.078), (0.24, 0.25, 0.068), mat_chrome, bevel=0.016, taper_top=(0.90, 0.78), smooth=True)
    base.add_box((0.0, lb_y, z_roof + 0.080), (0.18, 0.26, 0.042), mat_dark_trim, bevel=0.010, smooth=True)
    for sx in (-0.59, 0.59):
        base.add_box((sx, lb_y, z_roof + 0.078), (0.044, 0.23, 0.064), mat_dark_trim, bevel=0.014, taper_top=(0.75, 0.75), smooth=True)
    base_obj = base.finalize("Lightbar_Base", subsurf_levels=0, weighted_normals=True)

    blue = AutoMesh()
    blue.add_box((0.35, lb_y, z_roof + 0.080), (0.45, 0.235, 0.068), mat_blue_led, bevel=0.022, bevel_segments=3, taper_top=(0.94, 0.72), smooth=True)
    # Front subtle blue grille strobe pip
    blue.add_box((0.20, p.y_front - 0.005, 0.45), (0.085, 0.020, 0.024), mat_blue_led, bevel=0.004, smooth=True)
    blue_obj = blue.finalize("Lightbar_Blue", subsurf_levels=0, weighted_normals=True)

    red = AutoMesh()
    red.add_box((-0.35, lb_y, z_roof + 0.080), (0.45, 0.235, 0.068), mat_red_led, bevel=0.022, bevel_segments=3, taper_top=(0.94, 0.72), smooth=True)
    red.add_box((-0.20, p.y_front - 0.005, 0.45), (0.085, 0.020, 0.024), mat_red_led, bevel=0.004, smooth=True)
    red_obj = red.finalize("Lightbar_Red", subsurf_levels=0, weighted_normals=True)

    return base_obj, blue_obj, red_obj


# ---------------------------------------------------------------------------
# Showroom-Grade Forged Multi-Spoke Alloy Wheels + Treaded Tires + Brakes
# ---------------------------------------------------------------------------

def build_wheel(
    name: str,
    location: Tuple[float, float, float],
    radius: float,
    width: float,
    is_left: bool,
    is_front: bool,
    mat_tire: bpy.types.Material,
    mat_sidewall: bpy.types.Material,
    mat_rim: bpy.types.Material,
    mat_rim_dark: bpy.types.Material,
    mat_rotor: bpy.types.Material,
    mat_caliper: bpy.types.Material,
    mat_chrome: bpy.types.Material,
    style: str = "y_spoke",
) -> bpy.types.Object:
    """Build a showroom-grade wheel pivoted STRICTLY at axle hub center (0,0,0 local).
    - Fixed outward-facing rim barrel & bright diamond-cut outer rim lip!
    - Sculpted forged concave alloy spokes connecting solidly into the rim lip!
    - Cross-drilled steel brake rotor + Brembo-style multi-piston caliper!
    """
    mb = AutoMesh()
    s = 1.0 if is_left else -1.0
    hw = width * 0.5
    r_out = radius
    r_rim = radius * (0.70 if style == "y_spoke" else (0.66 if style == "patrol" else 0.65))
    segs = 24

    def ring_at(xp: float, rad: float) -> List[Tuple[float, float, float]]:
        return [
            (xp, math.cos(2.0 * math.pi * i / segs) * rad, math.sin(2.0 * math.pi * i / segs) * rad)
            for i in range(segs)
        ]

    # 1. Sculpted Tire Tread Crown with 4 real 3D rain grooves + cylindrical UVs for gpt-image-2 tire_tread!
    tread_profile = [
        (-hw * 0.84, r_out * 0.985),
        (-hw * 0.62, r_out),
        (-hw * 0.42, r_out),
        (-hw * 0.38, r_out - 0.006),
        (-hw * 0.34, r_out),
        (-hw * 0.13, r_out),
        (-hw * 0.09, r_out - 0.006),
        (-hw * 0.05, r_out),
        (hw * 0.05,  r_out),
        (hw * 0.09,  r_out - 0.006),
        (hw * 0.13,  r_out),
        (hw * 0.34,  r_out),
        (hw * 0.38,  r_out - 0.006),
        (hw * 0.42,  r_out),
        (hw * 0.62,  r_out),
        (hw * 0.84,  r_out * 0.985),
    ]
    mb.add_loft(
        [ring_at(xp, rr) for xp, rr in tread_profile],
        mat_tire,
        smooth=True,
        closed_u=True,
        uv_fn=lambda r_i, j, m, n: (r_i / max(1, m - 1), (j / n) * 5.0),
    )

    # 2. Rounded Bulging Tire Sidewalls (inner & outer)
    # Note: for ring_at (cos, sin) going +theta around X:
    # A loft moving from smaller radius to larger radius on +X face has outward normal +X if flipped properly!
    outer_sw = [
        (hw * 0.84, r_out * 0.985),
        (hw * 0.97, r_out * 0.952),
        (hw * 1.01, lerp(r_rim, r_out, 0.56)),
        (hw * 0.98, lerp(r_rim, r_out, 0.20)),
        (hw * 0.93, r_rim * 1.04),
        (hw * 0.84, r_rim * 1.00),
    ]
    mb.add_loft([ring_at(xp, rr) for xp, rr in outer_sw], mat_sidewall, smooth=True, closed_u=True)

    inner_sw = [
        (-hw * 0.84, r_rim * 1.00),
        (-hw * 0.93, r_rim * 1.04),
        (-hw * 0.98, lerp(r_rim, r_out, 0.20)),
        (-hw * 1.01, lerp(r_rim, r_out, 0.56)),
        (-hw * 0.97, r_out * 0.952),
        (-hw * 0.84, r_out * 0.985),
    ]
    mb.add_loft([ring_at(xp, rr) for xp, rr in inner_sw], mat_sidewall, smooth=True, closed_u=True)

    # 3. Solid Closed Stepped Alloy Rim Barrel + Bright Diamond-Cut Outer Rim Lip Ring!
    # Built as a continuous closed cross-section loop so EVERY face has guaranteed outward normals!
    # Outer visible bright metallic rim flange ring (using add_torus -> 100% solid outward normals!)
    mb.add_torus(
        (s * hw * 0.84, 0.0, 0.0),
        r_rim * 0.975,
        r_rim * 0.062,
        mat_rim,
        major_segs=segs,
        minor_segs=7,
        rot=(0.0, math.pi * 0.5, 0.0),
    )
    # Secondary inner recessed metallic step ring
    mb.add_torus(
        (s * hw * 0.68, 0.0, 0.0),
        r_rim * 0.92,
        r_rim * 0.045,
        mat_rim_dark,
        major_segs=segs,
        minor_segs=6,
        rot=(0.0, math.pi * 0.5, 0.0),
    )
    # Inner dark alloy barrel drum (closed cylinder wall visible between spokes!)
    mb.add_cylinder((0.0, 0.0, 0.0), r_rim * 0.96, r_rim * 0.96, width * 1.56 * 0.5, mat_rim_dark, segments=segs, rot=(0.0, math.pi * 0.5, 0.0), cap=False)
    # Inner solid backing disc deep inside the wheel so no light passes through axle
    mb.add_cylinder((-s * hw * 0.55, 0.0, 0.0), r_rim * 0.94, r_rim * 0.94, 0.025, mat_rim_dark, segments=segs, rot=(0.0, math.pi * 0.5, 0.0), cap=True)

    # 4. Sculpted Concave Forged Multi-Spoke Face (bold diamond-cut alloy spokes meeting rim lip!)
    hub_x = s * hw * 0.44
    outer_spoke_x = s * hw * 0.81
    r_hub = r_rim * 0.30

    mb.add_cylinder((hub_x, 0.0, 0.0), r_hub * 1.08, r_hub * 0.94, width * 0.16, mat_rim, segments=22, rot=(0.0, math.pi * 0.5, 0.0))
    mb.add_cylinder((hub_x + s * 0.020, 0.0, 0.0), r_hub * 0.42, r_hub * 0.40, 0.018, mat_rim_dark, segments=18, rot=(0.0, math.pi * 0.5, 0.0))
    for k in range(5):
        ang = 2.0 * math.pi * k / 5.0
        ly = math.cos(ang) * (r_hub * 0.70)
        lz = math.sin(ang) * (r_hub * 0.70)
        mb.add_cylinder((hub_x + s * 0.024, ly, lz), 0.011, 0.010, 0.022, mat_chrome, segments=6, rot=(0.0, math.pi * 0.5, 0.0), smooth=False)

    # Bold sculpted forged Y-spokes / twin-spokes flaring solidly into outer machined rim ring!
    pairs = 5
    spread = 0.24 if style == "y_spoke" else (0.16 if style == "patrol" else 0.18)
    spoke_r_base = 0.020 if style == "y_spoke" else 0.023
    for k in range(pairs):
        a0 = 2.0 * math.pi * k / pairs
        for side_branch in (-1.0, 1.0):
            a_inner = a0 + side_branch * (spread * (0.24 if style == "y_spoke" else 0.62))
            a_mid = a0 + side_branch * (spread * 0.66)
            a_outer = a0 + side_branch * spread
            pts = [
                (hub_x + s * 0.012, math.cos(a_inner) * (r_hub * 0.84), math.sin(a_inner) * (r_hub * 0.84)),
                (lerp(hub_x, outer_spoke_x, 0.52), math.cos(a_mid) * (r_rim * 0.58), math.sin(a_mid) * (r_rim * 0.58)),
                (outer_spoke_x, math.cos(a_outer) * (r_rim * 0.96), math.sin(a_outer) * (r_rim * 0.96)),
            ]
            mb.add_tube(pts, [spoke_r_base, spoke_r_base * 0.86, spoke_r_base * 0.76], mat_rim, segments=6, smooth=True, oval_ratio=0.58)

    # 5. Cross-Drilled Steel Brake Rotor Disc (radial UVs -> gpt-image-2 brake_rotor!)
    r_rotor = r_rim * 0.78
    rotor_x = s * hw * 0.16
    rotor_thick = 0.022
    rot_segs = 24
    front_v, back_v = [], []
    center_f = mb.bm.verts.new((rotor_x + s * rotor_thick * 0.5, 0.0, 0.0))
    for i in range(rot_segs):
        a = 2.0 * math.pi * i / rot_segs
        ca, sa = math.cos(a), math.sin(a)
        front_v.append(mb.bm.verts.new((rotor_x + s * rotor_thick * 0.5, ca * r_rotor, sa * r_rotor)))
        back_v.append(mb.bm.verts.new((rotor_x - s * rotor_thick * 0.5, ca * r_rotor, sa * r_rotor)))
    idx_rot = mb.mat_idx(mat_rotor)
    for i in range(rot_segs):
        inext = (i + 1) % rot_segs
        a0 = 2.0 * math.pi * i / rot_segs
        a1 = 2.0 * math.pi * inext / rot_segs
        tri = [center_f, front_v[i], front_v[inext]] if s > 0 else [center_f, front_v[inext], front_v[i]]
        f = mb.bm.faces.new(tri)
        f.material_index = idx_rot
        f.smooth = False
        f.loops[0][mb.uv_layer].uv = (0.5, 0.5)
        if s > 0:
            f.loops[1][mb.uv_layer].uv = (0.5 + 0.48 * math.cos(a0), 0.5 + 0.48 * math.sin(a0))
            f.loops[2][mb.uv_layer].uv = (0.5 + 0.48 * math.cos(a1), 0.5 + 0.48 * math.sin(a1))
        else:
            f.loops[1][mb.uv_layer].uv = (0.5 + 0.48 * math.cos(a1), 0.5 + 0.48 * math.sin(a1))
            f.loops[2][mb.uv_layer].uv = (0.5 + 0.48 * math.cos(a0), 0.5 + 0.48 * math.sin(a0))
        q = [front_v[i], back_v[i], back_v[inext], front_v[inext]] if s > 0 else [front_v[inext], back_v[inext], back_v[i], front_v[i]]
        fe = mb.bm.faces.new(q)
        fe.material_index = mb.mat_idx(mat_rim_dark)
        fe.smooth = True

    # 6. Sculpted Multi-Piston Brake Caliper gripping outer rotor edge
    cal_dir = 1.0 if is_front else -1.0
    cal_pts = []
    for k in range(6):
        ang = math.radians(-38.0 + 76.0 * k / 5.0)
        cal_pts.append((rotor_x + s * 0.020, cal_dir * math.cos(ang) * (r_rotor * 0.84), math.sin(ang) * (r_rotor * 0.84)))
    mb.add_tube(cal_pts, 0.032 if style == "y_spoke" else 0.025, mat_caliper, segments=10, smooth=True, oval_ratio=0.78)

    return mb.finalize(
        name,
        location=location,
        subsurf_levels=0,
        weighted_normals=True,
        sharp_angle_deg=42.0,
        box_uv_scale=1.2,
        merge_dist=0.0003,
        recalc_normals=False,
    )


# ---------------------------------------------------------------------------
# Grounding, Measurement & glTF Export
# ---------------------------------------------------------------------------

def ground_scene_to_zero() -> float:
    bpy.context.view_layer.update()
    min_z = float("inf")
    deps = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        eval_obj = obj.evaluated_get(deps)
        mesh = eval_obj.to_mesh()
        for v in mesh.vertices:
            wz = (obj.matrix_world @ v.co).z
            if wz < min_z:
                min_z = wz
        eval_obj.to_mesh_clear()
    if min_z == float("inf") or abs(min_z) < 1e-6:
        return 0.0
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.location.z -= min_z
    bpy.context.view_layer.update()
    return -min_z


def measure_scene_gltf() -> dict:
    bpy.context.view_layer.update()
    min_b = [float("inf")] * 3
    max_b = [float("-inf")] * 3
    tri_count = 0
    nodes = []
    deps = bpy.context.evaluated_depsgraph_get()
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        eval_obj = obj.evaluated_get(deps)
        mesh = eval_obj.to_mesh()
        mesh.calc_loop_triangles()
        tris = len(mesh.loop_triangles)
        tri_count += tris
        for v in mesh.vertices:
            w = obj.matrix_world @ v.co
            gx, gy, gz = w.x, w.z, -w.y
            min_b[0] = min(min_b[0], gx)
            min_b[1] = min(min_b[1], gy)
            min_b[2] = min(min_b[2], gz)
            max_b[0] = max(max_b[0], gx)
            max_b[1] = max(max_b[1], gy)
            max_b[2] = max(max_b[2], gz)
        eval_obj.to_mesh_clear()
        pos = obj.matrix_world.translation
        nodes.append({
            "name": obj.name,
            "triangles": tris,
            "materials": [m.name for m in obj.data.materials if m],
            "pivotGltf": [round(pos.x, 4), round(pos.z, 4), round(-pos.y, 4)],
        })
    return {
        "dimensions": {
            "width": round(max_b[0] - min_b[0], 4),
            "height": round(max_b[1] - min_b[1], 4),
            "depth": round(max_b[2] - min_b[2], 4),
        },
        "bounds": {
            "min": [round(v, 4) for v in min_b],
            "max": [round(v, 4) for v in max_b],
        },
        "triangles": tri_count,
        "nodes": nodes,
    }


def export_vehicle_glb(out_dir: str, filename: str, wheel_radius: float) -> dict:
    os.makedirs(out_dir, exist_ok=True)
    ground_scene_to_zero()
    stats = measure_scene_gltf()
    filepath = os.path.join(out_dir, filename)

    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_image_quality=80,
        export_lights=False,
        export_cameras=False,
        export_animations=False,
    )
    size_bytes = os.path.getsize(filepath)
    print(
        f"[export] {filename:18s} | {size_bytes/1024:7.1f} KB ({size_bytes/(1024*1024):.2f} MB) | "
        f"tris={stats['triangles']:6d} | minY={stats['bounds']['min'][1]:+.4f} | "
        f"WxHxD={stats['dimensions']['width']:.2f}x{stats['dimensions']['height']:.2f}x{stats['dimensions']['depth']:.2f}m | "
        f"wheelR={wheel_radius:.3f}m",
        flush=True,
    )
    return {
        "file": filename,
        "sizeBytes": size_bytes,
        "wheelRadius": wheel_radius,
        **stats,
    }


# ---------------------------------------------------------------------------
# Vehicle 1: getaway_car.glb (~4.58m European Night Fastback Sports Coupe)
# ---------------------------------------------------------------------------

def build_getaway_car(out_dir: str, tex_dir: str = DEFAULT_TEX_DIR) -> dict:
    reset_scene()
    pm = PBRMaterials(tex_dir)

    mat_paint = pm.make(
        "Coupe_GunmetalPaint",
        color="#212B3A",
        metallic=0.84,
        roughness=0.16,
        coat=1.0,
        coat_roughness=0.032,
        normal_map="metallic_paint_normal.jpg",
        normal_strength=0.12,
        roughness_map="metallic_paint_roughness.jpg",
        roughness_range=(0.12, 0.20),
        uv_scale=(5.0, 5.0),
    )
    mat_carbon = pm.make(
        "Coupe_CarbonFiber",
        color="#1B1F26",
        metallic=0.25,
        roughness=0.22,
        coat=0.95,
        coat_roughness=0.06,
        albedo_map="carbon_weave_albedo.jpg",
        normal_map="carbon_weave_normal.jpg",
        normal_strength=0.55,
        uv_scale=(8.0, 8.0),
    )
    mat_dark_trim = pm.make("Coupe_GlossBlackTrim", color="#0C0F15", metallic=0.22, roughness=0.28, coat=0.70)
    mat_grille = pm.make(
        "Coupe_HoneycombGrille",
        color="#12151B",
        metallic=0.30,
        roughness=0.45,
        albedo_map="honeycomb_grille_albedo.jpg",
        normal_map="honeycomb_grille_normal.jpg",
        normal_strength=0.95,
    )
    mat_chrome = pm.make("Coupe_BrushedTitanium", color="#D2DCE6", metallic=0.95, roughness=0.15)
    mat_clear_lens = pm.make("Coupe_ClearLens", color="#F2F7FF", metallic=0.04, roughness=0.02, alpha=0.14, coat=1.0, coat_roughness=0.015, double_sided=True)
    mat_glass = pm.make("Coupe_TintedGlass", color="#0A1522", metallic=0.08, roughness=0.04, alpha=0.44, coat=1.0, coat_roughness=0.02, double_sided=True)
    mat_leather = pm.make(
        "Coupe_NappaLeather",
        color="#181B22",
        metallic=0.0,
        roughness=0.56,
        albedo_map="car_leather_albedo.jpg",
        normal_map="car_leather_normal.jpg",
        normal_strength=0.42,
        uv_scale=(4.0, 4.0),
    )
    mat_dash = pm.make("Coupe_CockpitDash", color="#1A1F28", metallic=0.08, roughness=0.62)
    mat_screen = pm.make("Coupe_CockpitGlow", color="#22D3EE", metallic=0.1, roughness=0.15, emission="#18A8C8", emission_strength=1.5)
    mat_plate = pm.make("Coupe_Plate", color="#E8ECF2", metallic=0.12, roughness=0.36, albedo_map="plate_getaway.jpg", double_sided=True)

    mat_hl = pm.make("Coupe_Headlights", color="#FFF9EC", metallic=0.04, roughness=0.06, emission="#FFF0CC", emission_strength=7.5)
    mat_tl = pm.make("Coupe_Taillights", color="#E61424", metallic=0.06, roughness=0.10, emission="#FF1828", emission_strength=5.2)
    mat_bl = pm.make("Coupe_Brakelights", color="#FF1C26", metallic=0.05, roughness=0.08, emission="#FF242E", emission_strength=2.2)

    mat_tire = pm.make(
        "Coupe_TireTread",
        color="#15171C",
        metallic=0.0,
        roughness=0.84,
        albedo_map="tire_tread_albedo.jpg",
        normal_map="tire_tread_normal.jpg",
        normal_strength=0.90,
        roughness_map="tire_tread_roughness.jpg",
        roughness_range=(0.74, 0.94),
    )
    mat_sidewall = pm.make("Coupe_TireSidewall", color="#14171C", metallic=0.0, roughness=0.82)
    mat_rim = pm.make("Coupe_MachinedAlloy", color="#DCE4EE", metallic=0.94, roughness=0.15, coat=0.55)
    mat_rim_dark = pm.make("Coupe_RimBarrel", color="#252C38", metallic=0.82, roughness=0.30)
    mat_rotor = pm.make(
        "Coupe_BrakeRotor",
        color="#BCC4CE",
        metallic=0.88,
        roughness=0.32,
        albedo_map="brake_rotor_albedo.jpg",
        normal_map="brake_rotor_normal.jpg",
        normal_strength=0.80,
    )
    mat_caliper = pm.make("Coupe_BremboRed", color="#D21422", metallic=0.55, roughness=0.22, coat=0.9)

    p = CarProfile(
        name="Getaway",
        y_front=-2.23,
        y_rear=2.23,
        y_wf=-1.37,
        y_wr=1.34,
        wheel_r=0.345,
        arch_r_f=0.388,
        arch_r_r=0.394,
        track_x=0.82,
        tire_w_f=0.265,
        tire_w_r=0.285,
        y_cowl=-0.68,
        y_roof_f=0.02,
        y_b_pillar=0.46,
        y_roof_r=0.84,
        y_deck=1.74,
        hw_knots=[
            (-2.23, 0.72),
            (-2.00, 0.88),
            (-1.74, 0.91),
            (-1.37, 0.92),
            (-0.68, 0.905),
            (0.28,  0.895),
            (1.34,  0.930),
            (1.88,  0.895),
            (2.06,  0.845),
            (2.23,  0.72),
        ],
        z_sill_knots=[
            (-2.23, 0.165),
            (-1.80, 0.172),
            (-0.65, 0.168),
            (0.80,  0.175),
            (1.80,  0.205),
            (2.23,  0.245),
        ],
        # Low, aggressive sculpted shark-nose hood & sleek tapering tail!
        z_belt_knots=[
            (-2.23, 0.54),
            (-1.98, 0.68),
            (-1.37, 0.815),
            (-0.68, 0.860),
            (0.35,  0.905),
            (1.34,  0.945),
            (1.88,  0.905),
            (2.23,  0.825),
        ],
        z_center_knots=[
            (-2.23, 0.56),
            (-1.98, 0.715),
            (-1.37, 0.855),
            (-0.68, 0.895),
            (0.40,  0.915),
            (1.74,  0.925),
            (2.04,  0.905),
            (2.23,  0.845),
        ],
        hw_roof_f=0.635,
        hw_roof_mid=0.640,
        hw_roof_r=0.600,
        z_roof_f=1.275,
        z_roof_mid=1.298,
        z_roof_r=1.238,
        fender_flare_f=0.036,
        fender_flare_r=0.056,
        door_cove_depth=0.028,
        hood_power_dome=0.022,
        ducktail_lift=0.032,
        windshield_bow=0.115,
        rear_glass_bow=0.095,
        nose_plan_pull=0.25,
        tail_plan_pull=0.22,
        is_coupe=True,
    )

    lower_body, info = build_sculpted_body_shell(
        p, mat_paint, mat_dark_trim, mat_grille, mat_carbon, mat_chrome, mat_clear_lens, mat_plate
    )
    gh_obj, _glass = build_greenhouse_and_glass(p, mat_paint, mat_paint, mat_dark_trim, mat_chrome, mat_glass)
    join_objects([lower_body, gh_obj], "Body")

    build_interior(p, mat_leather, mat_dash, mat_dark_trim, mat_screen)
    build_lights(p, info, mat_hl, mat_tl, mat_bl)

    for wname, wloc, is_l, is_f, tw in [
        ("Wheel_FL", (p.track_x,  p.y_wf, p.wheel_r), True,  True,  p.tire_w_f),
        ("Wheel_FR", (-p.track_x, p.y_wf, p.wheel_r), False, True,  p.tire_w_f),
        ("Wheel_RL", (p.track_x,  p.y_wr, p.wheel_r), True,  False, p.tire_w_r),
        ("Wheel_RR", (-p.track_x, p.y_wr, p.wheel_r), False, False, p.tire_w_r),
    ]:
        build_wheel(wname, wloc, p.wheel_r, tw, is_l, is_f, mat_tire, mat_sidewall, mat_rim, mat_rim_dark, mat_rotor, mat_caliper, mat_chrome, style="y_spoke")

    return export_vehicle_glb(out_dir, "getaway_car.glb", p.wheel_r)


# ---------------------------------------------------------------------------
# Vehicle 2: police_car.glb (~4.78m Catalan Mossos d'Esquadra Patrol Sedan)
# ---------------------------------------------------------------------------

def build_police_car(out_dir: str, tex_dir: str = DEFAULT_TEX_DIR) -> dict:
    reset_scene()
    pm = PBRMaterials(tex_dir)

    mat_livery = pm.make(
        "Police_MossosLivery",
        color="#FFFFFF",
        metallic=0.40,
        roughness=0.20,
        coat=1.0,
        coat_roughness=0.042,
        albedo_map="police_livery_albedo.jpg",
        normal_map="metallic_paint_normal.jpg",
        normal_strength=0.10,
        roughness_map="metallic_paint_roughness.jpg",
        roughness_range=(0.14, 0.24),
    )
    mat_navy_pillar = pm.make("Police_NavyPaint", color="#0F1D3A", metallic=0.52, roughness=0.20, coat=1.0, coat_roughness=0.042)
    mat_dark_trim = pm.make("Police_TacticalTrim", color="#10141C", metallic=0.24, roughness=0.40, coat=0.35)
    mat_grille = pm.make(
        "Police_HoneycombGrille",
        color="#12151B",
        metallic=0.28,
        roughness=0.46,
        albedo_map="honeycomb_grille_albedo.jpg",
        normal_map="honeycomb_grille_normal.jpg",
        normal_strength=0.90,
    )
    mat_chrome = pm.make("Police_BrushedAlloy", color="#D0D9E4", metallic=0.92, roughness=0.17)
    mat_clear_lens = pm.make("Police_ClearLens", color="#EEF6FF", metallic=0.04, roughness=0.02, alpha=0.14, coat=1.0, coat_roughness=0.015, double_sided=True)
    mat_glass = pm.make("Police_TintedGlass", color="#0A1624", metallic=0.08, roughness=0.04, alpha=0.45, coat=1.0, coat_roughness=0.02, double_sided=True)
    mat_leather = pm.make(
        "Police_InteriorSeat",
        color="#1B1F27",
        metallic=0.0,
        roughness=0.65,
        albedo_map="car_leather_albedo.jpg",
        normal_map="car_leather_normal.jpg",
        normal_strength=0.38,
        uv_scale=(4.0, 4.0),
    )
    mat_dash = pm.make("Police_Dash", color="#1A2029", metallic=0.05, roughness=0.66)
    mat_mdt = pm.make("Police_MDTScreen", color="#38BDF8", metallic=0.1, roughness=0.15, emission="#38BDF8", emission_strength=1.8)
    mat_plate = pm.make("Police_Plate", color="#E8ECF2", metallic=0.12, roughness=0.36, albedo_map="plate_police.jpg", double_sided=True)

    mat_hl = pm.make("Police_Headlights", color="#F2F8FF", metallic=0.04, roughness=0.06, emission="#DCEEFF", emission_strength=7.2)
    mat_tl = pm.make("Police_Taillights", color="#E01424", metallic=0.06, roughness=0.10, emission="#FF1828", emission_strength=4.8)
    mat_bl = pm.make("Police_Brakelights", color="#FF1C26", metallic=0.05, roughness=0.08, emission="#FF222C", emission_strength=2.2)
    mat_blue_led = pm.make("Police_LightbarBlue", color="#1878FF", metallic=0.08, roughness=0.06, coat=1.0, emission="#1E88FF", emission_strength=6.8)
    mat_red_led = pm.make("Police_LightbarRed", color="#FF182A", metallic=0.08, roughness=0.06, coat=1.0, emission="#FF2030", emission_strength=6.8)

    mat_tire = pm.make(
        "Police_TireTread",
        color="#15181D",
        metallic=0.0,
        roughness=0.85,
        albedo_map="tire_tread_albedo.jpg",
        normal_map="tire_tread_normal.jpg",
        normal_strength=0.85,
        roughness_map="tire_tread_roughness.jpg",
        roughness_range=(0.75, 0.94),
    )
    mat_sidewall = pm.make("Police_TireSidewall", color="#14171C", metallic=0.0, roughness=0.84)
    mat_rim = pm.make("Police_PatrolAlloy", color="#C4CDD8", metallic=0.90, roughness=0.20, coat=0.45)
    mat_rim_dark = pm.make("Police_RimBarrel", color="#222832", metallic=0.78, roughness=0.34)
    mat_rotor = pm.make(
        "Police_BrakeRotor",
        color="#B6BEC8",
        metallic=0.86,
        roughness=0.34,
        albedo_map="brake_rotor_albedo.jpg",
        normal_map="brake_rotor_normal.jpg",
        normal_strength=0.75,
    )
    mat_caliper = pm.make("Police_Caliper", color="#56606E", metallic=0.72, roughness=0.34)

    p = CarProfile(
        name="Police",
        y_front=-2.31,
        y_rear=2.33,
        y_wf=-1.40,
        y_wr=1.35,
        wheel_r=0.35,
        arch_r_f=0.395,
        arch_r_r=0.398,
        track_x=0.81,
        tire_w_f=0.245,
        tire_w_r=0.245,
        y_cowl=-0.82,
        y_roof_f=-0.20,
        y_b_pillar=0.24,
        y_roof_r=1.04,
        y_deck=1.68,
        hw_knots=[
            (-2.31, 0.74),
            (-2.08, 0.88),
            (-1.80, 0.91),
            (-1.40, 0.92),
            (-0.82, 0.915),
            (0.24,  0.915),
            (1.35,  0.925),
            (1.94,  0.895),
            (2.14,  0.845),
            (2.33,  0.72),
        ],
        z_sill_knots=[
            (-2.31, 0.205),
            (-1.85, 0.200),
            (-0.70, 0.198),
            (0.90,  0.202),
            (1.85,  0.222),
            (2.33,  0.262),
        ],
        z_belt_knots=[
            (-2.31, 0.60),
            (-2.06, 0.74),
            (-1.40, 0.855),
            (-0.82, 0.900),
            (0.24,  0.922),
            (1.35,  0.952),
            (1.98,  0.920),
            (2.33,  0.855),
        ],
        z_center_knots=[
            (-2.31, 0.62),
            (-2.06, 0.770),
            (-1.40, 0.888),
            (-0.82, 0.930),
            (0.24,  0.942),
            (1.68,  0.955),
            (2.10,  0.930),
            (2.33,  0.875),
        ],
        hw_roof_f=0.678,
        hw_roof_mid=0.688,
        hw_roof_r=0.660,
        z_roof_f=1.385,
        z_roof_mid=1.418,
        z_roof_r=1.375,
        fender_flare_f=0.024,
        fender_flare_r=0.028,
        door_cove_depth=0.018,
        hood_power_dome=0.009,
        ducktail_lift=0.010,
        windshield_bow=0.095,
        rear_glass_bow=0.075,
        nose_plan_pull=0.23,
        tail_plan_pull=0.21,
        is_police=True,
    )

    lower_body, info = build_sculpted_body_shell(
        p, mat_livery, mat_dark_trim, mat_grille, mat_dark_trim, mat_chrome, mat_clear_lens, mat_plate
    )
    gh_obj, _glass = build_greenhouse_and_glass(p, mat_livery, mat_navy_pillar, mat_dark_trim, mat_chrome, mat_glass)
    join_objects([lower_body, gh_obj], "Body")

    build_interior(p, mat_leather, mat_dash, mat_dark_trim, mat_mdt)
    build_lights(p, info, mat_hl, mat_tl, mat_bl)
    build_police_lightbar(p, mat_dark_trim, mat_chrome, mat_blue_led, mat_red_led)

    for wname, wloc, is_l, is_f, tw in [
        ("Wheel_FL", (p.track_x,  p.y_wf, p.wheel_r), True,  True,  p.tire_w_f),
        ("Wheel_FR", (-p.track_x, p.y_wf, p.wheel_r), False, True,  p.tire_w_f),
        ("Wheel_RL", (p.track_x,  p.y_wr, p.wheel_r), True,  False, p.tire_w_r),
        ("Wheel_RR", (-p.track_x, p.y_wr, p.wheel_r), False, False, p.tire_w_r),
    ]:
        build_wheel(wname, wloc, p.wheel_r, tw, is_l, is_f, mat_tire, mat_sidewall, mat_rim, mat_rim_dark, mat_rotor, mat_caliper, mat_chrome, style="patrol")

    return export_vehicle_glb(out_dir, "police_car.glb", p.wheel_r)


# ---------------------------------------------------------------------------
# Vehicle 3: traffic_car.glb (~4.35m European Compact Sportback, Tintable)
# ---------------------------------------------------------------------------

def build_traffic_car(out_dir: str, tex_dir: str = DEFAULT_TEX_DIR) -> dict:
    reset_scene()
    pm = PBRMaterials(tex_dir)

    # Pure tintable neutral pearl-silver metallic (NO dark albedo override so @driving-sim tints cleanly!)
    mat_paint = pm.make(
        "Traffic_BodyPaint",
        color="#D6DFE8",
        metallic=0.64,
        roughness=0.19,
        coat=1.0,
        coat_roughness=0.048,
        normal_map="metallic_paint_normal.jpg",
        normal_strength=0.10,
        roughness_map="metallic_paint_roughness.jpg",
        roughness_range=(0.14, 0.23),
        uv_scale=(4.5, 4.5),
    )
    mat_dark_trim = pm.make("Traffic_DarkTrim", color="#141820", metallic=0.16, roughness=0.44)
    mat_grille = pm.make(
        "Traffic_HoneycombGrille",
        color="#14171D",
        metallic=0.25,
        roughness=0.48,
        albedo_map="honeycomb_grille_albedo.jpg",
        normal_map="honeycomb_grille_normal.jpg",
        normal_strength=0.88,
    )
    mat_chrome = pm.make("Traffic_ChromeTrim", color="#D2DCE6", metallic=0.92, roughness=0.17)
    mat_clear_lens = pm.make("Traffic_ClearLens", color="#F0F6FE", metallic=0.04, roughness=0.02, alpha=0.14, coat=1.0, coat_roughness=0.015, double_sided=True)
    mat_glass = pm.make("Traffic_TintedGlass", color="#0D1A28", metallic=0.08, roughness=0.04, alpha=0.44, coat=1.0, coat_roughness=0.02, double_sided=True)
    mat_leather = pm.make(
        "Traffic_InteriorCloth",
        color="#1E232C",
        metallic=0.0,
        roughness=0.72,
        albedo_map="car_leather_albedo.jpg",
        normal_map="car_leather_normal.jpg",
        normal_strength=0.35,
        uv_scale=(4.0, 4.0),
    )
    mat_dash = pm.make("Traffic_Dash", color="#1B202A", metallic=0.05, roughness=0.68)
    mat_screen = pm.make("Traffic_CockpitGlow", color="#F59E0B", metallic=0.1, roughness=0.15, emission="#D97706", emission_strength=1.2)
    mat_plate = pm.make("Traffic_Plate", color="#E8ECF2", metallic=0.12, roughness=0.36, albedo_map="plate_traffic.jpg", double_sided=True)

    mat_hl = pm.make("Traffic_Headlights", color="#FFF6E0", metallic=0.04, roughness=0.06, emission="#FFE8B2", emission_strength=6.5)
    mat_tl = pm.make("Traffic_Taillights", color="#DC1624", metallic=0.06, roughness=0.10, emission="#FF1C2C", emission_strength=4.5)
    mat_bl = pm.make("Traffic_Brakelights", color="#FF1C26", metallic=0.05, roughness=0.08, emission="#FF222C", emission_strength=2.0)

    mat_tire = pm.make(
        "Traffic_TireTread",
        color="#16181D",
        metallic=0.0,
        roughness=0.86,
        albedo_map="tire_tread_albedo.jpg",
        normal_map="tire_tread_normal.jpg",
        normal_strength=0.85,
        roughness_map="tire_tread_roughness.jpg",
        roughness_range=(0.76, 0.94),
    )
    mat_sidewall = pm.make("Traffic_TireSidewall", color="#15181D", metallic=0.0, roughness=0.84)
    mat_rim = pm.make("Traffic_SilverAlloy", color="#D2DAE4", metallic=0.92, roughness=0.18, coat=0.45)
    mat_rim_dark = pm.make("Traffic_RimBarrel", color="#262C36", metallic=0.78, roughness=0.34)
    mat_rotor = pm.make(
        "Traffic_BrakeRotor",
        color="#B2BAC4",
        metallic=0.85,
        roughness=0.36,
        albedo_map="brake_rotor_albedo.jpg",
        normal_map="brake_rotor_normal.jpg",
        normal_strength=0.70,
    )
    mat_caliper = pm.make("Traffic_Caliper", color="#647080", metallic=0.70, roughness=0.36)

    # Sleek modern European 5-door Sportback / Compact Hatchback (SEAT León / Audi A3 Sportback proportions!)
    p = CarProfile(
        name="Traffic",
        y_front=-2.14,
        y_rear=2.14,
        y_wf=-1.32,
        y_wr=1.28,
        wheel_r=0.33,
        arch_r_f=0.372,
        arch_r_r=0.376,
        track_x=0.79,
        tire_w_f=0.225,
        tire_w_r=0.225,
        y_cowl=-0.78,
        y_roof_f=-0.16,
        y_b_pillar=0.28,
        y_roof_r=1.08,
        y_deck=1.80,
        hw_knots=[
            (-2.14, 0.70),
            (-1.92, 0.85),
            (-1.64, 0.88),
            (-1.32, 0.89),
            (-0.78, 0.885),
            (0.28,  0.885),
            (1.28,  0.895),
            (1.80,  0.865),
            (1.98,  0.815),
            (2.14,  0.68),
        ],
        z_sill_knots=[
            (-2.14, 0.195),
            (-1.68, 0.192),
            (-0.60, 0.190),
            (0.85,  0.196),
            (1.72,  0.220),
            (2.14,  0.258),
        ],
        z_belt_knots=[
            (-2.14, 0.56),
            (-1.90, 0.71),
            (-1.32, 0.830),
            (-0.78, 0.885),
            (0.28,  0.915),
            (1.28,  0.950),
            (1.80,  0.920),
            (2.14,  0.840),
        ],
        z_center_knots=[
            (-2.14, 0.58),
            (-1.90, 0.740),
            (-1.32, 0.860),
            (-0.78, 0.912),
            (0.28,  0.935),
            (1.80,  0.942),
            (1.98,  0.915),
            (2.14,  0.858),
        ],
        hw_roof_f=0.655,
        hw_roof_mid=0.665,
        hw_roof_r=0.620,
        z_roof_f=1.365,
        z_roof_mid=1.395,
        z_roof_r=1.325,
        fender_flare_f=0.022,
        fender_flare_r=0.028,
        door_cove_depth=0.018,
        hood_power_dome=0.008,
        ducktail_lift=0.008,
        windshield_bow=0.098,
        rear_glass_bow=0.088,
        nose_plan_pull=0.22,
        tail_plan_pull=0.20,
        is_hatchback=True,
    )

    lower_body, info = build_sculpted_body_shell(
        p, mat_paint, mat_dark_trim, mat_grille, mat_dark_trim, mat_chrome, mat_clear_lens, mat_plate
    )
    gh_obj, _glass = build_greenhouse_and_glass(p, mat_paint, mat_paint, mat_dark_trim, mat_chrome, mat_glass)
    join_objects([lower_body, gh_obj], "Body")

    build_interior(p, mat_leather, mat_dash, mat_dark_trim, mat_screen)
    build_lights(p, info, mat_hl, mat_tl, mat_bl)

    for wname, wloc, is_l, is_f, tw in [
        ("Wheel_FL", (p.track_x,  p.y_wf, p.wheel_r), True,  True,  p.tire_w_f),
        ("Wheel_FR", (-p.track_x, p.y_wf, p.wheel_r), False, True,  p.tire_w_f),
        ("Wheel_RL", (p.track_x,  p.y_wr, p.wheel_r), True,  False, p.tire_w_r),
        ("Wheel_RR", (-p.track_x, p.y_wr, p.wheel_r), False, False, p.tire_w_r),
    ]:
        build_wheel(wname, wloc, p.wheel_r, tw, is_l, is_f, mat_tire, mat_sidewall, mat_rim, mat_rim_dark, mat_rotor, mat_caliper, mat_chrome, style="compact")

    return export_vehicle_glb(out_dir, "traffic_car.glb", p.wheel_r)


# ---------------------------------------------------------------------------
# Night-Lit Showroom QA Studio Renderer (3x3 Full + Close-Up Wheel/Headlight!)
# ---------------------------------------------------------------------------

def _setup_night_showroom(scene: bpy.types.Scene, res_x: int, res_y: int) -> None:
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = res_x
    scene.render.resolution_y = res_y
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = 0.20

    world = bpy.data.worlds.new("NightShowroomWorld")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    nt = world.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    bg.inputs["Strength"].default_value = 1.05
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.03, 0.04, 0.07, 1.0)
    e1 = ramp.color_ramp.elements.new(0.18)
    e1.color = (0.28, 0.18, 0.10, 1.0)
    ramp.color_ramp.elements[1].position = 0.65
    ramp.color_ramp.elements[1].color = (0.025, 0.05, 0.12, 1.0)
    nt.links.new(tc.outputs["Generated"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    nt.links.new(bg.outputs["Background"], out.inputs["Surface"])

    # Glossy dark wet-asphalt showroom turntable
    bpy.ops.mesh.primitive_cylinder_add(vertices=64, radius=18.0, depth=0.04, location=(0.0, 0.0, -0.02))
    floor = bpy.context.active_object
    fmat = bpy.data.materials.new("WetAsphaltStudioFloor")
    if fmat.node_tree is None:
        fmat.use_nodes = True
    bsdf = fmat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.018, 0.022, 0.032, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.24
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.72
        bsdf.inputs["Coat Roughness"].default_value = 0.12
    floor.data.materials.append(fmat)

    strip_data = bpy.data.lights.new("OverheadStrip", type="AREA")
    strip_data.shape = "RECTANGLE"
    strip_data.size = 1.6
    strip_data.size_y = 6.2
    strip_data.energy = 300.0
    strip_data.color = (0.94, 0.96, 1.0)
    strip_obj = bpy.data.objects.new("OverheadStrip", strip_data)
    scene.collection.objects.link(strip_obj)
    strip_obj.location = (0.0, 0.0, 4.3)

    key_data = bpy.data.lights.new("SodiumKey", type="AREA")
    key_data.shape = "RECTANGLE"
    key_data.size = 2.8
    key_data.size_y = 1.8
    key_data.energy = 240.0
    key_data.color = (1.0, 0.80, 0.56)
    key_obj = bpy.data.objects.new("SodiumKey", key_data)
    scene.collection.objects.link(key_obj)
    key_obj.location = (4.8, -4.6, 2.5)
    key_obj.rotation_euler = (Vector((0, 0, 0.7)) - key_obj.location).to_track_quat("-Z", "Y").to_euler()

    rim_data = bpy.data.lights.new("MoonRim", type="AREA")
    rim_data.shape = "RECTANGLE"
    rim_data.size = 3.2
    rim_data.size_y = 2.0
    rim_data.energy = 210.0
    rim_data.color = (0.55, 0.76, 1.0)
    rim_obj = bpy.data.objects.new("MoonRim", rim_data)
    scene.collection.objects.link(rim_obj)
    rim_obj.location = (-4.8, 4.4, 2.6)
    rim_obj.rotation_euler = (Vector((0, 0, 0.7)) - rim_obj.location).to_track_quat("-Z", "Y").to_euler()

    fill_data = bpy.data.lights.new("SideFill", type="AREA")
    fill_data.shape = "RECTANGLE"
    fill_data.size = 4.5
    fill_data.size_y = 1.4
    fill_data.energy = 90.0
    fill_data.color = (0.82, 0.88, 1.0)
    fill_obj = bpy.data.objects.new("SideFill", fill_data)
    scene.collection.objects.link(fill_obj)
    fill_obj.location = (5.4, 0.5, 1.3)
    fill_obj.rotation_euler = (Vector((0, 0, 0.55)) - fill_obj.location).to_track_quat("-Z", "Y").to_euler()


def render_qa_sheet(glb_dir: str, out_png: str) -> None:
    tile_w, tile_h = 640, 420
    tmp_dir = os.path.join(os.path.dirname(out_png), "_vehicle_qa_tiles")
    os.makedirs(tmp_dir, exist_ok=True)

    # Full-frame showroom 3/4 Front, 3/4 Rear, and Hero Close-Up (Headlight + Grille + Wheel/Brake)
    views = [
        ("front34", (4.35, -5.05, 1.55),  (0.0, -0.05, 0.66), 50.0),
        ("rear34",  (-4.25, 5.05, 1.58),  (0.0, 0.05,  0.66), 50.0),
        ("closeup", (2.85, -3.15, 0.78),  (0.28, -1.42, 0.44), 48.0),
    ]
    cars = ["getaway_car.glb", "police_car.glb", "traffic_car.glb"]
    tile_paths: List[str] = []

    for car_file in cars:
        glb_path = os.path.join(glb_dir, car_file)
        for suffix, cpos, ctgt, lens in views:
            reset_scene()
            scene = bpy.context.scene
            _setup_night_showroom(scene, tile_w, tile_h)
            bpy.ops.import_scene.gltf(filepath=glb_path)

            cam_data = bpy.data.cameras.new("QACam")
            cam_data.lens = lens
            cam_obj = bpy.data.objects.new("QACam", cam_data)
            scene.collection.objects.link(cam_obj)
            scene.camera = cam_obj
            cam_obj.location = Vector(cpos)
            cam_obj.rotation_euler = (Vector(ctgt) - cam_obj.location).to_track_quat("-Z", "Y").to_euler()

            out_tile = os.path.join(tmp_dir, f"{car_file.replace('.glb', '')}_{suffix}.png")
            scene.render.filepath = out_tile
            bpy.ops.render.render(write_still=True)
            tile_paths.append(out_tile)

    reset_scene()
    cols, rows = 3, 3
    sw, sh = cols * tile_w, rows * tile_h
    sheet = bpy.data.images.new("VehicleQASheet", width=sw, height=sh, alpha=False)
    buf = [0.02, 0.025, 0.035, 1.0] * (sw * sh)
    for idx, pth in enumerate(tile_paths):
        img = bpy.data.images.load(pth)
        px = list(img.pixels)
        col = idx % cols
        row = rows - 1 - (idx // cols)
        x0 = col * tile_w
        y0 = row * tile_h
        for y in range(tile_h):
            s0 = y * tile_w * 4
            d0 = ((y0 + y) * sw + x0) * 4
            buf[d0 : d0 + tile_w * 4] = px[s0 : s0 + tile_w * 4]
        bpy.data.images.remove(img)
    sheet.pixels.foreach_set(buf)
    sheet.filepath_raw = out_png
    sheet.file_format = "PNG"
    sheet.save()
    print(f"[qa] Saved 3x3 showroom QA sheet to {out_png} ({sw}x{sh})", flush=True)


def main() -> None:
    argv = sys.argv
    args = argv[argv.index("--") + 1 :] if "--" in argv else []
    qa_out = None
    tex_dir = DEFAULT_TEX_DIR
    out_dir = MODELS_DIR
    i = 0
    while i < len(args):
        if args[i] == "--qa-out" and i + 1 < len(args):
            qa_out = args[i + 1]
            i += 2
        elif args[i] == "--tex-dir" and i + 1 < len(args):
            tex_dir = args[i + 1]
            i += 2
        elif args[i] == "--out-dir" and i + 1 < len(args):
            out_dir = args[i + 1]
            i += 2
        else:
            i += 1

    results = [
        build_getaway_car(out_dir, tex_dir),
        build_police_car(out_dir, tex_dir),
        build_traffic_car(out_dir, tex_dir),
    ]
    print("\n=== VEHICLE BUILD SUMMARY ===", flush=True)
    print(json.dumps(results, indent=2), flush=True)

    if qa_out:
        render_qa_sheet(out_dir, qa_out)


if __name__ == "__main__":
    main()
