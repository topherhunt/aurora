# Blob shadows: a proposal

**The world currently has no shadows of any kind.** `grep -rn "shadowMap\|castShadow\|receiveShadow" src/` returns zero hits, so this is not a cheap approximation standing next to a real one. It would be the whole of the ground-contact and occlusion story, which is why it is worth designing rather than bolting on.

## The shape of it

A blob shadow is **a lighting term, not a texture**. Each caster publishes a circle on the ground -- world `(x, y, z, radius)` -- and every fragment in the world, ground or prop, asks "which circles cover me?" and multiplies the answer into its direct light. Nothing is drawn. No geometry is added, no transparency is sorted, and nothing has to lie flat on a hill.

That framing is what makes it work on **adjacent objects and not just the ground**, which is the thing a decal quad can never do: the fern under the canopy, the boulder at the trunk, the cabin wall in the treeline all darken from the same term, because they all read the same table.

## Why not a decal quad

Three reasons, in descending order of how fatal they are.

`createPropMaterial` is **binary cutout only** -- `alphaTest: 0.5, transparent: false` at `src/material.js:2181`, with the comment above it at 2179 stating that alpha blending "cannot be sorted within a batched draw call, so it is architecturally unavailable to us (DESIGN.md §7)". A blurred oval *is* alpha blending. A cutout can only give a hard stippled edge, which is worse than no shadow. So a shadow quad cannot ride the existing `BatchedMesh` path at all; it needs a whole new sorted transparent pass.

**The curvature error scales with the card.** A 1.6 m litter stamp on ground whose slope differs by 5° from its centre already carries its corner 14 cm off the plane. A 5 m blob under an oak, on that same 5°, is off by half a metre. The problem that pushed the pebbles toward spraying is strictly worse here.

**A ground quad shadows the ground**, and nothing else.

## The lookup, which is the only real engineering

Litter can be sprayed because it is a hash of position: an infinite field, no list, no lookup. Shadows are the opposite -- a sparse list of specific casters -- so the fragment has to answer a spatial query. Iterating every caster per fragment is the failure mode that makes people abandon this. The fix is a **2D uniform grid**, which is clustered forward lighting collapsed to two dimensions.

Sized against measured density. `check-trees.mjs` reports 10 trees within 8 m, 35 within 15 m and 1,571 within 100 m, all three of which come out at **0.0497 trees per m²**, one per 20 m², and flat across the whole band.

| knob | value | why |
|---|---|---|
| field | 160 m square, camera-following | past ~80 m a 4 m blob is a smudge; fade it out there |
| cell | 4 m | see the occupancy arithmetic below |
| cap | 12 entries per cell | bounds the loop; overflow drops the *smallest* blob |
| entry | one RGBA32F texel, `(x, y, z, radius)` | 1600 cells x 12 x 16 B = **307 KB** |

Casters are binned **conservatively**: a blob is written into every cell its radius touches, so a fragment reads its own cell only and never a 3x3 neighbourhood. Expected occupancy in closed forest is `ρ(c + 2r)² = 0.05 x (4 + 8)² = 7.2` entries, against `ρπr² = 2.5` blobs that genuinely overlap any given point -- the gap is the price of conservative binning, and it is what sets the cap at 12 rather than 8. Open ground is an empty cell and one wasted fetch.

Rebuild cost: 160² x 0.05 = ~1,280 trees in the field, each touching `((2r + c)/c)² = 9` cells, so ~11.5k appends. That is sub-millisecond, and it does not run per frame -- it runs when the camera crosses a cell, which at walking pace is about **1 Hz**. The caster list is already maintained: `src/props/scatter.js` keeps dense `instX` / `instZ` `Float32Array`s per kind over `[0, count)`. The one datum missing is `instY`, which is either a field sample at placement or a read-back from the batch matrix.

## Fragment cost, against what is already paid

Up to 12 `texelFetch` on a 307 KB unfiltered table, plus roughly 12 x (subtract, dot, smoothstep). Against that, `auroraStone()` already does **six triplanar `textureGrad` fetches** on the layer array -- three for the coarse octave out to 650 m and three for the fine octave out to 130 m. An unfiltered `texelFetch` on a table that stays hot in cache is far cheaper than a filtered array fetch with explicit derivatives, so the blob loop should land **under** the stone layer that the terrain already affords, while being gated to a fraction of its range.

