# 24 -- Mushrooms

Generator: `src/props/mushroom.js`, sheets in `src/props/mushroom-texture.js`, bench `gen-mushroom.html`. Scatter: `src/v2/render/mushrooms.js`. Gate: `scripts/check-mushrooms.mjs`.

## The generator

A mushroom is neither of the two prop shapes this project already knows how to build, and saying why is most of the design.

**It is not a fern.** A fern is a rosette of FLAT CARDS whose entire silhouette lives in an alpha channel, which works because a frond is genuinely flat: photograph it once and you have it from every angle that matters. A mushroom cap is a SOLID OF REVOLUTION seen from above at ankle height and from below when it is three metres tall in a cave. Its silhouette is a curve -- the difference between a cone, a dome, a parasol and a funnel is the entire identity of the thing -- and an alpha cutout of a dome is a semicircle, which is to say nothing at all.

**It is not a rock.** A rock's shape is noise and its texture is one tile repeated; a mushroom's shape is a PROFILE CURVE that has to be right to the millimetre at the rim, and its texture is radial -- gills, streaks, concentric scales -- all running from the axis outward. Feed a mushroom the rock's per-face planar projection and the gills run diagonally across the underside.

So this file builds surfaces of revolution with polar UVs, and everything follows from those two words.

### 1. The whole cap family is two numbers

Mycology names about eight cap shapes -- conical, campanulate, convex, plane, umbonate, depressed, infundibuliform, offset. They are not eight shapes. They are one profile with two knobs:

```
y(t) = capRise * (1 - t^capCurve) + margin * t^3
```

`t` is normalised radius from axis (0) to rim (1). **`capRise`** is how far the apex stands above the rim -- POSITIVE for every cap that sheds water, NEGATIVE for a funnel, and the sign change is the only difference between a bolete and a chanterelle. **`capCurve`** is where the drop happens: 1 is a straight cone, 2 a paraboloid dome, 6 a flat parasol with a cliff at the rim. **`margin`** then lifts or drops the outer eighth on its own -- the inrolled rim of a young button (negative), the flaring rim of an old one (positive).

Two knobs, eight named shapes, and every shape BETWEEN them, which is where the real ones live.

### 2. Normals are computed from the surface, not from the triangles

`computeVertexNormals` is wrong here for a specific reason that would have been found late and blamed on lighting. A polar UV needs a duplicated column of vertices at `theta = 0 = TAU`, because one vertex cannot hold both `u = 0` and `u = 1`. Those duplicates are coincident in space but separate in the index, so triangle-averaged normals give each of them HALF the neighbourhood -- and the cap gets a visible bright seam running apex to rim, on every mushroom, at every angle. Sampling the parametric surface instead makes theta a continuous variable that simply wraps, so the seam cannot exist.

It also gets the rim crease right for free: cap top and cap underside are separate surfaces that happen to share an edge, so they get their own normals and the rim reads as an edge rather than a soft fold.

### 3. Colour lives in the texture, not in the tint

