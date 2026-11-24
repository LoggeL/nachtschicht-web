"""Photorealistic, anatomically sculpted, skeletal-rigged & animated Blender 5.2 generator for:
- public/assets/models/character_guard.glb     (1.80m Catalan Securion/Mossos night guard)
- public/assets/models/character_civilian.glb  (1.75m Mediterranean evening promenade pedestrian)

Conventions:
- Blender Z-up, character facing -Y -> glTF Y-up (+Y), facing +Z, strictly grounded at y = 0.0000
- Real gpt-image-2 photorealistic PBR textures (albedo + derived Sobel normal + roughness) packed in GLB
- Full humanoid Armature with clean analytical Hermite skin weights (<=4 weights/vert, sum=1.0)
- Baked looping glTF NLA animation clips:
    Guard:    Idle, PatrolWalk, SuspiciousLook, FlashlightSweep, RadioCall, Sprint
    Civilian: Idle, Walk, Startled

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_guard.py
  /Applications/Blender.app/Contents/MacOS/Blender --background --python tools/blender/build_guard.py -- --qa-out /path/to/qa.png
"""

from __future__ import annotations

import argparse
import json
import math
import os
import struct
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
MODELS_DIR = PROJECT_ROOT / "public" / "assets" / "models"
DEFAULT_TEX_DIR = Path(
    "/Users/logge/.gemini/antigravity-cli/brain/47b04cbf-08f4-45fd-8389-5c0af5103732/scratch/textures"
)


# ---------------------------------------------------------------------------
# Math & Utility Helpers
# ---------------------------------------------------------------------------

def clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return lo if x < lo else (hi if x > hi else x)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if abs(edge1 - edge0) < 1e-8:
        return 1.0 if x >= edge1 else 0.0
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def gauss(x: float, mu: float, sigma: float) -> float:
    d = (x - mu) / max(sigma, 1e-6)
    return math.exp(-0.5 * d * d)


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
# Photorealistic PBR Material Builder (Packs Real gpt-image-2 Textures)
# ---------------------------------------------------------------------------

def _load_packed_image(filepath: Path, colorspace: str = "sRGB") -> Optional[bpy.types.Image]:
    if not filepath.exists():
        return None
    # Reuse if already loaded from same path
    abs_str = str(filepath.resolve())
    for img in bpy.data.images:
        if img.filepath == abs_str:
            return img
    img = bpy.data.images.load(abs_str, check_existing=True)
    img.colorspace_settings.name = colorspace
    try:
        img.pack()
    except Exception:
        pass
    return img


