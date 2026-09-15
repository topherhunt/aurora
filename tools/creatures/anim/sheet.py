"""Render a clip as a contact sheet, so a gait can be judged by looking at it.

    blender --background --factory-startup --python tools/creatures/anim/sheet.py -- \
        --in  tools/creatures/work/<id>/anim-walk.glb \
        --out tools/creatures/work/<id>/sheets/walk.png \
        --forward 0.696 -0.718 --ground 0.078 [--frames 8] [--view side]

The camera is aimed down the creature's own LATERAL axis, taken from --forward,
because a Tripo rig is not axis-aligned -- the red fox is modelled 46 degrees off
X, and a world-axis side view shows a useless three-quarter of it.

A ground plane is drawn at --ground. Judging whether a foot is planted, sliding
or floating is the whole point of looking at these, and the eye cannot do it
without a contact reference.

Workbench with a flat single colour, not EEVEE: silhouette and limb position are
what is being read here, and a textured render with shadows hides both.
"""

import sys

import bpy
import numpy as np
from mathutils import Vector

VIEWS = {
    # name: (along-lateral, along-forward) weights for where the camera sits;
    # lateral is the creature's left, so "side" shows its left flank
    "side": (1.0, 0.0),
    "right": (-1.0, 0.0),
    "front": (0.0, 1.0),
    "quarter": (0.82, 0.57),
}


def script_args():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def arg(name, args, default=None, n=1):
    if name not in args:
        if default is None:
            raise SystemExit(f"sheet: missing required argument {name}")
        return default
    i = args.index(name) + 1
    vals = args[i:i + n]
    return vals[0] if n == 1 else vals


def drop_widgets():
    """Remove Tripo's bone-widget spheres. The importer brings them in as a real
    mesh in `glTF_not_exported`, which both renders on top of the creature and
    drags the bounding box out so the framing lands on nothing."""
    doomed = [ob for c in bpy.data.collections if c.name == "glTF_not_exported" for ob in c.objects]
    names = [ob.name for ob in doomed]
    for ob in doomed:
        bpy.data.objects.remove(ob, do_unlink=True)
    return names


def evaluated_bounds():
    """World bounds from evaluated vertices. `object.bound_box` reports the
    un-deformed mesh -- on a skinned character it comes back as a unit cube and
    silently frames the shot on nothing."""
    dg = bpy.context.evaluated_depsgraph_get()
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        ev = ob.evaluated_get(dg)
        mesh = ev.to_mesh()
        for v in mesh.vertices:
            w = ev.matrix_world @ v.co
            for i in range(3):
                lo[i] = min(lo[i], w[i])
                hi[i] = max(hi[i], w[i])
        ev.to_mesh_clear()
    return lo, hi


def setup_world():
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sc.display.shading.light = "STUDIO"
    sc.display.shading.color_type = "SINGLE"
    sc.display.shading.single_color = (0.62, 0.60, 0.58)
    sc.display.shading.show_shadows = False
    sc.display.shading.show_cavity = True
    sc.render.film_transparent = False
    # Workbench takes its backdrop from the shading settings, not the world, and
    # an empty factory scene has no world datablock at all.
    sc.display.shading.background_type = "VIEWPORT"
    sc.display.shading.background_color = (0.93, 0.94, 0.96)


def ground_row(centre_z, ground_z, ortho_scale, res_x, res_y):
    """Which pixel row the ground sits on, or None if it is off the tile.

    Drawn into the image rather than modelled: these are orthographic SIDE
    views, so a real ground plane is exactly edge-on and renders as nothing.
    Blender's ortho_scale spans the larger render dimension."""
    world_h = ortho_scale * (res_y / max(res_x, res_y))
    row = round((centre_z + world_h / 2 - ground_z) / world_h * res_y)
    return row if 0 <= row < res_y else None


def draw_ground(tile, row):
    if row is None:
        return tile
    tile[row, :, :3] = (0.24, 0.28, 0.38)
    return tile


def add_camera(centre, span, direction):
    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = span * 1.35
    cam = bpy.data.objects.new("Cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = centre + direction * (span * 4)
    cam.rotation_euler = (centre - cam.location).normalized().to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.camera = cam
    return cam


def frame_range():
    """The clip's frame span, from whatever action the import produced."""
    spans = []
    for ob in bpy.context.scene.objects:
        ad = ob.animation_data
        if ad and ad.action:
            spans.append(tuple(ad.action.frame_range))
    if not spans:
        return None
    return min(s[0] for s in spans), max(s[1] for s in spans)


def render_to_array(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return px[::-1]  # Blender stores bottom-up


def save_array(arr, path):
    h, w, _ = arr.shape
    img = bpy.data.images.new("sheet", width=w, height=h, alpha=True)
    img.pixels = arr[::-1].reshape(-1).tolist()
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()


def main():
    a = script_args()
    src = arg("--in", a)
    out = arg("--out", a)
    fwd_x, fwd_z = (float(v) for v in arg("--forward", a, n=2))
    ground = float(arg("--ground", a, "0"))
    count = int(arg("--frames", a, "8"))
    view = arg("--view", a, "side")
    cols = int(arg("--cols", a, "4"))
    if view not in VIEWS:
        raise SystemExit(f"sheet: unknown view {view}, have {', '.join(VIEWS)}")

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    drop_widgets()

    # glTF is Y-up and the importer rotates it: glTF (x, y, z) -> Blender (x, -z, y).
    fwd = Vector((fwd_x, -fwd_z, 0)).normalized()
    lat = Vector((-fwd.y, fwd.x, 0))
    wl, wf = VIEWS[view]
    direction = (lat * wl + fwd * wf).normalized()

    lo, hi = evaluated_bounds()
    centre = (lo + hi) / 2
    span = max((hi - lo)[i] for i in range(3))
    ground_z = ground if ground else lo.z

    setup_world()
    cam = add_camera(centre, span, direction)

    sc = bpy.context.scene
    sc.render.resolution_x = 420
    sc.render.resolution_y = 360
    sc.render.image_settings.file_format = "PNG"
    row = ground_row(centre.z, ground_z, cam.data.ortho_scale,
                     sc.render.resolution_x, sc.render.resolution_y)

    span_frames = frame_range()
    tmp = out + ".frame.png"
    tiles = []
    if span_frames is None:
        tiles.append(draw_ground(render_to_array(tmp), row))
    else:
        f0, f1 = span_frames
        # Sample across one cycle WITHOUT repeating the loop point: the last
        # frame of a cycle is the first frame again, and a duplicated tile wastes
        # a cell and hides the frame that should have been there.
        for k in range(count):
            sc.frame_set(int(round(f0 + (f1 - f0) * k / count)))
            tiles.append(draw_ground(render_to_array(tmp), row))

    rows = (len(tiles) + cols - 1) // cols
    th, tw, _ = tiles[0].shape
    sheet = np.ones((rows * th, cols * tw, 4), dtype=np.float32)
    for i, t in enumerate(tiles):
        r, c = divmod(i, cols)
        sheet[r * th:(r + 1) * th, c * tw:(c + 1) * tw] = t
    save_array(sheet, out)
    print(f"sheet: {len(tiles)} frames, {rows}x{cols}, {view} view -> {out}")


main()
