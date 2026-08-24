## 3. Terrain character: cliffs, gorges, gullies

> **Covers:** what the terrain is supposed to look like and the noise construction that produces it -- scale, the three-tier fbm backbone, `SHRINK`, creases, the slope ladder, the retired Worley cliff layer.
> **Read this when:** touching `src/sim/terrain-height.js` or `TUNING`. The longest topic file, and the one with the most measurement in it.

Plain multi-octave Perlin produces rolling blobby hills and nothing else. It is the single biggest reason procedural terrain looks procedural. Five techniques, layered:

1. **Ridged multifractal** (`1 - abs(noise)`, accumulated across octaves) -- produces sharp ridgelines and knife-edge arêtes instead of rounded domes. ~~This is the backbone of the mountain layer.~~ **It is not, and this was the largest single mistake in the terrain so far -- see "Ridged noise makes filaments; fbm makes piles" below.** It survives as a rare, masked accent on roughly a tenth of the map, because a knife edge is a real landform and worth stumbling on; it just is not what a mountain looks like.
2. **Domain warping** -- perturb the noise input coordinates by a second noise field before sampling. Cheap, and it is what turns symmetric blobs into twisted, organic, geologically plausible shapes. Probably the highest ratio of visual payoff to code in the entire terrain system.
3. **Stratification / terracing** -- quantize elevation into bands with a sharp smoothstep between them, producing mesa edges and cliff bands. Gate it behind a mask so only some regions terrace; uniform terracing looks like a wedding cake.
4. **Variance masking** -- multiply detail-octave amplitude by a low-frequency mask so some regions are smooth (rolling alpine meadow) and others are chaotic (shattered broken ground). This is what gives "different levels of variation" rather than uniform noisiness everywhere.
5. **Worley/Voronoi cell noise** for plateau and cliff boundaries -- gives angular, fractured, geological breaks rather than round ones.

**Gorges and gulches come primarily from hydrology, not noise.** The `accumulation × slope` carve depth in §2 cuts genuine canyons exactly where a river cuts through steep terrain, which is where canyons actually are. Noise-based gulches on their own look arbitrary; hydrological ones look inevitable.

### Horizontal scale: Skyrim, not the Alps

The first tuning pass got the *character* right and the *size* wrong: valleys read as forty kilometres across and faded into haze rather than framing anywhere. The reference is the Riverwood-to-Whiterun stretch of Skyrim -- those are proper valleys, and they are small.

So all feature frequencies roughly doubled while relief stayed put, which is the whole trick: shrinking a valley without flattening it makes the walls steeper, and steep is what makes a valley read as one. Measured before -> after, with `scripts/probe-terrain.mjs` (a 513×513 sample at 32 m that reports elevation percentiles, a slope histogram, prominence-based peak spacing and valley-floor run lengths):

|  | before | after |
| --- | --- | --- |
| median peak-to-peak (prominence ≥ 120 m) | 1600 m | 864 m |
| median valley floor run | 800 m | 416 m |
| p95 valley floor run | 9952 m | 4736 m |
| max elevation | 893 m | 863 m |

Build the probe before turning the knobs. "Too big" is a feeling; 1600 m is a number, and only the number tells you when you have arrived.

The trade is walkable area, and it is the intended trade: steeper walls mean less of the map is under the 38° limit (55% -> 47%, reachable-from-spawn 86% -> 72%). §4's actual guarantee is *connectivity*, not coverage -- everything reachable stays leavable -- so the check gate moved rather than the terrain.

**Peaks want a soft ceiling, not a clamp.** `clamp01(ridged * 1.55)` saturated on 4.21% of the map, and that 4.21% was exactly the summits: every peak was a mesa at precisely `mountainRelief`. Replaced with a soft knee (`over / (1 + over * 2.2)` above 0.88) plus a crest-gated high-frequency ridged term, which is what turns domes into something jagged.

### Vertical scale: the one number is `relief × freq`

The Skyrim pass above doubled every frequency and deliberately held `mountainRelief` at 690. That is arithmetically identical to doubling every slope in the world, and the result was a landscape of 800 m vertical walls where every mountainside was a cliff and whole regions were sealed off behind them. "Make the peaks jagged" got implemented as "make everything vertical," which is not the same request.

