"""Headless Blender prop pipeline -- DESIGN.md §9, build step 4.

    blender --background --factory-startup --python tools/props/build.py -- \
        --manifest tools/props/manifest.json \
        --out public/props \
        [--only <id> ...] [--no-bake] [--no-billboard]

One asset per Blender session would be cleaner but costs ~1.5 s of startup each,
so the session is shared and `reset_scene()` runs between assets. That is safe
only because nothing here reads the scene implicitly.

WHAT COMES OUT

    public/props/props.glb        every asset, every LOD, as separate objects
    public/props/layers/NNN.png   128x128 RGBA Class-B texture layers (§9)
    public/props/manifest.json    per-asset metadata the runtime needs

STAGES, and why each is where it is

    import -> join -> orient -> ground+centre -> scale to real height
        Scale last, because `scale_to_height` measures the joined bounds and a
        stray unjoined child would set the height off the wrong object.

    clean (weld, drop loose, triangulate)
        Before decimation, not after. Collapse decimation cannot collapse
        across a vertex seam it reads as a boundary, and every FBX here is
        split per-face or per-leaf-card. Measured on the sources: welding first
        is the difference between reaching a 500-tri target and stalling.

    texture consolidation -> one 128x128 layer
        Only for assets that arrive with images. Assets with flat `Kd`
        materials -- which is the whole Quaternius pack and four of the
        downloads -- skip this entirely and carry their colour in vertex
        colours instead, costing zero texture layers.

    AO bake -> multiplied into vertex colour
        §8 wants AO baked per asset. Vertex colours rather than a texture
        because the runtime is already `vertexColors: true` (scatter.js), it
        costs no layer, and at 500 tris the vertex density is comparable to
        what a 128x128 unwrap would resolve anyway.

    decimate per LOD -> billboard render
        Billboards render from LOD0, not from the source: an impostor of a mesh
        the player never sees is an impostor of the wrong silhouette.
"""

import argparse
import json
import math
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bpy  # noqa: E402
import common  # noqa: E402
from mathutils import Vector  # noqa: E402


LAYER_SIZE = 128  # §9: Class B floor. 64 gives a whole tree ~16x16 per surface.
BILLBOARD_SIZE = 128


# ---------------------------------------------------------------------------
# Texture consolidation
# ---------------------------------------------------------------------------

def _principled(mat):
    if not mat or mat.node_tree is None:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


# Inputs that make a Cycles DIFFUSE bake return less than the base colour,
# because physically the surface is not diffuse. Zeroing them is not a cheat:
# §8 ships one directional light against a Lambert-ish pass with no metalness,
# no specular and no transmission, so there is no downstream consumer for any
# of this and the bake's only job is to capture albedo.
_NON_DIFFUSE = ("Metallic", "Transmission Weight", "Specular IOR Level")


def neutralize_pbr(obj):
    """Zero the PBR inputs that would darken or erase the diffuse bake.

    `windmill` arrived from its generator with metallicFactor 1.0, and a fully
    metallic surface has NO diffuse albedo -- so its 128x128 atlas baked pure
    black across the 65% of itself that was opaque, and the impostor rendered
    from it was a black slab. The mesh, the UVs and the 2048x2048 source texture
    were all fine; the material was telling Cycles the truth and the truth was
    not what this pipeline wanted. `watchtower` has the same input driven by a
    metallic-roughness map, so the link has to go too, not just the value."""
    for slot in obj.material_slots:
        bsdf = _principled(slot.material)
        if bsdf is None:
            continue
        nt = slot.material.node_tree
        for name in _NON_DIFFUSE:
            sock = bsdf.inputs.get(name)
            if sock is None:
                continue
            for link in list(sock.links):
                nt.links.remove(link)
            sock.default_value = 0.0


def _base_color_image(mat):
    """The image feeding Base Color, if there is one.

    Deliberately follows only the Base Color link. These sources ship full PBR
    sets -- normal, roughness, metallic, AO, sometimes transmission -- and none
    of them survive into a world with one real-time light and baked lighting
    (§8). Pulling the wrong one is easy: several assets name their roughness map
    more helpfully than their albedo."""
    node = _principled(mat)
    if node is None:
        return None
    inp = node.inputs.get("Base Color")
    if inp is None or not inp.is_linked:
        return None
    src = inp.links[0].from_node
    # Base Color is often routed through a Mix/Separate for channel-packed maps.
    seen = set()
    stack = [src]
    while stack:
        n = stack.pop()
        if n.name in seen:
            continue
        seen.add(n.name)
        if n.type == "TEX_IMAGE" and n.image is not None:
            return n.image
        for i in n.inputs:
            for l in i.links:
                stack.append(l.from_node)
    return None


def _flat_base_color(mat):
    node = _principled(mat)
    if node is None:
        return (0.5, 0.5, 0.5, 1.0)
    inp = node.inputs.get("Base Color")
    if inp is None:
        return (0.5, 0.5, 0.5, 1.0)
    if inp.is_linked:
        return (0.5, 0.5, 0.5, 1.0)
    return tuple(inp.default_value)


def _alpha_image(mat):
    node = _principled(mat)
    if node is None:
        return None
    inp = node.inputs.get("Alpha")
    if inp is not None and inp.is_linked:
        src = inp.links[0].from_node
        if src.type == "TEX_IMAGE" and src.image is not None:
            return src.image
    return None


def wire_orphan_color(obj):
    """Link a foliage atlas's RGB into Base Color when only its alpha is wired.

    A cutout leaf sheet is one RGBA image: colour in RGB, the cutout in A. The
    FBX importer routinely reconstructs only the alpha half of that, because the
    FBX material records the opacity channel explicitly and leaves the diffuse
    slot to a texture reference it could not resolve. What is left is a
    Principled node with a perfect cutout and Base Color sitting at its 0.8 grey
    default -- which bakes, correctly and uselessly, as white leaves.
    `tree_oak_hero` shipped a canopy of grey leaves that way and every check in
    the project passed it.

    Only ever fills an EMPTY Base Color, and only from an image the material
    already references, so it cannot override an author's wiring. Returns the
    slots it fixed."""
    fixed = []
    for slot in obj.material_slots:
        mat = slot.material
        bsdf = _principled(mat)
        if bsdf is None or mat.node_tree is None:
            continue
        bc = bsdf.inputs.get("Base Color")
        if bc is None or bc.is_linked:
            continue
        # Prefer the image already driving Alpha -- for a cutout sheet that IS
        # the colour map. Otherwise any image whose Color output goes nowhere.
        alpha_img = _alpha_image(mat)
        cand = None
        for n in mat.node_tree.nodes:
            if n.type != "TEX_IMAGE" or n.image is None:
                continue
            if alpha_img is not None and n.image is alpha_img:
                cand = n
                break
            if not n.outputs["Color"].links and cand is None:
                cand = n
        if cand is None:
            continue
        # An image the importer wired only to Alpha is tagged Non-Color, which is
        # right for a mask and wrong the moment it feeds Base Color: the bake
        # then reads sRGB-encoded green as if it were linear and crushes it to
        # near-black. This was the oak's canopy -- wiring alone left it black,
        # and only the colour space made it green. Safe for the cutout, because
        # Blender never colour-manages the alpha channel.
        cand.image.colorspace_settings.name = "sRGB"
        mat.node_tree.links.new(cand.outputs["Color"], bc)
        fixed.append("%s<-%s" % (mat.name, cand.image.name))
    return fixed


