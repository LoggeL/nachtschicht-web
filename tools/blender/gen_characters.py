"""Procedural Blender 5.2 generators for Nachtschicht stylized low-poly characters:
- character_mara.glb  (Mara Voss: dark tech-jacket, popped collar, satchel, wrist scanner)
- character_crew.glb  (Heist Crew accomplice: bomber/utility jacket, beanie, gear backpack)
- character_guard.glb (Security guard: crisp navy uniform, peaked patrol cap, flashlight)

All characters face -Y in Blender (+Z forward in glTF/Three.js), stand ~1.75-1.80m tall,
are strictly grounded at y=0, and share an identical articulated joint hierarchy:
  Root
   └── Pelvis
        ├── Torso (+ optional Backpack)
        │    ├── Head
        │    ├── Arm_L
        │    └── Arm_R (+ optional Flashlight)
        ├── Leg_L
        └── Leg_R
"""

from __future__ import annotations

import math
from typing import Optional

from common import MeshBuilder, export_glb, make_empty, make_material, reset_scene


def _build_leg(
    name: str,
    parent,
    hip_offset_x: float,
    pelvis_z_offset: float,
    leg_len: float,
    pants_mat,
    boot_mat,
    accent_mat,
    cargo_pockets: bool = False,
):
    """Build an articulated leg extending downward from local z=0 (hip joint) to -leg_len (sole)."""
    mb = MeshBuilder()
    # Upper thigh
    mb.add_box(
        (0.0, 0.0, -leg_len * 0.24),
        (0.145, 0.155, leg_len * 0.48),
        pants_mat,
        bevel=0.025,
        taper_bottom=(0.82, 0.84),
        taper_top=(1.04, 1.02),
    )
    if cargo_pockets:
        side = 1.0 if hip_offset_x > 0 else -1.0
        mb.add_box((side * 0.072, 0.0, -leg_len * 0.28), (0.032, 0.095, 0.13), accent_mat, bevel=0.008)

    # Knee cap subtle detail
    mb.add_box((0.0, -0.055, -leg_len * 0.48), (0.105, 0.05, 0.09), pants_mat, bevel=0.015)

    # Lower shin / trouser leg
    mb.add_box(
        (0.0, 0.01, -leg_len * 0.68),
        (0.12, 0.13, leg_len * 0.42),
        pants_mat,
        bevel=0.02,
        taper_bottom=(0.82, 0.85),
        taper_top=(1.0, 0.98),
    )

    # Sturdy night-noir boot (sole strictly reaches -leg_len!)
    boot_h = 0.13
    mb.add_box(
        (0.0, -0.032, -leg_len + boot_h * 0.5),
        (0.115, 0.24, boot_h),
        boot_mat,
        bevel=0.02,
        taper_top=(0.88, 0.72),
    )
    # Boot cuff & tread sole
    mb.add_box((0.0, -0.032, -leg_len + 0.018), (0.122, 0.252, 0.036), accent_mat, bevel=0.006)

    return mb.finalize(name, location=(hip_offset_x, 0.0, pelvis_z_offset), parent=parent)