**Horizontal scale and vertical scale are independent; steepness is their ratio.** Concretely, `relief × freq` is the number that governs how the world reads:

|  | first pass | Skyrim pass | correction | current |
| --- | --- | --- | --- | --- |
| `mountainRelief` | 690 m | 690 m | 175 m | 95 m |
| `ridgeFreq` | 0.00033 | 0.00068 | 0.00095 | 0.0029 |
| product | 0.23 | 0.47 | 0.166 | 0.28 |
| max elevation | 893 m | 863 m | 252 m | 225 m |
| median peak-to-peak | 1600 m | 864 m | 640 m | 384 m |
| walkable at 38° | 55% | 53% | 91% | 98% |
| reachable from spawn | 86% | 72% | 99% | 99.9% |

The corollary is worth stating because it is counter-intuitive and it came up as an explicit request: **scaling the whole world down by 4× cannot un-wall it.** A conformal shrink divides relief and multiplies frequency by the same factor, leaves the ratio untouched, and therefore leaves every slope angle in the world exactly where it was. Only the ratio moves slopes.

And the ratio overshoots in both directions. 0.166 measured as a world with **nothing above 40° anywhere and only 1.7% above 30°** -- gentle to the point of having no cliffs at all, which is its own failure. 0.28 puts 6.7% of the map in the 30-40° band and 1.0% above 40°, which is "some cliffs steep, others gradual" rather than either walls or pillows.

### Ridged noise makes filaments; fbm makes piles

The complaint was that the mountains looked like *wrinkled-up cloth* -- all curving smooth-edged ridgelines, no jumbled pile of peaks -- and that the coarse LOD rings turned those ridgelines into a row of saw teeth. Both had one cause, and it was structural rather than parametric: **no amount of frequency or relief tuning could have fixed it.**

Any `1 - abs(n)` construction puts its maxima on the **zero contour** of the underlying noise. A zero contour is a curvilinear network. So a ridged multifractal can only ever produce thin connected filaments -- rounding the crease just fattens the wire. Measured, the old backbone's distribution was `p10 0.081 median 0.268 p90 0.564`: most of the world was floor by construction, with bright threads on it. Plain fbm has **isolated point maxima**, which is what a jumbled pile of peaks actually is.

The remap on top of the fbm is deliberately **linear**, not a smoothstep. Pooling the bottom into valley floor is wanted; an S-curve would also dome every summit, and distinct summits are the point.

The saw-tooth artifact is a **sampling truth, not a tuning failure**: a crest whose curvature radius is smaller than the cell it is sampled on cannot be represented, so coarse rings land on alternating sides of the edge. The crest has to be wider than the sample spacing. Hence `ridged(..., round)`, where `sqrt(n² + r²)` equals `|n|` everywhere except within `r` of zero. No LOD change fixes it.

The same error recurred one scale down and had to be found the same way: the crest-gated summit-jag layer was also `ridged`, and it laid a fine wire network over every summit. Now fbm, still crest-gated -- the gate is what makes it different from simply adding another octave.

### Two scales, and the big one is the larger

`valleyRelief` (130 m at `baseFreq`, a 3.5 km wavelength) is deliberately **bigger** than `mountainRelief` (95 m at a 345 m wavelength). That inversion is what separates a region from gravel: lumps at one uniform scale read as texture, lumps riding on a slow swell read as high country and low country. It is also the only thing that gives a snow line meaning -- the same-shaped peak is white in one basin and bare in the next.

`reference/skyrim-height-map.jpg` is the target, and `scripts/heightmap-png.mjs` renders our field at the same **6.29 m/px** (the reference is 4 miles across at 1024 px) so the two can be put side by side. **Build this before tuning character.** Numbers catch scale errors; only the image catches character errors -- the ridged backbone measured perfectly well for two passes while looking like crumpled cloth.

### "Wide open plains" was the macro mask reaching zero

Basins 4 km across with nothing in them were not a frequency problem. The mountain mask reached a true 0, so the low country had **no backbone under it at all** and its only relief was the 3.5 km regional swell, which lays down nothing visible from inside it. A `mountainFloor` of 0.2 runs the same already-sampled backbone under the low ground at a fifth of its height -- about a 5% roll over 345 m, which reads as soft valleys rather than as floor, and costs nothing.

