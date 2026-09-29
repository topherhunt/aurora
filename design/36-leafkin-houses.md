# 36 -- Leafkin house exteriors

Code: `src/v2/render/house-exterior.js`. Bench: `/gen-leafkin-house` (`src/gen-leafkin-house-main.js`). Gate: `node scripts/check-leafkin-house.mjs`. Status: shipped. Every house in a leafkin glade is one of these (see In the glade).

Unlike the village houses, which draw on a fixed baked pool, every leafkin house is generated live from its seed on glade entry. All the glade's houses then merge into one mesh, with no LODs.

## Shape

A house is a hollow stump capped with one lumpy roof mound. `rollHouse(seed, height)` returns a flat spec object. It holds every choice the builder makes, and `buildHouse(spec)` reads nothing else. The bench sliders edit that object directly, and "copy spec" exports it.

- **Trunk.** A grid whose radius is `wallR(θ, y)`. It combines:
  - a taper and a belly;
  - a small uniform ground flare;
  - 5-9 buttress lobes that carry the real splay: gaussian in angle at a near-even reach, twisting and dying away up the trunk, and still widening below ground so the feet read as roots. The first two flank the door, and the trunk between lobes stays in;
  - value noise, calmed near every opening.

  The door and the windows calm the flare and the lobes, or their frames would tip skyward. A window calms them only from just below its frame, so the root beneath it still splays. The trunk's top row rises to 3 cm under the roof's own triangles, found by a vertical lookup against them. `lean` tilts the whole trunk. `girth` 0.29-0.36 and `trunk` 0.44-0.56 are fractions of `height`, matching the village rule that a house is as wide as it is tall.
- **Roof.** One mound, `roofAt(θ, u)` from the eave (u 0) to the apex (u 1). `rise` 0.5-1 sets the apex that fraction of the way from the trunk top to the full height. `swell` sets the profile from cone (~1) to dome (>2). `lump` adds noise to its radius and height, `tilt` makes the eave line lopsided, and `bend` bends the tip over. The eave never rises above the trunk top; where the mound then could not clear the wall, the eave reaches wider instead. The mesh is 14 columns × 6 rows whose bottom row fans out to a 56-point lip, every point dropped and nudged sideways by its own jittered amount for the frayed edge: 224 triangles, and the gate caps it at 250. Its texture is wrapped radially about the apex (v the true slope distance down from it, u the bearing in a whole number of repeats, true to scale 60% of the way down), so every course laps downhill at every bearing; the cost is courses that narrow toward the apex and widen at the eave. Skins are `leaf` (half the rolls, tinted darker than the photo), `shake` and `thatch`.
- **Crown.** 0-3 pieces of the stump's shell carried up through the roof. Each is a rounded, noisy section whose top row splinters into dips and spikes. `crown: 'tower'` makes the first one a wide hollow tower, with an inner wall, a dark floor and a round window facing out, its five columns smoothed and unsplintered and its frame set proud of every vertex behind it so no wall cuts the glass.
- **Openings.** The layout order is:
  1. The door sits at θ = 0 (+X). Its kinds are `arch`, `round` and `pointed`, and it has steps and a knocker.
  2. `transom: 'round'` puts a small round window above the door's awning, if it fits below the eave.
  3. The chimney comes next: `stone` (one hollow, crooked octagonal stack sunk a third of its width into the trunk, its courses jittered rings, rolling over a lip into a dark flue) or `pipe` (a clay tube with a hat, banded by rings squared to it).
  4. 1-4 windows go on the wall that is still free, their frames at least 1 m apart edge to edge (the transom counts). They are round (no sill) or arched (optional mullion and sill). No window carries an awning. Any of them may hang a flowerpot beside it.
  5. The crown takes the rest.

  Every opening is a flat, tilted frame standing proud of the wall. Its outline is skewed a few degrees, and its jamb (`rim`) has a jittered width, flares where it meets the wall, and has every vertex jittered. The door's awning always hangs crooked: `leaf` is a rolled, jittered sheet in `ROOF_LEAF` at the roof's scale, and `hood` is a flared, jittered board on brackets. Support sticks and brackets end just under the sheet's or board's actual jittered surface, never through it. The glass uses the interior's honeycomb `interiors/window.webp`.
