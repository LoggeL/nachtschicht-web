"""Photorealistic sculpted, skeletal-rigged, animated Blender 5.2 generator for
Nachtschicht Hero Crew Characters:
  - public/assets/models/character_jupp.glb  (Jupp Kowalke, 68yo German master safecracker, ~1.76m)
  - public/assets/models/character_crew.glb  (Tactical night-heist accomplice + Loot Duffel Backpack, ~1.78m)

Conventions:
  - Blender Z-up (+Z up, -Y forward, +X character left) -> glTF Y-up (+Y up, +Z forward, +X left)
  - Grounded strictly at y = 0.0000 in glTF (z = 0.0000 in Blender)
  - Real Humanoid Armature skeletal rig + smooth analytical skin weights (max 4 influences/vert)
  - 6 baked looping glTF animation clips on BOTH models:
      Idle, Walk, Sneak, Work, CarryLoot, Panic
  - Real photorealistic PBR textures (gpt-image-2 albedo + Sobel tangent normal + packed ORM)
    embedded directly inside each GLB.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_crew.py -- [--qa-out /path/to/crew_qa.png] [--tex-dir /path/to/textures]
"""

from __future__ import annotations

import json
import math
import struct
import sys
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import bmesh
import bpy
import numpy as np
from mathutils import Euler, Matrix, Vector

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parents[1]
MODELS_DIR = PROJECT_ROOT / "public" / "assets" / "models"
DEFAULT_TEX_DIR = Path(
    "/Users/logge/.gemini/antigravity-cli/brain/c740d959-e7b1-4d9c-b5f7-b38b84e35fd4/scratch/textures"
)
DEFAULT_QA_OUT = Path(
    "/Users/logge/.gemini/antigravity-cli/brain/c740d959-e7b1-4d9c-b5f7-b38b84e35fd4/crew_qa.png"
)


# ---------------------------------------------------------------------------
# Math & Utility Helpers
# ---------------------------------------------------------------------------

def clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else (hi if x > hi else x)


def smoothstep(edge0: float, edge1: float, x: float) -> float:
    if abs(edge1 - edge0) < 1e-8:
        return 1.0 if x >= edge1 else 0.0
    t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def srgb_to_linear(c: float) -> float:
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def hex_rgb_srgb(hex_str: str) -> Tuple[float, float, float]:
    s = hex_str.lstrip("#")
    return (int(s[0:2], 16) / 255.0, int(s[2:4], 16) / 255.0, int(s[4:6], 16) / 255.0)


def hex_rgba(hex_str: str, alpha: float = 1.0) -> Tuple[float, float, float, float]:
    r, g, b = hex_rgb_srgb(hex_str)
    return (srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), alpha)


def reset_scene() -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if bpy.context.scene.world is None:
        bpy.context.scene.world = bpy.data.worlds.new("World")


# ---------------------------------------------------------------------------
# NumPy Photorealistic Texture Compositor & PBR Material System
# ---------------------------------------------------------------------------

_NP_CACHE: Dict[str, np.ndarray] = {}


def _load_image_rgba_np(path: Path) -> Optional[np.ndarray]:
    k = str(path)
    if k in _NP_CACHE:
        return _NP_CACHE[k]
    if not path.exists():
        return None
    img = bpy.data.images.load(str(path), check_existing=False)
    w, h = img.size[0], img.size[1]
    arr = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(arr)
    bpy.data.images.remove(img)
    arr = arr.reshape((h, w, 4))
    _NP_CACHE[k] = arr
    return arr


def _make_blender_image(name: str, rgba: np.ndarray, colorspace: str = "sRGB") -> bpy.types.Image:
    if name in bpy.data.images:
        return bpy.data.images[name]
    h, w, _ = rgba.shape
    img = bpy.data.images.new(name=name, width=w, height=h, alpha=False)
    img.colorspace_settings.name = colorspace
    clipped = np.clip(rgba, 0.0, 1.0).astype(np.float32)
    clipped[:, :, 3] = 1.0
    img.pixels.foreach_set(clipped.ravel())
    img.pack()
    return img


def _tile_np(arr: np.ndarray, reps: int, size: int) -> np.ndarray:
    h, w, _ = arr.shape
    ys = (np.linspace(0, h * reps, size, endpoint=False) % h).astype(np.int32)
    xs = (np.linspace(0, w * reps, size, endpoint=False) % w).astype(np.int32)
    return arr[ys][:, xs]


def _gauss_2d(u: np.ndarray, v: np.ndarray, u0: float, v0: float, su: float, sv: float) -> np.ndarray:
    du = (u - u0) / su
    dv = (v - v0) / sv
    return np.exp(-0.5 * (du * du + dv * dv))


