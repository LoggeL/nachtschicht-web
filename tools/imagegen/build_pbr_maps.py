#!/usr/bin/env python3
"""Derive physically calibrated, toroidally seamless PBR maps (normal, roughness, AO)
from photorealistic 1024x1024 seamless albedo textures using NumPy & Pillow."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter


@dataclass(frozen=True)
class MaterialProfile:
    normal_strength: float
    micro_weight: float
    mid_weight: float
    macro_weight: float
    roughness_min: float
    roughness_max: float
    roughness_invert_luma: bool = True
    ao_strength: float = 0.55
    puddle_coverage: float = 0.0        # 0..1 fraction of surface with rain puddles
    puddle_roughness: float = 0.07      # mirror-wet puddle roughness
    puddle_darken: float = 0.28         # physical wet darkening on albedo
    anisotropic_brush: float = 0.0      # brushed metal streak intensity
    grout_crevice_boost: float = 0.0    # extra depth/roughness in dark mortar/grout seams
    seed: int = 42


PROFILES: dict[str, MaterialProfile] = {
    "wet_asphalt": MaterialProfile(
        normal_strength=3.6,
        micro_weight=0.60,
        mid_weight=0.28,
        macro_weight=0.12,
        roughness_min=0.52,
        roughness_max=0.84,
        roughness_invert_luma=False,
        ao_strength=0.45,
        puddle_coverage=0.34,
        puddle_roughness=0.06,
        puddle_darken=0.32,
        seed=101,
    ),
    "salou_stucco": MaterialProfile(
        normal_strength=2.8,
        micro_weight=0.45,
        mid_weight=0.35,
        macro_weight=0.20,
        roughness_min=0.70,
        roughness_max=0.94,
        roughness_invert_luma=True,
        ao_strength=0.52,
        seed=202,
    ),
    "stone_plaza": MaterialProfile(
        normal_strength=4.2,
        micro_weight=0.30,
        mid_weight=0.42,
        macro_weight=0.28,
        roughness_min=0.36,
        roughness_max=0.86,
        roughness_invert_luma=True,
        ao_strength=0.70,
        puddle_coverage=0.14,
        puddle_roughness=0.14,
        puddle_darken=0.18,
        grout_crevice_boost=0.45,
        seed=303,
    ),
    "dresden_sandstone": MaterialProfile(
        normal_strength=4.6,
        micro_weight=0.35,
        mid_weight=0.40,
        macro_weight=0.25,
        roughness_min=0.68,
        roughness_max=0.95,
        roughness_invert_luma=True,
        ao_strength=0.74,
        grout_crevice_boost=0.55,
        seed=404,
    ),
    "interior_marble": MaterialProfile(
        normal_strength=1.5,
        micro_weight=0.25,
        mid_weight=0.40,
        macro_weight=0.35,
        roughness_min=0.07,
        roughness_max=0.24,
        roughness_invert_luma=True,
        ao_strength=0.35,
        grout_crevice_boost=0.35,
        seed=505,
    ),
    "brushed_steel": MaterialProfile(
        normal_strength=1.8,
        micro_weight=0.75,
        mid_weight=0.20,
        macro_weight=0.05,
        roughness_min=0.22,
        roughness_max=0.46,
        roughness_invert_luma=True,
        ao_strength=0.30,
        anisotropic_brush=0.55,
        seed=606,
    ),
    "brick_alley": MaterialProfile(
        normal_strength=5.0,
        micro_weight=0.30,
        mid_weight=0.42,
        macro_weight=0.28,
        roughness_min=0.46,
        roughness_max=0.92,
        roughness_invert_luma=True,
        ao_strength=0.78,
        puddle_coverage=0.0,
        grout_crevice_boost=0.60,
        seed=707,
    ),
    "leather_dark": MaterialProfile(
        normal_strength=2.6,
        micro_weight=0.65,
        mid_weight=0.25,
        macro_weight=0.10,
        roughness_min=0.30,
        roughness_max=0.62,
        roughness_invert_luma=True,
        ao_strength=0.42,
        seed=808,
    ),
    "tactical_fabric": MaterialProfile(
        normal_strength=2.4,
        micro_weight=0.78,
        mid_weight=0.18,
        macro_weight=0.04,
        roughness_min=0.66,
        roughness_max=0.90,
        roughness_invert_luma=True,
        ao_strength=0.45,
        seed=809,
    ),
    "wool_tweed": MaterialProfile(
        normal_strength=3.0,
        micro_weight=0.72,
        mid_weight=0.22,
        macro_weight=0.06,
        roughness_min=0.76,
        roughness_max=0.96,
        roughness_invert_luma=True,
        ao_strength=0.55,
        seed=810,
    ),
    "palm_bark": MaterialProfile(
        normal_strength=5.4,
        micro_weight=0.28,
        mid_weight=0.40,
        macro_weight=0.32,
        roughness_min=0.72,
        roughness_max=0.96,
        roughness_invert_luma=True,
        ao_strength=0.78,
        grout_crevice_boost=0.50,
        seed=811,
    ),
    "wood_shutter": MaterialProfile(
        normal_strength=3.4,
        micro_weight=0.45,
        mid_weight=0.35,
        macro_weight=0.20,
        roughness_min=0.54,
        roughness_max=0.86,
        roughness_invert_luma=True,
        ao_strength=0.58,
        grout_crevice_boost=0.30,
        seed=812,
    ),
}


def toroidal_gaussian_blur(arr: np.ndarray, sigma: float) -> np.ndarray:
    """Separable periodic Gaussian blur via FFT — 100% seamless across tile borders."""
    if sigma <= 0.05:
        return arr.copy()
    h, w = arr.shape
    fy = np.fft.fftfreq(h)
    fx = np.fft.rfftfreq(w)
    # Frequency-domain Gaussian kernel: exp(-2 * pi^2 * sigma^2 * (fx^2 + fy^2))
    kernel = np.exp(-2.0 * (np.pi ** 2) * (sigma ** 2) * (fy[:, None] ** 2 + fx[None, :] ** 2))
    spec = np.fft.rfft2(arr)
    out = np.fft.irfft2(spec * kernel, s=(h, w))
    return out.astype(np.float32)


def periodic_fbm(h: int, w: int, seed: int, octaves: tuple[tuple[int, float], ...]) -> np.ndarray:
    """Generate 100% tileable periodic fBm noise via trigonometric harmonic synthesis / FFT."""
    rng = np.random.default_rng(seed)
    white = rng.standard_normal((h, w)).astype(np.float32)
    spec = np.fft.rfft2(white)
    fy = np.fft.fftfreq(h) * h  # integer harmonic cycles per tile
    fx = np.fft.rfftfreq(w) * w
    r2 = fy[:, None] ** 2 + fx[None, :] ** 2

    accum = np.zeros((h, w), dtype=np.float32)
    weight_sum = 0.0
    for freq_cycles, amp in octaves:
        # Band-pass around freq_cycles
        bw = max(1.0, freq_cycles * 0.55)
        band = np.exp(-0.5 * ((np.sqrt(r2) - freq_cycles) / bw) ** 2)
        band[0, 0] = 0.0
        layer = np.fft.irfft2(spec * band, s=(h, w)).astype(np.float32)
        std = float(np.std(layer)) + 1e-6
        accum += (layer / std) * amp
        weight_sum += amp

    accum /= max(weight_sum, 1e-6)
    # Normalize smoothly into [0, 1]
    lo, hi = np.percentile(accum, 2), np.percentile(accum, 98)
    return np.clip((accum - lo) / max(hi - lo, 1e-5), 0.0, 1.0).astype(np.float32)


def sobel_toroidal(height: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Toroidally wrapped 3x3 Sobel X and Y derivatives (zero border artifacts)."""
    h_ul = np.roll(np.roll(height, 1, axis=0), 1, axis=1)
    h_u  = np.roll(height, 1, axis=0)
    h_ur = np.roll(np.roll(height, 1, axis=0), -1, axis=1)
    h_l  = np.roll(height, 1, axis=1)
    h_r  = np.roll(height, -1, axis=1)
    h_dl = np.roll(np.roll(height, -1, axis=0), 1, axis=1)
    h_d  = np.roll(height, -1, axis=0)
    h_dr = np.roll(np.roll(height, -1, axis=0), -1, axis=1)

    dx = (h_ur + 2.0 * h_r + h_dr) - (h_ul + 2.0 * h_l + h_dl)
    dy = (h_dl + 2.0 * h_d + h_dr) - (h_ul + 2.0 * h_u + h_ur)
    return dx / 8.0, dy / 8.0