|  | before | after |
| --- | --- | --- |
| map that is flat (<6 m over 64 m) | 12.8% | 2.0% |
| largest unbroken plain | 1206 m | 284 m |
| median plain diameter (area-weighted) | 529 m | 102 m |

### Shape complaints have to become numbers

"It should be rare to have a pinnacle whose horizon angle is less than 30°" is a shape complaint, and `probe-terrain.mjs` could not answer it. It now reports **summit apex angle**: find cells that pass the prominence test on *both* their row and their column (a cheap stand-in for 2D prominence that correctly rejects shoulders), then measure the cone against the **mean** of a ring at 24 m and 64 m -- mean rather than min, so a summit on the end of a spur is judged by all its sides. Current: median 128°, p5 89°, and **0.1% below 60°**.

It also reports unbroken flat ground as connected components, with **area-weighted** percentiles. Unweighted, ten thousand single-cell specks drown out one 4 km basin, which is exactly the thing being looked for.

**Cliffs should come from the cliff layer, not the ridge backbone.** With cliffs sourced from `mountainRelief` they are a property of every mountain; sourced from the Worley break layer (`cliffFreq`, `cliffAmp`, gated by the mountain mask) they are a property of *some faces of some* mountains, which is both what real ranges look like and what leaves the rest climbable.

**Terracing is emergent, and its band width is** `step / tan(slope)`**.** An 18 m terrace step on a 30° slope puts a 31 m bench on the ground and reads as geology; the same step on a 60° slope puts a 10 m ledge under an 18 m wall and reads as a staircase. The terrace code never changed between the Skyrim pass and the complaint about staircases -- the ground under it got twice as steep. Fixes were all three of: shallower slopes (above), a smaller `terraceStep`, a wider smoothstep riser, and gating the terrace mask by `1 - crest` so summits never terrace.

**Instruments stop measuring when the world moves under them.** Two silently broke during this retune and both had to be fixed before the numbers meant anything again: `probe-terrain.mjs` used a fixed 120 m prominence threshold, which against 175 m peaks disqualified nearly every summit and reported peak spacing had *grown* to 3584 m (it now reports two thresholds, both keyed to total relief, because with a three-tier hierarchy "distance between peaks" has two different right answers); and `check-sim.mjs` sampled slope at 1 m eps while flood-filling on a 16 m grid, so the same world measured 73% reachable or 99% depending on which number you read. Colour bands in `chunk-mesh.js` and elevation bands in `props/scatter.js` are the same class of hazard -- every one of them is a fraction of the world's relief, and a 470 m treeline against 252 m peaks is not a treeline, it is "trees everywhere."

That hazard then bit again, in the *other* direction: a snow band of `smoothstep(140, 210)` written for 252 m peaks put snow **nowhere at all** once max elevation fell to 137 m. The rule that follows is worth writing down, because it has now cost two passes. **Every elevation-keyed constant outside** `TUNING` **has to be re-read off the probe whenever** `TUNING` **moves**, and there are four families of them: `shade()` in `chunk-mesh.js`, the four `minElev`/`maxElev`/`elevFade` sets in `props/scatter.js`, `findSpawn()` in `main.js`, and the spawn band in `check-sim.mjs` that must match it. None of them fail loudly; they all just quietly stop meaning anything.

### Three tiers, because height and peak spacing fight

"Peaks should reach 600 m, and 300-400 m should be common" and "peak to peak should be 200-500 m" cannot both come out of one noise layer, and the arithmetic is not close: a 600 m summit 400 m from its neighbour is 470 m of rise over 200 m of ground, a 67° wall -- the exact failure that sealed the world off during the Skyrim pass. Real ranges resolve it with a hierarchy, so the height function now has one:

| tier | wavelength | relief | what it is |
| --- | --- | --- | --- |
| `valleyRelief` | ~5.3 km | 240 m | regional swell -- high country and low country |
| `massifRelief` | ~1.7 km | 370 m | broad mountains on ~700 m flanks (~25°, walkable) |
| `mountainRelief` | ~345 m | 110 m | the close-spaced sub-peaks, riding on those flanks |
| `detail` | 91 m → 1.4 m | 2-7 m | micro relief, variance-masked |

