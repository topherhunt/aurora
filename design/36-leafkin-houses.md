# 36 -- Leafkin house exteriors

Code: `src/v2/render/house-exterior.js`. Bench: `/gen-leafkin-house` (`src/gen-leafkin-house-main.js`). Gate: `node scripts/check-leafkin-house.mjs`. Status: design bench only. Nothing in the game calls it yet.

Unlike the village houses, which draw on a fixed baked pool, every leafkin house is generated live from its seed on glade entry. All the glade's houses then merge into one mesh, with no LODs.

## Shape

A house is a hollow stump capped with a roof. `rollHouse(seed, height)` returns a flat spec object. It holds every choice the builder makes, and `buildHouse(spec)` reads nothing else. The bench sliders edit that object directly, and "copy spec" exports it.

- **Trunk.** A lathe whose radius is `wallR(θ, y)`. It combines:
  - a taper and a belly;
  - a ground flare, reduced at the door;
  - root lobes;
  - value noise, calmed near every opening.

  `lean` tilts the whole trunk. `girth` 0.31-0.39 and `trunk` 0.44-0.56 are fractions of `height`, matching the village rule that a house is as wide as it is tall.
- **Roof.** Kinds are `cone`, `dome` and `tiers`; skins are `leaf`, `shake` and `thatch`. The roof is built as coursed sawtooth strips with scalloped, jittered lips. The eave height is solved so the roof clears the trunk top where it crosses the wall, and the tip lands within 0.8 m of `height`. The roof ends in a finial stalk.
- **Spires.** These are broken shards of the stump rim, pushed out through the roof. `roofY` takes the highest roof tier above the wall, so a shard always clears it.
- **Openings.** The layout order is:
  1. The door sits at θ = 0 (+X). Its kinds are `arch`, `round` and `pointed`, and it has a rim, steps and a knocker.
  2. The chimney comes next: `stone` (a plumb stack) or `pipe` (a banded clay tube with a hat).
  3. 1-4 windows go on the wall that is still free. Each has an optional mullion, sill, hood or straw rays.
  4. Spires and roots take the rest; the first two roots flank the door.

  Every opening is a flat, tilted frame standing proud of the wall.
- **Decor.** `round(decor × 9)` picks from a pool: fungi, mushrooms, pinecones, a woodpile, a pot, straw, a garland, a vine, a door lantern and stones on the roof.

Each subsystem draws from its own `rngFor(tag)` stream. Changing the window count therefore never reshuffles the roof.

## Contract

`buildHouse` returns the following:

- `geometry`: attributes `position`, `normal`, `color`, `uvProj` and `texLayer` in `createPropMaterial`'s layout, using the prop texture array's layers.
- `glow`: window and lantern glass, with `position`, `normal` and `uv` only. It needs its own material, so it is a second draw call.
- `door {p, n, w, h, sill}` and `windows [{p, n, r}]`, in house space after the warp. These are for the interior and for walker routing.
- `lights [{kind, p}]`.
- `trunk {r, top}`, `eave {r, y}`, `reach` (the footprint radius) and `top`.
- `stats`.

## Budget

Triangles run 4.4k-16.7k per house across village heights 3.75-9.4 m; the gate caps them at 20k.

Build time is about 4.6 ms average in node on an M-series Mac and about 10 ms in the browser bench. A Quest 2 is likely 3-5× slower. Phase 2 should therefore build one house per frame rather than all of them in one frame.

## Phase 2 (after the design is locked)

- Replace `HOUSE_GLB` (`gen-props/house-leafkin.glb`, loaded in `src/v2/render/room-props.js`, §30) with one `buildHouse` per hut seed, then merge the results.
- Walker collision comes from `columnTable(geometry)` in the same file. Check that it copes with the roof overhang and the roots.
- Match the interior's window positions to `windows`, and its door to `door`.