def make_seamless_tile_rgb(img: Image.Image, blend_fraction: float = 0.12) -> Image.Image:
    """Diamond crossfade half-shift seamlessizer for organic textures."""
    w, h = img.size
    shifted = ImageChops.offset(img, w // 2, h // 2)
    ys = np.arange(h, dtype=np.float32)
    xs = np.arange(w, dtype=np.float32)
    bw = max(8.0, w * blend_fraction)
    bh = max(8.0, h * blend_fraction)
    dy = np.minimum(ys, h - 1 - ys)
    dx = np.minimum(xs, w - 1 - xs)
    wy = np.clip(dy / bh, 0.0, 1.0)
    wx = np.clip(dx / bw, 0.0, 1.0)
    wy = wy * wy * (3.0 - 2.0 * wy)
    wx = wx * wx * (3.0 - 2.0 * wx)
    mask_arr = (wy[:, None] * wx[None, :] * 255.0).astype(np.uint8)
    mask = Image.fromarray(mask_arr, mode="L").filter(ImageFilter.GaussianBlur(radius=3))
    return Image.composite(img, shifted, mask)


def make_equirectangular_seamless(img: Image.Image, blend_fraction: float = 0.07) -> Image.Image:
    """Eliminate the 360-degree horizontal seam on equirectangular environment maps
    and gently smooth zenith/nadir polar caps to avoid PMREM pinch artifacts."""
    arr = np.asarray(img.convert("RGB"), dtype=np.float32)
    h, w, _ = arr.shape

    # Horizontal-only half-shift blend on left/right edges
    shifted = np.roll(arr, w // 2, axis=1)
    xs = np.arange(w, dtype=np.float32)
    bw = max(16.0, w * blend_fraction)
    dx = np.minimum(xs, w - 1 - xs)
    wx = np.clip(dx / bw, 0.0, 1.0)
    wx = wx * wx * (3.0 - 2.0 * wx)
    blended = arr * wx[None, :, None] + shifted * (1.0 - wx[None, :, None])

    # Smooth extreme zenith (top 2.5%) and nadir (bottom 2.5%) rows toward row mean
    pole_rows = max(4, int(h * 0.025))
    for i in range(pole_rows):
        t = (i / pole_rows)
        t = t * t * (3.0 - 2.0 * t)
        # Top pole
        top_mean = blended[i].mean(axis=0, keepdims=True)
        blended[i] = top_mean * (1.0 - t) + blended[i] * t
        # Bottom pole
        bi = h - 1 - i
        bot_mean = blended[bi].mean(axis=0, keepdims=True)
        blended[bi] = bot_mean * (1.0 - t) + blended[bi] * t

    return Image.fromarray(np.clip(blended, 0, 255).astype(np.uint8), mode="RGB")


def derive_pbr_maps(
    albedo_img: Image.Image,
    profile_name: str,
    out_dir: Path,
    webp_quality: int = 86,
    legacy_copy_path: Path | None = None,
    qa_sheet_path: Path | None = None,
) -> dict[str, dict[str, int | str]]:
    """Generate albedo, tangent-space normal, roughness, and AO WebP maps."""
    profile = PROFILES[profile_name]
    rgb_u8 = np.asarray(albedo_img.convert("RGB"), dtype=np.uint8)
    rgb = rgb_u8.astype(np.float32) / 255.0
    h, w, _ = rgb.shape

    # Convert sRGB to linear luminance for accurate height & cavity extraction
    lin = np.where(rgb <= 0.04045, rgb / 12.92, ((rgb + 0.055) / 1.055) ** 2.4)
    luma = (0.2126 * lin[..., 0] + 0.7152 * lin[..., 1] + 0.0722 * lin[..., 2]).astype(np.float32)

    # High-pass detrending removes uneven illumination gradients while preserving stone/masonry relief
    detrend_base = toroidal_gaussian_blur(luma, sigma=max(24.0, w * 0.06))
    luma_hp = luma - detrend_base * 0.65
    lo, hi = np.percentile(luma_hp, 2), np.percentile(luma_hp, 98)
    height = np.clip((luma_hp - lo) / max(hi - lo, 1e-5), 0.0, 1.0).astype(np.float32)

    # Enhance dark grout/mortar crevices for tiled/masonry materials
    grout_mask = np.zeros_like(height)
    if profile.grout_crevice_boost > 0.0:
        local_med = toroidal_gaussian_blur(luma, sigma=7.0)
        crevice = np.clip((local_med - luma) * 5.5, 0.0, 1.0)
        grout_mask = np.clip(crevice ** 1.25, 0.0, 1.0)
        height = np.clip(height - grout_mask * (0.45 * profile.grout_crevice_boost), 0.0, 1.0)

    # Add fine directional brushed streaks for machined brushed_steel
    brush_signal = np.zeros_like(height)
    if profile.anisotropic_brush > 0.0:
        rng = np.random.default_rng(profile.seed)
        row_noise = rng.standard_normal((h, 1)).astype(np.float32)
        fine_noise = rng.standard_normal((h, w)).astype(np.float32)
        # Elongated horizontal brush streaks via strong horizontal blur + sharp vertical frequency
        streaks = toroidal_gaussian_blur(fine_noise, sigma=0.6)
        spec = np.fft.rfft2(streaks)
        fx = np.fft.rfftfreq(w)
        fy = np.fft.fftfreq(h)
        aniso_kernel = np.exp(-2.0 * (np.pi ** 2) * ((fx[None, :] * 28.0) ** 2 + (fy[:, None] * 0.55) ** 2))
        aniso = np.fft.irfft2(spec * aniso_kernel, s=(h, w)).astype(np.float32)
        aniso = aniso / (float(np.std(aniso)) + 1e-6)
        brush_signal = np.clip(0.5 + 0.20 * aniso + 0.08 * row_noise, 0.0, 1.0)
        height = np.clip(height * (1.0 - 0.35 * profile.anisotropic_brush) + brush_signal * (0.35 * profile.anisotropic_brush), 0.0, 1.0)

    # Optional realistic rain puddle mask (for wet_asphalt, damp stone_plaza, brick_alley)
    puddle_mask = np.zeros_like(height)
    if profile.puddle_coverage > 0.0:
        puddle_noise = periodic_fbm(
            h, w, seed=profile.seed,
            octaves=((2, 0.55), (4, 0.30), (9, 0.15)),
        )
        # Puddles naturally collect in lower surface depressions + broad smooth organic pools
        basin = 0.72 * puddle_noise + 0.28 * (1.0 - toroidal_gaussian_blur(height, sigma=6.0))
        thresh = float(np.quantile(basin, 1.0 - profile.puddle_coverage))
        puddle_raw = (basin - thresh) / 0.09
        puddle_mask = np.clip(puddle_raw, 0.0, 1.0)
        # Smoothstep for sharp yet natural wet meniscus edges
        puddle_mask = puddle_mask * puddle_mask * (3.0 - 2.0 * puddle_mask)

    # Multi-scale height fields for rich tangent-space normals
    h_micro = toroidal_gaussian_blur(height, sigma=0.7)
    h_mid = toroidal_gaussian_blur(height, sigma=2.4)
    h_macro = toroidal_gaussian_blur(height, sigma=6.5)

    dx1, dy1 = sobel_toroidal(h_micro)
    dx2, dy2 = sobel_toroidal(h_mid)
    dx3, dy3 = sobel_toroidal(h_macro)

    dx = (profile.micro_weight * dx1 + profile.mid_weight * dx2 + profile.macro_weight * dx3) * profile.normal_strength
    dy = (profile.micro_weight * dy1 + profile.mid_weight * dy2 + profile.macro_weight * dy3) * profile.normal_strength

    # Calm standing water in puddles flattens underlying asphalt normals!
    if profile.puddle_coverage > 0.0:
        calm = 1.0 - puddle_mask * 0.92
        dx *= calm
        dy *= calm

    # OpenGL / Three.js tangent-space normal convention:
    # +X right (R), +Y up (G => +dy in image coordinates where Y grows downward), +Z out (B)
    nx = -dx
    ny = dy
    nz = np.ones_like(nx)
    inv_len = 1.0 / np.sqrt(nx * nx + ny * ny + nz * nz + 1e-8)
    nx *= inv_len
    ny *= inv_len
    nz *= inv_len

    normal_u8 = np.stack([
        np.clip((nx * 0.5 + 0.5) * 255.0, 0, 255),
        np.clip((ny * 0.5 + 0.5) * 255.0, 0, 255),
        np.clip((nz * 0.5 + 0.5) * 255.0, 0, 255),
    ], axis=-1).astype(np.uint8)

    # Physically calibrated Roughness Map
    micro_var = periodic_fbm(h, w, seed=profile.seed + 17, octaves=((5, 0.45), (14, 0.35), (32, 0.20)))
    base_sig = (1.0 - height) if profile.roughness_invert_luma else height
    rough_norm = np.clip(0.65 * base_sig + 0.35 * micro_var, 0.0, 1.0)
    rough = profile.roughness_min + rough_norm * (profile.roughness_max - profile.roughness_min)

    if profile.grout_crevice_boost > 0.0:
        # Grout/mortar seams are always matte and rough
        rough = np.maximum(rough, grout_mask * 0.92)
    if profile.anisotropic_brush > 0.0:
        rough = np.clip(rough + (brush_signal - 0.5) * 0.22 * profile.anisotropic_brush, 0.12, 0.72)
    if profile.puddle_coverage > 0.0:
        # Wet halo around puddles lowers roughness slightly; puddle center drops to mirror-wet!
        damp_halo = toroidal_gaussian_blur(puddle_mask, sigma=14.0)
        rough = rough * (1.0 - 0.32 * damp_halo)
        rough = rough * (1.0 - puddle_mask) + profile.puddle_roughness * puddle_mask

    rough_u8 = np.clip(rough * 255.0, 0, 255).astype(np.uint8)

    # Physical wet-darkening of albedo in puddle zones & damp halos
    albedo_out = rgb.copy()
    if profile.puddle_coverage > 0.0 and profile.puddle_darken > 0.0:
        wet_factor = 1.0 - profile.puddle_darken * np.clip(puddle_mask * 0.85 + toroidal_gaussian_blur(puddle_mask, sigma=10.0) * 0.30, 0.0, 1.0)
        albedo_out = np.clip(albedo_out * wet_factor[..., None], 0.0, 1.0)
    albedo_u8 = np.clip(albedo_out * 255.0, 0, 255).astype(np.uint8)

    # Multi-scale Cavity Ambient Occlusion Map
    cav_fine = np.clip(toroidal_gaussian_blur(height, sigma=2.2) - height, 0.0, 1.0)
    cav_mid = np.clip(toroidal_gaussian_blur(height, sigma=9.0) - height, 0.0, 1.0)
    cavity = np.clip((cav_fine * 2.2 + cav_mid * 1.6 + grout_mask * 0.65), 0.0, 1.0)
    ao = np.clip(1.0 - cavity * profile.ao_strength, 0.38, 1.0)
    ao_u8 = np.clip(ao * 255.0, 0, 255).astype(np.uint8)

    # Save all 4 WebP maps
    out_dir.mkdir(parents=True, exist_ok=True)
    paths = {
        "albedo": out_dir / f"{profile_name}_albedo.webp",
        "normal": out_dir / f"{profile_name}_normal.webp",
        "roughness": out_dir / f"{profile_name}_roughness.webp",
        "ao": out_dir / f"{profile_name}_ao.webp",
    }

    Image.fromarray(albedo_u8, mode="RGB").save(paths["albedo"], format="WEBP", quality=webp_quality, method=6)
    # Normal maps benefit from slightly higher WebP quality to avoid tangent vector banding
    Image.fromarray(normal_u8, mode="RGB").save(paths["normal"], format="WEBP", quality=92, method=6)
    Image.fromarray(rough_u8, mode="L").save(paths["roughness"], format="WEBP", quality=webp_quality, method=6)
    Image.fromarray(ao_u8, mode="L").save(paths["ao"], format="WEBP", quality=webp_quality, method=6)

    if legacy_copy_path is not None:
        Image.fromarray(albedo_u8, mode="RGB").save(legacy_copy_path, format="WEBP", quality=webp_quality, method=6)

    # Optional 4-panel PBR visual inspection sheet (albedo | normal | roughness | AO + 2x2 tile strip)
    if qa_sheet_path is not None:
        qa_sheet_path.parent.mkdir(parents=True, exist_ok=True)
        sz = 384
        a_im = Image.fromarray(albedo_u8, mode="RGB")
        # Build 2x2 tiled preview for panel 0 so seam verification happens simultaneously!
        tile2 = Image.new("RGB", (w * 2, h * 2))
        tile2.paste(a_im, (0, 0))
        tile2.paste(a_im, (w, 0))
        tile2.paste(a_im, (0, h))
        tile2.paste(a_im, (w, h))
        p_albedo = tile2.resize((sz, sz), Image.Resampling.LANCZOS)
        p_normal = Image.fromarray(normal_u8, mode="RGB").resize((sz, sz), Image.Resampling.LANCZOS)
        p_rough = Image.fromarray(rough_u8, mode="L").convert("RGB").resize((sz, sz), Image.Resampling.LANCZOS)
        p_ao = Image.fromarray(ao_u8, mode="L").convert("RGB").resize((sz, sz), Image.Resampling.LANCZOS)

        sheet = Image.new("RGB", (sz * 4, sz + 28), (16, 20, 28))
        sheet.paste(p_albedo, (0, 28))
        sheet.paste(p_normal, (sz, 28))
        sheet.paste(p_rough, (sz * 2, 28))
        sheet.paste(p_ao, (sz * 3, 28))
        draw = ImageDraw.Draw(sheet)
        labels = [f"{profile_name} ALBEDO (2x2)", "NORMAL", "ROUGHNESS (dark=glossy)", "AO"]
        for i, text in enumerate(labels):
            draw.text((i * sz + 10, 8), text, fill=(235, 240, 250))
        sheet.save(qa_sheet_path, format="PNG")

    return {
        kind: {
            "path": str(p),
            "bytes": p.stat().st_size,
            "width": w,
            "height": h,
        }
        for kind, p in paths.items()
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="Source seamless albedo image")
    parser.add_argument("--profile", choices=tuple(PROFILES.keys()), required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--size", type=int, default=1024)
    parser.add_argument("--seamless-blend", action="store_true")
    parser.add_argument("--legacy-copy", type=Path, default=None)
    parser.add_argument("--qa-sheet", type=Path, default=None)
    args = parser.parse_args()

    with Image.open(args.input) as im:
        im = im.convert("RGB").resize((args.size, args.size), Image.Resampling.LANCZOS)
        if args.seamless_blend:
            im = make_seamless_tile_rgb(im, blend_fraction=0.12)
        info = derive_pbr_maps(
            im,
            profile_name=args.profile,
            out_dir=args.out_dir,
            legacy_copy_path=args.legacy_copy,
            qa_sheet_path=args.qa_sheet,
        )
    print(json.dumps(info, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