def untextured_slots(obj):
    """Material slots with no Base Color image, in an asset that has some.

    These bake as whatever Principled's default happens to be -- 0.8 white for
    an importer that wired nothing, near-black for one that wired a colour it
    read out of the FBX. Either way the asset comes out a chimera: a correctly
    textured trunk under a canopy of flat grey. Not an error the build can fix
    (the map exists on disk but nothing references it, so the wiring is a
    per-slot decision), which is exactly why it has to be reported."""
    return sorted(s.material.name for s in obj.material_slots
                  if s.material is not None and _base_color_image(s.material) is None)


def has_images(obj):
    return any(_base_color_image(s.material) is not None for s in obj.material_slots)


def _unloadable(images):
    """Images whose file is not where the datablock says it is.

    By path, not by `img.has_data`: Blender loads image pixels lazily, so
    `has_data` is False for a perfectly good texture nothing has sampled yet.
    Using it as the test reported three healthy maps as missing on an asset that
    had just baked correctly from them."""
    bad = []
    for img in images:
        if img is None or img.source != "FILE" or img.packed_file is not None:
            continue
        p = bpy.path.abspath(img.filepath)
        if not p or not os.path.exists(p):
            bad.append(img)
    return bad


def resolve_missing_images(obj, src, levels=3):
    """Re-find texture files the source references at a path that does not exist.

    `has_images` answers yes for these -- the material really does have a Base
    Color image node -- but the image has no pixels, and Blender substitutes
    magenta. So the asset takes the textured path, bakes magenta into its atlas,
    and the failure only shows up as a colour. `tree_oak_hero` baked at mean RGB
    (249, 0, 249) across 44% of its footprint before this existed.

    Two ways a pack does this, and this handles both because it matches on
    basename rather than on path: the FBX names a directory layout the download
    does not have (textures beside the mesh in `source/`, actually shipped in a
    sibling `textures/`), or it preserved the author's own machine
    (`C:/_Evan/PHOTSCANS/...`). Search outward one directory at a time and stop
    as soon as nothing is missing, rather than starting wide -- the pack roots
    sit inside one shared download tree, and a basename match across packs would
    quietly dress one asset in another's bark.

    Only Base Color maps are reported back. The FBXs carry slots for highlight,
    normal and specular maps that the packs frequently do not ship, and none of
    those have a consumer here -- §8 is one Lambert-ish pass -- so a warning
    about them is noise that would bury the one that matters."""
    d = os.path.dirname(os.path.abspath(src))
    for _ in range(levels):
        if not _unloadable(bpy.data.images):
            break
        bpy.ops.file.find_missing_files(directory=d, find_all=False)
        d = os.path.dirname(d)
    albedo = {_base_color_image(s.material) for s in obj.material_slots}
    return sorted(i.name for i in _unloadable(albedo))


def attach_loose_textures(obj, base_color_path, opacity_path=None):
    """Build a material from texture files the source did not reference.

    Megascans ships its FBX with no material at all -- the maps are loose JPGs
    next to it, named by convention, and the importing DCC is expected to wire
    them up. Without this the pipeline correctly detects "no images" and sends a
    photoscanned birch log down the flat-colour path, which throws away the only
    reason to use a photoscan.

    Generic on purpose. It reads two paths out of the manifest entry and builds
    the same Principled node tree every other textured asset already has, so
    everything downstream -- `has_images`, `consolidate_texture`, the alpha bake
    -- sees an ordinary textured asset and needs no special case. Adding another
    scanned source is a manifest edit, not a code change.

    Only base colour and opacity: the 8K normal, cavity, gloss, specular,
    displacement and translucency maps in these packs have nowhere to go. The
    runtime is one unlit-ish Lambert pass with a 128x128 albedo layer and baked
    AO (§8, §9), so a normal map has no consumer, and resampling one to 128x128
    would not survive the trip anyway."""
    img = bpy.data.images.load(base_color_path, check_existing=True)
    mat = bpy.data.materials.new("loose_%s" % obj.name)
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    if opacity_path:
        # Foliage scans put the cutout in a separate greyscale map rather than
        # in the base colour's alpha, so the alpha bake has nothing to read
        # unless it is linked here. A fern without it is a fern-shaped slab.
        op = bpy.data.images.load(opacity_path, check_existing=True)
        op.colorspace_settings.name = "Non-Color"
        opnode = nt.nodes.new("ShaderNodeTexImage")
        opnode.image = op
        nt.links.new(opnode.outputs["Color"], bsdf.inputs["Alpha"])

    obj.data.materials.clear()
    obj.data.materials.append(mat)


