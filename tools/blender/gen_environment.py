"""Procedural Blender 5.2 generators for Nachtschicht Mediterranean Salou & Dresden architecture:
- palm_tree.glb      (Curved Mediterranean coastal palm with two-tier arching frond canopy)
- streetlamp.glb     (Salou promenade wrought-iron heritage streetlamp with warm amber glow)
- salou_facade.glb   (Modular 6m Catalan Mediterranean townhouse/hotel facade with balcony, awning & neon)
- dresden_pillar.glb (Baroque Elbsandstein sandstone column/arch module with gold leaf & wall sconce)
"""

from __future__ import annotations

import math
from typing import List, Tuple

from common import MeshBuilder, export_glb, make_material, reset_scene


def build_palm_tree(out_dir: str) -> dict:
    """Mediterranean Salou promenade palm tree (~7.2m tall, grounded at y=0).
    Separate `Trunk` and crown-pivoted `Canopy` so Three.js can sway fronds in the night breeze.
    """
    reset_scene()

    mat_bark1 = make_material("Palm_BarkDark", "#4A3628", roughness=0.90)
    mat_bark2 = make_material("Palm_BarkLight", "#634A38", roughness=0.88)
    mat_coconut = make_material("Palm_Dates", "#52311A", roughness=0.72)
    mat_frond = make_material("Palm_FrondEmerald", "#1D4A33", roughness=0.68, double_sided=True)
    mat_frond_lit = make_material("Palm_FrondOlive", "#2C6342", roughness=0.65, double_sided=True)
    mat_stem = make_material("Palm_FrondStem", "#385732", roughness=0.75)

    # ------------------------------------------------------------------
    # 1. Trunk (organically curving segmented ringed palm trunk)
    # ------------------------------------------------------------------
    trunk = MeshBuilder()
    num_segs = 18
    total_h = 5.75

    def trunk_center(t: float) -> Tuple[float, float, float]:
        # Graceful Mediterranean coastal lean
        cx = math.sin(t * 1.45) * 0.42
        cy = -math.sin(t * 0.95) * 0.22
        cz = t * total_h
        return (cx, cy, cz)

    for i in range(num_segs):
        t0 = i / num_segs
        t1 = (i + 1) / num_segs
        p0 = trunk_center(t0)
        p1 = trunk_center(t1)
        mid = ((p0[0] + p1[0]) * 0.5, (p0[1] + p1[1]) * 0.5, (p0[2] + p1[2]) * 0.5)
        dx, dy, dz = p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]
        seg_len = math.sqrt(dx * dx + dy * dy + dz * dz) + 0.04

        # Taper from flared root base to slender upper shaft, with stepped palm bark rings
        base_r = 0.34 * ((1.0 - t0) ** 0.55) + 0.14
        if i == 0:
            base_r *= 1.24
        r_bot = base_r * 0.94
        r_top = base_r * 1.08

        rot_x = -math.atan2(dy, dz)
        rot_y = math.atan2(dx, dz)
        mat = mat_bark1 if i % 2 == 0 else mat_bark2
        trunk.add_cylinder(mid, r_bot, r_top, seg_len, mat, segments=10, rot=(rot_x, rot_y, i * 0.22), smooth=False)

    crown_top = trunk_center(1.0)
    # Fibrous crown heart & cluster of dates/coconuts
    trunk.add_sphere((crown_top[0], crown_top[1], crown_top[2] + 0.06), 0.24, mat_bark1, scale=(1.0, 1.0, 1.15), segments=10, rings=8)
    for k in range(6):
        ang = (2.0 * math.pi * k) / 6.0
        trunk.add_sphere(
            (crown_top[0] + math.cos(ang) * 0.19, crown_top[1] + math.sin(ang) * 0.19, crown_top[2] - 0.14),
            0.09,
            mat_coconut,
            scale=(0.85, 0.85, 1.15),
            segments=8,
            rings=6,
        )

    trunk.finalize("Trunk")

    # ------------------------------------------------------------------
    # 2. Canopy (pivoted at crown_top for gentle wind sway)
    # ------------------------------------------------------------------
    canopy = MeshBuilder()

    def add_frond(azimuth: float, length: float, rise: float, droop: float, width: float, mat) -> None:
        """Build a graceful arching V-folded palm frond ribbon with central midrib."""
        steps = 8
        ca, sa = math.cos(azimuth), math.sin(azimuth)
        # Perpendicular horizontal vector for frond width
        px, py = -sa, ca

        spine_pts = []
        left_pts = []
        right_pts = []
        for s in range(steps + 1):
            u = s / steps
            r_dist = u * length
            # Parabolic arc: rises then arches gracefully down
            z_off = rise * math.sin(u * math.pi * 0.82) - droop * (u ** 2.2)
            # Tapered leaflet envelope (widest at u=0.35, pointed tip at u=1.0)
            w = width * math.sin(u * math.pi) * (1.18 - 0.35 * u)
            if s == 0:
                w = 0.04
            elif s == steps:
                w = 0.005

            sx, sy, sz = ca * r_dist, sa * r_dist, z_off
            spine_pts.append((sx, sy, sz))
            # V-fold droops leaflet edges slightly below spine for realistic 3D volume
            v_drop = w * 0.34
            left_pts.append((sx + px * w, sy + py * w, sz - v_drop))
            right_pts.append((sx - px * w, sy - py * w, sz - v_drop))

        # Central rib tube
        canopy.add_tube(spine_pts, [0.032 * (1.0 - 0.72 * i / steps) for i in range(steps + 1)], mat_stem, segments=5, smooth=False)
        # Left & right V-folded frond blades
        for s in range(steps):
            canopy.add_quad_sheet(spine_pts[s], left_pts[s], left_pts[s + 1], spine_pts[s + 1], mat)
            canopy.add_quad_sheet(spine_pts[s], spine_pts[s + 1], right_pts[s + 1], right_pts[s], mat)

    # Lower spreading crown tier (10 lush wide Mediterranean fronds)
    for i in range(10):
        az = (2.0 * math.pi * i) / 10.0 + 0.15
        add_frond(az, length=2.85 + (i % 2) * 0.24, rise=0.92, droop=1.65, width=0.52, mat=mat_frond)

    # Upper ascending crown tier (7 fresh lighter fronds)
    for i in range(7):
        az = (2.0 * math.pi * i) / 7.0 + 0.45
        add_frond(az, length=2.15 + (i % 2) * 0.18, rise=1.42, droop=0.72, width=0.44, mat=mat_frond_lit)

    canopy.finalize("Canopy", location=(crown_top[0], crown_top[1], crown_top[2] + 0.10))

    return export_glb(
        out_dir,
        "palm_tree.glb",
        description="Mediterranean Salou promenade palm tree with curved ringed Trunk and crown-pivoted two-tier arching Canopy.",
        category="environment",
        ground=True,
        extra_meta={
            "animatableParts": ["Canopy"],
            "swayNote": "Gently oscillate Canopy.rotation.x/z by +-0.03 rad for night coastal breeze.",
        },
    )


