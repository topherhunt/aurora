# archive/

Code that is deliberately kept but deliberately not loaded. Nothing in here is imported by any page, and nothing in here should be edited by a repo-wide sweep -- if a mechanical change would touch a file here, the right move is to skip it, because the point of the folder is that these files are frozen at the state they were last known to work in.

Each subfolder answers three questions: what it is, why it is parked, and what would bring it back. If you cannot answer the third one, the code should be deleted instead -- git remembers it either way.

## aurora-mesh/

`aurora.js` (862 lines) and its catalogue `aurora-patterns.js` (579 lines): the band-mesh aurora, a few hundred quads swept along splines, one per named form in a table of sixteen. See `design/13-aurora-and-sky.md` §13 for the algorithm and `design/history/aurora-rounds-4-6.md` for how the catalogue reached its current shape.

**Why it is parked.** `src/v2/render/aurora.js` replaced it with the shader lab's `skymap` curtain, which draws a field rather than a band and so gets forking, braiding and ray structure for free -- things a strip with two edges cannot do at any triangle count. The world draws the field now; nothing draws the mesh.

**What would bring it back: the Quest measurement.** The field's cost argument is that its forty taps are paid on a 512x64 buffer once per frame instead of per fragment, which on desktop makes a full sky dome nearly free. That has not been measured on Quest 2 hardware. If the four offscreen passes turn out to cost more than the headset can spare -- fill rate at 72 Hz on a mobile tiler is the risk, not the tap count -- the band mesh is the fallback, because its cost is a few hundred additive quads and nothing else.

**Resurrecting it** is a two-line change in `src/v2/main.js`: the mesh mirrors `SkyAurora`'s public surface exactly (`mesh`, `update(head, state, elapsedReal)`, `cyclePattern`, `setPattern`, `label`, `blurb`, `dispose`), and it shares `VISIBLE_AT = 0.004` so the hour the aurora appears does not shift. Move the two files back to `src/` and undo the `../../src/` import prefixes at the top of each.

**It carries its own gate.** `archive/aurora-mesh/check-aurora-mesh.mjs` asserts its geometry, its noise budget, its meander and its shader hygiene, so it stays known-good rather than rotting into something that would need a week of re-tuning on the day it is wanted. Run it by hand -- `node archive/aurora-mesh/check-aurora-mesh.mjs` -- because it is deliberately **not** in `npm run check`: live code must not depend on this folder, and that includes the suite that gates live code. It shares the redeclaration scanner at `scripts/lib/glsl-scope.mjs` with `scripts/check-daynight.mjs`, which is the one dependency direction allowed here (archive may import from the tree, never the reverse). If the Quest measurement comes back favourable and the mesh is never wanted again, delete the folder and its gate together.
