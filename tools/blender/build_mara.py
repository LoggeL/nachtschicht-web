"""Dedicated Hero Character Sculptor & Technical Artist pipeline for Mara Voss (V2 Photoreal).

Builds a photorealistic, anatomically proportioned (1.72m), UV-mapped, real gpt-image-2 PBR-textured,
19-bone skeletal-rigged, and 5-clip animated glTF 2.0 character:
    public/assets/models/character_mara.glb

Usage:
    /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/blender/build_mara.py
    /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/blender/build_mara.py -- --qa /path/to/mara_qa.png
"""

from __future__ import annotations

import json
import math
import os
import struct
import sys
from typing import Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Quaternion, Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_GLB = os.path.join(PROJECT_ROOT, "public", "assets", "models", "character_mara.glb")

# Preprocessed gpt-image-2 photoreal PBR texture directory (packed directly into GLB!)
PBR_READY_DIR = "/Users/logge/.gemini/antigravity-cli/brain/78e7f8cd-be01-4666-bfdd-50249341846a/scratch/mara_pbr_ready"
PUBLIC_TEX_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "textures")

# Shared Head UV bounds (aligned pixel-exact with skin_albedo.png!)
HEAD_Z_MIN = 1.408
HEAD_Z_MAX = 1.712


def head_uv_from_phi_z(phi: float, z: float) -> Tuple[float, float]:
    """Exact bijection between head cylindrical angle phi in [-pi, pi] & z -> UV [0, 1]."""
    u = 0.5 + phi / (2.0 * math.pi)
    v = (z - HEAD_Z_MIN) / (HEAD_Z_MAX - HEAD_Z_MIN)
    return (max(0.0, min(1.0, u)), max(0.0, min(1.0, v)))


# =============================================================================
# 1. PHOTOREALISTIC PACKED PBR MATERIALS (gpt-image-2 + Sobel Normal/Roughness)
# =============================================================================

def _load_packed_image(filepath: str, is_srgb: bool = True) -> Optional[bpy.types.Image]:
    if not os.path.exists(filepath):
        return None
    img = bpy.data.images.load(filepath, check_existing=True)
    img.colorspace_settings.name = "sRGB" if is_srgb else "Non-Color"
    try:
        img.pack()
    except Exception:
        pass
    return img


