"""Procedural Blender 5.2 generators for Nachtschicht vehicles:
- getaway_car.glb: Sleek European night getaway sport-coupe
- police_car.glb: Catalan Mossos-inspired patrol cruiser with red/blue lightbar
"""

from __future__ import annotations

import math
from typing import List, Tuple

from common import MeshBuilder, export_glb, make_material, reset_scene


def _build_wheel(
    name: str,
    location: Tuple[float, float, float],
    radius: float,
    width: float,
    rim_mat,
    tire_mat,
    caliper_mat,
    hub_mat,
    is_left: bool,
    spokes: int = 5,
    police_steelie: bool = False,
) -> None:
    """Build a centered wheel mesh with origin strictly at wheel hub center.
    Axle is along X so Three.js `wheel.rotation.x` spins forward/backward cleanly.
    """
    mb = MeshBuilder()
    side_sign = 1.0 if is_left else -1.0  # +X is left (outside for FL/RL), -X is right

    # Outer tire tread (beveled silhouette via 5-ring profile along X)
    r_out = radius
    r_shld = radius * 0.965
    r_rim = radius * 0.64
    hw = width * 0.5
    segs = 20

    def ring_x(x_pos: float, r: float) -> List[Tuple[float, float, float]]:
        return [
            (x_pos, math.cos(2 * math.pi * i / segs) * r, math.sin(2 * math.pi * i / segs) * r)
            for i in range(segs)
        ]

    # Outer tire surface from inner sidewall -> tread -> outer sidewall
    tire_rings = [
        ring_x(-hw * 0.88, r_rim),
        ring_x(-hw, r_shld),
        ring_x(-hw * 0.78, r_out),
        ring_x(hw * 0.78, r_out),
        ring_x(hw, r_shld),
        ring_x(hw * 0.88, r_rim),
    ]
    mb.add_loft(tire_rings, tire_mat, cap_start=True, cap_end=True, smooth=True)

    # Alloy rim dish / inner barrel
    mb.add_cylinder(
        (0.0, 0.0, 0.0),
        r_rim * 1.02,
        r_rim * 1.02,
        width * 0.82,
        rim_mat,
        segments=segs,
        rot=(0.0, math.pi * 0.5, 0.0),
        smooth=True,
    )

    # Recessed rim lip on outside face
    outer_x = side_sign * (hw * 0.45)
    rim_face_x = side_sign * (hw * 0.50)

    if police_steelie:
        # Rugged patrol steelie with chrome center cap & lug bolts
        mb.add_cylinder(
            (side_sign * hw * 0.44, 0.0, 0.0),
            r_rim * 0.94,
            r_rim * 0.84,
            width * 0.14,
            rim_mat,
            segments=16,
            rot=(0.0, math.pi * 0.5, 0.0),
            smooth=True,
        )
        mb.add_cylinder(
            (side_sign * hw * 0.51, 0.0, 0.0),
            r_rim * 0.46,
            r_rim * 0.38,
            width * 0.10,
            hub_mat,
            segments=14,
            rot=(0.0, math.pi * 0.5, 0.0),
            smooth=True,
        )
    else:
        # Sporty 5-spoke alloy rim
        # Brake rotor & caliper visible slightly behind spokes
        mb.add_cylinder(
            (side_sign * hw * 0.22, 0.0, 0.0),
            r_rim * 0.72,
            r_rim * 0.72,
            width * 0.10,
            hub_mat,
            segments=16,
            rot=(0.0, math.pi * 0.5, 0.0),
            smooth=False,
        )
        mb.add_box(
            (side_sign * hw * 0.28, -r_rim * 0.46, 0.05),
            (width * 0.14, r_rim * 0.34, r_rim * 0.52),
            caliper_mat,
            bevel=0.01,
        )
        # Bright alloy outer rim lip ring
        mb.add_cylinder(
            (side_sign * hw * 0.46, 0.0, 0.0),
            r_rim * 1.03,
            r_rim * 0.96,
            width * 0.08,
            rim_mat,
            segments=segs,
            rot=(0.0, math.pi * 0.5, 0.0),
            smooth=True,
        )
        # Center hub
        mb.add_cylinder(
            (rim_face_x, 0.0, 0.0),
            r_rim * 0.26,
            r_rim * 0.22,
            width * 0.12,
            hub_mat,
            segments=12,
            rot=(0.0, math.pi * 0.5, 0.0),
            smooth=True,
        )
        # Sculpted spokes radiating from hub
        for s in range(spokes):
            ang = (2.0 * math.pi * s) / spokes
            cy = math.cos(ang) * (r_rim * 0.54)
            cz = math.sin(ang) * (r_rim * 0.54)
            mb.add_box(
                (outer_x, cy, cz),
                (width * 0.14, r_rim * 0.76, 0.052),
                rim_mat,
                rot=(ang, 0.0, 0.0),
                bevel=0.008,
            )

    mb.finalize(name=name, location=location)