def consolidate_texture(obj, out_png, size=LAYER_SIZE):
    """Bake every material's base colour (and alpha) into ONE `size` image and
    rewrite the object's UVs to match.

    This is the step §9 flags as most likely to break, and the reason is that
    the sources violate the assumption an atlas bake needs: several of them
    reuse the same 0-1 UV space across materials (a trunk and a leaf card both
    unwrapped to fill the square), so the existing UVs cannot address a shared
    image. A fresh Smart UV Project is therefore not an optimisation, it is
    required for correctness -- and it is also what makes the "one layer per
    asset" accounting in §9 true rather than aspirational.

    The cost is that tiling is lost: bark that repeated up a trunk is now baked
    once across whatever area the unwrap gave it. At 128x128 for a whole tree
    that is the intended trade (§9's Class B), but it is why Class A tiling
    surfaces are a separate array and not baked here."""
    common.select_only([obj])
    neutralize_pbr(obj)

    # A second UV layer, so the bake reads the ORIGINAL UVs through the existing
    # materials while writing into the new layout. Baking into the layer you are
    # reading from feeds the bake its own partial output.
    # By NAME, not by reference: `uv_layers.new()` reallocates the underlying
    # CustomData array, and every existing Python pointer into it dangles. The
    # symptom is that `src_uv.name` later reads as '' and the remove below fails
    # with "UV map '' not found", which is the sort of error that looks like a
    # missing UV map and is actually a stale pointer.
    if obj.data.uv_layers.active is None:
        raise RuntimeError("consolidate_texture needs source UVs: %s" % obj.name)
    src_uv_name = obj.data.uv_layers.active.name
    dst_uv_name = obj.data.uv_layers.new(name="bake").name
    obj.data.uv_layers.active = obj.data.uv_layers[dst_uv_name]

    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    # island_margin keeps islands from bleeding into each other at coarse mips.
    # 128px with ~2px of margin is 0.016 in UV space.
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.016)
    bpy.ops.object.mode_set(mode="OBJECT")

    img = bpy.data.images.new("bake_%s" % obj.name, width=size, height=size, alpha=True)
    img.generated_color = (0.0, 0.0, 0.0, 0.0)

    # Every material needs an active Image Texture node pointing at `img` for
    # the bake to have somewhere to land.
    targets = []
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None:
            continue
        if mat.node_tree is None:
            continue
        node = mat.node_tree.nodes.new("ShaderNodeTexImage")
        node.image = img
        node.select = True
        mat.node_tree.nodes.active = node
        targets.append((mat, node))

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 4  # DIFFUSE colour-only bake is noise-free; 4 is plenty
    scene.render.bake.use_pass_direct = False
    scene.render.bake.use_pass_indirect = False
    scene.render.bake.use_pass_color = True
    scene.render.bake.target = "IMAGE_TEXTURES"
    scene.render.bake.margin = 4
    scene.render.bake.use_clear = True
    bpy.ops.object.bake(type="DIFFUSE")

    # Alpha does not come through a DIFFUSE bake, so carry it separately: the
    # cutout mask is load-bearing for foliage (§7 alpha test) and a tree whose
    # leaf cards bake opaque is a tree made of solid green rectangles.
    _bake_alpha_into(obj, img, size)

    img.filepath_raw = out_png
    img.file_format = "PNG"
    img.save()

    for mat, node in targets:
        mat.node_tree.nodes.remove(node)
    # Drop the original UV layer; the new one is the only valid addressing now.
    obj.data.uv_layers.remove(obj.data.uv_layers[src_uv_name])
    obj.data.uv_layers[dst_uv_name].name = "UVMap"
    obj.data.uv_layers.active = obj.data.uv_layers["UVMap"]
    return img


def _bake_alpha_into(obj, img, size):
    """Bake each material's Alpha input into the alpha channel of `img`.

    Done as an EMIT bake of the alpha signal into a scratch image, then copied
    into `img`'s alpha. Blender has no direct "bake alpha" pass, and the
    alternative -- reading the source alpha map and resampling it through the
    new UV layout by hand -- would have to reimplement the unwrap."""
    scratch = bpy.data.images.new("alpha_%s" % obj.name, width=size, height=size, alpha=False)

    saved = []
    targets = []
    any_alpha = False
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or mat.node_tree is None:
            continue
        bsdf = _principled(mat)
        if bsdf is None:
            continue
        nt = mat.node_tree
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        if out is None:
            continue

        emit = nt.nodes.new("ShaderNodeEmission")
        a = bsdf.inputs.get("Alpha")
        if a is not None and a.is_linked:
            nt.links.new(a.links[0].from_socket, emit.inputs["Color"])
            any_alpha = True
        else:
            v = 1.0 if a is None else float(a.default_value)
            emit.inputs["Color"].default_value = (v, v, v, 1.0)

        old_link = out.inputs["Surface"].links[0] if out.inputs["Surface"].is_linked else None
        old_from = old_link.from_socket if old_link else None
        nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])

        node = nt.nodes.new("ShaderNodeTexImage")
        node.image = scratch
        node.select = True
        nt.nodes.active = node

        saved.append((nt, out, old_from, emit))
        targets.append((nt, node))

    if not saved:
        bpy.data.images.remove(scratch)
        return

    bpy.context.scene.render.bake.use_clear = True
    bpy.ops.object.bake(type="EMIT")

    if any_alpha:
        src = list(scratch.pixels)
        dst = list(img.pixels)
        for i in range(0, len(dst), 4):
            dst[i + 3] = src[i]  # R of the emit bake is the alpha signal
        img.pixels[:] = dst

    for nt, out, old_from, emit in saved:
        if old_from is not None:
            nt.links.new(old_from, out.inputs["Surface"])
        nt.nodes.remove(emit)
    for nt, node in targets:
        nt.nodes.remove(node)
    bpy.data.images.remove(scratch)


# ---------------------------------------------------------------------------
# Vertex colour: material colour x AO
# ---------------------------------------------------------------------------

def ensure_corner_col(me):
    """Return a CORNER-domain BYTE_COLOR layer named "Col", converting in place.

    Everything downstream indexes this layer by LOOP index, so the domain is not
    a detail. `boulder_scan` is a photogrammetry PLY that arrives carrying its
    own POINT-domain FLOAT_COLOR layer already called "Col" -- one entry per
    vertex, not per corner -- and writing loop indices into it raised
    "index 224284 out of range, size 224284" a third of the way through the
    library. Converting rather than replacing keeps the scan's real colours,
    which are a far better boulder than the flat grey it would otherwise get."""
    existing = me.color_attributes.get("Col")
    if existing is not None and existing.domain == "CORNER" and existing.data_type == "BYTE_COLOR":
        return existing

    carried = None
    if existing is not None:
        if existing.domain == "POINT":
            per_vert = [tuple(d.color) for d in existing.data]
            carried = [per_vert[l.vertex_index] for l in me.loops]
        else:
            carried = [tuple(d.color) for d in existing.data]
        me.color_attributes.remove(existing)

    layer = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    if carried is not None and len(carried) == len(layer.data):
        for i, c in enumerate(carried):
            layer.data[i].color = c
    elif carried is None:
        for d in layer.data:
            d.color = (1.0, 1.0, 1.0, 1.0)
    return layer


def has_own_vertex_colors(obj):
    """True if the source arrived with real per-vertex colour of its own.

    A third source class beside "has textures" and "has flat Kd materials": the
    scanned PLYs carry their albedo in vertex colours and nothing else. Detected
    rather than declared, because the manifest cannot know it without opening
    the file, which is the same argument `has_images` makes."""
    return obj.data.color_attributes.get("Col") is not None


def material_colors_to_vertex(obj, override=None):
    """Write each face's material base colour into a vertex colour layer.

    For the flat-shaded sources this IS the asset's appearance -- three solid
    `Kd` materials, no UVs, nothing else. Collapsing them into one vertex colour
    layer is what lets the whole library share one material (§5), which is the
    condition BatchedMesh batches under. Written per CORNER rather than per
    POINT so a hard colour boundary (trunk against foliage) stays hard; a
    per-point layer averages across it and gives every trunk a green halo.

    `override` is the manifest's `base_color`, for the two sources that arrive
    with no material at all (`boulder_scan`, `bush_simple`). Without it they
    would take the 0.7 grey fallback below, and a mid-grey boulder in a green
    field reads as untextured rather than as rock."""
    me = obj.data
    layer = ensure_corner_col(me)

    if override:
        cols = [tuple(override) + (1.0,) if len(override) == 3 else tuple(override)]
    else:
        cols = [_flat_base_color(s.material) for s in obj.material_slots]
    if not cols:
        cols = [(0.7, 0.7, 0.7, 1.0)]

    for poly in me.polygons:
        c = cols[min(poly.material_index, len(cols) - 1)]
        for li in poly.loop_indices:
            layer.data[li].color = (c[0], c[1], c[2], 1.0)
    return layer


