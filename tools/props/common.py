"""Shared helpers for the headless Blender prop pipeline (DESIGN.md §9).

Run with:  blender --background --python <script> -- <args>

Nothing in here touches the scene implicitly. Every function takes the objects
it works on, because the pipeline processes one asset per Blender session and a
stale datablock from a previous import is the classic way these scripts go
quietly wrong.
"""

import json
import math
import os
import sys

import bpy
import bmesh
import numpy
from mathutils import Vector


# ---------------------------------------------------------------------------
# Argument plumbing. Blender swallows everything before `--`.
# ---------------------------------------------------------------------------

def script_args():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


# ---------------------------------------------------------------------------
# Scene hygiene
# ---------------------------------------------------------------------------

def reset_scene():
    """Wipe the file back to empty. `bpy.ops.wm.read_factory_settings` is the
    only reliable way -- deleting objects leaves orphaned meshes, materials and
    images behind, and an orphaned image with the same name as one we are about
    to import gets a `.001` suffix and silently unhooks the material."""
    bpy.ops.wm.read_factory_settings(use_empty=True)


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def select_only(objs):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    if objs:
        bpy.context.view_layer.objects.active = objs[0]


# ---------------------------------------------------------------------------
# Import
# ---------------------------------------------------------------------------

def import_any(path):
    """Import one source file. Returns the mesh objects it created.

    Blender 4.x+ renamed several of these operators and changed their argument
    names; this targets the 4.0+/5.x spelling only, and fails loudly rather
    than guessing, because a silently-empty import reads downstream as "this
    asset has 0 triangles" instead of as an error."""
    ext = os.path.splitext(path)[1].lower()
    before = set(bpy.context.scene.objects)

    if ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".ply":
        bpy.ops.wm.ply_import(filepath=path)
    elif ext == ".dae":
        bpy.ops.wm.collada_import(filepath=path)
    elif ext == ".blend":
        # Append every mesh object from the file's scenes.
        with bpy.data.libraries.load(path, link=False) as (src, dst):
            dst.objects = list(src.objects)
        for o in dst.objects:
            if o is not None:
                bpy.context.scene.collection.objects.link(o)
    else:
        raise RuntimeError("unsupported source extension: %s" % ext)

    created = [o for o in bpy.context.scene.objects if o not in before]
    meshes = [o for o in created if o.type == "MESH"]
    if not meshes:
        raise RuntimeError("import produced no mesh objects: %s" % path)

    # Unparent, keeping the world placement. Several sources -- every Megascans
    # FBX, and any DCC export that carried a unit conversion -- hang their mesh
    # off an empty called `world_root` that holds a 0.01 scale and a -90 deg X
    # rotation. `transform_apply` bakes an object's LOCAL basis only, so on a
    # parented mesh it bakes an identity and leaves the parent's scale and
    # rotation where they were: in the node hierarchy.
    #
    # Everything in this file measures `matrix_world`, so every measurement and
    # every check inside Blender is right, and the build reports OK. What ships
    # is the mesh DATA plus a node transform -- 100x too large and lying on its
    # side. `forest_floor_cluster` exported at 167.75 m against a 1.15 m spec
    # with its base 82 m below the floor, and only `check-props.mjs` reading
    # POSITION.min straight out of the GLB caught it.
    for o in meshes:
        if o.parent:
            mw = o.matrix_world.copy()
            o.parent = None
            o.matrix_world = mw
    return meshes


# ---------------------------------------------------------------------------
# Measurement
# ---------------------------------------------------------------------------

def tri_count(obj):
    """Triangles after triangulation, counted honestly from the polygons.

    `len(mesh.polygons)` is NOT the triangle count on an unprocessed import --
    most of these sources are quads, and a couple carry ngons. A quad-heavy
    tree reports half its real cost, which is exactly the sort of number that
    makes a budget look met when it is not."""
    me = obj.data
    return sum(max(len(p.vertices) - 2, 0) for p in me.polygons)


def scene_tris(objs):
    return sum(tri_count(o) for o in objs)


