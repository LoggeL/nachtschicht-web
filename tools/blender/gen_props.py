"""Procedural Blender 5.2 generators for Nachtschicht heist props:
- safe.glb            (Heavy vault safe with recessed interior loot, hinged Safe_Door & spinning Safe_Dial)
- display_case.glb    (Museum/jeweler glass vitrine with glowing royal Artifact)
- power_box.glb       (Wall electrical breaker cabinet with conduits, cables, Breaker_Lever & Status_LED)
- security_camera.glb (Wall-mounted CCTV camera with pivoting Camera_Head & red Camera_LED)
"""

from __future__ import annotations

import math

from common import MeshBuilder, export_glb, make_material, reset_scene


def build_safe(out_dir: str) -> dict:
    """Heavy cast-steel bank/vault safe (~1.12m W x 1.48m H x 0.96m D).
    Grounded at y=0, front door faces -Y in Blender (+Z in glTF).
    Safe_Door origin is strictly on the left hinge axis so rotating around Y swings it open!
    """
    reset_scene()

    mat_steel = make_material("Safe_GunmetalSteel", "#222A35", metallic=0.72, roughness=0.38)
    mat_dark = make_material("Safe_InteriorDark", "#12161D", metallic=0.4, roughness=0.65)
    mat_brass = make_material("Safe_Brass", "#D1A347", metallic=0.90, roughness=0.22)
    mat_chrome = make_material("Safe_Chrome", "#CFD8E2", metallic=0.92, roughness=0.18)
    mat_gold = make_material("Safe_GoldBullion", "#E6B83A", metallic=0.95, roughness=0.18)
    mat_cash = make_material("Safe_CashBundle", "#3E6B48", roughness=0.78)
    mat_led = make_material("Safe_StatusLED", "#FF3B30", emission="#FF3B30", emission_strength=3.5, roughness=0.2)

    # ------------------------------------------------------------------
    # 1. Safe_Body (hollowed outer armored shell + feet + hinges + shelves)
    # ------------------------------------------------------------------
    body = MeshBuilder()
    # Heavy armored feet
    for sx in (-0.42, 0.42):
        for sy in (-0.34, 0.34):
            body.add_box((sx, sy, 0.05), (0.18, 0.18, 0.10), mat_dark, bevel=0.015)

    # Hollow vault enclosure (back, bottom, top, left, right walls — front open for door!)
    body.add_box((0.0, 0.0, 0.16), (1.08, 0.90, 0.14), mat_steel, bevel=0.025)   # bottom slab
    body.add_box((0.0, 0.0, 1.40), (1.08, 0.90, 0.14), mat_steel, bevel=0.025)   # top slab
    body.add_box((0.0, 0.38, 0.78), (1.08, 0.14, 1.36), mat_steel, bevel=0.025)  # back wall
    body.add_box((0.47, 0.0, 0.78), (0.14, 0.90, 1.36), mat_steel, bevel=0.025)  # left wall (+X)
    body.add_box((-0.47, 0.0, 0.78), (0.14, 0.90, 1.36), mat_steel, bevel=0.025) # right wall (-X)

    # Reinforced beveled corner armor bands & brass nameplate
    for sz in (0.16, 1.40):
        body.add_box((0.0, -0.44, sz), (1.12, 0.06, 0.07), mat_dark, bevel=0.012)
    body.add_box((0.0, -0.46, 1.40), (0.32, 0.025, 0.05), mat_brass, bevel=0.005)

    # Heavy barrel hinge knuckles on left front edge (+X = +0.52, y = -0.46)
    for hz in (0.42, 1.14):
        body.add_cylinder((0.52, -0.46, hz), 0.042, 0.042, 0.18, mat_brass, segments=12)

    # Interior vault shelf + recessed dark lining
    body.add_box((0.0, 0.04, 0.76), (0.80, 0.66, 0.04), mat_dark)
    body.add_box((0.0, 0.04, 0.24), (0.80, 0.66, 0.02), mat_dark)

    body.finalize("Safe_Body")

    # ------------------------------------------------------------------
    # 2. Safe_Loot (visible gold bars & cash bundles inside vault!)
    # ------------------------------------------------------------------
    loot = MeshBuilder()
    # Gold bullion bars on top shelf
    for i, lx in enumerate((-0.22, -0.04, 0.14)):
        loot.add_box((lx, 0.02, 0.83), (0.13, 0.24, 0.08), mat_gold, bevel=0.012, taper_top=(0.82, 0.88))
    loot.add_box((-0.13, 0.04, 0.91), (0.13, 0.24, 0.08), mat_gold, bevel=0.012, taper_top=(0.82, 0.88))
    # Cash stacks on bottom shelf
    for lx in (-0.20, 0.02, 0.22):
        for stack_z in (0.29, 0.36):
            loot.add_box((lx, 0.02, stack_z), (0.16, 0.09, 0.055), mat_cash, rot=(0.0, 0.0, 0.12 * lx), bevel=0.005)
            loot.add_box((lx, 0.02, stack_z), (0.04, 0.095, 0.058), mat_brass)
    loot.finalize("Safe_Loot")

    # ------------------------------------------------------------------
    # 3. Safe_Door (pivoted at left hinge axis x=+0.48, y=-0.46, z=0.78)
    # ------------------------------------------------------------------
    hinge_pos = (0.48, -0.46, 0.78)
    door = MeshBuilder()
    # Door slab centered relative to hinge: x = -0.48, y = +0.02, z = 0
    door.add_box((-0.48, 0.01, 0.0), (0.86, 0.11, 1.16), mat_steel, bevel=0.022)
    # Decorative recessed front armor bezel
    door.add_box((-0.48, -0.05, 0.0), (0.72, 0.03, 0.98), mat_dark, bevel=0.012)
    door.add_box((-0.48, -0.06, 0.0), (0.64, 0.025, 0.90), mat_steel, bevel=0.010)
    # Brass trim border strip
    door.add_box((-0.48, -0.062, 0.42), (0.58, 0.02, 0.025), mat_brass)
    door.add_box((-0.48, -0.062, -0.42), (0.58, 0.02, 0.025), mat_brass)
    # Chrome heavy locking bolts protruding from right latch side of door
    for bz in (-0.34, 0.0, 0.34):
        door.add_cylinder((-0.93, 0.02, bz), 0.026, 0.026, 0.09, mat_chrome, segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    # Hinge straps connecting hinge pin to door
    for hz in (-0.36, 0.36):
        door.add_box((-0.06, -0.02, hz), (0.16, 0.05, 0.06), mat_brass, bevel=0.008)

    door_obj = door.finalize("Safe_Door", location=hinge_pos)

    # ------------------------------------------------------------------
    # 4. Safe_Dial (child of Safe_Door, pivoted at handle wheel center!)
    # ------------------------------------------------------------------
    dial = MeshBuilder()
    # Central hub + combination dial bezel
    dial.add_cylinder((0.0, -0.02, 0.0), 0.09, 0.08, 0.05, mat_chrome, segments=18, rot=(math.pi * 0.5, 0.0, 0.0))
    dial.add_cylinder((0.0, -0.065, 0.0), 0.048, 0.042, 0.06, mat_brass, segments=14, rot=(math.pi * 0.5, 0.0, 0.0))
    # 3-spoke brass vault capstan wheel
    for s in range(3):
        ang = (2.0 * math.pi * s) / 3.0 + math.pi * 0.16
        cx = math.cos(ang) * 0.11
        cz = math.sin(ang) * 0.11
        dial.add_cylinder((cx, -0.08, cz), 0.018, 0.015, 0.19, mat_brass, segments=10, rot=(0.0, ang - math.pi * 0.5, 0.0))
        dial.add_sphere((math.cos(ang) * 0.21, -0.08, math.sin(ang) * 0.21), 0.028, mat_brass, segments=10, rings=8)
    dial.finalize("Safe_Dial", location=(-0.54, -0.075, -0.02), parent=door_obj)

    # Small glowing keypad / lock status LED on upper door
    led = MeshBuilder()
    led.add_box((0.0, 0.0, 0.0), (0.045, 0.025, 0.045), mat_led, bevel=0.005)
    led.finalize("Safe_LED", location=(-0.28, -0.078, 0.28), parent=door_obj)

    return export_glb(
        out_dir,
        "safe.glb",
        description="Heavy bank/vault safe with hollowed loot interior, hinge-pivoted Safe_Door, spinning 3-spoke Safe_Dial, and status LED.",
        category="prop",
        ground=True,
        extra_meta={
            "animatableParts": ["Safe_Door", "Safe_Dial", "Safe_LED", "Safe_Loot"],
            "hingeNote": "Rotate Safe_Door around Y by -1.8 rad to swing open cleanly.",
        },
    )


def build_display_case(out_dir: str) -> dict:
    """Museum / Jeweler Glass Vitrine with radiant glowing jewel/artifact centerpiece.
    ~1.00m W x 1.78m H x 1.00m D, grounded at y=0.
    """
    reset_scene()

    mat_wood = make_material("Vitrine_EbonyWood", "#1C1618", roughness=0.40, coat=0.45)
    mat_brass = make_material("Vitrine_Brass", "#D6AA4C", metallic=0.90, roughness=0.22)
    mat_velvet = make_material("Vitrine_CrimsonVelvet", "#681122", roughness=0.88)
    mat_glass = make_material("Vitrine_Glass", "#B8E4F8", metallic=0.05, roughness=0.04, alpha=0.24, coat=1.0, double_sided=True)
    mat_jewel = make_material("Vitrine_RoyalJewel", "#2CE6C8", metallic=0.15, roughness=0.08, emission="#38F2D6", emission_strength=2.6)
    mat_gold = make_material("Vitrine_GoldSetting", "#E8BC4A", metallic=0.94, roughness=0.16)
    mat_spot = make_material("Vitrine_InnerLamp", "#FFF0C8", emission="#FFE5A0", emission_strength=3.2, roughness=0.2)

    # ------------------------------------------------------------------
    # 1. Pedestal (stepped luxury plinth + velvet cushion + brass plaque)
    # ------------------------------------------------------------------
    ped = MeshBuilder()
    ped.add_box((0.0, 0.0, 0.06), (1.02, 1.02, 0.12), mat_wood, bevel=0.015)
    ped.add_box((0.0, 0.0, 0.14), (0.94, 0.94, 0.04), mat_brass, bevel=0.008)
    ped.add_box((0.0, 0.0, 0.52), (0.88, 0.88, 0.72), mat_wood, bevel=0.018)
    ped.add_box((0.0, 0.0, 0.91), (0.96, 0.96, 0.06), mat_wood, bevel=0.012)
    ped.add_box((0.0, 0.0, 0.955), (0.92, 0.92, 0.03), mat_brass, bevel=0.006)
    # Plush velvet display cushion pad
    ped.add_box((0.0, 0.0, 1.00), (0.64, 0.64, 0.07), mat_velvet, bevel=0.022, taper_top=(0.86, 0.86))
    # Front museum brass plaque
    ped.add_box((0.0, -0.45, 0.76), (0.28, 0.02, 0.11), mat_brass, bevel=0.005)
    ped.finalize("Pedestal")

    # ------------------------------------------------------------------
    # 2. Glass_Hood (framed glass enclosure + top cap & spotlight)
    # ------------------------------------------------------------------
    hood = MeshBuilder()
    # 4 glass panels (double-sided transparent)
    hw = 0.43
    z0, z1 = 0.97, 1.72
    hood.add_quad_sheet((-hw, -hw, z0), (hw, -hw, z0), (hw, -hw, z1), (-hw, -hw, z1), mat_glass)
    hood.add_quad_sheet((hw, hw, z0), (-hw, hw, z0), (-hw, hw, z1), (hw, hw, z1), mat_glass)
    hood.add_quad_sheet((hw, -hw, z0), (hw, hw, z0), (hw, hw, z1), (hw, -hw, z1), mat_glass)
    hood.add_quad_sheet((-hw, hw, z0), (-hw, -hw, z0), (-hw, -hw, z1), (-hw, hw, z1), mat_glass)
    # Slender brass corner posts
    for sx in (-hw, hw):
        for sy in (-hw, hw):
            hood.add_box((sx, sy, (z0 + z1) * 0.5), (0.028, 0.028, z1 - z0), mat_brass, bevel=0.004)
    # Top museum canopy frame + inner downlight lens
    hood.add_box((0.0, 0.0, 1.74), (0.92, 0.92, 0.06), mat_wood, bevel=0.012)
    hood.add_box((0.0, 0.0, 1.715), (0.90, 0.90, 0.02), mat_brass, bevel=0.005)
    hood.add_cylinder((0.0, 0.0, 1.705), 0.07, 0.06, 0.02, mat_spot, segments=12)
    hood.finalize("Glass_Hood")

    # ------------------------------------------------------------------
    # 3. Artifact (faceted glowing crown jewel on gilded display stand)
    # ------------------------------------------------------------------
    art = MeshBuilder()
    # Small gilded pedestal stand (centered relative to pivot z=1.24)
    art.add_cylinder((0.0, 0.0, -0.18), 0.11, 0.04, 0.08, mat_gold, segments=12)
    art.add_cylinder((0.0, 0.0, -0.09), 0.022, 0.022, 0.12, mat_gold, segments=10)
    # Ornate gold halo/crown ring around jewel
    ring_pts = []
    for i in range(12):
        ang = (2.0 * math.pi * i) / 12.0
        ring_pts.append((math.cos(ang) * 0.145, 0.0, 0.05 + math.sin(ang) * 0.175))
    ring_pts.append(ring_pts[0])
    art.add_tube(ring_pts, 0.014, mat_gold, segments=6, smooth=False, cap=False)
    # Radiant cut diamond/emerald centerpiece (faceted bipyramid!)
    art.add_cylinder((0.0, 0.0, 0.11), 0.105, 0.001, 0.14, mat_jewel, segments=8, smooth=False)
    art.add_cylinder((0.0, 0.0, -0.01), 0.001, 0.105, 0.10, mat_jewel, segments=8, smooth=False)
    art.finalize("Artifact", location=(0.0, 0.0, 1.24))

    return export_glb(
        out_dir,
        "display_case.glb",
        description="Luxury museum/jeweler glass vitrine with ebony-brass pedestal, transparent Glass_Hood, and glowing faceted Artifact.",
        category="prop",
        ground=True,
        extra_meta={
            "animatableParts": ["Artifact", "Glass_Hood"],
        },
    )


def build_power_box(out_dir: str) -> dict:
    """Wall-mounted electrical breaker cabinet with conduits, curved cables,
    flippable Breaker_Lever, and emissive Status_LED.
    Back wall mount sits at y=0 Blender (z=0 glTF), protruding toward +Z glTF; bottom at y=0.
    """
    reset_scene()

    mat_box = make_material("PowerBox_WeatheredSteel", "#3B4450", metallic=0.62, roughness=0.48)
    mat_dark = make_material("PowerBox_Conduit", "#1E232B", metallic=0.55, roughness=0.55)
    mat_cable = make_material("PowerBox_Cable", "#111318", roughness=0.80)
    mat_hazard = make_material("PowerBox_HazardYellow", "#E6B220", roughness=0.45)
    mat_lever = make_material("PowerBox_RedHandle", "#D42828", metallic=0.25, roughness=0.35)
    mat_led = make_material("PowerBox_GreenLED", "#28E870", emission="#28E870", emission_strength=4.2, roughness=0.15)
    mat_copper = make_material("PowerBox_Copper", "#B86B3B", metallic=0.88, roughness=0.30)

    # ------------------------------------------------------------------
    # 1. Box_Body (cabinet + back flanges + conduits + curved cables + hazard badge)
    # ------------------------------------------------------------------
    body = MeshBuilder()
    # Back mounting plate flush at y=0 (glTF z=0)
    body.add_box((0.0, -0.015, 0.48), (0.64, 0.03, 0.72), mat_dark, bevel=0.008)
    # Main steel enclosure extending forward to -Y (glTF +Z)
    body.add_box((0.0, -0.13, 0.48), (0.56, 0.22, 0.64), mat_box, bevel=0.018)
    # Sloped top rain hood
    body.add_box((0.0, -0.14, 0.81), (0.60, 0.26, 0.04), mat_box, rot=(0.08, 0.0, 0.0), bevel=0.008)

    # Top galvanized conduit pipes
    for cx in (-0.14, 0.14):
        body.add_cylinder((cx, -0.09, 0.89), 0.026, 0.026, 0.14, mat_dark, segments=10)
        body.add_cylinder((cx, -0.09, 0.83), 0.035, 0.035, 0.03, mat_copper, segments=10)

    # Bottom conduits & curving braided power cables descending to z=0
    body.add_tube(
        [(-0.16, -0.10, 0.18), (-0.16, -0.10, 0.08), (-0.22, -0.06, 0.03), (-0.26, -0.02, 0.02)],
        0.022,
        mat_cable,
        segments=8,
    )
    body.add_tube(
        [(0.0, -0.10, 0.18), (0.0, -0.11, 0.05), (0.04, -0.06, 0.02)],
        0.024,
        mat_cable,
        segments=8,
    )
    body.add_tube(
        [(0.16, -0.10, 0.18), (0.16, -0.10, 0.09), (0.23, -0.05, 0.03), (0.28, -0.02, 0.02)],
        0.019,
        mat_copper,
        segments=8,
    )
    body.finalize("Box_Body")

    # ------------------------------------------------------------------
    # 2. Box_Door (front door panel with louvers, handle & hazard sign)
    # ------------------------------------------------------------------
    door = MeshBuilder()
    door.add_box((0.0, -0.245, 0.48), (0.50, 0.035, 0.58), mat_box, bevel=0.012)
    # High-voltage warning plate (crisp yellow diamond with black lightning bolt)
    door.add_box((0.0, -0.268, 0.56), (0.16, 0.014, 0.16), mat_hazard, rot=(0.0, math.pi * 0.25, 0.0), bevel=0.004)
    door.add_box((0.0, -0.276, 0.575), (0.024, 0.008, 0.075), mat_dark, rot=(0.0, 0.35, 0.0))
    door.add_box((0.01, -0.276, 0.540), (0.024, 0.008, 0.065), mat_dark, rot=(0.0, 0.35, 0.0))
    # Louver vents along lower door
    for vz in (0.28, 0.32, 0.36):
        door.add_box((0.0, -0.264, vz), (0.34, 0.014, 0.018), mat_dark, rot=(0.25, 0.0, 0.0))
    # Front turn-latch handle
    door.add_box((-0.18, -0.272, 0.48), (0.035, 0.035, 0.11), mat_dark, bevel=0.006)
    door.finalize("Box_Door")

    # ------------------------------------------------------------------
    # 3. Breaker_Lever (pivoted external kill-switch on +X side)
    # ------------------------------------------------------------------
    lever = MeshBuilder()
    lever.add_cylinder((0.02, 0.0, 0.0), 0.028, 0.028, 0.05, mat_dark, segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    lever.add_box((0.045, 0.0, 0.09), (0.024, 0.028, 0.20), mat_dark, bevel=0.005)
    lever.add_cylinder((0.065, 0.0, 0.18), 0.020, 0.020, 0.09, mat_lever, segments=10, rot=(0.0, math.pi * 0.5, 0.0))
    lever.finalize("Breaker_Lever", location=(0.28, -0.14, 0.52))

    # ------------------------------------------------------------------
    # 4. Status_LED (glowing live-power indicator)
    # ------------------------------------------------------------------
    led = MeshBuilder()
    led.add_cylinder((0.0, 0.0, 0.0), 0.026, 0.026, 0.025, mat_dark, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
    led.add_sphere((0.0, -0.014, 0.0), 0.020, mat_led, segments=10, rings=8)
    led.finalize("Status_LED", location=(0.16, -0.265, 0.69))

    return export_glb(
        out_dir,
        "power_box.glb",
        description="Wall-mounted electrical breaker cabinet with conduits, braided cables, hazard sign, pivoting Breaker_Lever, and emissive Status_LED.",
        category="prop",
        ground=True,
        extra_meta={
            "wallMountBackZ": 0.0,
            "animatableParts": ["Breaker_Lever", "Status_LED", "Box_Door"],
        },
    )


def build_security_camera(out_dir: str) -> dict:
    """Wall-mounted CCTV camera with wall mount bracket, pivoting Camera_Head,
    dark optical lens, and glowing red Camera_LED.
    Back wall plate at z=0 glTF, camera points along +Z glTF (slightly pitched downward).
    """
    reset_scene()

    mat_mount = make_material("CCTV_MountSteel", "#252B34", metallic=0.65, roughness=0.45)
    mat_shell = make_material("CCTV_Housing", "#CDD5DE", metallic=0.18, roughness=0.38)
    mat_dark = make_material("CCTV_Bezel", "#13171E", metallic=0.30, roughness=0.42)
    mat_lens = make_material("CCTV_Lens", "#0A1828", metallic=0.20, roughness=0.05, coat=1.0)
    mat_led = make_material("CCTV_RedLED", "#FF1E22", emission="#FF1E22", emission_strength=5.0, roughness=0.15)

    # ------------------------------------------------------------------
    # 1. Camera_Mount (wall baseplate + articulated arm to swivel joint)
    # ------------------------------------------------------------------
    mount = MeshBuilder()
    # Wall plate flush at y=0 (glTF z=0)
    mount.add_box((0.0, -0.015, 0.13), (0.16, 0.03, 0.22), mat_mount, bevel=0.008)
    # Corner mounting bolts
    for sx in (-0.055, 0.055):
        for sz in (0.05, 0.21):
            mount.add_cylinder((sx, -0.032, sz), 0.010, 0.010, 0.014, mat_shell, segments=6, rot=(math.pi * 0.5, 0.0, 0.0))
    # Support arm sweeping forward to swivel knuckle at (0, -0.25, 0.21)
    mount.add_tube([(0.0, -0.02, 0.13), (0.0, -0.17, 0.13), (0.0, -0.25, 0.20)], 0.024, mat_mount, segments=10)
    mount.add_sphere((0.0, -0.25, 0.21), 0.036, mat_dark, segments=10, rings=8)
    mount.finalize("Camera_Mount")

    # ------------------------------------------------------------------
    # 2. Camera_Head (pivoted at swivel joint (0, -0.25, 0.21) for pan!)
    # ------------------------------------------------------------------
    swivel = (0.0, -0.25, 0.21)
    head = MeshBuilder()
    # Camera body box pointing along -Y (glTF +Z)
    head.add_box((0.0, -0.09, 0.045), (0.145, 0.30, 0.125), mat_shell, bevel=0.020)
    # Sleek extended sun-shield visor hood
    head.add_box((0.0, -0.14, 0.112), (0.165, 0.36, 0.022), mat_shell, rot=(0.04, 0.0, 0.0), bevel=0.006)
    head.add_box((-0.078, -0.14, 0.075), (0.014, 0.34, 0.075), mat_shell, bevel=0.004)
    head.add_box((0.078, -0.14, 0.075), (0.014, 0.34, 0.075), mat_shell, bevel=0.004)
    # Dark front lens bezel & glossy optical lens
    head.add_box((0.0, -0.242, 0.045), (0.125, 0.025, 0.105), mat_dark, bevel=0.008)
    head.add_cylinder((0.0, -0.256, 0.050), 0.044, 0.040, 0.032, mat_dark, segments=14, rot=(math.pi * 0.5, 0.0, 0.0))
    head.add_sphere((0.0, -0.268, 0.050), 0.034, mat_lens, scale=(1.0, 0.45, 1.0), segments=12, rings=8)
    # Rear cable gland
    head.add_cylinder((0.0, 0.07, 0.045), 0.016, 0.016, 0.04, mat_dark, segments=8, rot=(math.pi * 0.5, 0.0, 0.0))

    head_obj = head.finalize("Camera_Head", location=swivel)

    # ------------------------------------------------------------------
    # 3. Camera_LED (child of Camera_Head so it pans with the camera!)
    # ------------------------------------------------------------------
    led = MeshBuilder()
    led.add_sphere((0.0, 0.0, 0.0), 0.012, mat_led, segments=8, rings=6)
    led.finalize("Camera_LED", location=(0.042, -0.258, 0.014), parent=head_obj)

    return export_glb(
        out_dir,
        "security_camera.glb",
        description="Wall-mounted CCTV security camera with swivel-pivoted Camera_Head and glowing red Camera_LED.",
        category="prop",
        ground=True,
        extra_meta={
            "wallMountBackZ": 0.0,
            "animatableParts": ["Camera_Head", "Camera_LED"],
            "panNote": "Rotate Camera_Head around Y to sweep CCTV field of view.",
        },
    )
