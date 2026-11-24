"""Master headless Blender 5.2 build script for all Nachtschicht 3D GLB assets.

Usage:
  /Applications/Blender.app/Contents/MacOS/Blender -b -P tools/blender/build_all.py
"""

from __future__ import annotations

import json
import os
import sys
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
if SCRIPT_DIR not in sys.path:
    sys.path.insert(0, SCRIPT_DIR)

PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
OUT_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "models")

from gen_characters import build_character_crew, build_character_guard, build_character_mara
from gen_environment import build_dresden_pillar, build_palm_tree, build_salou_facade, build_streetlamp
from gen_props import build_display_case, build_power_box, build_safe, build_security_camera
from gen_vehicles import build_getaway_car, build_police_car


def main() -> None:
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)

    builders = [
        ("getaway_car", build_getaway_car),
        ("police_car", build_police_car),
        ("character_mara", build_character_mara),
        ("character_crew", build_character_crew),
        ("character_guard", build_character_guard),
        ("safe", build_safe),
        ("display_case", build_display_case),
        ("power_box", build_power_box),
        ("security_camera", build_security_camera),
        ("palm_tree", build_palm_tree),
        ("streetlamp", build_streetlamp),
        ("salou_facade", build_salou_facade),
        ("dresden_pillar", build_dresden_pillar),
    ]

    models = {}
    total_bytes = 0
    total_tris = 0

    for key, fn in builders:
        print(f"[build_all] Building {key}...")
        meta = fn(OUT_DIR)
        meta["key"] = key
        models[key] = meta
        total_bytes += meta["sizeBytes"]
        total_tris += meta["triangles"]
        d = meta["dimensions"]
        print(
            f"  -> {meta['file']}: {meta['sizeBytes'] / 1024:.1f} KB, "
            f"{meta['triangles']} tris, {d['width']:.2f}x{d['height']:.2f}x{d['depth']:.2f}m, "
            f"subMeshes={meta['subMeshes']}"
        )

    manifest = {
        "schemaVersion": "1.0",
        "project": "Nachtschicht",
        "coordinateSystem": {
            "up": "+Y",
            "forward": "+Z",
            "left": "+X",
            "units": "meters",
            "groundedAtY": 0.0,
        },
        "summary": {
            "modelCount": len(models),
            "totalSizeBytes": total_bytes,
            "totalSizeMB": round(total_bytes / (1024 * 1024), 3),
            "totalTriangles": total_tris,
        },
        "models": models,
    }

    manifest_path = os.path.join(OUT_DIR, "manifest.json")
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
        f.write("\n")

    elapsed = time.time() - t0
    print(
        f"[build_all] DONE: {len(models)} GLBs ({total_bytes / 1024:.1f} KB / "
        f"{total_bytes / (1024 * 1024):.3f} MB, {total_tris} total tris) in {elapsed:.2f}s"
    )
    print(f"[build_all] Manifest written to {manifest_path}")


if __name__ == "__main__":
    main()
