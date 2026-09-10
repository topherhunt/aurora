# Local shadows: shading the 0.5 m to 15 m scale

## What already exists, and a correction

This note replaces an earlier draft that opened by claiming the world has no shadows at all. That came from grepping `shadowMap|castShadow|receiveShadow`, which returns nothing. The grep was accurate and the conclusion was wrong: there are no three.js shadow maps, but there is a **complete directional shadow and ambient occlusion system**, built, gated and shipping, in `src/sim/horizon.js` and `src/lighting.js` (§8).

It bakes the horizon elevation at 16 azimuths per texel, 1024² over 16 km, and at runtime compares the sun's elevation against the interpolated horizon angle. `wlSun()` returns sun visibility, `wlSky()` returns the cosine-weighted sky fraction, and `APPLY` multiplies the first into `reflectedLight.directDiffuse` and the second into `indirectDiffuse` after `<lights_fragment_end>`.

**So the architecture this proposal needs is not hypothetical -- it is the architecture already in the tree.** What follows extends it rather than adding a second system.

The gap is **resolution**. 1024² over 16 km is **15.6 m per texel**. A mountain casts a shadow in that map. A boulder does not exist in it at all. Everything between roughly 0.5 m and 15 m -- a boulder shading the boulder beside it, a tree darkening the ground at its foot, a cabin throwing a shadow across the path -- is missing, and that is exactly the scale a walking player looks at.

## Can instanced meshes be shaded per-instance? Yes, and they already are

This is the question worth answering plainly, because the intuition that it must be expensive is right about one approach and wrong about the other.

**Baking per-instance vertex colours is the expensive thing, and it is worse than expensive -- it is incompatible.** Instancing works precisely because every instance shares one vertex buffer. Writing per-instance shading into that buffer would give every boulder in the world identical shading. Making it per-instance means unique geometry per instance, which is not "a slower version of instancing", it is *no instancing*, across tens of thousands of props.

**Evaluating per-vertex in the vertex shader is the cheap thing, and it is what the codebase already does.** The vertex shader knows which instance it is drawing, because the instance transform is in scope. `lighting.js:133` has the helper already written:

```glsl
vec4 wlLocal = vec4( transformed, 1.0 );
#ifdef USE_BATCHING  wlLocal = batchingMatrix * wlLocal; #endif
#ifdef USE_INSTANCING wlLocal = instanceMatrix * wlLocal; #endif
vec3 wlWorld = ( modelMatrix * wlLocal ).xyz;
```

Every prop in the world already samples the horizon map per-vertex from that world position and passes the result as a varying. Two boulders in different places already get different shading from shared geometry, today, for free. **No per-instance attribute is needed, and none is used.** Nothing new has to be invented to make local occlusion work the same way.

## Why per-vertex is the right granularity, with numbers

The frame is measured now, on the device, and the numbers are in `terrain-material.js:393`. Quest 2, trees and grass loaded, medium load:

| shader | fps | frame |
|---|---|---|
| stock Lambert | 73 | 13.70 ms |
| **lean (shipping)** | **60** | **16.67 ms** |
| lo-fi | 57 | 17.54 ms |
| full | 46 | 21.74 ms |

Two things follow, and both point the same way.

**There is no fragment headroom. There is negative fragment headroom.** 72 Hz is a 13.9 ms budget and the shipping shader already lands at 16.67. Anything added per-fragment comes out of a deficit. The same file notes the ground is fill bound "at 7 Mpixel a frame", and that the marginal cost of one full-screen texture fetch measured **0.64 ms** at the lean end -- with the honest caveat written next to it that "fetches are not the cost" and no single rate fits both data points.

**Vertex rate is roughly 35x cheaper for the same work.** 7 Mpixel of fragments against order 200k vertices per frame (terrain draws 46k triangles on the XR route at `triDeg` 5.72). A term costing 0.64 ms per fragment costs on the order of **0.02 ms per vertex**. That is the entire argument: a local shadow query is unaffordable per pixel on this device and close to free per vertex, and the difference is not 20%, it is a factor of dozens.

