#!/usr/bin/env python3
"""Generate, optimize, and manifest all Nachtschicht visual assets via Codex CLI imagegen."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageFilter

REPO_ROOT = Path(__file__).resolve().parents[2]
PROMPTS_PATH = Path(__file__).resolve().parent / "prompts.json"
CODEX_IMAGES_SCRIPT = Path.home() / ".codex/skills/codex-imagegen-models/scripts/codex_images.py"
DEFAULT_RAW_DIR = Path.home() / ".gemini/antigravity-cli/brain/2c447114-ea8d-4854-8220-5c56aa88fea3/scratch/raw_images"
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


def make_seamless_tile(img: Image.Image, blend_fraction: float = 0.14) -> Image.Image:
    """Ensure guaranteed seamless wrapping across X and Y edges via half-shift diamond crossfade."""
    w, h = img.size
    # Shift image by half width & height so original seams move to the center
    shifted = ImageChops.offset(img, w // 2, h // 2)

    # Create a smooth diamond/radial mask that preserves the original interior
    # and blends the shifted version across the center seam cross
    mask = Image.new("L", (w, h), 0)
    pixels = mask.load()
    bw = max(8, int(w * blend_fraction))
    bh = max(8, int(h * blend_fraction))

    for y in range(h):
        dy = min(y, h - 1 - y)
        wy = min(1.0, dy / bh)
        # Smoothstep for invisible gradient transitions
        wy = wy * wy * (3.0 - 2.0 * wy)
        for x in range(w):
            dx = min(x, w - 1 - x)
            wx = min(1.0, dx / bw)
            wx = wx * wx * (3.0 - 2.0 * wx)
            # Inside original image (away from edges): weight ~ 1.0 -> keep img
            # Near original edges (dx or dy small): weight -> 0.0 -> take shifted (which has continuous interior there!)
            pixels[x, y] = int(round(255.0 * wx * wy))

    # Light gaussian soften on mask
    mask = mask.filter(ImageFilter.GaussianBlur(radius=2))
    return Image.composite(img, shifted, mask)


def generate_one(
    asset: dict[str, Any],
    model: str,
    raw_dir: Path,
    force: bool = False,
) -> dict[str, Any]:
    key = asset["key"]
    raw_dir.mkdir(parents=True, exist_ok=True)
    raw_path = raw_dir / f"{key}.png"
    out_path = REPO_ROOT / asset["out"]
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if force and raw_path.exists():
        raw_path.unlink()

    if not raw_path.exists():
        with tempfile.NamedTemporaryFile("w", suffix=".prompt.txt", delete=False, encoding="utf-8") as tf:
            tf.write(asset["prompt"])
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
                asset["gen_size"],
                "--quality",
                asset.get("quality", "medium"),
                "--out",
                str(raw_path),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                raise RuntimeError(f"[{key}] codex_images failed: {proc.stderr.strip() or proc.stdout.strip()}")
            print(f"[generated] {key}: {proc.stdout.strip()}", flush=True)
        finally:
            prompt_file.unlink(missing_ok=True)
    else:
        print(f"[cached raw] {key}: {raw_path}", flush=True)

    # Optimize to target WebP
    with Image.open(raw_path) as im:
        im = im.convert("RGB")
        tw, th = asset["target_size"]
        im = center_crop_resize(im, tw, th)
        if asset.get("seamless_blend"):
            im = make_seamless_tile(im, blend_fraction=0.14)
        im.save(out_path, format="WEBP", quality=asset.get("webp_quality", 85), method=6)

    size_bytes = out_path.stat().st_size
    print(f"[optimized] {key} -> {asset['out']} ({tw}x{th}, {size_bytes/1024:.1f} KB)", flush=True)
    return {
        "key": key,
        "url": asset["url"],
        "category": asset["category"],
        "width": tw,
        "height": th,
        "format": "webp",
        "bytes": size_bytes,
        "tileable": bool(asset.get("seamless", False)),
        "usage": asset["usage"],
    }


def write_manifest(entries: list[dict[str, Any]], style_bible: dict[str, Any]) -> None:
    by_key = {e["key"]: {k: v for k, v in e.items() if k != "key"} for e in entries}
    manifest = {
        "version": 1,
        "style": style_bible["name"],
        "generatedWith": "codex-cli imagegen (gpt-image-2)",
        "assets": by_key,
        "images": {k: v["url"] for k, v in by_key.items() if v["category"] != "texture"},
        "textures": {k: v["url"] for k, v in by_key.items() if v["category"] == "texture"},
    }
    MANIFEST_PATH.parent.mkdir(parents=True, exist_ok=True)
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[manifest] wrote {MANIFEST_PATH} ({len(entries)} assets)", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="gpt-image-2", choices=("gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"))
    parser.add_argument("--only", nargs="*", help="Only generate specific asset keys")
    parser.add_argument("--workers", type=int, default=3, help="Parallel generation workers")
    parser.add_argument("--force", action="store_true", help="Regenerate even if raw PNG exists")
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_DIR)
    parser.add_argument("--manifest-only", action="store_true", help="Rebuild manifest from existing webp files")
    args = parser.parse_args()

    spec = json.loads(PROMPTS_PATH.read_text(encoding="utf-8"))
    assets = spec["assets"]

    if args.manifest_only:
        entries = []
        for a in assets:
            p = REPO_ROOT / a["out"]
            if not p.exists():
                raise FileNotFoundError(f"Missing asset for manifest: {p}")
            with Image.open(p) as im:
                w, h = im.size
            entries.append({
                "key": a["key"],
                "url": a["url"],
                "category": a["category"],
                "width": w,
                "height": h,
                "format": "webp",
                "bytes": p.stat().st_size,
                "tileable": bool(a.get("seamless", False)),
                "usage": a["usage"],
            })
        write_manifest(entries, spec["style_bible"])
        return 0

    selected = [a for a in assets if not args.only or a["key"] in args.only]
    if not selected:
        print("No matching assets selected.", file=sys.stderr)
        return 1

    results: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        fut_map = {
            pool.submit(generate_one, a, args.model, args.raw_dir, args.force): a["key"]
            for a in selected
        }
        for fut in concurrent.futures.as_completed(fut_map):
            key = fut_map[fut]
            try:
                results[key] = fut.result()
            except Exception as exc:
                errors.append(f"{key}: {exc}")
                print(f"[error] {key}: {exc}", file=sys.stderr, flush=True)

    if errors:
        print(f"Completed with {len(errors)} errors.", file=sys.stderr)
        return 1

    # Write manifest if all assets now exist on disk
    all_exist = all((REPO_ROOT / a["out"]).exists() for a in assets)
    if all_exist:
        entries = []
        for a in assets:
            if a["key"] in results:
                entries.append(results[a["key"]])
            else:
                p = REPO_ROOT / a["out"]
                with Image.open(p) as im:
                    w, h = im.size
                entries.append({
                    "key": a["key"],
                    "url": a["url"],
                    "category": a["category"],
                    "width": w,
                    "height": h,
                    "format": "webp",
                    "bytes": p.stat().st_size,
                    "tileable": bool(a.get("seamless", False)),
                    "usage": a["usage"],
                })
        write_manifest(entries, spec["style_bible"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