def bake_ao_to_vertex(obj, samples=64, distance=1.0, isolate=False):
    """Cycles AO bake, multiplied into the existing vertex colour layer.

    Multiplied rather than replacing, because the layer already carries either
    the material colour (flat assets) or white (textured assets), and the
    runtime multiplies vertex colour into albedo either way. That is what makes
    one shader path serve both classes.

    `distance` is the AO ray length and it has to be a fraction of the asset,
    not a constant: at 1 m on a 14 m tree the canopy self-occludes into a black
    mass, and at 1 m on a 0.4 m grass tuft nothing occludes anything.

    `isolate` hides every other mesh for the duration. The decimated path bakes
    once on the source, while it is alone in the scene, so it never needed this.
    The generated path bakes per tier, and the tiers are all grounded at the
    origin and fully interpenetrating -- so without it LOD1 casts its shadow
    onto LOD0 and the tiers get visibly different shading, which is exactly what
    a LOD swap must not have. `render_billboard` hides the scene the same way,
    for the same reason."""
    hidden = []
    if isolate:
        for o in bpy.context.scene.objects:
            if o.type == "MESH" and o is not obj and not o.hide_render:
                o.hide_render = True
                hidden.append(o)
    try:
        return _bake_ao(obj, samples, distance)
    finally:
        for o in hidden:
            o.hide_render = False


def _bake_ao(obj, samples, distance):
    me = obj.data
    layer = ensure_corner_col(me)

    before = [tuple(d.color) for d in layer.data]

    ao_layer = me.color_attributes.new(name="_ao", type="BYTE_COLOR", domain="CORNER")
    me.color_attributes.active_color = ao_layer
    me.attributes.active_color = ao_layer

    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.samples = samples
    if scene.world is None:
        scene.world = bpy.data.worlds.new("W")
    scene.render.bake.target = "VERTEX_COLORS"
    scene.render.bake.use_clear = True
    # The AO ray length lives on the WORLD, not on scene.cycles -- and it has
    # to be a fraction of the asset rather than a constant. At 1 m on a 14 m
    # tree the canopy self-occludes into a black mass; at 1 m on a 0.4 m grass
    # tuft nothing occludes anything at all.
    scene.world.light_settings.distance = distance
    common.select_only([obj])
    bpy.ops.object.bake(type="AO")

    ao = [tuple(d.color) for d in ao_layer.data]
    me.color_attributes.remove(ao_layer)

    # Lift the floor. A raw AO bake bottoms out at black, and black geometry in
    # a scene lit by one directional light plus ambient (§8) reads as a hole
    # rather than as shadow -- the ambient term is what a crevice is actually
    # lit by, and it is never zero outdoors.
    FLOOR = 0.45
    for i, c in enumerate(before):
        k = FLOOR + (1.0 - FLOOR) * ao[i][0]
        layer.data[i].color = (c[0] * k, c[1] * k, c[2] * k, c[3])

    me.color_attributes.active_color = layer
    me.attributes.active_color = layer
    return layer


# ---------------------------------------------------------------------------
# Final material
# ---------------------------------------------------------------------------

def finalize_material(obj, aid, textured, image=None):
    """Collapse every material slot into ONE material that references the vertex
    colour layer and (if textured) a UV-mapped image.

    This is not cosmetic, it is what makes the export correct. The glTF exporter
    only writes a colour attribute out if some material's node tree actually
    reads it, and only writes a UV layer out if some texture node samples it.
    Without this the exporter logs

        WARNING: The active Vertex Color will not be exported, as it is not
        used in the node tree of the material

    and drops COLOR_0 on the floor -- so the material colours and the AO bake,
    the two things this pipeline exists to produce, silently do not reach the
    runtime. The mesh still loads and still looks like a tree, which is exactly
    why this would have survived a long time unnoticed.

    Collapsing to one material also gives one glTF primitive per LOD instead of
    one per source material. BatchedMesh takes a single geometry per instance
    (§5), so a two-primitive LOD would have to be merged at load time anyway.

    `image` is this tier's real baked atlas, and it has to be, because
    `render_billboard` reads Base Color back out of this node tree. Handing it a
    stub here rendered nine impostor sheets as solid black -- the stub was the
    only albedo in the tree, and textured assets carry white vertex colours by
    design, so there was nothing else for the emission shader to pick up.

    The real image must NOT reach the GLB: the runtime samples the baked PNG out
    of the `uArrAsset` DataArrayTexture (§9), so embedding it would duplicate
    every layer inside every mesh. `swap_to_stub` does that swap immediately
    before export, once the billboard render is done with the real one."""
    me = obj.data
    mat = bpy.data.materials.new("prop_%s" % aid)
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])

    vcol = nt.nodes.new("ShaderNodeVertexColor")
    vcol.layer_name = "Col"

    if textured:
        tex = nt.nodes.new("ShaderNodeTexImage")
        tex.image = image if image is not None else bpy.data.images.new(
            "stub_%s" % aid, width=1, height=1, alpha=True)
        mix = nt.nodes.new("ShaderNodeMix")
        mix.data_type = "RGBA"
        mix.blend_type = "MULTIPLY"
        mix.inputs["Factor"].default_value = 1.0
        nt.links.new(tex.outputs["Color"], mix.inputs[6])
        nt.links.new(vcol.outputs["Color"], mix.inputs[7])
        nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        nt.links.new(tex.outputs["Alpha"], bsdf.inputs["Alpha"])
    else:
        nt.links.new(vcol.outputs["Color"], bsdf.inputs["Base Color"])

    me.materials.clear()
    me.materials.append(mat)
    for poly in me.polygons:
        poly.material_index = 0
    return mat


def swap_to_stub(objs, aid):
    """Point every Image Texture node at a 1x1 transparent stub.

    Run this after the billboard render and before the export. The texture node
    has to survive -- it is what makes the glTF exporter treat UVMap as used, and
    without a UV layer the runtime cannot address `uArrAsset` at all -- but the
    128x128 pixels behind it must not, or every layer ships twice: once in the
    array texture the runtime actually samples, and once embedded in the GLB."""
    stub = bpy.data.images.new("stub_%s" % aid, width=1, height=1, alpha=True)
    for obj in objs:
        for slot in obj.material_slots:
            mat = slot.material
            if mat is None or mat.node_tree is None:
                continue
            for node in mat.node_tree.nodes:
                if node.type == "TEX_IMAGE":
                    node.image = stub