def compose_face_texture_set(
    tex_dir: Path,
    skin_key: str,
    prefix: str,
    is_jupp: bool,
    size: int = 512,
) -> Tuple[bpy.types.Image, bpy.types.Image, bpy.types.Image]:
    """Composite a UV-aligned photorealistic face albedo, tangent normal, and ORM map
    on top of the real gpt-image-2 skin texture!

    Head UV mapping contract (matched verbatim by add_sculpted_head):
      u in [0, 1]: u = 0.5 is dead-center front (-Y); u = 0.25 right ear (-X); u = 0.75 left ear (+X)
      v in [0, 1]: v = 0.0 neck base; v = 0.25 chin; v = 0.365 mouth; v = 0.485 nose tip;
                   v = 0.592 eyes; v = 0.678 brows; v = 0.80 forehead; v = 1.0 crown
    """
    raw_alb = _load_image_rgba_np(tex_dir / f"{skin_key}_albedo.png")
    raw_nrm = _load_image_rgba_np(tex_dir / f"{skin_key}_normal.png")
    raw_orm = _load_image_rgba_np(tex_dir / f"{skin_key}_orm.png")

    if raw_alb is not None:
        alb = _tile_np(raw_alb, 2, size).copy()
        nrm = _tile_np(raw_nrm, 2, size).copy() if raw_nrm is not None else np.full((size, size, 4), [0.5, 0.5, 1.0, 1.0], dtype=np.float32)
        orm = _tile_np(raw_orm, 2, size).copy() if raw_orm is not None else np.full((size, size, 4), [0.92, 0.54, 0.0, 1.0], dtype=np.float32)
    else:
        alb = np.full((size, size, 4), [0.64, 0.48, 0.38, 1.0], dtype=np.float32)
        nrm = np.full((size, size, 4), [0.5, 0.5, 1.0, 1.0], dtype=np.float32)
        orm = np.full((size, size, 4), [0.92, 0.54, 0.0, 1.0], dtype=np.float32)

    # Calibrate real gpt-image-2 skin albedo into naturalistic European/Mediterranean film tone
    rgb = alb[:, :, :3]
    lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
    desat = 0.28 if is_jupp else 0.24
    rgb = rgb * (1.0 - desat) + lum[:, :, None] * desat
    target_mean = np.array([0.58, 0.43, 0.35], dtype=np.float32) if is_jupp else np.array([0.60, 0.46, 0.37], dtype=np.float32)
    cur_mean = np.maximum(rgb.mean(axis=(0, 1)), 1e-4)
    rgb = np.clip(rgb * (target_mean / cur_mean)[None, None, :], 0.0, 1.0)

    vs = np.linspace(0.0, 1.0, size, dtype=np.float32)[:, None]
    us = np.linspace(0.0, 1.0, size, dtype=np.float32)[None, :]
    u = np.broadcast_to(us, (size, size))
    v = np.broadcast_to(vs, (size, size))
    au = np.abs(u - 0.5)
    bump = np.zeros((size, size), dtype=np.float32)

    # 1. Subdermal facial color zones (forehead ochre, cheeks/nose warm bloodflow, cooler jaw/neck)
    cheeks = _gauss_2d(au, v, 0.095, 0.505, 0.058, 0.065) + _gauss_2d(au, v, 0.0, 0.505, 0.036, 0.070) * 0.90
    rgb[:, :, 0] = np.clip(rgb[:, :, 0] + cheeks * (0.044 if is_jupp else 0.032), 0.0, 1.0)
    rgb[:, :, 1] = np.clip(rgb[:, :, 1] - cheeks * 0.014, 0.0, 1.0)
    rgb[:, :, 2] = np.clip(rgb[:, :, 2] - cheeks * 0.016, 0.0, 1.0)

    # Natural submental/neck ambient shading under jaw
    neck_ao = np.clip((0.22 - v) / 0.17, 0.0, 1.0) * 0.26
    rgb *= (1.0 - neck_ao[:, :, None])
    orm[:, :, 0] = np.clip(orm[:, :, 0] - neck_ao * 0.55, 0.40, 1.0)

    # 2. Deep moody orbital eye socket shadow + crisp realistic almond upper/lower lash rim!
    # Eyes sit at u = 0.5 ± 0.060, v = 0.592
    eye_socket = _gauss_2d(au, v, 0.060, 0.592, 0.036, 0.034)
    rgb[:, :, 0] *= (1.0 - 0.25 * eye_socket)
    rgb[:, :, 1] *= (1.0 - 0.31 * eye_socket)
    rgb[:, :, 2] *= (1.0 - 0.31 * eye_socket)
    orm[:, :, 0] = np.clip(orm[:, :, 0] - eye_socket * 0.38, 0.32, 1.0)

    # Almond eyelid crease shadow & crisp natural upper/lower lash rim aligned to sculpted eye opening!
    eu = (au - 0.060) / 0.024
    in_eye_x = np.clip(1.0 - eu * eu, 0.0, 1.0)
    upper_arc_v = 0.591 + 0.0095 * in_eye_x
    lower_arc_v = 0.583 - 0.0045 * in_eye_x
    lid_crease = in_eye_x * np.exp(-0.5 * ((v - (upper_arc_v + 0.015)) / 0.0065) ** 2)
    lash_upper = in_eye_x * np.exp(-0.5 * ((v - upper_arc_v) / 0.0045) ** 2)
    lash_lower = in_eye_x * np.exp(-0.5 * ((v - lower_arc_v) / 0.0038) ** 2)
    rgb *= (1.0 - np.clip(lid_crease * 0.44 + lash_upper * 0.82 + lash_lower * 0.34, 0.0, 0.90)[:, :, None])
    bump -= (lid_crease * 0.70 + lash_upper * 0.60)

    # Subtle natural hairline shadow gradient on forehead for seamless hair-to-skin transition
    if not is_jupp:
        hair_edge = np.clip((v - 0.785) / 0.055, 0.0, 1.0) * 0.32
        rgb *= (1.0 - hair_edge[:, :, None])

    # 3. Nostril cavities & nose-wing crease occlusion
    nostrils = _gauss_2d(au, v, 0.019, 0.456, 0.012, 0.010)
    alar_crease = _gauss_2d(au, v, 0.034, 0.472, 0.008, 0.016)
    rgb *= (1.0 - np.clip(nostrils * 0.72 + alar_crease * 0.30, 0.0, 0.82)[:, :, None])
    orm[:, :, 0] = np.clip(orm[:, :, 0] - nostrils * 0.50, 0.30, 1.0)

    # 4. Natural anatomical adult lips (muted realistic vermilion + crisp parting line)
    lip_u = np.clip(1.0 - (au / 0.056) ** 2, 0.0, 1.0)
    upper_lip = lip_u * np.exp(-0.5 * ((v - (0.376 - 0.004 * (au / 0.056) ** 2)) / 0.0115) ** 2)
    lower_lip = lip_u * np.exp(-0.5 * ((v - (0.348 + 0.003 * (au / 0.056) ** 2)) / 0.0135) ** 2)
    lip_mask = np.clip(upper_lip + lower_lip, 0.0, 1.0)
    lip_color = np.array([0.46, 0.28, 0.26], dtype=np.float32) if is_jupp else np.array([0.49, 0.31, 0.28], dtype=np.float32)
    rgb = rgb * (1.0 - lip_mask[:, :, None] * 0.70) + lip_color[None, None, :] * (lip_mask[:, :, None] * 0.70)
    mouth_line = lip_u * np.exp(-0.5 * ((v - 0.362) / 0.0048) ** 2)
    rgb *= (1.0 - mouth_line[:, :, None] * 0.68)
    bump -= mouth_line * 0.80
    orm[:, :, 1] = np.clip(orm[:, :, 1] - lip_mask * 0.14, 0.28, 0.92)

    # 5. Soft brow density bed directly under 3D sculpted brows
    brow_v = 0.674 + 0.006 * np.sin((au - 0.03) * 28.0)
    brow_mask = _gauss_2d(au, v - (brow_v - 0.675), 0.062, 0.675, 0.040, 0.013)
    brow_tone = np.array([0.28, 0.27, 0.26], dtype=np.float32) if is_jupp else np.array([0.11, 0.09, 0.08], dtype=np.float32)
    rgb = rgb * (1.0 - brow_mask[:, :, None] * 0.52) + brow_tone[None, None, :] * (brow_mask[:, :, None] * 0.52)

    # 6. Character aging wrinkles & photorealistic facial hair stubble
    rng = np.random.default_rng(101 if is_jupp else 202)
    n_hi = rng.random((size, size), dtype=np.float32)
    n_med = np.repeat(np.repeat(rng.random((size // 2, size // 2), dtype=np.float32), 2, axis=0), 2, axis=1)

    if is_jupp:
        # Forehead expression lines, glabella worry lines, crow's feet, deep nasolabial folds, under-eye creases
        fh_zone = _gauss_2d(u, v, 0.5, 0.755, 0.12, 0.048)
        wrinkle_fh = fh_zone * np.maximum(0.0, np.cos((v - 0.72) * 155.0)) ** 5
        glab = _gauss_2d(au, v, 0.011, 0.665, 0.006, 0.026)
        cf_zone = _gauss_2d(au, v, 0.106, 0.588, 0.024, 0.022)
        crow = cf_zone * np.maximum(0.0, np.sin((v - 0.588) * 240.0 + (au - 0.095) * 95.0)) ** 4
        nl_target_u = 0.036 + np.clip((0.48 - v) / 0.14, 0.0, 1.0) * 0.044
        nl_v_mask = np.clip((v - 0.31) / 0.04, 0.0, 1.0) * np.clip((0.49 - v) / 0.04, 0.0, 1.0)
        nasolabial = nl_v_mask * np.exp(-0.5 * ((au - nl_target_u) / 0.009) ** 2)
        undereye = _gauss_2d(au, v, 0.062, 0.553, 0.032, 0.008)

        creases = np.clip(wrinkle_fh * 0.58 + glab * 0.55 + crow * 0.48 + nasolabial * 0.85 + undereye * 0.55, 0.0, 1.0)
        rgb *= (1.0 - creases[:, :, None] * 0.30)
        bump -= creases * 1.10
        orm[:, :, 0] = np.clip(orm[:, :, 0] - creases * 0.28, 0.40, 1.0)

        # Rich salt-and-pepper trimmed beard & moustache root stubble (matching portrait_jupp.webp!)
        jaw_zone = (
            _gauss_2d(u, v, 0.5, 0.260, 0.168, 0.090)
            + _gauss_2d(au, v, 0.132, 0.345, 0.056, 0.088) * 0.82
            + _gauss_2d(u, v, 0.5, 0.402, 0.066, 0.028) * 1.25
        )
        jaw_zone = np.clip(jaw_zone - lip_mask * 1.4 - nostrils * 1.2, 0.0, 1.0)
        jaw_zone *= np.clip((v - 0.175) / 0.045, 0.0, 1.0)
        salt_mask = (n_hi > 0.54).astype(np.float32) * jaw_zone
        pepper_mask = (n_hi < 0.34).astype(np.float32) * jaw_zone
        stubble_base = jaw_zone * (0.58 + 0.42 * n_med)

        ash_tone = np.array([0.36, 0.35, 0.34], dtype=np.float32)
        silver_hair = np.array([0.66, 0.65, 0.63], dtype=np.float32)
        dark_hair = np.array([0.14, 0.13, 0.13], dtype=np.float32)

        rgb = rgb * (1.0 - stubble_base[:, :, None] * 0.50) + ash_tone[None, None, :] * (stubble_base[:, :, None] * 0.50)
        rgb = rgb * (1.0 - salt_mask[:, :, None] * 0.50) + silver_hair[None, None, :] * (salt_mask[:, :, None] * 0.50)
        rgb = rgb * (1.0 - pepper_mask[:, :, None] * 0.48) + dark_hair[None, None, :] * (pepper_mask[:, :, None] * 0.48)
        bump += (salt_mask - pepper_mask * 0.5) * 0.50
        orm[:, :, 1] = np.clip(orm[:, :, 1] + jaw_zone * 0.22, 0.34, 0.94)
    else:
        # Realistic Mediterranean 2-day dark stubble shadow along jaw, chin & upper lip on Crew
        jaw_zone = (
            _gauss_2d(u, v, 0.5, 0.260, 0.160, 0.080)
            + _gauss_2d(au, v, 0.130, 0.345, 0.048, 0.072) * 0.65
            + _gauss_2d(u, v, 0.5, 0.400, 0.056, 0.022) * 0.85
        )
        jaw_zone = np.clip(jaw_zone - lip_mask * 1.4, 0.0, 1.0) * np.clip((v - 0.19) / 0.04, 0.0, 1.0)
        stubble_speck = jaw_zone * (0.34 + 0.52 * (n_hi < 0.42).astype(np.float32))
        rgb *= (1.0 - stubble_speck[:, :, None] * 0.30)
        bump += stubble_speck * 0.22
        orm[:, :, 1] = np.clip(orm[:, :, 1] + jaw_zone * 0.10, 0.34, 0.90)

    # T-zone realistic skin specular variation
    tzone = _gauss_2d(u, v, 0.5, 0.52, 0.028, 0.088) + _gauss_2d(u, v, 0.5, 0.74, 0.09, 0.04) * 0.5
    orm[:, :, 1] = np.clip(orm[:, :, 1] - tzone * 0.10, 0.36, 0.92)

    # Fold bump height field into tangent-space normal map cleanly
    pad = np.pad(bump, 1, mode="edge")
    gx = (pad[1:-1, 2:] - pad[1:-1, :-2]) * 2.4
    gy = (pad[2:, 1:-1] - pad[:-2, 1:-1]) * 2.4
    nx = (nrm[:, :, 0] * 2.0 - 1.0) - gx
    ny = (nrm[:, :, 1] * 2.0 - 1.0) - gy
    nz = np.maximum(nrm[:, :, 2] * 2.0 - 1.0, 0.25)
    inv_l = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    nrm[:, :, 0] = nx * inv_l * 0.5 + 0.5
    nrm[:, :, 1] = ny * inv_l * 0.5 + 0.5
    nrm[:, :, 2] = nz * inv_l * 0.5 + 0.5

    alb[:, :, :3] = np.clip(rgb, 0.0, 1.0)
    return (
        _make_blender_image(f"{prefix}_Face_Albedo", alb, "sRGB"),
        _make_blender_image(f"{prefix}_Face_Normal", nrm, "Non-Color"),
        _make_blender_image(f"{prefix}_Face_ORM", orm, "Non-Color"),
    )


def create_eye_texture(name: str, iris_rgb: Tuple[float, float, float], size: int = 256) -> bpy.types.Image:
    """Photorealistic eyeball UV map with subtle top-lid ambient shadow so eyes never stare wildly."""
    ys = np.linspace(-1.0, 1.0, size, dtype=np.float32)[:, None]  # -1 bottom, +1 top
    xs = np.linspace(-1.0, 1.0, size, dtype=np.float32)[None, :]
    r = np.sqrt(xs * xs + ys * ys)
    ang = np.arctan2(ys, xs)

    rgba = np.ones((size, size, 4), dtype=np.float32)
    rgba[:, :, 0] = 0.84 - 0.16 * np.clip(r - 0.36, 0.0, 0.8)
    rgba[:, :, 1] = 0.81 - 0.19 * np.clip(r - 0.36, 0.0, 0.8)
    rgba[:, :, 2] = 0.78 - 0.20 * np.clip(r - 0.36, 0.0, 0.8)

    # Realistic human iris proportion (~35% front hemisphere with rich upper-eyelid shadow!)
    iris_r = 0.35
    pupil_r = 0.145
    fibers = (
        0.5
        + 0.26 * np.sin(ang * 31.0 + r * 14.0)
        + 0.16 * np.sin(ang * 57.0 - r * 22.0)
        + 0.10 * np.cos(ang * 13.0)
    )
    in_iris = np.clip((iris_r - r) / 0.022, 0.0, 1.0)
    limbal = np.exp(-0.5 * ((r - (iris_r - 0.018)) / 0.020) ** 2)
    inner_glow = np.exp(-0.5 * ((r - (pupil_r + 0.052)) / 0.042) ** 2)

    ir = np.zeros((size, size, 3), dtype=np.float32)
    ir[:, :, 0] = iris_rgb[0] * (0.62 + 0.52 * fibers) + inner_glow * 0.10
    ir[:, :, 1] = iris_rgb[1] * (0.62 + 0.52 * fibers) + inner_glow * 0.08
    ir[:, :, 2] = iris_rgb[2] * (0.60 + 0.52 * fibers) + inner_glow * 0.03
    ir *= (1.0 - limbal[:, :, None] * 0.70)

    rgba[:, :, :3] = rgba[:, :, :3] * (1.0 - in_iris[:, :, None]) + np.clip(ir, 0.0, 1.0) * in_iris[:, :, None]

    in_pupil = np.clip((pupil_r - r) / 0.014, 0.0, 1.0)
    rgba[:, :, :3] *= (1.0 - in_pupil[:, :, None] * 0.97)

    # Realistic upper-eyelid soft cast shadow across upper 35% of sclera & iris!
    lid_shadow = np.clip((ys - 0.02) / 0.22, 0.0, 1.0) * 0.55
    rgba[:, :, :3] *= (1.0 - lid_shadow[:, :, None])
    return _make_blender_image(name, rgba, "sRGB")


def _ensure_gltf_ao_group() -> bpy.types.NodeTree:
    name = "glTF Material Output"
    if name in bpy.data.node_groups:
        return bpy.data.node_groups[name]
    ng = bpy.data.node_groups.new(name, "ShaderNodeTree")
    ng.interface.new_socket("Occlusion", in_out="INPUT", socket_type="NodeSocketFloat")
    return ng


def make_pbr_material_from_images(
    name: str,
    albedo_img: Optional[bpy.types.Image] = None,
    normal_img: Optional[bpy.types.Image] = None,
    orm_img: Optional[bpy.types.Image] = None,
    base_color_hex: str = "#808080",
    roughness: float = 0.6,
    metallic: float = 0.0,
    normal_strength: float = 0.85,
    coat: float = 0.0,
    coat_roughness: float = 0.12,
    emission_hex: Optional[str] = None,
    emission_strength: float = 0.0,
    tint_factor_hex: Optional[str] = None,
    double_sided: bool = False,
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

    if albedo_img is not None:
        tex_a = nt.nodes.new("ShaderNodeTexImage")
        tex_a.image = albedo_img
        if tint_factor_hex is not None:
            # Clean MULTIPLY node exports directly as glTF baseColorFactor * baseColorTexture!
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs["Factor"].default_value = 1.0
            mix.inputs["B"].default_value = hex_rgba(tint_factor_hex, 1.0)
            nt.links.new(tex_a.outputs["Color"], mix.inputs["A"])
            nt.links.new(mix.outputs["Result"], bsdf.inputs["Base Color"])
        else:
            nt.links.new(tex_a.outputs["Color"], bsdf.inputs["Base Color"])
    else:
        bsdf.inputs["Base Color"].default_value = hex_rgba(base_color_hex, 1.0)

    if orm_img is not None:
        tex_orm = nt.nodes.new("ShaderNodeTexImage")
        tex_orm.image = orm_img
        sep = nt.nodes.new("ShaderNodeSeparateColor")
        nt.links.new(tex_orm.outputs["Color"], sep.inputs["Color"])
        nt.links.new(sep.outputs["Green"], bsdf.inputs["Roughness"])
        if metallic > 0.01:
            bsdf.inputs["Metallic"].default_value = float(metallic)
        else:
            nt.links.new(sep.outputs["Blue"], bsdf.inputs["Metallic"])
        ao_grp = nt.nodes.new("ShaderNodeGroup")
        ao_grp.node_tree = _ensure_gltf_ao_group()
        nt.links.new(sep.outputs["Red"], ao_grp.inputs["Occlusion"])
    else:
        bsdf.inputs["Roughness"].default_value = float(roughness)
        bsdf.inputs["Metallic"].default_value = float(metallic)

    if normal_img is not None and normal_strength > 0.01:
        tex_n = nt.nodes.new("ShaderNodeTexImage")
        tex_n.image = normal_img
        nmap = nt.nodes.new("ShaderNodeNormalMap")
        nmap.inputs["Strength"].default_value = float(normal_strength)
        nt.links.new(tex_n.outputs["Color"], nmap.inputs["Color"])
        nt.links.new(nmap.outputs["Normal"], bsdf.inputs["Normal"])

    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = float(coat)
        bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)

    if emission_hex is not None and emission_strength > 0.0:
        bsdf.inputs["Emission Color"].default_value = hex_rgba(emission_hex, 1.0)
        bsdf.inputs["Emission Strength"].default_value = float(emission_strength)

    mat.use_backface_culling = not double_sided
    return mat


def load_pbr_material(
    name: str,
    tex_dir: Path,
    key: str,
    tint_hex: Optional[str] = None,
    tint_mix: float = 0.0,
    desat: float = 0.0,
    brightness: float = 1.0,
    rough_shift: float = 0.0,
    gltf_base_factor_hex: Optional[str] = None,
    fallback_hex: str = "#3a3f46",
    normal_strength: float = 0.85,
    roughness: float = 0.65,
    metallic: float = 0.0,
    coat: float = 0.0,
    coat_roughness: float = 0.14,
    double_sided: bool = False,
) -> bpy.types.Material:
    """Load real gpt-image-2 PBR set, baking clean color/roughness grading directly into packed
    images (zero extra shader nodes, zero glTF sampler warnings, 100% consistent look in EEVEE & Three.js!).
    """
    alb_arr = _load_image_rgba_np(tex_dir / f"{key}_albedo.png")
    nrm_arr = _load_image_rgba_np(tex_dir / f"{key}_normal.png")
    orm_arr = _load_image_rgba_np(tex_dir / f"{key}_orm.png")

    alb_img = None
    nrm_img = None
    orm_img = None

    if alb_arr is not None:
        if tint_hex is not None or desat > 0.001 or abs(brightness - 1.0) > 0.001:
            a = alb_arr.copy()
            rgb = a[:, :, :3]
            if desat > 0.001:
                lum = 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]
                rgb = rgb * (1.0 - desat) + lum[:, :, None] * desat
            if tint_hex is not None and tint_mix > 0.001:
                tr, tg, tb = hex_rgb_srgb(tint_hex)
                tcol = np.array([tr, tg, tb], dtype=np.float32)
                rgb = rgb * (1.0 - tint_mix) + tcol[None, None, :] * tint_mix
            rgb = np.clip(rgb * brightness, 0.0, 1.0)
            a[:, :, :3] = rgb
            alb_img = _make_blender_image(f"{name}_Alb", a, "sRGB")
        else:
            alb_img = _make_blender_image(f"{key}_Alb_Shared", alb_arr, "sRGB")

    if nrm_arr is not None:
        nrm_img = _make_blender_image(f"{key}_Nrm_Shared", nrm_arr, "Non-Color")

    if orm_arr is not None:
        if abs(rough_shift) > 0.001:
            o = orm_arr.copy()
            o[:, :, 1] = np.clip(o[:, :, 1] + rough_shift, 0.14, 0.98)
            orm_img = _make_blender_image(f"{name}_ORM", o, "Non-Color")
        else:
            orm_img = _make_blender_image(f"{key}_ORM_Shared", orm_arr, "Non-Color")

    return make_pbr_material_from_images(
        name=name,
        albedo_img=alb_img,
        normal_img=nrm_img,
        orm_img=orm_img,
        base_color_hex=fallback_hex,
        roughness=roughness,
        metallic=metallic,
        normal_strength=normal_strength,
        coat=coat,
        coat_roughness=coat_roughness,
        tint_factor_hex=gltf_base_factor_hex,
        double_sided=double_sided,
    )


# ---------------------------------------------------------------------------
# Sculpted Parametric BMesh Builder (Explicit UVs & Skin Domain Tags)
# ---------------------------------------------------------------------------

class SculptMesh:
    """High-craft anatomical BMesh builder supporting explicit UV layouts and
    per-vertex skin-domain tagging so multi-layer clothing skins with zero artifacts.
    """

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.uv_layer = self.bm.loops.layers.uv.verify()
        self.dom_layer = self.bm.verts.layers.int.new("skin_domain")
        self.materials: List[bpy.types.Material] = []
        self._mat_index: Dict[str, int] = {}
        self.domains: Dict[str, int] = {}
        self._domain_names: List[str] = []

    def mat_idx(self, mat: bpy.types.Material) -> int:
        if mat.name not in self._mat_index:
            self._mat_index[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self._mat_index[mat.name]

    def domain_id(self, domain: str) -> int:
        if domain not in self.domains:
            self.domains[domain] = len(self._domain_names)
            self._domain_names.append(domain)
        return self.domains[domain]

    def _new_vert(self, co: Sequence[float], dom_id: int) -> bmesh.types.BMVert:
        v = self.bm.verts.new((float(co[0]), float(co[1]), float(co[2])))
        v[self.dom_layer] = dom_id
        return v

    def add_grid(
        self,
        rings: Sequence[Sequence[Tuple[float, float, float]]],
        uv_rings: Sequence[Sequence[Tuple[float, float]]],
        mat: bpy.types.Material,
        domain: str,
        closed_u: bool = True,
        cap_start: bool = False,
        cap_end: bool = False,
        smooth: bool = True,
        flip: bool = False,
    ) -> List[bmesh.types.BMVert]:
        if len(rings) < 2:
            return []
        dom_id = self.domain_id(domain)
        m_idx = self.mat_idx(mat)
        n_r = len(rings)
        n_u = len(rings[0])
        v_rings = [[self._new_vert(pt, dom_id) for pt in ring] for ring in rings]

        u_count = n_u if closed_u else (n_u - 1)
        for ri in range(n_r - 1):
            r0, r1 = v_rings[ri], v_rings[ri + 1]
            uv0, uv1 = uv_rings[ri], uv_rings[ri + 1]
            for j in range(u_count):
                jn = (j + 1) % n_u
                u0a, v0a = uv0[j]
                u0b, v0b = uv0[jn]
                u1a, v1a = uv1[j]
                u1b, v1b = uv1[jn]
                if closed_u and j == n_u - 1:
                    if u0b < u0a:
                        u0b += 1.0
                    if u1b < u1a:
                        u1b += 1.0
                if not flip:
                    quad = (r0[j], r0[jn], r1[jn], r1[j])
                    q_uv = ((u0a, v0a), (u0b, v0b), (u1b, v1b), (u1a, v1a))
                else:
                    quad = (r0[j], r1[j], r1[jn], r0[jn])
                    q_uv = ((u0a, v0a), (u1a, v1a), (u1b, v1b), (u0b, v0b))
                if len(set(quad)) == 4:
                    try:
                        f = self.bm.faces.new(quad)
                        f.material_index = m_idx
                        f.smooth = smooth
                        for lp, uv in zip(f.loops, q_uv):
                            lp[self.uv_layer].uv = uv
                    except ValueError:
                        pass

        if cap_start and closed_u and n_u >= 3:
            c_co = sum((v.co for v in v_rings[0]), Vector((0, 0, 0))) / n_u
            cv = self._new_vert(c_co, dom_id)
            c_uv = (0.5, uv_rings[0][0][1])
            for j in range(n_u):
                jn = (j + 1) % n_u
                tri = (cv, v_rings[0][jn], v_rings[0][j]) if not flip else (cv, v_rings[0][j], v_rings[0][jn])
                try:
                    f = self.bm.faces.new(tri)
                    f.material_index = m_idx
                    f.smooth = smooth
                    f.loops[0][self.uv_layer].uv = c_uv
                    f.loops[1][self.uv_layer].uv = uv_rings[0][jn]
                    f.loops[2][self.uv_layer].uv = uv_rings[0][j]
                except ValueError:
                    pass

        if cap_end and closed_u and n_u >= 3:
            c_co = sum((v.co for v in v_rings[-1]), Vector((0, 0, 0))) / n_u
            cv = self._new_vert(c_co, dom_id)
            c_uv = (0.5, uv_rings[-1][0][1])
            for j in range(n_u):
                jn = (j + 1) % n_u
                tri = (cv, v_rings[-1][j], v_rings[-1][jn]) if not flip else (cv, v_rings[-1][jn], v_rings[-1][j])
                try:
                    f = self.bm.faces.new(tri)
                    f.material_index = m_idx
                    f.smooth = smooth
                    f.loops[0][self.uv_layer].uv = c_uv
                    f.loops[1][self.uv_layer].uv = uv_rings[-1][j]
                    f.loops[2][self.uv_layer].uv = uv_rings[-1][jn]
                except ValueError:
                    pass

        return [v for ring in v_rings for v in ring]

    def add_tube(
        self,
        points: Sequence[Sequence[float]],
        radii: Sequence[Tuple[float, float]] | Sequence[float] | Tuple[float, float] | float,
        mat: bpy.types.Material,
        domain: str,
        segments: int = 12,
        uv_scale: Tuple[float, float] = (1.0, 2.0),
        smooth: bool = True,
        cap_start: bool = True,
        cap_end: bool = True,
        up_hint: Tuple[float, float, float] = (0.0, -1.0, 0.0),
    ) -> None:
        pts = [Vector(p) for p in points]
        n = len(pts)
        if n < 2:
            return
        if isinstance(radii, (int, float)):
            r_list = [(float(radii), float(radii))] * n
        elif isinstance(radii, tuple) and len(radii) == 2 and isinstance(radii[0], (int, float)) and isinstance(radii[1], (int, float)):
            r_list = [(float(radii[0]), float(radii[1]))] * n
        elif isinstance(radii[0], (int, float)):
            r_list = [(float(r), float(r)) for r in radii]  # type: ignore[arg-type]
        else:
            r_list = [(float(r[0]), float(r[1])) for r in radii]  # type: ignore[index]

        rings = []
        uv_rings = []
        prev_n: Optional[Vector] = None
        cum_len = 0.0
        uh = Vector(up_hint).normalized()

        for i, p in enumerate(pts):
            if i > 0:
                cum_len += (pts[i] - pts[i - 1]).length
            if i == 0:
                tang = (pts[1] - pts[0]).normalized()
            elif i == n - 1:
                tang = (pts[-1] - pts[-2]).normalized()
            else:
                t1 = (pts[i] - pts[i - 1]).normalized()
                t2 = (pts[i + 1] - pts[i]).normalized()
                tang = t1 + t2
                tang = t2 if tang.length < 1e-5 else tang.normalized()

            if prev_n is None:
                ref = uh if abs(tang.dot(uh)) < 0.90 else Vector((1.0, 0.0, 0.0))
                nrm = tang.cross(ref).normalized()
            else:
                nrm = prev_n - tang * prev_n.dot(tang)
                if nrm.length < 1e-5:
                    ref = Vector((1.0, 0.0, 0.0)) if abs(tang.x) < 0.9 else Vector((0.0, 1.0, 0.0))
                    nrm = tang.cross(ref).normalized()
                else:
                    nrm.normalize()
            binrm = tang.cross(nrm).normalized()
            prev_n = nrm

            rx, ry = r_list[i]
            ring = []
            uv_r = []
            for s in range(segments):
                ang = (2.0 * math.pi * s) / segments
                pt = p + nrm * (math.cos(ang) * rx) + binrm * (math.sin(ang) * ry)
                ring.append((pt.x, pt.y, pt.z))
                uv_r.append(((s / segments) * uv_scale[0], cum_len * uv_scale[1]))
            rings.append(ring)
            uv_rings.append(uv_r)

        self.add_grid(rings, uv_rings, mat, domain, closed_u=True, cap_start=cap_start, cap_end=cap_end, smooth=smooth)

    def add_beveled_box(
        self,
        center: Sequence[float],
        size: Sequence[float],
        mat: bpy.types.Material,
        domain: str,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        bevel: float = 0.008,
        bevel_segments: int = 2,
        taper_top: Tuple[float, float] = (1.0, 1.0),
        taper_bottom: Tuple[float, float] = (1.0, 1.0),
        smooth: bool = True,
        uv_scale: float = 3.5,
    ) -> None:
        sx, sy, sz = float(size[0]), float(size[1]), float(size[2])
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        tbx, tby = taper_bottom
        ttx, tty = taper_top
        dom_id = self.domain_id(domain)
        m_idx = self.mat_idx(mat)

        # Capture existing geometry BEFORE box+bevel so 100% of newly generated faces receive exact material & domain!
        existing_v = set(self.bm.verts)
        existing_f = set(self.bm.faces)

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
        verts = [self._new_vert(c, dom_id) for c in coords]
        fdefs = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (2, 3, 7, 6), (1, 2, 6, 5), (3, 0, 4, 7)]
        faces = [self.bm.faces.new([verts[i] for i in fd]) for fd in fdefs]
        for f in faces:
            f.material_index = m_idx

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
                material=m_idx,
            )

        new_verts = [v for v in self.bm.verts if v not in existing_v]
        new_faces = [f for f in self.bm.faces if f not in existing_f]

        for v in new_verts:
            v[self.dom_layer] = dom_id

        mat4 = Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
        bmesh.ops.transform(self.bm, matrix=mat4, verts=new_verts)

        for f in new_faces:
            f.material_index = m_idx
            f.smooth = smooth
            f.normal_update()
            n = f.normal
            ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
            for lp in f.loops:
                co = lp.vert.co
                if az >= ax and az >= ay:
                    lp[self.uv_layer].uv = (co.x * uv_scale, co.y * uv_scale)
                elif ax >= ay and ax >= az:
                    lp[self.uv_layer].uv = (co.y * uv_scale, co.z * uv_scale)
                else:
                    lp[self.uv_layer].uv = (co.x * uv_scale, co.z * uv_scale)

    def add_cylinder(
        self,
        center: Sequence[float],
        r1: float,
        r2: float,
        depth: float,
        mat: bpy.types.Material,
        domain: str,
        segments: int = 12,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        uv_scale: float = 4.0,
    ) -> None:
        dom_id = self.domain_id(domain)
        m_idx = self.mat_idx(mat)
        mat4 = Matrix.Translation(Vector(center)) @ Euler(rot, "XYZ").to_matrix().to_4x4()
        existing_v = set(self.bm.verts)
        existing_f = set(self.bm.faces)
        bmesh.ops.create_cone(
            self.bm,
            cap_ends=True,
            cap_tris=True,
            segments=segments,
            radius1=float(r1),
            radius2=float(r2),
            depth=float(depth),
            matrix=mat4,
        )
        for v in self.bm.verts:
            if v not in existing_v:
                v[self.dom_layer] = dom_id
        for f in self.bm.faces:
            if f not in existing_f:
                f.material_index = m_idx
                f.smooth = smooth
                f.normal_update()
                for lp in f.loops:
                    co = lp.vert.co
                    lp[self.uv_layer].uv = (co.x * uv_scale + co.y * uv_scale, co.z * uv_scale)

    def add_thick_cloth_sheet(
        self,
        surf_grid: Sequence[Sequence[Tuple[float, float, float]]],
        thickness: float,
        mat: bpy.types.Material,
        domain: str,
        uv_scale: Tuple[float, float] = (3.0, 3.0),
        smooth: bool = True,
        mat_inner: Optional[bpy.types.Material] = None,
    ) -> None:
        nr = len(surf_grid)
        nc = len(surf_grid[0])
        if nr < 2 or nc < 2:
            return
        pts = [[Vector(p) for p in row] for row in surf_grid]
        norms = [[Vector((0, 0, 1)) for _ in range(nc)] for _ in range(nr)]
        for r in range(nr):
            for c in range(nc):
                du = pts[r][min(c + 1, nc - 1)] - pts[r][max(c - 1, 0)]
                dv = pts[min(r + 1, nr - 1)][c] - pts[max(r - 1, 0)][c]
                n = du.cross(dv)
                norms[r][c] = n.normalized() if n.length > 1e-6 else Vector((0, -1, 0))

        dom_id = self.domain_id(domain)
        m_out = self.mat_idx(mat)
        m_in = self.mat_idx(mat_inner if mat_inner is not None else mat)
        half_t = thickness * 0.5

        v_front = [[self._new_vert(pts[r][c] + norms[r][c] * half_t, dom_id) for c in range(nc)] for r in range(nr)]
        v_back = [[self._new_vert(pts[r][c] - norms[r][c] * half_t, dom_id) for c in range(nc)] for r in range(nr)]

        def make_quad(q, m_i, uvs):
            if len(set(q)) == 4:
                try:
                    f = self.bm.faces.new(q)
                    f.material_index = m_i
                    f.smooth = smooth
                    for lp, uv in zip(f.loops, uvs):
                        lp[self.uv_layer].uv = uv
                except ValueError:
                    pass

        for r in range(nr - 1):
            v0 = (r / (nr - 1)) * uv_scale[1]
            v1 = ((r + 1) / (nr - 1)) * uv_scale[1]
            for c in range(nc - 1):
                u0 = (c / (nc - 1)) * uv_scale[0]
                u1 = ((c + 1) / (nc - 1)) * uv_scale[0]
                uvs = ((u0, v0), (u1, v0), (u1, v1), (u0, v1))
                make_quad((v_front[r][c], v_front[r][c + 1], v_front[r + 1][c + 1], v_front[r + 1][c]), m_out, uvs)
                make_quad((v_back[r][c], v_back[r + 1][c], v_back[r + 1][c + 1], v_back[r][c + 1]), m_in, uvs)

        edge_uv = ((0, 0), (0.05, 0), (0.05, 0.1), (0, 0.1))
        for c in range(nc - 1):
            make_quad((v_front[0][c], v_back[0][c], v_back[0][c + 1], v_front[0][c + 1]), m_out, edge_uv)
            make_quad((v_front[-1][c], v_front[-1][c + 1], v_back[-1][c + 1], v_back[-1][c]), m_out, edge_uv)
        for r in range(nr - 1):
            make_quad((v_front[r][0], v_front[r + 1][0], v_back[r + 1][0], v_back[r][0]), m_out, edge_uv)
            make_quad((v_front[r][-1], v_back[r][-1], v_back[r + 1][-1], v_front[r + 1][-1]), m_out, edge_uv)

    def finalize(self, name: str) -> Tuple[bpy.types.Object, List[str]]:
        self.bm.normal_update()
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))
        self.bm.verts.ensure_lookup_table()
        vert_domains = [self._domain_names[v[self.dom_layer]] for v in self.bm.verts]

        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()

        for m in self.materials:
            mesh.materials.append(m)
        mesh.update()

        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)
        return obj, vert_domains


# ---------------------------------------------------------------------------
# Sculpted Realistic Human Head, Deep-Set Eyes with Hooded Eyelids, Ears & Hands
# ---------------------------------------------------------------------------

