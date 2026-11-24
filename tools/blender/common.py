"""Shared Blender 5.2 procedural modeling & glTF 2.0 export utilities for Nachtschicht."""

from __future__ import annotations

import math
import os
from typing import Iterable, List, Optional, Sequence, Tuple

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector


# ---------------------------------------------------------------------------
# Color & Material Helpers (Mediterranean Night Noir palette)
# ---------------------------------------------------------------------------

def srgb_to_linear(c: float) -> float:
    if c <= 0.04045:
        return c / 12.92
    return ((c + 0.055) / 1.055) ** 2.4


def hex_rgba(hex_str: str, alpha: float = 1.0) -> Tuple[float, float, float, float]:
    s = hex_str.lstrip("#")
    r = srgb_to_linear(int(s[0:2], 16) / 255.0)
    g = srgb_to_linear(int(s[2:4], 16) / 255.0)
    b = srgb_to_linear(int(s[4:6], 16) / 255.0)
    return (r, g, b, alpha)


def reset_scene() -> None:
    """Start from a completely clean empty Blender scene."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Ensure a world exists for preview renders
    if bpy.context.scene.world is None:
        w = bpy.data.worlds.new("World")
        bpy.context.scene.world = w


def make_material(
    name: str,
    color: str | Tuple[float, float, float],
    metallic: float = 0.0,
    roughness: float = 0.55,
    emission: Optional[str | Tuple[float, float, float]] = None,
    emission_strength: float = 0.0,
    alpha: float = 1.0,
    coat: float = 0.0,
    coat_roughness: float = 0.12,
    double_sided: bool = False,
) -> bpy.types.Material:
    """Create or retrieve a PBR material compatible with Blender 5.2 & glTF 2.0."""
    if name in bpy.data.materials:
        return bpy.data.materials[name]

    mat = bpy.data.materials.new(name=name)
    if mat.node_tree is None:
        mat.use_nodes = True

    nt = mat.node_tree
    bsdf = nt.nodes.get("Principled BSDF")
    if bsdf is None:
        nt.nodes.clear()
        bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
        out = nt.nodes.new("ShaderNodeOutputMaterial")
        nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    if isinstance(color, str):
        rgba = hex_rgba(color, 1.0)
    else:
        rgba = (srgb_to_linear(color[0]), srgb_to_linear(color[1]), srgb_to_linear(color[2]), 1.0)

    bsdf.inputs["Base Color"].default_value = rgba
    bsdf.inputs["Metallic"].default_value = float(metallic)
    bsdf.inputs["Roughness"].default_value = float(roughness)
    bsdf.inputs["Alpha"].default_value = float(alpha)

    if coat > 0.0 and "Coat Weight" in bsdf.inputs:
        bsdf.inputs["Coat Weight"].default_value = float(coat)
        bsdf.inputs["Coat Roughness"].default_value = float(coat_roughness)

    if emission is not None and emission_strength > 0.0:
        if isinstance(emission, str):
            ergba = hex_rgba(emission, 1.0)
        else:
            ergba = (srgb_to_linear(emission[0]), srgb_to_linear(emission[1]), srgb_to_linear(emission[2]), 1.0)
        bsdf.inputs["Emission Color"].default_value = ergba
        bsdf.inputs["Emission Strength"].default_value = float(emission_strength)

    if alpha < 0.999:
        mat.blend_method = "BLEND"
        mat.use_backface_culling = False
    else:
        mat.blend_method = "OPAQUE"
        mat.use_backface_culling = not double_sided

    return mat


# ---------------------------------------------------------------------------
# Procedural BMesh Builder
# ---------------------------------------------------------------------------

def _xform_matrix(center: Sequence[float], rot: Sequence[float] = (0.0, 0.0, 0.0)) -> Matrix:
    t = Matrix.Translation(Vector(center))
    r = Euler(rot, "XYZ").to_matrix().to_4x4()
    return t @ r


class MeshBuilder:
    """High-craft procedural bmesh builder with multi-material & smooth/flat support."""

    def __init__(self) -> None:
        self.bm = bmesh.new()
        self.materials: List[bpy.types.Material] = []
        self._mat_index: dict[str, int] = {}

    def mat_idx(self, mat: bpy.types.Material) -> int:
        if mat.name not in self._mat_index:
            self._mat_index[mat.name] = len(self.materials)
            self.materials.append(mat)
        return self._mat_index[mat.name]

    def _tag_faces(self, faces: Iterable[bmesh.types.BMFace], mat: bpy.types.Material, smooth: bool) -> None:
        idx = self.mat_idx(mat)
        for f in faces:
            f.material_index = idx
            f.smooth = smooth

    def add_box(
        self,
        center: Sequence[float],
        size: Sequence[float],
        mat: bpy.types.Material,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        bevel: float = 0.0,
        bevel_segments: int = 1,
        smooth: bool = False,
        taper_top: Tuple[float, float] = (1.0, 1.0),
        taper_bottom: Tuple[float, float] = (1.0, 1.0),
    ) -> None:
        """Add a box (optionally tapered along Z and edge-beveled) centered at `center`."""
        sx, sy, sz = float(size[0]), float(size[1]), float(size[2])
        hx, hy, hz = sx * 0.5, sy * 0.5, sz * 0.5
        tbx, tby = taper_bottom
        ttx, tty = taper_top

        coords = [
            (-hx * tbx, -hy * tby, -hz),
            (hx * tbx, -hy * tby, -hz),
            (hx * tbx, hy * tby, -hz),
            (-hx * tbx, hy * tby, -hz),
            (-hx * ttx, -hy * tty, hz),
            (hx * ttx, -hy * tty, hz),
            (hx * ttx, hy * tty, hz),
            (-hx * ttx, hy * tty, hz),
        ]
        verts = [self.bm.verts.new(c) for c in coords]
        face_defs = [
            (0, 3, 2, 1),  # bottom
            (4, 5, 6, 7),  # top
            (0, 1, 5, 4),  # -Y front
            (2, 3, 7, 6),  # +Y back
            (1, 2, 6, 5),  # +X left
            (3, 0, 4, 7),  # -X right
        ]
        faces = [self.bm.faces.new([verts[i] for i in fd]) for fd in face_defs]

        if bevel > 0.0:
            max_b = min(sx, sy, sz) * 0.42
            b_amt = min(float(bevel), max_b)
            edges = list({e for f in faces for e in f.edges})
            res = bmesh.ops.bevel(
                self.bm,
                geom=edges,
                offset=b_amt,
                offset_type="OFFSET",
                segments=bevel_segments,
                profile=0.5,
                affect="EDGES",
                clamp_overlap=True,
            )
            all_verts = list({v for f in faces if f.is_valid for v in f.verts} | set(res.get("verts", [])))
            all_faces = [f for f in faces if f.is_valid] + list(res.get("faces", []))
        else:
            all_verts = verts
            all_faces = faces

        mat4 = _xform_matrix(center, rot)
        bmesh.ops.transform(self.bm, matrix=mat4, verts=all_verts)
        self._tag_faces(all_faces, mat, smooth)

    def add_cylinder(
        self,
        center: Sequence[float],
        radius_bottom: float,
        radius_top: float,
        height: float,
        mat: bpy.types.Material,
        segments: int = 16,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
        cap: bool = True,
        cap_flat: bool = True,
    ) -> None:
        """Add a vertical cylinder/cone centered at `center`, rotated by `rot`."""
        existing_faces = set(self.bm.faces)
        res = bmesh.ops.create_cone(
            self.bm,
            cap_ends=cap,
            cap_tris=False,
            segments=segments,
            radius1=float(radius_bottom),
            radius2=float(radius_top),
            depth=float(height),
            matrix=_xform_matrix(center, rot),
        )
        new_faces = [f for f in self.bm.faces if f not in existing_faces]
        idx = self.mat_idx(mat)
        for f in new_faces:
            f.material_index = idx
            if cap_flat and len(f.verts) > 4:
                f.smooth = False
            else:
                f.smooth = smooth

    def add_sphere(
        self,
        center: Sequence[float],
        radius: float,
        mat: bpy.types.Material,
        scale: Sequence[float] = (1.0, 1.0, 1.0),
        segments: int = 14,
        rings: int = 10,
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        smooth: bool = True,
    ) -> None:
        existing_faces = set(self.bm.faces)
        mat4 = _xform_matrix(center, rot) @ Matrix.Diagonal((scale[0], scale[1], scale[2], 1.0))
        bmesh.ops.create_uvsphere(
            self.bm,
            u_segments=segments,
            v_segments=rings,
            radius=float(radius),
            matrix=mat4,
        )
        new_faces = [f for f in self.bm.faces if f not in existing_faces]
        self._tag_faces(new_faces, mat, smooth)

    def add_loft(
        self,
        rings: Sequence[Sequence[Sequence[float]]],
        mat: bpy.types.Material,
        cap_start: bool = True,
        cap_end: bool = True,
        smooth: bool = False,
        closed_u: bool = True,
    ) -> None:
        """Skin a quad mesh across a sequence of cross-section rings."""
        if len(rings) < 2:
            return
        n = len(rings[0])
        v_rings = [[self.bm.verts.new(tuple(pt)) for pt in ring] for ring in rings]
        new_faces: List[bmesh.types.BMFace] = []

        for r_i in range(len(v_rings) - 1):
            r0 = v_rings[r_i]
            r1 = v_rings[r_i + 1]
            count = n if closed_u else (n - 1)
            for j in range(count):
                jn = (j + 1) % n
                quad = [r0[j], r0[jn], r1[jn], r1[j]]
                # Guard against degenerate zero-area/duplicate verts
                if len(set(quad)) == 4:
                    try:
                        new_faces.append(self.bm.faces.new(quad))
                    except ValueError:
                        pass

        if cap_start and closed_u and n >= 3:
            try:
                f = self.bm.faces.new(list(reversed(v_rings[0])))
                f.smooth = False
                f.material_index = self.mat_idx(mat)
            except ValueError:
                pass
        if cap_end and closed_u and n >= 3:
            try:
                f = self.bm.faces.new(list(v_rings[-1]))
                f.smooth = False
                f.material_index = self.mat_idx(mat)
            except ValueError:
                pass

        self._tag_faces(new_faces, mat, smooth)

    def add_tube(
        self,
        points: Sequence[Sequence[float]],
        radii: float | Sequence[float],
        mat: bpy.types.Material,
        segments: int = 10,
        smooth: bool = True,
        cap: bool = True,
    ) -> None:
        """Sweep a circular cross-section along a 3D polyline."""
        pts = [Vector(p) for p in points]
        if len(pts) < 2:
            return
        if isinstance(radii, (int, float)):
            rad_list = [float(radii)] * len(pts)
        else:
            rad_list = [float(r) for r in radii]

        rings = []
        prev_n: Optional[Vector] = None
        for i, p in enumerate(pts):
            if i == 0:
                tangent = (pts[1] - pts[0]).normalized()
            elif i == len(pts) - 1:
                tangent = (pts[-1] - pts[-2]).normalized()
            else:
                t1 = (pts[i] - pts[i - 1]).normalized()
                t2 = (pts[i + 1] - pts[i]).normalized()
                tangent = (t1 + t2)
                if tangent.length < 1e-5:
                    tangent = t2
                else:
                    tangent.normalize()

            if prev_n is None:
                up = Vector((0.0, 0.0, 1.0))
                if abs(tangent.dot(up)) > 0.92:
                    up = Vector((1.0, 0.0, 0.0))
                nrm = tangent.cross(up).normalized()
            else:
                # Parallel transport frame to prevent twisting
                nrm = (prev_n - tangent * prev_n.dot(tangent))
                if nrm.length < 1e-5:
                    up = Vector((1.0, 0.0, 0.0)) if abs(tangent.x) < 0.9 else Vector((0.0, 1.0, 0.0))
                    nrm = tangent.cross(up).normalized()
                else:
                    nrm.normalize()
            binrm = tangent.cross(nrm).normalized()
            prev_n = nrm

            r = rad_list[i]
            ring = []
            for s in range(segments):
                ang = (2.0 * math.pi * s) / segments
                offset = (nrm * math.cos(ang) + binrm * math.sin(ang)) * r
                ring.append(tuple(p + offset))
            rings.append(ring)

        self.add_loft(rings, mat, cap_start=cap, cap_end=cap, smooth=smooth, closed_u=True)

    def add_prism_y(
        self,
        poly_xz: Sequence[Tuple[float, float]],
        y0: float,
        y1: float,
        mat: bpy.types.Material,
        smooth: bool = False,
    ) -> None:
        """Extrude a 2D (x, z) polygon along Y from y0 to y1."""
        r0 = [(x, y0, z) for (x, z) in poly_xz]
        r1 = [(x, y1, z) for (x, z) in poly_xz]
        self.add_loft([r0, r1], mat, cap_start=True, cap_end=True, smooth=smooth, closed_u=True)

    def add_prism_x(
        self,
        poly_yz: Sequence[Tuple[float, float]],
        x0: float,
        x1: float,
        mat: bpy.types.Material,
        smooth: bool = False,
    ) -> None:
        """Extrude a 2D (y, z) profile along X from x0 to x1 (ideal for car side silhouettes!)."""
        r0 = [(x0, y, z) for (y, z) in poly_yz]
        r1 = [(x1, y, z) for (y, z) in poly_yz]
        self.add_loft([r0, r1], mat, cap_start=True, cap_end=True, smooth=smooth, closed_u=True)

    def add_prism_z(
        self,
        poly_xy: Sequence[Tuple[float, float]],
        z0: float,
        z1: float,
        mat: bpy.types.Material,
        smooth: bool = False,
    ) -> None:
        """Extrude a 2D (x, y) polygon along Z from z0 to z1."""
        r0 = [(x, y, z0) for (x, y) in poly_xy]
        r1 = [(x, y, z1) for (x, y) in poly_xy]
        self.add_loft([r0, r1], mat, cap_start=True, cap_end=True, smooth=smooth, closed_u=True)

    def add_quad_sheet(
        self,
        v0: Sequence[float],
        v1: Sequence[float],
        v2: Sequence[float],
        v3: Sequence[float],
        mat: bpy.types.Material,
        smooth: bool = False,
    ) -> None:
        verts = [self.bm.verts.new(tuple(v)) for v in (v0, v1, v2, v3)]
        try:
            f = self.bm.faces.new(verts)
            f.material_index = self.mat_idx(mat)
            f.smooth = smooth
        except ValueError:
            pass

    def finalize(
        self,
        name: str,
        location: Sequence[float] = (0.0, 0.0, 0.0),
        rot: Sequence[float] = (0.0, 0.0, 0.0),
        parent: Optional[bpy.types.Object] = None,
        auto_uv: bool = True,
    ) -> bpy.types.Object:
        """Build the Blender mesh object with clean outward normals and box-projected UVs."""
        self.bm.normal_update()
        bmesh.ops.recalc_face_normals(self.bm, faces=list(self.bm.faces))

        if auto_uv and len(self.bm.faces) > 0:
            uv_layer = self.bm.loops.layers.uv.verify()
            for f in self.bm.faces:
                n = f.normal
                ax, ay, az = abs(n.x), abs(n.y), abs(n.z)
                for loop in f.loops:
                    co = loop.vert.co
                    if az >= ax and az >= ay:
                        loop[uv_layer].uv = (co.x * 0.5 + 0.5, co.y * 0.5 + 0.5)
                    elif ax >= ay and ax >= az:
                        loop[uv_layer].uv = (co.y * 0.5 + 0.5, co.z * 0.5 + 0.5)
                    else:
                        loop[uv_layer].uv = (co.x * 0.5 + 0.5, co.z * 0.5 + 0.5)

        mesh = bpy.data.meshes.new(name)
        self.bm.to_mesh(mesh)
        self.bm.free()

        for m in self.materials:
            mesh.materials.append(m)

        mesh.update()
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.scene.collection.objects.link(obj)

        if parent is not None:
            obj.parent = parent
            obj.matrix_parent_inverse = Matrix.Identity(4)

        obj.location = Vector(location)
        obj.rotation_euler = Euler(rot, "XYZ")
        obj.scale = Vector((1.0, 1.0, 1.0))
        return obj


def make_empty(
    name: str,
    location: Sequence[float] = (0.0, 0.0, 0.0),
    parent: Optional[bpy.types.Object] = None,
) -> bpy.types.Object:
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    if parent is not None:
        obj.parent = parent
        obj.matrix_parent_inverse = Matrix.Identity(4)
    obj.location = Vector(location)
    obj.rotation_euler = Euler((0.0, 0.0, 0.0), "XYZ")
    obj.scale = Vector((1.0, 1.0, 1.0))
    return obj


# ---------------------------------------------------------------------------
# Coordinate Conversion, Bounds Measurement & Export
# ---------------------------------------------------------------------------

def blender_to_gltf(vec: Sequence[float]) -> List[float]:
    """Convert Blender Z-up (x, y, z) to glTF Y-up (x, z, -y)."""
    return [round(float(vec[0]), 4), round(float(vec[2]), 4), round(float(-vec[1]), 4)]


def measure_scene_gltf() -> dict:
    """Measure exact Y-up bounding box, triangle count, and node metadata in current scene."""
    bpy.context.view_layer.update()
    min_b = [float("inf")] * 3
    max_b = [float("-inf")] * 3
    tri_count = 0
    sub_meshes = []

    for obj in bpy.context.scene.objects:
        world_pos = obj.matrix_world.translation
        local_pos = obj.location
        entry = {
            "name": obj.name,
            "type": obj.type,
            "parent": obj.parent.name if obj.parent else None,
            "worldPivot": blender_to_gltf(world_pos),
            "localOffset": blender_to_gltf(local_pos),
        }
        if obj.type == "MESH":
            mesh = obj.data
            mesh.calc_loop_triangles()
            tris = len(mesh.loop_triangles)
            tri_count += tris
            entry["triangles"] = tris
            entry["materials"] = [m.name for m in mesh.materials if m]
            for v in mesh.vertices:
                w = obj.matrix_world @ v.co
                gx, gy, gz = w.x, w.z, -w.y
                if gx < min_b[0]: min_b[0] = gx
                if gy < min_b[1]: min_b[1] = gy
                if gz < min_b[2]: min_b[2] = gz
                if gx > max_b[0]: max_b[0] = gx
                if gy > max_b[1]: max_b[1] = gy
                if gz > max_b[2]: max_b[2] = gz
        sub_meshes.append(entry)

    dims = {
        "width": round(max_b[0] - min_b[0], 4),
        "height": round(max_b[1] - min_b[1], 4),
        "depth": round(max_b[2] - min_b[2], 4),
    }
    bounds = {
        "min": [round(v, 4) for v in min_b],
        "max": [round(v, 4) for v in max_b],
    }
    return {
        "dimensions": dims,
        "bounds": bounds,
        "triangles": tri_count,
        "nodes": sub_meshes,
    }


def ground_scene_to_zero() -> float:
    """Shift top-level scene objects along Blender Z so lowest mesh vertex sits strictly at z=0."""
    bpy.context.view_layer.update()
    min_z = float("inf")
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        for v in obj.data.vertices:
            wz = (obj.matrix_world @ v.co).z
            if wz < min_z:
                min_z = wz
    if min_z == float("inf") or abs(min_z) < 1e-6:
        return 0.0
    for obj in bpy.context.scene.objects:
        if obj.parent is None:
            obj.location.z -= min_z
    bpy.context.view_layer.update()
    return -min_z


def export_glb(
    out_dir: str,
    filename: str,
    description: str,
    category: str,
    ground: bool = True,
    extra_meta: Optional[dict] = None,
) -> dict:
    """Optionally ground scene to y=0, export GLB, and return manifest metadata."""
    os.makedirs(out_dir, exist_ok=True)
    if ground:
        ground_scene_to_zero()

    stats = measure_scene_gltf()
    filepath = os.path.join(out_dir, filename)

    bpy.ops.export_scene.gltf(
        filepath=filepath,
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_lights=False,
        export_cameras=False,
        export_animations=False,
    )

    size_bytes = os.path.getsize(filepath)
    meta = {
        "file": filename,
        "url": f"/assets/models/{filename}",
        "category": category,
        "description": description,
        "sizeBytes": size_bytes,
        "triangles": stats["triangles"],
        "dimensions": stats["dimensions"],
        "bounds": stats["bounds"],
        "originOffset": [0.0, 0.0, 0.0],
        "forwardAxis": "+Z",
        "upAxis": "+Y",
        "subMeshes": [n["name"] for n in stats["nodes"] if n["type"] == "MESH"],
        "nodes": stats["nodes"],
    }
    if extra_meta:
        meta.update(extra_meta)
    return meta