# ---------------------------------------------------------------------------
# Decimation
# ---------------------------------------------------------------------------

def decimate_to(obj, target_tris, mode="collapse"):
    """Decimate a COPY of `obj` down to `target_tris`. Returns the new object.

    Blender's collapse decimator takes a ratio, not a target, and the ratio it
    hits is approximate -- it stops early when every remaining collapse would
    fold a boundary or flip a normal. So this iterates: aim, measure, re-aim.
    Two or three rounds converge; the loop caps at six so a mesh that genuinely
    cannot reach the target (all boundary edges, which is what a pile of
    disconnected alpha cards is) fails loudly with its real count instead of
    spinning."""
    dup = obj.copy()
    dup.data = obj.data.copy()
    bpy.context.scene.collection.objects.link(dup)

    cur = common.tri_count(dup)
    if cur <= target_tris:
        return dup

    if mode == "planar_collapse":
        # Hard-surface assets (cabins, towers, mills) are mostly large flat
        # planes triangulated into many coplanar faces. Dissolving those first
        # costs no silhouette at all, which is not true of a collapse pass.
        m = dup.modifiers.new("pre", "DECIMATE")
        m.decimate_type = "DISSOLVE"
        m.angle_limit = math.radians(12.0)
        m.use_dissolve_boundaries = True
        common.select_only([dup])
        bpy.ops.object.modifier_apply(modifier=m.name)
        common.clean_mesh(dup)
        mode = "collapse"

    # Iterate until it stops improving, not for a fixed number of rounds.
    #
    # The cleanup at the bottom of this loop is what makes the loop work at all,
    # which is not obvious. The decimator leaves the vertices it collapses in the
    # mesh (see `common.drop_loose`), and it will not collapse across a boundary
    # -- so a mesh still carrying the previous round's debris presents a topology
    # the next round can barely touch, and the whole thing plateaus long before
    # the real floor. Measured on `wild_grass`, cleaning between rounds is the
    # difference between stopping at 253 triangles and reaching the 16 asked for.
    # `boulder_mossy` and `horsetail` had been recorded as boundary stalls on
    # that evidence, and were not stalled at all.
    #
    # `validate` on the same line of reasoning: collapse leaves degenerate faces
    # at aggressive ratios, and left alone they reach the runtime as zero-area
    # triangles that still cost a vertex fetch and still get rasterised. It was
    # the fix for the exporter reporting "Mesh grass_LOD0 is not valid".
    prev = None
    for _ in range(12):
        cur = common.tri_count(dup)
        if cur <= target_tris or cur == prev:
            break
        prev = cur
        ratio = max(min(target_tris / float(cur), 1.0), 0.0005)
        m = dup.modifiers.new("dec", "DECIMATE")
        if mode == "unsubdiv":
            m.decimate_type = "UNSUBDIV"
            m.iterations = 1
        elif mode == "planar":
            m.decimate_type = "DISSOLVE"
            m.angle_limit = math.radians(5.0)
        else:
            m.decimate_type = "COLLAPSE"
            m.ratio = ratio
            m.use_collapse_triangulate = True
        common.select_only([dup])
        bpy.ops.object.modifier_apply(modifier=m.name)
        dup.data.validate(verbose=False)
        common.drop_loose(dup)
        if mode != "collapse":
            break  # planar/unsubdiv are one-shot; iterating them does nothing

    dup.data.validate(verbose=False)
    common.drop_loose(dup)
    return dup


# ---------------------------------------------------------------------------
# Billboard
# ---------------------------------------------------------------------------

def render_billboard(obj, out_png, size=BILLBOARD_SIZE):
    """Orthographic side render of `obj` on transparent black -> `out_png`.

    Side view only, one image. An octahedral impostor (8-16 view directions)
    would give real parallax, but at 128x128 per view it costs 8-16 array
    layers per asset against a MAX_ARRAY_TEXTURE_LAYERS guarantee of 256 (§9),
    which spends the entire budget on impostors for ten assets. The cross-quad
    §5 specifies takes exactly one layer, and its flatness is hidden by the
    thing that makes billboards necessary in the first place: at the distance
    they switch in, the forest is dense enough that no single tree is
    separable.

    Rendered with EMIT shading so the impostor carries the asset's albedo and
    nothing else. Any baked-in directional light would be wrong the moment the
    sun moves (§8), and the sun moves continuously here."""
    scene = bpy.context.scene
    lo, hi = common.world_bounds([obj])
    h = hi.z - lo.z
    w = max(hi.x - lo.x, hi.y - lo.y)
    span = max(w, h)

    cam_data = bpy.data.cameras.new("bb_cam")
    cam_data.type = "ORTHO"
    cam_data.ortho_scale = span * 1.02
    cam = bpy.data.objects.new("bb_cam", cam_data)
    scene.collection.objects.link(cam)
    # Look along +Y at the asset's centre, from far enough out to clear it.
    cx = (lo.x + hi.x) * 0.5
    cz = (lo.z + hi.z) * 0.5
    cam.location = (cx, lo.y - span * 3.0, cz)
    cam.rotation_euler = (math.pi / 2, 0.0, 0.0)
    cam_data.clip_start = span * 0.5
    cam_data.clip_end = span * 8.0
    scene.camera = cam

    prev = {
        "engine": scene.render.engine,
        "x": scene.render.resolution_x,
        "y": scene.render.resolution_y,
        "pct": scene.render.resolution_percentage,
        "film": scene.render.film_transparent,
        "path": scene.render.filepath,
        "fmt": scene.render.image_settings.file_format,
        "mode": scene.render.image_settings.color_mode,
    }
    scene.render.engine = "CYCLES"
    scene.cycles.samples = 16
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = out_png

    # Swap every material to pure emission of its own base colour, so the
    # render is albedo with no lighting in it.
    swapped = []
    for slot in obj.material_slots:
        mat = slot.material
        if mat is None or mat.node_tree is None:
            continue
        nt = mat.node_tree
        out = next((n for n in nt.nodes if n.type == "OUTPUT_MATERIAL"), None)
        bsdf = _principled(mat)
        if out is None or bsdf is None:
            continue
        emit = nt.nodes.new("ShaderNodeEmission")
        bc = bsdf.inputs.get("Base Color")
        if bc is not None and bc.is_linked:
            nt.links.new(bc.links[0].from_socket, emit.inputs["Color"])
        else:
            emit.inputs["Color"].default_value = _flat_base_color(mat)
        # Keep the cutout: a billboard of a tree with its leaf alpha thrown
        # away is a green rectangle, which is the classic impostor failure.
        trans = nt.nodes.new("ShaderNodeBsdfTransparent")
        mix = nt.nodes.new("ShaderNodeMixShader")
        a = bsdf.inputs.get("Alpha")
        if a is not None and a.is_linked:
            nt.links.new(a.links[0].from_socket, mix.inputs["Fac"])
        else:
            mix.inputs["Fac"].default_value = 1.0 if a is None else float(a.default_value)
        nt.links.new(trans.outputs["BSDF"], mix.inputs[1])
        nt.links.new(emit.outputs["Emission"], mix.inputs[2])
        old = out.inputs["Surface"].links[0].from_socket if out.inputs["Surface"].is_linked else None
        nt.links.new(mix.outputs["Shader"], out.inputs["Surface"])
        swapped.append((nt, out, old, [emit, trans, mix]))

    # Hide everything else in the scene so no stray import lands in the render.
    hidden = []
    for o in bpy.context.scene.objects:
        if o.type == "MESH" and o is not obj and not o.hide_render:
            o.hide_render = True
            hidden.append(o)

    bpy.ops.render.render(write_still=True)

    for o in hidden:
        o.hide_render = False
    for nt, out, old, nodes in swapped:
        if old is not None:
            nt.links.new(old, out.inputs["Surface"])
        for n in nodes:
            nt.nodes.remove(n)
    bpy.data.objects.remove(cam, do_unlink=True)
    bpy.data.cameras.remove(cam_data)

    scene.render.engine = prev["engine"]
    scene.render.resolution_x = prev["x"]
    scene.render.resolution_y = prev["y"]
    scene.render.resolution_percentage = prev["pct"]
    scene.render.film_transparent = prev["film"]
    scene.render.filepath = prev["path"]
    scene.render.image_settings.file_format = prev["fmt"]
    scene.render.image_settings.color_mode = prev["mode"]

    return {"width": span, "height": h}


