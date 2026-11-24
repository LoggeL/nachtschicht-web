"""Photorealistic Round 2 Blender 5.2 generator for Nachtschicht Architecture & Heist/Street Props.

Generates 10 high-detail, UV-mapped, packed-PBR (albedo + Sobel normal + ORM from Codex CLI gpt-image-2)
glTF 2.0 (.glb) assets into `public/assets/models/`:
  1. salou_facade.glb    - Multi-story Catalan Mediterranean facade (recessed shopfront interior, louvered shutters, ornate wrought-iron balcony, pleated awning, neon/brass signage)
  2. dresden_pillar.glb  - Dresdner Barock Elbsandstein concave-fluted Corinthian columns, voussoir arch & keystone cartouche, veined marble niches, gilded glass wall sconces
  3. palm_tree.glb       - Segmented fibrous curved palm trunk + 18 layered multi-leaflet arched feathered palm fronds
  4. streetlamp.glb      - Ornate cast-iron Mediterranean coastal lamppost, filigree scrollwork bracket, glass-paned lantern cage & warm Edison filament core
  5. safe.glb            - Heavy machined vault safe, chamfered frame, knurled combination dial + 3-spoke vault wheel, locking bolts, felt-lined gold/cash/jewel interior
  6. display_case.glb    - Museum veined-marble plinth, crimson velvet cushion, mitered brass/steel glass vitrine, ceiling micro-spotlights & multi-faceted royal jewel
  7. power_box.glb       - Weathered industrial Securion breaker cabinet, steel conduits, hinged door revealing internal copper busbars/breakers, pivoting Breaker_Lever & LEDs
  8. security_camera.glb - Architectural bullet CCTV camera, bolted gooseneck mount, coiled armored cable whip, vented sun hood, multi-element glass lens + 12-LED IR ring
  9. door_detailed.glb   - Framed walnut/steel security door with glazed transom, mortise lock cylinder, brass kickplate, lever Door_Handle & edge-hinged Door_Leaf
 10. cafe_terrace.glb    - Salou promenade terrace dressing: veined-marble brass bistro table + glass candle lantern, two scroll wrought-iron chairs, terracotta urn planter & street bollard

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_env_props.py
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_env_props.py -- --qa-out /path/to/env_props_qa.png
"""

from __future__ import annotations

import math
import os
import sys
import time
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "models")
DEFAULT_TEX_DIR = "/Users/logge/.gemini/antigravity-cli/brain/effc8a92-1a97-43cb-a19c-74d7ec11f191/scratch/pbr_textures"


# ===========================================================================
# Color, Packed-PBR Material & Texture Utilities
# ===========================================================================