def _make_procedural_image(name: str, rgb: np.ndarray, is_srgb: bool = True) -> bpy.types.Image:
    h, w, _ = rgb.shape
    rgba = np.ones((h, w, 4), dtype=np.float32)
    rgba[:, :, :3] = np.clip(rgb, 0.0, 1.0)
    img = bpy.data.images.new(name=name, width=w, height=h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "sRGB" if is_srgb else "Non-Color"
    img.pixels.foreach_set(rgba.ravel())
    img.pack()
    return img


def _create_pbr_material(
    name: str,
    albedo_img: Optional[bpy.types.Image] = None,
    normal_img: Optional[bpy.types.Image] = None,
    rough_img: Optional[bpy.types.Image] = None,
    base_color: Tuple[float, float, float] = (0.5, 0.5, 0.5),
    metallic: float = 0.0,
    roughness: float = 0.5,
    normal_strength: float = 1.0,
    coat: float = 0.0,
    coat_roughness: float = 0.12,
    emission: Optional[Tuple[float, float, float]] = None,
    emission_strength: float = 0.0,
    uv_scale: Tuple[float, float] = (1.0, 1.0),
    double_sided: bool = False,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    out.location = (520, 0)
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (200, 0)
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    bsdf.inputs["Base Color"].default_value = (*base_color, 1.0)
    bsdf.inputs["Metallic"].default_value = float(metallic)
    bsdf.inputs["Roughness"].default_value = float(roughness)

    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = float(coat)
        bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)

    if emission is not None and emission_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = (*emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = float(emission_strength)

    mapping_out = None
    if uv_scale != (1.0, 1.0):
        tc = nt.nodes.new("ShaderNodeTexCoord")
        tc.location = (-720, 0)
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.location = (-520, 0)
        mp.inputs["Scale"].default_value = (uv_scale[0], uv_scale[1], 1.0)
        nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
        mapping_out = mp.outputs["Vector"]

    def _add_tex(img: bpy.types.Image, y_pos: float):
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = img
        tn.location = (-280, y_pos)
        if mapping_out is not None:
            nt.links.new(mapping_out, tn.inputs["Vector"])
        return tn

    if albedo_img is not None:
        tn_col = _add_tex(albedo_img, 240)
        nt.links.new(tn_col.outputs["Color"], bsdf.inputs["Base Color"])

    if rough_img is not None:
        tn_r = _add_tex(rough_img, -20)
        nt.links.new(tn_r.outputs["Color"], bsdf.inputs["Roughness"])

    if normal_img is not None:
        tn_n = _add_tex(normal_img, -300)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.location = (-10, -280)
        nm.inputs["Strength"].default_value = float(normal_strength)
        nt.links.new(tn_n.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

    mat.use_backface_culling = not double_sided
    return mat


def _build_all_materials() -> Dict[str, bpy.types.Material]:
    """Load real gpt-image-2 PBR texture sets (albedo + Sobel normal + roughness) and pack into GLB."""
    mats: Dict[str, bpy.types.Material] = {}

    def _pbr_triplet(key: str):
        a = _load_packed_image(os.path.join(PBR_READY_DIR, f"{key}_albedo.png"), is_srgb=True)
        n = _load_packed_image(os.path.join(PBR_READY_DIR, f"{key}_normal.png"), is_srgb=False)
        r = _load_packed_image(os.path.join(PBR_READY_DIR, f"{key}_rough.png"), is_srgb=False)
        return a, n, r

    # 1) Skin (real gpt-image-2 silky 4x4 pores + pixel-exact Mediterranean facial shading & brows/lips)
    a, n, r = _pbr_triplet("skin")
    mats["skin"] = _create_pbr_material(
        "Mara_Skin", albedo_img=a, normal_img=n, rough_img=r,
        base_color=(0.55, 0.31, 0.21), roughness=0.46, normal_strength=0.18,
    )

    # 2) Eyes (real gpt-image-2 deep slate-hazel fibrous iris + wet glossy cornea)
    eye_a = _load_packed_image(os.path.join(PBR_READY_DIR, "eye_albedo.png"), is_srgb=True)
    mats["eye"] = _create_pbr_material(
        "Mara_Eye", albedo_img=eye_a, base_color=(0.18, 0.24, 0.22),
        roughness=0.04, coat=1.0, coat_roughness=0.015,
    )

    # 3) Hair (real gpt-image-2 silky dark espresso-chestnut vertical hair strands, subtle natural sheen)
    a, n, r = _pbr_triplet("hair")
    mats["hair"] = _create_pbr_material(
        "Mara_Hair", albedo_img=a, normal_img=n, rough_img=r,
        base_color=(0.03, 0.016, 0.012), roughness=0.56, normal_strength=0.58,
        coat=0.03, coat_roughness=0.42, double_sided=True,
    )

    # Dark espresso natural eyelashes
    mats["lash"] = _create_pbr_material(
        "Mara_Eyelash", base_color=(0.010, 0.007, 0.005), roughness=0.52, double_sided=True,
    )

    # 4) Matte Charcoal Leather-Tech Field Jacket (real gpt-image-2 full-grain matte charcoal leather)
    ja, jn, jr = _pbr_triplet("jacket")
    mats["jacket"] = _create_pbr_material(
        "Mara_TechJacket", albedo_img=ja, normal_img=jn, rough_img=jr,
        base_color=(0.032, 0.036, 0.044), metallic=0.0, roughness=0.72, normal_strength=0.82,
        uv_scale=(3.2, 3.2),
    )

    # Darker leather trim reusing jacket normal & rough datablocks (saves 350KB GLB size cleanly!)
    at = _load_packed_image(os.path.join(PBR_READY_DIR, "jacket_trim_albedo.png"), is_srgb=True)
    mats["jacket_trim"] = _create_pbr_material(
        "Mara_JacketTrim", albedo_img=at, normal_img=jn, rough_img=jr,
        base_color=(0.018, 0.020, 0.026), metallic=0.0, roughness=0.64, normal_strength=0.75,
        uv_scale=(3.6, 3.6),
    )

    # 5) Midnight-Navy Ribbed Merino Knit Turtleneck (real gpt-image-2 vertical wool knit)
    a, n, r = _pbr_triplet("turtleneck")
    mats["turtleneck"] = _create_pbr_material(
        "Mara_Turtleneck", albedo_img=a, normal_img=n, rough_img=r,
        base_color=(0.015, 0.024, 0.055), roughness=0.86, normal_strength=0.95,
        uv_scale=(2.2, 2.2),
    )

    # 6) Tailored Dark Tactical Trousers Twill (real gpt-image-2 diagonal woven twill)
    a, n, r = _pbr_triplet("trousers")
    mats["trousers"] = _create_pbr_material(
        "Mara_Trousers", albedo_img=a, normal_img=n, rough_img=r,
        base_color=(0.022, 0.026, 0.034), roughness=0.78, normal_strength=0.72,
        uv_scale=(3.6, 3.6),
    )

    # 7) Matte Black Tactical Boots & Leather Gloves (real gpt-image-2 tight-grain black leather)
    a, n, r = _pbr_triplet("boot")
    mats["leather_dark"] = _create_pbr_material(
        "Mara_LeatherBootsGloves", albedo_img=a, normal_img=n, rough_img=r,
        base_color=(0.016, 0.016, 0.018), roughness=0.44, normal_strength=0.75,
        coat=0.08, coat_roughness=0.30, uv_scale=(2.8, 2.8),
    )

    # Matte vulcanized rubber boot outsole & laces
    mats["rubber"] = _create_pbr_material(
        "Mara_BootRubber", base_color=(0.016, 0.017, 0.020), roughness=0.82,
    )

    # 8) Oiled Espresso Saddle Leather Crossbody Satchel (real gpt-image-2 oiled brown leather!)
    a, n, r = _pbr_triplet("satchel")
    mats["satchel_leather"] = _create_pbr_material(
        "Mara_SatchelLeather", albedo_img=a, normal_img=n, rough_img=r,
        base_color=(0.055, 0.024, 0.012), roughness=0.52, normal_strength=0.85,
        uv_scale=(2.2, 2.2),
    )

    # Subtle dark-blue ballistic nylon Securion tech pouch (using trousers/tactical weave normal + deep Securion navy!)
    pouch_n = _load_packed_image(os.path.join(PBR_READY_DIR, "trousers_normal.png"), is_srgb=False)
    mats["tech_pouch"] = _create_pbr_material(
        "Mara_SecurionPouch", normal_img=pouch_n,
        base_color=(0.018, 0.036, 0.078), roughness=0.62, normal_strength=0.75, uv_scale=(3.0, 3.0),
    )

    # 9) Brushed Metal Hardware (Gunmetal zippers/snaps/earpiece + Antique Brass satchel buckles + Subtle Cyan LED)
    steel_n = _load_packed_image(os.path.join(PUBLIC_TEX_DIR, "brushed_steel_normal.webp"), is_srgb=False)
    mats["gunmetal"] = _create_pbr_material(
        "Mara_BrushedGunmetal", normal_img=steel_n,
        base_color=(0.14, 0.15, 0.18), metallic=0.88, roughness=0.34, normal_strength=0.35,
    )
    mats["earpiece_dark"] = _create_pbr_material(
        "Mara_CommEarpiece", base_color=(0.025, 0.028, 0.032), metallic=0.45, roughness=0.26,
    )
    mats["brass"] = _create_pbr_material(
        "Mara_BrushedBrass", normal_img=steel_n,
        base_color=(0.48, 0.34, 0.14), metallic=0.88, roughness=0.32, normal_strength=0.35,
    )
    mats["cyan_led"] = _create_pbr_material(
        "Mara_DiagnosticCyan", base_color=(0.05, 0.22, 0.28), metallic=0.1, roughness=0.12,
        emission=(0.10, 0.72, 0.88), emission_strength=1.5,
    )

    return mats


# =============================================================================
# 2. PART-TAGGED SCULPTED MESH COLLECTOR (WITH FIXED BEVEL FACE CAPTURE!)
# =============================================================================

class CharacterBuilder:
    """Collects sculpted multi-material anatomical meshes with zero-bleed bone-region tags."""

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.materials: List[bpy.types.Material] = []
        self._mat_map: Dict[str, int] = {}
        self.uv_layer = self.bm.loops.layers.uv.verify()
        self.part_layer = self.bm.verts.layers.int.new("part_id")
        self._part_names: List[str] = []
        self._part_map: Dict[str, int] = {}

    def mat_idx(self, mat: bpy.types.Material) -> int:
        if mat.name not in self._mat_map:
            self._mat_map[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self._mat_map[mat.name]

    def part_id(self, name: str) -> int:
        if name not in self._part_map:
            self._part_map[name] = len(self._part_names)
            self._part_names.append(name)
        return self._part_map[name]

    def part_name(self, pid: int) -> str:
        return self._part_names[pid]

    def new_vert(self, co: Sequence[float], part: str) -> bmesh.types.BMVert:
        v = self.bm.verts.new((float(co[0]), float(co[1]), float(co[2])))
        v[self.part_layer] = self.part_id(part)
        return v

    def add_grid(
        self,
        rings: Sequence[Sequence[Tuple[float, float, float]]],
        uv_rings: Optional[Sequence[Sequence[Tuple[float, float]]]],
        mat: bpy.types.Material,
        part: str,
        closed_u: bool = True,
        smooth: bool = True,
        cap_start: bool = False,
        cap_end: bool = False,
        flip: bool = False,
    ) -> List[bmesh.types.BMFace]:
        nr = len(rings)
        if nr < 2:
            return []
        nu = len(rings[0])
        v_rows = [[self.new_vert(p, part) for p in row] for row in rings]
        midx = self.mat_idx(mat)
        faces: List[bmesh.types.BMFace] = []

        u_steps = nu if closed_u else (nu - 1)
        for r in range(nr - 1):
            for c in range(u_steps):
                cn = (c + 1) % nu
                quad = [v_rows[r][c], v_rows[r][cn], v_rows[r + 1][cn], v_rows[r + 1][c]]
                if flip:
                    quad.reverse()
                if len(set(quad)) < 4:
                    continue
                try:
                    f = self.bm.faces.new(quad)
                except ValueError:
                    continue
                f.material_index = midx
                f.smooth = smooth
                if uv_rings is not None:
                    u_cn = c + 1 if len(uv_rings[r]) > nu else cn
                    uvs = [uv_rings[r][c], uv_rings[r][u_cn], uv_rings[r + 1][u_cn], uv_rings[r + 1][c]]
                    if flip:
                        uvs.reverse()
                    for loop, uv in zip(f.loops, uvs):
                        loop[self.uv_layer].uv = uv
                else:
                    u0 = c / float(max(1, u_steps))
                    u1 = (c + 1) / float(max(1, u_steps))
                    v0 = r / float(max(1, nr - 1))
                    v1 = (r + 1) / float(max(1, nr - 1))
                    uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
                    if flip:
                        uvs.reverse()
                    for loop, uv in zip(f.loops, uvs):
                        loop[self.uv_layer].uv = uv
                faces.append(f)

        def _cap(row_verts, v_coord: float, reverse: bool):
            center = sum((v.co for v in row_verts), Vector((0, 0, 0))) / len(row_verts)
            cv = self.new_vert(center, part)
            for c in range(nu):
                cn = (c + 1) % nu
                tri = [row_verts[cn], row_verts[c], cv] if reverse else [row_verts[c], row_verts[cn], cv]
                if flip:
                    tri.reverse()
                if len(set(tri)) < 3:
                    continue
                try:
                    f = self.bm.faces.new(tri)
                    f.material_index = midx
                    f.smooth = smooth
                    for loop in f.loops:
                        loop[self.uv_layer].uv = (0.5, v_coord)
                    faces.append(f)
                except ValueError:
                    pass

        if cap_start and closed_u and nu >= 3:
            _cap(v_rows[0], 0.0, reverse=True)
        if cap_end and closed_u and nu >= 3:
            _cap(v_rows[-1], 1.0, reverse=False)
        return faces

    def add_tube(
        self,
        points: Sequence[Sequence[float]],
        radii: Sequence[Tuple[float, float]] | Sequence[float] | Tuple[float, float] | float,
        mat: bpy.types.Material,
        part: str,
        segments: int = 10,
        smooth: bool = True,
        cap_start: bool = True,
        cap_end: bool = True,
        twist_hint: Optional[Vector] = None,
    ) -> None:
        pts = [Vector(p) for p in points]
        n_pts = len(pts)
        if n_pts < 2:
            return

        r_pairs: List[Tuple[float, float]] = []
        if isinstance(radii, (int, float)):
            r_pairs = [(float(radii), float(radii))] * n_pts
        elif (
            isinstance(radii, tuple)
            and len(radii) == 2
            and isinstance(radii[0], (int, float))
            and isinstance(radii[1], (int, float))
        ):
            r_pairs = [(float(radii[0]), float(radii[1]))] * n_pts
        else:
            for item in radii:
                if isinstance(item, (tuple, list)):
                    r_pairs.append((float(item[0]), float(item[1])))
                else:
                    r_pairs.append((float(item), float(item)))
            if len(r_pairs) < n_pts:
                r_pairs.extend([r_pairs[-1]] * (n_pts - len(r_pairs)))

        rings = []
        prev_n: Optional[Vector] = None
        for i, p in enumerate(pts):
            if i == 0:
                tang = (pts[1] - pts[0]).normalized()
            elif i == n_pts - 1:
                tang = (pts[-1] - pts[-2]).normalized()
            else:
                t1 = (pts[i] - pts[i - 1]).normalized()
                t2 = (pts[i + 1] - pts[i]).normalized()
                tang = t1 + t2
                tang = t2 if tang.length < 1e-6 else tang.normalized()

            if prev_n is None:
                ref = twist_hint if twist_hint is not None else Vector((0.0, -1.0, 0.0))
                if abs(tang.dot(ref)) > 0.92:
                    ref = Vector((1.0, 0.0, 0.0))
                nrm = tang.cross(ref).normalized()
            else:
                nrm = prev_n - tang * prev_n.dot(tang)
                if nrm.length < 1e-6:
                    ref = Vector((1.0, 0.0, 0.0)) if abs(tang.x) < 0.9 else Vector((0.0, 1.0, 0.0))
                    nrm = tang.cross(ref).normalized()
                else:
                    nrm.normalize()
            binrm = tang.cross(nrm).normalized()
            prev_n = nrm

            rx, ry = r_pairs[i]
            ring = []
            for s in range(segments):
                ang = 2.0 * math.pi * s / segments
                pt = p + nrm * (math.cos(ang) * rx) + binrm * (math.sin(ang) * ry)
                ring.append((pt.x, pt.y, pt.z))
            rings.append(ring)

        self.add_grid(rings, None, mat, part, closed_u=True, smooth=smooth, cap_start=cap_start, cap_end=cap_end)

    def add_hair_ribbon(
        self,
        points: Sequence[Sequence[float]],
        widths: Sequence[float],
        thicknesses: Sequence[float],
        outward_hint: Sequence[Sequence[float]] | Vector,
        mat: bpy.types.Material,
        part: str = "head",
        u_offset: float = 0.0,
    ) -> None:
        """Smooth arched organic hair lock ribbon with longitudinal strand UVs."""
        pts = [Vector(p) for p in points]
        n_pts = len(pts)
        # Soft 5-point domed ribbon profile (clean smooth silhouette, economical tri count!)
        prof = [
            (-1.0, -0.15),
            (-0.50, 0.72),
            (0.0, 1.0),
            (0.50, 0.72),
            (1.0, -0.15),
            (0.0, -0.55),
        ]
        rings = []
        uv_rings = []
        for i, p in enumerate(pts):
            if i == 0:
                tang = (pts[1] - pts[0]).normalized()
            elif i == n_pts - 1:
                tang = (pts[-1] - pts[-2]).normalized()
            else:
                tang = ((pts[i] - pts[i - 1]).normalized() + (pts[i + 1] - pts[i]).normalized()).normalized()

            out = outward_hint.copy() if isinstance(outward_hint, Vector) else Vector(outward_hint[i])
            out = out - tang * out.dot(tang)
            out = Vector((0.0, 1.0, 0.0)) if out.length < 1e-6 else out.normalized()
            side = tang.cross(out).normalized()

            w = widths[i]
            th = thicknesses[i]
            v_coord = i / float(n_pts - 1)
            ring = []
            uv_row = []
            for j, (sx, sy) in enumerate(prof):
                pt = p + side * (sx * w) + out * (sy * th)
                ring.append((pt.x, pt.y, pt.z))
                uv_row.append(((u_offset + j / float(len(prof)) * 0.45) % 1.0, v_coord))
            uv_row.append(((u_offset + 0.45) % 1.0, v_coord))
            rings.append(ring)
            uv_rings.append(uv_row)

        self.add_grid(rings, uv_rings, mat, part, closed_u=True, smooth=True, cap_start=True, cap_end=True)

    def add_beveled_box(
        self,
        center: Sequence[float],
        size: Sequence[float],
        mat: bpy.types.Material,
        part: str,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        bevel: float = 0.005,
        segments: int = 1,
        smooth: bool = True,
        taper_top: Tuple[float, float] = (1.0, 1.0),
        taper_bottom: Tuple[float, float] = (1.0, 1.0),
    ) -> None:
        """Bulletproof beveled box capturing 100% of original + bevel-replaced faces & vertices!"""
        existing_v = set(self.bm.verts)
        existing_f = set(self.bm.faces)

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
        verts = [self.new_vert(c, part) for c in coords]
        fdefs = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
        faces = [self.bm.faces.new([verts[i] for i in fd]) for fd in fdefs]
        if bevel > 0.0:
            b_amt = min(float(bevel), min(sx, sy, sz) * 0.42)
            edges = list({e for f in faces for e in f.edges})
            bmesh.ops.bevel(
                self.bm, geom=edges, offset=b_amt, offset_type="OFFSET",
                segments=segments, profile=0.5, affect="EDGES", clamp_overlap=True,
            )

        new_verts = [v for v in self.bm.verts if v not in existing_v]
        new_faces = [f for f in self.bm.faces if f not in existing_f]

        pid = self.part_id(part)
        for v in new_verts:
            v[self.part_layer] = pid

        mat4 = Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=mat4, verts=new_verts)

        midx = self.mat_idx(mat)
        for f in new_faces:
            f.material_index = midx
            f.smooth = smooth
            f.normal_update()
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for loop in f.loops:
                co = loop.vert.co
                if az >= ax and az >= ay:
                    loop[self.uv_layer].uv = (co.x * 2.5 + 0.5, co.y * 2.5 + 0.5)
                elif ax >= ay and ax >= az:
                    loop[self.uv_layer].uv = (co.y * 2.5 + 0.5, co.z * 2.5 + 0.5)
                else:
                    loop[self.uv_layer].uv = (co.x * 2.5 + 0.5, co.z * 2.5 + 0.5)

    def add_cylinder(
        self,
        center: Sequence[float],
        r_bot: float,
        r_top: float,
        depth: float,
        mat: bpy.types.Material,
        part: str,
        segments: int = 10,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
    ) -> None:
        existing_v = set(self.bm.verts)
        existing_f = set(self.bm.faces)
        mat4 = Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
        bmesh.ops.create_cone(
            self.bm, cap_ends=True, cap_tris=False, segments=segments,
            radius1=float(r_bot), radius2=float(r_top), depth=float(depth), matrix=mat4,
        )
        pid = self.part_id(part)
        for v in self.bm.verts:
            if v not in existing_v:
                v[self.part_layer] = pid
        midx = self.mat_idx(mat)
        for f in self.bm.faces:
            if f not in existing_f:
                f.material_index = midx
                f.smooth = smooth if len(f.verts) <= 4 else False
                for loop in f.loops:
                    co = loop.vert.co
                    loop[self.uv_layer].uv = (co.x * 3.0 + 0.5, co.z * 3.0 + 0.5)


# =============================================================================
# 3. ANATOMICAL SCULPTORS (V2 REFINED FACE, 3D HOODED EYELIDS, SILKY HAIR, SLOPING SHOULDERS)
# =============================================================================

def _smoothstep(edge0: float, edge1: float, x: float) -> float:
    t = max(0.0, min(1.0, (x - edge0) / (edge1 - edge0 + 1e-8)))
    return t * t * (3.0 - 2.0 * t)


def _gauss(d: float, sigma: float) -> float:
    return math.exp(-(d * d) / (sigma * sigma + 1e-12))


# Eye anatomy constants shared between face orbit recess, glossy eyeballs, and 3D sculpted eyelids!
EYE_X = 0.0308
EYE_Y = -0.0642    # Deeply recessed inside orbital socket!
EYE_Z = 1.6060
EYE_R = 0.0114     # Realistic 22.8mm adult human eyeball (front cornea at y = -0.0756!)


def _eyelid_z_curves(dx: float, sx: float) -> Tuple[float, float]:
    """Alert, intense, focused almond eyelid aperture matching 35mm portrait_mara.webp!"""
    dx_out = dx * sx
    t_x = max(-1.0, min(1.0, dx / 0.0145))
    # Upper lid covers ~15% of upper iris (+0.0046 above center) -> sharp alert focused look (not sleepy!)
    z_up = EYE_Z + 0.0046 * math.cos(t_x * math.pi * 0.5) + 0.0014 * (dx_out / 0.0145)
    # Lower lid rests smoothly at bottom edge of iris (-0.0044 below center)
    z_lo = EYE_Z - 0.0044 * math.cos(t_x * math.pi * 0.5) + 0.0010 * (dx_out / 0.0145)
    return z_up, z_lo


def _eval_head_neck_surface(phi: float, z: float, include_orbit_recess: bool = True) -> Tuple[float, float, float]:
    """V3 Refined sculpted 34yo European female head & neck (balanced oval-athletic jaw, crisp nose, full lips)."""
    sp = math.sin(phi)
    cp = math.cos(phi)  # +1 front (-Y), -1 back (+Y)

    # Graceful natural jaw-to-neck transition (clean chin overhang, natural female throat width!)
    neck_to_head = _smoothstep(1.482 + 0.022 * max(0.0, -cp), 1.510 + 0.014 * max(0.0, -cp), z)

    # ---- Slender Athletic Female Neck (z=1.408 .. 1.512) ----
    t_neck = max(0.0, min(1.0, (z - 1.408) / 0.100))
    neck_rx = 0.0525 - 0.0052 * math.sin(t_neck * math.pi * 0.85) + 0.002 * (1.0 - t_neck)
    neck_ry = 0.0535 - 0.0045 * math.sin(t_neck * math.pi * 0.85)
    neck_cy = 0.019 - 0.003 * t_neck

    scm_target_phi = 0.28 + 1.25 * t_neck
    scm = _gauss(abs(phi) - scm_target_phi, 0.22) * math.sin(t_neck * math.pi) * 0.0036
    notch = _gauss(phi, 0.26) * _gauss(z - 1.425, 0.018) * (-0.0040)
    neck_r_mod = scm + notch
    nx = (neck_rx + neck_r_mod) * sp
    ny = neck_cy - (neck_ry + neck_r_mod) * cp

    # ---- Refined Craniofacial Envelope (z=1.494 .. 1.710) ----
    zc = 1.602
    dz = z - zc
    if dz >= 0.0:
        u_z = min(1.0, dz / 0.108)
        dome = math.sqrt(max(0.0, 1.0 - u_z * u_z))
        head_rx = 0.0745 * (dome ** 0.86)
        head_ry_f = 0.0890 * (dome ** 0.88)
        head_ry_b = 0.1040 * (dome ** 0.82)
        head_cy = 0.010 + 0.008 * u_z
    else:
        u_z = min(1.0, abs(dz) / 0.108)
        # Attractive balanced oval-sculpted European female jawline (less triangular/pointy than V2!)
        jaw_taper = max(0.0, 1.0 - (u_z ** 1.75))
        head_rx = 0.0745 * (jaw_taper ** 0.56)
        head_ry_f = 0.0890 * (jaw_taper ** 0.42)
        head_ry_b = 0.1040 * max(0.0, 1.0 - (u_z ** 1.35)) ** 0.72
        head_cy = 0.010 - 0.006 * u_z

    front_w = 0.5 * (1.0 + cp)
    head_ry = head_ry_b * (1.0 - front_w) + head_ry_f * front_w

    # Refined photographic female facial planes (matching 35mm portrait_mara.webp):
    temple = _gauss(abs(phi) - 0.90, 0.32) * _gauss(z - 1.628, 0.032) * (-0.0052)
    cheekbone = _gauss(abs(phi) - 0.66, 0.25) * _gauss(z - 1.586, 0.016) * 0.0072
    cheek_hollow = _gauss(abs(phi) - 0.58, 0.24) * _gauss(z - 1.550, 0.018) * (-0.0046)
    jaw_angle = _gauss(abs(phi) - 1.12, 0.22) * _gauss(z - 1.528, 0.015) * 0.0058
    submental = _smoothstep(1.505, 1.488, z) * max(0.0, cp) * (-0.012)
    chin_pad = _gauss(phi, 0.24) * _gauss(z - 1.505, 0.012) * 0.0068
    forehead_slope = _gauss(phi, 0.55) * _smoothstep(1.630, 1.682, z) * (-0.0042)

    r_sculpt = temple + cheekbone + cheek_hollow + jaw_angle + forehead_slope
    hx = (head_rx + r_sculpt) * sp
    hy = head_cy - (head_ry + r_sculpt + chin_pad + submental) * cp

    x = nx * (1.0 - neck_to_head) + hx * neck_to_head
    y = ny * (1.0 - neck_to_head) + hy * neck_to_head

    # ---- High-Precision Front Facial Features ----
    if cp > 0.22 and 1.495 < z < 1.675:
        f_env = _smoothstep(0.22, 0.55, cp)
        ax = abs(x)
        sx = 1.0 if x >= 0.0 else -1.0

        # 1) Defined Low-Set Brow Ridge
        bx_t = max(0.0, min(1.0, (ax - 0.010) / 0.038))
        brow_z = 1.620 + 0.0042 * math.sin(bx_t * math.pi * 0.72)
        brow_lat = _smoothstep(0.056, 0.038, ax)
        brow_bump = _gauss(z - brow_z, 0.0080) * brow_lat * 0.0062
        glab = _gauss(x, 0.0085) * _gauss(z - 1.614, 0.008) * (-0.0024)
        y -= (brow_bump + glab) * f_env

        # 2) Deep Smooth Orbital Socket Cavity
        if include_orbit_recess:
            ex = sx * EYE_X
            dx = x - ex
            orb_r2 = (dx / 0.0200) ** 2 + ((z - (EYE_Z + 0.0005)) / 0.0130) ** 2
            y += math.exp(-orb_r2) * 0.0155 * f_env
            if abs(dx) < 0.0160 and abs(z - EYE_Z) < 0.0105:
                ap_w = _smoothstep(0.0160, 0.0110, abs(dx)) * _smoothstep(0.0105, 0.0060, abs(z - EYE_Z))
                y = y * (1.0 - ap_w) + max(y, EYE_Y + 0.003) * ap_w

        # 3) Sleek Refined Straight Nose (higher crisp dorsal bridge + refined tip + sculpted nostrils!)
        if ax < 0.026 and 1.560 < z < 1.616:
            t_bridge = (1.610 - z) / 0.037  # starts right at nasion (1.610) -> tip (1.573)
            if 0.0 <= t_bridge <= 1.26:
                w_bridge = 0.0062 + 0.0030 * min(1.0, t_bridge)
                if t_bridge <= 1.0:
                    proj = 0.0045 + 0.0185 * (t_bridge ** 0.86)
                else:
                    u_under = (t_bridge - 1.0) / 0.26
                    proj = 0.0230 * (math.cos(u_under * math.pi * 0.5) ** 1.25)
                y -= proj * _gauss(x, w_bridge) * f_env

            tip_lobe = _gauss(x, 0.0068) * _gauss(z - 1.5735, 0.0052) * 0.0048
            ala = _gauss(ax - 0.0115, 0.0044) * _gauss(z - 1.5695, 0.0040) * 0.0086
            alar_crease = _gauss(ax - 0.0165, 0.0022) * _gauss(z - 1.5700, 0.0048) * (-0.0028)
            nostril = _gauss(ax - 0.0064, 0.0028) * _gauss(z - 1.5655, 0.0020) * (-0.0048)
            y -= (tip_lobe + ala + alar_crease + nostril) * f_env

        # 4) Philtrum + FULLER SCULPTED EXPRESSIVE LIPS at z_mid = 1.5425 (1.6cm philtrum!)
        if ax < 0.036 and 1.518 < z < 1.565:
            phil_dimple = _gauss(x, 0.0034) * _gauss(z - 1.556, 0.0055) * (-0.0022)
            phil_pillar = _gauss(ax - 0.0056, 0.0022) * _gauss(z - 1.555, 0.0055) * 0.0018
            y -= (phil_dimple + phil_pillar) * f_env

            mx_n = x / 0.0258
            if abs(mx_n) < 1.15:
                m_env = max(0.0, 1.0 - (mx_n * mx_n))
                m_soft = m_env ** 0.62
                z_mid = 1.5425 - 0.0007 * _gauss(x, 0.007) + 0.0010 * (mx_n * mx_n)
                cupid = 0.0018 * _gauss(ax - 0.0058, 0.0040)
                up_lip = _gauss(z - (z_mid + 0.0038 + cupid), 0.0034) * m_soft * 0.0094
                lo_lip = _gauss(z - (z_mid - 0.0046), 0.0042) * m_soft * 0.0102
                lip_part = _gauss(z - z_mid, 0.0015) * _smoothstep(1.02, 0.85, abs(mx_n)) * (-0.0052)
                corner_tuck = _gauss(ax - 0.0255, 0.0042) * _gauss(z - (z_mid + 0.001), 0.0042) * (-0.0048)
                labio = _gauss(x, 0.017) * _gauss(z - 1.526, 0.0052) * (-0.0048)
                y -= (up_lip + lo_lip + lip_part + corner_tuck + labio) * f_env

    return (x, y, z)


def build_head_and_face(cb: CharacterBuilder, mats: Dict[str, bpy.types.Material]) -> None:
    """Build sculpted head/neck, deeply recessed glossy eyeballs, dedicated 3D hooded eyelids, ears & earpiece."""
    # Optimized non-uniform Z spacing: crisp around lips/nose/brows, clean elsewhere (~2,300 tris total!)
    z_samples = sorted(
        list(np.linspace(1.408, 1.488, 8, endpoint=False))   # silky smooth neck in extreme close-up!
        + list(np.linspace(1.488, 1.526, 5, endpoint=False))
        + list(np.linspace(1.526, 1.562, 8, endpoint=False))
        + list(np.linspace(1.562, 1.592, 6, endpoint=False))
        + list(np.linspace(1.592, 1.626, 7, endpoint=False))
        + list(np.linspace(1.626, 1.664, 4, endpoint=False))
        + list(np.linspace(1.664, 1.709, 4))
    )

    front_phis = list(np.linspace(-1.16, 1.16, 27))
    back_right = list(np.linspace(-math.pi, -1.16, 5, endpoint=False))
    back_left = list(np.linspace(1.16, math.pi, 5, endpoint=True))[1:-1]
    phi_samples = back_right + front_phis + back_left  # 35 columns around head

    rings = []
    uv_rings = []
    for z in z_samples:
        row = []
        uv_row = []
        for phi in phi_samples:
            pt = _eval_head_neck_surface(phi, z, include_orbit_recess=True)
            row.append(pt)
            uv_row.append(head_uv_from_phi_z(phi, z))
        uv_row.append((1.0, head_uv_from_phi_z(math.pi, z)[1]))
        rings.append(row)
        uv_rings.append(uv_row)

    cb.add_grid(rings, uv_rings, mats["skin"], part="head_neck", closed_u=True, smooth=True, cap_start=False, cap_end=True)

    # ---- Deeply Seated Glossy Eyeballs + Dedicated 3D Sculpted Hooded Upper & Lower Eyelid Shells ----
    for sx in (-1.0, 1.0):
        ex = sx * EYE_X
        ey = EYE_Y
        ez = EYE_Z
        r_eye = EYE_R

        # 1) Realistic Glossy Eyeball with 100% anatomically accurate 11.6mm iris UV scale!
        n_rings, n_segs = 8, 14
        e_rings = []
        e_uvs = []
        for ri in range(1, n_rings):
            alpha = (ri / float(n_rings)) * math.pi * 0.56
            sa = math.sin(alpha)
            ca = math.cos(alpha)
            row = []
            uv_row = []
            for si in range(n_segs):
                th = 2.0 * math.pi * si / n_segs
                lx = r_eye * sa * math.cos(th)
                lz = r_eye * sa * math.sin(th)
                ly = -r_eye * ca
                row.append((ex + lx, ey + ly, ez + lz))
                rad_uv = min(0.492, (alpha / 0.534) * 0.395)
                uv_row.append((0.5 + rad_uv * math.cos(th), 0.5 + rad_uv * math.sin(th)))
            uv_row.append(uv_row[0])
            e_rings.append(row)
            e_uvs.append(uv_row)
        cb.add_grid(e_rings, e_uvs, mats["eye"], part="head", closed_u=True, smooth=True, cap_start=True, cap_end=False)

        # 2) Dedicated Sculpted 3D Upper & Lower Eyelid Shells (flush blend into cheek — ZERO baggy seam!)
        n_h = 11
        up_rows = [[] for _ in range(5)]
        up_uvs = [[] for _ in range(5)]
        lo_rows = [[] for _ in range(4)]
        lo_uvs = [[] for _ in range(4)]

        for k in range(n_h):
            t_x = -1.0 + 2.0 * (k / float(n_h - 1))
            dx = t_x * 0.0155
            wx = ex + dx
            z_up, z_lo = _eyelid_z_curves(dx, sx)
            corner_fade = math.cos(t_x * math.pi * 0.48)
            phi_x = math.atan2(wx, 0.074)

            def _eye_front_y(x_p: float, z_p: float, offset_r: float) -> float:
                r_eff = r_eye + offset_r
                d2 = (x_p - ex) ** 2 + (z_p - ez) ** 2
                return ey - math.sqrt(max(0.0, r_eff * r_eff - min(d2, (r_eff * 0.96) ** 2)))

            y_rim_in = _eye_front_y(wx, z_up, 0.0004)
            y_rim_out = _eye_front_y(wx, z_up + 0.0005, 0.0020)
            y_mid_lid = _eye_front_y(wx, z_up + 0.0032 * (0.45 + 0.55 * corner_fade), 0.0024)
            z_crease = z_up + 0.0062 * (0.40 + 0.60 * corner_fade)
            y_crease = _eye_front_y(wx, z_crease, 0.0012) + 0.0015 * corner_fade
            z_blend = z_up + 0.0102 * (0.45 + 0.55 * corner_fade)
            _, y_face_b, _ = _eval_head_neck_surface(phi_x, z_blend, include_orbit_recess=True)

            u_pts = [
                (wx, y_rim_in + 0.0012, z_up - 0.0002),
                (wx, y_rim_out, z_up + 0.0004),
                (wx, y_mid_lid, z_up + 0.0032 * (0.45 + 0.55 * corner_fade)),
                (wx, y_crease, z_crease),
                (wx, y_face_b + 0.0004, z_blend),
            ]
            for ri, pt in enumerate(u_pts):
                up_rows[ri].append(pt)
                up_uvs[ri].append(head_uv_from_phi_z(phi_x, pt[2]))

            # Smooth slim lower eyelid tapering seamlessly into cheek
            y_lo_in = _eye_front_y(wx, z_lo, 0.0004)
            y_lo_out = _eye_front_y(wx, z_lo - 0.0003, 0.0015)
            z_lo_mid = z_lo - 0.0028 * (0.40 + 0.60 * corner_fade)
            _, y_face_m, _ = _eval_head_neck_surface(phi_x, z_lo_mid, include_orbit_recess=True)
            z_lo_b = z_lo - 0.0072 * (0.45 + 0.55 * corner_fade)
            _, y_face_lo, _ = _eval_head_neck_surface(phi_x, z_lo_b, include_orbit_recess=True)

            l_pts = [
                (wx, y_lo_in + 0.0012, z_lo + 0.0002),
                (wx, y_lo_out, z_lo - 0.0004),
                (wx, 0.45 * y_lo_out + 0.55 * y_face_m + 0.0004, z_lo_mid),
                (wx, y_face_lo + 0.0004, z_lo_b),
            ]
            for ri, pt in enumerate(l_pts):
                lo_rows[ri].append(pt)
                lo_uvs[ri].append(head_uv_from_phi_z(phi_x, pt[2]))

        cb.add_grid(up_rows, up_uvs, mats["skin"], part="head", closed_u=False, smooth=True)
        cb.add_grid(lo_rows, lo_uvs, mats["skin"], part="head", closed_u=False, smooth=True, flip=True)

        # 3) Delicate Dark Espresso Upper Eyelash Fringe tucked cleanly along upper lid margin!
        lash_root = []
        lash_tip = []
        for k in range(1, n_h - 1):
            p_edge = up_rows[1][k]
            t_x = -1.0 + 2.0 * (k / float(n_h - 1))
            outer_boost = 0.75 + 0.55 * max(0.0, t_x * sx)
            lash_root.append((p_edge[0], p_edge[1] + 0.0003, p_edge[2] - 0.0003))
            lash_tip.append((p_edge[0] + sx * 0.0005, p_edge[1] - 0.0022 * outer_boost, p_edge[2] + 0.0009 * outer_boost))
        cb.add_grid([lash_root, lash_tip], None, mats["lash"], part="head", closed_u=False, smooth=True)

    # ---- Sculpted 3D Anatomical Ears (sleek, tucked naturally against head!) ----
    for sx in (-1.0, 1.0):
        ear_center = Vector((sx * 0.0705, 0.011, 1.584))
        rim_pts = [
            (0.002, 0.021), (0.010, 0.027), (0.019, 0.024), (0.023, 0.013),
            (0.022, -0.002), (0.018, -0.016), (0.010, -0.025), (0.002, -0.022),
            (-0.002, -0.011), (-0.003, 0.000), (-0.001, 0.010),
        ]
        layers = [
            (0.95, 0.000, 0.0),
            (1.02, 0.006, 0.002),
            (0.98, 0.010, 0.002),
            (0.82, 0.008, 0.001),
            (0.55, 0.003, -0.002),
        ]
        ear_rings = []
        ear_uvs = []
        for scale_r, out_x, y_shift in layers:
            row = []
            uv_row = []
            for py, pz in rim_pts:
                flare = max(0.0, py / 0.024) * 0.005
                row.append((ear_center.x + sx * (out_x + flare * scale_r), ear_center.y + py * scale_r + y_shift, ear_center.z + pz * scale_r))
                uv_row.append((0.5 + sx * 0.24, 0.56 + pz * 1.4))
            uv_row.append(uv_row[0])
            ear_rings.append(row)
            ear_uvs.append(uv_row)
        cb.add_grid(ear_rings, ear_uvs, mats["skin"], part="head", closed_u=True, smooth=True, cap_end=True, flip=(sx < 0))

    # ---- Sleek Black Tactical Comm Earpiece in LEFT Ear (+X, matching 35mm portrait_mara.webp!) ----
    cb.add_cylinder((0.0755, 0.012, 1.580), 0.0048, 0.0040, 0.007, mats["earpiece_dark"], part="head", segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    cb.add_cylinder((0.0790, 0.012, 1.580), 0.0034, 0.0028, 0.003, mats["gunmetal"], part="head", segments=10, rot=(0.0, math.pi * 0.5, 0.0))


def build_layered_hair(cb: CharacterBuilder, mats: Dict[str, bpy.types.Material]) -> None:
    """Build smooth, silky, natural espresso-chestnut pulled-back hair + low messy bun + soft framing tendrils."""
    mat_hair = mats["hair"]

    # 1) Smooth Sculpted Cranial Hair Base Shell (soft layered crown volume, slight off-center part!)
    n_rings = 16
    n_segs = 32
    cap_rings = []
    cap_uvs = []
    for ri in range(n_rings):
        t = ri / float(n_rings - 1)
        row = []
        uv_row = []
        for si in range(n_segs):
            phi = -math.pi + (2.0 * math.pi * si) / n_segs
            cp = math.cos(phi)
            if cp > 0.0:
                # Natural softly arched forehead hairline dipping slightly at temples
                z_edge = 1.608 + 0.048 * (cp ** 0.72) + 0.005 * math.sin(phi * 1.6)
            else:
                z_edge = 1.608 - 0.092 * ((-cp) ** 0.85)
            z = z_edge + t * (1.716 - z_edge)
            sx, sy, sz = _eval_head_neck_surface(phi, min(1.707, z), include_orbit_recess=False)

            # Soft realistic crown hair lift (tapered flush into hairline, fuller over upper crown & back!)
            vol_lift = (0.005 + 0.014 * math.sin(t * math.pi * 0.82)) * (1.0 + 0.25 * max(0.0, -cp))
            # Soft off-center parting groove matching 35mm portrait_mara.webp (x ~ +0.014)
            part_dip = _gauss(sx - 0.014, 0.011) * _smoothstep(0.12, 0.72, t) * max(0.0, cp) * (-0.0065)
            # Gentle organic swept-hair contour undulations (smooth low-frequency waves, ZERO harsh zigzags!)
            wave = 0.0020 * math.sin(phi * 10.0 + t * 1.8) * math.sin(t * math.pi)
            d_out = max(0.002, vol_lift + part_dip + wave)

            radial = Vector((sx, sy - 0.010, sz - 1.602))
            if radial.length > 1e-5:
                radial.normalize()
            pt = Vector((sx, sy, sz)) + radial * d_out
            row.append((pt.x, pt.y, pt.z))
            # Map V along hair sweep direction (front-to-back & crown-to-nape) so real hair strands align naturally!
            uv_row.append((((phi + math.pi) / (2.0 * math.pi)) * 2.5, 1.0 - t * 0.85))
        uv_row.append((2.5, 1.0 - t * 0.85))
        cap_rings.append(row)
        cap_uvs.append(uv_row)
    cb.add_grid(cap_rings, cap_uvs, mat_hair, part="head", closed_u=True, smooth=True, cap_end=True)

    # 2) 12 Smooth, Broad Overlapping Swept Hair Locks flowing cleanly back into the low bun (economical & sleek!)
    bun_center = Vector((0.0, 0.106, 1.552))
    for i in range(12):
        side = -1.0 if i < 6 else 1.0
        k = (i % 6) / 5.0
        phi0 = side * (0.16 + k * 1.36)
        z0 = 1.664 - k * 0.060 + (0.006 if (side < 0 and k < 0.35) else 0.0)
        pts = []
        outs = []
        widths = []
        thicks = []
        n_steps = 11
        for s in range(n_steps):
            u = s / float(n_steps - 1)
            phi_target = side * (math.pi - 0.14 * (1.0 - k * 0.4))
            phi = phi0 + (phi_target - phi0) * (u ** 0.90)
            z_arc = z0 * (1.0 - u) + (bun_center.z + 0.020 * (0.5 - k)) * u + 0.030 * math.sin(u * math.pi) * (1.0 - 0.50 * k)
            hx, hy, hz = _eval_head_neck_surface(phi, max(1.505, min(1.705, z_arc)), include_orbit_recess=False)
            out_v = Vector((hx, hy - 0.010, hz - 1.602)).normalized()
            lift = 0.007 + 0.010 * math.sin(u * math.pi)
            if s == n_steps - 1:
                p = bun_center + Vector((side * 0.016 * (0.4 + k * 0.5), -0.014, (0.5 - k) * 0.018))
            else:
                p = Vector((hx, hy, hz)) + out_v * lift
            pts.append(p)
            outs.append(out_v)
            widths.append(0.026 * (0.60 + 0.50 * math.sin(u * math.pi)))
            thicks.append(0.0058 * (0.50 + 0.55 * math.sin(u * math.pi)))
        cb.add_hair_ribbon(pts, widths, thicks, outs, mat_hair, part="head", u_offset=(i * 0.17) % 1.0)

    # 3) Soft Tousled Low Nape Bun (6 smooth braided coils tucked gracefully at lower nape!)
    for c_idx in range(6):
        ang0 = (c_idx / 6.0) * 2.0 * math.pi
        tilt = (c_idx % 3 - 1) * 0.32
        r_bun = 0.030 + 0.011 * ((c_idx % 3) / 2.0)
        pts = []
        outs = []
        widths = []
        thicks = []
        for s in range(9):
            u = s / 8.0
            ang = ang0 + u * math.pi * 1.45
            rad = r_bun * (0.85 + 0.22 * math.sin(u * math.pi))
            lx = math.cos(ang) * rad * 1.15
            lz = math.sin(ang) * rad * 0.88
            ly = math.sin(ang * 1.5 + tilt) * 0.016 + 0.012 * math.sin(u * math.pi)
            p = bun_center + Vector((lx, ly, lz))
            out_v = (p - (bun_center - Vector((0.0, 0.025, 0.0)))).normalized()
            pts.append(p)
            outs.append(out_v)
            widths.append(0.019 * (0.55 + 0.55 * math.sin(u * math.pi)))
            thicks.append(0.0075 * (0.55 + 0.50 * math.sin(u * math.pi)))
        cb.add_hair_ribbon(pts, widths, thicks, outs, mat_hair, part="head", u_offset=(c_idx * 0.23) % 1.0)

    # 4) Rounded Asymmetric Side-Part Sweeping Framing Locks (hug forehead/temples gracefully — ZERO tent peak!)
    tendril_specs = [
        # Right-side sweeping fringe curving ROUNDED over right forehead -> temple -> soft tuck behind jaw!
        [
            (0.014, -0.068, 1.668),
            (-0.010, -0.078, 1.664),
            (-0.038, -0.075, 1.650),
            (-0.060, -0.058, 1.622),
            (-0.069, -0.036, 1.588),
            (-0.065, -0.018, 1.554),
            (-0.056, -0.008, 1.528),
        ],
        # Second right wispy temple curl tucking softly near ear
        [
            (-0.030, -0.072, 1.656),
            (-0.058, -0.058, 1.628),
            (-0.071, -0.032, 1.594),
            (-0.069, -0.010, 1.560),
        ],
        # Left-side (+X) gentle curved side-sweep parting smoothly over left temple -> ear!
        [
            (0.018, -0.068, 1.668),
            (0.042, -0.072, 1.654),
            (0.062, -0.056, 1.626),
            (0.070, -0.034, 1.592),
            (0.066, -0.014, 1.556),
            (0.056, -0.004, 1.528),
        ],
        # Delicate loose left cheek wisp (signature portrait_mara detail!)
        [
            (0.044, -0.064, 1.646),
            (0.064, -0.050, 1.616),
            (0.067, -0.034, 1.582),
            (0.060, -0.024, 1.552),
        ],
        # Soft loose nape bun ends
        [(-0.030, 0.110, 1.546), (-0.042, 0.122, 1.532), (-0.044, 0.124, 1.514)],
        [(0.026, 0.112, 1.544), (0.038, 0.124, 1.530), (0.040, 0.126, 1.512)],
    ]
    for ti, tpts in enumerate(tendril_specs):
        n = len(tpts)
        ws = [0.0095 * (1.0 - 0.72 * (k / float(n - 1))) for k in range(n)]
        ths = [0.0032 * (1.0 - 0.68 * (k / float(n - 1))) for k in range(n)]
        outs = [Vector((p[0], p[1] - 0.005, p[2] - 1.60)).normalized() for p in tpts]
        cb.add_hair_ribbon(tpts, ws, ths, outs, mat_hair, part="head", u_offset=(0.31 + ti * 0.19) % 1.0)


def _eval_jacket_surface(phi: float, z: float) -> Tuple[float, float, float]:
    """V2 Tailored matte charcoal leather-tech field jacket with natural sloping female shoulders!"""
    sp = math.sin(phi)
    cp = math.cos(phi)

    # Natural athletic female sloping shoulder curve (eliminates V1 boxy shoulder-pad look!)
    stations = [
        (0.855, 0.172, 0.106, 0.114, 0.007),  # jacket lower hem around hips
        (0.925, 0.162, 0.100, 0.108, 0.008),  # upper hip
        (1.015, 0.132, 0.088, 0.092, 0.011),  # cinched athletic waist
        (1.095, 0.138, 0.096, 0.095, 0.009),  # lower ribcage
        (1.185, 0.154, 0.118, 0.103, 0.006),  # under-bust / mid-chest
        (1.255, 0.162, 0.129, 0.108, 0.006),  # bust apex
        (1.335, 0.172, 0.108, 0.110, 0.011),  # upper chest / shoulder yoke
        (1.368, 0.170, 0.094, 0.100, 0.014),  # full rounded shoulder cap (flush over sleeve top — ZERO step notch!)
        (1.398, 0.132, 0.080, 0.086, 0.016),  # natural sloping trapezius!
        (1.425, 0.082, 0.068, 0.074, 0.017),  # neckline base
    ]

    if z <= stations[0][0]:
        rx, ryf, ryb, cy = stations[0][1:]
    elif z >= stations[-1][0]:
        rx, ryf, ryb, cy = stations[-1][1:]
    else:
        for i in range(len(stations) - 1):
            z0 = stations[i][0]
            z1 = stations[i + 1][0]
            if z0 <= z <= z1:
                t = (z - z0) / (z1 - z0)
                t = t * t * (3.0 - 2.0 * t)
                rx = stations[i][1] + (stations[i + 1][1] - stations[i][1]) * t
                ryf = stations[i][2] + (stations[i + 1][2] - stations[i][2]) * t
                ryb = stations[i][3] + (stations[i + 1][3] - stations[i][3]) * t
                cy = stations[i][4] + (stations[i + 1][4] - stations[i][4]) * t
                break

    front_w = 0.5 * (1.0 + cp)
    ry = ryb * (1.0 - front_w) + ryf * front_w

    # Natural athletic female bust shaping
    if cp > 0.15 and 1.15 < z < 1.34:
        f_w = _smoothstep(0.15, 0.55, cp)
        bust_z = _gauss(z - 1.242, 0.044)
        ry += (0.015 * (_gauss(phi - 0.42, 0.34) + _gauss(phi + 0.42, 0.34)) - 0.008 * _gauss(phi, 0.16)) * bust_z * f_w

    # Subtle spine hollow along back
    if cp < -0.25 and 0.94 < z < 1.36:
        ry += _gauss(abs(phi) - math.pi, 0.18) * (-0.007) * _smoothstep(-0.25, -0.65, cp)

    # Subtle natural waist cloth folds + princess seam piping ridges
    waist_fold = (
        0.0025 * math.sin((z - 1.02) * 145.0 + phi * 2.0) * _gauss(z - 1.03, 0.055)
        + 0.0018 * math.sin((z - 0.90) * 120.0 - phi * 3.0) * _gauss(z - 0.91, 0.04)
    )
    seam_ridge = _gauss(abs(phi) - 0.54, 0.055) * _smoothstep(0.87, 0.91, z) * _smoothstep(1.36, 1.32, z) * 0.0022

    x = (rx + waist_fold + seam_ridge) * sp
    y = cy - (ry + waist_fold + seam_ridge) * cp
    return (x, y, z)


def build_torso_and_jacket(cb: CharacterBuilder, mats: Dict[str, bpy.types.Material]) -> None:
    """Build midnight-navy ribbed merino turtleneck + fitted matte charcoal field jacket + collar/lapels/zipper."""
    # 1) Ribbed Midnight-Navy Turtleneck (iconic folded ribbed neck rising cleanly to z=1.478 like portrait_mara!)
    tn_z = list(np.linspace(1.18, 1.478, 14))
    tn_rings = []
    tn_uvs = []
    n_u = 20
    for iz, z in enumerate(tn_z):
        row = []
        uv_row = []
        v = iz / float(len(tn_z) - 1)
        for iu in range(n_u):
            phi = -math.pi + 2.0 * math.pi * iu / n_u
            if z >= 1.408:
                hx, hy, _ = _eval_head_neck_surface(phi, z, include_orbit_recess=False)
                t_col = (z - 1.408) / 0.070
                fold_bulge = 0.0072 + 0.0062 * math.sin(t_col * math.pi)
                rad = Vector((hx, hy - 0.018, 0.0))
                if rad.length > 1e-5:
                    rad.normalize()
                pt = (hx + rad.x * fold_bulge, hy + rad.y * fold_bulge, z)
            else:
                jx, jy, _ = _eval_jacket_surface(phi, z)
                pt = (jx * 0.91, jy * 0.91 + 0.004, z)
            row.append(pt)
            uv_row.append((iu / float(n_u), v))
        uv_row.append((1.0, v))
        tn_rings.append(row)
        tn_uvs.append(uv_row)
    cb.add_grid(tn_rings, tn_uvs, mats["turtleneck"], part="chest_neck", closed_u=True, smooth=True)

    # 2) Matte Charcoal Leather-Tech Jacket Body (with clean V-placket revealing navy turtleneck)
    jk_z = list(np.linspace(0.855, 1.425, 20))
    n_u = 32
    jk_rings = []
    jk_uvs = []
    for iz, z in enumerate(jk_z):
        row = []
        uv_row = []
        v = (z - 0.855) / (1.425 - 0.855)
        v_open_phi = 0.0
        if z > 1.235:
            v_open_phi = 0.58 * ((z - 1.235) / (1.425 - 1.235)) ** 0.82
        for iu in range(n_u):
            t_u = iu / float(n_u - 1)
            phi_raw = v_open_phi + t_u * (2.0 * math.pi - 2.0 * v_open_phi)
            phi = phi_raw if phi_raw <= math.pi else phi_raw - 2.0 * math.pi
            row.append(_eval_jacket_surface(phi, z))
            uv_row.append((t_u * 2.0, v * 1.4))
        jk_rings.append(row)
        jk_uvs.append(uv_row)
    cb.add_grid(jk_rings, jk_uvs, mats["jacket"], part="torso", closed_u=False, smooth=True)

    # Rolled lower jacket hem trim
    hem_pts = []
    for iu in range(28):
        phi = -math.pi + 2.0 * math.pi * iu / 28.0
        px, py, pz = _eval_jacket_surface(phi, 0.858)
        hem_pts.append((px * 1.005, py * 1.005, pz))
    hem_pts.append(hem_pts[0])
    cb.add_tube(hem_pts, 0.0052, mats["jacket_trim"], part="torso", segments=6, cap_start=False, cap_end=False)

    # 3) Standing Popped Field-Jacket Collar (flaring cleanly around turtleneck!)
    col_phis = list(np.linspace(0.56, 2.0 * math.pi - 0.56, 18))
    col_outer = []
    col_inner = []
    for iz, (zc, flare) in enumerate([(1.410, 0.008), (1.450, 0.020), (1.490, 0.030)]):
        ro = []
        ri = []
        for phi_r in col_phis:
            phi = phi_r if phi_r <= math.pi else phi_r - 2.0 * math.pi
            back_boost = 0.011 * max(0.0, -math.cos(phi)) * (iz / 2.0)
            z_cur = zc + back_boost
            rx = 0.068 + flare + 0.014 * (abs(math.sin(phi)) ** 1.5)
            ry = 0.068 + flare
            cy = 0.017
            ro.append((rx * math.sin(phi), cy - ry * math.cos(phi), z_cur))
            ri.append(((rx - 0.005) * math.sin(phi), cy - (ry - 0.005) * math.cos(phi), z_cur))
        col_outer.append(ro)
        col_inner.append(ri)

    cb.add_grid(
        [col_outer[0], col_outer[1], col_outer[2], col_inner[2], col_inner[1], col_inner[0]],
        None, mats["jacket"], part="chest_collar", closed_u=False, smooth=True,
    )

    # Structured Notched Lapels + Metallic Snap Buttons + Sloped Shoulder Epaulettes!
    for sx in (-1.0, 1.0):
        lap_outer = []
        lap_inner = []
        specs = [
            (1.245, 0.012, 0.026, 0.006),
            (1.302, 0.024, 0.072, 0.010),
            (1.362, 0.042, 0.094, 0.012),
            (1.414, 0.054, 0.084, 0.011),
        ]
        for z_l, x_in, x_out, lift in specs:
            p_in = _eval_jacket_surface(sx * math.atan2(x_in, 0.112), z_l)
            p_out = _eval_jacket_surface(sx * math.atan2(x_out, 0.112), z_l)
            lap_outer.append([
                (sx * x_in, p_in[1] - 0.004, z_l),
                (sx * 0.5 * (x_in + x_out), 0.5 * (p_in[1] + p_out[1]) - lift - 0.004, z_l),
                (sx * x_out, p_out[1] - lift - 0.003, z_l),
            ])
            lap_inner.append([
                (sx * x_in, p_in[1] + 0.001, z_l),
                (sx * 0.5 * (x_in + x_out), 0.5 * (p_in[1] + p_out[1]) - lift + 0.001, z_l),
                (sx * x_out, p_out[1] - lift + 0.002, z_l),
            ])
        cb.add_grid(lap_outer, None, mats["jacket_trim"], part="chest_collar", closed_u=False, smooth=True, flip=(sx < 0))
        cb.add_grid(lap_inner, None, mats["jacket"], part="chest_collar", closed_u=False, smooth=True, flip=(sx > 0))
        cb.add_tube([row[2] for row in lap_outer], 0.0030, mats["jacket_trim"], part="chest_collar", segments=5)

        snap_p = lap_outer[2][2]
        cb.add_cylinder(
            (snap_p[0] - sx * 0.011, snap_p[1] - 0.004, snap_p[2] - 0.004),
            0.0058, 0.0052, 0.0035, mats["gunmetal"], part="chest_collar", segments=10, rot=(math.pi * 0.5, 0.0, 0.0)
        )

        # Sloped natural shoulder epaulette strap hugging trapezius curve!
        ep_pts = [
            (sx * 0.080, 0.014, 1.414),
            (sx * 0.116, 0.015, 1.396),
            (sx * 0.154, 0.015, 1.376),
        ]
        cb.add_tube(ep_pts, [(0.015, 0.0035), (0.016, 0.0035), (0.014, 0.0035)], mats["jacket_trim"], part="chest_collar", segments=6, twist_hint=Vector((0, 0, 1)))
        cb.add_cylinder((sx * 0.090, 0.014, 1.415), 0.0050, 0.0046, 0.0035, mats["gunmetal"], part="chest_collar", segments=8)

    # 4) Vertical Brushed-Gunmetal Front Zipper Track + Slider Pull
    zip_pts = [_eval_jacket_surface(0.0, z) for z in np.linspace(0.865, 1.240, 9)]
    zip_pts = [(p[0], p[1] - 0.0035, p[2]) for p in zip_pts]
    cb.add_tube(zip_pts, (0.0052, 0.0026), mats["gunmetal"], part="torso", segments=6, twist_hint=Vector((0, -1, 0)))
    top_z = zip_pts[-1]
    cb.add_beveled_box((top_z[0], top_z[1] - 0.004, top_z[2] - 0.008), (0.010, 0.007, 0.015), mats["gunmetal"], part="torso", bevel=0.002, segments=1)
    cb.add_beveled_box((top_z[0], top_z[1] - 0.007, top_z[2] - 0.024), (0.006, 0.003, 0.016), mats["gunmetal"], part="torso", rot=(0.15, 0.0, 0.0), bevel=0.001, segments=1)

    # 5) Angled Zippered Welt Pockets
    for sx in (-1.0, 1.0):
        p0 = _eval_jacket_surface(sx * 0.62, 0.945)
        p1 = _eval_jacket_surface(sx * 0.96, 1.005)
        cb.add_tube([(p0[0], p0[1] - 0.004, p0[2]), (p1[0], p1[1] - 0.004, p1[2])], (0.0052, 0.0032), mats["jacket_trim"], part="torso", segments=6)
        cb.add_cylinder((p0[0], p0[1] - 0.006, p0[2] - 0.004), 0.0030, 0.0026, 0.009, mats["gunmetal"], part="torso", segments=6)

    cp0 = _eval_jacket_surface(0.44, 1.275)
    cp1 = _eval_jacket_surface(0.76, 1.285)
    cb.add_tube([(cp0[0], cp0[1] - 0.004, cp0[2]), (cp1[0], cp1[1] - 0.004, cp1[2])], (0.0038, 0.0026), mats["gunmetal"], part="torso", segments=6)

    # 6) Fitted Dark Leather Tactical Belt + Brushed Gunmetal Buckle
    belt_pts = []
    for iu in range(26):
        phi = -math.pi + 2.0 * math.pi * iu / 26.0
        px, py, _ = _eval_jacket_surface(phi, 0.875)
        belt_pts.append((px * 0.97, py * 0.97, 0.872))
    belt_pts.append(belt_pts[0])
    cb.add_tube(belt_pts, (0.007, 0.018), mats["leather_dark"], part="hips", segments=6, twist_hint=Vector((0, 0, 1)), cap_start=False, cap_end=False)
    cb.add_beveled_box((0.0, -0.104, 0.872), (0.042, 0.011, 0.034), mats["gunmetal"], part="hips", bevel=0.0025, segments=1)


def build_sleeves_and_gloved_hands(cb: CharacterBuilder, mats: Dict[str, bpy.types.Material]) -> None:
    """Build naturally sloped sleeves with elbow folds, cuffs, Securion watch, and 5-finger gloved hands."""
    for sx, side_tag in ((1.0, "L"), (-1.0, "R")):
        arm_part = f"arm_{side_tag}"
        hand_part = f"hand_{side_tag}"

        # Natural sloping female shoulder pivot flush inside jacket shoulder yoke (ZERO rear notch!)
        sh = Vector((sx * 0.166, 0.016, 1.352))
        el = Vector((sx * 0.248, 0.030, 1.112))
        wr = Vector((sx * 0.292, -0.022, 0.888))

        sh_in = Vector((sx * 0.118, 0.016, 1.356))
        spine_t = list(np.linspace(0.0, 1.0, 14))
        pts = []
        rads = []
        for t in spine_t:
            if t < 0.16:
                u = t / 0.16
                p = sh_in.lerp(sh, u)
                rx = 0.048 + 0.005 * u
                ry = 0.052 + 0.004 * u
            elif t < 0.56:
                u = (t - 0.16) / 0.40
                p = sh.lerp(el, u)
                rx = 0.053 - 0.010 * u + 0.003 * math.sin(u * math.pi)
                ry = 0.056 - 0.011 * u + 0.003 * math.sin(u * math.pi)
            else:
                u = (t - 0.56) / 0.44
                p = el.lerp(wr, u)
                rx = 0.043 - 0.009 * u + 0.0025 * math.sin(u * math.pi)
                ry = 0.045 - 0.010 * u + 0.0025 * math.sin(u * math.pi)
            pts.append(p)
            rads.append((rx, ry))

        rings = []
        uv_rings = []
        n_seg = 12
        prev_n: Optional[Vector] = None
        for i, p in enumerate(pts):
            t = spine_t[i]
            if i == 0:
                tang = (pts[1] - pts[0]).normalized()
            elif i == len(pts) - 1:
                tang = (pts[-1] - pts[-2]).normalized()
            else:
                tang = ((pts[i] - pts[i - 1]).normalized() + (pts[i + 1] - pts[i]).normalized()).normalized()
            if prev_n is None:
                nrm = tang.cross(Vector((0.0, -1.0, 0.0))).normalized()
            else:
                nrm = (prev_n - tang * prev_n.dot(tang)).normalized()
            binrm = tang.cross(nrm).normalized()
            prev_n = nrm

            rx, ry = rads[i]
            elbow_env = _gauss(t - 0.54, 0.085)
            cuff_env = _gauss(t - 0.88, 0.055)
            row = []
            uv_row = []
            for s in range(n_seg):
                ang = 2.0 * math.pi * s / n_seg
                ca, sa = math.cos(ang), math.sin(ang)
                fold = 0.0038 * math.sin(t * 76.0 + sa * 2.2) * elbow_env + 0.0020 * math.sin(t * 92.0) * cuff_env
                pt = p + nrm * (ca * (rx + fold)) + binrm * (sa * (ry + fold))
                row.append((pt.x, pt.y, pt.z))
                uv_row.append((s / float(n_seg), t * 1.6))
            uv_row.append((1.0, t * 1.6))
            rings.append(row)
            uv_rings.append(uv_row)
        cb.add_grid(rings, uv_rings, mats["jacket"], part=arm_part, closed_u=True, smooth=True, cap_end=True)

        arm_dir = (wr - el).normalized()
        cb.add_tube([wr - arm_dir * 0.040, wr - arm_dir * 0.002], [(0.037, 0.039), (0.035, 0.037)], mats["jacket_trim"], part=arm_part, segments=12)

        # Sleek matte-titanium Securion wrist diagnostic unit on Left wrist (+X)
        if side_tag == "L":
            watch_c = wr + arm_dir * 0.004
            cb.add_tube([watch_c - arm_dir * 0.010, watch_c + arm_dir * 0.010], (0.033, 0.034), mats["leather_dark"], part=hand_part, segments=10)
            cb.add_beveled_box(
                (watch_c.x + 0.023, watch_c.y - 0.015, watch_c.z),
                (0.012, 0.026, 0.030), mats["gunmetal"], part=hand_part, rot=(0.20, -0.18, 0.45), bevel=0.0025, segments=1
            )
            cb.add_beveled_box(
                (watch_c.x + 0.028, watch_c.y - 0.018, watch_c.z),
                (0.004, 0.017, 0.020), mats["cyan_led"], part=hand_part, rot=(0.20, -0.18, 0.45), bevel=0.001, segments=1
            )

        # ---- Articulated 5-Finger Leather-Gloved Hand ----
        down = (Vector((sx * 0.308, -0.045, 0.736)) - wr).normalized()
        fwd_raw = Vector((0.0, -1.0, 0.0))
        fwd = (fwd_raw - down * fwd_raw.dot(down)).normalized()
        out = down.cross(fwd).normalized()
        if out.x * sx < 0.0:
            out = -out

        def h_pt(u_out: float, u_fwd: float, u_down: float) -> Vector:
            return wr + out * u_out + fwd * u_fwd + down * u_down

        cb.add_tube([h_pt(0.0, 0.0, -0.010), h_pt(0.0, 0.0, 0.014)], [(0.028, 0.031), (0.024, 0.033)], mats["leather_dark"], part=hand_part, segments=10)

        palm_stations = [
            (0.010, 0.015, 0.028, 0.000),
            (0.034, 0.016, 0.036, 0.002),
            (0.060, 0.015, 0.039, 0.001),
            (0.084, 0.012, 0.035, -0.001),
        ]
        p_rings = []
        for u_d, th_out, w_fwd, shift_out in palm_stations:
            row = []
            for s in range(10):
                ang = 2.0 * math.pi * s / 10.0
                ca, sa = math.cos(ang), math.sin(ang)
                o_val = ca * th_out * (1.12 if ca > 0 else 0.85) + shift_out
                pt = h_pt(o_val, sa * w_fwd, u_d)
                row.append((pt.x, pt.y, pt.z))
            p_rings.append(row)
        cb.add_grid(p_rings, None, mats["leather_dark"], part=hand_part, closed_u=True, smooth=True, cap_start=True, cap_end=True)

        # 4 Distinct Articulated Fingers (Index, Middle, Ring, Pinky)
        finger_specs = [
            (0.027, 0.070, 0.0078, 0.28),
            (0.009, 0.077, 0.0080, 0.34),
            (-0.009, 0.071, 0.0076, 0.40),
            (-0.025, 0.057, 0.0068, 0.46),
        ]
        for f_off, f_len, f_rad, curl in finger_specs:
            f_pts = []
            f_rads = []
            for k in range(4):
                u = k / 3.0
                curl_in = -(u * u) * curl * f_len * 0.72
                reach_d = 0.080 + u * f_len * (1.0 - 0.16 * u * curl)
                r_cur = f_rad * (1.0 - 0.28 * u)
                f_pts.append(h_pt(curl_in + 0.002 * (1.0 - u), f_off * (1.0 - 0.05 * u), reach_d))
                f_rads.append((r_cur * 0.92, r_cur))
            cb.add_tube(f_pts, f_rads, mats["leather_dark"], part=hand_part, segments=6)

        # Opposable Thumb
        thumb_pts = [
            h_pt(-0.004, 0.025, 0.030),
            h_pt(-0.014, 0.044, 0.054),
            h_pt(-0.022, 0.052, 0.078),
            h_pt(-0.025, 0.052, 0.096),
        ]
        cb.add_tube(thumb_pts, [0.011, 0.0094, 0.0080, 0.0064], mats["leather_dark"], part=hand_part, segments=6)


def build_trousers_and_boots(cb: CharacterBuilder, mats: Dict[str, bpy.types.Material]) -> None:
    """Build tailored dark tactical trousers with smooth hip/glute drape + detailed lace-up boots grounded at z=0.0000."""
    # Smooth inward-tucked bottom closure (no sharp 90-deg flat cap crease on back of glutes!)
    pel_stations = [
        (0.752, 0.125, 0.068, 0.078, 0.008),  # smoothly tucked inside upper thighs (zero rear normal break!)
        (0.782, 0.162, 0.088, 0.112, 0.009),
        (0.818, 0.171, 0.096, 0.120, 0.009),
        (0.858, 0.171, 0.098, 0.118, 0.008),
        (0.892, 0.164, 0.097, 0.112, 0.007),
        (0.925, 0.154, 0.094, 0.104, 0.007),
    ]
    p_rings = []
    p_uvs = []
    n_u = 22
    for iz, (z, rx, ryf, ryb, cy) in enumerate(pel_stations):
        row = []
        uv_row = []
        v = iz / float(len(pel_stations) - 1)
        for iu in range(n_u):
            phi = -math.pi + 2.0 * math.pi * iu / n_u
            cp, sp = math.cos(phi), math.sin(phi)
            fw = 0.5 * (1.0 + cp)
            ry = ryb * (1.0 - fw) + ryf * fw
            if cp < -0.2:
                ry += _gauss(abs(phi) - math.pi, 0.16) * (-0.010) * _smoothstep(-0.2, -0.6, cp)
            row.append((rx * sp, cy - ry * cp, z))
            uv_row.append((iu / float(n_u) * 2.0, v * 0.4))
        uv_row.append((2.0, v * 0.4))
        p_rings.append(row)
        p_uvs.append(uv_row)
    cb.add_grid(p_rings, p_uvs, mats["trousers"], part="hips", closed_u=True, smooth=True, cap_start=False)

    # 2) Tailored Left & Right Tactical Trouser Legs + Detailed Lace-Up Boots
    for sx, side_tag in ((1.0, "L"), (-1.0, "R")):
        leg_part = f"leg_{side_tag}"
        boot_part = f"boot_{side_tag}"

        leg_stations = [
            (0.845, 0.086, 0.008, 0.084, 0.086, 0.098),
            (0.768, 0.090, 0.005, 0.081, 0.084, 0.094),
            (0.665, 0.090, 0.002, 0.072, 0.075, 0.079),
            (0.555, 0.089, -0.002, 0.062, 0.065, 0.065),
            (0.472, 0.089, -0.006, 0.056, 0.062, 0.057),
            (0.405, 0.089, 0.002, 0.055, 0.055, 0.060),
            (0.320, 0.088, 0.010, 0.056, 0.055, 0.064),
            (0.240, 0.088, 0.012, 0.048, 0.048, 0.051),
            (0.195, 0.088, 0.012, 0.045, 0.046, 0.047),
        ]
        z_leg = list(np.linspace(0.195, 0.845, 16))
        n_seg = 14
        l_rings = []
        l_uvs = []
        for z in z_leg:
            for si in range(len(leg_stations) - 1):
                z1, cx1, cy1, rx1, ryf1, ryb1 = leg_stations[si]
                z0, cx0, cy0, rx0, ryf0, ryb0 = leg_stations[si + 1]
                if z0 <= z <= z1:
                    t = (z - z0) / (z1 - z0)
                    t = t * t * (3.0 - 2.0 * t)
                    cx = cx0 + (cx1 - cx0) * t
                    cy = cy0 + (cy1 - cy0) * t
                    rx = rx0 + (rx1 - rx0) * t
                    ryf = ryf0 + (ryf1 - ryf0) * t
                    ryb = ryb0 + (ryb1 - ryb0) * t
                    break
            row = []
            uv_row = []
            v = (z - 0.195) / (0.845 - 0.195)
            knee_fold = _gauss(z - 0.455, 0.032) * 0.0030 * math.sin(z * 160.0)
            ankle_stack = _gauss(z - 0.228, 0.025) * 0.0034 * math.sin(z * 190.0)
            for iu in range(n_seg):
                phi = -math.pi + 2.0 * math.pi * iu / n_seg
                cp, sp = math.cos(phi), math.sin(phi)
                fw = 0.5 * (1.0 + cp)
                ry = ryb * (1.0 - fw) + ryf * fw
                knee_dart = (_gauss(z - 0.515, 0.006) + _gauss(z - 0.425, 0.006)) * max(0.0, cp) * 0.0022
                outer_seam = _gauss(phi - sx * math.pi * 0.5, 0.12) * 0.0018
                fold_back = knee_fold * max(0.0, -cp) + ankle_stack
                row.append((sx * cx + (rx + outer_seam + fold_back) * sp, cy - (ry + knee_dart + fold_back) * cp, z))
                uv_row.append((iu / float(n_seg) * 1.4, v * 2.2))
            uv_row.append((1.4, v * 2.2))
            l_rings.append(row)
            l_uvs.append(uv_row)
        cb.add_grid(l_rings, l_uvs, mats["trousers"], part=leg_part, closed_u=True, smooth=True)

        # Sleek low-profile tactical thigh pocket (now properly dark trouser fabric thanks to bevel fix!)
        cb.add_beveled_box(
            (sx * 0.161, 0.008, 0.655), (0.010, 0.084, 0.102),
            mats["trousers"], part=leg_part, rot=(0.0, -sx * 0.06, 0.0), bevel=0.004, segments=1
        )
        cb.add_beveled_box(
            (sx * 0.164, 0.008, 0.698), (0.008, 0.086, 0.022),
            mats["jacket_trim"], part=leg_part, rot=(0.0, -sx * 0.06, 0.0), bevel=0.003, segments=1
        )

        # ---- Detailed Lace-Up Tactical Boot (Grounded STRICTLY at z = 0.0000!) ----
        bx = sx * 0.088
        shaft_z = [0.090, 0.130, 0.172, 0.212]
        shaft_rings = []
        for iz, z in enumerate(shaft_z):
            t = iz / 3.0
            rx = 0.045 + 0.006 * t
            ryf = 0.055 - 0.005 * t
            ryb = 0.051 + 0.001 * t
            row = []
            for s in range(14):
                phi = -math.pi + 2.0 * math.pi * s / 14.0
                cp, sp = math.cos(phi), math.sin(phi)
                ry = ryb * 0.5 * (1.0 - cp) + ryf * 0.5 * (1.0 + cp)
                row.append((bx + rx * sp, 0.010 - ry * cp, z - 0.009 * max(0.0, -cp) * t))
            shaft_rings.append(row)
        cb.add_grid(shaft_rings, None, mats["leather_dark"], part=boot_part, closed_u=True, smooth=True, cap_end=True)

        foot_slices = [
            (0.064, 0.032, 0.033, 0.027, 0.085),
            (0.038, 0.039, 0.041, 0.025, 0.096),
            (0.000, 0.041, 0.044, 0.025, 0.102),
            (-0.042, 0.042, 0.046, 0.025, 0.082),
            (-0.084, 0.045, 0.049, 0.025, 0.065),
            (-0.120, 0.041, 0.044, 0.026, 0.055),
            (-0.146, 0.028, 0.030, 0.028, 0.045),
            (-0.154, 0.012, 0.012, 0.031, 0.038),
        ]
        f_rings = []
        for y_s, w_in, w_out, zb, zt in foot_slices:
            row = []
            zc_f = 0.5 * (zb + zt)
            rz = 0.5 * (zt - zb)
            for s in range(12):
                ang = 2.0 * math.pi * s / 12.0
                ca, sa = math.cos(ang), math.sin(ang)
                w = w_out if (ca * sx) > 0.0 else w_in
                if sa < 0.0:
                    z_pt = zc_f + rz * sa * 0.96
                    x_pt = bx + w * ca * (0.94 + 0.06 * (1.0 + sa))
                else:
                    z_pt = zc_f + rz * (sa ** 0.85)
                    x_pt = bx + w * ca * (0.84 + 0.16 * (1.0 - sa))
                row.append((x_pt, y_s, z_pt))
            f_rings.append(row)
        cb.add_grid(f_rings, None, mats["leather_dark"], part=boot_part, closed_u=True, smooth=True, cap_start=True, cap_end=True)

        # Vulcanized Rubber Lug Outsole (FLAT AT z = 0.0000!)
        sole_slices = [
            (0.067, 0.036, 0.037, 0.0000, 0.029),
            (0.015, 0.041, 0.044, 0.0000, 0.028),
            (-0.012, 0.037, 0.041, 0.0085, 0.027),
            (-0.045, 0.044, 0.048, 0.0000, 0.027),
            (-0.088, 0.049, 0.052, 0.0000, 0.027),
            (-0.130, 0.042, 0.045, 0.0000, 0.028),
            (-0.154, 0.025, 0.026, 0.0040, 0.030),
        ]
        s_rings = []
        for y_s, w_in, w_out, zb, zt in sole_slices:
            x_lo = min(bx - sx * w_in, bx + sx * w_out)
            x_hi = max(bx - sx * w_in, bx + sx * w_out)
            s_rings.append([(x_hi, y_s, zb), (x_hi, y_s, zt), (x_lo, y_s, zt), (x_lo, y_s, zb)])
        cb.add_grid(s_rings, None, mats["rubber"], part=boot_part, closed_u=True, smooth=False, cap_start=True, cap_end=True)

        # Sole tread lugs (now properly matte black rubber!)
        for lug_y in (-0.122, -0.098, -0.074, -0.050, 0.028, 0.050):
            cb.add_beveled_box((bx, lug_y, 0.008), (0.096, 0.011, 0.014), mats["rubber"], part=boot_part, bevel=0.002, segments=1, smooth=False)

        # 3D Crisscross Boot Laces & Gunmetal Eyelets
        lace_levels = [
            (-0.080, 0.068, 0.023),
            (-0.062, 0.082, 0.022),
            (-0.047, 0.100, 0.022),
            (-0.043, 0.134, 0.023),
            (-0.041, 0.168, 0.024),
        ]
        for idx_l, (ly, lz, half_span) in enumerate(lace_levels):
            for ex_s in (-1.0, 1.0):
                cb.add_cylinder(
                    (bx + ex_s * half_span, ly - 0.002, lz),
                    0.0034, 0.0030, 0.003, mats["gunmetal"], part=boot_part, segments=6, rot=(math.pi * 0.4, 0.0, 0.0)
                )
            if idx_l < len(lace_levels) - 1:
                ny, nz, nspan = lace_levels[idx_l + 1]
                cb.add_tube([(bx - half_span, ly - 0.004, lz), (bx + nspan, ny - 0.004, nz)], 0.0020, mats["rubber"], part=boot_part, segments=4)
                cb.add_tube([(bx + half_span, ly - 0.004, lz), (bx - nspan, ny - 0.004, nz)], 0.0020, mats["rubber"], part=boot_part, segments=4)


def build_securion_satchel(cb: CharacterBuilder, mats: Dict[str, bpy.types.Material]) -> None:
    """Build Mara's rich dark oiled-leather crossbody tool satchel with brass buckles & dark-blue Securion tech pouch."""
    def _strap_ribbon(phi_z_list: Sequence[Tuple[float, float]], lift: float, width: float):
        pts = []
        outs = []
        for phi, z in phi_z_list:
            jx, jy, _ = _eval_jacket_surface(phi, max(0.856, min(1.420, z)))
            out = Vector((jx, jy - 0.010, 0.0)).normalized()
            if z > 1.375:
                out = (out + Vector((0.0, 0.0, 1.0))).normalized()
            pts.append(Vector((jx, jy, z)) + out * lift)
            outs.append(out)

        rings = []
        prof = [(-1.0, -0.4), (1.0, -0.4), (1.0, 0.6), (-1.0, 0.6)]
        for i, p in enumerate(pts):
            if i == 0:
                tang = (pts[1] - pts[0]).normalized()
            elif i == len(pts) - 1:
                tang = (pts[-1] - pts[-2]).normalized()
            else:
                tang = ((pts[i] - pts[i - 1]).normalized() + (pts[i + 1] - pts[i]).normalized()).normalized()
            out = (outs[i] - tang * outs[i].dot(tang)).normalized()
            side = tang.cross(out).normalized()
            rings.append([tuple(p + side * (sx * width) + out * (sy * 0.0042)) for sx, sy in prof])
        cb.add_grid(rings, None, mats["satchel_leather"], part="satchel_strap", closed_u=True, smooth=True)
        return pts

    front_path = [
        (0.95, 1.394),
        (0.74, 1.345),
        (0.48, 1.275),
        (0.18, 1.195),
        (-0.14, 1.115),
        (-0.50, 1.035),
        (-0.92, 0.962),
        (-1.42, 0.908),
        (-1.85, 0.892),
    ]
    front_pts = _strap_ribbon(front_path, lift=0.0085, width=0.016)

    back_path = [
        (1.92, 1.390),
        (2.18, 1.338),
        (2.48, 1.260),
        (2.78, 1.170),
        (-3.00, 1.080),
        (-2.62, 0.995),
        (-2.22, 0.932),
        (-1.92, 0.895),
    ]
    _strap_ribbon(back_path, lift=0.0085, width=0.016)

    adj_p = front_pts[2]
    cb.add_beveled_box(
        (adj_p.x, adj_p.y - 0.004, adj_p.z), (0.038, 0.010, 0.022),
        mats["brass"], part="satchel_strap", rot=(0.0, 0.55, -0.35), bevel=0.002, segments=1
    )

    # Tucked neatly behind right hip (-X, +Y) so right gloved hand hangs 100% clear in Idle!
    bag_c = Vector((-0.188, 0.056, 0.822))
    bag_rot = (0.06, 0.14, -0.22)
    bag_mat = Matrix.Translation(bag_c) @ Euler(bag_rot, "XYZ").to_matrix().to_4x4()

    def _bag_box(local_pos, size, mat, bevel=0.007, rot=(0.0, 0.0, 0.0)):
        wpos = bag_mat @ Vector(local_pos)
        wrot = (bag_rot[0] + rot[0], bag_rot[1] + rot[1], bag_rot[2] + rot[2])
        cb.add_beveled_box(wpos, size, mat, part="satchel_bag", rot=wrot, bevel=bevel, segments=1)

    _bag_box((0.0, 0.0, 0.0), (0.068, 0.205, 0.162), mats["satchel_leather"], bevel=0.012)
    _bag_box((-0.007, 0.0, 0.042), (0.075, 0.212, 0.086), mats["satchel_leather"], bevel=0.012)
    _bag_box((-0.042, 0.0, 0.004), (0.010, 0.206, 0.020), mats["jacket_trim"], bevel=0.003)

    for by in (-0.054, 0.054):
        _bag_box((-0.044, by, 0.004), (0.009, 0.018, 0.138), mats["leather_dark"], bevel=0.002)
        _bag_box((-0.048, by, -0.026), (0.010, 0.026, 0.026), mats["brass"], bevel=0.002)
        _bag_box((-0.050, by, -0.026), (0.005, 0.020, 0.005), mats["gunmetal"], bevel=0.001)

    for by in (-0.100, 0.100):
        p_d = bag_mat @ Vector((0.0, by, 0.068))
        cb.add_cylinder(p_d, 0.010, 0.010, 0.006, mats["brass"], part="satchel_bag", segments=10, rot=(math.pi * 0.5, 0.0, 0.0))

    # Dark-Blue Ballistic Nylon Securion Tech Pouch mounted on satchel outer face
    _bag_box((-0.042, -0.016, 0.020), (0.030, 0.084, 0.068), mats["tech_pouch"], bevel=0.006)
    _bag_box((-0.057, -0.016, 0.034), (0.007, 0.072, 0.012), mats["gunmetal"], bevel=0.002)
    _bag_box((-0.060, -0.044, 0.034), (0.004, 0.011, 0.006), mats["cyan_led"], bevel=0.001)


# =============================================================================
# 4. 19-BONE ARMATURE & ZERO-BLEED ANATOMICAL SKINNING
# =============================================================================

BONE_SPECS: List[Tuple[str, Optional[str], Tuple[float, float, float], Tuple[float, float, float]]] = [
    ("Hips", None, (0.0, 0.008, 0.895), (0.0, 0.008, 0.990)),
    ("Spine", "Hips", (0.0, 0.008, 0.990), (0.0, 0.012, 1.145)),
    ("Chest", "Spine", (0.0, 0.012, 1.145), (0.0, 0.016, 1.420)),
    ("Neck", "Chest", (0.0, 0.016, 1.420), (0.0, 0.008, 1.500)),
    ("Head", "Neck", (0.0, 0.008, 1.500), (0.0, 0.002, 1.708)),

    ("Shoulder_L", "Chest", (0.040, 0.015, 1.370), (0.166, 0.016, 1.352)),
    ("UpperArm_L", "Shoulder_L", (0.166, 0.016, 1.352), (0.248, 0.030, 1.112)),
    ("LowerArm_L", "UpperArm_L", (0.248, 0.030, 1.112), (0.292, -0.022, 0.888)),
    ("Hand_L", "LowerArm_L", (0.292, -0.022, 0.888), (0.308, -0.045, 0.740)),

    ("Shoulder_R", "Chest", (-0.040, 0.015, 1.370), (-0.166, 0.016, 1.352)),
    ("UpperArm_R", "Shoulder_R", (-0.166, 0.016, 1.352), (-0.248, 0.030, 1.112)),
    ("LowerArm_R", "UpperArm_R", (-0.248, 0.030, 1.112), (-0.292, -0.022, 0.888)),
    ("Hand_R", "LowerArm_R", (-0.292, -0.022, 0.888), (-0.308, -0.045, 0.740)),

    ("UpperLeg_L", "Hips", (0.090, 0.006, 0.878), (0.089, -0.006, 0.468)),
    ("LowerLeg_L", "UpperLeg_L", (0.089, -0.006, 0.468), (0.088, 0.012, 0.088)),
    ("Foot_L", "LowerLeg_L", (0.088, 0.012, 0.088), (0.088, -0.145, 0.028)),

    ("UpperLeg_R", "Hips", (-0.090, 0.006, 0.878), (-0.089, -0.006, 0.468)),
    ("LowerLeg_R", "UpperLeg_R", (-0.089, -0.006, 0.468), (-0.088, 0.012, 0.088)),
    ("Foot_R", "LowerLeg_R", (-0.088, 0.012, 0.088), (-0.088, -0.145, 0.028)),
]


def create_armature() -> bpy.types.Object:
    arm_data = bpy.data.armatures.new("MaraArmature")
    arm_obj = bpy.data.objects.new("MaraRig", arm_data)
    bpy.context.scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    ebones: Dict[str, bpy.types.EditBone] = {}
    for name, parent_name, head, tail in BONE_SPECS:
        eb = arm_data.edit_bones.new(name)
        eb.head = Vector(head)
        eb.tail = Vector(tail)
        eb.align_roll(Vector((0.0, 0.0, 1.0)) if "Shoulder" in name else Vector((0.0, -1.0, 0.0)))
        if parent_name is not None:
            eb.parent = ebones[parent_name]
            eb.use_connect = (eb.head - eb.parent.tail).length < 1e-4
        ebones[name] = eb

    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj


def _proj_param(p: Vector, a: Vector, b: Vector) -> float:
    ab = b - a
    l2 = ab.length_squared
    return 0.0 if l2 < 1e-8 else (p - a).dot(ab) / l2


def assign_anatomical_weights(mesh_obj: bpy.types.Object, arm_obj: bpy.types.Object, vert_parts: List[str]) -> None:
    bone_names = [b[0] for b in BONE_SPECS]
    vgroups = {bn: mesh_obj.vertex_groups.new(name=bn) for bn in bone_names}
    b_map = {b[0]: (Vector(b[2]), Vector(b[3])) for b in BONE_SPECS}

    def _add_w(weights: Dict[str, float], bname: str, val: float):
        if val > 1e-4:
            weights[bname] = weights.get(bname, 0.0) + float(val)

    for v in mesh_obj.data.vertices:
        p = v.co
        part = vert_parts[v.index]
        w: Dict[str, float] = {}

        if part == "head":
            _add_w(w, "Head", 1.0)
        elif part == "head_neck":
            if p.z >= 1.512:
                _add_w(w, "Head", 1.0)
            elif p.z >= 1.462:
                t = _smoothstep(1.462, 1.512, p.z)
                _add_w(w, "Head", t)
                _add_w(w, "Neck", 1.0 - t)
            else:
                t = _smoothstep(1.410, 1.462, p.z)
                _add_w(w, "Neck", 0.18 + 0.82 * t)
                _add_w(w, "Chest", 0.82 * (1.0 - t))
        elif part == "chest_neck":
            if p.z >= 1.415:
                t = _smoothstep(1.415, 1.465, p.z)
                _add_w(w, "Neck", 0.25 + 0.75 * t)
                _add_w(w, "Chest", 0.75 * (1.0 - t))
            else:
                t = _smoothstep(1.16, 1.24, p.z)
                _add_w(w, "Chest", t)
                _add_w(w, "Spine", 1.0 - t)
        elif part == "chest_collar":
            if p.z > 1.430:
                t_n = _smoothstep(1.430, 1.498, p.z) * 0.42
                _add_w(w, "Neck", t_n)
                _add_w(w, "Chest", 1.0 - t_n)
            elif abs(p.x) > 0.110 and p.z > 1.36:
                side = "L" if p.x >= 0 else "R"
                t_sh = _smoothstep(0.110, 0.168, abs(p.x)) * 0.55
                _add_w(w, f"Shoulder_{side}", t_sh)
                _add_w(w, "Chest", 1.0 - t_sh)
            else:
                _add_w(w, "Chest", 1.0)
        elif part == "torso":
            if p.z < 0.965:
                t = _smoothstep(0.860, 0.965, p.z)
                _add_w(w, "Hips", 1.0 - 0.55 * t)
                _add_w(w, "Spine", 0.55 * t)
            elif p.z < 1.155:
                t = _smoothstep(0.965, 1.155, p.z)
                if t < 0.5:
                    u = t * 2.0
                    _add_w(w, "Hips", 0.45 * (1.0 - u))
                    _add_w(w, "Spine", 0.55 + 0.45 * u)
                else:
                    u = (t - 0.5) * 2.0
                    _add_w(w, "Spine", 1.0 - 0.65 * u)
                    _add_w(w, "Chest", 0.65 * u)
            else:
                t = _smoothstep(1.155, 1.245, p.z)
                _add_w(w, "Spine", 0.35 * (1.0 - t))
                _add_w(w, "Chest", 0.65 + 0.35 * t)
            if p.z > 1.30 and abs(p.x) > 0.128:
                side = "L" if p.x >= 0 else "R"
                sh_w = _smoothstep(0.128, 0.178, abs(p.x)) * _smoothstep(1.30, 1.36, p.z) * 0.42
                for k in list(w.keys()):
                    w[k] *= (1.0 - sh_w)
                _add_w(w, f"Shoulder_{side}", sh_w)
        elif part == "hips":
            if p.z > 0.895:
                t = _smoothstep(0.895, 0.935, p.z) * 0.35
                _add_w(w, "Spine", t)
                _add_w(w, "Hips", 1.0 - t)
            elif p.z < 0.840 and abs(p.x) > 0.030:
                side = "L" if p.x >= 0 else "R"
                t_leg = _smoothstep(0.840, 0.772, p.z) * _smoothstep(0.030, 0.082, abs(p.x)) * 0.62
                _add_w(w, f"UpperLeg_{side}", t_leg)
                _add_w(w, "Hips", 1.0 - t_leg)
            else:
                _add_w(w, "Hips", 1.0)
        elif part == "satchel_bag":
            _add_w(w, "Hips", 0.82)
            _add_w(w, "Spine", 0.18)
        elif part == "satchel_strap":
            if p.z < 0.975:
                t = _smoothstep(0.890, 0.975, p.z)
                _add_w(w, "Hips", 1.0 - 0.65 * t)
                _add_w(w, "Spine", 0.65 * t)
            elif p.z < 1.155:
                t = _smoothstep(0.975, 1.155, p.z)
                _add_w(w, "Spine", 1.0 - 0.70 * t)
                _add_w(w, "Chest", 0.70 * t)
            else:
                t_sh = _smoothstep(1.32, 1.39, p.z) * _smoothstep(0.08, 0.14, p.x) * 0.35
                _add_w(w, "Chest", 1.0 - t_sh)
                _add_w(w, "Shoulder_L", t_sh)
        elif part in ("arm_L", "arm_R"):
            side = "L" if part.endswith("L") else "R"
            ua_h, ua_t = b_map[f"UpperArm_{side}"]
            la_h, la_t = b_map[f"LowerArm_{side}"]
            t_ua = _proj_param(p, ua_h, ua_t)
            t_la = _proj_param(p, la_h, la_t)
            if t_ua < 0.08:
                t = _smoothstep(-0.18, 0.08, t_ua)
                _add_w(w, f"UpperArm_{side}", 0.15 + 0.75 * t)
                _add_w(w, f"Shoulder_{side}", 0.55 * (1.0 - t) + 0.10 * t)
                _add_w(w, "Chest", 0.30 * (1.0 - t))
            elif t_ua < 0.84:
                _add_w(w, f"UpperArm_{side}", 1.0)
            elif t_la < 0.18:
                t = _smoothstep(-0.16, 0.18, t_la)
                _add_w(w, f"LowerArm_{side}", t)
                _add_w(w, f"UpperArm_{side}", 1.0 - t)
            elif t_la < 0.88:
                _add_w(w, f"LowerArm_{side}", 1.0)
            else:
                t = _smoothstep(0.88, 1.05, t_la) * 0.65
                _add_w(w, f"Hand_{side}", t)
                _add_w(w, f"LowerArm_{side}", 1.0 - t)
        elif part in ("hand_L", "hand_R"):
            side = "L" if part.endswith("L") else "R"
            la_h, la_t = b_map[f"LowerArm_{side}"]
            t_la = _proj_param(p, la_h, la_t)
            if t_la < 1.04:
                t = _smoothstep(0.94, 1.04, t_la)
                _add_w(w, f"Hand_{side}", 0.35 + 0.65 * t)
                _add_w(w, f"LowerArm_{side}", 0.65 * (1.0 - t))
            else:
                _add_w(w, f"Hand_{side}", 1.0)
        elif part in ("leg_L", "leg_R"):
            side = "L" if part.endswith("L") else "R"
            if p.z > 0.765:
                t = _smoothstep(0.765, 0.860, p.z)
                _add_w(w, "Hips", 0.72 * t)
                _add_w(w, f"UpperLeg_{side}", 1.0 - 0.72 * t)
            elif p.z > 0.515:
                _add_w(w, f"UpperLeg_{side}", 1.0)
            elif p.z > 0.420:
                t = _smoothstep(0.420, 0.515, p.z)
                _add_w(w, f"UpperLeg_{side}", t)
                _add_w(w, f"LowerLeg_{side}", 1.0 - t)
            elif p.z > 0.140:
                _add_w(w, f"LowerLeg_{side}", 1.0)
            else:
                t = _smoothstep(0.085, 0.140, p.z)
                _add_w(w, f"LowerLeg_{side}", t)
                _add_w(w, f"Foot_{side}", 1.0 - t)
        elif part in ("boot_L", "boot_R"):
            side = "L" if part.endswith("L") else "R"
            if p.z > 0.140:
                _add_w(w, f"LowerLeg_{side}", 1.0)
            elif p.z > 0.082:
                t = _smoothstep(0.082, 0.140, p.z)
                _add_w(w, f"LowerLeg_{side}", t)
                _add_w(w, f"Foot_{side}", 1.0 - t)
            else:
                _add_w(w, f"Foot_{side}", 1.0)
        else:
            _add_w(w, "Hips", 1.0)

        items = sorted(w.items(), key=lambda kv: kv[1], reverse=True)[:4]
        total = sum(val for _, val in items)
        if total < 1e-6:
            items = [("Hips", 1.0)]
            total = 1.0
        for bn, val in items:
            vgroups[bn].add([v.index], val / total, "REPLACE")

    mesh_obj.parent = arm_obj
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj
    mod.use_vertex_groups = True


# =============================================================================
# 5. ANATOMICAL POSE ENGINE & 5 SMOOTH LOOPING GLTF ANIMATION CLIPS
# =============================================================================

class PoseHelper:
    def __init__(self, arm_obj: bpy.types.Object) -> None:
        self.arm_obj = arm_obj
        self.rest_R: Dict[str, Matrix] = {}
        self.rest_R_inv: Dict[str, Matrix] = {}
        for b in arm_obj.data.bones:
            r3 = b.matrix_local.to_3x3().normalized()
            self.rest_R[b.name] = r3
            self.rest_R_inv[b.name] = r3.inverted()

    def clear_pose(self) -> None:
        for pb in self.arm_obj.pose.bones:
            pb.rotation_mode = "QUATERNION"
            pb.location = Vector((0.0, 0.0, 0.0))
            pb.rotation_quaternion = Quaternion((1.0, 0.0, 0.0, 0.0))
            pb.scale = Vector((1.0, 1.0, 1.0))

    def set_world_rot(self, bone_name: str, rx: float = 0.0, ry: float = 0.0, rz: float = 0.0) -> None:
        pb = self.arm_obj.pose.bones[bone_name]
        pb.rotation_mode = "QUATERNION"
        r_world = Euler((rx, ry, rz), "XYZ").to_matrix()
        r_local = self.rest_R_inv[bone_name] @ r_world @ self.rest_R[bone_name]
        pb.rotation_quaternion = r_local.to_quaternion().normalized()

    def set_hips_offset(self, dx: float = 0.0, dy: float = 0.0, dz: float = 0.0) -> None:
        pb = self.arm_obj.pose.bones["Hips"]
        pb.location = self.rest_R_inv["Hips"] @ Vector((dx, dy, dz))

    def torso(self, bone: str, fwd_deg: float = 0.0, yaw_left_deg: float = 0.0, tilt_left_deg: float = 0.0) -> None:
        self.set_world_rot(bone, math.radians(fwd_deg), math.radians(tilt_left_deg), math.radians(yaw_left_deg))

    def leg(self, side: str, swing_fwd_deg: float = 0.0, out_deg: float = 0.0, yaw_out_deg: float = 0.0) -> None:
        sgn = 1.0 if side == "L" else -1.0
        self.set_world_rot(f"UpperLeg_{side}", rx=math.radians(-swing_fwd_deg), ry=math.radians(-sgn * out_deg), rz=math.radians(sgn * yaw_out_deg))

    def knee(self, side: str, bend_deg: float = 0.0) -> None:
        self.set_world_rot(f"LowerLeg_{side}", rx=math.radians(max(0.0, bend_deg)))

    def ankle(self, side: str, toe_up_deg: float = 0.0) -> None:
        self.set_world_rot(f"Foot_{side}", rx=math.radians(-toe_up_deg))

    def arm(self, side: str, swing_fwd_deg: float = 0.0, adduct_in_deg: float = 0.0, twist_in_deg: float = 0.0) -> None:
        sgn = 1.0 if side == "L" else -1.0
        self.set_world_rot(f"UpperArm_{side}", rx=math.radians(-swing_fwd_deg), ry=math.radians(sgn * adduct_in_deg), rz=math.radians(-sgn * twist_in_deg))

    def elbow(self, side: str, bend_fwd_deg: float = 0.0, inward_deg: float = 0.0, pronate_deg: float = 0.0) -> None:
        sgn = 1.0 if side == "L" else -1.0
        self.set_world_rot(f"LowerArm_{side}", rx=math.radians(-max(0.0, bend_fwd_deg)), ry=math.radians(sgn * inward_deg), rz=math.radians(-sgn * pronate_deg))

    def hand(self, side: str, flex_deg: float = 0.0, pronate_deg: float = 0.0) -> None:
        sgn = 1.0 if side == "L" else -1.0
        self.set_world_rot(f"Hand_{side}", rx=math.radians(-flex_deg), rz=math.radians(-sgn * pronate_deg))

    def shoulder(self, side: str, shrug_up_deg: float = 0.0, fwd_deg: float = 0.0) -> None:
        sgn = 1.0 if side == "L" else -1.0
        self.set_world_rot(f"Shoulder_{side}", ry=math.radians(-sgn * shrug_up_deg), rz=math.radians(-sgn * fwd_deg))

    def keyframe_all(self, frame: int) -> None:
        for pb in self.arm_obj.pose.bones:
            pb.keyframe_insert(data_path="rotation_quaternion", frame=frame)
            if pb.name == "Hips":
                pb.keyframe_insert(data_path="location", frame=frame)


def _compute_hips_z_drop(hip_fwd_deg: float, knee_bend_deg: float) -> float:
    thigh, shin = 0.410, 0.380
    return thigh * math.cos(math.radians(hip_fwd_deg)) + shin * math.cos(math.radians(hip_fwd_deg - knee_bend_deg)) - (thigh + shin)


def build_animations(arm_obj: bpy.types.Object) -> List[str]:
    bpy.context.scene.render.fps = 30
    arm_obj.animation_data_create()
    ph = PoseHelper(arm_obj)
    clip_names: List[str] = []

    def _record_clip(name: str, n_frames: int, pose_fn) -> None:
        act = bpy.data.actions.new(name=name)
        arm_obj.animation_data.action = act
        frames = sorted(set(list(range(1, n_frames + 1, 2)) + [n_frames + 1]))
        for fr in frames:
            u = (fr - 1) / float(n_frames)
            ph.clear_pose()
            pose_fn(u)
            ph.keyframe_all(fr)

        track = arm_obj.animation_data.nla_tracks.new()
        track.name = name
        strip = track.strips.new(name, 1, act)
        if act.slots:
            strip.action_slot = act.slots[0]
        strip.mute = False
        arm_obj.animation_data.action = None
        clip_names.append(name)

    # 1) IDLE (96 frames = 3.2s): subtle weight shift, natural breathing, alert head micro-turns
    def pose_idle(u: float):
        w1 = math.sin(2.0 * math.pi * u)
        w2 = math.sin(4.0 * math.pi * u)
        c1 = math.cos(2.0 * math.pi * u)
        breath = 0.5 * (1.0 - c1)
        knee_l = 3.5 + 1.5 * w1
        knee_r = 3.5 - 1.5 * w1
        drop = min(_compute_hips_z_drop(2.0, knee_l), _compute_hips_z_drop(2.0, knee_r))

        ph.set_hips_offset(dx=0.011 * w1, dy=0.0, dz=drop + 0.004 * breath)
        ph.torso("Hips", fwd_deg=1.5, yaw_left_deg=2.2 * w1, tilt_left_deg=-1.6 * w1)
        ph.torso("Spine", fwd_deg=1.0 - 1.2 * breath, yaw_left_deg=-1.4 * w1, tilt_left_deg=1.1 * w1)
        ph.torso("Chest", fwd_deg=-1.4 * breath, yaw_left_deg=-1.8 * w1, tilt_left_deg=0.7 * w1)
        ph.torso("Neck", fwd_deg=0.8 + 0.7 * breath, yaw_left_deg=3.5 * math.sin(2.0 * math.pi * u + 0.4))
        ph.torso("Head", fwd_deg=-0.8 + 1.2 * w2, yaw_left_deg=8.0 * math.sin(2.0 * math.pi * u + 0.35), tilt_left_deg=1.8 * c1)

        ph.shoulder("L", shrug_up_deg=1.0 * breath - 1.2, fwd_deg=1.0)
        ph.shoulder("R", shrug_up_deg=1.0 * breath - 1.2, fwd_deg=1.5)
        ph.arm("L", swing_fwd_deg=3.0 + 1.5 * w1, adduct_in_deg=10.5, twist_in_deg=8.0)
        ph.arm("R", swing_fwd_deg=5.5 - 1.5 * w1, adduct_in_deg=7.5, twist_in_deg=8.0)  # hangs cleanly clear in front of satchel!
        ph.elbow("L", bend_fwd_deg=11.0 + 2.0 * breath)
        ph.elbow("R", bend_fwd_deg=12.0 + 2.0 * breath)
        ph.hand("L", flex_deg=3.0)
        ph.hand("R", flex_deg=3.0)

        ph.leg("L", swing_fwd_deg=2.5, out_deg=1.5, yaw_out_deg=4.0)
        ph.leg("R", swing_fwd_deg=-1.5, out_deg=1.5, yaw_out_deg=5.0)
        ph.knee("L", knee_l)
        ph.knee("R", knee_r)
        ph.ankle("L", toe_up_deg=knee_l - 2.5)
        ph.ankle("R", toe_up_deg=knee_r + 1.5)

    _record_clip("Idle", 96, pose_idle)

    # 2) WALK (32 frames = 1.067s): authentic 2-step stride, hip sway, counter-arm swing, heel-to-toe roll
    def pose_walk(u: float):
        ang = 2.0 * math.pi * u
        s, c, c2 = math.sin(ang), math.cos(ang), math.cos(2.0 * ang)
        leg_l_fwd = 26.0 * s + 3.0
        leg_r_fwd = -26.0 * s + 3.0
        knee_l = max(4.0, 26.0 * max(0.0, -c) + 10.0 * max(0.0, s))
        knee_r = max(4.0, 26.0 * max(0.0, c) + 10.0 * max(0.0, -s))
        hip_z = max(_compute_hips_z_drop(leg_l_fwd, knee_l), _compute_hips_z_drop(leg_r_fwd, knee_r)) + 0.006 * (-c2)

        ph.set_hips_offset(dx=0.017 * (-s), dy=0.0, dz=hip_z)
        ph.torso("Hips", fwd_deg=4.5, yaw_left_deg=-7.5 * s, tilt_left_deg=-3.2 * s)
        ph.torso("Spine", fwd_deg=2.5, yaw_left_deg=5.0 * s, tilt_left_deg=2.2 * s)
        ph.torso("Chest", fwd_deg=1.5, yaw_left_deg=7.5 * s, tilt_left_deg=1.5 * s)
        ph.torso("Neck", fwd_deg=-3.0, yaw_left_deg=-3.0 * s)
        ph.torso("Head", fwd_deg=-4.5, yaw_left_deg=-2.0 * s)

        ph.shoulder("L", shrug_up_deg=-1.2, fwd_deg=-4.5 * s)
        ph.shoulder("R", shrug_up_deg=-1.2, fwd_deg=4.5 * s)
        ph.arm("L", swing_fwd_deg=-22.0 * s + 3.0, adduct_in_deg=10.5, twist_in_deg=6.0)
        ph.arm("R", swing_fwd_deg=22.0 * s + 4.0, adduct_in_deg=7.5, twist_in_deg=6.0)
        ph.elbow("L", bend_fwd_deg=17.0 + 14.0 * max(0.0, -s))
        ph.elbow("R", bend_fwd_deg=17.0 + 14.0 * max(0.0, s))

        ph.leg("L", swing_fwd_deg=leg_l_fwd, out_deg=0.5, yaw_out_deg=3.0)
        ph.leg("R", swing_fwd_deg=leg_r_fwd, out_deg=0.5, yaw_out_deg=3.0)
        ph.knee("L", knee_l)
        ph.knee("R", knee_r)
        ph.ankle("L", toe_up_deg=12.0 * max(0.0, s) - 14.0 * max(0.0, -s))
        ph.ankle("R", toe_up_deg=12.0 * max(0.0, -s) - 14.0 * max(0.0, s))

    _record_clip("Walk", 32, pose_walk)

    # 3) SNEAK (36 frames = 1.2s): low crouched stealth gait, bent knees, cautious balance
    def pose_sneak(u: float):
        ang = 2.0 * math.pi * u
        s, c = math.sin(ang), math.cos(ang)
        leg_l_fwd = 28.0 + 22.0 * s
        leg_r_fwd = 28.0 - 22.0 * s
        knee_l = 52.0 + 18.0 * max(0.0, -c)
        knee_r = 52.0 + 18.0 * max(0.0, c)
        hip_z = max(_compute_hips_z_drop(leg_l_fwd, knee_l), _compute_hips_z_drop(leg_r_fwd, knee_r)) - 0.008

        ph.set_hips_offset(dx=0.022 * (-s), dy=-0.03, dz=hip_z)
        ph.torso("Hips", fwd_deg=16.0, yaw_left_deg=-8.0 * s, tilt_left_deg=-2.5 * s)
        ph.torso("Spine", fwd_deg=14.0, yaw_left_deg=4.0 * s)
        ph.torso("Chest", fwd_deg=10.0, yaw_left_deg=7.0 * s)
        ph.torso("Neck", fwd_deg=-18.0)
        ph.torso("Head", fwd_deg=-18.0, yaw_left_deg=6.0 * c)

        ph.shoulder("L", shrug_up_deg=2.0, fwd_deg=6.0 - 4.0 * s)
        ph.shoulder("R", shrug_up_deg=2.0, fwd_deg=6.0 + 4.0 * s)
        ph.arm("L", swing_fwd_deg=16.0 - 14.0 * s, adduct_in_deg=4.0, twist_in_deg=12.0)
        ph.arm("R", swing_fwd_deg=16.0 + 14.0 * s, adduct_in_deg=3.0, twist_in_deg=12.0)
        ph.elbow("L", bend_fwd_deg=46.0 + 10.0 * (-s), inward_deg=8.0, pronate_deg=18.0)
        ph.elbow("R", bend_fwd_deg=46.0 + 10.0 * s, inward_deg=8.0, pronate_deg=18.0)
        ph.hand("L", flex_deg=-8.0, pronate_deg=14.0)
        ph.hand("R", flex_deg=-8.0, pronate_deg=14.0)

        ph.leg("L", swing_fwd_deg=leg_l_fwd, out_deg=4.5, yaw_out_deg=6.0)
        ph.leg("R", swing_fwd_deg=leg_r_fwd, out_deg=4.5, yaw_out_deg=6.0)
        ph.knee("L", knee_l)
        ph.knee("R", knee_r)
        ph.ankle("L", toe_up_deg=knee_l - leg_l_fwd + 4.0 * s)
        ph.ankle("R", toe_up_deg=knee_r - leg_r_fwd - 4.0 * s)

    _record_clip("Sneak", 36, pose_sneak)

    # 4) RUN (22 frames = 0.733s): athletic forward-leaning sprint
    def pose_run(u: float):
        ang = 2.0 * math.pi * u
        s, c, c2 = math.sin(ang), math.cos(ang), math.cos(2.0 * ang)
        leg_l_fwd = 44.0 * s + 12.0
        leg_r_fwd = -44.0 * s + 12.0
        knee_l = max(12.0, 68.0 * max(0.0, -c) + 22.0 * max(0.0, s))
        knee_r = max(12.0, 68.0 * max(0.0, c) + 22.0 * max(0.0, -s))
        hip_z = max(_compute_hips_z_drop(leg_l_fwd, knee_l), _compute_hips_z_drop(leg_r_fwd, knee_r)) + 0.030 * (-c2)

        ph.set_hips_offset(dx=0.014 * (-s), dy=-0.02, dz=hip_z)
        ph.torso("Hips", fwd_deg=12.0, yaw_left_deg=-12.0 * s, tilt_left_deg=-3.5 * s)
        ph.torso("Spine", fwd_deg=9.0, yaw_left_deg=8.0 * s)
        ph.torso("Chest", fwd_deg=7.0, yaw_left_deg=12.0 * s)
        ph.torso("Neck", fwd_deg=-12.0)
        ph.torso("Head", fwd_deg=-13.0, yaw_left_deg=-4.0 * s)

        ph.shoulder("L", shrug_up_deg=2.0, fwd_deg=-8.0 * s)
        ph.shoulder("R", shrug_up_deg=2.0, fwd_deg=8.0 * s)
        ph.arm("L", swing_fwd_deg=-44.0 * s + 8.0, adduct_in_deg=10.0, twist_in_deg=10.0)
        ph.arm("R", swing_fwd_deg=44.0 * s + 8.0, adduct_in_deg=8.0, twist_in_deg=10.0)
        ph.elbow("L", bend_fwd_deg=78.0 + 14.0 * max(0.0, -s), inward_deg=6.0)
        ph.elbow("R", bend_fwd_deg=78.0 + 14.0 * max(0.0, s), inward_deg=6.0)

        ph.leg("L", swing_fwd_deg=leg_l_fwd, out_deg=1.5)
        ph.leg("R", swing_fwd_deg=leg_r_fwd, out_deg=1.5)
        ph.knee("L", knee_l)
        ph.knee("R", knee_r)
        ph.ankle("L", toe_up_deg=14.0 * max(0.0, s) - 20.0 * max(0.0, -s))
        ph.ankle("R", toe_up_deg=14.0 * max(0.0, -s) - 20.0 * max(0.0, s))

    _record_clip("Run", 22, pose_run)

    # 5) INTERACT (60 frames = 2.0s): focused crouching lockpicking / Securion circuit bypass with natural inward/downward wrists!
    def pose_interact(u: float):
        w1 = math.sin(2.0 * math.pi * u)
        w2 = math.sin(4.0 * math.pi * u)
        w4 = math.sin(8.0 * math.pi * u)

        leg_l_fwd, knee_l = 36.0, 52.0
        leg_r_fwd, knee_r = 8.0, 46.0
        drop = max(_compute_hips_z_drop(leg_l_fwd, knee_l), _compute_hips_z_drop(leg_r_fwd, knee_r))

        ph.set_hips_offset(dx=0.0, dy=-0.02, dz=drop + 0.004 * w1)
        ph.torso("Hips", fwd_deg=14.0, yaw_left_deg=-5.0)
        ph.torso("Spine", fwd_deg=13.0 + 1.5 * w1, yaw_left_deg=3.0)
        ph.torso("Chest", fwd_deg=10.0 + 1.5 * w1, yaw_left_deg=2.0)
        ph.torso("Neck", fwd_deg=-8.0, yaw_left_deg=3.5 * w1)
        ph.torso("Head", fwd_deg=-6.0 + 2.0 * w2, yaw_left_deg=6.0 * w1)

        ph.shoulder("L", shrug_up_deg=2.5, fwd_deg=14.0)
        ph.shoulder("R", shrug_up_deg=2.5, fwd_deg=16.0)
        # Pronated forearms & well-separated hands working cleanly on lock/circuit board (zero wrist crossing!)
        ph.arm("L", swing_fwd_deg=42.0 + 2.0 * w1, adduct_in_deg=8.0, twist_in_deg=14.0)
        ph.elbow("L", bend_fwd_deg=60.0 + 3.0 * w2, inward_deg=9.0, pronate_deg=36.0)
        ph.hand("L", flex_deg=-10.0, pronate_deg=18.0 + 5.0 * w1)

        ph.arm("R", swing_fwd_deg=46.0 + 4.5 * w2, adduct_in_deg=8.0, twist_in_deg=16.0)
        ph.elbow("R", bend_fwd_deg=58.0 + 7.0 * w2 + 3.0 * w4, inward_deg=10.0, pronate_deg=40.0)
        ph.hand("R", flex_deg=-12.0 + 8.0 * w4, pronate_deg=24.0 + 10.0 * w2)

        ph.leg("L", swing_fwd_deg=leg_l_fwd, out_deg=5.0, yaw_out_deg=6.0)
        ph.leg("R", swing_fwd_deg=leg_r_fwd, out_deg=6.0, yaw_out_deg=10.0)
        ph.knee("L", knee_l)
        ph.knee("R", knee_r)
        ph.ankle("L", toe_up_deg=knee_l - leg_l_fwd)
        ph.ankle("R", toe_up_deg=knee_r - leg_r_fwd - 10.0)

    _record_clip("Interact", 60, pose_interact)

    ph.clear_pose()
    return clip_names


# =============================================================================
# 6. BUILD, EXPORT GLB, VERIFY, AND RENDER 6-VIEW PHOTOREAL QA SHEET
# =============================================================================

def build_mara_glb(out_path: str = OUT_GLB) -> dict:
    bpy.ops.wm.read_factory_settings(use_empty=True)

    mats = _build_all_materials()
    cb = CharacterBuilder()

    build_head_and_face(cb, mats)
    build_layered_hair(cb, mats)
    build_torso_and_jacket(cb, mats)
    build_sleeves_and_gloved_hands(cb, mats)
    build_trousers_and_boots(cb, mats)
    build_securion_satchel(cb, mats)

    cb.bm.normal_update()
    bmesh.ops.recalc_face_normals(cb.bm, faces=list(cb.bm.faces))

    cb.bm.verts.ensure_lookup_table()
    vert_parts = [cb.part_name(v[cb.part_layer]) for v in cb.bm.verts]

    min_z = min(v.co.z for v in cb.bm.verts)
    if abs(min_z) > 1e-6:
        bmesh.ops.translate(cb.bm, vec=Vector((0.0, 0.0, -min_z)), verts=list(cb.bm.verts))

    max_z = max(v.co.z for v in cb.bm.verts)
    min_x = min(v.co.x for v in cb.bm.verts)
    max_x = max(v.co.x for v in cb.bm.verts)
    min_y = min(v.co.y for v in cb.bm.verts)
    max_y = max(v.co.y for v in cb.bm.verts)

    mesh = bpy.data.meshes.new("Mara_Mesh")
    cb.bm.to_mesh(mesh)
    cb.bm.free()

    for m in cb.materials:
        mesh.materials.append(m)
    mesh.update()

    mesh_obj = bpy.data.objects.new("Mara_Body", mesh)
    bpy.context.scene.collection.objects.link(mesh_obj)

    arm_obj = create_armature()
    assign_anatomical_weights(mesh_obj, arm_obj, vert_parts)
    clips = build_animations(arm_obj)

    mesh.calc_loop_triangles()
    tri_count = len(mesh.loop_triangles)

    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=out_path,
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="WEBP",
        export_image_quality=78,
        export_skins=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_bake_animation=True,
        export_optimize_animation_size=True,
        export_lights=False,
        export_cameras=False,
    )

    size_bytes = os.path.getsize(out_path)
    return {
        "file": out_path,
        "sizeBytes": size_bytes,
        "sizeMB": round(size_bytes / (1024 * 1024), 3),
        "triangles": tri_count,
        "vertices": len(mesh.vertices),
        "materials": len(mesh.materials),
        "bones": len(arm_obj.data.bones),
        "clips": clips,
        "boundsYUp": {
            "min": [round(min_x, 4), 0.0, round(-max_y, 4)],
            "max": [round(max_x, 4), round(max_z - min_z, 4), round(-min_y, 4)],
        },
        "heightM": round(max_z - min_z, 4),
    }


def verify_exported_glb(glb_path: str) -> dict:
    with open(glb_path, "rb") as f:
        data = f.read()
    magic, version, total_len = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF" and version == 2 and total_len == len(data)
    c0_len, c0_type = struct.unpack_from("<I4s", data, 12)
    assert c0_type == b"JSON"
    gltf = json.loads(data[20 : 20 + c0_len].decode("utf-8"))

    anim_names = [a.get("name") for a in gltf.get("animations", [])]
    node_names = [n.get("name") for n in gltf.get("nodes", [])]
    skins = gltf.get("skins", [])
    images = gltf.get("images", [])
    meshes = gltf.get("meshes", [])
    accessors = gltf.get("accessors", [])

    min_y, max_y = float("inf"), float("-inf")
    tri_total = 0
    for m in meshes:
        for prim in m.get("primitives", []):
            attrs = prim.get("attributes", {})
            assert "POSITION" in attrs and "NORMAL" in attrs and "JOINTS_0" in attrs and "WEIGHTS_0" in attrs
            pos_acc = accessors[attrs["POSITION"]]
            if "min" in pos_acc:
                min_y = min(min_y, pos_acc["min"][1])
                max_y = max(max_y, pos_acc["max"][1])
            if "indices" in prim:
                tri_total += accessors[prim["indices"]]["count"] // 3

    expected_clips = ["Idle", "Walk", "Sneak", "Run", "Interact"]
    expected_bones = [b[0] for b in BONE_SPECS]
    return {
        "validBinary": True,
        "sizeBytes": len(data),
        "sizeMB": round(len(data) / (1024 * 1024), 3),
        "triangles": tri_total,
        "skins": len(skins),
        "jointCount": len(skins[0]["joints"]) if skins else 0,
        "missingBones": [b for b in expected_bones if b not in node_names],
        "animations": anim_names,
        "missingClips": [c for c in expected_clips if c not in anim_names],
        "embeddedImages": len(images),
        "imageMimeTypes": sorted({im.get("mimeType", "?") for im in images}),
        "materials": len(gltf.get("materials", [])),
        "minY": round(min_y, 5),
        "maxY": round(max_y, 4),
        "heightM": round(max_y - min_y, 4),
    }


def render_qa_sheet(glb_path: str, out_png: str) -> None:
    """Re-import exported GLB and render high-res 6-panel studio & pose QA sheet with cinematic night lighting."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    tile_w, tile_h = 640, 768
    scene.render.resolution_x = tile_w
    scene.render.resolution_y = tile_h
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = 0.22

    world = bpy.data.worlds.new("QAWorld")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.016, 0.025, 0.048, 1.0)
        bg.inputs["Strength"].default_value = 0.72

    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=5.0, depth=0.04, location=(0.0, 0.0, -0.02))
    floor = bpy.context.active_object
    fmat = bpy.data.materials.new("QAFloor")
    fbsdf = fmat.node_tree.nodes.get("Principled BSDF")
    fbsdf.inputs["Base Color"].default_value = (0.028, 0.034, 0.048, 1.0)
    fbsdf.inputs["Roughness"].default_value = 0.36
    floor.data.materials.append(fmat)

    def _add_area(name, loc, target, energy, color, size):
        ld = bpy.data.lights.new(name, type="AREA")
        ld.energy = energy
        ld.color = color
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.location = Vector(loc)
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
        return lo

    # Warm Mediterranean streetlamp key (front-right 3/4, casting crisp facial relief)
    _add_area("KeyWarm", (-1.85, -2.10, 2.20), (0.0, 0.0, 1.15), 255.0, (1.0, 0.80, 0.58), 1.0)
    # Cool Mediterranean moonlight rim (back-left)
    _add_area("RimCool", (1.65, 2.05, 2.10), (0.0, 0.0, 1.25), 240.0, (0.45, 0.70, 1.0), 1.0)
    # Subtle soft front fill so dark leather & eyes read with photographic clarity
    _add_area("FillFront", (1.35, -2.35, 1.45), (0.0, 0.0, 1.25), 105.0, (0.82, 0.88, 1.0), 1.7)
    # Back kick light for bun, seams & satchel clarity
    _add_area("BackKick", (-1.45, 2.15, 1.80), (0.0, 0.0, 1.10), 135.0, (0.95, 0.84, 0.72), 1.2)

    before = set(scene.objects)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    imported = [o for o in scene.objects if o not in before]
    arm = next((o for o in imported if o.type == "ARMATURE"), None)

    def _activate_clip(clip_name: str, frame: int) -> None:
        if arm is None or arm.animation_data is None:
            return
        for tr in arm.animation_data.nla_tracks:
            match = (tr.name == clip_name) or any(st.action and st.action.name == clip_name for st in tr.strips)
            tr.mute = not match
        act = bpy.data.actions.get(clip_name)
        if act is not None:
            arm.animation_data.action = act
            if act.slots:
                arm.animation_data.action_slot = act.slots[0]
        scene.frame_set(frame)
        bpy.context.view_layer.update()

    cam_data = bpy.data.cameras.new("QACam")
    cam_obj = bpy.data.objects.new("QACam", cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    def _render_view(fname: str, cam_pos, look_at, lens: float, clip: str, frame: int) -> str:
        _activate_clip(clip, frame)
        cam_data.lens = lens
        cam_obj.location = Vector(cam_pos)
        cam_obj.rotation_euler = (Vector(look_at) - Vector(cam_pos)).to_track_quat("-Z", "Y").to_euler()
        scene.render.filepath = fname
        bpy.ops.render.render(write_still=True)
        return fname

    tmp_dir = os.path.join(os.path.dirname(out_png), "_mara_qa_tiles")
    os.makedirs(tmp_dir, exist_ok=True)

    # Verify evaluated skinned mesh deformation bounds across ALL 5 animation clips (zero exploded vertices!)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    skinned_obj = next((o for o in imported if o.type == "MESH"), None)
    if skinned_obj is not None:
        clip_checks = {}
        for cname, cfr in [("Idle", 12), ("Walk", 9), ("Sneak", 10), ("Run", 7), ("Interact", 18)]:
            _activate_clip(cname, cfr)
            depsgraph.update()
            eval_obj = skinned_obj.evaluated_get(depsgraph)
            eval_mesh = eval_obj.to_mesh()
            zs = [(eval_obj.matrix_world @ v.co).z for v in eval_mesh.vertices]
            xs = [(eval_obj.matrix_world @ v.co).x for v in eval_mesh.vertices]
            ys = [(eval_obj.matrix_world @ v.co).y for v in eval_mesh.vertices]
            clip_checks[cname] = {
                "minZ": round(min(zs), 4),
                "maxZ": round(max(zs), 4),
                "spanX": round(max(xs) - min(xs), 3),
                "spanY": round(max(ys) - min(ys), 3),
            }
            eval_obj.to_mesh_clear()
        print("[mara_qa] All-5-clips skinned deformation bounds:", json.dumps(clip_checks))

    views = [
        ("01_front.png", (0.0, -2.85, 0.96), (0.0, 0.0, 0.88), 52.0, "Idle", 12),
        ("02_hero34.png", (-1.55, -2.30, 1.10), (-0.02, 0.0, 0.96), 56.0, "Idle", 36),
        ("03_face.png", (0.14, -0.56, 1.595), (0.0, -0.02, 1.578), 88.0, "Idle", 1),
        ("04_back.png", (0.28, 2.78, 0.98), (0.0, 0.0, 0.90), 52.0, "Idle", 12),
        ("05_walk.png", (-1.85, -2.05, 0.95), (0.0, 0.0, 0.86), 50.0, "Walk", 9),
        ("06_interact.png", (1.65, -2.10, 0.90), (0.0, -0.05, 0.78), 52.0, "Interact", 18),
    ]

    tile_paths = []
    for fname, cpos, clook, lens, clip, fr in views:
        p = os.path.join(tmp_dir, fname)
        print(f"[mara_qa] Rendering {fname} (clip={clip}@{fr})...")
        tile_paths.append(_render_view(p, cpos, clook, lens, clip, fr))

    cols, rows = 3, 2
    sw, sh = cols * tile_w, rows * tile_h
    sheet_arr = np.full((sh, sw, 4), [0.015, 0.02, 0.035, 1.0], dtype=np.float32)

    for idx, p in enumerate(tile_paths):
        img = bpy.data.images.load(p)
        px = np.empty(tile_w * tile_h * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        tile_arr = px.reshape((tile_h, tile_w, 4))
        col = idx % cols
        row = rows - 1 - (idx // cols)
        sheet_arr[row * tile_h : (row + 1) * tile_h, col * tile_w : (col + 1) * tile_w, :] = tile_arr
        bpy.data.images.remove(img)

    sheet = bpy.data.images.new("MaraQASheet", width=sw, height=sh, alpha=False)
    sheet.pixels.foreach_set(sheet_arr.ravel())
    sheet.filepath_raw = out_png
    sheet.file_format = "PNG"
    sheet.save()
    print(f"[mara_qa] Saved 6-view QA sheet ({sw}x{sh}) to {out_png}")


def main() -> None:
    qa_path: Optional[str] = None
    argv = sys.argv
    if "--" in argv:
        extra = argv[argv.index("--") + 1 :]
        if "--qa" in extra:
            qi = extra.index("--qa")
            if qi + 1 < len(extra):
                qa_path = extra[qi + 1]

    print("[build_mara] Building V2 photorealistic rigged Mara Voss (gpt-image-2 packed PBR)...")
    stats = build_mara_glb(OUT_GLB)
    print("[build_mara] Export stats:", json.dumps(stats, indent=2))

    vstats = verify_exported_glb(OUT_GLB)
    print("[build_mara] Binary GLB verification:", json.dumps(vstats, indent=2))
    assert not vstats["missingBones"], f"Missing bones: {vstats['missingBones']}"
    assert not vstats["missingClips"], f"Missing clips: {vstats['missingClips']}"
    assert abs(vstats["minY"]) < 0.005, f"Not grounded at y=0: {vstats['minY']}"

    if qa_path:
        render_qa_sheet(OUT_GLB, qa_path)


if __name__ == "__main__":
    main()
