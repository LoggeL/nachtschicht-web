"""Render a headless Blender 5.2 visual contact sheet of all 13 Nachtschicht GLB models.

Saves output strictly outside `public/` (pass output path via `-- <out_png>`).
"""

from __future__ import annotations

import math
import os
import sys

import bpy
from mathutils import Vector

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(SCRIPT_DIR, "..", ".."))
MODELS_DIR = os.path.join(PROJECT_ROOT, "public", "assets", "models")

MODEL_FILES = [
    "getaway_car.glb",
    "police_car.glb",
    "character_mara.glb",
    "character_crew.glb",
    "character_guard.glb",
    "safe.glb",
    "display_case.glb",
    "power_box.glb",
    "security_camera.glb",
    "palm_tree.glb",
    "streetlamp.glb",
    "salou_facade.glb",
    "dresden_pillar.glb",
]


def setup_studio(scene: bpy.types.Scene) -> None:
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 384
    scene.render.resolution_y = 384
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.view_settings.view_transform = "AgX"

    # Mediterranean night-noir moody studio backdrop
    world = bpy.data.worlds.new("StudioWorld")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.025, 0.038, 0.065, 1.0)
        bg.inputs["Strength"].default_value = 0.85

    # Ground disc (subtle dark wet slate floor to verify grounding at y=0!)
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=18.0, depth=0.04, location=(0.0, 0.0, -0.02))
    floor = bpy.context.active_object
    fmat = bpy.data.materials.new("StudioFloor")
    bsdf = fmat.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (0.045, 0.055, 0.075, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.48
    floor.data.materials.append(fmat)

    # Key light (warm Mediterranean sodium-amber 3/4 front-left)
    key_data = bpy.data.lights.new("KeyLight", type="SUN")
    key_data.energy = 3.2
    key_data.color = (1.0, 0.86, 0.68)
    key_obj = bpy.data.objects.new("KeyLight", key_data)
    scene.collection.objects.link(key_obj)
    key_obj.rotation_euler = (math.radians(52), math.radians(-18), math.radians(-38))

    # Cool moonlight rim/fill from back-right
    rim_data = bpy.data.lights.new("RimLight", type="SUN")
    rim_data.energy = 1.6
    rim_data.color = (0.55, 0.78, 1.0)
    rim_obj = bpy.data.objects.new("RimLight", rim_data)
    scene.collection.objects.link(rim_obj)
    rim_obj.rotation_euler = (math.radians(40), math.radians(15), math.radians(145))

    # Front soft fill so faces/details are never crushed in shadow
    fill_data = bpy.data.lights.new("FillLight", type="SUN")
    fill_data.energy = 1.0
    fill_data.color = (0.85, 0.90, 1.0)
    fill_obj = bpy.data.objects.new("FillLight", fill_data)
    scene.collection.objects.link(fill_obj)
    fill_obj.rotation_euler = (math.radians(65), 0.0, math.radians(25))


def render_single(glb_path: str, out_png: str) -> None:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    setup_studio(scene)

    before = set(bpy.context.scene.objects)
    bpy.ops.import_scene.gltf(filepath=glb_path)
    imported = [o for o in bpy.context.scene.objects if o not in before]

    # Measure imported bounding box
    bpy.context.view_layer.update()
    mn = Vector((1e9, 1e9, 1e9))
    mx = Vector((-1e9, -1e9, -1e9))
    for obj in imported:
        if obj.type != "MESH":
            continue
        for corner in obj.bound_box:
            w = obj.matrix_world @ Vector(corner)
            mn.x = min(mn.x, w.x)
            mn.y = min(mn.y, w.y)
            mn.z = min(mn.z, w.z)
            mx.x = max(mx.x, w.x)
            mx.y = max(mx.y, w.y)
            mx.z = max(mx.z, w.z)

    center = (mn + mx) * 0.5
    size = mx - mn
    radius = max(size.length * 0.52, 0.25)

    # Place camera at flattering front-left 3/4 view (front is -Y in Blender!)
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.lens = 42.0
    cam_obj = bpy.data.objects.new("Cam", cam_data)
    scene.collection.objects.link(cam_obj)
    scene.camera = cam_obj

    az = math.radians(-34)  # slightly from front-left (+X, -Y)
    el = math.radians(20)
    dist = radius * 2.85
    cam_dir = Vector((-math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    cam_obj.location = center + cam_dir * dist

    look_vec = center - cam_obj.location
    cam_obj.rotation_euler = look_vec.to_track_quat("-Z", "Y").to_euler()

    scene.render.filepath = out_png
    bpy.ops.render.render(write_still=True)


def stitch_contact_sheet(tile_paths: list[str], out_path: str, cols: int = 4) -> None:
    """Stitch rendered tiles into a single PNG using Blender's built-in image API."""
    tile_w, tile_h = 384, 384
    rows = math.ceil(len(tile_paths) / cols)
    sheet_w = cols * tile_w
    sheet_h = rows * tile_h

    sheet = bpy.data.images.new("ContactSheet", width=sheet_w, height=sheet_h, alpha=False)
    buf = [0.02, 0.03, 0.05, 1.0] * (sheet_w * sheet_h)

    for idx, p in enumerate(tile_paths):
        img = bpy.data.images.load(p)
        px = list(img.pixels)
        col = idx % cols
        row = rows - 1 - (idx // cols)  # Blender image origin is bottom-left
        x0 = col * tile_w
        y0 = row * tile_h
        for y in range(tile_h):
            src_start = y * tile_w * 4
            dst_start = ((y0 + y) * sheet_w + x0) * 4
            buf[dst_start : dst_start + tile_w * 4] = px[src_start : src_start + tile_w * 4]
        bpy.data.images.remove(img)

    sheet.pixels.foreach_set(buf)
    sheet.filepath_raw = out_path
    sheet.file_format = "PNG"
    sheet.save()


def main() -> None:
    argv = sys.argv
    out_sheet = "/tmp/nachtschicht_contact_sheet.png"
    if "--" in argv:
        idx = argv.index("--")
        if idx + 1 < len(argv):
            out_sheet = argv[idx + 1]

    out_dir = os.path.dirname(out_sheet)
    os.makedirs(out_dir, exist_ok=True)
    tmp_dir = os.path.join(out_dir, "_preview_tiles")
    os.makedirs(tmp_dir, exist_ok=True)

    tiles = []
    for fname in MODEL_FILES:
        glb_path = os.path.join(MODELS_DIR, fname)
        tile_png = os.path.join(tmp_dir, fname.replace(".glb", ".png"))
        print(f"[render_preview] Rendering {fname}...")
        render_single(glb_path, tile_png)
        tiles.append(tile_png)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    stitch_contact_sheet(tiles, out_sheet, cols=4)
    print(f"[render_preview] Contact sheet saved to {out_sheet}")


if __name__ == "__main__":
    main()