def build_streetlamp(out_dir: str) -> dict:
    """Warm Mediterranean wrought-iron heritage streetlamp (~4.85m tall, grounded at y=0).
    Scrolled bracket reaches forward along -Y Blender (+Z glTF) over the street.
    """
    reset_scene()

    mat_iron = make_material("Lamp_WroughtIron", "#171B20", metallic=0.78, roughness=0.42)
    mat_bronze = make_material("Lamp_BronzeTrim", "#4D3B26", metallic=0.82, roughness=0.35)
    mat_glow = make_material("Lamp_SodiumAmber", "#FFC266", emission="#FFA73B", emission_strength=5.0, roughness=0.18)

    # ------------------------------------------------------------------
    # 1. Lamp_Post (ornate fluted base + column + scrolled bracket + lantern cage)
    # ------------------------------------------------------------------
    post = MeshBuilder()
    # Stepped octagonal heritage plinth & fluted base pedestal
    post.add_cylinder((0.0, 0.0, 0.09), 0.28, 0.25, 0.18, mat_iron, segments=8, smooth=False)
    post.add_cylinder((0.0, 0.0, 0.24), 0.23, 0.19, 0.14, mat_iron, segments=8, smooth=False)
    post.add_cylinder((0.0, 0.0, 0.62), 0.17, 0.125, 0.64, mat_iron, segments=10, smooth=False)
    post.add_cylinder((0.0, 0.0, 0.96), 0.145, 0.11, 0.08, mat_bronze, segments=12)

    # Tall tapered pole
    post.add_cylinder((0.0, 0.0, 2.52), 0.085, 0.056, 3.08, mat_iron, segments=12)
    # Mid & upper decorative cast collars
    post.add_cylinder((0.0, 0.0, 2.60), 0.092, 0.092, 0.07, mat_bronze, segments=12)
    post.add_cylinder((0.0, 0.0, 4.08), 0.085, 0.068, 0.12, mat_bronze, segments=12)
    post.add_cylinder((0.0, 0.0, 4.24), 0.055, 0.025, 0.22, mat_iron, segments=10)
    post.add_sphere((0.0, 0.0, 4.38), 0.045, mat_bronze, segments=10, rings=8)

    # Graceful arched wrought-iron bracket arm extending to -Y (glTF +Z)
    arm_pts = [
        (0.0, -0.02, 4.02),
        (0.0, -0.18, 4.46),
        (0.0, -0.44, 4.74),
        (0.0, -0.68, 4.72),
        (0.0, -0.80, 4.54),
    ]
    post.add_tube(arm_pts, [0.036, 0.032, 0.028, 0.026, 0.024], mat_iron, segments=8)

    # Decorative wrought-iron S-scroll brace under bracket
    scroll_pts = [
        (0.0, -0.06, 3.45),
        (0.0, -0.26, 3.74),
        (0.0, -0.34, 4.08),
        (0.0, -0.52, 4.36),
        (0.0, -0.68, 4.52),
    ]
    post.add_tube(scroll_pts, 0.017, mat_iron, segments=6)
    # Inner curl accent
    curl_pts = [
        (0.0, -0.22, 4.02),
        (0.0, -0.16, 4.18),
        (0.0, -0.26, 4.30),
        (0.0, -0.38, 4.22),
    ]
    post.add_tube(curl_pts, 0.014, mat_bronze, segments=6)

    # Hexagonal hanging lantern cage centered at (0.0, -0.80, 4.18)
    ly = -0.80
    # Pagoda lantern roof cap + finial
    post.add_cylinder((0.0, ly, 4.46), 0.24, 0.06, 0.16, mat_iron, segments=6, smooth=False)
    post.add_cylinder((0.0, ly, 4.56), 0.04, 0.01, 0.08, mat_bronze, segments=8)
    # Lower lantern base cup + pendant tip
    post.add_cylinder((0.0, ly, 3.94), 0.09, 0.14, 0.08, mat_iron, segments=6, smooth=False)
    post.add_cylinder((0.0, ly, 3.86), 0.01, 0.04, 0.09, mat_bronze, segments=6)
    # 6 slender corner cage mullions
    for k in range(6):
        ang = (2.0 * math.pi * k) / 6.0
        p_bot = (math.cos(ang) * 0.13, ly + math.sin(ang) * 0.13, 3.96)
        p_top = (math.cos(ang) * 0.20, ly + math.sin(ang) * 0.20, 4.39)
        post.add_tube([p_bot, p_top], 0.012, mat_iron, segments=5, smooth=False)

    post.finalize("Lamp_Post")

    # ------------------------------------------------------------------
    # 2. Lamp_Glow (warm sodium-amber emissive lantern glass core)
    # ------------------------------------------------------------------
    glow = MeshBuilder()
    glow.add_cylinder((0.0, 0.0, 0.0), 0.115, 0.175, 0.40, mat_glow, segments=6, smooth=False)
    glow.finalize("Lamp_Glow", location=(0.0, -0.80, 4.18))

    return export_glb(
        out_dir,
        "streetlamp.glb",
        description="Warm Mediterranean wrought-iron promenade streetlamp with scrollwork bracket and glowing sodium-amber hexagonal Lamp_Glow.",
        category="environment",
        ground=True,
        extra_meta={
            "lightOrigin": [0.0, 4.18, 0.80],
            "animatableParts": ["Lamp_Glow"],
        },
    )