Measured: max 661 m, p90 415, median 276; sub-peak spacing median 544 m, massif spacing median 1760 m; summit apex angle median 128°, nothing below 60°.

### Four ways a height field can look wrong while measuring right

Every one of these was found by rendering the field **shaded** and looking at it, after the percentiles had all come out fine. `heightmap-png.mjs` now takes `shade: true` and that is the default instrument for character, because a crease is a discontinuity in the *gradient* and an elevation map does not show the gradient.

- **Ridged noise makes filaments.** Covered above; it appeared twice, one scale apart.
- **A domain warp only works on features larger than its own amplitude.** `warpAmp` 60 m folds a 345 m ridge, which is the intent. Applied to a detail layer whose finest octave is 1.4 m, the same displacement is tens of wavelengths: it shears rather than folds, smearing every fine feature into a comet streak along the warp gradient. Shaded, the entire world looked like brushed metal -- thousands of parallel ripples with no landform behind them. Fixed by warping only the layers scaled for it and sampling jag and detail unwarped, and by sizing `warpAmp` against the **finest** warped wavelength rather than the base.
- **fbm gain above 0.5 is fur.** With lacunarity 2, octave *k* contributes slope in proportion to `(2·gain)^k`. At gain 0.55 the finest octave is the *roughest* thing in the layer, 1.8× the coarsest over 7 octaves. Exactly 0.5 is the 1/f self-similar law real terrain follows, and it is not a tuning preference.
- **Hard clamps make creases.** `(v - lo) / (hi - lo)` followed by a clamp is C0 but not C1, and the crease runs along a level set of smooth noise -- a closed curve. It shades as a hard-edged teardrop blob lying on otherwise smooth ground. `softFloor()` rounds the corner over a band while staying *exactly* equal to the input above the knee, so summits keep their points; the alternative, a smoothstep remap, would dome every summit.

### Creases and gorges -- the same operator at two scales, and where it stops working

The "molded curves of clay with mottled skin on top" complaint outlived two amplitude fixes, which is the evidence that it was never an amplitude problem. Measuring rather than guessing settled it: slope-per-octave-band is already near-constant at ~20% from 1 m to 67 m, so **no octave is missing**. What was missing is non-gaussianity. Curvature kurtosis measured **3.5**, where 3.0 is exactly gaussian -- the surface was smooth *everywhere*, and smooth-everywhere is what clay is. Every octave of an fbm is itself a smooth blob, so no amount of gain or octave count produces a C0 kink.

`1 - |fbm|` does. Its maxima lie on the noise's **zero contour**, and a zero contour is a connected curvilinear network -- the thing isolated noise maxima can never be. §3 rejected this operator twice already, at 345 m where it made the map read as wire and on the jag layer where it laid a wire net over every summit. **That rejection does not transfer to 38 m**, where a curvilinear network across a hillside is not wire, it is ribs and gully edges. Same operator, different scale, opposite verdict. Kurtosis 3.5 → 6.4 at the origin.

At 625 m spacing and 34 m depth the same operator gives **gorges** -- trenches with ~60° walls that have to be walked around. Two things separate a canyon from a worm, and the first sweep had neither, producing a rash of embossed squiggles:

- **One octave.** At two or more the zero contour closes into loops and doubles back every couple of hundred metres. Rivers do not do that.
- **A low-ground gate**, which matters more. Water does not cross a summit, so a trench that does reads instantly as something laid *on* the terrain rather than cut *into* it. Fading the cut out on high ground was the single change that turned the render from worms into canyons.

Measured on a 2 km patch: gorges occupy 3.1% of the ground within 16% of the map, mean trench 37 m across, +1.5 points of impassable ground.

**The negative result is the more useful half.** The same operator at 45-110 m, gated on true local slope, was tried for hillside gulches and rejected on the render: at that spacing you see dozens at once and the isotropy is unmissable -- squiggle loops and scratches, not gullies. Real gullies run down the fall line, deepen downslope and converge, and **no isotropic noise contour can produce any of those three**. Gorges work only because 625 m spacing is sparse enough that the eye reads each one individually. Hillside-scale incision is a job for the Phase A flow accumulation once it folds into the chunk pipeline (§2 Phase B), not for another noise layer.