def add_sculpted_head(
    sm: SculptMesh,
    neck_base_z: float,
    head_height: float,
    mat_face: bpy.types.Material,
    mat_eye: bpy.types.Material,
    is_jupp: bool,
) -> Dict[str, float]:
    """Build a continuous, silky-smooth anatomically sculpted human head with seamless
    hooded almond eyelids sculpted directly into the skin mesh (ZERO pasted rectangular flaps!),
    deep-set glossy 3D eyeballs, and sculpted 3D anatomical ears.
    """
    n_u = 46
    n_v = 34

    sx = 0.075 if is_jupp else 0.073
    sy_front = 0.095 if is_jupp else 0.093
    sy_back = 0.104 if is_jupp else 0.102
    neck_fwd = -0.010 if is_jupp else -0.005

    # Exact eyeball placement deep inside bony orbits (draped cleanly under hooded upper eyelid!)
    eye_z = neck_base_z + 0.590 * head_height
    eye_y = -(sy_front * 0.805)
    eye_x = 0.0295
    eye_r = 0.0110

    rings: List[List[Tuple[float, float, float]]] = []
    uv_rings: List[List[Tuple[float, float]]] = []

    for iv in range(n_v):
        t = iv / (n_v - 1)
        z = neck_base_z + t * head_height

        if t < 0.20:
            nt = t / 0.20
            rx = lerp(0.059, 0.049, smoothstep(0.0, 0.55, nt))
            ry_f = lerp(0.059, 0.053, smoothstep(0.0, 0.60, nt))
            ry_b = lerp(0.061, 0.055, smoothstep(0.0, 0.70, nt))
            yc = lerp(0.005, neck_fwd, nt)
        elif t < 0.29:
            jt = (t - 0.20) / 0.09
            s = smoothstep(0.0, 1.0, jt)
            rx = lerp(0.049, sx * (0.80 if is_jupp else 0.76), s)
            ry_f = lerp(0.053, sy_front * 0.89, s)
            ry_b = lerp(0.055, sy_back * 0.72, s)
            yc = lerp(neck_fwd, -0.003, s)
        elif t < 0.78:
            ft = (t - 0.29) / 0.49
            base_jaw = 0.80 if is_jupp else 0.76
            rx = sx * (
                base_jaw
                + (1.0 - base_jaw) * smoothstep(0.0, 0.50, ft)
                + 0.032 * math.exp(-((t - 0.52) / 0.095) ** 2)
                - 0.032 * math.exp(-((t - 0.69) / 0.075) ** 2)
            )
            ry_f = sy_front * (0.89 + 0.11 * math.sin(ft * math.pi * 0.88))
            ry_b = sy_back * (0.72 + 0.28 * smoothstep(0.0, 0.72, ft))
            yc = -0.003 + 0.006 * ft
        else:
            # Smooth round adult cranial dome (no pointy cone!)
            ct = (t - 0.78) / 0.22
            dome = max(0.06, math.sqrt(max(0.0, 1.0 - (ct * 0.992) ** 2)))
            rx = sx * 0.98 * dome
            ry_f = sy_front * 0.96 * dome
            ry_b = sy_back * 1.00 * dome
            yc = 0.003 + 0.007 * ct

        ring = []
        uv_r = []
        for iu in range(n_u):
            u_norm = iu / n_u
            theta = (u_norm - 0.5) * 2.0 * math.pi
            st = math.sin(theta)
            ct = math.cos(theta)
            front_w = max(0.0, ct)

            x = rx * st
            y = yc - (ry_f * ct if ct >= 0 else ry_b * ct)
            au = abs(u_norm - 0.5)

            # 1. Neck tendons & Adam's apple
            if t < 0.26:
                scm = math.exp(-((au - 0.092) / 0.032) ** 2) * math.exp(-((t - 0.12) / 0.07) ** 2)
                y -= scm * 0.0045
                x += math.copysign(scm * 0.0035, st)
                adams = math.exp(-((au) / 0.024) ** 2) * math.exp(-((t - 0.15) / 0.026) ** 2)
                y -= adams * 0.0045

            # 2. Natural sculpted adult jawline & chin
            chin = math.exp(-((au) / 0.042) ** 2) * math.exp(-((t - 0.262) / 0.035) ** 2)
            y -= chin * (0.0145 if is_jupp else 0.0135)
            if 0.20 < t < 0.38 and front_w > 0.2:
                jaw_taper = math.exp(-((au - 0.068) / 0.044) ** 2) * math.exp(-((t - 0.265) / 0.048) ** 2)
                y += jaw_taper * 0.0068
                gonial = math.exp(-((au - 0.145) / 0.042) ** 2) * math.exp(-((t - 0.305) / 0.048) ** 2)
                x += math.copysign(gonial * (0.0042 if is_jupp else 0.0035), st)

            # 3. Sculpted Zygomatic Cheekbones & Smooth Buccal Hollows
            cheekbone = math.exp(-((au - 0.100) / 0.044) ** 2) * math.exp(-((t - 0.520) / 0.048) ** 2)
            y -= cheekbone * (0.0078 if is_jupp else 0.0065)
            x += math.copysign(cheekbone * (0.0042 if is_jupp else 0.0034), st)

            buccal = math.exp(-((au - 0.092) / 0.038) ** 2) * math.exp(-((t - 0.400) / 0.052) ** 2)
            y += buccal * (0.0065 if is_jupp else 0.0038)
            x -= math.copysign(buccal * (0.0038 if is_jupp else 0.0024), st)

            # 4. SEAMLESS CONTINUOUS HOODED ALMOND EYELIDS + DEEP ORBITAL SOCKET!
            # Orbital depression sets eyes naturally back under brow bone
            eye_socket = math.exp(-((au - 0.060) / 0.032) ** 2) * math.exp(-((t - 0.592) / 0.036) ** 2)
            y += eye_socket * 0.0155

            # Prominent overhanging supraorbital brow ridge casting realistic upper-eye shade
            brow_ridge = math.exp(-((au - 0.058) / 0.054) ** 2) * math.exp(-((t - 0.674) / 0.028) ** 2)
            y -= brow_ridge * (0.0135 if is_jupp else 0.0105)
            glabella_dip = math.exp(-((au) / 0.016) ** 2) * math.exp(-((t - 0.618) / 0.020) ** 2)
            y += glabella_dip * 0.0055

            # Sculpt the continuous skin directly OVER the upper 32% and UNDER the lower 18% of the eyeball,
            # while recessing deeply ONLY inside the narrow calm almond eye aperture!
            if 0.540 < t < 0.655 and 0.024 < au < 0.098 and ct > 0.4:
                eu = (au - 0.060) / 0.025
                in_x = max(0.0, 1.0 - eu * eu)
                # Calm focused almond aperture: upper lid drapes right over upper 25% of iris!
                t_up = 0.591 + 0.0095 * in_x
                t_lo = 0.583 - 0.0045 * in_x
                in_slit = in_x * smoothstep(t_lo - 0.005, t_lo + 0.003, t) * smoothstep(t_up + 0.005, t_up - 0.003, t)
                y += in_slit * 0.0215
                u_hood = in_x * math.exp(-((t - (t_up + 0.010)) / 0.0135) ** 2)
                l_rim = in_x * math.exp(-((t - (t_lo - 0.008)) / 0.0105) ** 2)
                y -= u_hood * 0.0175 + l_rim * 0.0115

            # 5. Sculpted Anatomical Nose (Stronger European Nasal Bridge, Tip & Alar Wings)
            if 0.43 < t < 0.65 and au < 0.058:
                bridge_t = smoothstep(0.645, 0.505, t) * smoothstep(0.445, 0.482, t)
                roman = 1.0 + (0.14 * math.exp(-((t - 0.555) / 0.028) ** 2) if is_jupp else 0.0)
                bridge_w = math.exp(-((au) / lerp(0.0135, 0.0175, smoothstep(0.62, 0.48, t))) ** 2)
                y -= bridge_t * bridge_w * (0.0265 if is_jupp else 0.0235) * roman

                tip = math.exp(-((au) / 0.017) ** 2) * math.exp(-((t - 0.484) / 0.021) ** 2)
                y -= tip * (0.0115 if is_jupp else 0.0100)
                z -= tip * (0.0030 if is_jupp else 0.0010)

                ala = math.exp(-((au - 0.023) / 0.011) ** 2) * math.exp(-((t - 0.472) / 0.014) ** 2)
                y -= ala * 0.0115
                x += math.copysign(ala * 0.0055, st)

                nostril = math.exp(-((au - 0.017) / 0.008) ** 2) * math.exp(-((t - 0.454) / 0.008) ** 2)
                y += nostril * 0.0075

            # 6. Sculpted Lips, Philtrum & Natural Mouth Parting Line
            if 0.29 < t < 0.45 and au < 0.095:
                muzzle = math.exp(-((au) / 0.068) ** 2) * math.exp(-((t - 0.365) / 0.055) ** 2)
                y -= muzzle * 0.0080

                phil = math.exp(-((au) / 0.008) ** 2) * math.exp(-((t - 0.418) / 0.020) ** 2)
                y += phil * 0.0028

                lip_env = max(0.0, 1.0 - (au / 0.054) ** 2)
                cupid = 0.0035 * math.cos(au * 95.0) if au < 0.024 else 0.0
                u_lip = lip_env * math.exp(-((t - (0.376 + cupid)) / 0.0115) ** 2)
                l_lip = lip_env * math.exp(-((t - 0.347) / 0.0135) ** 2)
                m_cleft = lip_env * math.exp(-((t - 0.362) / 0.0052) ** 2)
                y -= u_lip * 0.0105 + l_lip * 0.0100
                y += m_cleft * 0.0072

                sulcus = math.exp(-((au) / 0.042) ** 2) * math.exp(-((t - 0.314) / 0.014) ** 2)
                y += sulcus * 0.0058

                if is_jupp:
                    nl_u = 0.035 + clamp((0.48 - t) / 0.14, 0.0, 1.0) * 0.042
                    nl = math.exp(-((au - nl_u) / 0.009) ** 2) * smoothstep(0.32, 0.36, t) * smoothstep(0.49, 0.45, t)
                    y += nl * 0.0036

            # 7. Temple gentle curve
            temple = math.exp(-((au - 0.162) / 0.042) ** 2) * math.exp(-((t - 0.70) / 0.068) ** 2)
            x -= math.copysign(temple * 0.0045, st)

            ring.append((x, y, z))
            uv_r.append((u_norm, t))

        rings.append(ring)
        uv_rings.append(uv_r)

    head_verts = sm.add_grid(rings, uv_rings, mat_face, domain="head", closed_u=True, cap_start=False, cap_end=True, smooth=True)
    # Gentle smooth pass keeps anatomical skin contours silky & organic!
    bmesh.ops.smooth_vert(sm.bm, verts=head_verts, factor=0.25, use_axis_x=True, use_axis_y=True, use_axis_z=False)

    # -------- Deep-Set 3D Eyeballs Seated Cleanly Behind Seamless Sculpted Eyelid Apertures --------
    for sx_dir in (-1.0, 1.0):
        ec = Vector((sx_dir * eye_x, eye_y, eye_z))
        e_rings, e_uvs = [], []
        eu_n, ev_n = 14, 9
        for jv in range(ev_n):
            phi = -math.pi * 0.48 + (jv / (ev_n - 1)) * math.pi * 0.96
            ring, uv_r = [], []
            for ju in range(eu_n):
                ang = (ju / eu_n) * 2.0 * math.pi
                cp, sp = math.cos(phi), math.sin(phi)
                ring.append((ec.x + eye_r * cp * math.cos(ang), ec.y - eye_r * sp, ec.z + eye_r * cp * math.sin(ang)))
                ang_from_front = math.acos(clamp(sp, -1.0, 1.0)) / (math.pi * 0.52)
                uv_r.append((clamp(0.5 + 0.5 * ang_from_front * math.cos(ang), 0.02, 0.98), clamp(0.5 + 0.5 * ang_from_front * math.sin(ang), 0.02, 0.98)))
            e_rings.append(ring)
            e_uvs.append(uv_r)
        sm.add_grid(e_rings, e_uvs, mat_eye, domain="head", closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # -------- Sculpted 3D Anatomical Ears --------
    ear_z = neck_base_z + 0.530 * head_height
    ear_y = 0.008
    for sx_dir in (-1.0, 1.0):
        ear_rings, ear_uvs = [], []
        e_seg = 10
        rad_prof = [
            (0.002, 0.003, 0.000),
            (0.010, 0.017, 0.003),
            (0.016, 0.026, 0.0072),
            (0.018, 0.029, 0.0038),
            (0.005, 0.015, -0.004),
        ]
        for ri, (ry_e, rz_e, out_x) in enumerate(rad_prof):
            ring, uv_r = [], []
            for j in range(e_seg):
                a = (j / e_seg) * 2.0 * math.pi
                lobe_mod = 1.0 + 0.22 * math.sin(a) - 0.12 * math.cos(2 * a)
                ly = ear_y + math.cos(a) * ry_e * lobe_mod
                lz = ear_z + math.sin(a) * rz_e
                flare = (0.006 if math.cos(a) > 0 else 0.0) * (ri / 3.0)
                ring.append((sx_dir * (sx * 0.96 + out_x + flare), ly, lz))
                uv_r.append((0.25 if sx_dir < 0 else 0.75, 0.50 + 0.05 * math.sin(a)))
            ear_rings.append(ring)
            ear_uvs.append(uv_r)
        sm.add_grid(ear_rings, ear_uvs, mat_face, domain="head", closed_u=True, cap_start=True, cap_end=True, smooth=True, flip=(sx_dir < 0))

    return {
        "neck_z": neck_base_z,
        "chin_z": neck_base_z + 0.26 * head_height,
        "mouth_z": neck_base_z + 0.362 * head_height,
        "nose_z": neck_base_z + 0.484 * head_height,
        "eye_z": eye_z,
        "brow_z": neck_base_z + 0.674 * head_height,
        "crown_z": neck_base_z + head_height,
        "ear_z": ear_z,
        "sx": sx,
        "sy_front": sy_front,
        "sy_back": sy_back,
    }


def add_jupp_head_details(
    sm: SculptMesh,
    lm: Dict[str, float],
    mat_hair: bpy.types.Material,
    mat_cap: bpy.types.Material,
    mat_cap_dark: bpy.types.Material,
    mat_pencil_wood: bpy.types.Material,
    mat_brass: bpy.types.Material,
) -> None:
    """Sculpt Jupp Kowalke's refined 68yo likeness (matching portrait_jupp.webp):
    - Expressive weathered salt-and-pepper eyebrows hugging brow ridge
    - Organic sculpted moustache + trimmed short beard flush with face
    - Wavy silver-grey hair peeking out neatly at temples & nape
    - SLEEK LOW-PROFILE tailored charcoal herringbone wool flatcap (Schiebermütze!)
    - Yellow drafting pencil tucked behind right ear!
    """
    sy_f = lm["sy_front"]
    sx = lm["sx"]

    # 1. Expressive Bushy Salt-and-Pepper Eyebrows (flush against overhanging brow ridge!)
    for s in (-1.0, 1.0):
        pts = [
            (s * 0.011, -sy_f * 1.015, lm["brow_z"] - 0.002),
            (s * 0.027, -sy_f * 1.000, lm["brow_z"] + 0.003),
            (s * 0.044, -sy_f * 0.925, lm["brow_z"] + 0.003),
            (s * 0.056, -sy_f * 0.800, lm["brow_z"] - 0.003),
        ]
        rads = [(0.0040, 0.0046), (0.0048, 0.0054), (0.0044, 0.0046), (0.0022, 0.0026)]
        sm.add_tube(pts, rads, mat_hair, domain="head", segments=7, uv_scale=(1.5, 4.0))

    # 2. Organic Sculpted Salt-and-Pepper Moustache (seated snugly onto upper lip!)
    for s in (-1.0, 1.0):
        pts_m = [
            (s * 0.002, -sy_f * 0.985, lm["mouth_z"] + 0.010),
            (s * 0.015, -sy_f * 0.972, lm["mouth_z"] + 0.008),
            (s * 0.029, -sy_f * 0.915, lm["mouth_z"] + 0.003),
            (s * 0.041, -sy_f * 0.828, lm["mouth_z"] - 0.005),
            (s * 0.046, -sy_f * 0.770, lm["mouth_z"] - 0.011),
        ]
        rads_m = [(0.0048, 0.0064), (0.0058, 0.0074), (0.0055, 0.0066), (0.0042, 0.0048), (0.0024, 0.0026)]
        sm.add_tube(pts_m, rads_m, mat_hair, domain="head", segments=8, uv_scale=(1.0, 6.0))

    # 3. Neat Wavy Silver-Grey Hair Curls Emerging Beneath Flatcap (Temples, Above Ears, Nape)
    for s in (-1.0, 1.0):
        for dy_off, dz_off, thick in [(-0.022, 0.018, 0.009), (0.002, 0.014, 0.010), (0.026, 0.008, 0.011)]:
            pts_h = [
                (s * (sx * 0.93), dy_off, lm["eye_z"] + dz_off + 0.018),
                (s * (sx * 1.02), dy_off + 0.007, lm["eye_z"] + dz_off),
                (s * (sx * 1.00), dy_off + 0.015, lm["eye_z"] + dz_off - 0.024),
                (s * (sx * 0.91), dy_off + 0.018, lm["eye_z"] + dz_off - 0.044),
            ]
            rads_h = [(thick * 0.65, thick * 0.9), (thick * 0.95, thick), (thick * 0.8, thick * 0.85), (thick * 0.3, thick * 0.35)]
            sm.add_tube(pts_h, rads_h, mat_hair, domain="head", segments=6, uv_scale=(1.0, 5.0))
    for ix in range(-3, 4):
        ang = (ix / 3.0) * 1.15
        bx = math.sin(ang) * sx * 0.94
        by = math.cos(ang) * lm["sy_back"] * 0.94
        pts_n = [
            (bx * 0.95, by * 0.95, lm["eye_z"] + 0.016),
            (bx * 1.02, by * 1.03, lm["ear_z"] - 0.005),
            (bx * 0.99, by * 1.00, lm["ear_z"] - 0.034),
            (bx * 0.86, by * 0.84, lm["chin_z"] - 0.002),
        ]
        sm.add_tube(pts_n, [(0.012, 0.009), (0.014, 0.010), (0.012, 0.009), (0.005, 0.004)], mat_hair, domain="head", segments=6, uv_scale=(1.2, 5.0))

    # 4. SLEEK LOW-PROFILE Tailored Charcoal Herringbone Flatcap (Schiebermütze!)
    # Clears crown cleanly with ZERO scalp poke-through while keeping authentic low forward rake!
    cap_base_z = lm["brow_z"] + 0.015
    cap_top_z = lm["crown_z"] + 0.013  # clears skull crown cleanly by 13mm!
    cap_rings = []
    cap_uvs = []
    c_u = 26
    c_v = 9
    for iv in range(c_v):
        t = iv / (c_v - 1)
        if t < 0.30:
            st = t / 0.30
            rad_mul = lerp(1.03, 1.24, smoothstep(0.0, 1.0, st))
            fwd_overhang = lerp(0.014, 0.054, smoothstep(0.0, 1.0, st))
            z_c = lerp(cap_base_z, cap_base_z + 0.018, st)
        elif t < 0.74:
            st = (t - 0.30) / 0.44
            rad_mul = lerp(1.24, 0.88, smoothstep(0.0, 1.0, st))
            fwd_overhang = lerp(0.054, 0.020, smoothstep(0.0, 1.0, st))
            z_c = lerp(cap_base_z + 0.018, cap_top_z - 0.003, smoothstep(0.0, 1.0, st))
        else:
            st = (t - 0.74) / 0.26
            rad_mul = max(0.06, lerp(0.88, 0.06, smoothstep(0.0, 1.0, st)))
            fwd_overhang = lerp(0.020, 0.0, st)
            z_c = lerp(cap_top_z - 0.003, cap_top_z, st)

        ring = []
        uv_r = []
        for iu in range(c_u):
            u_n = iu / c_u
            th = (u_n - 0.5) * 2.0 * math.pi
            st_a, ct_a = math.sin(th), math.cos(th)
            panel = 1.0 + 0.015 * abs(math.sin(th * 4.0)) * math.sin(t * math.pi)
            back_drop = max(0.0, -ct_a) * 0.028 * (1.0 - t * 0.90)
            front_dip = max(0.0, ct_a) * 0.012 * (1.0 - t * 0.55)
            x_c = sx * 1.03 * rad_mul * panel * st_a
            y_c = -(sy_f * 1.03 * rad_mul * panel * ct_a if ct_a >= 0 else lm["sy_back"] * 1.03 * rad_mul * ct_a)
            if ct_a > 0:
                y_c -= fwd_overhang * (ct_a ** 1.3)
            ring.append((x_c, y_c, z_c - back_drop - front_dip))
            uv_r.append((u_n * 2.4, t * 1.3))
        cap_rings.append(ring)
        cap_uvs.append(uv_r)
    sm.add_grid(cap_rings, cap_uvs, mat_cap, domain="head", closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Top flatcap button
    sm.add_cylinder((0.0, 0.008, cap_top_z + 0.001), 0.007, 0.005, 0.004, mat_cap_dark, domain="head", segments=8)

    # Curved slim stitched peak brim tucked snugly inside overhanging flatcap front (zero forehead gap!)
    brim_grid = []
    for ir in range(5):
        rt = ir / 4.0
        row = []
        for ic in range(11):
            ct_i = (ic / 10.0) * 2.0 - 1.0
            ang = ct_i * 0.98
            proj = lerp(-0.014, 0.052, rt) * (math.cos(ct_i * 1.25) ** 0.78)
            bx = math.sin(ang) * (sx * 1.00 + max(0.0, proj) * 0.30)
            by = -math.cos(ang) * (sy_f * 0.98 + proj)
            bz = cap_base_z - 0.003 - 0.015 * rt - 0.007 * (ct_i ** 2)
            row.append((bx, by, bz))
        brim_grid.append(row)
    sm.add_thick_cloth_sheet(brim_grid, 0.005, mat_cap_dark, domain="head", uv_scale=(1.5, 1.0))

    # 5. Classic Yellow Drafting Pencil tucked cleanly behind right ear (-X)
    p_dir = Vector((0.06, -0.92, 0.38)).normalized()
    p_mid = Vector((-(sx * 1.04), 0.006, lm["ear_z"] + 0.024))
    p_rot = p_dir.to_track_quat("Z", "Y").to_euler()
    sm.add_cylinder(p_mid, 0.0032, 0.0032, 0.112, mat_pencil_wood, domain="head", segments=6, rot=p_rot, smooth=False)
    sm.add_cylinder(p_mid + p_dir * 0.062, 0.0032, 0.0006, 0.015, mat_cap_dark, domain="head", segments=6, rot=p_rot)
    sm.add_cylinder(p_mid - p_dir * 0.058, 0.0034, 0.0034, 0.009, mat_brass, domain="head", segments=8, rot=p_rot)


def add_crew_head_details(
    sm: SculptMesh,
    lm: Dict[str, float],
    mat_hair: bpy.types.Material,
    mat_dark_metal: bpy.types.Material,
    mat_led: bpy.types.Material,
) -> None:
    """Sculpt Crew Accomplice's refined 30yo realistic head features:
    - Natural sculpted dark eyebrows
    - Unified organic layered short textured dark hair (ZERO sausage tubes!)
    - Sleek tactical comm earpiece / headset on right ear with thin boom mic & subtle LED
    """
    sy_f = lm["sy_front"]
    sx = lm["sx"]

    # 1. Natural Dark Sculpted Eyebrows (flush against brow ridge)
    for s in (-1.0, 1.0):
        pts = [
            (s * 0.012, -sy_f * 1.002, lm["brow_z"] - 0.002),
            (s * 0.028, -sy_f * 0.985, lm["brow_z"] + 0.002),
            (s * 0.044, -sy_f * 0.915, lm["brow_z"] + 0.002),
            (s * 0.055, -sy_f * 0.800, lm["brow_z"] - 0.003),
        ]
        rads = [(0.0030, 0.0036), (0.0038, 0.0042), (0.0033, 0.0036), (0.0018, 0.0022)]
        sm.add_tube(pts, rads, mat_hair, domain="head", segments=6, uv_scale=(1.5, 4.0))

    # 2. Unified Sculpted Modern Short Textured Dark Hair (Natural Rounded Crown + Soft Tapered Hairline!)
    h_rings = []
    h_uvs = []
    hu_n = 32
    hv_n = 12
    head_h = lm["crown_z"] - lm["neck_z"]
    for iv in range(hv_n):
        t = iv / (hv_n - 1)
        ring = []
        uv_r = []
        for iu in range(hu_n):
            u_n = iu / hu_n
            th = (u_n - 0.5) * 2.0 * math.pi
            st, ct = math.sin(th), math.cos(th)

            # Higher natural adult forehead hairline with subtle side-swept asymmetry
            if ct > 0.30:
                fringe_dip = 0.016 * math.sin(th * 2.2 + 0.8) + 0.008 * math.cos(th * 4.5)
                base_h = 0.805 - 0.032 * (1.0 - ct) - fringe_dip * max(0.0, ct)
            elif ct > -0.25:
                base_h = 0.625 + 0.14 * smoothstep(-0.22, 0.32, ct)
            else:
                base_h = 0.300 + 0.16 * (1.0 + ct)

            head_t = lerp(base_h, 1.015, t)
            z_h = lm["neck_z"] + head_t * head_h

            # Round natural cranial dome (matches spherical skull — zero pointy cone!)
            dome_t = clamp((head_t - 0.76) / 0.262, 0.0, 0.992)
            dome = max(0.05, math.sqrt(max(0.0, 1.0 - dome_t * dome_t)))
            feather = smoothstep(0.0, 0.22, t)
            top_vol = smoothstep(0.28, 0.78, t) * (0.008 + 0.006 * max(0.0, ct))
            side_vol = 0.004 * feather * (1.0 - 0.3 * abs(st))
            wave = (0.0022 * math.sin(th * 11.0 + t * 5.0) + 0.0014 * math.cos(th * 19.0 - t * 3.0)) * feather * math.sin(t * math.pi)
            sweep = 0.0045 * max(0.0, math.sin(th + 0.55)) * smoothstep(0.35, 0.85, t)

            rx_h = sx * 0.995 * dome + side_vol + top_vol * 0.75 + wave
            ry_f_h = sy_f * 0.985 * dome + side_vol + top_vol + sweep + wave
            ry_b_h = lm["sy_back"] * 1.00 * dome + side_vol + top_vol * 0.65 + wave
            ring.append((rx_h * st, -(ry_f_h * ct if ct >= 0 else ry_b_h * ct) + 0.003, z_h))
            uv_r.append((u_n * 3.2, t * 2.4))
        h_rings.append(ring)
        h_uvs.append(uv_r)
    sm.add_grid(h_rings, h_uvs, mat_hair, domain="head", closed_u=True, cap_start=False, cap_end=True, smooth=True)

    # 3. Sleek Tactical Comm Earpiece / Headset on Right Ear (-X) + Boom Mic + Tintable LED
    ear_x = -(sx * 1.08)
    ear_z = lm["ear_z"]
    sm.add_beveled_box((ear_x, 0.008, ear_z + 0.002), (0.013, 0.024, 0.034), mat_dark_metal, domain="head", rot=(0.14, 0.0, 0.0), bevel=0.0035)
    hook_pts = [
        (ear_x + 0.004, 0.008, ear_z + 0.016),
        (ear_x + 0.006, 0.020, ear_z + 0.027),
        (ear_x + 0.006, 0.026, ear_z + 0.014),
        (ear_x + 0.005, 0.022, ear_z - 0.012),
    ]
    sm.add_tube(hook_pts, 0.0028, mat_dark_metal, domain="head", segments=6)
    sm.add_beveled_box((ear_x - 0.007, 0.004, ear_z + 0.005), (0.0035, 0.010, 0.005), mat_led, domain="head", bevel=0.001)
    boom_pts = [
        (ear_x - 0.002, -0.004, ear_z - 0.008),
        (ear_x - 0.004, -0.044, ear_z - 0.024),
        (-0.065, -0.080, lm["mouth_z"] - 0.002),
        (-0.045, -0.097, lm["mouth_z"] - 0.004),
    ]
    sm.add_tube(boom_pts, [(0.0024, 0.0024), (0.0019, 0.0019), (0.0019, 0.0019), (0.0042, 0.0042)], mat_dark_metal, domain="head", segments=6)
    wire_pts = [
        (ear_x + 0.008, 0.020, ear_z - 0.014),
        (-(sx * 0.88), 0.026, lm["neck_z"] + 0.072),
        (-(sx * 0.76), 0.022, lm["neck_z"] + 0.018),
        (-0.060, 0.008, lm["neck_z"] - 0.022),
    ]
    sm.add_tube(wire_pts, 0.0022, mat_dark_metal, domain="head", segments=6)


def add_sculpted_gloved_hand(
    sm: SculptMesh,
    wrist_pos: Vector,
    side: float,
    mat_glove: bpy.types.Material,
    mat_hardware: bpy.types.Material,
    domain: str,
    tactical_knuckles: bool = False,
) -> None:
    """Anatomically sculpted 5-finger gloved hand extending downward from wrist_pos."""
    down = Vector((side * 0.02, -0.08, -0.996)).normalized()
    fwd = Vector((0.0, -1.0, 0.0))
    out = Vector((side, 0.0, 0.0))
    palm_in = (-out * 0.88 + fwd * 0.47).normalized()
    thumb_dir = (fwd * 0.88 + out * 0.47).normalized()

    palm_specs = [
        (-0.016, 0.031, 0.023, 0.000),
        (0.005, 0.034, 0.020, 0.002),
        (0.030, 0.041, 0.018, 0.005),
        (0.058, 0.043, 0.015, 0.004),
        (0.084, 0.041, 0.012, 0.001),
    ]
    p_rings = []
    p_uvs = []
    p_seg = 12
    for ri, (d_z, hw, ht, ot) in enumerate(palm_specs):
        c = wrist_pos + down * d_z + thumb_dir * ot
        ring = []
        uv_r = []
        for s in range(p_seg):
            a = (s / p_seg) * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            thick_mod = 1.15 if (sa > 0 and ca > 0 and ri == 2) else 1.0
            pt = c + thumb_dir * (ca * hw) + palm_in * (sa * ht * thick_mod)
            ring.append((pt.x, pt.y, pt.z))
            uv_r.append((s / p_seg * 1.5, ri / 4.0 * 1.2))
        p_rings.append(ring)
        p_uvs.append(uv_r)
    sm.add_grid(p_rings, p_uvs, mat_glove, domain=domain, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    if tactical_knuckles:
        kn_c = wrist_pos + down * 0.072 - palm_in * 0.013
        sm.add_beveled_box(kn_c, (0.016, 0.072, 0.020), mat_hardware, domain=domain, rot=(0.0, 0.0, -side * 0.45), bevel=0.004)
    else:
        cuff_c = wrist_pos - down * 0.004 - palm_in * 0.020
        sm.add_beveled_box(cuff_c, (0.009, 0.020, 0.022), mat_hardware, domain=domain, bevel=0.002)

    for f_off, f_len, f_r in ((0.029, 0.072, 0.0088), (0.010, 0.079, 0.0092), (-0.010, 0.073, 0.0086), (-0.028, 0.058, 0.0074)):
        knuckle = wrist_pos + down * 0.080 + thumb_dir * f_off - palm_in * 0.002
        p0 = knuckle
        p1 = p0 + down * (f_len * 0.42) + palm_in * (f_len * 0.08)
        p2 = p1 + down * (f_len * 0.34) + palm_in * (f_len * 0.22)
        p3 = p2 + down * (f_len * 0.24) + palm_in * (f_len * 0.28)
        sm.add_tube([p0, p1, p2, p3], [f_r, f_r * 0.90, f_r * 0.78, f_r * 0.56], mat_glove, domain=domain, segments=6, uv_scale=(1.0, 3.0))

    t0 = wrist_pos + down * 0.022 + thumb_dir * 0.033 + palm_in * 0.006
    t1 = t0 + down * 0.030 + thumb_dir * 0.021 + palm_in * 0.012
    t2 = t1 + down * 0.026 + thumb_dir * 0.011 + palm_in * 0.018
    t3 = t2 + down * 0.017 + thumb_dir * 0.004 + palm_in * 0.017
    sm.add_tube([t0, t1, t2, t3], [0.012, 0.0102, 0.0088, 0.0064], mat_glove, domain=domain, segments=7, uv_scale=(1.0, 3.0))


def add_sculpted_boot(
    sm: SculptMesh,
    ankle_x: float,
    ankle_z: float,
    side: float,
    mat_upper: bpy.types.Material,
    mat_sole: bpy.types.Material,
    mat_metal: bpy.types.Material,
    domain: str,
    tactical_sneaker: bool = False,
) -> None:
    """Anatomically sculpted left/right boot strictly grounded at z = 0.0000!"""
    sole_h = 0.028 if tactical_sneaker else 0.026
    y_stations = [
        (0.072, sole_h + 0.004, ankle_z + 0.018, 0.032, 0.035),
        (0.038, sole_h, ankle_z + 0.015, 0.042, 0.044),
        (-0.010, sole_h + 0.003, 0.112, 0.038, 0.044),
        (-0.075, sole_h, 0.095, 0.047, 0.052),
        (-0.140, sole_h, 0.074, 0.051, 0.055),
        (-0.184, sole_h + 0.004, 0.058, 0.040, 0.042),
        (-0.208, sole_h + 0.010, 0.040, 0.018, 0.018),
    ]
    b_rings, b_uvs = [], []
    b_seg = 14
    for yi, (y_pos, zb, zt, wi, wo) in enumerate(y_stations):
        ring, uv_r = [], []
        z_mid = (zb + zt) * 0.5
        hz = (zt - zb) * 0.5
        for s in range(b_seg):
            a = (s / b_seg) * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            hx = wi if (ca * side) < 0 else wo
            ring.append((ankle_x + ca * hx * (0.94 if sa > 0.35 else 1.0), y_pos, z_mid + sa * hz * (1.0 if sa >= 0 else 0.96)))
            uv_r.append((s / b_seg * 2.0, yi / (len(y_stations) - 1) * 2.0))
        b_rings.append(ring)
        b_uvs.append(uv_r)
    sm.add_grid(b_rings, b_uvs, mat_upper, domain=domain, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    shaft_rings, shaft_uvs = [], []
    for sz_i, (z_s, rx_s, ry_s, y_s) in enumerate([
        (ankle_z - 0.025, 0.050, 0.058, 0.005),
        (ankle_z + 0.025, 0.051, 0.057, 0.008),
        (ankle_z + 0.068, 0.054, 0.058, 0.010),
    ]):
        ring, uv_r = [], []
        for s in range(14):
            a = (s / 14) * 2.0 * math.pi
            ring.append((ankle_x + math.cos(a) * rx_s, y_s + math.sin(a) * ry_s, z_s))
            uv_r.append((s / 14 * 2.0, sz_i * 0.6))
        shaft_rings.append(ring)
        shaft_uvs.append(uv_r)
    sm.add_grid(shaft_rings, shaft_uvs, mat_upper, domain=domain, closed_u=True, cap_start=False, cap_end=True, smooth=True)

    sole_stations = [
        (0.076, 0.0000, sole_h + 0.008, 0.036, 0.039),
        (0.030, 0.0000, sole_h + 0.006, 0.045, 0.048),
        (-0.020, 0.0060 if not tactical_sneaker else 0.0020, sole_h + 0.004, 0.041, 0.047),
        (-0.085, 0.0000, sole_h + 0.005, 0.050, 0.055),
        (-0.150, 0.0000, sole_h + 0.006, 0.054, 0.058),
        (-0.194, 0.0025, sole_h + 0.008, 0.042, 0.044),
        (-0.214, 0.0080, sole_h + 0.012, 0.020, 0.020),
    ]
    s_rings, s_uvs = [], []
    for yi, (y_pos, zb, zt, wi, wo) in enumerate(sole_stations):
        ring, uv_r = [], []
        for s in range(12):
            a = (s / 12) * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            hx = wi if (ca * side) < 0 else wo
            z_pt = zb if sa < -0.15 else lerp((zb + zt) * 0.5, zt, max(0.0, sa))
            ring.append((ankle_x + ca * hx, y_pos, z_pt))
            uv_r.append((s / 12 * 2.0, yi * 0.4))
        s_rings.append(ring)
        s_uvs.append(uv_r)
    sm.add_grid(s_rings, s_uvs, mat_sole, domain=domain, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    for li in range(4):
        ly = -0.042 - li * 0.022
        lz = 0.118 - li * 0.010
        sm.add_tube([(ankle_x - 0.025, ly, lz), (ankle_x, ly - 0.004, lz + 0.004), (ankle_x + 0.025, ly, lz)], 0.0028, mat_sole, domain=domain, segments=5)
        if li < 2:
            for es in (-1.0, 1.0):
                sm.add_cylinder((ankle_x + es * 0.027, ly, lz), 0.0025, 0.0025, 0.003, mat_metal, domain=domain, segments=6)


def add_trouser_pelvis_bridge(
    sm: SculptMesh,
    hip_z: float,
    mat_pants: bpy.types.Material,
    width_x: float = 0.184,
    depth_y: float = 0.126,
) -> None:
    """Continuous tailored pelvis/seat trouser bridge joining left & right legs seamlessly at hips."""
    stations = [
        (hip_z - 0.115, width_x * 0.72, depth_y * 0.80, 0.012),
        (hip_z - 0.055, width_x * 0.96, depth_y * 0.96, 0.010),
        (hip_z + 0.010, width_x * 1.00, depth_y * 1.00, 0.006),
        (hip_z + 0.085, width_x * 0.93, depth_y * 0.94, 0.002),
    ]
    rings, uvs = [], []
    n_u = 20
    for z, rx, ry, yc in stations:
        ring, uv_r = [], []
        for iu in range(n_u):
            u_n = iu / n_u
            a = u_n * 2.0 * math.pi
            ring.append((math.cos(a) * rx, yc + math.sin(a) * ry, z))
            uv_r.append((u_n * 2.2, (z - (hip_z - 0.115)) * 2.2))
        rings.append(ring)
        uvs.append(uv_r)
    sm.add_grid(rings, uvs, mat_pants, domain="pelvis", closed_u=True, cap_start=True, cap_end=True, smooth=True)


def add_sculpted_trouser_leg(
    sm: SculptMesh,
    hip_x: float,
    hip_z: float,
    knee_z: float,
    ankle_z: float,
    side: float,
    mat_pants: bpy.types.Material,
    mat_hardware: bpy.types.Material,
    domain: str,
    cargo_pockets: bool = False,
    tailored_crease: bool = False,
) -> None:
    """Anatomically sculpted tailored/tactical trouser leg with proper hip fullness & hem break."""
    stations = [
        (hip_z + 0.035, hip_x * 0.76, 0.008, 0.104, 0.116, 0.002),
        (hip_z - 0.035, hip_x * 0.94, 0.006, 0.100, 0.110, 0.003),
        (lerp(hip_z, knee_z, 0.25), hip_x * 0.99, 0.002, 0.092, 0.098, 0.004),
        (lerp(hip_z, knee_z, 0.55), hip_x * 1.00, -0.004, 0.082, 0.088, 0.004),
        (lerp(hip_z, knee_z, 0.85), hip_x * 1.00, -0.010, 0.075, 0.080, 0.006),
        (knee_z, hip_x * 1.00, -0.014, 0.072, 0.079, 0.007),
        (lerp(knee_z, ankle_z, 0.28), hip_x * 1.00, 0.004, 0.071, 0.080, 0.005),
        (lerp(knee_z, ankle_z, 0.62), hip_x * 1.00, 0.008, 0.066, 0.072, 0.005),
        (ankle_z + 0.052, hip_x * 1.00, 0.006, 0.064, 0.070, 0.007),
        (ankle_z + 0.015, hip_x * 1.00, 0.004, 0.063, 0.068, 0.004),
    ]
    n_u = 16
    rings, uv_rings = [], []
    for si, (z, cx, cy, rx, ry, famp) in enumerate(stations):
        ring, uv_r = [], []
        v_coord = (z - ankle_z) * 1.8
        for iu in range(n_u):
            u_n = iu / n_u
            a = u_n * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            crease = 0.0045 * math.exp(-((a - 1.5 * math.pi) / 0.22) ** 2) if tailored_crease else 0.0
            fold = famp * math.sin(a * 3.0 + si * 1.15)
            x_pt = cx + ca * (rx + fold)
            if side > 0 and x_pt < 0.004 and z < hip_z - 0.09:
                x_pt = 0.004 + (x_pt - 0.004) * 0.20
            elif side < 0 and x_pt > -0.004 and z < hip_z - 0.09:
                x_pt = -0.004 + (x_pt + 0.004) * 0.20
            y_pt = cy + sa * (ry + fold) - crease
            ring.append((x_pt, y_pt, z))
            uv_r.append((u_n * 1.6, v_coord))
        rings.append(ring)
        uv_rings.append(uv_r)
    sm.add_grid(rings, uv_rings, mat_pants, domain=domain, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    if cargo_pockets:
        pz = lerp(hip_z, knee_z, 0.44)
        px = hip_x * 1.00 + side * 0.084
        sm.add_beveled_box(
            (px, 0.002, pz),
            (0.026, 0.118, 0.150),
            mat_pants,
            domain=domain,
            rot=(0.04, -side * 0.06, 0.0),
            bevel=0.007,
            taper_bottom=(0.94, 0.96),
        )
        sm.add_beveled_box(
            (px + side * 0.007, 0.002, pz + 0.062),
            (0.016, 0.122, 0.038),
            mat_pants,
            domain=domain,
            rot=(0.04, -side * 0.10, 0.0),
            bevel=0.004,
        )
        for dy in (-0.030, 0.030):
            sm.add_cylinder(
                (px + side * 0.016, dy, pz + 0.055),
                0.004,
                0.004,
                0.003,
                mat_hardware,
                domain=domain,
                segments=8,
                rot=(0.0, math.pi * 0.5, 0.0),
            )
        sm.add_beveled_box(
            (hip_x * 1.00, -0.074, knee_z + 0.005),
            (0.090, 0.020, 0.100),
            mat_pants,
            domain=domain,
            rot=(0.08, 0.0, 0.0),
            bevel=0.007,
        )


def add_sculpted_sleeve(
    sm: SculptMesh,
    shoulder_pos: Vector,
    elbow_pos: Vector,
    wrist_pos: Vector,
    side: float,
    mat_sleeve: bpy.types.Material,
    mat_cuff: bpy.types.Material,
    mat_button: bpy.types.Material,
    domain: str,
    coat_sleeve: bool = False,
) -> None:
    """Continuous sculpted sleeve with true anatomically sloped curved deltoid dome
    emerging organically out of the shoulder seam (ZERO sticking-out shoulder horns or football pads!).
    """
    n_u = 14
    rings, uv_rings = [], []

    # True anatomical curved shoulder path: starts deep inside upper chest shoulder seam (sloping downward!)
    # and curves gracefully down into the upper arm -> elbow -> wrist!
    arm_pts = [
        shoulder_pos + Vector((-side * 0.048, 0.0, 0.004)),   # Inside torso trapezius seam (zero shoulder horn!)
        shoulder_pos + Vector((-side * 0.016, 0.0, -0.006)),  # Outer trapezius curve
        shoulder_pos + Vector((side * 0.006, 0.002, -0.030)), # Rounded deltoid crest
        shoulder_pos + Vector((side * 0.014, 0.006, -0.072)), # Mid deltoid
    ]
    n_arm = 10
    p_mid_delt = arm_pts[-1]
    for i in range(1, n_arm):
        t = i / (n_arm - 1)
        u = 1.0 - t
        p = p_mid_delt * (u * u) + elbow_pos * (2 * u * t) + wrist_pos * (t * t)
        arm_pts.append(p)

    # Smooth radii profile: dome closes cleanly inside torso -> natural rounded deltoid -> bicep -> tapered cuff!
    r_full = 0.069 if coat_sleeve else 0.061
    r_el = 0.060 if coat_sleeve else 0.052
    r_wr = 0.051 if coat_sleeve else 0.043

    prev_n: Optional[Vector] = None
    total_n = len(arm_pts)
    for i, p in enumerate(arm_pts):
        t = i / (total_n - 1)
        if i == 0:
            tang = (arm_pts[1] - arm_pts[0]).normalized()
        elif i == total_n - 1:
            tang = (arm_pts[-1] - arm_pts[-2]).normalized()
        else:
            tang = (arm_pts[i + 1] - arm_pts[i - 1]).normalized()

        if prev_n is None:
            ref = Vector((0.0, -1.0, 0.0)) if abs(tang.dot(Vector((0.0, -1.0, 0.0)))) < 0.9 else Vector((0.0, 0.0, 1.0))
            nrm = tang.cross(ref).normalized()
        else:
            nrm = (prev_n - tang * prev_n.dot(tang)).normalized()
        binrm = tang.cross(nrm).normalized()
        prev_n = nrm

        if i == 0:
            rx_r, ry_r = r_full * 0.42, r_full * 0.55
        elif i == 1:
            rx_r, ry_r = r_full * 0.80, r_full * 0.90
        elif i == 2:
            rx_r, ry_r = r_full * 0.98, r_full * 1.04
        elif i == 3:
            rx_r, ry_r = r_full * 1.00, r_full * 1.04
        else:
            st = (i - 3) / (total_n - 4)
            base_r = lerp(r_full, r_el, smoothstep(0.0, 0.48, st)) if st < 0.48 else lerp(r_el, r_wr, smoothstep(0.48, 1.0, st))
            rx_r, ry_r = base_r, base_r * 1.04

        ring, uv_r = [], []
        for iu in range(n_u):
            u_n = iu / n_u
            a = u_n * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            elbow_w = math.exp(-((t - 0.56) / 0.11) ** 2)
            fold = elbow_w * 0.0045 * math.sin(t * 40.0 + ca * 2.5)
            pt = p + nrm * (ca * (rx_r + fold)) + binrm * (sa * (ry_r + fold))
            ring.append((pt.x, pt.y, pt.z))
            uv_r.append((u_n * 1.6, t * 2.2))
        rings.append(ring)
        uv_rings.append(uv_r)

    sm.add_grid(rings, uv_rings, mat_sleeve, domain=domain, closed_u=True, cap_start=True, cap_end=True, smooth=True)

    cuff_dir = (arm_pts[-1] - arm_pts[-2]).normalized()
    cuff_rot = cuff_dir.to_track_quat("Z", "Y").to_euler()
    cuff_c = wrist_pos - cuff_dir * 0.020
    cuff_r = 0.054 if coat_sleeve else 0.044
    sm.add_cylinder(cuff_c, cuff_r, cuff_r * 1.03, 0.042, mat_cuff, domain=domain, segments=14, rot=cuff_rot)
    tab_pos = cuff_c + Vector((side * (cuff_r + 0.002), 0.0, 0.0))
    sm.add_beveled_box(tab_pos, (0.009, 0.034, 0.017), mat_cuff, domain=domain, bevel=0.003)
    if coat_sleeve:
        sm.add_cylinder(tab_pos + Vector((side * 0.005, -0.007, 0.0)), 0.006, 0.006, 0.005, mat_button, domain=domain, segments=8, rot=(0.0, math.pi * 0.5, 0.0))


# ---------------------------------------------------------------------------
# Jupp Kowalke Complete Sculpted Character (~1.76m)
# ---------------------------------------------------------------------------

def build_jupp_geometry(tex_dir: Path) -> Tuple[bpy.types.Object, List[str], bpy.types.Object, List[str], Dict[str, Vector]]:
    """Build Jupp Kowalke (68yo German master safecracker, 1.76m)."""
    f_alb, f_nrm, f_orm = compose_face_texture_set(tex_dir, "skin_weathered_jupp", "Jupp", is_jupp=True, size=512)
    mat_face = make_pbr_material_from_images("Jupp_FaceSkin", f_alb, f_nrm, f_orm, normal_strength=0.90, coat=0.05, coat_roughness=0.48)
    eye_img = create_eye_texture("Jupp_Eye_Tex", iris_rgb=(0.38, 0.30, 0.20))
    mat_eye = make_pbr_material_from_images("Jupp_Eye", albedo_img=eye_img, roughness=0.05, metallic=0.0, coat=1.0, coat_roughness=0.04)

    mat_hair = load_pbr_material("Jupp_SilverHair", tex_dir, "hair_silver_pepper", brightness=0.82, normal_strength=0.95, rough_shift=0.08)
    mat_coat = load_pbr_material("Jupp_OvercoatWool", tex_dir, "wool_herringbone", tint_hex="#2D3239", tint_mix=0.28, brightness=0.88, normal_strength=1.05, rough_shift=0.06)
    mat_coat_dark = load_pbr_material("Jupp_FlatcapTrim", tex_dir, "wool_herringbone", tint_hex="#1D2127", tint_mix=0.45, brightness=0.78, normal_strength=1.0, rough_shift=0.06)
    mat_sweater = load_pbr_material("Jupp_KnitSweater", tex_dir, "knit_sweater", brightness=0.85, normal_strength=1.15, rough_shift=0.06)
    mat_trousers = load_pbr_material("Jupp_WoolTrousers", tex_dir, "wool_herringbone", tint_hex="#1C2026", tint_mix=0.52, brightness=0.76, normal_strength=0.80, rough_shift=0.06)
    mat_gloves = load_pbr_material("Jupp_LeatherGloves", tex_dir, "leather_black_glove", brightness=0.85, normal_strength=0.85, coat=0.14, coat_roughness=0.38)
    mat_boots = load_pbr_material("Jupp_LeatherBoots", tex_dir, "leather_weathered", tint_hex="#261B14", tint_mix=0.45, brightness=0.82, normal_strength=0.90, coat=0.22, coat_roughness=0.32)
    mat_sole = make_pbr_material_from_images("Jupp_BootSole", base_color_hex="#161413", roughness=0.86, metallic=0.0)
    mat_bag = load_pbr_material("Jupp_DoctorBagLeather", tex_dir, "leather_weathered", brightness=0.92, normal_strength=1.05, coat=0.18, coat_roughness=0.36)
    mat_horn = make_pbr_material_from_images("Jupp_HornButton", base_color_hex="#221914", roughness=0.32, metallic=0.05, coat=0.35)
    mat_brass = make_pbr_material_from_images("Jupp_AgedBrass", base_color_hex="#B58E47", roughness=0.32, metallic=0.88)
    mat_pencil = make_pbr_material_from_images("Jupp_DraftingPencil", base_color_hex="#D6A135", roughness=0.45, metallic=0.0)

    # Anatomically natural shoulder pivots (inward inside deltoid curve, ZERO robot box shoulders!)
    joints = {
        "hips": Vector((0.0, 0.0, 0.94)),
        "spine": Vector((0.0, 0.0, 1.06)),
        "spine1": Vector((0.0, 0.0, 1.22)),
        "chest": Vector((0.0, 0.0, 1.37)),
        "neck": Vector((0.0, -0.005, 1.465)),
        "head": Vector((0.0, -0.008, 1.545)),
        "shoulder_l": Vector((0.095, 0.0, 1.405)),
        "upper_arm_l": Vector((0.188, 0.004, 1.392)),
        "lower_arm_l": Vector((0.214, 0.012, 1.120)),
        "hand_l": Vector((0.216, -0.024, 0.875)),
        "shoulder_r": Vector((-0.095, 0.0, 1.405)),
        "upper_arm_r": Vector((-0.188, 0.004, 1.392)),
        "lower_arm_r": Vector((-0.214, 0.012, 1.120)),
        "hand_r": Vector((-0.216, -0.024, 0.875)),
        "upper_leg_l": Vector((0.098, 0.0, 0.925)),
        "lower_leg_l": Vector((0.100, -0.012, 0.485)),
        "foot_l": Vector((0.100, 0.005, 0.092)),
        "toe_l": Vector((0.100, -0.150, 0.026)),
        "upper_leg_r": Vector((-0.098, 0.0, 0.925)),
        "lower_leg_r": Vector((-0.100, -0.012, 0.485)),
        "foot_r": Vector((-0.100, 0.005, 0.092)),
        "toe_r": Vector((-0.100, -0.150, 0.026)),
        "toolbag": Vector((-0.228, 0.085, 0.855)),  # slightly behind right hip so hand hangs cleanly in front!
    }

    sm = SculptMesh()

    # 1. Sculpted Head + 68yo Likeness + Sleek Flatcap + Pencil
    lm = add_sculpted_head(sm, neck_base_z=1.455, head_height=0.292, mat_face=mat_face, mat_eye=mat_eye, is_jupp=True)
    add_jupp_head_details(sm, lm, mat_hair, mat_coat, mat_coat_dark, mat_pencil, mat_brass)

    # 2. Inner Ribbed Charcoal Knit Sweater
    sw_stations = [
        (1.18, 0.140, 0.116, -0.002),
        (1.30, 0.154, 0.122, -0.005),
        (1.40, 0.132, 0.102, -0.004),
        (1.46, 0.080, 0.076, -0.003),
        (1.502, 0.070, 0.068, -0.004),
    ]
    sw_rings, sw_uvs = [], []
    for z, rx, ry, yc in sw_stations:
        ring, uv_r = [], []
        for s in range(18):
            u_n = s / 18
            a = u_n * 2.0 * math.pi
            ring.append((math.cos(a) * rx, yc + math.sin(a) * ry, z))
            uv_r.append((u_n * 2.2, (z - 1.18) * 3.0))
        sw_rings.append(ring)
        sw_uvs.append(uv_r)
    sm.add_grid(sw_rings, sw_uvs, mat_sweater, domain="torso", closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # 3. Structured Herringbone Wool Overcoat with TRUE SLOPED TRAPEZIUS SHOULDERS & AMPLE STRIDE DRAPERY!
    coat_stations = [
        (0.615, 0.244, 0.184, 0.178, 0.004, 0.015),  # Mid-thigh hem drapery (ample front stride clearance!)
        (0.730, 0.228, 0.172, 0.168, 0.003, 0.012),
        (0.850, 0.212, 0.158, 0.156, 0.003, 0.009),
        (0.955, 0.198, 0.144, 0.144, 0.002, 0.006),
        (1.070, 0.186, 0.136, 0.134, 0.000, 0.005),  # Tailored waist
        (1.195, 0.198, 0.145, 0.136, -0.003, 0.004),
        (1.315, 0.208, 0.146, 0.138, -0.004, 0.003), # Full chest
        (1.385, 0.198, 0.132, 0.128, -0.003, 0.002), # Smooth deltoid taper!
        (1.430, 0.162, 0.112, 0.114, 0.000, 0.001),  # Natural 20-deg trapezius shoulder slope!
        (1.466, 0.104, 0.088, 0.094, 0.004, 0.001),  # Clean tailored neck seam!
    ]
    c_u = 32
    coat_rings, coat_uvs = [], []
    for si, (z, rx, ryf, ryb, yoff, damp) in enumerate(coat_stations):
        ring, uv_r = [], []
        v_coord = (z - 0.615) * 2.2
        for iu in range(c_u):
            u_n = iu / c_u
            th = (u_n - 0.5) * 2.0 * math.pi
            st, ct = math.sin(th), math.cos(th)
            drape = damp * (0.65 * math.sin(th * 5.0 + 0.5) + 0.35 * math.cos(th * 8.0))
            placket = 0.007 * smoothstep(0.0, 0.25, th) * smoothstep(0.55, 0.25, th) if z > 0.78 else 0.0
            v_open = smoothstep(1.25, 1.44, z) * max(0.0, ct - 0.55) / 0.45
            z_mod = z - v_open * 0.155
            back_vent = 0.010 * smoothstep(0.92, 0.65, z) * max(0.0, -ct - 0.85) / 0.15
            x_pt = (rx + drape) * st
            y_r = (ryf + drape + placket) if ct >= 0 else (ryb + drape - back_vent)
            y_pt = yoff - y_r * ct + (v_open * 0.020 if v_open > 0.05 else 0.0)
            ring.append((x_pt, y_pt, z_mod))
            uv_r.append((u_n * 2.8, v_coord))
        coat_rings.append(ring)
        coat_uvs.append(uv_r)
    sm.add_grid(coat_rings, coat_uvs, mat_coat, domain="coat_body", closed_u=True, cap_start=False, cap_end=False, smooth=True)

    hem_inner = [(x * 0.86, y * 0.86, z + 0.025) for (x, y, z) in coat_rings[0]]
    sm.add_grid([coat_rings[0], hem_inner], [coat_uvs[0], coat_uvs[0]], mat_coat_dark, domain="coat_body", closed_u=True, smooth=True)

    # 4. Graceful Tailored Upturned Storm Collar & Folded Wide Notched Lapels
    col_grid = []
    for ir in range(5):
        rt = ir / 4.0
        row = []
        for ic in range(15):
            ang = lerp(-2.20, 2.20, ic / 14.0)
            collar_h = lerp(0.052, 0.095, math.cos(ang * 0.58) ** 1.3)
            flare = 0.020 * rt * (0.65 + 0.50 * abs(math.sin(ang)))
            rx_c = 0.088 + flare + 0.016 * abs(math.sin(ang))
            ry_c = 0.086 + flare
            cx = math.sin(ang) * rx_c
            cy = 0.005 + math.cos(ang) * ry_c
            cz = 1.446 + rt * collar_h - 0.018 * (1.0 - math.cos(ang * 0.5)) * (1.0 - rt)
            row.append((cx, cy, cz))
        col_grid.append(row)
    sm.add_thick_cloth_sheet(col_grid, 0.010, mat_coat, domain="torso", uv_scale=(2.6, 0.8), mat_inner=mat_coat_dark)

    for s in (-1.0, 1.0):
        lap_grid = []
        for ir in range(6):
            rt = ir / 5.0
            row = []
            for ic in range(4):
                ct = ic / 3.0
                z_l = lerp(1.440, 1.180, rt)
                w_lap = 0.064 * math.sin(rt * math.pi * 0.85 + 0.25) + 0.016
                x_in = s * lerp(0.082, 0.020, rt)
                x_out = x_in + s * w_lap
                x_l = lerp(x_in, x_out, ct)
                y_base = -lerp(0.112, 0.152, math.sin(rt * math.pi * 0.72 + 0.15))
                y_l = y_base - 0.010 * math.sin(ct * math.pi) + 0.014 * (x_l ** 2) * 14.0
                row.append((x_l, y_l, z_l))
            lap_grid.append(row)
        sm.add_thick_cloth_sheet(lap_grid, 0.009, mat_coat, domain="torso", uv_scale=(1.2, 1.8))

    # Double-Breasted Horn Buttons + Properly Textured Hip Welt Pockets (seated cleanly at upper hip!)
    for bz in (1.165, 1.055, 0.945):
        for bx in (-0.050, 0.050):
            sm.add_cylinder((bx, -0.143 - (0.007 if bz > 1.1 else 0.0), bz), 0.0115, 0.0115, 0.006, mat_horn, domain="torso", segments=10, rot=(math.pi * 0.5, 0.0, 0.0))
    for s in (-1.0, 1.0):
        sm.add_beveled_box((s * 0.142, -0.104, 0.960), (0.108, 0.020, 0.038), mat_coat, domain="torso", rot=(0.06, s * 0.12, -s * 0.55), bevel=0.004)
        sm.add_cylinder((s * 0.078, 0.152, 1.045), 0.009, 0.009, 0.005, mat_horn, domain="torso", segments=8, rot=(math.pi * 0.5, 0.0, 0.0))
    sm.add_beveled_box((0.0, 0.142, 1.045), (0.198, 0.016, 0.040), mat_coat, domain="torso", bevel=0.004)

    # 5. Rounded-Shoulder Coat Sleeves & 5-Finger Leather Safecracking Gloves
    for s, dom_a in ((1.0, "arm_l"), (-1.0, "arm_r")):
        sh = joints["upper_arm_l" if s > 0 else "upper_arm_r"]
        el = joints["lower_arm_l" if s > 0 else "lower_arm_r"]
        wr = joints["hand_l" if s > 0 else "hand_r"]
        add_sculpted_sleeve(sm, sh, el, wr, s, mat_coat, mat_coat_dark, mat_horn, domain=dom_a, coat_sleeve=True)
        add_sculpted_gloved_hand(sm, wr, s, mat_gloves, mat_brass, domain=dom_a, tactical_knuckles=False)

    # 6. Tailored Wool Trousers (with Pelvis Bridge) & Scuffed Leather Boots (z = 0.0000!)
    add_trouser_pelvis_bridge(sm, joints["hips"].z, mat_trousers, width_x=0.180, depth_y=0.124)
    for s, dom_l in ((1.0, "leg_l"), (-1.0, "leg_r")):
        ul = joints["upper_leg_l" if s > 0 else "upper_leg_r"]
        ll = joints["lower_leg_l" if s > 0 else "lower_leg_r"]
        ft = joints["foot_l" if s > 0 else "foot_r"]
        add_sculpted_trouser_leg(sm, ul.x, ul.z, ll.z, ft.z, s, mat_trousers, mat_horn, domain=dom_l, cargo_pockets=False, tailored_crease=True)
        add_sculpted_boot(sm, ft.x, ft.z, s, mat_boots, mat_sole, mat_brass, domain=dom_l, tactical_sneaker=False)

    # 7. Diagonal Weathered Leather Shoulder Strap hugging coat cleanly to Doctor Tool Bag
    strap_front = [
        (0.134, -0.015, 1.430),
        (0.112, -0.142, 1.350),
        (0.032, -0.158, 1.215),
        (-0.072, -0.152, 1.075),
        (-0.175, -0.095, 0.960),
        (-0.222, -0.015, 0.915),
    ]
    strap_back = [
        (0.134, -0.015, 1.430),
        (0.118, 0.128, 1.355),
        (0.038, 0.148, 1.225),
        (-0.080, 0.148, 1.085),
        (-0.185, 0.130, 0.965),
        (-0.225, 0.125, 0.915),
    ]
    sm.add_tube(strap_front, (0.0065, 0.020), mat_bag, domain="torso", segments=8, uv_scale=(1.0, 4.0))
    sm.add_tube(strap_back, (0.0065, 0.020), mat_bag, domain="torso", segments=8, uv_scale=(1.0, 4.0))
    sm.add_beveled_box((0.038, -0.165, 1.225), (0.034, 0.013, 0.040), mat_brass, domain="torso", rot=(0.0, 0.60, 0.0), bevel=0.003)

    body_obj, body_domains = sm.finalize("Jupp_Body")

    # 8. Separate Weathered Leather Doctor-Style Safecracker Tool Bag (`ToolBag`)
    bm_bag = SculptMesh()
    bc = joints["toolbag"]
    bag_len_stations = [
        (-0.148, 0.036, -0.110, 0.034),
        (-0.118, 0.062, -0.130, 0.052),
        (-0.052, 0.074, -0.140, 0.058),
        (0.052, 0.074, -0.140, 0.058),
        (0.118, 0.062, -0.130, 0.052),
        (0.148, 0.036, -0.110, 0.034),
    ]
    bag_rings, bag_uvs = [], []
    b_seg = 16
    for bi, (dy, hwx, zb, zt) in enumerate(bag_len_stations):
        ring, uv_r = [], []
        for s in range(b_seg):
            a = (s / b_seg) * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            t_v = sa * 0.5 + 0.5
            pinch = lerp(0.88, 0.42, smoothstep(0.45, 1.0, t_v)) + 0.16 * math.sin(t_v * math.pi)
            ring.append((bc.x + ca * hwx * pinch, bc.y + dy, bc.z + lerp(zb, zt, t_v)))
            uv_r.append((s / b_seg * 2.0, bi / 5.0 * 1.6))
        bag_rings.append(ring)
        bag_uvs.append(uv_r)
    bm_bag.add_grid(bag_rings, bag_uvs, mat_bag, domain="toolbag", closed_u=True, cap_start=True, cap_end=True, smooth=True)

    bm_bag.add_beveled_box((bc.x, bc.y, bc.z + 0.060), (0.042, 0.270, 0.017), mat_brass, domain="toolbag", bevel=0.004)
    bm_bag.add_beveled_box((bc.x - 0.026, bc.y, bc.z + 0.054), (0.016, 0.040, 0.032), mat_brass, domain="toolbag", bevel=0.004)
    for dy_s in (-0.070, 0.070):
        bm_bag.add_beveled_box((bc.x - 0.062, bc.y + dy_s, bc.z - 0.034), (0.018, 0.022, 0.175), mat_bag, domain="toolbag", bevel=0.004)
        bm_bag.add_beveled_box((bc.x - 0.072, bc.y + dy_s, bc.z - 0.010), (0.011, 0.028, 0.024), mat_brass, domain="toolbag", bevel=0.003)
    h_pts = [
        (bc.x, bc.y - 0.064, bc.z + 0.066),
        (bc.x - 0.005, bc.y - 0.038, bc.z + 0.106),
        (bc.x - 0.007, bc.y, bc.z + 0.114),
        (bc.x - 0.005, bc.y + 0.038, bc.z + 0.106),
        (bc.x, bc.y + 0.064, bc.z + 0.066),
    ]
    bm_bag.add_tube(h_pts, 0.009, mat_bag, domain="toolbag", segments=8)
    for dy_r in (-0.126, 0.126):
        bm_bag.add_cylinder((bc.x, bc.y + dy_r, bc.z + 0.054), 0.013, 0.013, 0.008, mat_brass, domain="toolbag", segments=10, rot=(0.0, math.pi * 0.5, 0.0))

    bag_obj, bag_domains = bm_bag.finalize("ToolBag")
    return body_obj, body_domains, bag_obj, bag_domains, joints


# ---------------------------------------------------------------------------
# Crew Accomplice Complete Sculpted Character (~1.78m + Weighty Loot Duffel Backpack)
# ---------------------------------------------------------------------------

def build_crew_geometry(tex_dir: Path) -> Tuple[bpy.types.Object, List[str], bpy.types.Object, List[str], Dict[str, Vector]]:
    """Build Tactical Night-Heist Accomplice (Jule/Toni/Rico neutral-dark base, 1.78m)."""
    f_alb, f_nrm, f_orm = compose_face_texture_set(tex_dir, "skin_crew", "Crew", is_jupp=False, size=512)
    mat_face = make_pbr_material_from_images("Crew_FaceSkin", f_alb, f_nrm, f_orm, normal_strength=0.78, coat=0.05, coat_roughness=0.46)
    eye_img = create_eye_texture("Crew_Eye_Tex", iris_rgb=(0.28, 0.20, 0.14))
    mat_eye = make_pbr_material_from_images("Crew_Eye", albedo_img=eye_img, roughness=0.05, metallic=0.0, coat=1.0, coat_roughness=0.04)

    mat_hair = load_pbr_material("Crew_Hair", tex_dir, "hair_dark_brown", brightness=0.80, normal_strength=0.90, rough_shift=0.08)
    # Matte dark slate-charcoal technical ripstop windbreaker (authentic matte outdoor fabric, NOT shiny rubber!)
    mat_jacket = load_pbr_material("Crew_Windbreaker", tex_dir, "tech_windbreaker", tint_hex="#232830", tint_mix=0.30, brightness=0.86, normal_strength=0.95, rough_shift=0.16)
    mat_jacket_dark = load_pbr_material("Crew_JacketPanels", tex_dir, "tech_windbreaker", tint_hex="#181C22", tint_mix=0.42, brightness=0.76, normal_strength=0.88, rough_shift=0.16)
    # Subtle neutral-dark tintable accent trim (`baseColorFactor` cleanly tintable by @world!)
    mat_accent = load_pbr_material("Crew_HoodieTrim_Accent", tex_dir, "tech_windbreaker", desat=0.85, brightness=1.65, gltf_base_factor_hex="#4C5866", normal_strength=0.72, rough_shift=0.15)
    # Subtle headset status LED (tintable by @world!)
    mat_led = make_pbr_material_from_images("Crew_Headset_LED", base_color_hex="#68B8D0", emission_hex="#68B8D0", emission_strength=2.2, roughness=0.20)
    # Clean neutral dark charcoal-graphite tactical cargo pants (desaturated canvas so zero bright olive clash!)
    mat_pants = load_pbr_material("Crew_CargoPants", tex_dir, "cargo_canvas", tint_hex="#1E2228", tint_mix=0.52, desat=0.78, brightness=0.80, normal_strength=0.95, rough_shift=0.08)
    mat_gloves = load_pbr_material("Crew_TacticalGloves", tex_dir, "leather_black_glove", brightness=0.85, normal_strength=0.85, rough_shift=0.12)
    mat_boots = load_pbr_material("Crew_TacticalBoots", tex_dir, "leather_black_glove", tint_hex="#1B1E23", tint_mix=0.25, brightness=0.82, normal_strength=0.88, coat=0.10, coat_roughness=0.42)
    mat_sole = make_pbr_material_from_images("Crew_BootSole", base_color_hex="#191C20", roughness=0.86, metallic=0.0)
    # Heavy charcoal-slate ballistic-nylon / waxed canvas Loot Duffel Backpack!
    mat_pack = load_pbr_material("Crew_Backpack", tex_dir, "cargo_canvas", tint_hex="#26292E", tint_mix=0.44, desat=0.68, brightness=0.88, normal_strength=1.12, rough_shift=0.06)
    mat_webbing = load_pbr_material("Crew_PackStraps", tex_dir, "tech_windbreaker", tint_hex="#14171B", tint_mix=0.48, brightness=0.74, normal_strength=0.75, rough_shift=0.14)
    mat_metal = make_pbr_material_from_images("Crew_HardwareMetal", base_color_hex="#727C88", roughness=0.30, metallic=0.88)
    mat_polymer = make_pbr_material_from_images("Crew_MattePolymer", base_color_hex="#1A1D22", roughness=0.44, metallic=0.12)

    # Anatomically natural athletic proportions (1.78m)
    joints = {
        "hips": Vector((0.0, 0.0, 0.96)),
        "spine": Vector((0.0, 0.0, 1.08)),
        "spine1": Vector((0.0, 0.0, 1.24)),
        "chest": Vector((0.0, 0.0, 1.39)),
        "neck": Vector((0.0, -0.002, 1.485)),
        "head": Vector((0.0, -0.004, 1.565)),
        "shoulder_l": Vector((0.095, 0.0, 1.425)),
        "upper_arm_l": Vector((0.188, 0.002, 1.412)),
        "lower_arm_l": Vector((0.214, 0.010, 1.135)),
        "hand_l": Vector((0.216, -0.024, 0.885)),
        "shoulder_r": Vector((-0.095, 0.0, 1.425)),
        "upper_arm_r": Vector((-0.188, 0.002, 1.412)),
        "lower_arm_r": Vector((-0.214, 0.010, 1.135)),
        "hand_r": Vector((-0.216, -0.024, 0.885)),
        "upper_leg_l": Vector((0.096, 0.0, 0.945)),
        "lower_leg_l": Vector((0.098, -0.012, 0.495)),
        "foot_l": Vector((0.098, 0.005, 0.094)),
        "toe_l": Vector((0.098, -0.152, 0.026)),
        "upper_leg_r": Vector((-0.096, 0.0, 0.945)),
        "lower_leg_r": Vector((-0.098, -0.012, 0.495)),
        "foot_r": Vector((-0.098, 0.005, 0.094)),
        "toe_r": Vector((-0.098, -0.152, 0.026)),
        "backpack": Vector((0.0, 0.215, 1.22)),
    }

    sm = SculptMesh()

    # 1. Sculpted Head + Sleek Layered Short Dark Hair + Tactical Comm Headset
    lm = add_sculpted_head(sm, neck_base_z=1.478, head_height=0.292, mat_face=mat_face, mat_eye=mat_eye, is_jupp=False)
    add_crew_head_details(sm, lm, mat_hair, mat_polymer, mat_led)

    # 2. Fitted Matte Technical Windbreaker / Hooded Jacket (NATURAL SLOPED SHOULDERS + LAYERED HEM OVERLAP!)
    jk_stations = [
        (0.865, 0.178, 0.126, 0.130, 0.003, 0.003),  # Tucked elastic bottom hem edge (casts crisp jacket shadow over trousers!)
        (0.882, 0.208, 0.146, 0.150, 0.003, 0.010),  # Relaxed bloused technical windbreaker hem lip!
        (0.960, 0.200, 0.142, 0.144, 0.002, 0.007),  # Hip blouson drape
        (1.075, 0.184, 0.134, 0.132, 0.000, 0.005),  # Athletic waist
        (1.200, 0.198, 0.146, 0.136, -0.003, 0.004), # Ribcage
        (1.325, 0.208, 0.148, 0.138, -0.004, 0.003), # Broad chest
        (1.395, 0.190, 0.128, 0.124, -0.002, 0.002), # Smooth rounded shoulder curve!
        (1.445, 0.148, 0.104, 0.108, 0.000, 0.001),  # Natural 20-deg sloped trapezius!
        (1.482, 0.092, 0.082, 0.088, 0.002, 0.001),  # Collar base
        (1.532, 0.080, 0.078, 0.082, 0.002, 0.001),  # Crisp standing technical collar
    ]
    j_u = 30
    jk_rings, jk_uvs = [], []
    for si, (z, rx, ryf, ryb, yoff, famp) in enumerate(jk_stations):
        ring, uv_r = [], []
        v_coord = (z - 0.865) * 2.4
        for iu in range(j_u):
            u_n = iu / j_u
            th = (u_n - 0.5) * 2.0 * math.pi
            st, ct = math.sin(th), math.cos(th)
            fold = famp * math.sin(th * 6.0 + si * 0.95)
            zip_ridge = 0.005 * math.exp(-((th) / 0.12) ** 2) if 0 < si < 9 else 0.0
            collar_v = 0.018 * max(0.0, ct - 0.72) / 0.28 if si == 9 else 0.0
            x_pt = (rx + fold) * st
            y_r = (ryf + fold + zip_ridge) if ct >= 0 else (ryb + fold)
            y_pt = yoff - y_r * ct
            ring.append((x_pt, y_pt, z - collar_v))
            uv_r.append((u_n * 2.6, v_coord))
        jk_rings.append(ring)
        jk_uvs.append(uv_r)
    sm.add_grid(jk_rings, jk_uvs, mat_jacket, domain="torso", closed_u=True, cap_start=True, cap_end=False, smooth=True)

    # Subtle neutral-dark collar trim piping (tintable accent)
    piping_top = [
        (math.sin(a) * 0.080, 0.002 - math.cos(a) * 0.079, 1.530 - (0.016 if math.cos(a) > 0.75 else 0.0))
        for a in np.linspace(-math.pi * 0.88, math.pi * 0.88, 15)
    ]
    sm.add_tube(piping_top, 0.0055, mat_accent, domain="torso", segments=6)

    # Metallic Front Zipper + Welded Chest & Side Zip Pockets
    zip_pts = [(0.0, -0.140, 0.855), (0.0, -0.135, 1.060), (0.0, -0.151, 1.290), (0.0, -0.134, 1.425), (0.0, -0.088, 1.505)]
    sm.add_tube(zip_pts, (0.0045, 0.0035), mat_metal, domain="torso", segments=6)
    sm.add_beveled_box((0.0, -0.095, 1.498), (0.010, 0.012, 0.020), mat_accent, domain="torso", bevel=0.002)

    sm.add_beveled_box((0.092, -0.133, 1.305), (0.014, 0.012, 0.112), mat_jacket_dark, domain="torso", rot=(0.0, -0.10, 0.24), bevel=0.003)
    sm.add_beveled_box((0.095, -0.139, 1.345), (0.007, 0.007, 0.015), mat_metal, domain="torso", bevel=0.002)
    for s in (-1.0, 1.0):
        sm.add_beveled_box((s * 0.128, -0.106, 0.990), (0.018, 0.016, 0.128), mat_jacket_dark, domain="torso", rot=(0.14, s * 0.22, -s * 0.55), bevel=0.004)
        seam_pts = [(s * 0.086, -0.062, 1.472), (s * 0.140, -0.082, 1.430), (s * 0.184, -0.062, 1.375)]
        sm.add_tube(seam_pts, 0.0042, mat_accent, domain="torso", segments=6)

    # Sculpted Folded Technical Hood Draped Behind Collar & Upper Shoulders
    hood_grid = []
    for ir in range(6):
        rt = ir / 5.0
        row = []
        for ic in range(13):
            ct = (ic / 12.0) * 2.0 - 1.0
            ang = ct * 1.35
            rad_x = lerp(0.090, 0.138, smoothstep(0.0, 1.0, rt))
            rad_y = lerp(0.084, 0.155, math.sin(rt * math.pi * 0.72 + 0.15))
            hx = math.sin(ang) * rad_x
            hy = 0.018 + math.cos(ang) * rad_y
            hz = 1.500 - 0.082 * smoothstep(0.0, 1.0, rt) + 0.010 * math.sin(rt * math.pi) - 0.015 * (ct ** 2) + 0.004 * math.cos(ct * 9.0) * rt
            row.append((hx, hy, hz))
        hood_grid.append(row)
    sm.add_thick_cloth_sheet(hood_grid, 0.011, mat_jacket, domain="torso", uv_scale=(2.2, 1.4), mat_inner=mat_accent)

    # 3. Rounded-Shoulder Windbreaker Sleeves & 5-Finger Tactical Gloves
    for s, dom_a in ((1.0, "arm_l"), (-1.0, "arm_r")):
        sh = joints["upper_arm_l" if s > 0 else "upper_arm_r"]
        el = joints["lower_arm_l" if s > 0 else "lower_arm_r"]
        wr = joints["hand_l" if s > 0 else "hand_r"]
        add_sculpted_sleeve(sm, sh, el, wr, s, mat_jacket, mat_jacket_dark, mat_metal, domain=dom_a, coat_sleeve=False)
        add_sculpted_gloved_hand(sm, wr, s, mat_gloves, mat_polymer, domain=dom_a, tactical_knuckles=True)

    # 4. Dark Tactical Cargo Pants (Seamless Pelvis Bridge + 3D Gusseted Pockets) + Rugged Boots (z = 0.0000!)
    add_trouser_pelvis_bridge(sm, joints["hips"].z, mat_pants, width_x=0.184, depth_y=0.128)
    for s, dom_l in ((1.0, "leg_l"), (-1.0, "leg_r")):
        ul = joints["upper_leg_l" if s > 0 else "upper_leg_r"]
        ll = joints["lower_leg_l" if s > 0 else "lower_leg_r"]
        ft = joints["foot_l" if s > 0 else "foot_r"]
        add_sculpted_trouser_leg(sm, ul.x, ul.z, ll.z, ft.z, s, mat_pants, mat_metal, domain=dom_l, cargo_pockets=True, tailored_crease=False)
        add_sculpted_boot(sm, ft.x, ft.z, s, mat_boots, mat_sole, mat_metal, domain=dom_l, tactical_sneaker=True)

    body_obj, body_domains = sm.finalize("Crew_Body")

    # 5. Weighty Canvas / Ballistic-Nylon Loot Duffel Backpack (`Backpack` SkinnedMesh!)
    bp = SculptMesh()
    pack_z_stations = [
        (0.985, 0.122, 0.124, 0.300),
        (1.035, 0.158, 0.120, 0.346),  # Heavy loaded gravity bulge near base!
        (1.130, 0.162, 0.122, 0.352),
        (1.240, 0.156, 0.124, 0.336),
        (1.345, 0.144, 0.128, 0.308),
        (1.412, 0.120, 0.134, 0.264),
    ]
    pk_rings, pk_uvs = [], []
    pk_u = 22
    for pi, (z, hwx, yf, yr) in enumerate(pack_z_stations):
        ring, uv_r = [], []
        yc = (yf + yr) * 0.5
        hwy = (yr - yf) * 0.5
        for iu in range(pk_u):
            u_n = iu / pk_u
            a = u_n * 2.0 * math.pi
            ca, sa = math.cos(a), math.sin(a)
            sx_q = math.copysign(abs(ca) ** 0.72, ca)
            sy_q = math.copysign(abs(sa) ** 0.78, sa)
            ripple = 0.0028 * math.sin(a * 5.0 + pi * 1.1)
            ring.append((sx_q * (hwx + ripple), yc + sy_q * (hwy + ripple), z))
            uv_r.append((u_n * 2.4, (z - 0.985) * 2.6))
        pk_rings.append(ring)
        pk_uvs.append(uv_r)
    bp.add_grid(pk_rings, pk_uvs, mat_pack, domain="backpack_body", closed_u=True, cap_start=True, cap_end=True, smooth=True)

    # Flush Front Zippered Pouches + Tightly Wrapped Compression Straps (NO sticking-out wings!)
    bp.add_beveled_box((0.0, 0.346, 1.115), (0.236, 0.064, 0.160), mat_pack, domain="backpack_body", bevel=0.016, taper_top=(0.94, 0.88))
    bp.add_beveled_box((0.0, 0.326, 1.320), (0.212, 0.048, 0.084), mat_webbing, domain="backpack_body", rot=(0.24, 0.0, 0.0), bevel=0.010)
    bp.add_beveled_box((0.0, 0.378, 1.180), (0.205, 0.007, 0.009), mat_metal, domain="backpack_body", bevel=0.002)
    bp.add_beveled_box((0.0, 0.350, 1.340), (0.182, 0.007, 0.009), mat_metal, domain="backpack_body", bevel=0.002)

    # Curved wrap-around compression straps hugging the exact duffel profile cleanly!
    for cz, hwx_s, y_rear in ((1.080, 0.164, 0.382), (1.245, 0.158, 0.352)):
        c_pts = [
            (-hwx_s, 0.220, cz),
            (-hwx_s - 0.003, 0.310, cz),
            (-hwx_s * 0.72, y_rear, cz),
            (0.0, y_rear + 0.004, cz),
            (hwx_s * 0.72, y_rear, cz),
            (hwx_s + 0.003, 0.310, cz),
            (hwx_s, 0.220, cz),
        ]
        bp.add_tube(c_pts, (0.006, 0.013), mat_webbing, domain="backpack_body", segments=6)
        for sx_b in (-0.100, 0.100):
            bp.add_beveled_box((sx_b, y_rear + 0.004, cz), (0.028, 0.014, 0.030), mat_polymer, domain="backpack_body", bevel=0.003)

    # Side brushed-metal climbing carabiner clipped cleanly to side loop
    bp.add_tube(
        [(-0.164, 0.245, 1.262), (-0.180, 0.262, 1.242), (-0.178, 0.266, 1.196), (-0.162, 0.248, 1.192), (-0.164, 0.245, 1.262)],
        0.0042,
        mat_metal,
        domain="backpack_body",
        segments=6,
    )
    # Top reinforced haul handle
    bp.add_tube(
        [(-0.064, 0.200, 1.408), (-0.042, 0.206, 1.444), (0.0, 0.208, 1.450), (0.042, 0.206, 1.444), (0.064, 0.200, 1.408)],
        (0.007, 0.013),
        mat_webbing,
        domain="backpack_body",
        segments=7,
    )

    # Snug Contoured Padded Shoulder Straps hugging rounded jacket shoulders!
    for s in (-1.0, 1.0):
        sh_strap = [
            (s * 0.088, 0.142, 1.385),
            (s * 0.122, 0.048, 1.448),
            (s * 0.136, -0.095, 1.402),
            (s * 0.146, -0.148, 1.280),
            (s * 0.164, -0.120, 1.135),
            (s * 0.178, 0.015, 1.055),
            (s * 0.142, 0.155, 1.032),
        ]
        bp.add_tube(sh_strap, (0.0085, 0.024), mat_webbing, domain="backpack_straps", segments=8, uv_scale=(1.0, 4.0))
        bp.add_beveled_box((s * 0.138, -0.156, 1.275), (0.020, 0.013, 0.026), mat_polymer, domain="backpack_straps", bevel=0.003)
    bp.add_tube([(-0.136, -0.153, 1.275), (0.0, -0.160, 1.275), (0.136, -0.153, 1.275)], (0.005, 0.010), mat_webbing, domain="backpack_straps", segments=6)
    bp.add_beveled_box((0.0, -0.164, 1.275), (0.028, 0.014, 0.022), mat_polymer, domain="backpack_straps", bevel=0.003)

    pack_obj, pack_domains = bp.finalize("Backpack")
    return body_obj, body_domains, pack_obj, pack_domains, joints


# ---------------------------------------------------------------------------
# Humanoid Armature Rig & Analytical Zero-Artifact Skin Weight Solver
# ---------------------------------------------------------------------------

def build_armature(name: str, joints: Dict[str, Vector], extra_bone: Optional[Tuple[str, str, Vector, Vector]] = None) -> bpy.types.Object:
    arm_data = bpy.data.armatures.new(name)
    arm_obj = bpy.data.objects.new(name, arm_data)
    bpy.context.scene.collection.objects.link(arm_obj)
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")

    def add_bone(bname: str, head: Vector, tail: Vector, parent_name: Optional[str] = None, connect: bool = False):
        eb = arm_data.edit_bones.new(bname)
        eb.head = head
        eb.tail = tail
        if parent_name:
            eb.parent = arm_data.edit_bones[parent_name]
            eb.use_connect = connect
        return eb

    add_bone("Root", Vector((0, 0, 0)), Vector((0, 0, 0.16)))
    add_bone("Hips", joints["hips"], joints["spine"], "Root")
    add_bone("Spine", joints["spine"], joints["spine1"], "Hips", connect=True)
    add_bone("Spine1", joints["spine1"], joints["chest"], "Spine", connect=True)
    add_bone("Chest", joints["chest"], joints["neck"], "Spine1", connect=True)
    add_bone("Neck", joints["neck"], joints["head"], "Chest", connect=True)
    add_bone("Head", joints["head"], joints["head"] + Vector((0, 0, 0.21)), "Neck", connect=True)

    for suffix, key_s in (("L", "l"), ("R", "r")):
        s_vec = Vector((1 if suffix == "L" else -1, 0, 0))
        add_bone(f"Shoulder_{suffix}", joints[f"shoulder_{key_s}"], joints[f"upper_arm_{key_s}"], "Chest")
        add_bone(f"UpperArm_{suffix}", joints[f"upper_arm_{key_s}"], joints[f"lower_arm_{key_s}"], f"Shoulder_{suffix}", connect=True)
        add_bone(f"LowerArm_{suffix}", joints[f"lower_arm_{key_s}"], joints[f"hand_{key_s}"], f"UpperArm_{suffix}", connect=True)
        add_bone(f"Hand_{suffix}", joints[f"hand_{key_s}"], joints[f"hand_{key_s}"] + Vector((s_vec.x * 0.01, -0.02, -0.14)), f"LowerArm_{suffix}", connect=True)

        add_bone(f"UpperLeg_{suffix}", joints[f"upper_leg_{key_s}"], joints[f"lower_leg_{key_s}"], "Hips")
        add_bone(f"LowerLeg_{suffix}", joints[f"lower_leg_{key_s}"], joints[f"foot_{key_s}"], f"UpperLeg_{suffix}", connect=True)
        add_bone(f"Foot_{suffix}", joints[f"foot_{key_s}"], joints[f"toe_{key_s}"], f"LowerLeg_{suffix}", connect=True)
        add_bone(f"Toe_{suffix}", joints[f"toe_{key_s}"], joints[f"toe_{key_s}"] + Vector((0, -0.06, 0)), f"Foot_{suffix}", connect=True)

    if extra_bone is not None:
        bname, parent_name, bhead, btail = extra_bone
        add_bone(bname, bhead, btail, parent_name)

    for eb in arm_data.edit_bones:
        eb.roll = 0.0

    bpy.ops.object.mode_set(mode="OBJECT")
    return arm_obj


def bind_and_weight_mesh(
    mesh_obj: bpy.types.Object,
    vert_domains: List[str],
    arm_obj: bpy.types.Object,
    joints: Dict[str, Vector],
    extra_bone_name: Optional[str] = None,
) -> None:
    mesh_obj.parent = arm_obj
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj
    mod.use_vertex_groups = True

    vgroups = {b.name: mesh_obj.vertex_groups.new(name=b.name) for b in arm_obj.data.bones}

    z_hips = joints["hips"].z
    z_sp = joints["spine"].z
    z_sp1 = joints["spine1"].z
    z_ch = joints["chest"].z
    z_nk = joints["neck"].z
    z_hd = joints["head"].z

    def assign(vi: int, weights: Dict[str, float]) -> None:
        items = sorted(((k, w) for k, w in weights.items() if w > 1e-4 and k in vgroups), key=lambda kv: -kv[1])[:4]
        if not items:
            items = [("Hips", 1.0)]
        tot = sum(w for _, w in items)
        for k, w in items:
            vgroups[k].add([vi], w / tot, "REPLACE")

    for vi, v in enumerate(mesh_obj.data.vertices):
        dom = vert_domains[vi]
        p = v.co
        x, y, z = p.x, p.y, p.z

        if dom == "head":
            w_hd = smoothstep(z_nk + 0.015, z_hd + 0.015, z)
            w_ch = 1.0 - smoothstep(z_ch + 0.01, z_nk + 0.04, z)
            w_nk = max(0.0, 1.0 - w_hd - w_ch)
            assign(vi, {"Head": w_hd, "Neck": w_nk, "Chest": w_ch})

        elif dom == "pelvis":
            leg_w = smoothstep(z_hips - 0.02, z_hips - 0.11, z) * 0.45
            lb = smoothstep(-0.06, 0.06, x)
            assign(vi, {"Hips": 1.0 - leg_w, "UpperLeg_L": leg_w * lb, "UpperLeg_R": leg_w * (1.0 - lb)})

        elif dom == "torso":
            w_h = 1.0 - smoothstep(z_hips - 0.02, z_sp + 0.06, z)
            w_s = smoothstep(z_hips - 0.02, z_sp + 0.04, z) * (1.0 - smoothstep(z_sp + 0.04, z_sp1 + 0.06, z))
            w_s1 = smoothstep(z_sp + 0.02, z_sp1 + 0.04, z) * (1.0 - smoothstep(z_sp1 + 0.04, z_ch + 0.06, z))
            w_c = smoothstep(z_sp1 + 0.02, z_ch + 0.04, z) * (1.0 - smoothstep(z_ch + 0.08, z_nk + 0.07, z))
            w_n = smoothstep(z_ch + 0.08, z_nk + 0.06, z)
            w_sh = smoothstep(0.140, 0.195, abs(x)) * smoothstep(z_ch - 0.05, z_ch + 0.04, z) * 0.40
            weights = {"Hips": w_h, "Spine": w_s, "Spine1": w_s1, "Chest": w_c * (1.0 - w_sh), "Neck": w_n}
            if w_sh > 0.01:
                weights["Shoulder_L" if x >= 0 else "Shoulder_R"] = w_sh
            assign(vi, weights)

        elif dom == "coat_body":
            if z >= z_hips:
                w_h = 1.0 - smoothstep(z_hips, z_sp + 0.05, z)
                w_s = smoothstep(z_hips, z_sp + 0.04, z) * (1.0 - smoothstep(z_sp + 0.04, z_sp1 + 0.05, z))
                w_s1 = smoothstep(z_sp + 0.02, z_sp1 + 0.04, z) * (1.0 - smoothstep(z_sp1 + 0.04, z_ch + 0.05, z))
                w_c = smoothstep(z_sp1 + 0.02, z_ch + 0.04, z)
                assign(vi, {"Hips": w_h, "Spine": w_s, "Spine1": w_s1, "Chest": w_c})
            else:
                leg_influence = smoothstep(z_hips, z_hips - 0.18, z) * 0.90
                left_bias = smoothstep(-0.070, 0.070, x)
                assign(vi, {"Hips": 1.0 - leg_influence, "UpperLeg_L": leg_influence * left_bias, "UpperLeg_R": leg_influence * (1.0 - left_bias)})

        elif dom in ("arm_l", "arm_r"):
            sfx = "L" if dom == "arm_l" else "R"
            ks = "l" if sfx == "L" else "r"
            p_sh = joints[f"upper_arm_{ks}"]
            p_el = joints[f"lower_arm_{ks}"]
            p_wr = joints[f"hand_{ks}"]

            d_up = p_el - p_sh
            d_lo = p_wr - p_el
            t_el = (p - p_sh).dot(d_up) / max(d_up.length_squared, 1e-6)
            t_wr = (p - p_el).dot(d_lo) / max(d_lo.length_squared, 1e-6)

            if t_el < 0.24:
                # Smooth deltoid shoulder dome blend (Chest -> Shoulder -> UpperArm) prevents popping shoulder ball!
                w_ua = smoothstep(-0.08, 0.26, t_el)
                w_ch = (1.0 - smoothstep(-0.18, 0.04, t_el)) * 0.55
                w_sh = max(0.0, 1.0 - w_ua - w_ch)
                assign(vi, {"Chest": w_ch, f"Shoulder_{sfx}": w_sh, f"UpperArm_{sfx}": w_ua})
            elif t_wr < 0.0:
                w_la = smoothstep(0.76, 1.12, t_el)
                assign(vi, {f"UpperArm_{sfx}": 1.0 - w_la, f"LowerArm_{sfx}": w_la})
            elif t_wr < 0.85:
                w_ua = 1.0 - smoothstep(-0.14, 0.18, t_wr)
                w_ha = smoothstep(0.74, 1.04, t_wr)
                w_la = max(0.0, 1.0 - w_ua - w_ha)
                assign(vi, {f"UpperArm_{sfx}": w_ua, f"LowerArm_{sfx}": w_la, f"Hand_{sfx}": w_ha})
            else:
                w_ha = smoothstep(0.78, 1.00, t_wr)
                assign(vi, {f"LowerArm_{sfx}": 1.0 - w_ha, f"Hand_{sfx}": w_ha})

        elif dom in ("leg_l", "leg_r"):
            sfx = "L" if dom == "leg_l" else "R"
            ks = "l" if sfx == "L" else "r"
            z_hip = joints[f"upper_leg_{ks}"].z
            z_kn = joints[f"lower_leg_{ks}"].z
            z_an = joints[f"foot_{ks}"].z
            y_toe = joints[f"toe_{ks}"].y

            if z > z_hip - 0.04:
                w_h = smoothstep(z_hip - 0.05, z_hip + 0.055, z)
                assign(vi, {"Hips": w_h, f"UpperLeg_{sfx}": 1.0 - w_h})
            elif z > z_kn + 0.06:
                assign(vi, {f"UpperLeg_{sfx}": 1.0})
            elif z > z_kn - 0.06:
                w_lo = smoothstep(z_kn + 0.06, z_kn - 0.06, z)
                assign(vi, {f"UpperLeg_{sfx}": 1.0 - w_lo, f"LowerLeg_{sfx}": w_lo})
            elif z > z_an + 0.055:
                assign(vi, {f"LowerLeg_{sfx}": 1.0})
            elif z > z_an - 0.03:
                w_ft = smoothstep(z_an + 0.055, z_an - 0.025, z)
                assign(vi, {f"LowerLeg_{sfx}": 1.0 - w_ft, f"Foot_{sfx}": w_ft})
            else:
                w_toe = smoothstep(y_toe + 0.035, y_toe - 0.025, y)
                assign(vi, {f"Foot_{sfx}": 1.0 - w_toe, f"Toe_{sfx}": w_toe})

        elif dom == "toolbag":
            assign(vi, {extra_bone_name or "ToolBagBone": 1.0})

        elif dom == "backpack_body":
            assign(vi, {extra_bone_name or "BackpackBone": 1.0})

        elif dom == "backpack_straps":
            w_bp = smoothstep(0.08, 0.16, y)
            w_ch = (1.0 - w_bp) * smoothstep(z_sp1 - 0.04, z_ch - 0.04, z)
            w_s1 = max(0.0, 1.0 - w_bp - w_ch)
            assign(vi, {extra_bone_name or "BackpackBone": w_bp, "Chest": w_ch, "Spine1": w_s1})

        else:
            assign(vi, {"Hips": 1.0})


# ---------------------------------------------------------------------------
# 6 Expressive, Anatomically Exact Looping glTF Animations
# Verified exact local bone axes from Blender 5.2 matrix_local:
#   - Hips/Spine/Chest/Neck/Head (+Y = world +Z, +Z = world -Y):
#       +rot_x = pitch FORWARD (-Y); -rot_x = pitch BACKWARD / look UP
#       +rot_y = yaw LEFT; +loc_y = move UP (+Z)
#   - UpperArm/LowerArm/Hand/UpperLeg/LowerLeg (+Y = world -Z, +Z = world +Y):
#       -rot_x = swing FORWARD (-Y) / bend elbow FORWARD!
#       +rot_x = swing BACKWARD (+Y) / bend knee BACKWARD!
#       +rot_z = move limb LEFT (+X); -rot_z = move limb RIGHT (-X)!
#   - Foot (+Y = forward-down):
#       +rot_x = toe DOWN (plantarflex); -rot_x = toe UP (dorsiflex)
# ---------------------------------------------------------------------------

def _pose_bone(
    arm_obj: bpy.types.Object,
    bname: str,
    frame: int,
    rot_deg: Optional[Tuple[float, float, float]] = None,
    loc: Optional[Tuple[float, float, float]] = None,
) -> None:
    if bname not in arm_obj.pose.bones:
        return
    pb = arm_obj.pose.bones[bname]
    pb.rotation_mode = "XYZ"
    if rot_deg is not None:
        pb.rotation_euler = (math.radians(rot_deg[0]), math.radians(rot_deg[1]), math.radians(rot_deg[2]))
        pb.keyframe_insert("rotation_euler", frame=frame)
    if loc is not None:
        pb.location = Vector(loc)
        pb.keyframe_insert("location", frame=frame)


def _clear_pose(arm_obj: bpy.types.Object) -> None:
    for pb in arm_obj.pose.bones:
        pb.rotation_mode = "XYZ"
        pb.rotation_euler = (0.0, 0.0, 0.0)
        pb.location = Vector((0.0, 0.0, 0.0))
        pb.scale = Vector((1.0, 1.0, 1.0))


def _stance_hip_drop(hip_fwd_deg: float, knee_bend_deg: float, l_thigh: float = 0.44, l_shin: float = 0.40) -> float:
    """Compute exact vertical hip drop (negative meters) keeping the bent stance foot planted strictly at z=0!"""
    a1 = math.radians(hip_fwd_deg)
    a2 = math.radians(hip_fwd_deg - knee_bend_deg)
    h_rest = l_thigh + l_shin
    h_bent = l_thigh * math.cos(a1) + l_shin * math.cos(a2)
    return min(0.0, h_bent - h_rest)


def author_animations(arm_obj: bpy.types.Object, is_jupp: bool) -> List[str]:
    bpy.context.scene.render.fps = 30
    arm_obj.animation_data_create()

    clip_names = ["Idle", "Walk", "Sneak", "Work", "CarryLoot", "Panic"]
    extra_bone = "ToolBagBone" if is_jupp else "BackpackBone"

    def build_clip(clip_name: str, n_frames: int, sample_fn: Callable[[float, int], None]) -> None:
        _clear_pose(arm_obj)
        act = bpy.data.actions.new(name=clip_name)
        arm_obj.animation_data.action = act
        step = 2
        frames = list(range(1, n_frames + 1, step))
        if frames[-1] != n_frames + 1:
            frames.append(n_frames + 1)
        for fr in frames:
            phase = ((fr - 1) / n_frames) * 2.0 * math.pi
            sample_fn(phase, fr)

        tr = arm_obj.animation_data.nla_tracks.new()
        tr.name = clip_name
        st = tr.strips.new(clip_name, 1, act)
        st.name = clip_name
        st.action_frame_start = 1.0
        st.action_frame_end = float(n_frames + 1)
        st.frame_start = 1.0
        st.frame_end = float(n_frames + 1)

    # ------------------------------------------------------------------
    # 1. Idle (120 frames / 4.0s): Natural relaxed heist stance, breathing, observant glance
    # ------------------------------------------------------------------
    def anim_idle(p: float, fr: int) -> None:
        breath = math.sin(p * 2.0)
        sway = math.sin(p)
        glance = math.sin(p) * 14.0 + math.sin(p * 2.0 + 0.7) * 5.0
        tilt = math.cos(p) * 2.5

        drop = _stance_hip_drop(3.0, 5.0)
        _pose_bone(arm_obj, "Hips", fr, rot_deg=(1.0, sway * 1.4, -1.2 + sway * 0.8), loc=(sway * 0.008, drop, 0.0))
        _pose_bone(arm_obj, "Spine", fr, rot_deg=(1.5 + breath * 0.9, -sway * 0.8, 0.8))
        _pose_bone(arm_obj, "Spine1", fr, rot_deg=(1.0 + breath * 1.0, 0.0, 0.0))
        _pose_bone(arm_obj, "Chest", fr, rot_deg=(-0.8 + breath * 1.1, -sway * 0.6, 0.4))
        _pose_bone(arm_obj, "Neck", fr, rot_deg=(-1.0 - breath * 0.7, glance * 0.35, tilt * 0.4))
        _pose_bone(arm_obj, "Head", fr, rot_deg=(-1.0, glance * 0.65, tilt * 0.6))

        # Relaxed arms slightly bent FORWARD (-rot_x) and naturally at sides!
        _pose_bone(arm_obj, "Shoulder_L", fr, rot_deg=(0.0, 0.0, -1.5 + breath * 0.6))
        _pose_bone(arm_obj, "UpperArm_L", fr, rot_deg=(-4.0 - sway * 1.5, 0.0, 5.5))
        _pose_bone(arm_obj, "LowerArm_L", fr, rot_deg=(-14.0 - breath * 1.5, 0.0, -2.5))
        _pose_bone(arm_obj, "Hand_L", fr, rot_deg=(-2.0, 0.0, 2.0))

        _pose_bone(arm_obj, "Shoulder_R", fr, rot_deg=(0.0, 0.0, 1.5 - breath * 0.6))
        _pose_bone(arm_obj, "UpperArm_R", fr, rot_deg=(-7.0 + sway * 1.2 if is_jupp else -4.0 + sway * 1.5, 0.0, -5.5))
        _pose_bone(arm_obj, "LowerArm_R", fr, rot_deg=(-20.0 - breath * 1.5 if is_jupp else -13.0 - breath * 1.5, 0.0, 2.5))
        _pose_bone(arm_obj, "Hand_R", fr, rot_deg=(-2.0, 0.0, -2.0))

        # Grounded slightly staggered stance (UpperLeg -rot_x = forward, LowerLeg +rot_x = natural back knee bend!)
        _pose_bone(arm_obj, "UpperLeg_L", fr, rot_deg=(-3.5, 0.0, 2.0))
        _pose_bone(arm_obj, "LowerLeg_L", fr, rot_deg=(6.0, 0.0, 0.0))
        _pose_bone(arm_obj, "Foot_L", fr, rot_deg=(-2.5, 0.0, -1.5))

        _pose_bone(arm_obj, "UpperLeg_R", fr, rot_deg=(1.5, 0.0, -2.0))
        _pose_bone(arm_obj, "LowerLeg_R", fr, rot_deg=(2.5, 0.0, 0.0))
        _pose_bone(arm_obj, "Foot_R", fr, rot_deg=(-4.0, 0.0, 1.5))

        _pose_bone(arm_obj, extra_bone, fr, rot_deg=(breath * 0.8, 0.0, sway * 0.8))

    # ------------------------------------------------------------------
    # 2. Walk (32 frames / 1.07s): Natural realistic human stride!
    # ------------------------------------------------------------------
    def anim_walk(p: float, fr: int) -> None:
        stride = 24.0 if is_jupp else 28.0
        s = math.sin(p)
        c = math.cos(p)
        drop = _stance_hip_drop(abs(s) * stride * 0.72, 6.0 + abs(s) * 8.0)

        _pose_bone(arm_obj, "Hips", fr, rot_deg=(3.0, -s * 6.0, s * 2.4), loc=(c * 0.015, drop, 0.0))
        _pose_bone(arm_obj, "Spine", fr, rot_deg=(3.0, s * 3.5, -s * 1.4))
        _pose_bone(arm_obj, "Spine1", fr, rot_deg=(2.0, s * 3.5, -s * 1.0))
        _pose_bone(arm_obj, "Chest", fr, rot_deg=(1.0, s * 4.2, -s * 0.8))
        _pose_bone(arm_obj, "Neck", fr, rot_deg=(-2.0, -s * 3.5, 0.0))
        _pose_bone(arm_obj, "Head", fr, rot_deg=(-1.5, -s * 4.2, 0.0))

        # Left leg (p), Right leg (p + pi)
        # leg_fwd > 0 => thigh swings forward (-rot_x); knee bends backward (+rot_x)!
        for sfx, ph, side in (("L", p, 1.0), ("R", p + math.pi, -1.0)):
            leg_fwd = math.sin(ph)
            swing_lift = max(0.0, math.cos(ph))  # passing swing phase lifts knee naturally!
            hip_rx = -(leg_fwd * stride + 2.0)
            knee_rx = 4.0 + swing_lift * 46.0 + max(0.0, -leg_fwd) * 14.0
            # Heel strike (-10 deg dorsiflexion) -> flat stance -> toe push-off (+16 deg plantarflexion)
            foot_rx = -(hip_rx + knee_rx) * 0.55 - math.sin(ph - 0.55) * 11.0
            toe_rx = -max(0.0, -leg_fwd) * 16.0
            _pose_bone(arm_obj, f"UpperLeg_{sfx}", fr, rot_deg=(hip_rx, 0.0, side * 1.5))
            _pose_bone(arm_obj, f"LowerLeg_{sfx}", fr, rot_deg=(knee_rx, 0.0, 0.0))
            _pose_bone(arm_obj, f"Foot_{sfx}", fr, rot_deg=(foot_rx, 0.0, 0.0))
            _pose_bone(arm_obj, f"Toe_{sfx}", fr, rot_deg=(toe_rx, 0.0, 0.0))

        # Natural counter-swinging arms (elbow bends FORWARD via -rot_x!)
        for sfx, ph, side in (("L", p + math.pi, 1.0), ("R", p, -1.0)):
            arm_fwd = math.sin(ph)
            amp = 16.0 if (is_jupp and sfx == "R") else 22.0
            u_rx = -(arm_fwd * amp + 3.0)
            l_rx = -(14.0 + max(0.0, arm_fwd) * 20.0)
            _pose_bone(arm_obj, f"Shoulder_{sfx}", fr, rot_deg=(0.0, -arm_fwd * 2.5, -side * 1.5))
            _pose_bone(arm_obj, f"UpperArm_{sfx}", fr, rot_deg=(u_rx, 0.0, side * 5.0))
            _pose_bone(arm_obj, f"LowerArm_{sfx}", fr, rot_deg=(l_rx, 0.0, -side * 2.0))
            _pose_bone(arm_obj, f"Hand_{sfx}", fr, rot_deg=(-4.0, 0.0, side * 2.0))

        _pose_bone(arm_obj, extra_bone, fr, rot_deg=(abs(s) * 4.0 - 2.0, -s * 3.0, c * 2.5))

    # ------------------------------------------------------------------
    # 3. Sneak (36 frames / 1.2s): Low stealth crouch walk, bent knees, arms poised forward!
    # ------------------------------------------------------------------
    def anim_sneak(p: float, fr: int) -> None:
        s = math.sin(p)
        c = math.cos(p)
        # Exact geometric hip drop for bent stealth knees (stance foot strictly on floor!)
        drop = _stance_hip_drop(34.0, 56.0) - abs(s) * 0.014

        _pose_bone(arm_obj, "Hips", fr, rot_deg=(12.0, -s * 5.0, s * 2.0), loc=(c * 0.018, drop, 0.0))
        _pose_bone(arm_obj, "Spine", fr, rot_deg=(11.0, s * 3.0, 0.0))
        _pose_bone(arm_obj, "Spine1", fr, rot_deg=(9.0, s * 2.5, 0.0))
        _pose_bone(arm_obj, "Chest", fr, rot_deg=(7.0, s * 3.0, 0.0))
        # Head pitches UP (-rot_x) so eyes scan straight ahead!
        _pose_bone(arm_obj, "Neck", fr, rot_deg=(-14.0, -s * 3.5, 0.0))
        _pose_bone(arm_obj, "Head", fr, rot_deg=(-16.0, -s * 4.5, 0.0))

        for sfx, ph, side in (("L", p, 1.0), ("R", p + math.pi, -1.0)):
            sw = math.sin(ph)
            lift = max(0.0, math.cos(ph))
            hip_rx = -(34.0 + sw * 20.0)
            knee_rx = 56.0 + lift * 28.0 + max(0.0, -sw) * 8.0
            foot_rx = -(hip_rx + knee_rx) * 0.72 - lift * 8.0
            _pose_bone(arm_obj, f"UpperLeg_{sfx}", fr, rot_deg=(hip_rx, 0.0, side * 5.0))
            _pose_bone(arm_obj, f"LowerLeg_{sfx}", fr, rot_deg=(knee_rx, 0.0, 0.0))
            _pose_bone(arm_obj, f"Foot_{sfx}", fr, rot_deg=(foot_rx, 0.0, -side * 2.5))
            _pose_bone(arm_obj, f"Toe_{sfx}", fr, rot_deg=(-max(0.0, -sw) * 14.0, 0.0, 0.0))

        # Arms bent FORWARD (-rot_x) & slightly out for stealth balance!
        for sfx, ph, side in (("L", p + math.pi, 1.0), ("R", p, -1.0)):
            sw = math.sin(ph)
            _pose_bone(arm_obj, f"Shoulder_{sfx}", fr, rot_deg=(3.0, 0.0, -side * 2.0))
            _pose_bone(arm_obj, f"UpperArm_{sfx}", fr, rot_deg=(-(18.0 + sw * 12.0), 0.0, side * 12.0))
            _pose_bone(arm_obj, f"LowerArm_{sfx}", fr, rot_deg=(-(44.0 + sw * 10.0), 0.0, -side * 8.0))
            _pose_bone(arm_obj, f"Hand_{sfx}", fr, rot_deg=(6.0, 0.0, 0.0))

        _pose_bone(arm_obj, extra_bone, fr, rot_deg=(8.0 + abs(s) * 2.2, 0.0, c * 1.6))

    # ------------------------------------------------------------------
    # 4. Work (60 frames / 2.0s): Crouched precise tool manipulation at lock/safe/breaker box
    # ------------------------------------------------------------------
    def anim_work(p: float, fr: int) -> None:
        fine = math.sin(p * 3.0)
        micro = math.sin(p * 6.0)
        focus = math.sin(p)

        # Grounded deep stealth crouch (Left leg forward -66/+88, exact geometric hip height = -0.22m!)
        drop = _stance_hip_drop(64.0, 88.0) + focus * 0.006
        _pose_bone(arm_obj, "Hips", fr, rot_deg=(16.0, -8.0, 0.0), loc=(0.0, drop, 0.0))
        _pose_bone(arm_obj, "Spine", fr, rot_deg=(12.0, 4.0, 0.0))
        _pose_bone(arm_obj, "Spine1", fr, rot_deg=(10.0 + focus * 1.5, 3.0, 0.0))
        _pose_bone(arm_obj, "Chest", fr, rot_deg=(8.0 + focus * 1.5, 4.0, 0.0))
        _pose_bone(arm_obj, "Neck", fr, rot_deg=(-14.0, 2.0, focus * 2.0))
        _pose_bone(arm_obj, "Head", fr, rot_deg=(-12.0 + focus * 2.0, 3.0 + fine * 2.0, 3.5 if is_jupp else -2.0))

        # Left foot flat forward; right foot braced back on ball of foot (BOTH strictly >= z=0!)
        _pose_bone(arm_obj, "UpperLeg_L", fr, rot_deg=(-64.0, 0.0, 9.0))
        _pose_bone(arm_obj, "LowerLeg_L", fr, rot_deg=(88.0, 0.0, 0.0))
        _pose_bone(arm_obj, "Foot_L", fr, rot_deg=(-22.0, 0.0, -5.0))

        _pose_bone(arm_obj, "UpperLeg_R", fr, rot_deg=(-36.0, 0.0, -8.0))
        _pose_bone(arm_obj, "LowerLeg_R", fr, rot_deg=(84.0, 0.0, 0.0))
        _pose_bone(arm_obj, "Foot_R", fr, rot_deg=(-38.0, 0.0, 4.0))
        _pose_bone(arm_obj, "Toe_R", fr, rot_deg=(-14.0, 0.0, 0.0))

        # BOTH arms reaching FORWARD (-rot_x) manipulating lock/safe dial directly in front of chest!
        _pose_bone(arm_obj, "Shoulder_L", fr, rot_deg=(6.0, 5.0, -3.0))
        _pose_bone(arm_obj, "UpperArm_L", fr, rot_deg=(-(50.0 + focus * 2.5), 14.0, 6.0))
        _pose_bone(arm_obj, "LowerArm_L", fr, rot_deg=(-(54.0 + fine * 4.0), -10.0, -18.0))
        _pose_bone(arm_obj, "Hand_L", fr, rot_deg=(8.0, fine * 6.0, 0.0))

        _pose_bone(arm_obj, "Shoulder_R", fr, rot_deg=(8.0, -6.0, 3.0))
        _pose_bone(arm_obj, "UpperArm_R", fr, rot_deg=(-(54.0 + fine * 4.5), -16.0, -6.0))
        _pose_bone(arm_obj, "LowerArm_R", fr, rot_deg=(-(58.0 - fine * 6.5), 12.0, 18.0))
        _pose_bone(arm_obj, "Hand_R", fr, rot_deg=(6.0 + micro * 8.0, fine * 18.0, micro * 6.0))

        _pose_bone(arm_obj, extra_bone, fr, rot_deg=(12.0, 0.0, 0.0))

    # ------------------------------------------------------------------
    # 5. CarryLoot (36 frames / 1.2s): Heavy hunched stride gripping loaded bag straps!
    # ------------------------------------------------------------------
    def anim_carry_loot(p: float, fr: int) -> None:
        s = math.sin(p)
        c = math.cos(p)
        drop = _stance_hip_drop(22.0, 34.0) - abs(s) * 0.022

        _pose_bone(arm_obj, "Hips", fr, rot_deg=(8.0, -s * 4.5, s * 3.8), loc=(c * 0.024, drop, 0.0))
        _pose_bone(arm_obj, "Spine", fr, rot_deg=(10.0, s * 2.0, -s * 1.8))
        _pose_bone(arm_obj, "Spine1", fr, rot_deg=(9.0, s * 2.0, -s * 1.4))
        _pose_bone(arm_obj, "Chest", fr, rot_deg=(7.0, s * 2.4, -s * 1.0))
        _pose_bone(arm_obj, "Neck", fr, rot_deg=(-12.0, -s * 2.5, 0.0))
        _pose_bone(arm_obj, "Head", fr, rot_deg=(-12.0, -s * 3.0, 0.0))

        for sfx, ph, side in (("L", p, 1.0), ("R", p + math.pi, -1.0)):
            sw = math.sin(ph)
            lift = max(0.0, math.cos(ph))
            hip_rx = -(20.0 + sw * 20.0)
            knee_rx = 32.0 + lift * 32.0 + max(0.0, -sw) * 10.0
            foot_rx = -(hip_rx + knee_rx) * 0.68 - math.sin(ph - 0.5) * 9.0
            _pose_bone(arm_obj, f"UpperLeg_{sfx}", fr, rot_deg=(hip_rx, 0.0, side * 4.0))
            _pose_bone(arm_obj, f"LowerLeg_{sfx}", fr, rot_deg=(knee_rx, 0.0, 0.0))
            _pose_bone(arm_obj, f"Foot_{sfx}", fr, rot_deg=(foot_rx, 0.0, -side * 2.0))
            _pose_bone(arm_obj, f"Toe_{sfx}", fr, rot_deg=(-max(0.0, -sw) * 12.0, 0.0, 0.0))

        if is_jupp:
            # Jupp balances with left arm & braces heavy loaded leather safecracker bag with right arm!
            _pose_bone(arm_obj, "Shoulder_L", fr, rot_deg=(3.0, 0.0, -2.5))
            _pose_bone(arm_obj, "UpperArm_L", fr, rot_deg=(-(12.0 - s * 10.0), 0.0, 12.0))
            _pose_bone(arm_obj, "LowerArm_L", fr, rot_deg=(-28.0, 0.0, -6.0))
            _pose_bone(arm_obj, "Shoulder_R", fr, rot_deg=(6.0, 0.0, 4.0))
            _pose_bone(arm_obj, "UpperArm_R", fr, rot_deg=(-(24.0 + s * 4.0), -10.0, -6.0))
            _pose_bone(arm_obj, "LowerArm_R", fr, rot_deg=(-54.0, 8.0, 12.0))
        else:
            # Crew grips BOTH front backpack shoulder straps firmly up at upper chest!
            for sfx, side in (("L", 1.0), ("R", -1.0)):
                _pose_bone(arm_obj, f"Shoulder_{sfx}", fr, rot_deg=(5.0, 0.0, -side * 3.0))
                _pose_bone(arm_obj, f"UpperArm_{sfx}", fr, rot_deg=(-(32.0 + abs(s) * 3.0), side * 14.0, side * 8.0))
                _pose_bone(arm_obj, f"LowerArm_{sfx}", fr, rot_deg=(-78.0, -side * 12.0, -side * 16.0))
                _pose_bone(arm_obj, f"Hand_{sfx}", fr, rot_deg=(12.0, 0.0, 0.0))

        _pose_bone(arm_obj, extra_bone, fr, rot_deg=(9.0 + abs(s) * 6.5, -s * 4.0, c * 3.5))

    # ------------------------------------------------------------------
    # 6. Panic (40 frames / 1.33s): Tense reactive look-around / defensive ducking posture!
    # ------------------------------------------------------------------
    def anim_panic(p: float, fr: int) -> None:
        look = math.sin(p) * 38.0 + math.sin(p * 3.0) * 14.0
        duck = 0.5 + 0.5 * math.sin(p * 2.0)
        shift = math.sin(p)
        drop = _stance_hip_drop(34.0 + duck * 6.0, 56.0 + duck * 10.0)

        _pose_bone(arm_obj, "Hips", fr, rot_deg=(10.0 + duck * 4.0, shift * 8.0, shift * 3.5), loc=(shift * 0.035, drop, 0.0))
        _pose_bone(arm_obj, "Spine", fr, rot_deg=(10.0 + duck * 4.5, shift * 5.0, 0.0))
        _pose_bone(arm_obj, "Spine1", fr, rot_deg=(8.0 + duck * 4.0, shift * 6.0, 0.0))
        _pose_bone(arm_obj, "Chest", fr, rot_deg=(6.0 + duck * 4.0, shift * 7.0, 0.0))
        _pose_bone(arm_obj, "Neck", fr, rot_deg=(-12.0, look * 0.35, -shift * 4.0))
        _pose_bone(arm_obj, "Head", fr, rot_deg=(-12.0 + duck * 4.0, look * 0.65, -shift * 5.0))

        for sfx, side in (("L", 1.0), ("R", -1.0)):
            w_shift = max(0.0, side * shift)
            hip_rx = -(34.0 + duck * 6.0 + w_shift * 5.0)
            knee_rx = 56.0 + duck * 10.0 + w_shift * 7.0
            foot_rx = -(hip_rx + knee_rx) * 0.78
            _pose_bone(arm_obj, f"UpperLeg_{sfx}", fr, rot_deg=(hip_rx, 0.0, side * 9.0))
            _pose_bone(arm_obj, f"LowerLeg_{sfx}", fr, rot_deg=(knee_rx, 0.0, 0.0))
            _pose_bone(arm_obj, f"Foot_{sfx}", fr, rot_deg=(foot_rx, 0.0, -side * 4.5))

        # Defensive raised arms FORWARD (-rot_x) ready to duck/bolt!
        for sfx, side in (("L", 1.0), ("R", -1.0)):
            _pose_bone(arm_obj, f"Shoulder_{sfx}", fr, rot_deg=(8.0, 0.0, -side * (8.0 + duck * 4.0)))
            _pose_bone(arm_obj, f"UpperArm_{sfx}", fr, rot_deg=(-(28.0 + duck * 8.0), side * 10.0, side * 16.0))
            _pose_bone(arm_obj, f"LowerArm_{sfx}", fr, rot_deg=(-(74.0 + math.sin(p * 2.0 + side) * 10.0), -side * 8.0, -side * 12.0))
            _pose_bone(arm_obj, f"Hand_{sfx}", fr, rot_deg=(12.0, 0.0, 0.0))

        _pose_bone(arm_obj, extra_bone, fr, rot_deg=(7.0 + duck * 4.5, shift * 5.5, -shift * 3.5))

    build_clip("Idle", 120, anim_idle)
    build_clip("Walk", 32, anim_walk)
    build_clip("Sneak", 36, anim_sneak)
    build_clip("Work", 60, anim_work)
    build_clip("CarryLoot", 36, anim_carry_loot)
    build_clip("Panic", 40, anim_panic)

    arm_obj.animation_data.action = None
    _clear_pose(arm_obj)
    return clip_names


# ---------------------------------------------------------------------------
# Grounding, Export & Binary glTF 2.0 Verification
# ---------------------------------------------------------------------------

def ground_rigged_character(arm_obj: bpy.types.Object) -> float:
    bpy.context.view_layer.update()
    min_z = float("inf")
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        for v in obj.data.vertices:
            wz = (obj.matrix_world @ v.co).z
            if wz < min_z:
                min_z = wz
    if min_z == float("inf") or abs(min_z) < 1e-6:
        return 0.0
    bpy.context.view_layer.objects.active = arm_obj
    bpy.ops.object.mode_set(mode="EDIT")
    for eb in arm_obj.data.edit_bones:
        if eb.name != "Root":
            eb.head.z -= min_z
            eb.tail.z -= min_z
    bpy.ops.object.mode_set(mode="OBJECT")
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH":
            for v in obj.data.vertices:
                v.co.z -= min_z
            obj.data.update()
    bpy.context.view_layer.update()
    return -min_z


def export_rigged_glb(filepath: Path, img_format: str = "WEBP", img_quality: int = 88) -> dict:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(filepath),
        export_format="GLB",
        export_yup=True,
        export_apply=False,
        export_texcoords=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format=img_format,
        export_image_quality=img_quality,
        export_image_webp_fallback=False,
        export_draco_mesh_compression_enable=False,
        export_skins=True,
        export_animations=True,
        export_animation_mode="NLA_TRACKS",
        export_bake_animation=True,
        export_optimize_animation_size=True,
        export_anim_slide_to_zero=True,
        export_lights=False,
        export_cameras=False,
    )
    return verify_glb_file(filepath)


def verify_glb_file(filepath: Path) -> dict:
    data = filepath.read_bytes()
    magic, version, total_len = struct.unpack_from("<4sII", data, 0)
    assert magic == b"glTF", f"Bad magic: {magic!r}"
    assert version == 2, f"Bad version: {version}"
    assert total_len == len(data), f"Length mismatch: {total_len} vs {len(data)}"
    c0_len, c0_type = struct.unpack_from("<I4s", data, 12)
    assert c0_type == b"JSON", f"Bad chunk0: {c0_type!r}"
    gltf = json.loads(data[20 : 20 + c0_len].decode("utf-8"))

    meshes = gltf.get("meshes", [])
    accessors = gltf.get("accessors", [])
    nodes = gltf.get("nodes", [])
    anims = [a.get("name") for a in gltf.get("animations", [])]
    skins = gltf.get("skins", [])
    images = gltf.get("images", [])

    tris = 0
    min_b = [1e9, 1e9, 1e9]
    max_b = [-1e9, -1e9, -1e9]
    for m in meshes:
        for p in m.get("primitives", []):
            if "indices" in p:
                tris += accessors[p["indices"]]["count"] // 3
            pos_acc = accessors[p["attributes"]["POSITION"]]
            pmin = pos_acc.get("min", [0, 0, 0])
            pmax = pos_acc.get("max", [0, 0, 0])
            for i in range(3):
                min_b[i] = min(min_b[i], pmin[i])
                max_b[i] = max(max_b[i], pmax[i])

    return {
        "file": filepath.name,
        "sizeBytes": len(data),
        "sizeMB": round(len(data) / (1024 * 1024), 3),
        "triangles": tris,
        "meshes": [m.get("name") for m in meshes],
        "nodes": [n.get("name") for n in nodes],
        "skins": len(skins),
        "jointCount": len(skins[0].get("joints", [])) if skins else 0,
        "animations": anims,
        "images": len(images),
        "materials": [m.get("name") for m in gltf.get("materials", [])],
        "minY": round(min_b[1], 4),
        "dims": [round(max_b[i] - min_b[i], 3) for i in range(3)],
    }


# ---------------------------------------------------------------------------
# High-Res Multi-Angle Studio + Night-Lit QA Sheet Renderer (EEVEE AgX)
# ---------------------------------------------------------------------------

def _setup_qa_lighting(scene: bpy.types.Scene, night_mode: bool) -> None:
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.exposure = 0.30 if night_mode else 0.15

    world = bpy.data.worlds.new("QAWorld")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        if night_mode:
            bg.inputs["Color"].default_value = (0.016, 0.028, 0.056, 1.0)
            bg.inputs["Strength"].default_value = 0.65
        else:
            bg.inputs["Color"].default_value = (0.052, 0.064, 0.088, 1.0)
            bg.inputs["Strength"].default_value = 1.00

    bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=8.0, depth=0.04, location=(0.0, 0.0, -0.02))
    floor = bpy.context.active_object
    fmat = bpy.data.materials.new("QAFloor")
    bsdf = fmat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.030, 0.036, 0.046, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.24 if night_mode else 0.44
    if "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = 0.55 if night_mode else 0.12
    floor.data.materials.append(fmat)

    def add_area(name: str, loc: Tuple[float, float, float], target: Tuple[float, float, float], energy: float, color: Tuple[float, float, float], size: float) -> None:
        ld = bpy.data.lights.new(name, type="AREA")
        ld.energy = energy
        ld.color = color
        ld.size = size
        lo = bpy.data.objects.new(name, ld)
        scene.collection.objects.link(lo)
        lo.location = Vector(loc)
        lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()

    if night_mode:
        add_area("KeySodium", (2.0, -2.4, 2.5), (0.0, 0.0, 1.25), 260.0, (1.0, 0.76, 0.48), 1.4)
        add_area("RimMoon", (-2.2, 2.3, 2.4), (0.0, 0.0, 1.35), 220.0, (0.45, 0.72, 1.0), 1.8)
        add_area("FillNight", (-1.8, -2.1, 1.4), (0.0, 0.0, 1.20), 65.0, (0.65, 0.80, 1.0), 2.2)
    else:
        add_area("KeyStudio", (1.9, -2.5, 2.3), (0.0, 0.0, 1.20), 230.0, (1.0, 0.94, 0.86), 1.8)
        add_area("FillStudio", (-2.2, -2.0, 1.7), (0.0, 0.0, 1.15), 115.0, (0.82, 0.90, 1.0), 2.4)
        add_area("RimStudio", (-1.0, 2.5, 2.5), (0.0, 0.0, 1.35), 180.0, (0.85, 0.92, 1.0), 1.6)
        add_area("EyeCatch", (0.4, -1.6, 1.85), (0.0, 0.0, 1.62), 24.0, (1.0, 0.98, 0.94), 0.32)


def _apply_imported_clip(clip_name: Optional[str], frame: int) -> None:
    if not clip_name:
        return
    arm = next((o for o in bpy.context.scene.objects if o.type == "ARMATURE"), None)
    if arm is None:
        return
    act = bpy.data.actions.get(clip_name)
    if act is None:
        act = next((a for a in bpy.data.actions if clip_name.lower() in a.name.lower()), None)
    if act is not None:
        arm.animation_data_create()
        for tr in list(arm.animation_data.nla_tracks):
            tr.mute = True
        arm.animation_data.action = act
        bpy.context.scene.frame_set(frame)
        bpy.context.view_layer.update()


def render_qa_sheets(jupp_glb: Path, crew_glb: Path, out_sheet: Path) -> None:
    tmp_dir = out_sheet.parent / "_crew_qa_tiles"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    views = [
        # Jupp Kowalke row
        ("jupp_front", jupp_glb, (0.0, -3.15, 0.96), (0.0, 0.0, 0.90), 50.0, False, "Idle", 10),
        ("jupp_night34", jupp_glb, (1.95, -2.45, 1.12), (0.0, 0.0, 0.92), 52.0, True, "Walk", 9),
        ("jupp_face", jupp_glb, (0.26, -0.76, 1.64), (0.0, -0.02, 1.61), 85.0, False, "Idle", 1),
        ("jupp_back", jupp_glb, (-1.65, 2.55, 1.08), (-0.05, 0.0, 0.90), 50.0, False, "Idle", 1),
        # Crew Accomplice row
        ("crew_front", crew_glb, (0.0, -3.18, 0.98), (0.0, 0.0, 0.91), 50.0, False, "Idle", 10),
        ("crew_night34", crew_glb, (1.95, -2.45, 1.12), (0.0, 0.0, 0.92), 52.0, True, "CarryLoot", 9),
        ("crew_face", crew_glb, (-0.26, -0.76, 1.66), (0.0, -0.02, 1.63), 85.0, False, "Idle", 1),
        ("crew_back", crew_glb, (1.65, 2.55, 1.10), (0.0, 0.05, 0.94), 50.0, False, "Idle", 1),
    ]

    tile_paths = []
    for tag, glb_p, cloc, ctgt, lens, night, clip, fr in views:
        reset_scene()
        scene = bpy.context.scene
        _setup_qa_lighting(scene, night_mode=night)
        bpy.ops.import_scene.gltf(filepath=str(glb_p))
        _apply_imported_clip(clip, fr)

        cam_d = bpy.data.cameras.new("QACam")
        cam_d.lens = lens
        cam_o = bpy.data.objects.new("QACam", cam_d)
        scene.collection.objects.link(cam_o)
        scene.camera = cam_o
        cam_o.location = Vector(cloc)
        cam_o.rotation_euler = (Vector(ctgt) - Vector(cloc)).to_track_quat("-Z", "Y").to_euler()

        tp = tmp_dir / f"{tag}.png"
        scene.render.filepath = str(tp)
        bpy.ops.render.render(write_still=True)
        tile_paths.append(tp)

    reset_scene()
    tw, th = 512, 640
    cols, rows = 4, 2
    sw, sh = cols * tw, rows * th
    sheet_arr = np.zeros((sh, sw, 4), dtype=np.float32)
    sheet_arr[:, :, 3] = 1.0
    for idx, tp in enumerate(tile_paths):
        img = bpy.data.images.load(str(tp))
        px = np.empty(tw * th * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape((th, tw, 4))
        bpy.data.images.remove(img)
        col = idx % cols
        row = rows - 1 - (idx // cols)
        sheet_arr[row * th : (row + 1) * th, col * tw : (col + 1) * tw] = px

    out_sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet_img = bpy.data.images.new("CrewQASheet", width=sw, height=sh, alpha=False)
    sheet_img.pixels.foreach_set(sheet_arr.ravel())
    sheet_img.filepath_raw = str(out_sheet)
    sheet_img.file_format = "PNG"
    sheet_img.save()

    # Render 6x2 Animation Pose Verification Sheet into scratch/crew_poses_qa.png!
    pose_sheet_path = out_sheet.parent / "scratch" / "crew_poses_qa.png"
    pose_sheet_path.parent.mkdir(parents=True, exist_ok=True)
    pose_clips = [("Idle", 15), ("Walk", 9), ("Sneak", 10), ("Work", 15), ("CarryLoot", 9), ("Panic", 10)]
    ptw, pth = 320, 400
    p_tiles = []
    for char_tag, glb_p in (("jupp", jupp_glb), ("crew", crew_glb)):
        for cname, fr in pose_clips:
            reset_scene()
            scene = bpy.context.scene
            _setup_qa_lighting(scene, night_mode=False)
            scene.render.resolution_x = ptw
            scene.render.resolution_y = pth
            bpy.ops.import_scene.gltf(filepath=str(glb_p))
            _apply_imported_clip(cname, fr)

            cam_d = bpy.data.cameras.new("PoseCam")
            cam_d.lens = 48.0
            cam_o = bpy.data.objects.new("PoseCam", cam_d)
            scene.collection.objects.link(cam_o)
            scene.camera = cam_o
            cam_o.location = Vector((1.85, -2.50, 1.05))
            cam_o.rotation_euler = (Vector((0.0, 0.0, 0.85)) - cam_o.location).to_track_quat("-Z", "Y").to_euler()

            tp = tmp_dir / f"pose_{char_tag}_{cname}.png"
            scene.render.filepath = str(tp)
            bpy.ops.render.render(write_still=True)
            p_tiles.append(tp)

    reset_scene()
    pcols, prows = 6, 2
    psw, psh = pcols * ptw, prows * pth
    p_arr = np.zeros((psh, psw, 4), dtype=np.float32)
    p_arr[:, :, 3] = 1.0
    for idx, tp in enumerate(p_tiles):
        img = bpy.data.images.load(str(tp))
        px = np.empty(ptw * pth * 4, dtype=np.float32)
        img.pixels.foreach_get(px)
        px = px.reshape((pth, ptw, 4))
        bpy.data.images.remove(img)
        col = idx % pcols
        row = prows - 1 - (idx // pcols)
        p_arr[row * pth : (row + 1) * pth, col * ptw : (col + 1) * ptw] = px

    p_img = bpy.data.images.new("CrewPosesQA", width=psw, height=psh, alpha=False)
    p_img.pixels.foreach_set(p_arr.ravel())
    p_img.filepath_raw = str(pose_sheet_path)
    p_img.file_format = "PNG"
    p_img.save()

    for tp in list(tile_paths) + list(p_tiles):
        tp.unlink(missing_ok=True)
    try:
        tmp_dir.rmdir()
    except OSError:
        pass
    print(f"[build_crew] QA sheet saved: {out_sheet}")
    print(f"[build_crew] Pose QA sheet saved: {pose_sheet_path}")


# ---------------------------------------------------------------------------
# Entrypoint Builders
# ---------------------------------------------------------------------------

def build_character_jupp(out_dir: Path, tex_dir: Path) -> dict:
    reset_scene()
    body_obj, body_doms, bag_obj, bag_doms, joints = build_jupp_geometry(tex_dir)
    arm_obj = build_armature(
        "Armature",
        joints,
        extra_bone=("ToolBagBone", "Spine", joints["toolbag"] + Vector((0.0, 0.0, 0.08)), joints["toolbag"] + Vector((0.0, 0.0, -0.10))),
    )
    bind_and_weight_mesh(body_obj, body_doms, arm_obj, joints, extra_bone_name="ToolBagBone")
    bind_and_weight_mesh(bag_obj, bag_doms, arm_obj, joints, extra_bone_name="ToolBagBone")
    ground_rigged_character(arm_obj)
    author_animations(arm_obj, is_jupp=True)
    return export_rigged_glb(out_dir / "character_jupp.glb", img_format="WEBP", img_quality=88)


def build_character_crew(out_dir: Path, tex_dir: Path) -> dict:
    reset_scene()
    body_obj, body_doms, pack_obj, pack_doms, joints = build_crew_geometry(tex_dir)
    arm_obj = build_armature(
        "Armature",
        joints,
        extra_bone=("BackpackBone", "Chest", joints["backpack"] + Vector((0.0, -0.06, 0.0)), joints["backpack"] + Vector((0.0, 0.12, 0.0))),
    )
    bind_and_weight_mesh(body_obj, body_doms, arm_obj, joints, extra_bone_name="BackpackBone")
    bind_and_weight_mesh(pack_obj, pack_doms, arm_obj, joints, extra_bone_name="BackpackBone")
    ground_rigged_character(arm_obj)
    author_animations(arm_obj, is_jupp=False)
    return export_rigged_glb(out_dir / "character_crew.glb", img_format="WEBP", img_quality=88)


def main() -> None:
    t0 = time.time()
    argv = sys.argv
    extra = argv[argv.index("--") + 1 :] if "--" in argv else []
    tex_dir = DEFAULT_TEX_DIR
    qa_out: Optional[Path] = DEFAULT_QA_OUT
    render_qa = True

    i = 0
    while i < len(extra):
        if extra[i] == "--tex-dir" and i + 1 < len(extra):
            tex_dir = Path(extra[i + 1])
            i += 2
        elif extra[i] == "--qa-out" and i + 1 < len(extra):
            qa_out = Path(extra[i + 1])
            i += 2
        elif extra[i] == "--no-qa":
            render_qa = False
            i += 1
        else:
            i += 1

    print(f"[build_crew] Using PBR texture dir: {tex_dir}")
    jupp_stats = build_character_jupp(MODELS_DIR, tex_dir)
    print(f"[build_crew] character_jupp.glb -> {json.dumps(jupp_stats)}")

    crew_stats = build_character_crew(MODELS_DIR, tex_dir)
    print(f"[build_crew] character_crew.glb -> {json.dumps(crew_stats)}")

    required_clips = {"Idle", "Walk", "Sneak", "Work", "CarryLoot", "Panic"}
    for st in (jupp_stats, crew_stats):
        assert set(st["animations"]) == required_clips, f"Clip mismatch on {st['file']}: {st['animations']}"
        assert abs(st["minY"]) <= 0.005, f"Not grounded on {st['file']}: minY={st['minY']}"
        assert st["skins"] == 1 and st["jointCount"] >= 20, f"Invalid skin on {st['file']}"
    assert "Backpack" in crew_stats["nodes"], f"Missing Backpack node in character_crew.glb: {crew_stats['nodes']}"

    if render_qa and qa_out is not None:
        render_qa_sheets(MODELS_DIR / "character_jupp.glb", MODELS_DIR / "character_crew.glb", qa_out)

    print(f"[build_crew] Completed successfully in {time.time() - t0:.2f}s")


if __name__ == "__main__":
    main()