def build_salou_facade(out_dir: str) -> dict:
    """Modular 6.0m wide Catalan Mediterranean townhouse / hotel facade (~8.5m tall).
    Grounded at y=0, front facade face at z=0 glTF, balcony/awning projecting toward +Z glTF.
    """
    reset_scene()

    mat_stucco = make_material("Salou_TerracottaStucco", "#B46A4A", roughness=0.84)
    mat_stone = make_material("Salou_Limestone", "#998B77", roughness=0.78)
    mat_plinth = make_material("Salou_DarkPlinth", "#4D463E", roughness=0.82)
    mat_shutter = make_material("Salou_TealShutter", "#1E4745", roughness=0.66)
    mat_iron = make_material("Salou_WroughtIron", "#181C22", metallic=0.75, roughness=0.44)
    mat_wood = make_material("Salou_DoorWood", "#3D261A", roughness=0.62)
    mat_tile = make_material("Salou_RoofTile", "#853827", roughness=0.74)
    mat_awn_a = make_material("Salou_AwningCrimson", "#8C2A2A", roughness=0.82, double_sided=True)
    mat_awn_b = make_material("Salou_AwningCream", "#E2D5BE", roughness=0.82, double_sided=True)
    mat_win_warm = make_material("Salou_WarmWindow", "#FFBC5C", emission="#FFA63B", emission_strength=2.2, roughness=0.18)
    mat_win_dark = make_material("Salou_DarkWindow", "#121C29", metallic=0.15, roughness=0.12)
    mat_neon = make_material("Salou_CyanNeon", "#2CE8DC", emission="#2CE8DC", emission_strength=4.0, roughness=0.15)

    # ------------------------------------------------------------------
    # 1. Facade_Wall (stone shopfront + stucco upper floors + shutters + roof cornice)
    # ------------------------------------------------------------------
    wall = MeshBuilder()
    # Ground floor dressed limestone block (x: -3..3, y: 0..1.6 -> glTF z: -1.6..0)
    wall.add_box((0.0, 0.80, 1.55), (6.00, 1.60, 3.10), mat_stone)
    # Stone base plinth & corner pilasters
    wall.add_box((0.0, 0.78, 0.22), (6.04, 1.66, 0.44), mat_plinth)
    for sx in (-2.84, 2.84):
        wall.add_box((sx, -0.04, 1.55), (0.34, 0.10, 3.10), mat_stone, bevel=0.015)

    # Upper Catalan terracotta stucco wall (2nd & 3rd floor: z=3.1..8.1)
    wall.add_box((0.0, 0.80, 5.60), (6.00, 1.60, 5.00), mat_stucco)

    # Cream limestone horizontal stringcourse moldings between stories
    wall.add_box((0.0, -0.06, 3.12), (6.08, 0.18, 0.20), mat_stone, bevel=0.018)
    wall.add_box((0.0, -0.05, 5.68), (6.06, 0.14, 0.15), mat_stone, bevel=0.015)
    wall.add_box((0.0, -0.10, 8.05), (6.12, 0.28, 0.24), mat_stone, bevel=0.020)

    # Helper for hollow architectural stone window/door frames (never occluding glass!)
    def add_hollow_frame(cx: float, cz: float, w: float, h: float, thick: float, depth: float, mat) -> None:
        wall.add_box((cx, -depth * 0.5, cz + h * 0.5 + thick * 0.5), (w + thick * 2, depth, thick), mat, bevel=0.01)
        wall.add_box((cx, -depth * 0.5, cz - h * 0.5 - thick * 0.5), (w + thick * 2, depth, thick), mat, bevel=0.01)
        wall.add_box((cx - w * 0.5 - thick * 0.5, -depth * 0.5, cz), (thick, depth, h), mat, bevel=0.01)
        wall.add_box((cx + w * 0.5 + thick * 0.5, -depth * 0.5, cz), (thick, depth, h), mat, bevel=0.01)

    # Ground floor recessed doorway (left) & hollow shopfront frame (right)
    add_hollow_frame(-1.80, 1.24, 1.12, 2.26, 0.13, 0.12, mat_plinth)
    wall.add_box((-1.80, -0.02, 1.24), (1.10, 0.06, 2.24), mat_wood, bevel=0.01)
    wall.add_box((-1.42, -0.06, 1.15), (0.04, 0.06, 0.24), mat_iron)
    # Shopfront vitrine hollow stone surround (so Windows_Warm shines freely inside!)
    add_hollow_frame(0.88, 1.48, 2.94, 1.96, 0.14, 0.12, mat_plinth)

    # 2nd floor French balcony hollow door frames + open louvered teal shutters (at x = -1.55 and +1.55)
    for wx in (-1.55, 1.55):
        add_hollow_frame(wx, 4.38, 1.08, 1.98, 0.11, 0.10, mat_stone)
        # Left & right open louvered wooden shutters
        wall.add_box((wx - 0.84, -0.07, 4.38), (0.42, 0.06, 2.06), mat_shutter, bevel=0.008)
        wall.add_box((wx + 0.84, -0.07, 4.38), (0.42, 0.06, 2.06), mat_shutter, bevel=0.008)

    # 3rd floor hollow window frames + sills + louvered shutters (3 bays: -1.85, 0.0, +1.85)
    for wx in (-1.85, 0.0, 1.85):
        add_hollow_frame(wx, 6.84, 0.84, 1.30, 0.10, 0.10, mat_stone)
        wall.add_box((wx, -0.10, 6.10), (1.16, 0.18, 0.10), mat_stone, bevel=0.010)
        wall.add_box((wx - 0.68, -0.06, 6.84), (0.34, 0.055, 1.36), mat_shutter, bevel=0.006)
        wall.add_box((wx + 0.68, -0.06, 6.84), (0.34, 0.055, 1.36), mat_shutter, bevel=0.006)

    # Mediterranean terracotta sloped roof overhang & barrel tiles at roofline
    wall.add_box((0.0, 0.56, 8.32), (6.16, 2.15, 0.24), mat_tile, rot=(0.14, 0.0, 0.0), bevel=0.02)
    for i in range(15):
        tx = -2.85 + i * 0.407
        wall.add_cylinder((tx, -0.44, 8.20), 0.09, 0.085, 0.42, mat_tile, segments=8, rot=(math.pi * 0.5 + 0.14, 0.0, 0.0))

    wall.finalize("Facade_Wall")

    # ------------------------------------------------------------------
    # 2. Balcony (projecting 2nd-floor stone balcony + wrought-iron railing)
    # ------------------------------------------------------------------
    balc = MeshBuilder()
    # Balcony stone slab projecting to y = -0.92 (glTF +Z = +0.92)
    balc.add_box((0.0, -0.46, 3.24), (4.86, 0.92, 0.16), mat_stone, bevel=0.018)
    # Carved stone corbel brackets under balcony
    for bx in (-2.05, -0.70, 0.70, 2.05):
        balc.add_box((bx, -0.34, 3.00), (0.18, 0.64, 0.34), mat_stone, bevel=0.015, taper_bottom=(0.8, 0.45))

    # Wrought-iron top/bottom railing bars
    ry_front = -0.88
    balc.add_box((0.0, ry_front, 4.24), (4.76, 0.045, 0.045), mat_iron)
    balc.add_box((0.0, ry_front, 3.42), (4.76, 0.035, 0.035), mat_iron)
    for sx in (-2.36, 2.36):
        balc.add_box((sx, -0.45, 4.24), (0.045, 0.88, 0.045), mat_iron)
        balc.add_box((sx, -0.45, 3.42), (0.035, 0.88, 0.035), mat_iron)
        for by in (-0.20, -0.44, -0.68):
            balc.add_box((sx, by, 3.83), (0.025, 0.025, 0.84), mat_iron)
    # Front vertical iron balusters
    for i in range(19):
        bx = -2.36 + i * (4.72 / 18.0)
        balc.add_box((bx, ry_front, 3.83), (0.024, 0.024, 0.84), mat_iron)

    balc.finalize("Balcony")

    # ------------------------------------------------------------------
    # 3. Awning (Mediterranean striped canvas storefront awning)
    # ------------------------------------------------------------------
    awn = MeshBuilder()
    num_stripes = 10
    awn_w = 3.40
    stripe_w = awn_w / num_stripes
    x_start = 0.88 - awn_w * 0.5
    for i in range(num_stripes):
        sx0 = x_start + i * stripe_w
        sx1 = sx0 + stripe_w
        mat_s = mat_awn_a if i % 2 == 0 else mat_awn_b
        # Sloped canopy panel
        awn.add_quad_sheet((sx0, -0.02, 2.74), (sx1, -0.02, 2.74), (sx1, -0.96, 2.30), (sx0, -0.96, 2.30), mat_s)
        # Hanging front valance flap
        awn.add_quad_sheet((sx0, -0.96, 2.30), (sx1, -0.96, 2.30), (sx1, -0.96, 2.08), (sx0, -0.96, 2.08), mat_s)
    # Side iron awning struts
    for sx in (x_start + 0.05, x_start + awn_w - 0.05):
        awn.add_tube([(sx, -0.02, 2.28), (sx, -0.92, 2.28)], 0.018, mat_iron, segments=6)
    awn.finalize("Awning")

    # ------------------------------------------------------------------
    # 4. Windows_Warm (warm night-lit windows + mullions + night-dark panes)
    # ------------------------------------------------------------------
    win = MeshBuilder()
    # Ground floor warm glowing shopfront display window (cleanly visible in front of y=0!)
    win.add_box((0.88, -0.035, 1.48), (2.90, 0.04, 1.92), mat_win_warm)
    # Mullion dividers across shopfront
    for mx in (0.0, 1.76):
        win.add_box((mx, -0.07, 1.48), (0.06, 0.045, 1.96), mat_iron)
    win.add_box((0.88, -0.07, 2.12), (2.92, 0.04, 0.05), mat_iron)
    # 2nd floor French doors: left warm-lit, right dim night-dark (with French-door crossbars)
    for wx, wmat in ((-1.55, mat_win_warm), (1.55, mat_win_dark)):
        win.add_box((wx, -0.035, 4.38), (1.06, 0.04, 1.96), wmat)
        win.add_box((wx, -0.065, 4.38), (0.045, 0.035, 1.96), mat_iron)
        win.add_box((wx, -0.065, 4.42), (1.06, 0.035, 0.04), mat_iron)
    # 3rd floor windows: center & right warm-lit, left dark
    for wx, wmat in ((-1.85, mat_win_dark), (0.0, mat_win_warm), (1.85, mat_win_warm)):
        win.add_box((wx, -0.035, 6.84), (0.82, 0.04, 1.28), wmat)
        win.add_box((wx, -0.062, 6.84), (0.04, 0.03, 1.28), mat_iron)
        win.add_box((wx, -0.062, 6.84), (0.82, 0.03, 0.04), mat_iron)
    win.finalize("Windows_Warm")

    # ------------------------------------------------------------------
    # 5. Neon_Sign (Mediterranean Night Noir cyan neon sign on front balcony fascia)
    # ------------------------------------------------------------------
    neon = MeshBuilder()
    neon.add_box((0.0, -0.94, 3.24), (2.70, 0.06, 0.22), mat_iron, bevel=0.010)
    neon.add_cylinder((0.0, -0.985, 3.29), 0.024, 0.024, 2.48, mat_neon, segments=8, rot=(0.0, math.pi * 0.5, 0.0))
    neon.add_cylinder((0.0, -0.985, 3.19), 0.018, 0.018, 2.08, mat_neon, segments=8, rot=(0.0, math.pi * 0.5, 0.0))
    neon.finalize("Neon_Sign")

    return export_glb(
        out_dir,
        "salou_facade.glb",
        description="Modular 6.0m Catalan Mediterranean townhouse/hotel facade with limestone storefront, terracotta stucco, teal shutters, wrought-iron Balcony, striped Awning, warm night Windows_Warm, and cyan Neon_Sign.",
        category="environment",
        ground=True,
        extra_meta={
            "modularWidth": 6.0,
            "facadeFrontZ": 0.0,
            "animatableParts": ["Windows_Warm", "Neon_Sign"],
        },
    )