### `TUNING` is pre-SHRINK, and a world-space measurement is not

The crease layer was tuned in a scratch harness that added it *on top of* `heightAt` -- i.e. in world metres -- and the constants were transplanted straight into `TUNING`, which the header at `terrain-height.js:49` states in capitals is pre-SHRINK. A layer tuned to sit at 38 m with a 4 m excursion therefore shipped at 19 m with 2 m.

What makes this class of error hard to catch by looking is that **it is conformal**: halving wavelength and amplitude together leaves every slope angle identical. Nothing looked broken, no walkability number moved, and the ablation gate (`creaseAmp` to 0 restores the old world exactly) still passed. The features were simply half the size -- which put them back down in the fur band the layer exists to escape, and the complaint came back as "there are still lumpy clay areas". Measured peak contribution on a hillside: 1.00 m where 2.00 m was intended.

Any constant arrived at by measuring `heightAt` has to be multiplied on the way in. `snowLineAt` already does this explicitly and says why; that comment is the model.

### An elevation proxy is not a slope

`creaseMask` gates on `highGround = clamp01(massif * 0.7 + crest)`, which is deliberately an *elevation* proxy -- a true local slope costs four extra `heightAt` evaluations inside the hottest function in the project. The cost of the proxy is that mid-elevation hillsides read as low ground. The patch that prompted the second complaint sits at the map's **median** elevation with 27 m of relief across 400 m -- unmistakably a hillside, and one the mask was running at roughly half strength.

Fixed with a floor (`creaseFloor`) rather than a real slope: no ground is left perfectly smooth, and the gradient the window provides still holds above the floor. Cost, measured: walkable 57.5% → 55.4%, reachable from spawn 97.1% → 96.6%, with the gorges included in the same delta.

### The connectivity instrument was measuring the wrong thing

`check-sim.mjs` flood-filled over **nodes**, masking out any cell whose own local slope exceeded 38°. `player.js` `_walkable()` tests an **edge**: it compares the height where she is against the height where she is going and rejects the *step*, and never asks whether the ground she is standing on is steep. The difference is not conservative, it is wrong -- a node mask deletes the flat strip along the base of a cliff, which is the one corridor a mountain world most needs. The same terrain measures **71.8% reachable as nodes and 92.5% as edges**. The node number sent an entire pass hunting a connectivity regression that was never in the terrain. This is the third instrument to break this way; the pattern is now four for four.

**Ablations must not disturb the thing they are holding fixed.** The first ablation of this pass zeroed `massifRelief` and reported it cost 17 points of walkability, which pointed the fix at the massif tier. It was confounded: `jag` is gated on `massif` and the detail roughness mask keys off it too, so zeroing the massif silently removed three layers. Sweeping `massifFreq` across a 2× range moved walkability by 3 points, which is what the massif actually costs.

### The rockiness rule is POSITION, not elevation

Every rock layer -- `jag`, `detail`, `crease`, `cliff` -- used to be gated on `highGround = clamp01(massif * 0.7 + crest)`, and the `mountain` macro mask was a factor on most of them as well. Both are elevation proxies, so the rule the world was actually running was *high ground is rock, low ground is soil*. That rule can produce exactly two complaints and it produced both of them, repeatedly: low hills come out as smooth moulded clay, and high saddles and hanging valleys come out shattered. They are one bug seen from its two ends. Three separate passes raised rock amplitude against it, which is why each fix worked at the peaks and made the second complaint worse.

The replacement is **exposure**, and it is the organising idea of the whole field now. Rockiness follows landform *position*: convex ground -- spurs, ribs, crests, outcrops -- sheds its debris and stands as bare rock, while concave ground -- hollows, saddles, gullies, valley floors -- collects it and fills smooth. That is a real geomorphic process rather than a stylistic choice, and its useful property here is that **it is scale-free**: the same rule governs a 400 m spur off a massif and a 15 m outcrop in a meadow, so low hills get the same jagged jutting character as the peaks, at a gentler angle, with no second rule to tune.

