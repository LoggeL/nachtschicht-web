"""Pure-Python binary glTF 2.0 (.glb) validator & manifest verifier for Nachtschicht."""

from __future__ import annotations

import json
import math
import os
import struct
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
MODELS_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "models")

REQUIRED_MODELS = {
    "getaway_car.glb": ["Body", "Glass", "Interior", "Headlights", "Taillights", "Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"],
    "police_car.glb": ["Body", "Glass", "Headlights", "Taillights", "Lightbar_Base", "Lightbar_Blue", "Lightbar_Red", "Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"],
    "character_mara.glb": ["Root", "Pelvis", "Torso", "Head", "Arm_L", "Arm_R", "Leg_L", "Leg_R"],
    "character_crew.glb": ["Root", "Pelvis", "Torso", "Backpack", "Head", "Arm_L", "Arm_R", "Leg_L", "Leg_R"],
    "character_guard.glb": ["Root", "Pelvis", "Torso", "Head", "Arm_L", "Arm_R", "Flashlight", "Leg_L", "Leg_R"],
    "safe.glb": ["Safe_Body", "Safe_Loot", "Safe_Door", "Safe_Dial", "Safe_LED"],
    "display_case.glb": ["Pedestal", "Glass_Hood", "Artifact"],
    "power_box.glb": ["Box_Body", "Box_Door", "Breaker_Lever", "Status_LED"],
    "security_camera.glb": ["Camera_Mount", "Camera_Head", "Camera_LED"],
    "palm_tree.glb": ["Trunk", "Canopy"],
    "streetlamp.glb": ["Lamp_Post", "Lamp_Glow"],
    "salou_facade.glb": ["Facade_Wall", "Balcony", "Awning", "Windows_Warm", "Neon_Sign"],
    "dresden_pillar.glb": ["Sandstone_Column", "Gold_Trim", "Sconce_Glow"],
}


def mat4_identity():
    return [
        [1, 0, 0, 0],
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
    ]


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


def verify_glb(filepath: str, expected_nodes: list[str]) -> tuple[bool, list[str], dict]:
    errors: list[str] = []
    if not os.path.exists(filepath):
        return False, [f"Missing file: {filepath}"], {}

    file_size = os.path.getsize(filepath)
    with open(filepath, "rb") as f:
        data = f.read()

    if len(data) < 20:
        return False, ["File too small to be a valid GLB"], {}

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
    json_bytes = data[20 : 20 + chunk0_len]
    try:
        gltf = json.loads(json_bytes.decode("utf-8"))
    except Exception as exc:
        return False, errors + [f"JSON parse failed: {exc}"], {}

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

    if not meshes:
        errors.append("No meshes in GLB")
    if not materials:
        errors.append("No materials in GLB")

    node_names = {n.get("name") for n in nodes}
    for req in expected_nodes:
        if req not in node_names:
            errors.append(f"Missing required node/sub-mesh '{req}' (found: {sorted(x for x in node_names if x)})")

    # Compute world transforms & exact AABB from glTF position accessors
    parent_map = {}
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
    prim_count = 0
    for idx, n in enumerate(nodes):
        if "mesh" not in n:
            continue
        wm = world_mat(idx)
        mesh = meshes[n["mesh"]]
        for prim in mesh.get("primitives", []):
            prim_count += 1
            attrs = prim.get("attributes", {})
            if "POSITION" not in attrs:
                errors.append(f"Mesh {mesh.get('name')} primitive missing POSITION")
                continue
            if "NORMAL" not in attrs:
                errors.append(f"Mesh {mesh.get('name')} primitive missing NORMAL")
            pos_acc = accessors[attrs["POSITION"]]
            if pos_acc.get("count", 0) == 0:
                errors.append(f"Mesh {mesh.get('name')} has 0 vertices")
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

    if prim_count == 0:
        errors.append("Zero mesh primitives found")

    if abs(min_v[1]) > 0.02:
        errors.append(f"Model not grounded at y=0 (min_y = {min_v[1]:.4f})")

    info = {
        "sizeBytes": file_size,
        "meshes": len(meshes),
        "primitives": prim_count,
        "materials": len(materials),
        "nodes": sorted(x for x in node_names if x),
        "minY": round(min_v[1], 4),
        "dims": [round(max_v[i] - min_v[i], 3) for i in range(3)],
    }
    return len(errors) == 0, errors, info


def main() -> int:
    manifest_path = os.path.join(MODELS_DIR, "manifest.json")
    if not os.path.exists(manifest_path):
        print(f"FAIL: missing {manifest_path}")
        return 1

    with open(manifest_path, "r", encoding="utf-8") as f:
        manifest = json.load(f)

    total_bytes = 0
    all_ok = True
    for filename, req_nodes in REQUIRED_MODELS.items():
        path = os.path.join(MODELS_DIR, filename)
        ok, errs, info = verify_glb(path, req_nodes)
        total_bytes += info.get("sizeBytes", 0)
        status = "PASS" if ok else "FAIL"
        dims = info.get("dims", [0, 0, 0])
        print(
            f"[{status}] {filename:22s} | {info.get('sizeBytes', 0)/1024:6.1f} KB | "
            f"meshes={info.get('meshes',0):2d} mats={info.get('materials',0):2d} | "
            f"minY={info.get('minY', 0):+.4f} | WxHxD={dims[0]:.2f}x{dims[1]:.2f}x{dims[2]:.2f}m"
        )
        if not ok:
            all_ok = False
            for e in errs:
                print(f"   ERROR: {e}")

    total_mb = total_bytes / (1024 * 1024)
    print(f"\nTotal payload: {total_bytes / 1024:.1f} KB ({total_mb:.3f} MB) across {len(REQUIRED_MODELS)} GLBs")
    if total_mb > 6.0:
        print(f"FAIL: total payload {total_mb:.3f} MB exceeds 6 MB budget")
        all_ok = False

    manifest_models = manifest.get("models", {})
    if len(manifest_models) != len(REQUIRED_MODELS):
        print(f"FAIL: manifest has {len(manifest_models)} entries, expected {len(REQUIRED_MODELS)}")
        all_ok = False

    return 0 if all_ok else 1


if __name__ == "__main__":
    sys.exit(main())