The shared prop material tints PER INSTANCE (the arena's `setColorAt`, see `props/rock.js`), a scalar multiply over the whole instance. A rock is one material throughout, so a multiply is exactly right for it. A mushroom is two: what makes a fly agaric read as a fly agaric is a SCARLET CAP ON A WHITE STEM, and no per-instance multiply can produce two hues.

So the cap sheet and the flesh sheet carry colour, addressed per vertex by which cell of the sheet a surface samples -- `capCell` for the top, `fleshCell` for underside, stem and ring. Cap and stem are coloured INDEPENDENTLY at zero cost: no extra attribute, no extra material, no extra draw call. The per-instance tint is left to do what a tint is good at, a gentle value and warmth jitter so no two mushrooms in a clump are the same mushroom twice.

The cost is named rather than hidden: sheet cells bleed into each other in the low mips, so a mushroom far enough away to sample a 4 px mip converges on the average of its sheet. That is a card's job long before it happens -- the grass class takes its card at 20 m -- but it is why the sheets are 2x2 rather than 4x4.

### The cap top is a planar decal, not a polar chart

`capUV` projects along the cap's own axis. The reason is triangulation rather than art. A polar mapping hands each of the `radial` apex triangles a WEDGE of the chart and lets the GPU interpolate the angle linearly across it, which the true angle does not do: on the fly agaric's 9-gon that slices any wart wider than 40 degrees of arc (an inner-ring wart is 1.02 wedges wide, so all of them) and runs the radius 6% long inside every wedge. Both artefacts grow toward the middle, where the wedges converge and a cap is most visible.

A planar projection has neither, and not by being finer -- by being AFFINE. `u` and `v` come out linear in the cap's local x and z; a triangle's x and z are already linear in its barycentrics; so the hardware's linear interpolation is EXACT and the texture stops caring how many triangles the cap has. It also collapses the apex fan to a single point in UV instead of `cols + 1` different ones, which is the same statement read the other way round. Inset on all four sides like any other cell -- the disc has no wrap to protect, and the rim touches the cell edge at four points without it.

This is also why `radial` went from 9 to 16 on the near tier: under the old polar chart a coarse cap SLICED its own texture, so column count was a texture setting as well as a silhouette one.

### The cap must not be impaled on its own stalk

A dome sits above the stem tip and needs nothing done to it. A FUNNEL does: with `capRise` negative the profile's low point is the axis, which is exactly where the stalk is, so a chanterelle built naively has its stem standing up through the middle of its own cap.

The fix is to raise the cap until its surface meets the stalk AT THE STALK'S RADIUS rather than at the axis. The cap then closes onto the top rim of the tube with no slit, and the bowl carries on falling away INSIDE the tube where the tube's own walls hide it -- which is what the real thing does, since a chanterelle's funnel is continuous with its stalk rather than resting on one.

**"The stalk's radius" is its INSCRIBED radius, not `stalkR`.** A stem drawn with `stemRadial` columns is a prism, and the middle of a prism's flat face is only `stalkR * cos(pi / stemCols)` from the axis -- at the default 3 columns, HALF the circumradius. Align to the circumradius instead and the three flat faces each poke a corner up through the cap, which is the exact bug this block exists to remove. Aligning to the inscribed radius leaves the opposite error, a sub-millimetre slit at the three vertices, and a slit you cannot see beats a spike you can. Sampled around theta rather than solved, because `wavy` and `umbo` both perturb the height and neither inverts. Clamped at zero, so nothing whose cap already sheds water moves at all.

### Triangle count and the tiers

LOD knobs are re-generations rather than decimations -- the same argument §5 makes for the bush class. Triangles are exactly:

```
cluster x ( radial     x (2*capRings - 1)      <- cap top
          + radial     x 2 x underRings        <- underside, if any
          + stemRadial x 2 x stemRings         <- stem, if any
          + stemRadial x 2                     <- ring, if any
          + gillBlades x 2 )
```

The cap top is the odd one out because its innermost ring collapses to a point, so half of that row's quads are degenerate and never emitted. The underside does the same, but only on a STEMLESS mushroom: given a stalk its inner edge is trimmed to the stalk's radius and never reaches the axis, so subtract another `radial` from the underside row when `stemHeight` is 0.

**`underside` is off by default, and that is a DEFAULT rather than a tier setting.** A forest-floor mushroom is a thing you look down on, so its gills are a third of its triangles spent on the one face nobody sees. Turn it on for anything you can walk under. What "off" leaves behind is a cap that is a single sheet, and since the prop material is `DoubleSide` and re-flips the normal (`src/material.js`), that sheet's far side is lit by the cap's own UPWARD normal -- so from below the cap reads as lit rather than shadowed. That is the trade, and it is fine right up until you are standing under it.

### 4. A clump is one geometry

Mushrooms come in troops. One mushroom alone reads as a placed object; six of staggered ages around one patch of mycelium reads as something that grew. So `cluster` builds them into ONE geometry, which is also cheaper: §5's binding cost for small props is 37 ns per visible INSTANCE regardless of triangles, so six caps in one instance is a sixth of the per-frame CPU of six instances. Same argument as `shards` in `props/rock.js`.

**Attributes** are always `{ position, normal, uvProj, texLayer }`, indexed -- the shared prop material's layout (`src/material.js`). An `InstancedMesh` does not validate that the way `BatchedMesh` did, so a geometry short an attribute now draws wrong rather than throwing. Unlike `buildFern` there is no second `uv` layout, because the bench renders the real material: a mushroom without its two sheets is a grey lamp.

## The scatter

Fourth sibling of `render/trees.js`, `render/ferns.js` and `render/rocks.js`, reusing their machine wholesale: one `PropArena` -- a group of fifteen `InstancedMesh`es, one per (tier, species) -- one material, a variant bank, a tier ladder, a tiled camera-following scatter, graded thinning by per-candidate rank, rank-based incremental regrow, and the rim dissolve. `trees.js`'s header argues all of that.

Two things are genuinely different, and both come from the same fact: **a mushroom is not scattered over ground, it is scattered over OTHER PROPS.**

### 1. The candidates are anchors, not points

Every other scatter in /v2 rolls a fixed number of uniform random points per tile and asks the terrain whether each is allowed. This one asks the tree and rock scatters where their instances are (`anchorsInto`) and treats each returned prop as ONE candidate site. Mushrooms come up at the foot of things -- against a trunk, in the lee of a boulder -- and the cheap imitations of that (a noise field tuned to look foresty, a density multiplier keyed on altitude) all fail the same way: they put mushrooms in the open two metres from the nearest tree, which is exactly the tell.

The cost of doing it honestly is an ORDERING DEPENDENCY on trees and rocks, and it is a real one rather than a stylistic preference.

**The ordering contract.** `_growTile` reads the tree and rock scatters' PLACED instances, so it can only see anchors that already exist:

- at boot and on a relief edit, `place` must run after `trees.place` and `rocks.place`, or the whole layer comes up empty and stays empty until the player walks far enough to evict and regrow;
- every frame, `update` must run after theirs, so a tile that has just come into range finds the props that came into range with it.

What makes the frame case safe rather than merely ordered is the **radius gap**: this layer draws to 55 m and the forest keeps every stem at full density out to 80 m, so by the time a mushroom tile is queued, the trees inside it have been standing a long while and are not thinned. Shrinking the forest's `FULL_RADIUS` below this layer's `DRAW_RADIUS` would break that quietly -- clumps appearing and vanishing as the tree under them was thinned in and out.

### 2. A candidate produces a clump, not an instance

One accepted anchor becomes 1 to 5 mushrooms OF THE SAME SPECIES, ringed around a point near the prop's foot and tilted slightly away from each other. They are separate instances rather than one clustered geometry (`mushroom.js`'s `cluster` knob would bake a troop into a single mesh) because separate instances get separate variants, yaws, scales and ground heights, and a baked clump gets one of each -- so every troop in the world would be the same troop.