def _car_body_ring(
    y: float,
    hw_bot: float,
    hw_mid: float,
    hw_top: float,
    z_bot: float,
    z_mid: float,
    z_top: float,
    crown: float = 0.03,
) -> List[Tuple[float, float, float]]:
    """8-point symmetrical sculpted lower-body cross-section at station y."""
    return [
        (-hw_bot, y, z_bot),
        (hw_bot, y, z_bot),
        (hw_mid, y, z_mid),
        (hw_top, y, z_top),
        (hw_top * 0.45, y, z_top + crown),
        (-hw_top * 0.45, y, z_top + crown),
        (-hw_top, y, z_top),
        (-hw_mid, y, z_mid),
    ]


def build_getaway_car(out_dir: str) -> dict:
    """Sleek stylized European night getaway sport-coupe.
    Front = -Y (glTF +Z), Rear = +Y (glTF -Z), Up = +Z (glTF +Y).
    """
    reset_scene()

    # Mediterranean Night Noir materials
    mat_paint = make_material("Coupe_MidnightPaint", "#253858", metallic=0.72, roughness=0.22, coat=0.95, coat_roughness=0.07)
    mat_trim = make_material("Coupe_DarkTrim", "#12151C", metallic=0.25, roughness=0.58)
    mat_chrome = make_material("Coupe_BrushedSteel", "#CCD5DF", metallic=0.90, roughness=0.20)
    mat_grille = make_material("Coupe_Grille", "#0D1016", metallic=0.4, roughness=0.65)
    mat_glass = make_material("Coupe_TintedGlass", "#152B42", metallic=0.1, roughness=0.06, alpha=0.50, coat=1.0, double_sided=True)
    mat_interior = make_material("Coupe_Interior", "#1A1E28", metallic=0.0, roughness=0.85)
    mat_dash = make_material("Coupe_DashAccent", "#2B3646", metallic=0.1, roughness=0.65)
    mat_headlight = make_material("Coupe_Headlight", "#FFF3D4", metallic=0.1, roughness=0.1, emission="#FFE4A8", emission_strength=4.5)
    mat_taillight = make_material("Coupe_Taillight", "#D91E2A", metallic=0.1, roughness=0.15, emission="#FF1E2D", emission_strength=4.0)
    mat_tire = make_material("Coupe_Tire", "#171A1F", metallic=0.0, roughness=0.88)
    mat_rim = make_material("Coupe_AlloyRim", "#DCE3EB", metallic=0.88, roughness=0.20)
    mat_caliper = make_material("Coupe_BrakeCaliper", "#C9242E", metallic=0.5, roughness=0.35)
    mat_hub = make_material("Coupe_Hub", "#525A66", metallic=0.75, roughness=0.32)
    mat_plate = make_material("Coupe_Plate", "#DCE2EA", metallic=0.1, roughness=0.4)

    # ------------------------------------------------------------------
    # 1. Body (sculpted lower chassis + roof/pillars + trim + spoiler)
    # ------------------------------------------------------------------
    body = MeshBuilder()

    # Main sculpted lower body loft (front y=-2.24 to rear y=+2.18)
    lower_rings = [
        _car_body_ring(-2.24, 0.72, 0.80, 0.74, 0.24, 0.42, 0.58, 0.02),  # nose tip
        _car_body_ring(-2.08, 0.84, 0.91, 0.84, 0.21, 0.48, 0.70, 0.03),  # front bumper
        _car_body_ring(-1.42, 0.88, 0.96, 0.89, 0.20, 0.56, 0.81, 0.04),  # front fender flare
        _car_body_ring(-0.82, 0.87, 0.94, 0.87, 0.20, 0.56, 0.87, 0.03),  # cowl / hood base
        _car_body_ring(0.25,  0.87, 0.94, 0.87, 0.20, 0.57, 0.89, 0.02),  # mid doors
        _car_body_ring(1.28,  0.89, 0.98, 0.90, 0.21, 0.60, 0.94, 0.03),  # rear haunch
        _car_body_ring(1.98,  0.83, 0.91, 0.84, 0.25, 0.62, 0.91, 0.02),  # trunk tail
        _car_body_ring(2.18,  0.74, 0.84, 0.78, 0.29, 0.58, 0.85, 0.01),  # rear fascia
    ]
    body.add_loft(lower_rings, mat_paint, cap_start=True, cap_end=True, smooth=False)

    # Dark underbody floorpan + lower side skirts
    body.add_box((0.0, -0.02, 0.20), (1.62, 3.96, 0.08), mat_trim)
    for sx in (-0.90, 0.90):
        body.add_box((sx, 0.02, 0.22), (0.08, 1.98, 0.10), mat_trim, bevel=0.015)

    # Front aggressive splitter & intake grille
    body.add_box((0.0, -2.18, 0.20), (1.72, 0.26, 0.06), mat_trim, bevel=0.015)
    body.add_box((0.0, -2.23, 0.42), (1.18, 0.08, 0.22), mat_grille, bevel=0.01)
    # Horizontal chrome/dark grille accent slats
    for gz in (0.37, 0.44):
        body.add_box((0.0, -2.26, gz), (1.10, 0.03, 0.025), mat_chrome)
    # Side brake cooling intakes
    for sx in (-0.68, 0.68):
        body.add_box((sx, -2.18, 0.34), (0.32, 0.08, 0.14), mat_grille, rot=(0.0, 0.0, 0.18 * (1 if sx > 0 else -1)))

    # Sculpted hood power dome crease
    body.add_box((0.0, -1.42, 0.84), (0.86, 1.15, 0.05), mat_paint, rot=(-0.09, 0.0, 0.0), bevel=0.02)

    # Fastback roof skin & structural pillars (A, B, C pillars)
    # Roof cap
    roof_rings = [
        _car_body_ring(-0.18, 0.64, 0.64, 0.60, 1.29, 1.32, 1.34, 0.025),
        _car_body_ring(0.58,  0.63, 0.63, 0.59, 1.28, 1.31, 1.33, 0.025),
        _car_body_ring(1.06,  0.66, 0.66, 0.61, 1.15, 1.19, 1.21, 0.02),
    ]
    body.add_loft(roof_rings, mat_paint, cap_start=True, cap_end=True, smooth=False)

    # A-pillars (raked front windshield frame)
    for sx in (-1.0, 1.0):
        body.add_tube(
            [(sx * 0.78, -0.82, 0.86), (sx * 0.62, -0.18, 1.32)],
            [0.042, 0.036],
            mat_paint,
            segments=8,
            smooth=False,
        )
        # B-pillars (slim dark door divider)
        body.add_tube(
            [(sx * 0.78, 0.34, 0.88), (sx * 0.63, 0.38, 1.31)],
            [0.032, 0.028],
            mat_trim,
            segments=6,
            smooth=False,
        )
        # Fastback C-pillars (muscular sweeping coupe rear pillars)
        body.add_tube(
            [(sx * 0.61, 0.68, 1.31), (sx * 0.72, 1.24, 1.11), (sx * 0.80, 1.66, 0.92)],
            [0.055, 0.065, 0.058],
            mat_paint,
            segments=8,
            smooth=False,
        )

    # Flared dark wheel-arch moldings over all 4 wheel wells
    wheel_coords = [
        (0.84, -1.36, 0.34, True),
        (-0.84, -1.36, 0.34, False),
        (0.84, 1.32, 0.34, True),
        (-0.84, 1.32, 0.34, False),
    ]
    for wx, wy, wz, is_left in wheel_coords:
        sx = 1.0 if is_left else -1.0
        # Dark recessed upper wheel-well arch liner (kept cleanly above z=0.20 so tires rest at y=0!)
        body.add_box((sx * 0.78, wy, wz + 0.16), (0.30, 0.76, 0.42), mat_grille, bevel=0.04)
        # Subtle fender brow flare arc
        arc_pts = []
        for k in range(9):
            ang = math.pi * (0.08 + 0.84 * k / 8.0)
            arc_pts.append((sx * 0.96, wy - math.cos(ang) * 0.42, wz + math.sin(ang) * 0.40))
        body.add_tube(arc_pts, 0.038, mat_paint, segments=6, smooth=False)

    # Side-view mirrors
    for sx in (-1.0, 1.0):
        body.add_box((sx * 0.90, -0.58, 0.94), (0.14, 0.07, 0.04), mat_trim, rot=(0.0, 0.0, -sx * 0.25))
        body.add_box((sx * 1.00, -0.56, 0.97), (0.16, 0.12, 0.09), mat_paint, bevel=0.025)

    # Door handles
    for sx in (-1.0, 1.0):
        body.add_box((sx * 0.94, 0.24, 0.77), (0.04, 0.16, 0.035), mat_chrome, bevel=0.008)

    # Rear lip spoiler + rear diffuser + dual chrome exhaust tips
    body.add_box((0.0, 2.08, 0.95), (1.56, 0.20, 0.045), mat_trim, rot=(0.14, 0.0, 0.0), bevel=0.01)
    body.add_box((0.0, 2.15, 0.28), (1.36, 0.14, 0.14), mat_trim, bevel=0.015)
    for sx in (-0.48, -0.34, 0.34, 0.48):
        body.add_cylinder((sx, 2.20, 0.26), 0.042, 0.042, 0.14, mat_chrome, segments=12, rot=(math.pi * 0.5, 0.0, 0.0))

    # Front & rear license plates
    body.add_box((0.0, -2.25, 0.32), (0.46, 0.02, 0.11), mat_plate)
    body.add_box((0.0, 2.19, 0.52), (0.46, 0.02, 0.11), mat_plate)

    body.finalize("Body")

    # ------------------------------------------------------------------
    # 2. Tinted Glass (windshield, fastback rear glass, side windows)
    # ------------------------------------------------------------------
    glass = MeshBuilder()
    # Front windshield quad
    glass.add_quad_sheet(
        (-0.76, -0.82, 0.86),
        (0.76, -0.82, 0.86),
        (0.61, -0.18, 1.31),
        (-0.61, -0.18, 1.31),
        mat_glass,
    )
    # Rear fastback glass
    glass.add_quad_sheet(
        (-0.59, 0.72, 1.29),
        (0.59, 0.72, 1.29),
        (0.76, 1.62, 0.92),
        (-0.76, 1.62, 0.92),
        mat_glass,
    )
    # Left & right side window ribbons
    for sx in (-1.0, 1.0):
        # Front door window
        pts = [
            (sx * 0.78, -0.76, 0.87),
            (sx * 0.80, 0.34, 0.89),
            (sx * 0.63, 0.36, 1.30),
            (sx * 0.62, -0.16, 1.30),
        ]
        if sx < 0:
            pts.reverse()
        glass.add_quad_sheet(*pts, mat_glass)
        # Rear quarter window
        pts2 = [
            (sx * 0.80, 0.36, 0.89),
            (sx * 0.78, 1.22, 0.92),
            (sx * 0.65, 1.04, 1.18),
            (sx * 0.63, 0.38, 1.30),
        ]
        if sx < 0:
            pts2.reverse()
        glass.add_quad_sheet(*pts2, mat_glass)

    glass.finalize("Glass")

    # ------------------------------------------------------------------
    # 3. Interior silhouette (visible through smoked tinted windows)
    # ------------------------------------------------------------------
    intr = MeshBuilder()
    # Dashboard & center console
    intr.add_box((0.0, -0.58, 0.82), (1.36, 0.42, 0.24), mat_dash, bevel=0.03)
    intr.add_box((0.0, 0.05, 0.62), (0.28, 1.15, 0.28), mat_interior, bevel=0.02)
    # Steering wheel on left (European LHD: +X)
    intr.add_cylinder((0.36, -0.34, 0.94), 0.16, 0.16, 0.035, mat_interior, segments=14, rot=(1.22, 0.0, 0.0))
    # Two sport bucket seats with headrests
    for sx in (-0.36, 0.36):
        intr.add_box((sx, 0.05, 0.56), (0.44, 0.48, 0.14), mat_interior, bevel=0.03)
        intr.add_box((sx, 0.24, 0.84), (0.42, 0.14, 0.52), mat_interior, rot=(0.20, 0.0, 0.0), bevel=0.03)
        intr.add_box((sx, 0.30, 1.15), (0.22, 0.10, 0.18), mat_dash, rot=(0.15, 0.0, 0.0), bevel=0.025)
    # Rear parcel shelf / seat silhouette
    intr.add_box((0.0, 0.96, 0.82), (1.32, 0.44, 0.26), mat_interior, bevel=0.03)
    intr.finalize("Interior")

    # ------------------------------------------------------------------
    # 4. Headlights (warm amber/white) & Taillights (crimson LED)
    # ------------------------------------------------------------------
    hl = MeshBuilder()
    for sx in (-1.0, 1.0):
        hl.add_box(
            (sx * 0.66, -2.14, 0.61),
            (0.36, 0.14, 0.10),
            mat_headlight,
            rot=(0.0, 0.0, sx * 0.22),
            bevel=0.015,
        )
        # Lower fog/DRL accent
        hl.add_box(
            (sx * 0.68, -2.20, 0.34),
            (0.24, 0.06, 0.045),
            mat_headlight,
            rot=(0.0, 0.0, sx * 0.18),
        )
    hl.finalize("Headlights")

    tl = MeshBuilder()
    # Sleek full-width night-noir LED rear bar + side pods
    tl.add_box((0.0, 2.16, 0.74), (1.46, 0.07, 0.06), mat_taillight, bevel=0.01)
    for sx in (-1.0, 1.0):
        tl.add_box((sx * 0.66, 2.13, 0.74), (0.34, 0.11, 0.11), mat_taillight, rot=(0.0, 0.0, -sx * 0.14), bevel=0.015)
    tl.finalize("Taillights")

    # ------------------------------------------------------------------
    # 5. Four Named Wheels (centered at axle hubs for spin + steer)
    # ------------------------------------------------------------------
    wheel_specs = [
        ("Wheel_FL", (0.84, -1.36, 0.34), True),
        ("Wheel_FR", (-0.84, -1.36, 0.34), False),
        ("Wheel_RL", (0.84, 1.32, 0.34), True),
        ("Wheel_RR", (-0.84, 1.32, 0.34), False),
    ]
    for wname, wloc, is_left in wheel_specs:
        _build_wheel(wname, wloc, 0.34, 0.25, mat_rim, mat_tire, mat_caliper, mat_hub, is_left=is_left, spokes=5)

    return export_glb(
        out_dir,
        "getaway_car.glb",
        description="Stylized European midnight sport-coupe getaway vehicle with tinted windows, interior silhouette, emissive headlights/taillights, and 4 pivoted wheels.",
        category="vehicle",
        ground=True,
        extra_meta={
            "wheelRadius": 0.34,
            "wheelbase": 2.68,
            "trackWidth": 1.68,
            "animatableParts": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR"],
        },
    )