def _build_arm(
    name: str,
    parent,
    shoulder_x: float,
    shoulder_z: float,
    sleeve_mat,
    cuff_mat,
    skin_mat,
    accent_mat=None,
    wrist_glow_mat=None,
    epaulette_mat=None,
    arm_len: float = 0.59,
):
    """Build an articulated arm extending downward from local z=0 (shoulder pivot) to -arm_len."""
    mb = MeshBuilder()
    side = 1.0 if shoulder_x > 0 else -1.0

    # Rounded stylized shoulder cap
    mb.add_sphere((0.0, 0.0, -0.02), 0.072, sleeve_mat, scale=(1.0, 1.05, 1.0), segments=10, rings=8)

    if epaulette_mat is not None:
        mb.add_box((side * 0.01, 0.0, 0.042), (0.11, 0.055, 0.018), epaulette_mat, rot=(0.0, -side * 0.18, 0.0), bevel=0.004)

    # Upper arm (slight natural outward cant)
    mb.add_box(
        (side * 0.025, 0.0, -0.16),
        (0.105, 0.11, 0.27),
        sleeve_mat,
        rot=(0.0, -side * 0.07, 0.0),
        bevel=0.02,
        taper_bottom=(0.86, 0.88),
    )

    # Forearm (slight natural forward elbow bend)
    mb.add_box(
        (side * 0.042, -0.025, -0.39),
        (0.092, 0.095, 0.25),
        sleeve_mat,
        rot=(0.14, -side * 0.04, 0.0),
        bevel=0.018,
        taper_bottom=(0.82, 0.84),
    )

    # Sleeve cuff
    mb.add_cylinder((side * 0.046, -0.042, -0.50), 0.048, 0.052, 0.045, cuff_mat, segments=10, rot=(0.14, 0.0, 0.0))

    # Optional Mara wrist scanner band
    if wrist_glow_mat is not None:
        mb.add_box((side * 0.058, -0.055, -0.49), (0.045, 0.055, 0.032), accent_mat or cuff_mat, bevel=0.005)
        mb.add_box((side * 0.068, -0.062, -0.49), (0.018, 0.036, 0.020), wrist_glow_mat)

    # Stylized hand / glove
    mb.add_box(
        (side * 0.048, -0.052, -arm_len + 0.04),
        (0.068, 0.082, 0.105),
        skin_mat,
        rot=(0.12, 0.0, 0.0),
        bevel=0.016,
        taper_bottom=(0.78, 0.75),
    )

    return mb.finalize(name, location=(shoulder_x, 0.0, shoulder_z), parent=parent)


def _add_stylized_head_base(mb: MeshBuilder, skin_mat, hair_mat, eye_mat) -> None:
    """Add expressive faceted stylized head geometry (origin at neck base z=0, top ~0.29)."""
    # Neck
    mb.add_cylinder((0.0, 0.0, 0.045), 0.054, 0.050, 0.09, skin_mat, segments=10)
    # Sculpted cranium + tapered jaw
    mb.add_box(
        (0.0, -0.005, 0.185),
        (0.168, 0.192, 0.215),
        skin_mat,
        bevel=0.048,
        bevel_segments=2,
        taper_bottom=(0.76, 0.80),
        taper_top=(0.94, 0.96),
        smooth=False,
    )
    # Subtle stylized nose bridge facing -Y (glTF +Z) so facing direction reads crisply
    mb.add_box((0.0, -0.098, 0.175), (0.026, 0.032, 0.048), skin_mat, rot=(0.18, 0.0, 0.0), bevel=0.006)
    # Expressive shadowed brow ridge / eyes
    for sx in (-0.038, 0.038):
        mb.add_box((sx, -0.092, 0.205), (0.034, 0.014, 0.014), hair_mat)
        mb.add_box((sx, -0.091, 0.190), (0.022, 0.012, 0.012), eye_mat)


