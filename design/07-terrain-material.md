## 7. Terrain material and transparency

> **Covers:** the ground shader -- splat blending, the palette, speckle, snow line, transparency policy.
> **Read this when:** touching `src/material.js` or terrain colour.

### Splat blending: 4 layers, 4 channels

| Layer | Placement rule |
| --- | --- |
| **Snow** | Elevation above snowline, plus noise, plus weather accumulation (§10). Reduced on steep slopes -- snow does not cling to cliffs |
| **Rock** | Slope above threshold. Dominant on cliffs and gorge walls |
| **Grass** | Low elevation + moisture. Warmer valleys |
| **Packed dirt** | Path and village masks (§6) |

Weights pack into a single RGBA texture -- four layers, four channels, exactly. Two implementation notes that matter for how it looks:

- **Height-blend, do not linear-lerp.** Give each layer a height/roughness map and blend by `max(weight + height)` rather than a weighted average. This is the difference between snow *settling into* rock crevices and snow *fading uniformly* over rock. It is a few lines of shader and it is the single biggest quality lever on the terrain.
- **Triplanar on steep slopes only.** Lerp toward triplanar projection as slope increases, rather than applying it everywhere. Avoids stretched cliff textures at 1/3 the average cost.

The terrain uses its own material with small tiling textures -- **not** the prop atlas, since atlas tiles cannot wrap. This is a deliberate exception to the one-material rule and costs one draw call family.

### Interim: procedural speckle (`src/terrain/terrain-material.js`)

Until the splat textures exist, the surface gets its grain from a `MeshLambertMaterial` patched through `onBeforeCompile`: a sin-free hash noise at two octaves (~0.5 m grit and ~3.5 m patches), a brightness speckle on everything, then dirt and moss mixes gated on `vColor.g > max(vColor.r, vColor.b)` so only vegetated ground gets them. It fades out between 12 m and 95 m, because past that it is per-pixel noise nobody asked for.

**Keyed to world position, in the fragment shader, deliberately.** Anything baked per-vertex would rescale itself at every quadtree ring and pop as the LOD changed -- the grain would visibly breathe as you walked. Same reason the base classification in `chunk-mesh.js` stays coarse: it is the only part that *can* live on vertices.

**And "keyed to world position" has to include the classifier's INPUTS, not just its output grid.** `shade()` obeyed the rule on paper -- one colour per vertex, no scale-dependent noise -- while breaking it completely, because the steepness it classified on was the mesh normal, a central difference over the chunk's own cell: 1 m at a leaf and 128 m at depth 3. Steepness is what keeps snow off cliffs, and an alpine face standing at 74° over 1 m averages out to 24° over 128 m, so the identical ground came out bare rock up close and solid white from a distance. Over 400 snow-capable sites the white fraction ran **31.5% at the leaf to 55.8% at depth 3, rising monotonically with cell size**; flying away from close terrain repainted the world one chunk-shaped square at a time. The fix is that the classification slope is now measured over a **fixed 1 m stencil** (`CLASS_EPS`) regardless of chunk size, which flattens that to 31.5% → 29.8%. Leaves are exempt and therefore bit-identical, since their cells already *are* the stencil; coarse chunks pay four extra `heightAt` per vertex, once, and then cache. `check-terrain.mjs` guards the drift, because every other drill in the suite watches geometry and bookkeeping and none of them can see a colour.

The general form is worth keeping: **a per-vertex quantity is only LOD-safe if every term feeding it is a function of world position alone.** Mesh normals are not -- they are a function of the mesh.

Two things this pass got wrong the first time, both worth remembering. Vertex colours and plain `THREE.Color` uniforms are **linear working space**, and the palette had been authored as if they were sRGB: linear 0.33 is sRGB 0.60, which under a 2.1-intensity sun came out as pale mint green. Dark gritty ground lives around linear 0.05. And the speckle is what makes speed legible -- on untextured ground at 29 m/s you cannot tell you are moving at all.