It is free to compute, which is what makes it affordable inside the hottest function in the project. An fbm normalised to 0..1 sits near 0.5 at its own local mean, so `(lump - 0.5)` *is* local relative height with no absolute elevation in it. Convexity is a weighted sum of two already-sampled fbms (massif-scale and ridge-scale), pushed through a smoothstep band and multiplied by a slow lithology field so that whole regions are craggier than others:

```
convex   = (massifLump - 0.5)*exposureMassif + (lump - 0.5)*exposureRidge + exposureBias
exposure = smoothstep(-exposureBand, exposureBand, convex) * lith
rockAmp  = exposure * lerp(lowlandRock, 1, highGround)
```

`lowlandRock` (0.45) is the only place elevation still enters, and it is deliberately a *damper*, not a gate: low crests are rocky, just less violently so. Measured with a two-scale probe -- classify crest/hollow at a 400 m blur, measure roughness at a 24 m blur -- crest ground is **2.40x** rougher than hollow ground overall, and **2.22x** on low ground specifically (hollow 0.140, crest 0.310). Low crest against high crest is 1.80x: the same rule at both ends, at a gentler angle low down.

The consequence worth naming is that **the paths are what the rule leaves behind**. Concave ground is smooth by construction and hollows run unbroken from a valley floor to a saddle, so a walkable route network up every mountain falls out of the exposure rule without anything being placed. It is not a separate system and there is nothing to keep in sync.

### The slope ladder, not the height ladder

A layer's RMS *height* says how much it moves the ground; its RMS *slope* -- amplitude divided by wavelength -- says how much it moves the gradient, and the eye reads gradient. A hillshade, a silhouette and `_walkable()` are all functions of slope. A layer with a twentieth of the amplitude of the tier above it but a fortieth of the wavelength is **twice as steep** as that tier and will dominate it visually, however modest its height-ladder entry looks.

So the coherence rule is: sort the layers by RMS slope, and each rung should sit roughly 2x below the one above it. A flat ladder means no scale wins, and no scale winning is precisely what "jumbled chaos" looks like from inside. `scripts/ladder.mjs` ablates each layer and prints the ladder with its rung ratios.

Measured before this pass, the ladder was cliff 1.051 / backbone 0.631 / massif 0.539 / jag 0.457 -- four layers inside a 1.2x spread, with the *finest* structural layer twice as steep as the largest one. After: massif 0.556 leads, backbone 0.337, jag 0.322, swell 0.198, cliff 0.189, detail 0.151, crease 0.099. The massif tier dominating the ladder is the structural fix; `cliffAmp` 60 → 30 plus re-gating on exposure took cliff down 5.6x on its own.

This also reframes what a slider is for. Six amplitudes in metres and six frequencies are twelve controls that jointly set one thing nobody can see. Where a rung needs to come down, splitting the cut across amplitude *and* wavelength (here `mountainRelief` 110 → 80 with `ridgeFreq` 0.0029 → 0.0021) buys the slope reduction while keeping the sub-peak count and height, instead of spending the tier's presence to get it.

### A hillshade cannot see a hedge horizon

Every instrument in the repo looked straight down. A hillshade shows the gradient everywhere; it cannot show whether summits *differ*, only whether they exist. `massif` is an fbm remapped into a fixed window, so every massif topped out at the same value by construction and the range read as a hedge along the horizon -- invisible from above, and the single most obvious difference from the Skyrim reference silhouettes.

`scripts/skyline-png.mjs` ray-marches the horizon as she would see it: for each of 1200 azimuth columns across a 75 deg FOV it steps outward with geometric growth to 6000 m from a 1.65 m eye, tracking the maximum elevation angle and the distance of whatever drew it, then paints exponential haze so ridgelines separate into layers. It reports apex, median and relief in degrees, which is directly comparable against a reference screenshot.

The fix it drove is `peakContrast`: a very slow fbm (`peakFreq` 0.00013) that *multiplies* the massif tier rather than adding to it, so it changes which mountains are big without moving the mean. It needs a signed power curve (`sign(n)*|n|^peakSkew`) because a normalised fbm is bell-shaped and almost never approaches its declared ends -- the same pathology already recorded twice in this file for `valleyLo` and `cliffBreakLo`. Measured: mean apex 33.2 → 18.4 deg, relief 6.8 → 6.6 (references measure 5-9), and the viewpoint that had a sheer 71.2 deg wall in her face now reads 14.9.