def build_dresden_pillar(out_dir: str) -> dict:
    """Baroque Saxon Elbsandstein column & arch module for the Dresden Schatzkammer finale.
    ~3.2m wide x 5.8m tall x 1.4m deep, grounded at y=0, front facing +Z glTF.
    """
    reset_scene()

    mat_sandstone = make_material("Dresden_Elbsandstein", "#9B8A72", roughness=0.80)
    mat_patina = make_material("Dresden_AgedStone", "#766754", roughness=0.86)
    mat_marble = make_material("Dresden_DarkMarble", "#2C2725", roughness=0.32, coat=0.45)
    mat_gold = make_material("Dresden_GoldLeaf", "#D9AC44", metallic=0.92, roughness=0.20)
    mat_bronze = make_material("Dresden_Bronze", "#4E3A24", metallic=0.82, roughness=0.34)
    mat_glow = make_material("Dresden_SconceGlow", "#FFD078", emission="#FFBE55", emission_strength=4.2, roughness=0.15)

    # ------------------------------------------------------------------
    # 1. Sandstone_Column (plinth + fluted Corinthian column + baroque arch bay)
    # ------------------------------------------------------------------
    stone = MeshBuilder()

    # Backing architectural pier wall & baroque archway frame
    # Left & right supporting piers (leaving central arched niche / passageway)
    for sx in (-1.22, 1.22):
        stone.add_box((sx, 0.30, 0.48), (0.76, 0.92, 0.96), mat_patina, bevel=0.025)
        stone.add_box((sx, 0.30, 2.55), (0.68, 0.80, 3.22), mat_sandstone, bevel=0.02)
        # Recessed dark marble decorative wall panel on pier face
        stone.add_box((sx, -0.09, 2.55), (0.36, 0.05, 2.40), mat_marble, bevel=0.01)

    # Twin monumental engaged fluted baroque columns flanking the arch
    for sx in (-1.10, 1.10):
        cy = -0.22
        # Stepped pedestal plinth & classical Attic torus base
        stone.add_box((sx, cy, 0.14), (0.74, 0.74, 0.28), mat_patina, bevel=0.02)
        stone.add_box((sx, cy, 0.56), (0.60, 0.60, 0.58), mat_sandstone, bevel=0.018)
        stone.add_box((sx, cy, 0.89), (0.68, 0.68, 0.10), mat_patina, bevel=0.015)
        stone.add_cylinder((sx, cy, 1.00), 0.32, 0.28, 0.12, mat_sandstone, segments=16)
        stone.add_cylinder((sx, cy, 1.09), 0.29, 0.26, 0.08, mat_patina, segments=16)

        # Slightly entasis-tapered shaft with 12 sculptural baroque flutes (ridges)
        stone.add_cylinder((sx, cy, 2.56), 0.26, 0.23, 2.88, mat_sandstone, segments=16)
        for f in range(12):
            ang = (2.0 * math.pi * f) / 12.0
            fx = sx + math.cos(ang) * 0.245
            fy = cy + math.sin(ang) * 0.245
            stone.add_cylinder((fx, fy, 2.56), 0.026, 0.022, 2.74, mat_patina, segments=6)

        # Corinthian-inspired flared capital bell + stepped abacus
        stone.add_cylinder((sx, cy, 4.16), 0.24, 0.34, 0.34, mat_sandstone, segments=12, smooth=False)
        stone.add_box((sx, cy, 4.38), (0.76, 0.76, 0.12), mat_sandstone, bevel=0.02)

    # Baroque semicircular arch spanning between piers (center z=4.38, radius=1.08)
    arch_steps = 12
    arch_pts_outer = []
    arch_pts_inner = []
    for i in range(arch_steps + 1):
        ang = math.pi * (i / arch_steps)  # 0 (+X) to pi (-X)
        ax = math.cos(ang) * 1.12
        az = 4.38 + math.sin(ang) * 1.04
        arch_pts_outer.append((ax, -0.02, az))
        arch_pts_inner.append((math.cos(ang) * 0.94, -0.02, 4.38 + math.sin(ang) * 0.86))

    stone.add_tube(arch_pts_outer, 0.22, mat_sandstone, segments=8, smooth=False)
    stone.add_tube(arch_pts_inner, 0.11, mat_patina, segments=8, smooth=False)

    # Spandrel fill blocks seamlessly uniting column capitals with arch & grand baroque entablature
    for sx in (-1.14, 1.14):
        stone.add_box((sx, 0.14, 4.96), (0.94, 0.92, 1.12), mat_sandstone, bevel=0.02)
    stone.add_box((0.0, 0.16, 5.56), (3.24, 1.10, 0.28), mat_sandstone, bevel=0.025)
    stone.add_box((0.0, 0.10, 5.76), (3.36, 1.24, 0.16), mat_patina, bevel=0.02)

    # Projecting carved baroque keystone at arch apex
    stone.add_box((0.0, -0.22, 5.38), (0.34, 0.28, 0.50), mat_sandstone, bevel=0.025, taper_bottom=(0.74, 0.82))

    stone.finalize("Sandstone_Column")

    # ------------------------------------------------------------------
    # 2. Gold_Trim (gilded baroque gold-leaf rings, volutes & keystone medallion)
    # ------------------------------------------------------------------
    gold = MeshBuilder()
    for sx in (-1.10, 1.10):
        cy = -0.22
        # Gilded astragal rings at column base & neck
        gold.add_cylinder((sx, cy, 1.14), 0.285, 0.285, 0.045, mat_gold, segments=16)
        gold.add_cylinder((sx, cy, 3.98), 0.258, 0.258, 0.055, mat_gold, segments=16)
        # Stylized gilded corner capital volutes
        for vx in (-0.28, 0.28):
            for vy in (-0.28, 0.28):
                gold.add_sphere((sx + vx, cy + vy, 4.28), 0.085, mat_gold, scale=(1.0, 1.0, 0.8), segments=8, rings=6)
        # Gilded panel trim on pedestal
        gold.add_box((sx, -0.53, 0.56), (0.38, 0.03, 0.36), mat_gold, bevel=0.008)

    # Grand gilded baroque frieze strip & keystone royal cartouche medallion
    gold.add_box((0.0, -0.37, 5.56), (3.18, 0.04, 0.07), mat_gold, bevel=0.008)
    gold.add_sphere((0.0, -0.36, 5.36), 0.13, mat_gold, scale=(0.88, 0.42, 1.22), segments=12, rings=8)

    # Ornate bronze wall sconce arms mounted on front of columns
    for sx in (-1.10, 1.10):
        gold.add_box((sx, -0.49, 2.38), (0.14, 0.05, 0.32), mat_bronze, bevel=0.01)
        gold.add_tube([(sx, -0.50, 2.34), (sx, -0.68, 2.34), (sx, -0.72, 2.46)], 0.022, mat_gold, segments=8)
        gold.add_cylinder((sx, -0.72, 2.48), 0.065, 0.045, 0.05, mat_gold, segments=10)

    gold.finalize("Gold_Trim")

    # ------------------------------------------------------------------
    # 3. Sconce_Glow (warm baroque candle-lantern globes)
    # ------------------------------------------------------------------
    sconce = MeshBuilder()
    for sx in (-1.10, 1.10):
        sconce.add_sphere((sx, -0.72, 2.61), 0.085, mat_glow, scale=(0.85, 0.85, 1.30), segments=10, rings=8)
    sconce.finalize("Sconce_Glow")

    return export_glb(
        out_dir,
        "dresden_pillar.glb",
        description="Baroque Dresden Elbsandstein fluted column and vaulted arch module with gilded Gold_Trim and glowing wall Sconce_Glow for the Kurfuerstliche Schatzkammer finale.",
        category="environment",
        ground=True,
        extra_meta={
            "modularWidth": 3.2,
            "sconceLights": [[-1.10, 2.61, 0.72], [1.10, 2.61, 0.72]],
            "animatableParts": ["Sconce_Glow"],
        },
    )
