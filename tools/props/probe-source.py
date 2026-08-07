"""Measure a candidate source file BEFORE adding it to the manifest.

  blender --background --factory-startup --python tools/props/probe-source.py -- \
      --target 500 <file> [<file> ...]

The number this exists for is BOUNDARY EDGE FRACTION, and it is the single
statistic that predicts whether an asset is convertible at all.

The collapse decimator will not collapse an edge that borders a hole. A solid
scan is ~0% boundary and decimates to any ratio you ask for; a photoreal plant
where every leaf is a separate two-triangle card is ~100% boundary and
decimation does *nothing at all* -- not "less than asked", nothing. Last time
that was discovered by building four assets, one of which spent 54 MB of a 61 MB
library reaching 273,971 triangles against a 500 target. This measures it in
about thirty seconds per file instead.

It reports the achieved floor too, by actually running the collapse, because the
fraction predicts the shape of the answer and the floor is the answer.

Deliberately does not write anything. It informs the manifest; it is not part of
the build.
"""

import argparse
import os
import sys

import bmesh
import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402


def boundary_fraction(obj):
    """Fraction of edges with fewer than two faces, and the raw counts."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    total = len(bm.edges)
    boundary = sum(1 for e in bm.edges if len(e.link_faces) < 2)
    bm.free()
    return (boundary / float(total) if total else 0.0), boundary, total


def probe(path, target):
    common.reset_scene()
    name = os.path.basename(path)
    try:
        meshes = common.import_any(path)
    except Exception as exc:  # noqa: BLE001 -- the report IS the output
        print("  %-58s IMPORT FAILED  %s" % (name, exc))
        return

    obj = common.join_all(meshes, "probe")
    src_objs = len(meshes)
    raw = common.tri_count(obj)
    common.clean_mesh(obj)
    welded = common.tri_count(obj)

    frac, bnd, edges = boundary_fraction(obj)
    lo, hi = common.world_bounds([obj])
    dims = [hi[i] - lo[i] for i in range(3)]

    mats = common.material_report([obj])
    images = sorted({im["name"] for m in mats.values() for im in m["images"]})
    uvs = len(obj.data.uv_layers)

    # The floor, measured rather than predicted -- and the trajectory that got
    # there, because "stalled" has two very different causes that look identical
    # from the outside. A mesh that goes 121k -> 30k -> 8k -> 3k -> 1.9k is still
    # descending and merely ran out of the six rounds `decimate_to` allows; a
    # mesh that goes 5.9k -> 1.4k -> 1.4k -> 1.4k has hit a real boundary floor
    # and no number of rounds will move it. The first is a budget I can spend
    # more of, the second is an asset I have to reject.
    floor = welded
    traj = []
    if welded > target:
        import build  # noqa: PLC0415 -- only needed on the heavy path
        work = obj
        for _ in range(10):
            work = build.decimate_to(work, target)
            got = common.tri_count(work)
            traj.append(got)
            if got <= target * 1.05 or (len(traj) > 1 and got >= traj[-2]):
                break
        floor = traj[-1]

    verdict = "OK"
    if frac > 0.5:
        verdict = "CARD FOLIAGE"
    elif floor > target * 1.5:
        verdict = "STALLS"
    if src_objs > 50:
        verdict = "CLUSTER(%d objs)" % src_objs

    print("  %-58s %9d src %9d weld  bnd %5.1f%%  floor %7d  %s" % (
        name, raw, welded, frac * 100.0, floor, verdict))
    print("      dims %.2f x %.2f x %.2f m   uv_layers %d   images %d %s" % (
        dims[0], dims[1], dims[2], uvs, len(images),
        ("[" + ", ".join(images[:3]) + "]") if images else "[none -- no textures hooked up]"))
    if traj:
        print("      decimation trajectory  %s" % " -> ".join(str(t) for t in traj))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", type=int, default=500)
    ap.add_argument("files", nargs="+")
    args = ap.parse_args(common.script_args())

    print("\n=== source probe, %d tri target ===\n" % args.target)
    for f in args.files:
        probe(f, args.target)
    print("")


if __name__ == "__main__":
    main()
