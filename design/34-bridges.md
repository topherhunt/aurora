# 34 -- Stone bridges

Code: `src/bridges/bridge.js` (generator), `src/bridges/stone-bridge.js` (the shipped mesh). Bench: `/gen-bridge` (`src/gen-bridge-main.js`). Placed at road crossings by §35 (`design/35-roads.md`). The generator runs only at bake time; the game ships one baked mesh and instances it at every crossing.

## The shipped mesh

`npm run bridge:bake` writes `public/gen-props/bridge-stone.glb` from `BRIDGE_DEFAULTS` (seed 1, random decor). Its standard size, unscaled, with the origin at the river's centre line on the water surface:

| Dimension | Value |
|---|---|
| River span it crosses (bank to bank, along x) | 14 m, banks at x = ±7 |
| Overall length (`xa`..`xb`) | 17 m, x = -8.5..8.5, so each end runs 1.5 m past its bank onto the road |
| Road height at each end (`bankA`, `bankB`) | 3 m above the water, level where it meets the road |
| Deck crest (road surface at x = 0, centre line) | 4.22 m above the water, a 1.22 m hill over the banks |
| Walkable road width (between parapets, `2 × inner`) | 3.2 m |
| Deck width (parapet outer faces, `2 × halfWidth`) | 4.1 m |
| Footprint width (cutwaters included, bounding box z) | 6.4 m |
| Parapet height above the deck | 0.8 m |
| Arches | 3: middle 4.2 m wide with a 3.31 m crown, sides about 2.9 m wide with 2.5--2.6 m crowns |
| Below the water (`depth`) | 2 m of foundation, bounding box y from -2.0 |
| Highest point (post tops) | 5.9 m |
| Posts | 8 sockets, 6 flame lights |

It holds nodes `lod0`..`lod2`, with `uvProj` and `texLayer` as the custom attributes `_UVPROJ` and `_TEXLAYER`. The scene's extras hold the meta: extent (`xa`, `xb`, `halfWidth`), `bankA`/`bankB`, `clearance`, the arches, a 65-sample `deck` profile, `camber`/`inner`, `sockets`, `lights` and per-LOD `triangles`. `loadStoneBridge()` returns `{ lods, meta }` with the attributes renamed for `createPropMaterial`. `check-bridge` fails when the shipped file is not a fresh bake, so re-bake after any change to `bridge.js`.

**Placing it** at a crossing:
- Put the origin on the river's centre line at water level.
- Turn local +x along the road.
- Set scale.x = river width / 14, which scales the 1.5 m overhang with it.
- Set scale.y = road height above the water / 3.
- Set scale.z = road width / 3.2.

To walk it, divide a local point by the scale, call `stoneBridgeDeckAt(meta, x, z)`, and multiply the height by the y scale. Sockets and lights scale the same way. Non-uniform scale also stretches the stones and their texture, so keep y and z within about ±30% (the roads let x stretch to 1.8, design/35 Bridges) and sink the ends into the banks to meet unequal road heights.

## Frame and inputs

y = 0 is the water, the road runs along x, the river along z, centred on x = 0. `span` is the water's width. `bankA` and `bankB` are the road heights on the -x and +x banks, measured from the water. `abut` is how far the deck reaches past each bank, at most `MAX_ABUT` (2 m). `clearance` is the least height of the middle arch's crown above the water: jitter only raises it. `depth` is how far the foundations reach below the water, so the bridge can be sunk into a bank or bed without showing its underside.

## Plan (`planBridge`)

- **Arches:** n = ceil((span + pier) / (maxArch + pier)), rounded up to an odd number so an arch, not a pier, stands under the crest. The middle arch is widest. It is a semicircle on legs when its crown clears it, and a flattened ellipse when it does not.
- **Deck:** one hill over the whole length, base(x) + rise · sin(πu)^1.4. The base smoothsteps from bankA to bankB, so the deck is level where it meets each road. The rise is the least that carries the middle arch at its full height with its ring and `cover` under the deck. Every other arch sinks until its ring clears the deck too.
- **Grade:** there is no grade limit, because the 2 m reach fixes the length. The grade is what the clearance asks of it: about 20% for the 14 m default, over 50% for low banks. The bench reports it. `deckY(x)` and `deckAt(x, z)`, which includes the camber, are the walk surface.
- **Posts:** end posts at both ends of both parapets, and optional posts over the piers.

## Build (`buildBridge(plan, { lod })`)

One geometry per LOD in the shared prop material's layout, all `LAYER.STONE`, one draw call each.

| LOD | What | 14 m default |
|---|---|---|
| 0 | Body, parapets, string course, arch rings with keystones, cutwaters, posts and their tops | ~1.8k tris |
| 1 | The body alone, its side faces carried up to the parapets' top | ~110 tris |
| 2 | One rectangle over the footprint at the deck's mean height | 2 tris |

Counts grow with span: a 48 m, five-arch bridge is about 3.7k / 210 / 2.

**The haphazard look** follows the leafkin interior kit (`interior.js`):
- One smooth 3D noise warp moves every vertex, so surfaces that share an edge move together and never crack.
- Blocks have chamfered, bevelled corners and are pushed crooked. Normals smooth across the bevels, so low-poly stone still shades round.
- The parapets wobble and lean.
- A zero-area triangle is dropped, so builders collapse rows, such as the waterline split, for free.

**Texture and colour:** UVs are box-projected per triangle, and a vertex is split where the projection axis changes. Vertex colour carries ±9% of stone variance, plus a damp green-dark tint below about 1.1 m.

**Post tops** are random from `DECOR_KINDS`, weighted: lantern 3, cairn 3, cap 2, brazier 1, runestone 1, bare 1. A post facing another across the road copies its kind 70% of the time. Each top costs 20--60 triangles.

The build returns `sockets` (each post top, with its side, kind and decor) and `lights` (each lantern and brazier flame). Both are the same at every LOD.