**A second, un-faded macro layer, because the fade is what made distance look flat.** Everything past ~95 m was reading as smooth green or smooth grey, and the cause was not a thin palette -- it was that the only thing varying the palette had already faded out. So there are two independent layers with opposite requirements: the near grain (0.5-3.5 m) *must* die at range or it aliases into shimmer once it is sub-pixel; the macro layer (~110 m regions with ~38 m variation inside them) *must not*, and is safe not to because it is never close to pixel-sized from anywhere you can stand. One shared fade cannot satisfy both, which is why they are not just extra octaves on one fbm. The macro layer swings brightness on everything (damped on snow -- blotchy snow reads as dirty snow), pulls green ground toward a dry ochre or a damp deep green, and stains rock on the finer octave alone, since mineral banding follows the face rather than the valley.

### 10 cm texture is a NORMAL, not a seventh height octave

The ask was bumps and divots at 10 cm on every surface, because the ground was reading as poured and edible up close. That cannot go in the height field, and the reason is a number: the leaf chunk is 16 m over `CHUNK_RES` 16, so the mesh resolves **1.00 m cells**. A 10 cm wavelength is a fifth of Nyquist there. It would alias into a pattern that crawls whenever a chunk rebuilds, cost five more `heightAt` evaluations on the collision path (already the frame's most expensive query), and feed `slopeAt` at eps 0.75 with garbage -- manufacturing exactly the sub-metre walk refusals §4 just finished removing.

Perturbing the shading normal buys the look with none of it: geometry-free so nothing rebuilds and nothing can block her, world-keyed so it does not rescale across LOD rings, and inside a fade so it is gone before it can alias. There were already two octaves there (~1.4 m, ~0.45 m); this is a third rung at ~10 cm on its own tighter fade (gone by 40 m, where a 10 cm feature is about 3 px) and its own flat surface mask -- full on rock, half on grass and snow alike. The coarse pair give snow only a fifth, because half-metre relief makes a drift read as gravel; at 10 cm that does not apply, since windblown snow really is pitted at this scale.

**This ladder wants to be FLAT, which is the exact opposite of the terrain slope ladder in §3, and the difference is worth understanding.** Landform coherence needs one scale to dominate -- rungs ~2x apart, or the eye finds no large form. Surface texture needs every scale to read at once, because a real gritty surface differs at all of them simultaneously. Measured tilt from the transcribed noise, RMS / p99 / max:

```
~1.39 m   5.0 /  11.3 / 16.1 deg
~0.45 m   6.6 /  14.7 / 20.5 deg
~0.10 m   5.1 /  11.5 / 16.3 deg      <- the new rung, 1.8 cm on a 10 cm bump
```

Amplitude was derived rather than dialled: a rung's visual weight is amplitude over wavelength, so matching the existing pair means `10.0 * uMicroRelief / uRelief` landing near their `0.72*0.7 = 0.50` and `2.2*0.3 = 0.66`. `uMicroRelief = 0.018` gives 0.51, and the measurement above confirms it lands between them.

Two implementation details that are load-bearing. The octave is added to the **same** bump vector rather than applied as a second `normalize` -- two successive normalizes let the coarse tilt swallow the fine one wherever the coarse tilt is large, which is on rock, precisely where this octave is meant to be strongest. And it is nested inside the `uRelief > 0.0` guard, so the fill-bound escape hatch still kills the whole normal pass in one uniform.

Note there are now three separate operations at ~10 cm: the micro tint pair, the snow sparkle, and this. That is not duplication. A real gritty surface differs in albedo *and* in normal at once, and doing only the first is why a flat-shaded hillside with speckle on it still looks like icing.

### Transparency: alpha test, never alpha blend

`material.alphaTest = 0.5`, binary cutout, no partial alpha.

Not merely a preference: alpha blending requires back-to-front sorting, cannot write depth, and **fundamentally cannot be sorted within a batched or instanced draw call**. It is architecturally incompatible with §5. Alpha test writes depth, needs no sorting, batches cleanly.

Two caveats, neither fatal:

- On Adreno tile-based GPUs, `discard` disables early-Z for that draw. Render alpha-tested foliage **after** all opaque geometry so it still benefits from the opaque depth prepass.
- Alpha-test edges alias badly against MSAA. Set `alphaToCoverage = true`; cheap, and it cleans this up.

True alpha blending is reserved for **the aurora**, **fog/mist cards**, **water**, and **snow particles** -- all of which are small in number and sort trivially.

---
