"""Shared foliage atlases: one 128x128 layer per leaf species, one for grass.

Run under Blender (it needs bpy for the resample and nothing else):

    blender --background --python tools/trees/layers.py -- --out public/props

WHAT MAKES THESE DIFFERENT FROM EVERY OTHER LAYER IN THE LIBRARY. `build.py`
bakes one layer per asset per LOD tier -- `tree_dead_standing` alone ships three
near-identical 40 KB PNGs -- because a decimated tier's UVs no longer match the
tier above it. Generated foliage has no such problem: the tiers are authored,
not decimated, so every tier of every tree of a species can point at ONE image.
Seven tree species and three grass variants cost 5 layers total, not 20.

LAYOUT (and see the PATCH_V note in generate.mjs for why it is shaped this way):

    rows 32..127   leaf art, cropped to its alpha bounds and resampled
    rows  0..31    solid opaque white -- every bark vertex samples the centre

Blender indexes image rows from the BOTTOM, and so does UV space, so "rows 0..31"
is v in [0, 0.25] in both. No flip to reason about.

PROVENANCE -- UNRESOLVED, DO NOT SHIP ON THIS BASIS. EZ-Tree is MIT (Copyright
2024 Daniel Greenheck) and that covers its code. Its bark textures carry a
sources README crediting texturecan.com and polyhaven. Its LEAF atlases and the
grass tuft inside grass.glb carry no attribution anywhere in the package, and
they are photographic, so they did not originate with the project. Fine for a
proof of concept; needs an answer before these reach a build anyone can play.
The fallback if the answer is bad is to paint four leaf sprays procedurally --
at 128x128 with an alpha cutout that is a tractable amount of work.
"""

import argparse
import json
import os
import struct
import sys

import bpy
import numpy as np

HERE = os.path.dirname(os.path.realpath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
EZ = os.path.join(ROOT, "node_modules/@dgreenheck/ez-tree/src")

SIZE = 128
PATCH_ROWS = 32          # must equal PATCH_V * SIZE in generate.mjs
ART_ROWS = SIZE - PATCH_ROWS

LEAVES = ["pine", "oak", "aspen", "ash"]


# --- reading -----------------------------------------------------------------

def load_rgba(path):
    """Load a PNG as a float (h, w, 4) array of RAW values, bottom row first.

    Non-Color matters: these are already-encoded sRGB bytes and we are moving
    them, not lighting them. Letting Blender treat them as sRGB would linearise
    on read, and saving would re-encode -- a round trip that is only lossless if
    nothing in between touches the numbers, which resampling does.
    """
    img = bpy.data.images.load(path)
    img.colorspace_settings.name = "Non-Color"
    w, h = img.size
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)


def extract_glb_image(glb_path, out_png):
    """Pull the first embedded image out of a .glb.

    The grass tuft only exists inside EZ-Tree's grass.glb -- there is no loose
    copy in the package. Parsing a GLB well enough to find one image is a header,
    a JSON chunk and an offset, so it happens here rather than adding a
    dependency or a second tool to the chain.
    """
    with open(glb_path, "rb") as f:
        data = f.read()

    magic, _version, _length = struct.unpack_from("<4sII", data, 0)
    if magic != b"glTF":
        raise SystemExit("%s is not a GLB" % glb_path)

    chunks, off = {}, 12
    while off < len(data):
        clen, ctype = struct.unpack_from("<II", data, off)
        chunks[ctype] = data[off + 8: off + 8 + clen]
        off += 8 + clen + (-clen % 4)

    gltf = json.loads(chunks[0x4E4F534A].decode("utf-8"))
    bin_chunk = chunks[0x004E4942]

    images = gltf.get("images") or []
    if not images:
        raise SystemExit("%s embeds no images" % glb_path)
    view = gltf["bufferViews"][images[0]["bufferView"]]
    start = view.get("byteOffset", 0)
    blob = bin_chunk[start: start + view["byteLength"]]

    # Whatever the mime type says, keep the container's own extension so
    # Blender's loader dispatches on something true.
    ext = ".png" if images[0].get("mimeType", "").endswith("png") else ".webp"
    path = os.path.splitext(out_png)[0] + ext
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(blob)
    return path


# --- shaping -----------------------------------------------------------------