### The clump seed is the anchor's own position

This is the one place the file cannot copy its siblings. Every other scatter draws candidates from one stream per tile, so candidate k is whatever the k-th draw says it is -- deterministic because the tile is the only thing deciding the order. Here the candidates arrive from two independent modules whose own tiles are resident or not depending on where the player has walked, so the ORDER the anchors come back in is not a property of the world. Seeding off the tile stream would mean a tree that was second in the list on one visit and third on the next grew a different clump, and the mushrooms would silently shuffle every time the bed was regrown.

Hashing the anchor's own x and z instead makes a clump a property of the thing it grows on. Quantised to 3 cm, far finer than any two props are placed apart and far coarser than float drift. **x and z only, never y**: `trees.js` re-seats an instance's height when the chunk under it loads at a new resolution (`_reground`), so a hash including y would move the mushrooms whenever the terrain LOD changed underneath them.

### Clearance from the anchor

`ANCHOR_GAP` is measured from the anchor's SOLID radius outward -- a trunk or boulder occupies that circle, and a mushroom placed inside it is a mushroom growing through bark -- so a fat oak pushes its mushrooms further out than a sapling does.

**The ring's own radius is in that sum, and it has to be.** Members are scattered up to `ring` metres from the clump centre in EVERY direction, including straight back at the anchor, so a centre placed at just `aRad + gap` puts the inward members inside the trunk: measured on a grid of 0.25 m trunks, 13 of 390 mushrooms ended up inside the bark and the closest sat 2 cm from the axis. Pushing the centre out by the ring instead of clamping the strays afterwards keeps the ring a ring, and is right anyway -- a troop of five stands further off the trunk than a single cap does, because it needs the room.

The clearance is only ever as good as the radius it is measured from, and for a ROCK that radius is a circle about the anchor origin measured BEFORE the rock is tilted into the ground normal. A boulder leaning downhill carries its real footprint up to a couple of decimetres off the point it reported, so a clump on the downhill side can end up closer to the stone than the gap promises. The lower bound is set well clear of zero partly for that: cheaper to stand every clump a finger's width further out than to re-derive a tilted section the anchor API does not publish.

Every member takes its height from the field itself, not from the anchor: the y a source reports is its own seating plane, which for a bedded rock sits a sink depth BELOW the drawn ground.

### The ladder

| Tier | What | Band |
|---|---|---|
| 0 | mesh at radial 16, 60-66 tris | inside 20 spans |
| 1 | mesh at radial 6, 30-36 tris | 20 to 40 spans |
| 2 | one triangle, spun toward the eye | 40 spans to the draw radius |

There is no crossed-planes tier between the coarse mesh and the billboard, which is where a tree and a fern both have one: by 40 spans the whole prop is 23 px across, past §5's parallax range and past the size at which a second plane's silhouette is legible. So the billboard takes over at the end of the mesh and runs to the rim dissolve, exactly as a distant tree, tuft or fern does.

**The bands are multiples of the prop's own span, not metres**, which is the one place this scatter departs from its siblings. A fern is a fern; a mushroom is 8 cm on the forest floor and metres in a cave off the same five presets, and a fixed band would card the small one while it was still 15 px tall and hold the big one as a mesh long after 26. Hanging the ladder off the prop's own size puts every swap at the same apparent size instead -- 46 px and 23 px at 16.2 px/deg -- and costs one multiply per instance in the band test. A span is `max(height, spread)`. The far end is the 2-pixel rule coming the other way and stays absolute (`DRAW_RADIUS`).

### Pool sizing

`ANCHOR_DENSITY` is how many anchors -- trees plus rocks -- this file ASSUMES are standing per square metre, used only to size the instance pool. It is an assumption about two other modules rather than a number this one controls, which is why the pool carries a fatter safety factor than its siblings': `trees.js` runs at 0.05 stems/m^2 today and the boulder beds add to that, and if either is turned up, this constant has to move with it. Running the pool dry throws, so the failure is loud rather than a bed that quietly stops appearing.

`CLUMP_CHANCE` 0.32: every tree and every boulder having mushrooms at its foot reads as a set-dressing pass rather than as weather. A third is enough that a walk through the forest keeps finding some, and sparse enough that finding one still counts. Clump size is 1 to 5 skewed toward the small end (`CLUMP_SKEW`), so the common sight is a pair and the five-cap troop is the occasional one.