def srgb_to_linear(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(hex_str: str, alpha: float = 1.0) -> Tuple[float, float, float, float]:
    s = hex_str.lstrip("#")
    return (
        srgb_to_linear(int(s[0:2], 16) / 255.0),
        srgb_to_linear(int(s[2:4], 16) / 255.0),
        srgb_to_linear(int(s[4:6], 16) / 255.0),
        alpha,
    )


def hex_srgb_tuple(hex_str: str) -> Tuple[float, float, float]:
    s = hex_str.lstrip("#")
    return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if bpy.context.scene.world is None:
        bpy.context.scene.world = bpy.data.worlds.new("World")


def _load_image_packed(
    filepath: str,
    name: str,
    is_data: bool = False,
    max_res: Optional[int] = None,
) -> Optional[bpy.types.Image]:
    if not os.path.exists(filepath):
        return None
    if name in bpy.data.images:
        return bpy.data.images[name]
    img = bpy.data.images.load(filepath, check_existing=False)
    img.name = name
    img.colorspace_settings.name = "Non-Color" if is_data else "sRGB"
    if max_res is not None and (img.size[0] > max_res or img.size[1] > max_res):
        img.scale(max_res, max_res)
    try:
        img.pack()
    except Exception:
        pass
    return img


def _load_tinted_albedo(
    filepath: str,
    name: str,
    tint_hex: str,
    desat: float = 0.0,
    brightness: float = 1.0,
    max_res: Optional[int] = 512,
) -> Optional[bpy.types.Image]:
    """Load a real generated albedo JPEG and bake a clean color tint/brightness into pixel buffer for spec-pure glTF."""
    if name in bpy.data.images:
        return bpy.data.images[name]
    if not os.path.exists(filepath):
        return None
    tmp = bpy.data.images.load(filepath, check_existing=False)
    if max_res is not None and (tmp.size[0] > max_res or tmp.size[1] > max_res):
        tmp.scale(max_res, max_res)
    w, h = tmp.size[0], tmp.size[1]
    px = np.empty(w * h * 4, dtype=np.float32)
    tmp.pixels.foreach_get(px)
    bpy.data.images.remove(tmp)

    arr = px.reshape((h, w, 4))
    if desat > 0.0:
        lum = 0.299 * arr[..., 0] + 0.587 * arr[..., 1] + 0.114 * arr[..., 2]
        for ch in range(3):
            arr[..., ch] = arr[..., ch] * (1.0 - desat) + lum * desat
    tr, tg, tb = hex_srgb_tuple(tint_hex)
    arr[..., 0] = np.clip(arr[..., 0] * tr * brightness, 0.0, 1.0)
    arr[..., 1] = np.clip(arr[..., 1] * tg * brightness, 0.0, 1.0)
    arr[..., 2] = np.clip(arr[..., 2] * tb * brightness, 0.0, 1.0)
    arr[..., 3] = 1.0

    img = bpy.data.images.new(name, width=w, height=h, alpha=False)
    img.colorspace_settings.name = "sRGB"
    img.pixels.foreach_set(arr.ravel())
    img.pack()
    return img


def _load_calibrated_orm(
    filepath: str,
    name: str,
    metallic_override: Optional[float] = None,
    roughness_bias: float = 0.0,
    max_res: int = 256,
) -> Optional[bpy.types.Image]:
    """Load ORM map (256px for lean web payload) with optional metallic/roughness calibration."""
    if name in bpy.data.images:
        return bpy.data.images[name]
    if not os.path.exists(filepath):
        return None
    if metallic_override is None and abs(roughness_bias) < 1e-4:
        return _load_image_packed(filepath, name, is_data=True, max_res=max_res)
    tmp = bpy.data.images.load(filepath, check_existing=False)
    if tmp.size[0] > max_res or tmp.size[1] > max_res:
        tmp.scale(max_res, max_res)
    w, h = tmp.size[0], tmp.size[1]
    px = np.empty(w * h * 4, dtype=np.float32)
    tmp.pixels.foreach_get(px)
    bpy.data.images.remove(tmp)

    arr = px.reshape((h, w, 4))
    if abs(roughness_bias) > 1e-4:
        arr[..., 1] = np.clip(arr[..., 1] + roughness_bias, 0.04, 0.98)
    if metallic_override is not None:
        arr[..., 2] = float(metallic_override)
    arr[..., 3] = 1.0

    img = bpy.data.images.new(name, width=w, height=h, alpha=False, is_data=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(arr.ravel())
    img.pack()
    return img


def make_pbr_tex_material(
    name: str,
    tex_key: str,
    tex_dir: str = DEFAULT_TEX_DIR,
    normal_strength: float = 0.85,
    tint_hex: Optional[str] = None,
    desat: float = 0.0,
    brightness: float = 1.0,
    metallic_override: Optional[float] = None,
    roughness_bias: float = 0.0,
    coat: float = 0.0,
    coat_roughness: float = 0.12,
    double_sided: bool = False,
    fallback_color: str = "#888888",
    fallback_metallic: float = 0.0,
    fallback_roughness: float = 0.65,
) -> bpy.types.Material:
    """Create a packed-PBR material wired with real generated Albedo + Normal + glTF ORM maps."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]

    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        nt.nodes.clear()
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    albedo_path = os.path.join(tex_dir, f"{tex_key}_albedo.jpg")
    normal_path = os.path.join(tex_dir, f"{tex_key}_normal.jpg")
    orm_path = os.path.join(tex_dir, f"{tex_key}_orm.jpg")

    if tint_hex or abs(brightness - 1.0) > 1e-3:
        img_a = _load_tinted_albedo(albedo_path, f"{name}_albedo", tint_hex or "#FFFFFF", desat=desat, brightness=brightness, max_res=512)
    else:
        img_a = _load_image_packed(albedo_path, f"{tex_key}_albedo", is_data=False, max_res=512)
    img_n = _load_image_packed(normal_path, f"{tex_key}_normal", is_data=True, max_res=384)
    orm_name = f"{name}_orm" if (metallic_override is not None or abs(roughness_bias) > 1e-4) else f"{tex_key}_orm"
    img_o = _load_calibrated_orm(orm_path, orm_name, metallic_override=metallic_override, roughness_bias=roughness_bias, max_res=256)

    if img_a is not None:
        ta = nt.nodes.new("ShaderNodeTexImage")
        ta.image = img_a
        nt.links.new(ta.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = hex_rgba(fallback_color)

    if img_o is not None:
        to = nt.nodes.new("ShaderNodeTexImage")
        to.image = img_o
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(to.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
    else:
        bsdf.inputs["Roughness"].default_value = float(fallback_roughness)
        bsdf.inputs["Metallic"].default_value = float(fallback_metallic)

    if img_n is not None and normal_strength > 0.0:
        tn = nt.nodes.new("ShaderNodeTexImage")
        tn.image = img_n
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.inputs["Strength"].default_value = float(normal_strength)
        nt.links.new(tn.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])

    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = float(coat)
        bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)

    mat.blend_method = "OPAQUE"
    mat.use_backface_culling = not double_sided
    return mat


def make_solid_material(
    name: str,
    color: str,
    metallic: float = 0.0,
    roughness: float = 0.45,
    emission: Optional[str] = None,
    emission_strength: float = 0.0,
    alpha: float = 1.0,
    coat: float = 0.0,
    coat_roughness: float = 0.08,
    double_sided: bool = False,
) -> bpy.types.Material:
    """Create clean metallic, glass, or emissive PBR material (brass, chrome, glass, neon, filament)."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]
    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True
    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = hex_rgba(color, 1.0)
    bsdf.inputs["Metallic"].default_value = float(metallic)
    bsdf.inputs["Roughness"].default_value = float(roughness)
    bsdf.inputs["Alpha"].default_value = float(alpha)
    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = float(coat)
        bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)
    if emission is not None and emission_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(emission, 1.0)
        bsdf.inputs["Emission Strength"].default_value = float(emission_strength)

    if alpha < 0.999:
        mat.blend_method = "BLEND"
        mat.use_backface_culling = False
    else:
        mat.blend_method = "OPAQUE"
        mat.use_backface_culling = not double_sided
    return mat


# ===========================================================================
# High-Craft Procedural BMesh Builder with Explicit Metric & Parametric UVs
# ===========================================================================

def _xform(center: Sequence[float], rot: Sequence[float] = (0.0, 0.0, 0.0)) -> Matrix:
    return Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()


class MeshBuilder:
    """Precision architectural BMesh builder supporting bevels, fluted lofts, tubes & explicit UVs."""

    def __init__(self, default_uv_tile: float = 1.2) -> None:
        self.bm = bmesh.new()
        self.uv_layer = self.bm.loops.layers.uv.verify()
        self.materials: List[bpy.types.Material] = []
        self._mat_index: Dict[str, int] = {}
        self.default_uv_tile = float(default_uv_tile)
        self._uv_assigned_faces: set[int] = set()

    def mat_idx(self, mat: bpy.types.Material) -> int:
        if mat.name not in self._mat_index:
            self._mat_index[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self._mat_index[mat.name]

    def _tag_faces(self, faces: Iterable[bmesh.types.BMFace], mat: bpy.types.Material, smooth: bool, uv_tile: Optional[float] = None) -> None:
        idx = self.mat_idx(mat)
        tile = float(uv_tile) if uv_tile is not None else self.default_uv_tile
        inv_t = 1.0 / max(tile, 1e-4)
        for f in faces:
            if not f.is_valid:
                continue
            f.material_index = idx
            f.smooth = smooth
            # Assign clean metric triplanar box UVs right away
            f.normal_update()
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for loop in f.loops:
                co = loop.vert.co
                if az >= ax and az >= ay:
                    loop[self.uv_layer].uv = (co.x * inv_t, co.y * inv_t)
                elif ax >= ay and ax >= az:
                    loop[self.uv_layer].uv = (co.y * inv_t, co.z * inv_t)
                else:
                    loop[self.uv_layer].uv = (co.x * inv_t, co.z * inv_t)

    def add_box(
        self,
        center: Sequence[float],
        size: Sequence[float],
        mat: bpy.types.Material,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        bevel: float = 0.0,
        bevel_segments: int = 2,
        smooth: bool = False,
        taper_top: Tuple[float, float] = (1.0, 1.0),
        taper_bottom: Tuple[float, float] = (1.0, 1.0),
        uv_tile: Optional[float] = None,
    ) -> None:
        sx, sy, sz = float(size[0]), float(size[1]), float(size[2])
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        tbx, tby = taper_bottom
        ttx, tty = taper_top
        existing_verts = set(self.bm.verts)
        existing_faces = set(self.bm.faces)
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
        face_defs = [
            (0, 3, 2, 1), (4, 5, 6, 7),
            (0, 1, 5, 4), (2, 3, 7, 6),
            (1, 2, 6, 5), (3, 0, 4, 7),
        ]
        faces = [self.bm.faces.new([verts[i] for i in fd]) for fd in face_defs]
        if bevel > 0.0:
            b_amt = min(float(bevel), min(sx, sy, sz) * 0.40)
            edges = list({e for f in faces for e in f.edges})
            bmesh.ops.bevel(
                self.bm,
                geom=edges,
                offset=b_amt,
                offset_type="OFFSET",
                segments=bevel_segments,
                profile=0.5,
                affect="EDGES",
                clamp_overlap=True,
            )
        all_verts = [v for v in self.bm.verts if v not in existing_verts]
        all_faces = [f for f in self.bm.faces if f not in existing_faces]
        bmesh.ops.transform(self.bm, matrix=_xform(center, rot), verts=all_verts)
        self._tag_faces(all_faces, mat, smooth, uv_tile=uv_tile)

    def add_cylinder(
        self,
        center: Sequence[float],
        radius_bottom: float,
        radius_top: float,
        height: float,
        mat: bpy.types.Material,
        segments: int = 20,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        cap: bool = True,
        uv_tile: Optional[float] = None,
    ) -> None:
        existing = set(self.bm.faces)
        bmesh.ops.create_cone(
            self.bm,
            cap_ends=cap,
            cap_tris=False,
            segments=segments,
            radius1=float(radius_bottom),
            radius2=float(radius_top),
            depth=float(height),
            matrix=_xform(center, rot),
        )
        new_faces = [f for f in self.bm.faces if f not in existing]
        idx = self.mat_idx(mat)
        tile = float(uv_tile) if uv_tile is not None else self.default_uv_tile
        inv_t = 1.0 / max(tile, 1e-4)
        for f in new_faces:
            f.material_index = idx
            f.smooth = False if len(f.verts) > 4 else smooth
            f.normal_update()
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for loop in f.loops:
                co = loop.vert.co
                if az >= ax and az >= ay:
                    loop[self.uv_layer].uv = (co.x * inv_t, co.y * inv_t)
                elif ax >= ay and ax >= az:
                    loop[self.uv_layer].uv = (co.y * inv_t, co.z * inv_t)
                else:
                    loop[self.uv_layer].uv = (co.x * inv_t, co.z * inv_t)

    def add_sphere(
        self,
        center: Sequence[float],
        radius: float,
        mat: bpy.types.Material,
        scale: Sequence[float] = (1.0, 1.0, 1.0),
        segments: int = 16,
        rings: int = 12,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        uv_tile: Optional[float] = None,
    ) -> None:
        existing = set(self.bm.faces)
        mat4 = _xform(center, rot) @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        bmesh.ops.create_uvsphere(self.bm, u_segments=segments, v_segments=rings, radius=float(radius), matrix=mat4)
        new_faces = [f for f in self.bm.faces if f not in existing]
        self._tag_faces(new_faces, mat, smooth, uv_tile=uv_tile)

    def add_loft(
        self,
        rings: Sequence[Sequence[Sequence[float]]],
        mat: bpy.types.Material,
        cap_start: bool = True,
        cap_end: bool = True,
        smooth: bool = True,
        closed_u: bool = True,
        u_repeat: float = 1.0,
        v_repeat: float = 1.0,
    ) -> None:
        """Skin a quad mesh across cross-section rings with clean parametric (u, v) cylindrical/strip UVs."""
        if len(rings) < 2:
            return
        n = len(rings[0])
        m = len(rings)
        v_rings = [[self.bm.verts.new(tuple(pt)) for pt in ring] for ring in rings]
        idx = self.mat_idx(mat)

        for r_i in range(m - 1):
            r0, r1 = v_rings[r_i], v_rings[r_i + 1]
            v0 = (r_i / (m - 1)) * v_repeat
            v1 = ((r_i + 1) / (m - 1)) * v_repeat
            count = n if closed_u else (n - 1)
            for j in range(count):
                jn = (j + 1) % n
                quad = [r0[j], r0[jn], r1[jn], r1[j]]
                if len(set(quad)) == 4:
                    try:
                        f = self.bm.faces.new(quad)
                        f.material_index = idx
                        f.smooth = smooth
                        u0 = (j / count) * u_repeat
                        u1 = ((j + 1) / count) * u_repeat
                        uvs = [(u0, v0), (u1, v0), (u1, v1), (u0, v1)]
                        for loop, uv in zip(f.loops, uvs):
                            loop[self.uv_layer].uv = uv
                    except ValueError:
                        pass

        if cap_start and closed_u and n >= 3:
            try:
                f = self.bm.faces.new(list(reversed(v_rings[0])))
                f.smooth = False
                f.material_index = idx
                for loop in f.loops:
                    loop[self.uv_layer].uv = (loop.vert.co.x, loop.vert.co.y)
            except ValueError:
                pass
        if cap_end and closed_u and n >= 3:
            try:
                f = self.bm.faces.new(list(v_rings[-1]))
                f.smooth = False
                f.material_index = idx
                for loop in f.loops:
                    loop[self.uv_layer].uv = (loop.vert.co.x, loop.vert.co.y)
            except ValueError:
                pass

    def add_tube(
        self,
        points: Sequence[Sequence[float]],
        radii: float | Sequence[float],
        mat: bpy.types.Material,
        segments: int = 10,
        smooth: bool = True,
        cap: bool = True,
        v_repeat: float = 2.0,
    ) -> None:
        pts = [Vector(p) for p in points]
        if len(pts) < 2:
            return
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
                tangent = (t1 + t2).normalized() if (t1 + t2).length > 1e-5 else t2

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
            ring = [tuple(p + (nrm * math.cos(2 * math.pi * s / segments) + binrm * math.sin(2 * math.pi * s / segments)) * r) for s in range(segments)]
            rings.append(ring)
        self.add_loft(rings, mat, cap_start=cap, cap_end=cap, smooth=smooth, closed_u=True, u_repeat=1.0, v_repeat=v_repeat)

    def add_quad_uv(
        self,
        v0: Sequence[float],
        v1: Sequence[float],
        v2: Sequence[float],
        v3: Sequence[float],
        mat: bpy.types.Material,
        uvs: Sequence[Tuple[float, float]] = ((0, 0), (1, 0), (1, 1), (0, 1)),
        smooth: bool = False,
    ) -> None:
        verts = [self.bm.verts.new(tuple(v)) for v in (v0, v1, v2, v3)]
        try:
            f = self.bm.faces.new(verts)
            f.material_index = self.mat_idx(mat)
            f.smooth = smooth
            for loop, uv in zip(f.loops, uvs):
                loop[self.uv_layer].uv = uv
        except ValueError:
            pass

    def finalize(
        self,
        name: str,
        location: Sequence[float] = (0.0, 0.0, 0.0),
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        parent: Optional[bpy.types.Object] = None,
    ) -> bpy.types.Object:
        self.bm.normal_update()
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()
        for m in self.materials:
            mesh.materials.append(m)
        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        if parent is not None:
            obj.parent = parent
            obj.matrix_parent_inverse = Matrix.Identity(4)
        obj.location = Vector(location)
        obj.rotation_euler = Euler(rot, "XYZ")
        obj.scale = Vector((1.0, 1.0, 1.0))
        return obj


def ground_scene_to_zero() -> None:
    bpy.context.view_layer.update()
    min_z = float("inf")
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        for v in obj.data.vertices:
            wz = (obj.matrix_world @ v.co).z
            if wz < min_z:
                min_z = wz
    if min_z != float("inf") and abs(min_z) > 1e-6:
        for obj in bpy.context.scene.objects:
            if obj.parent is None:
                obj.location.z -= min_z
        bpy.context.view_layer.update()


def export_model_glb(out_dir: str, filename: str, ground: bool = True) -> int:
    os.makedirs(out_dir, exist_ok=True)
    if ground:
        ground_scene_to_zero()
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
        export_jpeg_quality=76,
        export_lights=False,
        export_cameras=False,
        export_animations=False,
    )
    return os.path.getsize(filepath)


# ===========================================================================
# 1. SALOU FACADE (Catalan Mediterranean Townhouse / Hotel Facade)
# ===========================================================================

def build_salou_facade(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_stucco = make_pbr_tex_material("Salou_CatalanStucco", "catalan_stucco", tex_dir, normal_strength=1.15)
    mat_limestone = make_pbr_tex_material("Salou_LimestoneAshlar", "limestone_ashlar", tex_dir, normal_strength=1.25)
    mat_plinth = make_pbr_tex_material("Salou_DarkPlinth", "limestone_ashlar", tex_dir, normal_strength=1.1, tint_hex="#7A736A")
    mat_shutter = make_pbr_tex_material("Salou_TealLouverWood", "weathered_wood_door", tex_dir, normal_strength=0.95, tint_hex="#5CB4A6", desat=0.92, brightness=1.55)
    mat_wood = make_pbr_tex_material("Salou_WalnutDoor", "weathered_wood_door", tex_dir, normal_strength=0.95, brightness=1.15, coat=0.25)
    mat_iron = make_pbr_tex_material("Salou_WroughtIron", "hammered_wrought_iron", tex_dir, normal_strength=1.0)
    mat_tile = make_pbr_tex_material("Salou_TerracottaTile", "terracotta_tiles", tex_dir, normal_strength=1.2)
    mat_awning = make_pbr_tex_material("Salou_AwningCanvas", "awning_fabric", tex_dir, normal_strength=0.85, double_sided=True)
    mat_brass = make_solid_material("Salou_BrushedBrass", "#D6AA4C", metallic=0.92, roughness=0.26)
    mat_glass_shop = make_solid_material("Salou_ShopGlass", "#A8D0E4", metallic=0.05, roughness=0.06, alpha=0.28, coat=1.0, double_sided=True)
    mat_win_warm = make_solid_material("Salou_WarmWindow", "#FFBF66", roughness=0.14, emission="#FFA838", emission_strength=2.3, coat=0.8)
    mat_win_dark = make_solid_material("Salou_DarkWindow", "#101B28", metallic=0.15, roughness=0.08, coat=0.9)
    mat_interior_back = make_solid_material("Salou_InteriorGlow", "#D98A3A", roughness=0.75, emission="#FFAE4A", emission_strength=1.35)
    mat_interior_wall = make_pbr_tex_material("Salou_InteriorPlaster", "catalan_stucco", tex_dir, normal_strength=0.6, tint_hex="#A87654")
    mat_neon_cyan = make_solid_material("Salou_CyanNeon", "#38F2E4", emission="#2EE8DA", emission_strength=4.8, roughness=0.12)
    mat_neon_amber = make_solid_material("Salou_AmberNeon", "#FFD07A", emission="#FFAC42", emission_strength=4.2, roughness=0.12)

    # ------------------------------------------------------------------
    # 1. Facade_Wall (stone ground floor w/ recessed boutique room + stucco upper stories + louvered shutters + barrel roof)
    # ------------------------------------------------------------------
    wall = MeshBuilder(default_uv_tile=1.6)

    # Ground floor solid structural surround leaving a REAL recessed shopfront cavity at x=[-0.60..+2.36], z=[0.44..2.46], y=[0..0.85]
    wall.add_box((-1.80, 0.80, 1.55), (2.40, 1.60, 3.10), mat_limestone, uv_tile=1.8)   # left entrance bay solid
    wall.add_box((2.68, 0.80, 1.55), (0.64, 1.60, 3.10), mat_limestone, uv_tile=1.8)    # right pier
    wall.add_box((0.88, 0.80, 0.24), (3.00, 1.60, 0.48), mat_plinth, uv_tile=1.5)       # low shopfront kneewall
    wall.add_box((0.88, 0.80, 2.78), (3.00, 1.60, 0.64), mat_limestone, uv_tile=1.8)    # shopfront lintel beam
    wall.add_box((0.88, 1.24, 1.55), (3.00, 0.72, 2.20), mat_interior_wall, uv_tile=1.5) # recessed interior back wall

    # Recessed shopfront boutique interior detail (warm lit shelving + counter visible through glass!)
    wall.add_box((0.88, 0.86, 1.50), (2.68, 0.05, 1.76), mat_interior_back)              # warm backlit interior wall panel
    wall.add_box((0.88, 0.56, 0.72), (2.30, 0.42, 0.52), mat_wood, bevel=0.015, uv_tile=0.8)  # wood display counter
    for sz in (1.30, 1.72):
        wall.add_box((0.88, 0.74, sz), (2.20, 0.22, 0.04), mat_wood, uv_tile=0.8)
        for dx in (-0.70, -0.20, 0.35, 0.82):
            wall.add_cylinder((0.88 + dx, 0.72, sz + 0.11), 0.055, 0.045, 0.18, mat_brass, segments=10)

    # Stone plinth & corner quoined pilasters
    wall.add_box((-1.80, 0.78, 0.22), (2.46, 1.66, 0.44), mat_plinth, uv_tile=1.5)
    for sx in (-2.84, 2.84):
        wall.add_box((sx, -0.04, 1.55), (0.34, 0.10, 3.10), mat_limestone, bevel=0.015, uv_tile=1.6)

    # Upper Catalan terracotta stucco block (2nd & 3rd floors: z=3.1..8.1)
    wall.add_box((0.0, 0.80, 5.60), (6.00, 1.60, 5.00), mat_stucco, uv_tile=2.2)

    # Molded limestone stringcourses & stepped eaves cornice
    wall.add_box((0.0, -0.06, 3.12), (6.08, 0.18, 0.18), mat_limestone, bevel=0.02, uv_tile=1.6)
    wall.add_box((0.0, -0.09, 3.22), (6.12, 0.22, 0.07), mat_limestone, bevel=0.01, uv_tile=1.6)
    wall.add_box((0.0, -0.05, 5.68), (6.06, 0.14, 0.15), mat_limestone, bevel=0.015, uv_tile=1.6)
    wall.add_box((0.0, -0.10, 7.96), (6.10, 0.24, 0.14), mat_limestone, bevel=0.015, uv_tile=1.6)
    wall.add_box((0.0, -0.16, 8.12), (6.18, 0.36, 0.18), mat_limestone, bevel=0.02, uv_tile=1.6)

    def add_hollow_frame(cx: float, cz: float, w: float, h: float, thick: float, depth: float, mat) -> None:
        wall.add_box((cx, -depth * 0.5, cz + h * 0.5 + thick * 0.5), (w + thick * 2, depth, thick), mat, bevel=0.012, uv_tile=1.4)
        wall.add_box((cx, -depth * 0.5, cz - h * 0.5 - thick * 0.5), (w + thick * 2, depth, thick), mat, bevel=0.012, uv_tile=1.4)
        wall.add_box((cx - w * 0.5 - thick * 0.5, -depth * 0.5, cz), (thick, depth, h), mat, bevel=0.012, uv_tile=1.4)
        wall.add_box((cx + w * 0.5 + thick * 0.5, -depth * 0.5, cz), (thick, depth, h), mat, bevel=0.012, uv_tile=1.4)

    def add_louvered_shutter(cx: float, cz: float, w: float, h: float, slats: int = 9) -> None:
        """Real framed wooden shutter with individual angled horizontal louver slats & iron strap hinges."""
        y_s = -0.075
        ft = 0.048
        # Outer wood stile & rail frame
        wall.add_box((cx, y_s, cz + h * 0.5 - ft * 0.5), (w, 0.042, ft), mat_shutter, bevel=0.005, uv_tile=0.8)
        wall.add_box((cx, y_s, cz - h * 0.5 + ft * 0.5), (w, 0.042, ft), mat_shutter, bevel=0.005, uv_tile=0.8)
        wall.add_box((cx - w * 0.5 + ft * 0.5, y_s, cz), (ft, 0.042, h - ft * 2), mat_shutter, bevel=0.005, uv_tile=0.8)
        wall.add_box((cx + w * 0.5 - ft * 0.5, y_s, cz), (ft, 0.042, h - ft * 2), mat_shutter, bevel=0.005, uv_tile=0.8)
        wall.add_box((cx, y_s, cz), (w - ft * 2, 0.036, 0.04), mat_shutter, uv_tile=0.8)  # center lock rail
        # Individual angled louver blades
        inner_h = h - ft * 2.4
        for i in range(slats):
            sz = (cz - inner_h * 0.5) + (i + 0.5) * (inner_h / slats)
            if abs(sz - cz) < 0.04:
                continue
            wall.add_box((cx, y_s - 0.004, sz), (w - ft * 2.1, 0.034, 0.016), mat_shutter, rot=(0.48, 0.0, 0.0), uv_tile=0.8)
        # Wrought-iron decorative strap hinges
        for hz in (cz - h * 0.34, cz + h * 0.34):
            wall.add_box((cx, y_s - 0.022, hz), (w * 0.55, 0.008, 0.028), mat_iron, uv_tile=0.5)

    # Recessed paneled walnut doorway on ground-left + carved keystone lintel
    add_hollow_frame(-1.80, 1.24, 1.12, 2.26, 0.14, 0.14, mat_plinth)
    wall.add_box((-1.80, -0.09, 2.46), (0.22, 0.16, 0.24), mat_limestone, bevel=0.015, taper_bottom=(0.76, 0.85))
    wall.add_box((-1.80, 0.03, 1.24), (1.10, 0.08, 2.24), mat_wood, bevel=0.01, uv_tile=0.9)
    for pz in (0.68, 1.66):
        wall.add_box((-1.80, -0.01, pz), (0.78, 0.03, 0.68), mat_wood, bevel=0.015, uv_tile=0.9)
    wall.add_box((-1.80, -0.015, 0.16), (1.06, 0.02, 0.18), mat_brass)
    wall.add_box((-1.38, -0.055, 1.12), (0.04, 0.07, 0.24), mat_brass, bevel=0.008)

    # Shopfront stone frame around recessed boutique glazing
    add_hollow_frame(0.88, 1.48, 2.94, 1.98, 0.14, 0.14, mat_plinth)

    # 2nd floor French balcony door frames + real multi-slat louvered teal shutters
    for wx in (-1.55, 1.55):
        add_hollow_frame(wx, 4.38, 1.08, 1.98, 0.11, 0.10, mat_limestone)
        add_louvered_shutter(wx - 0.84, 4.38, 0.44, 2.02, slats=11)
        add_louvered_shutter(wx + 0.84, 4.38, 0.44, 2.02, slats=11)

    # 3rd floor windows + moulded sills + real louvered shutters
    for wx in (-1.85, 0.0, 1.85):
        add_hollow_frame(wx, 6.84, 0.84, 1.30, 0.10, 0.10, mat_limestone)
        wall.add_box((wx, -0.11, 6.10), (1.18, 0.20, 0.10), mat_limestone, bevel=0.012)
        add_louvered_shutter(wx - 0.68, 6.84, 0.35, 1.34, slats=8)
        add_louvered_shutter(wx + 0.68, 6.84, 0.35, 1.34, slats=8)

    # Exposed carved timber roof rafter tails + overlapping double-course Mediterranean barrel tiles (teja árabe)
    for i in range(11):
        rx = -2.75 + i * 0.55
        wall.add_box((rx, -0.22, 8.20), (0.09, 0.52, 0.11), mat_wood, rot=(0.14, 0.0, 0.0), bevel=0.01, uv_tile=0.7)
    wall.add_box((0.0, 0.56, 8.36), (6.16, 2.20, 0.18), mat_tile, rot=(0.14, 0.0, 0.0), bevel=0.02, uv_tile=1.2)
    for i in range(16):
        tx = -2.90 + i * 0.387
        wall.add_cylinder((tx, -0.36, 8.26), 0.088, 0.082, 0.62, mat_tile, segments=10, rot=(math.pi * 0.5 + 0.14, 0.0, 0.0), uv_tile=0.9)
        wall.add_cylinder((tx, 0.22, 8.35), 0.088, 0.082, 0.62, mat_tile, segments=10, rot=(math.pi * 0.5 + 0.14, 0.0, 0.0), uv_tile=0.9)

    wall.finalize("Facade_Wall")

    # ------------------------------------------------------------------
    # 2. Balcony (moulded stone slab + carved corbels + ornate wrought-iron balustrade w/ C-scrolls)
    # ------------------------------------------------------------------
    balc = MeshBuilder(default_uv_tile=0.8)
    balc.add_box((0.0, -0.48, 3.24), (4.88, 0.96, 0.15), mat_limestone, bevel=0.02, uv_tile=1.4)
    balc.add_box((0.0, -0.45, 3.14), (4.76, 0.88, 0.07), mat_plinth, bevel=0.01, uv_tile=1.4)
    for bx in (-2.08, -0.72, 0.72, 2.08):
        balc.add_box((bx, -0.34, 2.98), (0.18, 0.66, 0.32), mat_limestone, bevel=0.02, taper_bottom=(0.76, 0.42), uv_tile=1.2)

    ry = -0.90
    # Top & bottom forged handrails + decorative frieze rail
    balc.add_box((0.0, ry, 4.24), (4.78, 0.048, 0.044), mat_iron, bevel=0.008)
    balc.add_box((0.0, ry, 4.06), (4.76, 0.028, 0.026), mat_iron)
    balc.add_box((0.0, ry, 3.42), (4.78, 0.036, 0.032), mat_iron)
    # Corner newel posts with turned brass finials
    for sx in (-2.38, 2.38):
        balc.add_box((sx, ry, 3.84), (0.048, 0.048, 0.92), mat_iron, bevel=0.006)
        balc.add_sphere((sx, ry, 4.33), 0.036, mat_brass, segments=10, rings=8)
        balc.add_box((sx, -0.46, 4.24), (0.045, 0.90, 0.042), mat_iron, bevel=0.006)
        balc.add_box((sx, -0.46, 3.42), (0.032, 0.90, 0.030), mat_iron)
        for by in (-0.22, -0.45, -0.68):
            balc.add_cylinder((sx, by, 3.83), 0.012, 0.012, 0.82, mat_iron, segments=8)

    # Turned vertical balusters with mid-collar rings + decorative wrought-iron frieze scroll rings
    for i in range(21):
        bx = -2.20 + i * (4.40 / 20.0)
        balc.add_cylinder((bx, ry, 3.83), 0.012, 0.012, 0.82, mat_iron, segments=8)
        balc.add_sphere((bx, ry, 3.74), 0.020, mat_iron, scale=(1.0, 1.0, 1.35), segments=8, rings=6)
    # Ornate iron scroll medallions along the upper frieze band (z=4.15)
    for i in range(10):
        sx = -2.00 + i * (4.00 / 9.0)
        ring_pts = [(sx + math.cos(2 * math.pi * k / 10) * 0.075, ry, 4.15 + math.sin(2 * math.pi * k / 10) * 0.075) for k in range(11)]
        balc.add_tube(ring_pts, 0.010, mat_iron, segments=6, cap=False)

    balc.finalize("Balcony")

    # ------------------------------------------------------------------
    # 3. Awning (curved pleated woven striped canvas awning + scalloped valance + iron arms)
    # ------------------------------------------------------------------
    awn = MeshBuilder(default_uv_tile=1.0)
    x0, x1 = -0.82, 2.58
    cols = 12
    rows = 5
    # Curved gently-sagging awning mesh with clean (u, v) mapping so stripes run vertically down slope!
    for c in range(cols):
        u0, u1 = c / cols, (c + 1) / cols
        xa = x0 + (x1 - x0) * u0
        xb = x0 + (x1 - x0) * u1
        # Slight scalloped ripple across fabric pleats
        sag_a = math.sin(u0 * math.pi * 6.0) * 0.014
        sag_b = math.sin(u1 * math.pi * 6.0) * 0.014
        for r in range(rows):
            v0, v1 = r / rows, (r + 1) / rows
            ya = -0.02 - 0.98 * v0
            yb = -0.02 - 0.98 * v1
            # Gentle concave Mediterranean awning swoop
            za = 2.74 - 0.44 * (v0 ** 1.15) - 0.04 * math.sin(v0 * math.pi)
            zb = 2.74 - 0.44 * (v1 ** 1.15) - 0.04 * math.sin(v1 * math.pi)
            awn.add_quad_uv(
                (xa, ya, za + sag_a * v0),
                (xb, ya, za + sag_b * v0),
                (xb, yb, zb + sag_b * v1),
                (xa, yb, zb + sag_a * v1),
                mat_awning,
                uvs=((u0 * 2.0, v0), (u1 * 2.0, v0), (u1 * 2.0, v1), (u0 * 2.0, v1)),
                smooth=True,
            )
        # Hanging scalloped front valance flap
        val_drop_a = 0.20 + 0.045 * abs(math.sin(u0 * math.pi * 6.0))
        val_drop_b = 0.20 + 0.045 * abs(math.sin(u1 * math.pi * 6.0))
        awn.add_quad_uv(
            (xa, -1.00, 2.30 + sag_a),
            (xb, -1.00, 2.30 + sag_b),
            (xb, -1.00, 2.30 - val_drop_b),
            (xa, -1.00, 2.30 - val_drop_a),
            mat_awning,
            uvs=((u0 * 2.0, 0.8), (u1 * 2.0, 0.8), (u1 * 2.0, 1.0), (u0 * 2.0, 1.0)),
        )
    # Forged awning folding scissor arms & front roller bar
    awn.add_cylinder((0.88, -0.99, 2.30), 0.022, 0.022, 3.44, mat_iron, segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    for sx in (x0 + 0.08, x1 - 0.08):
        awn.add_tube([(sx, -0.02, 2.28), (sx, -0.50, 2.26), (sx, -0.98, 2.30)], 0.018, mat_iron, segments=8)
        awn.add_tube([(sx, -0.02, 2.72), (sx, -0.98, 2.30)], 0.015, mat_iron, segments=8)
    awn.finalize("Awning")

    # ------------------------------------------------------------------
    # 4. Windows_Warm (translucent shopfront glazing + mullions + warm/dark upper windows)
    # ------------------------------------------------------------------
    win = MeshBuilder(default_uv_tile=1.0)
    # Recessed real translucent shopfront glass pane (lets the interior wood counter & warm glow shine through!)
    win.add_quad_uv((-0.58, -0.035, 0.50), (2.34, -0.035, 0.50), (2.34, -0.035, 2.46), (-0.58, -0.035, 2.46), mat_glass_shop)
    # Refined bronze/iron shopfront mullion grid
    for mx in (0.04, 1.72):
        win.add_box((mx, -0.055, 1.48), (0.055, 0.05, 1.98), mat_iron, bevel=0.006)
    win.add_box((0.88, -0.055, 2.10), (2.94, 0.05, 0.048), mat_brass, bevel=0.006)
    # 2nd floor French doors (left warm-lit, right night-dark with crisp iron muntins)
    for wx, wmat in ((-1.55, mat_win_warm), (1.55, mat_win_dark)):
        win.add_box((wx, -0.032, 4.38), (1.06, 0.04, 1.96), wmat)
        win.add_box((wx, -0.062, 4.38), (0.048, 0.038, 1.96), mat_iron)
        for mz in (3.85, 4.42, 4.96):
            win.add_box((wx, -0.060, mz), (1.06, 0.032, 0.032), mat_iron)
    # 3rd floor windows
    for wx, wmat in ((-1.85, mat_win_dark), (0.0, mat_win_warm), (1.85, mat_win_warm)):
        win.add_box((wx, -0.032, 6.84), (0.82, 0.04, 1.28), wmat)
        win.add_box((wx, -0.058, 6.84), (0.04, 0.03, 1.28), mat_iron)
        win.add_box((wx, -0.058, 6.84), (0.82, 0.03, 0.035), mat_iron)
    win.finalize("Windows_Warm")

    # ------------------------------------------------------------------
    # 5. Neon_Sign (realistic backlit brass & glass Mediterranean night fascia sign)
    # ------------------------------------------------------------------
    neon = MeshBuilder(default_uv_tile=0.6)
    # Forged dark backing frame + brushed brass bezel mounted on balcony edge
    neon.add_box((0.0, -0.96, 3.24), (2.82, 0.07, 0.25), mat_iron, bevel=0.012)
    neon.add_box((0.0, -0.985, 3.36), (2.84, 0.03, 0.025), mat_brass)
    neon.add_box((0.0, -0.985, 3.12), (2.84, 0.03, 0.025), mat_brass)
    # Glass tube standoffs
    for sx in (-1.15, -0.38, 0.38, 1.15):
        neon.add_cylinder((sx, -1.00, 3.24), 0.010, 0.010, 0.05, mat_brass, segments=8, rot=(math.pi * 0.5, 0.0, 0.0))
    # Dual coastal cyan + warm amber neon glass tubes
    neon.add_cylinder((0.0, -1.02, 3.295), 0.020, 0.020, 2.54, mat_neon_cyan, segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    neon.add_cylinder((0.0, -1.02, 3.195), 0.016, 0.016, 2.12, mat_neon_amber, segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    neon.finalize("Neon_Sign")

    return export_model_glb(out_dir, "salou_facade.glb", ground=True)


# ===========================================================================
# 2. DRESDEN PILLAR (Dresdner Barock Elbsandstein Column & Arch Module)
# ===========================================================================

def _add_concave_fluted_column(
    mb: MeshBuilder,
    cx: float,
    cy: float,
    z0: float,
    z1: float,
    r_bot: float,
    r_top: float,
    flutes: int,
    flute_depth: float,
    mat,
) -> None:
    """Sculpt a true classical concave-fluted column shaft with smooth Greek/Baroque entasis."""
    z_steps = 12
    # 3 samples per flute (fillet, deep concave flute center, fillet) -> crisp sculptural flutes
    ang_steps = flutes * 3
    rings = []
    for iz in range(z_steps + 1):
        t = iz / z_steps
        z = z0 + (z1 - z0) * t
        # Classical entasis curve: gentle convex swell peaking around t=0.33
        entasis = 1.0 + 0.045 * math.sin(t * math.pi)
        r_base = (r_bot * (1.0 - t) + r_top * t) * entasis
        # Taper fluting smoothly into circular collars at very bottom & top
        flute_env = math.sin(min(1.0, t / 0.07) * math.pi * 0.5) * math.sin(min(1.0, (1.0 - t) / 0.07) * math.pi * 0.5)
        ring = []
        for ia in range(ang_steps):
            ang = (2.0 * math.pi * ia) / ang_steps
            sub = ia % 3
            # sub==1 is center of concave flute groove; sub==0/2 are flat raised fillets
            depth = flute_depth * flute_env if sub == 1 else 0.0
            r = r_base - depth
            ring.append((cx + math.cos(ang) * r, cy + math.sin(ang) * r, z))
        rings.append(ring)
    mb.add_loft(rings, mat, cap_start=True, cap_end=True, smooth=False, closed_u=True, u_repeat=2.0, v_repeat=3.0)


def build_dresden_pillar(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_sandstone = make_pbr_tex_material("Dresden_Elbsandstein", "elbsandstein_baroque", tex_dir, normal_strength=1.3)
    mat_aged = make_pbr_tex_material("Dresden_AgedSandstone", "elbsandstein_baroque", tex_dir, normal_strength=1.35, tint_hex="#B8ADA0")
    mat_marble = make_pbr_tex_material("Dresden_DarkMarble", "veined_dark_marble", tex_dir, normal_strength=0.5, coat=0.75)
    mat_gold = make_solid_material("Dresden_GoldLeaf", "#DFB246", metallic=0.94, roughness=0.20, coat=0.3)
    mat_bronze = make_pbr_tex_material("Dresden_Bronze", "hammered_wrought_iron", tex_dir, normal_strength=0.9, tint_hex="#7A5A34")
    mat_globe = make_solid_material("Dresden_FrostedGlobe", "#FFF0D0", roughness=0.12, alpha=0.36, coat=0.9, double_sided=True)
    mat_glow = make_solid_material("Dresden_FilamentGlow", "#FFD47A", emission="#FFB945", emission_strength=5.5, roughness=0.1)

    # ------------------------------------------------------------------
    # 1. Sandstone_Column (true concave-fluted Corinthian columns + carved voussoir baroque arch + marble piers)
    # ------------------------------------------------------------------
    stone = MeshBuilder(default_uv_tile=1.4)

    # Flanking baroque stone piers with recessed veined Nero-Marquina marble panels
    for sx in (-1.22, 1.22):
        stone.add_box((sx, 0.30, 0.48), (0.78, 0.96, 0.96), mat_aged, bevel=0.025)
        stone.add_box((sx, 0.30, 2.55), (0.70, 0.84, 3.22), mat_sandstone, bevel=0.022)
        stone.add_box((sx, -0.10, 2.55), (0.38, 0.06, 2.38), mat_marble, bevel=0.012, uv_tile=0.9)

    # Twin engaged concave-fluted Corinthian baroque columns
    for sx in (-1.10, 1.10):
        cy = -0.22
        # Stepped beveled baroque plinth + classical Attic torus-scotia-torus turned base
        stone.add_box((sx, cy, 0.14), (0.78, 0.78, 0.28), mat_aged, bevel=0.022)
        stone.add_box((sx, cy, 0.56), (0.62, 0.62, 0.58), mat_sandstone, bevel=0.020)
        stone.add_box((sx, cy, 0.89), (0.72, 0.72, 0.10), mat_aged, bevel=0.018)
        # Attic turned base moldings
        stone.add_cylinder((sx, cy, 0.99), 0.34, 0.31, 0.10, mat_sandstone, segments=24)
        stone.add_cylinder((sx, cy, 1.07), 0.27, 0.27, 0.07, mat_aged, segments=24)
        stone.add_cylinder((sx, cy, 1.13), 0.30, 0.27, 0.07, mat_sandstone, segments=24)

        # True 18-flute concave Corinthian shaft with classical entasis
        _add_concave_fluted_column(stone, sx, cy, 1.16, 3.96, 0.265, 0.232, flutes=18, flute_depth=0.024, mat=mat_sandstone)

        # Corinthian bell core + 2 staggered tiers of sculpted curling acanthus leaves!
        stone.add_cylinder((sx, cy, 4.16), 0.23, 0.33, 0.38, mat_sandstone, segments=16)
        for tier, (z_leaf, rad_l, h_leaf, count_l, phase) in enumerate([
            (4.06, 0.265, 0.22, 8, 0.0),
            (4.21, 0.295, 0.24, 8, math.pi / 8.0),
        ]):
            for k in range(count_l):
                ang = (2.0 * math.pi * k) / count_l + phase
                lx = sx + math.cos(ang) * rad_l
                ly = cy + math.sin(ang) * rad_l
                # Outward-curling tapered acanthus leaf petal
                stone.add_box(
                    (lx, ly, z_leaf),
                    (0.11, 0.048, h_leaf),
                    mat_aged if tier == 0 else mat_sandstone,
                    rot=(-0.22 * math.sin(ang), 0.22 * math.cos(ang), ang + math.pi * 0.5),
                    bevel=0.014,
                    taper_top=(0.65, 0.70),
                )
        # Molded stepped Corinthian abacus seated seamlessly into arch impost block
        stone.add_box((sx, cy, 4.38), (0.76, 0.76, 0.10), mat_sandstone, bevel=0.018)
        stone.add_box((sx, cy, 4.46), (0.84, 0.84, 0.08), mat_aged, bevel=0.016)

    # Baroque semicircular archivolt built from 13 sculpted radiating beveled voussoir stones standing PROUD!
    num_v = 13
    for i in range(num_v):
        ang = math.pi * ((i + 0.5) / num_v)
        vx = math.cos(ang) * 1.06
        vz = 4.46 + math.sin(ang) * 0.94
        is_key = (i == num_v // 2)
        v_w = 0.30 if is_key else 0.25
        v_h = 0.50 if is_key else 0.34
        v_d = 0.64 if is_key else 0.50
        stone.add_box(
            (vx, -0.14 if is_key else -0.06, vz),
            (v_w, v_d, v_h),
            mat_sandstone if i % 2 == 0 else mat_aged,
            rot=(0.0, ang - math.pi * 0.5, 0.0),
            bevel=0.020,
            taper_bottom=(0.76, 0.92),
        )

    # Recessed upper spandrels (cleanly BEHIND proud voussoirs so circular arch reads clearly!) + dentil cornice
    for sx in (-1.22, 1.22):
        stone.add_box((sx, 0.28, 4.98), (0.76, 0.62, 1.02), mat_sandstone, bevel=0.02)
    stone.add_box((0.0, 0.16, 5.56), (3.24, 1.06, 0.26), mat_sandstone, bevel=0.024)
    # Classical dentil blocks beneath upper crown cornice
    for i in range(15):
        dx = -1.48 + i * (2.96 / 14.0)
        stone.add_box((dx, -0.39, 5.66), (0.10, 0.12, 0.09), mat_aged, bevel=0.008)
    stone.add_box((0.0, 0.10, 5.77), (3.40, 1.26, 0.16), mat_aged, bevel=0.022)

    stone.finalize("Sandstone_Column")

    # ------------------------------------------------------------------
    # 2. Gold_Trim (gilded astragals, corner volutes, keystone crest & bronze glass wall sconces)
    # ------------------------------------------------------------------
    gold = MeshBuilder(default_uv_tile=0.6)
    for sx in (-1.10, 1.10):
        cy = -0.22
        gold.add_cylinder((sx, cy, 1.17), 0.285, 0.285, 0.042, mat_gold, segments=20)
        gold.add_cylinder((sx, cy, 3.96), 0.256, 0.256, 0.052, mat_gold, segments=20)
        # 4 sculpted gilded corner volutes on each Corinthian capital
        for vx in (-0.30, 0.30):
            for vy in (-0.30, 0.30):
                gold.add_cylinder(
                    (sx + vx, cy + vy, 4.30),
                    0.078,
                    0.078,
                    0.07,
                    mat_gold,
                    segments=12,
                    rot=(math.pi * 0.5, 0.0, math.atan2(vy, vx)),
                )
        # Gilded inlaid frame on column pedestal
        gold.add_box((sx, -0.535, 0.56), (0.38, 0.025, 0.36), mat_gold, bevel=0.008)
        gold.add_box((sx, -0.545, 0.56), (0.30, 0.02, 0.28), mat_marble, bevel=0.006)

    # Baroque gilded frieze & sculpted royal keystone cartouche medallion
    gold.add_box((0.0, -0.39, 5.54), (3.20, 0.04, 0.065), mat_gold, bevel=0.008)
    gold.add_sphere((0.0, -0.35, 5.38), 0.145, mat_gold, scale=(0.86, 0.42, 1.28), segments=14, rings=10)
    gold.add_sphere((0.0, -0.39, 5.38), 0.075, mat_marble, scale=(0.85, 0.40, 1.20), segments=12, rings=8)

    # Ornate gilded-bronze wall sconces with graceful S-scroll arms & translucent tulip glass shades
    for sx in (-1.10, 1.10):
        gold.add_box((sx, -0.49, 2.38), (0.14, 0.045, 0.34), mat_bronze, bevel=0.015)
        gold.add_sphere((sx, -0.51, 2.55), 0.045, mat_gold, segments=10, rings=8)
        gold.add_tube(
            [(sx, -0.50, 2.34), (sx, -0.60, 2.26), (sx, -0.70, 2.32), (sx, -0.73, 2.46)],
            [0.024, 0.018, 0.018, 0.022],
            mat_gold,
            segments=10,
        )
        # Beaded bobeche drip cup
        gold.add_cylinder((sx, -0.73, 2.47), 0.032, 0.078, 0.052, mat_gold, segments=14)
        # Translucent blown-glass baroque tulip shade
        gold.add_cylinder((sx, -0.73, 2.61), 0.065, 0.110, 0.22, mat_globe, segments=16, cap=False)

    gold.finalize("Gold_Trim")

    # ------------------------------------------------------------------
    # 3. Sconce_Glow (warm incandescent candle-filament cores inside glass tulip shades)
    # ------------------------------------------------------------------
    sconce = MeshBuilder()
    for sx in (-1.10, 1.10):
        sconce.add_sphere((sx, -0.73, 2.59), 0.048, mat_glow, scale=(0.75, 0.75, 1.45), segments=12, rings=8)
    sconce.finalize("Sconce_Glow")

    return export_model_glb(out_dir, "dresden_pillar.glb", ground=True)


# ===========================================================================
# 3. PALM TREE (Curved Fibrous Trunk + 18 Multi-Leaflet Feathered Palm Fronds)
# ===========================================================================

def build_palm_tree(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_bark = make_pbr_tex_material("Palm_FibrousBark", "palm_bark", tex_dir, normal_strength=1.5)
    mat_crown = make_pbr_tex_material("Palm_CrownFiber", "palm_bark", tex_dir, normal_strength=1.4, tint_hex="#7A5A42")
    mat_leaf_dark = make_pbr_tex_material("Palm_LeafEmerald", "palm_leaf", tex_dir, normal_strength=0.95, double_sided=True)
    mat_leaf_bright = make_pbr_tex_material("Palm_LeafOlive", "palm_leaf", tex_dir, normal_strength=0.9, tint_hex="#C8DFB4", double_sided=True)
    mat_stem = make_pbr_tex_material("Palm_RachisStem", "palm_leaf", tex_dir, normal_strength=0.8, tint_hex="#92A874")
    mat_date = make_solid_material("Palm_Dates", "#5E381B", roughness=0.58)

    # ------------------------------------------------------------------
    # 1. Trunk (organically curving lofted trunk with sculpted diamond frond-scar collars!)
    # ------------------------------------------------------------------
    trunk = MeshBuilder(default_uv_tile=0.8)
    total_h = 5.80

    def trunk_pt(t: float) -> Vector:
        return Vector((math.sin(t * 1.45) * 0.44, -math.sin(t * 0.92) * 0.24, t * total_h))

    # Build continuous multi-ring sculpted palm trunk with alternating flared leaf-scar ridges
    ring_count = 44
    segs = 14
    rings = []
    for ir in range(ring_count + 1):
        t = ir / ring_count
        p = trunk_pt(t)
        p_next = trunk_pt(min(1.0, t + 0.02))
        p_prev = trunk_pt(max(0.0, t - 0.02))
        tan = (p_next - p_prev).normalized()
        nrm = tan.cross(Vector((0.0, 1.0, 0.0))).normalized()
        binrm = tan.cross(nrm).normalized()

        # Bulbous coastal root flare at base + slender graceful upper taper + sawtooth cut-petiole collars
        base_r = 0.28 * ((1.0 - t) ** 0.50) + 0.14
        if t < 0.08:
            base_r += 0.14 * ((1.0 - t / 0.08) ** 2.0)
        collar = 0.026 * (0.5 + 0.5 * math.sin(ir * math.pi))
        ring = []
        for s in range(segs):
            ang = (2.0 * math.pi * s) / segs + (0.22 if ir % 2 == 1 else 0.0)
            # Subtle organic diamond bump around trunk
            scar = 0.012 * math.cos(s * 3.0 + ir * 1.5)
            r = base_r + collar + scar
            pt = p + (nrm * math.cos(ang) + binrm * math.sin(ang)) * r
            ring.append(tuple(pt))
        rings.append(ring)

    trunk.add_loft(rings, mat_bark, cap_start=True, cap_end=True, smooth=False, closed_u=True, u_repeat=2.0, v_repeat=7.0)

    # Fibrous pineapple-shaped crown heart + hanging Mediterranean date panicles
    crown_top = trunk_pt(1.0)
    trunk.add_sphere((crown_top.x, crown_top.y, crown_top.z + 0.08), 0.28, mat_crown, scale=(1.0, 1.0, 1.22), segments=14, rings=10)
    for k in range(7):
        ang = (2.0 * math.pi * k) / 7.0
        for d in range(3):
            trunk.add_sphere(
                (crown_top.x + math.cos(ang) * (0.21 + d * 0.04), crown_top.y + math.sin(ang) * (0.21 + d * 0.04), crown_top.z - 0.12 - d * 0.09),
                0.065,
                mat_date,
                scale=(0.82, 0.82, 1.25),
                segments=8,
                rings=6,
            )

    trunk.finalize("Trunk")

    # ------------------------------------------------------------------
    # 2. Canopy (pivoted at crown_top — 18 layered multi-leaflet feathered fronds!)
    # ------------------------------------------------------------------
    canopy = MeshBuilder(default_uv_tile=0.5)

    def add_feathered_frond(
        azimuth: float,
        length: float,
        rise: float,
        droop: float,
        leaflet_len: float,
        num_pairs: int,
        mat_leaf,
    ) -> None:
        """Build a photoreal curved palm frond with tapered rachis spine + individual V-angled lance leaflets!"""
        ca, sa = math.cos(azimuth), math.sin(azimuth)
        fwd = Vector((ca, sa, 0.0))
        side = Vector((-sa, ca, 0.0))

        def spine_pos(u: float) -> Vector:
            r_d = u * length
            z_d = rise * math.sin(u * math.pi * 0.80) - droop * (u ** 2.15)
            return fwd * r_d + Vector((0.0, 0.0, z_d))

        # Tapered curved woody rachis spine (7 segments)
        rachis_pts = [tuple(spine_pos(i / 7.0)) for i in range(8)]
        rachis_rad = [0.030 * (1.0 - 0.78 * i / 7.0) for i in range(8)]
        canopy.add_tube(rachis_pts, rachis_rad, mat_stem, segments=5, smooth=True, v_repeat=4.0)

        # Individual feathered V-angled lance leaflets along both sides of the rachis!
        for p_idx in range(num_pairs):
            u = 0.14 + 0.84 * (p_idx / max(1, num_pairs - 1))
            p0 = spine_pos(u)
            p_ahead = spine_pos(min(1.0, u + 0.04))
            tang = (p_ahead - p0).normalized()
            # Natural botanical envelope: shortest at base & tip, longest mid-frond
            env = math.sin(((u - 0.10) / 0.90) * math.pi) ** 0.72
            l_len = leaflet_len * max(0.28, env)
            l_w = 0.052 * max(0.45, env)

            for sgn in (-1.0, 1.0):
                # Sweep leaflet slightly forward along rachis + natural V-angle & gravity droop at tip!
                lat = side * sgn
                dir_out = (lat * 0.82 + tang * 0.42 + Vector((0.0, 0.0, 0.14 - 0.36 * u))).normalized()
                mid_pt = p0 + dir_out * (l_len * 0.52) + Vector((0.0, 0.0, 0.02))
                tip_pt = p0 + dir_out * l_len - Vector((0.0, 0.0, l_len * (0.34 + 0.22 * u)))
                # Two-quad tapered lance blade (base -> wide belly -> pointed tip)
                b0 = p0 - tang * (l_w * 0.45)
                b1 = p0 + tang * (l_w * 0.45)
                m0 = mid_pt - tang * (l_w * 0.65)
                m1 = mid_pt + tang * (l_w * 0.65)
                t0 = tip_pt - tang * 0.006
                t1 = tip_pt + tang * 0.006
                if sgn > 0:
                    canopy.add_quad_uv(b0, b1, m1, m0, mat_leaf, uvs=((0, 0), (1, 0), (1, 0.55), (0, 0.55)), smooth=True)
                    canopy.add_quad_uv(m0, m1, t1, t0, mat_leaf, uvs=((0, 0.55), (1, 0.55), (0.6, 1), (0.4, 1)), smooth=True)
                else:
                    canopy.add_quad_uv(b1, b0, m0, m1, mat_leaf, uvs=((0, 0), (1, 0), (1, 0.55), (0, 0.55)), smooth=True)
                    canopy.add_quad_uv(m1, m0, t0, t1, mat_leaf, uvs=((0, 0.55), (1, 0.55), (0.6, 1), (0.4, 1)), smooth=True)

    # Lower drooping Mediterranean skirt tier (7 long sweeping fronds)
    for i in range(7):
        az = (2.0 * math.pi * i) / 7.0 + 0.12
        add_feathered_frond(az, length=2.95 + (i % 2) * 0.22, rise=0.72, droop=1.95, leaflet_len=0.72, num_pairs=16, mat_leaf=mat_leaf_dark)

    # Mid full arching canopy tier (6 broad fronds)
    for i in range(6):
        az = (2.0 * math.pi * i) / 6.0 + 0.52
        add_feathered_frond(az, length=2.65 + (i % 2) * 0.18, rise=1.22, droop=1.25, leaflet_len=0.66, num_pairs=15, mat_leaf=mat_leaf_dark)

    # Upper ascending young crown fronds (5 bright vibrant fronds)
    for i in range(5):
        az = (2.0 * math.pi * i) / 5.0 + 0.28
        add_feathered_frond(az, length=1.95 + (i % 2) * 0.14, rise=1.55, droop=0.58, leaflet_len=0.52, num_pairs=12, mat_leaf=mat_leaf_bright)

    canopy.finalize("Canopy", location=(crown_top.x, crown_top.y, crown_top.z + 0.12))

    return export_model_glb(out_dir, "palm_tree.glb", ground=True)


# ===========================================================================
# 4. STREETLAMP (Ornate Cast-Iron Mediterranean Promenade Lamppost)
# ===========================================================================

def build_streetlamp(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_iron = make_pbr_tex_material("Lamp_CastIron", "hammered_wrought_iron", tex_dir, normal_strength=1.1)
    mat_bronze = make_solid_material("Lamp_AgedBronze", "#7A5E3B", metallic=0.86, roughness=0.32)
    mat_glass = make_solid_material("Lamp_LanternGlass", "#FFF4DC", roughness=0.06, alpha=0.28, coat=1.0, double_sided=True)
    mat_ceramic = make_solid_material("Lamp_SocketCeramic", "#E0DCD2", roughness=0.35)
    mat_bulb = make_solid_material("Lamp_EdisonBulb", "#FFD480", emission="#FFAE3D", emission_strength=4.8, roughness=0.10)
    mat_filament = make_solid_material("Lamp_FilamentCore", "#FFF7DC", emission="#FFE4A0", emission_strength=8.5, roughness=0.05)

    # ------------------------------------------------------------------
    # 1. Lamp_Post (fluted cast-iron base, reeded pole, filigree bracket, glass-paned lantern cage)
    # ------------------------------------------------------------------
    post = MeshBuilder(default_uv_tile=0.7)

    # Anchored octagonal heritage plinth with 8 hex anchor bolts
    post.add_cylinder((0.0, 0.0, 0.05), 0.30, 0.28, 0.10, mat_iron, segments=8, smooth=False)
    for k in range(8):
        ang = (2.0 * math.pi * k) / 8.0 + math.pi / 8.0
        post.add_cylinder((math.cos(ang) * 0.25, math.sin(ang) * 0.25, 0.115), 0.018, 0.018, 0.03, mat_bronze, segments=6, smooth=False)
    post.add_cylinder((0.0, 0.0, 0.19), 0.25, 0.20, 0.18, mat_iron, segments=8, smooth=False)
    # Fluted classical lower pedestal
    _add_concave_fluted_column(post, 0.0, 0.0, 0.28, 0.94, 0.185, 0.125, flutes=12, flute_depth=0.014, mat=mat_iron)
    post.add_cylinder((0.0, 0.0, 0.98), 0.155, 0.115, 0.09, mat_bronze, segments=16)

    # Tapered reeded upper shaft + cast decorative rings
    post.add_cylinder((0.0, 0.0, 2.54), 0.086, 0.054, 3.08, mat_iron, segments=16)
    for rz, rr in ((1.85, 0.088), (2.95, 0.078), (4.06, 0.088)):
        post.add_cylinder((0.0, 0.0, rz), rr, rr * 0.92, 0.075, mat_bronze, segments=16)
    # Decorative spire finial at pole crown
    post.add_cylinder((0.0, 0.0, 4.24), 0.054, 0.022, 0.24, mat_iron, segments=12)
    post.add_sphere((0.0, 0.0, 4.39), 0.046, mat_bronze, segments=12, rings=8)

    # Sweeping forged gooseneck bracket reaching forward to y=-0.84 (glTF +Z = +0.84)
    arm_pts = [
        (0.0, -0.02, 4.02),
        (0.0, -0.18, 4.48),
        (0.0, -0.46, 4.78),
        (0.0, -0.72, 4.76),
        (0.0, -0.84, 4.56),
    ]
    post.add_tube(arm_pts, [0.036, 0.031, 0.027, 0.025, 0.023], mat_iron, segments=10)

    # Double-spiral wrought-iron filigree scrollwork brace under bracket
    scroll_main = [
        (0.0, -0.06, 3.38), (0.0, -0.24, 3.68), (0.0, -0.36, 4.06),
        (0.0, -0.54, 4.40), (0.0, -0.72, 4.56),
    ]
    post.add_tube(scroll_main, 0.017, mat_iron, segments=8)
    # Lower inward spiral volute
    vol1 = [
        (0.0, -0.24, 3.68), (0.0, -0.14, 3.82), (0.0, -0.18, 3.96), (0.0, -0.28, 3.92), (0.0, -0.26, 3.82),
    ]
    post.add_tube(vol1, 0.013, mat_bronze, segments=6)
    # Upper counter-spiral volute
    vol2 = [
        (0.0, -0.44, 4.28), (0.0, -0.32, 4.42), (0.0, -0.44, 4.54), (0.0, -0.54, 4.44),
    ]
    post.add_tube(vol2, 0.013, mat_bronze, segments=6)

    # Beveled hexagonal coastal heritage lantern cage centered at (0.0, -0.84, 4.18)
    ly = -0.84
    # Stepped pagoda roof cap, vent louvers & spire finial
    post.add_cylinder((0.0, ly, 4.46), 0.255, 0.09, 0.14, mat_iron, segments=6, smooth=False)
    post.add_cylinder((0.0, ly, 4.55), 0.085, 0.055, 0.06, mat_bronze, segments=6, smooth=False)
    post.add_cylinder((0.0, ly, 4.61), 0.025, 0.008, 0.07, mat_iron, segments=8)
    # Lower lantern frame ring & bronze drop finial
    post.add_cylinder((0.0, ly, 3.94), 0.10, 0.155, 0.075, mat_iron, segments=6, smooth=False)
    post.add_cylinder((0.0, ly, 3.85), 0.008, 0.042, 0.11, mat_bronze, segments=8)
    # 6 slender corner iron ribs + 6 crystal-clear beveled glass panes
    for k in range(6):
        a0 = (2.0 * math.pi * k) / 6.0
        a1 = (2.0 * math.pi * ((k + 1) % 6)) / 6.0
        p_b0 = (math.cos(a0) * 0.14, ly + math.sin(a0) * 0.14, 3.96)
        p_t0 = (math.cos(a0) * 0.215, ly + math.sin(a0) * 0.215, 4.39)
        p_b1 = (math.cos(a1) * 0.14, ly + math.sin(a1) * 0.14, 3.96)
        p_t1 = (math.cos(a1) * 0.215, ly + math.sin(a1) * 0.215, 4.39)
        post.add_tube([p_b0, p_t0], 0.011, mat_iron, segments=6, smooth=False)
        # Translucent glass pane inset cleanly between corner mullions
        post.add_quad_uv(p_b0, p_b1, p_t1, p_t0, mat_glass)

    # Ceramic bulb socket hanging inside lantern
    post.add_cylinder((0.0, ly, 4.34), 0.036, 0.044, 0.08, mat_ceramic, segments=12)

    post.finalize("Lamp_Post")

    # ------------------------------------------------------------------
    # 2. Lamp_Glow (warm glowing Edison glass bulb + intense incandescent inner filament core)
    # ------------------------------------------------------------------
    glow = MeshBuilder()
    glow.add_sphere((0.0, 0.0, 0.0), 0.072, mat_bulb, scale=(0.88, 0.88, 1.32), segments=14, rings=10)
    glow.add_cylinder((0.0, 0.0, 0.01), 0.018, 0.022, 0.095, mat_filament, segments=10)
    glow.finalize("Lamp_Glow", location=(0.0, -0.84, 4.21))

    return export_model_glb(out_dir, "streetlamp.glb", ground=True)


# ===========================================================================
# 5. SAFE (Heavy Brushed-Steel Bank / Vault Safe with Knurled Dial & Bolts)
# ===========================================================================

def build_safe(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_steel = make_pbr_tex_material("Safe_VaultSteel", "brushed_vault_steel", tex_dir, normal_strength=0.55, tint_hex="#92A0B2", brightness=1.25, metallic_override=0.58)
    mat_steel_dark = make_pbr_tex_material("Safe_DarkArmor", "brushed_vault_steel", tex_dir, normal_strength=0.55, tint_hex="#687485", metallic_override=0.52)
    mat_felt = make_pbr_tex_material("Safe_InteriorFelt", "crimson_velvet", tex_dir, normal_strength=0.6, tint_hex="#38343A", desat=0.8)
    mat_velvet = make_pbr_tex_material("Safe_JewelTray", "crimson_velvet", tex_dir, normal_strength=0.8)
    mat_brass = make_solid_material("Safe_PolishedBrass", "#D9AC4A", metallic=0.94, roughness=0.20)
    mat_chrome = make_solid_material("Safe_MachinedChrome", "#D8E0E8", metallic=0.95, roughness=0.14)
    mat_gold = make_solid_material("Safe_GoldIngot", "#F0C140", metallic=0.96, roughness=0.16)
    mat_cash = make_solid_material("Safe_EuroBundle", "#3E6B48", roughness=0.80)
    mat_led = make_solid_material("Safe_StatusLED", "#FF3B30", emission="#FF3B30", emission_strength=4.2, roughness=0.12)
    mat_keypad = make_solid_material("Safe_Keypad", "#181C24", roughness=0.45)

    # ------------------------------------------------------------------
    # 1. Safe_Body (chamfered vault armor + recessed jamb + rivets + heavy hinges + felt interior)
    # ------------------------------------------------------------------
    body = MeshBuilder(default_uv_tile=0.75)
    # Heavy cast-steel feet
    for sx in (-0.42, 0.42):
        for sy in (-0.34, 0.34):
            body.add_box((sx, sy, 0.055), (0.20, 0.20, 0.11), mat_steel_dark, bevel=0.018)

    # Hollow armored vault enclosure
    body.add_box((0.0, 0.0, 0.17), (1.10, 0.92, 0.15), mat_steel, bevel=0.028)   # floor slab
    body.add_box((0.0, 0.0, 1.42), (1.10, 0.92, 0.15), mat_steel, bevel=0.028)   # roof slab
    body.add_box((0.0, 0.39, 0.80), (1.10, 0.15, 1.38), mat_steel, bevel=0.028)  # back wall
    body.add_box((0.48, 0.0, 0.80), (0.15, 0.92, 1.38), mat_steel, bevel=0.028)  # left wall (+X)
    body.add_box((-0.48, 0.0, 0.80), (0.15, 0.92, 1.38), mat_steel, bevel=0.028) # right wall (-X)

    # Stepped recessed fire-seal door jamb + bolted armor trim bands
    for sz in (0.17, 1.42):
        body.add_box((0.0, -0.45, sz), (1.14, 0.06, 0.075), mat_steel_dark, bevel=0.012)
        for rx in (-0.48, -0.24, 0.0, 0.24, 0.48):
            body.add_sphere((rx, -0.482, sz), 0.014, mat_chrome, segments=8, rings=6)
    # Engraved brass manufacturer badge
    body.add_box((0.0, -0.478, 1.42), (0.34, 0.022, 0.052), mat_brass, bevel=0.006)

    # Heavy external cast barrel hinges with turned brass finials at x=+0.53, y=-0.47
    for hz in (0.42, 1.16):
        body.add_cylinder((0.53, -0.47, hz), 0.044, 0.044, 0.20, mat_steel_dark, segments=14)
        body.add_sphere((0.53, -0.47, hz + 0.105), 0.036, mat_brass, segments=10, rings=8)
        body.add_sphere((0.53, -0.47, hz - 0.105), 0.036, mat_brass, segments=10, rings=8)

    # Dark felt interior lining + chrome-edged vault shelves
    body.add_box((0.0, 0.29, 0.80), (0.80, 0.04, 1.08), mat_felt)
    for sz in (0.26, 0.78):
        body.add_box((0.0, 0.05, sz), (0.80, 0.64, 0.035), mat_steel_dark)
        body.add_box((0.0, -0.26, sz), (0.80, 0.025, 0.038), mat_chrome)

    body.finalize("Safe_Body")

    # ------------------------------------------------------------------
    # 2. Safe_Loot (gold bullion ingots + euro cash bundles + crimson velvet jewel tray)
    # ------------------------------------------------------------------
    loot = MeshBuilder(default_uv_tile=0.4)
    # Pyramid of beveled gold bullion ingots on top shelf
    for lx in (-0.24, -0.06, 0.12):
        loot.add_box((lx, 0.02, 0.84), (0.13, 0.25, 0.075), mat_gold, bevel=0.012, taper_top=(0.80, 0.86))
    for lx in (-0.15, 0.03):
        loot.add_box((lx, 0.03, 0.915), (0.13, 0.25, 0.075), mat_gold, bevel=0.012, taper_top=(0.80, 0.86))
    # Velvet jewelry tray on right side of top shelf
    loot.add_box((0.29, 0.04, 0.82), (0.18, 0.26, 0.04), mat_velvet, bevel=0.008)
    for jz_y in (-0.03, 0.08):
        loot.add_cylinder((0.29, jz_y, 0.855), 0.026, 0.026, 0.025, mat_brass, segments=12)
    # Banded cash stacks on bottom shelf
    for lx in (-0.22, 0.0, 0.22):
        for stack_z in (0.31, 0.375, 0.44):
            loot.add_box((lx, 0.02, stack_z), (0.16, 0.09, 0.052), mat_cash, rot=(0.0, 0.0, 0.10 * lx), bevel=0.005)
            loot.add_box((lx, 0.02, stack_z), (0.042, 0.096, 0.056), mat_brass)
    loot.finalize("Safe_Loot")

    # ------------------------------------------------------------------
    # 3. Safe_Door (hinged strictly at x=+0.49, y=-0.47, z=0.80)
    # ------------------------------------------------------------------
    hinge_pos = (0.49, -0.47, 0.80)
    door = MeshBuilder(default_uv_tile=0.7)
    door.add_box((-0.49, 0.015, 0.0), (0.88, 0.12, 1.18), mat_steel, bevel=0.024)
    door.add_box((-0.49, -0.052, 0.0), (0.74, 0.032, 1.00), mat_steel_dark, bevel=0.014)
    door.add_box((-0.49, -0.064, 0.0), (0.66, 0.028, 0.92), mat_steel, bevel=0.012)
    # Brass decorative pinstripe inlay
    door.add_box((-0.49, -0.072, 0.43), (0.60, 0.018, 0.022), mat_brass)
    door.add_box((-0.49, -0.072, -0.43), (0.60, 0.018, 0.022), mat_brass)
    # 4 heavy machined chrome locking bolts protruding from latch edge
    for bz in (-0.38, -0.13, 0.13, 0.38):
        door.add_cylinder((-0.95, 0.02, bz), 0.028, 0.028, 0.11, mat_chrome, segments=14, rot=(0.0, math.pi * 0.5, 0.0))
    # Heavy forged hinge straps
    for hz in (-0.38, 0.36):
        door.add_box((-0.07, -0.025, hz), (0.18, 0.052, 0.065), mat_steel_dark, bevel=0.008)
    # Combination dial graduated index ring & digital keypad housing
    door.add_cylinder((-0.54, -0.082, 0.20), 0.082, 0.074, 0.026, mat_chrome, segments=24, rot=(math.pi * 0.5, 0.0, 0.0))
    door.add_cylinder((-0.54, -0.098, 0.20), 0.062, 0.058, 0.024, mat_keypad, segments=24, rot=(math.pi * 0.5, 0.0, 0.0))
    door.add_box((-0.26, -0.084, 0.20), (0.12, 0.035, 0.18), mat_keypad, bevel=0.008)

    door_obj = door.finalize("Safe_Door", location=hinge_pos)

    # ------------------------------------------------------------------
    # 4. Safe_Dial (knurled combination dial + 3-spoke vault capstan wheel, child of Safe_Door)
    # ------------------------------------------------------------------
    dial = MeshBuilder()
    # Knurled upper combination knob (16 crisp machined grip flutes!)
    dial.add_cylinder((0.0, 0.0, 0.22), 0.050, 0.044, 0.052, mat_chrome, segments=20, rot=(math.pi * 0.5, 0.0, 0.0))
    for k in range(16):
        a = (2.0 * math.pi * k) / 16.0
        dial.add_cylinder((math.cos(a) * 0.048, -0.01, 0.22 + math.sin(a) * 0.048), 0.005, 0.005, 0.044, mat_chrome, segments=6, rot=(math.pi * 0.5, 0.0, 0.0))
    # Central 3-spoke vault wheel hub & turned ergonomic brass handles
    dial.add_cylinder((0.0, -0.015, 0.0), 0.088, 0.072, 0.06, mat_chrome, segments=20, rot=(math.pi * 0.5, 0.0, 0.0))
    dial.add_cylinder((0.0, -0.062, 0.0), 0.048, 0.042, 0.065, mat_brass, segments=16, rot=(math.pi * 0.5, 0.0, 0.0))
    for s in range(3):
        ang = (2.0 * math.pi * s) / 3.0 + math.pi * 0.16
        cx, cz = math.cos(ang) * 0.115, math.sin(ang) * 0.115
        dial.add_cylinder((cx, -0.078, cz), 0.019, 0.015, 0.20, mat_brass, segments=12, rot=(0.0, ang - math.pi * 0.5, 0.0))
        dial.add_sphere((math.cos(ang) * 0.22, -0.078, math.sin(ang) * 0.22), 0.030, mat_brass, segments=12, rings=8)
        # Forward crank grip on each spoke
        dial.add_cylinder((math.cos(ang) * 0.20, -0.115, math.sin(ang) * 0.20), 0.014, 0.018, 0.07, mat_chrome, segments=10, rot=(math.pi * 0.5, 0.0, 0.0))
    dial.finalize("Safe_Dial", location=(-0.54, -0.082, -0.02), parent=door_obj)

    # Recessed glass status LED
    led = MeshBuilder()
    led.add_cylinder((0.0, 0.0, 0.0), 0.022, 0.022, 0.022, mat_chrome, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
    led.add_sphere((0.0, -0.012, 0.0), 0.015, mat_led, segments=10, rings=8)
    led.finalize("Safe_LED", location=(-0.26, -0.095, 0.26), parent=door_obj)

    return export_model_glb(out_dir, "safe.glb", ground=True)


# ===========================================================================
# 6. DISPLAY CASE (Museum Veined-Marble & Brass Glass Vitrine + Royal Jewel)
# ===========================================================================

def build_display_case(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_marble = make_pbr_tex_material("Vitrine_VeinedMarble", "veined_dark_marble", tex_dir, normal_strength=0.45, brightness=1.55, coat=0.85)
    mat_velvet = make_pbr_tex_material("Vitrine_CrimsonVelvet", "crimson_velvet", tex_dir, normal_strength=0.85, brightness=1.25)
    mat_steel = make_pbr_tex_material("Vitrine_DarkSteel", "brushed_vault_steel", tex_dir, normal_strength=0.45, tint_hex="#6A727E", metallic_override=0.55)
    mat_brass = make_solid_material("Vitrine_BrushedBrass", "#D9AC4A", metallic=0.94, roughness=0.20, coat=0.2)
    mat_glass = make_solid_material("Vitrine_MuseumGlass", "#C2E8F8", metallic=0.05, roughness=0.03, alpha=0.22, coat=1.0, double_sided=True)
    mat_gold = make_solid_material("Vitrine_RoyalGold", "#F0C44C", metallic=0.96, roughness=0.14)
    mat_jewel = make_solid_material("Vitrine_CrownJewel", "#28E6C8", metallic=0.12, roughness=0.06, emission="#38F5DA", emission_strength=3.0, coat=1.0)
    mat_ruby = make_solid_material("Vitrine_AccentGem", "#E8264A", metallic=0.12, roughness=0.08, emission="#FF3055", emission_strength=2.2)
    mat_spot = make_solid_material("Vitrine_MicroSpot", "#FFF4D6", emission="#FFE5A8", emission_strength=4.5, roughness=0.1)

    # ------------------------------------------------------------------
    # 1. Pedestal (stepped veined Nero-Marquina marble plinth + brass reveals + velvet cushion)
    # ------------------------------------------------------------------
    ped = MeshBuilder(default_uv_tile=0.9)
    ped.add_box((0.0, 0.0, 0.055), (1.04, 1.04, 0.11), mat_marble, bevel=0.016)
    ped.add_box((0.0, 0.0, 0.13), (0.94, 0.94, 0.045), mat_brass, bevel=0.008)
    ped.add_box((0.0, 0.0, 0.52), (0.90, 0.90, 0.74), mat_marble, bevel=0.018)
    # Recessed brass inlay belt + upper moulded plinth cap
    ped.add_box((0.0, 0.0, 0.91), (0.98, 0.98, 0.055), mat_marble, bevel=0.014)
    ped.add_box((0.0, 0.0, 0.955), (0.94, 0.94, 0.035), mat_brass, bevel=0.008)
    # Stepped tufted crimson velvet riser pad
    ped.add_box((0.0, 0.0, 1.00), (0.68, 0.68, 0.065), mat_velvet, bevel=0.024, taper_top=(0.88, 0.88), uv_tile=0.5)
    ped.add_box((0.0, 0.0, 1.045), (0.44, 0.44, 0.035), mat_velvet, bevel=0.015, taper_top=(0.86, 0.86), uv_tile=0.4)
    # Front museum brass identification plaque
    ped.add_box((0.0, -0.458, 0.76), (0.30, 0.022, 0.11), mat_brass, bevel=0.006)
    ped.add_box((0.0, -0.470, 0.76), (0.25, 0.010, 0.075), mat_steel)
    ped.finalize("Pedestal")

    # ------------------------------------------------------------------
    # 2. Glass_Hood (sleek mitered brass & dark-steel framed museum glass + 4 recessed corner micro-spots)
    # ------------------------------------------------------------------
    hood = MeshBuilder(default_uv_tile=0.6)
    hw = 0.44
    z0, z1 = 0.97, 1.74
    hood.add_quad_uv((-hw, -hw, z0), (hw, -hw, z0), (hw, -hw, z1), (-hw, -hw, z1), mat_glass)
    hood.add_quad_uv((hw, hw, z0), (-hw, hw, z0), (-hw, hw, z1), (hw, hw, z1), mat_glass)
    hood.add_quad_uv((hw, -hw, z0), (hw, hw, z0), (hw, hw, z1), (hw, -hw, z1), mat_glass)
    hood.add_quad_uv((-hw, hw, z0), (-hw, -hw, z0), (-hw, -hw, z1), (-hw, hw, z1), mat_glass)
    # Mitered dark-steel & brass corner mullions
    for sx in (-hw, hw):
        for sy in (-hw, hw):
            hood.add_box((sx, sy, (z0 + z1) * 0.5), (0.026, 0.026, z1 - z0), mat_steel, bevel=0.004)
            hood.add_box((sx * 0.985, sy * 0.985, (z0 + z1) * 0.5), (0.012, 0.012, z1 - z0), mat_brass)
    # Museum canopy frame + 4 recessed corner micro-LED downlights
    hood.add_box((0.0, 0.0, 1.765), (0.94, 0.94, 0.065), mat_steel, bevel=0.014)
    hood.add_box((0.0, 0.0, 1.73), (0.92, 0.92, 0.022), mat_brass, bevel=0.005)
    for sx in (-0.28, 0.28):
        for sy in (-0.28, 0.28):
            hood.add_cylinder((sx, sy, 1.725), 0.036, 0.032, 0.022, mat_brass, segments=12)
            hood.add_cylinder((sx, sy, 1.714), 0.024, 0.024, 0.010, mat_spot, segments=12)
    hood.finalize("Glass_Hood")

    # ------------------------------------------------------------------
    # 3. Artifact (ornate gilded Schatzkammer royal crown-star brooch with multi-faceted emerald/ruby gems)
    # ------------------------------------------------------------------
    art = MeshBuilder()
    art.add_cylinder((0.0, 0.0, -0.20), 0.115, 0.042, 0.075, mat_gold, segments=16)
    art.add_cylinder((0.0, 0.0, -0.11), 0.022, 0.020, 0.12, mat_gold, segments=12)
    # Ornate Baroque gold filigree sunburst halo + 8 royal star rays with accent rubies
    ring_pts = [(math.cos(2 * math.pi * i / 16) * 0.145, 0.0, 0.05 + math.sin(2 * math.pi * i / 16) * 0.175) for i in range(17)]
    art.add_tube(ring_pts, 0.015, mat_gold, segments=8, cap=False)
    for k in range(8):
        a = (2.0 * math.pi * k) / 8.0
        px = math.cos(a) * 0.165
        pz = 0.05 + math.sin(a) * 0.195
        art.add_sphere((px, 0.0, pz), 0.024, mat_ruby if k % 2 == 0 else mat_gold, segments=8, rings=6)
    # Multi-tiered brilliant-cut emerald-diamond centerpiece
    art.add_cylinder((0.0, 0.0, 0.105), 0.105, 0.058, 0.065, mat_jewel, segments=10, smooth=False)
    art.add_cylinder((0.0, 0.0, 0.155), 0.058, 0.001, 0.045, mat_jewel, segments=10, smooth=False)
    art.add_cylinder((0.0, 0.0, 0.015), 0.001, 0.105, 0.115, mat_jewel, segments=10, smooth=False)
    art.finalize("Artifact", location=(0.0, 0.0, 1.28))

    return export_model_glb(out_dir, "display_case.glb", ground=True)


# ===========================================================================
# 7. POWER BOX (Industrial Securion Junction Cabinet w/ Internal Copper Busbars)
# ===========================================================================

def build_power_box(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_steel = make_pbr_tex_material("PowerBox_GalvSteel", "brushed_vault_steel", tex_dir, normal_strength=0.65, tint_hex="#98A6B6", brightness=1.35, metallic_override=0.35, roughness_bias=0.12)
    mat_dark = make_pbr_tex_material("PowerBox_DarkIron", "hammered_wrought_iron", tex_dir, normal_strength=0.70, tint_hex="#88909A", metallic_override=0.48)
    mat_cable = make_solid_material("PowerBox_ArmoredCable", "#15181F", roughness=0.72)
    mat_copper = make_solid_material("PowerBox_CopperBus", "#C87440", metallic=0.92, roughness=0.25)
    mat_hazard = make_solid_material("PowerBox_HazardYellow", "#F0BE24", roughness=0.42)
    mat_lever = make_solid_material("PowerBox_RedHandle", "#D92626", metallic=0.15, roughness=0.32, coat=0.4)
    mat_wire_r = make_solid_material("PowerBox_WireRed", "#C82828", roughness=0.55)
    mat_wire_b = make_solid_material("PowerBox_WireBlue", "#2860C8", roughness=0.55)
    mat_led_g = make_solid_material("PowerBox_GreenLED", "#28F078", emission="#28F078", emission_strength=4.8, roughness=0.12)
    mat_chrome = make_solid_material("PowerBox_Chrome", "#CFD8E2", metallic=0.92, roughness=0.20)

    # ------------------------------------------------------------------
    # 1. Box_Body (hollow industrial cabinet + INTERNAL copper busbars/breakers + conduits & armored cables)
    # ------------------------------------------------------------------
    body = MeshBuilder(default_uv_tile=0.7)
    # Back wall mounting flange flush at y=0 (glTF z=0) + 4 hex wall bolts
    body.add_box((0.0, -0.015, 0.48), (0.66, 0.03, 0.74), mat_dark, bevel=0.008)
    for sx in (-0.28, 0.28):
        for sz in (0.16, 0.80):
            body.add_cylinder((sx, -0.036, sz), 0.014, 0.014, 0.02, mat_chrome, segments=6, rot=(math.pi * 0.5, 0.0, 0.0))

    # Hollow cabinet shell (back, top, bottom, left, right — open front behind hinged Box_Door!)
    body.add_box((0.0, -0.04, 0.48), (0.58, 0.05, 0.66), mat_steel)
    body.add_box((0.0, -0.14, 0.79), (0.58, 0.22, 0.045), mat_steel, bevel=0.012)
    body.add_box((0.0, -0.14, 0.17), (0.58, 0.22, 0.045), mat_steel, bevel=0.012)
    body.add_box((0.27, -0.14, 0.48), (0.045, 0.22, 0.66), mat_steel, bevel=0.012)
    body.add_box((-0.27, -0.14, 0.48), (0.045, 0.22, 0.66), mat_steel, bevel=0.012)
    # Sloped weather drip hood
    body.add_box((0.0, -0.15, 0.82), (0.62, 0.27, 0.035), mat_steel, rot=(0.09, 0.0, 0.0), bevel=0.008)

    # DETAILED INTERNAL SECURION ELECTRICAL BUSBARS & DIN-RAIL BREAKERS (visible when Box_Door swings open!)
    for cx in (-0.12, 0.0, 0.12):
        body.add_box((cx, -0.09, 0.58), (0.026, 0.014, 0.34), mat_copper)
    # DIN rail + 6 modular circuit breakers with toggle switches
    body.add_box((0.0, -0.085, 0.36), (0.44, 0.025, 0.04), mat_chrome)
    for i in range(6):
        bx = -0.175 + i * 0.07
        body.add_box((bx, -0.125, 0.36), (0.055, 0.07, 0.12), mat_dark, bevel=0.005)
        body.add_box((bx, -0.168, 0.37), (0.028, 0.028, 0.022), mat_lever if i == 0 else mat_chrome)
    # Internal colored phase jumper cables
    body.add_tube([(-0.12, -0.10, 0.45), (-0.16, -0.15, 0.42), (-0.175, -0.12, 0.38)], 0.009, mat_wire_r, segments=6)
    body.add_tube([(0.12, -0.10, 0.45), (0.16, -0.15, 0.42), (0.175, -0.12, 0.38)], 0.009, mat_wire_b, segments=6)

    # Top steel conduits with knurled brass glands & clamping straps
    for cx in (-0.15, 0.15):
        body.add_cylinder((cx, -0.10, 0.90), 0.028, 0.028, 0.15, mat_dark, segments=12)
        body.add_cylinder((cx, -0.10, 0.835), 0.040, 0.036, 0.035, mat_copper, segments=8, smooth=False)

    # Bottom cable glands & sweeping armored power cables down to z=0
    for cx in (-0.16, 0.0, 0.16):
        body.add_cylinder((cx, -0.10, 0.145), 0.034, 0.034, 0.035, mat_copper, segments=8, smooth=False)
    body.add_tube([(-0.16, -0.10, 0.14), (-0.16, -0.11, 0.07), (-0.23, -0.06, 0.025), (-0.29, -0.02, 0.022)], 0.022, mat_cable, segments=8)
    body.add_tube([(0.0, -0.10, 0.14), (0.0, -0.12, 0.05), (0.04, -0.06, 0.022)], 0.024, mat_cable, segments=8)
    body.add_tube([(0.16, -0.10, 0.14), (0.16, -0.10, 0.08), (0.24, -0.05, 0.028), (0.30, -0.02, 0.022)], 0.019, mat_copper, segments=8)

    body.finalize("Box_Body")

    # ------------------------------------------------------------------
    # 2. Box_Door (hinged at left +X edge x=+0.28, y=-0.25, z=0.48)
    # ------------------------------------------------------------------
    door = MeshBuilder(default_uv_tile=0.7)
    door.add_box((-0.28, 0.0, 0.0), (0.54, 0.035, 0.60), mat_steel, bevel=0.012)
    # Recessed yellow-black high-voltage warning diamond & bolt
    door.add_box((-0.28, -0.022, 0.08), (0.16, 0.012, 0.16), mat_hazard, rot=(0.0, math.pi * 0.25, 0.0), bevel=0.004)
    door.add_box((-0.28, -0.030, 0.095), (0.022, 0.008, 0.068), mat_dark, rot=(0.0, 0.35, 0.0))
    door.add_box((-0.27, -0.030, 0.060), (0.022, 0.008, 0.062), mat_dark, rot=(0.0, 0.35, 0.0))
    # Louver ventilation slats
    for vz in (-0.20, -0.16, -0.12, -0.08):
        door.add_box((-0.28, -0.020, vz), (0.36, 0.014, 0.018), mat_dark, rot=(0.28, 0.0, 0.0))
    # Chrome cam latch & brushed aluminum Securion nameplate
    door.add_box((-0.48, -0.028, 0.0), (0.036, 0.036, 0.12), mat_chrome, bevel=0.006)
    door.add_box((-0.28, -0.022, 0.23), (0.24, 0.010, 0.042), mat_chrome)
    door.finalize("Box_Door", location=(0.28, -0.25, 0.48))

    # ------------------------------------------------------------------
    # 3. Breaker_Lever (external side disconnect switch pivoted at axle)
    # ------------------------------------------------------------------
    lever = MeshBuilder()
    lever.add_box((0.02, 0.0, 0.0), (0.055, 0.09, 0.14), mat_dark, bevel=0.008)
    lever.add_cylinder((0.048, 0.0, 0.0), 0.024, 0.024, 0.04, mat_chrome, segments=12, rot=(0.0, math.pi * 0.5, 0.0))
    lever.add_box((0.065, 0.0, 0.10), (0.022, 0.026, 0.21), mat_dark, bevel=0.005)
    lever.add_cylinder((0.092, 0.0, 0.19), 0.022, 0.020, 0.10, mat_lever, segments=12, rot=(0.0, math.pi * 0.5, 0.0))
    lever.finalize("Breaker_Lever", location=(0.29, -0.14, 0.52))

    # ------------------------------------------------------------------
    # 4. Status_LED (recessed chrome bezel + glowing emerald-green glass lens)
    # ------------------------------------------------------------------
    led = MeshBuilder()
    led.add_cylinder((0.0, 0.0, 0.0), 0.028, 0.024, 0.028, mat_chrome, segments=14, rot=(math.pi * 0.5, 0.0, 0.0))
    led.add_sphere((0.0, -0.015, 0.0), 0.020, mat_led_g, segments=12, rings=8)
    led.finalize("Status_LED", location=(0.16, -0.272, 0.70))

    return export_model_glb(out_dir, "power_box.glb", ground=True)


# ===========================================================================
# 8. SECURITY CAMERA (Architectural Bullet CCTV w/ Armored Whip & IR Ring)
# ===========================================================================

def build_security_camera(out_dir: str, tex_dir: str) -> int:
    reset_scene()

    mat_mount = make_pbr_tex_material("CCTV_DarkCast", "hammered_wrought_iron", tex_dir, normal_strength=0.65, tint_hex="#707884", metallic_override=0.45)
    mat_shell = make_pbr_tex_material("CCTV_AlumHousing", "brushed_vault_steel", tex_dir, normal_strength=0.35, tint_hex="#E2E8F0", desat=0.9, brightness=1.95, metallic_override=0.20, roughness_bias=-0.04)
    mat_baffle = make_solid_material("CCTV_OpticBaffle", "#10141B", metallic=0.25, roughness=0.45)
    mat_lens = make_solid_material("CCTV_GlassLens", "#091B30", metallic=0.15, roughness=0.03, coat=1.0)
    mat_ar_ring = make_solid_material("CCTV_LensCoat", "#1B5680", metallic=0.35, roughness=0.06, coat=1.0)
    mat_ir = make_solid_material("CCTV_IRDiode", "#481018", emission="#6B1018", emission_strength=1.4, roughness=0.12)
    mat_led = make_solid_material("CCTV_RedLED", "#FF1E22", emission="#FF1E22", emission_strength=5.2, roughness=0.12)
    mat_chrome = make_solid_material("CCTV_Bolts", "#C8D2DC", metallic=0.92, roughness=0.22)

    # ------------------------------------------------------------------
    # 1. Camera_Mount (bolted cast flange + gooseneck arm + coiled armored cable whip)
    # ------------------------------------------------------------------
    mount = MeshBuilder(default_uv_tile=0.5)
    mount.add_box((0.0, -0.016, 0.13), (0.165, 0.032, 0.225), mat_mount, bevel=0.010)
    for sx in (-0.058, 0.058):
        for sz in (0.048, 0.212):
            mount.add_cylinder((sx, -0.034, sz), 0.011, 0.011, 0.016, mat_chrome, segments=6, rot=(math.pi * 0.5, 0.0, 0.0))
    # Gooseneck conduit arm + dual-axis swivel yoke at (0, -0.25, 0.21)
    mount.add_tube([(0.0, -0.02, 0.13), (0.0, -0.17, 0.13), (0.0, -0.25, 0.20)], [0.028, 0.024, 0.022], mat_mount, segments=12)
    mount.add_sphere((0.0, -0.25, 0.21), 0.038, mat_baffle, segments=12, rings=8)
    # Armored braided cable whip looping cleanly from wall grommet into rear housing
    mount.add_tube(
        [(0.045, -0.02, 0.09), (0.075, -0.09, 0.06), (0.065, -0.16, 0.12), (0.015, -0.19, 0.23)],
        0.010,
        mat_baffle,
        segments=8,
    )
    mount.finalize("Camera_Mount")

    # ------------------------------------------------------------------
    # 2. Camera_Head (swivel-pivoted architectural bullet housing + sun visor + multi-element lens + 12 IR LEDs)
    # ------------------------------------------------------------------
    swivel = (0.0, -0.25, 0.21)
    head = MeshBuilder(default_uv_tile=0.5)
    # Extruded beveled aluminum housing pointing along -Y (glTF +Z)
    head.add_box((0.0, -0.09, 0.048), (0.148, 0.30, 0.128), mat_shell, bevel=0.024)
    # Dual-layer extended weather sun-shield hood with side fastener bolts
    head.add_box((0.0, -0.145, 0.118), (0.172, 0.37, 0.020), mat_shell, rot=(0.04, 0.0, 0.0), bevel=0.006)
    for sx in (-0.082, 0.082):
        head.add_box((sx, -0.145, 0.078), (0.014, 0.35, 0.078), mat_shell, bevel=0.004)
        head.add_cylinder((sx * 1.09, -0.08, 0.075), 0.008, 0.008, 0.014, mat_chrome, segments=6, rot=(0.0, math.pi * 0.5, 0.0))
    # Stepped matte optical baffle + multi-element glass lens barrel
    head.add_box((0.0, -0.242, 0.048), (0.128, 0.026, 0.108), mat_baffle, bevel=0.008)
    head.add_cylinder((0.0, -0.256, 0.052), 0.048, 0.042, 0.032, mat_baffle, segments=18, rot=(math.pi * 0.5, 0.0, 0.0))
    head.add_cylinder((0.0, -0.266, 0.052), 0.036, 0.032, 0.014, mat_ar_ring, segments=18, rot=(math.pi * 0.5, 0.0, 0.0))
    head.add_sphere((0.0, -0.272, 0.052), 0.031, mat_lens, scale=(1.0, 0.42, 1.0), segments=14, rings=10)
    # Ring of 12 infrared (IR) night-vision LED diodes encircling the optical barrel
    for k in range(12):
        a = (2.0 * math.pi * k) / 12.0
        head.add_sphere((math.cos(a) * 0.042, -0.256, 0.052 + math.sin(a) * 0.042), 0.0065, mat_ir, segments=6, rings=5)
    # Rear cable gland
    head.add_cylinder((0.0, 0.072, 0.048), 0.018, 0.016, 0.042, mat_baffle, segments=10, rot=(math.pi * 0.5, 0.0, 0.0))

    head_obj = head.finalize("Camera_Head", location=swivel)

    # ------------------------------------------------------------------
    # 3. Camera_LED (child of Camera_Head so it sweeps with camera)
    # ------------------------------------------------------------------
    led = MeshBuilder()
    led.add_sphere((0.0, 0.0, 0.0), 0.011, mat_led, segments=8, rings=6)
    led.finalize("Camera_LED", location=(0.046, -0.259, 0.012), parent=head_obj)

    return export_model_glb(out_dir, "security_camera.glb", ground=True)


# ===========================================================================
# 9. NEW: DOOR_DETAILED (Framed Walnut/Steel Security Door + Hinged Door_Leaf)
# ===========================================================================

def build_door_detailed(out_dir: str, tex_dir: str) -> int:
    """Detailed framed walnut/steel security door (~1.16m W x 2.38m H x 0.24m D).
    Grounded at y=0, front faces -Y Blender (+Z glTF).
    Door_Leaf is pivoted STRICTLY at left hinge axis x=+0.46, y=-0.02, z=0.0
    so rotating Door_Leaf.rotation.y from 0 to -1.65 rad physically swings it open!
    """
    reset_scene()

    mat_wood = make_pbr_tex_material("Door_WalnutTimber", "weathered_wood_door", tex_dir, normal_strength=0.90, brightness=1.25, coat=0.25)
    mat_frame = make_pbr_tex_material("Door_FrameSteel", "brushed_vault_steel", tex_dir, normal_strength=0.50, tint_hex="#5A626E", metallic_override=0.45)
    mat_brass = make_solid_material("Door_BrushedBrass", "#D6A848", metallic=0.94, roughness=0.22)
    mat_chrome = make_solid_material("Door_SteelHardware", "#CBD4DE", metallic=0.92, roughness=0.20)
    mat_glass = make_solid_material("Door_TransomGlass", "#B8D8E8", roughness=0.06, alpha=0.30, coat=1.0, double_sided=True)

    # ------------------------------------------------------------------
    # 1. Door_Frame (molded jambs, steel threshold sill, glazed transom window & 3 hinge knuckles)
    # ------------------------------------------------------------------
    frame = MeshBuilder(default_uv_tile=0.9)
    # Brushed-steel threshold sill plate grounded at z=0
    frame.add_box((0.0, 0.0, 0.014), (1.16, 0.22, 0.028), mat_chrome, bevel=0.006)
    # Left & right heavy molded door jambs (clear opening width 0.94m: x=-0.47..+0.47)
    for sx in (-0.525, 0.525):
        frame.add_box((sx, 0.0, 1.19), (0.11, 0.20, 2.36), mat_frame, bevel=0.012)
        # Decorative outer architrave trim moldings front & back
        for sy in (-0.11, 0.11):
            frame.add_box((sx * 1.03, sy, 1.19), (0.095, 0.032, 2.38), mat_wood, bevel=0.008)
    # Transom bar above door leaf (z=2.04) & top header lintel (z=2.34)
    frame.add_box((0.0, 0.0, 2.045), (0.98, 0.19, 0.07), mat_frame, bevel=0.010)
    frame.add_box((0.0, 0.0, 2.35), (1.18, 0.22, 0.08), mat_frame, bevel=0.012)
    for sy in (-0.11, 0.11):
        frame.add_box((0.0, sy, 2.36), (1.20, 0.034, 0.095), mat_wood, bevel=0.008)

    # Upper glazed transom window (z=2.08..2.31) with 3 slim brass muntins
    frame.add_quad_uv((-0.46, 0.0, 2.08), (0.46, 0.0, 2.08), (0.46, 0.0, 2.31), (-0.46, 0.0, 2.31), mat_glass)
    for mx in (-0.23, 0.0, 0.23):
        frame.add_box((mx, 0.0, 2.195), (0.024, 0.04, 0.23), mat_brass)

    # 3 heavy brass butt-hinge barrels on left jamb (+X = +0.465, y = -0.025)
    for hz in (0.34, 1.04, 1.74):
        frame.add_cylinder((0.465, -0.028, hz), 0.014, 0.014, 0.11, mat_brass, segments=10)

    frame.finalize("Door_Frame")

    # ------------------------------------------------------------------
    # 2. Door_Leaf (hinged STRICTLY at left edge x=+0.465, y=-0.025, z=0.0!)
    # ------------------------------------------------------------------
    hinge = (0.465, -0.025, 0.0)
    leaf = MeshBuilder(default_uv_tile=0.85)
    # Main walnut/steel-edged door slab centered at local x = -0.465 (width 0.92m, height 2.00m, depth 0.062m)
    leaf.add_box((-0.465, 0.025, 1.022), (0.92, 0.058, 1.99), mat_wood, bevel=0.008)
    # Reinforced steel perimeter security channel along latch edge
    leaf.add_box((-0.922, 0.025, 1.022), (0.016, 0.064, 1.99), mat_frame)
    # Raised beveled architectural timber panels on BOTH front & back faces!
    for sy in (-0.010, 0.060):
        # Upper twin tall raised panels
        for px in (-0.27, -0.66):
            leaf.add_box((px, sy, 1.44), (0.29, 0.018, 0.72), mat_wood, bevel=0.014)
        # Lower wide raised panel
        leaf.add_box((-0.465, sy, 0.58), (0.68, 0.018, 0.56), mat_wood, bevel=0.014)
        # Brushed-brass lower protective kickplate
        leaf.add_box((-0.465, sy, 0.13), (0.86, 0.012, 0.18), mat_brass, bevel=0.003)
        # Mortise security escutcheon plate + Euro-profile brass lock cylinder
        leaf.add_box((-0.825, sy, 0.99), (0.056, 0.016, 0.24), mat_brass, bevel=0.005)
        leaf.add_cylinder((-0.825, sy + (-0.012 if sy < 0 else 0.012), 0.93), 0.016, 0.016, 0.018, mat_chrome, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
        # Optical brass security peephole at eye level
        leaf.add_cylinder((-0.465, sy + (-0.010 if sy < 0 else 0.010), 1.56), 0.016, 0.013, 0.016, mat_brass, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))

    # Latch bolt tongue on lock edge
    leaf.add_box((-0.935, 0.025, 1.03), (0.028, 0.018, 0.032), mat_chrome, bevel=0.004)

    leaf_obj = leaf.finalize("Door_Leaf", location=hinge)

    # ------------------------------------------------------------------
    # 3. Door_Handle (child of Door_Leaf, pivoted at latch spindle for subtle push-down!)
    # ------------------------------------------------------------------
    hdl = MeshBuilder()
    for sgn in (-1.0, 1.0):
        # Spindle neck
        hdl.add_cylinder((0.0, sgn * 0.055, 0.0), 0.014, 0.014, 0.06, mat_brass, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
        # Curved ergonomic lever bar pointing inward toward center of door (+X relative to latch)
        hdl.add_tube(
            [(0.0, sgn * 0.082, 0.0), (0.04, sgn * 0.088, 0.0), (0.125, sgn * 0.086, 0.0), (0.145, sgn * 0.072, 0.0)],
            [0.014, 0.013, 0.012, 0.010],
            mat_brass,
            segments=10,
        )
    hdl.finalize("Door_Handle", location=(-0.825, 0.025, 1.045), parent=leaf_obj)

    return export_model_glb(out_dir, "door_detailed.glb", ground=True)


# ===========================================================================
# 10. NEW: CAFE_TERRACE (Salou Promenade Bistro Table, Scroll Chairs, Planter & Bollard)
# ===========================================================================

def _build_bistro_chair(name: str, location: Tuple[float, float, float], rot_z: float, mat_iron, mat_wood) -> None:
    """Build a graceful curved Mediterranean wrought-iron bistro chair with slatted seat & scroll back."""
    mb = MeshBuilder(default_uv_tile=0.5)
    # 4 graceful curved tubular iron legs
    for sx in (-0.19, 0.19):
        # Front legs
        mb.add_tube([(sx * 1.08, -0.20, 0.0), (sx * 1.02, -0.18, 0.24), (sx, -0.17, 0.45)], 0.012, mat_iron, segments=8)
        # Rear legs rising continuously up into backrest frame
        mb.add_tube(
            [(sx * 1.08, 0.21, 0.0), (sx * 1.02, 0.18, 0.24), (sx, 0.17, 0.45), (sx * 0.98, 0.20, 0.72), (sx * 0.92, 0.22, 0.86)],
            0.012,
            mat_iron,
            segments=8,
        )
    # Circular iron seat hoop + lower stretcher ring
    hoop = [(math.cos(2 * math.pi * k / 18) * 0.21, math.sin(2 * math.pi * k / 18) * 0.21, 0.45) for k in range(19)]
    mb.add_tube(hoop, 0.013, mat_iron, segments=8, cap=False)
    stretch = [(math.cos(2 * math.pi * k / 16) * 0.185, math.sin(2 * math.pi * k / 16) * 0.185, 0.17) for k in range(17)]
    mb.add_tube(stretch, 0.009, mat_iron, segments=6, cap=False)

    # Slatted curved walnut/teak seat planks
    for i in range(5):
        sy = -0.14 + i * 0.07
        w = math.sqrt(max(0.02, 0.195 ** 2 - sy ** 2)) * 1.92
        mb.add_box((0.0, sy, 0.464), (w, 0.052, 0.016), mat_wood, bevel=0.004)

    # Arched wrought-iron backrest crest + Parisian double-scroll filigree inside back
    arch = [
        (-0.175, 0.22, 0.85), (-0.12, 0.225, 0.91), (0.0, 0.23, 0.93), (0.12, 0.225, 0.91), (0.175, 0.22, 0.85)
    ]
    mb.add_tube(arch, 0.012, mat_iron, segments=8)
    mb.add_tube([(-0.18, 0.195, 0.62), (0.0, 0.205, 0.62), (0.18, 0.195, 0.62)], 0.010, mat_iron, segments=6)
    for sgn in (-1.0, 1.0):
        scroll = [
            (0.0, 0.21, 0.63), (sgn * 0.06, 0.215, 0.72), (sgn * 0.11, 0.22, 0.82),
            (sgn * 0.05, 0.225, 0.87), (0.0, 0.22, 0.80),
        ]
        mb.add_tube(scroll, 0.0085, mat_iron, segments=6)

    mb.finalize(name, location=location, rot=(0.0, 0.0, rot_z))


def build_cafe_terrace(out_dir: str, tex_dir: str) -> int:
    """Salou night promenade sidewalk terrace cluster (~2.45m W x 1.18m H x 1.90m D, grounded y=0)."""
    reset_scene()

    mat_marble = make_pbr_tex_material("Cafe_MarbleTop", "veined_dark_marble", tex_dir, normal_strength=0.45, tint_hex="#DDD8CE", desat=0.5, coat=0.8)
    mat_iron = make_pbr_tex_material("Cafe_WroughtIron", "hammered_wrought_iron", tex_dir, normal_strength=1.0)
    mat_wood = make_pbr_tex_material("Cafe_ChairWood", "weathered_wood_door", tex_dir, normal_strength=0.95)
    mat_terra = make_pbr_tex_material("Cafe_TerracottaUrn", "terracotta_tiles", tex_dir, normal_strength=1.15)
    mat_stone = make_pbr_tex_material("Cafe_StoneBase", "limestone_ashlar", tex_dir, normal_strength=1.1)
    mat_leaf = make_pbr_tex_material("Cafe_OliveFoliage", "palm_leaf", tex_dir, normal_strength=0.9, double_sided=True)
    mat_soil = make_solid_material("Cafe_Soil", "#241B14", roughness=0.95)
    mat_brass = make_solid_material("Cafe_BrassRim", "#D9AC4A", metallic=0.93, roughness=0.22)
    mat_glass = make_solid_material("Cafe_Glassware", "#D8EEF8", roughness=0.05, alpha=0.28, coat=1.0, double_sided=True)
    mat_cup = make_solid_material("Cafe_EspressoCup", "#EAE4D8", roughness=0.22, coat=0.6)
    mat_candle = make_solid_material("Cafe_CandleFlame", "#FFD278", emission="#FF9E2C", emission_strength=5.5, roughness=0.1)

    # ------------------------------------------------------------------
    # 1. Table (veined marble bistro table + spun brass rim + tripod iron base + glassware)
    # ------------------------------------------------------------------
    tbl = MeshBuilder(default_uv_tile=0.7)
    # Turned cast-iron pedestal column & 3 curved cabriole tripod feet
    tbl.add_cylinder((0.0, 0.0, 0.42), 0.046, 0.036, 0.62, mat_iron, segments=14)
    tbl.add_sphere((0.0, 0.0, 0.24), 0.068, mat_iron, scale=(1.0, 1.0, 1.35), segments=12, rings=8)
    tbl.add_cylinder((0.0, 0.0, 0.71), 0.16, 0.06, 0.05, mat_iron, segments=12)
    for k in range(3):
        a = (2.0 * math.pi * k) / 3.0 + 0.35
        ca, sa = math.cos(a), math.sin(a)
        tbl.add_tube(
            [(ca * 0.04, sa * 0.04, 0.18), (ca * 0.16, sa * 0.16, 0.13), (ca * 0.29, sa * 0.29, 0.05), (ca * 0.33, sa * 0.33, 0.018)],
            [0.026, 0.022, 0.018, 0.022],
            mat_iron,
            segments=8,
        )
    # Round veined marble tabletop with spun brushed-brass gallery edge
    tbl.add_cylinder((0.0, 0.0, 0.745), 0.43, 0.43, 0.034, mat_marble, segments=28)
    tbl.add_cylinder((0.0, 0.0, 0.745), 0.442, 0.442, 0.038, mat_brass, segments=28, cap=False)

    # Hurricane glass votive holder + espresso cup/saucer + wine glass on tabletop (z=0.762)
    tbl.add_cylinder((0.0, 0.0, 0.772), 0.048, 0.048, 0.020, mat_brass, segments=14)
    tbl.add_cylinder((0.0, 0.0, 0.845), 0.046, 0.056, 0.13, mat_glass, segments=16, cap=False)
    # Espresso cup + saucer
    tbl.add_cylinder((-0.18, -0.10, 0.768), 0.062, 0.052, 0.012, mat_cup, segments=14)
    tbl.add_cylinder((-0.18, -0.10, 0.800), 0.030, 0.038, 0.056, mat_cup, segments=14)
    # Stemmed Mediterranean wine glass
    tbl.add_cylinder((0.17, 0.11, 0.767), 0.036, 0.032, 0.008, mat_glass, segments=12)
    tbl.add_cylinder((0.17, 0.11, 0.822), 0.006, 0.006, 0.105, mat_glass, segments=8)
    tbl.add_cylinder((0.17, 0.11, 0.905), 0.028, 0.040, 0.085, mat_glass, segments=14)

    tbl.finalize("Table", location=(0.0, 0.0, 0.0))

    # ------------------------------------------------------------------
    # 2. Candle_Glow (warm flickering candle flame inside glass hurricane lantern)
    # ------------------------------------------------------------------
    cnd = MeshBuilder()
    cnd.add_cylinder((0.0, 0.0, -0.022), 0.024, 0.024, 0.044, mat_cup, segments=12)
    cnd.add_sphere((0.0, 0.0, 0.018), 0.016, mat_candle, scale=(0.75, 0.75, 1.65), segments=10, rings=8)
    cnd.finalize("Candle_Glow", location=(0.0, 0.0, 0.81))

    # ------------------------------------------------------------------
    # 3. Chair_L & Chair_R (two angled wrought-iron Mediterranean bistro chairs)
    # ------------------------------------------------------------------
    _build_bistro_chair("Chair_L", (0.64, 0.14, 0.0), rot_z=math.radians(108), mat_iron=mat_iron, mat_wood=mat_wood)
    _build_bistro_chair("Chair_R", (-0.66, -0.08, 0.0), rot_z=math.radians(-78), mat_iron=mat_iron, mat_wood=mat_wood)

    # ------------------------------------------------------------------
    # 4. Planter (fluted Mediterranean terracotta urn + olive/rosemary foliage)
    # ------------------------------------------------------------------
    pln = MeshBuilder(default_uv_tile=0.6)
    pln.add_box((0.0, 0.0, 0.04), (0.48, 0.48, 0.08), mat_stone, bevel=0.012)
    # Turned amphora/urn profile via loft
    urn_prof = [
        (0.08, 0.14), (0.14, 0.18), (0.25, 0.24), (0.42, 0.27),
        (0.56, 0.23), (0.62, 0.28), (0.66, 0.27), (0.64, 0.22),
    ]
    urn_rings = []
    for pz, pr in urn_prof:
        urn_rings.append([(math.cos(2 * math.pi * k / 18) * pr, math.sin(2 * math.pi * k / 18) * pr, pz) for k in range(18)])
    pln.add_loft(urn_rings, mat_terra, cap_start=True, cap_end=False, smooth=True, closed_u=True, u_repeat=2.0, v_repeat=1.5)
    pln.add_cylinder((0.0, 0.0, 0.61), 0.22, 0.22, 0.04, mat_soil, segments=16)

    # Layered Mediterranean olive/rosemary branches & leaf clusters
    for b in range(7):
        ang = (2.0 * math.pi * b) / 7.0 + 0.2
        rad = 0.06 + (b % 2) * 0.08
        bh = 0.34 + (b % 3) * 0.11
        tip = (math.cos(ang) * (rad + 0.18), math.sin(ang) * (rad + 0.18), 0.62 + bh)
        pln.add_tube([(math.cos(ang) * 0.04, math.sin(ang) * 0.04, 0.61), tip], [0.015, 0.007], mat_wood, segments=6)
        # Clustered crossed olive leaf blades around each branch tip
        for lf in range(5):
            la = ang + lf * 1.25
            lz = tip[2] - 0.06 + (lf % 3) * 0.055
            p0 = (tip[0] * 0.85, tip[1] * 0.85, lz)
            ca, sa = math.cos(la), math.sin(la)
            p1 = (p0[0] + ca * 0.14 - sa * 0.05, p0[1] + sa * 0.14 + ca * 0.05, lz + 0.04)
            p2 = (p0[0] + ca * 0.22, p0[1] + sa * 0.22, lz + 0.01)
            p3 = (p0[0] + ca * 0.14 + sa * 0.05, p0[1] + sa * 0.14 - ca * 0.05, lz + 0.04)
            pln.add_quad_uv(p0, p1, p2, p3, mat_leaf, smooth=True)

    pln.finalize("Planter", location=(-1.04, 0.62, 0.0))

    # ------------------------------------------------------------------
    # 5. Bollard (Catalan coastal cast-iron promenade sidewalk bollard w/ brass collar)
    # ------------------------------------------------------------------
    bol = MeshBuilder(default_uv_tile=0.5)
    bol.add_cylinder((0.0, 0.0, 0.04), 0.135, 0.12, 0.08, mat_iron, segments=16)
    bol.add_cylinder((0.0, 0.0, 0.42), 0.095, 0.082, 0.70, mat_iron, segments=16)
    bol.add_cylinder((0.0, 0.0, 0.70), 0.090, 0.090, 0.048, mat_brass, segments=16)
    bol.add_cylinder((0.0, 0.0, 0.79), 0.092, 0.082, 0.06, mat_iron, segments=16)
    bol.add_sphere((0.0, 0.0, 0.82), 0.080, mat_iron, scale=(1.0, 1.0, 0.85), segments=16, rings=10)
    bol.finalize("Bollard", location=(1.12, -0.68, 0.0))

    return export_model_glb(out_dir, "cafe_terrace.glb", ground=True)


# ===========================================================================
# High-Resolution Blender 5.2 Night-Noir Studio QA Contact Sheet Renderer
# ===========================================================================

def render_qa_sheet(out_png: str, model_files: List[str]) -> None:
    """Render a crisp 1920x1152 night-noir studio QA contact sheet of all 10 architecture & prop GLBs."""
    tile_w, tile_h = 480, 384
    cols, rows = 4, 3
    tmp_dir = os.path.join(os.path.dirname(out_png), "_env_props_qa_tiles")
    os.makedirs(tmp_dir, exist_ok=True)
    tile_paths = []

    for fname in model_files:
        glb_path = os.path.join(OUT_DIR, fname)
        bpy.ops.wm.read_factory_settings(use_empty=True)
        scene = bpy.context.scene
        scene.render.engine = "BLENDER_EEVEE"
        scene.render.resolution_x = tile_w
        scene.render.resolution_y = tile_h
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.view_settings.view_transform = "AgX"

        # Rich Mediterranean coastal night sky bounce
        world = bpy.data.worlds.new("QAWorld")
        scene.world = world
        if world.node_tree is None:
            world.use_nodes = True
        bg = world.node_tree.nodes.get("Background")
        if bg:
            bg.inputs["Color"].default_value = (0.04, 0.06, 0.11, 1.0)
            bg.inputs["Strength"].default_value = 1.15

        # Wet night slate studio floor
        bpy.ops.mesh.primitive_cylinder_add(vertices=36, radius=24.0, depth=0.04, location=(0.0, 0.0, -0.02))
        fl = bpy.context.active_object
        fmat = bpy.data.materials.new("QAFloor")
        fbsdf = fmat.node_tree.nodes.get("Principled BSDF")
        fbsdf.inputs["Base Color"].default_value = (0.035, 0.045, 0.065, 1.0)
        fbsdf.inputs["Roughness"].default_value = 0.28
        fl.data.materials.append(fmat)

        # Warm sodium key + cool moonlight rim + soft bounce fill
        for lname, energy, col, rot in [
            ("Key", 3.6, (1.0, 0.87, 0.70), (50, -18, -36)),
            ("Rim", 2.0, (0.52, 0.76, 1.0), (38, 16, 142)),
            ("Fill", 1.2, (0.88, 0.92, 1.0), (68, 0, 28)),
        ]:
            ld = bpy.data.lights.new(lname, type="SUN")
            ld.energy = energy
            ld.color = col
            lo = bpy.data.objects.new(lname, ld)
            scene.collection.objects.link(lo)
            lo.rotation_euler = tuple(math.radians(a) for a in rot)

        before = set(scene.objects)
        bpy.ops.import_scene.gltf(filepath=glb_path)
        imported = [o for o in scene.objects if o not in before]

        bpy.context.view_layer.update()
        mn = Vector((1e9, 1e9, 1e9))
        mx = Vector((-1e9, -1e9, -1e9))
        for obj in imported:
            if obj.type != "MESH":
                continue
            for corner in obj.bound_box:
                w = obj.matrix_world @ Vector(corner)
                mn = Vector((min(mn.x, w.x), min(mn.y, w.y), min(mn.z, w.z)))
                mx = Vector((max(mx.x, w.x), max(mx.y, w.y), max(mx.z, w.z)))

        center = (mn + mx) * 0.5
        size = mx - mn
        radius = max(size.length * 0.50, 0.22)

        cam_d = bpy.data.cameras.new("QACam")
        cam_d.lens = 46.0
        cam_o = bpy.data.objects.new("QACam", cam_d)
        scene.collection.objects.link(cam_o)
        scene.camera = cam_o

        az = math.radians(-30)
        el = math.radians(17)
        # Aspect-aware framing so tall props (streetlamp, door, pillar) fit cleanly with zero cropping!
        dist_h = size.z * 1.95
        dist_w = max(size.x, size.y) * 1.65
        dist = max(radius * 2.80, dist_h, dist_w, 0.72)
        cam_dir = Vector((-math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
        cam_o.location = center + cam_dir * dist
        cam_o.rotation_euler = (center - cam_o.location).to_track_quat("-Z", "Y").to_euler()

        tpath = os.path.join(tmp_dir, fname.replace(".glb", ".png"))
        scene.render.filepath = tpath
        bpy.ops.render.render(write_still=True)
        tile_paths.append(tpath)

    # Stitch into single contact sheet PNG via Blender image API
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sheet_w, sheet_h = cols * tile_w, rows * tile_h
    sheet = bpy.data.images.new("EnvPropsQA", width=sheet_w, height=sheet_h, alpha=False)
    buf = [0.02, 0.03, 0.05, 1.0] * (sheet_w * sheet_h)
    for idx, p in enumerate(tile_paths):
        img = bpy.data.images.load(p)
        px = list(img.pixels)
        col = idx % cols
        row = rows - 1 - (idx // cols)
        x0, y0 = col * tile_w, row * tile_h
        for y in range(tile_h):
            s0 = y * tile_w * 4
            d0 = ((y0 + y) * sheet_w + x0) * 4
            buf[d0 : d0 + tile_w * 4] = px[s0 : s0 + tile_w * 4]
        bpy.data.images.remove(img)
    sheet.pixels.foreach_set(buf)
    sheet.filepath_raw = out_png
    sheet.file_format = "PNG"
    sheet.save()
    print(f"[build_env_props] QA sheet saved to {out_png}")


# ===========================================================================
# Main Entrypoint
# ===========================================================================

def main() -> None:
    t0 = time.time()
    argv = sys.argv
    extra = argv[argv.index("--") + 1 :] if "--" in argv else []
    tex_dir = DEFAULT_TEX_DIR
    qa_out: Optional[str] = None
    i = 0
    while i < len(extra):
        if extra[i] == "--tex-dir" and i + 1 < len(extra):
            tex_dir = extra[i + 1]
            i += 2
        elif extra[i] == "--qa-out" and i + 1 < len(extra):
            qa_out = extra[i + 1]
            i += 2
        else:
            i += 1

    builders = [
        ("salou_facade.glb", build_salou_facade),
        ("dresden_pillar.glb", build_dresden_pillar),
        ("palm_tree.glb", build_palm_tree),
        ("streetlamp.glb", build_streetlamp),
        ("safe.glb", build_safe),
        ("display_case.glb", build_display_case),
        ("power_box.glb", build_power_box),
        ("security_camera.glb", build_security_camera),
        ("door_detailed.glb", build_door_detailed),
        ("cafe_terrace.glb", build_cafe_terrace),
    ]

    total_bytes = 0
    for fname, fn in builders:
        sz = fn(OUT_DIR, tex_dir)
        total_bytes += sz
        print(f"[build_env_props] Built {fname:22s} -> {sz / 1024:7.1f} KB")

    print(
        f"[build_env_props] DONE: {len(builders)} photoreal env/prop GLBs "
        f"({total_bytes / 1024:.1f} KB / {total_bytes / (1024 * 1024):.2f} MB) in {time.time() - t0:.2f}s"
    )

    if qa_out:
        render_qa_sheet(qa_out, [f for f, _ in builders])


if __name__ == "__main__":
    main()