def build_cross_quad(name, width, height, quads=2):
    """The billboard geometry: `quads` vertical planes through the up (+Z) axis.

    Three at 60 degrees rather than two at 90, for large props. A two-quad cross
    has an orientation from which it presents edge-on and momentarily vanishes;
    §5 hides that with per-instance random yaw, which works statistically but
    still means some fraction of the forest is a line at any moment. The third
    quad costs 2 triangles and removes the failure rather than distributing it.
    Small props keep 2 -- they are gone before anyone can look at one."""
    me = bpy.data.meshes.new(name)
    verts, faces, uvs = [], [], []
    hw = width * 0.5
    for q in range(quads):
        a = math.pi * q / quads
        dx, dy = math.cos(a) * hw, math.sin(a) * hw
        base = len(verts)
        verts += [
            (-dx, -dy, 0.0), (dx, dy, 0.0), (dx, dy, height), (-dx, -dy, height),
        ]
        faces += [(base, base + 1, base + 2), (base, base + 2, base + 3)]
        uvs += [(0.0, 0.0), (1.0, 0.0), (1.0, 1.0), (0.0, 0.0), (1.0, 1.0), (0.0, 1.0)]
    me.from_pydata(verts, [], faces)
    me.update()
    uvl = me.uv_layers.new(name="UVMap")
    for i, uv in enumerate(uvs):
        uvl.data[i].uv = uv
    col = me.color_attributes.new(name="Col", type="BYTE_COLOR", domain="CORNER")
    for d in col.data:
        d.color = (1.0, 1.0, 1.0, 1.0)
    obj = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


# ---------------------------------------------------------------------------
# Per-asset driver
# ---------------------------------------------------------------------------