### Seventy-five sliders is the source file with a mouse

The tuner shipped with every `TUNING` constant exposed, and it was reported as overwhelming and as full of controls that "don't do the thing that they say they do". That report was accurate, for three separate reasons:

- **About a third were gate endpoints.** `cliffGateLo`, `creaseHi`, `massifLo` and two dozen siblings are smoothstep edges on internal noise. Nobody can predict what moving one by 0.05 does, because the answer depends on the distribution of a field you cannot see. They were solved once against measurements; the right home for a solved constant is the source, with its reasoning beside it.
- **Most of the rest were gated to invisibility.** An amplitude multiplied by three masks does nothing wherever any mask is shut, and the cliff layer as shipped was shut over 96% of the world. Dragging that slider and seeing nothing is indistinguishable from a broken control.
- **The thing that decided the look was not on the panel.** The slope ratio between tiers is not any one constant, so no slider moved it.

Cut to 17, against the rule that a knob must visibly change the *character* of the world within a couple of seconds of dragging, from wherever you happen to be standing: five for the silhouette, seven for the rock/smooth balance (led by `exposureBias`, which sets what fraction of the world is bare rock), two for the lowlands, three for the snow line.

### The Worley cliff layer is retired, and the wall was the gate

`cliffAmp` is 0. This layer has now been asked four times to do something its structure cannot do -- it shipped as a field of round pits (F1 read backwards), then as an inert 0.08 m contribution, then at amplitude 60 as a carpet of closed Worley squiggles over every summit, and finally as sheer vertical walls. The fourth complaint is the one that settled it, because the measurement showed the two knobs that are supposed to control face steepness do not control it.

Face angle of the isolated layer, p90 and p99, across the plausible range:

```
lip 3.0, edge 0.13 (as shipped)   p90 80   p99 85
lip 1.0, edge 0.30                p90 77   p99 85
lip 1.0, edge 0.40, amp 22        p90 67   p99 80
```

That last row is a 7.4 m step spread over a 24 m run. That is a **17 degree** face by arithmetic, and it measures 67. So the angle is not coming from the mosaic.

It is coming from the **gate**. `gate` multiplies the whole term, and deep inside a cell the term already sits at full plateau height, so wherever the gate opens underneath such a cell the ground climbs the entire height of the cliff over the gate's transition distance -- at a location set by three composed smoothsteps on unrelated noise, with no relation to the mosaic at all. `cliffGateLo/Hi` exist precisely to make that transition near-binary, on the stated reasoning that "a partially-gated cliff is not a small cliff, it is the smooth ramp we were trying to get rid of". The vertical faces are what the gate was tightened to produce.

The `mid` construction keeps the surface continuous across **cell** boundaries and was always cited as this layer's continuity argument. Nothing keeps it continuous across **gate** boundaries, and that is where the walls are. Opening the gate windows does soften them (p90 80 → 65) but relocates the cliffs entirely, which is a redesign rather than a knob.

Cost of retiring it, world-wide at a 1.5 m stride: ground over 60 deg 3.27% → 2.93%, over 70 deg 0.51% → 0.21%, **over 80 deg 0.13% → 0.00%**, across 2.9% coverage. The layer supplied all of the genuinely vertical ground and about 60% of everything past 70 deg. What remains over 60 deg comes from the exposure rule, which produces steep rock as a consequence of landform position rather than by drawing a mosaic on top of one. The skyline is unchanged by the removal (mean relief 6.6 → 7.1 deg), so the drama was never coming from this layer either.

The code stays, guarded on `cliffAmp < 0.001` tested *before* the gate so the retired layer costs one compare in the hottest function in the project, and the slider stays on the panel. If it is ever wanted, **fix the gate first, not the blend**.

### Two hard constraints

- **Heightmaps cannot represent overhangs, arches, or caves.** One elevation per XZ, period. No natural bridges, no cave mouths. Accepted.
- **Near-vertical cliffs stretch triangles and UVs badly.** Solved by **triplanar mapping** on the terrain material (§7), which blends three axis-aligned projections weighted by the surface normal. Costs 3x texture samples, mitigated by lerping toward triplanar only where slope is high.

---