def crop_to_art(rgba):
    """Square crop around everything the alpha test will actually keep.

    The source atlases are mostly empty -- a leaf spray floating in transparency
    with wide margins. Resampling that straight to 128 spends most of the layer
    on nothing. Cropping to the alpha bounds first is worth roughly a third more
    effective resolution on the part anyone sees.

    Threshold 0.5 because that is the alphaTest the material runs (§7): a texel
    below it is not "faint", it is absent, and it should not widen the crop.
    """
    keep = rgba[:, :, 3] > 0.5
    if not keep.any():
        raise SystemExit("source image is empty above the alpha threshold")

    rows, cols = np.where(keep)
    y0, y1 = int(rows.min()), int(rows.max()) + 1
    x0, x1 = int(cols.min()), int(cols.max()) + 1

    # Square it about the centre so the resample to a 128x96 slot applies one
    # known 4:3 squash rather than the source's arbitrary aspect on top of it.
    h, w = y1 - y0, x1 - x0
    side = max(h, w)
    cy, cx = (y0 + y1) // 2, (x0 + x1) // 2
    y0 = max(0, cy - side // 2)
    x0 = max(0, cx - side // 2)
    y1 = min(rgba.shape[0], y0 + side)
    x1 = min(rgba.shape[1], x0 + side)
    return rgba[y0:y1, x0:x1]


def resample(rgba, w, h):
    """Resize via Blender's own image scaler.

    Deliberately not a hand-rolled box filter: this has to handle the alpha
    channel of a cutout, and getting that subtly wrong shows up as leaves with
    haloed or eroded edges after the alpha test -- exactly the failure that is
    hardest to spot in a thumbnail and impossible to miss in a headset.
    """
    src_h, src_w = rgba.shape[:2]
    img = bpy.data.images.new("_resample", width=src_w, height=src_h, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(rgba.astype(np.float32).ravel())
    img.scale(w, h)
    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    bpy.data.images.remove(img)
    return buf.reshape(h, w, 4)


def compose(art, out_png, patch):
    """Art over the bark patch (or filling the layer, when there is no bark)."""
    out = np.zeros((SIZE, SIZE, 4), dtype=np.float32)
    if patch:
        out[:PATCH_ROWS] = (1.0, 1.0, 1.0, 1.0)
        out[PATCH_ROWS:] = art
    else:
        out[:] = art

    # Kill the colour of fully-transparent texels. They are invisible on their
    # own, but mip generation averages RGB without regard to alpha, so a black
    # transparent background bleeds a dark rim into every leaf edge one mip down.
    # Flooding them white instead means the bleed goes toward the leaf's own
    # brightness, which reads as softening rather than as an outline.
    clear = out[:, :, 3] < 0.5
    out[clear, 0:3] = 1.0

    img = bpy.data.images.new("_out", width=SIZE, height=SIZE, alpha=True)
    img.colorspace_settings.name = "Non-Color"
    img.pixels.foreach_set(out.ravel())
    img.file_format = "PNG"
    os.makedirs(os.path.dirname(out_png), exist_ok=True)
    img.save(filepath=out_png)
    bpy.data.images.remove(img)
    return out


def build(src_png, out_png, patch=True):
    rows = ART_ROWS if patch else SIZE
    art = resample(crop_to_art(load_rgba(src_png)), SIZE, rows)
    compose(art, out_png, patch)
    kb = os.path.getsize(out_png) / 1024.0
    print("  %-28s %d rows of art  %.1f KB" % (os.path.basename(out_png), rows, kb))


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    # Staged under tmp/, NOT straight into public/props: `npm run props` runs
    # build.py with --clean, which deletes public/props before building, and
    # these have to exist BEFORE the generated assets build. They are inputs to
    # the build, not products of it. build.py copies each one into place as the
    # asset that references it is built.
    ap.add_argument("--out", default=os.path.join(ROOT, "tmp/generated-props"))
    opts = ap.parse_args(argv)

    layers = os.path.join(opts.out, "layers")

    for name in LEAVES:
        build(os.path.join(EZ, "lib/assets/leaves/%s_color.png" % name),
              os.path.join(layers, "leaf_%s.png" % name))

    # No patch for grass: it is cards and nothing else, so there is no bark to
    # give an opaque texel to, and it is the most-instanced asset in the world.
    # Handing it the other 32 rows is a third more vertical resolution on the
    # thing that fills the most screen.
    tuft = extract_glb_image(os.path.join(EZ, "app/public/grass.glb"),
                             os.path.join(ROOT, "tmp/generated-props/grass_tuft_src.png"))
    build(tuft, os.path.join(layers, "grass_tuft.png"), patch=False)

    print("\n%d shared layers -> %s" % (len(LEAVES) + 1, os.path.relpath(layers, ROOT)))


main()
