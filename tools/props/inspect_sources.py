"""Inventory every source asset. Read-only -- writes one JSON report, no geometry.

    blender --background --python tools/props/inspect_sources.py -- <out.json> <src> [<src> ...]

This runs before any budget is chosen. DESIGN.md §9 records poly counts for the
Quaternius pack that were read off two files; everything else in that section is
an estimate, and the decimation strategy per asset depends on facts this reports
-- whether the mesh has UVs at all, whether its foliage is alpha cards or solid
geometry, and what units it arrived in.

One asset per Blender session would be cleaner but costs ~1.5 s of startup each.
`reset_scene()` between imports is what makes a shared session safe.
"""

import os
import sys
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import common  # noqa: E402


def main():
    args = common.script_args()
    if len(args) < 2:
        raise SystemExit("usage: -- <out.json> <src> [<src> ...]")
    out_path, sources = args[0], args[1:]

    report = {}
    for src in sources:
        key = os.path.relpath(src)
        try:
            common.reset_scene()
            objs = common.import_any(src)
            report[key] = common.inspect(objs)
            info = report[key]
            print("OK   %-70s %7d tris  %s" % (
                os.path.basename(src), info["tris"],
                "x".join("%.2f" % d for d in info["dims_m"])))
        except Exception as e:  # noqa: BLE001 -- an unreadable source is data
            report[key] = {"error": "%s: %s" % (type(e).__name__, e)}
            print("FAIL %-70s %s" % (os.path.basename(src), e))
            traceback.print_exc()

    common.write_json(out_path, report)


main()
