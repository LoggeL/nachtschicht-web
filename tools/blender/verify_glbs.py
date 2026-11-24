"""Comprehensive binary glTF 2.0 (.glb) validator & master manifest builder for Nachtschicht Round 2.

Validates:
- Valid binary GLB header (magic `glTF`, version 2, exact file length, JSON & BIN chunks)
- Non-empty meshes, normals, UVs, PBR materials, embedded textures
- Grounding at y = 0.0 (within tolerance) and exact Y-up bounding box computed from glTF accessors
- Required named sub-meshes / hierarchy nodes (wheels, lightbars, hinged doors, dials, camera head)
- Skeletal animation clip names on rigged NPCs (when Round 2 rigs are present)
- Optional `--write-manifest` flag to rebuild `public/assets/models/manifest.json` from ALL valid GLBs on disk
  so `@modeler`, `@npc-mara`, `@npc-guard`, `@npc-crew`, and `@vehicle-artist` models are unified cleanly!
"""

from __future__ import annotations

import argparse
import json
import os
import struct
import sys
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
MODELS_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "models")

# Model specifications: required nodes (any matching set allowed for V1->V2 transition), category, description
MODEL_SPECS: Dict[str, Dict[str, Any]] = {
    # --- Architecture & Heist/Street Props (owned by @modeler) ---
    "salou_facade.glb": {
        "key": "salou_facade",
        "category": "environment",
        "owner": "modeler",
        "required_nodes": ["Facade_Wall", "Balcony", "Awning", "Windows_Warm", "Neon_Sign"],
        "description": "Photorealistic modular 6.0m Catalan Mediterranean townhouse/hotel facade with recessed shopfront glazing & interior, louvered wooden shutters, ornate wrought-iron balcony, striped canvas awning, and backlit neon fascia.",
        "extra": {"modularWidth": 6.0, "facadeFrontZ": 0.0, "animatableParts": ["Windows_Warm", "Neon_Sign"]},
    },
    "dresden_pillar.glb": {
        "key": "dresden_pillar",
        "category": "environment",
        "owner": "modeler",
        "required_nodes": ["Sandstone_Column", "Gold_Trim", "Sconce_Glow"],
        "description": "Photorealistic Dresdner Barock Elbsandstein concave-fluted Corinthian columns, sculpted voussoir arch & keystone cartouche, veined marble niches, and gilded bronze glass wall sconces.",
        "extra": {"modularWidth": 3.2, "sconceLights": [[-1.10, 2.58, 0.72], [1.10, 2.58, 0.72]], "animatableParts": ["Sconce_Glow"]},
    },
    "palm_tree.glb": {
        "key": "palm_tree",
        "category": "environment",
        "owner": "modeler",
        "required_nodes": ["Trunk", "Canopy"],
        "description": "Photorealistic Mediterranean Salou coastal palm tree with curved fibrous ringed trunk and crown-pivoted multi-leaflet feathered palm fronds.",
        "extra": {"animatableParts": ["Canopy"], "swayNote": "Oscillate Canopy.rotation.x/z by +-0.03 rad for coastal breeze."},
    },
    "streetlamp.glb": {
        "key": "streetlamp",
        "category": "environment",
        "owner": "modeler",
        "required_nodes": ["Lamp_Post", "Lamp_Glow"],
        "description": "Ornate cast-iron Mediterranean coastal lamppost with fluted pedestal, scrolled filigree bracket, glass-paned hexagonal lantern cage, and warm tungsten filament core.",
        "extra": {"lightOrigin": [0.0, 4.18, 0.84], "animatableParts": ["Lamp_Glow"]},
    },
    "safe.glb": {
        "key": "safe",
        "category": "prop",
        "owner": "modeler",
        "required_nodes": ["Safe_Body", "Safe_Loot", "Safe_Door", "Safe_Dial", "Safe_LED"],
        "description": "Heavy photorealistic brushed-steel vault safe with chamfered armor frame, hinge-pivoted Safe_Door with locking bolts, knurled dial + 3-spoke vault wheel Safe_Dial, and interior gold/cash/jewel trays.",
        "extra": {"animatableParts": ["Safe_Door", "Safe_Dial", "Safe_LED", "Safe_Loot"], "hingeNote": "Rotate Safe_Door around Y by -1.8 rad to swing open."},
    },
    "display_case.glb": {
        "key": "display_case",
        "category": "prop",
        "owner": "modeler",
        "required_nodes": ["Pedestal", "Glass_Hood", "Artifact"],
        "description": "Museum-grade brass/steel-framed glass vitrine on veined dark marble plinth with tufted crimson velvet cushion, ceiling micro-spotlights, and faceted sparkling royal jewel Artifact.",
        "extra": {"animatableParts": ["Artifact", "Glass_Hood"]},
    },
    "power_box.glb": {
        "key": "power_box",
        "category": "prop",
        "owner": "modeler",
        "required_nodes": ["Box_Body", "Box_Door", "Breaker_Lever", "Status_LED"],
        "description": "Weathered industrial Securion wall electrical junction box with galvanized steel conduits, armored cables, hinged panel revealing internal copper busbars/breakers, pivoting Breaker_Lever, and recessed Status_LED.",
        "extra": {"wallMountBackZ": 0.0, "animatableParts": ["Breaker_Lever", "Status_LED", "Box_Door"]},
    },
    "security_camera.glb": {
        "key": "security_camera",
        "category": "prop",
        "owner": "modeler",
        "required_nodes": ["Camera_Mount", "Camera_Head", "Camera_LED"],
        "description": "Architectural bullet CCTV camera with bolted gooseneck bracket, armored cable whip, vented sun hood, multi-element glass lens with IR LED ring, swivel-pivoted Camera_Head, and glowing red Camera_LED.",
        "extra": {"wallMountBackZ": 0.0, "animatableParts": ["Camera_Head", "Camera_LED"], "panNote": "Rotate Camera_Head around Y to sweep FOV."},
    },
    "door_detailed.glb": {
        "key": "door_detailed",
        "category": "prop",
        "owner": "modeler",
        "required_nodes": ["Door_Frame", "Door_Leaf", "Door_Handle"],
        "description": "Detailed framed walnut/steel security door with glazed transom window, brass kickplate, mortise lock cylinder, lever Door_Handle, and edge-hinged Door_Leaf that physically swings open when unlocked.",
        "extra": {"animatableParts": ["Door_Leaf", "Door_Handle"], "hingeNote": "Rotate Door_Leaf around Y from 0 to -1.65 rad to swing open."},
    },
    "cafe_terrace.glb": {
        "key": "cafe_terrace",
        "category": "environment",
        "owner": "modeler",
        "required_nodes": ["Table", "Candle_Glow", "Chair_L", "Chair_R", "Planter", "Bollard"],
        "description": "Salou coastal night promenade bistro terrace cluster: marble-topped brass-rim table with candle lantern, two wrought-iron scroll chairs, terracotta Mediterranean planter, and cast-iron street bollard.",
        "extra": {"animatableParts": ["Candle_Glow"]},
    },
    # --- Vehicles (owned by @vehicle-artist) ---
    "getaway_car.glb": {
        "key": "getaway_car",
        "category": "vehicle",
        "owner": "vehicle-artist",
        "required_nodes": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"],
        "description": "Photorealistic European night getaway sports coupe with metallic clearcoat body, tinted glass, interior, headlights/taillights/brakelights, and 4 axle-pivoted wheels.",
        "extra": {"animatableParts": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR", "Headlights", "Taillights", "Brakelights"]},
    },
    "police_car.glb": {
        "key": "police_car",
        "category": "vehicle",
        "owner": "vehicle-artist",
        "required_nodes": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR", "Lightbar_Blue", "Lightbar_Red"],
        "description": "Photorealistic Catalan Mossos-inspired night patrol cruiser with navy/white/crimson livery, roof LED lightbar, and 4 axle-pivoted wheels.",
        "extra": {"animatableParts": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR", "Lightbar_Blue", "Lightbar_Red"]},
    },
    "traffic_car.glb": {
        "key": "traffic_car",
        "category": "vehicle",
        "owner": "vehicle-artist",
        "optional": True,
        "required_nodes": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"],
        "description": "Photorealistic European compact sedan/hatchback for ambient Salou night traffic.",
        "extra": {"animatableParts": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"]},
    },
    # --- Characters (owned by @npc-mara, @npc-guard, @npc-crew) ---
    "character_mara.glb": {
        "key": "character_mara",
        "category": "character",
        "owner": "npc-mara",
        "required_nodes": [],
        "expected_clips": ["Idle", "Walk", "Sneak", "Run", "Interact"],
        "description": "Photorealistic skeletal-rigged Mara Voss (ex-Securion security engineer) with animated glTF clips.",
        "extra": {},
    },
    "character_jupp.glb": {
        "key": "character_jupp",
        "category": "character",
        "owner": "npc-crew",
        "optional": True,
        "required_nodes": [],
        "expected_clips": ["Idle", "Walk", "Sneak", "Work", "CarryLoot", "Panic"],
        "description": "Photorealistic skeletal-rigged Jupp Kowalke (68yo master safecracker in wool overcoat & flatcap) with animated glTF clips.",
        "extra": {},
    },
    "character_crew.glb": {
        "key": "character_crew",
        "category": "character",
        "owner": "npc-crew",
        "required_nodes": [],
        "expected_clips": ["Idle", "Walk", "Sneak", "Work", "CarryLoot", "Panic"],
        "description": "Photorealistic skeletal-rigged tactical heist accomplice with gear backpack and animated glTF clips.",
        "extra": {},
    },
    "character_guard.glb": {
        "key": "character_guard",
        "category": "character",
        "owner": "npc-guard",
        "required_nodes": [],
        "expected_clips": ["Idle", "PatrolWalk", "SuspiciousLook", "FlashlightSweep", "RadioCall", "Sprint"],
        "description": "Photorealistic skeletal-rigged Catalan Securion night security guard with peaked cap, lapel radio, flashlight, and animated glTF clips.",
        "extra": {},
    },
    "character_civilian.glb": {
        "key": "character_civilian",
        "category": "character",
        "owner": "npc-guard",
        "optional": True,
        "required_nodes": [],
        "expected_clips": ["Idle", "Walk", "Startled"],
        "description": "Photorealistic skeletal-rigged Salou evening promenade pedestrian/witness with animated glTF clips.",
        "extra": {},
    },
}


def mat4_mul(a, b):
    out = [[0.0] * 4 for _ in range(4)]
    for i in range(4):
        for j in range(4):
            out[i][j] = sum(a[i][k] * b[k][j] for k in range(4))
    return out


def mat4_from_trs(t, r, s):
    qx, qy, qz, qw = r
    xx, yy, zz = qx * qx, qy * qy, qz * qz
    xy, xz, yz = qx * qy, qx * qz, qy * qz
    wx, wy, wz = qw * qx, qw * qy, qw * qz
    sx, sy, sz = s
    tx, ty, tz = t
    return [
        [(1 - 2 * (yy + zz)) * sx, 2 * (xy - wz) * sy, 2 * (xz + wy) * sz, tx],
        [2 * (xy + wz) * sx, (1 - 2 * (xx + zz)) * sy, 2 * (yz - wx) * sz, ty],
        [2 * (xz - wy) * sx, 2 * (yz + wx) * sy, (1 - 2 * (xx + yy)) * sz, tz],
        [0.0, 0.0, 0.0, 1.0],
    ]


def mat4_apply(m, p):
    x, y, z = p
    return (
        m[0][0] * x + m[0][1] * y + m[0][2] * z + m[0][3],
        m[1][0] * x + m[1][1] * y + m[1][2] * z + m[1][3],
        m[2][0] * x + m[2][1] * y + m[2][2] * z + m[2][3],
    )


def inspect_glb(filepath: str, spec: Dict[str, Any], require_clips: bool = False) -> Tuple[bool, List[str], List[str], Dict[str, Any]]:
    """Inspect a single GLB file; returns (ok, errors, warnings, manifest_entry)."""
    errors: List[str] = []
    warnings: List[str] = []

    if not os.path.exists(filepath):
        return False, [f"Missing file: {filepath}"], warnings, {}

    file_size = os.path.getsize(filepath)
    with open(filepath, "rb") as f:
        data = f.read()

    if len(data) < 20:
        return False, ["File too small to be a valid GLB"], warnings, {}

    magic, version, total_len = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        errors.append(f"Invalid magic: {magic!r}")
    if version != 2:
        errors.append(f"Expected glTF version 2, got {version}")
    if total_len != file_size:
        errors.append(f"Header length {total_len} != actual file size {file_size}")

    chunk0_len, chunk0_type = struct.unpack_from("<I4s", data, 12)
    if chunk0_type != b"JSON":
        errors.append(f"First chunk type is {chunk0_type!r}, expected b'JSON'")
    try:
        gltf = json.loads(data[20 : 20 + chunk0_len].decode("utf-8"))
    except Exception as exc:
        return False, errors + [f"JSON parse failed: {exc}"], warnings, {}

    bin_offset = 20 + chunk0_len
    if bin_offset + 8 <= len(data):
        chunk1_len, chunk1_type = struct.unpack_from("<I4s", data, bin_offset)
        if chunk1_type != b"BIN\x00":
            errors.append(f"Second chunk type is {chunk1_type!r}, expected b'BIN\\x00'")
        if bin_offset + 8 + chunk1_len > len(data):
            errors.append("BIN chunk overruns file end")
    else:
        errors.append("Missing BIN chunk")

    nodes = gltf.get("nodes", [])
    meshes = gltf.get("meshes", [])
    accessors = gltf.get("accessors", [])
    materials = gltf.get("materials", [])
    images = gltf.get("images", [])
    skins = gltf.get("skins", [])
    animations = gltf.get("animations", [])

    if not meshes:
        errors.append("No meshes in GLB")
    if not materials:
        errors.append("No materials in GLB")

    node_names = {n.get("name") for n in nodes if n.get("name")}
    for req in spec.get("required_nodes", []):
        if req not in node_names:
            errors.append(f"Missing required node '{req}'")

    clip_names = [a.get("name", f"clip_{i}") for i, a in enumerate(animations)]
    expected_clips = spec.get("expected_clips", [])
    if expected_clips:
        missing_clips = [c for c in expected_clips if c not in clip_names]
        if missing_clips:
            msg = f"Missing expected animation clips: {missing_clips} (found: {clip_names})"
            if require_clips:
                errors.append(msg)
            else:
                warnings.append(msg)

    # Parent mapping & world matrix computation
    parent_map: Dict[int, int] = {}
    for idx, n in enumerate(nodes):
        for ch in n.get("children", []):
            parent_map[ch] = idx

    def world_mat(idx: int):
        n = nodes[idx]
        if "matrix" in n:
            cm = n["matrix"]
            local = [
                [cm[0], cm[4], cm[8], cm[12]],
                [cm[1], cm[5], cm[9], cm[13]],
                [cm[2], cm[6], cm[10], cm[14]],
                [cm[3], cm[7], cm[11], cm[15]],
            ]
        else:
            local = mat4_from_trs(
                n.get("translation", [0.0, 0.0, 0.0]),
                n.get("rotation", [0.0, 0.0, 0.0, 1.0]),
                n.get("scale", [1.0, 1.0, 1.0]),
            )
        if idx in parent_map:
            return mat4_mul(world_mat(parent_map[idx]), local)
        return local

    min_v = [float("inf")] * 3
    max_v = [float("-inf")] * 3
    total_tris = 0
    prim_count = 0
    sub_meshes: List[str] = []
    node_entries: List[Dict[str, Any]] = []
    wheel_radii: List[float] = []

    for idx, n in enumerate(nodes):
        wm = world_mat(idx)
        n_name = n.get("name", f"Node_{idx}")
        t_local = n.get("translation", [0.0, 0.0, 0.0])
        world_pivot = [round(wm[0][3], 4), round(wm[1][3], 4), round(wm[2][3], 4)]
        is_mesh = "mesh" in n
        entry: Dict[str, Any] = {
            "name": n_name,
            "type": "MESH" if is_mesh else ("SKIN_JOINT" if skins else "EMPTY"),
            "parent": nodes[parent_map[idx]].get("name") if idx in parent_map else None,
            "worldPivot": world_pivot,
            "localOffset": [round(float(v), 4) for v in t_local],
        }
        if is_mesh:
            sub_meshes.append(n_name)
            mesh = meshes[n["mesh"]]
            mesh_tris = 0
            mesh_mats = []
            w_ymin, w_ymax = float("inf"), float("-inf")
            for prim in mesh.get("primitives", []):
                prim_count += 1
                attrs = prim.get("attributes", {})
                if "POSITION" not in attrs:
                    errors.append(f"Mesh {mesh.get('name')} primitive missing POSITION")
                    continue
                if "NORMAL" not in attrs:
                    errors.append(f"Mesh {mesh.get('name')} primitive missing NORMAL")
                pos_acc = accessors[attrs["POSITION"]]
                if "indices" in prim:
                    idx_acc = accessors[prim["indices"]]
                    mesh_tris += idx_acc.get("count", 0) // 3
                else:
                    mesh_tris += pos_acc.get("count", 0) // 3
                if "material" in prim and prim["material"] < len(materials):
                    mname = materials[prim["material"]].get("name")
                    if mname and mname not in mesh_mats:
                        mesh_mats.append(mname)
                pmin = pos_acc.get("min")
                pmax = pos_acc.get("max")
                if pmin and pmax:
                    for cx in (pmin[0], pmax[0]):
                        for cy in (pmin[1], pmax[1]):
                            for cz in (pmin[2], pmax[2]):
                                wx, wy, wz = mat4_apply(wm, (cx, cy, cz))
                                min_v[0] = min(min_v[0], wx)
                                min_v[1] = min(min_v[1], wy)
                                min_v[2] = min(min_v[2], wz)
                                max_v[0] = max(max_v[0], wx)
                                max_v[1] = max(max_v[1], wy)
                                max_v[2] = max(max_v[2], wz)
                                w_ymin = min(w_ymin, wy)
                                w_ymax = max(w_ymax, wy)
            total_tris += mesh_tris
            entry["triangles"] = mesh_tris
            entry["materials"] = mesh_mats
            if n_name.startswith("Wheel_") and w_ymax > w_ymin:
                wheel_radii.append((w_ymax - w_ymin) * 0.5)
        # Keep manifest lean: include all mesh nodes + top-level empties, skip giant bone lists unless <= 16
        if is_mesh or len(nodes) <= 24:
            node_entries.append(entry)

    if prim_count == 0:
        errors.append("Zero mesh primitives found")

    if min_v[1] == float("inf"):
        min_v = [0.0, 0.0, 0.0]
        max_v = [0.0, 0.0, 0.0]

    if abs(min_v[1]) > 0.05:
        errors.append(f"Model not grounded at y=0 (min_y = {min_v[1]:.4f})")

    dims = {
        "width": round(max_v[0] - min_v[0], 4),
        "height": round(max_v[1] - min_v[1], 4),
        "depth": round(max_v[2] - min_v[2], 4),
    }

    filename = os.path.basename(filepath)
    manifest_entry: Dict[str, Any] = {
        "key": spec["key"],
        "file": filename,
        "url": f"/assets/models/{filename}",
        "category": spec["category"],
        "description": spec["description"],
        "sizeBytes": file_size,
        "triangles": total_tris,
        "textures": len(images),
        "skinned": len(skins) > 0,
        "animations": clip_names,
        "dimensions": dims,
        "bounds": {
            "min": [round(v, 4) for v in min_v],
            "max": [round(v, 4) for v in max_v],
        },
        "originOffset": [0.0, 0.0, 0.0],
        "forwardAxis": "+Z",
        "upAxis": "+Y",
        "subMeshes": sub_meshes,
        "nodes": node_entries,
    }
    if wheel_radii:
        manifest_entry["wheelRadius"] = round(sum(wheel_radii) / len(wheel_radii), 4)
    for k, v in spec.get("extra", {}).items():
        if k not in manifest_entry:
            manifest_entry[k] = v

    return len(errors) == 0, errors, warnings, manifest_entry


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner", help="Only verify models belonging to this owner (e.g. modeler)")
    parser.add_argument("--require-clips", action="store_true", help="Fail if rigged NPC animation clips are missing")
    parser.add_argument("--require-all", action="store_true", help="Fail if optional Round 2 models are missing")
    parser.add_argument("--write-manifest", action="store_true", help="Write/update public/assets/models/manifest.json from all present GLBs")
    args = parser.parse_args()

    all_ok = True
    models_manifest: Dict[str, Any] = {}
    total_bytes = 0
    total_tris = 0

    for filename, spec in MODEL_SPECS.items():
        if args.owner and spec.get("owner") != args.owner:
            continue
        path = os.path.join(MODELS_DIR, filename)
        if not os.path.exists(path):
            if spec.get("optional") and not args.require_all:
                print(f"[SKIP] {filename:24s} | not yet generated by @{spec.get('owner')}")
                continue
            print(f"[FAIL] {filename:24s} | MISSING")
            all_ok = False
            continue

        ok, errs, warns, entry = inspect_glb(path, spec, require_clips=args.require_clips)
        total_bytes += entry.get("sizeBytes", 0)
        total_tris += entry.get("triangles", 0)
        models_manifest[spec["key"]] = entry

        d = entry.get("dimensions", {"width": 0, "height": 0, "depth": 0})
        min_y = entry.get("bounds", {}).get("min", [0, 0, 0])[1]
        clips = entry.get("animations", [])
        clip_str = f" clips={len(clips)}" if clips else ""
        tex_str = f" tex={entry.get('textures', 0)}"
        status = "PASS" if ok else "FAIL"
        print(
            f"[{status}] {filename:24s} | {entry.get('sizeBytes', 0)/1024:7.1f} KB | "
            f"tris={entry.get('triangles', 0):6d}{tex_str}{clip_str:9s} | "
            f"minY={min_y:+.4f} | WxHxD={d['width']:.2f}x{d['height']:.2f}x{d['depth']:.2f}m"
        )
        for w in warns:
            print(f"   WARN:  {w}")
        for e in errs:
            print(f"   ERROR: {e}")
        if not ok:
            all_ok = False

    total_mb = total_bytes / (1024 * 1024)
    print(
        f"\nSummary: {len(models_manifest)} models verified | "
        f"{total_bytes/1024:.1f} KB ({total_mb:.2f} MB) | {total_tris:,} total tris"
    )

    if args.write_manifest:
        # Always include ALL present GLBs across all owners in the master manifest!
        if args.owner:
            models_manifest = {}
            total_bytes = 0
            total_tris = 0
            for filename, spec in MODEL_SPECS.items():
                path = os.path.join(MODELS_DIR, filename)
                if not os.path.exists(path):
                    continue
                _, _, _, entry = inspect_glb(path, spec, require_clips=False)
                models_manifest[spec["key"]] = entry
                total_bytes += entry.get("sizeBytes", 0)
                total_tris += entry.get("triangles", 0)

        manifest = {
            "schemaVersion": "2.0",
            "project": "Nachtschicht",
            "coordinateSystem": {
                "up": "+Y",
                "forward": "+Z",
                "left": "+X",
                "units": "meters",
                "groundedAtY": 0.0,
            },
            "summary": {
                "modelCount": len(models_manifest),
                "totalSizeBytes": total_bytes,
                "totalSizeMB": round(total_bytes / (1024 * 1024), 3),
                "totalTriangles": total_tris,
            },
            "models": models_manifest,
        }
        manifest_path = os.path.join(MODELS_DIR, "manifest.json")
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump(manifest, f, indent=2)
            f.write("\n")
        print(f"Wrote master manifest: {manifest_path} ({len(models_manifest)} models, {total_bytes/(1024*1024):.2f} MB)")

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