def build_character_mara(out_dir: str) -> dict:
    """Mara Voss (34): Ex-Securion security engineer in sleek dark tech-jacket,
    popped collar, crossbody leather satchel, glowing cyan wrist-scanner.
    Height ~1.75m, grounded at y=0, forward +Z.
    """
    reset_scene()

    mat_skin = make_material("Mara_Skin", "#D8A686", roughness=0.65)
    mat_hair = make_material("Mara_Hair", "#3E2018", roughness=0.52)
    mat_eye = make_material("Mara_Eye", "#1B2630", roughness=0.3)
    mat_jacket = make_material("Mara_TechJacket", "#263550", metallic=0.14, roughness=0.48)
    mat_jacket_dark = make_material("Mara_JacketTrim", "#151D2C", metallic=0.18, roughness=0.44)
    mat_shirt = make_material("Mara_InnerTop", "#3C506E", roughness=0.62)
    mat_pants = make_material("Mara_Trousers", "#1B202C", roughness=0.72)
    mat_boots = make_material("Mara_Boots", "#111319", metallic=0.1, roughness=0.40)
    mat_satchel = make_material("Mara_SatchelLeather", "#6A3F26", roughness=0.52)
    mat_brass = make_material("Mara_Brass", "#C89B4B", metallic=0.85, roughness=0.28)
    mat_cyan = make_material("Mara_ScannerCyan", "#2CE6D8", emission="#2CE6D8", emission_strength=3.2, roughness=0.2)
    mat_amber = make_material("Mara_AccentAmber", "#E59A3C", metallic=0.3, roughness=0.35)

    root = make_empty("Root", (0.0, 0.0, 0.0))
    pelvis = make_empty("Pelvis", (0.0, 0.0, 0.90), parent=root)

    # Legs (hip at world z=0.88 -> local z=-0.02 from Pelvis)
    _build_leg("Leg_L", pelvis, 0.095, -0.02, 0.88, mat_pants, mat_boots, mat_jacket_dark)
    _build_leg("Leg_R", pelvis, -0.095, -0.02, 0.88, mat_pants, mat_boots, mat_jacket_dark)

    # Torso (waist pivot at world z=0.94 -> local z=+0.04 from Pelvis)
    torso_mb = MeshBuilder()
    # Pelvis/hips jacket hem skirt
    torso_mb.add_box((0.0, 0.0, -0.04), (0.31, 0.21, 0.16), mat_jacket, bevel=0.03, taper_top=(0.90, 0.92), taper_bottom=(1.06, 1.05))
    # Fitted main tech-jacket torso (wider shoulders, slim waist)
    torso_mb.add_box((0.0, 0.0, 0.23), (0.36, 0.22, 0.44), mat_jacket, bevel=0.035, taper_bottom=(0.80, 0.84), taper_top=(1.04, 0.98))
    # Front inner zip V-panel & crisp brass zipper strip
    torso_mb.add_box((0.0, -0.102, 0.26), (0.11, 0.035, 0.36), mat_shirt, bevel=0.008, taper_bottom=(0.55, 1.0))
    torso_mb.add_box((0.0, -0.116, 0.24), (0.018, 0.016, 0.40), mat_brass)
    # Iconic popped tech-jacket high collar
    collar_pts = [
        (0.085, -0.075, 0.45),
        (0.11, 0.0, 0.48),
        (0.07, 0.095, 0.50),
        (0.0, 0.11, 0.51),
        (-0.07, 0.095, 0.50),
        (-0.11, 0.0, 0.48),
        (-0.085, -0.075, 0.45),
    ]
    torso_mb.add_tube(collar_pts, 0.034, mat_jacket_dark, segments=8, smooth=False)
    # Shoulder accent strips
    for sx in (-1.0, 1.0):
        torso_mb.add_box((sx * 0.135, 0.0, 0.445), (0.09, 0.14, 0.025), mat_jacket_dark, bevel=0.005)
    # Subtle amber tech-patch on upper chest
    torso_mb.add_box((0.095, -0.112, 0.34), (0.048, 0.012, 0.022), mat_amber)
    # Utility belt
    torso_mb.add_box((0.0, 0.0, 0.02), (0.31, 0.215, 0.055), mat_jacket_dark, bevel=0.01)
    torso_mb.add_box((0.0, -0.112, 0.02), (0.055, 0.022, 0.048), mat_brass, bevel=0.006)

    # Crossbody leather tech-satchel (strap from left shoulder to right hip + satchel bag)
    strap_front = [(0.12, -0.105, 0.44), (0.01, -0.118, 0.22), (-0.15, -0.095, 0.03), (-0.19, 0.02, -0.05)]
    strap_back = [(0.12, 0.105, 0.44), (0.02, 0.118, 0.22), (-0.15, 0.095, 0.03), (-0.19, 0.02, -0.05)]
    torso_mb.add_tube(strap_front, 0.020, mat_satchel, segments=6, smooth=False)
    torso_mb.add_tube(strap_back, 0.020, mat_satchel, segments=6, smooth=False)
    # Satchel bag at right hip (-X)
    torso_mb.add_box((-0.20, 0.03, -0.08), (0.10, 0.24, 0.20), mat_satchel, rot=(0.0, 0.12, 0.08), bevel=0.018)
    torso_mb.add_box((-0.245, 0.03, -0.03), (0.025, 0.22, 0.09), mat_satchel, rot=(0.0, 0.14, 0.08), bevel=0.008)
    torso_mb.add_box((-0.255, 0.03, -0.075), (0.018, 0.04, 0.035), mat_brass)
    torso_mb.add_box((-0.250, -0.05, -0.01), (0.015, 0.028, 0.015), mat_cyan)

    torso = torso_mb.finalize("Torso", location=(0.0, 0.0, 0.04), parent=pelvis)

    # Head (neck base at world z=1.45 -> local z=+0.51 from Torso)
    head_mb = MeshBuilder()
    _add_stylized_head_base(head_mb, mat_skin, mat_hair, mat_eye)
    # Sleek sculpted bob haircut hugging crown, temples, and nape cleanly
    head_mb.add_sphere((0.0, 0.014, 0.236), 0.105, mat_hair, scale=(0.92, 1.04, 0.80), segments=14, rings=10, smooth=False)
    head_mb.add_box((0.0, 0.056, 0.165), (0.172, 0.118, 0.150), mat_hair, rot=(0.10, 0.0, 0.0), bevel=0.028)
    # Sleek tucked side-swept bob locks framing cheeks tightly
    for sx in (-1.0, 1.0):
        head_mb.add_box((sx * 0.080, 0.010, 0.188), (0.024, 0.095, 0.125), mat_hair, bevel=0.008)
    # Asymmetric swept fringe across forehead
    head_mb.add_box((0.020, -0.068, 0.246), (0.155, 0.068, 0.056), mat_hair, rot=(0.10, 0.12, -0.08), bevel=0.016)
    # Low bun at nape + tactical comm earpiece
    head_mb.add_sphere((0.0, 0.118, 0.142), 0.050, mat_hair, scale=(1.0, 1.10, 0.90), segments=10, rings=8)
    head_mb.add_box((0.088, -0.012, 0.160), (0.018, 0.024, 0.032), mat_jacket_dark, bevel=0.004)
    head_mb.add_box((0.095, -0.016, 0.160), (0.009, 0.012, 0.012), mat_cyan)
    head_mb.finalize("Head", location=(0.0, 0.0, 0.51), parent=torso)

    # Arms (shoulders at world z=1.37 -> local z=+0.43 from Torso)
    _build_arm("Arm_L", torso, 0.215, 0.43, mat_jacket, mat_jacket_dark, mat_skin, accent_mat=mat_jacket_dark, wrist_glow_mat=mat_cyan, arm_len=0.58)
    _build_arm("Arm_R", torso, -0.215, 0.43, mat_jacket, mat_jacket_dark, mat_skin, arm_len=0.58)

    return export_glb(
        out_dir,
        "character_mara.glb",
        description="Mara Voss (protagonist): stylized night-noir security engineer in dark popped-collar tech-jacket, leather crossbody satchel, and glowing cyan wrist scanner.",
        category="character",
        ground=True,
        extra_meta={
            "rigHierarchy": "Root > Pelvis > (Leg_L, Leg_R, Torso > (Head, Arm_L, Arm_R))",
            "animatableParts": ["Pelvis", "Torso", "Head", "Arm_L", "Arm_R", "Leg_L", "Leg_R"],
        },
    )


