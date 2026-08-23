"""Render every tier of a generated species from the same camera, side by side.

    blender --background --factory-startup --python tools/trees/compare-tiers.py -- gen_pine gen_oak

Writes <id>_LOD<n>.png into tmp/generated-props/compare/.

WHY THIS EXISTS. Triangle counts and leaf-area totals both looked correct for
the entire time the canopy was wrong: an early LOD1 hit its budget exactly, at
100% of LOD0's total leaf area, and still rendered as two dense whorls with a
bare leader spiking out of the top. Nothing in the generator's own numbers could
have caught that. Looking at the tiers next to each other is the check, so it
lives in the repo rather than being rebuilt from memory each time.

Each tier goes through the same finishing the real build applies (ground, scale,
adopt COLOR_0, one material against the shared atlas) so what comes out is what
ships, not an approximation of it.
"""

import json
import os
import sys

HERE = os.path.dirname(os.path.realpath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "tools/props"))

import bpy        # noqa: E402
import common     # noqa: E402
import build      # noqa: E402  -- guarded by __name__ == "__main__", so importing runs nothing

SIZE = 256        # 2x the shipped impostor: this is for looking at, not for shipping

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
out_dir = os.path.join(ROOT, "tmp/generated-props/compare")
os.makedirs(out_dir, exist_ok=True)

with open(os.path.join(ROOT, "tmp/generated-props/generated.json")) as f:
    specs = {a["id"]: a for a in json.load(f)}

if not argv:
    raise SystemExit("name at least one asset id, e.g. %s" % " ".join(sorted(specs)[:2]))

for aid in argv:
    if aid not in specs:
        raise SystemExit("unknown asset %r -- run `npm run props:generate` first" % aid)
    spec = specs[aid]
    for i, tier in enumerate(spec["tiers"]):
        common.reset_scene()
        # After reset_scene, so the atlas is reloaded rather than left dangling:
        # resetting frees every image datablock and a stale reference raises.
        image = bpy.data.images.load(os.path.join(ROOT, spec["shared_layer_src"]))
        obj = common.join_all(common.import_any(os.path.join(ROOT, tier)),
                              "%s_LOD%d" % (aid, i))
        common.apply_transforms(obj)   # the importer carries Y-up in as a rotation
        build.adopt_generated_colors(obj)
        common.ground_and_center(obj)
        common.scale_to_height(obj, spec["height_m"])
        build.finalize_material(obj, aid, True, image=image)

        png = os.path.join(out_dir, "%s_LOD%d.png" % (aid, i))
        build.render_billboard(obj, png, size=SIZE)
        print("wrote %s  (%d tris)" % (os.path.relpath(png, ROOT), common.tri_count(obj)))