def build_asset(spec, out_dir, opts):
    aid = spec["id"]
    common.reset_scene()

    objs = common.import_any(spec["src"])
    obj = common.join_all(objs, aid)
    common.apply_transforms(obj)

    # Before anything asks whether this asset is textured -- a scan source needs
    # its loose maps wired up first or it answers "no". See attach_loose_textures.
    if spec.get("base_color_map"):
        attach_loose_textures(obj, spec["base_color_map"], spec.get("opacity_map"))

    # After the line above, not before it: the three `grass_tall_scan` FBXs name
    # an `Atlas_texture1` that does not ship, and `base_color_map` replaces that
    # material outright -- so checking first accuses an asset whose texture is
    # about to be fine.
    unresolved = resolve_missing_images(obj, spec["src"])
    if unresolved:
        # Loud, and recorded, because the asset still builds: it bakes magenta
        # and ships looking like a Blender error, which is a thing you can only
        # find by looking at it.
        print("WARN %-22s textures not found: %s" % (aid, ", ".join(unresolved)))

    # After the resolve, because a slot whose image was missing has nothing to
    # wire yet, and before `has_images` decides the asset's whole path.
    rewired = wire_orphan_color(obj)
    if rewired:
        print("     %-22s wired Base Color from alpha-only image: %s" % (aid, ", ".join(rewired)))

    if spec.get("rotate_x_deg"):
        obj.rotation_euler = (math.radians(spec["rotate_x_deg"]), 0.0, 0.0)
        common.apply_transforms(obj)

    common.ground_and_center(obj)
    src_tris = common.tri_count(obj)
    common.clean_mesh(obj, merge_dist=spec.get("weld", 0.0001))
    welded_tris = common.tri_count(obj)
    scale_k = common.scale_to_height(obj, spec["height_m"])

    rec = {
        "id": aid,
        "class": spec["class"],
        "src": os.path.relpath(spec["src"]),
        "src_tris": src_tris,
        "welded_tris": welded_tris,
        "height_m": spec["height_m"],
        "source_scale": round(scale_k, 6),
        "lods": [],
    }
    if unresolved:
        rec["missing_images"] = unresolved

    # --- texture or vertex colour -----------------------------------------
    textured = has_images(obj) and not spec.get("force_vertex_color")
    if textured:
        color_source = "baked_texture"
        flat = untextured_slots(obj)
        if flat:
            print("WARN %-22s textured, but %d slot(s) bake flat: %s"
                  % (aid, len(flat), ", ".join(flat)))
            rec["untextured_slots"] = flat
        # White vertex colour so the AO multiply below is the only thing in it.
        for d in ensure_corner_col(obj.data).data:
            d.color = (1.0, 1.0, 1.0, 1.0)
    elif has_own_vertex_colors(obj):
        # The scanned PLYs carry their albedo here and have no materials at all.
        # Keep it: `base_color` in the manifest is the fallback for an asset with
        # NO colour source, and a scan is not that.
        color_source = "source_vertex_color"
        ensure_corner_col(obj.data)
    else:
        color_source = "material_color"
        material_colors_to_vertex(obj, override=spec.get("base_color"))

    rec["textured"] = textured
    rec["color_source"] = color_source

    if opts.bake:
        bake_ao_to_vertex(obj, samples=spec.get("ao_samples", 48),
                          distance=spec["height_m"] * spec.get("ao_reach", 0.25))

    if not textured:
        # All the colour is in COLOR_0, which survives decimation, so one
        # material for the whole chain is enough: the LODs are copies of `obj`
        # and inherit it. Textured assets cannot do this -- see the loop below.
        finalize_material(obj, aid, False)

    # --- LOD chain ---------------------------------------------------------
    budgets = spec["lod_tris"]
    lod_objs = []
    for i, target in enumerate(budgets):
        lod = decimate_to(obj, target, mode=spec.get("decimate", "collapse"))
        lod.name = "%s_LOD%d" % (aid, i)
        lod.data.name = lod.name

        # Re-ground and re-scale EVERY tier, because decimation moves the
        # bounds. Collapsing a vertex removes an extreme, so a decimated mesh is
        # systematically shorter than its source and no longer sits on z=0 --
        # measured, a 16-tri plant lost 28% of its height and floated 15 cm.
        # Two separate defects follow from leaving that alone: the prop is the
        # wrong size against §6's scale reference, and it visibly shrinks and
        # hops at every LOD transition. Renormalising costs nothing and makes
        # the tiers interchangeable, which is the whole premise of swapping them.
        common.ground_and_center(lod)
        common.scale_to_height(lod, spec["height_m"])

        # Unwrap and bake PER TIER, not once on the full-res source.
        #
        # The atlas addresses the mesh through UVs that Smart UV Project laid out
        # for a specific triangulation. Decimating afterwards collapses vertices
        # and drags their UVs with them, so islands smear across the seams and
        # triangles land on whatever happens to be next door -- usually the
        # transparent gutter, which alpha-test then discards outright. Measured
        # on the old order: 11 of 21 textured assets lost more than a quarter of
        # their triangles to it, and five lost all of them. It tracked decimation
        # depth exactly -- cabins keeping 8-18% of their source triangles were
        # fine, photoscans keeping 0.01-0.6% were not -- which is what you would
        # expect if the UVs are only valid for the topology they were made for.
        #
        # Unwrapping after decimation costs one Cycles bake per tier instead of
        # one per asset, and in exchange every tier's UVs describe that tier's
        # own triangles. It also unblocks the decimator: Smart UV Project's seams
        # are boundaries the collapse decimator will not cross, so baking first
        # was putting a floor under every LOD budget below it.
        layer = None
        if textured:
            layer_png = os.path.join(out_dir, "layers", "%s_L%d.png" % (aid, i))
            os.makedirs(os.path.dirname(layer_png), exist_ok=True)
            img = consolidate_texture(lod, layer_png)
            finalize_material(lod, "%s_L%d" % (aid, i), True, image=img)
            layer = "layers/%s_L%d.png" % (aid, i)

        lod_objs.append(lod)
        got = common.tri_count(lod)
        entry = {
            "name": lod.name,
            "target_tris": target,
            "tris": got,
            "verts": len(lod.data.vertices),
            "kind": "mesh",
            "layer": layer,
        }
        # The collapse decimator will not collapse across an open boundary, so
        # a mesh with many boundary loops has a hard floor above its target. Say
        # so in the record rather than letting the budget look met: a chain that
        # silently returns 917 tris for a 130 target is the single most
        # expensive kind of lie this pipeline could tell.
        if got > target * 1.1:
            entry["stalled"] = True
            entry["overshoot"] = round(got / float(target), 2)
        rec["lods"].append(entry)

    # --- billboard ---------------------------------------------------------
    if spec.get("billboard") and opts.billboard:
        bb_png = os.path.join(out_dir, "layers", "%s_bb.png" % aid)
        os.makedirs(os.path.dirname(bb_png), exist_ok=True)
        dims = render_billboard(lod_objs[0], bb_png)
        quads = spec.get("billboard_quads", 3)
        bb = build_cross_quad("%s_BB" % aid, dims["width"], dims["height"], quads)
        lod_objs.append(bb)
        rec["lods"].append({
            "name": bb.name,
            "target_tris": quads * 2,
            "tris": quads * 2,
            "verts": quads * 4,
            "kind": "billboard",
            "layer": "layers/%s_bb.png" % aid,
            "width_m": round(dims["width"], 4),
            "height_m": round(dims["height"], 4),
        })
        rec["billboard_layer"] = "layers/%s_bb.png" % aid

    # --- export ------------------------------------------------------------
    bpy.data.objects.remove(obj, do_unlink=True)
    if textured:
        swap_to_stub(lod_objs, aid)
    glb = os.path.join(out_dir, "assets", "%s.glb" % aid)
    os.makedirs(os.path.dirname(glb), exist_ok=True)
    common.select_only(lod_objs)
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    rec["glb"] = "assets/%s.glb" % aid
    rec["glb_bytes"] = os.path.getsize(glb)
    return rec


# ---------------------------------------------------------------------------
# Generated assets
# ---------------------------------------------------------------------------

def adopt_generated_colors(obj):
    """Rename the imported COLOR_0 to the name the rest of this file expects.

    Blender's glTF importer calls it "Color"; every consumer here -- the vertex
    colour node in `finalize_material`, `ensure_corner_col`, the AO multiply --
    looks for "Col". Left alone, `ensure_corner_col` finds nothing, creates a
    fresh WHITE layer, and the generator's bark and leaf tints vanish without an
    error: the tree still builds and still renders, in the wrong colours.
    """
    ca = obj.data.color_attributes
    if ca.get("Col") is not None:
        return
    src = ca.get("Color")
    if src is None:
        raise RuntimeError("%s: imported tier has no COLOR_0 -- the generator "
                           "must write bark and leaf tints" % obj.name)
    src.name = "Col"
    ensure_corner_col(obj.data)  # normalise domain/type, keeping the colours