def build_character_crew(out_dir: str) -> dict:
    """Heist Crew Accomplice (versatile base for Jupp/Jule/Toni/Rico):
    Dark utility bomber jacket over warm amber-accented hoodie, knit beanie,
    cargo trousers, and removable heist gear backpack.
    Height ~1.78m, grounded at y=0, forward +Z.
    """
    reset_scene()

    mat_skin = make_material("Crew_Skin", "#C89574", roughness=0.68)
    mat_hair = make_material("Crew_Hair", "#26201D", roughness=0.65)
    mat_eye = make_material("Crew_Eye", "#1B2028", roughness=0.35)
    mat_jacket = make_material("Crew_UtilityJacket", "#262E2B", roughness=0.62)
    mat_hoodie = make_material("Crew_AccentHoodie", "#A6652E", roughness=0.72)
    mat_vest = make_material("Crew_DarkTrim", "#171B20", roughness=0.55)
    mat_pants = make_material("Crew_CargoPants", "#1D212A", roughness=0.75)
    mat_boots = make_material("Crew_Boots", "#141210", roughness=0.50)
    mat_beanie = make_material("Crew_Beanie", "#1A202B", roughness=0.82)
    mat_pack = make_material("Crew_Backpack", "#2E261F", roughness=0.68)
    mat_metal = make_material("Crew_Metal", "#8D96A0", metallic=0.82, roughness=0.32)

    root = make_empty("Root", (0.0, 0.0, 0.0))
    pelvis = make_empty("Pelvis", (0.0, 0.0, 0.91), parent=root)

    _build_leg("Leg_L", pelvis, 0.105, -0.02, 0.89, mat_pants, mat_boots, mat_vest, cargo_pockets=True)
    _build_leg("Leg_R", pelvis, -0.105, -0.02, 0.89, mat_pants, mat_boots, mat_vest, cargo_pockets=True)

    # Broad utility bomber jacket torso
    torso_mb = MeshBuilder()
    torso_mb.add_box((0.0, 0.0, -0.03), (0.34, 0.23, 0.14), mat_vest, bevel=0.025)
    torso_mb.add_box((0.0, 0.0, 0.24), (0.40, 0.25, 0.45), mat_jacket, bevel=0.04, taper_bottom=(0.86, 0.88), taper_top=(1.04, 1.0))
    # Warm amber inner hoodie chest & folded back hood collar
    torso_mb.add_box((0.0, -0.115, 0.26), (0.14, 0.04, 0.36), mat_hoodie, bevel=0.012)
    torso_mb.add_box((0.0, 0.095, 0.44), (0.24, 0.11, 0.11), mat_hoodie, rot=(0.25, 0.0, 0.0), bevel=0.035)
    # Tool belt + pouches
    torso_mb.add_box((0.0, 0.0, 0.02), (0.35, 0.24, 0.06), mat_vest, bevel=0.01)
    torso_mb.add_box((0.0, -0.125, 0.02), (0.065, 0.024, 0.052), mat_metal, bevel=0.005)
    for sx in (-0.17, 0.17):
        torso_mb.add_box((sx, -0.02, 0.01), (0.055, 0.09, 0.095), mat_pack, bevel=0.012)
    # Chest utility pocket
    torso_mb.add_box((0.11, -0.125, 0.31), (0.08, 0.025, 0.09), mat_vest, bevel=0.008)
    torso = torso_mb.finalize("Torso", location=(0.0, 0.0, 0.04), parent=pelvis)

    # Separate Backpack child mesh on Torso (heist tool/loot duffel pack)
    pack_mb = MeshBuilder()
    pack_mb.add_box((0.0, 0.18, 0.25), (0.29, 0.16, 0.36), mat_pack, bevel=0.038, taper_top=(0.88, 0.82))
    pack_mb.add_box((0.0, 0.255, 0.17), (0.23, 0.05, 0.14), mat_vest, bevel=0.015)
    # Carabiner / tool hardware accents
    for sx in (-0.09, 0.09):
        pack_mb.add_box((sx, 0.26, 0.32), (0.026, 0.03, 0.055), mat_metal, bevel=0.005)
        pack_mb.add_box((sx * 1.15, 0.08, 0.32), (0.038, 0.12, 0.26), mat_vest, bevel=0.008)
    pack_mb.finalize("Backpack", location=(0.0, 0.0, 0.0), parent=torso)

    # Head with snug ribbed knit beanie (hugging cranium cleanly)
    head_mb = MeshBuilder()
    _add_stylized_head_base(head_mb, mat_skin, mat_hair, mat_eye)
    head_mb.add_sphere((0.0, 0.008, 0.242), 0.104, mat_beanie, scale=(0.95, 1.07, 0.86), segments=12, rings=8)
    head_mb.add_cylinder((0.0, 0.004, 0.232), 0.102, 0.100, 0.048, mat_vest, segments=12, rot=(0.10, 0.0, 0.0))
    head_mb.finalize("Head", location=(0.0, 0.0, 0.52), parent=torso)

    # Arms
    _build_arm("Arm_L", torso, 0.235, 0.43, mat_jacket, mat_vest, mat_skin, arm_len=0.60)
    _build_arm("Arm_R", torso, -0.235, 0.43, mat_jacket, mat_vest, mat_skin, arm_len=0.60)

    return export_glb(
        out_dir,
        "character_crew.glb",
        description="Heist crew accomplice in dark utility bomber jacket, warm amber hoodie accent, knit beanie, cargo pants, and removable gear Backpack.",
        category="character",
        ground=True,
        extra_meta={
            "rigHierarchy": "Root > Pelvis > (Leg_L, Leg_R, Torso > (Backpack, Head, Arm_L, Arm_R))",
            "animatableParts": ["Pelvis", "Torso", "Head", "Arm_L", "Arm_R", "Leg_L", "Leg_R", "Backpack"],
        },
    )