def build_police_car(out_dir: str) -> dict:
    """Stylized Catalan / Mossos d'Esquadra-inspired patrol cruiser.
    Dark midnight navy + crisp white doors/roof + Catalan crimson red accents + roof lightbar.
    """
    reset_scene()

    mat_navy = make_material("Police_Navy", "#101B33", metallic=0.45, roughness=0.28, coat=0.75)
    mat_white = make_material("Police_White", "#E5EAF2", metallic=0.1, roughness=0.30, coat=0.6)
    mat_red = make_material("Police_CatalanRed", "#C62032", metallic=0.25, roughness=0.32, coat=0.5)
    mat_trim = make_material("Police_Trim", "#141820", metallic=0.2, roughness=0.62)
    mat_chrome = make_material("Police_Chrome", "#BCC6D0", metallic=0.88, roughness=0.24)
    mat_glass = make_material("Police_Glass", "#0E1D2E", metallic=0.1, roughness=0.06, alpha=0.50, coat=1.0, double_sided=True)
    mat_headlight = make_material("Police_Headlight", "#E8F4FF", metallic=0.1, roughness=0.1, emission="#D4EBFF", emission_strength=4.2)
    mat_taillight = make_material("Police_Taillight", "#D91E2A", metallic=0.1, roughness=0.15, emission="#FF2030", emission_strength=3.5)
    mat_blue_led = make_material("Police_LightbarBlue", "#1A75FF", metallic=0.1, roughness=0.12, emission="#1E88FF", emission_strength=5.0)
    mat_red_led = make_material("Police_LightbarRed", "#FF1E2D", metallic=0.1, roughness=0.12, emission="#FF2233", emission_strength=5.0)
    mat_tire = make_material("Police_Tire", "#15171B", metallic=0.0, roughness=0.88)
    mat_steelie = make_material("Police_Steelie", "#2A303A", metallic=0.6, roughness=0.42)
    mat_hub = make_material("Police_Hubcap", "#CBD4DE", metallic=0.88, roughness=0.22)
    mat_plate = make_material("Police_Plate", "#DCE2EA", metallic=0.1, roughness=0.4)

    # ------------------------------------------------------------------
    # 1. Body (4-door patrol sedan + Mossos livery panels + bullbar)
    # ------------------------------------------------------------------
    body = MeshBuilder()

    # Main navy cruiser lower hull
    lower_rings = [
        _car_body_ring(-2.28, 0.76, 0.85, 0.78, 0.26, 0.48, 0.68, 0.02),
        _car_body_ring(-2.10, 0.86, 0.94, 0.87, 0.24, 0.56, 0.78, 0.03),
        _car_body_ring(-1.40, 0.90, 0.98, 0.91, 0.23, 0.62, 0.88, 0.03),
        _car_body_ring(-0.80, 0.90, 0.97, 0.90, 0.23, 0.62, 0.92, 0.02),
        _car_body_ring(0.55,  0.90, 0.97, 0.90, 0.23, 0.63, 0.94, 0.02),
        _car_body_ring(1.38,  0.90, 0.98, 0.91, 0.24, 0.64, 0.96, 0.02),
        _car_body_ring(2.05,  0.86, 0.94, 0.87, 0.27, 0.64, 0.94, 0.02),
        _car_body_ring(2.26,  0.78, 0.86, 0.80, 0.30, 0.60, 0.88, 0.01),
    ]
    body.add_loft(lower_rings, mat_navy, cap_start=True, cap_end=True, smooth=False)

    # Crisp white patrol side door panels (classic Mossos white mid-body, cleanly outside loft!)
    for sx in (-1.0, 1.0):
        body.add_box((sx * 0.96, 0.02, 0.74), (0.06, 1.92, 0.34), mat_white, rot=(0.0, sx * 0.20, 0.0), bevel=0.012)
        body.add_box((sx * 0.96, 0.02, 0.44), (0.06, 1.92, 0.30), mat_white, rot=(0.0, -sx * 0.14, 0.0), bevel=0.012)
        # Signature Catalan crimson-red horizontal & angled patrol stripe along doors & fenders
        body.add_box((sx * 0.995, 0.02, 0.59), (0.032, 2.02, 0.10), mat_red, bevel=0.008)
        body.add_box((sx * 0.975, -1.32, 0.62), (0.048, 0.56, 0.10), mat_red, rot=(0.35, 0.0, 0.0), bevel=0.008)
        body.add_box((sx * 0.975, 1.32, 0.64), (0.048, 0.60, 0.10), mat_red, rot=(-0.32, 0.0, 0.0), bevel=0.008)

    # White hood patrol V-chevron & red badge bar (cleanly proud of hood crown)
    body.add_box((0.0, -1.46, 0.925), (1.10, 0.96, 0.045), mat_white, rot=(-0.09, 0.0, 0.0), bevel=0.01)
    body.add_box((0.0, -1.92, 0.855), (0.86, 0.14, 0.045), mat_red, rot=(-0.10, 0.0, 0.0), bevel=0.008)

    # Upright 4-door patrol sedan greenhouse & white roof panel
    roof_rings = [
        _car_body_ring(-0.22, 0.70, 0.70, 0.66, 1.38, 1.42, 1.44, 0.025),
        _car_body_ring(0.82,  0.70, 0.70, 0.66, 1.38, 1.42, 1.44, 0.025),
        _car_body_ring(1.22,  0.72, 0.72, 0.67, 1.32, 1.36, 1.38, 0.02),
    ]
    body.add_loft(roof_rings, mat_white, cap_start=True, cap_end=True, smooth=False)

    # Pillars (A, B, C)
    for sx in (-1.0, 1.0):
        body.add_tube([(sx * 0.82, -0.82, 0.91), (sx * 0.68, -0.22, 1.42)], [0.045, 0.038], mat_navy, segments=8, smooth=False)
        body.add_tube([(sx * 0.83, 0.18, 0.93), (sx * 0.69, 0.22, 1.41)], [0.038, 0.034], mat_trim, segments=6, smooth=False)
        body.add_tube([(sx * 0.68, 0.96, 1.41), (sx * 0.82, 1.54, 0.95)], [0.056, 0.056], mat_navy, segments=8, smooth=False)

    # Front patrol grille & heavy tactical push-bar (bullbar)
    body.add_box((0.0, -2.28, 0.54), (1.16, 0.08, 0.24), mat_trim, bevel=0.01)
    # Bullbar upright guards & crossbars
    for sx in (-0.42, 0.42):
        body.add_box((sx, -2.38, 0.50), (0.07, 0.16, 0.50), mat_trim, rot=(-0.15, 0.0, 0.0), bevel=0.015)
    body.add_box((0.0, -2.41, 0.64), (0.94, 0.06, 0.055), mat_trim, bevel=0.01)
    body.add_box((0.0, -2.44, 0.42), (0.98, 0.06, 0.065), mat_trim, bevel=0.01)

    # Dark recessed upper wheel wells (kept cleanly above z=0.22 so tires touch y=0!)
    for sx in (-1.0, 1.0):
        for wy in (-1.38, 1.36):
            body.add_box((sx * 0.80, wy, 0.52), (0.30, 0.78, 0.44), mat_trim, bevel=0.04)

    # Underbody + bumpers + side mirrors + trunk radio antenna
    body.add_box((0.0, 0.0, 0.22), (1.68, 4.10, 0.08), mat_trim)
    for sx in (-1.0, 1.0):
        body.add_box((sx * 0.98, -0.58, 1.02), (0.16, 0.12, 0.10), mat_trim, bevel=0.02)
    # Rear whip antenna on trunk
    body.add_cylinder((0.52, 1.98, 1.32), 0.012, 0.005, 0.76, mat_trim, segments=6)
    # Interior dark silhouette block inside cabin
    body.add_box((0.0, 0.18, 1.04), (1.28, 1.32, 0.48), mat_trim, bevel=0.04)
    # Rear red reflective chevron bar & license plates
    body.add_box((0.0, 2.26, 0.62), (1.44, 0.04, 0.12), mat_white)
    body.add_box((0.0, 2.27, 0.62), (0.96, 0.03, 0.08), mat_red)
    body.add_box((0.0, -2.30, 0.34), (0.46, 0.02, 0.11), mat_plate)
    body.add_box((0.0, 2.28, 0.46), (0.46, 0.02, 0.11), mat_plate)

    body.finalize("Body")

    # ------------------------------------------------------------------
    # 2. Tinted Glass
    # ------------------------------------------------------------------
    glass = MeshBuilder()
    glass.add_quad_sheet((-0.80, -0.80, 0.92), (0.80, -0.80, 0.92), (0.66, -0.22, 1.41), (-0.66, -0.22, 1.41), mat_glass)
    glass.add_quad_sheet((-0.65, 0.98, 1.39), (0.65, 0.98, 1.39), (0.79, 1.54, 0.96), (-0.79, 1.54, 0.96), mat_glass)
    for sx in (-1.0, 1.0):
        pts = [(sx * 0.82, -0.74, 0.93), (sx * 0.82, 1.44, 0.96), (sx * 0.68, 0.96, 1.40), (sx * 0.67, -0.20, 1.40)]
        if sx < 0:
            pts.reverse()
        glass.add_quad_sheet(*pts, mat_glass)
    glass.finalize("Glass")

    # ------------------------------------------------------------------
    # 3. Headlights & Taillights
    # ------------------------------------------------------------------
    hl = MeshBuilder()
    for sx in (-1.0, 1.0):
        hl.add_box((sx * 0.68, -2.20, 0.68), (0.36, 0.12, 0.12), mat_headlight, rot=(0.0, 0.0, sx * 0.16), bevel=0.015)
    hl.finalize("Headlights")

    tl = MeshBuilder()
    for sx in (-1.0, 1.0):
        tl.add_box((sx * 0.68, 2.22, 0.78), (0.36, 0.10, 0.13), mat_taillight, rot=(0.0, 0.0, -sx * 0.12), bevel=0.015)
    tl.finalize("Taillights")

    # ------------------------------------------------------------------
    # 4. Roof Lightbar (Lightbar_Base + Lightbar_Blue + Lightbar_Red)
    # ------------------------------------------------------------------
    lb_base = MeshBuilder()
    # Mounting feet + central aluminum housing
    for sx in (-0.54, 0.54):
        lb_base.add_box((sx, 0.14, 1.45), (0.10, 0.24, 0.08), mat_trim, bevel=0.01)
    lb_base.add_box((0.0, 0.14, 1.53), (0.28, 0.26, 0.10), mat_chrome, bevel=0.02)
    lb_base.add_box((0.0, 0.14, 1.49), (1.18, 0.24, 0.035), mat_trim, bevel=0.008)
    lb_base.finalize("Lightbar_Base")

    lb_blue = MeshBuilder()
    lb_blue.add_box((0.36, 0.14, 1.54), (0.44, 0.24, 0.10), mat_blue_led, bevel=0.025)
    lb_blue.finalize("Lightbar_Blue")

    lb_red = MeshBuilder()
    lb_red.add_box((-0.36, 0.14, 1.54), (0.44, 0.24, 0.10), mat_red_led, bevel=0.025)
    lb_red.finalize("Lightbar_Red")

    # ------------------------------------------------------------------
    # 5. Four Named Wheels
    # ------------------------------------------------------------------
    wheel_specs = [
        ("Wheel_FL", (0.86, -1.38, 0.35), True),
        ("Wheel_FR", (-0.86, -1.38, 0.35), False),
        ("Wheel_RL", (0.86, 1.36, 0.35), True),
        ("Wheel_RR", (-0.86, 1.36, 0.35), False),
    ]
    for wname, wloc, is_left in wheel_specs:
        _build_wheel(
            wname,
            wloc,
            0.35,
            0.26,
            mat_steelie,
            mat_tire,
            mat_red,
            mat_hub,
            is_left=is_left,
            police_steelie=True,
        )

    return export_glb(
        out_dir,
        "police_car.glb",
        description="Catalan Mossos-inspired night patrol cruiser with navy/white/crimson livery, front bullbar, separate pulsing Lightbar_Blue/Lightbar_Red pods, and 4 pivoted wheels.",
        category="vehicle",
        ground=True,
        extra_meta={
            "wheelRadius": 0.35,
            "wheelbase": 2.74,
            "trackWidth": 1.72,
            "animatableParts": ["Wheel_FL", "Wheel_FR", "Wheel_RL", "Wheel_RR", "Lightbar_Blue", "Lightbar_Red"],
        },
    )