Your instinct that per-vertex is enough is also, separately, correct on looks. The finest terrain cell is **50 cm** (8 m leaf node, `CHUNK_RES` 16 -- `src/v2/config.js:54`), so a shadow edge smears over half a metre underfoot. At latitude 65 N with the sun culminating at 21°, shadows are long and soft all day anyway, and the house style is N64-era low-poly with baked lighting. Gouraud-interpolated soft shadows are not a concession here, they are period-correct.

## The proposal: sphere occluders, queried per vertex

Each significant object publishes one or a few **spheres** in world space, `(x, y, z, radius)`. A boulder is one sphere. A tree is one for the crown, optionally a thin one for the trunk. A cabin is two or three, or a box later.

Then two terms, and they are worth building in this order because the first is cheaper and may carry most of the feeling.

**Term 1: contact occlusion. Sun-independent, no ray.** For each vertex, accumulate darkening from nearby occluder spheres by proximity alone. This is what makes an object read as *planted* rather than hovering, it deepens the crevice between two boulders, and because it is sun-independent it still works at night -- where, per §8's night work, the ambient *is* the light. Cost is a distance compare per occluder. It multiplies `indirectDiffuse`, exactly as `wlSky` already does.

**Term 2: directional shadow. A ray toward the sun.** For each vertex, test the ray from the vertex toward the sun against nearby spheres. Analytic ray-sphere is a handful of ops, and the **penumbra falls out for free**: use the perpendicular distance from the sphere centre to the ray, over the radius, as the soft edge. This is the term that gives you the thing you actually asked for -- the big boulder shading the small boulder -- because it is a genuine 3D occlusion test and not a shadow projected onto the ground. It multiplies `directDiffuse`.

Two optimisations are worth building in from the start:

- **Skip vertices already facing away.** If `dot(N, L) <= 0` the Lambert term is zero and the vertex is dark regardless. That is roughly half the vertices of every closed object, discarded before any occluder is touched.
- **Bias the ray origin along the vertex normal** so an object's own sphere does not shadow-acne it. Combined with keeping the published sphere slightly inside the mesh, this avoids needing per-instance identity in the query at all.

Occluders are fed as a small data texture with a camera-following 2D grid, handed into every material **by reference** the way `lighting.js` already shares its uniforms, so there is one writer and no per-material update loop.

## Follow the compile-time rule

`lighting.js` is emphatic on this and the proposal must obey it: *"a uniform whose value says 'do nothing' still pays for every instruction guarded by it, which on a Quest 2 is the whole cost and none of the effect."* The system has `enabled` and `ready` as **compile-time decisions**, not runtime uniforms, so switching it off emits literally nothing.

Local shadows get the same treatment: a compile flag, its own row in the headset panel beside `terrain & prop lighting`, so the A/B is a real measurement and shipping without it costs zero instructions.

## Where per-vertex genuinely fails, stated plainly

**Two-triangle cards.** A billboard has four vertices, so it gets a flat value with no gradient across it. Acceptable, because cards are the distant tier and a distant tree does not need a shadow gradient -- but it does mean the near/far card crossover is where a shading pop could appear, and that wants checking.

**Far-LOD terrain triangles.** Out at range the triangles are tens of metres across and a 4 m shadow simply vanishes between vertices. This is correct LOD behaviour rather than a bug, and the horizon map still carries the large-scale shadowing out there, which is the half that matters at distance.

**Overlapping occluders are not sorted.** Two spheres shadowing the same vertex should not multiply naively or the overlap goes too dark. Take the maximum, or a soft-max, rather than the product.

**Spheres are a poor fit for some shapes.** A cabin wall is not a sphere and a long fallen log is not a sphere. Capsules cover the log cheaply; boxes cover the cabin and cost more. Start with spheres and add shapes only where the silhouette is visibly wrong.

## Coverage: which surfaces receive

The patch already reaches every surface that matters, and in the right mode. Terrain is fragment mode. Props, the village and **roads** are vertex mode -- `road-surfaces.js:41` builds a plain `MeshLambertMaterial` but its doc comment requires the caller to run `lighting.patch(roads.material, { mode: 'vertex', cacheKey: 'v2-road' })`, with the reason stated: fragment mode "costs a horizon-map tap per fragment to buy a shadow edge that a road at 2 m sample spacing has nowhere to put." That is the same argument this proposal makes, already settled for one surface.