- **Decor.** `round(decor × 14)` picks from a pool:
  - shelf fungi (weighted ×3): flat, in the mottled `ROCK_BUMP` grit with one palette tint per cluster;
  - mushrooms at the lobes;
  - pinecones;
  - a woodpile: a pyramid of 3-4 logs laid along the wall in a nook between two roots (never the pair flanking the door), each row in the grooves below, or a bundle of logs and sticks leaning on the wall;
  - a pot;
  - straw;
  - a garland;
  - knotted climbing vines with branches (weighted ×4);
  - vines (weighted ×4) and ropes hanging from the eave;
  - a door lantern.

  Vines carry `IVY_LEAF` quads.

Each subsystem draws from its own `rngFor(tag)` stream. Changing the window count therefore never reshuffles the roof.

**Texture layers.** `ROOF_LEAF` and `IVY_LEAF` in `src/textures.js` come from `tools/buildings/leafkin-textures.mjs`:

- `ROOF_LEAF` is a FLUX Klein photo, centre-cropped, made seamless with `tools/tileable.sh`, then shipped at 128 px.
- `IVY_LEAF` is a five-lobed leaf drawn in code on alpha. It is 128 px because the texture array needs that size.

Everything else reuses existing layers: bark, timber, door, stone, iron, shingle, thatch, plaster, dirt, `ROCK_BUMP` for the fungi and the ironwork (the `IRON` decal sheet's alpha islands would break a band into dots), and the interior's `window.webp` for the glass.

## Contract

`buildHouse` returns the following:

- `geometry`: attributes `position`, `normal`, `color`, `uvProj` and `texLayer` in `createPropMaterial`'s layout, using the prop texture array's layers.
- `glow`: window and lantern glass, with `position`, `normal` and `uv` only. It needs its own material, so it is a second draw call.
- `door {p, n, w, h, sill, steps, landing}` (`steps` how far the lowest step reaches out from the door's face, `landing` the top step's height) and `windows [{p, n, r}]`, in house space after the warp. `windows` includes the transom but not a tower's window. These are for the interior and for walker routing.
- `lights [{kind, p}]`.
- `trunk {r, top}`, `eave {r, y}` (mean radius, highest point), `reach` (the footprint radius) and `top`.
- `stats`, including `roofTriangles`.

## Budget

Triangles run 3.0k-7.0k per house across village heights 3.75-9.4 m. The gate caps them at 8k.

Median build time is about 2.2 ms in node on an M-series Mac. A Quest 2 is likely 3-5× slower. That is cheap enough to build a whole glade on entry, though one house per frame stays the safe default.

## In the glade

`RoomProps` (`src/v2/render/room-props.js`, §30) builds house k from `rollHouse` on the k-th draw off the glade's seed, at the prop's height, then merges every house into one solid mesh and one glass mesh (`glowMaterial`, dim by day and lit at night). The interior is sited from `door` and `windows`.

- **Bounds.** `HOUSE_BOUNDS` is 0.6 of the height in radius. Over 300 houses, what stands above ground reaches p50 0.56, p90 0.65 and at most 0.83 of the height, which the siting's r√2 box covers. Buried root tips run to 1.05 and do not count. The eave is at most 0.56 and the trunk 0.30-0.36.
- **Collision** is `columnTable(geometry, height, wall)` at `CELL` 1/40 of the height. Crossings pair into spans, and a top with no underside open is a one-cell cloth (the roof, the awning). `SOFT` layers (ivy leaves, fungi and ironwork grit) are not stone. A column crossing more than `CROSS_CAP` is stone from its lowest crossing to its highest.
- **Posts.** A vertical wall crosses no column, so steep faces, lowest first, climb each cell within half a cell of their plan from near the ground. A climb of 8 cells is stone from the floor. No post stands on the stoop, the steps' plan in front of the door, or the door's leaf would stand one on the top step.
- **The wall outline.** The trunk's vertical wall and shallow flare make no posts, so `wallOutline` takes the least solid radius per bearing (32 bins) at 0.8-1.9 m over the ground. It bridges the doorway between the jambs, and every cell inside it is stone to `trunk.top`.
- **Roof ferns** (`roofSpots`) seat on the topmost span over half the house's height, inside the eave, where the slope is under 60° and seats stand 0.25 of the radius apart. Crown trees stand at the house's own point, as before.