def world_bounds(objs):
    """Axis-aligned world-space bounds, measured from the VERTICES.

    Not `obj.bound_box`, which is a depsgraph-cached value: same numbers when
    it is fresh, no cache to be stale when it is not. `foreach_get` pulls the
    coordinates in one C-level call, so this is fast even on the 1.5M-vertex
    sources -- the equivalent Python loop costs minutes across a full build.

    Caveat worth knowing, because it produced a long and wrong hunt for a
    stale-depsgraph bug: this measures EVERY vertex, and a decimated mesh is
    full of unreferenced ones the glTF exporter will not write. Callers that
    measure after decimation must `drop_loose` first, or they are measuring a
    ghost of the pre-decimation silhouette."""
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    for o in objs:
        n = len(o.data.vertices)
        if n == 0:
            continue
        co = numpy.empty(n * 3, dtype=numpy.float32)
        o.data.vertices.foreach_get("co", co)
        co = co.reshape((n, 3))
        m = numpy.array(o.matrix_world, dtype=numpy.float32)
        world = co @ m[:3, :3].T + m[:3, 3]
        mn, mx = world.min(axis=0), world.max(axis=0)
        for i in range(3):
            lo[i] = min(lo[i], float(mn[i]))
            hi[i] = max(hi[i], float(mx[i]))
    return lo, hi


def material_report(objs):
    """What the textures actually are, per material.

    The distinction that matters downstream is DESIGN.md §9's Class A / Class B
    split, and the thing that decides it is whether the material has a UV-mapped
    image at all. The Quaternius pack has solid `Kd` colours and no UVs; the
    downloaded assets have full PBR sets. One pipeline has to handle both, so
    it has to be able to tell them apart without being told."""
    out = {}
    for o in objs:
        for slot in o.material_slots:
            m = slot.material
            if m is None or m.name in out:
                continue
            images, has_alpha = [], False
            base_rgba = None
            if m.node_tree is not None:
                for n in m.node_tree.nodes:
                    if n.type == "TEX_IMAGE" and n.image is not None:
                        images.append({
                            "name": n.image.name,
                            "size": list(n.image.size),
                            "channels": n.image.channels,
                        })
                        if n.image.channels == 4:
                            has_alpha = True
                    if n.type == "BSDF_PRINCIPLED":
                        inp = n.inputs.get("Base Color")
                        if inp is not None and not inp.is_linked:
                            base_rgba = [round(v, 4) for v in inp.default_value]
            out[m.name] = {
                "images": images,
                "has_alpha_image": has_alpha,
                "blend_method": getattr(m, "blend_method", None),
                "flat_base_color": base_rgba,
            }
    return out


def uv_report(objs):
    layers = set()
    missing = []
    for o in objs:
        names = [uv.name for uv in o.data.uv_layers]
        layers.update(names)
        if not names:
            missing.append(o.name)
    return {"layers": sorted(layers), "objects_without_uvs": missing}


def inspect(objs):
    lo, hi = world_bounds(objs)
    return {
        "objects": len(objs),
        "tris": scene_tris(objs),
        "verts": sum(len(o.data.vertices) for o in objs),
        "dims_m": [round(hi[i] - lo[i], 4) for i in range(3)],
        "min_m": [round(v, 4) for v in lo],
        "max_m": [round(v, 4) for v in hi],
        "uvs": uv_report(objs),
        "materials": material_report(objs),
        "object_names": [o.name for o in objs][:40],
    }


# ---------------------------------------------------------------------------
# Normalisation
# ---------------------------------------------------------------------------

def join_all(objs, name):
    """Join every mesh into one object.

    The pipeline needs one object per asset because BatchedMesh takes one
    geometry per instance (§5) and because decimation ratios only mean anything
    against a single triangle total -- decimating twelve separate leaf clusters
    to 0.1 each does not give you 10% of the tree, it gives you twelve clusters
    that have each lost their silhouette."""
    for o in objs:
        o.hide_set(False)
        o.hide_viewport = False
    select_only(objs)
    if len(objs) > 1:
        bpy.ops.object.join()
    obj = bpy.context.view_layer.objects.active
    obj.name = name
    obj.data.name = name
    return obj


def apply_transforms(obj):
    select_only([obj])
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