def build_character_guard(out_dir: str) -> dict:
    """Securion / Catalan Private Security Guard:
    Crisp dark navy uniform, light-blue epaulettes, silver badge, duty belt with radio,
    peaked security patrol cap, and held metallic Flashlight with warm emissive lens.
    Height ~1.80m, grounded at y=0, forward +Z.
    """
    reset_scene()

    mat_skin = make_material("Guard_Skin", "#CE9B7A", roughness=0.68)
    mat_hair = make_material("Guard_Hair", "#231E1B", roughness=0.65)
    mat_eye = make_material("Guard_Eye", "#181E26", roughness=0.3)
    mat_uniform = make_material("Guard_UniformNavy", "#243A5E", roughness=0.55)
    mat_uniform_dark = make_material("Guard_DarkNavy", "#121C30", roughness=0.55)
    mat_epaulette = make_material("Guard_EpauletteBlue", "#88B0DC", roughness=0.45)
    mat_belt = make_material("Guard_DutyBelt", "#121418", metallic=0.15, roughness=0.40)
    mat_silver = make_material("Guard_SilverBadge", "#CFD8E2", metallic=0.90, roughness=0.20)
    mat_visor = make_material("Guard_CapVisor", "#0B0D12", metallic=0.15, roughness=0.18, coat=0.8)
    mat_torch = make_material("Guard_FlashlightBody", "#1C2129", metallic=0.78, roughness=0.30)
    mat_lens = make_material("Guard_FlashlightLens", "#FFF5D6", emission="#FFE9AD", emission_strength=4.5, roughness=0.1)

    root = make_empty("Root", (0.0, 0.0, 0.0))
    pelvis = make_empty("Pelvis", (0.0, 0.0, 0.92), parent=root)

    _build_leg("Leg_L", pelvis, 0.105, -0.02, 0.90, mat_uniform_dark, mat_belt, mat_belt)
    _build_leg("Leg_R", pelvis, -0.105, -0.02, 0.90, mat_uniform_dark, mat_belt, mat_belt)

    # Crisp Security Uniform Torso
    torso_mb = MeshBuilder()
    torso_mb.add_box((0.0, 0.0, -0.03), (0.34, 0.22, 0.14), mat_uniform_dark, bevel=0.025)
    torso_mb.add_box((0.0, 0.0, 0.24), (0.41, 0.24, 0.45), mat_uniform, bevel=0.035, taper_bottom=(0.84, 0.86), taper_top=(1.04, 1.0))
    # Shirt collar + dark tactical tie
    torso_mb.add_box((0.0, -0.115, 0.27), (0.044, 0.022, 0.32), mat_uniform_dark, taper_bottom=(1.3, 1.0))
    torso_mb.add_cylinder((0.0, 0.0, 0.465), 0.095, 0.088, 0.055, mat_uniform, segments=12)
    # Silver Securion/Security chest badge & pocket flaps
    torso_mb.add_box((0.105, -0.125, 0.34), (0.048, 0.016, 0.056), mat_silver, bevel=0.005)
    for sx in (-0.105, 0.105):
        torso_mb.add_box((sx, -0.120, 0.28), (0.082, 0.018, 0.075), mat_uniform_dark, bevel=0.005)
    # Shoulder epaulettes
    for sx in (-1.0, 1.0):
        torso_mb.add_box((sx * 0.15, 0.0, 0.468), (0.10, 0.055, 0.018), mat_epaulette, bevel=0.004)
    # Duty belt + silver buckle + hip walkie-talkie radio with antenna
    torso_mb.add_box((0.0, 0.0, 0.02), (0.36, 0.24, 0.065), mat_belt, bevel=0.01)
    torso_mb.add_box((0.0, -0.126, 0.02), (0.062, 0.022, 0.054), mat_silver, bevel=0.005)
    torso_mb.add_box((0.195, -0.02, 0.03), (0.052, 0.078, 0.12), mat_belt, bevel=0.01)
    torso_mb.add_cylinder((0.20, -0.04, 0.145), 0.006, 0.004, 0.14, mat_belt, segments=6)

    torso = torso_mb.finalize("Torso", location=(0.0, 0.0, 0.04), parent=pelvis)

    # Head with peaked security patrol cap
    head_mb = MeshBuilder()
    _add_stylized_head_base(head_mb, mat_skin, mat_hair, mat_eye)
    # Short cropped hair sides
    head_mb.add_box((0.0, 0.025, 0.21), (0.175, 0.185, 0.11), mat_hair, bevel=0.03)
    # Peaked security patrol cap (snug fit on brow + glossy front brim + silver emblem)
    head_mb.add_cylinder((0.0, 0.006, 0.254), 0.102, 0.114, 0.068, mat_uniform, segments=14, rot=(0.06, 0.0, 0.0))
    head_mb.add_cylinder((0.0, 0.002, 0.226), 0.100, 0.102, 0.030, mat_belt, segments=14, rot=(0.06, 0.0, 0.0))
    # Glossy forward brim visor (-Y = glTF +Z)
    head_mb.add_box((0.0, -0.112, 0.218), (0.162, 0.112, 0.016), mat_visor, rot=(0.14, 0.0, 0.0), bevel=0.006, taper_top=(0.88, 0.92))
    # Silver front cap badge
    head_mb.add_box((0.0, -0.106, 0.256), (0.038, 0.016, 0.038), mat_silver, bevel=0.005)
    head_mb.finalize("Head", location=(0.0, 0.0, 0.52), parent=torso)

    # Arms
    _build_arm("Arm_L", torso, 0.235, 0.43, mat_uniform, mat_uniform_dark, mat_skin, epaulette_mat=mat_epaulette, arm_len=0.60)
    arm_r = _build_arm("Arm_R", torso, -0.235, 0.43, mat_uniform, mat_uniform_dark, mat_skin, epaulette_mat=mat_epaulette, arm_len=0.60)

    # Metallic Flashlight child mesh held in Guard's right hand (pointing forward -Y / glTF +Z)
    fl_mb = MeshBuilder()
    fl_mb.add_cylinder((0.0, -0.02, 0.0), 0.022, 0.022, 0.22, mat_torch, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
    fl_mb.add_cylinder((0.0, -0.145, 0.0), 0.024, 0.036, 0.065, mat_torch, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
    fl_mb.add_cylinder((0.0, -0.180, 0.0), 0.032, 0.032, 0.012, mat_lens, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))
    fl_mb.finalize("Flashlight", location=(-0.048, -0.075, -0.56), parent=arm_r)

    return export_glb(
        out_dir,
        "character_guard.glb",
        description="Securion / Catalan private security guard in crisp navy uniform, silver badge, peaked patrol cap, hip radio, and held emissive Flashlight.",
        category="character",
        ground=True,
        extra_meta={
            "rigHierarchy": "Root > Pelvis > (Leg_L, Leg_R, Torso > (Head, Arm_L, Arm_R > Flashlight))",
            "animatableParts": ["Pelvis", "Torso", "Head", "Arm_L", "Arm_R", "Leg_L", "Leg_R", "Flashlight"],
        },
    )