So local shadows inherit the coverage rather than re-establishing it. **Water is the exception** -- `src/water.js` carries its own shader and is outside the patch, which is correct for now.

## Sizing the occluder population

`check-trees.mjs` measures 10 trees within 8 m, 35 within 15 m and 1,571 within 100 m -- all three landing on **0.0497 trees per m²**, one per 20 m², and flat across the whole band. Over a 40 m occluder field that is ~80 trees plus rocks, which is a small enough table to hold as a handful of texels and rebuild on camera cell-crossing rather than per frame.

That density is also the argument for keeping the occluder radius honest. At one tree per 20 m² a 4 m crown radius means the canopy discs overlap roughly threefold, so in closed forest the correct answer is mostly "shadowed", and the interesting variation is at the edges and clearings.

## What not to do

**Do not use decal quads.** This was the original idea in the draft this note replaces, and it fails three ways. `createPropMaterial` is binary cutout only -- `alphaTest: 0.5, transparent: false` at `src/material.js:2181`, with the comment above it stating that alpha blending "cannot be sorted within a batched draw call, so it is architecturally unavailable to us (DESIGN.md §7)". A blurred oval *is* alpha blending, so a quad cannot ride the batched path at all. Second, the curvature error scales with the card: a 5 m blob on 5° of slope variation lifts its rim half a metre off the ground -- the same problem that pushed the pebble litter toward spraying, strictly worse. Third, and fatally for what you actually asked: **a ground quad shadows the ground and nothing else.** It can never make one boulder shade another.

**Do not add three.js shadow maps.** Beyond the second depth pass, every billboard rotation and wind displacement in the prop material would need a matching `customDepthMaterial` reproducing that vertex logic, or props would cast shadows from their un-spun geometry. At 16.67 ms already, this is not the device for it.

**Do not do the fragment-rate blob grid from the earlier note.** I proposed it and I am retracting it. It was costed on desktop reasoning, and the measured frame says the fragment budget is already overspent.

**Do not bake local occlusion into terrain vertex colours at chunk build.** Tempting, since `buildChunkV2` already writes vertex colours on the CPU and it would be free at runtime -- but the sun moves, so a baked sun shadow is wrong at every hour but one. Term 1 (contact occlusion) *could* be baked this way since it is sun-independent; the catch is that props are placed per-tile and re-thinned by LOD, so the bake would need invalidating whenever the scatter changes underneath it. Worth revisiting only if the runtime version measures badly.

## Staging

0. **Measure first.** Add the compile flag and an empty term, confirm the A/B row reads zero. This is also the moment to check the vertex-rate assumption, since a tiled GPU can run vertex shaders more than once per vertex.
1. **Boulders only, contact occlusion only.** One sphere per rock, sun-independent proximity darkening. Smallest change that makes rocks look planted, and it is the term that survives at night.
2. **Add the sun ray, boulders only.** This is the one that answers "the big boulder shades the small boulder". Judge it on the headset before going wider.
3. **Tree crowns**, which is the largest occluder population and therefore the real cost test.
4. **Buildings**, as boxes if spheres read wrong on a wall.

A cheaper fallback exists at every stage if the budget bites: drop to **one value per instance** rather than per vertex, computed CPU-side at placement. That loses the gradient across a single boulder but keeps boulder-to-boulder difference, and costs essentially nothing per frame.

## Gating

Everything above the shader is testable headless in the house style. A `check-local-shadows.mjs` can assert that the occluder grid returns every sphere overlapping a queried point; that the ray-sphere test agrees with a brute-force reference within tolerance across a sweep of sun elevations; that `dot(N,L) <= 0` culling never changes a result; and that overlapping occluders combine by max rather than product. The shader half is gated the way `lighting.js` already is -- by asserting the injected identifiers appear in three.js's real `ShaderLib.lambert` source, because a `String.replace` that matches nothing returns the string unchanged and would silently delete every shadow in the game while still compiling.