It is also **coherent**, which matters more than the instruction count: neighbouring fragments read the same cell, so the fetches hit cache and the trip count is quad-uniform nearly everywhere. This is not a divergent loop.

## Where it goes

Injected after `#include <lights_fragment_end>` (`meshlambert.glsl.js:109`), which **neither material patches today** -- both currently touch only `diffuseColor`. Two terms rather than one:

```glsl
reflectedLight.directDiffuse   *= blob;                      // the shadow
reflectedLight.indirectDiffuse *= mix( 1.0, blob, AO_SHARE ); // the contact
```

Splitting them is what makes it behave at night. Multiplying `diffuseColor` instead would darken sun and sky equally and leave a black disc on the ground at midnight. With the split, the direct term vanishes when the sun does, while a light `AO_SHARE` keeps the ground reading as *touched* under overcast and after dark.

Both injection sites already carry what they need. `terrain-material.js:299` declares `varying vec3 vWorldPos`. `createPropMaterial` already computes `vec3 propWorld = (modelMatrix * snowWorld).xyz` at `material.js:2302` for its snow line, though it sits inside a guard and would need promoting to a varying. Those two patches cover terrain, trees, ferns, grass, mushrooms and buildings. **One gap:** `src/v2/render/road-surfaces.js:43` builds its own plain `MeshLambertMaterial` and would visibly not receive until patched. Water carries its own shader in `src/water.js` and is out of scope for v1.

## Two things that come free, and one that does not

**Strength from size**, without a per-entry field: `strength = clamp(r / R_REF, 0.3, 1.0)`. A bigger occluder blocks more sky, which is both principled and true, so a cabin reads darker than a sapling with no extra bytes.

**A low sun stretches the blob**, by offsetting the centre along `uSunDir` projected onto the ground (the uniform already exists and is live -- `src/sky-glsl.js:51`, updated at `:84`). Done CPU-side at bin time it costs nothing, since the grid rebuilds anyway. A true *ellipse* at sunset needs a second texel for the major axis and azimuth; that is a v2, not a v1.

**Vertical falloff is the part that needs care.** A circle is 2D, so a fragment 20 m down a cliff from a tree would otherwise be shadowed by it. Fade on `fragY - casterY`, and asymmetrically: fast above the caster's base (~2 m, so a tree's own canopy is not darkened by its own blob) and slow below (~15 m, so the shadow still runs down a slope, which is correct). Getting this wrong is what makes blob shadows look like stickers.

## Rejected alternatives

**Real shadow maps.** A 2048² cascade over 160 m gives 8 cm texels, which is genuinely good, but it costs a second depth pass over all 40,972 forest instances and 12,666 rocks, and -- the actual trap -- every `onBeforeCompile` billboard and wind displacement in `createPropMaterial` would need a matching `customDepthMaterial` replicating that vertex logic. Without it, billboards cast shadows from their un-spun geometry. That is a much larger project for crisper shadows than the art direction wants.

**Screen-space deferred decals.** Need a depth prepass and a G-buffer. This is a forward `MeshLambertMaterial` renderer; there is no buffer to project into.

**Mesh-clipped decals.** Re-meshing a caster's footprint against a quadtree that re-splits underneath it, per caster, per split. Fragile and expensive.

## How it gets gated

Everything above the shader is CPU-side and testable headless, in the house style -- assert decisions, not pixels. A `check-blob-shadows.mjs` can hold: that binning is genuinely conservative (query every point a blob covers and confirm the blob is found in that point's cell); that cap overflow drops the smallest and never the largest; that cell occupancy over a real forest traverse stays under the cap for some high fraction of cells, with the overflow rate printed rather than hidden; and that the rebuild fires on cell crossing rather than per frame. The shader half is gated the way the others are, by compiling it in `check-shaders`.

## Scope

Roughly: the grid builder and its harvester from `scatter.js`, one GLSL helper shared by two `onBeforeCompile` sites, the patch to `road-surfaces.js`, and the gate. The largest unknown is not the code but the tuning -- `AO_SHARE`, the two vertical falloff distances, and `R_REF` are the three numbers that decide whether this reads as contact or as stickers, and none of them can be settled without looking at it.