# UP IS +Z, EVERYWHERE IN THIS FILE.
#
# Blender's world space is Z-up. three.js and glTF are Y-up, and the glTF
# exporter converts on the way out (`export_yup=True`), so nothing here should
# ever rotate an asset to "fix" the axis -- doing that once means it gets fixed
# twice and the prop leaves lying on its side.
#
# Writing these two functions against +Y instead cost a full 150-asset build:
# `scale_to_height` normalised each tree along its DEPTH axis and
# `ground_and_center` centred it vertically instead of standing it on the
# ground, so every prop exported half-buried and at an arbitrary size. It is
# invisible in Blender's own viewport (the asset looks fine, just mis-scaled)
# and only shows up by reading POSITION.min out of the exported GLB, which is
# what `scripts/check-props.mjs` now does.

def ground_and_center(obj):
    """Put the base on z=0 and the XY centroid of the *footprint* on the origin.

    Deliberately not the bounding-box centre in the up axis: a prop is placed by
    its foot, and `scatter.js` already subtracts a small `sink` from the terrain
    height. An asset centred on its bbox floats by half its own height, and the
    error scales with the prop, so a tree floats 7 m while a pebble floats 5 cm
    -- which is why this reads as "the big props are broken" rather than as a
    single systematic offset."""
    lo, hi = world_bounds([obj])
    cx = (lo.x + hi.x) * 0.5
    cy = (lo.y + hi.y) * 0.5
    obj.location = (obj.location.x - cx, obj.location.y - cy, obj.location.z - lo.z)
    apply_transforms(obj)


def scale_to_height(obj, target_h):
    """Uniform scale so the asset stands `target_h` metres tall.

    Source assets arrive in centimetres, in inches, in arbitrary units, and in
    at least one case with a 100x FBX unit scale already baked in. Rather than
    trying to recover the true unit, every asset declares the real-world height
    it should have in the manifest and gets scaled to it. That is also the only
    number an artist can check by eye -- §6's whole scale-reference argument."""
    lo, hi = world_bounds([obj])
    cur = hi.z - lo.z
    if cur <= 1e-9:
        raise RuntimeError("asset has zero height, cannot scale: %s" % obj.name)
    k = target_h / cur
    obj.scale = (k, k, k)
    apply_transforms(obj)
    return k


def drop_loose(obj):
    """Delete vertices and edges no face references.

    The decimate modifier does not remove the vertices it collapses -- it
    unhooks them from the faces and leaves them in the mesh. Two things follow,
    and both are silent:

    Every measurement is wrong. `world_bounds` reads `data.vertices`, so it sees
    the ghost cloud of the ORIGINAL silhouette and reports the height the mesh
    had before decimation. `scale_to_height` then computes k ~= 1.0 and applies
    it perfectly, so the renormalisation pass runs and does nothing. The glTF
    exporter writes only face-referenced vertices, so the exported asset is
    whatever decimation actually left: measured, `tree_deciduous_hi` came out
    10.77 m against an 11 m spec and `fern_polypody` 0.29 m against 0.45 m,
    floating 4 cm. `obj.bound_box` has the same blind spot, which is why this
    looked for a long time like a stale-depsgraph bug.

    And the vertex counts are fiction. LOD0 above reported 7,285 verts for
    ~1,100 real ones. BatchedMesh reserves storage against vertex count (§5), so
    that number is not cosmetic -- it is a 6x over-reservation per instance."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    loose = [v for v in bm.verts if not v.link_faces]
    if loose:
        bmesh.ops.delete(bm, geom=loose, context="VERTS")
    bm.to_mesh(me)
    bm.free()
    me.update()


def clean_mesh(obj, merge_dist=0.0001):
    """Weld doubles, drop loose geometry, triangulate.

    Merge-by-distance before decimation is what makes decimation work at all on
    these sources: an FBX exported per-face or per-leaf-card has split vertices
    everywhere, and the collapse decimator cannot collapse across a seam it
    thinks is a boundary. Measured on the pine sources this is the difference
    between reaching a 500-tri target and stalling around 3,000."""
    me = obj.data
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=merge_dist)
    # Loose verts and edges carry no triangles but do inflate vertex counts,
    # and BatchedMesh reserves against vertex count, not triangle count (§5).
    loose_v = [v for v in bm.verts if not v.link_faces]
    if loose_v:
        bmesh.ops.delete(bm, geom=loose_v, context="VERTS")
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.to_mesh(me)
    bm.free()
    me.update()


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(obj, f, indent=2)
    print("wrote %s" % path)