def make_pbr_material(
    name: str,
    tex_dir: Path,
    albedo_file: Optional[str] = None,
    normal_file: Optional[str] = None,
    roughness_file: Optional[str] = None,
    fallback_color: str = "#808080",
    tint: Optional[Tuple[float, float, float]] = None,
    metallic: float = 0.0,
    roughness: float = 0.55,
    normal_strength: float = 0.55,
    coat: float = 0.0,
    coat_roughness: float = 0.12,
    specular_ior: float = 0.5,
    emission_color: Optional[str] = None,
    emission_strength: float = 0.0,
    alpha: float = 1.0,
    double_sided: bool = False,
) -> bpy.types.Material:
    """Create a glTF-ready Principled BSDF PBR material with packed image textures."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]

    mat = bpy.data.materials.new(name=name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = hex_rgba(fallback_color, 1.0)
    bsdf.inputs["Metallic"].default_value = float(metallic)
    bsdf.inputs["Roughness"].default_value = float(roughness)
    bsdf.inputs["Alpha"].default_value = float(alpha)
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = float(specular_ior)
    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = float(coat)
        bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)
    if emission_color and emission_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(emission_color, 1.0)
        bsdf.inputs["Emission Strength"].default_value = float(emission_strength)

    # Albedo texture
    if albedo_file:
        img = _load_packed_image(tex_dir / albedo_file, "sRGB")
        if img is not None:
            tex = nt.nodes.new("ShaderNodeTexImage")
            tex.image = img
            if tint is not None:
                mix = nt.nodes.new("ShaderNodeMix")
                mix.data_type = "RGBA"
                mix.blend_type = "MULTIPLY"
                mix.inputs["Factor"].default_value = 1.0
                mix.inputs[7].default_value = (tint[0], tint[1], tint[2], 1.0)
                nt.links.new(tex.outputs["Color"], mix.inputs[6])
                nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
            else:
                nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    # Roughness texture
    if roughness_file:
        r_img = _load_packed_image(tex_dir / roughness_file, "Non-Color")
        if r_img is not None:
            r_tex = nt.nodes.new("ShaderNodeTexImage")
            r_tex.image = r_img
            nt.links.new(r_tex.outputs["Color"], bsdf.inputs["Roughness"])

    # Tangent-space Normal Map
    if normal_file and normal_strength > 0.0:
        n_img = _load_packed_image(tex_dir / normal_file, "Non-Color")
        if n_img is not None:
            n_tex = nt.nodes.new("ShaderNodeTexImage")
            n_tex.image = n_img
            n_map = nt.nodes.new("ShaderNodeNormalMap")
            n_map.space = "TANGENT"
            n_map.inputs["Strength"].default_value = float(normal_strength)
            nt.links.new(n_tex.outputs["Color"], n_map.inputs["Color"])
            nt.links.new(n_map.outputs["Normal"], bsdf.inputs["Normal"])

    if alpha < 0.999:
        mat.blend_method = "BLEND"
        mat.use_backface_culling = False
    else:
        mat.blend_method = "OPAQUE"
        mat.use_backface_culling = not double_sided

    return mat


# ---------------------------------------------------------------------------
# Sculpted Mesh Builder with Per-Vertex Bone Weights & Explicit UVs
# ---------------------------------------------------------------------------

WeightSpec = Dict[str, float]
WeightFn = Callable[[Vector], WeightSpec]


def normalize_weights(w: WeightSpec) -> WeightSpec:
    # Keep top 4 bones (glTF standard), drop tiny weights, normalize sum to 1.0
    items = [(k, float(v)) for k, v in w.items() if v > 1e-4]
    if not items:
        return {"Hips": 1.0}
    items.sort(key=lambda kv: kv[1], reverse=True)
    items = items[:4]
    total = sum(v for _, v in items)
    return {k: v / total for k, v in items}


def blend_2bones(t: float, b0: str, b1: str) -> WeightSpec:
    t = clamp(t, 0.0, 1.0)
    return normalize_weights({b0: 1.0 - t, b1: t})


class CharacterMeshBuilder:
    """High-craft procedural sculpted mesh builder with explicit UVs and analytical bone weights."""

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.uv_layer = self.bm.loops.layers.uv.verify()
        self.materials: List[bpy.types.Material] = []
        self._mat_index: Dict[str, int] = {}
        # Map BMVert -> normalized bone weight dict
        self.vert_weights: Dict[bmesh.types.BMVert, WeightSpec] = {}

    def mat_idx(self, mat: bpy.types.Material) -> int:
        if mat.name not in self._mat_index:
            self._mat_index[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self._mat_index[mat.name]

    def _assign_weights(self, verts: Iterable[bmesh.types.BMVert], w_fn: WeightFn | WeightSpec) -> None:
        if callable(w_fn):
            for v in verts:
                self.vert_weights[v] = normalize_weights(w_fn(v.co))
        else:
            norm = normalize_weights(w_fn)
            for v in verts:
                self.vert_weights[v] = norm

    def add_uv_loft(
        self,
        rings: Sequence[Sequence[Tuple[float, float, float]]],
        uv_rings: Sequence[Sequence[Tuple[float, float]]],
        mat: bpy.types.Material,
        w_fn: WeightFn | WeightSpec,
        closed_u: bool = True,
        cap_start: bool = False,
        cap_end: bool = False,
        smooth: bool = True,
        flip_normals: bool = False,
    ) -> List[bmesh.types.BMVert]:
        """Skin a clean quad loft with explicit UV coordinates and per-vertex skin weights."""
        if len(rings) < 2:
            return []
        n_v = len(rings)
        n_u = len(rings[0])
        v_grid: List[List[bmesh.types.BMVert]] = []
        all_verts: List[bmesh.types.BMVert] = []

        for r_idx in range(n_v):
            row = []
            for u_idx in range(n_u):
                v = self.bm.verts.new(rings[r_idx][u_idx])
                row.append(v)
                all_verts.append(v)
            v_grid.append(row)

        m_idx = self.mat_idx(mat)
        u_count = n_u if closed_u else (n_u - 1)

        for r_idx in range(n_v - 1):
            r0 = v_grid[r_idx]
            r1 = v_grid[r_idx + 1]
            uv0 = uv_rings[r_idx]
            uv1 = uv_rings[r_idx + 1]
            for j in range(u_count):
                jn = (j + 1) % n_u
                # Handle wrap-around UV seam cleanly!
                u0_j, v0_j = uv0[j]
                u0_n, v0_n = uv0[jn]
                u1_j, v1_j = uv1[j]
                u1_n, v1_n = uv1[jn]
                if closed_u and j == n_u - 1:
                    # Seam quad: wrap u from end to next period
                    if u0_n < u0_j:
                        span = max(abs(uv0[1][0] - uv0[0][0]), 1e-4)
                        u0_n = u0_j + span
                        u1_n = u1_j + span
                quad = [r0[j], r0[jn], r1[jn], r1[j]]
                quad_uvs = [(u0_j, v0_j), (u0_n, v0_n), (u1_n, v1_n), (u1_j, v1_j)]
                if flip_normals:
                    quad = list(reversed(quad))
                    quad_uvs = list(reversed(quad_uvs))
                if len(set(quad)) < 4:
                    continue
                try:
                    f = self.bm.faces.new(quad)
                    f.material_index = m_idx
                    f.smooth = smooth
                    for loop, uv in zip(f.loops, quad_uvs):
                        loop[self.uv_layer].uv = uv
                except ValueError:
                    pass

        if cap_start and closed_u and n_u >= 3:
            pts = list(reversed(v_grid[0])) if not flip_normals else list(v_grid[0])
            cx = sum(v.co.x for v in v_grid[0]) / n_u
            cy = sum(v.co.y for v in v_grid[0]) / n_u
            cz = sum(v.co.z for v in v_grid[0]) / n_u
            cv = self.bm.verts.new((cx, cy, cz))
            all_verts.append(cv)
            c_u = sum(u for u, _ in uv_rings[0]) / n_u
            c_v = sum(v for _, v in uv_rings[0]) / n_u
            for j in range(n_u):
                jn = (j + 1) % n_u
                tri = [cv, pts[j], pts[jn]]
                if len(set(tri)) == 3:
                    try:
                        f = self.bm.faces.new(tri)
                        f.material_index = m_idx
                        f.smooth = False
                        for loop in f.loops:
                            loop[self.uv_layer].uv = (c_u, c_v)
                    except ValueError:
                        pass

        if cap_end and closed_u and n_u >= 3:
            pts = list(v_grid[-1]) if not flip_normals else list(reversed(v_grid[-1]))
            cx = sum(v.co.x for v in v_grid[-1]) / n_u
            cy = sum(v.co.y for v in v_grid[-1]) / n_u
            cz = sum(v.co.z for v in v_grid[-1]) / n_u
            cv = self.bm.verts.new((cx, cy, cz))
            all_verts.append(cv)
            c_u = sum(u for u, _ in uv_rings[-1]) / n_u
            c_v = sum(v for _, v in uv_rings[-1]) / n_u
            for j in range(n_u):
                jn = (j + 1) % n_u
                tri = [cv, pts[j], pts[jn]]
                if len(set(tri)) == 3:
                    try:
                        f = self.bm.faces.new(tri)
                        f.material_index = m_idx
                        f.smooth = False
                        for loop in f.loops:
                            loop[self.uv_layer].uv = (c_u, c_v)
                    except ValueError:
                        pass

        self._assign_weights(all_verts, w_fn)
        return all_verts

    def _apply_box_uvs(self, faces: Iterable[bmesh.types.BMFace], uv_scale: float = 3.0) -> None:
        for f in faces:
            f.normal_update()
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for loop in f.loops:
                co = loop.vert.co
                if az >= ax and az >= ay:
                    loop[self.uv_layer].uv = (co.x * uv_scale, co.y * uv_scale)
                elif ax >= ay and ax >= az:
                    loop[self.uv_layer].uv = (co.y * uv_scale, co.z * uv_scale)
                else:
                    loop[self.uv_layer].uv = (co.x * uv_scale, co.z * uv_scale)

    def add_box(
        self,
        center: Sequence[float],
        size: Sequence[float],
        mat: bpy.types.Material,
        w_fn: WeightFn | WeightSpec,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        bevel: float = 0.0,
        bevel_segments: int = 1,
        smooth: bool = True,
        taper_top: Tuple[float, float] = (1.0, 1.0),
        taper_bottom: Tuple[float, float] = (1.0, 1.0),
        uv_scale: float = 3.5,
    ) -> List[bmesh.types.BMVert]:
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
                self.bm, geom=edges, offset=b_amt, offset_type="OFFSET",
                segments=bevel_segments, profile=0.5, affect="EDGES", clamp_overlap=True,
            )
            all_verts = list({v for f in faces if f.is_valid for v in f.verts} | set(res.get("verts", [])))
            all_faces = [f for f in faces if f.is_valid] + list(res.get("faces", []))
        else:
            all_verts = verts
            all_faces = faces

        mat4 = Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=mat4, verts=all_verts)
        m_idx = self.mat_idx(mat)
        for f in all_faces:
            f.material_index = m_idx
            f.smooth = smooth
        self._apply_box_uvs(all_faces, uv_scale)
        self._assign_weights(all_verts, w_fn)
        return all_verts

    def add_cylinder(
        self,
        center: Sequence[float],
        r_bot: float,
        r_top: float,
        height: float,
        mat: bpy.types.Material,
        w_fn: WeightFn | WeightSpec,
        segments: int = 16,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        cap: bool = True,
        uv_scale: float = 4.0,
    ) -> List[bmesh.types.BMVert]:
        existing_f = set(self.bm.faces)
        existing_v = set(self.bm.verts)
        mat4 = Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
        bmesh.ops.create_cone(
            self.bm, cap_ends=cap, cap_tris=False, segments=segments,
            radius1=float(r_bot), radius2=float(r_top), depth=float(height), matrix=mat4,
        )
        new_faces = [f for f in self.bm.faces if f not in existing_f]
        new_verts = [v for v in self.bm.verts if v not in existing_v]
        m_idx = self.mat_idx(mat)
        for f in new_faces:
            f.material_index = m_idx
            f.smooth = False if len(f.verts) > 4 else smooth
        self._apply_box_uvs(new_faces, uv_scale)
        self._assign_weights(new_verts, w_fn)
        return new_verts

    def add_sphere(
        self,
        center: Sequence[float],
        radius: float,
        mat: bpy.types.Material,
        w_fn: WeightFn | WeightSpec,
        scale: Sequence[float] = (1.0, 1.0, 1.0),
        segments: int = 16,
        rings: int = 12,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        front_uv: bool = False,
        uv_scale: float = 3.5,
    ) -> List[bmesh.types.BMVert]:
        existing_f = set(self.bm.faces)
        existing_v = set(self.bm.verts)
        mat4 = (
            Matrix.Translation(Vector(center))
            @ Euler(rot, "XYZ").to_matrix().to_4x4()
            @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        )
        bmesh.ops.create_uvsphere(
            self.bm, u_segments=segments, v_segments=rings, radius=float(radius), matrix=mat4
        )
        new_faces = [f for f in self.bm.faces if f not in existing_f]
        new_verts = [v for v in self.bm.verts if v not in existing_v]
        m_idx = self.mat_idx(mat)
        cx, cy, cz = center
        r_inv = 1.0 / max(radius, 1e-5)
        for f in new_faces:
            f.material_index = m_idx
            f.smooth = smooth
            if front_uv:
                for loop in f.loops:
                    d = loop.vert.co - Vector((cx, cy, cz))
                    # Project directly onto front (-Y) for eyeball iris mapping
                    u = 0.5 + (d.x * r_inv) * 0.48
                    v = 0.5 + (d.z * r_inv) * 0.48
                    if d.y > 0.0:
                        u, v = 0.05, 0.05  # back of eyeball -> sclera
                    loop[self.uv_layer].uv = (clamp(u, 0.0, 1.0), clamp(v, 0.0, 1.0))
        if not front_uv:
            self._apply_box_uvs(new_faces, uv_scale)
        self._assign_weights(new_verts, w_fn)
        return new_verts

    def add_tube(
        self,
        points: Sequence[Sequence[float]],
        radii: float | Sequence[float],
        mat: bpy.types.Material,
        w_fn: WeightFn | WeightSpec,
        segments: int = 10,
        smooth: bool = True,
        cap: bool = True,
        uv_scale: float = 5.0,
    ) -> List[bmesh.types.BMVert]:
        pts = [Vector(p) for p in points]
        if len(pts) < 2:
            return []
        rad_list = [float(radii)] * len(pts) if isinstance(radii, (int, float)) else [float(r) for r in radii]
        rings = []
        uv_rings = []
        prev_n: Optional[Vector] = None
        arc_len = 0.0
        for i, p in enumerate(pts):
            if i > 0:
                arc_len += (pts[i] - pts[i - 1]).length
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
            ring = []
            uv_r = []
            for s in range(segments):
                ang = (2.0 * math.pi * s) / segments
                offset = (nrm * math.cos(ang) + binrm * math.sin(ang)) * r
                ring.append(tuple(p + offset))
                uv_r.append((s / segments, arc_len * uv_scale))
            rings.append(ring)
            uv_rings.append(uv_r)
        return self.add_uv_loft(rings, uv_rings, mat, w_fn, closed_u=True, cap_start=cap, cap_end=cap, smooth=smooth)

    def finalize_skinned(self, name: str, arm_obj: bpy.types.Object) -> bpy.types.Object:
        """Convert bmesh to Blender Mesh, assign all normalized VertexGroups, bind to Armature."""
        self.bm.verts.ensure_lookup_table()
        self.bm.faces.ensure_lookup_table()
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        self.bm.normal_update()

        # Snapshot vertex weights by index before to_mesh
        weights_by_idx: List[WeightSpec] = []
        for idx, v in enumerate(self.bm.verts):
            weights_by_idx.append(self.vert_weights.get(v, {"Hips": 1.0}))

        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()

        for m in self.materials:
            mesh.materials.append(m)
        mesh.update()

        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        obj.parent = arm_obj
        obj.matrix_parent_inverse = Matrix.Identity(4)

        # Create vertex groups for all bones in armature
        vg_map: Dict[str, bpy.types.VertexGroup] = {}
        for bone in arm_obj.data.bones:
            vg_map[bone.name] = obj.vertex_groups.new(name=bone.name)

        # Assign exact normalized weights
        for v_idx, w_dict in enumerate(weights_by_idx):
            for b_name, w_val in w_dict.items():
                if b_name in vg_map and w_val > 1e-4:
                    vg_map[b_name].add([v_idx], float(w_val), "REPLACE")

        mod = obj.modifiers.new(name="Armature", type="ARMATURE")
        mod.object = arm_obj
        mod.use_vertex_groups = True
        return obj


# ---------------------------------------------------------------------------
# Anatomical Sculpted Human Parts (Head, Ears, Eyes, Hair, Hands, Limbs, Feet)
# ---------------------------------------------------------------------------

def add_sculpted_human_head(
    mb: CharacterMeshBuilder,
    neck_base_z: float,
    head_height: float,
    skin_mat: bpy.types.Material,
    eye_mat: bpy.types.Material,
    hair_mat: bpy.types.Material,
    jaw_strength: float = 1.0,
    cheek_width: float = 1.0,
    nose_prominence: float = 1.0,
    neck_bone: str = "Neck",
    head_bone: str = "Head",
    chest_bone: str = "Chest",
) -> dict:
    """Build an anatomically sculpted adult human head + neck + ears + deeply recessed almond-lidded eyes.
    Uses true Loomis adult facial proportions: Chin=0.24, Mouth=0.382, NoseBase=0.462, Eyes=0.590, Brows=0.648."""
    n_u = 36
    n_v = 32
    z0 = neck_base_z
    z_span = head_height

    def head_weights(co: Vector) -> WeightSpec:
        t_neck = smoothstep(z0 - 0.01, z0 + 0.055, co.z)
        t_head = smoothstep(z0 + 0.075, z0 + 0.135, co.z)
        return {chest_bone: 1.0 - t_neck, neck_bone: t_neck * (1.0 - t_head), head_bone: t_head}

    rings: List[List[Tuple[float, float, float]]] = []
    uv_rings: List[List[Tuple[float, float]]] = []

    for iv in range(n_v):
        v = iv / (n_v - 1)
        z = z0 + v * z_span

        # True Loomis adult skull & face profile (slender neck -> chiseled jaw -> zygoma -> sleek cranial dome)
        if v < 0.20:
            t = v / 0.20
            flare = (1.0 - t) ** 2.0
            rx = 0.052 + 0.024 * flare
            ry_f = 0.049 + 0.014 * flare
            ry_b = 0.056 + 0.020 * flare
            y_shift = 0.015 * (1.0 - t)
        elif v < 0.27:
            # Crisp under-chin submental shelf stepping sharply forward to chin tip (v=0.24..0.27)
            t = smoothstep(0.20, 0.27, v)
            rx = 0.052 + (0.060 * cheek_width - 0.052) * t
            ry_f = 0.049 + (0.095 - 0.049) * (t ** 0.70)
            ry_b = 0.056 + (0.068 - 0.056) * t
            y_shift = 0.002 * (1.0 - t)
        elif v < 0.68:
            t = (v - 0.27) / 0.41
            rx = (0.060 + 0.018 * (t ** 0.72)) * cheek_width
            ry_f = 0.095 + 0.002 * math.sin(t * math.pi)
            ry_b = 0.068 + 0.032 * smoothstep(0.0, 0.85, t)
            y_shift = 0.004 * t
        else:
            t = (v - 0.68) / 0.32
            # Natural realistic human cranial height (slightly compact ovoid dome instead of tall egg)
            dome = math.sqrt(max(0.0, 1.0 - (t ** 1.92)))
            rx = 0.077 * cheek_width * dome + 0.003 * (1.0 - dome)
            ry_f = 0.094 * dome + 0.003 * (1.0 - dome)
            ry_b = 0.100 * dome + 0.003 * (1.0 - dome)
            y_shift = 0.004 * (1.0 - t)
            z = z0 + (0.68 + 0.275 * t) * z_span

        ring = []
        uv_r = []
        for iu in range(n_u):
            u = iu / n_u
            theta = (u - 0.5) * 2.0 * math.pi  # 0 = front (-Y)
            sin_t = math.sin(theta)
            cos_t = math.cos(theta)
            abs_t = abs(theta)

            if cos_t >= 0.0:
                x = sin_t * rx
                y = -cos_t * ry_f + y_shift
            else:
                x = sin_t * rx * (1.0 + 0.04 * smoothstep(0.48, 0.82, v))
                y = -cos_t * ry_b + y_shift

            # 1. Neck sternocleidomastoid & Adam's apple
            if v < 0.23:
                neck_env = smoothstep(0.0, 0.06, v) * (1.0 - smoothstep(0.15, 0.23, v))
                scm = gauss(abs_t, 0.52 - 0.22 * (v / 0.23), 0.22) * 0.0045 * neck_env
                adams = gauss(abs_t, 0.0, 0.16) * gauss(v, 0.13, 0.026) * 0.0045
                y -= (scm * cos_t + adams)
                x += math.copysign(scm * 0.5, sin_t) if abs_t > 0.05 else 0.0

            # 2. Chiseled Adult Jawline & Strong Tapered Chin
            lower_face_taper = gauss(v, 0.275, 0.075) * smoothstep(-0.1, 0.75, cos_t)
            x *= (1.0 - 0.26 * lower_face_taper)
            gonion = gauss(abs_t, 1.00, 0.20) * gauss(v, 0.35, 0.052) * 0.0090 * jaw_strength
            x += math.copysign(gonion, sin_t) if abs_t > 0.06 else 0.0

            # 3. Sculpted Chin Pad (v=0.275) & Mentolabial Groove (v=0.335)
            chin_pad = gauss(abs_t, 0.0, 0.20) * gauss(v, 0.275, 0.032) * (0.0125 * jaw_strength)
            mento_dip = gauss(abs_t, 0.0, 0.25) * gauss(v, 0.338, 0.018) * 0.0085
            y -= (chin_pad - mento_dip)

            # 4. Full Anatomically-Scaled 3D Mouth & Lips (v=0.382, proper adult mouth width +/-0.27 rad!)
            lower_lip = gauss(abs_t, 0.0, 0.26) * gauss(v, 0.367, 0.014) * 0.0125
            lip_seam = gauss(abs_t, 0.0, 0.28) * gauss(v, 0.382, 0.0065) * 0.0110
            cupid = 1.0 + 0.28 * gauss(abs_t, 0.085, 0.055) - 0.22 * gauss(abs_t, 0.0, 0.038)
            upper_lip = gauss(abs_t, 0.0, 0.24) * gauss(v, 0.397, 0.013) * 0.0120 * cupid
            mouth_corner = gauss(abs_t, 0.34, 0.065) * gauss(v, 0.382, 0.016) * 0.0082
            philtrum = gauss(abs_t, 0.0, 0.048) * gauss(v, 0.428, 0.019) * 0.0042
            y -= (lower_lip + upper_lip - lip_seam - mouth_corner - philtrum)

            # 5. Crisp Chiseled Mediterranean Nose (Base=0.462, Tip=0.485, Nasion=0.605)
            nose_profile = (
                0.0270 * gauss(v, 0.484, 0.026)
                + 0.0170 * gauss(v, 0.538, 0.038)
                + 0.0075 * gauss(v, 0.588, 0.022)
            ) * nose_prominence
            bridge_sigma = 0.068 + 0.038 * gauss(v, 0.484, 0.025)
            nose_bridge = gauss(abs_t, 0.0, bridge_sigma) * nose_profile
            alae = gauss(abs_t, 0.128, 0.046) * gauss(v, 0.468, 0.014) * 0.0110 * nose_prominence
            nostril_in = gauss(abs_t, 0.088, 0.034) * gauss(v, 0.454, 0.010) * 0.0080
            nasion_dip = gauss(abs_t, 0.0, 0.11) * gauss(v, 0.606, 0.016) * 0.0058
            y -= (nose_bridge + alae - nostril_in - nasion_dip)

            # 6. Deep Sculpted Orbital Eye Sockets (Eyes at |theta| ~ 0.36 rad, v = 0.590!)
            orb_depth = gauss(abs_t, 0.36, 0.135) * gauss(v, 0.590, 0.038) * 0.0215
            upper_lid_ridge = gauss(abs_t, 0.36, 0.125) * gauss(v, 0.618, 0.012) * 0.0075
            lower_lid_ridge = gauss(abs_t, 0.36, 0.120) * gauss(v, 0.562, 0.012) * 0.0045
            y -= (upper_lid_ridge + lower_lid_ridge - orb_depth)

            # 7. Pronounced Supraorbital Brow Ridge & Glabella (v = 0.648)
            brow = gauss(abs_t, 0.36, 0.25) * gauss(v, 0.648, 0.026) * (0.0125 * jaw_strength)
            brow_center = gauss(abs_t, 0.0, 0.14) * gauss(v, 0.642, 0.020) * 0.0075
            y -= (brow + brow_center)

            # 8. Zygomatic Cheekbone Planes & Sculpted Buccal Hollows
            cheekbone = gauss(abs_t, 0.72, 0.22) * gauss(v, 0.518, 0.038) * 0.0095
            buccal_hollow = gauss(abs_t, 0.58, 0.19) * gauss(v, 0.415, 0.044) * 0.0072
            nasolabial = gauss(abs_t, 0.32, 0.10) * gauss(v, 0.445, 0.042) * 0.0032
            x += math.copysign(cheekbone - buccal_hollow * 0.75, sin_t) if abs_t > 0.08 else 0.0
            y -= (cheekbone * 0.55 - buccal_hollow * 0.65 + nasolabial)

            # 9. Recessed Temples & Occipital Nape Curve
            temple = gauss(abs_t, 0.94, 0.20) * gauss(v, 0.70, 0.062) * 0.0068
            x -= math.copysign(temple, sin_t) if abs_t > 0.1 else 0.0
            nape_in = gauss(abs_t, math.pi, 0.65) * gauss(v, 0.24, 0.065) * 0.012
            y -= nape_in

            ring.append((x, y, z))
            uv_r.append((u, v))

        rings.append(ring)
        uv_rings.append(uv_r)

    mb.add_uv_loft(rings, uv_rings, skin_mat, head_weights, closed_u=True, cap_start=False, cap_end=True, smooth=True)

    eye_z = z0 + 0.590 * z_span
    brow_z = z0 + 0.648 * z_span
    ear_z = z0 + 0.535 * z_span
    crown_z = z0 + z_span

    # --- Deeply Seated Realistic Eyeballs Wrapped Tightly by Seamless Calm-Gaze Eyelids ---
    eye_x = 0.0295 * cheek_width
    eye_y = -0.0720
    eye_r = 0.0112
    for sx in (-1.0, 1.0):
        mb.add_sphere(
            (sx * eye_x, eye_y, eye_z),
            eye_r, eye_mat, {head_bone: 1.0},
            segments=12, rings=9, smooth=True, front_uv=True,
        )

        # Calm focused Upper Eyelid Crescent Hood (covers top 26% of iris — confident natural human gaze!)
        u_lid_rings, u_lid_uvs = [], []
        lash_pts = []
        for ir, (z_off, y_off, z_scale) in enumerate([
            (0.0004, -0.0014, 0.0024),   # crisp upper lash rim resting slightly over upper iris!
            (0.0046, -0.0014, 0.0042),   # smooth upper lid fold
            (0.0110, +0.0048, 0.0022),   # tucks seamlessly back into orbital crease
        ]):
            r_pts, r_uv = [], []
            for k in range(8):
                t = k / 7.0
                ang = (t - 0.5) * 1.92
                ca, sa = math.cos(ang), math.sin(ang)
                arch = max(0.0, math.cos((t - 0.46) * math.pi))
                lx = sx * (eye_x + sa * (eye_r + 0.0042))
                ly = eye_y - ca * (eye_r + 0.0014) + y_off * arch
                lz = eye_z + z_off * (0.25 + 0.75 * arch) + z_scale * (arch ** 1.3) - 0.0018 * (1.0 - arch)
                r_pts.append((lx, ly, lz))
                r_uv.append((0.5 + sx * (0.042 + t * 0.036), 0.600 + ir * 0.014))
                if ir == 0:
                    lash_pts.append((lx, ly - 0.0005, lz - 0.0002))
            u_lid_rings.append(r_pts)
            u_lid_uvs.append(r_uv)
        mb.add_uv_loft(u_lid_rings, u_lid_uvs, skin_mat, {head_bone: 1.0}, closed_u=False, smooth=True, flip_normals=(sx < 0))
        # Subtle fine dark eyelash rim hugging upper eyelid edge (classic AAA eye realism detail!)
        mb.add_tube(lash_pts, [0.0007, 0.0011, 0.0013, 0.0014, 0.0014, 0.0013, 0.0011, 0.0007], hair_mat, {head_bone: 1.0}, segments=4)

        # Seamless Lower Eyelid Rim touching bottom edge of iris (zero wide-eyed lower white gap!)
        l_lid_rings, l_lid_uvs = [], []
        for ir, (z_off, y_off) in enumerate([
            (-0.0008, -0.0011),
            (-0.0040, +0.0010),
            (-0.0082, +0.0052),
        ]):
            r_pts, r_uv = [], []
            for k in range(8):
                t = k / 7.0
                ang = (t - 0.5) * 1.88
                ca, sa = math.cos(ang), math.sin(ang)
                arch = max(0.0, math.cos((t - 0.50) * math.pi))
                lx = sx * (eye_x + sa * (eye_r + 0.0038))
                ly = eye_y - ca * (eye_r + 0.0012) + y_off
                lz = eye_z + z_off * (0.35 + 0.65 * arch)
                r_pts.append((lx, ly, lz))
                r_uv.append((0.5 + sx * (0.042 + t * 0.036), 0.576 - ir * 0.010))
            l_lid_rings.append(r_pts)
            l_lid_uvs.append(r_uv)
        mb.add_uv_loft(l_lid_rings, l_lid_uvs, skin_mat, {head_bone: 1.0}, closed_u=False, smooth=True, flip_normals=(sx > 0))

    # --- Sculpted Anatomical 3D Ears (Helix + Concha + Soft Rounded Earlobe) ---
    ear_x = 0.075 * cheek_width
    ear_y = 0.010
    for sx in (-1.0, 1.0):
        helix = [
            (sx * (ear_x - 0.004), ear_y - 0.008, ear_z + 0.014),
            (sx * (ear_x + 0.005), ear_y - 0.001, ear_z + 0.022),
            (sx * (ear_x + 0.010), ear_y + 0.008, ear_z + 0.018),
            (sx * (ear_x + 0.010), ear_y + 0.013, ear_z + 0.005),
            (sx * (ear_x + 0.008), ear_y + 0.009, ear_z - 0.010),
            (sx * (ear_x + 0.003), ear_y + 0.001, ear_z - 0.020),
            (sx * (ear_x - 0.005), ear_y - 0.005, ear_z - 0.017),
        ]
        mb.add_tube(helix, [0.0032, 0.0042, 0.0046, 0.0044, 0.0044, 0.0050, 0.0034], skin_mat, {head_bone: 1.0}, segments=6)
        mb.add_sphere(
            (sx * (ear_x + 0.001), ear_y + 0.004, ear_z + 0.001),
            0.015, skin_mat, {head_bone: 1.0},
            scale=(0.35, 0.72, 1.22), rot=(0.0, sx * 0.22, -sx * 0.28), segments=8, rings=6,
        )

    return {
        "eye_z": eye_z,
        "brow_z": brow_z,
        "ear_z": ear_z,
        "crown_z": crown_z,
        "ear_x": ear_x,
        "ear_y": ear_y,
        "neck_base_z": z0,
    }


def add_sculpted_hand(
    mb: CharacterMeshBuilder,
    wrist_pos: Vector,
    side: float,  # +1.0 for Left (+X), -1.0 for Right (-X)
    mat_skin: bpy.types.Material,
    hand_bone: str,
    lower_arm_bone: str,
    grip_flashlight: bool = False,
) -> Vector:
    """Build an articulated human hand (sculpted palm, arched thumb, 4 distinct curled fingers).
    Returns flashlight grip center in world coords if grip_flashlight=True.
    """
    def hand_w(co: Vector) -> WeightSpec:
        # Smooth wrist blend near wrist_pos.z
        t = smoothstep(wrist_pos.z + 0.025, wrist_pos.z - 0.018, co.z)
        return blend_2bones(t, lower_arm_bone, hand_bone)

    # Palm base loft (wrist -> knuckles)
    # In rest pose: hand hangs slightly angled forward (-Y) and inward
    # When gripping flashlight (Right hand), palm angles forward so thumb is on top/inside & fingers wrap barrel!
    if grip_flashlight:
        # Forearm is gently angled forward; hand grips horizontal flashlight barrel running along -Y!
        # Palm faces inward (+X), back of hand faces outward (-X), fingers curl under & around (-Y axis)
        palm_center = wrist_pos + Vector((side * 0.006, -0.042, -0.028))
        mb.add_box(
            palm_center,
            (0.030, 0.078, 0.068),
            mat_skin,
            hand_w,
            rot=(0.22, 0.0, 0.0),
            bevel=0.011,
            bevel_segments=2,
            taper_bottom=(0.88, 0.94),
        )
        # Flashlight barrel axis sits cradled inside the palm!
        fl_center = wrist_pos + Vector((-0.024, -0.055, -0.040))

        # 4 distinct fingers curling tightly around flashlight barrel (radius ~0.019m)
        finger_offsets_y = [-0.027, -0.009, 0.009, 0.026]
        finger_rads = [0.0082, 0.0086, 0.0080, 0.0070]
        for fy, fr in zip(finger_offsets_y, finger_rads):
            pts = [
                (fl_center.x - 0.015, fl_center.y + fy, fl_center.z + 0.016),  # knuckle outer
                (fl_center.x - 0.021, fl_center.y + fy, fl_center.z - 0.006),  # proximal phalanx
                (fl_center.x - 0.005, fl_center.y + fy, fl_center.z - 0.022),  # middle phalanx under barrel
                (fl_center.x + 0.016, fl_center.y + fy, fl_center.z - 0.012),  # distal tip wrapping inside
                (fl_center.x + 0.018, fl_center.y + fy, fl_center.z + 0.005),  # fingertip pad
            ]
            mb.add_tube(pts, [fr, fr * 0.95, fr * 0.88, fr * 0.80, fr * 0.65], mat_skin, {hand_bone: 1.0}, segments=6)

        # Thumb resting naturally along top-inner side of flashlight barrel (ready on switch!)
        thumb_pts = [
            (fl_center.x + 0.008, fl_center.y + 0.028, fl_center.z + 0.018),
            (fl_center.x + 0.017, fl_center.y + 0.008, fl_center.z + 0.024),
            (fl_center.x + 0.010, fl_center.y - 0.018, fl_center.z + 0.023),
            (fl_center.x + 0.002, fl_center.y - 0.036, fl_center.z + 0.020),
        ]
        mb.add_tube(thumb_pts, [0.0115, 0.0105, 0.0092, 0.0076], mat_skin, {hand_bone: 1.0}, segments=6)
        return fl_center

    # Relaxed open-curled natural human hand (palm facing inward toward thigh)
    palm_rings = []
    palm_uvs = []
    # 5 cross-sections from wrist down to knuckles
    sec_specs = [
        (0.000, 0.023, 0.030, 0.000),
        (-0.022, 0.019, 0.037, -0.003),
        (-0.048, 0.017, 0.041, -0.006),
        (-0.076, 0.015, 0.042, -0.009),
        (-0.088, 0.012, 0.037, -0.011),
    ]
    n_seg = 14
    for iz, (dz, rx, ry, dy) in enumerate(sec_specs):
        ring = []
        uv_r = []
        for s in range(n_seg):
            ang = 2.0 * math.pi * s / n_seg
            px = wrist_pos.x + math.cos(ang) * rx
            py = wrist_pos.y + dy + math.sin(ang) * ry
            pz = wrist_pos.z + dz
            ring.append((px, py, pz))
            uv_r.append((s / n_seg, iz / 4.0))
        palm_rings.append(ring)
        palm_uvs.append(uv_r)
    mb.add_uv_loft(palm_rings, palm_uvs, mat_skin, hand_w, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # 4 distinct naturally relaxed curled fingers (index -> pinky)
    finger_specs = [
        (-0.029, 0.072, 0.0080),  # index (front-most, -Y)
        (-0.010, 0.079, 0.0084),  # middle
        (0.010, 0.073, 0.0078),   # ring
        (0.028, 0.058, 0.0068),   # pinky (rear-most, +Y)
    ]
    for fy, flen, frad in finger_specs:
        base = Vector((wrist_pos.x, wrist_pos.y - 0.010 + fy, wrist_pos.z - 0.082))
        pts = [
            base,
            base + Vector((-side * 0.004, -0.004, -flen * 0.36)),
            base + Vector((-side * 0.014, -0.007, -flen * 0.72)),
            base + Vector((-side * 0.024, -0.006, -flen * 0.98)),
        ]
        mb.add_tube(pts, [frad, frad * 0.92, frad * 0.80, frad * 0.64], mat_skin, {hand_bone: 1.0}, segments=7)

    # Sculpted thumb on front-inner edge (-Y)
    t_base = Vector((wrist_pos.x - side * 0.006, wrist_pos.y - 0.026, wrist_pos.z - 0.032))
    t_pts = [
        t_base,
        t_base + Vector((-side * 0.010, -0.020, -0.026)),
        t_base + Vector((-side * 0.018, -0.028, -0.054)),
        t_base + Vector((-side * 0.022, -0.026, -0.074)),
    ]
    mb.add_tube(t_pts, [0.012, 0.0105, 0.0088, 0.0070], mat_skin, {hand_bone: 1.0}, segments=7)
    return wrist_pos


def add_sculpted_sleeve_arm(
    mb: CharacterMeshBuilder,
    shoulder_pos: Vector,
    elbow_pos: Vector,
    wrist_pos: Vector,
    side: float,
    sleeve_mat: bpy.types.Material,
    cuff_mat: bpy.types.Material,
    skin_mat: bpy.types.Material,
    shoulder_bone: str,
    upper_bone: str,
    lower_bone: str,
    hand_bone: str,
    chest_bone: str,
    sleeve_bulk: float = 1.0,
    show_cuff_band: bool = True,
) -> None:
    """Build a continuous anatomically sculpted garment sleeve from shoulder cap to wrist."""
    n_u = 14
    n_v = 16

    def eval_centerline(t: float) -> Tuple[Vector, Vector]:
        # Smooth quadratic curve shoulder -> elbow -> wrist
        if t <= 0.5:
            s = t * 2.0
            p = shoulder_pos.lerp(elbow_pos, s)
            tang = (elbow_pos - shoulder_pos).normalized()
        else:
            s = (t - 0.5) * 2.0
            p = elbow_pos.lerp(wrist_pos, s)
            tang = (wrist_pos - elbow_pos).normalized()
        # Smooth elbow corner rounding
        blend_e = gauss(t, 0.5, 0.08)
        p = p.lerp((shoulder_pos + elbow_pos * 2.0 + wrist_pos) * 0.25, blend_e * 0.14)
        return p, tang

    def arm_w(co: Vector) -> WeightSpec:
        # Distance projection along upper & lower segments
        u_dir = elbow_pos - shoulder_pos
        u_len = u_dir.length
        t_u = clamp((co - shoulder_pos).dot(u_dir) / (u_len * u_len), 0.0, 1.0)
        d_elbow = (co - elbow_pos).length
        # Shoulder blend into Chest/Shoulder near top
        sh_in = smoothstep(abs(shoulder_pos.x) - 0.035, abs(shoulder_pos.x) + 0.030, abs(co.x))
        # Along-arm parameter: 0 at shoulder, 0.5 at elbow, 1.0 at wrist
        l_dir = wrist_pos - elbow_pos
        l_len = l_dir.length
        # Choose nearest segment
        t_l = clamp((co - elbow_pos).dot(l_dir) / (l_len * l_len), 0.0, 1.0)
        p_u = shoulder_pos + u_dir * t_u
        p_l = elbow_pos + l_dir * t_l
        if (co - p_u).length <= (co - p_l).length:
            arm_t = t_u * 0.5
        else:
            arm_t = 0.5 + t_l * 0.5

        t_el = smoothstep(0.42, 0.58, arm_t)
        w_sh = (1.0 - smoothstep(0.0, 0.16, arm_t)) * 0.65 * (1.0 - sh_in * 0.4)
        w_up = (1.0 - t_el) * (1.0 - w_sh)
        w_lo = t_el * (1.0 - smoothstep(0.92, 1.02, arm_t))
        w_ha = smoothstep(0.92, 1.02, arm_t)
        return normalize_weights({
            chest_bone: w_sh * 0.4,
            shoulder_bone: w_sh * 0.6,
            upper_bone: w_up,
            lower_bone: w_lo,
            hand_bone: w_ha,
        })

    rings = []
    uv_rings = []
    for iv in range(n_v):
        t = iv / (n_v - 1)
        # Keep sleeve ending slightly above wrist so wrist skin / cuff shows cleanly
        p, tang = eval_centerline(t * 0.96)
        # Reference forward vector (-Y) to build twist-free frame
        fwd = Vector((0.0, -1.0, 0.0))
        right = tang.cross(fwd)
        if right.length < 1e-4:
            right = Vector((1.0, 0.0, 0.0))
        else:
            right.normalize()
        fwd_ortho = right.cross(tang).normalized()

        # Anatomical arm/sleeve radius profile (deltoid fullness -> bicep -> elbow crease -> forearm -> cuff)
        if t < 0.14:
            # Smoothly rounded deltoid cap tucking cleanly into torso shoulder
            r_base = (0.042 + 0.024 * math.sin((t / 0.14) * math.pi * 0.5)) * sleeve_bulk
            rx = r_base * 0.95
            ry = r_base * 1.12
        elif t < 0.50:
            s = (t - 0.14) / 0.36
            rx = (0.062 - 0.008 * s) * sleeve_bulk
            ry = (0.068 - 0.011 * s) * sleeve_bulk
        elif t < 0.92:
            s = (t - 0.50) / 0.42
            # Brachioradialis fullness right below elbow, tapering cleanly to cuff
            forearm_bump = 0.005 * gauss(s, 0.22, 0.20)
            rx = (0.053 - 0.013 * s + forearm_bump) * sleeve_bulk
            ry = (0.056 - 0.014 * s + forearm_bump) * sleeve_bulk
        else:
            # Tailored cuff edge
            rx = 0.041 * sleeve_bulk
            ry = 0.043 * sleeve_bulk

        # Subtle sculpted fabric creases around inner elbow (t ~ 0.48..0.56)
        crease = 0.0032 * math.sin((t - 0.50) * 75.0) * gauss(t, 0.50, 0.065)

        ring = []
        uv_r = []
        for iu in range(n_u):
            ang = 2.0 * math.pi * iu / n_u
            c_ang = math.cos(ang)
            s_ang = math.sin(ang)
            # Crease strongest on inner-front elbow bend
            local_crease = crease * max(0.0, s_ang)
            offset = right * (c_ang * (rx + local_crease)) + fwd_ortho * (s_ang * (ry + local_crease))
            ring.append(tuple(p + offset))
            uv_r.append((iu / n_u * 2.0, t * 3.2))
        rings.append(ring)
        uv_rings.append(uv_r)

    mb.add_uv_loft(rings, uv_rings, sleeve_mat, arm_w, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Crisp cuff band & exposed anatomical wrist connecting sleeve to hand
    if show_cuff_band:
        cuff_p, cuff_t = eval_centerline(0.93)
        rot_q = Vector((0.0, 0.0, -1.0)).rotation_difference(cuff_t).to_euler("XYZ")
        mb.add_cylinder(cuff_p, 0.043 * sleeve_bulk, 0.044 * sleeve_bulk, 0.048, cuff_mat, {lower_bone: 0.85, hand_bone: 0.15}, segments=16, rot=rot_q)

    # Exposed skin wrist necking cleanly into hand
    w_top, w_t = eval_centerline(0.93)
    w_mid = w_top.lerp(wrist_pos, 0.55)
    rot_w = Vector((0.0, 0.0, -1.0)).rotation_difference(w_t).to_euler("XYZ")
    mb.add_cylinder(w_mid, 0.031, 0.034, 0.052, skin_mat, {lower_bone: 0.5, hand_bone: 0.5}, segments=14, rot=rot_w)


def add_sculpted_trouser_leg(
    mb: CharacterMeshBuilder,
    hip_pos: Vector,
    knee_pos: Vector,
    ankle_pos: Vector,
    side: float,
    pants_mat: bpy.types.Material,
    hips_bone: str,
    upper_leg_bone: str,
    lower_leg_bone: str,
    foot_bone: str,
    pressed_crease: bool = True,
    taper: float = 1.0,
) -> None:
    """Build a continuous anatomically sculpted trouser leg with knee drape and pressed crease."""
    n_u = 16
    n_v = 18

    def leg_w(co: Vector) -> WeightSpec:
        t_hip = smoothstep(hip_pos.z + 0.025, hip_pos.z - 0.075, co.z)
        t_knee = smoothstep(knee_pos.z + 0.058, knee_pos.z - 0.058, co.z)
        t_ank = smoothstep(ankle_pos.z + 0.040, ankle_pos.z - 0.025, co.z)
        w_hips = 1.0 - t_hip
        w_up = t_hip * (1.0 - t_knee)
        w_lo = t_knee * (1.0 - t_ank)
        w_ft = t_ank
        return normalize_weights({
            hips_bone: w_hips,
            upper_leg_bone: w_up,
            lower_leg_bone: w_lo,
            foot_bone: w_ft,
        })

    rings = []
    uv_rings = []
    for iv in range(n_v):
        t = iv / (n_v - 1)  # 0 at hip top (+0.03), 0.5 at knee, 1.0 at ankle/boot cuff
        if t <= 0.5:
            s = t * 2.0
            p = (hip_pos + Vector((0, 0, 0.025))).lerp(knee_pos, s)
        else:
            s = (t - 0.5) * 2.0
            p = knee_pos.lerp(ankle_pos, s)

        # Realistic leg cross-section: muscular thigh -> slightly tapered knee -> calf curve -> hem
        if t < 0.48:
            s = t / 0.48
            rx = (0.094 - 0.025 * (s ** 1.15)) * taper
            ry = (0.104 - 0.028 * (s ** 1.15)) * taper
            # Glute fullness at top rear (+Y)
            p = Vector((p.x, p.y + 0.012 * ((1.0 - s) ** 1.8), p.z))
        else:
            s = (t - 0.48) / 0.52
            calf = 0.009 * gauss(s, 0.34, 0.24)
            rx = (0.069 - 0.017 * s + calf * 0.7) * taper
            ry = (0.075 - 0.018 * s + calf) * taper
            p = Vector((p.x, p.y + calf * 0.8, p.z))

        # Subtle natural fabric break folds behind knee & at ankle hem
        knee_fold = 0.004 * math.sin((t - 0.50) * 65.0) * gauss(t, 0.50, 0.06)
        ankle_break = 0.0045 * math.sin((t - 0.92) * 55.0) * gauss(t, 0.92, 0.05)

        ring = []
        uv_r = []
        for iu in range(n_u):
            ang = 2.0 * math.pi * iu / n_u
            c_a = math.cos(ang)  # +X / -X
            s_a = math.sin(ang)  # +Y back / -Y front
            # Crisp front & back pressed uniform trouser crease (-Y and +Y peaks)
            crease_ext = 0.0055 * (abs(s_a) ** 6) if pressed_crease else 0.0
            # Inner thigh slight flattening so legs don't intersect at crotch
            inner = max(0.0, -side * c_a) * smoothstep(0.35, 0.0, t) * 0.016
            r_x = rx - inner
            r_y = ry + crease_ext + knee_fold * max(0.0, s_a) + ankle_break
            ring.append((p.x + c_a * r_x, p.y + s_a * r_y, p.z))
            uv_r.append((iu / n_u * 2.2, t * 4.5))
        rings.append(ring)
        uv_rings.append(uv_r)

    mb.add_uv_loft(rings, uv_rings, pants_mat, leg_w, closed_u=True, cap_start=True, cap_end=True, smooth=True)


def add_combat_boot(
    mb: CharacterMeshBuilder,
    ankle_pos: Vector,
    side: float,
    leather_mat: bpy.types.Material,
    sole_mat: bpy.types.Material,
    metal_mat: bpy.types.Material,
    lower_leg_bone: str,
    foot_bone: str,
) -> None:
    """Build a realistic polished leather tactical combat boot strictly grounded at z = 0.0000."""
    def boot_w(co: Vector) -> WeightSpec:
        t = smoothstep(ankle_pos.z + 0.055, ankle_pos.z - 0.020, co.z)
        return blend_2bones(t, lower_leg_bone, foot_bone)

    # Boot shaft wrapping lower shin cleanly into trouser hem (z = 0.08 .. 0.21)
    shaft_rings = []
    shaft_uvs = []
    shaft_specs = [
        (0.075, 0.049, 0.058, 0.000),
        (0.115, 0.051, 0.060, 0.002),
        (0.165, 0.055, 0.064, 0.004),
        (0.205, 0.059, 0.068, 0.005),
    ]
    n_u = 12
    for iz, (z, rx, ry, dy) in enumerate(shaft_specs):
        ring, uv_r = [], []
        for iu in range(n_u):
            ang = 2.0 * math.pi * iu / n_u
            ring.append((ankle_pos.x + math.cos(ang) * rx, ankle_pos.y + dy + math.sin(ang) * ry, z))
            uv_r.append((iu / n_u * 2.0, iz * 0.45))
        shaft_rings.append(ring)
        shaft_uvs.append(uv_r)
    mb.add_uv_loft(shaft_rings, shaft_uvs, leather_mat, boot_w, closed_u=True, cap_start=False, cap_end=True, smooth=True)

    # Sculpted contoured boot upper (heel counter -> instep -> rounded reinforced toe cap)
    foot_rings = []
    foot_uvs = []
    foot_profiles = [
        (0.072, 0.032, 0.088, 0.036, 0.000),
        (0.045, 0.028, 0.098, 0.047, 0.000),
        (0.000, 0.026, 0.096, 0.050, 0.000),
        (-0.055, 0.024, 0.084, 0.052, -side * 0.002),
        (-0.115, 0.022, 0.068, 0.054, -side * 0.003),
        (-0.162, 0.022, 0.058, 0.048, -side * 0.004),
        (-0.192, 0.025, 0.048, 0.034, -side * 0.005),
        (-0.206, 0.029, 0.038, 0.018, -side * 0.005),
    ]
    n_p = 12
    for iy, (yo, zb, zt, hw, xb) in enumerate(foot_profiles):
        ring, uv_r = [], []
        cz = (zb + zt) * 0.5
        hz = (zt - zb) * 0.5
        for ip in range(n_p):
            ang = 2.0 * math.pi * ip / n_p
            ca = math.cos(ang)
            sa = math.sin(ang)
            # Flatter bottom, rounder dome top
            z_pt = cz + (sa * hz if sa >= 0 else sa * hz * 0.85)
            x_pt = ankle_pos.x + xb + ca * hw * (1.0 - 0.14 * max(0.0, sa))
            ring.append((x_pt, ankle_pos.y + yo, z_pt))
            uv_r.append((ip / n_p * 2.0, iy / 7.0 * 2.0))
        foot_rings.append(ring)
        foot_uvs.append(uv_r)
    mb.add_uv_loft(foot_rings, foot_uvs, leather_mat, {foot_bone: 1.0}, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Thick sculpted lugged rubber sole + heel block strictly grounded at z = 0.0000!
    # Main sole platform z = 0.000 .. 0.026
    sole_rings = []
    sole_uvs = []
    sole_profiles = [
        (0.076, 0.000, 0.032, 0.042, 0.000),
        (0.040, 0.000, 0.030, 0.051, 0.000),
        (0.005, 0.000, 0.029, 0.049, 0.000),
        (-0.032, 0.008, 0.027, 0.045, 0.000),  # arch waist recess!
        (-0.070, 0.000, 0.025, 0.055, -side * 0.002),
        (-0.130, 0.000, 0.024, 0.057, -side * 0.003),
        (-0.180, 0.000, 0.024, 0.048, -side * 0.004),
        (-0.208, 0.005, 0.028, 0.026, -side * 0.005),
    ]
    for iy, (yo, zb, zt, hw, xb) in enumerate(sole_profiles):
        ring, uv_r = [], []
        cz = (zb + zt) * 0.5
        hz = (zt - zb) * 0.5
        for ip in range(12):
            ang = 2.0 * math.pi * ip / 12
            ca, sa = math.cos(ang), math.sin(ang)
            # Boxier rubber outsole silhouette
            x_pt = ankle_pos.x + xb + math.copysign(abs(ca) ** 0.72, ca) * hw
            z_pt = cz + math.copysign(abs(sa) ** 0.55, sa) * hz
            ring.append((x_pt, ankle_pos.y + yo, max(0.0, z_pt)))
            uv_r.append((ip / 12.0, iy / 7.0))
        sole_rings.append(ring)
        sole_uvs.append(uv_r)
    mb.add_uv_loft(sole_rings, sole_uvs, sole_mat, {foot_bone: 1.0}, closed_u=True, cap_start=True, cap_end=True, smooth=False)

    # Lace bars + metallic speed-lace eyelets up the boot tongue
    for k in range(5):
        lz = 0.088 + k * 0.022
        ly = ankle_pos.y - 0.062 + k * 0.0045
        mb.add_box((ankle_pos.x, ly, lz), (0.044, 0.008, 0.005), sole_mat, boot_w, bevel=0.0015)
        for ex in (-0.024, 0.024):
            mb.add_sphere((ankle_pos.x + ex, ly + 0.003, lz), 0.0036, metal_mat, boot_w, segments=6, rings=5)


def add_coastal_loafer(
    mb: CharacterMeshBuilder,
    ankle_pos: Vector,
    side: float,
    suede_mat: bpy.types.Material,
    sole_mat: bpy.types.Material,
    skin_mat: bpy.types.Material,
    lower_leg_bone: str,
    foot_bone: str,
) -> None:
    """Build a sleek Mediterranean suede evening loafer/minimalist sneaker grounded at z = 0.0000."""
    # Brief ankle/sock bridge tucked into cuffed chino hem
    mb.add_cylinder(
        (ankle_pos.x, ankle_pos.y, 0.095),
        0.041, 0.044, 0.070, skin_mat, {lower_leg_bone: 0.7, foot_bone: 0.3}, segments=14,
    )

    # Sleek almond-toe suede loafer upper
    foot_rings, foot_uvs = [], []
    profiles = [
        (0.068, 0.022, 0.072, 0.034, 0.000),
        (0.038, 0.020, 0.074, 0.044, 0.000),
        (-0.008, 0.018, 0.066, 0.046, 0.000),
        (-0.065, 0.018, 0.064, 0.049, -side * 0.002),
        (-0.125, 0.018, 0.056, 0.050, -side * 0.003),
        (-0.172, 0.018, 0.046, 0.042, -side * 0.004),
        (-0.198, 0.020, 0.036, 0.026, -side * 0.005),
        (-0.208, 0.023, 0.030, 0.013, -side * 0.005),
    ]
    n_p = 14
    for iy, (yo, zb, zt, hw, xb) in enumerate(profiles):
        ring, uv_r = [], []
        cz, hz = (zb + zt) * 0.5, (zt - zb) * 0.5
        for ip in range(n_p):
            ang = 2.0 * math.pi * ip / n_p
            ca, sa = math.cos(ang), math.sin(ang)
            z_pt = cz + (sa * hz if sa >= 0 else sa * hz * 0.85)
            x_pt = ankle_pos.x + xb + ca * hw * (1.0 - 0.16 * max(0.0, sa))
            ring.append((x_pt, ankle_pos.y + yo, z_pt))
            uv_r.append((ip / n_p * 2.0, iy / 7.0 * 2.0))
        foot_rings.append(ring)
        foot_uvs.append(uv_r)
    mb.add_uv_loft(foot_rings, foot_uvs, suede_mat, {foot_bone: 1.0}, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Penny-loafer saddle strap detail across instep
    mb.add_box(
        (ankle_pos.x - side * 0.002, ankle_pos.y - 0.078, 0.058),
        (0.092, 0.032, 0.014),
        suede_mat,
        {foot_bone: 1.0},
        rot=(0.14, 0.0, 0.0),
        bevel=0.005,
    )

    # Clean off-white/espresso low-profile cupsole strictly grounded at z = 0.0000
    sole_rings, sole_uvs = [], []
    s_profiles = [
        (0.072, 0.000, 0.023, 0.038, 0.000),
        (0.030, 0.000, 0.022, 0.047, 0.000),
        (-0.040, 0.000, 0.020, 0.047, -side * 0.001),
        (-0.115, 0.000, 0.020, 0.052, -side * 0.003),
        (-0.178, 0.000, 0.020, 0.043, -side * 0.004),
        (-0.209, 0.003, 0.022, 0.021, -side * 0.005),
    ]
    for iy, (yo, zb, zt, hw, xb) in enumerate(s_profiles):
        ring, uv_r = [], []
        cz, hz = (zb + zt) * 0.5, (zt - zb) * 0.5
        for ip in range(12):
            ang = 2.0 * math.pi * ip / 12
            ca, sa = math.cos(ang), math.sin(ang)
            x_pt = ankle_pos.x + xb + math.copysign(abs(ca) ** 0.72, ca) * hw
            z_pt = cz + math.copysign(abs(sa) ** 0.55, sa) * hz
            ring.append((x_pt, ankle_pos.y + yo, max(0.0, z_pt)))
            uv_r.append((ip / 12.0, iy / 5.0))
        sole_rings.append(ring)
        sole_uvs.append(uv_r)
    mb.add_uv_loft(sole_rings, sole_uvs, sole_mat, {foot_bone: 1.0}, closed_u=True, cap_start=True, cap_end=True, smooth=False)


# ---------------------------------------------------------------------------
# Humanoid Armature Builder
# ---------------------------------------------------------------------------

def create_humanoid_armature(
    name: str,
    joints: Dict[str, Tuple[Vector, Vector, Optional[str], Optional[Vector]]],
) -> bpy.types.Object:
    """Create a clean Blender Armature from (head, tail, parent, roll_align_vec) specs."""
    arm_data = bpy.data.armatures.new(name)
    arm_obj = bpy.data.objects.new(name, arm_data)
    bpy.context.scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    created: Dict[str, bpy.types.EditBone] = {}
    for b_name, (head, tail, parent_name, align_vec) in joints.items():
        eb = arm_data.edit_bones.new(b_name)
        eb.head = head.copy()
        eb.tail = tail.copy()
        eb.use_connect = False
        if align_vec is not None:
            eb.align_roll(align_vec)
        else:
            eb.roll = 0.0
        created[b_name] = eb

    for b_name, (_, _, parent_name, _) in joints.items():
        if parent_name and parent_name in created:
            created[b_name].parent = created[parent_name]

    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = "XYZ"
    return arm_obj


# ---------------------------------------------------------------------------
# Procedural Cyclic Skeletal Animation Authoring
# ---------------------------------------------------------------------------

def _reset_pose(arm_obj: bpy.types.Object) -> None:
    for pb in arm_obj.pose.bones:
        pb.location = (0.0, 0.0, 0.0)
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.scale = (1.0, 1.0, 1.0)


def author_nla_clip(
    arm_obj: bpy.types.Object,
    clip_name: str,
    num_frames: int,
    pose_fn: Callable[[float, Dict[str, bpy.types.PoseBone]], None],
    fps: int = 24,
) -> None:
    """Evaluate `pose_fn(phase in [0, 1], pose_bones)` at each frame and bake into a named NLA track."""
    bpy.context.scene.render.fps = fps
    if arm_obj.animation_data is None:
        arm_obj.animation_data_create()

    action = bpy.data.actions.new(name=clip_name)
    arm_obj.animation_data.action = action
    pose_bones = {pb.name: pb for pb in arm_obj.pose.bones}

    # Sample every 2 frames + exact start/end for crisp lightweight smooth curves!
    sample_frames = list(range(1, num_frames + 1, 2))
    if sample_frames[-1] != num_frames:
        sample_frames.append(num_frames)
    # Include frame num_frames + 1 == phase 1.0 == phase 0.0 for seamless looping!
    end_frame = num_frames + 1
    sample_frames.append(end_frame)

    for frame in sample_frames:
        phase = (frame - 1) / float(num_frames)
        _reset_pose(arm_obj)
        pose_fn(phase, pose_bones)
        for pb in arm_obj.pose.bones:
            pb.keyframe_insert(data_path="rotation_euler", frame=frame)
            if pb.name == "Hips":
                pb.keyframe_insert(data_path="location", frame=frame)

    # Push to dedicated NLA track named exactly `clip_name`
    track = arm_obj.animation_data.nla_tracks.new()
    track.name = clip_name
    strip = track.strips.new(name=clip_name, start=1, action=action)
    strip.name = clip_name
    strip.frame_end = float(end_frame)

    # Clear active action & restore clean bind pose
    arm_obj.animation_data.action = None
    _reset_pose(arm_obj)


def _set_rot(pb_map: Dict[str, bpy.types.PoseBone], name: str, rx_deg: float, ry_deg: float = 0.0, rz_deg: float = 0.0) -> None:
    if name in pb_map:
        pb_map[name].rotation_euler = (math.radians(rx_deg), math.radians(ry_deg), math.radians(rz_deg))


# ---------------------------------------------------------------------------
# CHARACTER 1: Catalan Securion / Mossos Night Security Guard (1.80m)
# ---------------------------------------------------------------------------

def build_character_guard(out_path: Path, tex_dir: Path) -> dict:
    reset_scene()

    # Photorealistic PBR materials backed by packed gpt-image-2 textures
    mat_face = make_pbr_material(
        "Guard_FaceSkin", tex_dir,
        albedo_file="guard_face_albedo.jpg",
        normal_file="skin_fine_normal.png",
        roughness_file="skin_fine_roughness.jpg",
        fallback_color="#C99676",
        roughness=0.48,
        normal_strength=0.35,
        specular_ior=0.44,
    )
    mat_skin = make_pbr_material(
        "Guard_SkinHands", tex_dir,
        albedo_file="skin_fine_albedo.jpg",
        normal_file="skin_fine_normal.png",
        roughness_file="skin_fine_roughness.jpg",
        fallback_color="#C99676",
        roughness=0.50,
        normal_strength=0.32,
        specular_ior=0.44,
    )
    mat_eye = make_pbr_material(
        "Guard_Eye", tex_dir,
        albedo_file="eye_iris_albedo.jpg",
        fallback_color="#4A3525",
        roughness=0.05,
        coat=1.0,
        coat_roughness=0.03,
        specular_ior=0.65,
    )
    mat_hair = make_pbr_material(
        "Guard_Hair", tex_dir,
        albedo_file="hair_dark_strands_albedo.jpg",
        normal_file="hair_dark_strands_normal.png",
        roughness_file="hair_dark_strands_roughness.jpg",
        fallback_color="#211A16",
        roughness=0.46,
        normal_strength=0.55,
    )
    mat_shirt = make_pbr_material(
        "Guard_UniformShirt", tex_dir,
        albedo_file="uniform_navy_twill_albedo.jpg",
        normal_file="uniform_navy_twill_normal.png",
        roughness_file="uniform_navy_twill_roughness.jpg",
        fallback_color="#1D2E4B",
        roughness=0.72,
        normal_strength=0.55,
    )
    mat_trousers = make_pbr_material(
        "Guard_UniformTrousers", tex_dir,
        albedo_file="uniform_trousers_albedo.jpg",
        normal_file="uniform_navy_twill_normal.png",
        roughness_file="uniform_navy_twill_roughness.jpg",
        fallback_color="#131D30",
        roughness=0.74,
        normal_strength=0.50,
    )
    mat_vest = make_pbr_material(
        "Guard_TacticalVest", tex_dir,
        albedo_file="tactical_vest_cordura_albedo.jpg",
        normal_file="tactical_vest_cordura_normal.png",
        roughness_file="tactical_vest_cordura_roughness.jpg",
        fallback_color="#161A22",
        roughness=0.66,
        normal_strength=0.68,
    )
    mat_epaulette = make_pbr_material(
        "Guard_EpauletteAccent", tex_dir,
        albedo_file="uniform_navy_twill_albedo.jpg",
        normal_file="uniform_navy_twill_normal.png",
        fallback_color="#5B86B8",
        tint=(2.1, 2.5, 3.0),
        roughness=0.56,
        normal_strength=0.35,
    )
    mat_catalan_red = make_pbr_material(
        "Guard_CatalanTrim", tex_dir,
        fallback_color="#8C1D24",
        roughness=0.45,
        metallic=0.15,
    )
    mat_leather = make_pbr_material(
        "Guard_LeatherBootsBelt", tex_dir,
        albedo_file="leather_black_grain_albedo.jpg",
        normal_file="leather_black_grain_normal.png",
        roughness_file="leather_black_grain_roughness.jpg",
        fallback_color="#15161A",
        roughness=0.30,
        coat=0.35,
        coat_roughness=0.22,
        normal_strength=0.52,
    )
    mat_sole = make_pbr_material(
        "Guard_RubberSole", tex_dir,
        fallback_color="#101216",
        roughness=0.82,
    )
    mat_visor = make_pbr_material(
        "Guard_CapVisorPatent", tex_dir,
        fallback_color="#090B10",
        metallic=0.08,
        roughness=0.11,
        coat=0.95,
        coat_roughness=0.06,
    )
    mat_silver = make_pbr_material(
        "Guard_MetallicBadge", tex_dir,
        albedo_file="metal_anodized_brushed_albedo.jpg",
        normal_file="metal_anodized_brushed_normal.png",
        fallback_color="#D0D8E2",
        tint=(2.4, 2.45, 2.55),
        metallic=0.92,
        roughness=0.22,
        normal_strength=0.22,
    )
    mat_gold = make_pbr_material(
        "Guard_BrassGold", tex_dir,
        fallback_color="#C9A24B",
        metallic=0.90,
        roughness=0.25,
    )
    mat_torch = make_pbr_material(
        "Guard_FlashlightAluminum", tex_dir,
        albedo_file="metal_anodized_brushed_albedo.jpg",
        normal_file="metal_anodized_brushed_normal.png",
        roughness_file="metal_anodized_brushed_roughness.jpg",
        fallback_color="#232830",
        metallic=0.84,
        roughness=0.32,
        normal_strength=0.45,
    )
    mat_lens = make_pbr_material(
        "Guard_FlashlightLens", tex_dir,
        fallback_color="#FFF7DE",
        roughness=0.08,
        metallic=0.05,
        emission_color="#FFE8A8",
        emission_strength=4.8,
    )
    mat_earcoil = make_pbr_material(
        "Guard_AcousticCoil", tex_dir,
        fallback_color="#C6CDD4",
        roughness=0.20,
        coat=0.6,
        alpha=0.82,
    )
    mat_radio_led = make_pbr_material(
        "Guard_RadioLED", tex_dir,
        fallback_color="#34D399",
        emission_color="#22C55E",
        emission_strength=2.6,
        roughness=0.2,
    )

    # --- Anatomical Joint Coordinates (1.80m Guard, facing -Y, grounded z=0.0) ---
    hip_z = 0.945
    knee_z = 0.505
    ankle_z = 0.095
    shoulder_z = 1.402
    neck_z = 1.455
    head_pivot_z = 1.540

    hip_l = Vector((0.096, 0.0, hip_z))
    hip_r = Vector((-0.096, 0.0, hip_z))
    knee_l = Vector((0.092, -0.008, knee_z))
    knee_r = Vector((-0.092, -0.008, knee_z))
    ankle_l = Vector((0.096, 0.012, ankle_z))
    ankle_r = Vector((-0.096, 0.012, ankle_z))

    sh_l = Vector((0.192, 0.006, shoulder_z))
    el_l = Vector((0.232, 0.010, 1.125))
    wr_l = Vector((0.242, -0.036, 0.865))

    # Right arm gently flexed forward so Flashlight naturally aims along -Y (glTF +Z) in bind pose!
    sh_r = Vector((-0.192, 0.006, shoulder_z))
    el_r = Vector((-0.230, 0.014, 1.128))
    wr_r = Vector((-0.228, -0.118, 0.938))
    fl_grip_pos = wr_r + Vector((-0.024, -0.055, -0.040))

    fwd_vec = Vector((0.0, -1.0, 0.0))
    up_vec = Vector((0.0, 0.0, 1.0))

    joints = {
        "Root": (Vector((0, 0, 0)), Vector((0, 0, 0.18)), None, None),
        "Hips": (Vector((0, 0, hip_z)), Vector((0, 0, 1.07)), "Root", None),
        "Spine": (Vector((0, 0, 1.07)), Vector((0, 0, 1.24)), "Hips", None),
        "Chest": (Vector((0, 0, 1.24)), Vector((0, 0, neck_z)), "Spine", None),
        "Neck": (Vector((0, 0, neck_z)), Vector((0, 0, head_pivot_z)), "Chest", None),
        "Head": (Vector((0, 0, head_pivot_z)), Vector((0, 0, 1.76)), "Neck", None),
        "Shoulder_L": (Vector((0.075, 0.006, 1.42)), sh_l, "Chest", fwd_vec),
        "UpperArm_L": (sh_l, el_l, "Shoulder_L", fwd_vec),
        "LowerArm_L": (el_l, wr_l, "UpperArm_L", fwd_vec),
        "Hand_L": (wr_l, wr_l + Vector((0.0, -0.02, -0.10)), "LowerArm_L", fwd_vec),
        "Shoulder_R": (Vector((-0.075, 0.006, 1.42)), sh_r, "Chest", fwd_vec),
        "UpperArm_R": (sh_r, el_r, "Shoulder_R", fwd_vec),
        "LowerArm_R": (el_r, wr_r, "UpperArm_R", fwd_vec),
        "Hand_R": (wr_r, wr_r + Vector((0.0, -0.07, -0.05)), "LowerArm_R", fwd_vec),
        # Flashlight bone points +Z with roll=0 -> local +Z in glTF points strictly +Z (out of lens!)
        "Flashlight": (fl_grip_pos, fl_grip_pos + Vector((0.0, 0.0, 0.12)), "Hand_R", None),
        "UpperLeg_L": (hip_l, knee_l, "Hips", fwd_vec),
        "LowerLeg_L": (knee_l, ankle_l, "UpperLeg_L", fwd_vec),
        "Foot_L": (ankle_l, Vector((ankle_l.x, -0.165, 0.025)), "LowerLeg_L", up_vec),
        "UpperLeg_R": (hip_r, knee_r, "Hips", fwd_vec),
        "LowerLeg_R": (knee_r, ankle_r, "UpperLeg_R", fwd_vec),
        "Foot_R": (ankle_r, Vector((ankle_r.x, -0.165, 0.025)), "LowerLeg_R", up_vec),
    }

    arm_obj = create_humanoid_armature("GuardArmature", joints)
    mb = CharacterMeshBuilder()

    def torso_w(co: Vector) -> WeightSpec:
        t_sp = smoothstep(0.98, 1.14, co.z)
        t_ch = smoothstep(1.18, 1.33, co.z)
        return normalize_weights({
            "Hips": 1.0 - t_sp,
            "Spine": t_sp * (1.0 - t_ch),
            "Chest": t_ch,
        })

    def belt_w(co: Vector) -> WeightSpec:
        return {"Hips": 0.78, "Spine": 0.22}

    # --- 1. Pelvis / Seat Block & Continuous Sculpted Uniform Trousers ---
    # Natural anatomical stance: hips +/-0.095 -> knees +/-0.092 -> ankles +/-0.096
    pelv_rings, pelv_uvs = [], []
    pelv_specs = [
        (0.878, 0.164, 0.112, 0.007),
        (0.922, 0.180, 0.122, 0.009),
        (0.968, 0.178, 0.118, 0.005),
        (1.015, 0.168, 0.112, 0.003),
    ]
    for iz, (z, rx, ry, dy) in enumerate(pelv_specs):
        ring, uv_r = [], []
        for iu in range(20):
            ang = 2.0 * math.pi * iu / 20
            ca, sa = math.cos(ang), math.sin(ang)
            crotch = 0.014 * (abs(sa) ** 4) if iz == 0 else 0.0
            ring.append((ca * rx, dy + sa * (ry - crotch), z))
            uv_r.append((iu / 20.0 * 2.5, iz * 0.45))
        pelv_rings.append(ring)
        pelv_uvs.append(uv_r)
    mb.add_uv_loft(pelv_rings, pelv_uvs, mat_trousers, {"Hips": 0.90, "Spine": 0.10}, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    add_sculpted_trouser_leg(mb, hip_l, knee_l, ankle_l, +1.0, mat_trousers, "Hips", "UpperLeg_L", "LowerLeg_L", "Foot_L", pressed_crease=True, taper=0.98)
    add_sculpted_trouser_leg(mb, hip_r, knee_r, ankle_r, -1.0, mat_trousers, "Hips", "UpperLeg_R", "LowerLeg_R", "Foot_R", pressed_crease=True, taper=0.98)
    add_combat_boot(mb, ankle_l, +1.0, mat_leather, mat_sole, mat_silver, "LowerLeg_L", "Foot_L")
    add_combat_boot(mb, ankle_r, -1.0, mat_leather, mat_sole, mat_silver, "LowerLeg_R", "Foot_R")

    # --- 2. Continuous Sculpted Dark-Navy Uniform Shirt Torso (Anatomical Sloped Shoulders!) ---
    torso_rings, torso_uvs = [], []
    t_specs = [
        (0.995, 0.160, 0.108, 0.110, 0.002),
        (1.055, 0.158, 0.106, 0.108, 0.002),
        (1.135, 0.168, 0.114, 0.112, 0.000),
        (1.220, 0.184, 0.124, 0.118, -0.002),
        (1.310, 0.198, 0.128, 0.122, -0.002),
        (1.385, 0.202, 0.116, 0.116, 0.001),
        (1.425, 0.168, 0.094, 0.098, 0.004),  # Natural trapezius slope down from neck!
        (1.455, 0.098, 0.068, 0.074, 0.005),
        (1.475, 0.064, 0.058, 0.064, 0.005),
    ]
    n_tu = 24
    for iz, (z, rx, ryf, ryb, y_off) in enumerate(t_specs):
        ring, uv_r = [], []
        for iu in range(n_tu):
            ang = 2.0 * math.pi * iu / n_tu
            ca, sa = math.cos(ang), math.sin(ang)
            ry = ryf if sa < 0 else ryb
            spine_in = 0.007 * (max(0.0, sa) ** 6) if 2 <= iz <= 5 else 0.0
            pec = 0.006 * max(0.0, -sa) * (1.0 - 0.4 * gauss(ca, 0.0, 0.25)) if 4 <= iz <= 5 else 0.0
            ring.append((ca * rx, y_off + sa * (ry - spine_in + pec), z))
            uv_r.append((iu / n_tu * 3.0, (z - 0.995) * 4.5))
        torso_rings.append(ring)
        torso_uvs.append(uv_r)
    mb.add_uv_loft(torso_rings, torso_uvs, mat_shirt, torso_w, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Folded uniform shirt collar + tactical dark tie + front placket
    collar_pts = []
    for k in range(15):
        ang = -math.pi * 0.85 + (k / 14.0) * math.pi * 1.70  # open slightly at front tie knot (-Y)
        cx = math.sin(ang) * 0.074
        cy = math.cos(ang) * 0.074 + 0.004
        cz = 1.468 + 0.010 * math.cos(ang)
        collar_pts.append((cx, cy, cz))
    mb.add_tube(collar_pts, 0.015, mat_shirt, {"Chest": 0.75, "Neck": 0.25}, segments=8)
    # Shirt collar points flanking tie knot
    for sx in (-1.0, 1.0):
        mb.add_box((sx * 0.036, -0.074, 1.456), (0.048, 0.014, 0.036), mat_shirt, {"Chest": 0.85, "Neck": 0.15}, rot=(0.24, sx * 0.20, sx * 0.35), bevel=0.004)
    # Uniform tie knot & blade tucked cleanly under vest neckline
    mb.add_box((0.0, -0.079, 1.454), (0.026, 0.018, 0.024), mat_trousers, {"Chest": 1.0}, bevel=0.005, taper_bottom=(0.75, 0.85))
    mb.add_box((0.0, -0.095, 1.402), (0.036, 0.014, 0.092), mat_trousers, {"Chest": 1.0}, rot=(-0.22, 0.0, 0.0), bevel=0.004)

    # Shoulder epaulettes (Catalan blue rank bars + metallic snap button)
    for sx in (-1.0, 1.0):
        mb.add_box(
            (sx * 0.150, 0.004, 1.448),
            (0.112, 0.046, 0.012),
            mat_epaulette,
            {"Chest": 0.55, f"Shoulder_{'L' if sx > 0 else 'R'}": 0.45},
            rot=(0.0, sx * 0.18, 0.0),
            bevel=0.003,
        )
        mb.add_cylinder(
            (sx * 0.104, 0.004, 1.462),
            0.0065, 0.0065, 0.006, mat_silver, {"Chest": 0.85, f"Shoulder_{'L' if sx > 0 else 'R'}": 0.15}, segments=10,
        )

    # --- 3. Realistic Structured Tactical Security Vest ---
    # Fitted layered Cordura carrier shell hugging ribcage (open at upper V-neck & armholes)
    vest_rings, vest_uvs = [], []
    v_specs = [
        (1.062, 0.174, 0.125, 0.124, 0.000),
        (1.135, 0.182, 0.133, 0.129, -0.002),
        (1.225, 0.192, 0.142, 0.134, -0.003),
        (1.310, 0.188, 0.144, 0.134, -0.003),
        (1.368, 0.164, 0.132, 0.124, -0.001),
    ]
    for iz, (z, rx, ryf, ryb, yo) in enumerate(v_specs):
        ring, uv_r = [], []
        for iu in range(28):
            ang = 2.0 * math.pi * iu / 28
            ca, sa = math.cos(ang), math.sin(ang)
            ry = ryf if sa < 0 else ryb
            # Slight molded armor plate contour on chest/back
            plate = 0.007 * (abs(sa) ** 1.5) * (1.0 - 0.5 * abs(ca))
            # Armhole cutaway near top sides
            arm_cut = 0.018 * (abs(ca) ** 3) if iz >= 3 else 0.0
            ring.append((ca * (rx - arm_cut), yo + sa * (ry + plate), z))
            uv_r.append((iu / 28.0 * 3.0, iz * 0.65))
        vest_rings.append(ring)
        vest_uvs.append(uv_r)
    mb.add_uv_loft(vest_rings, vest_uvs, mat_vest, torso_w, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Padded vest shoulder straps connecting front & back carrier plates
    for sx in (-1.0, 1.0):
        strap_pts = [
            (sx * 0.105, -0.124, 1.355),
            (sx * 0.108, -0.072, 1.425),
            (sx * 0.110, 0.005, 1.448),
            (sx * 0.108, 0.082, 1.420),
            (sx * 0.102, 0.124, 1.355),
        ]
        mb.add_tube(strap_pts, 0.022, mat_vest, {"Chest": 0.90, "Spine": 0.10}, segments=8)

    # Subtle Catalan crimson & metallic reflective trim stripe across upper chest & back
    mb.add_box((0.0, -0.145, 1.298), (0.280, 0.012, 0.012), mat_catalan_red, torso_w, bevel=0.002)
    mb.add_box((0.0, 0.136, 1.305), (0.260, 0.012, 0.014), mat_catalan_red, torso_w, bevel=0.002)
    # Metallic SECURION nameplate (right chest -X) & sculpted Securion shield badge (left chest +X)
    mb.add_box((-0.078, -0.146, 1.326), (0.064, 0.010, 0.018), mat_silver, {"Chest": 1.0}, bevel=0.002)
    # Left-chest shield badge (gold outer shield + silver star center)
    mb.add_box((0.082, -0.148, 1.328), (0.044, 0.012, 0.052), mat_gold, {"Chest": 1.0}, bevel=0.004, taper_bottom=(0.68, 1.0))
    mb.add_cylinder((0.082, -0.154, 1.331), 0.014, 0.014, 0.006, mat_silver, {"Chest": 1.0}, segments=8, rot=(math.pi * 0.5, 0.0, 0.0))

    # Front vest tactical utility pockets, Molle loops & center zipper
    mb.add_box((0.0, -0.145, 1.215), (0.016, 0.012, 0.275), mat_sole, torso_w, bevel=0.002)
    for sx in (-1.0, 1.0):
        # Lower tactical chest/abdomen cargo pockets with beveled flaps
        mb.add_box((sx * 0.086, -0.148, 1.148), (0.092, 0.032, 0.102), mat_vest, torso_w, bevel=0.007)
        mb.add_box((sx * 0.086, -0.160, 1.186), (0.094, 0.016, 0.034), mat_vest, torso_w, rot=(0.12, 0.0, 0.0), bevel=0.004)
        # Side retention straps with matte buckles
        for sz in (1.125, 1.195):
            mb.add_box((sx * 0.184, 0.0, sz), (0.022, 0.110, 0.024), mat_leather, torso_w, bevel=0.003)
            mb.add_box((sx * 0.193, -0.020, sz), (0.014, 0.030, 0.028), mat_sole, torso_w, bevel=0.002)
    # Back upper tactical panel patch
    mb.add_box((0.0, 0.138, 1.268), (0.210, 0.014, 0.056), mat_vest, {"Chest": 0.9, "Spine": 0.1}, bevel=0.004)

    # --- 4. Shoulder Lapel Radio Speaker-Mic (Left Strap +X) & Coiled Cable to Hip Radio ---
    mic_pos = Vector((0.118, -0.126, 1.388))
    mb.add_box(mic_pos, (0.044, 0.028, 0.066), mat_vest, {"Chest": 1.0}, rot=(-0.20, 0.12, -0.16), bevel=0.006)
    # Speaker grille indent + silver clip + tiny green status LED + red PTT button
    mb.add_box(mic_pos + Vector((0.0, -0.014, 0.006)), (0.032, 0.006, 0.036), mat_sole, {"Chest": 1.0}, rot=(-0.20, 0.12, -0.16), bevel=0.002)
    mb.add_box(mic_pos + Vector((0.022, -0.002, 0.004)), (0.008, 0.014, 0.026), mat_catalan_red, {"Chest": 1.0}, bevel=0.002)
    mb.add_sphere(mic_pos + Vector((-0.012, -0.015, 0.022)), 0.0032, mat_radio_led, {"Chest": 1.0}, segments=6, rings=5)

    # Coiled radio cord looping down left flank from shoulder mic to hip radio
    cord_pts = []
    for k in range(20):
        t = k / 19.0
        cx = 0.125 + 0.085 * smoothstep(0.0, 0.75, t) + 0.005 * math.sin(t * 28.0)
        cy = -0.122 + 0.115 * smoothstep(0.05, 0.95, t) + 0.005 * math.cos(t * 28.0)
        cz = 1.356 - 0.340 * t
        cord_pts.append((cx, cy, cz))
    mb.add_tube(cord_pts, 0.0040, mat_sole, torso_w, segments=5)

    # --- 5. Heavy Duty Belt, Holster, Belt Pouches & Hip Radio ---
    # Basketweave leather duty belt around waist/hip (z=1.015)
    belt_rings, belt_uvs = [], []
    for iz, bz in enumerate((0.986, 1.044)):
        ring, uv_r = [], []
        for iu in range(28):
            ang = 2.0 * math.pi * iu / 28
            ca, sa = math.cos(ang), math.sin(ang)
            ring.append((ca * 0.184, 0.003 + sa * 0.128, bz))
            uv_r.append((iu / 28.0 * 4.5, iz * 0.45))
        belt_rings.append(ring)
        belt_uvs.append(uv_r)
    mb.add_uv_loft(belt_rings, belt_uvs, mat_leather, belt_w, closed_u=True, cap_start=False, cap_end=False, smooth=False)
    # Metallic double-prong tactical buckle at front center
    mb.add_box((0.0, -0.130, 1.015), (0.068, 0.020, 0.064), mat_silver, belt_w, bevel=0.005)
    mb.add_box((0.0, -0.136, 1.015), (0.044, 0.012, 0.044), mat_sole, belt_w, bevel=0.003)
    # 4 leather belt keepers
    for kx, ky in [(0.11, -0.105), (-0.11, -0.105), (0.11, 0.110), (-0.11, 0.110)]:
        mb.add_box((kx, ky, 1.015), (0.020, 0.020, 0.068), mat_leather, belt_w, bevel=0.003)

    # Right hip (-X): Molded duty holster + secured sidearm grip
    mb.add_box((-0.194, -0.008, 0.945), (0.056, 0.088, 0.165), mat_leather, {"Hips": 0.90, "UpperLeg_R": 0.10}, rot=(0.06, -0.06, 0.0), bevel=0.012, taper_bottom=(0.76, 0.72))
    # Contoured polymer sidearm grip emerging from holster top
    mb.add_box((-0.195, 0.024, 1.032), (0.032, 0.068, 0.068), mat_sole, {"Hips": 0.92, "Spine": 0.08}, rot=(-0.38, 0.0, 0.0), bevel=0.007)

    # Left hip (+X): Handheld patrol radio unit + whip antenna
    mb.add_box((0.202, -0.005, 1.010), (0.046, 0.066, 0.128), mat_vest, belt_w, bevel=0.008)
    mb.add_cylinder((0.205, -0.022, 1.132), 0.0045, 0.0032, 0.125, mat_sole, belt_w, segments=6)
    mb.add_cylinder((0.204, 0.010, 1.082), 0.009, 0.009, 0.018, mat_silver, belt_w, segments=8)

    # Front-left dual magazine/tool pouch & rear-right handcuff case
    mb.add_box((0.125, -0.118, 1.005), (0.072, 0.038, 0.095), mat_leather, belt_w, rot=(0.0, 0.0, 0.45), bevel=0.008)
    mb.add_box((-0.120, 0.112, 1.005), (0.084, 0.042, 0.088), mat_leather, belt_w, rot=(0.0, 0.0, -0.45), bevel=0.012)

    # --- 6. Sculpted Arms, Articulated Hands & Tactical Flashlight ---
    add_sculpted_sleeve_arm(mb, sh_l, el_l, wr_l, +1.0, mat_shirt, mat_trousers, mat_skin, "Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L", "Chest", sleeve_bulk=1.02)
    add_sculpted_sleeve_arm(mb, sh_r, el_r, wr_r, -1.0, mat_shirt, mat_trousers, mat_skin, "Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R", "Chest", sleeve_bulk=1.02)

    add_sculpted_hand(mb, wr_l, +1.0, mat_skin, "Hand_L", "LowerArm_L", grip_flashlight=False)
    actual_fl_pos = add_sculpted_hand(mb, wr_r, -1.0, mat_skin, "Hand_R", "LowerArm_R", grip_flashlight=True)

    # Detailed CNC-machined anodized aluminum tactical flashlight skinned 100% to Flashlight bone!
    # Barrel runs straight along -Y (glTF +Z) so beam shoots straight out the lens!
    fl_w = {"Flashlight": 1.0}
    rot_y_fwd = (math.pi * 0.5, 0.0, 0.0)
    # Tailcap + rubber click button (+Y rear end)
    mb.add_cylinder(actual_fl_pos + Vector((0, 0.082, 0)), 0.0175, 0.0185, 0.032, mat_torch, fl_w, segments=16, rot=rot_y_fwd)
    mb.add_cylinder(actual_fl_pos + Vector((0, 0.099, 0)), 0.011, 0.011, 0.008, mat_sole, fl_w, segments=12, rot=rot_y_fwd)
    # Main knurled grip barrel
    mb.add_cylinder(actual_fl_pos + Vector((0, 0.000, 0)), 0.0165, 0.0165, 0.135, mat_torch, fl_w, segments=16, rot=rot_y_fwd)
    # Cooling fin collar rings around bezel neck
    for fy in (-0.074, -0.084, -0.094):
        mb.add_cylinder(actual_fl_pos + Vector((0, fy, 0)), 0.022, 0.022, 0.0055, mat_torch, fl_w, segments=16, rot=rot_y_fwd)
    # Flared tactical strike bezel head
    mb.add_cylinder(actual_fl_pos + Vector((0, -0.118, 0)), 0.020, 0.029, 0.044, mat_torch, fl_w, segments=18, rot=rot_y_fwd)
    # Metallic bezel rim & glowing emissive glass lens pointing -Y (glTF +Z)
    mb.add_cylinder(actual_fl_pos + Vector((0, -0.141, 0)), 0.0295, 0.0285, 0.007, mat_silver, fl_w, segments=18, rot=rot_y_fwd)
    mb.add_cylinder(actual_fl_pos + Vector((0, -0.142, 0)), 0.0245, 0.0245, 0.005, mat_lens, fl_w, segments=18, rot=rot_y_fwd)

    # --- 7. Anatomically Sculpted Guard Head, Short Cropped Hair, Sleek Peaked Cap & Acoustic Ear-Coil ---
    lm = add_sculpted_human_head(
        mb,
        neck_base_z=1.448,
        head_height=0.312,
        skin_mat=mat_face,
        eye_mat=mat_eye,
        hair_mat=mat_hair,
        jaw_strength=1.15,
        cheek_width=1.04,
        nose_prominence=1.08,
    )

    # Short-cropped security hair hugging temples, sides & nape below cap band
    hair_rings, hair_uvs = [], []
    h_specs = [
        (lm["ear_z"] - 0.022, 0.072, 0.092, 0.018),
        (lm["ear_z"] + 0.012, 0.083, 0.100, 0.014),
        (lm["brow_z"] + 0.018, 0.085, 0.103, 0.008),
        (lm["crown_z"] - 0.014, 0.070, 0.086, 0.005),
    ]
    for iz, (hz, rx, ry, yo) in enumerate(h_specs):
        ring, uv_r = [], []
        for iu in range(18):
            t = iu / 17.0
            ang = math.pi * 0.34 + t * math.pi * 1.32
            hx = math.sin(ang) * rx
            hy = -math.cos(ang) * ry + yo
            hz_pt = hz + 0.018 if (iz == 0 and abs(ang - math.pi) > 1.25) else hz
            ring.append((hx, hy, hz_pt))
            uv_r.append((t * 2.5, iz * 0.5))
        hair_rings.append(ring)
        hair_uvs.append(uv_r)
    mb.add_uv_loft(hair_rings, hair_uvs, mat_hair, {"Head": 1.0}, closed_u=False, cap_start=False, cap_end=False, smooth=True)

    # Acoustic Translucent Ear-Coil on Right Ear (-X) curving cleanly behind jaw into collar
    ex = -lm["ear_x"] - 0.004
    ey = lm["ear_y"] + 0.004
    ez = lm["ear_z"] - 0.004
    mb.add_sphere((ex + 0.004, ey - 0.002, ez), 0.0052, mat_sole, {"Head": 1.0}, segments=6, rings=5)
    coil_pts = []
    for k in range(22):
        t = k / 21.0
        cx = ex - 0.003 + 0.013 * smoothstep(0.3, 1.0, t) + 0.0042 * math.sin(t * 36.0)
        cy = ey + 0.014 * math.sin(t * math.pi) + 0.010 * t + 0.0042 * math.cos(t * 36.0)
        cz = ez - 0.145 * t
        coil_pts.append((cx, cy, cz))
    mb.add_tube(coil_pts, 0.0022, mat_earcoil, lambda c: blend_2bones(smoothstep(1.47, 1.56, c.z), "Chest", "Head"), segments=5)

    # Sleek European Peaked Security Patrol Cap (sits snugly above Loomis brows -> 1.800m!)
    cap_base_z = lm["brow_z"] + 0.012
    band_rings, band_uvs = [], []
    for iz, (dz, rx, ry, tilt_y) in enumerate([
        (0.000, 0.086, 0.105, 0.004),
        (0.022, 0.088, 0.107, 0.006),
    ]):
        ring, uv_r = [], []
        for iu in range(20):
            ang = 2.0 * math.pi * iu / 20
            ring.append((math.sin(ang) * rx, -math.cos(ang) * ry + tilt_y, cap_base_z + dz + math.cos(ang) * 0.006))
            uv_r.append((iu / 20.0 * 3.0, iz * 0.4))
        band_rings.append(ring)
        band_uvs.append(uv_r)
    mb.add_uv_loft(band_rings, band_uvs, mat_leather, {"Head": 1.0}, closed_u=True, cap_start=False, cap_end=False, smooth=True)

    crown_rings, crown_uvs = [], []
    c_specs = [
        (0.021, 0.088, 0.107, 0.006, 0.006),
        (0.048, 0.098, 0.117, 0.004, 0.011),
        (0.070, 0.101, 0.120, 0.002, 0.014),
        (0.080, 0.080, 0.098, 0.002, 0.010),
        (0.084, 0.032, 0.042, 0.002, 0.006),
    ]
    for iz, (dz, rx, ry, yo, front_lift) in enumerate(c_specs):
        ring, uv_r = [], []
        for iu in range(20):
            ang = 2.0 * math.pi * iu / 20
            ca, sa = math.cos(ang), math.sin(ang)
            z_pt = min(1.800, cap_base_z + dz + ca * front_lift)
            ring.append((sa * rx, -ca * ry + yo, z_pt))
            uv_r.append((iu / 20.0 * 3.0, iz * 0.45))
        crown_rings.append(ring)
        crown_uvs.append(uv_r)
    mb.add_uv_loft(crown_rings, crown_uvs, mat_shirt, {"Head": 1.0}, closed_u=True, cap_start=False, cap_end=True, smooth=True)

    # Glossy curved patent-leather cap visor/brim sweeping over brow (-Y forward)
    visor_rings, visor_uvs = [], []
    for ir, (rad_ext, z_drop) in enumerate([(0.000, 0.002), (0.036, -0.010), (0.062, -0.022)]):
        ring, uv_r = [], []
        for iu in range(15):
            t = iu / 14.0
            ang = -math.pi * 0.42 + t * math.pi * 0.84
            arc_scale = math.cos(ang * 1.12)
            r_x = 0.086 + rad_ext * 0.62 * max(0.0, arc_scale)
            r_y = 0.104 + rad_ext * max(0.0, arc_scale)
            ring.append((math.sin(ang) * r_x, -math.cos(ang) * r_y + 0.004, cap_base_z + 0.006 + z_drop * max(0.0, arc_scale)))
            uv_r.append((t, ir * 0.5))
        visor_rings.append(ring)
        visor_uvs.append(uv_r)
    mb.add_uv_loft(visor_rings, visor_uvs, mat_visor, {"Head": 1.0}, closed_u=False, smooth=True)
    visor_bot = [[(x, y, z - 0.005) for (x, y, z) in r] for r in visor_rings]
    mb.add_uv_loft(visor_bot, visor_uvs, mat_visor, {"Head": 1.0}, closed_u=False, smooth=True, flip_normals=True)
    mb.add_tube(visor_rings[-1], 0.0032, mat_visor, {"Head": 1.0}, segments=5)

    # Braided metallic chin-cord & sculpted Securion cap badge crest
    cord_cap = [
        (math.sin(-math.pi * 0.45 + (k / 10.0) * math.pi * 0.90) * 0.090,
         -math.cos(-math.pi * 0.45 + (k / 10.0) * math.pi * 0.90) * 0.109 + 0.004,
         cap_base_z + 0.013 + math.cos(-math.pi * 0.45 + (k / 10.0) * math.pi * 0.90) * 0.006)
        for k in range(11)
    ]
    mb.add_tube(cord_cap, 0.0034, mat_gold, {"Head": 1.0}, segments=5)
    for sx in (-1.0, 1.0):
        mb.add_sphere((sx * 0.088, -0.010, cap_base_z + 0.014), 0.005, mat_gold, {"Head": 1.0}, segments=6, rings=5)

    badge_z = cap_base_z + 0.048
    # Clean centered Catalan/Securion metallic shield + gold star + crimson enamel crest (zero clipping!)
    mb.add_box((0.0, -0.116, badge_z), (0.032, 0.007, 0.036), mat_silver, {"Head": 1.0}, rot=(-0.16, 0.0, 0.0), bevel=0.003, bevel_segments=1, taper_bottom=(0.68, 1.0))
    mb.add_cylinder((0.0, -0.121, badge_z + 0.001), 0.012, 0.012, 0.004, mat_gold, {"Head": 1.0}, segments=8, rot=(math.pi * 0.5 - 0.16, 0.0, 0.0))
    mb.add_cylinder((0.0, -0.1235, badge_z + 0.001), 0.0068, 0.0068, 0.003, mat_catalan_red, {"Head": 1.0}, segments=8, rot=(math.pi * 0.5 - 0.16, 0.0, 0.0))

    guard_mesh = mb.finalize_skinned("Guard_Mesh", arm_obj)

    # --- 8. Author All 6 Baked Looping Guard Animations ---

    # Clip 1: Idle (weight shift, calm breathing, attentive head scan, flashlight ready)
    def anim_idle(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        shift = math.sin(w)
        breath = math.sin(w * 2.0)
        scan = math.sin(w) * 14.0 + math.sin(w * 2.0) * 5.0
        pb["Hips"].location = (shift * 0.012, 0.0, breath * 0.004)
        _set_rot(pb, "Hips", 0.0, shift * 2.0, -shift * 1.4)
        _set_rot(pb, "Spine", 1.5 + breath * 1.0, -shift * 1.5, shift * 1.2)
        _set_rot(pb, "Chest", 1.0 + breath * 1.4, scan * 0.18, shift * 0.8)
        _set_rot(pb, "Neck", -1.0, scan * 0.35, 0.0)
        _set_rot(pb, "Head", 1.5 + math.sin(w * 2.0) * 2.0, scan * 0.65, -shift * 1.5)
        # Left arm relaxed near duty belt
        _set_rot(pb, "UpperArm_L", 4.0 + breath * 1.2, 0.0, -4.0)
        _set_rot(pb, "LowerArm_L", 16.0 + breath * 1.5, 0.0, 4.0)
        # Right arm holds flashlight at waist-chest ready height
        _set_rot(pb, "UpperArm_R", 14.0 + breath * 1.2, 0.0, 4.0)
        _set_rot(pb, "LowerArm_R", 28.0 + breath * 1.6, 0.0, -5.0)
        _set_rot(pb, "Hand_R", -26.0, scan * 0.25, 0.0)
        # Grounded legs subtly compensating hip shift
        _set_rot(pb, "UpperLeg_L", -1.5, 0.0, shift * 1.5)
        _set_rot(pb, "UpperLeg_R", -1.5, 0.0, shift * 1.5)

    # Clip 2: PatrolWalk (measured authoritative night patrol stride)
    def anim_patrol_walk(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        s = math.sin(w)
        c = math.cos(w)
        bob = abs(math.cos(w)) * 0.028 - 0.014
        pb["Hips"].location = (s * 0.014, 0.0, bob)
        _set_rot(pb, "Hips", 2.0, s * 6.5, -s * 2.2)
        _set_rot(pb, "Spine", 3.5, -s * 4.5, s * 1.6)
        _set_rot(pb, "Chest", 2.5, -s * 5.0, s * 1.2)
        _set_rot(pb, "Neck", -2.0, s * 3.0, 0.0)
        _set_rot(pb, "Head", -1.0, s * 4.0, 0.0)

        # Left leg & Right leg alternating stride with realistic knee flexion & ankle roll
        leg_l_swing = s * 25.0
        leg_r_swing = -s * 25.0
        knee_l = -max(0.0, -c) * 34.0 - 4.0
        knee_r = -max(0.0, c) * 34.0 - 4.0
        _set_rot(pb, "UpperLeg_L", leg_l_swing, 0.0, 1.0)
        _set_rot(pb, "LowerLeg_L", knee_l, 0.0, 0.0)
        _set_rot(pb, "Foot_L", -leg_l_swing * 0.45 - knee_l * 0.35 + c * 8.0, 0.0, 0.0)

        _set_rot(pb, "UpperLeg_R", leg_r_swing, 0.0, -1.0)
        _set_rot(pb, "LowerLeg_R", knee_r, 0.0, 0.0)
        _set_rot(pb, "Foot_R", -leg_r_swing * 0.45 - knee_r * 0.35 - c * 8.0, 0.0, 0.0)

        # Left arm counter-swings naturally; Right arm holds flashlight steadily forward!
        _set_rot(pb, "UpperArm_L", -s * 20.0, 0.0, -4.0)
        _set_rot(pb, "LowerArm_L", 16.0 + max(0.0, -s) * 14.0, 0.0, 3.0)

        _set_rot(pb, "UpperArm_R", 18.0 + s * 6.0, 0.0, 4.0)
        _set_rot(pb, "LowerArm_R", 34.0 - s * 4.0, 0.0, -6.0)
        _set_rot(pb, "Hand_R", -32.0 + s * 3.0, -s * 5.0, 0.0)

    # Clip 3: SuspiciousLook (pauses, leans forward, scans head & flashlight left and right)
    def anim_suspicious_look(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        # Smooth dwell left -> center -> right -> center
        sweep = math.sin(w) + 0.25 * math.sin(w * 3.0)
        pb["Hips"].location = (sweep * 0.015, -0.018, -0.022)
        _set_rot(pb, "Hips", 6.0, sweep * 5.0, 0.0)
        _set_rot(pb, "Spine", 9.0, sweep * 8.0, 0.0)
        _set_rot(pb, "Chest", 7.0, sweep * 12.0, -sweep * 2.5)
        _set_rot(pb, "Neck", -6.0, sweep * 12.0, 0.0)
        _set_rot(pb, "Head", -5.0 + math.sin(w * 2.0) * 3.0, sweep * 22.0, -sweep * 4.0)
        # Alert braced knees
        _set_rot(pb, "UpperLeg_L", 8.0, 0.0, -3.5)
        _set_rot(pb, "LowerLeg_L", -14.0, 0.0, 0.0)
        _set_rot(pb, "Foot_L", 6.0, 0.0, 0.0)
        _set_rot(pb, "UpperLeg_R", 5.0, 0.0, 3.5)
        _set_rot(pb, "LowerLeg_R", -12.0, 0.0, 0.0)
        _set_rot(pb, "Foot_R", 7.0, 0.0, 0.0)
        # Left hand hovers alertly near waist/belt
        _set_rot(pb, "UpperArm_L", 12.0, 0.0, -8.0)
        _set_rot(pb, "LowerArm_L", 34.0, 0.0, 12.0)
        # Right arm raises flashlight forward tracking suspicious sound/movement
        _set_rot(pb, "UpperArm_R", 34.0, -sweep * 14.0, 6.0)
        _set_rot(pb, "LowerArm_R", 42.0, 0.0, -10.0)
        _set_rot(pb, "Hand_R", -48.0, sweep * 18.0, 0.0)

    # Clip 4: FlashlightSweep (high-alert raised tactical flashlight sweeping dark corridor)
    def anim_flashlight_sweep(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        sweep = math.sin(w)
        vert_probe = math.sin(w * 2.0) * 8.0
        pb["Hips"].location = (sweep * 0.012, -0.012, -0.016)
        _set_rot(pb, "Hips", 4.0, sweep * 8.0, 0.0)
        _set_rot(pb, "Spine", 5.0, sweep * 10.0, 0.0)
        _set_rot(pb, "Chest", 4.0, sweep * 16.0, 0.0)
        _set_rot(pb, "Neck", -3.0, sweep * 10.0, 0.0)
        _set_rot(pb, "Head", -2.0 + vert_probe * 0.4, sweep * 22.0, -sweep * 3.0)
        # Planted knees
        _set_rot(pb, "UpperLeg_L", 6.0, 0.0, -3.0)
        _set_rot(pb, "LowerLeg_L", -12.0, 0.0, 0.0)
        _set_rot(pb, "Foot_L", 6.0, 0.0, 0.0)
        _set_rot(pb, "UpperLeg_R", 6.0, 0.0, 3.0)
        _set_rot(pb, "LowerLeg_R", -12.0, 0.0, 0.0)
        _set_rot(pb, "Foot_R", 6.0, 0.0, 0.0)
        # Left arm guards chest/holster readiness
        _set_rot(pb, "UpperArm_L", 16.0, 0.0, -6.0)
        _set_rot(pb, "LowerArm_L", 40.0, 0.0, 16.0)
        # Right arm raised high to shoulder/cheek tactical sweep position sweeping wide arc!
        _set_rot(pb, "Shoulder_R", 0.0, 0.0, 8.0)
        _set_rot(pb, "UpperArm_R", 64.0 + vert_probe * 0.6, -sweep * 20.0, 10.0 - sweep * 12.0)
        _set_rot(pb, "LowerArm_R", 46.0, 0.0, -14.0)
        _set_rot(pb, "Hand_R", -68.0 + vert_probe, sweep * 24.0, 0.0)

    # Clip 5: RadioCall (LEFT hand reaches up to left shoulder lapel mic; RIGHT hand holds flashlight ready!)
    def anim_radio_call(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        # Smooth ramp up to lapel mic, hold & talk with subtle urgent pulse, stay poised
        talk = math.sin(w * 3.0)
        reach = 0.85 + 0.15 * math.sin(w)
        pb["Hips"].location = (-0.010, 0.0, -0.014)
        _set_rot(pb, "Hips", 2.0, -6.0, 1.5)
        _set_rot(pb, "Spine", 3.0, -4.0, -2.0)
        _set_rot(pb, "Chest", 2.0, -5.0, -3.5)
        # Head tilts left & slightly down toward left shoulder lapel mic while scanning eyes forward!
        _set_rot(pb, "Neck", 6.0 + talk * 1.5, 10.0, -12.0)
        _set_rot(pb, "Head", 8.0 + talk * 2.0, 14.0 + math.sin(w) * 6.0, -10.0)
        # Planted alert stance
        _set_rot(pb, "UpperLeg_L", 6.0, 0.0, -2.5)
        _set_rot(pb, "LowerLeg_L", -10.0, 0.0, 0.0)
        _set_rot(pb, "Foot_L", 4.0, 0.0, 0.0)
        _set_rot(pb, "UpperLeg_R", -4.0, 0.0, 2.5)
        _set_rot(pb, "LowerLeg_R", -6.0, 0.0, 0.0)
        _set_rot(pb, "Foot_R", 6.0, 0.0, 0.0)
        # LEFT ARM reaches right up to left shoulder lapel mic (pressing PTT!)
        _set_rot(pb, "Shoulder_L", 6.0, 0.0, -6.0)
        _set_rot(pb, "UpperArm_L", 52.0 * reach, 18.0, 20.0 * reach)
        _set_rot(pb, "LowerArm_L", 108.0 * reach, 14.0, 34.0 * reach)
        _set_rot(pb, "Hand_L", 12.0, -10.0, 14.0)
        # RIGHT ARM holds tactical flashlight raised forward ready covering the threat!
        _set_rot(pb, "UpperArm_R", 44.0 + talk * 1.5, 0.0, 6.0)
        _set_rot(pb, "LowerArm_R", 42.0, 0.0, -8.0)
        _set_rot(pb, "Hand_R", -56.0, math.sin(w) * 12.0, 0.0)

    # Clip 6: Sprint (urgent pursuit run)
    def anim_sprint(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        s = math.sin(w)
        c = math.cos(w)
        bob = abs(math.cos(w)) * 0.055 - 0.032
        pb["Hips"].location = (s * 0.018, -0.025, bob)
        _set_rot(pb, "Hips", 14.0, s * 10.0, -s * 3.5)
        _set_rot(pb, "Spine", 11.0, -s * 8.0, s * 2.5)
        _set_rot(pb, "Chest", 8.0, -s * 10.0, s * 2.0)
        _set_rot(pb, "Neck", -14.0, s * 6.0, 0.0)
        _set_rot(pb, "Head", -12.0, s * 5.0, 0.0)

        leg_l = s * 44.0 + 8.0
        leg_r = -s * 44.0 + 8.0
        knee_l = -max(0.0, -c) * 68.0 - 12.0
        knee_r = -max(0.0, c) * 68.0 - 12.0
        _set_rot(pb, "UpperLeg_L", leg_l, 0.0, 1.0)
        _set_rot(pb, "LowerLeg_L", knee_l, 0.0, 0.0)
        _set_rot(pb, "Foot_L", -leg_l * 0.35 - knee_l * 0.30 + c * 14.0, 0.0, 0.0)

        _set_rot(pb, "UpperLeg_R", leg_r, 0.0, -1.0)
        _set_rot(pb, "LowerLeg_R", knee_r, 0.0, 0.0)
        _set_rot(pb, "Foot_R", -leg_r * 0.35 - knee_r * 0.30 - c * 14.0, 0.0, 0.0)

        # Powerful sprinting left arm pump; right arm pumps tightly keeping flashlight gripped forward
        _set_rot(pb, "UpperArm_L", -s * 42.0 + 10.0, 0.0, -8.0)
        _set_rot(pb, "LowerArm_L", 78.0 + max(0.0, -s) * 20.0, 0.0, 10.0)

        _set_rot(pb, "UpperArm_R", s * 24.0 + 26.0, 0.0, 8.0)
        _set_rot(pb, "LowerArm_R", 64.0 + max(0.0, s) * 14.0, 0.0, -10.0)
        _set_rot(pb, "Hand_R", -48.0, 0.0, 0.0)

    author_nla_clip(arm_obj, "Idle", 72, anim_idle)
    author_nla_clip(arm_obj, "PatrolWalk", 32, anim_patrol_walk)
    author_nla_clip(arm_obj, "SuspiciousLook", 60, anim_suspicious_look)
    author_nla_clip(arm_obj, "FlashlightSweep", 64, anim_flashlight_sweep)
    author_nla_clip(arm_obj, "RadioCall", 60, anim_radio_call)
    author_nla_clip(arm_obj, "Sprint", 20, anim_sprint)

    return _ground_and_export_character(arm_obj, guard_mesh, out_path, target_height=1.80)


# ---------------------------------------------------------------------------
# CHARACTER 2: Mediterranean Evening Promenade Civilian (1.75m)
# ---------------------------------------------------------------------------

def build_character_civilian(out_path: Path, tex_dir: Path) -> dict:
    reset_scene()

    mat_face = make_pbr_material(
        "Civ_FaceSkin", tex_dir,
        albedo_file="civilian_face_albedo.jpg",
        normal_file="skin_fine_normal.png",
        roughness_file="skin_fine_roughness.jpg",
        fallback_color="#D19F7E",
        roughness=0.47,
        normal_strength=0.32,
        specular_ior=0.44,
    )
    mat_skin = make_pbr_material(
        "Civ_SkinHands", tex_dir,
        albedo_file="skin_fine_albedo.jpg",
        normal_file="skin_fine_normal.png",
        roughness_file="skin_fine_roughness.jpg",
        fallback_color="#D19F7E",
        roughness=0.49,
        normal_strength=0.30,
        specular_ior=0.44,
    )
    mat_eye = make_pbr_material(
        "Civ_Eye", tex_dir,
        albedo_file="eye_iris_albedo.jpg",
        fallback_color="#4A3525",
        roughness=0.05,
        coat=1.0,
        coat_roughness=0.03,
        specular_ior=0.65,
    )
    mat_hair = make_pbr_material(
        "Civ_Hair", tex_dir,
        albedo_file="hair_dark_strands_albedo.jpg",
        normal_file="hair_dark_strands_normal.png",
        roughness_file="hair_dark_strands_roughness.jpg",
        fallback_color="#281E18",
        roughness=0.44,
        normal_strength=0.60,
    )
    mat_blazer = make_pbr_material(
        "Civ_LinenBlazer", tex_dir,
        albedo_file="blazer_linen_mediterranean_albedo.jpg",
        normal_file="blazer_linen_mediterranean_normal.png",
        roughness_file="blazer_linen_mediterranean_roughness.jpg",
        fallback_color="#4D4842",
        roughness=0.78,
        normal_strength=0.62,
    )
    mat_inner_shirt = make_pbr_material(
        "Civ_DarkShirt", tex_dir,
        albedo_file="tactical_vest_cordura_albedo.jpg",
        normal_file="uniform_navy_twill_normal.png",
        fallback_color="#181D26",
        roughness=0.76,
        normal_strength=0.32,
    )
    mat_chinos = make_pbr_material(
        "Civ_ChinosSand", tex_dir,
        albedo_file="chinos_sand_albedo.jpg",
        normal_file="blazer_linen_mediterranean_normal.png",
        roughness_file="blazer_linen_mediterranean_roughness.jpg",
        fallback_color="#8E7E66",
        roughness=0.78,
        normal_strength=0.48,
    )
    mat_suede = make_pbr_material(
        "Civ_SuedeLoafers", tex_dir,
        albedo_file="suede_brown_albedo.jpg",
        normal_file="leather_black_grain_normal.png",
        roughness_file="blazer_linen_mediterranean_roughness.jpg",
        fallback_color="#3E2A1E",
        roughness=0.68,
        normal_strength=0.48,
    )
    mat_sole = make_pbr_material(
        "Civ_LoaferSole", tex_dir,
        fallback_color="#D9D2C4",
        roughness=0.72,
    )
    mat_belt = make_pbr_material(
        "Civ_LeatherBelt", tex_dir,
        albedo_file="suede_brown_albedo.jpg",
        normal_file="leather_black_grain_normal.png",
        roughness_file="leather_black_grain_roughness.jpg",
        fallback_color="#382418",
        roughness=0.38,
        normal_strength=0.45,
    )
    mat_metal = make_pbr_material(
        "Civ_BrushedSteel", tex_dir,
        albedo_file="metal_anodized_brushed_albedo.jpg",
        fallback_color="#C8CFD8",
        tint=(2.2, 2.25, 2.3),
        metallic=0.90,
        roughness=0.24,
    )
    mat_button = make_pbr_material(
        "Civ_HornButton", tex_dir,
        fallback_color="#261F1B",
        roughness=0.32,
        coat=0.4,
    )

    # --- Anatomical Joint Coordinates (1.75m Mediterranean Civilian) ---
    hip_z = 0.915
    knee_z = 0.485
    ankle_z = 0.088
    shoulder_z = 1.362
    neck_z = 1.412
    head_pivot_z = 1.495

    hip_l = Vector((0.090, 0.0, hip_z))
    hip_r = Vector((-0.090, 0.0, hip_z))
    knee_l = Vector((0.086, -0.008, knee_z))
    knee_r = Vector((-0.086, -0.008, knee_z))
    ankle_l = Vector((0.090, 0.010, ankle_z))
    ankle_r = Vector((-0.090, 0.010, ankle_z))

    sh_l = Vector((0.178, 0.005, shoulder_z))
    el_l = Vector((0.214, 0.009, 1.092))
    wr_l = Vector((0.222, -0.032, 0.842))

    sh_r = Vector((-0.178, 0.005, shoulder_z))
    el_r = Vector((-0.214, 0.009, 1.092))
    wr_r = Vector((-0.222, -0.032, 0.842))

    fwd_vec = Vector((0.0, -1.0, 0.0))
    up_vec = Vector((0.0, 0.0, 1.0))

    joints = {
        "Root": (Vector((0, 0, 0)), Vector((0, 0, 0.18)), None, None),
        "Hips": (Vector((0, 0, hip_z)), Vector((0, 0, 1.03)), "Root", None),
        "Spine": (Vector((0, 0, 1.03)), Vector((0, 0, 1.20)), "Hips", None),
        "Chest": (Vector((0, 0, 1.20)), Vector((0, 0, neck_z)), "Spine", None),
        "Neck": (Vector((0, 0, neck_z)), Vector((0, 0, head_pivot_z)), "Chest", None),
        "Head": (Vector((0, 0, head_pivot_z)), Vector((0, 0, 1.72)), "Neck", None),
        "Shoulder_L": (Vector((0.070, 0.005, 1.375)), sh_l, "Chest", fwd_vec),
        "UpperArm_L": (sh_l, el_l, "Shoulder_L", fwd_vec),
        "LowerArm_L": (el_l, wr_l, "UpperArm_L", fwd_vec),
        "Hand_L": (wr_l, wr_l + Vector((0.0, -0.02, -0.095)), "LowerArm_L", fwd_vec),
        "Shoulder_R": (Vector((-0.070, 0.005, 1.375)), sh_r, "Chest", fwd_vec),
        "UpperArm_R": (sh_r, el_r, "Shoulder_R", fwd_vec),
        "LowerArm_R": (el_r, wr_r, "UpperArm_R", fwd_vec),
        "Hand_R": (wr_r, wr_r + Vector((0.0, -0.02, -0.095)), "LowerArm_R", fwd_vec),
        "UpperLeg_L": (hip_l, knee_l, "Hips", fwd_vec),
        "LowerLeg_L": (knee_l, ankle_l, "UpperLeg_L", fwd_vec),
        "Foot_L": (ankle_l, Vector((ankle_l.x, -0.160, 0.020)), "LowerLeg_L", up_vec),
        "UpperLeg_R": (hip_r, knee_r, "Hips", fwd_vec),
        "LowerLeg_R": (knee_r, ankle_r, "UpperLeg_R", fwd_vec),
        "Foot_R": (ankle_r, Vector((ankle_r.x, -0.160, 0.020)), "LowerLeg_R", up_vec),
    }

    arm_obj = create_humanoid_armature("CivilianArmature", joints)
    mb = CharacterMeshBuilder()

    def torso_w(co: Vector) -> WeightSpec:
        t_sp = smoothstep(0.94, 1.10, co.z)
        t_ch = smoothstep(1.15, 1.29, co.z)
        return normalize_weights({
            "Hips": 1.0 - t_sp,
            "Spine": t_sp * (1.0 - t_ch),
            "Chest": t_ch,
        })

    # --- 1. Pelvis & Slim-Tailored Mediterranean Chinos + Suede Coastal Loafers ---
    pelv_rings, pelv_uvs = [], []
    for iz, (z, rx, ry, dy) in enumerate([
        (0.840, 0.150, 0.104, 0.004),
        (0.890, 0.162, 0.110, 0.005),
        (0.945, 0.162, 0.108, 0.004),
        (0.992, 0.156, 0.104, 0.002),
    ]):
        ring, uv_r = [], []
        for iu in range(20):
            ang = 2.0 * math.pi * iu / 20
            ca, sa = math.cos(ang), math.sin(ang)
            crotch = 0.011 * (abs(sa) ** 4) if iz == 0 else 0.0
            ring.append((ca * rx, dy + sa * (ry - crotch), z))
            uv_r.append((iu / 20.0 * 2.4, iz * 0.45))
        pelv_rings.append(ring)
        pelv_uvs.append(uv_r)
    mb.add_uv_loft(pelv_rings, pelv_uvs, mat_chinos, {"Hips": 0.90, "Spine": 0.10}, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    add_sculpted_trouser_leg(mb, hip_l, knee_l, ankle_l + Vector((0, 0, 0.016)), +1.0, mat_chinos, "Hips", "UpperLeg_L", "LowerLeg_L", "Foot_L", pressed_crease=False, taper=0.88)
    add_sculpted_trouser_leg(mb, hip_r, knee_r, ankle_r + Vector((0, 0, 0.016)), -1.0, mat_chinos, "Hips", "UpperLeg_R", "LowerLeg_R", "Foot_R", pressed_crease=False, taper=0.88)
    # Neat folded chino ankle cuffs
    for sx, ank in [(+1.0, ankle_l), (-1.0, ankle_r)]:
        mb.add_cylinder((ank.x, ank.y, 0.114), 0.052, 0.053, 0.030, mat_chinos, {"LowerLeg_L" if sx > 0 else "LowerLeg_R": 0.9, "Foot_L" if sx > 0 else "Foot_R": 0.1}, segments=16)

    add_coastal_loafer(mb, ankle_l, +1.0, mat_suede, mat_sole, mat_skin, "LowerLeg_L", "Foot_L")
    add_coastal_loafer(mb, ankle_r, -1.0, mat_suede, mat_sole, mat_skin, "LowerLeg_R", "Foot_R")

    # Leather dress belt + brushed steel buckle
    belt_rings, belt_uvs = [], []
    for iz, bz in enumerate((0.968, 1.004)):
        ring, uv_r = [], []
        for iu in range(24):
            ang = 2.0 * math.pi * iu / 24
            ring.append((math.cos(ang) * 0.166, 0.002 + math.sin(ang) * 0.114, bz))
            uv_r.append((iu / 24.0 * 4.0, iz * 0.4))
        belt_rings.append(ring)
        belt_uvs.append(uv_r)
    mb.add_uv_loft(belt_rings, belt_uvs, mat_belt, {"Hips": 0.78, "Spine": 0.22}, closed_u=True, smooth=False)
    mb.add_box((0.0, -0.115, 0.986), (0.044, 0.014, 0.040), mat_metal, {"Hips": 0.78, "Spine": 0.22}, bevel=0.004)

    # --- 2. Inner Dark Knit Crewneck Shirt ---
    shirt_rings, shirt_uvs = [], []
    for iz, (z, rx, ryf, ryb, yo) in enumerate([
        (0.985, 0.155, 0.104, 0.106, 0.002),
        (1.075, 0.156, 0.106, 0.106, 0.001),
        (1.185, 0.172, 0.116, 0.112, -0.001),
        (1.295, 0.184, 0.120, 0.116, -0.002),
        (1.375, 0.172, 0.102, 0.104, 0.003),
        (1.415, 0.088, 0.068, 0.072, 0.004),
    ]):
        ring, uv_r = [], []
        for iu in range(24):
            ang = 2.0 * math.pi * iu / 24
            ca, sa = math.cos(ang), math.sin(ang)
            ry = ryf if sa < 0 else ryb
            ring.append((ca * rx, yo + sa * ry, z))
            uv_r.append((iu / 24.0 * 3.0, (z - 0.985) * 4.0))
        shirt_rings.append(ring)
        shirt_uvs.append(uv_r)
    mb.add_uv_loft(shirt_rings, shirt_uvs, mat_inner_shirt, torso_w, closed_u=True, cap_start=True, cap_end=True, smooth=True)
    # Crewneck ribbed collar band
    mb.add_cylinder((0.0, 0.004, 1.418), 0.070, 0.066, 0.022, mat_inner_shirt, {"Chest": 0.75, "Neck": 0.25}, segments=18)

    # --- 3. Sculpted Tailored Mediterranean Linen-Cotton Casual Blazer (Natural Sloped Shoulders + Zero Poke-Through!) ---
    blazer_rings, blazer_uvs = [], []
    b_specs = [
        (0.760, 0.204, 0.136, 0.144, 0.46, 0.007),
        (0.848, 0.198, 0.132, 0.139, 0.39, 0.006),
        (0.945, 0.184, 0.124, 0.129, 0.32, 0.005),
        (1.045, 0.178, 0.120, 0.122, 0.28, 0.002),
        (1.155, 0.186, 0.126, 0.124, 0.36, 0.000),
        (1.270, 0.194, 0.128, 0.124, 0.46, -0.001),
        (1.352, 0.190, 0.116, 0.116, 0.58, 0.001),
        (1.398, 0.146, 0.092, 0.096, 0.78, 0.004),
    ]
    n_bu = 24
    for iz, (z, rx, ryf, ryb, gap, yo) in enumerate(b_specs):
        ring, uv_r = [], []
        a_start = -math.pi * 0.5 + gap
        a_end = math.pi * 1.5 - gap
        for iu in range(n_bu):
            t = iu / (n_bu - 1)
            ang = a_start + t * (a_end - a_start)
            ca, sa = math.cos(ang), math.sin(ang)
            ry = ryf if sa < 0 else ryb
            drape = 0.003 * math.sin(ang * 5.0) * smoothstep(1.10, 0.76, z)
            ring.append((ca * (rx + drape), yo + sa * (ry + drape), z))
            uv_r.append((t * 3.2, (z - 0.760) * 3.8))
        blazer_rings.append(ring)
        blazer_uvs.append(uv_r)

    def blazer_w(co: Vector) -> WeightSpec:
        if co.z < 0.92:
            t_leg = smoothstep(0.92, 0.74, co.z) * 0.35
            leg_b = "UpperLeg_L" if co.x >= 0 else "UpperLeg_R"
            return normalize_weights({"Hips": 1.0 - t_leg, leg_b: t_leg})
        return torso_w(co)

    mb.add_uv_loft(blazer_rings, blazer_uvs, mat_blazer, blazer_w, closed_u=False, smooth=True)
    blazer_inner = [[(x * 0.968, y * 0.968, z) for (x, y, z) in r] for r in blazer_rings]
    mb.add_uv_loft(blazer_inner, blazer_uvs, mat_blazer, blazer_w, closed_u=False, smooth=True, flip_normals=True)
    left_edge = [r[0] for r in blazer_rings]
    right_edge = [r[-1] for r in blazer_rings]
    mb.add_tube(left_edge, 0.0065, mat_blazer, blazer_w, segments=5)
    mb.add_tube(right_edge, 0.0065, mat_blazer, blazer_w, segments=5)
    mb.add_tube(blazer_rings[0], 0.0060, mat_blazer, blazer_w, segments=5)

    # Flat Tailored Notched Lapels (sculpted flat ribbon strips hugging blazer chest — NOT fat sausages!)
    for sx in (-1.0, 1.0):
        l_inner = [
            (sx * 0.048, -0.122, 1.060),
            (sx * 0.068, -0.128, 1.165),
            (sx * 0.088, -0.126, 1.275),
            (sx * 0.082, -0.098, 1.365),
            (sx * 0.064, -0.025, 1.408),
            (sx * 0.040, 0.062, 1.415),
        ]
        l_outer = [
            (sx * 0.064, -0.124, 1.065),
            (sx * 0.106, -0.122, 1.175),
            (sx * 0.132, -0.114, 1.275),
            (sx * 0.116, -0.086, 1.358),
            (sx * 0.090, -0.018, 1.404),
            (sx * 0.056, 0.072, 1.412),
        ]
        l_uvs = [[(0.0, i * 0.25) for i in range(6)], [(0.3, i * 0.25) for i in range(6)]]
        # Transpose so loft connects inner & outer strip edges cleanly
        lap_rings = [[l_inner[i], l_outer[i]] for i in range(6)]
        lap_uvs = [[(0.0, i * 0.35), (0.4, i * 0.35)] for i in range(6)]
        mb.add_uv_loft(lap_rings, lap_uvs, mat_blazer, torso_w, closed_u=False, smooth=True, flip_normals=(sx > 0))
    # Back blazer collar connecting left & right lapels cleanly around neck
    mb.add_tube([(0.052, 0.062, 1.415), (0.0, 0.080, 1.420), (-0.052, 0.062, 1.415)], 0.012, mat_blazer, {"Chest": 0.85, "Neck": 0.15}, segments=6)

    # Clean low-profile chest welt pocket & front-side blazer hip pocket flaps (strictly front-facing!)
    mb.add_box((0.094, -0.124, 1.235), (0.058, 0.010, 0.014), mat_blazer, {"Chest": 1.0}, rot=(0.0, 0.0, 0.28), bevel=0.002, bevel_segments=1)
    for sx in (-1.0, 1.0):
        mb.add_box((sx * 0.115, -0.110, 0.895), (0.064, 0.010, 0.022), mat_blazer, blazer_w, rot=(0.0, 0.0, sx * 0.42), bevel=0.002, bevel_segments=1)
    for bz in (1.035, 0.960):
        mb.add_cylinder((-0.052, -0.122, bz), 0.008, 0.008, 0.004, mat_button, torso_w, segments=8, rot=(math.pi * 0.5, 0.0, 0.0))

    # --- 4. Sculpted Blazer Sleeves, Articulated Hands & Wristwatch ---
    add_sculpted_sleeve_arm(mb, sh_l, el_l, wr_l, +1.0, mat_blazer, mat_blazer, mat_skin, "Shoulder_L", "UpperArm_L", "LowerArm_L", "Hand_L", "Chest", sleeve_bulk=0.92, show_cuff_band=False)
    add_sculpted_sleeve_arm(mb, sh_r, el_r, wr_r, -1.0, mat_blazer, mat_blazer, mat_skin, "Shoulder_R", "UpperArm_R", "LowerArm_R", "Hand_R", "Chest", sleeve_bulk=0.92, show_cuff_band=False)
    add_sculpted_hand(mb, wr_l, +1.0, mat_skin, "Hand_L", "LowerArm_L", grip_flashlight=False)
    add_sculpted_hand(mb, wr_r, -1.0, mat_skin, "Hand_R", "LowerArm_R", grip_flashlight=False)

    # Sleek stainless wristwatch on left wrist (+X)
    mb.add_cylinder(wr_l + Vector((0.0, 0.005, 0.020)), 0.032, 0.032, 0.015, mat_belt, {"LowerArm_L": 0.6, "Hand_L": 0.4}, segments=12)
    mb.add_cylinder(wr_l + Vector((0.027, -0.006, 0.020)), 0.014, 0.014, 0.008, mat_metal, {"LowerArm_L": 0.6, "Hand_L": 0.4}, segments=10, rot=(0.0, math.pi * 0.5, 0.0))

    # --- 5. Anatomically Sculpted Mediterranean Civilian Head & Organic Sculpted Hair (ZERO Tubes!) ---
    lm = add_sculpted_human_head(
        mb,
        neck_base_z=1.404,
        head_height=0.306,
        skin_mat=mat_face,
        eye_mat=mat_eye,
        hair_mat=mat_hair,
        jaw_strength=0.96,
        cheek_width=1.00,
        nose_prominence=1.02,
    )

    # Natural handsome Mediterranean short-medium side-parted hairstyle with proper temples & sideburns!
    # Built by exact radial outward offset from head skull (zero scalp poke-through, zero tall fez silhouette!)
    h_rings, h_uvs = [], []
    n_hu = 36
    n_hv = 16
    head_z0 = lm["neck_base_z"]
    head_span = 0.306
    for iv in range(n_hv):
        tv = iv / (n_hv - 1)  # 0 = lower hairline rim, 1 = crown apex
        ring, uv_r = [], []
        for iu in range(n_hu):
            u = iu / n_hu
            theta = (u - 0.5) * 2.0 * math.pi  # 0 = center forehead (-Y), +/-pi = back nape (+Y)
            sin_t = math.sin(theta)
            cos_t = math.cos(theta)
            abs_t = abs(theta)

            # Natural adult male hairline in head parametric v-space:
            # - Asymmetric soft side-swept forehead (v ~ 0.725..0.755)
            # - Natural masculine temple recession around |theta| ~ 0.65
            # - Proper hair coverage coming DOWN the temples into neat sideburns in front of ears (|theta| ~ 1.18 -> v ~ 0.52)
            # - Arches cleanly over the ears (|theta| ~ 1.55 -> v ~ 0.60) and tapers down into neat nape (v ~ 0.36)!
            front_w = 0.5 + 0.5 * cos_t
            # Base curve from nape (0.37) to forehead (0.73)
            v_base = 0.37 + 0.36 * (front_w ** 0.90)
            # Gentle asymmetric side-swept fringe wave across forehead
            fringe_wave = -0.022 * gauss(theta, -0.18, 0.38) + 0.018 * gauss(theta, 0.42, 0.24)
            # Proper temple & sideburn drop right in front of ears (|theta| ~ 1.18)
            sideburn_drop = -0.135 * gauss(abs_t, 1.16, 0.22)
            # Clean arch right over ear helix (|theta| ~ 1.56)
            ear_arch = 0.075 * gauss(abs_t, 1.56, 0.18)
            v_hairline = clamp(v_base + fringe_wave + sideburn_drop + ear_arch, 0.34, 0.78)

            v_skull = v_hairline + (0.988 - v_hairline) * tv

            # Exact skull cross-section radius at v_skull
            if v_skull < 0.68:
                t_m = (v_skull - 0.27) / 0.41
                s_rx = 0.060 + 0.018 * (max(0.0, t_m) ** 0.72)
                s_ryf = 0.095 + 0.002 * math.sin(max(0.0, t_m) * math.pi)
                s_ryb = 0.068 + 0.032 * smoothstep(0.0, 0.85, t_m)
                s_ys = 0.004 * max(0.0, t_m)
            else:
                t_d = clamp((v_skull - 0.68) / 0.32, 0.0, 1.0)
                dome = math.sqrt(max(0.0, 1.0 - (t_d ** 1.85)))
                s_rx = 0.077 * dome + 0.003 * (1.0 - dome)
                s_ryf = 0.094 * dome + 0.003 * (1.0 - dome)
                s_ryb = 0.100 * dome + 0.003 * (1.0 - dome)
                s_ys = 0.004 * (1.0 - t_d)

            # Natural low-profile tailored hair thickness (hugs sides tightly, natural subtle volume on crown — NO tall fez!)
            feather = smoothstep(0.0, 0.22, tv)
            crown_zone = smoothstep(0.72, 0.94, v_skull)
            side_sweep = 0.0055 * gauss(theta, -0.22, 0.78) * smoothstep(0.15, 0.72, tv) * (1.0 - 0.75 * gauss(theta, 0.48, 0.18))
            wave = 0.0018 * math.sin(theta * 15.0 - tv * 5.0) * math.sin(tv * math.pi)
            thick_r = (0.0038 + 0.0045 * crown_zone + side_sweep + wave) * feather + 0.0014
            # Keep top height sleek and natural (only +7mm above skull, NEVER towering!)
            thick_z = (0.001 + 0.0065 * crown_zone + side_sweep * 0.55) * feather

            if cos_t >= 0.0:
                hx = sin_t * (s_rx + thick_r)
                hy = -cos_t * (s_ryf + thick_r) + s_ys
            else:
                hx = sin_t * (s_rx * (1.0 + 0.04 * smoothstep(0.48, 0.82, v_skull)) + thick_r)
                hy = -cos_t * (s_ryb + thick_r) + s_ys
    # Also mirror exact skull dome z-curve for hair top!
            if v_skull <= 0.68:
                z_base = head_z0 + v_skull * head_span
            else:
                t_d2 = clamp((v_skull - 0.68) / 0.32, 0.0, 1.0)
                z_base = head_z0 + (0.68 + 0.275 * t_d2) * head_span
            hz = min(1.749, z_base + thick_z)

            ring.append((hx, hy, hz))
            uv_r.append((u * 3.5, tv * 1.4))
        h_rings.append(ring)
        h_uvs.append(uv_r)

    mb.add_uv_loft(h_rings, h_uvs, mat_hair, {"Head": 1.0}, closed_u=True, cap_start=False, cap_end=True, smooth=True)

    civ_mesh = mb.finalize_skinned("Civilian_Mesh", arm_obj)

    # --- 6. Author All 3 Baked Looping Civilian Animations (Idle, Walk, Startled) ---

    def anim_civ_idle(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        shift = math.sin(w)
        breath = math.sin(w * 2.0)
        glance = math.sin(w) * 16.0
        pb["Hips"].location = (shift * 0.014, 0.0, breath * 0.003)
        _set_rot(pb, "Hips", 0.0, shift * 2.5, -shift * 1.6)
        _set_rot(pb, "Spine", 1.0 + breath * 0.8, -shift * 2.0, shift * 1.4)
        _set_rot(pb, "Chest", 0.5 + breath * 1.2, glance * 0.16, shift * 0.8)
        _set_rot(pb, "Neck", 0.0, glance * 0.32, 0.0)
        _set_rot(pb, "Head", 1.0 + math.sin(w * 2.0) * 2.0, glance * 0.65, -shift * 1.8)
        _set_rot(pb, "UpperArm_L", 3.0 + breath, 0.0, -3.5)
        _set_rot(pb, "LowerArm_L", 14.0 + breath * 1.5, 0.0, 4.0)
        _set_rot(pb, "UpperArm_R", 2.0 - breath, 0.0, 3.5)
        _set_rot(pb, "LowerArm_R", 12.0 + breath * 1.5, 0.0, -4.0)

    def anim_civ_walk(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        s = math.sin(w)
        c = math.cos(w)
        bob = abs(math.cos(w)) * 0.026 - 0.013
        pb["Hips"].location = (s * 0.016, 0.0, bob)
        _set_rot(pb, "Hips", 1.5, s * 6.0, -s * 2.4)
        _set_rot(pb, "Spine", 2.5, -s * 4.5, s * 1.8)
        _set_rot(pb, "Chest", 2.0, -s * 5.0, s * 1.2)
        _set_rot(pb, "Neck", -1.5, s * 3.0, 0.0)
        _set_rot(pb, "Head", -0.5, s * 3.5, 0.0)

        leg_l = s * 24.0
        leg_r = -s * 24.0
        knee_l = -max(0.0, -c) * 32.0 - 4.0
        knee_r = -max(0.0, c) * 32.0 - 4.0
        _set_rot(pb, "UpperLeg_L", leg_l, 0.0, 1.0)
        _set_rot(pb, "LowerLeg_L", knee_l, 0.0, 0.0)
        _set_rot(pb, "Foot_L", -leg_l * 0.45 - knee_l * 0.35 + c * 8.0, 0.0, 0.0)

        _set_rot(pb, "UpperLeg_R", leg_r, 0.0, -1.0)
        _set_rot(pb, "LowerLeg_R", knee_r, 0.0, 0.0)
        _set_rot(pb, "Foot_R", -leg_r * 0.45 - knee_r * 0.35 - c * 8.0, 0.0, 0.0)

        # Relaxed natural counter-swing of both arms
        _set_rot(pb, "UpperArm_L", -s * 22.0, 0.0, -3.5)
        _set_rot(pb, "LowerArm_L", 14.0 + max(0.0, -s) * 14.0, 0.0, 3.0)
        _set_rot(pb, "UpperArm_R", s * 22.0, 0.0, 3.5)
        _set_rot(pb, "LowerArm_R", 14.0 + max(0.0, s) * 14.0, 0.0, -3.0)

    def anim_civ_startled(p: float, pb: Dict[str, bpy.types.PoseBone]) -> None:
        w = 2.0 * math.pi * p
        # Sharp flinch & defensive turn-back looking over shoulder at disturbance
        flinch = 0.5 - 0.5 * math.cos(w)  # smooth 0 -> 1 -> 0 envelope
        tremor = math.sin(w * 4.0) * 2.0 * flinch
        look_back = math.sin(w * 1.5) * 0.4 + flinch * 0.8
        pb["Hips"].location = (-0.018 * flinch, 0.045 * flinch, -0.036 * flinch)
        _set_rot(pb, "Hips", -6.0 * flinch, 14.0 * flinch, 3.0 * flinch)
        _set_rot(pb, "Spine", -8.0 * flinch, 16.0 * flinch, -3.0 * flinch)
        _set_rot(pb, "Chest", -6.0 * flinch, 18.0 * flinch, -4.0 * flinch)
        _set_rot(pb, "Neck", 5.0 * flinch, 18.0 * look_back, 4.0 * flinch)
        _set_rot(pb, "Head", 4.0 * flinch + tremor, 28.0 * look_back, 5.0 * flinch)
        # Recoiling stepped knees
        _set_rot(pb, "UpperLeg_L", 12.0 * flinch, 0.0, -5.0 * flinch)
        _set_rot(pb, "LowerLeg_L", -22.0 * flinch, 0.0, 0.0)
        _set_rot(pb, "Foot_L", 10.0 * flinch, 0.0, 0.0)
        _set_rot(pb, "UpperLeg_R", -8.0 * flinch, 0.0, 5.0 * flinch)
        _set_rot(pb, "LowerLeg_R", -14.0 * flinch, 0.0, 0.0)
        _set_rot(pb, "Foot_R", 12.0 * flinch, 0.0, 0.0)
        # Defensive raised hands clear of face (chest/shoulder level recoil)
        _set_rot(pb, "Shoulder_L", 0.0, 0.0, -8.0 * flinch)
        _set_rot(pb, "UpperArm_L", 28.0 * flinch, 0.0, -18.0 * flinch)
        _set_rot(pb, "LowerArm_L", 64.0 * flinch, 0.0, 8.0 * flinch)
        _set_rot(pb, "Hand_L", -12.0 * flinch, 0.0, 0.0)

        _set_rot(pb, "Shoulder_R", 0.0, 0.0, 8.0 * flinch)
        _set_rot(pb, "UpperArm_R", 24.0 * flinch, 0.0, 20.0 * flinch)
        _set_rot(pb, "LowerArm_R", 58.0 * flinch, 0.0, -8.0 * flinch)
        _set_rot(pb, "Hand_R", -12.0 * flinch, 0.0, 0.0)

    author_nla_clip(arm_obj, "Idle", 72, anim_civ_idle)
    author_nla_clip(arm_obj, "Walk", 32, anim_civ_walk)
    author_nla_clip(arm_obj, "Startled", 48, anim_civ_startled)

    return _ground_and_export_character(arm_obj, civ_mesh, out_path, target_height=1.75)


# ---------------------------------------------------------------------------
# Grounding, Height Calibration & GLB Export
# ---------------------------------------------------------------------------

def _ground_and_export_character(
    arm_obj: bpy.types.Object,
    mesh_obj: bpy.types.Object,
    out_path: Path,
    target_height: float,
) -> dict:
    """Strictly ground lowest vertex at z=0.0000, normalize height to target_height, and export rigged GLB."""
    bpy.context.view_layer.update()
    mesh = mesh_obj.data
    min_z = min((mesh_obj.matrix_world @ v.co).z for v in mesh.vertices)
    max_z = max((mesh_obj.matrix_world @ v.co).z for v in mesh.vertices)
    cur_h = max_z - min_z
    scale_f = target_height / cur_h if cur_h > 0.1 else 1.0

    # Apply exact grounding and uniform height scale directly to mesh vertices & armature bones
    # so exported Armature and Mesh both have clean Identity transforms!
    for v in mesh.vertices:
        v.co.z = (v.co.z - min_z) * scale_f
        v.co.x *= scale_f
        v.co.y *= scale_f
    mesh.update()

    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    for eb in arm_obj.data.edit_bones:
        eb.head = Vector((eb.head.x * scale_f, eb.head.y * scale_f, (eb.head.z - min_z) * scale_f))
        eb.tail = Vector((eb.tail.x * scale_f, eb.tail.y * scale_f, (eb.tail.z - min_z) * scale_f))
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.context.view_layer.update()

    # Measure final stats
    mesh.calc_loop_triangles()
    tris = len(mesh.loop_triangles)
    xs = [v.co.x for v in mesh.vertices]
    ys = [v.co.y for v in mesh.vertices]
    zs = [v.co.z for v in mesh.vertices]

    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=86,
        export_skins=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_nla_strips=True,
        export_bake_animation=True,
        export_frame_step=1,
        export_anim_slide_to_zero=True,
        export_optimize_animation_size=True,
        export_lights=False,
        export_cameras=False,
    )

    size_bytes = out_path.stat().st_size
    clips = [t.name for t in arm_obj.animation_data.nla_tracks]
    return {
        "file": out_path.name,
        "sizeBytes": size_bytes,
        "sizeMB": round(size_bytes / (1024 * 1024), 3),
        "triangles": tris,
        "width": round(max(xs) - min(xs), 4),
        "height": round(max(zs) - min(zs), 4),
        "depth": round(max(ys) - min(ys), 4),
        "minY": round(min(zs), 5),
        "clips": clips,
    }


# ---------------------------------------------------------------------------
# High-Res Multi-Angle Studio + Night-Lit QA Contact Sheet Renderer
# ---------------------------------------------------------------------------

def _setup_qa_scene(night_mode: bool = False, res: int = 512) -> None:
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = res
    scene.render.resolution_y = res
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"

    world = bpy.data.worlds.new("QAWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        if night_mode:
            bg.inputs["Color"].default_value = (0.018, 0.028, 0.052, 1.0)
            bg.inputs["Strength"].default_value = 0.70
        else:
            bg.inputs["Color"].default_value = (0.08, 0.095, 0.125, 1.0)
            bg.inputs["Strength"].default_value = 0.95

    # Ground plinth disc at z=0 to clearly verify feet grounding
    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=3.0, depth=0.04, location=(0.0, 0.0, -0.02))
    fl = bpy.context.active_object
    fmat = bpy.data.materials.new("QAFloor")
    fmat.use_nodes = True
    bsdf = fmat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.045, 0.055, 0.072, 1.0) if night_mode else (0.11, 0.12, 0.14, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.30 if night_mode else 0.55
    fl.data.materials.append(fmat)

    def add_area(name: str, loc, rot_deg, energy: float, size: float, color):
        ld = bpy.data.lights.new(name, type="AREA")
        ld.energy = energy
        ld.size = size
        ld.color = color
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.location = Vector(loc)
        lo.rotation_euler = tuple(math.radians(a) for a in rot_deg)
        return lo

    if night_mode:
        # Cinematic Salou Night-Noir: warm sodium streetlamp key + cool Mediterranean moonlight rim
        add_area("SodiumKey", (1.8, -2.4, 2.5), (58, 0, 36), energy=150.0, size=1.4, color=(1.0, 0.78, 0.52))
        add_area("MoonRim", (-1.9, 2.0, 2.3), (64, 0, -138), energy=130.0, size=1.6, color=(0.45, 0.72, 1.0))
        add_area("SoftBounce", (-1.2, -2.2, 1.2), (82, 0, -28), energy=36.0, size=1.8, color=(0.75, 0.85, 1.0))
    else:
        # Clean neutral-warm 3-point character sculpt studio lighting
        add_area("StudioKey", (1.6, -2.4, 2.3), (62, 0, 34), energy=165.0, size=1.6, color=(1.0, 0.94, 0.88))
        add_area("StudioFill", (-1.8, -2.0, 1.6), (72, 0, -40), energy=80.0, size=2.0, color=(0.82, 0.90, 1.0))
        add_area("StudioRim", (0.2, 2.4, 2.4), (58, 0, 175), energy=120.0, size=1.6, color=(0.78, 0.88, 1.0))


def _render_qa_panel(
    glb_path: Path,
    out_png: Path,
    cam_pos: Tuple[float, float, float],
    target: Tuple[float, float, float],
    lens: float = 55.0,
    night_mode: bool = False,
    clip_name: Optional[str] = None,
    frame: int = 1,
    res: int = 512,
) -> None:
    reset_scene()
    _setup_qa_scene(night_mode=night_mode, res=res)
    bpy.ops.import_scene.gltf(filepath=str(glb_path))

    # Optionally pose into a specific exported animation clip & frame to visually verify skinning & poses!
    if clip_name:
        for obj in bpy.context.scene.objects:
            if obj.type == "ARMATURE" and obj.animation_data:
                for act in bpy.data.actions:
                    if act.name == clip_name or act.name.startswith(clip_name):
                        obj.animation_data.action = act
                        break
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()

    cam_d = bpy.data.cameras.new("QACam")
    cam_d.lens = lens
    cam_o = bpy.data.objects.new("QACam", cam_d)
    bpy.context.scene.collection.objects.link(cam_o)
    bpy.context.scene.camera = cam_o
    cam_o.location = Vector(cam_pos)
    look = Vector(target) - cam_o.location
    cam_o.rotation_euler = look.to_track_quat("-Z", "Y").to_euler()

    bpy.context.scene.render.filepath = str(out_png)
    bpy.ops.render.render(write_still=True)


def render_qa_sheet(guard_glb: Path, civ_glb: Path, qa_out: Path) -> None:
    """Render an 8-panel (4x2) high-res QA sheet covering Guard & Civilian from all required angles + poses."""
    qa_out.parent.mkdir(parents=True, exist_ok=True)
    tmp = qa_out.parent / "_guard_civ_qa_tiles"
    tmp.mkdir(parents=True, exist_ok=True)
    res = 480

    # Row 1 (Guard): Front Studio | 3/4 Night-Lit RadioCall/Hero | Face Close-up | Back Studio
    # Row 2 (Civilian): Front Studio | 3/4 Night-Lit Hero | Face Close-up | Back Studio
    panels = [
        (guard_glb, "g_front.png", (0.0, -3.1, 1.00), (0.0, 0.0, 0.92), 54.0, False, None, 1),
        (guard_glb, "g_hero_night.png", (-1.75, -2.55, 1.12), (0.0, 0.0, 0.96), 54.0, True, "RadioCall", 30),
        (guard_glb, "g_face.png", (-0.18, -0.78, 1.66), (0.0, -0.02, 1.62), 82.0, False, None, 1),
        (guard_glb, "g_back.png", (0.55, 3.05, 1.05), (0.0, 0.0, 0.92), 54.0, False, None, 1),
        (civ_glb, "c_front.png", (0.0, -3.05, 0.98), (0.0, 0.0, 0.89), 54.0, False, None, 1),
        (civ_glb, "c_hero_night.png", (1.70, -2.50, 1.08), (0.0, 0.0, 0.92), 54.0, True, "Startled", 24),
        (civ_glb, "c_face.png", (0.16, -0.74, 1.60), (0.0, -0.02, 1.56), 82.0, False, None, 1),
        (civ_glb, "c_back.png", (-0.50, 3.00, 1.02), (0.0, 0.0, 0.89), 54.0, False, None, 1),
    ]

    tile_paths = []
    for glb, fname, cpos, tgt, lens, night, clip, fr in panels:
        p = tmp / fname
        _render_qa_panel(glb, p, cpos, tgt, lens=lens, night_mode=night, clip_name=clip, frame=fr, res=res)
        tile_paths.append(p)

    # Stitch into 4x2 contact sheet using Blender image buffer
    reset_scene()
    cols, rows = 4, 2
    sw, sh = cols * res, rows * res
    sheet = bpy.data.images.new("GuardCivQA", width=sw, height=sh, alpha=False)
    buf = [0.02, 0.03, 0.05, 1.0] * (sw * sh)
    for idx, tp in enumerate(tile_paths):
        img = bpy.data.images.load(str(tp))
        px = list(img.pixels)
        col = idx % cols
        row = rows - 1 - (idx // cols)
        x0, y0 = col * res, row * res
        for y in range(res):
            s0 = y * res * 4
            d0 = ((y0 + y) * sw + x0) * 4
            buf[d0 : d0 + res * 4] = px[s0 : s0 + res * 4]
        bpy.data.images.remove(img)
    sheet.pixels.foreach_set(buf)
    sheet.filepath_raw = str(qa_out)
    sheet.file_format = "PNG"
    sheet.save()
    print(f"[qa] Saved 8-panel QA sheet -> {qa_out}")


# ---------------------------------------------------------------------------
# Binary GLB Verification
# ---------------------------------------------------------------------------

def verify_exported_glb(filepath: Path, required_clips: Sequence[str], required_nodes: Sequence[str]) -> dict:
    data = filepath.read_bytes()
    magic, ver, length = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and ver == 2 and length == len(data), f"Invalid GLB header in {filepath}"
    c0_len, c0_type = struct.unpack_from("<I4s", data, 12)
    assert c0_type == b"JSON"
    gltf = json.loads(data[20 : 20 + c0_len].decode("utf-8"))
    clips = [a.get("name") for a in gltf.get("animations", [])]
    nodes = [n.get("name") for n in gltf.get("nodes", [])]
    missing_clips = [c for c in required_clips if c not in clips]
    missing_nodes = [n for n in required_nodes if n not in nodes]
    assert not missing_clips, f"{filepath.name} missing clips: {missing_clips} (found {clips})"
    assert not missing_nodes, f"{filepath.name} missing nodes: {missing_nodes}"
    assert len(gltf.get("skins", [])) >= 1, f"{filepath.name} has no glTF skin!"
    assert len(gltf.get("images", [])) >= 1, f"{filepath.name} has no packed PBR images!"
    return {
        "file": filepath.name,
        "bytes": len(data),
        "mb": round(len(data) / (1024 * 1024), 3),
        "clips": clips,
        "skins": len(gltf.get("skins", [])),
        "images": len(gltf.get("images", [])),
        "materials": len(gltf.get("materials", [])),
        "nodesCount": len(nodes),
    }


def main() -> int:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description="Build photorealistic rigged guard & civilian GLBs.")
    parser.add_argument("--tex-dir", type=Path, default=DEFAULT_TEX_DIR)
    parser.add_argument("--out-dir", type=Path, default=MODELS_DIR)
    parser.add_argument("--qa-out", type=Path, default=None)
    args = parser.parse_args(argv)

    guard_glb = args.out_dir / "character_guard.glb"
    civ_glb = args.out_dir / "character_civilian.glb"

    print(f"[build_guard] Using PBR texture dir: {args.tex_dir}")
    g_stats = build_character_guard(guard_glb, args.tex_dir)
    print(f"[build_guard] Exported {g_stats}")

    c_stats = build_character_civilian(civ_glb, args.tex_dir)
    print(f"[build_guard] Exported {c_stats}")

    g_ver = verify_exported_glb(
        guard_glb,
        required_clips=["Idle", "PatrolWalk", "SuspiciousLook", "FlashlightSweep", "RadioCall", "Sprint"],
        required_nodes=["Root", "Hips", "Spine", "Chest", "Neck", "Head", "Hand_R", "Flashlight", "Foot_L", "Foot_R"],
    )
    c_ver = verify_exported_glb(
        civ_glb,
        required_clips=["Idle", "Walk", "Startled"],
        required_nodes=["Root", "Hips", "Spine", "Chest", "Neck", "Head", "Hand_L", "Hand_R", "Foot_L", "Foot_R"],
    )
    print(f"[verify] Guard GLB OK: {g_ver}")
    print(f"[verify] Civilian GLB OK: {c_ver}")

    if args.qa_out is not None:
        render_qa_sheet(guard_glb, civ_glb, args.qa_out)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