def build_generated(spec, out_dir, opts):
    """Build an asset whose LOD tiers were AUTHORED, not decimated.

    `tools/trees/generate.mjs` emits one GLB per tier, already on budget, and
    this walks them through the same finishing the scanned assets get: ground,
    scale, AO into vertex colour, one material, an impostor sheet, one GLB.

    Two things are deliberately NOT done here, and they are the point:

    NO DECIMATION. The generator takes the triangle budget as an input, so there
    is nothing to decimate toward. That removes the boundary stall outright --
    the collapse decimator refuses to cross an open boundary, alpha cards are
    almost entirely boundary, and that is why four grass variants and two trees
    had to be dropped from the hand-collected library rather than hit budget.

    NO PER-TIER ATLAS BAKE. Authored tiers share a UV layout, so every tier of
    every tree of a species addresses ONE `shared_layer` -- five 128x128 PNGs
    for the whole generated set. `consolidate_texture` exists because decimation
    invalidates a tier's UVs; nothing here invalidates them.
    """
    aid = spec["id"]
    common.reset_scene()

    # The atlas is an INPUT, staged in tmp/ by tools/trees/layers.py, and it is
    # copied into the output tree here rather than written there directly
    # because `--clean` wipes the output tree immediately before this runs.
    # Several assets share one file, so copying is idempotent by design.
    layer_rel = spec["shared_layer"]
    layer_src = spec["shared_layer_src"]
    if not os.path.exists(layer_src):
        raise RuntimeError("%s: shared layer %s missing -- run tools/trees/layers.py first"
                           % (aid, layer_src))
    layer_png = os.path.join(out_dir, layer_rel)
    os.makedirs(os.path.dirname(layer_png), exist_ok=True)
    shutil.copyfile(layer_src, layer_png)
    image = bpy.data.images.load(layer_png)

    rec = {
        "id": aid,
        "class": spec["class"],
        "src": spec["tiers"][0],
        "height_m": spec["height_m"],
        "generated": True,
        "textured": True,
        # Not "baked_texture": nothing was baked. The tints the generator wrote
        # into COLOR_0 are real colour that the AO multiply and the shared atlas
        # both build on, so this must not be confused with the textured path's
        # white-vertex-colour convention.
        "color_source": "generated_vertex_color",
        "shared_layer": layer_rel,
        "lods": [],
    }

    lod_objs = []
    for i, tier in enumerate(spec["tiers"]):
        if not os.path.exists(tier):
            raise RuntimeError("%s: tier %d missing (%s) -- run tools/trees/generate.mjs" % (aid, i, tier))
        lod = common.join_all(common.import_any(tier), "%s_LOD%d" % (aid, i))
        common.apply_transforms(lod)  # the importer carries Y-up in as a rotation
        lod.data.name = lod.name
        adopt_generated_colors(lod)

        # Ground and scale every tier for the same reason the decimated chain
        # does: the tiers must be interchangeable, and a tier that sits 3 cm
        # higher than its neighbour hops at the transition.
        common.ground_and_center(lod)
        scale_k = common.scale_to_height(lod, spec["height_m"])
        if i == 0:
            rec["source_scale"] = round(scale_k, 6)
            rec["src_tris"] = common.tri_count(lod)
            rec["welded_tris"] = rec["src_tris"]

        if opts.bake:
            # A much shorter reach than the 0.25 the scanned assets use. AO rays
            # do not know a leaf card is a cutout -- to Cycles the canopy is a
            # few hundred overlapping opaque quads -- so a reach that spans the
            # crown buries the whole tree in its own shadow. A short reach still
            # darkens where cards genuinely stack, which is the depth we want.
            bake_ao_to_vertex(lod, samples=spec.get("ao_samples", 32),
                              distance=spec["height_m"] * spec.get("ao_reach", 0.06),
                              isolate=True)

        finalize_material(lod, "%s_L%d" % (aid, i), True, image=image)
        lod_objs.append(lod)

        got = common.tri_count(lod)
        target = spec["lod_tris"][i]
        entry = {
            "name": lod.name,
            "target_tris": target,
            "tris": got,
            "verts": len(lod.data.vertices),
            "kind": "mesh",
            "layer": layer_rel,
        }
        # Kept even though a generator cannot stall the way a decimator does:
        # if this ever fires it means the generator and the manifest disagree
        # about the budget, which is worth hearing about rather than absorbing.
        if got > target * 1.1:
            entry["stalled"] = True
            entry["overshoot"] = round(got / float(target), 2)
        rec["lods"].append(entry)

    if spec.get("billboard") and opts.billboard:
        bb_png = os.path.join(out_dir, "layers", "%s_bb.png" % aid)
        os.makedirs(os.path.dirname(bb_png), exist_ok=True)
        dims = render_billboard(lod_objs[0], bb_png)
        quads = spec.get("billboard_quads", 3)
        bb = build_cross_quad("%s_BB" % aid, dims["width"], dims["height"], quads)
        lod_objs.append(bb)
        rec["lods"].append({
            "name": bb.name,
            "target_tris": quads * 2,
            "tris": quads * 2,
            "verts": quads * 4,
            "kind": "billboard",
            "layer": "layers/%s_bb.png" % aid,
            "width_m": round(dims["width"], 4),
            "height_m": round(dims["height"], 4),
        })
        rec["billboard_layer"] = "layers/%s_bb.png" % aid

    # The shared atlas must not travel inside the GLB -- that is the whole
    # saving. Same swap the textured path makes, and for the same reason, except
    # here it would duplicate one layer into every tier of every tree using it.
    swap_to_stub(lod_objs, aid)
    glb = os.path.join(out_dir, "assets", "%s.glb" % aid)
    os.makedirs(os.path.dirname(glb), exist_ok=True)
    common.select_only(lod_objs)
    bpy.ops.export_scene.gltf(
        filepath=glb,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_normals=True,
        export_texcoords=True,
        export_tangents=False,
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_skins=False,
        export_morph=False,
    )
    rec["glb"] = "assets/%s.glb" % aid
    rec["glb_bytes"] = os.path.getsize(glb)
    return rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--only", nargs="*", default=None)
    ap.add_argument("--no-bake", dest="bake", action="store_false")
    ap.add_argument("--no-billboard", dest="billboard", action="store_false")
    ap.add_argument("--clean", action="store_true")
    opts = ap.parse_args(common.script_args())

    with open(opts.manifest) as f:
        manifest = json.load(f)

    out_dir = opts.out
    if opts.clean and os.path.isdir(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(out_dir, exist_ok=True)

    specs = manifest["assets"]
    if opts.only:
        specs = [s for s in specs if s["id"] in opts.only]

    built, failed = [], []
    for spec in specs:
        # A generated spec names authored tiers instead of one source file, so
        # it is dispatched on that rather than on a `src` it does not have.
        generated = bool(spec.get("tiers"))
        if not generated and not os.path.exists(spec["src"]):
            failed.append({"id": spec["id"], "error": "source missing: %s" % spec["src"]})
            print("MISS %s" % spec["id"])
            continue
        try:
            rec = build_generated(spec, out_dir, opts) if generated else build_asset(spec, out_dir, opts)
            built.append(rec)
            chain = " -> ".join("%d" % l["tris"] for l in rec["lods"])
            print("OK   %-22s %7d src  %s  %s" % (
                rec["id"], rec["src_tris"], chain,
                "gen" if generated else ("tex" if rec["textured"] else "vcol")))
        except Exception as e:  # noqa: BLE001
            import traceback
            traceback.print_exc()
            failed.append({"id": spec["id"], "error": "%s: %s" % (type(e).__name__, e)})
            print("FAIL %-22s %s" % (spec["id"], e))

    out = {
        "layer_size": LAYER_SIZE,
        "billboard_size": BILLBOARD_SIZE,
        "lod_ranges": manifest["lod_ranges"],
        "classes": manifest["classes"],
        "assets": built,
        "failed": failed,
    }
    common.write_json(os.path.join(out_dir, "manifest.json"), out)
    print("\nbuilt %d, failed %d" % (len(built), len(failed)))


# Blender runs `--python` scripts with __name__ == "__main__", so this still
# executes normally -- but it also lets a diagnostic script import this module
# to poke at one stage of one asset without running a whole build.
if __name__ == "__main__":
    main()
