#!/usr/bin/env python3
"""Generate, PBR-derive, optimize, and manifest all Nachtschicht Round-2 photorealistic assets
via the local Codex CLI imagegen skill (gpt-image-2) + NumPy/PIL PBR synthesis."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image

from build_pbr_maps import (
    derive_pbr_maps,
    make_equirectangular_seamless,
    make_seamless_tile_rgb,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_PATH = Path(__file__).resolve().parent / "prompts.json"
CODEX_IMAGES_SCRIPT = Path.home() / ".codex/skills/codex-imagegen-models/scripts/codex_images.py"
DEFAULT_RAW_DIR = Path.home() / ".gemini/antigravity-cli/brain/2c447114-ea8d-4854-8220-5c56aa88fea3/scratch/raw_images_v2"
DEFAULT_QA_DIR = Path.home() / ".gemini/antigravity-cli/brain/2c447114-ea8d-4854-8220-5c56aa88fea3/scratch/qa_v2"
MANIFEST_PATH = REPO_ROOT / "public/assets/images/manifest.json"


def center_crop_resize(img: Image.Image, target_w: int, target_h: int) -> Image.Image:
    """Center-crop to match target aspect ratio cleanly, then high-quality LANCZOS resize."""
    src_w, src_h = img.size
    target_ratio = target_w / target_h
    src_ratio = src_w / src_h

    if abs(src_ratio - target_ratio) > 0.005:
        if src_ratio > target_ratio:
            new_w = int(round(src_h * target_ratio))
            left = (src_w - new_w) // 2
            img = img.crop((left, 0, left + new_w, src_h))
        else:
            new_h = int(round(src_w / target_ratio))
            top = (src_h - new_h) // 2
            img = img.crop((0, top, src_w, top + new_h))

    return img.resize((target_w, target_h), Image.Resampling.LANCZOS)


def call_codex_imagegen(
    key: str,
    prompt: str,
    gen_size: str,
    quality: str,
    model: str,
    raw_path: Path,
    force: bool = False,
) -> Path:
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    if force and raw_path.exists():
        raw_path.unlink()

    if raw_path.exists():
        print(f"[cached raw] {key}: {raw_path}", flush=True)
        return raw_path

    with tempfile.NamedTemporaryFile("w", suffix=".prompt.txt", delete=False, encoding="utf-8") as tf:
        tf.write(prompt)
        prompt_file = Path(tf.name)
    try:
        cmd = [
            sys.executable,
            str(CODEX_IMAGES_SCRIPT),
            "--model",
            model,
            "--prompt-file",
            str(prompt_file),
            "--size",
            gen_size,
            "--quality",
            quality,
            "--out",
            str(raw_path),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"[{key}] codex_images failed: {proc.stderr.strip() or proc.stdout.strip()}")
        print(f"[generated] {key}: {proc.stdout.strip()}", flush=True)
        return raw_path
    finally:
        prompt_file.unlink(missing_ok=True)


def process_cinema_image(item: dict[str, Any], model: str, raw_dir: Path, force: bool) -> str:
    key = item["key"]
    raw_path = call_codex_imagegen(
        key=key,
        prompt=item["prompt"],
        gen_size=item["gen_size"],
        quality=item.get("quality", "high"),
        model=model,
        raw_path=raw_dir / f"{key}.png",
        force=force,
    )
    out_path = REPO_ROOT / item["out"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tw, th = item["target_size"]
    with Image.open(raw_path) as im:
        im = center_crop_resize(im.convert("RGB"), tw, th)
        im.save(out_path, format="WEBP", quality=item.get("webp_quality", 86), method=6)
    kb = out_path.stat().st_size / 1024
    print(f"[cinema] {key} -> {item['out']} ({tw}x{th}, {kb:.1f} KB)", flush=True)
    return key


def process_pbr_material(item: dict[str, Any], model: str, raw_dir: Path, qa_dir: Path, force: bool) -> str:
    key = item["key"]
    raw_path = call_codex_imagegen(
        key=key,
        prompt=item["prompt"],
        gen_size=item["gen_size"],
        quality=item.get("quality", "high"),
        model=model,
        raw_path=raw_dir / f"pbr_{key}.png",
        force=force,
    )
    size = int(item.get("target_size", 1024))
    out_dir = REPO_ROOT / "public/assets/textures"
    legacy_copy = (REPO_ROOT / item["legacy_out"]) if item.get("legacy_out") else None
    qa_sheet = qa_dir / f"pbr_{key}_qa.png"

    with Image.open(raw_path) as im:
        im = center_crop_resize(im.convert("RGB"), size, size)
        if item.get("seamless_blend"):
            im = make_seamless_tile_rgb(im, blend_fraction=0.12)
        maps = derive_pbr_maps(
            im,
            profile_name=key,
            out_dir=out_dir,
            webp_quality=86,
            legacy_copy_path=legacy_copy,
            qa_sheet_path=qa_sheet,
        )
    total_kb = sum(int(m["bytes"]) for m in maps.values()) / 1024
    print(f"[pbr] {key} -> 4 maps ({size}x{size}, {total_kb:.1f} KB total)", flush=True)
    return key


def process_environment(item: dict[str, Any], model: str, raw_dir: Path, qa_dir: Path, force: bool) -> str:
    key = item["key"]
    raw_path = call_codex_imagegen(
        key=key,
        prompt=item["prompt"],
        gen_size=item["gen_size"],
        quality=item.get("quality", "high"),
        model=model,
        raw_path=raw_dir / f"{key}.png",
        force=force,
    )
    tw, th = item["target_size"]
    out_path = REPO_ROOT / item["out"]
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(raw_path) as im:
        im = center_crop_resize(im.convert("RGB"), tw, th)
        im = make_equirectangular_seamless(im, blend_fraction=0.07)
        im.save(out_path, format="WEBP", quality=item.get("webp_quality", 86), method=6)
        # Save horizontal seam-wrap QA preview (shifted by 50% width so the 360 seam is right in the center!)
        qa_dir.mkdir(parents=True, exist_ok=True)
        from PIL import ImageChops
        shifted = ImageChops.offset(im, tw // 2, 0)
        shifted.resize((1024, 512), Image.Resampling.LANCZOS).save(qa_dir / f"{key}_seam_qa.png")

    kb = out_path.stat().st_size / 1024
    print(f"[env] {key} -> {item['out']} ({tw}x{th}, {kb:.1f} KB)", flush=True)
    return key


def build_manifest(spec: dict[str, Any]) -> None:
    assets_map: dict[str, Any] = {}
    images_map: dict[str, str] = {}
    textures_map: dict[str, str] = {}
    pbr_sets: dict[str, Any] = {}
    environments_map: dict[str, Any] = {}

    # 1. Cinema hero, story panels & character portraits
    for item in spec["cinema_images"]:
        p = REPO_ROOT / item["out"]
        if not p.exists():
            raise FileNotFoundError(f"Missing cinema asset: {p}")
        with Image.open(p) as im:
            w, h = im.size
        key = item["key"]
        images_map[key] = item["url"]
        assets_map[key] = {
            "url": item["url"],
            "category": item["category"],
            "width": w,
            "height": h,
            "format": "webp",
            "bytes": p.stat().st_size,
            "tileable": False,
            "usage": item["usage"],
        }

    # 2. Full Photorealistic PBR Material Sets (albedo + normal + roughness + ao)
    for item in spec["pbr_materials"]:
        key = item["key"]
        set_urls: dict[str, Any] = {}
        set_w = set_h = 0
        for kind in ("albedo", "normal", "roughness", "ao"):
            rel_url = f"/assets/textures/{key}_{kind}.webp"
            p = REPO_ROOT / "public" / rel_url.lstrip("/")
            if not p.exists():
                raise FileNotFoundError(f"Missing PBR map: {p}")
            with Image.open(p) as im:
                w, h = im.size
            set_w, set_h = w, h
            set_urls[kind] = rel_url
            assets_map[f"{key}_{kind}"] = {
                "url": rel_url,
                "category": "pbr_texture",
                "mapType": kind,
                "material": key,
                "width": w,
                "height": h,
                "format": "webp",
                "bytes": p.stat().st_size,
                "tileable": True,
                "usage": f"{item['usage']} ({kind} map)",
            }

        pbr_sets[key] = {
            "albedo": set_urls["albedo"],
            "normal": set_urls["normal"],
            "roughness": set_urls["roughness"],
            "ao": set_urls["ao"],
            "width": set_w,
            "height": set_h,
            "tileable": True,
            "materialHint": item.get("materialHint", {}),
            "usage": item["usage"],
        }

        # Preserve backward-compatible `textures[key]` & `assets[key]` pointing to albedo/legacy path
        if item.get("legacy_out"):
            legacy_url = "/" + str(Path(item["legacy_out"]).relative_to("public")).replace("\\", "/")
            legacy_p = REPO_ROOT / item["legacy_out"]
            if legacy_p.exists():
                textures_map[key] = legacy_url
                assets_map[key] = {
                    "url": legacy_url,
                    "category": "texture",
                    "width": set_w,
                    "height": set_h,
                    "format": "webp",
                    "bytes": legacy_p.stat().st_size,
                    "tileable": True,
                    "usage": item["usage"],
                }
        else:
            textures_map[key] = set_urls["albedo"]

    # 3. Preserved standalone textures (blueprint_paper)
    for item in spec.get("keep_textures", []):
        p = REPO_ROOT / item["out"]
        if not p.exists():
            raise FileNotFoundError(f"Missing kept texture: {p}")
        with Image.open(p) as im:
            w, h = im.size
        key = item["key"]
        textures_map[key] = item["url"]
        assets_map[key] = {
            "url": item["url"],
            "category": "texture",
            "width": w,
            "height": h,
            "format": "webp",
            "bytes": p.stat().st_size,
            "tileable": bool(item.get("tileable", True)),
            "usage": item["usage"],
        }

    # 4. Equirectangular Night IBL Environment Maps
    for item in spec["environments"]:
        p = REPO_ROOT / item["out"]
        if not p.exists():
            raise FileNotFoundError(f"Missing environment map: {p}")
        with Image.open(p) as im:
            w, h = im.size
        key = item["key"]
        mkey = item["manifest_key"]
        short_key = mkey.replace("_night", "")
        # Direct string URLs matching src/world/assetLoader.ts ImagesManifest.environments
        environments_map[key] = item["url"]
        environments_map[short_key] = item["url"]
        textures_map[key] = item["url"]
        assets_map[key] = {
            "url": item["url"],
            "category": "environment",
            "projection": "equirectangular",
            "width": w,
            "height": h,
            "format": "webp",
            "bytes": p.stat().st_size,
            "tileable": True,
            "usage": item["usage"],
        }

    # 5. Optional Blender-reusable PBR material sets (kept outside pbrSets so runtime doesn't eagerly download them)
    blender_materials: dict[str, Any] = {}
    for item in spec.get("blender_materials", []):
        key = item["key"]
        albedo_p = REPO_ROOT / f"public/assets/textures/{key}_albedo.webp"
        if not albedo_p.exists():
            continue
        set_urls: dict[str, Any] = {}
        set_w = set_h = 0
        for kind in ("albedo", "normal", "roughness", "ao"):
            rel_url = f"/assets/textures/{key}_{kind}.webp"
            p = REPO_ROOT / "public" / rel_url.lstrip("/")
            if not p.exists():
                continue
            with Image.open(p) as im:
                set_w, set_h = im.size
            set_urls[kind] = rel_url
        if len(set_urls) == 4:
            blender_materials[key] = {
                **set_urls,
                "width": set_w,
                "height": set_h,
                "tileable": True,
                "usage": item["usage"],
            }

    manifest = {
        "version": 2,
        "style": spec["style_bible"]["name"],
        "generatedWith": "codex-cli imagegen (gpt-image-2) + NumPy/PIL PBR synthesis",
        "images": images_map,
        "textures": textures_map,
        "pbrSets": pbr_sets,
        "environments": environments_map,
        "blenderMaterials": blender_materials,
        "assets": assets_map,
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(
        f"[manifest] wrote {MANIFEST_PATH} "
        f"({len(images_map)} cinema images, {len(pbr_sets)} PBR sets, {len(environments_map)} environments)",
        flush=True,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="gpt-image-2", choices=("gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"))
    parser.add_argument("--group", choices=("all", "pbr", "env", "cinema", "blender"), default="all")
    parser.add_argument("--only", nargs="*", help="Filter by specific asset keys")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--qa-dir", type=Path, default=DEFAULT_QA_DIR)
    parser.add_argument("--manifest-only", action="store_true")
    args = parser.parse_args()

    spec = json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))

    if args.manifest_only:
        build_manifest(spec)
        return 0

    only_set = set(args.only) if args.only else None
    jobs: list[tuple[str, dict[str, Any]]] = []

    if args.group in ("all", "pbr"):
        for item in spec["pbr_materials"]:
            if not only_set or item["key"] in only_set:
                jobs.append(("pbr", item))
    if args.group in ("all", "blender"):
        for item in spec.get("blender_materials", []):
            if not only_set or item["key"] in only_set:
                jobs.append(("pbr", item))
    if args.group in ("all", "env"):
        for item in spec["environments"]:
            if not only_set or item["key"] in only_set:
                jobs.append(("env", item))
    if args.group in ("all", "cinema"):
        for item in spec["cinema_images"]:
            if not only_set or item["key"] in only_set:
                jobs.append(("cinema", item))

    if not jobs:
        print("No matching jobs selected.", file=sys.stderr)
        return 1

    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        fut_map = {}
        for kind, item in jobs:
            if kind == "pbr":
                fut = pool.submit(process_pbr_material, item, args.model, args.raw_dir, args.qa_dir, args.force)
            elif kind == "env":
                fut = pool.submit(process_environment, item, args.model, args.raw_dir, args.qa_dir, args.force)
            else:
                fut = pool.submit(process_cinema_image, item, args.model, args.raw_dir, args.force)
            fut_map[fut] = item["key"]

        for fut in concurrent.futures.as_completed(fut_map):
            key = fut_map[fut]
            try:
                fut.result()
            except Exception as exc:
                errors.append(f"{key}: {exc}")
                print(f"[error] {key}: {exc}", file=sys.stderr, flush=True)

    if errors:
        print(f"Completed with {len(errors)} errors:", file=sys.stderr)
        for e in errors:
            print("  -", e, file=sys.stderr)
        return 1

    if args.group == "all" and not only_set:
        build_manifest(spec)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
